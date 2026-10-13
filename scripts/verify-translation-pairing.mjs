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

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

const fenceOpen = /^\s*(`{3,}|~{3,})(.*)$/
const tableSeparator = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function hasCjk(text) {
  return CJK.test(text)
}

/**
 * Code spans that name an API rather than a concept: tool and parameter names,
 * package names, dotted property paths. These must survive translation verbatim
 * even though ordinary code spans (translated prose, placeholder examples)
 * legitimately differ between the two languages.
 */
function isApiToken(span) {
  if (/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(span)) return true
  if (/^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/.test(span)) return true
  if (/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(span)) return true
  return /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(span)
}

function countColumns(row) {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  if (trimmed.trim() === '') return 0
  return trimmed.split(/(?<!\\)\|/).length
}

/**
 * Split a Markdown document into the structures a translation must preserve:
 * heading levels, fenced blocks, table shapes, inline code spans, and link
 * targets. Fenced content is captured verbatim so an untranslated block can be
 * compared byte for byte.
 */
function analyzeMarkdown(text) {
  const lines = text.split(/\r?\n/)
  const headings = []
  const fences = []
  const tables = []
  const inlineCode = new Map()
  const links = new Set()
  let fence = null

  const recordInline = (line) => {
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      const span = match[1].trim()
      inlineCode.set(span, (inlineCode.get(span) ?? 0) + 1)
    }
    for (const match of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].replace(/#.*$/, '').replace(/\.zh\.md$/, '.md')
      if (target !== '') links.add(target)
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fenceMatch = fenceOpen.exec(line)
    if (fenceMatch) {
      if (fence === null) {
        fence = { marker: fenceMatch[1][0], size: fenceMatch[1].length, info: fenceMatch[2].trim(), content: [] }
      } else if (fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.size && fenceMatch[2].trim() === '') {
        fences.push({ info: fence.info, content: fence.content.join('\n') })
        fence = null
      } else {
        fence.content.push(line)
      }
      continue
    }
    if (fence !== null) {
      fence.content.push(line)
      continue
    }

    const headingMatch = /^(#{1,6})\s+/.exec(line)
    if (headingMatch) headings.push(headingMatch[1].length)

    if (line.includes('|') && i + 1 < lines.length && tableSeparator.test(lines[i + 1])) {
      const shape = [countColumns(line)]
      let row = i + 2
      while (row < lines.length && lines[row].includes('|') && lines[row].trim() !== '') {
        shape.push(countColumns(lines[row]))
        row += 1
      }
      tables.push(shape)
      i = row - 1
      continue
    }

    recordInline(line)
  }

  if (fence !== null) fences.push({ info: fence.info, content: fence.content.join('\n') })

  return { headings, fences, tables, inlineCode, links }
}

/** Compare the structures both sides must share; returns human-readable issues. */
function compareStructure(enText, zhText) {
  const en = analyzeMarkdown(enText)
  const zh = analyzeMarkdown(zhText)
  const issues = []

  if (!hasCjk(zhText)) issues.push('ZH side contains no CJK characters')

  if (en.headings.join(',') !== zh.headings.join(',')) {
    issues.push(`heading level sequence differs (EN [${en.headings.join(',')}] vs ZH [${zh.headings.join(',')}])`)
  }

  if (en.fences.length !== zh.fences.length) {
    issues.push(`fenced block count differs (EN ${en.fences.length} vs ZH ${zh.fences.length})`)
  } else {
    en.fences.forEach((fence, index) => {
      const counterpart = zh.fences[index]
      if (fence.info !== counterpart.info) {
        issues.push(`fence #${index + 1} info string differs (EN "${fence.info}" vs ZH "${counterpart.info}")`)
      } else if (!hasCjk(fence.content) && !hasCjk(counterpart.content) && fence.content !== counterpart.content) {
        issues.push(`fence #${index + 1} (${fence.info || 'plain'}) content differs while neither side is localized`)
      }
    })
  }

  if (en.tables.length !== zh.tables.length) {
    issues.push(`table count differs (EN ${en.tables.length} vs ZH ${zh.tables.length})`)
  } else {
    en.tables.forEach((shape, index) => {
      const counterpart = zh.tables[index]
      if (shape.length !== counterpart.length || shape.some((columns, row) => columns !== counterpart[row])) {
        issues.push(`table #${index + 1} shape differs (EN [${shape.join(',')}] vs ZH [${counterpart.join(',')}])`)
      }
    })
  }

  const missingSpans = [...en.inlineCode.keys()].filter(span => isApiToken(span) && !zh.inlineCode.has(span))
  const extraSpans = [...zh.inlineCode.keys()].filter(span => isApiToken(span) && !en.inlineCode.has(span))
  if (missingSpans.length > 0 || extraSpans.length > 0) {
    const parts = []
    if (missingSpans.length > 0) parts.push(`EN-only [${missingSpans.slice(0, 5).join(', ')}]`)
    if (extraSpans.length > 0) parts.push(`ZH-only [${extraSpans.slice(0, 5).join(', ')}]`)
    issues.push(`API names differ (${parts.join('; ')})`)
  }

  const missingLinks = [...en.links].filter(link => !zh.links.has(link))
  const extraLinks = [...zh.links].filter(link => !en.links.has(link))
  if (missingLinks.length > 0 || extraLinks.length > 0) {
    const parts = []
    if (missingLinks.length > 0) parts.push(`EN-only [${missingLinks.slice(0, 5).join(', ')}]`)
    if (extraLinks.length > 0) parts.push(`ZH-only [${extraLinks.slice(0, 5).join(', ')}]`)
    issues.push(`link targets differ (${parts.join('; ')})`)
  }

  return issues
}

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

    const enText = await readFile(enPath, 'utf8')
    const zhText = await readFile(zhPath, 'utf8')
    const issues = compareStructure(enText, zhText)
    if (issues.length > 0) {
      failed = true
      for (const issue of issues) {
        process.stderr.write(`${scope}/${enFile} ↔ ${zhFile}: ${issue}\n`)
      }
      continue
    }

    const actualEn = hashFile(enPath)
    const actualZh = hashFile(zhPath)
    const drifted = []
    if (enRecord.hash !== actualEn) drifted.push(enFile)
    if (zhRecord.hash !== actualZh) drifted.push(zhFile)

    if (drifted.length === 0) {
      process.stdout.write(`${scope}: ${enFile} ↔ ${zhFile} match recorded hashes and structure\n`)
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
      process.stdout.write(`${scope}: structure OK, re-recorded hashes for ${drifted.join(', ')}\n`)
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
