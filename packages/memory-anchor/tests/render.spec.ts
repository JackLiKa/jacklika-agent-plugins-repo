import { describe, expect, it } from 'vitest'
import { renderMemoryDiscipline } from '../src/index.ts'

const defaults = {
  recallReminder: true,
  captureReminder: true,
  recallText: 'Memory discipline: search durable memory with `memory_recall`/`wiki_search` (2-4 keywords) before answering or acting.',
  captureText: 'When a task ends with durable conclusions, record them with `memory_capture`/`wiki_write`.',
}

describe('renderMemoryDiscipline', () => {
  it('renders both reminder lines by default', () => {
    const text = renderMemoryDiscipline(defaults)
    expect(text).toContain('memory_recall')
    expect(text).toContain('memory_capture')
    expect(text.split('\n')).toHaveLength(2)
  })

  it('renders only the capture line when recallReminder is off', () => {
    const text = renderMemoryDiscipline({ ...defaults, recallReminder: false })
    expect(text).not.toContain('memory_recall')
    expect(text).toContain('memory_capture')
  })

  it('renders only the recall line when captureReminder is off', () => {
    const text = renderMemoryDiscipline({ ...defaults, captureReminder: false })
    expect(text).toContain('memory_recall')
    expect(text).not.toContain('memory_capture')
  })

  it('renders nothing when both reminders are off so the Harness drops the contribution', () => {
    expect(renderMemoryDiscipline({ ...defaults, recallReminder: false, captureReminder: false })).toBe('')
  })

  it('omits the Vault sentence when vaultHint is off', () => {
    const text = renderMemoryDiscipline({ ...defaults, vaultHint: false })
    expect(text).toContain('memory_capture')
    expect(text).not.toContain('Vault')
  })

  it('includes the Vault sentence by default and when the hint is explicitly on', () => {
    for (const options of [defaults, { ...defaults, vaultHint: true }]) {
      expect(renderMemoryDiscipline(options)).toContain('The Vault is the persistent record')
    }
  })
})
