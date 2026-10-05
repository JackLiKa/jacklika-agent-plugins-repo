# @jacklika/dsh-qoder-connect

将 Qoder 的 CLI/模型服务接入 DeepSeek Harness 的 DSH 插件。

## 变体

- `qoder` — 全球区域（默认）。
- `qoder-china` — 中国区域。

## 配置

```yaml
enabled: true
models: []
timeoutMs: 120000
```

- `enabled` — 是否注册 providers。
- `models` — 使用自定义条目覆盖默认模型目录。
- `timeoutMs` — CLI 请求超时。

## PAT

插件从环境变量读取 `QODER_PERSONAL_ACCESS_TOKEN`（全球）和 `QODER_CHINA_PERSONAL_ACCESS_TOKEN`（中国），也支持通过设置 UI 写入。UI 只展示 token 尾部，绝不记录完整 PAT。

默认变体使用全球区域与原始 Qoder 客户端请求头。PAT 会被交换为 job token，再作为 Bearer token 用于用户、套餐、组织与额度接口。

## 状态

状态端点返回：

- 用户名、邮箱、用户类型、头像。
- 套餐层级与组织。
- 信用额度账户及每个账户的剩余/总量（如 Plan、Org Package）。
- 完整模型列表。

## 客户端 UI

当渲染器可用时，通过 `dsh.client` 注册设置卡片。UI 调用 `/plugins/dsh-qoder-connect/*` 宿主路由，写入操作附带加载时生成的 per-process 控制密钥。连接器会把状态发布到共享的连接器状态存储，以便统一面板显示身份、多条额度进度条和模型数量。
