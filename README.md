# dsh-compressor

In-process [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. It crushes long tool results (logs, JSON, CJK text, search, diffs) before they hit `Session.deriveMessages()`, stores the original on disk, and gives the model `compressor_retrieve` to get it back.

This repository is a fork of Headroom. The product of **this** fork is the DSH plugin, not the Headroom proxy or MCP server.

## Install

From a checkout:

```bash
dsh plugin --profile web add ./plugins/dsh-compressor
```

From GitHub (after #18 is on `main`):

```bash
dsh plugin --profile web add github:lifeodyssey/dsh-compressor#path:plugins/dsh-compressor
```

Until that merge, pin the branch:

```bash
dsh plugin --profile web add 'github:lifeodyssey/dsh-compressor#feat/deepseek-harness-plugin&path:plugins/dsh-compressor'
```

Then start DSH as usual (`dsh web` or your profile). The layer should appear in `dsh --profile web --dump-config` as `dsh-compressor`.

Need `pnpm` on PATH. `dsh plugin` is a thin wrapper around `pnpm add` in the profile directory.

## What the model sees

Eligible `bash` / `run_code` (and similar) results become:

```
[crushed extract]
<<compressor:64-hex-sha256>>
Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.
```

The model calls `compressor_retrieve` with the locator or the bare hash. That is a real DSH tool, not a Headroom CCR / HTTP retrieve.

Left alone by default: user / system / assistant text, Read / Glob / Grep / Write / Edit / Web*, short results, protected errors, recent source code, official DSH spill notices (those stay as a file path + `read`/`grep`).

## Publish

The installable package lives in `plugins/dsh-compressor/` (`name`: `dsh-compressor`, not on npm yet).

```bash
cd plugins/dsh-compressor
pnpm install
pnpm build          # emits lib/
# native/*.node already ships darwin-arm64 + linux-x64-gnu
npm publish --access public
```

After that, anyone can:

```bash
dsh plugin --profile web add dsh-compressor
```

Do not publish from the repo root. That is still a Headroom tree.

Details: [plugins/dsh-compressor/README.md](plugins/dsh-compressor/README.md).

## Develop

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
pnpm typecheck
```

Specs and tickets: [lifeodyssey/dsh-compressor issues](https://github.com/lifeodyssey/dsh-compressor/issues). Always pass `-R lifeodyssey/dsh-compressor` to `gh`.

## License

Apache-2.0. Crushers are the official Headroom Rust implementations (Log, Smart, Text/CJK, Search, Diff) via napi. Code-aware and Kompress stay off.
