# dsh-compressor

In-process [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. It crushes long tool results (logs, JSON, CJK text, search, diffs) before they hit `Session.deriveMessages()`, stores the original on disk, and gives the model `compressor_retrieve` to get it back.

This repository is a fork of [Headroom](https://github.com/chopratejas/headroom). The product of **this** fork is the DSH plugin, not the Headroom proxy, wrap CLI, or MCP server.

## Install

`dsh plugin` is `pnpm add` inside `$DSH_HOME/profiles/<name>`. There is no DeepSeek plugin store. You publish a **npm package** (or a GitHub path) and people `dsh plugin add` that spec.

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

From npm (after we publish `dsh-compressor`; not published yet):

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

## TODO — Headroom capabilities not in this plugin

Checked = already in the DSH plugin. Unchecked = Headroom product we have **not** ported (and most of it we decided not to, unless we reopen it).

### In the plugin now

- [x] In-process DSH bundle (`dsh plugin add`, Cordis hooks)
- [x] Official Rust Log / Smart / Text(CJK) / Search / Diff crushers via napi
- [x] Disk originals + `<<compressor:64hex>>` + `compressor_retrieve`
- [x] ContentRouter-like skip/protect (no Kompress, no code-aware)
- [x] Mixed-content sectioning
- [x] Coexist with official DSH spill (`read`/`grep` paths)
- [x] Prebuilt `darwin-arm64` + `linux-x64-gnu` addons

### Headroom surfaces we do not ship

- [ ] `headroom` CLI / `headroom wrap` / `headroom unwrap` (Claude, Codex, Copilot, Cursor, Aider, OpenCode, Cline, Continue, Goose, OpenHands, OpenClaw, …)
- [ ] HTTP proxy (`headroom proxy`, `ANTHROPIC_BASE_URL` hijack)
- [ ] MCP tools (`headroom_compress`, `headroom_retrieve`, `headroom_stats`, optional `headroom_read`)
- [ ] Python / TypeScript `compress()` library and PyPI / root npm `headroom-ai`
- [ ] Docker image / `headroom deploy`
- [ ] Dashboard, `headroom perf`, `headroom doctor`, `headroom savings`
- [ ] GitHub Releases / Release Please / PyPI publish automation

### Headroom protocols we do not use as the user API

- [ ] CCR store (SQLite / Redis) and `<<ccr:…>>` as the redeem protocol
- [ ] `headroom_retrieve` / `/v1/retrieve` / transparent proxy retrieve loop
- [ ] Proactive CCR expansion / context tracker
- [ ] Replacing DSH `spillStore`

### Headroom crushers / ML still off

- [ ] Kompress (ModernBERT / ONNX)
- [ ] Code-aware compressor (tree-sitter; upstream also added PHP)
- [ ] Magika / extra detectors
- [ ] Image compression
- [ ] Adaptive sizer / token-gate extras beyond current ContentRouter glue

### Headroom product around the proxy

- [ ] Cross-agent memory (`memory_*`, mem0)
- [ ] `headroom learn` (mine failed sessions → CLAUDE.md / AGENTS.md)
- [ ] Output-token reduction (trim what the model writes)
- [ ] Shared context library
- [ ] Beacon / OTEL / Prometheus savings attribution
- [ ] Tool-search / transcript repair on Anthropic
- [ ] VS Code / Copilot CAPI / Claude-in-VS-Code wrap
- [ ] Serena semantic-code sidecar
- [ ] Subscription / pricing / prompt-cache TTL accounting
- [ ] Runtime rollout flags (`feat: deterministic runtime rollout`)

### Upstream since last fork `main` (fetched, not merged)

`chopratejas/headroom` `main` is **206 commits** ahead of this fork’s `main`. Almost all of it is proxy/wrap/MCP/CI. Crusher-tree delta is small (SmartCrusher null-tool-call guard, CCR marker persistence). **Not merged into this plugin branch** — a blanket sync would reintroduce the Headroom product tree we slimmed and fight #18.

Worth a later, targeted look if we reopen crushers:

- SmartCrusher: don’t crash on a tool call with a null `function`
- CCR: don’t persist retrieval markers as original content (we don’t use CCR retrieve)
- Code-aware: PHP (code-aware stays off)

## License

Apache-2.0.
