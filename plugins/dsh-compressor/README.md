[English](README.md) | [中文](README.zh-CN.md)

# dsh-compressor

> Cut up to 20% of a DeepSeek Harness session — without hurting the model, and without busting the prefix cache.

[![npm](https://img.shields.io/npm/v/dsh-compressor.svg)](https://www.npmjs.com/package/dsh-compressor)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)

In-process DSH plugin. Long tool results are crushed before `Session.deriveMessages()`. Originals go to disk; the model calls `compressor_retrieve` to restore them.

```bash
dsh plugin --profile web add dsh-compressor
```

`pnpm` must be on PATH. `dsh --profile web --dump-config` should show `id: dsh-compressor`.

The model sees an extract plus `<<compressor:64-hex>>` — not a filesystem path. Official DSH spill is left alone.

Dev: `pnpm install && pnpm test`. More: [repository README](https://github.com/lifeodyssey/dsh-compressor#readme).
