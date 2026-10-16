import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../../scripts/audit-memory-acceptance.mjs', import.meta.url))
let root: string | undefined
let parent: string | undefined

function git(...args: string[]) {
  return execFileSync('git', ['-C', root!, ...args], { encoding: 'utf8' }).trim()
}

async function add(id: string) {
  const path = join(root!, id)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, id)
  git('add', '--', id)
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', id)
}

async function audit(baseline: string, manifest: string) {
  const path = join(parent!, 'manifest.json')
  await writeFile(path, manifest)
  return spawnSync(process.execPath, [script, '--vault', root!, '--baseline', baseline, '--manifest', path], { encoding: 'utf8' })
}

afterEach(async () => {
  if (parent !== undefined) await rm(parent, { recursive: true, force: true })
  root = undefined
  parent = undefined
})

describe('independent acceptance Git audit', () => {
  it('flags a committed out-of-run note even when Git is clean', async () => {
    parent = await mkdtemp(join(tmpdir(), 'dsh-scope-audit-'))
    root = join(parent, 'vault')
    await mkdir(root)
    git('init')
    await add('baseline.md')
    const baseline = git('rev-parse', 'HEAD')
    await add('shared/notes/run-123/ok.md')
    await add('shared/notes/unauthorized.md')
    const manifest = JSON.stringify({
      schemaVersion: 1, createPrefixes: ['shared/notes/run-123/'],
      updateIds: [], archiveMoves: [],
    })
    const result = await audit(baseline, manifest)
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as { unexpected: { id: string }[] }
    expect(report.unexpected.map(entry => entry.id)).toContain('shared/notes/unauthorized.md')
    expect(report.unexpected.map(entry => entry.id)).not.toContain('shared/notes/run-123/ok.md')
  })

  it('accepts only an explicitly paired archive move and rejects a dirty Vault', async () => {
    parent = await mkdtemp(join(tmpdir(), 'dsh-scope-audit-'))
    root = join(parent, 'vault')
    await mkdir(root)
    git('init')
    await add('shared/notes/run-123/target.md')
    const baseline = git('rev-parse', 'HEAD')
    const destination = 'archive/shared/notes/run-123/target.md'
    await mkdir(join(root, 'archive/shared/notes/run-123'), { recursive: true })
    git('mv', 'shared/notes/run-123/target.md', destination)
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'archive')
    const manifest = JSON.stringify({
      schemaVersion: 1, createPrefixes: ['shared/notes/run-123/'], updateIds: [],
      archiveMoves: [{ from: 'shared/notes/run-123/target.md', to: destination }],
    })
    const result = await audit(baseline, manifest)
    expect(result.status, result.stderr).toBe(0)
    expect((JSON.parse(result.stdout) as { pass: boolean }).pass).toBe(true)
    await writeFile(join(root, 'unexpected.md'), 'untracked')
    const dirty = await audit(baseline, manifest)
    expect(dirty.status).toBe(1)
    expect((JSON.parse(dirty.stdout) as { cleanWorkingTree: boolean }).cleanWorkingTree).toBe(false)
  })

  it('retains evidence of a committed violation even after that file is removed', async () => {
    parent = await mkdtemp(join(tmpdir(), 'dsh-scope-audit-'))
    root = join(parent, 'vault')
    await mkdir(root)
    git('init')
    await add('baseline.md')
    const baseline = git('rev-parse', 'HEAD')
    await add('shared/notes/unauthorized.md')
    git('rm', '--', 'shared/notes/unauthorized.md')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'hide violation')
    const result = await audit(baseline, JSON.stringify({
      schemaVersion: 1, createPrefixes: ['shared/notes/run-123/'], updateIds: [], archiveMoves: [],
    }))
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as { unexpected: { status: string; id: string }[] }
    expect(report.unexpected).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'A', id: 'shared/notes/unauthorized.md' }),
      expect.objectContaining({ status: 'D', id: 'shared/notes/unauthorized.md' }),
    ]))
  })
})
