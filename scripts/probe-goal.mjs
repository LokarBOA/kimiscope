import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'goal probe', metadata: { cwd: 'C:/Users/user/Projects/KimiHarness' } }) }).then((r) => r.json())
const SID = (created.data ?? created).id
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo', goal_objective: 'Probe goal: reply with the word ok and stop.' } }) })
const g = await fetch(`${BASE}/api/v1/sessions/${SID}/goal`, { headers: H }).then((r) => r.json())
console.log('goal after set:', JSON.stringify(g.data ?? g, null, 1).slice(0, 700))
await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H, body: '{}' })
process.exit(0)
