import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window'

let pendingCount = 0

/** Flash the taskbar button + bump the title badge when the user is elsewhere. */
export async function notifyAttention(reason: string): Promise<void> {
  try {
    const win = getCurrentWindow()
    if (await win.isFocused()) return
    await win.requestUserAttention(UserAttentionType.Critical)
    pendingCount++
    await win.setTitle(`(${pendingCount}) KimiScope — ${reason}`)
  } catch {
    // not running inside Tauri (plain vite) — ignore
  }
}

export async function clearAttention(): Promise<void> {
  if (pendingCount === 0) return
  pendingCount = 0
  try {
    await getCurrentWindow().setTitle('KimiScope')
  } catch {
    // ignore
  }
}

// Reset the badge whenever the window regains focus.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => void clearAttention())
}
