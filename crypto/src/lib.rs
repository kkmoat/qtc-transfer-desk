//! Browser-local signing bridge. No network, storage, or secret export APIs.
//! The caller must independently verify the intended chain and review the transaction.
use blake2::{Blake2b512, Blake2b, Digest, digest::consts::U32};
use qp_rusty_crystals_dilithium::{ml_dsa_65, ml_dsa_87};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;
use qp_rusty_crystals_hdwallet::{SensitiveBytes64, WormholePair};

const CONTEXT: &[u8] = b"QUANTUS_EXTRINSIC";
const SUPPORTED_SPEC: u32 = 152;
const MAX_PAYLOAD: usize = 1024 * 1024;

enum Keys {
    Dsa65(Box<ml_dsa_65::Keypair>),
    Dsa87(Box<ml_dsa_87::Keypair>),
}

impl Keys {
    fn public(&self) -> Vec<u8> {
        match self {
            Self::Dsa65(k) => k.public().to_bytes().to_vec(),
            Self::Dsa87(k) => k.public().to_bytes().to_vec(),
        }
    }
    fn sign(&self, msg: &[u8]) -> Result<Vec<u8>, &'static str> {
        match self {
            Self::Dsa65(k) => k.sign(msg, Some(CONTEXT), None).map(|s| s.to_vec()),
            Self::Dsa87(k) => k.sign(msg, Some(CONTEXT), None).map(|s| s.to_vec()),
        }.map_err(|_| "Signing failed")
    }
}

fn message(payload: &[u8]) -> Vec<u8> {
    if payload.len() > 256 {
        Blake2b::<U32>::digest(payload).to_vec()
    } else {
        payload.to_vec()
    }
}

fn address_for_id(id: &[u8; 32]) -> String {
    let mut bytes = vec![0x6f, 0x40]; // SS58 prefix 189, two-byte encoding.
    bytes.extend_from_slice(id);
    let mut hasher = Blake2b512::new();
    hasher.update(b"SS58PRE");
    hasher.update(&bytes);
    bytes.extend_from_slice(&hasher.finalize()[..2]);
    bs58::encode(bytes).into_string()
}

fn parse_scheme(scheme: &str) -> Result<bool, &'static str> {
    match scheme {
        "ml-dsa-65" => Ok(true),
        "ml-dsa-87" => Ok(false),
        _ => Err("Expected ml-dsa-65 or ml-dsa-87"),
    }
}

fn canonical_path(scheme: &str, account: u32) -> Result<String, &'static str> {
    if account >= (1 << 31) { return Err("Account index must be below 2^31"); }
    let last = if parse_scheme(scheme)? { 1 } else { 0 };
    Ok(format!("m/44'/189189'/{account}'/0'/{last}'"))
}

fn derive_inner(mnemonic: String, scheme: &str, path: String) -> Result<SecretHandle, &'static str> {
    let mnemonic = Zeroizing::new(mnemonic);
    if mnemonic.len() > 1024 { return Err("Mnemonic is too long"); }
    let is65 = parse_scheme(scheme)?;
    let keys = if is65 {
        Keys::Dsa65(Box::new(qp_rusty_crystals_hdwallet::ml_dsa_65::derive_key_from_mnemonic(
            mnemonic.as_str(), None, &path,
        ).map_err(|_| "Invalid mnemonic or derivation path")?))
    } else {
        Keys::Dsa87(Box::new(qp_rusty_crystals_hdwallet::ml_dsa_87::derive_key_from_mnemonic(
            mnemonic.as_str(), None, &path,
        ).map_err(|_| "Invalid mnemonic or derivation path")?))
    };
    let public_key = keys.public();
    let account_id = qp_poseidon_core::hash_bytes(&public_key);
    Ok(SecretHandle {
        keys: Some(keys),
        address: address_for_id(&account_id),
        account_id,
        public_key,
        path,
        scheme: scheme.to_owned(),
    })
}

/// Holds official zeroize-on-drop keypairs. No secret accessors are exposed.
#[wasm_bindgen]
pub struct SecretHandle {
    keys: Option<Keys>,
    address: String,
    account_id: [u8; 32],
    public_key: Vec<u8>,
    path: String,
    scheme: String,
}

#[wasm_bindgen]
impl SecretHandle {
    #[wasm_bindgen(getter)]
    pub fn address(&self) -> String { self.address.clone() }
    #[wasm_bindgen(getter, js_name = accountId)]
    pub fn account_id(&self) -> Vec<u8> { self.account_id.to_vec() }
    #[wasm_bindgen(getter, js_name = publicKey)]
    pub fn public_key(&self) -> Vec<u8> { self.public_key.clone() }
    #[wasm_bindgen(getter)]
    pub fn path(&self) -> String { self.path.clone() }
    #[wasm_bindgen(getter)]
    pub fn scheme(&self) -> String { self.scheme.clone() }
    #[wasm_bindgen(getter)]
    pub fn cleared(&self) -> bool { self.keys.is_none() }

    /// Sign the complete SCALE SignedPayload. Performs Substrate's >256-byte hash rule.
    /// It never assembles or broadcasts a transaction.
    #[wasm_bindgen(js_name = signPayload)]
    pub fn sign_payload(&self, payload: &[u8], spec_version: u32) -> Result<Vec<u8>, JsError> {
        if spec_version != SUPPORTED_SPEC { return Err(JsError::new("Unsupported runtime: expected specVersion 152")); }
        if payload.is_empty() || payload.len() > MAX_PAYLOAD { return Err(JsError::new("Invalid signing payload length")); }
        let keys = self.keys.as_ref().ok_or_else(|| JsError::new("Signing key has been cleared"))?;
        keys.sign(&message(payload)).map_err(JsError::new)
    }

    /// Immediately drop and zeroize secret key material; safe to call repeatedly.
    pub fn clear(&mut self) { self.keys = None; }
}

#[wasm_bindgen(js_name = deriveAccount)]
pub fn derive_account(mnemonic: String, scheme: &str, account_index: u32) -> Result<SecretHandle, JsError> {
    // The guard ensures even a rejected scheme/index wipes the incoming Rust copy.
    let mut phrase = Zeroizing::new(mnemonic);
    let path = canonical_path(scheme, account_index).map_err(JsError::new)?;
    derive_inner(core::mem::take(&mut *phrase), scheme, path).map_err(JsError::new)
}

/// Explicit canonical BIP44 path option for accounts created with custom HD indices.
#[wasm_bindgen(js_name = deriveAccountAtPath)]
pub fn derive_account_at_path(mnemonic: String, scheme: &str, path: String) -> Result<SecretHandle, JsError> {
    derive_inner(mnemonic, scheme, path).map_err(JsError::new)
}

#[wasm_bindgen(js_name = verifyPayload)]
pub fn verify_payload(public_key: &[u8], payload: &[u8], signature: &[u8], scheme: &str, spec_version: u32) -> bool {
    if spec_version != SUPPORTED_SPEC || payload.is_empty() || payload.len() > MAX_PAYLOAD { return false; }
    let msg = message(payload);
    match scheme {
        "ml-dsa-65" => ml_dsa_65::PublicKey::from_bytes(public_key).map(|p| p.verify(&msg, signature, Some(CONTEXT))).unwrap_or(false),
        "ml-dsa-87" => ml_dsa_87::PublicKey::from_bytes(public_key).map(|p| p.verify(&msg, signature, Some(CONTEXT))).unwrap_or(false),
        _ => false,
    }
}

fn wormhole_path(index: u32, branch: u32) -> Result<String, &'static str> {
    if index >= (1 << 31) || branch > 1 { return Err("Invalid encrypted-account branch or index"); }
    Ok(format!("m/44'/189189189'/0'/{branch}'/{index}'"))
}

/// An official HD seed retained only inside the local Worker/WASM session.
/// No mnemonic, seed, secret or first-hash getter is exported.
#[wasm_bindgen]
pub struct WormholeSession { seed: Option<Box<SensitiveBytes64>> }

impl WormholeSession {
    fn derive_pair(&self, index: u32, branch: u32) -> Result<WormholePair, &'static str> {
        let path = wormhole_path(index, branch)?;
        let seed = self.seed.as_ref().ok_or("Encrypted account is locked")?;
        qp_rusty_crystals_hdwallet::generate_wormhole_from_seed(seed, &path)
            .map_err(|_| "Encrypted-account derivation failed")
    }
}

#[wasm_bindgen]
impl WormholeSession {
    #[wasm_bindgen(js_name = deriveAddress)]
    pub fn derive_address(&self, index: u32, branch: u32) -> Result<String, JsError> {
        let pair = self.derive_pair(index, branch).map_err(JsError::new)?;
        Ok(address_for_id(pair.address()))
    }

    #[wasm_bindgen(js_name = accountId)]
    pub fn account_id(&self, index: u32, branch: u32) -> Result<Vec<u8>, JsError> {
        let pair = self.derive_pair(index, branch).map_err(JsError::new)?;
        Ok(pair.address().to_vec())
    }

    #[wasm_bindgen(js_name = computeNullifier)]
    pub fn compute_nullifier(&self, index: u32, branch: u32, transfer_count: &str, expected_address: &str) -> Result<Vec<u8>, JsError> {
        if transfer_count.is_empty() || transfer_count.len() > 20 || !transfer_count.bytes().all(|b| b.is_ascii_digit()) {
            return Err(JsError::new("Invalid transfer count"));
        }
        let count: u64 = transfer_count.parse().map_err(|_| JsError::new("Invalid transfer count"))?;
        let pair = self.derive_pair(index, branch).map_err(JsError::new)?;
        if address_for_id(pair.address()) != expected_address { return Err(JsError::new("Encrypted-account address mismatch")); }
        Ok(wormhole_nullifier(&pair, count).to_vec())
    }

    #[wasm_bindgen(getter)]
    pub fn cleared(&self) -> bool { self.seed.is_none() }
    pub fn clear(&mut self) { self.seed = None; }
}

// Byte-identical to qp-wormhole-circuit 4.3.0 Nullifier::from_preimage:
// Poseidon2(Poseidon2(string_to_felts("~nullif~") || secret_digest || u64_to_felts(count))).
// Use the already-vendored official core, and explicitly wipe felt copies.
fn wormhole_nullifier(pair: &WormholePair, count: u64) -> [u8; 32] {
    use qp_poseidon_core::{hash_to_bytes, rehash_to_bytes, Goldilocks};
    use qp_poseidon_core::serialization::{bytes_to_digest_lossy, string_to_felts, u64_to_felts};
    fn wipe(values: &mut [Goldilocks]) {
        for value in values { unsafe { core::ptr::write_volatile(value, Goldilocks::default()) }; }
        core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
    }
    let mut secret_felts = bytes_to_digest_lossy(pair.secret().as_bytes());
    let mut preimage = Vec::with_capacity(9);
    preimage.extend(string_to_felts("~nullif~"));
    preimage.extend_from_slice(&secret_felts);
    preimage.extend(u64_to_felts(count));
    let inner = Zeroizing::new(hash_to_bytes(&preimage));
    wipe(&mut secret_felts);
    wipe(&mut preimage);
    rehash_to_bytes(&inner).expect("Poseidon output is canonical")
}

#[wasm_bindgen(js_name = openWormhole)]
pub fn open_wormhole(mnemonic: String) -> Result<WormholeSession, JsError> {
    let mut phrase = Zeroizing::new(mnemonic);
    if phrase.len() > 1024 { return Err(JsError::new("Mnemonic is too long")); }
    let mut seed = Box::new(SensitiveBytes64::zeroed());
    qp_rusty_crystals_hdwallet::mnemonic_to_seed(core::mem::take(&mut *phrase), None, &mut seed)
        .map_err(|_| JsError::new("Invalid encrypted-account mnemonic"))?;
    Ok(WormholeSession { seed: Some(seed) })
}

#[cfg(test)]
mod tests {
    use super::*;
    const PHRASE: &str = "orchard answer curve patient visual flower maze noise retreat penalty cage small earth domain scan pitch bottom crunch theme club client swap slice raven";

    #[test]
    fn official_wallet_address_vectors_both_schemes() {
        for (scheme, expected) in [
            ("ml-dsa-87", "qzm5QCox8Dp5A3oSXZZYHD8YoYgPz7enykZb6RPUropdCyN5h"),
            ("ml-dsa-65", "qzoyC4eRTrexYoutXABVsf61QJZxJim3iWvayRQwEjXWgA4mw"),
        ] {
            let handle = derive_inner(PHRASE.into(), scheme, canonical_path(scheme, 0).unwrap()).unwrap();
            assert_eq!(handle.address(), expected);
        }
    }

    #[test]
    fn official_second_hd_account_vector() {
        let handle = derive_inner(PHRASE.into(), "ml-dsa-87", canonical_path("ml-dsa-87", 1).unwrap()).unwrap();
        assert_eq!(handle.address(), "qzmufPopkLKAwDmTzR5uXg8GMp5sUP48CqafJLUz3fPMSSGSh");
    }

    #[test]
    fn both_schemes_verify_context_and_reject_tampering() {
        for scheme in ["ml-dsa-65", "ml-dsa-87"] {
            let mut handle = derive_inner(PHRASE.into(), scheme, canonical_path(scheme, 0).unwrap()).unwrap();
            for payload in [vec![7; 140], vec![9; 300]] {
                let sig = handle.keys.as_ref().unwrap().sign(&message(&payload)).unwrap();
                assert!(verify_payload(&handle.public_key, &payload, &sig, scheme, 152));
                let mut tampered = payload.clone(); tampered[0] ^= 1;
                assert!(!verify_payload(&handle.public_key, &tampered, &sig, scheme, 152));
                assert!(!verify_payload(&handle.public_key, &payload, &sig, scheme, 147));
                let no_context_valid = if scheme == "ml-dsa-65" {
                    ml_dsa_65::PublicKey::from_bytes(&handle.public_key).unwrap().verify(&message(&payload), &sig, None)
                } else {
                    ml_dsa_87::PublicKey::from_bytes(&handle.public_key).unwrap().verify(&message(&payload), &sig, None)
                };
                assert!(!no_context_valid);
            }
            handle.clear(); handle.clear();
            assert!(handle.cleared());
        }
    }

    #[test]
    fn invalid_inputs_rejected_without_disclosing_phrase() {
        assert_eq!(derive_inner("this is not valid".into(), "ml-dsa-65", canonical_path("ml-dsa-65", 0).unwrap()).err(), Some("Invalid mnemonic or derivation path"));
        assert!(canonical_path("bad", 0).is_err());
        assert!(canonical_path("ml-dsa-65", 1 << 31).is_err());
        assert!(!verify_payload(&[0; 3], &[1; 5], &[0; 3], "ml-dsa-65", 152));
    }

    #[test]
    fn encrypted_session_matches_official_seed_paths_and_clears() {
        let mut session = open_wormhole(PHRASE.into()).unwrap();
        let mut addresses = std::collections::HashSet::new();
        for branch in [0, 1] {
            for index in [0, 1, 20, 100] {
                let path = wormhole_path(index, branch).unwrap();
                let expected = qp_rusty_crystals_hdwallet::derive_wormhole_from_mnemonic(PHRASE, None, &path).unwrap();
                let actual = session.derive_pair(index, branch).unwrap();
                assert_eq!(actual.address(), expected.address());
                assert!(addresses.insert(address_for_id(actual.address())));
                assert_ne!(wormhole_nullifier(&actual, 0), wormhole_nullifier(&actual, u64::MAX));
            }
        }
        assert!(wormhole_path(0, 2).is_err());
        assert!(wormhole_path(1 << 31, 0).is_err());
        session.clear(); session.clear();
        assert!(session.cleared());
        assert!(session.derive_pair(0, 0).is_err());
    }
}
