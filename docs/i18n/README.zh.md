# 双语文档配对

每个面向用户的包都必须保持英文和中文 README 同步。每个包在 README 对旁边
放置 `README.i18n.yaml`，记录最近一次确认一致时两种语言的 git blob hash。
两种语言具有同等效力。

## 工作流

1. 先编辑你母语那一边（英文或中文）。
2. 把另一边同步到相同详细程度和准确性。
3. 重新记录配对：

   ```bash
   pnpm run verify-translation-pairing --write packages/<name>/README.md
   ```

   或

   ```bash
   pnpm run verify-translation-pairing --write packages/<name>/README.zh.md
   ```

4. 一起提交两个 README 和更新后的 `README.i18n.yaml`。

## 验证

CI 会在没有 `--write` 的情况下运行校验器，任何漂移都会让构建失败。
