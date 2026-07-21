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

export interface TranscriptPage {
  agent_id: string
  items: TranscriptTurn[]
  has_more?: boolean
}

/** Flatten transcript turns into the ChatMessage model: each turn's prompt
 *  becomes a user message, each step an assistant message; tool frames expand
 *  to tool_use + tool_result blocks so the store rebuilds full tool cards. */
export function transcriptToMessages(turns: TranscriptTurn[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const t of turns) {
    if (t.prompt) {
      out.push({ id: t.turnId, role: 'user', content: [{ type: 'text', text: t.prompt }] })
    }
    for (const s of t.steps ?? []) {
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
