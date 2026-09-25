# mydsh-plugin contributor rules

- This is a private pnpm workspace of third-party DeepSeek Harness plugins. `@jacklika/dsh-memory` is the installable Bundle; the repository root is not installable.
- Support Node.js `^22.19.0 || >=24.0.0` and pnpm 11.7.0 on Windows, macOS, and Linux. Never commit machine-local `link:` dependencies or absolute developer paths.
- Harness APIs are pre-stable. Direct Harness/Cordis imports use the exact versions documented in `docs/compatibility.md`; expand ranges only after the full compatibility matrix passes.
- Function plugins named-export `name`, `inject`, `Config`, and `apply` without a default export. Registrations and waterfall listeners must dispose with their Loader fiber; unhandled waterfall calls delegate through `next()`.
- Every filesystem path stays inside its configured Vault after lexical and realpath checks. Writes use sibling temporary files and atomic rename; tests own unique temporary directories and await cleanup.
- Update English and Chinese documentation together. Package behavior belongs in the package README; suite-wide install, compatibility, architecture, and security behavior belongs in `docs/`.
- Before delivery run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:multiprocess`, `pnpm test:pack`, and `pnpm test:profile`.
