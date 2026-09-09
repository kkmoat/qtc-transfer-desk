//! Browser-local signing bridge. No network, storage, or secret export APIs.
//! The caller must independently verify the intended chain and review the transaction.
use blake2::{Blake2b512, Blake2b, Digest, digest::consts::U32};
use qp_rusty_crystals_dilithium::{ml_dsa_65, ml_dsa_87};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

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
}
