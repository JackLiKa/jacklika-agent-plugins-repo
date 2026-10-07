---
description: "把本机 Qoder CLI 挂载为 `qoder` 与 `qoder-byok` 两条 provider 路由：账号的实时模型目录、每会话常驻的 inner session、基于 attachment store 的图片输入，以及 provider 上报的缓存 token 分桶。"
kind: "package-reference"
---

# @jacklika/dsh-llm-qoder

[English](README.md) | 中文

## 概述

`dsh-llm-qoder` 把本机的 `qodercli` 变成 dsh 的一个模型后端。它声明两条可配置 provider 路由，并用同一个适配器同时挂载：`qoder` 服务账号内置模型，`qoder-byok` 服务账号自定义模型，两者的 config 里都没有凭据字段 —— 两条路由都走 Qoder CLI 自己的登录。模型元数据实时取自 CLI，带 TTL 缓存，并在无法实时获取时回退到一份从某个账号抓取的静态目录。

每个 dsh 会话保有一个常驻的 inner CLI session，因此长对话是增量喂给模型，而不是每轮重建；旁路请求（标题、压缩摘要）不占用会话池，而是带着同款模型发一次一次性请求。图片经宿主 attachment store 送达模型，token 用量按 Harness 互不重叠的口径上报 —— 只要 CLI 提供，就用 provider 自己的缓存计数 —— 而包括常驻子进程在内的全部注册项都随 Loader fiber 一起释放。

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

挂在 LLM 服务之后，然后在任意模型位选择 `qoder/<model>` 或 `qoder-byok/<model>`：

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@jacklika/dsh-llm-qoder'
```

bundle 自带的 patch 已经以 `llm-qoder` 这个 id 插入该行；profile 可以覆盖该行来限制会话池或目录 TTL：

```yaml
- id: llm-qoder
  name: '@jacklika/dsh-llm-qoder'
  config:
    maxSessions: 4
    modelCacheTtlSeconds: 600
```

行级 patch 是**整体替换**，因此 profile 仍需要的每个键都要重复写一遍。

### 配置路由

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `maxSessions` | number | `8` | 同时常驻的 inner qodercli 会话上限（1–64）。取用会把会话移到池尾；池溢出时关闭最久未用者。 |
| `modelCacheTtlSeconds` | number | `300` | 抓取到的 CLI 模型目录保持新鲜的秒数，过期后下一次请求会重新抓取（10–86400）。 |

### 凭据

没有 token 字段。适配器通过运行 dsh 的这台机器上 Qoder CLI 自己的登录认证，因此部署需要装好并登录 `qodercli`；profile 无法提供账号。BYOK 路由不是第二个账号 —— 它用的是同一份 CLI 登录，只是把目录筛到账号自定义模型。

<a id="understand-the-implementation"></a>
## 理解实现

五个部件，都随 Loader fiber 一起释放：

- **provider 目录条目**（`ctx.llm.registerConfigurableProviders`）声明 `qoder` 与 `qoder-byok`，显示名分别为 `Qoder CLI` 与 `Qoder 自定义`，并使用本插件自己的 settings 命名空间 —— 这正是模型位与模型设置页能渲染出两个具名分组而非匿名路由的原因。
- **适配器路由**（`ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)`）用一个适配器实例同时服务两条路由。`listModels` 按条目来源拆分账号目录：内置路由隐藏账号自定义模型，BYOK 路由只提供这些模型。
- **实时模型目录**（`QoderModelCatalog`）通过一个短命的 inner session 向 CLI 索取账号目录。抓到的快照在配置的 TTL 内保持新鲜；并发调用共享同一次进行中的抓取；抓取失败或超过 20 秒时，继续提供上一份可用快照，而从未成功抓取过的部署回退到 [catalog.ts](src/catalog.ts) 里的静态目录。
- **attachment store** 惰性注入（`ctx.inject(['attachments'])`），因此即使部署里没有它，路由也照常注册；此时图片会退化为 Harness 自己的 handle 文本，而不会让这一轮失败。
- **释放钩子**会关闭全部常驻 inner session（`ctx.effect(() => () => adapter.close())`），因为 `registerAdapter` 的 disposer 只撤回路由，不负责适配器持有的 CLI 子进程。

模型寻址在查目录之前完成：`deepseek-v4-flash` 与 `deepseek-v4-pro` 展开为 `dfmodel` 与 `dmodel`，`qoder-` 前缀被剥掉，其余 id 原样透传。解析结果用于查找元数据，但 `resolveModel` 回显请求的 id，因为该 seam 拒绝「解析出的模型 id 与请求 id 不一致」的结果。

能力只在被验证过时才声明。`resolveModel` 只为 `isVl` 恰为 `true` 的实时条目声明图片输入；对于未声明该能力的路由，Harness 会把图片投影为 handle 文本，因此 CLI 没有做出的声明会让像素被静默丢弃。它把目录里的 `defaultContextWindow` 作为该路由的窗口上报，依次回退到 `maxInputTokens`、再到 200 000 —— 这是**有意不取上限**：qodercli 把 `maxInputTokens` 报成模型最大值（常常是 1 M），而 `defaultContextWindow` 才是每会话的有效窗口，若按上限给上下文计量定价，自动压缩会远远超出 provider 实际接受的范围。

<a id="model-experience"></a>
## 模型体验

**首轮与续轮。** Harness 对话先被整体渲染成带角色标签的文本流，作为 inner session 的 prompt 发出。后续轮次只喂尾部增量 —— 新的用户消息加上原地刷新的上下文快照 —— 而工具结果交给已停放的工具处理器，不重复喂入。无法修复的分歧历史（索引 0 变化、原地改写超过两次，或消息列表变短）会用完整文本流冷重建 inner session。

**旁路通道。** 不带 session id 的请求（标题、压缩摘要）完全不经过会话池：关掉工具、按主会话的模型发一次一次性对话，这样 dsh 记录的摘要模型就是 qodercli 实际运行的那个。

**图片。** 图片引用经宿主 attachment store 解析为 base64，保持 attachment 自身的尺寸，每张转发的图片编码后上限 1 MiB。未声明视觉能力的路由收到的是 Harness 展平的 handle 文本；宿主读不到的 attachment 会留下一条点名它的说明，让 inner 模型仍知道它存在过。

**token 计量。** 带缓存流量的流帧按互不重叠的分桶上报 —— 输入（不含缓存读写）、缓存读取、缓存写入与 `totalTokens` —— 只有不超过 provider 自己的输出计数时才会附带 reasoning 估算，因为 Harness 拒绝「思考量高于输出量」的样本。没有计量数据的帧回退到会话级估算，计价方式与 Harness 的 token 计量器一致（按渲染后的对话每 4 字符 1 token，外加图片 token），让压缩阈值看到真实占用。

**错误。** CLI 的失败文本会被归类为 Harness 的「上下文超限」「配额耗尽」或后端轮次错误码，因此 agent 循环对窗口耗尽与配额用尽会做出不同反应。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **除会话池与 TTL 外无可配置项。** 该路由只通过本机 `qodercli` 登录认证；profile 无法提供 token 或账号，而没有登录 CLI 的部署能列出静态目录却跑不了任何一轮。
- **`qoder-byok` 是目录切分，不是第二个账号。** 两条路由读同一份 CLI 登录；BYOK 路由只是筛到账号自定义模型。
- **目录新鲜度有上限。** 条目在 TTL 内有效，抓取失败时静默沿用上一份可用快照。静态回退是某个账号 2026-08 的抓取结果，且不声明任何视觉能力 —— 因为它无法验证。
- **回退估算不是 provider 计量。** 它够上下文计量与压缩阈值使用，不足以支撑计费或缓存命中分析。
- **常驻会话是进程状态。** `maxSessions` 为它们设上限，溢出时关闭最久未用者，宿主重启后冷重建，而每个常驻会话都持有一个活的 CLI 子进程。
- **运行时字符串来自上游。** prompt 指令、角色标签、`Qoder 自定义` 显示名与 CJK 目录描述都逐字保留；它们是行为面 —— inner 模型与 UI 读到的东西 —— 有意排除在英文注释迁移之外。
- **上游的单元测试未搬过来。** 目前的覆盖是下面的 Loader 组合测试；移植上游那七个 spec 文件并适配缓存分桶补丁一事待办。

<a id="provenance-and-local-changes"></a>
## 来源与本地改动

搬自 [JiamingZang/dsh-llm-qodersdk](https://github.com/JiamingZang/dsh-llm-qodersdk)，提交 `3515f20c28e8c01476ca27509ca0b8c5090e82d7`（MIT —— 原始 `LICENSE` 原样保留）。

本地改动全部位于 host 半边：

1. **包形态** —— 重建为 `packages/llm-qoder` 并遵循本仓库约定：`src/` TypeScript 由 `tsc` 编译（上游同时交付 `lib/` 产物与源码）、包名 `@jacklika/dsh-llm-qoder`、本双语 README 对。
2. **缓存分桶用量补丁** —— [session.ts](src/session.ts) 让 provider 缓存流量先于会话级估算上报：带 `cache_read_input_tokens`/`cache_creation_input_tokens` 的帧优先于估算，其分桶互不重叠（输入不含缓存读写）并携带 `totalTokens`，且只有在不超过 provider 自己的输出计数时才发出 reasoning 估算。估算仍是回退路径，而上游是无条件使用它。
3. **lint 清理** —— [adapter.ts](src/adapter.ts) 中 reasoning effort 的策略对象不再展开一个条件表达式。
4. **单元测试未搬过来** —— 上游附带七个 `.spec.ts`；本包改为一个真实的 Loader 组合测试。

其余部分与上游逐字节一致，包括「已知限制」里列出的运行时字符串。唯一的例外是 [models.ts](src/models.ts)：上游以 CRLF 换行发布，本仓库的 `.gitattributes` 会将其规范化为 LF。

<a id="dev-note"></a>
## 开发说明

`tests/loader-composition.spec.ts` 在真实的 `@deepseek-ai/dsh-llm` 服务旁启动真实 Loader，断言组合 seam：两条路由带着各自的显示名出现在 provider 目录中，适配器的条目出现在 `listConfigurableProviders()` 里，释放插件 fiber 后它们被撤回。它有意止步于任何模型查找之前，因为该适配器里每条目录路径都要经过本机 Qoder CLI 登录，而封闭测试无法假定它存在。
