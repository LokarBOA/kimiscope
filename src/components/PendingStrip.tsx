import { post } from '../api/client'
import { abortQueuedAndRefresh } from '../state/sync'
import { useApp } from '../state/store'

const NO_OUTBOX: import('../state/store').OutboxItem[] = []

/** Pending prompts strip — sits right above the composer, TUI-style:
 *  queued items with edit / steer-now / cancel, plus transient outbox chips. */
export function PendingStrip({ sessionId }: { sessionId: string }) {
  // Select stable references; default outside the selector (zustand v5:
  // allocating `?? []` inside a selector infinite-loops useSyncExternalStore).
  const queue = useApp((st) => st.sessionState[sessionId]?.queue ?? null)
  const outbox = useApp((st) => st.sessionState[sessionId]?.outbox) ?? NO_OUTBOX

  const queued = queue?.queued ?? []
  const pendingOutbox = outbox.filter(
    (o) =>
      o.kind === 'steer' ||
      o.kind === 'send' ||
      (o.kind === 'queue' && !queued.some((q) => textOf(q) === o.text)),
  )
  if (queued.length === 0 && pendingOutbox.length === 0) return null

  function textOf(item: { content?: { type: string; text?: string }[] }): string {
    return (
      item.content
        ?.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
        .join(' ')
        .trim() || '(prompt)'
    )
  }

  return (
    <div className="space-y-1 border-t border-zinc-800 px-3 pt-2">
      {queued.map((q, i) => {
        const text = textOf(q)
        return (
          <div
            key={q.prompt_id}
            className="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[13px]"
          >
            <span className="shrink-0 rounded bg-zinc-700/70 px-1.5 py-px text-[10px] font-medium text-zinc-400">
              #{i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-zinc-300" title={text}>
              {text}
            </span>
            <button
              title="Edit — move text back to the composer"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('kimiscope:edit-queued', { detail: { sessionId, text } }),
                )
                void abortQueuedAndRefresh(sessionId, q.prompt_id)
              }}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-sky-400"
            >
              ✎ edit
            </button>
            <button
              title="Steer — the model picks it up at the next step boundary"
              onClick={() =>
                void post(`/sessions/${sessionId}/prompts:steer`, { prompt_ids: [q.prompt_id] })
              }
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-amber-400"
            >
              ⇢ steer
            </button>
            <button
              title="Remove from queue"
              onClick={() => void abortQueuedAndRefresh(sessionId, q.prompt_id)}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
            >
              ✕
            </button>
          </div>
        )
      })}
      {pendingOutbox.map((o) => (
        <div
          key={o.localId}
          className="flex items-center gap-2 rounded-md border border-dashed border-sky-800/50 bg-sky-950/10 px-2.5 py-1 text-[12px] text-sky-400/80"
        >
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />
          <span className="shrink-0">
            {o.kind === 'steer'
              ? 'steering (next step)…'
              : o.kind === 'interrupt'
                ? 'interrupting…'
                : 'sending…'}
          </span>
          <span className="min-w-0 flex-1 truncate text-zinc-500">
            {o.imageCount ? `🖼×${o.imageCount} ` : ''}
            {o.text}
          </span>
        </div>
      ))}
    </div>
  )
}
