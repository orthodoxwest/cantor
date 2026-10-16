.PHONY: setup neuma check test e2e e2e-full eval wasm

# Everything a fresh clone needs: the neuma browser module, Rust's wasm target, npm packages, Playwright's browser.
setup: neuma
	rustup target add wasm32-unknown-unknown
	npm ci
	npx --workspace web --if-present playwright install chromium

neuma:
	sh scripts/neuma.sh

# What to run before pushing. CI runs exactly this plus e2e-full.
check: test wasm e2e

test:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --workspace
	npm run check
	npm test

wasm:
	cargo build -p cantor-wasm --target wasm32-unknown-unknown --profile wasm

e2e:
	npm run e2e

e2e-full:
	npm run e2e:full

eval:
	cargo run -q -p cantor-cli -- eval
