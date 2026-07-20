import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'steer probe', metadata: { cwd: 'C:/Users/user/Projects/KimiHarness' } }) }).then((r) => r.json())
const SID = created.data.id
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }) })
const snap = await fetch(`${BASE}/api/v1/sessions/${SID}/snapshot`, { headers: H }).then((r) => r.json()).then((j) => j.data ?? j)
const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_steer`, ['kimi-code.bearer.' + TOKEN])
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_steer', subscriptions: [] } })))
ws.on('message', (m) => {
  let f; try { f = JSON.parse(String(m)) } catch { return }
  const t = f.payload?.type ?? f.type
  if (/turn\.|interrupt|steer|prompt/.test(t)) console.log(new Date().toISOString().slice(11, 19), t, JSON.stringify(f.payload).slice(0, 150))
  if (f.type === 'ack' && f.id === 'h1') ws.send(JSON.stringify({ type: 'subscribe', id: 's1', payload: { session_ids: [SID], cursors: { [SID]: { seq: snap.as_of_seq, epoch: snap.epoch } } } }))
  if (f.type === 'ack' && f.id === 's1') run()
})
async function run() {
  const p1 = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Count slowly from 1 to 20, one number per line, thinking between each.' }] }) }).then((r) => r.json())
  console.log('p1:', (p1.data ?? p1).status)
  await new Promise((r) => setTimeout(r, 4000))
  const p2 = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'STEER: stop counting and just say hi.' }] }) }).then((r) => r.json())
  console.log('p2:', (p2.data ?? p2).status, (p2.data ?? p2).prompt_id)
  const st = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts:steer`, { method: 'POST', headers: H, body: JSON.stringify({ prompt_ids: [(p2.data ?? p2).prompt_id] }) })
  console.log('steer response:', st.status, (await st.text()).slice(0, 200))
}
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1) })
setTimeout(async () => { await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H, body: '{}' }); console.log('done'); process.exit(0) }, 60000)
