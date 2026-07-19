import { getConnectionInfo } from './connection'

/** Thin typed REST client for the kimi daemon. All paths are /api/v1-relative. */
export class ApiError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`kimi api ${status}: ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const conn = await getConnectionInfo()
  const res = await fetch(`${conn.baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
  const json = await res.json()
  // The daemon wraps payloads as { code, msg, data } — unwrap, and treat
  // non-zero codes as errors (they arrive with HTTP 200).
  if (json && typeof json === 'object' && 'code' in json) {
    const env = json as { code: number; msg?: string; data: T }
    if (env.code !== 0) throw new ApiError(env.code, env.msg ?? 'unknown error')
    return env.data
  }
  return json as T
}

export const get = <T = unknown>(path: string) => api<T>(path)
export const post = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
