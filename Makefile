# Rust build targets for the slimmed DSH fork (core + napi + parity).

SHELL := /bin/bash
CARGO ?= cargo
FIXTURES ?= tests/parity/fixtures

.PHONY: help test test-parity bench fmt fmt-check lint clippy clean ci-precheck-rust

help:
	@echo "Rust targets:"
	@echo "  make test               - cargo test --workspace"
	@echo "  make test-parity        - parity-run against recorded fixtures"
	@echo "  make bench              - cargo bench --workspace"
	@echo "  make fmt                - cargo fmt --all"
	@echo "  make fmt-check          - cargo fmt --all -- --check"
	@echo "  make lint               - cargo clippy --workspace -- -D warnings"
	@echo "  make clean              - cargo clean"
	@echo "  make ci-precheck-rust   - cargo fmt --check + clippy + test"

test:
	$(CARGO) test --workspace

# headroom-parity comparators call headroom-core directly (no Python).
test-parity:
	$(CARGO) run -p headroom-parity -- run --fixtures $(FIXTURES)

bench:
	$(CARGO) bench --workspace

fmt:
	$(CARGO) fmt --all

fmt-check:
	$(CARGO) fmt --all -- --check

clippy lint:
	$(CARGO) clippy --workspace -- -D warnings

clean:
	$(CARGO) clean

ci-precheck-rust:
	@echo "── ci-precheck-rust ────────────────────────────────────────────"
	$(CARGO) fmt --all -- --check
	$(CARGO) clippy --workspace -- -D warnings
	$(CARGO) test --workspace
