import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
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

function pairName(file) {
  if (file.endsWith('.zh.md')) return file.slice(0, -'.zh.md'.length)
  if (file.endsWith('.md')) return file.slice(0, -'.md'.length)
  return file
}

async function* walkI18nFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue
      yield* walkI18nFiles(join(dir, entry.name))
    } else if (entry.name.endsWith('.i18n.yaml')) {
      yield join(dir, entry.name)
    }
  }
}

async function listPairs(scopeDir, enSuffix, zhSuffix) {
  const pairs = []
  const entries = await readdir(scopeDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(scopeDir, entry.name)
    const enPath = join(dir, enSuffix)
    const zhPath = join(dir, zhSuffix)
    const hasEn = await fileExists(enPath)
    const hasZh = await fileExists(zhPath)
    if (hasEn || hasZh) {
      pairs.push({ dir, hasEn, hasZh })
    }
  }
  return pairs
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error?.code ?? '') === 'ENOENT') return false
    throw error
  }
}

async function guardedPairs() {
  let failed = false
  const i18nFiles = explicitPaths.length > 0
    ? explicitPaths.map(p => resolve(root, p))
    : await Array.fromAsync(walkI18nFiles(root))

  for (const i18nPath of i18nFiles) {
    const dir = dirname(i18nPath)
    let text = await readFile(i18nPath, 'utf8')
    const recorded = parseHashes(text)
    const pairs = new Map()
    for (const file of Object.keys(recorded)) {
      const base = pairName(file)
      if (!pairs.has(base)) pairs.set(base, [])
      pairs.get(base).push(file)
    }

    for (const [base, files] of pairs) {
      if (files.length !== 2) {
        failed = true
        process.stderr.write(`${i18nPath}: pair "${base}" has ${files.length} side(s) (${files.join(', ')}); expected exactly 2\n`)
        continue
      }
      const zhFile = files.find(f => f.endsWith('.zh.md'))
      const enFile = files.find(f => f !== zhFile)
      if (!enFile || !zhFile) {
        failed = true
        process.stderr.write(`${i18nPath}: pair "${base}" must contain one .md and one .zh.md (${files.join(', ')})\n`)
        continue
      }
      const enPath = join(dir, enFile)
      const zhPath = join(dir, zhFile)
      const actual = { [enFile]: hashFile(enPath), [zhFile]: hashFile(zhPath) }
      const mismatched = []
      for (const file of files) {
        if (recorded[file] !== actual[file]) mismatched.push(file)
      }
      if (mismatched.length === 0) {
        process.stdout.write(`${relative(root, dir)}: ${enFile} ↔ ${zhFile} match recorded hashes\n`)
        continue
      }
      if (writeFlag) {
        text = replaceHashes(text, actual)
        await writeFile(i18nPath, text)
        process.stdout.write(`${relative(root, dir)}: re-recorded hashes for ${mismatched.join(', ')}\n`)
      } else {
        failed = true
        for (const file of mismatched) {
          process.stderr.write(`${relative(root, dir)}/${file}: hash drift (recorded ${recorded[file]}, actual ${actual[file]})\n`)
        }
      }
    }
  }

  return { failed }
}

async function unguardedPairs() {
  let failed = false
  // Package README pairs.
  const packagesRoot = join(root, 'packages')
  const packagePairs = await listPairs(packagesRoot, 'README.md', 'README.zh.md')
  for (const { dir, hasEn, hasZh } of packagePairs) {
    const i18nPath = join(dir, 'README.i18n.yaml')
    if (!hasEn || !hasZh || !await fileExists(i18nPath)) {
      failed = true
      process.stderr.write(`${relative(root, dir)}: unguarded bilingual README pair (${hasEn ? 'EN' : 'missing EN'}, ${hasZh ? 'ZH' : 'missing ZH'}, i18n=${await fileExists(i18nPath) ? 'yes' : 'no'})\n`)
    }
  }

  // Docs page pairs.
  const docsDir = join(root, 'docs')
  const docsEntries = await readdir(docsDir)
  const zhPages = new Set(docsEntries.filter(name => name.endsWith('.zh.md')))
  for (const name of docsEntries) {
    if (!name.endsWith('.md') || name.endsWith('.zh.md') || name.endsWith('.i18n.yaml')) continue
    const zhName = `${pairName(name)}.zh.md`
    if (!zhPages.has(zhName)) {
      failed = true
      process.stderr.write(`docs/${name}: missing Chinese pair docs/${zhName}\n`)
      continue
    }
  }
  const i18nPath = join(docsDir, 'docs.i18n.yaml')
  if (!await fileExists(i18nPath)) {
    failed = true
    process.stderr.write(`docs/: missing docs/docs.i18n.yaml for bilingual page pairs\n`)
  }

  return failed
}

const { failed: guardFailed } = await guardedPairs()
const unguardFailed = await unguardedPairs()

if (guardFailed || unguardFailed) process.exit(1)
