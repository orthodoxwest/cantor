#!/bin/sh
# Builds neuma's browser module at the revision Cargo.toml pins, into vendor/neuma/.
# Cached by revision: nothing happens when vendor/neuma/REV already matches.
set -e
cd "$(dirname "$0")/.."
REV=$(sed -n 's/^neuma = .*rev = "\([0-9a-f]*\)".*/\1/p' Cargo.toml)
[ -n "$REV" ] || { echo "neuma revision not found in Cargo.toml" >&2; exit 1; }
if [ "$(cat vendor/neuma/REV 2>/dev/null)" = "$REV" ] && [ -f vendor/neuma/neuma.wasm ] && [ -f vendor/neuma/neuma.mjs ]; then exit 0; fi
SRC=vendor/neuma-src
if [ ! -d "$SRC/.git" ]; then
  git clone --quiet --filter=blob:none https://github.com/orthodoxwest/neuma "$SRC"
fi
git -C "$SRC" fetch --quiet origin "$REV"
git -C "$SRC" checkout --quiet "$REV"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
(cd "$SRC" && cargo build --quiet -p neuma-wasm --target wasm32-unknown-unknown --profile wasm && node crates/neuma-wasm/build.mjs)
mkdir -p vendor/neuma
cp "$SRC"/crates/neuma-wasm/dist/neuma.mjs "$SRC"/crates/neuma-wasm/dist/neuma.d.mts "$SRC"/crates/neuma-wasm/dist/neuma-external.mjs "$SRC"/crates/neuma-wasm/dist/neuma-external.d.mts "$SRC"/crates/neuma-wasm/dist/neuma.wasm vendor/neuma/
cp "$SRC"/crates/neuma-wasm/package.json vendor/neuma/package.json
echo "$REV" > vendor/neuma/REV
