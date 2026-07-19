import { Component, useEffect, useState, type ReactNode } from 'react'

function CrashOverlay({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8">
      <div className="max-w-2xl rounded-lg border border-red-900 bg-zinc-950 p-5">
        <div className="mb-2 text-sm font-semibold text-red-400">Something crashed</div>
        <pre className="max-h-80 overflow-auto text-[12px] whitespace-pre-wrap text-zinc-400">
          {error}
        </pre>
        <button
          onClick={onDismiss}
          className="mt-4 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-700"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

/** Catches render errors below and async errors globally, and shows them in-window. */
export class ErrorSurface extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) }
  }

  componentDidCatch(e: unknown) {
    console.error('render crash', e)
  }

  render() {
    if (this.state.error) {
      return <CrashOverlay error={this.state.error} onDismiss={() => this.setState({ error: null })} />
    }
    return this.props.children
  }
}

/** Async errors (unhandled rejections, window.onerror) as overlay. */
export function AsyncErrorSurface() {
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const onErr = (e: ErrorEvent) => setError(`${e.message}\n${e.error?.stack ?? ''}`)
    const onRej = (e: PromiseRejectionEvent) =>
      setError(e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ''}` : String(e.reason))
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)
    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onRej)
    }
  }, [])
  if (!error) return null
  return <CrashOverlay error={error} onDismiss={() => setError(null)} />
}
