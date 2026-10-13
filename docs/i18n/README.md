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

CI runs the verifier without `--write`, so any drift fails the build. Before
comparing recorded hashes, the verifier checks the structures a translation
must preserve: the heading level sequence, the count and info strings of
fenced blocks, table shapes, and Markdown link targets (fragment-only links
and `.zh.md` suffixes are normalized). Fenced blocks that are not localized on
either side must match byte for byte, so an updated verbatim tool description
cannot survive in one language only, and every API-like inline code span (tool
and parameter names, package names, dotted property paths) must appear on both
sides. The Chinese side must also contain CJK characters, which catches a pair
"translated" by copying the English file. Ordinary prose inside code spans may
differ freely.
