import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DevinBridge from '@jacklika/dsh-devin-bridge'

let root: string | undefined
let context: Context | undefined
let savedCredentialsPath: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (savedCredentialsPath === undefined) delete process.env.DEVIN_CREDENTIALS_PATH
  else process.env.DEVIN_CREDENTIALS_PATH = savedCredentialsPath
  savedCredentialsPath = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the bridge beside the real LLM service through a real Loader include.
 *
 * Credentials are pinned to a path inside the scratch root, so no assertion can
 * observably depend on a `devin auth login` on the machine running the test.
 * @param config extra `config:` lines for the bridge row, already indented.
 * @param token the configured token; the empty string leaves the credentials file to be read.
 * @returns the booted context.
 */
async function boot(config: string[] = [], token = 'devin-session-token$test'): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-devin-bridge-'))
  savedCredentialsPath = process.env.DEVIN_CREDENTIALS_PATH
  process.env.DEVIN_CREDENTIALS_PATH = join(root, 'missing-credentials.toml')

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@jacklika/dsh-devin-bridge'",
    '  config:',
    `    token: '${token}'`,
    ...config,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@jacklika/dsh-devin-bridge', DevinBridge],
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
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-devin-bridge')
  if (entry?.fiber === undefined) throw new Error('active devin-bridge entry missing')
  await entry.fiber.dispose()
}

describe('devin-bridge real Loader composition through cordis.yml', () => {
  it('mounts the devin route on the real LLM service under its display name', async () => {
    const ctx = await boot()
    expect(ctx.llm.listProviders()).toEqual([{ id: 'devin', name: 'Devin' }])
  })

  it('advertises the bundled catalog through the service', async () => {
    const ctx = await boot()
    const models = await ctx.llm.listModels('devin')
    expect(models.length).toBe(45)
    expect(models.every(model => model.provider === 'devin')).toBe(true)
    expect(models.some(model => model.id === 'glm-5-2')).toBe(true)
    // Vision is declared only for the entries that carry it, never for the route
    // as a whole: the composer would otherwise offer images to text-only models.
    expect(models.find(model => model.id === 'glm-5-2')?.inputModalities).toEqual(['text'])
    expect(models.find(model => model.id === 'claude-opus-5-5-medium')?.inputModalities).toEqual(['text', 'image'])
  })

  it('resolves a catalog model, effort slider included, without provider I/O', async () => {
    const ctx = await boot()
    const info = await ctx.llm.resolveModelInfo('devin', 'glm-5-2')
    expect(info.id).toBe('glm-5-2')
    expect(info.context?.contextWindow).toBe(200_000)
    expect(info.defaultMaxTokens).toBeGreaterThan(0)
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['high', 'medium', 'max', 'none'])
    expect(info.reasoning?.defaultEffort).toBe('high')
  })

  it('falls back to the configured defaults for a model outside the catalog', async () => {
    const ctx = await boot(['    defaultContextWindow: 4242', '    defaultMaxTokens: 99'])
    const info = await ctx.llm.resolveModelInfo('devin', 'no-such-model')
    expect(info.id).toBe('no-such-model')
    expect(info.context?.contextWindow).toBe(4242)
    expect(info.defaultMaxTokens).toBe(99)
  })

  it('declares the route in the configurable-provider directory', async () => {
    const ctx = await boot()
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      { provider: 'devin', displayName: 'Devin', settingsNs: 'devin-bridge', settingsPath: [] },
    ])
  })

  it('names the three credential sources when a turn finds no token', async () => {
    // The empty token makes the credentials file authoritative, and the boot
    // pointed that path at a file that does not exist.
    const ctx = await boot([], '')
    const failure = await ctx.llm.listModels('devin').then(() => null, (error: Error) => error)
    if (failure === null) throw new Error('a tokenless bridge resolved a connection')
    const message = `${failure.message} ${String(failure.cause ?? '')}`
    expect(message).toMatch(/no Devin session token found/)
    expect(message).toContain('devin auth login')
    expect(message).toContain('DEVIN_CREDENTIALS_PATH')
  })

  it('withdraws the adapter, the directory entry and discovery on unload', async () => {
    const ctx = await boot()
    expect(ctx.llm.listProviders()).toHaveLength(1)

    await unload(ctx)

    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })
})
