---
description: "dsh 记忆 bundle：在 dsh-base 之上叠加兼容 Obsidian 的 Markdown vault、按 agent 划分的写入命名空间、串行化写入与 git 历史。"
kind: "package-bundle"
---

# @jacklika/dsh-memory

[English](README.md) | 中文

## 概述

`dsh-memory` 是外部 Profile Bundle，在 `dsh-base` 之后挂载完整记忆链——兼容 Obsidian 的 Markdown vault 及其写协调。只需把这一个包安装进自定义 Profile；它的运行时依赖会带齐所有成员插件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过 Harness Plugin Manager 安装 Bundle；该命令可使用已有 Profile，也可自动创建：

```sh
dsh plugin --profile memory add @jacklika/dsh-memory@0.1.7-rc.30
```

保持 Bundle 位于 `dsh-base` 之后，并加入 `dsh-headless` 或 `dsh-web-app` 等应用层。语义搜索默认关闭，需在 profile patch 中提供 embeddings 端点后启用：

```yaml
- id: tool-memory-vector
  disabled: false
  config:
    endpoint: http://localhost:11434/v1/embeddings
    model: nomic-embed-text
```

Bundle patch 默认把 vault 设在 `<会话 cwd>/.plugins/memory/`；可在 profile patch 中覆盖 `tool-memory-filesystem`、`memory-queue`、`memory-git` 与 `tool-memory-graph` 的 `vaultRoot`。

<a id="understand-the-implementation"></a>
## 理解实现

bundle 的实质是 `cordis.patch.yml`，由 `dsh.bundle.patch` 清单字段声明。其 insert 列表按 waterfall 顺序挂载写入阶梯：

1. `memory-scope` 把私有 `wiki_write` 的 id 重写到 `agents/<agent key>/` 命名空间，使不同 agent 在结构上不可能撞车；`shared/` 前缀直接放行。
2. `memory-queue` 用 `mkdir` 锁与心跳计数器判活串行化同 lane 的写，使不同进程无法交错。
3. `memory-git` 在锁内提交 `shared/` 和 `agents/` 写入、历史恢复与归档移动；`nestedRepo: 'init'` 把 vault 历史保存在 vault 自己的 `.git` 中，绝不进入外层项目仓库。
4. `tool-memory-filesystem` 拥有 vault 本体：`wiki_read`、`wiki_search`、`wiki_write`、原子发布、可选 `baseVersion` 冲突检测、`wiki_history` 与 `wiki_restore`。
5. `tool-memory-graph` 提供 `wiki_graph` 链接图查询。
6. `memory-curator` 注册 `memory_recall`、`memory_capture`、`memory_correct`、`memory_forget` 与 `memory_compact`；逐回合自动捕获笔记不会出现在 `memory_recall` 中，并可通过 `memory_compact`  aged out。
7. frontmatter 中的 `expires` 会在读取与搜索结果中暴露为 `expired` 标志；过期笔记不会自动删除。
8. `wiki_search` 返回 `fused` 与 `semantic`，让调用方知道是否成功融合了语义排序；语义失败时无改动地回退到纯词法排序。
9. `memory_capture` 与 `memory_correct` 接受可选的 `source_session`、`commit`、`verified` 来源字段。

`tool-memory-vector` 默认禁用，因为它需要外部 embeddings 端点。所有 git 提交都是本地的；不会推送。

<a id="model-experience"></a>
## 模型体验

间接地，经由各插入行所属的包提供——各行自己的包负责其模型可见行为。

#### KV Cache 影响

bundle 自身不增加请求前缀；任何缓存影响由各插入行所属的包负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- scope、queue 锁与版本校验都是咨询性的：waterfall 之外的写入方（shell、Obsidian、其他进程）会绕过；原子 rename 与 `baseVersion` 限定损害范围。
- 写权只划分不隔离读：每个 agent 都可读全 vault，包括其他 agent 的命名空间。
- `tool-memory-vector` 需要外部 embeddings 端点；启用后笔记内容会发送到该端点。
- 对 Bundle 配置下的 `shared/`、`agents/` 笔记，`wiki_restore` 会记录前滚提交；瀑布链之外的写入方仍会绕过该审计链。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
