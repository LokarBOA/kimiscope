import { useEffect, useRef, useState } from 'react'
import { useApp} from '../state/store'
import { loadOlder } from '../state/sync'
import { stripSystemEnvelopes } from '../state/sysmsg'
import type { ChatMessage, SubagentRecord, ToolCallRecord } from '../api/events'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCard } from './ToolCard'
import { TaskRow } from './InsightRail'

/** Best-effort render source for a history image block (the daemon stores
 *  `source.kind: 'url'` with a data URL; live blocks may carry raw base64). */
function imageSrc(b: unknown): string | null {
  const s = (b as { source?: { kind?: string; url?: string; data?: string; media_type?: string } })
    .source
  if (!s) return null
  if (typeof s.url === 'string' && s.url) return s.url
  if (typeof s.data === 'string' && s.data) return `data:${s.media_type ?? 'image/png'};base64,${s.data}`
  return null
}

/** Compaction divider: replaces the daemon-projection summary "user message"
 *  with a boundary marker; the agent's working summary sits behind a toggle. */
function CompactionCard({ msg }: { msg: ChatMessage }) {
  const [open, setOpen] = useState(false)
  const text = (msg.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n\n')
  return (
    <div className="py-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 text-zinc-600 transition-colors hover:text-zinc-400"
        title="The agent's pre-compaction working summary (state it wrote down for itself)"
      >
        <span className="h-px flex-1 bg-zinc-800" />
        <span className="text-[11px] tracking-wide">✂ context compacted {open ? '▾' : '▸'}</span>
        <span className="h-px flex-1 bg-zinc-800" />
      </button>
      {open && (
        <div className="mx-auto mt-2 max-w-[85%] rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-[12px] text-zinc-500">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  )
}

function MessageView({
  msg,
  toolCalls,
  subagents,
  plans,
}: {
  msg: ChatMessage
  toolCalls: Record<string, ToolCallRecord>
  subagents: Record<string, SubagentRecord>
  plans: Record<string, import('../state/store').PlanRecord>
}) {
  const [copied, setCopied] = useState(false)
  if (msg.role === 'tool') return null // results render inside their tool card
  if (msg.compaction) return <CompactionCard msg={msg} />
  const isUser = msg.role === 'user'
  // Runtime control-plane envelopes (system reminders, notifications) arrive as
  // user-role text — strip them; a message with nothing real left renders as nothing.
  const blocks = (msg.content ?? []).flatMap((b, i) => {
    if (b.type === 'text') {
      const text = stripSystemEnvelopes((b as { text: string }).text)
      return text ? [<Markdown key={i}>{text}</Markdown>] : []
    }
    if (b.type === 'image') {
      const src = imageSrc(b)
      return [
        src ? (
          <img
            key={i}
            src={src}
            alt="attached image"
            className="max-h-64 max-w-full rounded-md border border-zinc-700 object-contain"
          />
        ) : (
          <span key={i} className="inline-block rounded bg-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300">
            🖼 image
          </span>
        ),
      ]
    }
    if (b.type === 'thinking') return [<ThinkingBlock key={i} text={(b as { thinking: string }).thinking} />]
    if (b.type === 'tool_use') {
      const tu = b as { tool_call_id: string; tool_name: string; input: unknown }
      const rec = toolCalls[tu.tool_call_id] ?? {
        toolCallId: tu.tool_call_id,
        name: tu.tool_name,
        args: tu.input,
        status: 'running' as const,
      }
      return [<ToolCard key={tu.tool_call_id} call={rec} subagents={subagents} allCalls={toolCalls} plan={plans[tu.tool_call_id]} />]
    }
    return []
  })
  if (blocks.length === 0) return null

  const copyText = (msg.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n\n')
  // Copy affordance only on plain-text messages: thinking/tool cards own the
  // top-right corner for their expanders.
  const plain = (msg.content ?? []).every((b) => b.type === 'text')

  return (
    <div className={isUser ? 'flex justify-end' : ''}>
      <div
        className={
          isUser
            ? 'max-w-[80%] rounded-lg bg-zinc-800 px-3.5 py-2 text-[14px]'
            : 'group relative w-full space-y-2 text-[14px]'
        }
      >
        {!isUser && copyText && plain && (
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(copyText)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
            title="Copy message"
            className="absolute top-0 right-0 rounded px-1 text-[11px] text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-300"
          >
            {copied ? '✓ copied' : '📋'}
          </button>
        )}
        {blocks}
      </div>
    </div>
  )
}

export function ChatView({ sessionId }: { sessionId: string }) {
  const s = useApp((st) => st.sessionState[sessionId])
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  /** Marks scroll events caused by our own pinning (distinguishes them from
   *  user scrollbar drags — browser scroll-anchoring adjustments are neither). */
  const progScrollRef = useRef(false)
  /** Set while the user's pointer is down in the scrollbar gutter. */
  const scrollbarDragRef = useRef(false)
  const touchYRef = useRef<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)

  const ready = !!s

  // Follow-scroll, the whole story: anchored unless the USER scrolls up, and
  // re-anchored whenever the view lands at the bottom. Content growth (text
  // deltas, image decodes, reflow, clamps) never touches the flag — the only
  // inputs are wheel/touch/keyboard and scrollbar drags. Programmatic snaps
  // are marked so they can't masquerade as drags.
  useEffect(() => {
    const scrollEl = scrollRef.current
    const contentEl = contentRef.current
    if (!scrollEl || !contentEl) return
    stickRef.current = true
    const pin = () => {
      progScrollRef.current = true
      scrollEl.scrollTop = scrollEl.scrollHeight
      requestAnimationFrame(() => {
        progScrollRef.current = false
      })
    }
    pin()
    const ro = new ResizeObserver(() => {
      if (stickRef.current) pin()
    })
    ro.observe(contentEl)
    const onScroll = () => {
      if (progScrollRef.current) return // ours — not a user action
      if (scrollbarDragRef.current) {
        stickRef.current = false
        return
      }
      const dist = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
      if (dist < 24) stickRef.current = true
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      ro.disconnect()
      scrollEl.removeEventListener('scroll', onScroll)
    }
  }, [sessionId, ready])

  if (!s) return <div className="p-6 text-zinc-500">Loading session…</div>

  const liveCalls = Object.values(s.toolCalls).filter(
    (c) => c.status === 'running' && (c.agentId ?? 'main') === 'main',
  )
  const running = s.tasks.filter((t) => t.status === 'running')
  const backgroundBusy = !s.streaming.active && s.busy && !s.mainTurnActive && running.length > 0

  return (
    <div
      ref={scrollRef}
      onWheel={(e) => {
        if (e.deltaY < 0) stickRef.current = false
      }}
      onTouchStart={(e) => {
        touchYRef.current = e.touches[0]?.clientY ?? null
      }}
      onTouchMove={(e) => {
        const y0 = touchYRef.current
        const y1 = e.touches[0]?.clientY ?? y0
        if (y0 != null && y1 != null && y1 - y0 > 4) stickRef.current = false
      }}
      onKeyDown={(e) => {
        if (['PageUp', 'ArrowUp', 'Home', ' '].includes(e.key)) stickRef.current = false
      }}
      onPointerDown={(e) => {
        const el = e.currentTarget
        // Pointer in the scrollbar gutter = grabbing the scrollbar itself.
        if (e.clientX > el.getBoundingClientRect().right - 18) scrollbarDragRef.current = true
      }}
      onPointerUp={() => {
        scrollbarDragRef.current = false
      }}
      onPointerCancel={() => {
        scrollbarDragRef.current = false
      }}
      className="flex-1 overflow-y-auto px-5 py-4"
    >
      <div ref={contentRef} className="space-y-4">
        {s.hasMore && (
          <div className="text-center">
            <button
              disabled={loadingOlder}
              onClick={async () => {
                setLoadingOlder(true)
                const el = scrollRef.current
                const prevHeight = el?.scrollHeight ?? 0
                await loadOlder(sessionId)
                // Keep the viewport anchored where the user was reading.
                if (el) {
                  progScrollRef.current = true
                  el.scrollTop = el.scrollHeight - prevHeight
                  requestAnimationFrame(() => {
                    progScrollRef.current = false
                  })
                }
                setLoadingOlder(false)
              }}
              className="rounded-md bg-zinc-800 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-50"
            >
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {s.messages.map((m) => (
          <MessageView key={m.id} msg={m} toolCalls={s.toolCalls} subagents={s.subagents} plans={s.plans} />
        ))}

        {s.compacting && (
          <div className="flex items-center gap-3 py-1 text-zinc-600">
            <span className="h-px flex-1 bg-zinc-800" />
            <span className="flex items-center gap-2 text-[11px] tracking-wide">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-500" />
              compacting context…
            </span>
            <span className="h-px flex-1 bg-zinc-800" />
          </div>
        )}

        {s.streaming.active && (
          <div className="space-y-2 text-[14px]">
            {s.streaming.thinking && <ThinkingBlock text={s.streaming.thinking} streaming />}
            {s.streaming.assistant && <Markdown>{s.streaming.assistant}</Markdown>}
            {liveCalls.map((c) => (
              <ToolCard key={c.toolCallId} call={c} live subagents={s.subagents} allCalls={s.toolCalls} />
            ))}
            {!s.streaming.thinking && !s.streaming.assistant && liveCalls.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-zinc-500">
                <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
                Working…
              </div>
            )}
          </div>
        )}

        {backgroundBusy && (
          <div className="rounded-md border border-zinc-800/60">
            <button
              onClick={() => setTasksOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-zinc-500 hover:bg-zinc-800/40"
            >
              <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400/70" />
              <span className="flex-1">
                {running.length} background task{running.length > 1 ? 's' : ''} running — agent idle
              </span>
              <span className="text-zinc-600">{tasksOpen ? '▾' : '▸'}</span>
            </button>
            {tasksOpen && (
              <div className="border-t border-zinc-800/60 px-2 py-1">
                {running.map((t) => (
                  <TaskRow key={t.id} sessionId={sessionId} task={t} />
                ))}
              </div>
            )}
          </div>
        )}

        {s.lastError && (
          <div className="rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
            {s.lastError}
          </div>
        )}
      </div>
    </div>
  )
}
