import { memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createHighlighter, type Highlighter } from 'shiki'

let highlighterPromise: Promise<Highlighter> | null = null
const LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'bash',
  'shell',
  'powershell',
  'python',
  'rust',
  'toml',
  'yaml',
  'markdown',
  'diff',
  'css',
  'html',
  'sql',
  'text',
]

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark-default'],
      langs: LANGS,
    })
  }
  return highlighterPromise
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const l = LANGS.includes(lang) ? lang : 'text'
    getHighlighter()
      .then((h) => {
        if (!alive) return
        setHtml(h.codeToHtml(code, { lang: l, theme: 'github-dark-default' }))
      })
      .catch(() => alive && setHtml(null))
    return () => {
      alive = false
    }
  }, [lang, code])

  if (html) {
    return (
      <div
        className="codeblock overflow-x-auto rounded-md text-[13px] leading-relaxed [&>pre]:p-3"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  return (
    <pre className="overflow-x-auto rounded-md bg-zinc-900 p-3 text-[13px] text-zinc-200">
      <code>{code}</code>
    </pre>
  )
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children: c } = props as {
              className?: string
              children?: ReactNode
            }
            const text = String(c ?? '').replace(/\n$/, '')
            const match = /language-(\S+)/.exec(className ?? '')
            const isBlock = text.includes('\n') || Boolean(match)
            if (!isBlock) {
              return (
                <code className="rounded bg-zinc-800 px-1 py-0.5 text-[0.85em] text-amber-200/90">
                  {text}
                </code>
              )
            }
            return <CodeBlock lang={match?.[1] ?? 'text'} code={text} />
          },
          pre(props) {
            // code renderer already produced the block; unwrap the <pre>
            return <>{props.children}</>
          },
          a(props) {
            return (
              <a
                {...props}
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 underline decoration-sky-400/40 hover:decoration-sky-400"
              />
            )
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})
