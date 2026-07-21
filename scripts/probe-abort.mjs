import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'abort probe', metadata: { cwd: process.cwd() } }) }).then((r) => r.json())
const SID = created.data.id
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }) })
const snap = await fetch(`${BASE}/api/v1/sessions/${SID}/snapshot`, { headers: H }).then((r) => r.json()).then((j) => j.data ?? j)
const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_abort`, ['kimi-code.bearer.' + TOKEN])
const t0 = Date.now()
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's'
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_abort', subscriptions: [] } })))
ws.on('message', (m) => {
  let f; try { f = JSON.parse(String(m)) } catch { return }
  const t = f.payload?.type ?? f.type
  if (/turn\.|interrupt|prompt|tool\.(call\.started|result)/.test(t)) console.log(stamp(), t, JSON.stringify(f.payload).slice(0, 130))
  if (f.type === 'ack' && f.id === 'h1') ws.send(JSON.stringify({ type: 'subscribe', id: 's1', payload: { session_ids: [SID], cursors: { [SID]: { seq: snap.as_of_seq, epoch: snap.epoch } } } }))
  if (f.type === 'ack' && f.id === 's1') run()
})
async function run() {
  const p1 = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Run `sleep 120` in bash, then report done.' }] }) }).then((r) => r.json())
  const activeId = (p1.data ?? p1).prompt_id
  console.log(stamp(), '>>> turn started')
  await new Promise((r) => setTimeout(r, 6000))
  await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'INTERRUPT-TEST: say hi right now instead.' }] }) })
  console.log(stamp(), '>>> queued interrupt msg; aborting active prompt', activeId)
  const ab = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts/${activeId}:abort`, { method: 'POST', headers: H, body: '{}' })
  console.log(stamp(), '>>> abort call:', ab.status, (await ab.text()).slice(0, 120))
}
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1) })
setTimeout(async () => { await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H, body: '{}' }); console.log('done'); process.exit(0) }, 45000)
