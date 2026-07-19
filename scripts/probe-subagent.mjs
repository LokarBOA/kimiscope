// Dev probe: capture subagent lifecycle frames (Agent tool spawn -> completion).
import WebSocket from 'ws'
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = process.argv[3] ?? readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const SECONDS = Number(process.argv[2] ?? 240)
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const dump = []
const log = (...a) => console.log(...a)

const created = await fetch(`${BASE}/api/v1/sessions`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ title: 'Harness subagent probe', metadata: { cwd: 'C:\\Users\\user\\Projects\\KimiHarness' } }),
}).then((r) => r.json())
const SID = (created.data ?? created).id
log('session:', SID)
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }),
})
const snap = await fetch(`${BASE}/api/v1/sessions/${SID}/snapshot`, { headers: H }).then((r) => r.json()).then((j) => j.data ?? j)

const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_sub`, ['kimi-code.bearer.' + TOKEN])
const seen = new Map()
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_sub', subscriptions: [] } })))
ws.on('message', (m) => {
  let f
  try { f = JSON.parse(String(m)) } catch { return }
  dump.push(f)
  const t = f.payload?.type ?? f.type
  const agentId = f.payload?.agentId ?? ''
  const key = agentId && agentId !== 'main' ? `${t} [${agentId.slice(0, 12)}]` : t
  if (!seen.has(key)) {
    seen.set(key, true)
    log('--- NEW:', key)
    log(JSON.stringify(f.payload, null, 1).slice(0, 700))
  }
  if (f.type === 'ack' && f.id === 'h1') {
    ws.send(JSON.stringify({ type: 'subscribe', id: 's1', payload: { session_ids: [SID], cursors: { [SID]: { seq: snap.as_of_seq, epoch: snap.epoch } } } }))
  }
  if (f.type === 'ack' && f.id === 's1') {
    fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ content: [{ type: 'text', text: 'Use the Agent tool to launch an explore subagent with prompt "List the files in the src/ directory of this project and report back the count". Wait for its result, then reply with the count.' }] }),
    })
  }
})
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1) })
setTimeout(() => {
  writeFileSync('reference/probe-subagent-frames.json', JSON.stringify(dump, null, 1))
  log(`\n=== done: ${dump.length} frames -> reference/probe-subagent-frames.json ===`)
  for (const k of seen.keys()) log(' -', k)
  process.exit(0)
}, SECONDS * 1000)
