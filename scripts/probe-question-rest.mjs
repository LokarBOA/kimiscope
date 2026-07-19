import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'q rest probe', metadata: { cwd: 'C:/Users/user/Projects/KimiHarness' } }) }).then((r) => r.json())
const SID = created.data.id
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo' } }) })
await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Use the AskUserQuestion tool to ask me exactly two questions at once (favorite color; favorite animal). Wait for the answer.' }] }) })
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const q = await fetch(`${BASE}/api/v1/sessions/${SID}/questions?status=pending`, { headers: H }).then((r) => r.json())
  const items = (q.data ?? q).items ?? []
  if (items.length) {
    console.log('PENDING SHAPE:', JSON.stringify(items[0], null, 1).slice(0, 1500))
    break
  }
  if (i === 29) console.log('NO QUESTION APPEARED. last resp:', JSON.stringify(q).slice(0, 300))
}
await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H })
process.exit(0)
