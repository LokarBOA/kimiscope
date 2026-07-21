import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'hands drag test', metadata: { cwd: process.cwd() } }) }).then((r) => r.json())
const SID = (created.data ?? created).id
console.log('session:', SID)
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }) })
const snap = await fetch(`${BASE}/api/v1/sessions/${SID}/snapshot`, { headers: H }).then((r) => r.json()).then((j) => j.data ?? j)
const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_drag`, ['kimi-code.bearer.' + TOKEN])
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_drag', subscriptions: [] } })))
ws.on('message', (m) => {
  let f; try { f = JSON.parse(String(m)) } catch { return }
  const t = f.payload?.type ?? f.type
  if (t === 'tool.call.started') console.log('CALL:', f.payload.name, JSON.stringify(f.payload.args ?? '').slice(0, 160))
  if (t === 'tool.result') console.log('  -> err=' + !!f.payload.isError, JSON.stringify(f.payload.output ?? '').slice(0, 160))
  if (t === 'turn.ended') console.log('TURN ENDED:', f.payload.reason)
  if (f.type === 'ack' && f.id === 'h1') ws.send(JSON.stringify({ type: 'subscribe', id: 's1', payload: { session_ids: [SID], cursors: { [SID]: { seq: snap.as_of_seq, epoch: snap.epoch } } } }))
  if (f.type === 'ack' && f.id === 's1') fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Use your windows MCP tools to grab the open "KimiHarness" window and move it about 250 pixels to the right and 150 pixels down from where it is. Suggested approach: Snapshot to find the window, then use the App tool to focus it, then drag its title bar (mouse down, move, mouse up) — or use the Windows move-window keyboard shortcut (Alt+Space, then M, then arrow keys, then Enter). Verify with a final Snapshot and report the before/after window position.' }] }) })
})
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1) })
setTimeout(() => { console.log('done'); process.exit(0) }, 240000)
