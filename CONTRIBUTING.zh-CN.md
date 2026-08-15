# Contributing

PR 开到 [lifeodyssey/dsh-compressor](https://github.com/lifeodyssey/dsh-compressor)，不要开到 Headroom 上游。

## 目录

| 路径 | 内容 |
| --- | --- |
| `plugins/dsh-compressor` | DSH 插件（钩子、取回、测试） |
| `crates/headroom-napi` | 插件用的 napi 绑定 |
| `crates/headroom-core` | 压缩器（来自 Headroom） |
| `crates/headroom-parity` | 压缩器 fixture 对照 |

## 插件

需要 Node 22+ 和 [pnpm](https://pnpm.io/)。

```bash
cd plugins/dsh-compressor
pnpm install
pnpm test
pnpm typecheck
```

改 JS：`pnpm build`。改 Rust 压缩器或 napi：`pnpm build:native`（要有 Rust，并且在这个仓库的 Cargo workspace 里编）。

## 压缩器

```bash
cargo test --workspace
make test-parity
```

推之前跑 `cargo fmt` 和 `cargo clippy --workspace -- -D warnings`。

## 提 PR

1. Fork，从 `main` 拉分支。
2. 一个 PR 只做一件事。
3. 改插件要在 `plugins/dsh-compressor` 里补测试。
4. 改压缩器要过 `cargo test`；动到输出的话还要更新 parity fixture。

## 许可证

本插件是 MIT。`crates/headroom-*` 仍是 Apache-2.0（Headroom）。见 `LICENSE` 和 `LICENSE-APACHE`。
