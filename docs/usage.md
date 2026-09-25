# Install and use the memory suite

The installable entry is `@jacklika/dsh-memory`. The repository root is a private pnpm workspace and is not a Bundle; do not pass the GitHub repository root to `dsh plugin add`.

## Registry installation

After the packages are published, install the Bundle into an existing or new Profile:

```sh
dsh plugin --profile memory add @jacklika/dsh-memory@0.1.7-rc.1
```

The Bundle carries all six member packages as runtime dependencies. Do not install them one by one. Keep `@deepseek-ai/dsh-base` before the memory Bundle and add an application layer such as `@deepseek-ai/dsh-headless` or `@deepseek-ai/dsh-web-app`. Inspect the effective order with:

```sh
dsh --profile memory --dump-config
```

The expected memory order is `memory-scope`, `memory-queue`, `memory-git`, `tool-memory-filesystem`, `tool-memory-graph`, then the disabled `tool-memory-vector`.

Use the Web **Plugins** page or the `plugin_manager` tool to disable and re-enable the installed Bundle. A Profile patch replaces a targeted row's complete `config`; include every config value that deployment needs.

Uninstall through the official package command:

```sh
dsh plugin --profile memory remove @jacklika/dsh-memory
```

Uninstall removes package code and Bundle selection, not `<workspace>/.dsh/memory/` or an explicitly configured Vault.

## Private and local installation

This suite is a private plugin package; it is not published to a public registry. Install it straight from a checkout, with no registry and no publish step:

```sh
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile memory add /absolute/path/to/mydsh-plugin/packages/memory
```

Pass an absolute path, and point it at the **Bundle** package — never the repository root. Only the spelling differs per platform:

| Platform | Path to pass |
|---|---|
| macOS / Linux | `/home/me/src/mydsh-plugin/packages/memory` |
| Windows (PowerShell) | `C:\src\mydsh-plugin\packages\memory` |
| Windows (forward slashes are also accepted) | `C:/src/mydsh-plugin/packages/memory` |

Quote the path when it contains spaces.

`pnpm build` comes first: `lib/` is gitignored, and the Bundle's `main` and `types` entries live there. Re-run `pnpm build` after editing sources; the Profile itself needs no reinstall.

The Profile records the Bundle as a `link:` dependency — a directory junction on Windows, a symbolic link on POSIX — so the checkout must stay at the path you passed. Everything else behaves like a registry installation:

```sh
dsh --profile memory --dump-config
dsh plugin --profile memory remove @jacklika/dsh-memory
```

Do not pass a member package such as `packages/tool-memory-filesystem` on its own. It declares no `dsh.bundle`, so `dsh plugin` installs it as a plain dependency and it contributes no Profile layer.

### Why a Bundle tarball alone is not enough

`pnpm pack` rewrites the Bundle's `workspace:*` member dependencies into exact versions. Those members are unpublished, so installing the tarball alone asks a registry for them and fails with `ERR_PNPM_FETCH_404`; `dsh plugin` then restores the Profile manifest and lockfile. Distribute a tarball through a private registry, or install from the checkout path above.

### Private registry

To install on several machines or share the suite, publish all eight packages to a private registry and point the Plugin Manager at it. Harness asks a registry outside its configured set alone, so a private registry never falls through to a public one. Set `registry` on the `plugin-manager` row; authentication comes from pnpm's own configuration (`.npmrc`):

```yaml
- id: plugin-manager
  config:
    registry: 'https://npm.example.internal/'
```

Then install by name and version as in [Registry installation](#registry-installation).

## Unpublished local tarball verification

The repository builds and packs every package, checks tarball contents, and installs the packed Bundle in a directory with no source-workspace links:

```sh
pnpm install --frozen-lockfile
pnpm test:pack
pnpm test:profile
```

PowerShell uses the same commands:

```powershell
pnpm install --frozen-lockfile
pnpm test:pack
pnpm test:profile
```

`pnpm pack:all` writes tarballs to `artifacts/packages/` by default. Before registry publication, `test:profile` is the supported reproducible local installation path: it supplies temporary pnpm overrides for all unpublished member tarballs, runs the real `dsh plugin` command, verifies `--dump-config`, uninstalls, and confirms Vault preservation. Direct installation of only the Bundle tarball cannot resolve unpublished member packages from npm and is therefore rejected as a normal workflow.

## Configure the Vault

Without `vaultRoot`, every call uses `<session workspace>/.dsh/memory/`. A relative `vaultRoot` is anchored at that workspace; an absolute path selects a shared Vault. Paths with spaces and non-ASCII characters are supported through Node's path APIs. Example Profile override:

```yaml
- id: tool-memory-filesystem
  config:
    vaultRoot: '.dsh/memory'
    extensions: ['.md']
    maxLinkDepth: 1
    maxSearchResults: 20
    indexHiddenDirs: false
```

Use `agentKey` for a stable private namespace across sessions:

```yaml
- id: memory-scope
  config:
    agentKey: 'main'
```

An empty `agentKey` derives `agents/<session id>/`; a configured key writes under `agents/<agentKey>/`. Paths beginning with `shared/` are not rewritten and are committed by `memory-git` by default.

`memory-git.nestedRepo` defaults to `init`, which creates a Vault-local repository and never joins a parent repository. `inherit` selects the nearest parent repository; `own` requires `<vault>/.git`. The plugin never changes global Git configuration and never pushes.

## Mount the Skill separately

Installing tools does not install agent guidance. Mount `skills/memory-vault` through the existing `skill-filesystem` row.

POSIX path:

```yaml
- id: skill-filesystem
  config:
    customSkillDirs: ['/home/me/src/mydsh-plugin/skills']
```

Windows YAML path (forward slashes avoid backslash escaping):

```yaml
- id: skill-filesystem
  config:
    customSkillDirs: ['C:/src/mydsh-plugin/skills']
```

An invalid directory is diagnosed by `skill-filesystem`; it does not affect installation of the memory tools.

## Vector search

Vector search is disabled in the Bundle. Enable it only with an explicit HTTP(S) endpoint and model:

```yaml
- id: tool-memory-vector
  disabled: false
  config:
    endpoint: 'http://127.0.0.1:11434/v1/embeddings'
    model: 'nomic-embed-text'
    apiKeyEnv: 'DSH_MEMORY_EMBEDDING_API_KEY'
    requestTimeoutMs: 30000
```

Keep the key in the named environment variable. It is sent only as the endpoint's Bearer token and is not written to the Vault, Git, or error messages.

## Troubleshooting

| Symptom | Action |
|---|---|
| Bundle is not recognized | Install `@jacklika/dsh-memory`, not the repository root; verify its packed `package.json` contains `dsh.bundle.patch`. |
| A member package installs but adds no Profile layer | Pass `packages/memory`, not `packages/tool-memory-filesystem`; a package without `dsh.bundle` is a plain dependency. |
| Bundle tarball install fails with `ERR_PNPM_FETCH_404` | Install from a checkout path ([Private and local installation](#private-and-local-installation)), or publish every member package to a private registry. |
| `lib/index.js` is missing | Run `pnpm build`; use `pnpm test:pack` before publishing. |
| Peer version mismatch | Use the exact Harness release in [compatibility.md](compatibility.md); do not suppress the peer check. |
| Git is missing | Install Git and ensure `git --version` works on `PATH`, or omit `memory-git` from a custom Bundle. |
| Git identity error | The plugin supplies command-local identity with `git -c`; it never edits global config. Inspect the surfaced Git error. |
| Vault permission error | Select a writable `vaultRoot`; the original filesystem error is returned. |
| Lock timeout | Check for another active writer. A stale lock is reclaimed only after unchanged heartbeat evidence and same-host PID checks. |
| Skill is absent | Verify `customSkillDirs` points to the directory containing `memory-vault/SKILL.md`; restart a non-HMR Profile. |
| Vector endpoint error | Verify HTTP(S) URL, model, environment-variable key, timeout, and OpenAI-compatible `data[].embedding` response. |
