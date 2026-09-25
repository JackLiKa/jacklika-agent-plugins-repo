import { mkdir, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] ?? join(root, 'artifacts', 'packages'))
const packagesRoot = join(root, 'packages')
await mkdir(output, { recursive: true })

function runPnpm(args, cwd) {
  if (process.platform === 'win32') {
    // pnpm is installed as a shell/batch shim on Windows; spawnSync needs a shell to execute it.
    const command = ['pnpm', ...args.map(a => JSON.stringify(a))].join(' ')
    return spawnSync(command, { cwd, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  return spawnSync('pnpm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

for (const name of (await readdir(packagesRoot)).sort()) {
  const cwd = join(packagesRoot, name)
  const result = runPnpm(['pack', '--pack-destination', output], cwd)
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
  process.stdout.write(result.stdout ?? '')
}
