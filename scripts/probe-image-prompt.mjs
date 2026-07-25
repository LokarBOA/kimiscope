// Probe: does the daemon accept an inline base64 image prompt? (img probe, throwaway)
import { readFileSync } from 'node:fs'
const TOKEN = readFileSync(process.env.USERPROFILE + '/.kimi-code/server.token', 'utf8').trim()
const BASE = 'http://127.0.0.1:58627/api/v1'
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
const SID = process.argv[2]

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const res = await fetch(`${BASE}/sessions/${SID}/prompts`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    content: [
      { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: PNG_1PX } },
      { type: 'text', text: 'img probe — reply with exactly: ok' },
    ],
  }),
})
const body = await res.json().catch(() => null)
console.log('status', res.status, JSON.stringify(body).slice(0, 300))
