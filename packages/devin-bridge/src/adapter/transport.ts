// Devin Connect transport: auth header injection, proxying, forced HTTP/1.1.
// Ported from authTransport + httpproxy in devin-2api/internal/adapter/devin/devin.go.

import type { Interceptor } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import type { Agent } from 'node:http'
import { createRequire } from 'node:module'

// This package is ESM, and the proxy agents are CommonJS-only optional
// dependencies loaded lazily: a deployment without a proxy never pays for them.
const nodeRequire = createRequire(import.meta.url)

export interface TransportConfig {
  baseUrl: string
  token: string
  proxy?: string | undefined
  forceHttp1: boolean
}

/**
 * Create the Connect transport with Devin's Basic auth header and proxy support.
 */
export function createDevinTransport(config: TransportConfig) {
  const agent = createProxyAgent(config.proxy)
  const interceptors: Interceptor[] = [authInterceptor(config.token)]

  const transportOptions: Parameters<typeof createConnectTransport>[0] = {
    baseUrl: config.baseUrl,
    interceptors,
    nodeOptions: agent ? { agent } : undefined,
  } as never
  if (config.forceHttp1) {
    ;(transportOptions as { httpVersion: '1.1' }).httpVersion = '1.1'
  } else {
    ;(transportOptions as { httpVersion: '2' }).httpVersion = '2'
  }
  return createConnectTransport(transportOptions)
}

/**
 * Auth interceptor: injects `Authorization: Basic <token>-<token>`, matching the
 * behavior of the Go authTransport.
 */
function authInterceptor(token: string): Interceptor {
  return (next) => async (req) => {
    req.header.set('Authorization', `Basic ${token}-${token}`)
    return next(req)
  }
}

/**
 * Build the agent for a proxy URL; http://, https://, socks5:// and socks5h://
 * are accepted.
 */
function createProxyAgent(proxyUrl: string | undefined): Agent | undefined {
  if (!proxyUrl) return undefined

  const url = new URL(proxyUrl)
  const protocol = url.protocol

  if (protocol === 'http:' || protocol === 'https:') {
    const { HttpsProxyAgent } = nodeRequire('https-proxy-agent') as typeof import('https-proxy-agent')
    return new HttpsProxyAgent(proxyUrl) as unknown as Agent
  }

  if (protocol === 'socks5:' || protocol === 'socks5h:') {
    const { SocksProxyAgent } = nodeRequire('socks-proxy-agent') as typeof import('socks-proxy-agent')
    return new SocksProxyAgent(proxyUrl) as unknown as Agent
  }

  throw new Error(`unsupported proxy protocol: ${protocol}`)
}
