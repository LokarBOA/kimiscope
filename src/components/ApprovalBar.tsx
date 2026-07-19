import { useState } from 'react'
import { post } from '../api/client'
import type { ApprovalItem } from '../api/events'
import { useApp } from '../state/store'
import { Markdown } from './Markdown'

interface Display {
  kind?: string
  command?: string
  plan?: string
}

function ApprovalCard({ sessionId, approval }: { sessionId: string; approval: ApprovalItem }) {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const display = approval.tool_input_display as Display | undefined
  const isPlan = display?.kind === 'plan_review'

  async function decide(decision: 'approved' | 'rejected', scope?: 'session', note?: string) {
    if (busy) return
    setBusy(true)
    try {
      await post(`/sessions/${sessionId}/approvals/${approval.approval_id}`, {
        decision,
        ...(scope ? { scope } : {}),
        ...(note ? { feedback: note } : {}),
      })
      setFeedback('')
    } catch (e) {
      console.error('approval decision failed', e)
      setBusy(false)
    }
  }

  return (
    <div
      className={`rounded-lg border p-3 ${
        isPlan ? 'border-sky-700/50 bg-sky-950/20' : 'border-amber-700/50 bg-amber-950/20'
      }`}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className={isPlan ? 'text-sky-400' : 'text-amber-400'}>{isPlan ? '◈' : '⚠'}</span>
        <span className={`font-medium ${isPlan ? 'text-sky-200' : 'text-amber-200'}`}>
          {approval.tool_name}
        </span>
        <span className="text-zinc-400">{isPlan ? 'presents a plan' : 'wants approval'}</span>
      </div>
      <div className="mt-1.5 text-[13px] text-zinc-300">{approval.action}</div>
      {display?.command && (
        <pre className="mt-1.5 overflow-x-auto rounded bg-black/50 p-2 font-mono text-[12px] text-amber-100/90">
          $ {display.command}
        </pre>
      )}
      {isPlan && display?.plan && (
        <div className="mt-2 max-h-80 overflow-y-auto rounded border border-zinc-800 bg-zinc-950/60 p-3 text-[13px]">
          <Markdown>{display.plan}</Markdown>
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          onClick={() => void decide('approved')}
          disabled={busy}
          className="rounded-md bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {isPlan ? 'Approve plan' : 'Approve'}
        </button>
        {!isPlan && (
          <button
            onClick={() => void decide('approved', 'session')}
            disabled={busy}
            className="rounded-md bg-zinc-700 px-3 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
          >
            Always, this session
          </button>
        )}
        <button
          onClick={() => void decide('rejected', undefined, feedback.trim() || undefined)}
          disabled={busy}
          className="rounded-md bg-red-900/70 px-3 py-1 text-xs font-medium text-red-200 hover:bg-red-800 disabled:opacity-50"
        >
          {isPlan ? 'Revise' : 'Deny'}
        </button>
      </div>
      {isPlan && (
        <input
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Revision notes (sent with Revise)…"
          className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-sky-700"
        />
      )}
    </div>
  )
}

const NO_APPROVALS: ApprovalItem[] = []

export function ApprovalBar({ sessionId }: { sessionId: string }) {
  // Select the stable reference; default outside the selector. A `?? []`
  // inside the selector allocates per snapshot and loops useSyncExternalStore.
  const approvals = useApp((st) => st.sessionState[sessionId]?.approvals) ?? NO_APPROVALS
  if (approvals.length === 0) return null
  return (
    <div className="space-y-2 border-t border-zinc-800 px-3 pt-2">
      {approvals.map((a) => (
        <ApprovalCard key={a.approval_id} sessionId={sessionId} approval={a} />
      ))}
    </div>
  )
}
