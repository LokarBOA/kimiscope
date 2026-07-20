import WebSocket from 'ws'
import { readFileSync, writeFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const dump = []
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'question probe', metadata: { cwd: 'C:/Users/user/Projects/KimiHarness' } }) }).then((r) => r.json())
const SID = (created.data ?? created).id
console.log('session:', SID)
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }) })
const snap = await fetch(`${BASE}/api/v1/sessions/${SID}/snapshot`, { headers: H }).then((r) => r.json()).then((j) => j.data ?? j)
const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_q`, ['kimi-code.bearer.' + TOKEN])
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_q', subscriptions: [] } })))
ws.on('message', (m) => {
  let f; try { f = JSON.parse(String(m)) } catch { return }
  dump.push(f)
  const t = f.payload?.type ?? f.type
  if (/question/i.test(t)) console.log('---', t, JSON.stringify(f.payload, null, 1).slice(0, 1200))
  if (f.type === 'ack' && f.id === 'h1') ws.send(JSON.stringify({ type: 'subscribe', id: 's1', payload: { session_ids: [SID], cursors: { [SID]: { seq: snap.as_of_seq, epoch: snap.epoch } } } }))
  if (f.type === 'ack' && f.id === 's1') fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Use the AskUserQuestion tool to ask me THREE questions at once (any trivial topic, e.g. favorite color, editor, theme). Then end your turn without waiting.' }] }) })
})
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1) })
setTimeout(async () => {
  writeFileSync('reference/probe-question-frames.json', JSON.stringify(dump, null, 1))
  const q = await fetch(`${BASE}/api/v1/sessions/${SID}/questions?status=pending`, { headers: H }).then((r) => r.json())
  console.log('REST pending questions:', JSON.stringify(q.data ?? q, null, 1).slice(0, 1500))
  await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H, body: '{}' })
  console.log('done'); process.exit(0)
}, 90000)
