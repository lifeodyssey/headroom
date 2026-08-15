# Contributing

PRs go to [lifeodyssey/dsh-compressor](https://github.com/lifeodyssey/dsh-compressor). Do not open them against Headroom.

## Layout

| Path | What |
| --- | --- |
| `plugins/dsh-compressor` | DSH plugin (hooks, retrieve, tests) |
| `crates/headroom-napi` | napi bindings used by the plugin |
| `crates/headroom-core` | crushers (from Headroom) |
| `crates/headroom-parity` | crusher fixture parity |

## Plugin

Needs Node 22+ and [pnpm](https://pnpm.io/).

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
pnpm typecheck
```

JS changes: `pnpm build`. Rust crusher or napi changes: `pnpm build:native` (needs a Rust toolchain and this repo's Cargo workspace).

## Crushers

```bash
cargo test --workspace
make test-parity
```

`cargo fmt` / `cargo clippy --workspace -- -D warnings` before you push.

## Pull requests

1. Fork, branch from `main`.
2. Keep the diff to one change.
3. Plugin changes need a failing-then-passing test under `plugins/dsh-compressor`.
4. Crusher changes need `cargo test` and, if you touch crush output, a parity fixture update.

## License

This plugin is MIT. `crates/headroom-*` is still Apache-2.0 (Headroom). See `LICENSE` and `LICENSE-APACHE`.
