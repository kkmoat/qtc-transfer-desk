# Quantus browser crypto resource

This WASM adapter uses the official Quantus primitives with exact versions:

- `qp-rusty-crystals-dilithium = 4.1.1` (ML-DSA-65 + ML-DSA-87)
- `qp-rusty-crystals-hdwallet = 4.1.1`
- `qp-poseidon-core = 3.1.0`
- `wasm-bindgen = 0.2.114`
- Optional `wormhole-prover` feature: `qp-wormhole-{circuit,prover,aggregator} = 4.3.0`, `qp-zk-circuits-common = 4.3.0`, `qp-plonky2 = 1.5.5`

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

Canonical paths are `m/44'/189189189'/0'/branch'/index'`, matching Quantus apps commit `76df7b06d7a092c9cdfb9a459f8effb9ddb5e737`. No secret, first hash, seed, or mnemonic getter is exposed. The nullifier uses the official Poseidon construction, cross-checked against `qp-wormhole-circuit 4.3.0` for both branches and full-width transfer counts.

## Local encrypted self-withdrawal

The site dynamically imports `quantus_wormhole_crypto.js` inside the existing Worker only when opening an encrypted account. The heavy module creates and owns the seed session directly; seed bytes never cross WASM instances or leave the Worker. Ordinary signing uses the separate default build.

The heavy `WormholeSession` additionally provides:

- `normalInfo(accountIndex)`: JSON containing only the same seed's normal ML-DSA-65 address, account ID, public key and canonical path.
- `prepareWithdrawal(requestJson)`: an opaque one-shot `WithdrawalJob`. It validates the public snapshot, ownership, Merkle paths, header hash and all amounts before retaining the private witnesses.
- `job.summary()`, `job.proveNextLeaf()` and `job.aggregate()`. The final opaque result exposes `proofBytes` and a JSON public summary. Leaf proofs and private witnesses are never exported.

The matching Worker messages are `wormhole-normal`, `wormhole-check`, and `wormhole-prove`; `wormhole-derive` and `wormhole-nullifiers` retain their existing read-only APIs. Proving emits `{id, progress: {stage, completed, total}}`; final messages retain `{id, ok, result}`. Stages are `leaf`, `aggregate`, and `verified`. Closing clears the seed, frees pending witnesses, and rejects future operations; the UI terminates the Worker to cancel synchronous proving. It also terminates it after broadcast and separately tracks the public transaction.

This version consumes the entire selected one to seven UTXOs and sends the combined net amount only to a normal account derived from the same seed. It does not create encrypted change. Unselected UTXOs remain untouched. The official scale-down factor is 10,000,000,000 Planck (0.01 QTC) per unit. Each input is rounded down to units; the batch net is `floor(sumUnits * 9996 / 10000)`, with the fee allocated backwards across inputs. `feePlanck = inputPlanck - netPlanck` includes both the chain volume fee and input quantization dust. The client displays those separately. No website service fee is taken from this first self-withdrawal. The subsequent independently reviewed normal transfer retains the site's disclosed 0.5% service fee.

The adapter accepts only specVersion 152, the fixed mainnet genesis, the reviewed runtime code Blake2-256 `0x4a2d509dfa3faf06a9645bd444d5f2f63ac8ab2f75ba540a0b84680a514514fa`, asset 0 and volume fee 4 bps. The client must establish these values from finalized public RPC state; a supplied JSON string alone does not prove chain canonicality. Leaf data, transfer count, raw amount, derived account, Poseidon leaf hash, sorted Merkle membership and the header hash are checked again inside WASM. The recipient and output allocations are constructed internally.

After aggregation, the exact outgoing proof bytes are deserialized and verified against the canonical source-built verifier. All 162 actual public inputs are returned and checked for the expected block, fee, summed output, self-account and real nullifier subset. The seven nullifiers include nonzero dummy nullifiers; the client checks all seven against chain state before submission. Canonical verifier and common byte hashes are fixed in `src/wormhole_proof.rs` and match the reviewed runtime's embedded verifier. Runtime changes require explicit review.

The public fixture in `test-fixtures/withdrawal-public.json` is synthetic and deliberately has no valid funded chain inclusion. It may be used to exercise the complete prover without sending any transaction. A real Chrome 152 Worker completed this fixture, rejected eleven altered requests, matched serialized proof public inputs, rejected operations after close, and reopened the same ordinary account for a signing regression. External network access was blocked; only localhost static assets were loaded. One-input proof generation used approximately 42 seconds and 903 MiB of WASM memory on the test machine. These checks are not an independent security audit or a guarantee of safety on every browser.

## Sensitive memory

The WASM handle holds the private key; JavaScript receives only public data and signatures. Incoming Rust mnemonic copies use `Zeroizing<String>` and are erased on return. The official keypair's secret storage erases on drop. Call `clear()` and `free()` in a `finally` block; a dedicated worker should also be terminated after use. JavaScript strings/DOM input remain managed by the browser and cannot be guaranteed erased by this module; clear the input and references immediately. This does not protect against malicious same-origin JavaScript, compromised browser extensions, or a compromised page.

Error messages deliberately omit mnemonic contents. No password, mnemonic, or secret seed is logged.

## Verification

`cargo test --release --features wormhole-prover` verifies official cross-project account vectors, correct scheme-specific paths, context separation (empty context must fail), tampering, long-message hashing, and clear behavior. `node test-node.cjs` executes the actual WASM build with both schemes and 140/256/257/300 byte payloads, tests malformed inputs and cleared-handle rejection. When `QUANTUS_WORMHOLE_NODE_MODULE` points to the heavy Node binding it also executes full proof generation and byte/public-input binding. `build.sh` runs both suites using vendored dependencies.

Fixtures are publicly documented test mnemonics from official repositories. They must never hold real funds. No test broadcasts a transaction or reads any user wallet.

References:

- https://github.com/Quantus-Network/quantus-apps/blob/main/quantus_sdk/rust/src/api/crypto.rs
- https://github.com/Quantus-Network/quantus-apps/blob/main/quantus_sdk/rust/src/signing_context.rs
- https://github.com/Quantus-Network/quantus-wasm/blob/main/src/ext.rs
- https://github.com/Quantus-Network/chain/blob/main/primitives/dilithium-crypto/src/types.rs

The official published npm `@quantus-network/wasm@0.2.0` was unsuitable for this task: its package omitted the WASM/glue files, targets Node.js, supports only ML-DSA-87, and predates the required extrinsic signing context. This adapter uses the current official crypto crates directly.
