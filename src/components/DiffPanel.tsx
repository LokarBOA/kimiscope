import { useCallback, useEffect, useState } from 'react'
import { post } from '../api/client'

interface GitStatus {
  branch: string
  ahead: number
  behind: number
  entries: Record<string, string>
}

function UnifiedDiff({ diff }: { diff: string }) {
  return (
    <pre className="p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
      {diff.split('\n').map((line, i) => {
        let cls = 'text-zinc-500'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-950/30'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-950/30'
        else if (line.startsWith('@@')) cls = 'text-sky-400'
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-zinc-600'
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

const STATUS_STYLE: Record<string, string> = {
  modified: 'text-amber-400',
  untracked: 'text-emerald-400',
  deleted: 'text-red-400',
  added: 'text-emerald-400',
  renamed: 'text-sky-400',
}

export function DiffPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await post<GitStatus>(`/sessions/${sessionId}/fs:git_status`, {})
      setStatus(res)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!selected) return
    setLoadingDiff(true)
    setDiff(null)
    post<{ diff: string }>(`/sessions/${sessionId}/fs:diff`, { path: selected })
      .then((res) => setDiff(res.diff))
      .catch((e) => setDiff(`# failed to load diff: ${e}`))
      .finally(() => setLoadingDiff(false))
  }, [selected, sessionId])

  const entries = Object.entries(status?.entries ?? {})

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex h-[80vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
          <span className="text-sm font-semibold text-zinc-100">Session changes</span>
          {status && (
            <span className="text-xs text-zinc-500">
              {status.branch}
              {status.ahead > 0 && ` ↑${status.ahead}`}
              {status.behind > 0 && ` ↓${status.behind}`} · {entries.length} files
            </span>
          )}
          <button
            onClick={() => void refresh()}
            className="ml-auto rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            Refresh
          </button>
          <button onClick={onClose} className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800">
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 overflow-y-auto border-r border-zinc-800 p-2">
            {error && <div className="p-2 text-xs text-red-400">{error}</div>}
            {!error && entries.length === 0 && status && (
              <div className="p-2 text-xs text-zinc-500">Working tree clean.</div>
            )}
            {entries.map(([path, st]) => (
              <button
                key={path}
                onClick={() => setSelected(path)}
                className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] ${
                  selected === path ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
                }`}
              >
                <span className={`shrink-0 ${STATUS_STYLE[st] ?? 'text-zinc-500'}`}>
                  {st === 'modified' ? 'M' : st === 'untracked' ? '?' : st === 'deleted' ? 'D' : st[0]?.toUpperCase()}
                </span>
                <span className="min-w-0 truncate text-zinc-300">{path}</span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto bg-black/30">
            {loadingDiff && <div className="p-4 text-sm text-zinc-500">Loading diff…</div>}
            {!loadingDiff && diff && <UnifiedDiff diff={diff} />}
            {!loadingDiff && !diff && (
              <div className="p-4 text-sm text-zinc-600">
                {selected ? 'No diff available.' : 'Select a file to view its diff.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
