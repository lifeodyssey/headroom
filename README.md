[English](README.md) | [中文](README.zh-CN.md)

# dsh-compressor

> Cut up to 20% of a DeepSeek Harness session — without hurting the model, and without busting the prefix cache.

[![npm](https://img.shields.io/npm/v/dsh-compressor.svg)](https://www.npmjs.com/package/dsh-compressor)
[![CI](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml/badge.svg)](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. It crushes long tool results *before* they hit `Session.deriveMessages()`, stores the original on disk, and gives the model a real tool — `compressor_retrieve` — to get them back.

On 20 redacted real DSH sessions, `deriveMessages()` JSON shrank by **up to 20%**. Official DSH spill is left alone.

## Why

A DSH agent that runs `bash` / `run_code` for an hour fills the context with logs, JSON, and diffs the model already used. Official spill writes the full result to a file and tells the model to `read` / `grep` it — that's another tool hop, and the preview still sits in the transcript.

[Headroom](https://github.com/headroomlabs-ai/headroom) already has the crushers for this. They ship as a proxy / wrap product. This repo is those crushers living *inside* DSH, so the prefix already sent to the model is never rewritten.

## Install

Needs [`pnpm`](https://pnpm.io/) on `PATH`.

```bash
dsh plugin --profile web add dsh-compressor
```

From this repo:

```bash
dsh plugin --profile web add github:lifeodyssey/dsh-compressor#path:plugins/dsh-compressor
dsh plugin --profile web add ./plugins/dsh-compressor
```

Then start DSH. Confirm the layer:

```bash
dsh --profile web --dump-config
```

You should see `id: dsh-compressor`.

## What the model sees

Eligible tool results become:

```
[crushed extract]
<<compressor:64-hex-sha256>>
Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.
```

`compressor_retrieve` is a normal DSH tool. The locator is not a file — do not `Read` it.

Left alone: user / system / assistant text, Read / Glob / Grep / Write / Edit / Web*, short results, protected errors, recent source, official DSH spill notices.

## Compared with doing nothing

| | Without this plugin | With dsh-compressor |
| --- | --- | --- |
| Long `bash` / `run_code` output | Stays in every later turn | Crushed extract + locator |
| Already-sent prefix | Grows every step | Byte-stable after first crush |
| Full original | Only if you still have the tool output | Disk + `compressor_retrieve` |
| Official DSH spill | Works | Still works — we don't touch it |
| Extra hop | Spill → `read` / `grep` | One official tool call |

## How it works

1. **`tools/post-execute`** — crush a new tool result as DSH accepts it.
2. **`agent/pre-step`** — rewrite eligible `tool/result` nodes on the session surface so `Session.deriveMessages()` sees the crushed form. A second pass is a no-op (prefix cache).
3. **Originals** live at `$DSH_HOME/dsh-compressor/<sha256>`.
4. **Fail-closed** — if `compressor_retrieve` or the system-prompt section cannot register, nothing is crushed.

Crushers are Headroom's official Rust Log / Smart / Text(CJK) / Search / Diff, via napi (`darwin-arm64`, `linux-x64-gnu`). Code-aware and Kompress are not linked.

## Develop

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
pnpm typecheck
```

Rebuild JS after edits: `pnpm build`. Rebuild the native addon only if you change Rust crushers: `pnpm build:native` (needs this repo's Cargo workspace).

Reproduce the 20-session numbers: `node scripts/measure-sessions.mjs`.

Issues: [lifeodyssey/dsh-compressor](https://github.com/lifeodyssey/dsh-compressor/issues) — always `gh … -R lifeodyssey/dsh-compressor`.

Apache-2.0. Crushers come from Headroom.
