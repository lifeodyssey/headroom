<!-- Synced with README.md as of 2026-08-16 -->

[English](README.md) | [中文](README.zh-CN.md)

# dsh-compressor

> 最多少掉 DeepSeek Harness 会话里 20% 的上下文。不伤模型，也不把已经缓存的前缀改坏。

[![npm](https://img.shields.io/npm/v/dsh-compressor.svg)](https://www.npmjs.com/package/dsh-compressor)
[![CI](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml/badge.svg)](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

这是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。长工具结果在进 `Session.deriveMessages()` **之前**被压掉，原文写到磁盘，模型用正式工具 `compressor_retrieve` 取回。

20 条脱敏过的真实 DSH session 上，`deriveMessages()` 的 JSON 最多少了 **20%**。官方 spill 我们不动。

## 为什么要做

DSH 里 `bash` / `run_code` 跑一小时，上下文全是模型早就用过的日志、JSON、diff。官方 spill 把全文写到文件，再让模型 `read` / `grep` —— 多一跳工具，预览还留在 transcript 里。

[Headroom](https://github.com/headroomlabs-ai/headroom) 已经有对应的 crusher，但那是代理 / wrap 产品。这个仓库把同一套 crusher 放进 DSH 进程：已经发给模型的前缀，一步都不会改。

## 安装

需要 PATH 上有 [`pnpm`](https://pnpm.io/)。

```bash
dsh plugin --profile web add dsh-compressor
```

从这个仓库装：

```bash
dsh plugin --profile web add github:lifeodyssey/dsh-compressor#path:plugins/dsh-compressor
dsh plugin --profile web add ./plugins/dsh-compressor
```

然后启动 DSH，确认插件在：

```bash
dsh --profile web --dump-config
```

应看到 `id: dsh-compressor`。

## 模型看到什么

够长的工具结果会变成：

```
[crushed extract]
<<compressor:64-hex-sha256>>
Call compressor_retrieve with this locator or its hash to restore the original. This is not a filesystem path.
```

`compressor_retrieve` 是普通 DSH 工具。这个 locator 不是文件路径，不要去 `Read`。

默认不动：用户 / system / assistant 文本，Read / Glob / Grep / Write / Edit / Web*，短结果，受保护的 error，最近的源码，官方 DSH spill。

## 装和不装

| | 不装 | 装上 dsh-compressor |
| --- | --- | --- |
| 很长的 `bash` / `run_code` | 后面每一轮都带着 | 摘要 + locator |
| 已经发出去的前缀 | 每步都在涨 | 第一次压完后字节不变 |
| 全文 | 只剩当时的工具输出 | 磁盘 + `compressor_retrieve` |
| 官方 spill | 照常 | 照常，我们不碰 |
| 再取一次 | spill 后再 `read` / `grep` | 调一次官方工具 |

## 怎么压的

1. **`tools/post-execute`**：DSH 收下新工具结果时压。
2. **`agent/pre-step`**：改 session 表面上的 `tool/result`，让 `Session.deriveMessages()` 看到压过的内容。再跑一遍是 no-op（前缀缓存）。
3. **原文**在 `$DSH_HOME/dsh-compressor/<sha256>`。
4. **Fail-closed**：`compressor_retrieve` 或 system prompt 注册不上，就完全不压。

Crusher 是 Headroom 官方 Rust 的 Log / Smart / Text(CJK) / Search / Diff，走 napi（`darwin-arm64`、`linux-x64-gnu`）。Code-aware 和 Kompress 没链进来。

## 开发

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
pnpm typecheck
```

改 JS 后：`pnpm build`。改 Rust crusher 才需要 `pnpm build:native`（要用这个仓库的 Cargo workspace）。

复现 20 条 session 的数字：`node scripts/measure-sessions.mjs`。

Issue 只开在 [lifeodyssey/dsh-compressor](https://github.com/lifeodyssey/dsh-compressor/issues)，一律 `gh … -R lifeodyssey/dsh-compressor`。

Apache-2.0。Crusher 来自 Headroom。
