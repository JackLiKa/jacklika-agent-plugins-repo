/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list whose insert rows mount the
 * memory write ladder in waterfall order.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-memory bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patchPath = resolve(root, manifest.dsh!.bundle!.patch!)
    expect(existsSync(patchPath)).toBe(true)
    const parsed = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)

    const rows = (parsed as {
      insert?: { id?: string; name?: string; disabled?: boolean }[]
    }[]).flatMap(patch => patch.insert ?? [])
    const ids = rows.map(row => row.id)

    // Waterfall order: scope wraps queue wraps git wraps the vault tool.
    expect(ids.indexOf('memory-scope')).toBeLessThan(ids.indexOf('memory-queue'))
    expect(ids.indexOf('memory-queue')).toBeLessThan(ids.indexOf('memory-git'))
    expect(ids.indexOf('memory-git')).toBeLessThan(ids.indexOf('tool-memory-filesystem'))
    expect(rows.find(row => row.id === 'tool-memory-vector')?.disabled).toBe(true)

    // Every named plugin resolves through the bundle's own dependencies.
    for (const row of rows) {
      expect(row.name).toBeDefined()
      expect(manifest.dependencies).toHaveProperty(row.name!)
    }
  })
})
