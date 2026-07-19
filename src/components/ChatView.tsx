import { useEffect, useRef, useState } from 'react'
import { useApp} from '../state/store'
import { loadOlder } from '../state/sync'
import type { ChatMessage, SubagentRecord, ToolCallRecord } from '../api/events'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCard } from './ToolCard'

function MessageView({
  msg,
  toolCalls,
  subagents,
}: {
  msg: ChatMessage
  toolCalls: Record<string, ToolCallRecord>
  subagents: Record<string, SubagentRecord>
}) {
  if (msg.role === 'tool') return null // results render inside their tool card
  const blocks = msg.content ?? []
  const isUser = msg.role === 'user'

  return (
    <div className={isUser ? 'flex justify-end' : ''}>
      <div
        className={
          isUser
            ? 'max-w-[80%] rounded-lg bg-zinc-800 px-3.5 py-2 text-[14px]'
            : 'w-full space-y-2 text-[14px]'
        }
      >
        {blocks.map((b, i) => {
          if (b.type === 'text') return <Markdown key={i}>{(b as { text: string }).text}</Markdown>
          if (b.type === 'thinking')
            return <ThinkingBlock key={i} text={(b as { thinking: string }).thinking} />
          if (b.type === 'tool_use') {
            const tu = b as { tool_call_id: string; tool_name: string; input: unknown }
            const rec = toolCalls[tu.tool_call_id] ?? {
              toolCallId: tu.tool_call_id,
              name: tu.tool_name,
              args: tu.input,
              status: 'running' as const,
            }
            return (
              <ToolCard key={tu.tool_call_id} call={rec} subagents={subagents} allCalls={toolCalls} />
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

export function ChatView({ sessionId }: { sessionId: string }) {
  const s = useApp((st) => st.sessionState[sessionId])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const msgCount = s?.messages.length ?? 0
  const streamSig = (s?.streaming.thinking.length ?? 0) + (s?.streaming.assistant.length ?? 0)

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [msgCount, streamSig, sessionId])

  if (!s) return <div className="p-6 text-zinc-500">Loading session…</div>

  const liveCalls = Object.values(s.toolCalls).filter(
    (c) => c.status === 'running' && (c.agentId ?? 'main') === 'main',
  )

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
      className="flex-1 space-y-4 overflow-y-auto px-5 py-4"
    >
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
        <div className="space-y-2">
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

      {s.lastError && (
        <div className="rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          {s.lastError}
        </div>
      )}
    </div>
  )
}
