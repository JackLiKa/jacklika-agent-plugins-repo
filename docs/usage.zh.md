# 安装并使用记忆套件

可安装入口是 `@jacklika/dsh-memory`。仓库根目录是私有 pnpm workspace，不是 Bundle；不要把 GitHub 仓库根地址传给 `dsh plugin add`。

## 从 registry 安装

各包发布后，把 Bundle 安装进已有或新 Profile：

```sh
dsh plugin --profile memory add @jacklika/dsh-memory@0.1.7-rc.2
```

Bundle 以运行时依赖带齐六个成员包，无需逐个安装。确保 `@deepseek-ai/dsh-base` 位于记忆 Bundle 之前，并加入 `@deepseek-ai/dsh-headless` 或 `@deepseek-ai/dsh-web-app` 等应用层。检查最终顺序：

```sh
dsh --profile memory --dump-config
```

预期记忆顺序是 `memory-scope`、`memory-queue`、`memory-git`、`tool-memory-filesystem`、`tool-memory-graph`，最后是默认禁用的 `tool-memory-vector`。

使用 Web 的 **Plugins** 页面或 `plugin_manager` 工具禁用、重新启用已安装 Bundle。Profile patch 会整项替换目标 row 的 `config`；请在覆盖项中写全本部署需要的配置。

通过官方包命令卸载：

```sh
dsh plugin --profile memory remove @jacklika/dsh-memory
```

卸载只移除包代码与 Bundle 选择，不会删除 `<workspace>/.dsh/memory/` 或显式配置的 Vault。

## 未发布时的本地 tarball 验证

仓库会构建并打包全部包、检查 tarball 内容，并在不引用源码 workspace 的独立目录里安装打包后的 Bundle：

```sh
pnpm install --frozen-lockfile
pnpm test:pack
pnpm test:profile
```

PowerShell 使用相同命令：

```powershell
pnpm install --frozen-lockfile
pnpm test:pack
pnpm test:profile
```

`pnpm pack:all` 默认把 tarball 写到 `artifacts/packages/`。发布 registry 之前，`test:profile` 是受支持且可复现的本地安装路径：它为所有尚未发布的成员 tarball 提供临时 pnpm overrides，运行真实 `dsh plugin` 命令，验证 `--dump-config`，卸载，并确认 Vault 保留。只安装 Bundle tarball 无法从 npm 解析尚未发布的成员包，因此不能作为正常流程。

## 配置 Vault

未配置 `vaultRoot` 时，每次调用使用 `<session workspace>/.dsh/memory/`。相对 `vaultRoot` 以该工作区为基准；绝对路径选择共享 Vault。路径由 Node path API 处理，支持空格和非 ASCII 字符。Profile 覆盖示例：

```yaml
- id: tool-memory-filesystem
  config:
    vaultRoot: '.dsh/memory'
    extensions: ['.md']
    maxLinkDepth: 1
    maxSearchResults: 20
    indexHiddenDirs: false
```

使用 `agentKey` 获得跨 session 稳定的私有命名空间：

```yaml
- id: memory-scope
  config:
    agentKey: 'main'
```

`agentKey` 为空时写入 `agents/<session id>/`；配置后写入 `agents/<agentKey>/`。以 `shared/` 开头的路径不重写，并默认由 `memory-git` 提交。

`memory-git.nestedRepo` 默认 `init`：创建 Vault 自己的仓库，绝不加入父仓库。`inherit` 选择最近的父仓库；`own` 要求 `<vault>/.git` 已存在。插件永不修改全局 Git 配置，也永不 push。

## 单独挂载 Skill

安装工具不等于安装 agent 指导。通过现有 `skill-filesystem` row 挂载 `skills/memory-vault`。

POSIX 路径：

```yaml
- id: skill-filesystem
  config:
    customSkillDirs: ['/home/me/src/mydsh-plugin/skills']
```

Windows YAML 路径（正斜杠可避免反斜杠转义）：

```yaml
- id: skill-filesystem
  config:
    customSkillDirs: ['C:/src/mydsh-plugin/skills']
```

目录无效时由 `skill-filesystem` 给出诊断，不影响记忆工具的安装。

## Vector 搜索

Bundle 默认禁用 vector。只有显式提供 HTTP(S) endpoint 与 model 后再启用：

```yaml
- id: tool-memory-vector
  disabled: false
  config:
    endpoint: 'http://127.0.0.1:11434/v1/embeddings'
    model: 'nomic-embed-text'
    apiKeyEnv: 'DSH_MEMORY_EMBEDDING_API_KEY'
    requestTimeoutMs: 30000
```

把 key 放在该环境变量中。它只作为 endpoint 的 Bearer token 发送，不会写进 Vault、Git 或错误消息。

## 常见问题

| 现象 | 处理 |
|---|---|
| Bundle 无法识别 | 安装 `@jacklika/dsh-memory`，不要安装仓库根；检查打包后的 `package.json` 含 `dsh.bundle.patch`。 |
| 缺少 `lib/index.js` | 运行 `pnpm build`；发布前运行 `pnpm test:pack`。 |
| peer 版本不兼容 | 使用 [compatibility.zh.md](compatibility.zh.md) 中的精确 Harness 版本；不要压制 peer 检查。 |
| Git 不存在 | 安装 Git 并确认 `git --version` 可在 `PATH` 运行，或在自定义 Bundle 中不挂 `memory-git`。 |
| Git identity 错误 | 插件通过 `git -c` 提供单次命令 identity，永不改全局配置；查看原样返回的 Git 错误。 |
| Vault 无权限 | 选择可写的 `vaultRoot`；原始文件系统错误会返回。 |
| 锁超时 | 检查其他活跃 writer；只有心跳持续不变且同机 PID 检查通过后才回收 stale lock。 |
| Skill 未加载 | 检查 `customSkillDirs` 指向包含 `memory-vault/SKILL.md` 的目录；非 HMR Profile 需重启。 |
| Vector endpoint 错误 | 检查 HTTP(S) URL、model、环境变量 key、timeout 与 OpenAI 兼容的 `data[].embedding` 响应。 |
