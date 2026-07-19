import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const SID = process.argv[2]
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
for (let i = 0; i < 40; i++) {
  const r = await fetch(`${BASE}/api/v1/sessions/${SID}/approvals`, { headers: H }).then((x) => x.json())
  const items = (r.data ?? r).items ?? []
  if (items.length) { console.log(JSON.stringify(items[0], null, 1)); process.exit(0) }
  const s = await fetch(`${BASE}/api/v1/sessions/${SID}`, { headers: H }).then((x) => x.json())
  const d = s.data ?? s
  if (!d.busy) { console.log('turn ended without approval; reason:', d.last_turn_reason); process.exit(1) }
  await new Promise((r2) => setTimeout(r2, 2000))
}
console.log('timeout')
process.exit(1)
