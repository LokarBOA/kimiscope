import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'queue vis probe', metadata: { cwd: process.cwd() } }) }).then((r) => r.json())
const SID = created.data.id
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }) })
await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Run `sleep 40` in bash, then say done.' }] }) })
await new Promise((r) => setTimeout(r, 2000))
const p2 = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'QUEUED-MARKER: say hello after.' }] }) }).then((r) => r.json())
console.log('p2 status:', (p2.data ?? p2).status)
await new Promise((r) => setTimeout(r, 1500))
const msgs = await fetch(`${BASE}/api/v1/sessions/${SID}/messages?page_size=10`, { headers: H }).then((r) => r.json())
console.log('--- messages in history:')
for (const m of (msgs.data ?? msgs).items ?? []) {
  const txt = (m.content ?? []).map((b) => b.text ?? b.type).join(' ').slice(0, 60)
  console.log(' ', m.role, '|', txt, '| status:', m.status ?? '-')
}
const q = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { headers: H }).then((r) => r.json())
console.log('--- /prompts queued count:', ((q.data ?? q).queued ?? []).length)
await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H, body: '{}' })
process.exit(0)
