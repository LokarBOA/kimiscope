/** media:// URL for a local media file, streamed by the Rust `media://`
 *  protocol handler. Null outside Tauri (browser dev has no custom protocol —
 *  video shows as a filename link only). */
export function mediaUrl(path: string): string | null {
  if (!('__TAURI_INTERNALS__' in window)) return null
  return `media://localhost/${encodeURIComponent(path)}`
}
