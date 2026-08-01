import { useEffect, useRef, useState, type ReactNode } from 'react'
import DiffViewer from 'react-diff-viewer-continued'
import type { SubagentRecord, ToolCallRecord } from '../api/events'
import { getConnectionInfo } from '../api/connection'
import { openExternal } from '../api/openPath'
import { Markdown } from './Markdown'

function fmtArgs(args: unknown): string {
  if (args == null) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args, null, 1)
  } catch {
    return String(args)
  }
}

function fmtOutput(output: unknown): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 1)
  } catch {
    return String(output)
  }
}

/** Image blocks inside a tool result (ReadMediaFile et al. return content-block
 *  arrays with `image_url` entries carrying data URLs). */
function extractResultImages(output: unknown): string[] {
  if (!Array.isArray(output)) return []
  const urls: string[] = []
  for (const b of output as Record<string, unknown>[]) {
    if (b?.type === 'image_url') {
      const u = (b.imageUrl as { url?: unknown } | undefined)?.url
      if (typeof u === 'string' && u) urls.push(u)
    } else if (b?.type === 'image') {
      const u = (b.source as { url?: unknown } | undefined)?.url
      if (typeof u === 'string' && u) urls.push(u)
    }
  }
  return urls
}

/** Video results carry a path tag: either a plain string
 *  `<video path="C:/…/clip.webm"></video>` (transcript) or content blocks with
 *  the tag in a text block plus a `video_url` companion (REST history — the
 *  ms:// id is not downloadable over REST, so the path is the only source). */
function extractResultVideos(output: unknown): string[] {
  const paths: string[] = []
  const scan = (text: string) => {
    for (const m of text.matchAll(/<video path="([^"]+)"/g)) paths.push(m[1])
  }
  if (typeof output === 'string') scan(output)
  else if (Array.isArray(output)) {
    for (const b of output as Record<string, unknown>[]) {
      if (b?.type === 'text' && typeof b.text === 'string') scan(b.text)
    }
  }
  return paths
}

const VIDEO_MIME: Record<string, string> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ogv: 'video/ogg',
}
/** Don't pull files bigger than this into the webview — fall back to the
 *  external-player link instead. */
const VIDEO_CAP = 25 * 1024 * 1024

/** path → blob URL promise (null = unavailable: endpoint missing on old
 *  daemons, file gone, or over the cap). Cached forever — history videos
 *  don't change, and revoking would break re-renders. */
const videoUrlCache = new Map<string, Promise<string | null>>()

function fetchVideoUrl(path: string): Promise<string | null> {
  let p = videoUrlCache.get(path)
  if (p) return p
  p = (async () => {
    try {
      const conn = await getConnectionInfo()
      const url = `${conn.baseUrl}/api/v1/fs:content?path=${encodeURIComponent(path)}`
      const auth = { Authorization: `Bearer ${conn.token}` }
      // Size probe: 1-byte range → Content-Range carries the total. Daemons
      // before fs:content (≤0.28) answer 404 here → null → chip fallback.
      const probe = await fetch(url, { headers: { ...auth, Range: 'bytes=0-0' } })
      if (probe.status === 206) {
        const total = Number((probe.headers.get('content-range') ?? '').split('/')[1])
        await probe.arrayBuffer()
        if (Number.isFinite(total) && total > VIDEO_CAP) return null
      } else {
        const len = Number(probe.headers.get('content-length') ?? 0)
        await probe.body?.cancel().catch(() => {})
        if (!probe.ok) return null
        if (len > VIDEO_CAP) return null
      }
      const res = await fetch(url, { headers: auth })
      if (!res.ok) return null
      const buf = await res.arrayBuffer()
      if (buf.byteLength > VIDEO_CAP) return null
      const ext = path.split('.').pop()?.toLowerCase() ?? ''
      return URL.createObjectURL(new Blob([buf], { type: VIDEO_MIME[ext] ?? 'video/mp4' }))
    } catch {
      return null
    }
  })()
  videoUrlCache.set(path, p)
  return p
}

/** Inline player for a video result: filename link on top (opens the default
 *  player), <video> below fed by a blob URL from fs:content. The fetch only
 *  starts when the card scrolls near the viewport. Falls back to the bare
 *  chip+link when the file can't be streamed. */
function InlineVideo({ path }: { path: string }) {
  const name = path.split(/[\\/]/).pop() ?? path
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [src, setSrc] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          setPhase('loading')
          void fetchVideoUrl(path).then((u) => {
            setSrc(u)
            setPhase(u ? 'ready' : 'failed')
          })
        }
      },
      { rootMargin: '300px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [path])
  return (
    <div ref={ref} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {phase === 'failed' && (
          <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300">🎬</span>
        )}
        <button
          onClick={() => void openExternal(path)}
          title={`${path} — open in default player`}
          className="max-w-72 truncate text-left font-mono text-[11px] text-sky-400/90 underline decoration-zinc-600 underline-offset-2 hover:text-sky-300"
        >
          {name}
        </button>
      </div>
      {phase === 'loading' && <div className="h-36 w-64 animate-pulse rounded-md bg-zinc-800/60" />}
      {phase === 'ready' && src && (
        <video src={src} controls preload="metadata" className="max-h-64 rounded-md border border-zinc-700" />
      )}
    </div>
  )
}

const ICONS: Record<string, string> = {
  Bash: '›_',
  Read: '📄',
  Edit: '✎',
  Write: '✎',
  Grep: '⌕',
  Glob: '⌕',
  TodoList: '☰',
  Agent: '⎇',
  WebSearch: '◎',
  FetchURL: '⇩',
}

function EditDiff({ args }: { args: unknown }) {
  const a = args as { path?: string; old_string?: string; new_string?: string }
  if (typeof a?.old_string !== 'string' || typeof a?.new_string !== 'string') return null
  return (
    <div>
      {a.path && <div className="mb-1 font-mono text-[11px] text-zinc-500">{a.path}</div>}
      <div className="max-h-96 overflow-y-auto rounded border border-zinc-800 text-[12px] [&_td]:!border-zinc-800/50">
        <DiffViewer
          oldValue={a.old_string}
          newValue={a.new_string}
          splitView={false}
          useDarkTheme
          hideLineNumbers={false}
        />
      </div>
    </div>
  )
}

function WritePreview({ args }: { args: unknown }) {
  const a = args as { path?: string; content?: string }
  if (typeof a?.content !== 'string') return null
  return (
    <div>
      {a.path && <div className="mb-1 font-mono text-[11px] text-zinc-500">{a.path}</div>}
      <pre className="max-h-72 overflow-y-auto rounded bg-zinc-900 p-2 text-[12px] whitespace-pre-wrap text-zinc-300">
        {a.content.length > 4000 ? a.content.slice(0, 4000) + '\n… (truncated)' : a.content}
      </pre>
    </div>
  )
}

/** Nested view of a subagent spawned by an Agent/AgentSwarm tool call. */
function SubagentPanel({
  sub,
  allCalls,
}: {
  sub: SubagentRecord
  allCalls: Record<string, ToolCallRecord>
}) {
  const childCalls = Object.values(allCalls).filter((c) => c.agentId === sub.subagentId)
  return (
    <div className="mt-2 space-y-1 border-l-2 border-violet-800/60 pl-3">
      <div className="flex items-center gap-2 text-[12px]">
        <span
          className={`h-1.5 w-1.5 rounded-full ${sub.status === 'running' ? 'animate-pulse bg-violet-400' : 'bg-emerald-500'}`}
        />
        <span className="font-medium text-violet-300">{sub.name}</span>
        {sub.description && <span className="truncate text-zinc-500">{sub.description}</span>}
      </div>
      {sub.status === 'running' && sub.thinking && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-violet-400/70 hover:text-violet-300">
            Thinking…
          </summary>
          <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-zinc-500">
            {sub.thinking.slice(-2000)}
          </div>
        </details>
      )}
      {childCalls.map((c) => (
        <div key={c.toolCallId} className="flex items-center gap-2 text-[12px] text-zinc-500">
          <span
            className={`h-1 w-1 rounded-full ${
              c.status === 'running' ? 'animate-pulse bg-sky-400' : c.status === 'error' ? 'bg-red-500' : 'bg-emerald-500'
            }`}
          />
          <span className="font-medium text-zinc-400">{c.name}</span>
          <span className="truncate">{c.description ?? ''}</span>
        </div>
      ))}
      {sub.status === 'done' && sub.resultSummary && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">Result</summary>
          <div className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap text-zinc-400">
            {sub.resultSummary}
          </div>
        </details>
      )}
    </div>
  )
}

/** ExitPlanMode with a recoverable plan record (0.29+): plan content,
 *  offered options (selected highlighted), and the review outcome. */
function PlanBody({ plan }: { plan: import('../state/store').PlanRecord }) {
  const [showPlan, setShowPlan] = useState(false)
  const review = plan.review
  const badge =
    review?.state === 'approved'
      ? { text: 'approved', cls: 'bg-emerald-900/60 text-emerald-300' }
      : review?.state === 'rejected'
        ? { text: 'rejected', cls: 'bg-red-950/60 text-red-300' }
        : review?.state === 'cancelled'
          ? { text: 'cancelled', cls: 'bg-zinc-800 text-zinc-400' }
          : { text: 'auto', cls: 'bg-sky-950/60 text-sky-300' }
  return (
    <div className="space-y-2 border-t border-zinc-800 px-3 py-2 text-[12.5px]">
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-px text-[10px] font-medium ${badge.cls}`}>{badge.text}</span>
        {review?.feedback && (
          <span className="min-w-0 flex-1 truncate text-zinc-500" title={review.feedback}>
            “{review.feedback}”
          </span>
        )}
        <button
          onClick={() => setShowPlan((v) => !v)}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-sky-400/90 hover:bg-zinc-800"
        >
          {showPlan ? 'hide plan' : 'show plan'}
        </button>
      </div>
      {plan.options && plan.options.length > 0 && (
        <div className="space-y-1">
          {plan.options.map((o, i) => {
            const chosen = review?.selected_option === o.label
            return (
              <div
                key={i}
                className={`rounded border px-2 py-1 ${
                  chosen ? 'border-emerald-800 bg-emerald-950/30' : 'border-zinc-800'
                }`}
              >
                <span className="text-zinc-300">
                  {chosen && <span className="mr-1 text-emerald-400">✓</span>}
                  {o.label}
                </span>
                {o.description && <div className="text-[11px] text-zinc-500">{o.description}</div>}
              </div>
            )
          })}
        </div>
      )}
      {showPlan && (
        <div className="rounded bg-zinc-900 p-2 text-zinc-300">
          <Markdown>{plan.plan}</Markdown>
        </div>
      )}
      {plan.path && (
        <div className="font-mono text-[11px] text-zinc-600">{plan.path}</div>
      )}
    </div>
  )
}

export function ToolCard({
  call,
  live = false,
  subagents = {},
  allCalls = {},
  plan,
}: {
  call: ToolCallRecord
  live?: boolean
  subagents?: Record<string, SubagentRecord>
  allCalls?: Record<string, ToolCallRecord>
  plan?: import('../state/store').PlanRecord
}) {
  const [open, setOpen] = useState(false)
  const [fullImage, setFullImage] = useState<number | null>(null)
  const isBash = call.name === 'Bash' || call.display?.kind === 'command'
  const isEdit = call.name === 'Edit'
  const isWrite = call.name === 'Write'
  const cmd = call.display?.command ?? (isBash ? (call.args as { command?: string })?.command : undefined)
  const output = fmtOutput(call.output) || call.progressText || ''
  const resultImages = extractResultImages(call.output)
  // Source file behind a result image (ReadMediaFile et al. take a `path` arg).
  // args can still be a concatenated string while deltas stream in — guard.
  const imagePath =
    resultImages.length > 0 && typeof call.args === 'object' && call.args !== null
      ? ((call.args as { path?: unknown }).path as string | undefined)
      : undefined
  const imageName =
    typeof imagePath === 'string' && imagePath ? (imagePath.split(/[\\/]/).pop() ?? null) : null
  const resultVideos = extractResultVideos(call.output)

  const dot =
    call.status === 'running'
      ? 'bg-sky-400 animate-pulse'
      : call.status === 'error'
        ? 'bg-red-500'
        : call.status === 'interrupted'
          ? 'bg-amber-500'
          : 'bg-emerald-500'

  let body: ReactNode = null
  if (open) {
    if (plan) {
      body = <PlanBody plan={plan} />
    } else if (isBash) {
      body = (
        <div className="border-t border-zinc-800 bg-black/40 px-3 py-2 font-mono text-[12.5px]">
          {cmd && (
            <div className="text-zinc-300">
              <span className="text-emerald-400">$ </span>
              {cmd}
            </div>
          )}
          {(call.progressText || output) && (
            <pre className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap text-zinc-400">
              {call.progressText && call.progressText !== output
                ? call.progressText + (output ? `\n→ ${output}` : '')
                : output}
            </pre>
          )}
        </div>
      )
    } else {
      body = (
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2 text-[12.5px]">
          {isEdit && <EditDiff args={call.args} />}
          {isWrite && <WritePreview args={call.args} />}
          {!isEdit && !isWrite && call.args != null && (
            <div>
              <div className="mb-0.5 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                Input
              </div>
              <pre className="max-h-56 overflow-y-auto rounded bg-zinc-900 p-2 whitespace-pre-wrap text-zinc-300">
                {fmtArgs(call.args)}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <div className="mb-0.5 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                Output
              </div>
              <pre
                className={`max-h-72 overflow-y-auto rounded p-2 whitespace-pre-wrap ${
                  call.isError ? 'bg-red-950/40 text-red-200' : 'bg-zinc-900 text-zinc-300'
                }`}
              >
                {output}
              </pre>
            </div>
          )}
        </div>
      )
    }
  }

  const linkedSubs = Object.values(subagents).filter((s) => s.parentToolCallId === call.toolCallId)

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-800/40"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="font-mono text-zinc-500">{ICONS[call.name] ?? '⚙'}</span>
        <span className="font-medium text-zinc-300">{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-zinc-500">
          {call.description ?? (cmd ? String(cmd) : '')}
        </span>
        {live && call.status === 'running' && <span className="text-sky-400/80">running</span>}
        {call.status === 'interrupted' && <span className="text-amber-400/80">interrupted</span>}
        <span className="ml-2 shrink-0 text-zinc-600">{open ? '▾' : '▸'}</span>
      </button>
      {linkedSubs.length > 0 && (
        <div className="border-t border-zinc-800/60 px-3 py-2">
          {linkedSubs.map((s) => (
            <SubagentPanel key={s.subagentId} sub={s} allCalls={allCalls} />
          ))}
        </div>
      )}
      {resultImages.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-zinc-800/60 px-3 py-2">
          {resultImages.map((url, i) => (
            <div key={i} className="flex flex-col gap-1">
              {imageName && (
                <button
                  onClick={() => void openExternal(imagePath as string, url)}
                  title={`${imagePath} — open externally`}
                  className="max-w-56 truncate text-left font-mono text-[11px] text-sky-400/90 underline decoration-zinc-600 underline-offset-2 hover:text-sky-300"
                >
                  {imageName}
                </button>
              )}
              <img
                src={url}
                alt={imageName ?? 'tool result'}
                loading="lazy"
                onClick={() => setFullImage((v) => (v === i ? null : i))}
                title={fullImage === i ? 'Click to shrink' : 'Click to expand'}
                className={`cursor-zoom-in rounded-md border border-zinc-700 object-contain ${
                  fullImage === i ? 'w-full' : 'max-h-64'
                }`}
              />
            </div>
          ))}
        </div>
      )}
      {resultVideos.length > 0 && (
        <div className="flex flex-wrap gap-3 border-t border-zinc-800/60 px-3 py-2">
          {resultVideos.map((path, i) => (
            <InlineVideo key={i} path={path} />
          ))}
        </div>
      )}
      {body}
    </div>
  )
}
