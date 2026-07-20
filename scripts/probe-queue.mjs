import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'queue probe', metadata: { cwd: 'C:/Users/user/Projects/KimiHarness' } }) }).then((r) => r.json())
const SID = (created.data ?? created).id
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }) })
const p1 = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Run `sleep 45` in bash, then say done.' }] }) }).then((r) => r.json())
console.log('p1:', JSON.stringify(p1.data ?? p1).slice(0, 150))
await new Promise((r) => setTimeout(r, 1500))
const p2 = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'When done, also say hello.' }] }) }).then((r) => r.json())
console.log('p2:', JSON.stringify(p2.data ?? p2).slice(0, 150))
const q = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { headers: H }).then((r) => r.json())
console.log('queue:', JSON.stringify(q.data ?? q, null, 1).slice(0, 900))
// try aborting the queued prompt
const qid = (q.data ?? q).queued?.[0]?.prompt_id ?? (q.data ?? q).queued?.[0]?.id
if (qid) {
  const ab = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts/${qid}:abort`, { method: 'POST', headers: H, body: '{}' })
  console.log('abort queued:', ab.status, (await ab.text()).slice(0, 200))
}
const q2 = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { headers: H }).then((r) => r.json())
console.log('queue after:', JSON.stringify(q2.data ?? q2).slice(0, 300))
await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H, body: '{}' })
process.exit(0)
