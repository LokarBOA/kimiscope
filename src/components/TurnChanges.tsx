import { useState } from 'react'
import DiffViewer from 'react-diff-viewer-continued'
import type { FileChange } from '../state/store'
import { getTurnFileContent } from '../state/sync'

const STATUS_STYLE: Record<FileChange['status'], { glyph: string; cls: string }> = {
  added: { glyph: '+', cls: 'text-emerald-400/90' },
  modified: { glyph: '~', cls: 'text-amber-400/90' },
  deleted: { glyph: '−', cls: 'text-red-400/90' },
}

interface FileDiffState {
  loading: boolean
  error?: string
  /** Full file text at the checkpoint; null = no checkpoint recorded. */
  start?: string | null
  end?: string | null
}

/** Per-turn file-changes chip (kimi 0.40+ `file_history` experiment): a
 *  collapsed "N files changed · +a −d" row under the turn's last message,
 *  expanding to a per-file list with lazy before/after inline diffs. */
export function TurnChanges({
  sessionId,
  turnId,
  changes,
}: {
  sessionId: string
  turnId: number
  changes: FileChange[]
}) {
  const [open, setOpen] = useState(false)
  const [openFile, setOpenFile] = useState<string | null>(null)
  // Fetched start/end snapshots per path, so re-expanding never refetches.
  const [diffs, setDiffs] = useState<Record<string, FileDiffState>>({})

  let adds = 0
  let dels = 0
  for (const c of changes) {
    if (c.binary) continue // binary files carry no line counts
    adds += c.additions
    dels += c.deletions
  }

  const toggleFile = (c: FileChange) => {
    const next = openFile === c.path ? null : c.path
    setOpenFile(next)
    if (!next || c.binary || diffs[c.path]) return
    setDiffs((d) => ({ ...d, [c.path]: { loading: true } }))
    void Promise.all([
      getTurnFileContent(sessionId, turnId, c.path, 'start'),
      getTurnFileContent(sessionId, turnId, c.path, 'end'),
    ])
      .then(([start, end]) =>
        setDiffs((d) => ({
          ...d,
          [c.path]: { loading: false, start: start?.content ?? null, end: end?.content ?? null },
        })),
      )
      .catch((e: unknown) =>
        setDiffs((d) => ({
          ...d,
          [c.path]: { loading: false, error: e instanceof Error ? e.message : String(e) },
        })),
      )
  }

  return (
    <div className="flex flex-col items-center py-1">
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Files changed in turn ${turnId + 1} (kimi 0.40+ file history)`}
        className="rounded-full border border-zinc-700/60 bg-zinc-900/60 px-2.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-300"
      >
        ◇ {changes.length} file{changes.length === 1 ? '' : 's'} changed
        {adds + dels > 0 ? ` · +${adds} −${dels}` : ''} {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="mt-1.5 w-full max-w-[85%] rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1">
          {changes.map((c) => {
            const st = STATUS_STYLE[c.status] ?? STATUS_STYLE.modified
            const d = diffs[c.path]
            const isOpen = openFile === c.path
            return (
              <div key={c.path}>
                <button
                  onClick={() => toggleFile(c)}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-800/60"
                >
                  <span className={`w-3 shrink-0 text-center ${st.cls}`}>{st.glyph}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300">{c.path}</span>
                  {!c.binary && (
                    <span className="shrink-0 text-[11px] text-zinc-500">
                      +{c.additions} −{c.deletions}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] text-zinc-600">{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen && (
                  <div className="mb-1 px-1">
                    {c.binary ? (
                      <div className="px-2 py-1 text-[11px] text-zinc-500">binary file, no inline diff</div>
                    ) : !d || d.loading ? (
                      <div className="px-2 py-1 text-[11px] text-zinc-500">loading diff…</div>
                    ) : d.error ? (
                      <div className="px-2 py-1 text-[11px] text-red-400/90">diff failed: {d.error}</div>
                    ) : d.start === null && d.end === null ? (
                      <div className="px-2 py-1 text-[11px] text-zinc-500">no checkpoint recorded for this file</div>
                    ) : (
                      <div className="max-h-96 overflow-y-auto rounded border border-zinc-800 text-[12px] [&_td]:!border-zinc-800/50">
                        <DiffViewer
                          oldValue={d.start ?? ''}
                          newValue={d.end ?? ''}
                          splitView={false}
                          useDarkTheme
                          hideLineNumbers={false}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
