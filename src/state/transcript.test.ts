import { describe, expect, it } from 'vitest'
import { transcriptToMessages, type TranscriptTurn } from './transcript'

const TURNS: TranscriptTurn[] = [
  {
    kind: 'turn',
    turnId: 't0',
    ordinal: 0,
    state: 'completed',
    prompt: 'hello',
    steps: [
      {
        kind: 'step',
        stepId: 't0.1',
        ordinal: 1,
        state: 'completed',
        frames: [
          { kind: 'thinking', frameId: 't0.1.f1', text: 'hmm' },
          {
            kind: 'tool',
            frameId: 't0.1.tool_1',
            toolCallId: 'tool_1',
            name: 'Bash',
            state: 'done',
            input: { command: 'ls' },
            output: 'ok',
          },
          { kind: 'text', frameId: 't0.1.f2', text: 'done' },
        ],
      },
    ],
  },
]

describe('transcriptToMessages', () => {
  it('flattens turns and steps into messages with stable transcript ids', () => {
    const msgs = transcriptToMessages(TURNS)
    expect(msgs.map((m) => m.id)).toEqual(['t0', 't0.1'])
    expect(msgs[0]).toMatchObject({ role: 'user' })
    expect(msgs[1]).toMatchObject({ role: 'assistant' })
  })

  it('expands tool frames to tool_use + tool_result blocks', () => {
    const content = transcriptToMessages(TURNS)[1].content
    const tu = content.find((b) => b.type === 'tool_use')
    const tr = content.find((b) => b.type === 'tool_result')
    expect(tu).toMatchObject({ tool_call_id: 'tool_1', tool_name: 'Bash', input: { command: 'ls' } })
    expect(tr).toMatchObject({ tool_call_id: 'tool_1', output: 'ok', is_error: false })
  })

  it('skips prompt-less turns and empty steps', () => {
    const msgs = transcriptToMessages([
      { kind: 'turn', turnId: 't9', ordinal: 9, state: 'cancelled', steps: [] },
      { kind: 'turn', turnId: 't10', ordinal: 10, state: 'completed', prompt: 'x', steps: [] },
    ])
    expect(msgs.map((m) => m.id)).toEqual(['t10'])
  })

  it('marks failed tool frames as errors and tolerates missing output', () => {
    const msgs = transcriptToMessages([
      {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: 'completed',
        steps: [
          {
            kind: 'step',
            stepId: 't1.1',
            ordinal: 1,
            state: 'completed',
            frames: [
              { kind: 'tool', toolCallId: 'a', name: 'Bash', state: 'failed', output: 'boom' },
              { kind: 'tool', toolCallId: 'b', name: 'Bash', state: 'cancelled' },
            ],
          },
        ],
      },
    ])
    const content = msgs[0].content
    expect(content.find((b) => b.type === 'tool_result')).toMatchObject({ is_error: true })
    // No result block for the output-less call.
    expect(content.filter((b) => b.type === 'tool_result')).toHaveLength(1)
  })
})
