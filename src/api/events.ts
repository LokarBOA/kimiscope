// WS event model for the kimi daemon stream.
// Typed payloads below were captured live from kimi 0.27.0 (see reference/probe-frames.json);
// event types not yet observed fall through as `unknown` payloads.

export interface Frame<P = unknown> {
  type: string
  seq: number
  session_id: string
  timestamp: string
  epoch: string
  volatile?: boolean
  payload: P
}

// ---- content blocks (message model, mirrors REST /messages) ----
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | string
  content: ContentBlock[]
  toolCalls?: ToolCallRecord[]
  origin?: { kind: string }
  created_at?: string
}

export interface ToolCallRecord {
  toolCallId: string
  name: string
  agentId?: string
  args?: unknown
  description?: string
  display?: { kind: string; command?: string; cwd?: string; language?: string; [k: string]: unknown }
  output?: unknown
  isError?: boolean
  status: 'running' | 'done' | 'error' | 'interrupted'
  progressText?: string
}

export interface SubagentRecord {
  subagentId: string
  name: string
  description?: string
  parentToolCallId?: string
  runInBackground?: boolean
  status: 'running' | 'done'
  resultSummary?: string
  /** Live streaming buffers while the subagent works. */
  thinking?: string
  assistant?: string
}

// ---- observed session-event payloads ----
export interface TurnStarted {
  type: 'turn.started'
  turnId: number
  origin: { kind: string }
}
export interface TurnEnded {
  type: 'turn.ended'
  turnId: number
  reason: 'completed' | 'failed' | 'interrupted' | string
  error?: { code: string; message: string; retryable?: boolean }
  durationMs?: number
}
export interface StepStarted {
  type: 'turn.step.started'
  turnId: number
  step: number
}
export interface StepCompleted {
  type: 'turn.step.completed'
  turnId: number
  step: number
  usage?: { inputOther?: number; output?: number; inputCacheRead?: number; inputCacheCreation?: number }
  finishReason?: string
}
export interface StepInterrupted {
  type: 'turn.step.interrupted'
  turnId: number
  step: number
  reason: string
  message?: string
}
export interface ThinkingDelta {
  type: 'thinking.delta'
  turnId: number
  delta: string
}
export interface AssistantDelta {
  type: 'assistant.delta'
  turnId: number
  delta: string
}
export interface ToolCallStarted {
  type: 'tool.call.started'
  turnId: number
  toolCallId: string
  name: string
  args?: unknown
  description?: string
  display?: ToolCallRecord['display']
}
export interface ToolCallDelta {
  type: 'tool.call.delta'
  turnId: number
  toolCallId: string
  name: string
  argumentsPart: string
}
export interface ToolProgress {
  type: 'tool.progress'
  turnId: number
  toolCallId: string
  update: { kind: string; text?: string; [k: string]: unknown }
}
export interface ToolResult {
  type: 'tool.result'
  turnId: number
  toolCallId: string
  output: unknown
  isError?: boolean
}
export interface ContextSpliced {
  type: 'context.spliced'
  start: number
  deleteCount: number
  messages: ChatMessage[]
}
export interface WorkChanged {
  type: 'event.session.work_changed'
  busy: boolean
  main_turn_active: boolean
  pending_interaction: string
}
export interface SessionMetaUpdated {
  type: 'session.meta.updated'
  patch: Record<string, unknown>
}
export interface UsageUpdated {
  type: 'session.usage_updated'
  usage?: SessionUsage
  [k: string]: unknown
}
export interface SessionUsage {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  total_cost_usd: number
  context_tokens: number
  context_limit: number
  turn_count: number
}
export interface PromptCompleted {
  type: 'prompt.completed'
  promptId: string
  finishedAt: string
  reason: string
}
export interface ErrorPayload {
  type: 'error'
  code: string
  message: string
  retryable?: boolean
}

// ---- approvals / questions (observed 0.27.0) ----
export interface ApprovalRequest {
  type: 'event.approval.requested'
  approval_id: string
  tool_call_id: string
  tool_name: string
  action: string
  tool_input?: unknown
  tool_input_display?: ToolCallRecord['display']
  created_at: string
  expires_at: string
}
export interface ApprovalResolved {
  type: 'event.approval.resolved'
  approval_id: string
  decision?: string
}
export interface TodoItem {
  title: string
  status: 'pending' | 'in_progress' | 'done' | string
}

export interface TaskItem {
  id: string
  kind: string
  description?: string
  command?: string
  status: 'running' | 'completed' | 'cancelled' | 'failed' | string
  created_at?: string
  started_at?: string
  completed_at?: string
  exit_code?: number
  stop_reason?: string
  /** Only present on the detail endpoint (GET .../tasks/{id}). */
  output_preview?: string
  output_bytes?: number
}

export interface GoalState {
  goalId: string
  objective: string
  status: 'active' | 'paused' | 'completed' | 'blocked' | 'cancelled' | string
  turnsUsed: number
  tokensUsed: number
  wallClockMs: number
  budget?: {
    tokenBudget: number | null
    turnBudget: number | null
    wallClockBudgetMs: number | null
    overBudget: boolean
    [k: string]: unknown
  }
}

export type SessionEventPayload =
  | TurnStarted
  | TurnEnded
  | StepStarted
  | StepCompleted
  | StepInterrupted
  | ThinkingDelta
  | AssistantDelta
  | ToolCallStarted
  | ToolCallDelta
  | ToolProgress
  | ToolResult
  | ContextSpliced
  | WorkChanged
  | SessionMetaUpdated
  | UsageUpdated
  | PromptCompleted
  | ErrorPayload
  | { type: string; [k: string]: unknown }

// ---- approvals & questions (REST) ----
export interface ApprovalItem {
  approval_id: string
  session_id: string
  turn_id: number
  tool_call_id: string
  tool_name: string
  action: string
  tool_input_display: unknown
  created_at: string
  expires_at: string
}

export interface QuestionOption {
  id: string
  label: string
  description?: string
  [k: string]: unknown
}

/** One sub-question of an AskUserQuestion call (observed 0.27.0). */
export interface SubQuestion {
  id: string
  question: string
  header?: string
  multi_select?: boolean
  allow_other?: boolean
  options: QuestionOption[]
}

export interface QuestionItem {
  question_id: string
  session_id: string
  questions?: SubQuestion[]
  [k: string]: unknown
}

// ---- snapshot (REST GET /sessions/{id}/snapshot) ----
export interface SessionSummary {
  id: string
  workspace_id: string
  title: string
  created_at: string
  updated_at: string
  busy: boolean
  main_turn_active: boolean
  pending_interaction: string
  archived?: boolean
  last_prompt?: string
  last_turn_reason?: string
  metadata?: { cwd?: string }
  agent_config?: {
    model?: string
    permission_mode?: string
    plan_mode?: boolean
    swarm_mode?: boolean
    thinking?: string
  }
  usage?: SessionUsage
  message_count?: number
  last_seq?: number
}

/** Writable subset of the session profile's agent_config (POST /sessions/{id}/profile). */
export interface AgentConfigPatch {
  model?: string
  permission_mode?: 'manual' | 'yolo' | 'auto'
  plan_mode?: boolean
  swarm_mode?: boolean
  thinking?: string
  goal_objective?: string
  goal_control?: 'pause' | 'resume' | 'cancel'
}

/** A skill invocable via the Composer `/` menu (GET /sessions/{id}/skills). */
export interface SkillInfo {
  name: string
  description: string
  path: string
  source: 'project' | 'user' | 'extra' | 'builtin'
  type?: string
  disable_model_invocation?: boolean
}

export interface Snapshot {
  as_of_seq: number
  epoch: string
  session: SessionSummary
  messages: { items: ChatMessage[]; has_more: boolean }
  in_flight_turn: unknown | null
  subagents: unknown[]
  pending_approvals: unknown[]
  pending_questions: unknown[]
}
