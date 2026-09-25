# mydsh-plugin documentation

Suite-level documentation for the DeepSeek Harness plugin collection. Per-package configuration references live in each package's own `README.md` / `README.zh.md`.

## Contents

| Document | Topic |
|---|---|
| [compatibility.md](compatibility.md) | Verified Node, pnpm, Harness, Cordis, and Git versions plus imported APIs |
| [architecture.md](architecture.md) | The three-layer design (skill / tool calling / MCP), vault layout, and the write-coordination chain |
| [usage.md](usage.md) | Installing the suite into a dsh profile, mounting skills, tool reference |
| [mcp-server.md](mcp-server.md) | Running `dsh-memory-mcp` and mounting it in MCP clients |
| [security.md](security.md) | Data flows, local-only guarantees, LLM/embedding exposure boundaries |
| [adding-plugins.md](adding-plugins.md) | Conventions for adding new plugin packages to this repository |
