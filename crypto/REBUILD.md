# Rebuild the source package

This artifact was built with Rust 1.98.1, wasm32-unknown-unknown standard library, and wasm-bindgen CLI 0.2.114 on macOS arm64. The source is portable; no Apple APIs are used.

Install Rust through its official distribution, add target `wasm32-unknown-unknown`, and install/download the official wasm-bindgen CLI **0.2.114** for your platform. Then, from this source directory:

```sh
mkdir -p .cargo
cp cargo-vendor-config.toml .cargo/config.toml
cargo test --release --locked --offline
cargo build --release --locked --offline --target wasm32-unknown-unknown
wasm-bindgen target/wasm32-unknown-unknown/release/quantus_browser_crypto.wasm --target web --out-dir pkg-web
wasm-bindgen target/wasm32-unknown-unknown/release/quantus_browser_crypto.wasm --target nodejs --out-dir pkg-node
node test-node.cjs
```

`vendor/` contains every dependency in `Cargo.lock`, including third-party license files. The Rust toolchain and wasm-bindgen CLI executables themselves are ordinary build tools and are not bundled. The workspace `build.sh` is a convenience for the original task's isolated toolchain layout; the commands above work with tools installed elsewhere.

Serve both generated `pkg-web/quantus_browser_crypto.js` and `pkg-web/quantus_browser_crypto_bg.wasm` together. The page must never send its input phrase to a server. Do not fund the published test mnemonic.
