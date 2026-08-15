[English](README.md) · 中文

# 最多少 20% 上下文

不影响模型效果，不破坏上下文缓存。

DeepSeek Harness 插件。压过长的工具结果，原文用 `compressor_retrieve` 取回。

```bash
dsh plugin --profile web add dsh-compressor
```

`dsh --profile web --dump-config` 里应看到 `id: dsh-compressor`。需要 `pnpm`。

开发：`pnpm install && pnpm test`
