import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
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

function posixPath(absolutePath) {
  return relative(root, absolutePath).replace(/\\/g, '/')
}

async function* walkMdFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
      yield* walkMdFiles(join(dir, entry.name))
    } else if (entry.name.endsWith('.md')) {
      yield join(dir, entry.name)
    }
  }
}

function languageSuffix(file) {
  if (file.endsWith('.zh.md')) return 'zh'
  if (file.endsWith('.md')) return 'en'
  return undefined
}

function baseName(file) {
  return file.replace(/\.zh\.md$/, '').replace(/\.md$/, '')
}

function enName(base) { return `${base}.md` }
function zhName(base) { return `${base}.zh.md` }

const recordTemplate = `# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each
# side as of the last confirmed-consistent state. Both languages carry equal authority;
# after editing either side, bring the other along and re-record with:
#   pnpm run verify-translation-pairing --write
`

async function loadAllRecords() {
  const records = new Map() // posix file path -> { i18nPath, hash }
  for await (const i18nPath of walkI18nFiles(root)) {
    const dir = dirname(i18nPath)
    const text = await readFile(i18nPath, 'utf8')
    const hashes = parseHashes(text)
    for (const [file, hash] of Object.entries(hashes)) {
      records.set(posixPath(join(dir, file)), { i18nPath, hash })
    }
  }
  return records
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

async function collectBilingualPairs() {
  const groups = new Map() // base name (filename only) -> dir -> { en?: string, zh?: string }
  const scopes = [join(root, 'docs'), join(root, 'packages')]
  const mdFiles = explicitPaths.length > 0
    ? explicitPaths.map(p => resolve(root, p))
    : []

  if (explicitPaths.length > 0) {
    for (const p of mdFiles) {
      const dir = dirname(p)
      const file = posixPath(p).split('/').pop()
      const lang = languageSuffix(file)
      if (lang !== 'en' && lang !== 'zh') continue
      const base = baseName(file)
      const entry = groups.get(`${dir}\n${base}`) ?? {}
      entry[lang] = p
      entry[lang === 'en' ? 'zh' : 'en'] = join(dir, lang === 'en' ? zhName(base) : enName(base))
      groups.set(`${dir}\n${base}`, entry)
    }
  } else {
    for (const scope of scopes) {
      for await (const mdPath of walkMdFiles(scope)) {
        const dir = dirname(mdPath)
        const file = posixPath(mdPath).split('/').pop()
        const lang = languageSuffix(file)
        if (lang !== 'en' && lang !== 'zh') continue
        const base = baseName(file)
        const key = `${dir}\n${base}`
        const entry = groups.get(key) ?? {}
        entry[lang] = mdPath
        groups.set(key, entry)
      }
    }
  }
  return groups
}

async function main() {
  const records = await loadAllRecords()
  const pairs = await collectBilingualPairs()
  let failed = false
  const updatesByI18n = new Map() // i18nPath -> { text, hashes }

  for (const [key, { en: enPath, zh: zhPath }] of pairs) {
    const [dirPart, base] = key.split('\n')
    const dir = dirPart
    const enFile = enName(base)
    const zhFile = zhName(base)
    const scope = posixPath(dir)

    if (!enPath || !zhPath) {
      failed = true
      process.stderr.write(`${scope}: incomplete bilingual pair (${enPath ? 'EN' : 'missing EN'}, ${zhPath ? 'ZH' : 'missing ZH'})\n`)
      continue
    }

    const enKey = posixPath(enPath)
    const zhKey = posixPath(zhPath)
    const enRecord = records.get(enKey)
    const zhRecord = records.get(zhKey)
    const i18nPath = enRecord?.i18nPath ?? zhRecord?.i18nPath
    const expectedI18n = join(dir, 'i18n.yaml')

    if (!enRecord || !zhRecord || enRecord.i18nPath !== zhRecord.i18nPath) {
      failed = true
      process.stderr.write(`${scope}: ${enFile} ↔ ${zhFile} is not guarded by ${posixPath(expectedI18n)}\n`)
      continue
    }

    const actualEn = hashFile(enPath)
    const actualZh = hashFile(zhPath)
    const drifted = []
    if (enRecord.hash !== actualEn) drifted.push(enFile)
    if (zhRecord.hash !== actualZh) drifted.push(zhFile)

    if (drifted.length === 0) {
      process.stdout.write(`${scope}: ${enFile} ↔ ${zhFile} match recorded hashes\n`)
      continue
    }

    if (writeFlag) {
      let entry = updatesByI18n.get(i18nPath)
      if (!entry) {
        let text
        try {
          text = await readFile(i18nPath, 'utf8')
        } catch (error) {
          if ((error?.code ?? '') === 'ENOENT') {
            text = recordTemplate
          } else {
            throw error
          }
        }
        entry = { text, hashes: {} }
        updatesByI18n.set(i18nPath, entry)
      }
      if (enRecord.hash !== actualEn) entry.hashes[enFile] = actualEn
      if (zhRecord.hash !== actualZh) entry.hashes[zhFile] = actualZh
      process.stdout.write(`${scope}: re-recorded hashes for ${drifted.join(', ')}\n`)
    } else {
      failed = true
      if (enRecord.hash !== actualEn) {
        process.stderr.write(`${scope}/${enFile}: hash drift (recorded ${enRecord.hash}, actual ${actualEn})\n`)
      }
      if (zhRecord.hash !== actualZh) {
        process.stderr.write(`${scope}/${zhFile}: hash drift (recorded ${zhRecord.hash}, actual ${actualZh})\n`)
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
