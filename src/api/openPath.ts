import { invoke } from '@tauri-apps/api/core'

/** Open a local file with the OS default handler via the Rust `open_path`
 *  command. In plain-browser dev IPC is absent — fall back to opening the
 *  rendered image in a new tab (browsers block data: URL navigation, so go
 *  through a blob object URL). */
export async function openExternal(path: string, fallbackUrl?: string): Promise<void> {
  try {
    await invoke('open_path', { path })
  } catch (e) {
    console.warn('open_path failed', e)
    if (fallbackUrl) {
      try {
        const blob = await (await fetch(fallbackUrl)).blob()
        window.open(URL.createObjectURL(blob), '_blank')
      } catch (e2) {
        console.warn('image fallback failed', e2)
      }
    }
  }
}
