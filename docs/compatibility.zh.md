# 兼容性

## 已验证基线

| 组件 | 声明范围 | 已验证基线 |
|---|---|---|
| Node.js | `^22.19.0 || >=24.0.0` | 本地：22.23.2；CI 覆盖 Linux、macOS、Windows 上的 22.19.0 与当前 24.x |
| pnpm | 仓库开发使用 11.7.0 | 11.7.0 |
| DeepSeek Harness 包 | peer `>=0.1.7-rc.1 <0.3.0-0` | `0.1.7-rc.10` 与 `0.2.0-rc.1` 均跑过完整套件 |
| Cordis | peer exact `4.0.4` | 4.0.4 |
| Git | `git` 必须在 `PATH` 中；插件使用 `-C`、`init`、`rev-parse`、`status`、`add`、`commit` | 本地：Apple Git 2.50.1；CI 使用各 runner 自带 Git |

Harness peer 范围故意采用有界范围而非精确版本。Harness API 尚未稳定，桌面应用会自动更新，因此精确 peer 会把兼容但无关的新版本也变成加载时拒绝——这在验证本套件时已经发生过两次。有界范围保留了关键保护：下一个主版本线仍会在代码加载前被拒绝，因为 `>=0.1.7-rc.1 <0.3.0-0` 只接纳 0.1.x 与 0.2.x 线（从 `0.1.7-rc.1` 起），并明确排除 0.3.x 的每个预发布版本。`-0` 后缀必不可少，因为 semver 开启 `includePrerelease` 时会把 `0.3.0-rc.1` 视为满足 `<0.3.0`。窗口内的每个发布都必须通过完整 CI 与独立的 Profile 安装测试，才能加入窗口；超出当前已验证线的扩容也需要同等证据。因此“允许”与“已验证”在当前指向同一窗口。

Harness 在 registry 安装前和 Profile 组合前都会检查所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer。本套件的 Bundle 声明了该有界范围，因此超出验证线的运行时会先在加载前被拒绝。Harness 提供显式的 `allow-version --accept-risk` 豁免，但它是紧急用户决策，不是本套件的安装步骤。超出窗口的运行时通常应通过验证并移动窗口来解决。

## 引用的 Harness API

| 插件包 | 导入 |
|---|---|
| 所有 Cordis 插件 | `@deepseek-ai/cordis` 的 `Context`；`@deepseek-ai/schemastery` 的 config |
| scope | `@deepseek-ai/dsh-llm` 的 `ToolCallId`；`@deepseek-ai/dsh-tools` 的 `ToolDispatchExecution`、`ToolExecutionResult` 与 `ctx.tools.execute` |
| queue 与 git | `@deepseek-ai/dsh-tools` 的 `ToolExecutionResult` 与 `tools/execute` 瀑布 |
| filesystem、graph、vector、curator | `@deepseek-ai/dsh-tools` 的 `defineTool` / `ToolRunContext`；filesystem、graph、curator 也使用 `@deepseek-ai/dsh-util-values` 的 `JsonValue` |
| connector-core、devin-connect、qoder-connect | `@deepseek-ai/dsh-llm` 的 `CliLlmAdapter`、模型注册与解析；`@deepseek-ai/cordis` 的 web 路由原语 |

Bundle 本身只包含 Cordis patch 与对成员包的运行时依赖。

## 跨平台说明

- Vault 路径通过 Node `path` 模块解析，并在任何读写前经过校验。
- 连接器 CLI adapter 会启动登录 shell（macOS/Linux 用 `/bin/bash -lc`，Windows 用 `cmd.exe /c`），从而继承用户的 PATH 与环境。
- Devin CLI 凭证发现：macOS/Linux 使用 `~/.local/share/devin/credentials.toml`，Windows 使用 `%LOCALAPPDATA%/devin/credentials.toml`。
- Qoder 配置目录在所有平台下均位于 `~/.dsh/profiles/<profile>/.dsh-qoder-connect`。
- 完整 Windows/macOS/Linux CI 矩阵会在每次 push 时运行 `install`、`typecheck`、`lint`、`test`、`build`、`test:multiprocess`、`test:pack` 与 `test:profile`。
