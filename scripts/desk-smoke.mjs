#!/usr/bin/env node
/**
 * Local DeepSeek Harness desk compatibility smoke test.
 *
 * Extracts the `dsh` CLI from the installed desk app.asar, creates a temporary
 * profile, installs the Bundle, and verifies `--dump-config` contains the
 * expected plugin ids.
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
 * Example (npm bundle):
 *   node scripts/desk-smoke.mjs \
 *     --desk-app "/Applications/DeepSeek Harness.app" \
 *     --bundle "@jacklika/dsh-memory@0.1.7-rc.9" \
 *     --profile desk-smoke
 */

import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

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

function patchRoot() {
  return resolve(import.meta.dirname, '..')
}

/**
 * Read the Bundle patch and return the ordered list of enabled plugin ids it
 * inserts. Keeps verification scripts in sync with the patch so a newly-added
 * row cannot silently disappear from the strongest end-to-end checks.
 */
async function expectedEnabledPluginIds(patchPath) {
  const text = await readFile(patchPath, 'utf8')
  const lines = text.split(/\r?\n/)
  const ids = []
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
      if (!disabled) ids.push(id)
    }
  }
  return ids
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
  const expectedIds = await expectedEnabledPluginIds(join(patchRoot(), 'packages', 'memory', 'cordis.patch.yml'))
  for (const id of expectedIds) {
    if (!dumped.includes(`id: ${id}`)) fail(`dump-config missing ${id}`)
  }
  // The patch order is part of the waterfall contract; verify it is preserved.
  const positions = expectedIds.map(id => dumped.indexOf(`id: ${id}`))
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] <= positions[i - 1]) fail(`dump-config order wrong for ${expectedIds[i]}`)
  }
  if (!dumped.includes('id: tool-memory-vector')) fail('dump-config missing tool-memory-vector')
  if (dumped.toLowerCase().includes('incompatible')) fail('compatibility warning found in dump-config')

  process.stdout.write(`desk smoke test passed on ${process.platform}\n`)
} finally {
  if (!keep) {
    await rm(scratch, { recursive: true, force: true })
  } else {
    process.stdout.write(`kept temp directory: ${scratch}\n`)
  }
}
