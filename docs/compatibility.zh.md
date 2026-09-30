# 兼容性

## 已验证基线

| 组件 | 声明范围 | 已验证基线 |
|---|---|---|
| Node.js | `^22.19.0 || >=24.0.0` | 本地：22.23.2；CI 覆盖 Linux、macOS、Windows 上的 22.19.0 与当前 24.x |
| pnpm | 仓库开发使用 11.7.0 | 11.7.0 |
| DeepSeek Harness 包 | peer `>=0.1.7-rc.1 <0.3.0-0` | `0.1.7-rc.7` 与 `0.2.0-rc.1` 均跑过完整套件 |
| Cordis | 精确 peer `4.0.4` | 4.0.4 |
| Git | `git` 必须在 `PATH`；插件使用 `-C`、`init`、`rev-parse`、`status`、`add`、`commit` | 本地：Apple Git 2.50.1；CI 使用各 runner 的 Git |

Harness 的 peer 范围是**有界而非精确**的，这是刻意的。Harness API 仍处于 pre-stable 阶段，而桌面应用会自我更新，因此精确 peer 会把每一次无关的版本发布都变成加载期拒收 —— 即便插件其实兼容。本套件在验证过程中就因此被拒过两次。有界范围保留了真正重要的保护：**下一条发布线仍会在代码加载前被拒绝**，因为 `>=0.1.7-rc.1 <0.3.0-0` 只接受 0.1.x 与 0.2.x 这两条发布线（从 `0.1.7-rc.1` 起），并明确排除 0.3.x 的所有预发布版本。`-0` 后缀是必需的，因为 semver 在 `includePrerelease` 模式下会把 `0.3.0-rc.1` 误判为满足 `<0.3.0`。窗口内的每个版本都必须先通过完整 CI 与独立 Profile 安装测试才能加入该窗口；想把窗口扩大到已验证的那条线之外，同样需要这些证据。当前"允许范围"和"验证范围"因此是同一个窗口。

Harness 会在 registry 安装前以及 Profile 组合前检查每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer。本套件给 Bundle 声明该有界范围，使窗口之外的 runtime 在代码加载前被拒绝。Harness 提供精确版本的 `allow-version --accept-risk` 紧急豁免，但它是用户的风险决策，不是本套件的正常安装步骤。runtime 落在窗口之外时，正常做法是先验证它并移动窗口。

## 实际导入的 Harness API

| 插件包 | 导入 |
|---|---|
| 所有 Cordis 插件 | `@deepseek-ai/cordis` 的 `Context`；`@deepseek-ai/schemastery` 的配置 schema |
| scope | `@deepseek-ai/dsh-llm` 的 `ToolCallId`；`@deepseek-ai/dsh-tools` 的 `ToolDispatchExecution`、`ToolExecutionResult` 与 `ctx.tools.execute` |
| queue 与 git | `@deepseek-ai/dsh-tools` 的 `ToolExecutionResult` 与 `tools/execute` waterfall |
| filesystem、graph、vector、curator | `@deepseek-ai/dsh-tools` 的 `defineTool` / `ToolRunContext`；filesystem、graph 与 curator 还使用 `@deepseek-ai/dsh-util-values` 的 `JsonValue` |

Bundle 本身只包含 Cordis patch，以及七个成员包的运行时依赖。
