import { useState, type ReactNode } from 'react'
import DiffViewer from 'react-diff-viewer-continued'
import type { SubagentRecord, ToolCallRecord } from '../api/events'
import { openExternal } from '../api/openPath'

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

export function ToolCard({
  call,
  live = false,
  subagents = {},
  allCalls = {},
}: {
  call: ToolCallRecord
  live?: boolean
  subagents?: Record<string, SubagentRecord>
  allCalls?: Record<string, ToolCallRecord>
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
    if (isBash) {
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
      {body}
    </div>
  )
}
