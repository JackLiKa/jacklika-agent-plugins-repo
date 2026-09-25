# 兼容性

## 已验证基线

| 组件 | 声明范围 | 已验证基线 |
|---|---|---|
| Node.js | `^22.19.0 || >=24.0.0` | 本地：22.23.2；CI 覆盖 Linux、macOS、Windows 上的 22.19.0 与当前 24.x |
| pnpm | 仓库开发使用 11.7.0 | 11.7.0 |
| DeepSeek Harness 包 | 精确 peer `0.1.7-rc.1` | Harness checkout 与已发布包 `0.1.7-rc.1` |
| Cordis | 精确 peer `4.0.4` | 4.0.4 |
| Git | `git` 必须在 `PATH`；插件使用 `-C`、`init`、`rev-parse`、`status`、`add`、`commit` | 本地：Apple Git 2.50.1；CI 使用各 runner 的 Git |

Harness API 仍处于 pre-stable 阶段，因此精确 peer 版本是刻意选择。扩大 semver 范围会声称未经测试的兼容性。新的 Harness 版本必须先通过完整 CI 与独立 Profile 安装测试，才能调整范围。当前“允许范围”和“验证范围”因此是同一个精确版本。

Harness 会在 registry 安装前以及 Profile 组合前检查每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer。本套件给 Bundle 声明精确 peer，使不兼容 runtime 在代码加载前被拒绝。Harness 提供精确版本的 `allow-version --accept-risk` 紧急豁免，但它是用户的风险决策，不是本套件的正常安装步骤。版本不匹配时通常应选择已验证的插件/Harness 组合。

## 实际导入的 Harness API

| 插件包 | 导入 |
|---|---|
| 所有 Cordis 插件 | `@deepseek-ai/cordis` 的 `Context`；`@deepseek-ai/schemastery` 的配置 schema |
| scope | `@deepseek-ai/dsh-llm` 的 `ToolCallId`；`@deepseek-ai/dsh-tools` 的 `ToolDispatchExecution`、`ToolExecutionResult` 与 `ctx.tools.execute` |
| queue 与 git | `@deepseek-ai/dsh-tools` 的 `ToolExecutionResult` 与 `tools/execute` waterfall |
| filesystem、graph、vector | `@deepseek-ai/dsh-tools` 的 `defineTool` / `ToolRunContext`；filesystem 与 graph 还使用 `@deepseek-ai/dsh-util-values` 的 `JsonValue` |

Bundle 本身只包含 Cordis patch，以及六个成员包的运行时依赖。
