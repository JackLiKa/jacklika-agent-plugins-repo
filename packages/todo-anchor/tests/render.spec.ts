import { describe, expect, it } from 'vitest'
import { renderTodoContext, type TodoItem } from '../src/index.ts'

const entries: TodoItem[] = [
  { content: 'audit the parser', status: 'completed' },
  { content: 'fix the CRLF path', status: 'in_progress' },
  { content: 'write the regression test', status: 'pending' },
]

describe('renderTodoContext', () => {
  it('renders one checkbox line per entry, in the order written', () => {
    const text = renderTodoContext(entries, { reminder: false, maxItems: 50 })
    expect(text).toContain('- [x] audit the parser')
    expect(text).toContain('- [~] fix the CRLF path')
    expect(text).toContain('- [ ] write the regression test')
    expect(text.indexOf('audit the parser')).toBeLessThan(text.indexOf('fix the CRLF path'))
  })

  it('renders nothing for an empty list so the Harness drops the contribution', () => {
    // The Harness filters zero-length dynamic context, so this is the switch
    // that keeps a session which never wrote a list free of this plugin.
    expect(renderTodoContext([], { reminder: true, maxItems: 50 })).toBe('')
  })

  it('carries the write-back rule only when the reminder is on', () => {
    expect(renderTodoContext(entries, { reminder: true, maxItems: 50 })).toContain('Re-write this list as soon as an item completes.')
    expect(renderTodoContext(entries, { reminder: false, maxItems: 50 })).not.toContain('Re-write this list')
  })

  it('collapses entries past maxItems into a count', () => {
    const text = renderTodoContext(entries, { reminder: false, maxItems: 2 })
    expect(text).toContain('audit the parser')
    expect(text).not.toContain('write the regression test')
    expect(text).toContain('… and 1 more not shown')
  })

  it('renders an unknown status as not started rather than dropping the entry', () => {
    const text = renderTodoContext([{ content: 'mystery step', status: 'whatever' }], { reminder: false, maxItems: 50 })
    expect(text).toContain('- [ ] mystery step')
  })

  it('names the tool that owns the list, so the model knows where it came from', () => {
    expect(renderTodoContext(entries, { reminder: false, maxItems: 50 })).toContain('`todo_write`')
  })

  it('omits the Vault sentence when no vault tool is mounted', () => {
    // A deployment without @jacklika/dsh-memory must not point the model at
    // tools that do not exist, so the hint follows tool registration.
    const text = renderTodoContext(entries, { reminder: true, maxItems: 50, vaultHint: false })
    expect(text).toContain('Re-write this list as soon as an item completes.')
    expect(text).not.toContain('memory Vault')
  })

  it('includes the Vault sentence by default and when the hint is explicitly on', () => {
    for (const options of [
      { reminder: true, maxItems: 50 },
      { reminder: true, maxItems: 50, vaultHint: true },
    ]) {
      expect(renderTodoContext(entries, options)).toContain('Durable decisions belong in the memory Vault.')
    }
  })

  it('leaves the Vault sentence out entirely when the reminder is off', () => {
    const text = renderTodoContext(entries, { reminder: false, maxItems: 50, vaultHint: true })
    expect(text).not.toContain('memory Vault')
    expect(text).not.toContain('Re-write this list')
  })
})
