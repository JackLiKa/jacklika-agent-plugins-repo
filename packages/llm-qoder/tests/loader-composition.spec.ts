import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmQoder from '@jacklika/dsh-llm-qoder'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the adapter beside the real LLM service through a real Loader include.
 *
 * Every assertion here stays on the registration seam: the adapter's catalog and
 * model lookups all go through the local `qodercli` login, which a hermetic test
 * cannot assume, so nothing below triggers them.
 * @param config extra `config:` lines for the plugin row, already indented.
 * @returns the booted context.
 */
async function boot(config: string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-qoder-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@jacklika/dsh-llm-qoder'",
    ...config.length === 0 ? [] : ['  config:', ...config],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@jacklika/dsh-llm-qoder', LlmQoder],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Dispose the Loader row the plugin was mounted under, as a profile reload would. */
async function unload(ctx: Context): Promise<void> {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-llm-qoder')
  if (entry?.fiber === undefined) throw new Error('active llm-qoder entry missing')
  await entry.fiber.dispose()
}

describe('llm-qoder real Loader composition through cordis.yml', () => {
  it('mounts both Qoder routes on the real LLM service under their display names', async () => {
    const ctx = await boot()
    expect(ctx.llm.listProviders()).toEqual([
      { id: 'qoder', name: 'Qoder CLI' },
      { id: 'qoder-byok', name: 'Qoder 自定义' },
    ])
  })

  it('declares both routes in the configurable-provider directory under one namespace', async () => {
    const ctx = await boot()
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      { provider: 'qoder', displayName: 'Qoder CLI', settingsNs: 'llm-qoder', settingsPath: [] },
      { provider: 'qoder-byok', displayName: 'Qoder 自定义', settingsNs: 'llm-qoder', settingsPath: [] },
    ])
  })

  it('accepts a profile override of the pool and the catalog TTL', async () => {
    const ctx = await boot(['    maxSessions: 2', '    modelCacheTtlSeconds: 600'])
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['qoder', 'qoder-byok'])
  })

  it('withdraws both routes, and the directory entries with them, on unload', async () => {
    const ctx = await boot()
    expect(ctx.llm.listProviders()).toHaveLength(2)

    await unload(ctx)

    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })
})
