import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script without types
import { pruneStaging, replaceDir } from '../scripts/install-into-profile.mjs'

let base: string | undefined

afterEach(async () => {
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
})

async function tmp(): Promise<string> {
  base = await mkdtemp(join(tmpdir(), 'dsh-install-spec-'))
  return base
}

describe('replaceDir', () => {
  it('swaps a new directory over an existing install', async () => {
    const root = await tmp()
    const src = join(root, 'new')
    const target = join(root, 'nm', '@jacklika', 'pkg')
    const backup = join(root, 'pkg.backup')
    await mkdir(join(src, 'lib'), { recursive: true })
    await writeFile(join(src, 'lib', 'index.js'), 'new build')
    await mkdir(join(target, 'lib'), { recursive: true })
    await writeFile(join(target, 'lib', 'index.js'), 'old build')
    await writeFile(join(target, 'stale.txt'), 'gone')
    await replaceDir(src, target, backup)
    expect(await readFile(join(target, 'lib', 'index.js'), 'utf8')).toBe('new build')
    await expect(stat_or_undef(join(target, 'stale.txt'))).resolves.toBeUndefined()
    await expect(stat_or_undef(backup)).resolves.toBeUndefined()
  })

  it('restores the previous install when the move dies mid-write', async () => {
    const root = await tmp()
    const src = join(root, 'new')
    const target = join(root, 'nm', '@jacklika', 'pkg')
    const backup = join(root, 'pkg.backup')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'fresh.js'), 'new')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'index.js'), 'old build')
    // Simulate the observed defect: the cross-device `cp` writes part of
    // `target` then throws. Without the fix, rollback would hit a non-empty
    // target and fail too.
    const failingMove = async () => {
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'partial.js'), 'partial write')
      throw new Error('simulated cp failure')
    }
    await expect(replaceDir(src, target, backup, { move: failingMove })).rejects.toThrow('simulated cp failure')
    // The old install must be restored byte-for-byte and no partial write left.
    expect(await readFile(join(target, 'index.js'), 'utf8')).toBe('old build')
    await expect(stat_or_undef(join(target, 'partial.js'))).resolves.toBeUndefined()
  })

  it('reports the backup location and restore command when rollback fails', async () => {
    const root = await tmp()
    const src = join(root, 'new')
    const target = join(root, 'nm', '@jacklika', 'pkg')
    const backup = join(root, 'pkg.backup')
    await mkdir(src, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'index.js'), 'old build')
    // The injected move deletes the backup before failing, so rollback's
    // rename AND its cp fallback both fail — the error must say where the
    // backup would have been and how to recover.
    const failingMove = async () => {
      await rm(backup, { recursive: true, force: true })
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'partial.js'), 'x')
      throw new Error('simulated cp failure')
    }
    const error = await replaceDir(src, target, backup, { move: failingMove }).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(backup)
    expect((error as Error).message).toContain('restore it manually')
    expect((error as Error).message).toContain('mv')
  })

  it('reports the backup path when the rollback removal itself fails', async () => {
    const root = await tmp()
    const src = join(root, 'new')
    const target = join(root, 'nm', '@jacklika', 'pkg')
    const backup = join(root, 'pkg.backup')
    await mkdir(src, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'index.js'), 'old build')
    // Cross-platform injection: the rollback's own remove(target) dies — the
    // macOS chflags/Windows EBUSY case without needing platform APIs.
    const failingRemove = async () => { throw new Error('simulated rm failure (EBUSY)') }
    const error = await replaceDir(src, target, backup, {
      move: async () => { throw new Error('simulated move failure') },
      remove: failingRemove,
    }).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain(backup)
    expect(message).toContain('restore it manually')
    expect(message).toContain('mv')
    // The backup must still be intact on disk — it is the only copy of the
    // previous install.
    expect(await readFile(join(backup, 'index.js'), 'utf8')).toBe('old build')
  })

  it('rethrows the original error untouched when nothing was backed up', async () => {
    const root = await tmp()
    const src = join(root, 'new')
    const target = join(root, 'nm', '@jacklika', 'pkg')
    await mkdir(src, { recursive: true })
    const failingMove = async () => { throw new Error('move failed with no prior install') }
    const failingRemove = async () => { throw new Error('must not be called') }
    await expect(replaceDir(src, target, join(root, 'b'), { move: failingMove, remove: failingRemove }))
      .rejects.toThrow('move failed with no prior install')
    await expect(stat_or_undef(target)).resolves.toBeUndefined()
  })

  it('installs cleanly when nothing was installed before', async () => {
    const root = await tmp()
    const src = join(root, 'new')
    const target = join(root, 'nm', '@jacklika', 'pkg')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'index.js'), 'new')
    await replaceDir(src, target, join(root, 'pkg.backup'))
    expect(await readFile(join(target, 'index.js'), 'utf8')).toBe('new')
  })
})

describe('pruneStaging', () => {
  it('keeps referenced tarballs, copies fresh ones, prunes stale ones', async () => {
    const root = await tmp()
    const profile = join(root, 'profile')
    const staging = join(profile, '.connector-packages')
    const artifacts = join(root, 'artifacts')
    await mkdir(staging, { recursive: true })
    await mkdir(artifacts, { recursive: true })
    // Profile references one ghost tarball whose workspace package is gone,
    // plus one still-packed package.
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dependencies: {
        '@jacklika/dsh-ghost': 'file:.connector-packages/ghost-1.0.0.tgz',
        '@jacklika/dsh-real': 'file:.connector-packages/real-1.0.0.tgz',
      },
    }))
    await writeFile(join(artifacts, 'real-1.0.0.tgz'), 'fresh tarball')
    await writeFile(join(staging, 'ghost-1.0.0.tgz'), 'referenced, keep me')
    await writeFile(join(staging, 'real-1.0.0.tgz'), 'old copy')
    await writeFile(join(staging, 'stale-9.9.9.tgz'), 'unreferenced, prune me')
    const pruned = await pruneStaging(staging, artifacts, profile)
    expect(pruned).toEqual(['stale-9.9.9.tgz'])
    const files = (await readdir(staging)).sort()
    expect(files).toEqual(['ghost-1.0.0.tgz', 'real-1.0.0.tgz'])
    // The fresh copy wins over the stale one.
    expect(await readFile(join(staging, 'real-1.0.0.tgz'), 'utf8')).toBe('fresh tarball')
    // Second run is stable: nothing left to prune.
    expect(await pruneStaging(staging, artifacts, profile)).toEqual([])
  })

  it('keeps tarballs referenced with Windows-style backslash separators', async () => {
    const root = await tmp()
    const profile = join(root, 'profile')
    const staging = join(profile, '.connector-packages')
    const artifacts = join(root, 'artifacts')
    await mkdir(staging, { recursive: true })
    await mkdir(artifacts, { recursive: true })
    // A manifest authored on Windows may write the file: spec with a
    // backslash separator — the reference must still be recognised.
    await writeFile(join(profile, 'package.json'), JSON.stringify({
      dependencies: { '@jacklika/dsh-ghost': 'file:.connector-packages\\ghost-1.0.0.tgz' },
    }))
    await writeFile(join(artifacts, 'real-1.0.0.tgz'), 'fresh')
    await writeFile(join(staging, 'ghost-1.0.0.tgz'), 'referenced via backslash')
    const pruned = await pruneStaging(staging, artifacts, profile)
    expect(pruned).toEqual([])
    expect((await readdir(staging)).sort()).toEqual(['ghost-1.0.0.tgz', 'real-1.0.0.tgz'])
  })

  it('tolerates a brand-new profile with no package.json (nothing is referenced)', async () => {
    const root = await tmp()
    const profile = join(root, 'profile')
    const staging = join(profile, '.connector-packages')
    const artifacts = join(root, 'artifacts')
    await mkdir(staging, { recursive: true })
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, 'real-1.0.0.tgz'), 'x')
    await writeFile(join(staging, 'stale-1.0.0.tgz'), 'y')
    await pruneStaging(staging, artifacts, profile)
    expect((await readdir(staging)).sort()).toEqual(['real-1.0.0.tgz'])
  })

  it('refuses to prune when the manifest exists but cannot be parsed', async () => {
    const root = await tmp()
    const profile = join(root, 'profile')
    const staging = join(profile, '.connector-packages')
    const artifacts = join(root, 'artifacts')
    await mkdir(profile, { recursive: true })
    await mkdir(staging, { recursive: true })
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(profile, 'package.json'), '{ not json')
    await writeFile(join(artifacts, 'real-1.0.0.tgz'), 'x')
    await writeFile(join(staging, 'referenced.tgz'), 'keep')
    await expect(pruneStaging(staging, artifacts, profile)).rejects.toThrow('cannot read')
    // Throws before copying or deleting — staging is exactly as before.
    expect((await readdir(staging)).sort()).toEqual(['referenced.tgz'])
  })
})

describe('main() entry guard', () => {
  // Windows symlink creation may require Developer Mode or elevation.
  const itPosix = process.platform === 'win32' ? it.skip : it
  itPosix('runs main() when invoked through a symlink', async () => {
    const { symlink } = await import('node:fs/promises')
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const root = await tmp()
    const script = fileURLToPath(new URL('../scripts/install-into-profile.mjs', import.meta.url))
    const link = join(root, 'deploy-alias.mjs')
    await symlink(script, link)
    // With no profile argument, main() prints usage and exits 2 — proof the
    // guard fired. A symlink-blind guard would silently exit 0.
    const result = spawnSync('node', [link], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr ?? '').toContain('usage')
  })
})

async function stat_or_undef(path: string): Promise<unknown> {
  try {
    const { stat } = await import('node:fs/promises')
    return await stat(path)
  } catch {
    return undefined
  }
}
