# Rebuild both browser modules

The source was tested using Rust 1.98.1, target `wasm32-unknown-unknown`, wasm-bindgen CLI **0.2.114**, and Node 24 on macOS arm64. The adapter uses portable Rust; browser proofs do not require threads, SharedArrayBuffer, a server, or a GPU.

Install Rust and the WebAssembly target through the official Rust distribution, and install the official wasm-bindgen CLI 0.2.114 for your platform. Build tools themselves are not included. From this directory:

```sh
rustup target add wasm32-unknown-unknown
# Install wasm-bindgen-cli 0.2.114 separately, or put its official binary on PATH.
bash build.sh
```

`build.sh` uses `cargo-vendor-config.toml` explicitly and `--locked --offline` for every Cargo operation. The complete dependency sources and their original licenses are in `vendor/`. No registry access is needed after installing the tools. `QTC_CARGO` and `QTC_WASM_BINDGEN` may name tool executables outside this directory. `CARGO_TARGET_DIR` may name an external build cache; it is not added to the source package. The script does not modify `HOME`, `RUSTUP_HOME` or `CARGO_HOME`.

The script builds these separately from the same crate:

1. Default features: `quantus_browser_crypto` for normal account derivation and signing.
2. Feature `wormhole-prover`: `quantus_wormhole_crypto` for the opaque encrypted seed session and canonical local proof creation.

The heavier build requires `--cfg getrandom_backend="wasm_js"` for the official prover's browser randomness. The script supplies this setting and remaps the source root to avoid embedding the developer's absolute path. Native tests and actual generated Node WASM tests run before completion, including the public synthetic self-withdrawal fixture and rejection checks. Test fixtures are compromised public vectors: never fund them.

Outputs are `pkg-web/` (browser glue, WASM and declarations) and `pkg-node/` (Node test bindings). After review, copy each module's `.js`, `.d.ts`, and `_bg.wasm` into the site's `public/crypto/`; do not copy Node bindings. Keep the matching `worker.js` from the website repository. Run the website's source packaging and hash verification scripts before release. Changing Rust, LLVM, wasm-bindgen, profile settings, or source-path layout may change binary hashes; the current published hashes identify reviewed artifacts and are not a claim of independent bit-for-bit reproduction.

The proof is generated from the vendored circuit definitions. No external `prover.bin`, trusted secret setup material, or downloaded proof verifier is loaded. At aggregation time the adapter checks SHA-256 of its canonical common/verifier serialization against bytes embedded in the pinned mainnet runtime. The web client separately checks live runtime code and finalized state before proof generation and submission.

A Chrome 152 test using the actual Worker and the published-style web WASM generated a one-input, seven-slot private batch in approximately 42 seconds with about 903 MiB of WASM linear memory. More inputs and slower hardware can take longer. Terminate the Worker to cancel computation and release its retained memory. Cancellation after transaction submission cannot reverse a chain transaction.
