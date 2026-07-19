import { useEffect, useRef, useState } from 'react'
import { abortActive, sendPrompt } from '../state/sync'
import { useApp } from '../state/store'

interface PendingImage {
  mediaType: string
  base64: string
  previewUrl: string
}

export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [sending, setSending] = useState(false)
  const busy = useApp((st) => st.sessionState[sessionId]?.busy ?? false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // QueueBar "edit" moves a queued prompt's text back here.
  useEffect(() => {
    function onEdit(e: Event) {
      const d = (e as CustomEvent<{ sessionId: string; text: string }>).detail
      if (d?.sessionId === sessionId) {
        setText(d.text)
        taRef.current?.focus()
      }
    }
    window.addEventListener('kimiscope:edit-queued', onEdit)
    return () => window.removeEventListener('kimiscope:edit-queued', onEdit)
  }, [sessionId])

  function attachImage(file: File) {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      setImages((imgs) => [
        ...imgs,
        { mediaType: file.type, base64, previewUrl: dataUrl },
      ])
    }
    reader.readAsDataURL(file)
  }

  async function submit(mode: 'queue' | 'steer' | 'interrupt') {
    const t = text.trim()
    if ((!t && images.length === 0) || sending) return
    setSending(true)
    try {
      await sendPrompt(sessionId, t, mode, images)
      setText('')
      setImages([])
      if (taRef.current) taRef.current.style.height = 'auto'
    } catch (e) {
      console.error('prompt failed', e)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t border-zinc-800 p-3">
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
                onClick={() => setImages((imgs) => imgs.filter((_, j) => j !== i))}
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
          placeholder={busy ? 'Message — Enter queues, ⚡ Now interrupts…' : 'Message Kimi… (paste images)'}
          onChange={(e) => {
            setText(e.target.value)
            const el = e.target
            el.style.height = 'auto'
            el.style.height = Math.min(el.scrollHeight, 200) + 'px'
          }}
          onPaste={(e) => {
            Array.from(e.clipboardData.files).forEach(attachImage)
          }}
          onKeyDown={(e) => {
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
              onClick={() => void submit('interrupt')}
              disabled={(!text.trim() && images.length === 0) || sending}
              title="Interrupt NOW: kills the active turn; this message takes over"
              className="rounded-md bg-amber-600/80 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              ⚡ Now
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
        Enter sends (queues if busy) · ⚡ Now interrupts instantly · Steer lands at next step · Esc
        aborts
      </div>
    </div>
  )
}
