// Writes public/dev-token.json so the frontend can run in a plain browser
// (Playwright, drive-by DOM checks) without Tauri IPC. Dev-only; the file is
// gitignored and served by vite on localhost only. Requires the daemon to be
// running (the app auto-starts it, or `kimi server run`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const token = readFileSync(join(homedir(), '.kimi-code', 'server.token'), 'utf8').trim()

// Port comes from the daemon's lock file when present, defaulting to 58627.
let port = 58627
try {
  const lock = JSON.parse(readFileSync(join(homedir(), '.kimi-code', 'server', 'lock'), 'utf8'))
  if (typeof lock.port === 'number') port = lock.port
} catch {
  // no lock file — use default
}

mkdirSync('public', { recursive: true })
writeFileSync(
  join('public', 'dev-token.json'),
  JSON.stringify({
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/v1/ws`,
    token,
    port,
    spawned: false,
  }),
)
console.log(`wrote public/dev-token.json (port ${port}) — gitignored, do not commit`)
