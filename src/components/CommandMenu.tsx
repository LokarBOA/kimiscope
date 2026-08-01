export interface MenuEntry {
  key: string
  label: string
  description?: string
  hint?: string
  /** Optional secondary affordance rendered as a small button on the row's right. */
  altLabel?: string
}

export interface MenuSection {
  title: string
  entries: MenuEntry[]
  /** Global flat index of this section's first entry (for highlight math). */
  start: number
}

/** Popup above the Composer listing `/` commands, skills, or models.
 *  Presentational only — filtering, keyboard, and actions live in Composer. */
export function CommandMenu({
  sections,
  highlight,
  total,
  onPick,
  onHover,
  onAlt,
}: {
  sections: MenuSection[]
  highlight: number
  total: number
  onPick: (index: number) => void
  onHover: (index: number) => void
  onAlt?: (index: number) => void
}) {
  return (
    <div className="absolute right-3 bottom-full left-3 z-20 mb-2 max-h-80 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl shadow-black/50">
      {sections.map((sec) => (
        <div key={sec.title}>
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-zinc-500 uppercase">
            {sec.title}
          </div>
          {sec.entries.map((e, i) => {
            const idx = sec.start + i
            return (
              <button
                key={e.key}
                onMouseEnter={() => onHover(idx)}
                onClick={() => onPick(idx)}
                className={`flex w-full items-baseline gap-2 px-3 py-1 text-left text-[13px] ${
                  idx === highlight ? 'bg-zinc-800' : ''
                }`}
              >
                <span className="shrink-0 font-mono text-sky-300">{e.label}</span>
                {e.hint && <span className="shrink-0 text-[11px] text-zinc-600">{e.hint}</span>}
                <span className="min-w-0 flex-1 truncate text-zinc-500">{e.description}</span>
                {e.altLabel && onAlt && (
                  <span
                    role="button"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onAlt(idx)
                    }}
                    className="shrink-0 rounded border border-zinc-700 px-1 text-[10px] text-zinc-500 hover:border-sky-700 hover:text-sky-300"
                  >
                    {e.altLabel}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      ))}
      {total === 0 && (
        <div className="px-3 py-2 text-[12px] text-zinc-600">
          No matches — Enter sends as a message
        </div>
      )}
    </div>
  )
}
