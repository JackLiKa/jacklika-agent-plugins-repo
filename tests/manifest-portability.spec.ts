import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageRoot = join(root, 'packages')

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

  it('contain no machine-specific links or wildcard Harness peers', async () => {
    for (const { path, value } of await packageManifests()) {
      const serialized = JSON.stringify(value)
      expect(serialized, path).not.toMatch(/link:\/|link:[A-Za-z]:\\/)
      const peers = value.peerDependencies as Record<string, string> | undefined
      for (const [name, range] of Object.entries(peers ?? {})) {
        if (name.startsWith('@deepseek-ai/dsh-')) expect(range, `${path}: ${name}`).toBe('0.1.7-rc.1')
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
})
