English · [中文](README.zh-CN.md)

# Cut up to 20% of context

Without hurting the model. Without breaking the prefix cache.

In-process [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. Long tool results are crushed before `Session.deriveMessages()`. The original is stored on disk; the model gets it back with `compressor_retrieve`. Anything already sent to the model is left untouched.

On 20 redacted real DSH sessions, `deriveMessages()` JSON shrank by **up to 20%**. Official DSH spill is left verbatim.

```bash
dsh plugin --profile web add dsh-compressor
```

GitHub / local:

```bash
dsh plugin --profile web add github:lifeodyssey/dsh-compressor#path:plugins/dsh-compressor
dsh plugin --profile web add ./plugins/dsh-compressor
```

`pnpm` must be on PATH. `dsh --profile web --dump-config` should show `id: dsh-compressor`.

The model sees an extract plus `<<compressor:64-hex>>`. That is not a filesystem path. Call `compressor_retrieve`.

Crushers: Headroom’s official Rust Log / Smart / Text / Search / Diff. Code-aware and Kompress are not wired in yet.

```bash
cd plugins/dsh-compressor && pnpm install && pnpm test
```

Apache-2.0
