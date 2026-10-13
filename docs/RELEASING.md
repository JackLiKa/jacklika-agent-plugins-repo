# Releasing the suite

Operational runbook for cutting a release of the `@jacklika` plugin suite: gates, tagging, the GitHub-Release-triggered npm publish, desktop profile deployment, and npm dist-tag maintenance. `AGENTS.md` stays authoritative for contributor rules; this document only spells out the release procedure.

## Gates before delivery

Run all nine from the repository root and require success before any release commit. `test:multiprocess`, `test:pack`, and `test:profile` rebuild first, so a plain sequential run is enough.

| Gate | Command | Covers |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | Lockfile matches the manifests |
| Typecheck | `pnpm typecheck` | Project references, declarations |
| Lint | `pnpm lint` | `oxlint --deny-warnings` |
| Pairing | `pnpm run verify-translation-pairing` | EN/ZH structure, API names, and hashes |
| Test | `pnpm test` | Unit tests plus the MCP smoke test |
| Build | `pnpm build` | `tsc -b` across the workspace |
| Multiprocess | `pnpm test:multiprocess` | Cross-process vault coordination |
| Pack | `pnpm test:pack` | Tarball contents and installation |
| Profile | `pnpm test:profile` | Profile resolution with pinned tarballs |

`pnpm bench:vault` (1200 notes by default) is not a gate; run it when a change touches indexing, search, graph traversal, or the write path.

## Versioning

Every published package bumps in the release commit; unchanged packages keep their version. The Bundle (`@jacklika/dsh-memory`) carries the release line (`0.1.7-rc.22`), tool packages use `-alpha.N` suffixes (`0.1.3-alpha.12`), and the five-version set ships together so the Bundle dependency closure stays resolvable.

1. Bump `version` in each changed package's `package.json` and refresh internal dependency ranges when a dependency version changed.
2. Update the `dependencies` / `devDependencies` of dependents (`workspace:*` resolves at pack time, but the Bundle's published ranges are literal) and re-run `pnpm install` so `pnpm-lock.yaml` records the new versions.
3. Commit as `chore(release): <one-line summary>` and keep the fix commit separate so the diff reviewable.

## Tag and GitHub Release

The publish workflow triggers on `release: published`, so the Release is the release button — do not run `npm publish` from a workstation.

```bash
git push origin master
git tag v0.1.7-rc.22 && git push origin v0.1.7-rc.22
gh release create v0.1.7-rc.22 --title v0.1.7-rc.22 --notes-file /tmp/dsh-rc22-notes.md
```

- Tag name is `v<version>` and matches the Bundle version; the pre-release lines stay non-prerelease Releases so CI publishes them.
- Release notes list the package table (name, version, change), the nine-gate result, and any follow-ups.
- Expected CI: the `Publish to npm` workflow (`publish.yml`) runs `pnpm pack:all` and `pnpm test:pack`, then publishes tools before the Bundle tarball. Re-running is safe: already-published versions are skipped.

## Registry verification

Propagation can lag the workflow by minutes, so poll `npm view` instead of trusting the green run.

```bash
for p in @jacklika/dsh-memory @jacklika/dsh-tool-memory-filesystem @jacklika/dsh-memory-curator @jacklika/dsh-tool-memory-graph @jacklika/dsh-memory-mcp; do npm view "$p" version; done
```

A version is verified when `npm view <pkg>@<version> version` prints it; expected state is one release per package with `latest` pointing at it.

## Public access

`npm publish --access public` guarantees visibility for first publishes; there is currently no `npm access` step, because it was removed when npm made that operation fail for bypass-2FA tokens (see the next section).

## Dist-tag maintenance

`dist-tags.yml` is a `workflow_dispatch` helper; local checkouts carry no npm credentials, so every registry write goes through CI. Accepted inputs: `action` (`rm` or `add`), `tag`, comma- or space-separated `packages` (empty selects the five memory packages), `version` (required for `add`), and `dry_run` (default `true`).

```bash
gh workflow run dist-tags.yml -f action=add -f tag=next -f packages='@jacklika/dsh-memory' -f version=0.1.7-rc.22 -f dry_run=false
```

- `add` re-points a tag and is idempotent; every dispatch covers a single version, so repointing several packages to different versions takes one dispatch each.
- `rm` tolerates `E404` for an already-absent tag but fails on any other error.
- Always run a `dry_run=true` dispatch first; it prints the exact `npm dist-tag` commands without touching the registry.
- The health check for `next` is that every tracked line exposes the same version on `next` and `latest`.

## npm token failures

`NPM_TOKEN` is a granular access token that bypasses 2FA. Since npm restricted [bypass-2FA granular access tokens](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/) such a token can publish and can add or re-point dist-tags, but sensitive operations are refused:

| Operation | Result with the current token |
|---|---|
| `npm publish` for a new version | Works |
| `npm dist-tag add`, including re-pointing | Works |
| `npm dist-tag rm` | `403 ... DELETE .../dist-tags/<tag>` |
| `npm access set status=public` | `403 ... POST .../access` |

Distinguish the two failure classes before retrying anything: a `403` together with the npm notice about bypass-2FA tokens is a policy refusal, and retrying, renaming, or switching packages does not help. `E401` or `EOTP` is an authentication or one-time-password problem instead.

## Trusted publishing (OIDC) migration

Direct publishing loses token support in January 2027, and npm's answer is [trusted publishing](https://docs.npmjs.com/trusted-publishers) with short-lived OIDC credentials. Prepare both workflows now; the migration direction is OIDC-first with the token as the fallback until the npm-side configuration is validated.

1. Repository side: grant `id-token: write` in both `publish.yml` and `dist-tags.yml` (already present) so `actions/setup-node` exposes `ACTIONS_ID_TOKEN_REQUEST_URL`.
2. npm side: for each package add a trusted publisher for this repository and workflow file, then enable [Allow npm dist-tag](https://github.blog/changelog/2026-09-30-opt-in-dist-tag-permissions-for-npm-trusted-publishing) per configuration. Both actions need interactive 2FA on npmjs.com and cannot be performed by CI.
3. Validate: `publish.yml` runs OIDC-first without being asked to, and falls back to `NPM_TOKEN` for one retry when an OIDC publish fails, so a package without a trusted publisher still publishes. A `dist-tags.yml` dispatch with the `oidc` input proves the dist-tag grant: use `add`, and if `rm` still returns `403`, the grant is missing or unvalidated on the npm side.
4. Retire the token once a release has published cleanly over OIDC: revoke `NPM_TOKEN` and delete the repository secret.

The auth selector `publish.yml` uses:

```bash
unset NODE_AUTH_TOKEN
```

With both `ACTIONS_ID_TOKEN_REQUEST_URL` and `NODE_AUTH_TOKEN` present npm ignores the OIDC route, so the token is withheld until an attempt fails on authentication. `dist-tags.yml` instead selects one mode per dispatch through its `oidc` input, and never falls back, so a refused deletion cannot look like a deletion that worked.

## Desktop profile deployment

Pinning unpublished or locally built versions into a dsh profile uses `file:` dependencies plus overrides in the profile's `pnpm-workspace.yaml`; the profile pins agent plugins through its own lockfile. The desktop profile at `/Users/user/.dsh/profiles/desktop` follows this pattern:

1. `dsh plugin add` resolves each package once and writes `file:.connector-packages/*.tgz` dependencies plus matching `overrides:` entries.
2. The app runtime pnpm must be invoked with `DSH_DESKTOP_NODE_EXECUTABLE` set, or the wrapper node prints `exec: : not found` and exits 127.
3. Verify with `pnpm install --frozen-lockfile` under the app runtime and with `scripts/profile-resolution.mjs`, which asserts a single copy per package inside the profile's `node_modules`.
4. Restart the Electron host to load new plugin code; `plugin_manager` install or update calls are unsafe while the pins are active.

## Related

- [architecture.md](architecture.md)
- [usage.md](usage.md)
- [compatibility.md](compatibility.md)
