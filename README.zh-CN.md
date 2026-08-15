[English](README.md) | [中文](README.zh-CN.md)

# dsh-compressor

[![npm](https://img.shields.io/npm/v/dsh-compressor.svg)](https://www.npmjs.com/package/dsh-compressor)
[![CI](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml/badge.svg)](https://github.com/lifeodyssey/dsh-compressor/actions/workflows/dsh-compressor.yml)

[Headroom](https://github.com/headroomlabs-ai/headroom) 的精简移植，在不影响模型上下文缓存以及 Agent 性能的情况下，压缩工具的输出，至多减少 20% 的上下文。

## 安装

```bash
dsh plugin --profile web add dsh-compressor
```

## 它怎么工作

模型跑工具会留下一大段日志 / JSON / diff，里面只有一小部分有用。插件把长输出压短再给模型，原文留在本机；已经发给模型的前缀不改，避免动到缓存，并提供工具让 Agent 取回完整上下文。

```mermaid
flowchart LR
  A[工具跑完] --> B{输出很长?}
  B -->|不| C[原文进对话]
  B -->|是| D[压短，原文存盘]
  D --> E[模型看到有用的那截]
```

压缩器代码来自 [Headroom](https://github.com/headroomlabs-ai/headroom)。现在接上的是 Log / Smart / Text / Search / Diff。还没接进来的压缩器就这两个：

- [ ] Code-aware（tree-sitter，压源码）
- [ ] Kompress（ONNX，压长散文）

## 开发

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
```

## Contributing

PR 开到本仓库，不要开到 Headroom。

插件在 `plugins/dsh-compressor`（Node 22+、pnpm）：

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
pnpm typecheck
```

改压缩器在 `crates/`：

```bash
cargo test --workspace
make test-parity
```

一个 PR 只做一件事。改插件补测试，改压缩器过 `cargo test`。更细的步骤见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

本插件 MIT。`crates/headroom-*` 仍是 Apache-2.0。
