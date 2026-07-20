import { create } from 'zustand'
import type { ConnectionInfo } from '../api/connection'
import type {
  ApprovalItem,
  ChatMessage,
  Frame,
  QuestionItem,
  SessionSummary,
  SessionUsage,
  SkillInfo,
  Snapshot,
  SubagentRecord,
  GoalState,
  TaskItem,
  TodoItem,
  ToolCallRecord,
} from '../api/events'

export interface Workspace {
  id: string
  root: string
  name: string
  created_at?: string
  last_opened_at?: string
  session_count?: number
  [k: string]: unknown
}

export interface StreamingState {
  active: boolean
  turnId: number | null
  thinking: string
  assistant: string
}

export interface PromptQueueItem {
  prompt_id: string
  status: string
  content?: { type: string; text?: string }[]
  created_at?: string
}
export interface PromptQueue {
  active: PromptQueueItem | null
  queued: PromptQueueItem[]
}

/** A message just submitted from this app, awaiting daemon confirmation. */
export interface OutboxItem {
  localId: string
  text: string
  kind: 'queue' | 'steer' | 'interrupt' | 'send'
  sentAt: number
  imageCount?: number
}

export interface SessionState {
  summary: SessionSummary | null
  messages: ChatMessage[]
  toolCalls: Record<string, ToolCallRecord>
  streaming: StreamingState
  usage: SessionUsage | null
  busy: boolean
  pendingInteraction: string
  cursor: { seq: number; epoch: string } | null
  synced: boolean
  lastError: string | null
  approvals: ApprovalItem[]
  questions: QuestionItem[]
  todos: TodoItem[]
  subagents: Record<string, SubagentRecord>
  tasks: TaskItem[]
  goal: GoalState | null
  queue: PromptQueue | null
  outbox: OutboxItem[]
  hasMore: boolean
  skills: SkillInfo[]
}

const emptyStreaming = (): StreamingState => ({
  active: false,
  turnId: null,
  thinking: '',
  assistant: '',
})

const emptySession = (): SessionState => ({
  summary: null,
  messages: [],
  toolCalls: {},
  streaming: emptyStreaming(),
  usage: null,
  busy: false,
  pendingInteraction: 'none',
  cursor: null,
  synced: false,
  lastError: null,
  approvals: [],
  questions: [],
  todos: [],
  subagents: {},
  tasks: [],
  goal: null,
  queue: null,
  outbox: [],
  hasMore: false,
  skills: [],
})

/** Main-agent tool calls left `running` with no result once the turn is over
 *  are dead (crash, abort, daemon restart) — mark them interrupted instead of
 *  pulsing forever. Subagent calls are left alone (background subagents can
 *  outlive the main turn). */
function sweepInterrupted(s: SessionState): SessionState {
  let changed = false
  const toolCalls: Record<string, ToolCallRecord> = {}
  for (const [k, rec] of Object.entries(s.toolCalls)) {
    if ((rec.agentId ?? 'main') === 'main' && rec.status === 'running' && rec.output === undefined) {
      toolCalls[k] = { ...rec, status: 'interrupted' }
      changed = true
    } else {
      toolCalls[k] = rec
    }
  }
  return changed ? { ...s, toolCalls } : s
}

/** Latest TodoList tool state from message history (last write wins). */
export function extractTodos(messages: ChatMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i].content ?? []) {
      if (b.type === 'tool_use') {
        const tb = b as { tool_name: string; input: unknown }
        if (tb.tool_name === 'TodoList') {
          const todos = (tb.input as { todos?: TodoItem[] })?.todos
          if (Array.isArray(todos)) return todos
        }
      }
    }
  }
  return []
}

export interface ModelInfo {
  provider: string
  model: string
  display_name: string
  max_context_size: number
  capabilities: string[]
}

interface AppState {
  conn: ConnectionInfo | null
  socketState: 'connecting' | 'open' | 'closed'
  serverVersion: string | null
  /** Non-fatal sync problem worth showing in the UI (e.g. subscribe failing). */
  syncIssue: string | null
  workspaces: Workspace[]
  sessions: SessionSummary[]
  activeSessionId: string | null
  sessionState: Record<string, SessionState>
  models: ModelInfo[]
  defaultModel: string | null
  initError: string | null
  /** Transient composer feedback for `/commands` (survives session switches). */
  notice: string | null
  /** Sidebar: include archived sessions in the list (view-only; the daemon
   *  has no unarchive action in 0.27.0). */
  showArchived: boolean

  setConnection: (c: ConnectionInfo) => void
  setSocketState: (s: AppState['socketState']) => void
  setServerVersion: (v: string) => void
  setSyncIssue: (issue: string | null) => void
  setWorkspaces: (w: Workspace[]) => void
  setSessions: (s: SessionSummary[]) => void
  setActiveSession: (id: string | null) => void
  applySnapshot: (id: string, snap: Snapshot) => void
  applyFrame: (f: Frame) => void
  setMessages: (id: string, msgs: ChatMessage[], hasMore?: boolean) => void
  prependMessages: (id: string, msgs: ChatMessage[], hasMore: boolean) => void
  markUnsynced: (id: string) => void
  markSynced: (id: string) => void
  setModels: (m: ModelInfo[], defaultModel: string | null) => void
  setInitError: (e: string | null) => void
  setNotice: (n: string | null) => void
  setShowArchived: (b: boolean) => void
  setApprovals: (id: string, approvals: ApprovalItem[]) => void
  setQuestions: (id: string, questions: QuestionItem[]) => void
  setTasks: (id: string, tasks: TaskItem[]) => void
  setGoal: (id: string, goal: GoalState | null) => void
  applyStatus: (
    id: string,
    s: {
      context_tokens?: number
      max_context_tokens?: number
      model?: string
      permission?: string
      plan_mode?: boolean
      swarm_mode?: boolean
      thinking_level?: string
    },
  ) => void
  mergeUsage: (id: string, u: SessionUsage) => void
  setQueue: (id: string, q: PromptQueue | null) => void
  addToOutbox: (id: string, item: OutboxItem) => void
  clearOutbox: (id: string, localId?: string) => void
  setSkills: (id: string, skills: SkillInfo[]) => void
}

export const useApp = create<AppState>((set) => ({
  conn: null,
  socketState: 'connecting',
  serverVersion: null,
  syncIssue: null,
  workspaces: [],
  sessions: [],
  activeSessionId: null,
  sessionState: {},
  models: [],
  defaultModel: null,
  initError: null,
  notice: null,
  showArchived: false,

  setConnection: (conn) => set({ conn }),
  setSocketState: (socketState) => set({ socketState }),
  setServerVersion: (serverVersion) => set({ serverVersion }),
  setSyncIssue: (syncIssue) => set({ syncIssue }),
  setWorkspaces: (workspaces) => set({ workspaces }),
  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (activeSessionId) => set({ activeSessionId }),

  setMessages: (id, msgs, hasMore) =>
    set((st) => {
      const prev = st.sessionState[id] ?? emptySession()
      // Rebuild tool records from history blocks, keeping any live records
      // that are still running (they carry progress text).
      const toolCalls: Record<string, ToolCallRecord> = {}
      for (const m of msgs) {
        for (const b of m.content ?? []) {
          if (b.type === 'tool_use') {
            const tb = b as { tool_call_id: string; tool_name: string; input: unknown }
            const live = prev.toolCalls[tb.tool_call_id]
            toolCalls[tb.tool_call_id] =
              live && (live.status === 'running' || live.status === 'interrupted')
                ? { ...live, args: tb.input }
                : {
                    toolCallId: tb.tool_call_id,
                    name: tb.tool_name,
                    args: tb.input,
                    status: 'running',
                  }
          }
          if (b.type === 'tool_result') {
            const tb = b as { tool_call_id: string; output: unknown; is_error?: boolean }
            const rec = toolCalls[tb.tool_call_id]
            if (rec) {
              rec.output = tb.output
              rec.isError = tb.is_error
              rec.status = tb.is_error ? 'error' : 'done'
            }
          }
        }
      }
      // Idle session with result-less calls: those died mid-flight (crash/abort).
      if (!prev.busy) {
        for (const rec of Object.values(toolCalls)) {
          if ((rec.agentId ?? 'main') === 'main' && rec.status === 'running' && rec.output === undefined) {
            rec.status = 'interrupted'
          }
        }
      }
      return {
        sessionState: {
          ...st.sessionState,
          [id]: {
            ...prev,
            messages: msgs,
            toolCalls,
            todos: extractTodos(msgs),
            ...(hasMore !== undefined ? { hasMore } : {}),
          },
        },
      }
    }),

  prependMessages: (id, msgs, hasMore) =>
    set((st) => {
      const prev = st.sessionState[id] ?? emptySession()
      const existing = new Set(prev.messages.map((m) => m.id))
      const fresh = msgs.filter((m) => !existing.has(m.id))
      return {
        sessionState: {
          ...st.sessionState,
          [id]: { ...prev, messages: [...fresh, ...prev.messages], hasMore },
        },
      }
    }),

  markUnsynced: (id) =>
    set((st) => ({
      sessionState: {
        ...st.sessionState,
        [id]: { ...(st.sessionState[id] ?? emptySession()), synced: false },
      },
    })),

  markSynced: (id) =>
    set((st) => ({
      sessionState: {
        ...st.sessionState,
        [id]: { ...(st.sessionState[id] ?? emptySession()), synced: true },
      },
    })),

  setModels: (models, defaultModel) => set({ models, defaultModel }),

  setInitError: (initError) => set({ initError }),

  setNotice: (notice) => set({ notice }),

  setShowArchived: (showArchived) => set({ showArchived }),

  setApprovals: (id, approvals) =>
    set((st) => ({
      sessionState: {
        ...st.sessionState,
        [id]: { ...(st.sessionState[id] ?? emptySession()), approvals },
      },
    })),

  setQuestions: (id, questions) =>
    set((st) => ({
      sessionState: {
        ...st.sessionState,
        [id]: { ...(st.sessionState[id] ?? emptySession()), questions },
      },
    })),

  setTasks: (id, tasks) =>
    set((st) => ({
      sessionState: {
        ...st.sessionState,
        [id]: { ...(st.sessionState[id] ?? emptySession()), tasks },
      },
    })),

  setGoal: (id, goal) =>
    set((st) => ({
      sessionState: {
        ...st.sessionState,
        [id]: { ...(st.sessionState[id] ?? emptySession()), goal },
      },
    })),

  applyStatus: (id, s) =>
    set((st) => {
      const prev = st.sessionState[id] ?? emptySession()
      const usage: SessionUsage = {
        input_tokens: prev.usage?.input_tokens ?? 0,
        output_tokens: prev.usage?.output_tokens ?? 0,
        cache_read_tokens: prev.usage?.cache_read_tokens ?? 0,
        cache_creation_tokens: prev.usage?.cache_creation_tokens ?? 0,
        total_cost_usd: prev.usage?.total_cost_usd ?? 0,
        context_tokens: s.context_tokens ?? prev.usage?.context_tokens ?? 0,
        context_limit: s.max_context_tokens ?? prev.usage?.context_limit ?? 0,
        turn_count: prev.usage?.turn_count ?? 0,
      }
      const summary = prev.summary
        ? {
            ...prev.summary,
            agent_config: {
              ...prev.summary.agent_config,
              ...(s.model ? { model: s.model } : {}),
              ...(s.permission ? { permission_mode: s.permission } : {}),
              ...(s.plan_mode !== undefined ? { plan_mode: s.plan_mode } : {}),
              ...(s.swarm_mode !== undefined ? { swarm_mode: s.swarm_mode } : {}),
              ...(s.thinking_level ? { thinking: s.thinking_level } : {}),
            },
          }
        : prev.summary
      return {
        sessionState: {
          ...st.sessionState,
          [id]: { ...prev, usage, summary },
        },
      }
    }),

  mergeUsage: (id, u) =>
    set((st) => {
      const prev = st.sessionState[id]
      if (!prev) return st
      // The sessions list reports all-zero usage for TUI-owned sessions; never
      // let zeros clobber real values pulled from /status or the snapshot.
      const merged = { ...(prev.usage ?? {}) } as SessionUsage
      let any = false
      for (const [k, v] of Object.entries(u)) {
        if (typeof v === 'number' && v !== 0) {
          ;(merged as unknown as Record<string, number>)[k] = v
          any = true
        }
      }
      // An all-zero payload with nothing real yet would leave a field-less
      // object — truthy but missing context_tokens, which crashes the rail.
      if (!any && !prev.usage) return st
      return {
        sessionState: {
          ...st.sessionState,
          [id]: { ...prev, usage: merged },
        },
      }
    }),

  setQueue: (id, q) =>
    set((st) => ({
      sessionState: {
        ...st.sessionState,
        [id]: { ...(st.sessionState[id] ?? emptySession()), queue: q },
      },
    })),

  addToOutbox: (id, item) =>
    set((st) => {
      const prev = st.sessionState[id] ?? emptySession()
      return {
        sessionState: {
          ...st.sessionState,
          [id]: { ...prev, outbox: [...prev.outbox, item] },
        },
      }
    }),

  clearOutbox: (id, localId) =>
    set((st) => {
      const prev = st.sessionState[id]
      if (!prev) return st
      return {
        sessionState: {
          ...st.sessionState,
          [id]: {
            ...prev,
            outbox: localId ? prev.outbox.filter((o) => o.localId !== localId) : [],
          },
        },
      }
    }),

  setSkills: (id, skills) =>
    set((st) => ({
      sessionState: {
        ...st.sessionState,
        [id]: { ...(st.sessionState[id] ?? emptySession()), skills },
      },
    })),

  applySnapshot: (id, snap) =>
    set((st) => {
      const prev = st.sessionState[id] ?? emptySession()
      const toolCalls: Record<string, ToolCallRecord> = {}
      // Rebuild tool records from history blocks.
      for (const m of snap.messages.items) {
        for (const b of m.content ?? []) {
          if (b.type === 'tool_use') {
            const tb = b as { tool_call_id: string; tool_name: string; input: unknown }
            toolCalls[tb.tool_call_id] = {
              toolCallId: tb.tool_call_id,
              name: tb.tool_name,
              args: tb.input,
              status: 'running',
            }
          }
          if (b.type === 'tool_result') {
            const tb = b as { tool_call_id: string; output: unknown; is_error?: boolean }
            const rec = toolCalls[tb.tool_call_id]
            if (rec) {
              rec.output = tb.output
              rec.isError = tb.is_error
              rec.status = tb.is_error ? 'error' : 'done'
            }
          }
        }
      }
      // A snapshot taken while idle: result-less calls died with their turn.
      if (!snap.session.busy) {
        for (const rec of Object.values(toolCalls)) {
          if (rec.status === 'running' && rec.output === undefined) rec.status = 'interrupted'
        }
      }
      return {
        sessionState: {
          ...st.sessionState,
          [id]: {
            ...prev,
            summary: snap.session,
            // Guard: a mid-turn snapshot can lag the stream; never blank good history.
            messages: snap.messages.items.length > 0 ? snap.messages.items : prev.messages,
            toolCalls: snap.messages.items.length > 0 ? toolCalls : prev.toolCalls,
            usage: (() => {
              const su = snap.session.usage
              // REST usage is all zeros in 0.27.0 — keep frame-accumulated values.
              const hasReal =
                su &&
                Object.values(su).some((v) => typeof v === 'number' && v !== 0)
              if (hasReal) return su
              return prev.usage ?? su ?? null
            })(),
            busy: snap.session.busy,
            pendingInteraction: snap.session.pending_interaction,
            cursor: { seq: snap.as_of_seq, epoch: snap.epoch },
            streaming: snap.session.busy ? { ...emptyStreaming(), active: true } : emptyStreaming(),
            approvals: (snap.pending_approvals as ApprovalItem[]) ?? [],
            questions: (snap.pending_questions as QuestionItem[]) ?? [],
            todos: snap.messages.items.length > 0 ? extractTodos(snap.messages.items) : prev.todos,
            hasMore: snap.messages.has_more,
            lastError: null,
          },
        },
      }
    }),

  applyFrame: (f) =>
    set((st) => {
      const id = f.session_id
      if (!id) return st
      const prev = st.sessionState[id] ?? emptySession()
      const p = f.payload as Record<string, unknown> & { type?: string }
      const t = p?.type ?? f.type
      // Subagent frames share the session stream; route them to their own record
      // so they never pollute the main agent's streaming buffers or history.
      const aid = (p.agentId as string) ?? 'main'
      const isMain = aid === 'main'

      const routeToSubagent = (fn: (rec: SubagentRecord) => SubagentRecord): SessionState => ({
        ...next,
        subagents: next.subagents[aid]
          ? { ...next.subagents, [aid]: fn(next.subagents[aid]) }
          : next.subagents,
      })

      // Advance the stream cursor; tolerate repeated seq (same commit batch).
      let cursor = prev.cursor
      if (f.epoch && typeof f.seq === 'number') {
        cursor = { seq: Math.max(cursor?.seq ?? 0, f.seq), epoch: f.epoch }
      }

      const next: SessionState = { ...prev, cursor }

      switch (t) {
        case 'session.meta.updated': {
          if (next.summary)
            next.summary = { ...next.summary, ...(p.patch as object) } as SessionSummary
          break
        }
        case 'event.session.work_changed': {
          if (!isMain) break
          next.busy = Boolean(p.busy)
          next.pendingInteraction = String(p.pending_interaction ?? 'none')
          if (!p.busy) next.streaming = { ...emptyStreaming() }
          break
        }
        case 'session.usage_updated': {
          next.usage = (p.usage as SessionUsage) ?? next.usage
          break
        }
        case 'turn.started': {
          if (!isMain) break
          next.streaming = { active: true, turnId: p.turnId as number, thinking: '', assistant: '' }
          next.busy = true
          break
        }
        case 'turn.step.started': {
          if (!isMain) break
          next.streaming = { ...next.streaming, thinking: '', assistant: '' }
          break
        }
        case 'thinking.delta': {
          if (!isMain) {
            Object.assign(
              next,
              routeToSubagent((rec) => ({ ...rec, thinking: (rec.thinking ?? '') + (p.delta as string) })),
            )
            break
          }
          next.streaming = { ...next.streaming, thinking: next.streaming.thinking + (p.delta as string) }
          break
        }
        case 'assistant.delta': {
          if (!isMain) {
            Object.assign(
              next,
              routeToSubagent((rec) => ({ ...rec, assistant: (rec.assistant ?? '') + (p.delta as string) })),
            )
            break
          }
          next.streaming = { ...next.streaming, assistant: next.streaming.assistant + (p.delta as string) }
          break
        }
        case 'tool.call.delta': {
          const cid = p.toolCallId as string
          const rec = next.toolCalls[cid] ?? {
            toolCallId: cid,
            name: (p.name as string) ?? '?',
            status: 'running' as const,
          }
          rec.args = String((rec.args as string) ?? '') + (p.argumentsPart as string)
          next.toolCalls = { ...next.toolCalls, [cid]: { ...rec } }
          break
        }
        case 'tool.call.started': {
          const cid = p.toolCallId as string
          next.toolCalls = {
            ...next.toolCalls,
            [cid]: {
              toolCallId: cid,
              name: p.name as string,
              agentId: (p.agentId as string) ?? 'main',
              args: p.args,
              description: p.description as string | undefined,
              display: p.display as ToolCallRecord['display'],
              status: 'running',
            },
          }
          if (p.name === 'TodoList') {
            const todos = (p.args as { todos?: TodoItem[] })?.todos
            if (Array.isArray(todos)) next.todos = todos
          }
          break
        }
        case 'tool.progress': {
          const cid = p.toolCallId as string
          const rec = next.toolCalls[cid]
          if (rec) {
            const u = p.update as { kind: string; text?: string }
            const text = u?.text ?? ''
            next.toolCalls = {
              ...next.toolCalls,
              [cid]: { ...rec, progressText: (rec.progressText ?? '') + text },
            }
          }
          break
        }
        case 'tool.result': {
          const cid = p.toolCallId as string
          const rec = next.toolCalls[cid] ?? {
            toolCallId: cid,
            name: '?',
            status: 'running' as const,
          }
          next.toolCalls = {
            ...next.toolCalls,
            [cid]: {
              ...rec,
              output: p.output,
              isError: Boolean(p.isError),
              status: p.isError ? 'error' : 'done',
            },
          }
          break
        }
        case 'subagent.spawned': {
          const sid = p.subagentId as string
          next.subagents = {
            ...next.subagents,
            [sid]: {
              subagentId: sid,
              name: (p.subagentName as string) ?? sid,
              description: p.description as string | undefined,
              parentToolCallId: p.parentToolCallId as string | undefined,
              runInBackground: Boolean(p.runInBackground),
              status: 'running',
            },
          }
          break
        }
        case 'subagent.completed': {
          const sid = p.subagentId as string
          const rec = next.subagents[sid]
          if (rec) {
            next.subagents = {
              ...next.subagents,
              [sid]: { ...rec, status: 'done', resultSummary: p.resultSummary as string | undefined },
            }
          }
          break
        }
        case 'context.spliced': {
          if (!isMain) break // subagent transcripts stay out of the main history
          const start = p.start as number
          const del = p.deleteCount as number
          const msgs = (p.messages as ChatMessage[]) ?? []
          if (del > 0) {
            // History was rewritten (e.g. compaction); safest to refetch.
            next.synced = false
            break
          }
          const existing = new Set(next.messages.map((m) => m.id))
          const fresh = msgs.filter((m) => !existing.has(m.id))
          if (fresh.length) {
            const merged = [...next.messages]
            merged.splice(Math.min(start, merged.length), 0, ...fresh)
            next.messages = merged
          }
          break
        }
        case 'turn.step.completed': {
          if (!isMain) break
          // REST usage is all zeros in 0.27.0 — accumulate from step frames.
          const u = p.usage as
            | { inputOther?: number; output?: number; inputCacheRead?: number; inputCacheCreation?: number }
            | undefined
          if (u) {
            const base: SessionUsage = next.usage ?? {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
              total_cost_usd: 0,
              context_tokens: 0,
              context_limit: 0,
              turn_count: 0,
            }
            next.usage = {
              ...base,
              input_tokens: base.input_tokens + (u.inputOther ?? 0),
              output_tokens: base.output_tokens + (u.output ?? 0),
              cache_read_tokens: base.cache_read_tokens + (u.inputCacheRead ?? 0),
              cache_creation_tokens: base.cache_creation_tokens + (u.inputCacheCreation ?? 0),
            }
          }
          break
        }
        case 'turn.ended': {
          if (!isMain) break
          next.streaming = { ...next.streaming, active: false }
          if (next.usage) next.usage = { ...next.usage, turn_count: next.usage.turn_count + 1 }
          if (p.reason === 'failed' && p.error) {
            next.lastError = `${(p.error as { code?: string }).code}: ${(p.error as { message?: string }).message}`
          }
          Object.assign(next, sweepInterrupted(next))
          break
        }
        case 'prompt.completed': {
          if (!isMain) break
          next.busy = false
          next.streaming = { ...next.streaming, active: false }
          Object.assign(next, sweepInterrupted(next))
          break
        }
        case 'approval.resolved': {
          const apId = p.approval_id ?? p.approvalId
          if (apId) next.approvals = next.approvals.filter((a) => a.approval_id !== apId)
          break
        }
        case 'question.answered':
        case 'question.dismissed': {
          const qid = p.question_id ?? p.questionId
          if (qid) next.questions = next.questions.filter((q) => q.question_id !== qid)
          break
        }
        case 'error': {
          next.lastError = `${p.code}: ${p.message}`
          break
        }
        default:
          break
      }

      return { sessionState: { ...st.sessionState, [id]: next } }
    }),
}))
