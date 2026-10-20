import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { api, get } from '../api/client'

interface AccountInfo {
  nickname: string
  userLevelName: string
  region: string
}

/** kimi 0.31+ managed account profile; absent on older daemons (404 → null). */
async function fetchAccount(): Promise<AccountInfo | null> {
  try {
    const res = await get<
      | { kind: 'ok'; userInfo: AccountInfo }
      | { kind: 'error'; message: string }
    >('/oauth/userinfo')
    return res.kind === 'ok' ? res.userInfo : null
  } catch {
    return null
  }
}

interface McpEntry {
  command?: string
  args?: string[]
  url?: string
  enabled?: boolean
}

const LABELS: Record<string, { label: string; hint: string; power?: boolean }> = {
  windows: { label: 'Hands (GUI control)', hint: 'Click, type, hotkeys on your desktop', power: true },
  'playwright-personal': {
    label: 'Logged-in browser',
    hint: 'Dedicated Edge profile with your logins',
    power: true,
  },
  playwright: { label: 'Browser automation', hint: 'Isolated Chromium' },
  github: { label: 'GitHub', hint: 'Issues, PRs, code search (gh token)' },
  memory: { label: 'Memory', hint: 'Cross-session knowledge graph' },
}

const PERMISSION_MODES = [
  { id: 'yolo', label: 'yolo — auto-approve tool calls (may still ask questions)' },
  { id: 'auto', label: 'auto — fully autonomous, never asks' },
  { id: 'manual', label: 'manual — approve each tool call' },
]

interface DaemonServer {
  id: string
  name: string
  transport: string
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  last_error?: string
  tool_count: number
}

/** kimi 2.2+ remote-control device registry (routes 404 on older daemons). */
interface RcDevice {
  device_id: string
  alias: string
  status: 'online' | 'offline'
  platform: string
  client_version: string
  last_remote_access_at?: string
}

interface RcStatus {
  enabled: boolean
  state: 'off' | 'starting' | 'on' | 'stopping'
  url?: string
  device_name?: string
  error?: string
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [servers, setServers] = useState<Record<string, McpEntry> | null>(null)
  const [daemonServers, setDaemonServers] = useState<Record<string, DaemonServer>>({})
  const [dirty, setDirty] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [stale, setStale] = useState(false)
  const [permMode, setPermMode] = useState(
    () => localStorage.getItem('kimiscope.permissionMode') ?? 'yolo',
  )
  const [account, setAccount] = useState<AccountInfo | null>(null)
  const [rcStatus, setRcStatus] = useState<RcStatus | null>(null)
  const [rcDevices, setRcDevices] = useState<RcDevice[] | null>(null)

  async function load() {
    const j = await invoke<{ mcpServers?: Record<string, McpEntry> }>('get_mcp_servers').catch(
      () => null,
    )
    setServers(j?.mcpServers ?? {})
    const meta = await invoke<{ stale: boolean }>('get_mcp_meta').catch(() => null)
    setStale(meta?.stale ?? false)
    setAccount(await fetchAccount())
    const ds = await get<{ servers?: DaemonServer[] }>('/mcp/servers').catch(() => null)
    const map: Record<string, DaemonServer> = {}
    for (const s of ds?.servers ?? []) map[s.name] = s
    setDaemonServers(map)
    // Remote control (2.2+): the devices route 404s on older daemons — hide.
    const rc = await get<RcStatus>('/remote-control').catch(() => null)
    setRcStatus(rc)
    if (rc) {
      const devs = await get<{ devices?: RcDevice[] }>('/remote-control/devices').catch(() => null)
      setRcDevices(devs ? (devs.devices ?? []) : null)
    } else {
      setRcDevices(null)
    }
  }

  async function renameRcDevice(d: RcDevice) {
    const alias = window.prompt(`Rename device "${d.alias}"`, d.alias)?.trim()
    if (!alias || alias === d.alias) return
    try {
      await api(`/remote-control/devices/${d.device_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ alias: alias.slice(0, 50) }),
      })
      await load()
    } catch (e) {
      alert(`rename failed: ${e}`)
    }
  }

  async function deactivateRcDevice(d: RcDevice) {
    if (!window.confirm(`Deactivate "${d.alias}" (${d.platform})?\nIt loses remote access until it signs in again.`)) return
    try {
      await api(`/remote-control/devices/${d.device_id}/deactivate`, { method: 'POST' })
      await load()
    } catch (e) {
      alert(`deactivate failed: ${e}`)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  async function toggle(name: string, enabled: boolean) {
    await invoke('set_mcp_enabled', { name, enabled })
    setDirty(true)
    await load()
  }

  async function restart() {
    if (
      !window.confirm(
        'Restart the kimi daemon now?\n\nSessions survive, but any turn running right now will be cut off.',
      )
    )
      return
    setRestarting(true)
    try {
      await invoke('restart_daemon')
      setDirty(false)
      await load() // fresh daemon start clears the stale marker
    } catch (e) {
      alert(`restart failed: ${e}`)
    } finally {
      setRestarting(false)
    }
  }

  const entries = Object.entries(servers ?? {})

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="w-[520px] rounded-lg border border-zinc-700 bg-zinc-950 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center">
          <span className="text-sm font-semibold text-zinc-100">Settings</span>
          <button onClick={onClose} className="ml-auto rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800">
            ✕
          </button>
        </div>

        {account && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-[13px]">
            <span className="text-zinc-200">{account.nickname}</span>
            <span className="ml-auto rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">
              {account.userLevelName}
            </span>
          </div>
        )}

        <div className="mb-4">
          <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
            Capabilities (MCP servers)
          </div>
          <div className="space-y-1">
            {entries.map(([name, cfg]) => {
              const meta = LABELS[name] ?? { label: name, hint: '' }
              const enabled = cfg.enabled !== false
              return (
                <label
                  key={name}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-zinc-800 px-3 py-2 hover:border-zinc-600"
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => void toggle(name, e.target.checked)}
                    className="accent-sky-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-[13px] text-zinc-200">
                      {meta.label}
                      {meta.power && (
                        <span className="rounded bg-amber-900/50 px-1.5 text-[10px] text-amber-300">
                          power
                        </span>
                      )}
                      {(() => {
                        const ds = daemonServers[name]
                        if (!ds) return null
                        if (ds.status === 'connected') {
                          return (
                            <span className="rounded bg-emerald-900/50 px-1.5 text-[10px] text-emerald-300">
                              {ds.tool_count} tools
                            </span>
                          )
                        }
                        if (ds.status === 'error' && /oauth/i.test(ds.last_error ?? '')) {
                          return (
                            <span
                              className="rounded bg-amber-900/50 px-1.5 text-[10px] text-amber-300"
                              title={`${ds.last_error}\nRun /mcp-config login ${name} in the kimi TUI, then restart the server here.`}
                            >
                              needs login (TUI)
                            </span>
                          )
                        }
                        if (ds.status === 'error') {
                          return (
                            <span
                              className="rounded bg-red-950/60 px-1.5 text-[10px] text-red-300"
                              title={ds.last_error}
                            >
                              error
                            </span>
                          )
                        }
                        return (
                          <span className="rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400">
                            {ds.status}
                          </span>
                        )
                      })()}
                    </span>
                    {meta.hint && <span className="block text-[11px] text-zinc-500">{meta.hint}</span>}
                  </span>
                  <span className="text-[10px] text-zinc-600">{cfg.url ? 'http' : 'stdio'}</span>
                </label>
              )
            })}
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
            {stale ? (
              <span className="text-amber-400/90">
                mcp.json changed since the daemon started — restart to apply
              </span>
            ) : (
              <span>Changes apply to new sessions; daemon restart applies everywhere.</span>
            )}
            <button
              onClick={() => void restart()}
              disabled={restarting}
              title="Kill and respawn the kimi daemon — also picks up a newly installed kimi-code version"
              className={`ml-auto rounded px-2 py-1 text-[11px] text-white disabled:opacity-50 ${
                dirty || stale ? 'bg-amber-700 hover:bg-amber-600' : 'bg-zinc-700 hover:bg-zinc-600'
              }`}
            >
              {restarting ? 'Restarting…' : 'Restart daemon'}
            </button>
          </div>
        </div>

        {rcStatus !== null && rcDevices !== null && (
          <div className="mb-4">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
              Remote Control
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-[13px]">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${rcStatus.state === 'on' ? 'bg-emerald-500' : 'bg-zinc-600'}`}
                />
                <span className="text-zinc-300">
                  tunnel {rcStatus.state}
                  {rcStatus.state === 'on' && rcStatus.url ? ` — ${rcStatus.url}` : ''}
                </span>
                {rcStatus.device_name && (
                  <span className="ml-auto text-[11px] text-zinc-500">{rcStatus.device_name}</span>
                )}
              </div>
              {rcDevices.map((d) => (
                <div
                  key={d.device_id}
                  className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-[13px]"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${d.status === 'online' ? 'bg-emerald-500' : 'bg-zinc-600'}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-zinc-200">{d.alias}</span>
                  <span className="text-[11px] text-zinc-500">
                    {d.platform} · {d.client_version}
                  </span>
                  <button
                    onClick={() => void renameRcDevice(d)}
                    title="Rename device"
                    className="rounded px-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    ✎
                  </button>
                  <button
                    onClick={() => void deactivateRcDevice(d)}
                    title="Deactivate — revokes remote access until it signs in again"
                    className="rounded px-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {rcDevices.length === 0 && (
                <div className="px-1 text-[11px] text-zinc-600">No devices registered.</div>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-zinc-500 uppercase">
            New sessions default to
          </div>
          <select
            value={permMode}
            onChange={(e) => {
              setPermMode(e.target.value)
              localStorage.setItem('kimiscope.permissionMode', e.target.value)
            }}
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[13px] text-zinc-200 outline-none"
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}
