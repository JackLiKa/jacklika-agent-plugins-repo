# Bilingual documentation pairing

Every package that ships user-facing documentation must keep its English and
Chinese READMEs in sync. Each package stores a `README.i18n.yaml` next to the
pair with the git blob hash of each language as of the last confirmed-consistent
state. Both languages carry equal authority.

## Workflow

1. Edit the side you write in first (English or Chinese).
2. Bring the other side to the same level of detail and accuracy.
3. Re-record the pair:

   ```bash
   pnpm run verify-translation-pairing --write packages/<name>/README.md
   ```

   or

   ```bash
   pnpm run verify-translation-pairing --write packages/<name>/README.zh.md
   ```

4. Commit both READMEs and the updated `README.i18n.yaml` together.

## Verification

CI runs the verifier without `--write` so any drift fails the build.
