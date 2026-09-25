import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(tmpdir(), 'mydsh-profile-'))
const tarballs = join(scratch, 'tarballs')
const cliRoot = join(scratch, 'cli')
const home = join(scratch, 'home')
const workspace = join(scratch, 'workspace')
const profile = 'memory-e2e'
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const dsh = join(cliRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
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

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home, PATH: `${join(cliRoot, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
  return result.stdout ?? ''
}

function runShell(command, args, cwd, extraEnv = {}) {
  if (process.platform === 'win32') {
    const cmd = [command, ...args.map(a => JSON.stringify(a))].join(' ')
    const result = spawnSync(cmd, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: home, PATH: `${join(cliRoot, 'node_modules', '.bin')}${delimiter}${process.env.PATH ?? ''}`, ...extraEnv },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.status !== 0) {
      process.stderr.write(result.stdout ?? '')
      process.stderr.write(result.stderr ?? '')
      process.exit(result.status ?? 1)
    }
    return result.stdout ?? ''
  }
  return run(command, args, cwd, extraEnv)
}

try {
  await Promise.all([mkdir(tarballs), mkdir(cliRoot), mkdir(workspace)])
  run(process.execPath, [join(root, 'scripts', 'pack-all.mjs'), tarballs], root)
  await writeFile(join(cliRoot, 'package.json'), '{"name":"dsh-profile-smoke","private":true}\n')
  await writeFile(join(cliRoot, 'pnpm-workspace.yaml'), [
    'autoInstallPeers: true',
    'allowBuilds:',
    "  '@deepseek-ai/dsh-subprocess-local': true",
    "  '@google/genai': false",
    '  koffi: true',
    '  node-pty: true',
    '  protobufjs: false',
    '',
  ].join('\n'))
  runShell(pnpm, ['add', '@deepseek-ai/dsh@0.1.7-rc.2'], cliRoot)
  runShell(dsh, ['plugin', '--profile', profile, 'root'], workspace)

  const files = (await readdir(tarballs)).filter(file => file.endsWith('.tgz'))
  const packageSpecs = new Map()
  for (const file of files) {
    const path = join(tarballs, file)
    const result = run(tar, ['-xOf', tarPath(path), 'package/package.json'], root)
    packageSpecs.set(JSON.parse(result).name, `file:${path}`)
  }
  const profileDir = join(home, 'profiles', profile)
  const overrides = [...packageSpecs].map(([name, spec]) => `  '${name}': '${spec.replaceAll("'", "''")}'`).join('\n')
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\noverrides:\n${overrides}\n`)
  const bundleSpec = packageSpecs.get('@jacklika/dsh-memory')
  if (bundleSpec === undefined) throw new Error('bundle tarball missing')
  runShell(dsh, ['plugin', '--profile', profile, 'add', bundleSpec], workspace)

  const manifestPath = join(profileDir, 'package.json')
  const installed = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (installed.dependencies?.['@jacklika/dsh-memory'] === undefined) throw new Error('bundle dependency missing')
  if (Object.keys(installed.dependencies ?? {}).some(name => name !== '@jacklika/dsh-memory')) {
    throw new Error('profile must install only the Bundle as a direct dependency')
  }
  const bundles = installed.dsh?.profile?.bundles ?? []
  const base = bundles.indexOf('@deepseek-ai/dsh-base')
  const memory = bundles.indexOf('@jacklika/dsh-memory')
  if (base < 0 || memory <= base) throw new Error('memory bundle must follow dsh-base')
  const expectedIds = ['memory-scope', 'memory-queue', 'memory-git', 'tool-memory-filesystem', 'tool-memory-graph']
  const dumped = runShell(dsh, ['--profile', profile, '--dump-config'], workspace)
  for (const id of expectedIds) {
    if (!dumped.includes(`id: ${id}`)) throw new Error(`dump-config missing ${id}`)
  }

  installed.dsh.profile.bundles = bundles.filter(name => name !== '@jacklika/dsh-memory')
  await writeFile(manifestPath, JSON.stringify(installed, undefined, 2) + '\n')
  const disabled = runShell(dsh, ['--profile', profile, '--dump-config'], workspace)
  if (expectedIds.some(id => disabled.includes(`id: ${id}`))) throw new Error('disabled Bundle still contributes config')
  installed.dsh.profile.bundles.push('@jacklika/dsh-memory')
  await writeFile(manifestPath, JSON.stringify(installed, undefined, 2) + '\n')
  const enabled = runShell(dsh, ['--profile', profile, '--dump-config'], workspace)
  if (expectedIds.some(id => !enabled.includes(`id: ${id}`))) throw new Error('re-enabled Bundle is incomplete')

  const vault = join(workspace, '.dsh', 'memory')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, 'preserved.md'), 'preserve on uninstall\n')
  runShell(dsh, ['plugin', '--profile', profile, 'remove', '@jacklika/dsh-memory'], workspace)
  const removed = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (removed.dependencies?.['@jacklika/dsh-memory'] !== undefined) throw new Error('bundle dependency remains after uninstall')
  if ((removed.dsh?.profile?.bundles ?? []).includes('@jacklika/dsh-memory')) throw new Error('bundle remains enabled after uninstall')
  await readFile(join(vault, 'preserved.md'), 'utf8')
  process.stdout.write('profile install, dump-config, disable, re-enable, uninstall, and vault preservation verified\n')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
