import { invoke } from '@tauri-apps/api/core'

export interface ConnectionInfo {
  baseUrl: string
  wsUrl: string
  token: string
  port: number
  spawned: boolean
}

let cached: ConnectionInfo | null = null

/** Ask the Rust side to ensure a kimi server is running and hand us its token. */
export async function getConnectionInfo(force = false): Promise<ConnectionInfo> {
  if (cached && !force) return cached
  cached = await invoke<ConnectionInfo>('get_connection_info')
  return cached
}

/** Dev fallback: when running the frontend outside Tauri (plain vite in a
 *  browser), read the token written by scripts/dev-token instead of IPC. */
export async function getConnectionInfoDev(): Promise<ConnectionInfo> {
  if (cached) return cached
  try {
    return await getConnectionInfo()
  } catch {
    const res = await fetch('/dev-token.json')
    if (!res.ok) throw new Error('no Tauri IPC and no /dev-token.json')
    cached = (await res.json()) as ConnectionInfo
    return cached
  }
}
