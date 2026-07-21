import { useCallback, useEffect, useRef, useState } from 'react'
import { abortActive, runSlashCommand, sendPrompt } from '../state/sync'
import { useApp, type ComposerDraft, type DraftImage } from '../state/store'
import { filterCommands, slashNameFilter, THINKING_LEVELS } from '../state/commands'
import type { SkillInfo } from '../api/events'
import { CommandMenu, type MenuEntry, type MenuSection } from './CommandMenu'

const NO_SKILLS: SkillInfo[] = []
const NO_IMAGES: DraftImage[] = []

interface FlatEntry extends MenuEntry {
  action: () => void
}

export function Composer({ sessionId }: { sessionId: string }) {
  // The composer stays mounted across session switches, so the draft lives in
  // the store keyed by session id — typed text must neither follow the switch
  // nor be lost.
  const draft = useApp((st) => st.drafts[sessionId])
  const text = draft?.text ?? ''
  const images = draft?.images ?? NO_IMAGES
  const setDraft = useApp((st) => st.setDraft)
  const [sending, setSending] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [modelPicker, setModelPicker] = useState<'model' | 'thinking' | null>(null)
  const busy = useApp((st) => st.sessionState[sessionId]?.busy ?? false)
  const skills = useApp((st) => st.sessionState[sessionId]?.skills)
  const models = useApp((st) => st.models)
  const notice = useApp((st) => st.notice)
  const setNotice = useApp((st) => st.setNotice)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const updateDraft = useCallback(
    (patch: Partial<ComposerDraft>) => {
      const cur = useApp.getState().drafts[sessionId] ?? { text: '', images: [] }
      setDraft(sessionId, { ...cur, ...patch })
    },
    [sessionId, setDraft],
  )

  // A restored draft may need a taller box than the single-row default.
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [sessionId])

  // QueueBar "edit" moves a queued prompt's text back here.
  useEffect(() => {
    function onEdit(e: Event) {
      const d = (e as CustomEvent<{ sessionId: string; text: string }>).detail
      if (d?.sessionId === sessionId) {
        updateDraft({ text: d.text })
        taRef.current?.focus()
      }
    }
    window.addEventListener('kimiscope:edit-queued', onEdit)
    return () => window.removeEventListener('kimiscope:edit-queued', onEdit)
  }, [sessionId, updateDraft])

  // Transient feedback for executed `/commands`.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(t)
  }, [notice, setNotice])

  function attachImage(file: File) {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const cur = useApp.getState().drafts[sessionId] ?? { text: '', images: [] }
      setDraft(sessionId, {
        ...cur,
        images: [...cur.images, { mediaType: file.type, base64, previewUrl: dataUrl }],
      })
    }
    reader.readAsDataURL(file)
  }

  /** Run a `/command` client-side; true when handled (input cleared, notice shown). */
  async function execSlash(raw: string): Promise<boolean> {
    const r = await runSlashCommand(sessionId, raw)
    if (!r.handled) return false
    updateDraft({ text: '' })
    setModelPicker(null)
    if (taRef.current) taRef.current.style.height = 'auto'
    if (r.notice) setNotice(r.notice)
    return true
  }

  function pickCommand(name: string) {
    if (name === 'model' || name === 'thinking') {
      setModelPicker(name)
      updateDraft({ text: `/${name}` })
      setHighlight(0)
      return
    }
    // Commands needing arguments complete the name and let the user type them.
    if (name === 'title' || name === 'goal') {
      updateDraft({ text: `/${name} ` })
      taRef.current?.focus()
      return
    }
    void execSlash(`/${name}`)
  }

  function pickSkill(name: string) {
    updateDraft({ text: `/${name} ` })
    taRef.current?.focus()
  }

  // ---- Menu view model ----
  const nameFilter = slashNameFilter(text)
  const menuOpen = !dismissed && (modelPicker !== null || nameFilter !== null)
  const sections: MenuSection[] = []
  const flat: FlatEntry[] = []
  if (menuOpen) {
    if (modelPicker === 'model') {
      for (const m of models) {
        flat.push({
          key: `model:${m.model}`,
          label: m.display_name || m.model,
          hint: m.model,
          description: m.provider,
          action: () => void execSlash(`/model ${m.model}`),
        })
      }
      sections.push({ title: 'Models — switching invalidates the prompt cache', entries: flat, start: 0 })
    } else if (modelPicker === 'thinking') {
      for (const level of THINKING_LEVELS) {
        flat.push({
          key: `thinking:${level}`,
          label: level,
          action: () => void execSlash(`/thinking ${level}`),
        })
      }
      sections.push({ title: 'Thinking effort — switching invalidates the prompt cache', entries: flat, start: 0 })
    } else {
      const g = filterCommands(nameFilter ?? '', skills ?? NO_SKILLS)
      const cmdEntries: FlatEntry[] = g.commands.map((c) => ({
        key: `cmd:${c.name}`,
        label: `/${c.name}`,
        hint: c.args,
        description: c.description,
        action: () => pickCommand(c.name),
      }))
      const skillEntries: FlatEntry[] = g.skills.map((s) => ({
        key: `skill:${s.source}:${s.name}`,
        label: `/${s.name}`,
        hint: s.source,
        description: s.description,
        action: () => pickSkill(s.name),
      }))
      if (cmdEntries.length) sections.push({ title: 'Session', entries: cmdEntries, start: 0 })
      if (skillEntries.length)
        sections.push({ title: 'Skills', entries: skillEntries, start: cmdEntries.length })
      flat.push(...cmdEntries, ...skillEntries)
    }
  }
  const hi = Math.min(highlight, Math.max(flat.length - 1, 0))

  async function submit(mode: 'queue' | 'steer' | 'interrupt') {
    const t = text.trim()
    if ((!t && images.length === 0) || sending) return
    setSending(true)
    try {
      // `/commands` run client-side and never reach the daemon as prompts;
      // unknown ones fall through as normal messages (CLI semantics).
      if (t.startsWith('/') && (await execSlash(t))) return
      await sendPrompt(sessionId, t, mode, images)
      updateDraft({ text: '', images: [] })
      if (taRef.current) taRef.current.style.height = 'auto'
    } catch (e) {
      console.error('prompt failed', e)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="relative border-t border-zinc-800 p-3">
      {menuOpen && (
        <CommandMenu
          sections={sections}
          highlight={hi}
          total={flat.length}
          onPick={(i) => flat[i]?.action()}
          onHover={setHighlight}
        />
      )}
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div key={i} className="group relative">
              <img
                src={img.previewUrl}
                alt="attachment"
                className="h-16 rounded-md border border-zinc-700 object-cover"
              />
              <button
                onClick={() => updateDraft({ images: images.filter((_, j) => j !== i) })}
                className="absolute -top-1.5 -right-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-[10px] text-zinc-200 group-hover:flex"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-lg border border-zinc-700 bg-zinc-900 p-2 focus-within:border-zinc-500">
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder={
            busy ? 'Message — Enter queues, Steer injects, ■ Stop aborts…' : 'Message Kimi… (paste images, / for commands)'
          }
          onChange={(e) => {
            updateDraft({ text: e.target.value })
            setDismissed(false)
            setHighlight(0)
            if (modelPicker && e.target.value !== `/${modelPicker}`) setModelPicker(null)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 200) + 'px'
          }}
          onPaste={(e) => {
            Array.from(e.clipboardData.files).forEach(attachImage)
          }}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = Math.max(flat.length, 1)
                setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
                return
              }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                e.preventDefault()
                if (flat.length > 0) flat[hi]?.action()
                else if (e.key === 'Enter') void submit('queue')
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setDismissed(true)
                setModelPicker(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              // Enter is always a normal send — queues behind an active turn.
              void submit('queue')
            }
            if (e.key === 'Escape' && busy) {
              void abortActive(sessionId)
            }
          }}
          className="max-h-52 flex-1 resize-none bg-transparent px-1.5 py-1 text-[14px] text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        {busy ? (
          <>
            <button
              onClick={() => void submit('queue')}
              disabled={(!text.trim() && images.length === 0) || sending}
              title="Add to the queue; runs after the active turn"
              className="rounded-md bg-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              Queue
            </button>
            <button
              onClick={() => void submit('steer')}
              disabled={(!text.trim() && images.length === 0) || sending}
              title="Inject into the active turn; model picks it up at the next step boundary"
              className="rounded-md bg-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-600 disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              Steer
            </button>
            <button
              onClick={() => void abortActive(sessionId)}
              title="Stop the active turn (Esc also works); your message stays for Send"
              className="rounded-md bg-red-700/80 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-600"
            >
              ■ Stop
            </button>
          </>
        ) : (
          <button
            onClick={() => void submit('queue')}
            disabled={(!text.trim() && images.length === 0) || sending}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            Send
          </button>
        )}
      </div>
      <div className="mt-1 px-1 text-[11px] text-zinc-600">
        {notice ? (
          <span className="text-amber-400/90">{notice}</span>
        ) : (
          <>
            Enter sends (queues if busy) · Steer lands at next step · ■ Stop or Esc aborts · / for
            commands
          </>
        )}
      </div>
    </div>
  )
}
