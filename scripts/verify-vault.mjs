/**
 * Vault hygiene guard: four read-only checks over a Markdown vault, each
 * mapped to a defect class that was previously only discoverable by hand.
 *
 *   1. emptySlug      — a `.md` file whose basename folded to nothing
 *                       (e.g. `shared/notes/.md`, the legacy empty-slug bug)
 *   2. duplicateH1    — a note carrying more than one `# ` level-1 heading
 *   3. archiveLeak    — a non-archive note containing an `[[archive/…]]` link
 *   4. dirtyWorktree  — `git status --porcelain` is not empty (skipped when
 *                       the vault is not a git repository)
 *
 * Usage: node scripts/verify-vault.mjs --vault <path> [--json]
 * Exit code is non-zero when any check reports at least one finding.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, relative, basename } from 'node:path'

const flags = process.argv.slice(2)
const vaultFlag = flags.indexOf('--vault')
const json = flags.includes('--json')
if (vaultFlag === -1 || flags[vaultFlag + 1] === undefined) {
  console.error('usage: node scripts/verify-vault.mjs --vault <path> [--json]')
  process.exit(2)
}
const vault = resolve(flags[vaultFlag + 1])

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      yield* walk(full)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full
    }
  }
}

const findings = { emptySlug: [], duplicateH1: [], archiveLeak: [], dirtyWorktree: [] }

for (const file of walk(vault)) {
  const id = relative(vault, file).split('\\').join('/')
  if (basename(file) === '.md' || basename(file).startsWith('.')) findings.emptySlug.push(id)
  const text = readFileSync(file, 'utf8')
  const h1Count = (text.match(/^#\s/gm) ?? []).length
  if (h1Count > 1) findings.duplicateH1.push({ id, h1Count })
  if (!id.startsWith('archive/') && /\[\[archive\//.test(text)) findings.archiveLeak.push(id)
}

let isRepo = true
try {
  execFileSync('git', ['-C', vault, 'rev-parse', '--git-dir'], { stdio: 'pipe' })
} catch {
  isRepo = false
}
if (isRepo) {
  const dirty = execFileSync('git', ['-C', vault, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' })
  findings.dirtyWorktree = dirty.split('\n').filter(Boolean).map(line => line.slice(3).replace(/^"|"$/g, ''))
}

const report = {
  vault,
  gitRepository: isRepo,
  checks: Object.fromEntries(Object.entries(findings).map(([name, hits]) => [name, { count: hits.length, hits }])),
}
report.pass = Object.values(findings).every(hits => hits.length === 0)

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const [name, hits] of Object.entries(findings)) {
    const mark = hits.length === 0 ? 'ok' : `${hits.length} finding(s)`
    console.log(`${name.padEnd(14)} ${mark}`)
    for (const hit of hits.slice(0, 20)) console.log(`  - ${typeof hit === 'string' ? hit : JSON.stringify(hit)}`)
    if (hits.length > 20) console.log(`  … ${hits.length - 20} more`)
  }
  console.log(report.pass ? 'verify-vault: PASS' : 'verify-vault: FAIL')
}
process.exitCode = report.pass ? 0 : 1
