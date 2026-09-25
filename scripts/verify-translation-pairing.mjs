import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const writeFlag = process.argv.includes('--write')
const paths = process.argv.slice(2).filter(arg => arg !== '--write')

function hashFile(path) {
  const result = spawnSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    throw new Error(`git hash-object failed for ${path}: ${result.stderr ?? result.error?.message}`)
  }
  return result.stdout.trim()
}

async function* findPairs() {
  if (paths.length > 0) {
    for (const raw of paths) {
      const absolute = resolve(root, raw)
      const dir = dirname(absolute)
      const i18nPath = join(dir, 'README.i18n.yaml')
      yield { dir, i18nPath }
    }
  } else {
    const packagesRoot = join(root, 'packages')
    for (const name of await readdir(packagesRoot)) {
      const dir = join(packagesRoot, name)
      const i18nPath = join(dir, 'README.i18n.yaml')
      yield { dir, i18nPath }
    }
  }
}

function parseHashes(text) {
  const hashes = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^(README(?:\.\w+)?\.md):\s*([0-9a-f]{40})$/.exec(line)
    if (match) hashes[match[1]] = match[2]
  }
  return hashes
}

function replaceHashes(text, hashes) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(README(?:\.\w+)?\.md):\s*([0-9a-f]{40})$/.exec(lines[i])
    if (match && hashes[match[1]] !== undefined) {
      lines[i] = `${match[1]}: ${hashes[match[1]]}`
    }
  }
  return lines.join('\n')
}

let failed = false
for await (const { dir, i18nPath } of findPairs()) {
  let text
  try {
    text = await readFile(i18nPath, 'utf8')
  } catch (error) {
    if ((error?.code ?? '') === 'ENOENT') continue
    throw error
  }
  const recorded = parseHashes(text)
  const enPath = join(dir, 'README.md')
  const zhPath = join(dir, 'README.zh.md')
  const actual = { 'README.md': hashFile(enPath), 'README.zh.md': hashFile(zhPath) }
  const mismatched = []
  for (const file of Object.keys(actual)) {
    if (recorded[file] !== actual[file]) mismatched.push(file)
  }
  if (mismatched.length === 0) {
    process.stdout.write(`${dir}: bilingual READMEs match recorded hashes\n`)
    continue
  }
  if (writeFlag) {
    const updated = replaceHashes(text, actual)
    await writeFile(i18nPath, updated)
    process.stdout.write(`${dir}: re-recorded hashes for ${mismatched.join(', ')}\n`)
  } else {
    failed = true
    for (const file of mismatched) {
      process.stderr.write(`${dir}/${file}: hash drift (recorded ${recorded[file]}, actual ${actual[file]})\n`)
    }
  }
}

if (failed) process.exit(1)
