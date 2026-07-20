import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627'
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }
const created = await fetch(`${BASE}/api/v1/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'sysprompt probe', metadata: { cwd: 'C:/Users/user/Projects/KimiHarness' } }) }).then((r) => r.json())
const SID = created.data.id
await fetch(`${BASE}/api/v1/sessions/${SID}/profile`, { method: 'POST', headers: H, body: JSON.stringify({ agent_config: { model: 'kimi-code/k3', permission_mode: 'yolo', system_prompt: 'You are a pirate. Always answer in pirate speak (arr, matey, ye). Keep answers short.' } }) })
const res = await fetch(`${BASE}/api/v1/sessions/${SID}/prompts`, { method: 'POST', headers: H, body: JSON.stringify({ content: [{ type: 'text', text: 'Run `echo ahoy` in bash, then tell me what you ran and who you are.' }] }) })
console.log('prompt posted:', (await res.json()).data?.status)
// wait for turn end then read messages
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const s = await fetch(`${BASE}/api/v1/sessions/${SID}/status`, { headers: H }).then((r) => r.json())
  if (!(s.data ?? s).busy) break
}
const msgs = await fetch(`${BASE}/api/v1/sessions/${SID}/messages?page_size=10`, { headers: H }).then((r) => r.json())
for (const m of (msgs.data ?? msgs).items ?? []) {
  if (m.role === 'assistant') {
    for (const b of m.content ?? []) {
      if (b.type === 'text') console.log('ASSISTANT:', b.text.slice(0, 400))
      if (b.type === 'tool_use') console.log('TOOL CALL:', b.tool_name, JSON.stringify(b.input).slice(0, 80))
    }
  }
}
await fetch(`${BASE}/api/v1/sessions/${SID}:archive`, { method: 'POST', headers: H, body: '{}' })
process.exit(0)
