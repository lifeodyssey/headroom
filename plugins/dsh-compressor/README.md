# dsh-compressor

In-process DeepSeek Harness context compression. Install as a DSH bundle:

```bash
dsh plugin --profile web add ./plugins/dsh-compressor
```

It hangs on `agent/pre-step` (rewrites eligible `tool/result` surface nodes) and `tools/post-execute` (crushes new tool output). Originals stay on disk under `$DSH_HOME/dsh-compressor`. Retrieve with `compressor_retrieve`.

Crushers are the official Headroom Rust implementations (Log, Smart, Text/CJK, Search, Diff) loaded from `native/*.node`. Code-aware and Kompress stay off. `pnpm test` includes official parity fixtures as byte-equal oracles.

```bash
cd plugins/dsh-compressor && pnpm test
```
