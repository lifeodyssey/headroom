[English](README.md) | [中文](README.zh-CN.md)

# dsh-compressor

[![npm](https://img.shields.io/npm/v/dsh-compressor.svg)](https://www.npmjs.com/package/dsh-compressor)
[![CI](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml/badge.svg)](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml)

A DeepSeek Harness plugin that compresses tool output and cuts up to 20% of context, without affecting the model's context cache or agent performance.

## Install

```bash
dsh plugin --profile web add dsh-compressor
```

## How it works

A tool run leaves a long log. Only a small part of it is useful. This plugin shortens that output before the next turn, keeps the original on disk, and does not rewrite the prefix already sent to the model. To get the full text back, the model calls `compressor_retrieve`.

```mermaid
flowchart LR
  A[Tool finishes] --> B{Output long?}
  B -->|no| C[Full text stays]
  B -->|yes| D[Shorten and save original]
  D --> E[Model sees the useful part]
  E --> F[Need the full text? compressor_retrieve]
```

Compressor code comes from [Headroom](https://github.com/headroomlabs-ai/headroom). Wired in today: Log / Smart / Text / Search / Diff.

- [ ] TODO: migrate the remaining compressors (Code-aware, Kompress, …)

## Develop

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
```

## Contributing

Plugin code lives in `plugins/dsh-compressor`, crushers in `crates/`. Open PRs on [lifeodyssey/dsh-compressor](https://github.com/lifeodyssey/dsh-compressor), not on upstream Headroom.
