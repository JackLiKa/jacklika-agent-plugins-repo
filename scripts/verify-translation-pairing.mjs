import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..')
const writeFlag = process.argv.includes('--write')
const explicitPaths = process.argv.slice(2).filter(arg => arg !== '--write')

function hashFile(path) {
  const result = spawnSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    throw new Error(`git hash-object failed for ${path}: ${result.stderr ?? result.error?.message}`)
  }
  return result.stdout.trim()
}

/** Parse `<filename>: <sha1>` entries from an i18n record. */
function parseHashes(text) {
  const hashes = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([\w./-]+\.md):\s*([0-9a-f]{40})$/.exec(line)
    if (match) hashes[match[1]] = match[2]
  }
  return hashes
}

function replaceHashes(text, hashes) {
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([\w./-]+\.md):\s*([0-9a-f]{40})$/.exec(lines[i])
    if (match && hashes[match[1]] !== undefined) {
      lines[i] = `${match[1]}: ${hashes[match[1]]}`
    }
  }
  return lines.join('\n')
}

async function* walkZhMdFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
      yield* walkZhMdFiles(join(dir, entry.name))
    } else if (entry.name.endsWith('.zh.md')) {
      yield join(dir, entry.name)
    }
  }
}

async function* walkI18nFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
      yield* walkI18nFiles(join(dir, entry.name))
    } else if (entry.name === 'i18n.yaml') {
      yield join(dir, entry.name)
    }
  }
}

function baseName(zhFile) {
  return basename(zhFile, '.zh.md')
}

function posixPath(absolutePath) {
  return relative(root, absolutePath).replace(/\\/g, '/')
}

async function main() {
  // Load every recorded hash from every i18n.yaml record.
  const records = new Map() // key -> { i18nPath, file, hash }
  const i18nFiles = explicitPaths.length > 0
    ? explicitPaths.map(p => resolve(root, p))
    : await Array.fromAsync(walkI18nFiles(root))

  for (const i18nPath of i18nFiles) {
    const dir = dirname(i18nPath)
    const text = await readFile(i18nPath, 'utf8')
    const hashes = parseHashes(text)
    for (const [file, hash] of Object.entries(hashes)) {
      records.set(posixPath(join(dir, file)), { i18nPath, file, hash })
    }
  }

  // Discover every *.zh.md and its English counterpart.
  const zhFiles = explicitPaths.length > 0
    ? explicitPaths.map(p => resolve(root, p))
    : await Array.fromAsync(walkZhMdFiles(root))

  let failed = false
  const updatesByI18n = new Map() // i18nPath -> { text, hashes }

  for (const zhPath of zhFiles) {
    const dir = dirname(zhPath)
    const base = baseName(zhPath)
    const zhFile = `${base}.zh.md`
    const enFile = `${base}.md`
    const enPath = join(dir, enFile)
    const zhKey = posixPath(zhPath)
    const enKey = posixPath(enPath)

    const zhRecord = records.get(zhKey)
    const enRecord = records.get(enKey)
    if (!enRecord || !zhRecord || enRecord.i18nPath !== zhRecord.i18nPath) {
      failed = true
      process.stderr.write(`${relative(root, dir)}: bilingual pair ${enFile} ↔ ${zhFile} is not guarded by an i18n.yaml record\n`)
      continue
    }

    const i18nPath = enRecord.i18nPath
    const actualEn = hashFile(enPath)
    const actualZh = hashFile(zhPath)
    const drifted = []
    if (enRecord.hash !== actualEn) drifted.push(enFile)
    if (zhRecord.hash !== actualZh) drifted.push(zhFile)

    if (drifted.length === 0) {
      process.stdout.write(`${relative(root, dir)}: ${enFile} ↔ ${zhFile} match recorded hashes\n`)
      continue
    }

    if (writeFlag) {
      let entry = updatesByI18n.get(i18nPath)
      if (!entry) {
        entry = { text: await readFile(i18nPath, 'utf8'), hashes: {} }
        updatesByI18n.set(i18nPath, entry)
      }
      if (enRecord.hash !== actualEn) entry.hashes[enFile] = actualEn
      if (zhRecord.hash !== actualZh) entry.hashes[zhFile] = actualZh
      process.stdout.write(`${relative(root, dir)}: re-recorded hashes for ${drifted.join(', ')}\n`)
    } else {
      failed = true
      if (enRecord.hash !== actualEn) {
        process.stderr.write(`${relative(root, dir)}/${enFile}: hash drift (recorded ${enRecord.hash}, actual ${actualEn})\n`)
      }
      if (zhRecord.hash !== actualZh) {
        process.stderr.write(`${relative(root, dir)}/${zhFile}: hash drift (recorded ${zhRecord.hash}, actual ${actualZh})\n`)
      }
    }
  }

  if (writeFlag) {
    for (const [i18nPath, { text, hashes }] of updatesByI18n) {
      const updated = replaceHashes(text, hashes)
      await writeFile(i18nPath, updated)
    }
  }

  if (failed) process.exit(1)
}

await main()
