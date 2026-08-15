# dsh-compressor

In-process [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. It crushes long tool results (logs, JSON, CJK text, search, diffs) before they hit `Session.deriveMessages()`, stores the original on disk, and gives the model `compressor_retrieve` to get it back.

Crushers are Headroom’s official Rust Log / Smart / Text / Search / Diff, linked in-process. This is not the Headroom proxy, wrap CLI, MCP server, or dashboard.

On 20 redacted real DSH sessions (local `~/.dsh/sessions` fixtures), `Session.deriveMessages()` JSON shrank by **up to 20%**. Official DSH spill left verbatim. Reproduce: `cd plugins/dsh-compressor && node scripts/measure-sessions.mjs`.

## Install

`dsh plugin` is `pnpm add` inside `$DSH_HOME/profiles/<name>`. Need `pnpm` on PATH.

```bash
dsh plugin --profile web add dsh-compressor
dsh plugin --profile web add github:lifeodyssey/dsh-compressor#path:plugins/dsh-compressor
dsh plugin --profile web add ./plugins/dsh-compressor
```

Then start DSH. `dsh --profile web --dump-config` should show `id: dsh-compressor`.

## What the model sees

Eligible `bash` / `run_code` (and similar) results become:

```
[crushed extract]
<<compressor:64-hex-sha256>>
Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.
```

The model calls `compressor_retrieve` with the locator or the bare hash. That is a real DSH tool.

Left alone by default: user / system / assistant text, Read / Glob / Grep / Write / Edit / Web*, short results, protected errors, recent source code, official DSH spill notices.

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
- [ ] Kompress / ONNX (Headroom’s ML prose crusher; not linked in the addon yet).

## License

Apache-2.0.
