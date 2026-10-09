import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(tmpdir(), 'dsh-pack-'))
const tarballs = join(scratch, 'tarballs')
const install = join(scratch, 'install')
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'

const tarIsGnu = (() => {
  const result = spawnSync(tar, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return (result.stdout ?? '').includes('GNU tar')
})()

/** Convert a Windows path to POSIX form when GNU tar (e.g. from Git for Windows) is in use. */
function tarPath(absolutePath) {
  if (process.platform !== 'win32' || !tarIsGnu) return absolutePath
  return absolutePath
    .replace(/^[A-Za-z]:[\\/]/, match => `/${match[0].toLowerCase()}/`)
    .replace(/\\/g, '/')
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
  return result.stdout ?? ''
}

function runPnpm(args, cwd) {
  if (process.platform === 'win32') {
    // pnpm is installed as a shell/batch shim on Windows; spawnSync needs a shell to execute it.
    const command = ['pnpm', ...args.map(a => JSON.stringify(a))].join(' ')
    const result = spawnSync(command, { cwd, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (result.status !== 0) {
      process.stderr.write(result.stdout ?? '')
      process.stderr.write(result.stderr ?? '')
      process.exit(result.status ?? 1)
    }
    return result.stdout ?? ''
  }
  return run('pnpm', args, cwd)
}

/** Every workspace member's manifest, keyed by package name. */
async function workspaceMembers() {
  const members = new Map()
  for (const dir of (await readdir(join(root, 'packages'))).sort()) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', dir, 'package.json'), 'utf8'))
    members.set(manifest.name, manifest)
  }
  return members
}

/**
 * The spec pnpm must write into a packed manifest for a `workspace:` range: a
 * bare or `*` protocol pins the member's exact current version, `^`/`~` keep
 * their modifier, and anything else is carried through verbatim.
 * @param {string} range - source specifier starting with `workspace:`.
 * @param {string} version - the referenced member's current version.
 * @returns {string} the portable spec the tarball has to carry.
 */
function expectedWorkspaceSpec(range, version) {
  const suffix = range.slice('workspace:'.length)
  if (suffix === '' || suffix === '*') return version
  if (suffix === '^' || suffix === '~') return `${suffix}${version}`
  return suffix
}

const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']

try {
  await mkdir(tarballs)
  run(process.execPath, [join(root, 'scripts', 'pack-all.mjs'), tarballs], root)
  const files = (await readdir(tarballs)).filter(file => file.endsWith('.tgz')).sort()
  // Derive every expectation from the same source pack-all.mjs packs, so adding
  // or renaming a workspace package cannot leave these checks asserting a stale
  // count or a hardcoded bundle filename.
  const members = await workspaceMembers()
  const bundleManifest = JSON.parse(await readFile(join(root, 'packages', 'memory', 'package.json'), 'utf8'))
  const bundleName = bundleManifest.name
  if (!members.has(bundleName)) throw new Error(`bundle ${bundleName} is not a workspace member`)
  if (files.length !== members.size) throw new Error(`expected ${members.size} tarballs, found ${files.length}`)

  const packageSpecs = new Map()
  let sawBundle = false
  for (const file of files) {
    const path = join(tarballs, file)
    const entries = run(tar, ['-tf', tarPath(path)], root).split(/\r?\n/).filter(Boolean)
    if (!entries.includes('package/package.json')) throw new Error(`${file}: package.json missing`)
    if (entries.some(entry => entry.includes('node_modules') || entry.includes('.env'))) {
      throw new Error(`${file}: forbidden package content`)
    }
    const spec = `file:${path}`
    const manifestText = run(tar, ['-xOf', tarPath(path), 'package/package.json'], root)
    if (/workspace:|link:|\/Users\/[^/]+\/|[A-Za-z]:\\/.test(manifestText)) throw new Error(`${file}: non-portable dependency spec`)
    const manifest = JSON.parse(manifestText)
    const source = members.get(manifest.name)
    if (source === undefined) throw new Error(`${file}: packed unknown workspace member ${manifest.name}`)
    if (manifest.version !== source.version) {
      throw new Error(`${file}: packed version ${manifest.version} does not match the workspace's ${source.version}`)
    }
    if (manifest.name === bundleName) {
      sawBundle = true
      if (!entries.includes('package/cordis.patch.yml')) throw new Error(`${file}: cordis.patch.yml missing`)
    }
    // A `workspace:` range only becomes portable if pnpm rewrote it against the
    // version that member actually has right now; a leftover float or a stale
    // pin installs something other than this checkout.
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, range] of Object.entries(source[field] ?? {})) {
        if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
        const member = members.get(dependency)
        if (member === undefined) throw new Error(`${file}: ${field}.${dependency} is a workspace range but not a member`)
        const expectedSpec = expectedWorkspaceSpec(range, member.version)
        const packedSpec = manifest[field]?.[dependency]
        if (packedSpec !== expectedSpec) {
          throw new Error(`${file}: ${field}.${dependency} packed as ${JSON.stringify(packedSpec)}, expected ${JSON.stringify(expectedSpec)} from ${range}`)
        }
      }
    }
    for (const field of ['main', 'types']) {
      if (typeof manifest[field] === 'string' && !entries.includes(`package/${manifest[field].replace(/^\.\//, '')}`)) {
        throw new Error(`${file}: ${field} target missing`)
      }
    }
    packageSpecs.set(manifest.name, spec)
  }
  if (!sawBundle) throw new Error(`no tarball carried the bundle manifest ${bundleName}`)

  await mkdir(install)
  await writeFile(join(install, 'package.json'), JSON.stringify({ name: 'memory-pack-smoke', private: true }, undefined, 2) + '\n')
  const overrides = [...packageSpecs].map(([name, spec]) => `  '${name}': '${spec.replaceAll("'", "''")}'`).join('\n')
  await writeFile(join(install, 'pnpm-workspace.yaml'), `packages:\n  - '.'\nautoInstallPeers: true\noverrides:\n${overrides}\n`)
  const bundleSpec = packageSpecs.get('@jacklika/dsh-memory')
  const mcpSpec = packageSpecs.get('@jacklika/dsh-memory-mcp')
  if (bundleSpec === undefined || mcpSpec === undefined) throw new Error('entry package tarballs missing')
  runPnpm(['add', '-w', bundleSpec, mcpSpec], install)
  const bundle = JSON.parse(await readFile(join(install, 'node_modules', '@jacklika', 'dsh-memory', 'package.json'), 'utf8'))
  if (bundle.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('installed bundle metadata missing')
  for (const dependency of Object.keys(bundle.dependencies ?? {})) {
    if (!dependency.startsWith('@jacklika/')) continue
    const listed = runPnpm(['list', dependency, '--depth', 'Infinity', '--json'], install)
    if (!listed.includes(dependency)) throw new Error(`${dependency}: installed dependency missing`)
  }
  run(process.execPath, ['--input-type=module', '--eval', "await import('@jacklika/dsh-memory')"], install)
  process.stdout.write(`verified ${files.map(file => basename(file)).join(', ')}\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
