import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useApp } from '../state/store'
import { goalControl, goalCreate } from '../state/sync'
import type { GoalState, TodoItem, ToolCallRecord } from '../api/events'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-zinc-800/70 px-3 py-2.5">
      <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
        {title}
      </div>
      {children}
    </div>
  )
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const icon =
    todo.status === 'done' ? '✓' : todo.status === 'in_progress' ? '▶' : '○'
  const cls =
    todo.status === 'done'
      ? 'text-emerald-500'
      : todo.status === 'in_progress'
        ? 'text-sky-400'
        : 'text-zinc-600'
  return (
    <div className="flex items-start gap-2 py-0.5 text-[13px]">
      <span className={`${cls} w-4 shrink-0 text-center`}>{icon}</span>
      <span className={todo.status === 'done' ? 'text-zinc-500 line-through' : 'text-zinc-300'}>
        {todo.title}
      </span>
    </div>
  )
}

/** Files written/edited this session, latest first, derived from tool calls. */
function useTouchedFiles(toolCalls: Record<string, ToolCallRecord>) {
  return useMemo(() => {
    const seen = new Map<string, { path: string; ops: Set<string> }>()
    for (const c of Object.values(toolCalls)) {
      if (c.name !== 'Edit' && c.name !== 'Write') continue
      const p = (c.args as { path?: string })?.path
      if (!p) continue
      const e = seen.get(p) ?? { path: p, ops: new Set<string>() }
      e.ops.add(c.name)
      seen.set(p, e)
    }
    return [...seen.values()].reverse()
  }, [toolCalls])
}

function GoalSection({ sessionId, goal }: { sessionId: string; goal: GoalState | null }) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)

  if (!goal) {
    return open ? (
      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          const o = draft.trim()
          if (o) void goalCreate(sessionId, o)
          setDraft('')
          setOpen(false)
        }}
      >
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Goal objective…"
          rows={2}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
        />
        <div className="flex gap-1.5">
          <button type="submit" className="rounded bg-sky-700 px-2 py-0.5 text-[11px] text-white hover:bg-sky-600">
            Start goal
          </button>
          <button type="button" onClick={() => setOpen(false)} className="rounded px-2 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-300">
            Cancel
          </button>
        </div>
      </form>
    ) : (
      <button onClick={() => setOpen(true)} className="text-[12px] text-zinc-500 hover:text-zinc-300">
        + New goal…
      </button>
    )
  }

  const statusColor =
    goal.status === 'active'
      ? 'text-sky-400'
      : goal.status === 'completed'
        ? 'text-emerald-400'
        : goal.status === 'blocked'
          ? 'text-red-400'
          : 'text-zinc-400'

  return (
    <div className="space-y-1 text-[12px]">
      <div className="text-zinc-300">{goal.objective}</div>
      <div className="flex gap-2 text-[11px] text-zinc-500">
        <span className={statusColor}>{goal.status}</span>
        <span>{goal.turnsUsed} turns</span>
        <span>{(goal.tokensUsed / 1000).toFixed(1)}k tokens</span>
        <span>{Math.round(goal.wallClockMs / 60000)}m</span>
      </div>
      {goal.status === 'active' && (
        <div className="flex gap-1.5 pt-0.5">
          <button onClick={() => void goalControl(sessionId, 'pause')} className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-700">
            Pause
          </button>
          <button onClick={() => void goalControl(sessionId, 'cancel')} className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-red-400 hover:bg-zinc-700">
            Cancel
          </button>
        </div>
      )}
      {goal.status === 'paused' && (
        <div className="flex gap-1.5 pt-0.5">
          <button onClick={() => void goalControl(sessionId, 'resume')} className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-emerald-400 hover:bg-zinc-700">
            Resume
          </button>
          <button onClick={() => void goalControl(sessionId, 'cancel')} className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-red-400 hover:bg-zinc-700">
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

interface McpEntry {
  command?: string
  args?: string[]
  url?: string
  enabled?: boolean
}

/** MCP servers from the user-level mcp.json (read via the Rust side). */
function McpSection() {
  const [servers, setServers] = useState<Record<string, McpEntry> | null>(null)
  useEffect(() => {
    invoke<{ mcpServers?: Record<string, McpEntry> }>('get_mcp_servers')
      .then((j) => setServers(j.mcpServers ?? {}))
      .catch(() => setServers(null))
  }, [])
  if (!servers) return <div className="text-xs text-zinc-600">mcp.json unavailable.</div>
  const entries = Object.entries(servers)
  if (entries.length === 0) return <div className="text-xs text-zinc-600">No MCP servers.</div>
  return (
    <div className="space-y-1">
      {entries.map(([name, cfg]) => (
        <div key={name} className="flex items-center gap-2 text-[12px]" title={(cfg.args ?? []).join(' ') || cfg.url}>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cfg.enabled === false ? 'bg-zinc-600' : 'bg-emerald-500'}`} />
          <span className="min-w-0 truncate text-zinc-300">{name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-zinc-600">{cfg.url ? 'http' : 'stdio'}</span>
        </div>
      ))}
    </div>
  )
}

export function InsightRail({ sessionId }: { sessionId: string }) {
  const s = useApp((st) => st.sessionState[sessionId])
  const touched = useTouchedFiles(s?.toolCalls ?? {})
  if (!s) return null
  const usage = s.usage
  const ctxPct =
    usage && usage.context_limit > 0
      ? Math.min(100, (usage.context_tokens / usage.context_limit) * 100)
      : 0

  return (
    <div className="h-full overflow-y-auto">
      <Section title="Todos">
        {s.todos.length === 0 ? (
          <div className="text-xs text-zinc-600">No todo list in this session.</div>
        ) : (
          s.todos.map((t, i) => <TodoRow key={i} todo={t} />)
        )}
      </Section>

      <Section title="Goal">
        <GoalSection sessionId={sessionId} goal={s.goal} />
      </Section>

      <Section title={`Tasks (${s.tasks.filter((t) => t.status === 'running').length} running)`}>
        {s.tasks.length === 0 ? (
          <div className="text-xs text-zinc-600">No background tasks.</div>
        ) : (
          s.tasks.slice(0, 8).map((t) => (
            <div key={t.id} className="flex items-center gap-2 py-0.5 text-[12px]" title={t.command ?? t.id}>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  t.status === 'running'
                    ? 'animate-pulse bg-sky-400'
                    : t.status === 'completed'
                      ? 'bg-emerald-500'
                      : t.status === 'failed'
                        ? 'bg-red-500'
                        : 'bg-zinc-600'
                }`}
              />
              <span className="min-w-0 truncate text-zinc-400">{t.description ?? t.id}</span>
            </div>
          ))
        )}
      </Section>

      <Section title={`Files touched (${touched.length})`}>
        {touched.length === 0 ? (
          <div className="text-xs text-zinc-600">No edits yet.</div>
        ) : (
          touched.slice(0, 30).map((f) => (
            <div key={f.path} className="flex items-center gap-1.5 py-0.5 text-[12px]" title={f.path}>
              <span className={f.ops.has('Write') ? 'text-amber-400' : 'text-emerald-400'}>
                {f.ops.has('Write') ? '✎+' : '✎'}
              </span>
              <span className="min-w-0 truncate font-mono text-zinc-400">
                {f.path.split(/[\\/]/).slice(-2).join('/')}
              </span>
            </div>
          ))
        )}
      </Section>

      <Section title="Context">
        {usage ? (
          <div>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full rounded-full transition-all ${
                  ctxPct > 90 ? 'bg-red-500' : ctxPct > 70 ? 'bg-amber-500' : 'bg-sky-500'
                }`}
                style={{ width: `${ctxPct}%` }}
              />
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
              <span>
                {usage.context_tokens.toLocaleString()} / {usage.context_limit.toLocaleString()}
              </span>
              <span>{ctxPct.toFixed(0)}%</span>
            </div>
          </div>
        ) : (
          <div className="text-xs text-zinc-600">No usage data yet.</div>
        )}
      </Section>

      <Section title="Usage">
        {usage ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-zinc-400">
            <span>Input</span>
            <span className="text-right text-zinc-300">
              {(usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens).toLocaleString()}
            </span>
            <span>Output</span>
            <span className="text-right text-zinc-300">{usage.output_tokens.toLocaleString()}</span>
            <span>Cache read</span>
            <span className="text-right text-zinc-300">{usage.cache_read_tokens.toLocaleString()}</span>
            <span>Cache write</span>
            <span className="text-right text-zinc-300">
              {usage.cache_creation_tokens.toLocaleString()}
            </span>
            <span>Turns</span>
            <span className="text-right text-zinc-300">{usage.turn_count}</span>
            {usage.total_cost_usd > 0 && (
              <>
                <span>Cost</span>
                <span className="text-right text-zinc-300">
                  ${usage.total_cost_usd.toFixed(4)}
                </span>
              </>
            )}
          </div>
        ) : (
          <div className="text-xs text-zinc-600">—</div>
        )}
      </Section>

      <Section title="MCP servers">
        <McpSection />
      </Section>

      <Section title="Session">
        <div className="space-y-1 text-[12px] text-zinc-400">
          <div className="flex justify-between gap-2">
            <span>Model</span>
            <span className="truncate text-zinc-300">
              {s.summary?.agent_config?.model || '—'}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>Mode</span>
            <span className="text-zinc-300">
              {s.summary?.agent_config?.permission_mode || '—'}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>Folder</span>
            <span className="truncate text-zinc-300" title={s.summary?.metadata?.cwd}>
              {s.summary?.metadata?.cwd?.split(/[\\/]/).pop() || '—'}
            </span>
          </div>
        </div>
      </Section>
    </div>
  )
}
