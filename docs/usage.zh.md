# 使用

## 安装进 dsh profile

```sh
# profile 不存在时自动创建，安装 bundle 并追加到 dsh.profile.bundles
dsh plugin --profile <name> add /path/to/mydsh-plugin/packages/memory
```

然后确认 profile 的 `bundles` 里还有应用层（如 `@deepseek-ai/dsh-headless`），启动：

```sh
dsh --profile <name> "<任务>"
```

发布到 npm 后把本地路径换成 `@jacklika/dsh-memory`，用法相同。

## 挂载 skill

在 profile 的 `cordis.patch.yml` 中：

```yaml
- id: skill-filesystem
  config:
    customSkillDirs: ['/path/to/mydsh-plugin/skills']
```

`memory-vault` skill 随后出现在 agent 的技能目录中，教会它 vault 工作流。

## 工具参考

| 工具 | 包 | 用途 |
|---|---|---|
| `wiki_read` | `dsh-tool-memory-filesystem` | 读笔记；返回 frontmatter、正文、`[[links]]`、`version`、链出笔记 |
| `wiki_search` | `dsh-tool-memory-filesystem` | 按标题/正文关键字搜索 |
| `wiki_write` | `dsh-tool-memory-filesystem` | 追加（默认）或覆盖；`baseVersion` 乐观并发 |
| `wiki_graph` | `dsh-tool-memory-graph` | 全 vault 链接图，或以某笔记为中心的 `depth` 跳子图 |
| `wiki_semantic_search` | `dsh-tool-memory-vector` | embedding 搜索；配置 OpenAI 兼容端点前保持禁用 |

协调插件不注册工具，它们装饰 `wiki_write`：

| 插件 | 主要配置 |
|---|---|
| `dsh-memory-scope` | `sharedPrefixes`（默认 `['shared/']`）、`role: curator` |
| `dsh-memory-queue` | `crossProcessLock`、`laneArgument: id` |
| `dsh-memory-git` | `prefixes`（默认 `['shared/']`）、`nestedRepo: init \| inherit \| own`（默认 `init`） |

## 典型的模型侧流程

1. `wiki_search "RAG"` → 找候选笔记。
2. `wiki_read "concepts/RAG.md"` → 记住返回的 `version`。
3. `wiki_write(id, content, baseVersion)` → 冲突报错时重读再写。
