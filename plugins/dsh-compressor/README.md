English · [中文](README.zh-CN.md)

# Cut up to 20% of context

Without hurting the model. Without breaking the prefix cache.

DeepSeek Harness plugin. Crushes long tool results; the model restores them with `compressor_retrieve`.

```bash
dsh plugin --profile web add dsh-compressor
```

`dsh --profile web --dump-config` should show `id: dsh-compressor`. Needs `pnpm`.

Dev: `pnpm install && pnpm test`
