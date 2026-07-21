// Dev probe: does a daemon session get MCP tools? Ask it to drive a browser.
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
  body: JSON.stringify({ title: 'Harness MCP probe', metadata: { cwd: process.cwd() } }),
}).then((r) => r.json())
const SID = (created.data ?? created).id
log('session:', SID)
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }),
})
const snap = await fetch(`${BASE}/api/v1/sessions/${SID}/snapshot`, { headers: H }).then((r) => r.json()).then((j) => j.data ?? j)

const ws = new WebSocket(`ws://127.0.0.1:58627/api/v1/ws?client_id=probe_mcp`, ['kimi-code.bearer.' + TOKEN])
const seen = new Map()
ws.on('open', () => ws.send(JSON.stringify({ type: 'client_hello', id: 'h1', payload: { client_id: 'probe_mcp', subscriptions: [] } })))
ws.on('message', (m) => {
  let f
  try { f = JSON.parse(String(m)) } catch { return }
  dump.push(f)
  const t = f.payload?.type ?? f.type
  if (t === 'tool.call.started' || t === 'tool.result' || t === 'turn.ended' || t === 'error') {
    const key = t + ':' + (f.payload?.name ?? f.payload?.code ?? '')
    if (!seen.has(key)) {
      seen.set(key, true)
      log('--- NEW:', key)
      log(JSON.stringify(f.payload, null, 1).slice(0, 600))
    }
  }
  if (f.type === 'ack' && f.id === 'h1') {
    ws.send(JSON.stringify({ type: 'subscribe', id: 's1', payload: { session_ids: [SID], cursors: { [SID]: { seq: snap.as_of_seq, epoch: snap.epoch } } } }))
  }
  if (f.type === 'ack' && f.id === 's1') {
    fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ content: [{ type: 'text', text: 'Use the playwright MCP tool browser_navigate to open https://example.com, then use browser_snapshot and report the page heading text. If you have no playwright tools, say NO_PLAYWRIGHT.' }] }),
    })
  }
})
ws.on('error', (e) => { console.error('WS ERROR', e.message); process.exit(1) })
setTimeout(() => {
  writeFileSync('reference/probe-mcp-frames.json', JSON.stringify(dump, null, 1))
  log(`\n=== done: ${dump.length} frames -> reference/probe-mcp-frames.json ===`)
  for (const k of seen.keys()) log(' -', k)
  process.exit(0)
}, SECONDS * 1000)
