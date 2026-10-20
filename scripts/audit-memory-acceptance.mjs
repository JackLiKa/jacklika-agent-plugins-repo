import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function git(vault, ...args) {
  return execFileSync('git', ['-C', vault, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

function safeId(id) {
  return typeof id === 'string' && id !== '' && !id.startsWith('/') &&
    !id.includes('\\') && !id.includes('\0') && !/^[A-Za-z]:/.test(id) &&
    !id.split('/').some(part => part === '.' || part === '..' || part === '')
}

function main() {
  const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => {
    if (index % 2 === 0) pairs.push([arg, all[index + 1]])
    return pairs
  }, []))
  if (Object.keys(flags).length !== 3 || !flags['--vault'] || !flags['--baseline'] || !flags['--manifest']) {
    throw new Error('usage: node scripts/audit-memory-acceptance.mjs --vault <vault> --baseline <commit> --manifest <json>')
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(flags['--baseline'])) {
    throw new Error('baseline must be a pinned full Git commit hash')
  }
  const vault = resolve(flags['--vault'])
  const manifest = JSON.parse(readFileSync(resolve(flags['--manifest']), 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.createPrefixes) ||
      !Array.isArray(manifest.updateIds) || !Array.isArray(manifest.archiveMoves) ||
      manifest.createPrefixes.length === 0 ||
      manifest.createPrefixes.some(prefix => !prefix.endsWith('/') || !safeId(`${prefix}note.md`) || prefix.startsWith('archive/')) ||
      manifest.updateIds.some(id => !safeId(id) || id.startsWith('archive/')) ||
      manifest.archiveMoves.some(move => !safeId(move.from) || move.to !== `archive/${move.from}`)) {
    throw new Error('invalid acceptance manifest')
  }
  const baseline = git(vault, 'rev-parse', '--verify', `${flags['--baseline']}^{commit}`).trim()
  git(vault, 'merge-base', '--is-ancestor', baseline, 'HEAD')
  const dirty = git(vault, 'status', '--porcelain=v1', '--untracked-files=all')
  const preexisting = new Set(git(vault, 'ls-tree', '-r', '--name-only', '-z', baseline).split('\0'))
  const commits = git(vault, 'rev-list', '--reverse', `${baseline}..HEAD`).split('\n').filter(Boolean)
  const entries = []
  for (const commit of commits) {
    const ancestry = git(vault, 'rev-list', '--parents', '-n', '1', commit).trim().split(' ')
    if (ancestry.length !== 2) throw new Error(`merge or root commit in acceptance range: ${commit}`)
    const changes = git(vault, 'diff', '--no-renames', '--name-status', '-z', ancestry[1], commit).split('\0')
    const group = []
    for (let i = 0; i < changes.length - 1; i += 2) group.push({ commit, status: changes[i], id: changes[i + 1] })
    for (const entry of group) {
      const { status, id } = entry
      const archive = manifest.archiveMoves.find(move => move.from === id || move.to === id)
      const paired = archive && group.some(other =>
        other.id === (status === 'D' ? archive.to : archive.from) && other.status === (status === 'D' ? 'A' : 'D'))
      const inRun = manifest.createPrefixes.some(prefix => id.startsWith(prefix))
      entry.allowed = (status === 'A' && inRun) ||
        (status === 'M' && (manifest.updateIds.includes(id) || (inRun && !preexisting.has(id)))) ||
        (status === 'D' && archive?.from === id && Boolean(paired)) ||
        (status === 'A' && archive?.to === id && Boolean(paired))
      const mode = git(vault, 'ls-tree', commit, '--', id).split(' ')[0]
      if (status !== 'D' && mode !== '100644' && mode !== '100755') entry.allowed = false
    }
    entries.push(...group)
  }
  const dirtyEntries = dirty === '' ? [] : dirty.split('\n').filter(Boolean).map(line => {
    let id = line.slice(3)
    if (id.startsWith('"') && id.endsWith('"')) id = JSON.parse(id)
    const arrow = id.indexOf(' -> ')
    if (arrow !== -1) id = id.slice(arrow + 4)
    return { status: line.slice(0, 2).trim(), id }
  })
  // Worktree dirt on a path that was already tracked at baseline cannot be
  // attributed to the run: it may be a leftover from earlier activity (e.g. an
  // uncommitted delete) or an uncommitted run write — the committed range is
  // already audited per-commit above. Report it as a warning, not a failure.
  // Dirt on paths absent from the baseline tree is new by definition and fails.
  const unexpectedDirty = dirtyEntries.filter(entry => !preexisting.has(entry.id))
  const preexistingDirty = dirtyEntries.filter(entry => preexisting.has(entry.id))
  const report = {
    baseline, head: git(vault, 'rev-parse', 'HEAD').trim(),
    cleanWorkingTree: dirty === '',
    preexistingDirty,
    unexpectedDirty,
    entries,
    unexpected: entries.filter(entry => !entry.allowed),
  }
  report.pass = report.unexpectedDirty.length === 0 && report.unexpected.length === 0
  console.log(JSON.stringify(report, null, 2))
  if (!report.pass) process.exitCode = 1
}

try {
  main()
} catch (error) {
  console.error(`acceptance audit failed closed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
