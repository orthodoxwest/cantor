#!/bin/sh
# Builds cantor-wasm and puts it where the web app serves it (web/public/cantor.wasm).
set -e
cd "$(dirname "$0")/.."
cargo build --quiet -p cantor-wasm --target wasm32-unknown-unknown --profile wasm
mkdir -p web/public
cp target/wasm32-unknown-unknown/wasm/cantor_wasm.wasm web/public/cantor.wasm
