import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // Serve the browser-dev token in dev only, from a root file that is never
      // part of the bundle. (It used to live in public/ — vite copies public/
      // into dist verbatim, so the file shipped inside the installer with a
      // live token and masked real connection errors on other machines.)
      name: 'dev-token',
      configureServer(server) {
        server.middlewares.use('/dev-token.json', (_req, res) => {
          try {
            const body = readFileSync('.dev-token.json', 'utf8')
            res.setHeader('Content-Type', 'application/json')
            res.end(body)
          } catch {
            res.statusCode = 404
            res.end('run `npm run dev:token` first')
          }
        })
      },
    },
  ],
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
