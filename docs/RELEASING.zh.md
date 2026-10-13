# 套件发布

`@jacklika` 插件套件的发布运维手册：门禁、打 tag、由 GitHub Release 触发的 npm 发布、desktop profile 部署，以及 npm dist-tag 维护。贡献者规则仍以 `AGENTS.md` 为准；本文只展开发布流程。

## 交付前门禁

在仓库根目录执行全部九项，全部成功后才允许提交发布。`test:multiprocess`、`test:pack`、`test:profile` 会先自行构建，因此按顺序直接执行即可。

| 门禁 | 命令 | 覆盖内容 |
|---|---|---|
| 安装 | `pnpm install --frozen-lockfile` | lockfile 与清单一致 |
| 类型检查 | `pnpm typecheck` | 项目引用、声明文件 |
| Lint | `pnpm lint` | `oxlint --deny-warnings` |
| 配对 | `pnpm run verify-translation-pairing` | EN/ZH 结构、API 名称与哈希 |
| 测试 | `pnpm test` | 单元测试加 MCP 冒烟测试 |
| 构建 | `pnpm build` | 全工作区 `tsc -b` |
| 多进程 | `pnpm test:multiprocess` | 跨进程 vault 协调 |
| 打包 | `pnpm test:pack` | tarball 内容与安装 |
| Profile | `pnpm test:profile` | 使用 pin 的 tarball 做 profile 解析 |

`pnpm bench:vault`（默认 1200 条笔记）不是门禁；改动涉及索引、搜索、图遍历或写入路径时运行它。

## 版本号

发布提交为每个已发布包升版本，未变化的包保持版本不动。Bundle（`@jacklika/dsh-memory`）承载发布线（`0.1.7-rc.22`），工具包带 `-alpha.N` 后缀（`0.1.3-alpha.12`），五个版本成套发布，保证 Bundle 的依赖闭包可解析。

1. 在发生变化的每个包 `package.json` 中升级 `version`，并在依赖版本变化时同步内部依赖范围。
2. 更新依赖方的 `dependencies` / `devDependencies`（`workspace:*` 在打包时解析，但 Bundle 发布出去的范围是字面值），随后重跑 `pnpm install`，让 `pnpm-lock.yaml` 记录新版本。
3. 以 `chore(release): <一行摘要>` 提交，并与修复提交分开，便于审阅 diff。

## 打 tag 与 GitHub Release

发布工作流由 `release: published` 触发，因此 Release 就是发布按钮——不要在开发机上直接执行 `npm publish`。

```bash
git push origin master
git tag v0.1.7-rc.22 && git push origin v0.1.7-rc.22
gh release create v0.1.7-rc.22 --title v0.1.7-rc.22 --notes-file /tmp/dsh-rc22-notes.md
```

- tag 名为 `v<version>`，与 Bundle 版本一致；预发布线同样以非 prerelease 的 Release 发布，便于 CI 发布。
- Release 说明列出包表（名称、版本、变更）、九项门禁结果和后续事项。
- 预期 CI：`Publish to npm` 工作流（`publish.yml`）先跑 `pnpm pack:all` 与 `pnpm test:pack`，再按工具包在前、Bundle tarball 在后的顺序发布。重跑是安全的：已发布的版本会被跳过。

## registry 复核

传播可能比工作流晚几分钟，因此用轮询 `npm view` 代替"绿灯即成功"。

```bash
for p in @jacklika/dsh-memory @jacklika/dsh-tool-memory-filesystem @jacklika/dsh-memory-curator @jacklika/dsh-tool-memory-graph @jacklika/dsh-memory-mcp; do npm view "$p" version; done
```

当 `npm view <pkg>@<version> version` 打印出该版本时即为复核通过；预期状态是每个包各一个发布版本，且 `latest` 指向它。

## 公开可见性

`npm publish --access public` 已保证首次发布的可见性；当前没有 `npm access` 步骤，因为 npm 让该操作对绕过 2FA 的令牌失败后被移除（见下一节）。

## dist-tag 维护

dist-tag 维护由同一个 `publish.yml` 工作流通过 `workflow_dispatch` 的 `dist-tag` action 完成；本地 checkout 不带 npm 凭据，因此所有 registry 写入都走 CI。接受的输入：`action`（`dist-tag`）、`dist_tag_action`（`rm` 或 `add`）、`dist_tag`、以逗号或空格分隔的 `dist_tag_packages`（留空即选中五个 memory 包）、`dist_tag_version`（`add` 必填）。

```bash
gh workflow run publish.yml -f action=dist-tag -f dist_tag_action=add -f dist_tag=next -f dist_tag_packages='@jacklika/dsh-memory' -f dist_tag_version=0.1.7-rc.23
```

- `add` 用于重指 tag，幂等；每次 dispatch 只接受一个版本，因此多个包指向不同版本时需逐个 dispatch。
- `rm` 容忍 tag 本就不存在的 `E404`，其他错误一律失败。
- dist-tag 任务始终使用 OIDC trusted publishing，仅在 OIDC 尝试失败时回退到 `NPM_TOKEN`。
- `next` 的健康标准是：每条受跟踪的发布线在 `next` 与 `latest` 上暴露相同版本。

## npm 令牌故障

`NPM_TOKEN` 是绕过 2FA 的 granular access token。自 npm 收紧[绕过 2FA 的 granular access token](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)以来，此类令牌可以发布、可以添加或重指 dist-tag，但敏感操作会被拒绝：

| 操作 | 当前令牌结果 |
|---|---|
| 新版本的 `npm publish` | 成功 |
| `npm dist-tag add`（含重指） | 成功 |
| `npm dist-tag rm` | `403 ... DELETE .../dist-tags/<tag>` |
| `npm access set status=public` | `403 ... POST .../access` |

重试前先区分两类失败：`403` 且带 npm 关于绕过 2FA 令牌的 notice，属策略拒绝，重试、改名或换包都无效。`E401` 或 `EOTP` 才是认证或一次性密码问题。

## 迁移到 trusted publishing（OIDC）

直接发布将于 2027-01 失去令牌支持，npm 给出的方向是使用短时 OIDC 凭据的 [trusted publishing](https://docs.npmjs.com/trusted-publishers)。现在就为两个工作流做好准备；迁移方向是 OIDC 优先、令牌兜底，直到 npm 侧配置被验证。

1. 仓库侧：在 `publish.yml` 中授予 `id-token: write`（已就位），使 runner 暴露 `ACTIONS_ID_TOKEN_REQUEST_URL`。
2. npm 侧：为每个包添加指向本仓库与 `publish.yml` 工作流文件的 trusted publisher，并在同一配置中启用 **Allow npm dist-tag**，随后通过第一次成功发布验证该配置。这些步骤都需要在 npmjs.com 上交互式 2FA，CI 无法代劳。
3. 验证：`publish.yml` 无需额外开关即 OIDC 优先，当某包的 OIDC 发布失败时回退到 `NPM_TOKEN` 重试一次，因此尚未配置 trusted publisher 的包仍能发布。`publish.yml` 用 `action=dist-tag` dispatch 证明 dist-tag 授权；若返回 `401`，说明 npm 侧授权缺失或未验证。
   - 注意：OIDC dist-tag 操作要求 npm CLI `>= 11.21.0`（或 `>= 12.2.0`）。`publish.yml` 的 dist-tag job 会在调用 `npm dist-tag` 前升级 runner 上的 npm，因为 Node 24 镜像自带的 npm 版本不支持 OIDC dist-tag。
4. 某次发布在 OIDC 下干净完成后撤销令牌：吊销 `NPM_TOKEN` 并删除仓库 secret。

`publish.yml` 使用的认证选择器：

```bash
unset NODE_AUTH_TOKEN
```

当 `ACTIONS_ID_TOKEN_REQUEST_URL` 与 `NODE_AUTH_TOKEN` 同时存在时，npm 会忽略 OIDC 通道，因此令牌被扣留，直到某次尝试因认证失败。`publish.yml` 的 dist-tag 任务使用同样的"先 unset、失败再回退"模式。

## desktop profile 部署

把未发布或本地构建的版本 pin 进 dsh profile，使用 profile `pnpm-workspace.yaml` 中的 `file:` 依赖加 overrides；profile 通过自己的 lockfile pin 住 agent 插件。desktop profile（`/Users/user/.dsh/profiles/desktop`）遵循这一模式：

1. `dsh plugin add` 逐个解析包，写入 `file:.connector-packages/*.tgz` 依赖及对应的 `overrides:` 条目。
2. 必须设置 `DSH_DESKTOP_NODE_EXECUTABLE` 再调用 app 运行时 pnpm，否则包装 node 输出 `exec: : not found` 并以 127 退出。
3. 用 app 运行时的 `pnpm install --frozen-lockfile` 和 `scripts/profile-resolution.mjs` 验证，后者断言每个包在 profile 的 `node_modules` 中只有单副本。
4. 重启 Electron 宿主以加载新插件代码；pin 生效期间调用 `plugin_manager` 的安装或更新是不安全的。

## 关联

- [architecture.md](architecture.zh.md)
- [usage.md](usage.zh.md)
- [compatibility.md](compatibility.zh.md)
