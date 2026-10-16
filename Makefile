.PHONY: setup neuma check test e2e eval oracle wasm content

# Everything a fresh clone needs: the neuma browser module, Rust's wasm target and cantor.wasm,
# npm packages, Playwright's browser.
setup: neuma
	rustup target add wasm32-unknown-unknown
	sh scripts/cantor-wasm.sh
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
	sh scripts/cantor-wasm.sh

e2e:
	npm run e2e

# The listening gates; TAKES=../cantor-content/evals/takes adds the real takes, ORACLE=1 the
# oracle's labels (after `make oracle`).
eval:
	cargo run -q -p cantor-cli -- eval $(if $(TAKES),--takes $(TAKES)) $(if $(ORACLE),--oracle vendor/crepe/full.onnx)
	cargo run -q -p cantor-cli -- eval --nsdf-only $(if $(TAKES),--takes $(TAKES))

# The oracle's model, built from torchcrepe's published weights; needs numpy and onnx.
oracle:
	python3 scripts/crepe.py

content:
	node content/build.mjs
