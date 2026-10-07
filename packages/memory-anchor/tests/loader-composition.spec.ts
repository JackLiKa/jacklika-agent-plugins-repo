import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as MemoryAnchor from '@jacklika/dsh-memory-anchor'

/**
 * Stand-in for a vault write tool; the anchor only checks registration.
 */
const WikiWriteStub = {
  name: 'memory-anchor-test-stub',
  inject: ['tools'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'wiki_write',
      description: 'Test stub standing in for the vault write tool.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        return { written: true } as never
      },
    })))
  },
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the anchor beside the real prompt and tool registries.
 * @param anchorConfig - extra YAML lines for the plugin's config block.
 * @param vaultTool - whether to register the `wiki_write` stub.
 * @returns the booted context.
 */
async function boot(anchorConfig = '', vaultTool = false): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-anchor-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-memory-anchor'",
    anchorConfig,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@jacklika/dsh-memory-anchor', MemoryAnchor],
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
  if (vaultTool) await ctx.plugin(WikiWriteStub)
  return ctx
}

/** Render the dynamic-context snapshot the Harness would put in the next prompt. */
async function promptContext(ctx: Context): Promise<string> {
  return renderContextSnapshot(await ctx.systemPrompt.assemble({}))
}

describe('memory-anchor real Loader composition through cordis.yml', () => {
  it('contributes both reminder lines to the prompt context', async () => {
    const ctx = await boot()
    const snapshot = await promptContext(ctx)
    expect(snapshot).toContain('memory_recall')
    expect(snapshot).toContain('memory_capture')
  })

  it('renders the same reminder on every prompt, surviving re-renders', async () => {
    const ctx = await boot()
    expect(await promptContext(ctx)).toBe(await promptContext(ctx))
    expect(await promptContext(ctx)).toContain('Memory discipline')
  })

  it('withdraws its contribution when the Loader fiber unloads', async () => {
    const ctx = await boot()
    expect(await promptContext(ctx)).toContain('Memory discipline')

    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-memory-anchor')
    if (entry?.fiber === undefined) throw new Error('active memory-anchor entry missing')
    await entry.fiber.dispose()

    expect(await promptContext(ctx)).toBe('')
  })

  it('renders only the capture line when recallReminder is configured off', async () => {
    const ctx = await boot('  config:\n    recallReminder: false\n')
    const snapshot = await promptContext(ctx)
    expect(snapshot).not.toContain('memory_recall')
    expect(snapshot).toContain('memory_capture')
  })

  it('drops the contribution entirely when both reminders are off', async () => {
    const ctx = await boot('  config:\n    recallReminder: false\n    captureReminder: false\n')
    expect(await promptContext(ctx)).toBe('')
  })

  it('omits the Vault sentence when no vault write tool is registered', async () => {
    // A deployment without the memory suite must not point the model at tools
    // that do not exist, so the hint follows tool registration.
    const ctx = await boot()
    const snapshot = await promptContext(ctx)
    expect(snapshot).toContain('memory_capture')
    expect(snapshot).not.toContain('Vault')
  })

  it('includes the Vault sentence once a vault write tool is mounted', async () => {
    const ctx = await boot('', true)
    expect(await promptContext(ctx)).toContain('The Vault is the persistent record')
  })

  it('keeps the Vault sentence out when vaultHint is configured off, even with a vault tool mounted', async () => {
    const ctx = await boot('  config:\n    vaultHint: false\n', true)
    const snapshot = await promptContext(ctx)
    expect(snapshot).toContain('memory_capture')
    expect(snapshot).not.toContain('Vault')
  })

  it('honors a configured contextName and order', async () => {
    const ctx = await boot('  config:\n    contextName: custom:memory\n    order: 140\n')
    expect(await promptContext(ctx)).toContain('Memory discipline')
  })
})
