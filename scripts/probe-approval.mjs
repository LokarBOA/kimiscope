// Dev probe: manual-mode session -> prompt needing approval -> dump approval
// shape -> approve via REST -> confirm turn completes.
import { readFileSync } from 'node:fs'

const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const J = (r) => r.json()

const created = await fetch(`${BASE}/api/v1/sessions`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ title: 'approval shape probe', metadata: { cwd: 'C:\\Users\\user\\Projects\\KimiHarness' } }),
}).then(J)
const SID = (created.data ?? created).id
console.log('session:', SID)

await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'manual' } }),
}).then(J)

await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ content: [{ type: 'text', text: 'Use the Bash tool to run exactly: echo approval-shape-test' }] }),
}).then(J)

const deadline = Date.now() + 90_000
let item = null
while (Date.now() < deadline) {
  const res = await fetch(`${BASE}/api/v1/sessions/${SID}/approvals`, { headers: H }).then(J)
  const items = (res.data ?? res).items ?? []
  if (items.length) { item = items[0]; break }
  await new Promise((r) => setTimeout(r, 1500))
}
if (!item) { console.log('NO APPROVAL APPEARED (model may not have called the tool)'); process.exit(1) }
console.log('approval item:', JSON.stringify(item, null, 1))

const dec = await fetch(`${BASE}/api/v1/sessions/${SID}/approvals/${item.approval_id}`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ decision: 'approved' }),
}).then(J)
console.log('decision response:', JSON.stringify(dec).slice(0, 300))

// wait for turn end
for (let i = 0; i < 40; i++) {
  const s = await fetch(`${BASE}/api/v1/sessions/${SID}`, { headers: H }).then(J)
  const d = s.data ?? s
  if (!d.busy) { console.log('turn finished, reason:', d.last_turn_reason); break }
  await new Promise((r) => setTimeout(r, 1500))
}
const msgs = await fetch(`${BASE}/api/v1/sessions/${SID}/messages?limit=10`, { headers: H }).then(J)
const items = (msgs.data ?? msgs).items ?? []
console.log('messages:', items.length)
for (const m of items.slice(0, 4)) console.log(' -', m.role, JSON.stringify(m.content).slice(0, 150))
process.exit(0)
