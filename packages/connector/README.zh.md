# @jacklika/dsh-connector

将 Qoder 与 Devin 连接器插件打包为 DeepSeek Harness Bundle。

## 安装

作为 DSH Bundle 安装：

```bash
dsh plugin add @jacklika/dsh-connector
```

## 内容

- `@jacklika/dsh-qoder-connect` — Qoder CLI 连接器（中国 + 国际）
- `@jacklika/dsh-devin-connect` — Devin API 连接器
- `@jacklika/dsh-connector-core` — 共享宿主/客户端原语

## 要求

- DeepSeek Harness/Cordis 在 `docs/compatibility.md` 文档的验证窗口内。
- Node.js `^22.19.0 || >=24.0.0`
- Qoder provider 需要 `qodercli`
- Devin 需要 `DEVIN_API_KEY` 或通过设置 UI 写入的 PAT

## 安全

PAT 不会持久化到插件包目录，也不会被记录。对宿主路由的写入操作需要 per-process 控制密钥和 loopback 校验。
