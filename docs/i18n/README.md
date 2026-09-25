# Bilingual documentation pairing

Every package and suite-level documentation directory that ships
user-facing docs must keep its English and Chinese files in sync. Each
bilingual pair is guarded by an `i18n.yaml` record that stores the git blob
hash of each language as of the last confirmed-consistent state. Both
languages carry equal authority.

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

4. Commit both sides and the updated `i18n.yaml` together.

## Verification

CI runs the verifier without `--write` so any drift fails the build.
