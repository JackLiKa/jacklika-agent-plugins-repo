# Adding new plugins

This repository is the plugin suite workspace; the memory chain is one member. New plugins follow the same conventions so they stay installable through `dsh plugin add` and composable in profiles.

## Checklist

1. Create `packages/<name>/` with `package.json` named `@jacklika/dsh-<name>`.
2. Export the Cordis plugin contract from `src/index.ts`: `name`, `inject`, `Config` (schemastery), `apply(ctx, config)`.
3. Declare `@deepseek-ai/*` services as `peerDependencies` (resolved by the host dsh installation) plus `devDependencies` for local development; suite-internal dependencies use `workspace:*`.
4. Register a `paths` alias in `tsconfig.base.json`, add a root `tsconfig.json` reference, and give the package tsconfig `outDir: lib` + `declarationDir: lib/types` with a project `references` entry per suite-internal dependency.
5. Write `README.md` and `README.zh.md` with a configuration table and a usage example.
6. Add a test that composes the plugin in a real Loader context — not only unit tests.
7. If the plugin ships agent-facing guidance, add `skills/<name>/SKILL.md` and document the `customSkillDirs` mount.

## Principles carried over from dsh

- Everything is opt-in: no plugin may change behavior unless mounted.
- Coordination plugins decorate `tools/execute` (waterfall); they never modify the tool itself.
- Deployment-varying choices are `Config` fields, not hardcoded constants.
- All vault/filesystem writes must pass path-containment checks and publish atomically.
