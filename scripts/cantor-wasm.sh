#!/bin/sh
# Builds cantor-wasm and cantor-ear and puts them where the web app serves them
# (web/public/cantor.wasm, web/public/ear.wasm).
set -e
cd "$(dirname "$0")/.."
cargo build --quiet -p cantor-wasm -p cantor-ear --target wasm32-unknown-unknown --profile wasm
mkdir -p web/public
cp target/wasm32-unknown-unknown/wasm/cantor_wasm.wasm web/public/cantor.wasm
cp target/wasm32-unknown-unknown/wasm/cantor_ear.wasm web/public/ear.wasm
