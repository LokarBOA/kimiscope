import { useMemo, useState } from 'react'
import { useApp } from '../state/store'
import { archiveSession, newSession, refreshSessions, watchSession } from '../state/sync'
import type { SessionSummary } from '../api/events'

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function SessionRow({ s }: { s: SessionSummary }) {
  const activeId = useApp((st) => st.activeSessionId)
  const setActive = useApp((st) => st.setActiveSession)
  const live = useApp((st) => st.sessionState[s.id])
  const busy = live?.busy ?? s.busy
  const pending = (live?.pendingInteraction ?? s.pending_interaction) !== 'none'
  const archived = s.archived === true
  // Completion badge: a background task finished recently in a session you're not viewing.
  const showDoneBadge =
    !archived && live?.recentTaskDone != null && Date.now() - live.recentTaskDone < 15 * 60_000 && s.id !== activeId

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        setActive(s.id)
        void watchSession(s.id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          setActive(s.id)
          void watchSession(s.id)
        }
      }}
      className={`group mb-0.5 w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left transition-colors ${
        s.id === activeId ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
      } ${archived ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            busy ? 'animate-pulse bg-sky-400' : pending ? 'bg-amber-400' : 'bg-zinc-700'
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-200">
          {s.title || 'Untitled'}
        </span>
        {showDoneBadge && (
          <span title="Background task finished" className="shrink-0 text-[11px] text-emerald-400">
            ✓
          </span>
        )}
        {archived ? (
          <span className="shrink-0 text-[10px] text-zinc-600 uppercase">archived</span>
        ) : (
          <button
            title="Archive session"
            onClick={(e) => {
              e.stopPropagation()
              if (busy && !window.confirm(`"${s.title || 'Untitled'}" is mid-turn — archive anyway?`))
                return
              void archiveSession(s.id)
            }}
            className="shrink-0 rounded px-1 text-[11px] text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-700 hover:text-zinc-300"
          >
            ✕
          </button>
        )}
        <span className="shrink-0 text-[11px] text-zinc-600 group-hover:hidden">
          {timeAgo(s.updated_at)}
        </span>
      </div>
    </div>
  )
}

function OpenFolder() {
  const [path, setPath] = useState('')
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full px-3 py-2 text-left text-[12px] text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300"
      >
        + Open folder as project…
      </button>
    )
  }
  return (
    <form
      className="flex gap-1 p-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        const p = path.trim()
        if (p) void newSession(p)
        setPath('')
        setOpen(false)
      }}
    >
      <input
        autoFocus
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="C:\\path\\to\\project"
        className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
      />
      <button
        type="submit"
        className="rounded-md bg-zinc-700 px-2 py-1 text-[12px] text-zinc-200 hover:bg-zinc-600"
      >
        Open
      </button>
    </form>
  )
}

export function SessionList() {
  const sessions = useApp((st) => st.sessions)
  const workspaces = useApp((st) => st.workspaces)
  const sessionStates = useApp((st) => st.sessionState)
  const showArchived = useApp((st) => st.showArchived)
  const setShowArchived = useApp((st) => st.setShowArchived)

  const groups = useMemo(() => {
    const byWs = new Map<string, SessionSummary[]>()
    for (const s of sessions) {
      const list = byWs.get(s.workspace_id) ?? []
      list.push(s)
      byWs.set(s.workspace_id, list)
    }
    const wsOrder = [...byWs.keys()].sort((a, b) => {
      const wa = workspaces.find((w) => w.id === a)
      const wb = workspaces.find((w) => w.id === b)
      return (wb?.last_opened_at ?? '').localeCompare(wa?.last_opened_at ?? '')
    })
    for (const list of byWs.values()) {
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    }
    return wsOrder.map((id) => ({
      workspace: workspaces.find((w) => w.id === id),
      id,
      sessions: byWs.get(id)!,
    }))
  }, [sessions, workspaces])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2.5">
        <span className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">
          Projects
        </span>
        <button
          onClick={() => {
            setShowArchived(!showArchived)
            void refreshSessions()
          }}
          title={showArchived ? 'Hide archived sessions' : 'Show archived sessions'}
          className={`text-[13px] ${showArchived ? 'text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'}`}
        >
          🗄
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {groups.map(({ workspace, id, sessions: list }) => {
          // Presence: other sessions mid-turn on this working tree (clobber warning).
          const busyTitles = list
            .filter((s) => !s.archived && (sessionStates[s.id]?.busy ?? s.busy))
            .map((s) => s.title || 'Untitled')
          return (
            <div key={id} className="mb-2">
              <div className="group flex items-center gap-1.5 px-1.5 pt-1.5 pb-1">
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
                  {workspace?.name ?? id}
                </span>
                {busyTitles.length > 0 && (
                  <span
                    title={`Active in this project: ${busyTitles.join(', ')}`}
                    className="shrink-0 text-[10px] text-sky-400/90"
                  >
                    ⚡{busyTitles.length}
                  </span>
                )}
                <button
                  onClick={() => workspace && void newSession(workspace.root)}
                  title={`New session in ${workspace?.name ?? id}`}
                  className="rounded px-1 text-sm text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  +
                </button>
              </div>
              {list.map((s) => (
                <SessionRow key={s.id} s={s} />
              ))}
            </div>
          )
        })}
        {groups.length === 0 && (
          <div className="p-4 text-center text-sm text-zinc-600">No sessions yet</div>
        )}
      </div>
      <div className="border-t border-zinc-800">
        <OpenFolder />
      </div>
    </div>
  )
}
