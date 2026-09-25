import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(tmpdir(), 'mydsh-pack-'))
const tarballs = join(scratch, 'tarballs')
const install = join(scratch, 'install')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  return result.stdout
}

try {
  await mkdir(tarballs)
  run(process.execPath, [join(root, 'scripts', 'pack-all.mjs'), tarballs], root)
  const files = (await readdir(tarballs)).filter(file => file.endsWith('.tgz')).sort()
  if (files.length !== 8) throw new Error(`expected 8 tarballs, found ${files.length}`)

  const packageSpecs = new Map()
  for (const file of files) {
    const path = join(tarballs, file)
    const entries = run(tar, ['-tf', path], root).split(/\r?\n/).filter(Boolean)
    if (!entries.includes('package/package.json')) throw new Error(`${file}: package.json missing`)
    if (file.includes('dsh-memory-0.1.7')) {
      if (!entries.includes('package/cordis.patch.yml')) throw new Error(`${file}: cordis.patch.yml missing`)
    }
    if (entries.some(entry => entry.includes('node_modules') || entry.includes('.env'))) {
      throw new Error(`${file}: forbidden package content`)
    }
    const spec = `file:${path}`
    const manifestText = run(tar, ['-xOf', path, 'package/package.json'], root)
    if (/workspace:|link:|\/Users\/[^/]+\/|[A-Za-z]:\\/.test(manifestText)) throw new Error(`${file}: non-portable dependency spec`)
    const manifest = JSON.parse(manifestText)
    for (const field of ['main', 'types']) {
      if (typeof manifest[field] === 'string' && !entries.includes(`package/${manifest[field].replace(/^\.\//, '')}`)) {
        throw new Error(`${file}: ${field} target missing`)
      }
    }
    packageSpecs.set(manifest.name, spec)
  }

  await mkdir(install)
  await writeFile(join(install, 'package.json'), JSON.stringify({ name: 'memory-pack-smoke', private: true }, undefined, 2) + '\n')
  const overrides = [...packageSpecs].map(([name, spec]) => `  '${name}': '${spec.replaceAll("'", "''")}'`).join('\n')
  await writeFile(join(install, 'pnpm-workspace.yaml'), `autoInstallPeers: true\noverrides:\n${overrides}\n`)
  const bundleSpec = packageSpecs.get('@jacklika/dsh-memory')
  const mcpSpec = packageSpecs.get('@jacklika/dsh-memory-mcp')
  if (bundleSpec === undefined || mcpSpec === undefined) throw new Error('entry package tarballs missing')
  run(pnpm, ['add', bundleSpec, mcpSpec], install)
  const bundle = JSON.parse(await readFile(join(install, 'node_modules', '@jacklika', 'dsh-memory', 'package.json'), 'utf8'))
  if (bundle.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('installed bundle metadata missing')
  for (const dependency of Object.keys(bundle.dependencies ?? {})) {
    if (!dependency.startsWith('@jacklika/')) continue
    const listed = run(pnpm, ['list', dependency, '--depth', 'Infinity', '--json'], install)
    if (!listed.includes(dependency)) throw new Error(`${dependency}: installed dependency missing`)
  }
  run(process.execPath, ['--input-type=module', '--eval', "await import('@jacklika/dsh-memory')"], install)
  process.stdout.write(`verified ${files.map(file => basename(file)).join(', ')}\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
