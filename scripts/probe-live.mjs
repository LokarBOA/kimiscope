// Dev probe: snapshot -> subscribe with cursor -> dump live frames.
// Usage: node scripts/probe-live.mjs [sessionId] [seconds]
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

const TOKEN = process.argv[4] ?? readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const SESSION = process.argv[2] ?? 'session_9e6611ce-cc5f-4620-8a59-ea8faa851615'
const SECONDS = Number(process.argv[3] ?? 30)
const BASE = 'http://127.0.0.1:58627'

const snap = await fetch(`${BASE}/api/v1/sessions/${SESSION}/snapshot`, {
  headers: { Authorization: 'Bearer ' + TOKEN },
}).then((r) => r.json())
const d = snap.data ?? snap
console.log('snapshot: epoch=%s as_of_seq=%s busy=%s in_flight=%s msgs=%s',
  d.epoch, d.as_of_seq, d.session?.busy, !!d.in_flight_turn, d.messages?.items?.length)

const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_live`, ['kimi-code.bearer.' + TOKEN])
const seen = new Map()
let count = 0
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_live', subscriptions: [] } }))
})
ws.on('message', (m) => {
  let f
  try { f = JSON.parse(String(m)) } catch { return }
  count++
  if (f.type === 'ack' && f.id === 'h1') {
    console.log('hello ack; subscribing with cursor seq=%s epoch=%s', d.as_of_seq, d.epoch)
    ws.send(JSON.stringify({
      type: 'subscribe', id: 's1',
      payload: { session_ids: [SESSION], cursors: { [SESSION]: { seq: d.as_of_seq, epoch: d.epoch } } },
    }))
    return
  }
  const key = f.payload?.type ? `${f.type}->${f.payload.type}` : f.type
  if (!seen.has(key)) {
    seen.set(key, true)
    console.log('--- NEW:', key)
    console.log(JSON.stringify(f, null, 1).slice(0, 700))
  }
})
ws.on('error', (e) => { console.error('ERROR', e.message); process.exit(1) })
ws.on('unexpected-response', (q, r) => { console.error('HTTP', r.statusCode); process.exit(1) })
setTimeout(() => {
  console.log(`\n=== ${count} frames; kinds ===`)
  for (const k of seen.keys()) console.log(' -', k)
  process.exit(0)
}, SECONDS * 1000)
