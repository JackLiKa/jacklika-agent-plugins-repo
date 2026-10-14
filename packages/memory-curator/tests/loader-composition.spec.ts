import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

async function boot(vaultRoot: string, approval?: { request: (details: { reason: string; displayReason: { en: string } }) => Promise<string> }, filesystemConfig: string[] = []): Promise<Context> {
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
    const out1 = JSON.parse(resultText(r1)) as { written: boolean; id: string; mode: string; version: string; created?: string; updated?: string; committed?: boolean }
    expect(out1.written).toBe(true)
    expect(out1.id).toBe('shared/notes/project-conventions.md')
    expect(out1.mode).toBe('overwrite')
    expect(out1.version.length).toBe(40)
    expect(out1.created).toMatch(/\+08:00$/)
    expect(out1).not.toHaveProperty('updated')
    expect(out1).not.toHaveProperty('committed')

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
    const out = JSON.parse(resultText(result)) as { hits: { id: string }[]; total: number; truncated: boolean }
    // Three notes match but the search layer returns two. Restating the capped
    // length as `total` would tell the model the vault holds only what it saw,
    // which is the under-reporting this passthrough exists to prevent.
    expect(out.hits).toHaveLength(2)
    expect(out.total).toBe(3)
    // The search layer cut the list, so recall must pass that flag through.
    expect(out.truncated).toBe(true)
  })

  it('flags truncated when its own 20-hit cap drops matches the search layer returned', async () => {
    const vault = await vaultDir()
    const notes = join(vault, 'shared', 'notes')
    await mkdir(notes, { recursive: true })
    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(notes, `note-${String(index).padStart(2, '0')}.md`), `# Note ${index}\n\nzephyr-token appears here.\n`)
    }
    // A search cap above 20 makes the search layer return every match, so any
    // truncation can only come from memory_recall's own slice.
    const ctx = await boot(vault, undefined, ['    maxSearchResults: 30'])

    const result = await recall(ctx, 'recall-own-cap', 'zephyr-token', 'agent-1', vault)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected memory_recall success')
    const out = JSON.parse(resultText(result)) as { hits: unknown[]; total: number; truncated: boolean }
    expect(out.hits).toHaveLength(20)
    expect(out.total).toBe(25)
    expect(out.truncated).toBe(true)
  })

  it('hides auto-capture notes from recall without swallowing notes that merely share the name prefix', async () => {
    const vault = await vaultDir()
    const notes = join(vault, 'shared', 'notes')
    await mkdir(join(notes, 'auto-capture'), { recursive: true })
    await writeFile(join(notes, 'auto-capture', 'session-1.md'), 'Mechanical zephyrprobe turn summary.\n')
    // Real vault shapes: the legacy flat form is `<prefix>-<sanitized session id>`,
    // with and without the `session-` id prefix.
    await writeFile(join(notes, 'auto-capture-session-6845668f-076f-4053-90ce-9b806c3432b4.md'), 'Legacy zephyrprobe flat summary.\n')
    await writeFile(join(notes, 'auto-capture-b433b13a-f474-4f5d-814e-16927c26aa04.md'), 'Legacy zephyrprobe bare-id summary.\n')
    // Ships under a name that starts with the auto-capture namespace without
    // being a capture; a bare prefix or substring filter would hide it.
    await writeFile(join(notes, 'auto-capture-release-0.1.0-alpha.1.md'), '# Release 0.1.0-alpha.1\n\nCurated zephyrprobe release notes.\n')
    const ctx = await boot(vault)

    const result = await recall(ctx, 'recall-namespace', 'zephyrprobe', 'agent-1', vault)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected memory_recall success')
    const out = JSON.parse(resultText(result)) as { hits: { id: string }[]; total: number }
    const ids = out.hits.map(hit => hit.id)
    expect(ids).toContain('shared/notes/auto-capture-release-0.1.0-alpha.1.md')
    expect(ids).not.toContain('shared/notes/auto-capture/session-1.md')
    expect(ids).not.toContain('shared/notes/auto-capture-session-6845668f-076f-4053-90ce-9b806c3432b4.md')
    expect(ids).not.toContain('shared/notes/auto-capture-b433b13a-f474-4f5d-814e-16927c26aa04.md')
    expect(out.total).toBe(1)
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

  it('warns an approver that default append retains old conclusions', async () => {
    const vault = await vaultDir()
    const reasons: string[] = []
    const ctx = await boot(vault, { request: async details => {
      reasons.push(details.reason, details.displayReason.en)
      return 'allowed-once'
    } })
    await capture(ctx, 'approval-first', 'Deploy runbook', 'Old conclusion.', 'agent-1', vault)

    const result = await capture(ctx, 'approval-second', 'Deploy runbook', 'Additional material.', 'agent-1', vault)
    expect(result.isError).toBe(false)
    expect(JSON.parse(resultText(result))).toMatchObject({ mode: 'append', conflict: true })
    expect(reasons).toEqual([expect.stringContaining('old text remains visible'), expect.stringContaining('Old conclusions remain visible')])
    const text = await readFile(join(vault, 'shared', 'notes', 'deploy-runbook.md'), 'utf8')
    expect(text).toContain('Old conclusion.')
    expect(text).toContain('Additional material.')
  })

  it('fails an update-only capture for a note that does not exist', async () => {
    const vault = await vaultDir()
    const ctx = await boot(vault)

    const result = await capture(ctx, 'c-require-missing', 'Nowhere note', 'Update body.', 'agent-1', vault, { requireExisting: true })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected memory_capture failure')
    expect(result.error.message).toContain('does not exist')
    expect(await readdir(vault)).toEqual([])
  })

  it('updates an existing note without conflict approval when requireExisting is set', async () => {
    const vault = await vaultDir()
    const ctx = await boot(vault)

    const first = await capture(ctx, 'c-require-first', 'Release checklist', 'Initial checklist.', 'agent-1', vault)
    expect(first.isError).toBe(false)

    // Without an approval service a conflicting capture would refuse; a
    // declared update is not a conflict, so it replaces the old conclusion.
    const update = await capture(ctx, 'c-require-update', 'Release checklist', 'Revised checklist with smoke check.', 'agent-1', vault, { requireExisting: true })
    expect(update.isError).toBe(false)
    if (update.isError) throw new Error('expected memory_capture success')
    const out = JSON.parse(resultText(update)) as { written: boolean; conflict: boolean; id: string; mode: string; updated?: string }
    expect(out.written).toBe(true)
    expect(out.conflict).toBe(false)
    expect(out.id).toBe('shared/notes/release-checklist.md')
    expect(out.mode).toBe('overwrite')
    expect(out.updated).toMatch(/\+08:00$/)

    const read = await readNote(ctx, 'require-read', out.id, 'agent-1', vault)
    expect(read.isError).toBe(false)
    const note = JSON.parse(resultText(read)) as { body: string }
    expect(note.body).not.toContain('Initial checklist.')
    expect(note.body).toContain('Revised checklist with smoke check.')
    expect(note.body.match(/# Release checklist/g)).toHaveLength(1)
    const recalled = await recall(ctx, 'require-recall', 'Release checklist smoke', 'agent-1', vault)
    expect(recalled.isError).toBe(false)
    expect((JSON.parse(resultText(recalled)) as { hits: { id: string }[] }).hits.map(hit => hit.id)).toContain(out.id)
  })

  it('still appends new material to an existing note when append is explicit', async () => {
    const vault = await vaultDir()
    const ctx = await boot(vault)
    await capture(ctx, 'append-first', 'Release checklist', 'Initial checklist.', 'agent-1', vault)

    const update = await capture(ctx, 'append-update', 'Release checklist', 'Added smoke check.', 'agent-1', vault, { requireExisting: true, mode: 'append' })
    expect(update.isError).toBe(false)
    const out = JSON.parse(resultText(update)) as { mode: string; conflict: boolean }
    expect(out).toMatchObject({ mode: 'append', conflict: false })
    const text = await readFile(join(vault, 'shared', 'notes', 'release-checklist.md'), 'utf8')
    expect(text).toContain('Initial checklist.')
    expect(text).toContain('Added smoke check.')
    expect(text.match(/# Release checklist/g)).toHaveLength(1)
  })

  it('does not redirect an update-only capture to another note with the same title', async () => {
    const vault = await vaultDir()
    const ctx = await boot(vault)
    await capture(ctx, 'target-first', 'Deploy runbook', 'Keep this note.', 'agent-1', vault)

    const result = await capture(ctx, 'target-missing', 'Deploy runbook', 'Must not replace another note.', 'agent-1', vault, {
      id: 'missing-target.md', requireExisting: true,
    })
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected missing target failure')
    expect(result.error.message).toContain('does not exist')
    const text = await readFile(join(vault, 'shared', 'notes', 'deploy-runbook.md'), 'utf8')
    expect(text).toContain('Keep this note.')
    expect(text).not.toContain('Must not replace another note.')
  })

  it('rejects an update-only overwrite when the note changes after frontmatter is read', async () => {
    const vault = await vaultDir()
    const ctx = await boot(vault)
    const id = 'shared/notes/deploy-runbook.md'
    await capture(ctx, 'race-first', 'Deploy runbook', 'First conclusion.', 'agent-1', vault)
    const execute = ctx.tools.execute.bind(ctx.tools)
    const spy = vi.spyOn(ctx.tools, 'execute').mockImplementation(async args => {
      if (args.name === 'wiki_write' && args.arguments?.mode === 'overwrite') {
        await writeFile(join(vault, id), '---\ntitle: Deploy runbook\n---\n\n# Deploy runbook\n\nConcurrent conclusion.\n')
      }
      return execute(args)
    })
    try {
      const update = await capture(ctx, 'race-update', 'Deploy runbook', 'Stale conclusion.', 'agent-1', vault, { requireExisting: true })
      expect(update.isError).toBe(true)
      if (!update.isError) throw new Error('expected stale update failure')
      expect(update.error.message).toContain('changed since it was read')
      expect(await readFile(join(vault, id), 'utf8')).toContain('Concurrent conclusion.')
    } finally {
      spy.mockRestore()
    }
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
    const out = JSON.parse(resultText(result)) as { id: string; mode: string; version: string; created?: string; updated?: string }
    expect(out.mode).toBe('overwrite')
    expect(out.version.length).toBe(40)
    expect(out.created).toMatch(/\+08:00$/)
    expect(out).not.toHaveProperty('updated')

    const read = await readNote(ctx, 'fresh-read', out.id, 'agent-1', vault)
    const { frontmatter } = JSON.parse(resultText(read)) as { frontmatter: Record<string, unknown> }
    expect(frontmatter).not.toHaveProperty('updated')
    expect(String(frontmatter.created)).toMatch(/\+08:00$/)
  })

  it('preserves created and adds updated on an append capture', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'dsh-curator-vault-'))
    // Appending to an existing note is a conflict, so the write path needs
    // approval to be reachable.
    const ctx = await boot(vault, { request: async () => 'allowed-once' })

    const r1 = await capture(ctx, 'append-first', 'Appendable', 'First section.', 'agent-1', vault)
    expect(r1.isError).toBe(false)
    const out1 = JSON.parse(resultText(r1)) as { written: boolean; id: string; version: string; created?: string; updated?: string }
    expect(out1.written).toBe(true)
    expect(out1.version.length).toBe(40)
    expect(out1.created).toMatch(/\+08:00$/)
    expect(out1).not.toHaveProperty('updated')

    const r2 = await capture(ctx, 'append-second', 'Appendable', 'Second section.', 'agent-1', vault, { mode: 'append' })
    expect(r2.isError).toBe(false)
    const out2 = JSON.parse(resultText(r2)) as { written: boolean; id: string; version: string; created?: string; updated?: string }
    expect(out2.written).toBe(true)
    expect(out2.created).toBe(out1.created)
    expect(out2.updated).toMatch(/\+08:00$/)
    expect(out2.version).not.toBe(out1.version)
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
