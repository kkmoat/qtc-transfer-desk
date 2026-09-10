# Quantus browser crypto resource

This small WASM adapter uses the official Quantus primitives with exact versions:

- `qp-rusty-crystals-dilithium = 4.1.1` (ML-DSA-65 + ML-DSA-87)
- `qp-rusty-crystals-hdwallet = 4.1.1`
- `qp-poseidon-core = 3.1.0`
- `wasm-bindgen = 0.2.114`

The matching `Cargo.lock` pins all transitive dependencies. Source license: GPL-3.0-only, reflecting the official crypto libraries. Distribute the corresponding source and license alongside public WASM assets. This is a small application adapter, not an official Quantus release or a security audit.

## Browser API

```js
import init, { deriveAccount, deriveAccountAtPath, verifyPayload } from './pkg-web/quantus_browser_crypto.js';
await init(); // resolves quantus_browser_crypto_bg.wasm next to the JS file
const handle = deriveAccount(userEnteredPhrase, 'ml-dsa-65', 0);
// Available public getters: address, accountId (Uint8Array), publicKey,
// path, scheme, cleared.
const signature = handle.signPayload(completeScaleSigningPayload, 152);
const valid = verifyPayload(handle.publicKey, completeScaleSigningPayload, signature, handle.scheme, 152);
handle.clear(); // drops official zeroize-on-drop keys; idempotent
handle.free();  // also release the wasm-bindgen object allocation; call once
```

`deriveAccountAtPath(phrase, scheme, path)` supports an explicitly selected HD path. For standard accounts use `deriveAccount` to derive `m/44'/189189'/<account>'/0'/1'` for ML-DSA-65 or `.../0'` for ML-DSA-87. No BIP39 passphrase is added. After importing, compare the full public address to the intended funded address. Changing the scheme/path produces a different account.

`signPayload` takes the full SCALE signed payload, not an already-hashed payload: it hashes payloads longer than 256 bytes using Blake2b-256, then signs using FIPS-204 context `QUANTUS_EXTRINSIC`. Runtime **152 only** is accepted. The caller must independently pin mainnet genesis, transactionVersion 6, metadata/call indexes and extension layout. A future runtime requires a review and explicit adapter update.

Signature result lengths: 65 = 3309, 87 = 4627 bytes. Public keys: 65 = 1952, 87 = 2592 bytes. For the current chain signature enum use variant 1 for 65 or 0 for 87, followed by signature then public key. This resource does not encode complete extrinsics, connect to RPC, broadcast, store data, or export secrets.

## Encrypted accounts (Wormhole)

`openWormhole(phrase)` returns a separate `WormholeSession` whose BIP39 seed is retained in an official zeroizing `SensitiveBytes64`. It exposes only:

- `deriveAddress(index, branch)` and `accountId(index, branch)`; branch 0 receives, branch 1 is change.
- `computeNullifier(index, branch, transferCountDecimal, expectedAddress)`, which verifies address ownership and accepts the full u64 count without floating-point conversion.
- `clear()`, `free()`, and `cleared` for session lifecycle.

Canonical paths are `m/44'/189189189'/0'/branch'/index'`, matching Quantus apps commit `76df7b06d7a092c9cdfb9a459f8effb9ddb5e737`. No secret, first hash, seed, or mnemonic getter is exposed. The Worker can return public addresses and nullifiers for read-only balance queries. It does not export proofs or enable encrypted withdrawals.

The nullifier uses the official Poseidon construction. Tests cross-check both HD branches and full-width transfer counts against published `qp-wormhole-circuit 4.3.0` behavior; only the already-vendored Poseidon implementation is compiled into this small adapter. No proving dependencies were added. Ordinary ML-DSA signing remains separate.

## Sensitive memory

The WASM handle holds the private key; JavaScript receives only public data and signatures. Incoming Rust mnemonic copies use `Zeroizing<String>` and are erased on return. The official keypair's secret storage erases on drop. Call `clear()` and `free()` in a `finally` block; a dedicated worker should also be terminated after use. JavaScript strings/DOM input remain managed by the browser and cannot be guaranteed erased by this module; clear the input and references immediately. This does not protect against malicious same-origin JavaScript, compromised browser extensions, or a compromised page.

Error messages deliberately omit mnemonic contents. No password, mnemonic, or secret seed is logged.

## Verification

`cargo test --release` verifies official cross-project account vectors, correct scheme-specific paths, context separation (empty context must fail), tampering, long-message hashing, and clear behavior. `node test-node.cjs` executes the actual WASM build with both schemes and 140/256/257/300 byte payloads, tests malformed inputs and cleared-handle rejection.

Fixtures are publicly documented test mnemonics from official repositories. They must never hold real funds. No test broadcasts a transaction or reads any user wallet.

References:

- https://github.com/Quantus-Network/quantus-apps/blob/main/quantus_sdk/rust/src/api/crypto.rs
- https://github.com/Quantus-Network/quantus-apps/blob/main/quantus_sdk/rust/src/signing_context.rs
- https://github.com/Quantus-Network/quantus-wasm/blob/main/src/ext.rs
- https://github.com/Quantus-Network/chain/blob/main/primitives/dilithium-crypto/src/types.rs

The official published npm `@quantus-network/wasm@0.2.0` was unsuitable for this task: its package omitted the WASM/glue files, targets Node.js, supports only ML-DSA-87, and predates the required extrinsic signing context. This adapter uses the current official crypto crates directly.
