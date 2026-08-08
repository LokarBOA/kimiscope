import { get, post, ApiError } from '../api/client'
import { getConnectionInfo } from '../api/connection'
import { notifyAttention } from '../api/notify'
import { KimiSocket } from '../api/ws'
import type {
  AgentConfigPatch,
  ApprovalItem,
  Frame,
  GoalState,
  QuestionItem,
  SessionSummary,
  SkillInfo,
  Snapshot,
  TaskItem,
} from '../api/events'
import { parseSlash, THINKING_LEVELS } from './commands'
import { transcriptToMessages, type TranscriptPage } from './transcript'
import { useApp, type ModelInfo, type PromptQueue, type Workspace } from './store'

let socket: KimiSocket | null = null
const watching = new Set<string>()
let sessionPoll: ReturnType<typeof setInterval> | null = null
let queuePoll: ReturnType<typeof setInterval> | null = null

interface Meta {
  server_version: string
}

/** Server version stamp — re-fetched on every socket (re)connect so a daemon
 *  restart (which drops the socket) updates the top bar without an app reload. */
export async function refreshServerMeta(): Promise<void> {
  await get<Meta>('/meta')
    .then((m) => useApp.getState().setServerVersion(m.server_version))
    .catch(() => {})
}

let booted = false

/** Re-run boot after an init failure (the Retry button on the error screen). */
export function retryInit(): void {
  useApp.getState().setInitError(null)
  booted = false
  void initApp()
}

/** Boot: connection info, server meta, workspace/session lists, shared socket. */
export async function initApp(): Promise<void> {
  if (booted) return // StrictMode double-invokes effects in dev
  booted = true
  // Retry with pauses: on a cold machine (fresh boot, slow VM) the daemon
  // spawn can outlast the Rust side's warm-up wait, and a later attempt's
  // discovery finds the server the first attempt spawned.
  let conn: Awaited<ReturnType<typeof getConnectionInfo>> | null = null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3 && !conn; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000))
    conn = await getConnectionInfo(true).catch((e: unknown) => {
      lastErr = e
      return null
    })
  }
  if (!conn) {
    useApp.getState().setInitError(String(lastErr instanceof Error ? lastErr.message : lastErr))
    return
  }
  useApp.getState().setConnection(conn)

  void refreshServerMeta()

  // Model catalog + configured default, for session creation and the picker.
  Promise.all([
    get<{ items: ModelInfo[] }>('/models').catch(() => ({ items: [] as ModelInfo[] })),
    get<{ default_model?: string }>('/config').catch(() => ({}) as { default_model?: string }),
  ]).then(([models, cfg]) => {
    useApp.getState().setModels(models.items ?? [], cfg.default_model ?? null)
  })

  await Promise.all([refreshSessions(), refreshWorkspaces()])

  socket = new KimiSocket(conn.wsUrl, conn.token, {
    onFrame: handleFrame,
    onReset: () => {
      // Socket dropped: every watched session must be re-snapshotted.
      for (const id of watching) useApp.getState().markUnsynced(id)
      for (const id of [...watching]) void watchSession(id)
    },
    onStateChange: (s) => {
      useApp.getState().setSocketState(s)
      if (s === 'open') {
        // Fresh connection — the daemon may have restarted while we were down.
        void refreshServerMeta()
        // (Re)subscribe anything that failed while the socket was down.
        for (const id of watching) {
          if (!useApp.getState().sessionState[id]?.synced) void watchSession(id)
        }
      }
    },
  })
  socket.connect()

  sessionPoll = setInterval(() => {
    void refreshSessions()
    void refreshWorkspaces()
    void pollTaskCompletions()
  }, 10_000)

  // Prompt queues for every watched session, fast enough to feel live.
  queuePoll = setInterval(() => {
    const st = useApp.getState()
    for (const id of watching) {
      const s = st.sessionState[id]
      if (!s) continue
      if (s.busy || (s.queue?.queued.length ?? 0) > 0 || s.queue?.active) {
        void getPromptQueue(id)
          .then((q) => useApp.getState().setQueue(id, q))
          .catch(() => {})
      }
    }
  }, 2_500)
}

export async function refreshSessions(): Promise<void> {
  try {
    const includeArchived = useApp.getState().showArchived ? '&include_archive=true' : ''
    const [sessions, workspaces] = await Promise.all([
      get<{ items: SessionSummary[] }>(`/sessions?limit=100${includeArchived}`),
      get<{ items: Workspace[] }>('/workspaces').catch(() => ({ items: [] as Workspace[] })),
    ])
    useApp.getState().setSessions(sessions.items ?? [])
    useApp.getState().setWorkspaces(workspaces.items ?? [])
    // Keep cost/token usage fresh for sessions we're already watching.
    for (const s of sessions.items ?? []) {
      if (s.usage && useApp.getState().sessionState[s.id]) {
        useApp.getState().mergeUsage(s.id, s.usage)
      }
    }
    void refreshSessionActivity()
  } catch {
    // daemon hiccup; next poll recovers
  }
}

interface V2SessionItem {
  id: string
  activity?: { status?: string }
}

let v2SessionsUnsupported = false

/** 0.34+ enrichment: pull `/api/v2/sessions` and map sessionId → activity.status
 *  (failed/approval/question/running/idle) for sidebar markers + the attention
 *  filter. Silent no-op on older daemons (one 404 probe, then stays off). */
export async function refreshSessionActivity(): Promise<void> {
  if (v2SessionsUnsupported) return
  try {
    const map: Record<string, string> = {}
    let token: string | null = null
    for (let page = 0; page < 5; page++) {
      const qs = token ? `?page_token=${encodeURIComponent(token)}` : ''
      const res = await get<{ items?: V2SessionItem[]; has_more?: boolean; next_page_token?: string | null }>(
        `/v2/sessions${qs}`,
      )
      for (const it of res.items ?? []) {
        if (it.activity?.status) map[it.id] = it.activity.status
      }
      token = res.next_page_token ?? null
      if (!token || !res.has_more) break
    }
    useApp.getState().setSessionActivity(map)
  } catch {
    v2SessionsUnsupported = true
  }
}

export async function refreshWorkspaces(): Promise<void> {
  try {
    const res = await get<{ items: import('./store').Workspace[] }>('/workspaces')
    useApp.getState().setWorkspaces(res.items ?? [])
    void refreshWorkspaceTrust()
  } catch {
    // daemon hiccup
  }
}

/** null = untested; 404 on first probe = daemon without trust (≤0.30) — never probe again. */
let trustSupported: boolean | null = null
/** null = untested; 404 on first probe = daemon without /transcript/plan (≤0.28). */
let planSupported: boolean | null = null

/** 0.29+ only: pull ExitPlanMode plan records into session state (keyed by
 *  tool_call_id). Older daemons 404 once and are never re-probed. */
export async function pullPlans(sessionId: string): Promise<void> {
  if (planSupported === false) return
  try {
    const res = await get<{ plans?: import('./store').PlanRecord[] }>(
      `/sessions/${sessionId}/transcript/plan?agent_id=main`,
    )
    planSupported = true
    const map: Record<string, import('./store').PlanRecord> = {}
    for (const p of res.plans ?? []) map[p.tool_call_id] = p
    useApp.getState().setPlans(sessionId, map)
  } catch {
    if (planSupported === null) planSupported = false
  }
}

/** 0.31+ only: daemon-created workspaces start untrusted, which disables their
 *  project-level mcp.json. Probe each workspace's trust state once per refresh;
 *  daemons without the trust endpoint (≤0.30) 404 once and are never re-probed. */
export async function refreshWorkspaceTrust(): Promise<void> {
  if (trustSupported === false) return
  const st = useApp.getState()
  const results: (readonly [string, boolean] | null)[] = []
  for (const w of st.workspaces) {
    const r = await get<{ trusted: boolean }>(`/workspaces/${w.id}/trust`)
      .then((res) => [w.id, res.trusted] as const)
      .catch(() => null)
    if (!r && trustSupported === null) {
      trustSupported = false // first probe ever 404'd — older daemon, stop here
      return
    }
    trustSupported = true
    results.push(r)
  }
  const map: Record<string, boolean> = {}
  for (const r of results) if (r) map[r[0]] = r[1]
  useApp.getState().setWorkspaceTrustAll(map)
}

/** Grant trust for one workspace (0.31+); silently ignored on older daemons. */
export async function trustWorkspace(workspaceId: string): Promise<void> {
  try {
    await post(`/workspaces/${workspaceId}/trust`, {})
    useApp.getState().setWorkspaceTrust(workspaceId, true)
  } catch {
    // ≤0.30 — no trust concept
  }
}

function handleFrame(f: Frame) {
  if (f.type === 'resync_required') {
    const sid = (f.payload as { session_id?: string })?.session_id ?? f.session_id
    if (sid) {
      useApp.getState().markUnsynced(sid)
      void watchSession(sid)
    }
    return
  }
  const t = (f.payload as { type?: string })?.type ?? f.type
  // The WS stream never carries completed assistant messages — only the user
  // message splice and live deltas. Pull authoritative history at turn end and
  // after context rewrites (compaction), debounced across the end-of-turn burst.
  if (t === 'turn.ended' || t === 'prompt.completed') scheduleHistoryPull(f.session_id)
  if (t === 'context.spliced' && (f.payload as { deleteCount?: number }).deleteCount) {
    scheduleHistoryPull(f.session_id)
  }
  // Interaction events carry sparse payloads; refetch the authoritative lists.
  // Observed names: event.approval.requested, permission.approval.requested,
  // event.question.requested/answered — match the inner family regardless of prefix.
  if (/(approval|question)\./.test(t) && f.session_id) {
    void refreshInteractions(f.session_id)
  }
  if (/^(task|background\.task)\./.test(t) && f.session_id) {
    void refreshTasks(f.session_id)
  }
  // Completion badge: a task finished in a session you're not looking at.
  if ((t === 'task.terminated' || t === 'background.task.terminated') && f.session_id) {
    const st = useApp.getState()
    if (st.activeSessionId !== f.session_id) {
      const title = st.sessionState[f.session_id]?.summary?.title ?? 'another session'
      void notifyAttention(`background task finished — ${title.slice(0, 40)}`)
    }
  }
  if (t === 'goal.updated' && f.session_id) {
    void refreshGoal(f.session_id)
  }
  if (t === 'context.spliced' && f.session_id) {
    // A message we sent just landed in history — retire its outbox bubble.
    const msgs = (f.payload as { messages?: { role?: string; content?: { type?: string; text?: string }[] }[] })
      .messages ?? []
    const texts = msgs
      .filter((m) => m.role === 'user')
      .flatMap((m) => (m.content ?? []).map((c) => c.text ?? ''))
    const outbox = useApp.getState().sessionState[f.session_id]?.outbox ?? []
    for (const item of outbox) {
      if (texts.some((t) => t === item.text || t.includes(item.text))) {
        useApp.getState().clearOutbox(f.session_id, item.localId)
      }
    }
  }
  if (t === 'turn.step.started' && f.session_id) {
    // Steered messages materialize at step boundaries — pull to reveal them.
    scheduleHistoryPull(f.session_id)
  }
  if (t === 'prompt.steered' && f.session_id) {
    // Steered prompt joins the turn; refresh queue + history so it shows up.
    void getPromptQueue(f.session_id)
      .then((q) => useApp.getState().setQueue(f.session_id, q))
      .catch(() => {})
    scheduleHistoryPull(f.session_id)
  }
  // Compaction rewrites context; pull so the projected summary message lands
  // (and renders as the ✂ divider card instead of a fake user bubble).
  if (t === 'compaction.completed' && f.session_id) {
    scheduleHistoryPull(f.session_id)
  }
  // MCP OAuth failures arrive as structured error codes (0.32+). Surface the
  // fix path at once instead of waiting for the user to open Settings.
  if ((f.payload as { code?: string })?.code === 'mcp.oauth_failed') {
    const server = (f.payload as { server?: string; message?: string })?.server
    useApp
      .getState()
      .setSyncIssue(
        `MCP server ${server ?? ''} needs OAuth login — run /mcp-config login${server ? ` ${server}` : ''} in the kimi TUI, then restart the daemon from Settings ⚙`,
      )
    void notifyAttention('MCP server needs login')
  }
  // Attention nudges: turn finished, or the agent needs a human.
  const isMain = ((f.payload as { agentId?: string })?.agentId ?? 'main') === 'main'
  if (isMain && t === 'prompt.completed') {
    const title = useApp.getState().sessionState[f.session_id]?.summary?.title ?? 'session'
    void notifyAttention(`turn finished — ${title.slice(0, 40)}`)
  }
  if (t === 'event.approval.requested' || t === 'question.requested') {
    void notifyAttention(t === 'event.approval.requested' ? 'approval needed' : 'question asked')
  }
  useApp.getState().applyFrame(f)
}

interface SessionStatus {
  context_tokens?: number
  max_context_tokens?: number
  model?: string
  permission?: string
  plan_mode?: boolean
  swarm_mode?: boolean
  thinking_level?: string
}

/** Pull live context/model/permission/plan/swarm/thinking status (usage_updated
 *  frames don't fire, and GET /profile + snapshots return a sparse projection). */
export async function refreshStatus(id: string): Promise<void> {
  try {
    const s = await get<SessionStatus>(`/sessions/${id}/status`)
    useApp.getState().applyStatus(id, s)
  } catch {
    // daemon hiccup
  }
}

/** Refetch the current goal (null when none). */
export async function refreshGoal(id: string): Promise<void> {
  try {
    const g = await get<GoalState | null>(`/sessions/${id}/goal`)
    useApp.getState().setGoal(id, g && typeof g === 'object' && 'goalId' in g ? g : null)
  } catch {
    // daemon hiccup
  }
}

/** Create or control a goal via the session profile. */
export async function goalControl(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  await post(`/sessions/${id}/profile`, { agent_config: { goal_control: action } })
  await refreshGoal(id)
}

export async function goalCreate(id: string, objective: string): Promise<void> {
  await post(`/sessions/${id}/profile`, { agent_config: { goal_objective: objective } })
  await refreshGoal(id)
}

/** Refetch invocable skills for the Composer `/` menu. */
export async function refreshSkills(id: string): Promise<void> {
  try {
    const res = await get<{ skills: SkillInfo[] }>(`/sessions/${id}/skills`)
    useApp.getState().setSkills(id, res.skills ?? [])
  } catch {
    // daemon hiccup
  }
}

/** Toggle model / permission / plan / swarm etc. via the session profile.
 *  State re-syncs from /status — the profile GET returns a sparse projection. */
export async function updateAgentConfig(id: string, patch: AgentConfigPatch): Promise<void> {
  await post(`/sessions/${id}/profile`, { agent_config: patch })
  await refreshStatus(id)
}

export async function renameSession(id: string, title: string): Promise<void> {
  await post(`/sessions/${id}/profile`, { title })
  await refreshSessions()
}

/** Fork into a child session (preserving full history). The child joins the
 *  session list; we stay on the current session (kimi 0.33+ semantics — the
 *  fork is visible at the top of its project group after the refresh). */
export async function forkSession(id: string): Promise<void> {
  await post<{ id: string }>(`/sessions/${id}/children`, {})
  await refreshSessions()
}

/** Export session + diagnostic logs as a zip. The endpoint streams the archive
 *  binary directly (no JSON envelope), so this bypasses the typed client and
 *  triggers a browser download. Returns the filename used. */
export async function exportSession(id: string): Promise<string> {
  const conn = await getConnectionInfo()
  const res = await fetch(`${conn.baseUrl}/api/v1/sessions/${id}/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`export failed: ${res.status}`)
  const cd = res.headers.get('Content-Disposition') ?? ''
  const named = /filename="?([^";]+)"?/.exec(cd)?.[1]
  const filename = named ?? `session-${id.slice(8, 16)}.zip`
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return filename
}

/** Activate a skill in the session — REST analogue of the /<skill> slash command.
 *  (Tail is `{name}:activate`; a bare name is rejected as an unknown action.) */
export async function activateSkill(id: string, name: string, args: string): Promise<void> {
  await post(`/sessions/${id}/skills/${name}:activate`, { args })
}

function lastAssistantText(id: string): string | null {
  const msgs = useApp.getState().sessionState[id]?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue
    const text = (msgs[i].content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
    if (text.trim()) return text
  }
  return null
}

export interface SlashResult {
  handled: boolean
  notice?: string
}

/** Execute a `/command` client-side against the daemon (the daemon itself
 *  treats `/...` as plain prompt text — verified by probe). Returns
 *  handled=false for unknown input so the Composer falls through to a normal
 *  send, matching CLI semantics. */
export async function runSlashCommand(id: string, raw: string): Promise<SlashResult> {
  const p = parseSlash(raw)
  if (!p) return { handled: false }
  const { name, args } = p
  try {
    switch (name) {
      case 'yolo':
      case 'auto':
      case 'manual':
        await updateAgentConfig(id, { permission_mode: name })
        return { handled: true, notice: `permission → ${name}` }
      case 'plan': {
        const cur = useApp.getState().sessionState[id]?.summary?.agent_config?.plan_mode ?? false
        const next = args === 'on' ? true : args === 'off' ? false : !cur
        await updateAgentConfig(id, { plan_mode: next })
        return { handled: true, notice: `plan mode → ${next ? 'on' : 'off'}` }
      }
      case 'model': {
        if (!args) return { handled: true, notice: 'usage: /model <alias>' }
        const models = useApp.getState().models
        const m = models.find((x) => x.model === args) ?? models.find((x) => x.model.includes(args))
        if (!m) return { handled: true, notice: `no model matching "${args}"` }
        await updateAgentConfig(id, { model: m.model })
        return { handled: true, notice: `model → ${m.display_name || m.model}` }
      }
      case 'thinking': {
        const level = args.toLowerCase()
        if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) {
          return { handled: true, notice: `usage: /thinking <${THINKING_LEVELS.join('|')}>` }
        }
        await updateAgentConfig(id, { thinking: level })
        return { handled: true, notice: `thinking → ${level}` }
      }
      case 'title': {
        if (!args) return { handled: true, notice: 'usage: /title <text>' }
        await renameSession(id, args.slice(0, 200))
        return { handled: true, notice: `renamed → ${args.slice(0, 60)}` }
      }
      case 'goal': {
        if (args === 'pause' || args === 'resume' || args === 'cancel') {
          await goalControl(id, args)
          return { handled: true, notice: `goal ${args}` }
        }
        if (!args || args === 'next' || args.startsWith('next ')) {
          return {
            handled: true,
            notice: 'usage: /goal <objective|pause|resume|cancel> (goal queueing unsupported)',
          }
        }
        await goalCreate(id, args)
        return { handled: true, notice: 'goal started' }
      }
      case 'fork':
        await forkSession(id)
        return { handled: true, notice: 'forked — child session is in the list' }
      case 'usage': {
        const u = await get<{
          kind: string
          summary?: { window: { duration: number; unit: string }; used: number; limit: number; reset_at?: string }
          limits?: { window: { duration: number; unit: string }; used: number; limit: number; reset_at?: string }[]
          extra_usage?: { monthly_used_cents: number; monthly_charge_limit_cents: number }
        }>('/oauth/usage').catch(() => null)
        if (u?.kind !== 'ok' || !u.summary) {
          return { handled: true, notice: 'usage unavailable (needs kimi 0.30+ with a managed account)' }
        }
        const parts = [`${u.summary.used}% of the ${u.summary.window.duration}-${u.summary.window.unit} window`]
        for (const l of u.limits ?? []) {
          parts.push(`${l.used}% of ${l.window.duration}${l.window.unit} rate limit`)
        }
        if (u.extra_usage && u.extra_usage.monthly_charge_limit_cents > 0) {
          parts.push(
            `extra usage $${(u.extra_usage.monthly_used_cents / 100).toFixed(2)} of $${(u.extra_usage.monthly_charge_limit_cents / 100).toFixed(2)}`,
          )
        }
        const reset = u.summary.reset_at
          ? ` · resets ${new Date(u.summary.reset_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
          : ''
        return { handled: true, notice: `usage: ${parts.join(' · ')}${reset}` }
      }
      case 'export': {
        const filename = await exportSession(id)
        return { handled: true, notice: `exported → ${filename} (downloaded)` }
      }
      case 'copy': {
        const text = lastAssistantText(id)
        if (!text) return { handled: true, notice: 'nothing to copy' }
        await navigator.clipboard.writeText(text)
        return { handled: true, notice: 'last assistant message copied' }
      }
      case 'new': {
        const cwd = useApp.getState().sessionState[id]?.summary?.metadata?.cwd
        if (!cwd) return { handled: true, notice: 'no folder known for this session' }
        await newSession(cwd)
        return { handled: true, notice: 'new session' }
      }
      default: {
        const skills = useApp.getState().sessionState[id]?.skills ?? []
        const sk = skills.find((s) => s.name.toLowerCase() === name)
        if (!sk) return { handled: false }
        await activateSkill(id, sk.name, args)
        return { handled: true, notice: `/${sk.name} activated` }
      }
    }
  } catch (e) {
    return { handled: true, notice: `/${name} failed: ${e instanceof Error ? e.message : e}` }
  }
}


/** Refetch the background task list for a session. */
export async function refreshTasks(id: string): Promise<void> {
  try {
    const res = await get<{ items: TaskItem[] }>(`/sessions/${id}/tasks`)
    useApp.getState().setTasks(id, res.items ?? [])
  } catch {
    // daemon hiccup
  }
}

/** Fetch one task's detail (carries `output_preview` for the log tail). */
export async function getTaskDetail(id: string, taskId: string): Promise<TaskItem | null> {
  try {
    return await get<TaskItem>(`/sessions/${id}/tasks/${taskId}`)
  } catch {
    return null
  }
}

/** Per-session task status from the last poll — detects completions for
 *  sessions we are NOT subscribed to (unwatched sessions get no frames). */
const prevTaskStatus = new Map<string, Map<string, string>>()

/** Poll /tasks across listed sessions; a running→terminal transition in an
 *  unwatched session raises the completion badge + a taskbar notification.
 *  (Watched sessions get instant frames via handleFrame instead.) */
async function pollTaskCompletions(): Promise<void> {
  const st = useApp.getState()
  const listed = st.sessions.filter((s) => !s.archived).slice(0, 30)
  for (const s of listed) {
    let items: TaskItem[]
    try {
      const res = await get<{ items: TaskItem[] }>(`/sessions/${s.id}/tasks`)
      items = res.items ?? []
    } catch {
      continue
    }
    const prev = prevTaskStatus.get(s.id) ?? new Map<string, string>()
    const cur = new Map<string, string>()
    for (const t of items) {
      cur.set(t.id, t.status)
      if (prev.get(t.id) === 'running' && t.status !== 'running' && !watching.has(s.id)) {
        useApp.getState().markTaskDone(s.id)
        if (st.activeSessionId !== s.id) {
          void notifyAttention(`background task ${t.status} — ${(s.title ?? 'another session').slice(0, 40)}`)
        }
      }
    }
    prevTaskStatus.set(s.id, cur)
  }
}

/** Refetch pending approvals + questions for a session. */
export async function refreshInteractions(id: string): Promise<void> {
  const [approvals, questions] = await Promise.all([
    get<{ items: ApprovalItem[] }>(`/sessions/${id}/approvals?status=pending`).catch(() => ({
      items: [] as ApprovalItem[],
    })),
    get<{ items: QuestionItem[] }>(`/sessions/${id}/questions?status=pending`).catch(() => ({
      items: [] as QuestionItem[],
    })),
  ])
  useApp.getState().setApprovals(id, approvals.items ?? [])
  useApp.getState().setQuestions(id, questions.items ?? [])
}

const historyPulls = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleHistoryPull(sessionId: string) {
  if (!sessionId) return
  const existing = historyPulls.get(sessionId)
  if (existing) clearTimeout(existing)
  historyPulls.set(
    sessionId,
    setTimeout(() => {
      historyPulls.delete(sessionId)
      void pullHistory(sessionId)
      void refreshStatus(sessionId)
    }, 350),
  )
}

async function pullHistory(sessionId: string): Promise<void> {
  const source = useApp.getState().sessionState[sessionId]?.historySource
  if (source === 'transcript') {
    // Same id space — a fresh transcript page cleanly replaces the old one.
    if (await pullTranscript(sessionId)) {
      void pullPlans(sessionId)
      return
    }
  }
  try {
    const res = await get<{ items: Snapshot['messages']['items']; has_more?: boolean }>(
      `/sessions/${sessionId}/messages?page_size=100`,
    )
    // API returns newest-first; store chronologically.
    if (res.items?.length) {
      useApp.getState().setMessages(sessionId, [...res.items].reverse(), Boolean(res.has_more))
    }
  } catch (e) {
    console.error('history pull failed', sessionId, e)
  }
}

/** Pull one transcript page (0.28+); false when the route doesn't exist (0.27)
 *  or the page is empty. `beforeTurn` pages backward by turn id. */
async function pullTranscript(sessionId: string, beforeTurn?: string): Promise<boolean> {
  try {
    const qs = beforeTurn ? `&before_turn=${encodeURIComponent(beforeTurn)}` : ''
    const res = await get<TranscriptPage>(
      `/sessions/${sessionId}/transcript?agent_id=main&page_size=100${qs}`,
    )
    if (!res.items?.length) return false
    const messages = transcriptToMessages(res.items)
    if (beforeTurn) {
      useApp.getState().prependMessages(sessionId, messages, Boolean(res.has_more))
    } else {
      useApp.getState().setMessages(sessionId, messages, Boolean(res.has_more))
      useApp.getState().setHistorySource(sessionId, 'transcript')
      void pullPlans(sessionId)
    }
    return true
  } catch (e) {
    console.warn('transcript pull failed (0.27 daemon?)', sessionId, e)
    return false
  }
}

/** Load the next older page of history for the "Load earlier" button. */
export async function loadOlder(sessionId: string): Promise<void> {
  const s = useApp.getState().sessionState[sessionId]
  const oldest = s?.messages[0]
  if (!s?.hasMore || !oldest) return
  if (s.historySource === 'transcript') {
    // Oldest message of a transcript-backed history is always a turn's user
    // message, so its id is the turn id the cursor wants.
    if (!(await pullTranscript(sessionId, oldest.id))) {
      useApp.getState().prependMessages(sessionId, [], false)
    }
    return
  }
  try {
    const res = await get<{ items: Snapshot['messages']['items']; has_more?: boolean }>(
      `/sessions/${sessionId}/messages?page_size=100&before_id=${encodeURIComponent(oldest.id)}`,
    )
    if (res.items?.length) {
      useApp.getState().prependMessages(sessionId, [...res.items].reverse(), Boolean(res.has_more))
    } else {
      useApp.getState().prependMessages(sessionId, [], false)
    }
  } catch (e) {
    console.error('load older failed', sessionId, e)
  }
}

/** Subscribe to a session's live stream, rebuilding from snapshot first. */
export async function watchSession(id: string): Promise<void> {
  const st = useApp.getState()
  if (watching.has(id) && st.sessionState[id]?.synced) return
  // Mark intent immediately so reconnect/open handlers retry failed watches.
  watching.add(id)

  let snap: Snapshot
  try {
    snap = await get<Snapshot>(`/sessions/${id}/snapshot`)
  } catch (e) {
    // Orphaned sessions (their workspace record is missing, e.g. headless
    // digest runs under an unregistered path spelling) 404 on /snapshot but
    // stay readable via /transcript and /messages — render history read-only
    // instead of surfacing an error.
    if (e instanceof ApiError && e.status === 40401) {
      console.warn('snapshot 404; falling back to transcript/messages', id)
      if (!(await pullTranscript(id))) {
        try {
          const res = await get<{ items: Snapshot['messages']['items']; has_more?: boolean }>(
            `/sessions/${id}/messages?page_size=100`,
          )
          if (res.items?.length) {
            useApp.getState().setMessages(id, [...res.items].reverse(), Boolean(res.has_more))
          }
        } catch (e2) {
          console.error('fallback history pull failed', id, e2)
        }
      }
      useApp.getState().markSynced(id)
      useApp.getState().setSyncIssue(null)
      return
    }
    console.error('snapshot failed', id, e)
    useApp.getState().markUnsynced(id)
    useApp.getState().setSyncIssue(`snapshot failed for ${id.slice(8, 16)}: ${e instanceof Error ? e.message : e}`)
    return
  }
  useApp.getState().applySnapshot(id, snap)
  // A session with on-disk history the daemon never ingested (TUI-era, daemon
  // restarts) snapshots empty — rebuild from the wire log when 0.28+ allows.
  if (snap.messages.items.length === 0) void pullTranscript(id)
  void refreshInteractions(id)
  void refreshTasks(id)
  void refreshGoal(id)
  void refreshStatus(id)
  void refreshSkills(id)

  if (!socket) return
  // The socket may still be connecting (app just launched, session restored
  // from localStorage). Wait for it — otherwise the session never streams.
  try {
    await socket.waitForOpen()
  } catch (e) {
    console.error('socket not open; will retry watch on reconnect', id, e)
    useApp.getState().markUnsynced(id)
    return
  }
  try {
    const ack = await socket.request('subscribe', {
      session_ids: [id],
      cursors: { [id]: { seq: snap.as_of_seq, epoch: snap.epoch } },
    })
    const p = ack.payload as {
      accepted?: string[]
      not_found?: string[]
      resync_required?: string[]
    }
    if (p.resync_required?.includes(id)) {
      // Cursor raced; loop once more.
      useApp.getState().markUnsynced(id)
      return watchSession(id)
    }
    if (p.not_found?.includes(id)) {
      // Session predates the daemon (created by TUI): stream unavailable and
      // the /messages projection is partial. 0.28+ rebuilds the full history
      // from the wire log via /transcript — use it when present.
      console.warn('session not streamable by daemon:', id)
      void pullTranscript(id)
    }
    useApp.getState().markSynced(id)
    useApp.getState().setSyncIssue(null)
  } catch (e) {
    console.error('subscribe failed', id, e)
    useApp.getState().markUnsynced(id)
    useApp.getState().setSyncIssue(`subscribe failed for ${id.slice(8, 16)}: ${e instanceof Error ? e.message : e}`)
  }
}

export function stopSync(): void {
  if (sessionPoll) clearInterval(sessionPoll)
  if (queuePoll) clearInterval(queuePoll)
  socket?.close()
}

/** Archive a session (soft-close; it disappears from the list). */
export async function archiveSession(id: string): Promise<void> {
  await post(`/sessions/${id}:archive`)
  watching.delete(id)
  const st = useApp.getState()
  if (st.activeSessionId === id) st.setActiveSession(null)
  await refreshSessions()
}

/** Archive many sessions at once (per-project cleanup) with one list refresh. */
export async function archiveSessions(ids: string[]): Promise<void> {
  for (const id of ids) {
    await post(`/sessions/${id}:archive`).catch(() => {})
    watching.delete(id)
    const st = useApp.getState()
    if (st.activeSessionId === id) st.setActiveSession(null)
  }
  await refreshSessions()
}

/** Last prompt id per session — needed to abort app-initiated turns. */
const lastPromptIds = new Map<string, string>()

let outboxCounter = 0

export type SendMode = 'queue' | 'steer' | 'interrupt'

/**
 * Send a prompt. Modes while a turn is active:
 * - queue: runs after the active turn
 * - steer: injected, model picks it up at the next step boundary
 * - interrupt: kills the active turn; this message takes over immediately
 * Records the message in the outbox so the user sees it pending.
 */
export async function sendPrompt(
  sessionId: string,
  text: string,
  mode: SendMode = 'queue',
  images: { mediaType: string; base64: string }[] = [],
): Promise<void> {
  const busy = useApp.getState().sessionState[sessionId]?.mainTurnActive ?? false
  const kind = busy ? mode : 'send'
  const localId = `ob_${Date.now()}_${++outboxCounter}`
  useApp.getState().addToOutbox(sessionId, {
    localId,
    text,
    kind,
    sentAt: Date.now(),
    ...(images.length ? { imageCount: images.length } : {}),
  })
  const content: unknown[] = [
    ...images.map((img) => ({
      type: 'image',
      source: { kind: 'base64', media_type: img.mediaType, data: img.base64 },
    })),
    ...(text ? [{ type: 'text', text }] : []),
  ]
  try {
    const res = await post<{ prompt_id: string }>(`/sessions/${sessionId}/prompts`, { content })
    if (res.prompt_id) {
      lastPromptIds.set(sessionId, res.prompt_id)
      // Keep the daemon id on the chip so Stop can cancel a pending steer
      // daemon-side instead of leaving it in the injection queue.
      useApp.getState().tagOutboxPromptId(sessionId, localId, res.prompt_id)
      if (busy && mode === 'steer') {
        await post(`/sessions/${sessionId}/prompts:steer`, { prompt_ids: [res.prompt_id] })
      }
      if (busy && mode === 'interrupt') {
        const q = await getPromptQueue(sessionId)
        if (q.active) await abortPrompt(sessionId, q.active.prompt_id)
      }
      // Refresh the queue right away so queued messages render immediately.
      void getPromptQueue(sessionId)
        .then((q) => useApp.getState().setQueue(sessionId, q))
        .catch(() => {})
      // Queue/send: the daemon queue row (or the incoming splice) now represents
      // the message truthfully — retire the chip. Steer/interrupt chips stay:
      // they cover the gap until the message materializes at a step boundary
      // (cleared by the splice match or at turn end).
      if (kind !== 'steer' && kind !== 'interrupt') {
        useApp.getState().clearOutbox(sessionId, localId)
      }
    }
  } catch (e) {
    useApp.getState().clearOutbox(sessionId, localId)
    throw e
  }
}

export async function getPromptQueue(sessionId: string): Promise<PromptQueue> {
  return get<PromptQueue>(`/sessions/${sessionId}/prompts`)
}

export async function abortPrompt(sessionId: string, promptId: string): Promise<void> {
  await post(`/sessions/${sessionId}/prompts/${promptId}:abort`, {})
}

/** Abort a queued prompt and refresh the queue so the row disappears at once. */
export async function abortQueuedAndRefresh(sessionId: string, promptId: string): Promise<void> {
  await abortPrompt(sessionId, promptId)
  const q = await getPromptQueue(sessionId)
  useApp.getState().setQueue(sessionId, q)
}

/** Steer a queued prompt from the strip: mark it for injection daemon-side and
 *  give it a steering chip so it stays visible until it lands at a step
 *  boundary (without one the prompt vanishes from the UI while it waits).
 *  text/imageCount must be the CLEAN content (promptContentText) — the chip's
 *  text is the splice match key, so a `[image]` display prefix would stick. */
export async function steerQueued(sessionId: string, promptId: string, text: string, imageCount = 0): Promise<void> {
  const localId = `ob_${Date.now()}_${++outboxCounter}`
  useApp.getState().addToOutbox(sessionId, {
    localId,
    text,
    kind: 'steer',
    sentAt: Date.now(),
    promptId,
    ...(imageCount ? { imageCount } : {}),
  })
  try {
    await post(`/sessions/${sessionId}/prompts:steer`, { prompt_ids: [promptId] })
  } catch (e) {
    useApp.getState().clearOutbox(sessionId, localId)
    throw e
  }
  const q = await getPromptQueue(sessionId).catch(() => null)
  if (q) useApp.getState().setQueue(sessionId, q)
}

/** Abort the active turn AND drain the queue behind it. Stop means stop — if a
 *  queued prompt auto-started after every Stop, the button would look broken
 *  (exactly the report that prompted this). Cleared queue rows get a notice so
 *  the drain is discoverable, not silent. Pending steers are swept too: the
 *  turn they were waiting for is dead, so they would sit in the injection
 *  queue (daemon-side) and as chips (app-side) forever. */
export async function abortActive(sessionId: string): Promise<boolean> {
  // Best-effort cancel every pending steer/interrupt chip, daemon-side where we
  // know the prompt id, then drop the chips. Returns the count for the notice.
  const sweepSteers = async (): Promise<number> => {
    const st = useApp.getState()
    const pending = (st.sessionState[sessionId]?.outbox ?? []).filter(
      (o) => o.kind === 'steer' || o.kind === 'interrupt' || o.steerFallback,
    )
    for (const o of pending) {
      if (o.promptId) await abortPrompt(sessionId, o.promptId).catch(() => {})
      st.clearOutbox(sessionId, o.localId)
    }
    return pending.length
  }
  try {
    const q = await getPromptQueue(sessionId)
    const queued = q.queued ?? []
    const drainQueue = async () => {
      for (const p of queued) await abortPrompt(sessionId, p.prompt_id).catch(() => {})
      const fresh = await getPromptQueue(sessionId).catch(() => null)
      if (fresh) useApp.getState().setQueue(sessionId, fresh)
    }
    if (q.active) {
      await abortPrompt(sessionId, q.active.prompt_id)
      await drainQueue()
      const swept = await sweepSteers()
      const parts = [`stopped`]
      if (queued.length) parts.push(`cleared ${queued.length} queued`)
      if (swept) parts.push(`cancelled ${swept} steering`)
      if (parts.length > 1) useApp.getState().setNotice(parts.join(' — '))
      return true
    }
    if (queued.length) {
      await drainQueue()
      const swept = await sweepSteers()
      useApp
        .getState()
        .setNotice(
          `cleared ${queued.length} queued prompt${queued.length > 1 ? 's' : ''}${swept ? ` — cancelled ${swept} steering` : ''}`,
        )
      return true
    }
    // Nothing active and nothing queued — there may still be steer chips.
    const swept = await sweepSteers()
    if (swept) {
      useApp.getState().setNotice(`cancelled ${swept} steering prompt${swept > 1 ? 's' : ''}`)
      return true
    }
  } catch {
    // fall through to WS
  }
  const promptId = lastPromptIds.get(sessionId)
  if (promptId && socket) {
    socket.send('abort', { session_id: sessionId, prompt_id: promptId })
    await sweepSteers()
    return true
  }
  // Last handle: the newest user message carrying a daemon id IS the active
  // prompt's id — present in history/splices even when the queue record was
  // lost (daemon restart) or the prompt came from another client.
  const msgs = useApp.getState().sessionState[sessionId]?.messages ?? []
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && m.id.startsWith('msg_'))
  if (lastUser) {
    try {
      await abortPrompt(sessionId, lastUser.id)
      return true
    } catch {
      // already finished — nothing left to stop
    }
  }
  // No handle anywhere — say so, with the escape hatch one click away.
  useApp.getState().setNotice('could not stop the turn — restart the daemon from Settings ⚙')
  return false
}

/** Create a daemon-owned session (streamable), set its profile, and open it. */
export async function newSession(cwd: string): Promise<string | null> {
  const st = useApp.getState()
  try {
    // Resolve a model: store first, then a fresh config fetch — never send ''.
    let model = st.defaultModel ?? st.models[0]?.model ?? ''
    if (!model) {
      const cfg = await get<{ default_model?: string }>('/config').catch(() => null)
      model = cfg?.default_model ?? ''
    }
    if (!model) {
      throw new Error('no model configured — set default_model in kimi config first')
    }
    const created = await post<{ id: string; workspace_id?: string }>('/sessions', {
      title: 'New session',
      metadata: { cwd },
    })
    const id = created.id
    // The user explicitly chose this folder — grant trust up front (0.31+;
    // no-op on older daemons) so project-level mcp.json loads from the start.
    if (created.workspace_id) void trustWorkspace(created.workspace_id)
    const profile = () =>
      post(`/sessions/${id}/profile`, {
        agent_config: {
          model,
          permission_mode: localStorage.getItem('kimiscope.permissionMode') ?? 'yolo',
        },
      })
    await profile().catch((e) => console.error('profile failed', e))
    // The profile write can silently not stick (seen on daemon warm-up edges):
    // verify via /status (the only reliable read-back) and retry once before
    // letting the user hit `model.not_configured` on their first prompt.
    let status = await get<{ model?: string }>(`/sessions/${id}/status`).catch(() => null)
    if (!status?.model) {
      console.warn('profile did not stick; retrying', id)
      await profile().catch(() => {})
      status = await get<{ model?: string }>(`/sessions/${id}/status`).catch(() => null)
      if (!status?.model) {
        useApp.getState().setNotice('new session has no model — pick one in the rail Session section')
      }
    }
    await Promise.all([refreshSessions(), refreshWorkspaces()])
    st.setActiveSession(id)
    void watchSession(id)
    return id
  } catch (e) {
    console.error('create session failed', e)
    return null
  }
}
