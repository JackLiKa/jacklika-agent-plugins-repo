# @jacklika/dsh-devin-connect

将 Devin API 接入 DeepSeek Harness 的 DSH 插件。

## 变体

- `devin` — 通过 PAT 使用 Devin API。

## 配置

```yaml
enabled: true
models: []
timeoutMs: 120000
```

- `enabled` — 是否注册 provider。
- `models` — 覆盖默认模型目录。
- `timeoutMs` — 状态检查请求超时。

## PAT

插件从环境变量 `DEVIN_API_KEY` 读取，也支持通过设置 UI 写入。UI 只展示 token 尾部，绝不记录完整密钥。

## 客户端 UI

当渲染器可用时，通过 `dsh.client` 注册设置卡片。它调用 `/plugins/dsh-devin-connect/*` 宿主路由，写入操作附带 per-process 控制密钥。
