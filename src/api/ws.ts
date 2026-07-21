import type { Frame } from './events'

interface PendingRequest {
  resolve: (f: Frame) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface SocketHandlers {
  onFrame: (f: Frame) => void
  /** Fired when the socket drops and will reconnect — callers should resync. */
  onReset: () => void
  onStateChange?: (state: 'connecting' | 'open' | 'closed') => void
}

let counter = 0
const nextId = () => `kh_${Date.now()}_${++counter}`

/** One shared daemon socket. Auth rides as a Sec-WebSocket-Protocol token,
 *  which is the only mechanism a browser/WebView2 WebSocket can use. */
export class KimiSocket {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private reconnectDelay = 500
  private closedByUser = false
  private clientId = `kimiscope_${Math.random().toString(36).slice(2, 10)}`
  private url: string
  private token: string
  private handlers: SocketHandlers

  constructor(url: string, token: string, handlers: SocketHandlers) {
    this.url = url
    this.token = token
    this.handlers = handlers
  }

  private openWaiters: { resolve: () => void; reject: (e: Error) => void }[] = []

  /** Resolves once the socket is OPEN (immediately if it already is). */
  waitForOpen(timeoutMs = 15_000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket open timed out')), timeoutMs)
      this.openWaiters.push({
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })
  }

  connect() {
    this.handlers.onStateChange?.('connecting')
    const ws = new WebSocket(`${this.url}?client_id=${this.clientId}`, [
      `kimi-code.bearer.${this.token}`,
    ])
    this.ws = ws

    ws.onopen = () => {
      this.reconnectDelay = 500
      this.handlers.onStateChange?.('open')
      for (const w of this.openWaiters.splice(0)) w.resolve()
      this.request('client_hello', { client_id: this.clientId, subscriptions: [] }).catch(
        () => this.handlers.onReset(),
      )
    }
    ws.onmessage = (ev) => {
      let frame: Frame
      try {
        frame = JSON.parse(String(ev.data)) as Frame
      } catch {
        return
      }
      if (frame.type === 'ping') {
        this.send('pong', { nonce: (frame.payload as { nonce?: unknown })?.nonce })
        return
      }
      const id = (frame as unknown as { id?: string }).id
      if (frame.type === 'ack' && id && this.pending.has(id)) {
        const p = this.pending.get(id)!
        this.pending.delete(id)
        clearTimeout(p.timer)
        p.resolve(frame)
        return
      }
      this.handlers.onFrame(frame)
    }
    ws.onclose = () => {
      this.handlers.onStateChange?.('closed')
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('socket closed'))
      }
      this.pending.clear()
      if (!this.closedByUser) {
        this.handlers.onReset()
        setTimeout(() => this.connect(), this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000)
      }
    }
    ws.onerror = () => {
      for (const w of this.openWaiters.splice(0)) w.reject(new Error('socket error'))
      ws.close()
    }
  }

  send(type: string, payload: unknown, id = nextId()): string {
    this.ws?.send(JSON.stringify({ type, id, payload }))
    return id
  }

  request(type: string, payload: unknown, timeoutMs = 10_000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('socket not open'))
        return
      }
      const id = nextId()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${type} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.send(type, payload, id)
    })
  }

  close() {
    this.closedByUser = true
    this.ws?.close()
  }
}
