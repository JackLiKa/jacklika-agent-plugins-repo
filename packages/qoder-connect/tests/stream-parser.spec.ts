import { describe, expect, it } from 'vitest'
import { QoderStreamParser } from '../src/index.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

function feed(parser: QoderStreamParser, lines: string[]): StreamChunk[] {
  const out: StreamChunk[] = []
  for (const line of lines) {
    const chunks = parser.parseLine(line)
    if (chunks) out.push(...chunks)
  }
  return out
}

const hookEvent = JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'x' })
const initEvent = JSON.stringify({ type: 'system', subtype: 'init', model: 'DeepSeek-Flash' })

function assistant(id: string, text: string, thinking = ''): string {
  const content: Record<string, unknown>[] = []
  if (thinking) content.push({ type: 'thinking', thinking })
  if (text) content.push({ type: 'text', text })
  return JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content } })
}

function result(text: string, isError = false): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: isError,
    result: text,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
  })
}

describe('QoderStreamParser', () => {
  it('ignores system noise and emits a text block for an assistant message', () => {
    const chunks = feed(new QoderStreamParser(), [hookEvent, initEvent, assistant('m1', 'Hi'), result('Hi')])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('never leaks non-JSON lines as transcript text', () => {
    const chunks = feed(new QoderStreamParser(), ['Welcome to Qoder', 'some banner', '  ', 'not json {'])
    expect(chunks).toEqual([])
  })

  it('deduplicates repeated assistant snapshots by message id', () => {
    const chunks = feed(new QoderStreamParser(), [
      assistant('m1', 'Hel'),
      assistant('m1', 'Hello'),
      assistant('m1', 'Hello'),
      result('Hello'),
    ])
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text)
    expect(deltas).toEqual(['Hel', 'lo'])
  })

  it('emits reasoning before text and closes the reasoning block', () => {
    const chunks = feed(new QoderStreamParser(), [
      assistant('m1', '', 'thinking...'),
      assistant('m1', 'answer', 'thinking...done'),
      result('answer'),
    ])
    const types = chunks.map((c) => c.type)
    expect(types).toEqual([
      'block-start',
      'reasoning-delta',
      'reasoning-delta',
      'block-end',
      'block-start',
      'text-delta',
      'block-end',
      'usage',
      'finish',
    ])
    expect(chunks[0]).toMatchObject({ blockType: 'reasoning' })
    expect(chunks[4]).toMatchObject({ blockType: 'text' })
  })

  it('throws on error result events', () => {
    const parser = new QoderStreamParser()
    feed(parser, [assistant('m1', 'partial')])
    expect(() => parser.parseLine(result('quota exceeded', true))).toThrow('quota exceeded')
  })

  it('closes an open block on flush for reasoning-only termination', () => {
    const parser = new QoderStreamParser()
    feed(parser, [assistant('m1', '', 'only thinking')])
    const tail = parser.flush()
    expect(tail).toEqual([{ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'only thinking' } }])
  })

  it('ignores tool_use content blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
    })
    expect(feed(new QoderStreamParser(), [line])).toEqual([])
  })
})
