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
import { listDevinModels, verifyDevinPat } from './api.js'

export interface PatStore {
  get(): string | undefined | Promise<string | undefined>
  set(value: string): Promise<{ ok: true; tail: string } | { ok: false; error: string }>
  clear(): Promise<{ ok: true }>
}

interface DevinRuntime {
  envToken: string
  statusPath: string
  authPath: string
  store: PatStore
  authKey: string
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function buildStatus(runtime: DevinRuntime): Promise<unknown> {
  const pat = await runtime.store.get()
  if (!pat) {
    return { status: 'signed-out', reason: 'missing-pat', authKey: runtime.authKey }
  }

  const { valid, user } = await verifyDevinPat(pat)
  if (!valid) {
    return { status: 'error', message: 'invalid or expired PAT', authKey: runtime.authKey }
  }

  const orgs = user?.organizations ?? []
  const models = await listDevinModels(pat).catch(() => [] as { id: string; name: string }[])

  return {
    status: 'signed-in',
    authKey: runtime.authKey,
    pat: { source: 'saved', tail: `***${pat.slice(-4)}` },
    catalog: { source: 'live', fetchedAt: Date.now() },
    user: { email: user?.email, name: user?.name, organizations: orgs.map((o) => o.name) },
    models,
    credits: undefined,
    probe: { candidates: [], results: [] },
  }
}

function statusHandler(runtime: DevinRuntime) {
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

function authHandler(runtime: DevinRuntime) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(runtime.authKey, headerValue(req.headers['x-devin-auth-key']))) {
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
        await runtime.store.clear()
        json(res, 200, { ok: true })
        return
      }
      if (typeof request.pat !== 'string' || request.pat.length === 0) {
        json(res, 200, { ok: false, error: 'devin_missing_pat' })
        return
      }
      const { valid } = await verifyDevinPat(request.pat)
      if (!valid) {
        json(res, 200, { ok: false, error: 'devin_invalid_pat' })
        return
      }
      const result = await runtime.store.set(request.pat)
      json(res, 200, result)
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) })
    }
  }
}

export function registerDevinWebRoutes(ctx: WebRouteContext, runtime: DevinRuntime) {
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
    return () => {
      disposeStatus()
      disposeAuth()
    }
  }, 'dsh-devin-connect: web routes')
}
