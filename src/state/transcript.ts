import type { ChatMessage, ContentBlock } from '../api/events'

/** Shapes of the 0.28+ `GET /sessions/{id}/transcript` endpoint: turn-granular
 *  history rebuilt from the wire log (cold sessions) or the in-memory store
 *  (live). Ids are turn-scoped (`t0`, `t0.1`) — a different id space from
 *  `/messages` (`msg_…`), so transcript history must REPLACE, never merge. */
export interface TranscriptFrame {
  kind: string
  frameId?: string
  text?: string
  toolCallId?: string
  name?: string
  state?: string
  input?: unknown
  output?: unknown
}

export interface TranscriptStep {
  kind: 'step'
  stepId: string
  ordinal: number
  state: string
  frames?: TranscriptFrame[]
}

export interface TranscriptTurn {
  kind: 'turn'
  turnId: string
  ordinal: number
  state: string
  prompt?: string
  steps?: TranscriptStep[]
}

/** Non-turn page items: `marker` carries compaction summaries (and undo marks,
 * ignored); `taskref` links background-task turns (rendered as normal turns
 * when present, skipped here otherwise). */
export interface TranscriptMarker {
  kind: 'marker' | string
  markerId?: string
  marker?: string
  payload?: { text?: string }
}

export interface TranscriptPage {
  agent_id: string
  items: (TranscriptTurn | TranscriptMarker)[]
  has_more?: boolean
}

/** Flatten transcript turns into the ChatMessage model: each turn's prompt
 *  becomes a user message, each step an assistant message; tool frames expand
 *  to tool_use + tool_result blocks so the store rebuilds full tool cards. */
export function transcriptToMessages(items: (TranscriptTurn | TranscriptMarker)[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const t of items) {
    // Compaction markers carry the agent's working summary — render as a
    // divider card, not a user bubble. Other markers (undo, …) are skipped.
    if (t.kind === 'marker') {
      const mk = t as TranscriptMarker
      if (mk.marker === 'compaction' && mk.payload?.text) {
        out.push({
          id: mk.markerId ?? `compaction_${out.length}`,
          role: 'user',
          compaction: true,
          content: [{ type: 'text', text: mk.payload.text }],
        })
      }
      continue
    }
    if (t.kind !== 'turn') continue
    const turn = t as TranscriptTurn
    if (turn.prompt) {
      out.push({ id: turn.turnId, role: 'user', content: [{ type: 'text', text: turn.prompt }] })
    }
    for (const s of turn.steps ?? []) {
      const content: ContentBlock[] = []
      for (const f of s.frames ?? []) {
        if (f.kind === 'thinking') {
          content.push({ type: 'thinking', thinking: f.text ?? '' })
        } else if (f.kind === 'text') {
          content.push({ type: 'text', text: f.text ?? '' })
        } else if (f.kind === 'tool') {
          const cid = f.toolCallId ?? f.frameId ?? '?'
          content.push({ type: 'tool_use', tool_call_id: cid, tool_name: f.name ?? '?', input: f.input })
          if (f.output !== undefined) {
            content.push({
              type: 'tool_result',
              tool_call_id: cid,
              output: f.output,
              is_error: f.state === 'failed',
            })
          }
        }
      }
      if (content.length) out.push({ id: s.stepId, role: 'assistant', content })
    }
  }
  return out
}
