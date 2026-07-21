import WebSocket from 'ws'
import { readFileSync, writeFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const dump = []
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Harness screen probe', metadata: { cwd: process.cwd() } }) }).then((r) => r.json())
const SID = (created.data ?? created).id
console.log('session:', SID)
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }) })
const snap = await fetch(`${BASE}/api/v1/sessions/${SID}/snapshot`, { headers: H }).then((r) => r.json()).then((j) => j.data ?? j)
const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_screen`, ['kimi-code.bearer.' + TOKEN])
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_screen', subscriptions: [] } })))
ws.on('message', (m) => {
  let f; try { f = JSON.parse(String(m)) } catch { return }
  dump.push(f)
  const t = f.payload?.type ?? f.type
  if (t === 'tool.call.started') console.log('CALL:', f.payload.name, JSON.stringify(f.payload.args ?? '').slice(0, 120))
  if (t === 'tool.result') console.log('RESULT err=' + !!f.payload.isError, JSON.stringify(f.payload.output ?? '').slice(0, 250))
  if (t === 'assistant.delta') process.stdout.write(f.payload.delta)
  if (f.type === 'ack' && f.id === 'h1') ws.send(JSON.stringify({ type: 'subscribe', id: 's1', payload: { session_ids: [SID], cursors: { [SID]: { seq: snap.as_of_seq, epoch: snap.epoch } } } }))
  if (f.type === 'ack' && f.id === 's1') fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Use the windows-screen MCP Screenshot tool to capture my screen, then briefly describe what you see (which apps/windows are visible).' }] }) })
})
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1) })
setTimeout(() => { writeFileSync('reference/probe-screen-frames.json', JSON.stringify(dump, null, 1)); console.log('\ndone'); process.exit(0) }, 120000)
