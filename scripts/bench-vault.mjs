/**
 * Large-vault performance benchmark for the memory suite. Generates a
 * throwaway vault under the OS temp directory, then measures index build,
 * search, link-depth reads, whole/sub graphs, appends, and cross-process lock
 * contention against the built workspace packages.
 *
 * Usage: node scripts/bench-vault.mjs [--notes 1200] [--writes 50]
 */

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as MemoryFilesystem from '../packages/tool-memory-filesystem/lib/index.js'
// `rankNotes` is the ranking half of `wiki_search`, but the package entry point
// re-exports only `buildIndex`, so the search phase imports the built module.
import { rankNotes } from '../packages/tool-memory-filesystem/lib/search.js'
import * as MemoryGraph from '../packages/tool-memory-graph/lib/index.js'

const queueWorker = join(resolve(import.meta.dirname, '..'), 'scripts', 'queue-worker.mjs')
const EXTENSIONS = ['.md']
const NOTE_WIDTH = 4
const READ_COUNT = 50
const MAX_EDGES = 20000
const QUERIES = ['atlas', 'cobalt', 'atlas cobalt', 'harbor quartz']

/**
 * The prose vocabulary is deliberately closed: literals are terms the graph
 * treats as stopwords, and the only shared non-stopword terms are the
 * topic/series tags. Natural prose repeats a handful of common words in every
 * note, and each such global term makes keyword-edge construction enumerate
 * O(N^2) pairs across the whole vault.
 */
const TOPICS = [
  'atlas', 'beacon', 'cipher', 'delta', 'ember', 'forge', 'glacier', 'harbor',
  'island', 'juniper', 'kestrel', 'lantern', 'meadow', 'needle', 'orchard', 'pebble',
  'quarry', 'ripple', 'summit', 'thicket', 'umber', 'vessel', 'willow', 'zephyr',
]
const SERIES = [
  'autumn', 'birch', 'cobalt', 'dusk', 'elm', 'fable', 'garnet', 'hazel', 'ivory', 'jade',
  'kelp', 'lilac', 'maple', 'nimbus', 'opal', 'pine', 'quartz', 'reed', 'slate', 'teak',
  'viola', 'walnut', 'yarrow', 'amber', 'bronze', 'cedar', 'dune', 'flint', 'grove', 'heath',
]

function parseArgs(argv) {
  const options = { notes: 1200, writes: 50 }
  const minimums = { '--notes': 10, '--writes': 1 }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    // `pnpm run <script> -- --flag` forwards the separator verbatim.
    if (flag === '--') continue
    if (!(flag in minimums)) throw new Error(`unknown argument: ${flag}`)
    const value = Number(argv[index + 1])
    if (!Number.isInteger(value) || value < minimums[flag]) {
      throw new Error(`${flag} requires an integer >= ${minimums[flag]}`)
    }
    options[flag.slice(2)] = value
    index += 1
  }
  return options
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function pad(value, width) {
  return String(value).padStart(width, '0')
}

/** Vault convention stores timestamps as second-precision Asia/Shanghai strings. */
function beijingStamp(offsetMinutes) {
  const shifted = Date.UTC(2026, 0, 1, 0, 0, 0) + offsetMinutes * 60000 + 8 * 3600 * 1000
  return `${new Date(shifted).toISOString().slice(0, 19)}+08:00`
}

function renderNote(index, total) {
  const topic = TOPICS[index % TOPICS.length]
  const series = SERIES[Math.floor(index / 40) % SERIES.length]
  const links = []
  // `notes >= 10` keeps every offset target distinct and never the note itself.
  for (let step = 0; step < 2 + (index % 3); step += 1) {
    links.push(`note-${pad((index + 1 + step) % total, NOTE_WIDTH)}`)
  }
  const paragraphs = [
    `The ${topic} and ${series} are the same as those we keep for ${topic}, and it should be the same when we come back to it.`,
    links.map(link => `See [[${link}]] for more of the same, and it is one of the few that will hold; that is why we keep it here.`).join(' '),
    `It was more of the same for ${series}, and it will be so again when we come back. There is more than one, and each of them is about the same; it should not be the same after that.`,
  ]
  return [
    '---',
    `title: "${topic} ${series} ${pad(index, NOTE_WIDTH)}"`,
    'tags:',
    `  - ${topic}`,
    `  - ${series}`,
    `created: "${beijingStamp(index)}"`,
    '---',
    '',
    paragraphs.join('\n\n'),
    '',
  ].join('\n')
}

async function timed(run) {
  const started = performance.now()
  const value = await run()
  return { value, elapsed: performance.now() - started }
}

/**
 * The filesystem and graph packages export only their Cordis plugin for
 * writing and graphing, so those phases mount the plugins on a real Context and
 * call the registered tools; `wiki_write` has no plain-function export.
 */
async function mountHarness(vault, notes) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemoryFilesystem, { vaultRoot: vault })
  await ctx.plugin(MemoryGraph, {
    vaultRoot: vault,
    maxDepth: 2,
    maxNodes: notes,
    maxEdges: MAX_EDGES,
  })
  return ctx
}

function resultText(result) {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

async function callToolJson(ctx, name, args, callId) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name,
    arguments: args,
  })
  if (result.isError) throw new Error(`${name} failed: ${resultText(result)}`)
  return JSON.parse(resultText(result))
}

async function runLockBatch(vault, markers, label) {
  const spawned = markers.map(marker =>
    spawn(process.execPath, [queueWorker, 'write', vault, marker], { stdio: ['ignore', 'ignore', 'pipe'] }),
  )
  const exits = spawned.map(child => new Promise((resolveExit, reject) => {
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal, stderr }))
  }))
  const started = performance.now()
  const outcomes = await Promise.all(exits)
  const elapsed = performance.now() - started
  outcomes.forEach((outcome, index) => {
    assert(outcome.code === 0, `${label}: writer ${markers[index]} failed (${outcome.signal ?? outcome.code}): ${outcome.stderr}`)
  })
  return elapsed
}

function printTable(rows) {
  const cells = [
    ['phase', 'count', 'elapsed ms', 'per item ms'],
    ...rows.map(row => [
      row.phase,
      String(row.count),
      row.elapsed.toFixed(1),
      row.perItem === undefined ? '—' : row.perItem.toFixed(3),
    ]),
  ]
  const widths = cells[0].map((_, column) => Math.max(...cells.map(line => line[column].length)))
  cells.forEach((line, index) => {
    process.stdout.write(`${line.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()}\n`)
    if (index === 0) process.stdout.write(`${widths.map(width => '-'.repeat(width)).join('  ')}\n`)
  })
}

let vault
let context
try {
  const { notes, writes } = parseArgs(process.argv.slice(2))
  vault = await mkdtemp(join(tmpdir(), 'dsh-bench-vault-'))
  const notesDir = join(vault, 'shared', 'notes')

  const generate = await timed(async () => {
    await mkdir(notesDir, { recursive: true })
    for (let index = 0; index < notes; index += 1) {
      await writeFile(join(notesDir, `note-${pad(index, NOTE_WIDTH)}.md`), renderNote(index, notes), 'utf8')
    }
  })

  // Prebuilt outside the timed phases: `wiki_read` builds this resolver per
  // call, but the phase isolates `readNote` itself.
  const notePaths = await MemoryFilesystem.listNotePaths(vault, EXTENSIONS)
  assert(notePaths.length === notes, `generate: expected ${notes} note files, found ${notePaths.length}`)
  const linkResolver = MemoryFilesystem.createLinkResolver(
    notePaths.map(path => MemoryFilesystem.vaultRelativeId(vault, path)),
  )

  const index = await timed(() => MemoryFilesystem.buildIndex(vault, EXTENSIONS))
  assert(index.value.size === notes, `index build: expected ${notes} notes, got ${index.value.size}`)
  const backlinked = [...index.value.values()].filter(entry => entry.backlinks.length > 0).length
  assert(backlinked > 0, 'index build: no [[link]] backlinks resolved')

  const search = await timed(() => QUERIES.map(query => rankNotes(index.value, query)))
  search.value.forEach((hits, position) => {
    assert(hits.length > 0, `search: query ${JSON.stringify(QUERIES[position])} returned no hits`)
  })

  const readCount = Math.min(READ_COUNT, notePaths.length)
  const read = await timed(async () => {
    for (let index = 0; index < readCount; index += 1) {
      const path = notePaths[(index * 7) % notePaths.length]
      const note = await MemoryFilesystem.readNote(vault, EXTENSIONS, 1, path, new Set(), linkResolver)
      assert(note.links.length >= 2, `read: note ${note.id} carries fewer than two links`)
      assert(note.linkedNotes.length >= 1, `read: note ${note.id} resolved no depth-1 links`)
    }
  })

  context = await mountHarness(vault, notes)

  const whole = await timed(() => callToolJson(context, 'wiki_graph', {}, 'bench-graph-whole'))
  assert(whole.value.truncated === false, 'graph: whole-vault graph hit the node cap')
  assert(
    whole.value.nodes.length === notes,
    `graph: expected ${notes} nodes, got ${whole.value.nodes.length}`,
  )
  const sub = await timed(() => callToolJson(
    context,
    'wiki_graph',
    { id: `shared/notes/note-${pad(0, NOTE_WIDTH)}.md`, depth: 2 },
    'bench-graph-sub',
  ))
  assert(sub.value.nodes.length >= 3, `graph: subgraph depth 2 returned ${sub.value.nodes.length} nodes`)

  const writeTarget = 'shared/notes/bench-append.md'
  const write = await timed(async () => {
    for (let index = 0; index < writes; index += 1) {
      await callToolJson(
        context,
        'wiki_write',
        { id: writeTarget, content: `bench-write-${pad(index, NOTE_WIDTH)}` },
        `bench-write-${index}`,
      )
    }
  })
  const appended = await readFile(join(vault, 'shared', 'notes', 'bench-append.md'), 'utf8')
  const appendedCount = appended.split('bench-write-').length - 1
  assert(appendedCount === writes, `write: expected ${writes} appends, found ${appendedCount}`)

  // queue-worker.mjs hardcodes the note id (`shared/concurrent.md`) and exposes
  // no lane argument, so distinct-lane contention cannot be driven from it; the
  // second batch raises same-note writer count instead.
  const sameNoteMarkers = ['bench-lock-a', 'bench-lock-b']
  const lockTwo = await runLockBatch(vault, sameNoteMarkers, 'lock 2 writers')
  const fourNoteMarkers = ['bench-lock-c', 'bench-lock-d', 'bench-lock-e', 'bench-lock-f']
  const lockFour = await runLockBatch(vault, fourNoteMarkers, 'lock 4 writers')
  const concurrent = await readFile(join(vault, 'shared', 'concurrent.md'), 'utf8')
  for (const marker of [...sameNoteMarkers, ...fourNoteMarkers]) {
    assert(concurrent.includes(marker), `lock: append ${marker} was lost under same-note contention`)
  }

  printTable([
    { phase: 'generate notes', count: notes, elapsed: generate.elapsed, perItem: generate.elapsed / notes },
    { phase: 'index build', count: index.value.size, elapsed: index.elapsed, perItem: index.elapsed / index.value.size },
    { phase: 'search', count: QUERIES.length, elapsed: search.elapsed, perItem: search.elapsed / QUERIES.length },
    { phase: 'read depth 1', count: readCount, elapsed: read.elapsed, perItem: read.elapsed / readCount },
    { phase: 'graph whole vault', count: whole.value.nodes.length, elapsed: whole.elapsed, perItem: whole.elapsed / whole.value.nodes.length },
    { phase: 'graph subgraph depth 2', count: sub.value.nodes.length, elapsed: sub.elapsed, perItem: sub.elapsed / sub.value.nodes.length },
    { phase: 'write append', count: writes, elapsed: write.elapsed, perItem: write.elapsed / writes },
    { phase: 'lock 2 writers same note', count: sameNoteMarkers.length, elapsed: lockTwo },
    { phase: 'lock 4 writers same note', count: fourNoteMarkers.length, elapsed: lockFour },
  ])
  process.stdout.write(`\nsearch hits: ${QUERIES.map((query, position) => `${query}=${search.value[position].length}`).join(', ')}\n`)
  process.stdout.write(`read: ${backlinked}/${index.value.size} notes carry backlinks\n`)
  process.stdout.write(`graph whole vault: ${whole.value.nodes.length} nodes, ${whole.value.edges.length} edges, edgesTruncated=${whole.value.edgesTruncated}\n`)
  process.stdout.write(`graph subgraph depth 2: ${sub.value.nodes.length} nodes, ${sub.value.edges.length} edges, edgesTruncated=${sub.value.edgesTruncated}\n`)
  process.stdout.write(`write: ${appendedCount}/${writes} appends present in ${writeTarget}\n`)
  process.stdout.write(`lock: ${sameNoteMarkers.length + fourNoteMarkers.length}/${sameNoteMarkers.length + fourNoteMarkers.length} same-note appends present (serialized, no lost writes)\n`)
  process.stdout.write('lock: distinct-lane mode unavailable — scripts/queue-worker.mjs fixes the note id and has no lane argument\n')
  process.stdout.write('bench-vault: OK\n')
} catch (error) {
  process.stderr.write(`bench-vault: FAIL ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await context?.fiber.dispose()
  if (vault !== undefined) await rm(vault, { recursive: true, force: true })
}
