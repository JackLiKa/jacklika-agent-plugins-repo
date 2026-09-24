# 新增插件

本仓库是插件套件工作区，记忆链只是其中一个成员。新插件遵循同样的约定，以保证能通过 `dsh plugin add` 安装并在 profile 中组合。

## 清单

1. 创建 `packages/<name>/`，`package.json` 命名为 `@jacklika/dsh-<name>`。
2. 从 `src/index.ts` 导出 Cordis 插件契约：`name`、`inject`、`Config`（schemastery）、`apply(ctx, config)`。
3. `@deepseek-ai/*` 服务声明为 `peerDependencies`（由宿主 dsh 安装解析）+ 本地开发的 `devDependencies`；套件内部依赖用 `workspace:*`。
4. 在 `tsconfig.base.json` 注册 `paths` 别名；如目录在 `packages/*` glob 之外则加入 `pnpm-workspace.yaml`。
5. 写 `README.md` 和 `README.zh.md`，含配置表与使用示例。
6. 加一个真实 Loader 组合测试——不能只写单元测试。
7. 若插件带 agent 侧引导，加 `skills/<name>/SKILL.md` 并写明 `customSkillDirs` 挂载方式。

## 从 dsh 继承的原则

- 一切 opt-in：不挂载就不得改变行为。
- 协调类插件装饰 `tools/execute`（waterfall），绝不修改工具本体。
- 随部署变化的选项进 `Config` 字段，不写硬编码常量。
- 一切 vault/文件系统写必须经过路径包含校验并原子发布。
