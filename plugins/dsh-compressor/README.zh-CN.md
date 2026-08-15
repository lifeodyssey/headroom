<!-- Synced with README.md as of 2026-08-16 -->

[English](README.md) | [中文](README.zh-CN.md)

# dsh-compressor

> 最多少掉 DeepSeek Harness 会话里 20% 的上下文。不伤模型，也不把已经缓存的前缀改坏。

[![npm](https://img.shields.io/npm/v/dsh-compressor.svg)](https://www.npmjs.com/package/dsh-compressor)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)

DSH 进程内插件。长工具结果在 `Session.deriveMessages()` 之前压掉，原文落盘，模型用 `compressor_retrieve` 取回。

```bash
dsh plugin --profile web add dsh-compressor
```

需要 PATH 上有 `pnpm`。`dsh --profile web --dump-config` 里应看到 `id: dsh-compressor`。

模型看到的是摘要 + `<<compressor:64位哈希>>`，不是文件路径。官方 spill 不动。

开发：`pnpm install && pnpm test`。完整说明见 [仓库 README](https://github.com/lifeodyssey/dsh-compressor/blob/main/README.zh-CN.md)。
