import { useEffect, useState } from 'react'
import { useApp } from './state/store'
import { initApp, watchSession } from './state/sync'
import { SessionList } from './components/SessionList'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { DiffPanel } from './components/DiffPanel'
import { TerminalPane } from './components/TerminalPane'
import { SettingsModal } from './components/SettingsModal'
import { PendingStrip } from './components/PendingStrip'
import { ApprovalBar } from './components/ApprovalBar'
import { QuestionDialog } from './components/QuestionDialog'
import { InsightRail } from './components/InsightRail'

function TopBar({
  onShowDiff,
  onToggleTerminal,
  onShowSettings,
}: {
  onShowDiff: () => void
  onToggleTerminal: () => void
  onShowSettings: () => void
}) {
  const socketState = useApp((st) => st.socketState)
  const serverVersion = useApp((st) => st.serverVersion)
  const activeId = useApp((st) => st.activeSessionId)
  const summary = useApp((st) => (activeId ? st.sessionState[activeId]?.summary : null))
  const usage = useApp((st) => (activeId ? st.sessionState[activeId]?.usage : null))

  const syncIssue = useApp((st) => st.syncIssue)
  const dot =
    socketState === 'open' ? 'bg-emerald-500' : socketState === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-red-500'

  return (
    <div className="flex h-11 items-center gap-3 border-b border-zinc-800 px-4">
      <span className="text-sm font-semibold text-zinc-100">KimiScope</span>
      <span className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        {socketState}
        {serverVersion && <span className="text-zinc-600">· kimi {serverVersion}</span>}
      </span>
      {syncIssue && (
        <span
          className="rounded bg-amber-900/40 px-2 py-0.5 text-[11px] text-amber-300"
          title={syncIssue}
        >
          ⚠ {syncIssue.slice(0, 60)}
        </span>
      )}
      <div className="min-w-0 flex-1 truncate text-center text-sm text-zinc-400">
        {summary?.title ?? ''}
      </div>
      {activeId && (
        <button
          onClick={onShowDiff}
          title="Files changed in this session's repo"
          className="shrink-0 rounded-md bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          Changes
        </button>
      )}
      {activeId && (
        <button
          onClick={onToggleTerminal}
          title="Toggle local terminal"
          className="shrink-0 rounded-md bg-zinc-800 px-2.5 py-1 font-mono text-xs text-zinc-300 hover:bg-zinc-700"
        >
          ›_
        </button>
      )}
      <button
        onClick={onShowSettings}
        title="Settings"
        className="shrink-0 rounded-md bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
      >
        ⚙
      </button>
      {usage && usage.context_limit > 0 && (
        <span className="shrink-0 text-xs text-zinc-500" title="context tokens / limit · cost">
          {(usage.context_tokens / 1000).toFixed(0)}k/{(usage.context_limit / 1000).toFixed(0)}k · $
          {usage.total_cost_usd.toFixed(3)}
        </span>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center text-zinc-600">
      <div className="text-center">
        <div className="mb-2 text-4xl">⬡</div>
        <div className="text-sm">Pick a session on the left, or start a new one.</div>
      </div>
    </div>
  )
}

export default function App() {
  const activeId = useApp((st) => st.activeSessionId)
  const initError = useApp((st) => st.initError)
  const [showDiff, setShowDiff] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const activeCwd = useApp((st) =>
    activeId ? st.sessionState[activeId]?.summary?.metadata?.cwd : undefined,
  )

  useEffect(() => {
    void initApp()
  }, [])

  useEffect(() => {
    if (activeId) void watchSession(activeId)
  }, [activeId])

  // Restore last open session, and allow #<session-id> deep links (debug/repro).
  useEffect(() => {
    const fromHash = window.location.hash.replace(/^#/, '')
    const fromStore = localStorage.getItem('kimiharness.activeSession')
    const id = fromHash || fromStore
    if (id) useApp.getState().setActiveSession(id)
    const onHash = () => {
      const h = window.location.hash.replace(/^#/, '')
      if (h) useApp.getState().setActiveSession(h)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (activeId) localStorage.setItem('kimiharness.activeSession', activeId)
  }, [activeId])

  if (initError) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 p-8">
        <div className="max-w-md rounded-lg border border-red-900/50 bg-red-950/20 p-5">
          <div className="mb-2 text-sm font-semibold text-red-300">
            Could not reach the kimi server
          </div>
          <div className="text-[13px] whitespace-pre-wrap text-zinc-400">{initError}</div>
          <div className="mt-3 text-xs text-zinc-600">
            Make sure `kimi` is on PATH and try again.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-200">
      <TopBar
        onShowDiff={() => setShowDiff(true)}
        onToggleTerminal={() => setShowTerminal((v) => !v)}
        onShowSettings={() => setShowSettings(true)}
      />
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 border-r border-zinc-800">
          <SessionList />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          {activeId ? (
            <>
              <ChatView sessionId={activeId} />
              <ApprovalBar sessionId={activeId} />
              <QuestionDialog sessionId={activeId} />
              <PendingStrip sessionId={activeId} />
              <Composer sessionId={activeId} />
            </>
          ) : (
            <EmptyState />
          )}
          {showTerminal && (
            <TerminalPane cwd={activeCwd} onClose={() => setShowTerminal(false)} />
          )}
        </main>
        {activeId && (
          <aside className="w-80 shrink-0 border-l border-zinc-800">
            <InsightRail sessionId={activeId} />
          </aside>
        )}
      </div>
      {showDiff && activeId && (
        <DiffPanel sessionId={activeId} onClose={() => setShowDiff(false)} />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}

