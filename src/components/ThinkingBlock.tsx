import { useEffect, useRef, useState } from 'react'

/** Collapsible reasoning block — collapsed by default once finished. */
export function ThinkingBlock({
  text,
  streaming = false,
}: {
  text: string
  streaming?: boolean
}) {
  const [open, setOpen] = useState(streaming)
  const bodyRef = useRef<HTMLDivElement>(null)
  // While streaming, the box follows the newest thought unless the user
  // scrolled up inside it.
  const innerStickRef = useRef(true)

  useEffect(() => {
    const el = bodyRef.current
    if (el && streaming && innerStickRef.current) el.scrollTop = el.scrollHeight
  }, [text, streaming, open])

  if (!text.trim()) return null
  return (
    <div className="rounded-md border border-violet-900/40 bg-violet-950/20">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-violet-300/80 hover:text-violet-200"
      >
        <span className={streaming ? 'animate-pulse' : ''}>{streaming ? '●' : '◆'}</span>
        Thinking{streaming ? '…' : ''}
        <span className="ml-auto text-zinc-600">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget
            innerStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
          className="max-h-96 overflow-y-auto px-3 pb-2 text-[13px] whitespace-pre-wrap text-zinc-400"
        >
          {text}
        </div>
      )}
    </div>
  )
}
