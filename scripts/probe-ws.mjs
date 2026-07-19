// Dev probe: subscribe to a session's WS stream and dump frame shapes.
// Usage: node scripts/probe-ws.mjs [sessionId] [seconds]
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

const TOKEN = process.argv[4] ?? readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const SESSION = process.argv[2] ?? 'session_9e6611ce-cc5f-4620-8a59-ea8faa851615'
const SECONDS = Number(process.argv[3] ?? 20)

const url = `ws://127.0.0.1:58627/api/v1/ws?client_id=probe_${Date.now()}`
const ws = new WebSocket(url, ['kimi-code.bearer.' + TOKEN])

const seen = new Map()
function note(frame) {
  const t = frame.type
  const payloadType = frame.payload?.type
  const key = payloadType ? `${t} -> ${payloadType}` : t
  if (!seen.has(key)) {
    seen.set(key, true)
    console.log('--- NEW:', key)
    console.log(JSON.stringify(frame, null, 1).slice(0, 900))
  }
}

ws.on('open', () => {
  console.log('OPEN')
  ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe', subscriptions: [SESSION] } }))
})
ws.on('message', (m) => {
  let f
  try { f = JSON.parse(String(m)) } catch { return }
  note(f)
})
ws.on('error', (e) => { console.error('ERROR', e.message); process.exit(1) })
ws.on('unexpected-response', (q, r) => { console.error('HTTP', r.statusCode); process.exit(1) })

setTimeout(() => {
  console.log('\n=== frame kinds seen ===')
  for (const k of seen.keys()) console.log(' -', k)
  ws.close()
  process.exit(0)
}, SECONDS * 1000)
