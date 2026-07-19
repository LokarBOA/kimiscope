import { useState } from 'react'
import { post } from '../api/client'
import type { QuestionItem } from '../api/events'
import { useApp } from '../state/store'

type Answer =
  | { kind: 'single'; option_id: string }
  | { kind: 'multi'; option_ids: string[] }
  | { kind: 'other'; text: string }
  | { kind: 'multi_with_other'; option_ids: string[]; other_text: string }
  | { kind: 'skipped' }

function QuestionCard({
  sessionId,
  item,
}: {
  sessionId: string
  item: QuestionItem
}) {
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const subs = item.questions ?? []

  async function submit() {
    if (busy) return
    setBusy(true)
    const answers: Record<string, Answer> = {}
    for (const sub of subs) {
      const sel = selections[sub.id] ?? []
      const other = (otherText[sub.id] ?? '').trim()
      if (other && sel.length === 0) answers[sub.id] = { kind: 'other', text: other }
      else if (other && sel.length > 0)
        answers[sub.id] = { kind: 'multi_with_other', option_ids: sel, other_text: other }
      else if (sub.multi_select && sel.length > 0)
        answers[sub.id] = { kind: 'multi', option_ids: sel }
      else if (sel.length > 0) answers[sub.id] = { kind: 'single', option_id: sel[0] }
      else answers[sub.id] = { kind: 'skipped' }
    }
    try {
      await post(`/sessions/${sessionId}/questions/${item.question_id}`, { answers })
    } catch (e) {
      console.error('question submit failed', e)
      setBusy(false)
    }
  }

  async function dismiss() {
    await post(`/sessions/${sessionId}/questions/${item.question_id}:dismiss`).catch((e) =>
      console.error('question dismiss failed', e),
    )
  }

  return (
    <div className="rounded-lg border border-sky-800/50 bg-sky-950/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sky-400">?</span>
        <span className="text-sm font-medium text-sky-200">Kimi is asking</span>
        <button
          onClick={() => void dismiss()}
          title="Dismiss — the agent continues without answers"
          className="ml-auto text-xs text-zinc-500 hover:text-zinc-300"
        >
          Dismiss all
        </button>
      </div>
      <div className="space-y-3">
        {subs.map((sub) => {
          const sel = selections[sub.id] ?? []
          return (
            <div key={sub.id}>
              <div className="mb-1 text-[13px] text-zinc-300">
                {sub.header && (
                  <span className="mr-1.5 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {sub.header}
                  </span>
                )}
                {sub.question}
              </div>
              <div className="space-y-1">
                {sub.options.map((opt) => {
                  const checked = sel.includes(opt.id)
                  return (
                    <label
                      key={opt.id}
                      className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-1.5 text-[13px] ${
                        checked
                          ? 'border-sky-600 bg-sky-900/30 text-zinc-100'
                          : 'border-zinc-800 text-zinc-400 hover:border-zinc-600'
                      }`}
                    >
                      <input
                        type={sub.multi_select ? 'checkbox' : 'radio'}
                        name={item.question_id + sub.id}
                        checked={checked}
                        onChange={() => {
                          setSelections((s) => {
                            const cur = s[sub.id] ?? []
                            if (sub.multi_select) {
                              return {
                                ...s,
                                [sub.id]: checked
                                  ? cur.filter((x) => x !== opt.id)
                                  : [...cur, opt.id],
                              }
                            }
                            return { ...s, [sub.id]: [opt.id] }
                          })
                        }}
                        className="mt-0.5 accent-sky-500"
                      />
                      <span>
                        <span className="block">{opt.label}</span>
                        {opt.description && (
                          <span className="block text-xs text-zinc-500">{opt.description}</span>
                        )}
                      </span>
                    </label>
                  )
                })}
                {sub.allow_other !== false && (
                  <input
                    type="text"
                    placeholder="Other…"
                    value={otherText[sub.id] ?? ''}
                    onChange={(e) => setOtherText((s) => ({ ...s, [sub.id]: e.target.value }))}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-sky-700"
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          Submit answers
        </button>
        <span className="text-[11px] text-zinc-600">unanswered questions are skipped</span>
      </div>
    </div>
  )
}

const NO_QUESTIONS: QuestionItem[] = []

/** Renders EVERY pending question item, each with all of its sub-questions. */
export function QuestionDialog({ sessionId }: { sessionId: string }) {
  // Select the stable reference; default outside the selector (see ApprovalBar).
  const questions = useApp((st) => st.sessionState[sessionId]?.questions) ?? NO_QUESTIONS
  if (questions.length === 0) return null
  return (
    <div className="space-y-2 border-t border-zinc-800 px-3 pt-2">
      {questions.map((q) => (
        <QuestionCard key={q.question_id} sessionId={sessionId} item={q} />
      ))}
    </div>
  )
}
