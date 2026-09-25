# mydsh-plugin 文档

DeepSeek Harness 插件套件的套件级文档。各包的配置参考在各包自己的 `README.md` / `README.zh.md` 中。

## 目录

| 文档 | 主题 |
|---|---|
| [compatibility.md](compatibility.zh.md) | 已验证的 Node、pnpm、Harness、Cordis、Git 版本及实际导入 API |
| [architecture.md](architecture.zh.md) | 三层设计（skill / tool calling / MCP）、vault 布局、写协调链 |
| [usage.md](usage.zh.md) | 把套件装进 dsh profile、挂载 skill、工具参考 |
| [mcp-server.md](mcp-server.zh.md) | 运行 `dsh-memory-mcp` 并在 MCP 客户端中挂载 |
| [security.md](security.zh.md) | 数据流、纯本地保证、LLM/embedding 暴露边界 |
| [adding-plugins.md](adding-plugins.zh.md) | 向本仓库新增插件包的约定 |
