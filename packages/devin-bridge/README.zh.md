---
description: "把 Devin 适配器注册为 `devin` provider 路由，让 agent 循环能运行 Devin 托管的 Claude、GPT、Gemini、GLM、SWE、Kimi 模型 —— 并支持 reasoning effort、图片输入、流式工具调用与 token 计量。"
kind: "package-reference"
---

# @jacklika/dsh-devin-bridge

[English](README.md) | 中文

## 概述

`dsh-devin-bridge` 代表 Harness 与 Devin Connect 通信。它在可配置 provider 目录中登记 `devin`，并为该路由挂载一个适配器：把每个模型请求翻译成发往 `server.codeium.com` 的 `ChatMessage` RPC，再把响应流解码回 Harness 的数据块 —— 正文、思考、工具调用、结束原因与 token 用量。凭据直接取自 Devin CLI 自己的 `credentials.toml`，因此已用 `devin auth login` 登录过的账号无需在 profile 里写 token；`token` 字段是给希望固定凭据的部署准备的。

该路由对外暴露本包内置的模型列表（45 条，由一次真实的 Devin 模型目录生成），并可通过标准的模型发现通道从服务端刷新。reasoning effort 以 Harness 的方式表达 —— 一个四档滑块 —— 并在插件内部映射到 Devin 那些把 effort 编进 uid 的模型上。

这是一个 fork：来源与全部本地改动见[来源与本地改动](#provenance-and-local-changes)。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [来源与本地改动](#provenance-and-local-changes)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

挂在 LLM 服务之后，然后在任意模型位选择 `devin/<model>`：

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@jacklika/dsh-devin-bridge'
```

bundle 自带的 patch 已经以 `devin-bridge` 这个 id 插入该行；profile 若想固定 token 或裁剪模型列表，覆盖该行即可：

```yaml
- id: devin-bridge
  name: '@jacklika/dsh-devin-bridge'
  config:
    token: 'devin-session-token$...'
    defaultContextWindow: 1000000
    models:
      - id: glm-5-2
        name: GLM-5.2 High
        contextWindow: 200000
```

行级 patch 是**整体替换**，因此 profile 仍需要的每个键都要重复写一遍。

### 配置桥接器

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `token` | string（`secret`） | `''` | `devin-session-token$...` 形式的 Devin 会话 token。留空则改为读取 Devin CLI 凭据。 |
| `baseUrl` | string | `https://server.codeium.com` | Devin Connect 端点。保持默认时，若凭据文件中带有 `api_server_url`，则以它为准。 |
| `proxy` | string | `''` | Devin 流量的出站代理：`http://`、`https://`、`socks5://` 或 `socks5h://`。留空为直连。 |
| `forceHttp1` | boolean | `true` | 以 HTTP/1.1 与 Devin 通信。设为 `false` 则由传输层协商 HTTP/2。 |
| `defaultContextWindow` | number | `128000` | 列表中未描述的模型所用的上下文窗口。 |
| `defaultMaxTokens` | number | `16384` | 列表中未描述的模型所用的输出上限。 |
| `models` | array | 内置 45 条 | 该路由对外公布的模型：`{id, name, contextWindow, supportsImages}`。该字段是 volatile 的，因此设置项的写入无需重新挂载即可被读到。 |
| `retryPolicy` | object | Harness 默认 | 该路由的重试策略，在注册时解析一次。 |

### 凭据

token 在每次操作时按以下顺序解析，且**配置的 token 永不缓存**：

1. `config.token`（profile 设置了它）；
2. `DEVIN_CREDENTIALS_PATH` 指向的凭据文件（设置了该环境变量时）；
3. Devin CLI 自己的凭据文件 —— Unix 上是 `~/.local/share/devin/credentials.toml`，Windows 上是 `%APPDATA%\devin\credentials.toml` —— 由 `devin auth login` 写入。

基于文件的会话读取两个键：`windsurf_api_key`（token）与 `api_server_url`（端点）。三者都不存在时，第一次适配器调用会抛错，并列出这三种提供凭据的方式；该错误不会被缓存，因此之后再设置 token 会在下一次调用生效。

<a id="understand-the-implementation"></a>
## 理解实现

四个部件，都随 Loader fiber 一起释放：

- **provider 目录条目**（`ctx.llm.registerConfigurableProviders`）声明 `devin`，显示名为 `Devin`，并使用本插件自己的 settings 命名空间 —— 这正是模型位与模型设置页能渲染出一个具名分组而非匿名路由的原因。
- **适配器路由**（`ctx.llm.registerAdapter(['devin'], adapter)`）是请求通路。适配器持有的是**连接 thunk** 而不是连接：每次操作都重新读取 `token`/`baseUrl`/`proxy`，一旦这三元组变化就重建 Connect 客户端。
- **模型发现**（`ctx.llm.registerModelDiscovery`）响应「获取可用模型」动作，调用 Devin 的 `GetCascadeModelConfigs` RPC。被禁用的条目被丢弃，uid 去重，同一 family 的多个变体按 family 合并为一个基础模型，并优先保留促销变体。
- **重试策略覆盖**在注册时解析一次，而不是每次请求解析，因此已配置的策略不会在会话中途漂移。

token 计量取自 Devin 在每次响应上附带的 `usage` 块，按 Harness 互不重叠的口径上报：未命中缓存的输入、输出、缓存读取、缓存写入。服务端未上报缓存字段时，这些字段被省略 —— 于是「不再返回缓存字段」会退化为「未知」，而不会变成错误数字。

图片不会裸奔。图片块经宿主 attachment store 解析为字节，再以 base64 内联转发；没有 store 时该轮会明确失败，而不会静默丢弃图片。图片只在**当前轮**携带 —— 更早的轮次会折叠成占位文本 `[Image omitted from history]`，这样长会话不会反复重发全部历史图片。

<a id="model-experience"></a>
## 模型体验

模型看到的是 Devin 自己视角的对话：文本块累加进同一个 prompt，思考块成为 prompt 的 `thinking` 字段，工具调用以「名称 + 原始 JSON 参数」转发，工具定义以 JSON Schema 传输，仅用于展示的注解会被剥掉。

reasoning effort 是 Harness 的四档滑块；每一档映射到一个 Devin 模型 uid，若该 uid 不在目录中，则回退到配置里的 id 而不是让这一轮失败：

| Harness effort | Devin uid 后缀 | 示例 |
|---|---|---|
| `high`（默认） | 无 | `glm-5-2` |
| `medium` | `-medium` | `glm-5-2-medium` |
| `max` | `-max` | `glm-5-2-max` |
| `none` | `-none` | `glm-5-2-none` |

本包内置的目录保留**真实 uid**：模型发现推导出的 id 是剥掉 effort 后缀的基础 id，而它们并非都能在端点上解析。采用发现列表的部署应预期拿到基础 id；沿用内置列表的部署则精确指向生成时刻 Devin 接受的变体。

错误会被翻译：Connect 失败变成 `LlmError`，并保留原有的类 HTTP 错误码；流在缺少结束原因时结束，会被报告为错误而不是干净停止。被中止的请求会以「已中止」上报，Harness 因此能区分「取消」与「失败」。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **只搬了 host 半边。** 上游还附带一个浏览器侧客户端（模型选择 UI）。Harness 自身已经渲染可配置 provider 与模型发现，因此这里不需要那半边；它是**有意缺席**，而非待办。
- **内置目录会漂移。** Devin 在服务端增删模型，内置列表只是一份快照；模型缺失时请使用模型发现（或行级 patch）。内置列表本身是有意的取舍：它让该路由在启动时零网络调用即可使用。
- **Devin 计费的是 credits，不是 token。** usage 块携带 token 计数，但 Devin 自己的成本核算基于 credits 且在服务端完成；插件不对任何一轮做计价。
- **`baseUrl` 是真正的覆盖，而非提示。** 把它指到默认值之外会绕过凭据文件自带的 `api_server_url`；这正是接入自建或区域端点的方式，同时保证 token 与端点一致是运维方的责任。
- **代理 agent 是 CommonJS 可选依赖**，通过 `createRequire` 惰性加载，因此不走代理的部署永远不会加载它们。

<a id="provenance-and-local-changes"></a>
## 来源与本地改动

搬自 [Arborsm/dsh-plugin-devin-bridge](https://github.com/Arborsm/dsh-plugin-devin-bridge)，提交 `ced035dd2f43b2dbf37a25c8a47b8ae1c1cc47f4`（MIT —— 原始 `LICENSE` 原样保留）。上游 README 说明该插件面向 Harness 0.1.x 编写；下面的移植是它能在本仓库的 0.2.0 API 上编译并运行的原因。

本地改动全部位于 host 半边：

1. **包形态** —— 重建为 `packages/devin-bridge` 并遵循本仓库约定：`src/` TypeScript 由 `tsc` 编译（上游交付的是 tsdown 构建出的 `lib/`），英文注释，包名 `@jacklika/dsh-devin-bridge`。
2. **消息模型（0.2.0）** —— 请求转换器接收 `RequestMessage`（其中包含一次性的 `RequestUserInput`）而非 `Message`；工具结果的错误标记改从 tool 消息自身的 `isError`/role 读取，因为 0.2.0 的内容块已没有 `tool-result` 类型。
3. **标识符** —— decoder 与 adapter 中的 `CallId` 统一改名为 `ToolCallId`。
4. **模型发现签名** —— 回调为 `(request, signal)`，于是取消能作为第二个参数传到 `discoverModels`。
5. **`exactOptionalPropertyTypes` 清理** —— 可选的传输层与连接字段显式声明 `| undefined`。
6. **ESM 下的代理加载** —— 代理 agent 通过 `createRequire` 加载，因为本包是 ESM，裸 `require` 并不存在。
7. **内置目录** —— 上游只有三条手写默认模型；本 fork 交付 `src/default-models.ts`，含 45 条由一次真实目录响应生成的条目，按与模型发现相同的方式合并 family，并保留可解析的 uid。
8. **volatile 模型列表** —— `models` 声明为 `.volatile()` 并由 `readModels` 解包；当字段的输入与输出形态不一致时，schema 采用 Harness 自己使用的双类型参数注解。

<a id="dev-note"></a>
## 开发说明

`src/proto/gen/devin_pb.ts` 由 `src/proto/devin.proto` 生成（Connect/Buf，protobuf-es 2）。不要手改生成文件，请重新生成。

内置默认列表是用适配器自身的目录抓取、针对一个真实账号生成一次得到的，合并 family 的方式与 `discoverModels()` 完全一致，并丢弃了遗留的 `MODEL_*` 别名；`src/default-models.ts` 文件开头记录了这一来源。Devin 目录变动时，按同样方式重新生成即可。
