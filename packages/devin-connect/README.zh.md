# @jacklika/dsh-devin-connect

将 Devin API 接入 DeepSeek Harness 的 DSH 插件。

## 变体

- `devin` — 通过 PAT 使用 Devin API。

## 配置

```yaml
enabled: true
models: []
timeoutMs: 120000
cliCommand: devin
```

- `enabled` — 是否注册 provider。
- `models` — 覆盖默认模型目录。
- `timeoutMs` — 状态检查与 CLI 调用超时。
- `cliCommand` — 可选的 Devin CLI 二进制名或路径（默认 `devin`）。

## PAT

插件从环境变量 `DEVIN_API_KEY` 读取，也支持通过设置 UI 写入。UI 只展示 token 尾部，绝不记录完整密钥。

## 模型目录

插件优先使用 Devin CLI 的模型目录（`devin models list --format json`），使选择器显示与 Devin 应用一致的真实模型。每个 family（如 `SWE-2`、`Claude Fable 5.1`）会被保留用于分组；上下文长度、价格等变体元数据也会暴露给自定义选择器。

如果 CLI 未登录，插件会回退到一小份内置的常见 Devin 模型列表。

## 额度与用量

状态端点优先读取本地 Devin CLI 凭证（macOS/Linux 为 `~/.local/share/devin/credentials.toml`，Windows 为 `%LOCALAPPDATA%/devin/credentials.toml`），并调用 Codeium 的 `GetUserStatus` 接口——也就是 Devin 应用本身使用的数据源。这样可以返回套餐名、每日/每周额度百分比、超额余额，而无需企业 PAT。

如果该路径不可用，插件会回退到 Devin 的企业消费接口。这些接口需要具备 billing 权限的企业服务用户；普通 PAT 会如实返回权限不足状态，不会伪造数字。

## 客户端 UI

当渲染器可用时，通过 `dsh.client` 注册设置卡片。它调用 `/plugins/dsh-devin-connect/*` 宿主路由，写入操作附带加载时生成的 per-process 控制密钥。连接器会把状态发布到共享的连接器状态存储，以便统一面板显示身份、额度和模型数量。

## 跨平台说明

CLI 调用在 macOS/Linux 使用 `/bin/bash -lc`，在 Windows 使用 `cmd.exe /c`，从而继承用户 shell 的 PATH 与登录环境。实时模型发现需要 Devin CLI 已安装并已登录。
