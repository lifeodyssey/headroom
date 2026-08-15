# dsh-compressor

DeepSeek Harness bundle. Compresses long tool results in-process and restores them with `compressor_retrieve`.

On 20 redacted real DSH sessions, `Session.deriveMessages()` JSON shrank by **up to 20%**. Official spill left verbatim. Reproduce: `node scripts/measure-sessions.mjs`.

## Install into a DSH profile

`dsh plugin` forwards to `pnpm` in `$DSH_HOME/profiles/<name>`. Relative paths are resolved from the directory you run `dsh` in.

**Local checkout**

```bash
dsh plugin --profile web add ./plugins/dsh-compressor
```

**GitHub subdirectory** (plugin is not the repo root)

```bash
dsh plugin --profile web add github:lifeodyssey/dsh-compressor#path:plugins/dsh-compressor
```

**npm**

```bash
dsh plugin --profile web add dsh-compressor
```

Confirm the layer:

```bash
dsh --profile web --dump-config
```

You should see `# == dsh-compressor` and `id: dsh-compressor`.

`pnpm` must be on PATH. Git-hosted installs may ask you to allow a `prepare`/`build` script under the profile’s `pnpm-workspace.yaml` (`allowBuilds`). This package ships prebuilt `native/*.node` and compiled `lib/`; it should not need rustc on the user’s machine.

## Behavior

Hooks:

- `agent/pre-step` — rewrite eligible `tool/result` nodes on the session surface so `Session.deriveMessages()` sees the crushed form
- `tools/post-execute` — crush a new tool result as it is accepted

Originals: `$DSH_HOME/dsh-compressor/<sha256>`. Retrieve: `compressor_retrieve` with `<<compressor:64hex>>` or the bare hash.

Crushers: official Headroom Rust Log / Smart / Text / Search / Diff via napi (`darwin-arm64`, `linux-x64-gnu`). Code-aware off. Kompress off. CCR retrieve is not the user protocol.

Official DSH spill (preview + filesystem path + read/grep) is left alone.

## Develop / test

```bash
pnpm install
pnpm test
pnpm typecheck
```

Rebuild JS after source edits: `pnpm build`. Rebuild the native addon only if you change Rust crushers: `pnpm build:native` (needs the repo’s Cargo workspace).
