import { describe, expect, it } from 'vitest'
import { stripSystemEnvelopes } from './sysmsg'

describe('stripSystemEnvelopes', () => {
  it('leaves normal text untouched', () => {
    expect(stripSystemEnvelopes('hello world')).toBe('hello world')
    expect(stripSystemEnvelopes('use a <system> tag or <notify> inline')).toBe(
      'use a <system> tag or <notify> inline',
    )
  })

  it('removes a standalone system-reminder entirely', () => {
    const t = '<system-reminder>\nThe TodoList tool has not been updated.\n</system-reminder>'
    expect(stripSystemEnvelopes(t)).toBe('')
  })

  it('removes reminders embedded around real user text', () => {
    const t = '<system-reminder>secret control stuff</system-reminder>\n\nactual question here'
    expect(stripSystemEnvelopes(t)).toBe('actual question here')
  })

  it('removes notification envelopes with attributes', () => {
    const t =
      '<notification id="task:x:failed" category="task">\nTitle: failed\n<output-file path="/tmp/x">read it</output-file>\n</notification>'
    expect(stripSystemEnvelopes(t)).toBe('')
  })

  it('removes multiple envelopes and collapses blank runs', () => {
    const t =
      'first\n\n<system-reminder>a</system-reminder>\n\n\n<notification id="n">b</notification>\n\nlast'
    expect(stripSystemEnvelopes(t)).toBe('first\n\nlast')
  })

  it('removes skill-load envelopes with their wrapper sentence', () => {
    const t =
      'Skill tool loaded instructions for this request. Follow them.\n\n<kimi-skill-loaded name="check-kimi-code-docs" source="builtin">\n# Check docs\nbig body\n</kimi-skill-loaded>'
    expect(stripSystemEnvelopes(t)).toBe('')
  })

  it('removes a bare skill-load envelope but keeps surrounding text', () => {
    const t = 'before\n<kimi-skill-loaded name="x">body</kimi-skill-loaded>\nafter'
    expect(stripSystemEnvelopes(t)).toBe('before\n\nafter')
  })
})
