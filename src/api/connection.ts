import { invoke } from '@tauri-apps/api/core'

export interface ConnectionInfo {
  baseUrl: string
  wsUrl: string
  token: string
  port: number
  spawned: boolean
}

let cached: ConnectionInfo | null = null

/** Ask the Rust side to ensure a kimi server is running and hand us its token.
 *  In plain-browser dev (vite without Tauri) IPC is absent — fall back to the
 *  token file written by `npm run dev:token` (gitignored, localhost only). */
export async function getConnectionInfo(force = false): Promise<ConnectionInfo> {
  if (cached && !force) return cached
  try {
    cached = await invoke<ConnectionInfo>('get_connection_info')
  } catch (e) {
    const res = await fetch('/dev-token.json').catch(() => null)
    if (!res?.ok) throw e
    cached = (await res.json()) as ConnectionInfo
  }
  return cached
}
