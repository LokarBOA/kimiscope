import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'term probe init', metadata: { cwd: process.cwd() } }) }).then((r) => r.json())
const SID = created.data.id
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }) })
console.log('session:', SID)
await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Reply with exactly: ok' }] }) })
// wait for the turn to complete (agent initialized)
for (let i = 0; i < 30; i++) {
  const s = await fetch(`${BASE}/api/v1/sessions/${SID}/status`, { headers: H }).then((r) => r.json())
  if (!(s.data ?? s).busy) break
  await sleep(2000)
}
console.log('turn done; creating terminal')
const term = await fetch(`${BASE}/api/v1/sessions/${SID}/terminals`, { method: 'POST', headers: H, body: JSON.stringify({ cols: 100, rows: 30 }) }).then((r) => r.json())
const TID = (term.data ?? term).id
console.log('terminal:', TID)

const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_term2`, ['kimi-code.bearer.' + TOKEN])
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_term2', subscriptions: [] } })))
ws.on('message', (m) => {
  console.log('RAW:', String(m).slice(0, 220))
})
ws.on('error', (e) => console.log('ERR', e.message))
await sleep(600)
ws.send(JSON.stringify({ type: 'subscribe', id: 's1', payload: { session_ids: [SID] } }))
await sleep(600)
ws.send(JSON.stringify({ type: 'terminal_attach', id: 'a1', payload: { session_id: SID, terminal_id: TID, since_seq: 0 } }))
await sleep(1200)
ws.send(JSON.stringify({ type: 'terminal_input', id: 'i1', payload: { session_id: SID, terminal_id: TID, data: 'echo term-alive\r' } }))
await sleep(4000)
await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H, body: '{}' })
console.log('done')
process.exit(0)
