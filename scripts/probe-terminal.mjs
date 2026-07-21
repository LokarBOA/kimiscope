import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }

const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'terminal probe', metadata: { cwd: process.cwd() } }) }).then((r) => r.json())
const SID = (created.data ?? created).id
const term = await fetch(`${BASE}/api/v1/sessions/${SID}/terminals`, { method: 'POST', headers: H, body: JSON.stringify({ cols: 100, rows: 30 }) }).then((r) => r.json())
const TID = (term.data ?? term).id
console.log('terminal:', TID)

const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_term`, ['kimi-code.bearer.' + TOKEN])
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_term', subscriptions: [] } })))
ws.on('message', (m) => {
  let f; try { f = JSON.parse(String(m)) } catch { return }
  const t = f.payload?.type ?? f.type
  if (f.type === 'ack') console.log('ack', f.id, JSON.stringify(f.payload).slice(0, 250))
  else if (t !== 'server_hello') console.log('FRAME:', t, JSON.stringify(f).slice(0, 250))
  if (f.type === 'ack' && f.id === 'h1') {
    ws.send(JSON.stringify({ type: 'subscribe', id: 'sub1', payload: { session_ids: [SID] } }))
  }
  if (f.type === 'ack' && f.id === 'sub1') {
    ws.send(JSON.stringify({ type: 'terminal_attach', id: 'a1', payload: { session_id: SID, terminal_id: TID } }))
  }
  if (f.type === 'ack' && f.id === 'a1') {
    ws.send(JSON.stringify({ type: 'terminal_input', id: 'i1', payload: { session_id: SID, terminal_id: TID, data: 'echo terminal-works\r' } }))
  }
})
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1) })
setTimeout(async () => {
  await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H, body: '{}' })
  console.log('done'); process.exit(0)
}, 20000)
