import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { satisfies } from 'semver'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageRoot = join(root, 'packages')

/**
 * The Harness release line this suite verifies: bounded, not exact. The
 * application updates itself, and an exact peer turns every unrelated release
 * into a load-time refusal even when the plugin is compatible. A release joins
 * the window only after the full compatibility matrix passes on it, and the
 * range keeps the next release line refused before code loads.
 *
 * The window is spelled as two branches because the string serves two
 * consumers with different semver semantics. The Harness runtime validates it
 * with `includePrerelease: true`, under which the first branch alone covers
 * every 0.1.x/0.2.x prerelease. npm and pnpm resolve peers under default
 * semantics, where a prerelease can only match when some comparator carries a
 * prerelease at the same major.minor.patch — so the second branch exists
 * solely for package-manager resolution and must gain a sibling with the same
 * tuple whenever the verified line moves (e.g. `>=0.2.1-rc.1 <0.3.0-0`).
 */
const HARNESS_PEER_WINDOW = '>=0.1.7-rc.1 <0.3.0-0 || >=0.2.0-rc.1 <0.3.0-0'

/**
 * Reduce a declared or remote Git URL to `host/owner/repo` so the spellings npm
 * accepts compare equal: `git+https://…`, `ssh://…`, and `git@host:owner/repo`.
 * @param url - the raw Git URL.
 * @returns the lowercased URL without its transport prefix or `.git` suffix.
 */
function normalizeGitUrl(url: string): string {
  return url.trim()
    .replace(/^git\+/, '')
    .replace(/^ssh:\/\//, '')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * Read the checkout's `origin` URL.
 * @returns the remote URL, or undefined when the checkout has no readable origin.
 */
function originUrl(): string | undefined {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) return undefined
  const url = result.stdout.trim()
  return url === '' ? undefined : url
}

async function packageManifests(): Promise<{ path: string; value: Record<string, unknown> }[]> {
  const names = await readdir(packageRoot)
  const manifests = await Promise.all(names.map(async (name) => {
    const path = join(packageRoot, name, 'package.json')
    try {
      return { path, value: JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }
    } catch (error) {
      // Skip stray entries under packages/ that are not packages. ENOTDIR
      // covers plain files (packages/foo.txt/package.json); ENOENT covers
      // directories without a manifest.
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
  }))
  return manifests.filter((item): item is { path: string; value: Record<string, unknown> } => item !== undefined)
}

describe('published package manifests', () => {
  it('contains no machine-specific dependency path in manifests or lockfile', async () => {
    const files = [join(root, 'package.json'), join(root, 'pnpm-lock.yaml'), ...(await packageManifests()).map(item => item.path)]
    for (const path of files) {
      const text = await readFile(path, 'utf8')
      expect(text, path).not.toMatch(/\/Users\/[^/]+\/|link:[A-Za-z]:[\\/]/)
    }
  })

  it('contain no machine-specific links and pin the verified Harness peer window', async () => {
    for (const { path, value } of await packageManifests()) {
      const serialized = JSON.stringify(value)
      expect(serialized, path).not.toMatch(/link:\/|link:[A-Za-z]:\\/)
      const peers = value.peerDependencies as Record<string, string> | undefined
      for (const [name, range] of Object.entries(peers ?? {})) {
        if (name.startsWith('@deepseek-ai/dsh-')) expect(range, `${path}: ${name}`).toBe(HARNESS_PEER_WINDOW)
        else if (name.startsWith('@deepseek-ai/')) expect(range, `${path}: ${name}`).not.toBe('*')
      }
    }
  })

  it('declares the supported Node range and complete published entry points', async () => {
    for (const { path, value } of await packageManifests()) {
      expect(value.type, path).toBe('module')
      expect(value.engines, path).toEqual({ node: '^22.19.0 || >=24.0.0' })
      expect(value.license, path).toBe('MIT')
      expect(value.repository, path).toMatchObject({ type: 'git', directory: expect.any(String) })
      expect(value.main, path).toBeTypeOf('string')
      expect(value.types, path).toBeTypeOf('string')
      expect(value.files, path).toBeInstanceOf(Array)
      expect(value.exports, path).toBeTypeOf('object')
    }
  })

  it('names one repository URL that still matches the checkout it lives in', async () => {
    const rootPath = join(root, 'package.json')
    const rootManifest = JSON.parse(await readFile(rootPath, 'utf8')) as Record<string, unknown>
    const packages = await packageManifests()

    const urls = new Set<string>()
    for (const { path, value } of [{ path: rootPath, value: rootManifest }, ...packages]) {
      const repository = value.repository as { type?: string; url?: string; directory?: string } | undefined
      expect(repository?.type, path).toBe('git')
      expect(repository?.url, path).toBeTypeOf('string')
      urls.add(normalizeGitUrl(repository!.url!))
    }

    // Every manifest in the workspace names the same repository.
    expect([...urls], 'manifests disagree on the repository URL').toHaveLength(1)

    // A package's `directory` is its own path, so a moved or renamed package fails.
    for (const { path, value } of packages) {
      const directory = (value.repository as { directory?: string }).directory
      expect(directory, path).toBe(relative(root, dirname(path)).split(sep).join('/'))
    }
    expect(
      (rootManifest.repository as { directory?: string }).directory,
      'the root package must not claim a subdirectory',
    ).toBeUndefined()

    // The repository name is the part that drifts — a stale rename once survived
    // this suite. Only the name is compared, never the owner, so a fork's
    // checkout (same name, different owner) still passes.
    const remote = originUrl()
    if (remote !== undefined) {
      const declaredName = [...urls][0]!.split('/').pop()
      expect(declaredName, 'manifests must name the checkout origin repository').toBe(
        normalizeGitUrl(remote).split('/').pop(),
      )
    }
  })

  it('rejects the next release line prereleases before code loads', () => {
    // The runtime checks peers with includePrerelease enabled. Without the -0
    // suffix on the upper bound, <0.3.0 would match 0.3.0-rc.1 and 0.3.0-alpha.0.
    const accepts = ['0.1.7-rc.1', '0.1.7-rc.2', '0.2.0-rc.1', '0.2.99-rc.1']
    const rejects = ['0.3.0', '0.3.0-alpha.0', '0.3.0-rc.1', '0.3.1-rc.1']
    for (const version of accepts) {
      expect(satisfies(version, HARNESS_PEER_WINDOW, { includePrerelease: true })).toBe(true)
    }
    for (const version of rejects) {
      expect(satisfies(version, HARNESS_PEER_WINDOW, { includePrerelease: true })).toBe(false)
    }
  })

  it('accepts the verified lines under package-manager default semantics', () => {
    // npm and pnpm resolve peers WITHOUT includePrerelease: a prerelease only
    // matches a range containing a comparator with a prerelease at the same
    // major.minor.patch. Passing the runtime gate is therefore not proof the
    // package can be installed — a single-branch window silently excluded the
    // entire 0.2.x line and npm ERESOLVEd against dsh-llm@0.2.0-rc.2.
    for (const version of ['0.1.7-rc.2', '0.2.0-rc.2']) {
      expect(satisfies(version, HARNESS_PEER_WINDOW)).toBe(true)
    }
    for (const version of ['0.3.0-rc.1', '0.3.0']) {
      expect(satisfies(version, HARNESS_PEER_WINDOW)).toBe(false)
    }
  })
})
