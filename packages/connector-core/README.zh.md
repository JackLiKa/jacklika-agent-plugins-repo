# @jacklika/dsh-connector-core

Qoder 与 Devin 连接器插件的共享基础库。

## 范围

- `CliLlmAdapter` 基类：将官方 CLI 包装为 DSH LLM adapter。
- Web 路由辅助：loopback 校验、安全 JSON 响应、请求体读取、常量时间控制密钥、敏感信息脱敏。
- 宿主/客户端契约的 TypeScript 类型定义。

## 安全说明

- 所有连接器 Web 路由都会校验 `Host` 和 `Origin` 头，仅允许本机访问。
- 写入 PAT/密钥的操作还需要加载时生成的 per-process 控制密钥。
- 错误信息先经过 `safeMessage()` 处理，脱敏 Bearer token、JWT、`code=...`、`token=...` 等敏感内容，再进入日志或 UI。
