# dsh-compressor

In-process [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. It crushes long tool results (logs, JSON, CJK text, search, diffs) before they hit `Session.deriveMessages()`, stores the original on disk, and gives the model `compressor_retrieve` to get it back.

This repository is a fork of [Headroom](https://github.com/chopratejas/headroom). The product of **this** fork is the DSH plugin, not the Headroom proxy, wrap CLI, or MCP server.

## Install

`dsh plugin` is `pnpm add` inside `$DSH_HOME/profiles/<name>`. There is no DeepSeek plugin store. You publish a **npm package** (or a GitHub path) and people `dsh plugin add` that spec.

From a checkout:

```bash
dsh plugin --profile web add ./plugins/dsh-compressor
```

From GitHub:

```bash
dsh plugin --profile web add github:lifeodyssey/dsh-compressor#path:plugins/dsh-compressor
```

From npm (after `npm publish` from `plugins/dsh-compressor`):

```bash
dsh plugin --profile web add dsh-compressor
```

Then start DSH (`dsh web` or your profile). `dsh --profile web --dump-config` should show `id: dsh-compressor`. Need `pnpm` on PATH.

## What the model sees

Eligible `bash` / `run_code` (and similar) results become:

```
[crushed extract]
<<compressor:64-hex-sha256>>
Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.
```

The model calls `compressor_retrieve` with the locator or the bare hash. That is a real DSH tool.

Left alone by default: user / system / assistant text, Read / Glob / Grep / Write / Edit / Web*, short results, protected errors, recent source code, official DSH spill notices.

## How a DSH plugin is published

Not a Headroom wheel. Not PyPI. Not a GitHub Release by itself.

1. The installable unit is the folder `plugins/dsh-compressor/` (`package.json` name `dsh-compressor`, `dsh.bundle.patch` → `cordis.patch.yml`).
2. Users install it with `dsh plugin --profile <name> add <pnpm-spec>`.
3. `<pnpm-spec>` can be a local path, `github:owner/repo#path:plugins/dsh-compressor`, or an npm name after `npm publish` from that folder.
4. To put it on npm: `cd plugins/dsh-compressor && pnpm install && pnpm build && npm publish --access public`. Do **not** publish the repo root.
5. GitHub Releases are optional tags for humans; DSH does not read them.

Details: [plugins/dsh-compressor/README.md](plugins/dsh-compressor/README.md).

## Develop

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
pnpm typecheck
```

Specs/tickets: [lifeodyssey/dsh-compressor issues](https://github.com/lifeodyssey/dsh-compressor/issues). Always `gh … -R lifeodyssey/dsh-compressor`.

## TODO — crush port leftovers

This is a port of Headroom’s crushers into DSH, not Headroom the product. Proxy, wrap CLI, MCP tools, dashboard, memory, and the rest of that surface stay out.

### In

- [x] Official Log / Smart / Text(CJK) / Search / Diff crushers (napi)
- [x] Mixed-content sectioning + ContentRouter skip/protect
- [x] Disk originals + `<<compressor:64hex>>` + `compressor_retrieve`
- [x] Leave official DSH spill alone

### Maybe later

- [ ] Code-aware crusher (tree-sitter). The other official Headroom crusher; unlinked so the addon stays small.
- [ ] Extra napi triples if someone needs them: `win32-x64`, `darwin-x64`, `linux-arm64` (we ship `darwin-arm64` + `linux-x64-gnu`).

Kompress / ONNX stays off.

## License

Apache-2.0.
