import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import '@xterm/xterm/css/xterm.css'

/** Local PTY terminal (Rust portable-pty), independent of the daemon. */
export function TerminalPane({ cwd, onClose }: { cwd?: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#09090b',
        foreground: '#d4d4d8',
        cursor: '#38bdf8',
        selectionBackground: '#3f3f46',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    let termId: number | null = null
    let unlisten: (() => void) | null = null
    let disposed = false

    invoke<number>('term_spawn', { cwd: cwd ?? null, cols: term.cols, rows: term.rows })
      .then(async (id) => {
        if (disposed) {
          void invoke('term_kill', { id })
          return
        }
        termId = id
        unlisten = await listen<string>(`term://${id}`, (e) => term.write(e.payload))
        term.onData((d) => {
          if (termId != null) void invoke('term_write', { id: termId, data: d })
        })
      })
      .catch((e) => term.write(`\x1b[31mterm_spawn failed: ${e}\x1b[0m\r\n`))

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        if (termId != null) void invoke('term_resize', { id: termId, cols: term.cols, rows: term.rows })
      } catch {
        // fit throws when hidden; ignore
      }
    })
    observer.observe(host)

    // Drag-resize the pane from its top edge.
    const bar = barRef.current
    let dragY: number | null = null
    const onMove = (e: MouseEvent) => {
      if (dragY == null) return
      const delta = dragY - e.clientY
      dragY = e.clientY
      const parent = host.parentElement
      if (parent) parent.style.height = Math.max(120, parent.clientHeight + delta) + 'px'
    }
    const onUp = () => (dragY = null)
    const onDown = (e: MouseEvent) => {
      dragY = e.clientY
      e.preventDefault()
    }
    bar?.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)

    return () => {
      disposed = true
      observer.disconnect()
      bar?.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      unlisten?.()
      if (termId != null) void invoke('term_kill', { id: termId })
      term.dispose()
    }
  }, [cwd])

  return (
    <div className="flex h-64 shrink-0 flex-col border-t border-zinc-700 bg-zinc-950">
      <div
        ref={barRef}
        className="flex h-6 shrink-0 cursor-row-resize items-center gap-2 border-b border-zinc-800 px-2"
      >
        <span className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
          Terminal
        </span>
        <span className="text-[10px] text-zinc-700">local shell · drag to resize</span>
        <button
          onClick={onClose}
          className="ml-auto rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          ✕
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-1.5 py-1" />
    </div>
  )
}
