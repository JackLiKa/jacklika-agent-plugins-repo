import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageRoot = join(root, 'packages')

/**
 * The Harness release line this suite verifies: bounded, not exact. The
 * application updates itself, and an exact peer turns every unrelated release
 * into a load-time refusal even when the plugin is compatible. A release joins
 * the window only after the full compatibility matrix passes on it, and the
 * range keeps the next release line refused before code loads.
 */
const HARNESS_PEER_WINDOW = '>=0.1.7-rc.1 <0.1.8'

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
  return Promise.all(names.map(async (name) => {
    const path = join(packageRoot, name, 'package.json')
    return { path, value: JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }
  }))
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
})
