import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MemoryCurator from '@jacklika/dsh-memory-curator'
import * as ToolMemoryFilesystem from '@jacklika/dsh-tool-memory-filesystem'

let root: string | undefined
let context: Context | undefined
const vaults: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  await Promise.all(vaults.splice(0).map(vault => rm(vault, { recursive: true, force: true })))
})

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** A temporary vault this spec cleans up after itself. */
async function vaultDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
  vaults.push(dir)
  return dir
}

async function boot(vaultRoot: string, approval?: { request: () => Promise<string> }, filesystemConfig: string[] = []): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-curator-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@jacklika/dsh-memory-curator'",
    "- name: '@jacklika/dsh-tool-memory-filesystem'",
    '  config:',
    `    vaultRoot: ${vaultRoot}`,
    ...filesystemConfig,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  // Stand in for the Harness approval seam: an overwrite of an existing note is
  // a detected conflict, so reaching that write path needs an approver.
  if (approval !== undefined) ctx.provide('approval', approval)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@jacklika/dsh-memory-curator', MemoryCurator],
    ['@jacklika/dsh-tool-memory-filesystem', ToolMemoryFilesystem],
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

function agent(id: string, cwd: string) {
  return { id, session: { header: { cwd } } } as never
}

async function capture(
  ctx: Context,
  callId: string,
  title: string,
  summary: string,
  agentId: string,
  cwd: string,
  extra: Record<string, unknown> = {},
) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'memory_capture',
    arguments: { title, summary, ...extra },
    agent: agent(agentId, cwd),
  })
}

async function recall(ctx: Context, callId: string, query: string, agentId: string, cwd: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'memory_recall',
    arguments: { query },
    agent: agent(agentId, cwd),
  })
}

async function readNote(ctx: Context, callId: string, id: string, agentId: string, cwd: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'wiki_read',
    arguments: { id },
    agent: agent(agentId, cwd),
  })
}

describe('memory-curator real Loader composition through cordis.yml', () => {
  it('captures a new shared note and recalls it later', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)

    const r1 = await capture(ctx, 'c1', 'Project conventions', 'Use pnpm 11.7.0 and Node ^22.19.0.', 'agent-1', vault, { tags: ['conventions', 'node', 'pnpm'] })
    expect(r1.isError).toBe(false)
    const out1 = JSON.parse(resultText(r1)) as { written: boolean; id: string; mode: string }
    expect(out1.written).toBe(true)
    expect(out1.id).toBe('shared/notes/project-conventions.md')
    expect(out1.mode).toBe('overwrite')

    const r1r = await readNote(ctx, 'r1-read', 'shared/notes/project-conventions.md', 'agent-1', vault)
    expect(r1r.isError).toBe(false)
    const read1 = JSON.parse(resultText(r1r)) as { frontmatter: { title?: string; tags?: string[]; created?: string }; body: string }
    expect(read1.frontmatter.title).toBe('Project conventions')
    expect(read1.frontmatter.tags).toEqual(['conventions', 'node', 'pnpm'])
    expect(read1.frontmatter.created).toMatch(/\+08:00$/)
    expect(read1.body).toContain('Use pnpm 11.7.0 and Node ^22.19.0.')

    const notePath = join(vault, 'shared', 'notes', 'project-conventions.md')
    const text = await readFile(notePath, 'utf8')
    expect(text.startsWith('---')).toBe(true)
    expect(text).toContain('title: Project conventions')
    expect(text).toContain('# Project conventions')
    expect(text).toContain('Use pnpm 11.7.0 and Node ^22.19.0.')

    const r2 = await recall(ctx, 'r1-recall', 'pnpm Node project conventions', 'agent-1', vault)
    expect(r2.isError).toBe(false)
    const out2 = JSON.parse(resultText(r2)) as { query: string; hits: { id: string; title: string; backlinks: string[] }[]; total: number }
    expect(out2.total).toBeGreaterThan(0)
    expect(out2.hits.some(hit => hit.id === 'shared/notes/project-conventions.md')).toBe(true)
  })

  it('passes the vault-wide match count through memory_recall even when the search layer caps hits', async () => {
    const vault = await vaultDir()
    const notes = join(vault, 'shared', 'notes')
    await mkdir(notes, { recursive: true })
    for (const [index, name] of ['alpha', 'beta', 'gamma'].entries()) {
      await writeFile(join(notes, `${name}.md`), `# ${name}\n\nCarries ${'zephyr-token '.repeat(index + 1).trim()}.\n`)
    }
    const ctx = await boot(vault, undefined, ['    maxSearchResults: 2'])

    const result = await recall(ctx, 'recall-capped', 'zephyr-token', 'agent-1', vault)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected memory_recall success')
    const out = JSON.parse(resultText(result)) as { hits: { id: string }[]; total: number }
    // Three notes match but the search layer returns two. Restating the capped
    // length as `total` would tell the model the vault holds only what it saw,
    // which is the under-reporting this passthrough exists to prevent.
    expect(out.hits).toHaveLength(2)
    expect(out.total).toBe(3)
  })

  it('appends to an existing note when the same title is captured again with conflictPolicy=skip', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)

    const r1 = await capture(ctx, 'c1', 'Bug fix', 'Fixed off-by-one in loop.', 'agent-1', vault)
    expect(r1.isError).toBe(false)
    const out1 = JSON.parse(resultText(r1)) as { written: boolean; id: string }
    expect(out1.id).toBe('shared/notes/bug-fix.md')

    const r2 = await capture(ctx, 'c2', 'Bug fix', 'Added regression test.', 'agent-1', vault, { conflictPolicy: 'skip' })
    expect(r2.isError).toBe(false)
    const out2 = JSON.parse(resultText(r2)) as { written: boolean; conflict: boolean; id: string }
    expect(out2.written).toBe(false)
    expect(out2.conflict).toBe(true)
    expect(out2.id).toBe('shared/notes/bug-fix.md')

    const text = await readFile(join(vault, 'shared', 'notes', 'bug-fix.md'), 'utf8')
    expect(text).toContain('Fixed off-by-one in loop.')
    expect(text).not.toContain('Added regression test.')
  })

  it('derives distinct readable ids for non-Latin and mixed-script titles', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)

    const titles = ['数据库迁移方案', '用户偏好', 'データベース設計', 'Database Migration 方案']
    const ids: string[] = []
    for (const [index, title] of titles.entries()) {
      const result = await capture(ctx, `cjk-${index}`, title, `Knowledge for ${title}.`, 'agent-1', vault)
      expect(result.isError).toBe(false)
      const out = JSON.parse(resultText(result)) as { written: boolean; id: string; conflict: boolean }
      expect(out.written).toBe(true)
      expect(out.conflict).toBe(false)
      ids.push(out.id)
    }

    expect(ids).toEqual([
      'shared/notes/数据库迁移方案.md',
      'shared/notes/用户偏好.md',
      'shared/notes/データベース設計.md',
      'shared/notes/database-migration-方案.md',
    ])

    const notes = await readdir(join(vault, 'shared', 'notes'))
    expect(notes).not.toContain('.md')
    expect(notes.sort()).toEqual(ids.map(id => id.slice('shared/notes/'.length)).sort())
    for (const id of ids) {
      expect(await readFile(join(vault, id), 'utf8')).toContain('Knowledge for')
    }
  })

  it('gives symbol-only titles a stable hashed id instead of one shared bare ".md"', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)

    const captured: { written: boolean; id: string; conflict: boolean }[] = []
    for (const [index, title] of ['🚀🎉', '???'].entries()) {
      const result = await capture(ctx, `sym-${index}`, title, `Note ${index}.`, 'agent-1', vault)
      expect(result.isError).toBe(false)
      captured.push(JSON.parse(resultText(result)) as { written: boolean; id: string; conflict: boolean })
    }
    for (const out of captured) {
      expect(out.written).toBe(true)
      expect(out.conflict).toBe(false)
      expect(out.id).toMatch(/^shared\/notes\/note-[0-9a-f]{12}\.md$/)
    }
    expect(captured[0].id).not.toBe(captured[1].id)

    // The hash is content-stable, so recapturing the same title targets the same note.
    const again = await capture(ctx, 'sym-2', '🚀🎉', 'Note 0 again.', 'agent-1', vault, { conflictPolicy: 'skip' })
    expect((JSON.parse(resultText(again)) as { id: string }).id).toBe(captured[0].id)
  })

  it('folds NFC and NFD spellings of one title onto one note', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)
    const nfc = 'Caf\u00E9 layout'
    const nfd = 'Cafe\u0301 layout'
    expect(nfc).not.toBe(nfd)

    const first = await capture(ctx, 'nfc', nfc, 'The grid uses 12 columns.', 'agent-1', vault)
    const second = await capture(ctx, 'nfd', nfd, 'The grid uses 12 columns.', 'agent-1', vault, { conflictPolicy: 'skip' })
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)

    const firstId = (JSON.parse(resultText(first)) as { id: string }).id
    expect(firstId).toBe('shared/notes/caf\u00E9-layout.md')
    expect((JSON.parse(resultText(second)) as { id: string }).id).toBe(firstId)
    expect((await readdir(join(vault, 'shared', 'notes'))).map(name => name.normalize('NFC')))
      .toEqual(['caf\u00E9-layout.md'])
  })

  it('keeps unknown frontmatter fields and the original created when overwriting a note', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    await mkdir(join(vault, 'shared', 'notes'), { recursive: true })
    await writeFile(join(vault, 'shared', 'notes', 'deploy-runbook.md'), [
      '---',
      'title: Deploy runbook',
      'tags:',
      '  - stale',
      'created: 2020-01-02T03:04:05+08:00',
      'owner: agent-7',
      'review: quarterly',
      '---',
      '',
      '# Deploy runbook',
      '',
      'Old procedure.',
      '',
    ].join('\n'))
    // Overwriting a note the search finds is a conflict, so the write path is
    // only reachable through an approved request.
    const ctx = await boot(vault, { request: async () => 'allowed-once' })

    const result = await capture(ctx, 'ow1', 'Deploy runbook', 'Restart the queue before the web tier.', 'agent-1', vault, {
      mode: 'overwrite',
      tags: ['deploy'],
    })
    expect(result.isError).toBe(false)
    const out = JSON.parse(resultText(result)) as { written: boolean; id: string; mode: string; conflict: boolean }
    expect(out).toMatchObject({ written: true, id: 'shared/notes/deploy-runbook.md', mode: 'overwrite', conflict: true })

    const read = await readNote(ctx, 'ow1-read', out.id, 'agent-1', vault)
    expect(read.isError).toBe(false)
    const note = JSON.parse(resultText(read)) as { frontmatter: Record<string, unknown>; body: string }
    expect(note.frontmatter.owner).toBe('agent-7')
    expect(note.frontmatter.review).toBe('quarterly')
    expect(note.frontmatter.created).toBe('2020-01-02T03:04:05+08:00')
    // This call owns title and tags.
    expect(note.frontmatter.title).toBe('Deploy runbook')
    expect(note.frontmatter.tags).toEqual(['deploy'])
    expect(String(note.frontmatter.updated)).toMatch(/\+08:00$/)
    expect(note.body).toContain('Restart the queue before the web tier.')
    expect(note.body).not.toContain('Old procedure.')
  })

  it('records no updated field on a first capture', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)

    const result = await capture(ctx, 'fresh', 'Fresh note', 'Nothing existed before.', 'agent-1', vault)
    expect(result.isError).toBe(false)
    const out = JSON.parse(resultText(result)) as { id: string; mode: string }
    expect(out.mode).toBe('overwrite')

    const read = await readNote(ctx, 'fresh-read', out.id, 'agent-1', vault)
    const { frontmatter } = JSON.parse(resultText(read)) as { frontmatter: Record<string, unknown> }
    expect(frontmatter).not.toHaveProperty('updated')
    expect(String(frontmatter.created)).toMatch(/\+08:00$/)
  })

  it('withdraws its tools when the Loader fiber unloads', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    const ctx = await boot(vault)
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@jacklika/dsh-memory-curator')
    if (entry?.fiber === undefined) throw new Error('active curator entry missing')
    await entry.fiber.dispose()

    const result = await capture(ctx, 'after-unload', 'Title', 'Summary', 'agent-1', vault)
    expect(result.isError).toBe(true)
  })
})
