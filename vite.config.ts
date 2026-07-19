import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri expects a fixed port in dev
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Windows fs.watch dies with EBUSY on locked/transient files (Rust build
      // output, tsc artifacts). Polling is slower but does not crash.
      usePolling: true,
      interval: 300,
      ignored: ['**/src-tauri/**', '**/dist/**', '**/reference/**', '**/*.tsbuildinfo'],
    },
  },
  // Prevent vite from obscuring rust errors in tauri dev
  clearScreen: false,
})
