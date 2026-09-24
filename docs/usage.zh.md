# 使用

## 安装进 dsh profile

```sh
# 1. profile 不存在时自动创建，安装 bundle 并追加到 dsh.profile.bundles
dsh plugin --profile <name> add /path/to/mydsh-plugin/packages/memory

# 2. 仅本地开发：把套件的每个包 link 进 profile，使 bundle 的
#    cordis.patch.yml 能解析到它们（`link:` 不安装依赖）
cd ~/.dsh/profiles/<name>
pnpm add /path/to/mydsh-plugin/packages/tool-memory-filesystem \
         /path/to/mydsh-plugin/packages/tool-memory-graph \
         /path/to/mydsh-plugin/packages/tool-memory-vector \
         /path/to/mydsh-plugin/packages/memory-scope \
         /path/to/mydsh-plugin/packages/memory-queue \
         /path/to/mydsh-plugin/packages/memory-git
```

然后确认 profile 的 `bundles` 里还有应用层（如 `@deepseek-ai/dsh-headless`），启动：

```sh
dsh --profile <name> "<任务>"
```

本地开发需要先在本仓库 `pnpm build`——包解析到 `lib/` 产物；套件内部 `devDependencies` 以 `link:` 指向本地 deepseek-harness 检出，若你的检出路径不同请修改。发布到 npm 后 `dsh plugin --profile <name> add @jacklika/dsh-memory` 即可——真实依赖会正常安装，第 2 步消失。

## 卸载

```sh
cd ~/.dsh/profiles/<name>
pnpm remove @jacklika/dsh-memory @jacklika/dsh-memory-git @jacklika/dsh-memory-queue \
            @jacklika/dsh-memory-scope @jacklika/dsh-tool-memory-filesystem \
            @jacklika/dsh-tool-memory-graph @jacklika/dsh-tool-memory-vector
```

再从 profile `package.json` 的 `dsh.profile.bundles` 里删掉 `"@jacklika/dsh-memory"`。`.dsh/memory/` 下的 vault 不受影响，不需要时手动删除。

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
