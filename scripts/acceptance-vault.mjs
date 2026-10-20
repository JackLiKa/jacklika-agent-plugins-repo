/**
 * One-shot acceptance vault: create a disposable Markdown vault for DSH
 * runtime acceptance, snapshot it, diff it after the run, and destroy it.
 * Each run gets a unique vault, so repeated acceptance rounds can never
 * collide on titles or pollute the real vault's search index.
 *
 *   node scripts/acceptance-vault.mjs create
 *     Prints a JSON plan: the new vaultRoot, a manifest path, the suggested
 *     note prefix, and the cordis.yml snippet that points a dedicated
 *     acceptance profile at this vault.
 *   node scripts/acceptance-vault.mjs snapshot --vault <dir>
 *     Records sha256 of every file (excluding .git and the manifest itself)
 *     into <dir>/.acceptance-manifest.json. Run before acceptance.
 *   node scripts/acceptance-vault.mjs check --vault <dir> --allow <prefix>[,<prefix>...]
 *     Compares the tree against the manifest. Every created/modified/deleted
 *     file must live under one of the --allow prefixes (archive/ mirrors are
 *     allowed automatically for an allowed notes prefix). Exits non-zero on
 *     any out-of-scope change.
 *   node scripts/acceptance-vault.mjs clean --vault <dir>
 *     Removes the vault. Refuses anything outside the OS temp dir or without
 *     a manifest marker, so a stray argument cannot delete a real vault.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

const MANIFEST = '.acceptance-manifest.json'
const args = process.argv.slice(2)
const command = args[0]

function flag(name) {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
function requireVault() {
  const v = flag('--vault')
  if (v === undefined) {
    console.error('error: --vault <dir> is required')
    process.exit(2)
  }
  return resolve(v)
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile() && entry.name !== MANIFEST) yield full
  }
}

function tree(root) {
  const map = {}
  if (!existsSync(root)) return map
  for (const file of walk(root)) {
    const rel = relative(root, file).split(sep).join('/')
    map[rel] = createHash('sha256').update(readFileSync(file)).digest('hex')
  }
  return map
}

if (command === 'create') {
  const vault = mkdtempSync(join(tmpdir(), 'dsh-acceptance-vault-'))
  execFileSync('git', ['init', '-q'], { cwd: vault })
  execFileSync('git', ['config', 'user.name', 'dsh-acceptance'], { cwd: vault })
  execFileSync('git', ['config', 'user.email', 'acceptance@local'], { cwd: vault })
  execFileSync('git', ['commit', '-qm', 'acceptance baseline', '--allow-empty'], { cwd: vault })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const prefix = `shared/notes/accept-${stamp}/`
  console.log(JSON.stringify({
    vaultRoot: vault,
    manifest: join(vault, MANIFEST),
    suggestedPrefix: prefix,
    archiveMirror: `archive/${prefix}`,
    cordis: {
      note: 'Mount the same Bundle in a dedicated acceptance profile with this vaultRoot.',
      config: { '@jacklika/dsh-tool-memory-filesystem': { vaultRoot: vault } },
    },
    next: [
      `node scripts/acceptance-vault.mjs snapshot --vault ${vault}`,
      `# run acceptance with note prefix ${prefix}`,
      `node scripts/acceptance-vault.mjs check --vault ${vault} --allow ${prefix}`,
      `node scripts/acceptance-vault.mjs clean --vault ${vault}`,
    ],
  }, null, 2))
} else if (command === 'snapshot') {
  const vault = requireVault()
  writeFileSync(join(vault, MANIFEST), JSON.stringify({ createdAt: new Date().toISOString(), files: tree(vault) }, null, 2))
  console.log(`snapshot recorded for ${Object.keys(tree(vault)).length} files`)
} else if (command === 'check') {
  const vault = requireVault()
  const allow = (flag('--allow') ?? '').split(',').filter(Boolean)
  if (allow.length === 0) {
    console.error('error: at least one --allow prefix is required')
    process.exit(2)
  }
  const manifestPath = join(vault, MANIFEST)
  if (!existsSync(manifestPath)) {
    console.error('error: no manifest; run snapshot first')
    process.exit(2)
  }
  const before = JSON.parse(readFileSync(manifestPath, 'utf8')).files
  const after = tree(vault)
  const inScope = (rel) => allow.some(p => rel.startsWith(p) || rel.startsWith(`archive/${p}`))
  const changed = [], outOfScope = []
  for (const rel of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const status = before[rel] === undefined ? 'created' : after[rel] === undefined ? 'deleted' : before[rel] !== after[rel] ? 'modified' : null
    if (status === null) continue
    ;(inScope(rel) ? changed : outOfScope).push({ id: rel, status })
  }
  console.log(JSON.stringify({ changed, outOfScope }, null, 2))
  if (outOfScope.length > 0) {
    console.error(`FAIL: ${outOfScope.length} change(s) outside the allowed prefixes`)
    process.exit(1)
  }
  console.log(`PASS: ${changed.length} change(s), all inside allowed prefixes`)
} else if (command === 'clean') {
  const vault = requireVault()
  if (!vault.startsWith(join(tmpdir(), 'dsh-acceptance-vault-')) || !existsSync(join(vault, MANIFEST))) {
    console.error('refused: clean only removes dsh-acceptance-vault-* dirs that carry a manifest')
    process.exit(2)
  }
  rmSync(vault, { recursive: true, force: true })
  console.log(`removed ${vault}`)
} else {
  console.error('usage: node scripts/acceptance-vault.mjs create|snapshot|check|clean [--vault <dir>] [--allow <prefix>[,<prefix>...]]')
  process.exit(2)
}
