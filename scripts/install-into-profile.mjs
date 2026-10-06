/**
 * Install workspace builds into a DSH profile (`~/.dsh/profiles/<name>`).
 *
 * Why this script exists: pnpm keys `file:` tarball installs by version +
 * integrity. When the workspace changes without a version bump, `pnpm add
 * file:...tgz` reports "already up to date" and leaves the OLD build in
 * node_modules — this bit us twice (a stale `terms.every` build, then a stale
 * resolver without `basenameId`). DSH has no plugin update button and npm
 * only carries the published build, so local deployment must defeat that
 * cache. The script therefore:
 *   1. builds the workspace and repacks every package,
 *   2. `pnpm add`s the tarballs so the profile manifest/lockfile stay coherent
 *      (the Bundle is added too — its `workspace:*` deps are only rewritten
 *      to real versions inside the packed tarball; adding a single package
 *      alone would let the Bundle keep resolving old deps from npm),
 *   3. force-extracts each tarball over the installed directory anyway,
 *      defeating the same-version cache (extract → verify → atomic swap, with
 *      the previous install restored on failure),
 *   4. byte-compares the installed `lib/` against the workspace build and
 *      fails on any drift.
 *
 * IMPORTANT — `<profile>/.connector-packages/` lifecycle: profile
 * dependencies are rewritten to `file:.connector-packages/*.tgz`, so the
 * profile PERMANENTLY depends on that directory holding those tarballs. The
 * script copies all freshly packed tarballs in, then prunes only files that
 * are neither referenced by the profile manifest nor produced by this run —
 * a tarball the profile still references but whose workspace package was
 * deleted is kept, so the profile stays resolvable. Do NOT delete the
 * directory by hand; tarballs for packages still in the workspace are
 * restored by re-running this script, but a tarball whose package was
 * deleted from the workspace can only be recovered from git history.
 *
 * Usage: node scripts/install-into-profile.mjs <profile-dir> [package-dir ...]
 *   e.g. node scripts/install-into-profile.mjs ~/.dsh/profiles/desktop
 *        node scripts/install-into-profile.mjs ~/.dsh/profiles/desktop memory tool-memory-filesystem
 * Without package dirs it installs every packed artifact (Bundle included).
 * Cross-platform (Windows/macOS/Linux): relies on Node APIs plus `tar`, which
 * ships as bsdtar on Windows 10+.
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')

function run(cmd, args, cwd) {
  const result = process.platform === 'win32' && (cmd === 'pnpm' || cmd === 'npx')
    ? spawnSync([cmd, ...args.map(a => JSON.stringify(a))].join(' '), { cwd, encoding: 'utf8', shell: true })
    : spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status ?? 1}`)
  }
  return result.stdout ?? ''
}

async function filesUnder(dir) {
  const out = []
  const walk = async d => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  await walk(dir)
  return out
}

/** Recursive byte-for-byte comparison; returns a list of differing paths. */
export async function diffDirs(a, b) {
  const diffs = []
  const [aFiles, bFiles] = [await filesUnder(a), await filesUnder(b)]
  const rel = (dir, f) => f.slice(dir.length + sep.length)
  const aSet = new Map(aFiles.map(f => [rel(a, f), f]))
  const bSet = new Map(bFiles.map(f => [rel(b, f), f]))
  for (const [r, f] of aSet) {
    if (r.endsWith('.map')) continue
    const other = bSet.get(r)
    if (other === undefined) { diffs.push(`missing in install: ${r}`); continue }
    const [x, y] = await Promise.all([readFile(f), readFile(other)])
    if (!x.equals(y)) diffs.push(`differs: ${r}`)
  }
  for (const r of bSet.keys()) {
    if (!r.endsWith('.map') && !aSet.has(r)) diffs.push(`missing in workspace: ${r}`)
  }
  return diffs
}

/** Default move: rename, with a copy-then-remove cross-device fallback. */
async function moveIn(src, target) {
  try {
    await rename(src, target)
  } catch {
    // cross-device fallback: remove any partially written target first so
    // cp cannot nest `src` inside an existing directory
    await rm(target, { recursive: true, force: true })
    await cp(src, target, { recursive: true })
    await rm(src, { recursive: true, force: true })
  }
}

/**
 * Atomically replace `target` with the directory at `src`, keeping a rename
 * backup of the previous install and restoring it when the swap fails.
 * Rollback removes any partially written `target` first — `rename` fails on a
 * non-empty directory (`ENOTEMPTY`) and `fs.cp` into an existing directory
 * nests instead of replacing. Whenever the previous install cannot be
 * restored, the error names the backup path and the manual restore command;
 * the backup stays on disk.
 * @param {string} src - the unpacked replacement directory.
 * @param {string} target - the install destination; must already be validated
 *   to live inside the profile's node_modules by the caller.
 * @param {string} backup - a non-existent path used as the rename backup.
 * @param {object} [options] - injectable operations for fault-injection tests.
 */
export async function replaceDir(src, target, backup, { move = moveIn, remove = rm } = {}) {
  let swapped = false
  try {
    await stat(target)
    await rename(target, backup)
    swapped = true
  } catch {
    // not installed yet — nothing to back up
  }
  try {
    await move(src, target)
  } catch (error) {
    if (swapped) {
      try {
        await remove(target, { recursive: true, force: true })
        try {
          await rename(backup, target)
        } catch {
          await cp(backup, target, { recursive: true })
        }
      } catch (rollbackError) {
        throw new Error(
          `install into ${target} failed (${error.message}) and rollback failed too: ` +
          `${rollbackError.message}. The previous install is preserved at ${backup} — ` +
          `restore it manually with: mv "${backup}" "${target}"`,
        )
      }
    }
    throw error
  }
  if (swapped) await rm(backup, { recursive: true, force: true })
}

/**
 * Copy every fresh tarball into `staging`, then delete only the tarballs that
 * are neither referenced by the profile manifest (`file:.connector-packages/*`)
 * nor produced by this pack run. Referenced tarballs whose workspace package
 * no longer exists are preserved so the profile stays resolvable.
 * @returns {Promise<string[]>} the pruned tarball filenames.
 */
export async function pruneStaging(staging, artifacts, profileDir) {
  const referenced = new Set()
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    for (const spec of Object.values(manifest.dependencies ?? {})) {
      const m = /^file:(?:\.\/)?\.connector-packages[/\\]([^/\\]+\.tgz)$/.exec(typeof spec === 'string' ? spec : '')
      if (m !== null && m[1] !== undefined) referenced.add(m[1])
    }
  } catch (error) {
    // A missing manifest means a fresh profile with no file: deps — safe to
    // proceed. A manifest that exists but cannot be parsed is fail-CLOSED:
    // pruning without knowing the references could delete tarballs the
    // profile still needs, leaving it permanently unresolvable.
    if (error.code === 'ENOENT') {
      // no manifest — nothing is referenced
    } else {
      throw new Error(`cannot read ${join(profileDir, 'package.json')} — refusing to prune ${staging} without knowing the referenced tarballs: ${error.message}`)
    }
  }
  const fresh = new Set((await readdir(artifacts)).filter(f => f.endsWith('.tgz')))
  await mkdir(staging, { recursive: true })
  for (const file of fresh) {
    await cp(join(artifacts, file), join(staging, file))
  }
  const pruned = []
  for (const file of await readdir(staging)) {
    if (file.endsWith('.tgz') && !fresh.has(file) && !referenced.has(file)) {
      await rm(join(staging, file))
      pruned.push(file)
    }
  }
  return pruned
}

async function main() {
  const profile = resolve(process.argv[2] ?? (() => { console.error('usage: install-into-profile.mjs <profile-dir> [package-dir ...]'); process.exit(2) })())
  const only = new Set(process.argv.slice(3))
  const staging = join(profile, '.connector-packages')
  const artifacts = join(root, 'artifacts', 'packages')

  run('pnpm', ['build'], root)
  run('node', ['scripts/pack-all.mjs'], root)

  // Map each package dir to its packed tarball filename: pnpm pack names a
  // scoped package "@jacklika/dsh-x@ver" as "jacklika-dsh-x-<ver>.tgz".
  const targets = []
  for (const dir of await readdir(join(root, 'packages'))) {
    if (only.size > 0 && !only.has(dir)) continue
    const manifest = JSON.parse(await readFile(join(root, 'packages', dir, 'package.json'), 'utf8'))
    const name = manifest.name
    if (typeof name !== 'string' || !name.startsWith('@jacklika/dsh-')) continue
    targets.push({ base: dir, name, file: `${name.slice(1).replace('/', '-')}-${manifest.version}.tgz` })
  }

  const pruned = await pruneStaging(staging, artifacts, profile)
  if (pruned.length > 0) console.log(`pruned stale tarballs: ${pruned.join(', ')}`)

  const installed = []
  const tmpBase = await mkdtemp(join(tmpdir(), 'dsh-profile-install-'))
  try {
    for (const { base, name, file } of targets) {
      const local = join(staging, file)
      run('pnpm', ['add', `${name}@file:.connector-packages/${file}`], profile)
      // Resolve the install dir from the manifest name, and refuse to touch
      // anything outside <profile>/node_modules.
      const target = resolve(profile, 'node_modules', ...name.split('/'))
      const nmRoot = resolve(profile, 'node_modules') + sep
      if (!target.startsWith(nmRoot)) throw new Error(`refusing to install outside node_modules: ${target}`)
      // Extract to a temp dir first; only swap in on success so a failed
      // unpack cannot leave the package missing from the profile.
      const unpacked = join(tmpBase, base)
      await mkdir(unpacked, { recursive: true })
      run('tar', ['-xzf', local, '-C', unpacked, '--strip-components=1'], root)
      await replaceDir(unpacked, target, join(tmpBase, `${base}.backup`))
      installed.push({ base, target })
    }
  } finally {
    await rm(tmpBase, { recursive: true, force: true })
  }

  let drift = 0
  for (const { base, target } of installed) {
    const workspaceLib = join(root, 'packages', base, 'lib')
    try {
      await stat(workspaceLib)
    } catch {
      continue // packages without a build step (e.g. memory-mcp) ship src/, not lib/
    }
    const diffs = await diffDirs(join(target, 'lib'), workspaceLib)
    if (diffs.length > 0) {
      drift++
      console.error(`drift in dsh-${base}:\n${diffs.join('\n')}`)
    }
  }
  console.log(`installed ${installed.length} package(s) into ${profile}`)
  if (drift > 0) process.exit(1)
  console.log('installed lib/ matches workspace build')
}

// argv[1] is the invoked path while import.meta.url is the resolved module
// URL; invoking through a symlink makes them differ, so compare realpaths —
// otherwise the script would silently exit 0 having done nothing.
async function invokedAsMain() {
  if (process.argv[1] === undefined) return false
  const invoked = await realpath(process.argv[1]).catch(() => process.argv[1])
  const self = await realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url))
  return invoked === self
}
if (await invokedAsMain()) {
  await main()
}
