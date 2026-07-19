import { beforeEach, describe, expect, it } from 'vitest'
import { useApp } from './store'
import type { Frame, Snapshot } from '../api/events'

const SID = 'session_test_1'

function frame(type: string, payload: Record<string, unknown>, seq = 1): Frame {
  return {
    type,
    seq,
    session_id: SID,
    timestamp: new Date().toISOString(),
    epoch: 'ep_test',
    payload: { type, ...payload },
  }
}

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    as_of_seq: 1,
    epoch: 'ep_test',
    session: {
      id: SID,
      workspace_id: 'wd_test',
      title: 't',
      created_at: '',
      updated_at: '',
      busy: false,
      main_turn_active: false,
      pending_interaction: 'none',
    },
    messages: { items: [], has_more: false },
    in_flight_turn: null,
    subagents: [],
    pending_approvals: [],
    pending_questions: [],
    ...overrides,
  }
}

beforeEach(() => {
  useApp.setState({ sessionState: {} })
})

describe('streaming', () => {
  it('accumulates main-agent deltas into streaming buffers', () => {
    const st = useApp.getState()
    st.applyFrame(frame('turn.started', { agentId: 'main', turnId: 0 }))
    st.applyFrame(frame('thinking.delta', { agentId: 'main', delta: 'hello ' }))
    st.applyFrame(frame('thinking.delta', { agentId: 'main', delta: 'world' }))
    st.applyFrame(frame('assistant.delta', { agentId: 'main', delta: 'answer' }))
    const s = useApp.getState().sessionState[SID]
    expect(s.streaming.thinking).toBe('hello world')
    expect(s.streaming.assistant).toBe('answer')
    expect(s.streaming.active).toBe(true)
    expect(s.busy).toBe(true)
  })

  it('clears streaming and busy on prompt.completed', () => {
    const st = useApp.getState()
    st.applyFrame(frame('turn.started', { agentId: 'main', turnId: 0 }))
    st.applyFrame(frame('assistant.delta', { agentId: 'main', delta: 'x' }))
    st.applyFrame(frame('prompt.completed', { agentId: 'main' }))
    const s = useApp.getState().sessionState[SID]
    expect(s.busy).toBe(false)
    expect(s.streaming.active).toBe(false)
  })
})

describe('per-agent separation (subagent cross-talk)', () => {
  it('routes subagent deltas to the subagent record, never the main stream', () => {
    const st = useApp.getState()
    st.applyFrame(frame('turn.started', { agentId: 'main', turnId: 0 }))
    st.applyFrame(frame('thinking.delta', { agentId: 'main', delta: 'MAIN' }))
    st.applyFrame(
      frame('subagent.spawned', { subagentId: 'agent-1', subagentName: 'explore', agentId: 'main' }),
    )
    st.applyFrame(frame('thinking.delta', { agentId: 'agent-1', delta: 'SUB' }))
    st.applyFrame(frame('assistant.delta', { agentId: 'agent-1', delta: 'subanswer' }))
    st.applyFrame(frame('turn.ended', { agentId: 'agent-1', reason: 'completed' }))
    st.applyFrame(frame('prompt.completed', { agentId: 'agent-1' }))
    const s = useApp.getState().sessionState[SID]
    expect(s.streaming.thinking).toBe('MAIN') // unpolluted
    expect(s.streaming.active).toBe(true) // subagent end must not clear main
    expect(s.busy).toBe(true)
    expect(s.subagents['agent-1'].thinking).toBe('SUB')
    expect(s.subagents['agent-1'].assistant).toBe('subanswer')
  })

  it('ignores subagent context.spliced for the main history', () => {
    const st = useApp.getState()
    st.applyFrame(
      frame('context.spliced', {
        agentId: 'agent-1',
        start: 0,
        deleteCount: 0,
        messages: [{ id: 'm1', role: 'user', content: [] }],
      }),
    )
    expect(useApp.getState().sessionState[SID].messages).toHaveLength(0)
  })
})

describe('tool calls and todos', () => {
  it('extracts todos from TodoList tool calls', () => {
    const st = useApp.getState()
    st.applyFrame(
      frame('tool.call.started', {
        agentId: 'main',
        toolCallId: 'tc1',
        name: 'TodoList',
        args: { todos: [{ title: 'a', status: 'pending' }, { title: 'b', status: 'done' }] },
      }),
    )
    expect(useApp.getState().sessionState[SID].todos).toHaveLength(2)
  })
})

describe('usage accumulation (REST returns zeros in 0.27.0)', () => {
  it('accumulates tokens from turn.step.completed and counts turns', () => {
    const st = useApp.getState()
    st.applyFrame(
      frame('turn.step.completed', {
        agentId: 'main',
        usage: { inputOther: 100, output: 10, inputCacheRead: 500, inputCacheCreation: 5 },
      }),
    )
    st.applyFrame(
      frame('turn.step.completed', {
        agentId: 'main',
        usage: { inputOther: 50, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      }),
    )
    st.applyFrame(frame('turn.ended', { agentId: 'main', reason: 'completed' }))
    const u = useApp.getState().sessionState[SID].usage!
    expect(u.input_tokens).toBe(150)
    expect(u.output_tokens).toBe(15)
    expect(u.cache_read_tokens).toBe(500)
    expect(u.cache_creation_tokens).toBe(5)
    expect(u.turn_count).toBe(1)
  })

  it('mergeUsage never clobbers real values with zeros', () => {
    const st = useApp.getState()
    st.applyStatus(SID, { context_tokens: 999, max_context_tokens: 1000 })
    st.mergeUsage(SID, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    })
    expect(useApp.getState().sessionState[SID].usage!.context_tokens).toBe(999)
    expect(useApp.getState().sessionState[SID].usage!.context_limit).toBe(1000)
  })
})

describe('context.spliced merging', () => {
  it('dedupes by message id', () => {
    const st = useApp.getState()
    const msg = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }
    st.applyFrame(frame('context.spliced', { agentId: 'main', start: 0, deleteCount: 0, messages: [msg] }))
    st.applyFrame(frame('context.spliced', { agentId: 'main', start: 0, deleteCount: 0, messages: [msg] }))
    expect(useApp.getState().sessionState[SID].messages).toHaveLength(1)
  })

  it('marks unsynced on history rewrite (deleteCount > 0)', () => {
    const st = useApp.getState()
    st.applyFrame(frame('context.spliced', { agentId: 'main', start: 0, deleteCount: 2, messages: [] }))
    expect(useApp.getState().sessionState[SID].synced).toBe(false)
  })
})

describe('snapshot guards', () => {
  it('never blanks good history with an empty snapshot page', () => {
    const st = useApp.getState()
    st.applyFrame(
      frame('context.spliced', {
        agentId: 'main',
        start: 0,
        deleteCount: 0,
        messages: [{ id: 'm1', role: 'user', content: [] }],
      }),
    )
    st.applySnapshot(SID, snap()) // empty items
    expect(useApp.getState().sessionState[SID].messages).toHaveLength(1)
  })

  it('preserves frame-accumulated usage when REST usage is zeros', () => {
    const st = useApp.getState()
    st.applyFrame(
      frame('turn.step.completed', { agentId: 'main', usage: { inputOther: 42, output: 1 } }),
    )
    st.applySnapshot(
      SID,
      snap({
        session: {
          ...snap().session,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            total_cost_usd: 0,
            context_tokens: 0,
            context_limit: 0,
            turn_count: 0,
          },
        },
      }),
    )
    expect(useApp.getState().sessionState[SID].usage!.input_tokens).toBe(42)
  })
})

describe('outbox', () => {
  it('adds and clears optimistic items', () => {
    const st = useApp.getState()
    st.addToOutbox(SID, { localId: 'a', text: 'hi', kind: 'steer', sentAt: 1 })
    st.addToOutbox(SID, { localId: 'b', text: 'yo', kind: 'queue', sentAt: 2 })
    expect(useApp.getState().sessionState[SID].outbox).toHaveLength(2)
    st.clearOutbox(SID, 'a')
    expect(useApp.getState().sessionState[SID].outbox).toHaveLength(1)
    st.clearOutbox(SID)
    expect(useApp.getState().sessionState[SID].outbox).toHaveLength(0)
  })
})
