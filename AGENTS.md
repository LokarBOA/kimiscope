# KimiScope

Standalone desktop UI for [Kimi Code](https://www.kimi.com/code) — a Tauri 2 app that renders rich session UI (streaming, thinking, todos, tool cards with diffs, subagents, approvals, usage) on top of the **kimi daemon's local REST + WebSocket API**. It contains no agent logic; sessions live in the daemon (`kimi server`), the app is a disposable renderer.

## Fresh machine bootstrap (agent-executable)

To set up KimiScope on a new Windows machine, an agent can do everything with these steps (verify each before continuing):

1. **Node.js**: `winget install OpenJS.NodeJS` → verify `node -v` and `npm -v`.
2. **Kimi CLI**: `npm install -g @moonshot-ai/kimi-code` → verify `kimi --version`.
3. **Login**: `kimi login` (device-code flow; needs the user to approve in a browser once) → verify `~/.kimi-code/credentials` exists.
4. **uv** (hands): `winget install astral-sh.uv` or `pip install uv` → verify `uv --version`.
5. **Install KimiScope** from `src-tauri/target/release/bundle/` (or `npm run tauri build` from source with Rust present). The app auto-starts the daemon (`kimi server run`) and reads `~/.kimi-code/server.token` — verify `curl http://127.0.0.1:58627/api/v1/healthz` after first launch.
6. **MCP servers** (optional powers): write `~/.kimi-code/mcp.json` (template in README), then restart the daemon. All servers self-download on first use. GitHub tools additionally need `winget install GitHub.cli` + `gh auth login`, then this entry (token from `gh auth token`):
   `"github": { "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer <token>" } }`
   Logged-in browser additionally needs:
   `"playwright-personal": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--browser", "msedge", "--user-data-dir", "%LOCALAPPDATA%\\KimiScope\\edge-agent-profile"] }` (create the profile dir first; the user logs into sites once in its window).

## Architecture

- **Daemon**: `kimi server run` serves REST on `http://127.0.0.1:58627` + WS on `ws://127.0.0.1:58627/api/v1/ws`, bearer auth. Token is persisted in `~/.kimi-code/server.token`; port in `~/.kimi-code/server/lock`. API specs: `reference/openapi.json`, `reference/asyncapi.json` (regenerate types with `npm run gen:api`).
- **Rust side** (`src-tauri/src/lib.rs`): thin — ensures the daemon runs, hands `{baseUrl, wsUrl, token}` to the frontend via the `get_connection_info` command. Nothing else.
- **Frontend** (React 19 + TS + Vite + Tailwind v4 + zustand): talks to the daemon directly.
  - `src/api/` — REST client (`client.ts`), WS client (`ws.ts`, auth via `Sec-WebSocket-Protocol: kimi-code.bearer.<token>`, the only browser-feasible mechanism), event types (`events.ts`).
  - `src/state/` — `store.ts` (zustand, per-session state + frame reducer), `sync.ts` (socket lifecycle, snapshot→subscribe `SessionSync`, history pulls, notifications).
  - `src/components/` — SessionList (workspaces), ChatView (messages/streaming), ToolCard (per-tool renderers incl. diffs + subagent panels), ThinkingBlock, ApprovalBar, QuestionDialog, InsightRail (todos/usage), Composer (+ CommandMenu `/` popup), ErrorSurface.

## Daemon protocol facts (verified against kimi 0.27.0)

- WS flow: connect (subprotocol auth) → `client_hello` → REST `GET /sessions/{id}/snapshot` → `subscribe` with cursor `{seq: snapshot.as_of_seq, epoch: snapshot.epoch}` → `session_event` frames. Reply to `ping` with `pong`. On reconnect/`resync_required`/context rewrite: re-snapshot.
- **The WS stream never carries completed assistant messages** — only the user-message `context.spliced` and live deltas. Pull `GET /sessions/{id}/messages` at `turn.ended`/`prompt.completed` (debounced). `/messages` is newest-first (reverse it); snapshot is chronological.
- Sessions created **through the daemon API** are streamable. Sessions created by the TUI/CLI before the daemon saw them answer `not_found` on subscribe — snapshot data still renders.
- Session creation ignores `agent_config`; always `POST /sessions/{id}/profile` with `{agent_config: {model, permission_mode}}` afterwards.
- Subagent frames share the session stream with `agentId != 'main'`; lifecycle: `subagent.spawned/started/completed`. Never merge them into main streaming/history.
- Approvals: `GET .../approvals?status=pending` (the status param is required), resolve via `POST .../approvals/{id} {decision}`. Questions analogous; answers use `{kind: single|multi|other|multi_with_other|skipped}`.
- Steer mid-turn: `POST /prompts` (queues) then `POST /prompts:steer {prompt_ids}`.
- The daemon does **not** interpret `/commands` sent as prompts — the Composer's `/` menu is client-side (`src/state/commands.ts` pure parser/filter; dispatch in `sync.ts:runSlashCommand`). Skills: `GET /sessions/{id}/skills`, activate via `POST /sessions/{id}/skills/{name}:activate {args}` (a bare name tail is rejected). Mode toggles go through `POST /profile {agent_config}` and re-sync from `GET /status` — **the profile GET and snapshots return a sparse `agent_config` projection**, so `/status` (which also carries `plan_mode`/`swarm_mode`) is the only reliable read-back. `/sessions/{id}/export` streams the zip binary directly (no JSON envelope).

## Commands

- Dev: `npm run dev` (vite, one terminal) + `cargo run --no-default-features` in `src-tauri/` (another). HMR works; the Rust side rebuilds manually. `npm run tauri dev` also works but has been flaky under background task managers here — same for plain `npm run dev` (a killed vite orphans the process and keeps port 5173 hostage).
- Browser dev (no Tauri window): `npm run dev:token` writes `public/dev-token.json` (gitignored), then `npm run dev` and open http://localhost:5173 — `getConnectionInfo` falls back to the token file when IPC is absent. Handy for Playwright-driven DOM verification.
- Build: `npm run tauri build` → MSI + portable exe in `src-tauri/target/release/bundle/`.
- Types: `npm run gen:api` after a kimi upgrade (re-snapshot `reference/*.json` first).
- Tests: `npm test` (vitest). The store reducer is the regression-prone core — `src/state/store.test.ts` pins streaming, per-agent separation, usage accumulation, spliced merging, snapshot guards, outbox. Add cases there whenever touching `applyFrame`/`applySnapshot`. Reducer logic deliberately lives in the store (pure, testable) rather than in `sync.ts` (module-level singleton: socket/watchers/polling).
- Probes: `node scripts/probe-*.mjs` — live protocol probes against the daemon (each creates a throwaway session).

## Gotchas

- zustand v5: never `?? []` / `?? {}` inside a selector — allocates per snapshot and infinite-loops `useSyncExternalStore`. Select the reference, default outside.
- Vite `server.watch.ignored` must exclude `src-tauri/**` (cargo locks files; vite crashes EBUSY otherwise).
- Git Bash: node can't read MSYS `/tmp` paths — use `cygpath -w`.
- MCP servers (user-level `~/.kimi-code/mcp.json`): playwright (`--browser chromium`), playwright-personal (Edge, dedicated profile at `%LOCALAPPDATA%\KimiScope\edge-agent-profile` — the user logs into sites once in its window), memory, github (remote, PAT from `gh auth token`), windows (GUI control: Snapshot/Screenshot/Click/Type/Scroll/Move/Shortcut/Wait/WaitFor/App/Clipboard/Notification/MultiSelect — no Registry/PowerShell/Process). Yolo auto-approves MCP calls — vet before adding servers; hands are ask-first in practice. Daemon picks up mcp.json changes only on restart.
- Standing automation: Windows task `KimiCIDigest` (daily 08:47) runs `scripts/ci-digest.bat` → headless `kimi -p` CI digest appended to `~/kimi-digest.log`.
