# @jacklika/dsh-qoder-connect

将 Qoder CLI/模型服务接入 DeepSeek Harness 的 DSH 插件。

## 变体

- `qoder`（中国区）
- `qoder-global`（国际区）

## 配置

```yaml
enabled: true
models: []
timeoutMs: 120000
```

- `enabled` — 是否注册 provider。
- `models` — 覆盖默认模型目录的自定义条目。
- `timeoutMs` — CLI 请求超时。

## PAT

插件从环境变量读取 `QODER_PERSONAL_ACCESS_TOKEN`（中国）和 `QODER_GLOBAL_PERSONAL_ACCESS_TOKEN`（国际），也支持通过设置 UI 写入。UI 只展示 token 单向尾部，绝不记录完整 PAT。

## 客户端 UI

当渲染器可用时，会通过 `dsh.client` 注册设置卡片与侧栏额度面板。UI 调用 `/plugins/dsh-qoder-connect/*` 宿主路由，写入操作附带 per-process 控制密钥。
