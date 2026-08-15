[English](README.md) · 中文

# 最多少 20% 上下文

不影响模型效果，不破坏上下文缓存。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 进程内插件。过长的工具结果先压再进 `Session.deriveMessages()`，原文落盘，模型用 `compressor_retrieve` 取回。已经发给模型的前缀不会被改写。

20 条脱敏过的真实 DSH session 上，`deriveMessages()` JSON 最多少 **20%**。官方 spill 原样留下。

```bash
dsh plugin --profile web add dsh-compressor
```

GitHub / 本地：

```bash
dsh plugin --profile web add github:lifeodyssey/dsh-compressor#path:plugins/dsh-compressor
dsh plugin --profile web add ./plugins/dsh-compressor
```

`pnpm` 要在 PATH 上。`dsh --profile web --dump-config` 里应看到 `id: dsh-compressor`。

模型看到的是摘要 + `<<compressor:64位哈希>>`。不要当文件路径去 Read，调用 `compressor_retrieve`。

Crushers：Headroom 官方 Rust Log / Smart / Text / Search / Diff。Code-aware、Kompress 还没接。

```bash
cd plugins/dsh-compressor && pnpm install && pnpm test
```

Apache-2.0
