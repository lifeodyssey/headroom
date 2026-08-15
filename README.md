[English](README.md) | [中文](README.zh-CN.md)

# dsh-compressor

[![npm](https://img.shields.io/npm/v/dsh-compressor.svg)](https://www.npmjs.com/package/dsh-compressor)
[![CI](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml/badge.svg)](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml)

Compresses tool output and cuts up to 20% of context, without affecting the model's context cache or agent performance.

## Install

```bash
dsh plugin --profile web add dsh-compressor
```

## How it works

A tool run leaves a long log / JSON / diff. Only a small part of it is useful. This plugin shortens that output before the next turn, keeps the original on disk, leaves the already-sent prefix alone so the cache stays valid, and gives the agent a tool to pull the full context back.

```mermaid
flowchart LR
  A[Tool finishes] --> B{Output long?}
  B -->|no| C[Full text stays]
  B -->|yes| D[Shorten and save original]
  D --> E[Model sees the useful part]
```

Compressor code comes from [Headroom](https://github.com/headroomlabs-ai/headroom). Wired in today: Log / Smart / Text / Search / Diff. The only crushers not wired in yet:

- [ ] Code-aware (tree-sitter, source code)
- [ ] Kompress (ONNX, long prose)

## Develop

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
```

## Contributing

Open PRs on this repo, not on Headroom.

Plugin code is in `plugins/dsh-compressor` (Node 22+, pnpm):

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
pnpm typecheck
```

Crushers live in `crates/`:

```bash
cargo test --workspace
make test-parity
```

One change per PR. Plugin changes need tests; crusher changes need `cargo test`. Details: [CONTRIBUTING.md](CONTRIBUTING.md).

This plugin is MIT. `crates/headroom-*` remains Apache-2.0.
