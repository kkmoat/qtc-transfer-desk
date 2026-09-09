#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export CARGO_HOME="$PWD/toolchain/cargo"
export RUSTUP_HOME="$PWD/toolchain/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
cargo test --release --locked
cargo build --release --locked --target wasm32-unknown-unknown
toolchain/wasm-bindgen-0.2.114-aarch64-apple-darwin/wasm-bindgen target/wasm32-unknown-unknown/release/quantus_browser_crypto.wasm --target web --out-dir pkg-web
toolchain/wasm-bindgen-0.2.114-aarch64-apple-darwin/wasm-bindgen target/wasm32-unknown-unknown/release/quantus_browser_crypto.wasm --target nodejs --out-dir pkg-node
node test-node.cjs
