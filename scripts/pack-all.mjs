import { mkdir, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] ?? join(root, 'artifacts', 'packages'))
const packagesRoot = join(root, 'packages')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
await mkdir(output, { recursive: true })

for (const name of (await readdir(packagesRoot)).sort()) {
  const cwd = join(packagesRoot, name)
  const result = spawnSync(pnpm, ['pack', '--pack-destination', output], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  process.stdout.write(result.stdout)
}
