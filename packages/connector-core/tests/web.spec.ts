import { describe, expect, it } from 'vitest'
import { hostIsLoopback, originIsLoopback, safeMessage } from '../src/web.js'

describe('web security helpers', () => {
  it('accepts only loopback Host values', () => {
    expect(hostIsLoopback('127.0.0.1')).toBe(true)
    expect(hostIsLoopback('localhost')).toBe(true)
    expect(hostIsLoopback('[::1]')).toBe(true)
    expect(hostIsLoopback('127.0.0.1:3000')).toBe(true)
    expect(hostIsLoopback('example.com')).toBe(false)
    expect(hostIsLoopback(undefined)).toBe(false)
  })

  it('accepts only loopback Origin values', () => {
    expect(originIsLoopback('http://127.0.0.1:3000')).toBe(true)
    expect(originIsLoopback('http://localhost')).toBe(true)
    expect(originIsLoopback('http://[::1]:3000')).toBe(true)
    expect(originIsLoopback(undefined)).toBe(true)
    expect(originIsLoopback('https://evil.com')).toBe(false)
  })

  it('redacts token-like substrings from error messages', () => {
    expect(safeMessage('Bearer abc123.def')).toContain('[redacted]')
    expect(safeMessage('pat=super-secret')).toContain('[redacted]')
    expect(safeMessage('code=xyz&token=abc')).toContain('[redacted]')
    expect(safeMessage('jrt-1234567890abcdef')).toContain('[redacted token]')
    expect(safeMessage('Authorization: Bearer eyJ.x.y')).toContain('[redacted]')
  })
})
