// Writes public/dev-token.json so the frontend can run in a plain browser
// (Playwright, drive-by DOM checks) without Tauri IPC. Dev-only; the file is
// gitignored and served by vite on localhost only. Requires the daemon to be
// running (the app auto-starts it, or `kimi web`).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

const home = join(homedir(), '.kimi-code')
const token = readFileSync(join(home, 'server.token'), 'utf8').trim()

function tcpAlive(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 400 })
    s.once('connect', () => { s.end(); resolve(true) })
    s.once('error', () => resolve(false))
    s.once('timeout', () => { s.destroy(); resolve(false) })
  })
}

// Port discovery: 0.28 instance files (newest first; stale files survive hard
// kills, so probe), then the 0.27 lock, then the default.
async function discoverPort() {
  const candidates = []
  try {
    for (const f of readdirSync(join(home, 'server', 'instances'))) {
      try {
        const v = JSON.parse(readFileSync(join(home, 'server', 'instances', f), 'utf8'))
        if (typeof v.port === 'number') candidates.push([v.started_at ?? 0, v.port])
      } catch { /* unreadable instance file — skip */ }
    }
  } catch { /* no instances dir (0.27) */ }
  candidates.sort((a, b) => b[0] - a[0])
  try {
    const lock = JSON.parse(readFileSync(join(home, 'server', 'lock'), 'utf8'))
    if (typeof lock.port === 'number') candidates.push([0, lock.port])
  } catch { /* no lock file */ }
  candidates.push([0, 58627])
  for (const [, port] of candidates) {
    if (await tcpAlive(port)) return port
  }
  return 58627
}

const port = await discoverPort()

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
