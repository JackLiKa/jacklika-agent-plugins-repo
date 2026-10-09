#!/usr/bin/env node
/**
 * Local DeepSeek Harness desk compatibility smoke test.
 *
 * Extracts the `dsh` CLI from the installed desk app.asar, creates a temporary
 * profile, installs the Bundle, and verifies `--dump-config` contains the
 * plugin ids that Bundle's own patch enables: a local Bundle path supplies its
 * patch, a registry spec needs `--patch` to name one.
 *
 * macOS is fully supported and tested. Windows paths can be supplied via the
 * DSH_DESK_NODE, DSH_DESK_NODE_BIN, and DSH_DESK_PNPM environment variables.
 *
 * Example (macOS):
 *   node scripts/desk-smoke.mjs \
 *     --desk-app "/Applications/DeepSeek Harness.app" \
 *     --bundle "/Users/user/Dev/github/jacklika-agent-plugins-repo/packages/memory" \
 *     --profile desk-smoke
 *
 * Example (adapter bundle):
 *   node scripts/desk-smoke.mjs \
 *     --desk-app "/Applications/DeepSeek Harness.app" \
 *     --bundle "/Users/user/Dev/github/jacklika-agent-plugins-repo/packages/devin-bridge" \
 *     --profile desk-smoke-devin
 *
 * Example (npm bundle):
 *   node scripts/desk-smoke.mjs \
 *     --desk-app "/Applications/DeepSeek Harness.app" \
 *     --bundle "@jacklika/dsh-memory@0.1.7-rc.10" \
 *     --patch "/Users/user/Dev/github/jacklika-agent-plugins-repo/packages/memory/cordis.patch.yml" \
 *     --profile desk-smoke
 */

import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { assertProfileResolution } from './profile-resolution.mjs'

const argv = process.argv.slice(2)

function arg(name, fallback) {
  const idx = argv.indexOf(name)
  if (idx >= 0 && argv[idx + 1] !== undefined) return argv[idx + 1]
  return fallback
}

function flag(name) {
  return argv.includes(name)
}

const deskApp = arg('--desk-app', process.env.DSH_DESK_APP) ?? defaultDeskApp()
const bundleSpec = arg('--bundle', process.env.DSH_BUNDLE_SPEC) ?? defaultBundlePath()
const patchSpec = arg('--patch', process.env.DSH_PATCH)
const profileName = arg('--profile', process.env.DSH_PROFILE_NAME) ?? 'desk-smoke'
const keep = flag('--keep') || process.env.DSH_KEEP_TEMP === '1'

function defaultDeskApp() {
  if (process.platform === 'darwin') return '/Applications/DeepSeek Harness.app'
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')
  throw new Error(`Unsupported platform: ${process.platform}; set --desk-app or DSH_DESK_APP`)
}

function defaultBundlePath() {
  const root = resolve(import.meta.dirname, '..')
  return join(root, 'packages', 'memory')
}

/**
 * Locate the patch whose insert rows define the expected plugin ids. A local
 * Bundle directory carries its own patch; a registry spec cannot be inspected
 * before installation, so it must be named with `--patch`.
 */
async function resolvePatchPath() {
  if (patchSpec !== undefined) return resolve(patchSpec)
  const candidate = join(resolve(bundleSpec), 'cordis.patch.yml')
  try {
    await readFile(candidate, 'utf8')
  } catch {
    fail(`--bundle ${bundleSpec} is not a local Bundle directory; pass --patch <cordis.patch.yml>`)
  }
  return candidate
}

/**
 * Read a Bundle patch and return the plugin ids it inserts, in patch order.
 * `enabled` drops rows marked `disabled: true`; `all` keeps them, because a
 * disabled row must still reach the effective config so the profile layer can
 * re-enable it. Reading the ids from the patch under test keeps this script in
 * sync with every Bundle, so a newly-added row cannot silently disappear from
 * the strongest end-to-end check.
 */
async function patchPluginIds(patchPath) {
  const text = await readFile(patchPath, 'utf8')
  const lines = text.split(/\r?\n/)
  const enabled = []
  const all = []
  let inInsert = false
  let insertIndent = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trimStart()
    const indent = line.length - trimmed.length
    if (trimmed.startsWith('- insert:')) {
      inInsert = true
      insertIndent = indent
      continue
    }
    if (!inInsert) continue
    if (indent <= insertIndent && trimmed !== '') {
      inInsert = false
      continue
    }
    const match = /^\s*- id:\s*(\S+)/.exec(line)
    if (match) {
      const id = match[1]
      let disabled = false
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? ''
        const nextTrimmed = next.trimStart()
        const nextIndent = next.length - nextTrimmed.length
        if (nextTrimmed === '' || nextIndent <= indent) break
        if (nextTrimmed === 'disabled: true') {
          disabled = true
          break
        }
      }
      all.push(id)
      if (!disabled) enabled.push(id)
    }
  }
  return { enabled, all }
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    fail(`command failed: ${command} ${args.join(' ')}`)
  }
  return result.stdout ?? ''
}

function detectDeskPaths() {
  const absolute = resolve(deskApp)
  if (process.platform === 'darwin') {
    return {
      app: absolute,
      nodeWrapper: join(absolute, 'Contents', 'Resources', 'runtime', 'bin', 'node'),
      nodeBin: join(absolute, 'Contents', 'Resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node'),
      pnpmBin: join(absolute, 'Contents', 'Resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
      appAsar: join(absolute, 'Contents', 'Resources', 'app.asar'),
      cliRel: join('dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    }
  }
  if (process.platform === 'win32') {
    return {
      app: absolute,
      nodeWrapper: process.env.DSH_DESK_NODE ?? join(absolute, 'resources', 'runtime', 'bin', 'node'),
      nodeBin: process.env.DSH_DESK_NODE_BIN ?? join(absolute, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'node.exe'),
      pnpmBin: process.env.DSH_DESK_PNPM ?? join(absolute, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
      appAsar: join(absolute, 'resources', 'app.asar'),
      cliRel: join('dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    }
  }
  throw new Error(`Unsupported platform: ${process.platform}`)
}

function extractAsar(archive, dest) {
  // Prefer a locally installed extractor, then fall back to npx.
  for (const pkgName of ['@electron/asar', 'asar']) {
    const result = spawnSync(process.execPath, ['-e', `
      const { extractAll } = require('${pkgName}');
      extractAll('${archive.replace(/'/g, "\\'")}', '${dest.replace(/'/g, "\\'")}');
      console.log('ok');
    `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (result.status === 0 && (result.stdout ?? '').trim() === 'ok') return
  }

  const npx = spawnSync('npx', ['@electron/asar', 'extract', archive, dest], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (npx.status === 0) return

  fail('asar extraction failed; install with: npm i -g @electron/asar')
}

const paths = detectDeskPaths()

const scratch = await mkdtemp(join(tmpdir(), 'dsh-desk-smoke-'))
const extractDir = join(scratch, 'app-asar')
const homeDir = join(scratch, 'dsh-home')
const workspaceDir = join(scratch, 'workspace')
const binDir = join(scratch, 'bin')

try {
  if (!deskApp) fail('missing --desk-app or DSH_DESK_APP')
  if (!bundleSpec) fail('missing --bundle or DSH_BUNDLE_SPEC')

  await mkdir(extractDir, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  await mkdir(binDir, { recursive: true })

  extractAsar(paths.appAsar, extractDir)

  const cliPath = join(extractDir, paths.cliRel)
  const relativeCli = relative(binDir, cliPath).split(sep).join('/')

  // Build a pnpm shim that uses the desk runtime wrapper. The wrapper reads
  // DSH_DESKTOP_NODE_EXECUTABLE to find the real Node binary.
  if (process.platform === 'win32') {
    const shim = join(binDir, 'pnpm.bat')
    await writeFile(shim, `@echo off\nset DSH_DESKTOP_NODE_EXECUTABLE=${paths.nodeBin}\n"${paths.nodeWrapper}" "${paths.pnpmBin}" %*\n`)
  } else {
    const shim = join(binDir, 'pnpm')
    await writeFile(shim, `#!/bin/sh\nexport DSH_DESKTOP_NODE_EXECUTABLE="${paths.nodeBin}"\nexec "${paths.nodeWrapper}" "${paths.pnpmBin}" "$@"\n`)
    await chmod(shim, 0o755)
  }

  const baseEnv = {
    DSH_DESKTOP_NODE_EXECUTABLE: paths.nodeBin,
    DSH_HOME: homeDir,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
  }

  // dsh CLI is executed via the desk Node wrapper, which also needs the
  // DSH_DESKTOP_NODE_EXECUTABLE pointer.
  const dshRunner = (args) => run(paths.nodeWrapper, [relativeCli, ...args], binDir, baseEnv)

  // Initialize profile.
  dshRunner(['plugin', '--profile', profileName, 'root'])

  // Install the Bundle.
  dshRunner(['plugin', '--profile', profileName, 'add', bundleSpec])

  // Verify dump-config.
  const dumped = dshRunner(['--profile', profileName, '--dump-config'])
  const { enabled, all } = await patchPluginIds(await resolvePatchPath())
  for (const id of all) {
    if (!dumped.includes(`id: ${id}`)) fail(`dump-config missing ${id}`)
  }
  // The patch order is part of the waterfall contract; verify it is preserved.
  const positions = enabled.map(id => dumped.indexOf(`id: ${id}`))
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] <= positions[i - 1]) fail(`dump-config order wrong for ${enabled[i]}`)
  }
  if (dumped.toLowerCase().includes('incompatible')) fail('compatibility warning found in dump-config')

  // dump-config proves the plugins registered; this proves which copy of each
  // package they registered from, and that the desk install kept exactly one.
  const profileDir = join(homeDir, 'profiles', profileName)
  try {
    const resolution = assertProfileResolution(profileDir, paths.nodeWrapper, [], {
      DSH_DESKTOP_NODE_EXECUTABLE: paths.nodeBin,
    })
    process.stdout.write(`resolved ${resolution.checked.length} @jacklika packages: ${Object.entries(resolution.versions).map(([name, version]) => `${name}@${version}`).join(', ')}\n`)
  } catch (error) {
    fail(`resolution check failed: ${error?.message ?? error}`)
  }

  process.stdout.write(`desk smoke test passed on ${process.platform} for ${bundleSpec}\n`)
} finally {
  if (!keep) {
    await rm(scratch, { recursive: true, force: true })
  } else {
    process.stdout.write(`kept temp directory: ${scratch}\n`)
  }
}
