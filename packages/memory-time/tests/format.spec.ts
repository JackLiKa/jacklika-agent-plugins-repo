import { describe, expect, it } from 'vitest'
import { formatBeijingTime } from '../src/index.ts'

describe('formatBeijingTime', () => {
  it('converts a UTC instant into Asia/Shanghai wall-clock time with an explicit +08:00 offset', () => {
    expect(formatBeijingTime(new Date('2026-06-15T12:34:56Z'))).toBe('2026-06-15T20:34:56+08:00')
  })

  it('uses an existing +08:00 instant unchanged', () => {
    expect(formatBeijingTime(new Date('2026-10-08T02:32:47+08:00'))).toBe('2026-10-08T02:32:47+08:00')
  })

  it('zero-pads every component', () => {
    expect(formatBeijingTime(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02T08:00:00+08:00')
  })

  it('renders Beijing midnight as 00, never as hour 24', () => {
    expect(formatBeijingTime(new Date('2026-10-07T16:00:00Z'))).toBe('2026-10-08T00:00:00+08:00')
  })

  it('rolls the wall-clock date across the year boundary', () => {
    expect(formatBeijingTime(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01T00:00:00+08:00')
  })

  it('rolls a short month into the next one', () => {
    expect(formatBeijingTime(new Date('2026-02-28T16:00:00Z'))).toBe('2026-03-01T00:00:00+08:00')
  })

  it('drops sub-second precision so labels stay at the documented second resolution', () => {
    expect(formatBeijingTime(new Date('2026-10-08T02:32:47.987+08:00'))).toBe('2026-10-08T02:32:47+08:00')
  })

  it('keeps the instant unchanged: the output parses back to the input epoch second', () => {
    for (const iso of [
      '2026-06-15T12:34:56Z',
      '2026-01-01T00:00:00Z',
      '2026-12-31T23:59:59Z',
      '2026-10-08T02:32:47Z',
    ]) {
      const date = new Date(iso)
      const parsed = new Date(formatBeijingTime(date))
      expect(parsed.getTime()).toBe(Math.floor(date.getTime() / 1000) * 1000)
    }
  })
})
