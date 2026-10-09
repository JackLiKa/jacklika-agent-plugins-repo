import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Probe run inside the profile directory: resolve the requested packages the
 * way the Harness loader would, then walk the profile's dependency tree and
 * report every `@jacklika/*` copy it finds with its real path and version.
 * Prints one JSON report on stdout.
 */
const PROBE = `
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

const names = JSON.parse(process.env.DSH_PROBE_NAMES ?? '[]')
const root = process.cwd()
const require = createRequire(join(root, 'resolution-probe.cjs'))

function realManifest(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  return { name: manifest.name, version: manifest.version, directory: realpathSync(directory) }
}

// Keyed by realpath: a pnpm install exposes each package both as a top-level
// link and as the physical copy in the virtual store, and those two paths are
// the same package, not a duplicate.
const copies = new Map()
const visited = new Set()
function walk(directory, depth) {
  if (depth > 24) return
  let real
  try {
    real = realpathSync(directory)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)
  let entries
  try {
    entries = readdirSync(real, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const child = join(real, entry.name)
    if (entry.name === 'node_modules') {
      const scoped = join(child, '@jacklika')
      for (const member of readdirSyncSafe(scoped)) {
        const directory = join(scoped, member)
        if (!isPackage(directory)) continue
        record(directory)
        walk(directory, depth + 1)
      }
      // The virtual store sits beside the links and holds the physical copies,
      // so a second copy of a package is only visible by walking it too.
      walk(join(child, '.pnpm'), depth + 1)
      continue
    }
    if (entry.name === '.pnpm') {
      for (const member of readdirSyncSafe(child)) walk(join(child, member), depth + 1)
      continue
    }
    if (entry.name.startsWith('.')) continue
    walk(child, depth + 1)
  }
}

function record(directory) {
  const manifest = realManifest(directory)
  if (!copies.has(manifest.directory)) copies.set(manifest.directory, manifest)
}

function readdirSyncSafe(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

function isPackage(directory) {
  try {
    return statSync(join(directory, 'package.json')).isFile()
  } catch {
    return false
  }
}

walk(root, 0)

const resolutions = {}
for (const name of names) {
  try {
    resolutions[name] = {
      ...realManifest(dirname(require.resolve(\`\${name}/package.json\`))),
      entry: realpathSync(require.resolve(name)),
    }
  } catch (error) {
    resolutions[name] = { error: String(error?.message ?? error) }
  }
}

process.stdout.write(JSON.stringify({ resolutions, copies: [...copies.values()] }))
`

/**
 * Verify the resolution layer of an installed profile: the packages the caller
 * names resolve from the profile root into the profile's own `node_modules`,
 * every `@jacklika/*` copy in the tree lives inside the profile, and no package
 * name is present twice or at two versions. Both smoke scripts already prove the
 * plugin *loads*; this proves which copy loaded. A hoisted install that quietly
 * kept a second copy — or a `link:` that escaped into the checkout — imports
 * just as happily, so only the resolved real paths show it.
 *
 * Only `names` is held to root resolvability: a non-hoisted pnpm layout keeps
 * transitive packages inside `.pnpm`, where the loader reaches them through its
 * importer rather than from the profile root.
 * @param profileDir - absolute profile root holding `package.json` and `node_modules`.
 * @param nodeCommand - node executable used to run the probe.
 * @param names - package names that must resolve from the profile root.
 * @param env - extra environment for the probe, e.g. the desk runtime pointer.
 * @throws when a named package fails to resolve, a copy lies outside the profile, or a name is duplicated.
 */
export function assertProfileResolution(profileDir, nodeCommand, names = [], env = {}) {
  const result = spawnSync(nodeCommand, ['--input-type=module', '--eval', PROBE], {
    cwd: profileDir,
    encoding: 'utf8',
    env: { ...process.env, ...env, DSH_PROBE_NAMES: JSON.stringify(names) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`resolution probe failed in ${profileDir}: ${result.stderr || result.stdout}`)
  }
  const report = JSON.parse(result.stdout)
  if (report.copies.length === 0) throw new Error(`no @jacklika package found under ${profileDir}`)

  // Compare real paths: the probe reports realpath'd resolutions, so a profile
  // under a symlinked temp root (/var on macOS) would otherwise never match.
  const boundary = realpathSync(join(profileDir, 'node_modules'))
  for (const name of [...names].sort()) {
    const resolution = report.resolutions[name]
    if (resolution === undefined || resolution.error !== undefined) {
      throw new Error(`${name}: does not resolve from the profile root: ${resolution?.error ?? 'probe did not report it'}`)
    }
    for (const [field, value] of [['manifest', resolution.directory], ['entry', resolution.entry]]) {
      if (!isInside(boundary, value)) {
        throw new Error(`${name}: ${field} resolved to ${value}, outside ${boundary}`)
      }
    }
  }

  const byName = new Map()
  for (const copy of report.copies) {
    if (!isInside(boundary, copy.directory)) {
      throw new Error(`${copy.name}: copy at ${copy.directory} lies outside ${boundary}`)
    }
    const known = byName.get(copy.name) ?? { directories: new Set(), versions: new Set() }
    known.directories.add(copy.directory)
    known.versions.add(copy.version)
    byName.set(copy.name, known)
  }
  for (const [name, found] of [...byName].sort()) {
    if (found.versions.size > 1) {
      throw new Error(`${name}: conflicting versions in the profile tree: ${[...found.versions].sort().join(', ')}`)
    }
    if (found.directories.size > 1) {
      throw new Error(`${name}: ${found.directories.size} copies in the profile tree: ${[...found.directories].sort().join(', ')}`)
    }
  }

  return {
    checked: [...byName.keys()].sort(),
    versions: Object.fromEntries([...byName].sort().map(([name, found]) => [name, [...found.versions][0]])),
  }
}

/** True when `candidate` is `boundary` itself or lives beneath it. */
function isInside(boundary, candidate) {
  return candidate === boundary || candidate.startsWith(boundary + '/') || candidate.startsWith(boundary + '\\')
}

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']

/**
 * The `@jacklika/*` names an installed profile has to resolve: the entry bundle
 * plus everything it depends on, transitively. Sibling workspace packages the
 * bundle does not depend on are never installed into a profile, so requiring
 * them would fail a correct install.
 * @param manifests - map (or plain object) of package name to its manifest.
 * @param entryName - the bundle the profile installs directly.
 * @returns sorted list of package names in the entry's dependency closure.
 */
export function jacklikaClosure(manifests, entryName) {
  const closure = new Set()
  const pending = [entryName]
  while (pending.length > 0) {
    const name = pending.pop()
    if (closure.has(name)) continue
    closure.add(name)
    const manifest = manifests instanceof Map ? manifests.get(name) : manifests[name]
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(manifest?.[field] ?? {})) {
        if (dependency.startsWith('@jacklika/')) pending.push(dependency)
      }
    }
  }
  return [...closure].sort()
}
