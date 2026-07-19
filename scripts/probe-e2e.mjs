// Dev probe: full harness loop — create session via REST, subscribe via WS,
// send a prompt that triggers thinking + a Bash tool call, dump all frames.
// Usage: node scripts/probe-e2e.mjs [seconds]
import WebSocket from 'ws'
import { readFileSync, writeFileSync } from 'node:fs'

const TOKEN = process.argv[3] ?? readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const SECONDS = Number(process.argv[2] ?? 120)
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const dump = []
const log = (...a) => console.log(...a)

// 1. create session
const created = await fetch(`${BASE}/api/v1/sessions`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    title: 'Harness WS probe',
    metadata: { cwd: 'C:\\Users\\user\\Projects\\KimiHarness' },
    agent_config: { permission_mode: 'yolo', model: 'kimi-code/k3' },
  }),
}).then((r) => r.json())
const session = created.data ?? created
const SID = session.id ?? session.session_id
log('created session:', SID)

// 1b. set profile (model + permission mode) — creation-time agent_config is ignored
const prof = await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }),
}).then((r) => r.json())
log('profile set:', JSON.stringify(prof.data?.agent_config ?? prof))

// 2. snapshot for cursor
const snapRaw = await fetch(`${BASE}/api/v1/sessions/${SID}/snapshot`, { headers: H }).then((r) => r.json())
const snap = snapRaw.data ?? snapRaw
log('snapshot cursor: seq=%s epoch=%s', snap.as_of_seq, snap.epoch)

// 3. WS subscribe
const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_e2e`, ['kimi-code.bearer.' + TOKEN])
const seen = new Map()
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_e2e', subscriptions: [] } })))
ws.on('message', (m) => {
  let f
  try { f = JSON.parse(String(m)) } catch { return }
  dump.push(f)
  const key = f.payload?.type ? `${f.type}->${f.payload.type}` : (f.id ? `${f.type}(${f.id})` : f.type)
  if (!seen.has(key)) {
    seen.set(key, true)
    log('--- NEW:', key)
    log(JSON.stringify(f, null, 1).slice(0, 800))
  }
  if (f.type === 'ack' && f.id === 'h1') {
    ws.send(JSON.stringify({
      type: 'subscribe', id: 's1',
      payload: { session_ids: [SID], cursors: { [SID]: { seq: snap.as_of_seq, epoch: snap.epoch } } },
    }))
  }
  if (f.type === 'ack' && f.id === 's1') {
    log('subscribe ack:', JSON.stringify(f.payload))
    // 4. send prompt
    fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ content: [{ type: 'text', text: 'Use the Agent tool to launch one explore subagent that lists the files in the current directory, then report what it found.' }] }),
    }).then((r) => r.json()).then((j) => log('prompt posted:', JSON.stringify(j).slice(0, 200)))
  }
})
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1) })
ws.on('unexpected-response', (q, r) => { console.error('WS HTTP', r.statusCode); process.exit(1) })

setTimeout(() => {
  writeFileSync('reference/probe-frames.json', JSON.stringify(dump, null, 1))
  log(`\n=== done: ${dump.length} frames saved to reference/probe-frames.json; kinds ===`)
  for (const k of seen.keys()) log(' -', k)
  process.exit(0)
}, SECONDS * 1000)
