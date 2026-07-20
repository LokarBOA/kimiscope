import { get, post } from '../api/client'
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
import { useApp, type ModelInfo, type PromptQueue, type Workspace } from './store'

let socket: KimiSocket | null = null
const watching = new Set<string>()
let sessionPoll: ReturnType<typeof setInterval> | null = null
let queuePoll: ReturnType<typeof setInterval> | null = null

interface Meta {
  server_version: string
}

let booted = false

/** Boot: connection info, server meta, workspace/session lists, shared socket. */
export async function initApp(): Promise<void> {
  if (booted) return // StrictMode double-invokes effects in dev
  booted = true
  const conn = await getConnectionInfo().catch((e: unknown) => {
    useApp.getState().setInitError(String(e instanceof Error ? e.message : e))
    return null
  })
  if (!conn) return
  useApp.getState().setConnection(conn)

  get<Meta>('/meta')
    .then((m) => useApp.getState().setServerVersion(m.server_version))
    .catch(() => {})

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
  } catch {
    // daemon hiccup; next poll recovers
  }
}

export async function refreshWorkspaces(): Promise<void> {
  try {
    const res = await get<{ items: import('./store').Workspace[] }>('/workspaces')
    useApp.getState().setWorkspaces(res.items ?? [])
  } catch {
    // daemon hiccup
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

/** Fork into a child session (preserving full history) and open it. */
export async function forkSession(id: string): Promise<void> {
  const child = await post<{ id: string }>(`/sessions/${id}/children`, {})
  await refreshSessions()
  useApp.getState().setActiveSession(child.id)
  void watchSession(child.id)
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
        return { handled: true, notice: 'forked — opened child session' }
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

/** Load the next older page of history for the "Load earlier" button. */
export async function loadOlder(sessionId: string): Promise<void> {
  const s = useApp.getState().sessionState[sessionId]
  const oldest = s?.messages[0]
  if (!s?.hasMore || !oldest) return
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
    console.error('snapshot failed', id, e)
    useApp.getState().markUnsynced(id)
    useApp.getState().setSyncIssue(`snapshot failed for ${id.slice(8, 16)}: ${e instanceof Error ? e.message : e}`)
    return
  }
  useApp.getState().applySnapshot(id, snap)
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
      // Session predates the daemon (created by TUI): stream unavailable,
      // snapshot data is still shown. It becomes streamable once prompted via API.
      console.warn('session not streamable by daemon:', id)
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
  const busy = useApp.getState().sessionState[sessionId]?.busy ?? false
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

/** Abort the active turn (REST works for any active prompt; WS is the fallback). */
export async function abortActive(sessionId: string): Promise<boolean> {
  try {
    const q = await getPromptQueue(sessionId)
    if (q.active) {
      await abortPrompt(sessionId, q.active.prompt_id)
      return true
    }
  } catch {
    // fall through to WS
  }
  const promptId = lastPromptIds.get(sessionId)
  if (!promptId || !socket) return false
  socket.send('abort', { session_id: sessionId, prompt_id: promptId })
  return true
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
    const created = await post<{ id: string }>('/sessions', {
      title: 'New session',
      metadata: { cwd },
    })
    const id = created.id
    await post(`/sessions/${id}/profile`, {
      agent_config: {
        model,
        permission_mode: localStorage.getItem('kimiharness.permissionMode') ?? 'yolo',
      },
    }).catch((e) => console.error('profile failed', e))
    await refreshSessions()
    st.setActiveSession(id)
    void watchSession(id)
    return id
  } catch (e) {
    console.error('create session failed', e)
    return null
  }
}
