import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  hostIsLoopback,
  json,
  keyMatches,
  originIsLoopback,
  readBody,
  safeMessage,
  type WebRouteContext,
} from '@jacklika/dsh-connector-core'
import { fetchQoderUsage, fetchQoderUser, listQoderModels, verifyQoderPat, type QoderUsage } from './api.js'

export interface PatStore {
  get(): string | undefined | Promise<string | undefined>
  set(value: string): Promise<{ ok: true; tail: string } | { ok: false; error: string }>
  clear(): Promise<{ ok: true }>
}

interface QoderVariantRuntime {
  id: string
  envToken: string
  cliConfigDir: string
  statusPath: string
  authPath: string
  probePath: string
  store: PatStore
  authKey: string
  probeKey: string
}

function patTail(pat: string): string {
  if (pat.length < 8) return '***'
  return `***${pat.slice(-4)}`
}

function normalizeUsage(usage: QoderUsage | undefined) {
  if (!usage?.userQuota) return undefined
  return {
    accounts: [
      {
        packageName: 'Plan',
        remain: usage.userQuota.remaining,
        size: usage.userQuota.total,
        unlimited: false,
      },
    ],
    unlimited: false,
    total: usage.userQuota.used,
    totalSize: usage.userQuota.total,
    cycleResetTime: usage.expiresAt ? new Date(usage.expiresAt).toISOString() : undefined,
  }
}

async function buildStatus(runtime: QoderVariantRuntime): Promise<unknown> {
  const pat = await runtime.store.get()
  if (!pat) {
    return { status: 'signed-out', reason: 'missing-pat', authKey: runtime.authKey }
  }

  const { valid } = await verifyQoderPat(pat, runtime.cliConfigDir)
  if (!valid) {
    return { status: 'error', message: 'invalid or expired PAT', authKey: runtime.authKey }
  }

  const [models, user, usage] = await Promise.all([
    listQoderModels(pat, runtime.cliConfigDir).catch(() => [] as { id: string; name: string }[]),
    fetchQoderUser(pat, runtime.cliConfigDir).catch(() => undefined),
    fetchQoderUsage(pat).catch(() => undefined),
  ])

  return {
    status: 'signed-in',
    authKey: runtime.authKey,
    probeKey: runtime.probeKey,
    pat: { source: 'saved', tail: patTail(pat) },
    catalog: { source: 'live', fetchedAt: Date.now() },
    user: user
      ? {
          username: user.username,
          email: user.email,
          userType: user.user_type,
          orgId: user.org_id,
          avatarUrl: user.avatar_url,
          allowByok: user.allow_byok === 1,
        }
      : undefined,
    models,
    credits: normalizeUsage(usage),
    probe: { candidates: [], results: [] },
  }
}

function statusHandler(runtime: QoderVariantRuntime) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }

    try {
      const status = await buildStatus(runtime)
      json(res, 200, status)
    } catch (error) {
      json(res, 500, { status: 'error', message: safeMessage(error), authKey: runtime.authKey })
    }
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function authHandler(runtime: QoderVariantRuntime) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(runtime.authKey, headerValue(req.headers['x-qoder-auth-key']))) {
      json(res, 403, { error: 'invalid-auth-key' })
      return
    }

    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }

    let request: { action?: string; pat?: string }
    try {
      request = JSON.parse(body) as { action?: string; pat?: string }
    } catch {
      json(res, 400, { error: 'invalid action' })
      return
    }
    if (typeof request !== 'object' || request === null) {
      json(res, 400, { error: 'invalid action' })
      return
    }

    try {
      if (request.action === 'clear') {
        const result = await runtime.store.clear()
        json(res, 200, result)
        return
      }
      if (typeof request.pat !== 'string' || request.pat.length === 0) {
        json(res, 200, { ok: false, error: 'qoder_missing_pat' })
        return
      }
      const { valid } = await verifyQoderPat(request.pat, runtime.cliConfigDir)
      if (!valid) {
        json(res, 200, { ok: false, error: 'qoder_invalid_pat' })
        return
      }
      const result = await runtime.store.set(request.pat)
      json(res, 200, result)
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) })
    }
  }
}

function probeHandler(runtime: QoderVariantRuntime) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(runtime.probeKey, headerValue(req.headers['x-qoder-probe-key']))) {
      json(res, 403, { error: 'invalid-probe-key' })
      return
    }

    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }

    let request: { action?: string; model?: string; enabled?: boolean }
    try {
      request = JSON.parse(body) as { action?: string; model?: string; enabled?: boolean }
    } catch {
      json(res, 400, { error: 'invalid action' })
      return
    }
    if (typeof request !== 'object' || request === null) {
      json(res, 400, { error: 'invalid action' })
      return
    }

    const pat = await runtime.store.get()
    if (!pat) {
      json(res, 200, { state: 'failed', reason: 'missing-pat' })
      return
    }

    try {
      if (request.action === 'refresh') {
        await listQoderModels(pat, runtime.cliConfigDir)
        json(res, 200, { state: 'ok' })
        return
      }
      if (request.action === 'probe' && typeof request.model === 'string') {
        const models = await listQoderModels(pat, runtime.cliConfigDir)
        const target = models.find((m) => m.id === request.model)
        if (!target) {
          json(res, 200, { state: 'failed', reason: 'model-not-found' })
          return
        }
        json(res, 200, {
          state: 'ok',
          validation: 'validating',
          efforts: ['low', 'medium', 'high'],
        })
        return
      }
      json(res, 400, { error: 'invalid action' })
    } catch (error) {
      json(res, 200, { state: 'failed', reason: safeMessage(error) })
    }
  }
}

export function registerQoderWebRoutes(ctx: WebRouteContext, runtimes: QoderVariantRuntime[]) {
  for (const runtime of runtimes) {
    ctx.effect(() => {
      const disposeStatus = ctx.webServer.register({
        kind: 'exact',
        path: runtime.statusPath,
        handler: statusHandler(runtime),
      })
      const disposeAuth = ctx.webServer.register({
        kind: 'exact',
        path: runtime.authPath,
        handler: authHandler(runtime),
      })
      const disposeProbe = ctx.webServer.register({
        kind: 'exact',
        path: runtime.probePath,
        handler: probeHandler(runtime),
      })
      return () => {
        disposeStatus()
        disposeAuth()
        disposeProbe()
      }
    }, `dsh-qoder-connect: web routes (${runtime.id})`)
  }
}
