---
name: harness-dev
description: Develop, run, and verify the KimiHarness Tauri app in this repo — dev loop, build, protocol probing, and the pitfalls already discovered. Use for any work on the KimiHarness codebase.
---

# KimiHarness dev loop

Read `AGENTS.md` first — it has the architecture and the daemon protocol facts. Do not re-derive them by probing.

## Run in dev

Two processes (do NOT use `npm run tauri dev` under a background task manager — it gets killed and orphans children):

1. `npm run dev` (vite, port 5173)
2. `cd src-tauri && cargo run --no-default-features` (opens the window; debug builds load devUrl)

HMR applies to frontend changes. Rust changes need a cargo restart.

## Build

`npm run tauri build` → exe + installers under `src-tauri/target/release/bundle/`. Kill any running release `app.exe` first (Windows locks it; the build fails with "Access is denied").

## Verify

- `npx tsc -b` must be clean before anything is called done.
- Protocol changes: verify against the live daemon with a probe script (`scripts/probe-*.mjs` pattern, see the `live-probe` skill). Never code against assumed frame shapes.
- UI behavior: run the frontend in a plain browser and drive it with Playwright — `npm run dev:token` (writes the gitignored `public/dev-token.json`), `npm run dev`, open http://localhost:5173. `getConnectionInfo` falls back to the token file automatically when Tauri IPC is absent.
- UI state: zustand v5 — no `?? []` / `?? {}` inside selectors (infinite render loop; see AGENTS.md).
- The daemon must be running (`curl http://127.0.0.1:58627/api/v1/healthz`); the app auto-starts it, probes do not.

## Conventions

- Rust stays thin (daemon lifecycle + token only). All API I/O is frontend fetch/WebSocket.
- Keep dependencies as-is (no new UI frameworks); Tailwind v4 for styles, dark theme.
- Probe scripts go in `scripts/`, captures in `reference/`, and are throwaway — archive probe sessions after.
