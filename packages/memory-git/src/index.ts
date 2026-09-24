/**
 * Commits successful memory-tool writes to a git repository inside the vault.
 * Mounting this plugin after `@jacklika/dsh-memory-queue` records every
 * matching write — `wiki_write` by default — as one `git add` + `git commit`
 * inside the queue's lock section, giving the vault version history, rollback,
 * and per-write audit without changing the memory tools. When
 * `@jacklika/dsh-memory-scope` rewrites an id first, the commit records the
 * rewritten on-disk path.
 * @module @jacklika/dsh-memory-git
 */

import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { containedPath, resolveMemoryVaultRoot } from '@jacklika/dsh-tool-memory-filesystem'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-git'

/** Services required so the listener registers after the tool registry exists. */
export const inject = ['tools']

const execFileAsync = promisify(execFile)

/** Plugin configuration. */
export interface Config {
  /** Tool names whose successful dispatches are committed. */
  toolNames?: string[]
  /** Argument carrying the vault-relative note id. */
  idArgument?: string
  /**
   * Vault root hosting the git repository. Resolved per call with the same
   * rules as the memory tools: empty selects `<session cwd>/.dsh/memory/`.
   */
  vaultRoot?: string
  /**
   * Only ids under these prefixes are committed. An empty array commits every
   * matching write.
   */
  prefixes?: string[]
  /**
   * How the vault relates to git repositories: `init` gives the vault its own
   * `.git` (created under `autoInit`), never joining an enclosing repo;
   * `inherit` joins the nearest enclosing repo (initializing the vault only
   * when none exists and `autoInit` allows); `own` requires `<vault>/.git`
   * to exist already and fails otherwise.
   */
  nestedRepo?: 'init' | 'inherit' | 'own'
  /** Run `git init` in the vault when the selected `nestedRepo` mode allows it. */
  autoInit?: boolean
  /** Commit author name written into `git -c user.name`. */
  authorName?: string
  /** Commit author email written into `git -c user.email`. */
  authorEmail?: string
  /** Prefix of each generated commit message; the note id follows it. */
  commitPrefix?: string
  /** Retries when `.git/index.lock` is held by another git process. */
  indexLockRetries?: number
  /** Delay between `index.lock` retries. */
  indexLockRetryMs?: number
}

/** Schemastery configuration for the memory git consumer. */
export const Config: z<Config> = z.object({
  toolNames: z.array(z.string()).default(['wiki_write']),
  idArgument: z.string().default('id'),
  vaultRoot: z.string().default(''),
  prefixes: z.array(z.string()).default(['shared/']),
  nestedRepo: z.union(['init', 'inherit', 'own']).default('init'),
  autoInit: z.boolean().default(true),
  authorName: z.string().default('dsh-memory-git'),
  authorEmail: z.string().default('dsh-memory-git@localhost'),
  commitPrefix: z.string().default('wiki_write'),
  indexLockRetries: z.number().default(30),
  indexLockRetryMs: z.number().default(100),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Run a git command inside `vault`, retrying only on a held `index.lock` —
 * the one failure mode another process can trigger without cooperation.
 * @param vault - absolute repository working tree.
 * @param args - git arguments after `-C <vault>`.
 * @param resolved - applied plugin configuration.
 */
async function git(vault: string, args: string[], resolved: ResolvedConfig): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', vault, ...args])
      return stdout
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('index.lock') || attempt >= resolved.indexLockRetries) throw error
      await sleep(resolved.indexLockRetryMs)
    }
  }
}

/**
 * Stage and commit one written note when it differs from `HEAD`. `status`
 * keeps no-op writes from producing empty commits; the commit pathspec limits
 * the record to the written note so concurrent unrelated changes are untouched.
 * @param vault - absolute repository working tree.
 * @param id - vault-relative note id as reported by the tool call.
 * @param resolved - applied plugin configuration.
 */
async function commitWrite(vault: string, id: string, resolved: ResolvedConfig): Promise<void> {
  containedPath(vault, id)
  await mkdir(vault, { recursive: true })
  const hasOwnRepo = await stat(join(vault, '.git')).then(() => true, () => false)
  if (resolved.nestedRepo === 'own' && !hasOwnRepo) {
    throw new Error(`memory-git: ${vault} has no .git and nestedRepo 'own' forbids creating one`)
  }
  if (resolved.nestedRepo === 'init' && !hasOwnRepo) {
    if (!resolved.autoInit) throw new Error(`memory-git: ${vault} has no .git and autoInit is off`)
    await git(vault, ['init'], resolved)
  }
  if (resolved.nestedRepo === 'inherit') {
    await git(vault, ['rev-parse', '--git-dir'], resolved).catch(async (error: unknown) => {
      if (!resolved.autoInit) throw error
      await git(vault, ['init'], resolved)
    })
  }
  const status = await git(vault, ['status', '--porcelain', '--', id], resolved)
  if (status.trim() === '') return
  await git(vault, ['add', '--', id], resolved)
  await git(vault, [
    '-c', `user.name=${resolved.authorName}`,
    '-c', `user.email=${resolved.authorEmail}`,
    'commit', '-m', `${resolved.commitPrefix}: ${id}`, '--', id,
  ], resolved)
}

/**
 * Register a `tools/execute` waterfall listener that commits each successful
 * matching dispatch. Mounting order matters: mounted after
 * `dsh-memory-queue`, the commit runs inside the vault lock so `index.lock`
 * contention is serialized away; mounted without it, git calls serialize on an
 * in-process chain and `index.lock` errors retry briefly. A failed commit
 * fails the dispatch result even though the note was written — the divergence
 * is surfaced, not hidden.
 * @param ctx - registrant context carrying the tool registry events.
 * @param config - deployment's explicit git configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  if (resolved.toolNames.length === 0) {
    throw new Error('memory-git: toolNames must not be empty')
  }
  if (!Number.isInteger(resolved.indexLockRetries) || resolved.indexLockRetries < 0) {
    throw new Error('memory-git: indexLockRetries must be a non-negative integer')
  }
  if (!Number.isInteger(resolved.indexLockRetryMs) || resolved.indexLockRetryMs < 1) {
    throw new Error('memory-git: indexLockRetryMs must be a positive integer')
  }
  const names = new Set(resolved.toolNames)
  let tail: Promise<void> = Promise.resolve()

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const run = tail.then(work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (!names.has(exec.name)) return next()
    const result = await next()
    if (result.isError) return result
    const args = exec.arguments
    if (args === null || typeof args !== 'object') return result
    const id = (args as Record<string, unknown>)[resolved.idArgument]
    if (typeof id !== 'string') return result
    if (resolved.prefixes.length > 0 && !resolved.prefixes.some(prefix => id.startsWith(prefix))) {
      return result
    }
    const vault = resolveMemoryVaultRoot(resolved.vaultRoot, exec)
    await enqueue(() => commitWrite(vault, id, resolved))
    return result
  })
}
