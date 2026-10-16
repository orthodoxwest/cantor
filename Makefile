.PHONY: setup neuma check test e2e eval wasm content

# Everything a fresh clone needs: the neuma browser module, Rust's wasm target, npm packages, Playwright's browser.
setup: neuma
	rustup target add wasm32-unknown-unknown
	npm ci
	npx --workspace web --if-present playwright install chromium

neuma:
	sh scripts/neuma.sh

# What to run before pushing; CI runs the same.
check: test wasm eval content e2e

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

eval:
	cargo run -q -p cantor-cli -- eval

content:
	node content/build.mjs
