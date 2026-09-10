#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# Install the toolchain separately. No machine-specific paths or downloaded executables.
QTC_CARGO=${QTC_CARGO:-cargo}
QTC_WASM_BINDGEN=${QTC_WASM_BINDGEN:-wasm-bindgen}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-"$PWD/target"}
export RUSTFLAGS="${RUSTFLAGS:-} --cfg getrandom_backend=\"wasm_js\" --remap-path-prefix=$PWD=."
mkdir -p pkg-web pkg-node
printf '%s\n' '{"type":"commonjs"}' > pkg-node/package.json
"$QTC_CARGO" test --config cargo-vendor-config.toml --config "source.vendored-sources.directory='$PWD/vendor'" --release --features wormhole-prover --locked --offline
"$QTC_CARGO" build --config cargo-vendor-config.toml --config "source.vendored-sources.directory='$PWD/vendor'" --release --locked --offline --target wasm32-unknown-unknown
"$QTC_WASM_BINDGEN" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/quantus_browser_crypto.wasm" --target web --out-dir pkg-web --out-name quantus_browser_crypto
"$QTC_WASM_BINDGEN" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/quantus_browser_crypto.wasm" --target nodejs --out-dir pkg-node --out-name quantus_browser_crypto
"$QTC_CARGO" build --config cargo-vendor-config.toml --config "source.vendored-sources.directory='$PWD/vendor'" --release --features wormhole-prover --locked --offline --target wasm32-unknown-unknown
"$QTC_WASM_BINDGEN" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/quantus_browser_crypto.wasm" --target web --out-dir pkg-web --out-name quantus_wormhole_crypto
"$QTC_WASM_BINDGEN" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/quantus_browser_crypto.wasm" --target nodejs --out-dir pkg-node --out-name quantus_wormhole_crypto
QUANTUS_CRYPTO_NODE_MODULE="$PWD/pkg-node/quantus_browser_crypto.js" QUANTUS_WORMHOLE_NODE_MODULE="$PWD/pkg-node/quantus_wormhole_crypto.js" node test-node.cjs
printf '%s\n' 'Both modules and tests completed. Review pkg-web before copying .js, .d.ts and _bg.wasm into public/crypto.'
