# dsh-compressor

In-process DeepSeek Harness context compression. Install as a DSH bundle:

```bash
dsh plugin --profile web add ./plugins/dsh-compressor
```

It hangs on `agent/pre-step` (rewrites eligible `tool/result` surface nodes) and `tools/post-execute` (crushes new tool output). Originals stay on disk under `$DSH_HOME/dsh-compressor`. Retrieve with `compressor_retrieve`.

Default crushers: log, structured list / JSON array, CJK-aware prose. Code-aware and Kompress are off.

```bash
cd plugins/dsh-compressor && pnpm test
```
