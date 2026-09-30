/**
 * Whole-chain composition: the shipped bundle patch mounted for real.
 *
 * Every member package already has its own `loader-composition.spec.ts`, but
 * each of those mounts only two rows — the plugin under test plus the memory
 * filesystem it decorates. This spec instead mounts the bundle's real
 * `cordis.patch.yml`: all six rows, in patch order, with the shipped config and
 * no overrides, driving the vault the way a user gets it by default
 * (`<session cwd>/.plugins/memory/`).
 *
 * That is the only place the cross-layer contracts of the assembled ladder can
 * show themselves:
 *
 *   - queue keys its cross-process lock by the id scope already rewrote, so two
 *     agents writing the same private id never contend for one lock,
 *   - queue releases its lock when the filesystem write finishes,
 *   - git commits the `shared/` write that survived scope and never the
 *     `agents/<key>/` namespace scope created,
 *   - every row resolves the same default vault from one session workspace.
 *
 * The lane test fails if scope stops namespacing private writes (or if queue
 * ever started keying on the raw id), which is the regression it guards.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MemoryGit from '@jacklika/dsh-memory-git'
import * as MemoryQueue from '@jacklika/dsh-memory-queue'
import * as MemoryScope from '@jacklika/dsh-memory-scope'
import * as ToolMemoryFilesystem from '@jacklika/dsh-tool-memory-filesystem'
import * as ToolMemoryGraph from '@jacklika/dsh-tool-memory-graph'
import * as ToolMemoryVector from '@jacklika/dsh-tool-memory-vector'

const execFileAsync = promisify(execFile)
const bundleRoot = fileURLToPath(new URL('..', import.meta.url))

interface ShippedRow {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
}

/** The insert rows the shipped bundle patch declares, in patch order. */
function shippedRows(): ShippedRow[] {
  const text = readFileSync(join(bundleRoot, 'cordis.patch.yml'), 'utf8')
  const patches = yaml.load(text, { schema: entryListSchema }) as { insert?: ShippedRow[] }[]
  return patches.flatMap(patch => patch.insert ?? [])
}

let root: string | undefined
let context: Context | undefined
const temps: string[] = []

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the shipped patch as a real Loader tree.
 * @param queueTiming - shorten the queue's lock timings so a planted foreign
 *   lock fails fast. The row's identity, order, and remaining config stay
 *   exactly as shipped; only the timing knobs change.
 * @returns the booted context.
 */
async function boot(queueTiming = false): Promise<Context> {
  const rows = shippedRows().map(row => queueTiming && row.id === 'memory-queue'
    ? {
      ...row,
      config: {
        ...row.config,
        lockHeartbeatMs: 100,
        lockStaleMs: 5000,
        lockTimeoutMs: 800,
        lockRetryMs: 50,
      },
    }
    : row)

  root = await mkdtemp(join(tmpdir(), 'dsh-chain-loader-'))
  const configPath = join(root, 'cordis.yml')
  // The bundle must follow dsh-base, which supplies the tool runtime and the
  // system-prompt row; replicate those two ancestors the way a profile would.
  const entryList = [
    { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-tools' },
    ...rows,
  ]
  await writeFile(configPath, yaml.dump(entryList))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@jacklika/dsh-memory-scope', MemoryScope],
    ['@jacklika/dsh-memory-queue', MemoryQueue],
    ['@jacklika/dsh-memory-git', MemoryGit],
    ['@jacklika/dsh-tool-memory-filesystem', ToolMemoryFilesystem],
    ['@jacklika/dsh-tool-memory-graph', ToolMemoryGraph],
    ['@jacklika/dsh-tool-memory-vector', ToolMemoryVector],
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

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The calling agent a tool dispatch carries; scope derives its key from `id`. */
function agent(id: string, cwd: string) {
  return { id, session: { header: { cwd } } } as never
}

/** The vault every row resolves when the session workspace is `cwd`. */
function vaultOf(cwd: string): string {
  return join(cwd, '.plugins', 'memory')
}

function write(
  ctx: Context,
  callId: string,
  id: string,
  workspace: string,
  content = `content of ${id}`,
  agentId = 'agent-1',
) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'wiki_write',
    arguments: { id, content },
    agent: agent(agentId, workspace),
  })
}

async function gitLog(vault: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', vault, 'log', '--format=%s', '--name-only'])
  return stdout
}

/** Lane lock files still present under the vault, i.e. locks never released. */
async function heldLocks(vault: string): Promise<string[]> {
  const lanes = join(vault, '.memory-queue.lock.lanes')
  if (!existsSync(lanes)) return []
  return (await readdir(lanes)).filter(name => name.endsWith('.lock'))
}

function laneOf(key: string): string {
  return createHash('sha1').update(key).digest('hex')
}

describe('dsh-memory whole-chain composition through the shipped cordis.patch.yml', () => {
  it('mounts every shipped row and serves the ladder from the session workspace', async () => {
    const workspace = await temp('dsh-chain-ws-')
    const ctx = await boot()

    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('wiki_read')
    expect(names).toContain('wiki_search')
    expect(names).toContain('wiki_write')
    expect(names).toContain('wiki_graph')
    // The shipped patch disables the vector row, so its tool never registers.
    expect(names).not.toContain('wiki_semantic_search')

    const result = await write(ctx, 'shared-write', 'shared/summary.md', workspace)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected chain wiki_write success')
    // scope leaves `shared/` untouched, so the reported id is the requested one.
    expect((JSON.parse(resultText(result)) as { id: string }).id).toBe('shared/summary.md')

    // All three write-ladder rows agreed on `<workspace>/.plugins/memory` by default.
    const vault = vaultOf(workspace)
    expect(await readFile(join(vault, 'shared', 'summary.md'), 'utf8'))
      .toContain('content of shared/summary.md')
    expect(await gitLog(vault)).toContain('wiki_write: shared/summary.md')
    expect(await heldLocks(vault)).toEqual([])
  })

  it('scopes private ids per agent while git commits only the shared prefix', async () => {
    const workspace = await temp('dsh-chain-ws-')
    const ctx = await boot()
    const vault = vaultOf(workspace)

    const privateWrite = await write(ctx, 'private-write', 'notes/private.md', workspace)
    expect(privateWrite.isError).toBe(false)
    if (privateWrite.isError) throw new Error('expected scoped wiki_write success')
    expect((JSON.parse(resultText(privateWrite)) as { id: string }).id)
      .toBe('agents/agent-1/notes/private.md')
    expect(await readFile(join(vault, 'agents', 'agent-1', 'notes', 'private.md'), 'utf8'))
      .toContain('content of notes/private.md')

    const sharedWrite = await write(ctx, 'shared-write', 'shared/team.md', workspace)
    expect(sharedWrite.isError).toBe(false)
    if (sharedWrite.isError) throw new Error('expected shared wiki_write success')
    expect((JSON.parse(resultText(sharedWrite)) as { id: string }).id).toBe('shared/team.md')

    const log = await gitLog(vault)
    expect(log).toContain('wiki_write: shared/team.md')
    expect(log).not.toContain('agents/agent-1/notes/private.md')
  })

  it('keys the cross-process lock lane by the scoped id, so two agents never contend', async () => {
    const workspace = await temp('dsh-chain-ws-')
    const ctx = await boot(true)
    const vault = vaultOf(workspace)

    const privateId = 'notes/order.md'
    const scopedA = 'agents/agent-1/notes/order.md'

    // A fresh foreign lock in agent-1's lane. queue keys the lock by the id
    // scope already rewrote, so agent-1 blocks here while agent-2 sails past.
    const lanesDir = join(vault, '.memory-queue.lock.lanes')
    const planted = join(lanesDir, `${laneOf(scopedA)}.lock`)
    await mkdir(planted, { recursive: true })

    const blockedA = await write(ctx, 'blocked-a', privateId, workspace, `content of ${privateId}`, 'agent-1')
    expect(blockedA.isError).toBe(true)
    if (!blockedA.isError) throw new Error('expected agent-1 to block on its own scoped lane')
    expect(resultText(blockedA)).toContain(`${laneOf(scopedA)}.lock`)
    expect(resultText(blockedA)).not.toContain(`${laneOf(privateId)}.lock`)

    // A second agent writing the same raw id lives on a different lane.
    const passedB = await write(ctx, 'passed-b', privateId, workspace, `content of ${privateId}`, 'agent-2')
    expect(passedB.isError).toBe(false)

    // Control: agent-1 proceeds once the foreign lock is gone.
    await rm(planted, { recursive: true, force: true })
    const releasedA = await write(ctx, 'released-a', privateId, workspace, `content of ${privateId}`, 'agent-1')
    expect(releasedA.isError).toBe(false)
    expect(await heldLocks(vault)).toEqual([])
  })

  it('reads a shared note back with resolved links and exposes the graph', async () => {
    const workspace = await temp('dsh-chain-ws-')
    const ctx = await boot()

    const first = await write(ctx, 'write-a', 'shared/a.md', workspace, '# A\n\nLinks to [[shared/b]].\n')
    const second = await write(ctx, 'write-b', 'shared/b.md', workspace, '# B\n\nLeaf note.\n')
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)

    const read = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('read-a'),
      name: 'wiki_read',
      arguments: { id: 'shared/a.md' },
      agent: agent('agent-1', workspace),
    })
    expect(read.isError).toBe(false)
    if (read.isError) throw new Error('expected chain wiki_read success')
    const note = JSON.parse(resultText(read)) as { id: string; linkedNotes: unknown[] }
    expect(note.id).toBe('shared/a.md')
    expect(note.linkedNotes).toHaveLength(1)

    const graph = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('graph-all'),
      name: 'wiki_graph',
      arguments: {},
      agent: agent('agent-1', workspace),
    })
    expect(graph.isError).toBe(false)
    if (graph.isError) throw new Error('expected chain wiki_graph success')
    const parsed = JSON.parse(resultText(graph)) as {
      nodes: { id: string }[]
      edges: { from: string; to: string }[]
    }
    expect(parsed.nodes.map(node => node.id).sort()).toEqual(['shared/a.md', 'shared/b.md'])
    expect(parsed.edges).toContainEqual({ from: 'shared/a.md', to: 'shared/b.md' })
  })
})
