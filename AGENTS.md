# jacklika-agent-plugins-repo contributor rules

- This is a private pnpm workspace of third-party DeepSeek Harness plugins. `@jacklika/dsh-memory` is the installable Bundle; the repository root is not installable.
- Support Node.js `^22.19.0 || >=24.0.0` and pnpm 11.7.0 on Windows, macOS, and Linux. Never commit machine-local `link:` dependencies or absolute developer paths.
- Harness APIs are pre-stable. Direct Harness/Cordis imports use the verified Harness window documented in `docs/compatibility.md`; a release joins that window only after the full compatibility matrix passes on it, and the window stays bounded so the next release line is still refused before code loads.
- Function plugins named-export `name`, `inject`, `Config`, and `apply` without a default export. Registrations and waterfall listeners must dispose with their Loader fiber; unhandled waterfall calls delegate through `next()`.
- Every filesystem path stays inside its configured Vault after lexical and realpath checks. Writes use sibling temporary files and atomic rename; tests and verification scripts own unique temporary directories under the OS temp directory, prefixed `dsh-<area>-<purpose>-`, and await cleanup.
- Update English and Chinese documentation together. Package behavior belongs in the package README; suite-wide install, compatibility, architecture, and security behavior belongs in `docs/`.
- Before delivery run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm run verify-translation-pairing`, `pnpm test`, `pnpm build`, `pnpm test:multiprocess`, `pnpm test:pack`, and `pnpm test:profile`.
