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

function MessageView({
  msg,
  toolCalls,
  subagents,
}: {
  msg: ChatMessage
  toolCalls: Record<string, ToolCallRecord>
  subagents: Record<string, SubagentRecord>
}) {
  const [copied, setCopied] = useState(false)
  if (msg.role === 'tool') return null // results render inside their tool card
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
      return [<ToolCard key={tu.tool_call_id} call={rec} subagents={subagents} allCalls={toolCalls} />]
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
  const lastTopRef = useRef(0)
  const lastHeightRef = useRef(0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)

  const ready = !!s

  // Follow the stream. Growth is observed on the content itself, so anything
  // that makes it taller — text deltas, tool progress, subagent panels,
  // markdown reflow — snaps to the bottom while the user is stuck there.
  // Stickiness is derived only from scroll position: programmatic snaps land
  // exactly at the bottom and never un-anchor, while scrolling up detaches and
  // scrolling back to the bottom re-attaches.
  useEffect(() => {
    const scrollEl = scrollRef.current
    const contentEl = contentRef.current
    if (!scrollEl || !contentEl) return
    stickRef.current = true
    scrollEl.scrollTop = scrollEl.scrollHeight
    const ro = new ResizeObserver(() => {
      if (stickRef.current) scrollEl.scrollTop = scrollEl.scrollHeight
    })
    ro.observe(contentEl)
    return () => ro.disconnect()
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
      onScroll={(e) => {
        const el = e.currentTarget
        // Unstick only on a genuine user scroll-up: position moves up while
        // height is stable or growing. History replacement (send/splice/pull)
        // shrinks content transiently and the browser clamps scrollTop down —
        // a clamp, not a scroll-up, and it must not unstick the follow.
        const clamping = el.scrollHeight < lastHeightRef.current - 1
        if (!clamping && el.scrollTop < lastTopRef.current - 1) stickRef.current = false
        else stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        lastTopRef.current = el.scrollTop
        lastHeightRef.current = el.scrollHeight
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
                if (el) el.scrollTop = el.scrollHeight - prevHeight
                setLoadingOlder(false)
              }}
              className="rounded-md bg-zinc-800 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-50"
            >
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {s.messages.map((m) => (
          <MessageView key={m.id} msg={m} toolCalls={s.toolCalls} subagents={s.subagents} />
        ))}

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
