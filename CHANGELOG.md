# Changelog

## v0.1.3

### Added

- **Per-session composer drafts** — unsent text and pasted images live in the store keyed by session id: switching sessions no longer carries the draft along, and switching back restores it.
- **Filename links on image tool results** — inline result images (ReadMediaFile et al.) now show the source file's basename above the thumbnail; clicking opens the file with the OS default handler via a new `open_path` Tauri command (path passed as argv, never through a shell). Browser-dev falls back to opening the image in a new tab.

### Fixed

- **React "unique key" warnings from mid-turn spliced messages** — `context.spliced` frames that inject runtime envelopes (system reminders as user-role text) arrive **without a message id**; they entered `messages` as-is and rendered keyless on every render until the turn-end history pull healed state (and could never dedupe on redelivery). The reducer now mints a frame-stable `spliced_<seq>_<i>` id before merging.

## v0.1.2

### Added

- **Image tool results render inline** — `ReadMediaFile`-style results (content-block arrays with `image_url` data URLs) show as thumbnails directly in the tool card; click to expand full width. Lazy-loaded so image-heavy histories stay light.
- **Background-task log tails + completion badges** — task rows in the InsightRail expand to a live `output_preview` tail (polls while running); a task finishing in a session you're not watching raises a taskbar notification and a ✓ badge on its sidebar row (10s `/tasks` polling for unwatched sessions, instant frames for watched ones).
- **Project presence indicator** — workspace headers show `⚡N` when N sessions are mid-turn on that working tree (tooltip lists them) — a clobber warning for shared repos.
- **MCP staleness hint** — Settings compares `mcp.json`'s mtime against the daemon's `started_at` (read from the server lock) and shows "mcp.json changed since the daemon started — restart to apply" with a restart button when they diverge (from laptop-agent field feedback).
- **Interrupted tool calls render as such** — a main-agent call left `running` with no result when the turn ends (crash, abort, daemon restart) is marked `interrupted` (amber) in the store and the tool card, instead of pulsing forever. Aborted calls that recorded a result still show `error`.

### Fixed

- `prependMessages` now rebuilds tool records from older pages — previously, cards on any page loaded via "Load earlier" rendered as forever-running fallbacks with no output (also the source of zombie running cards on long histories).

## v0.1.1

### Added

- **Image messages render** — history `image` blocks show as thumbnails (the daemon stores them as data URLs); the composer's sending chip shows `🖼×N` while an image send is in flight. Combined with the envelope stripping, an image send now reads as "the image" in the log, never as a blob of system text.
- **`/` command menu in the Composer** — filtered popup (Session + live per-session Skills sections, keyboard/mouse) with CLI semantics: unmatched `/text` falls through as a normal prompt. Session commands: `/yolo` `/auto` `/manual`, `/plan [on|off]`, `/model` (alias or picker), `/thinking [off|low|medium|high|xhigh|max]` (alias or picker), `/title`, `/goal <objective|pause|resume|cancel>`, `/fork` (child session), `/export` (zip download), `/copy`, `/new`. Skill entries activate via `POST /skills/{name}:activate`.
- **InsightRail**: thinking row + plan/swarm badges; mode/plan/swarm/thinking state synced from `/status` (the profile GET and snapshots return a sparse projection).
- **Sidebar archived view** — 🗄 toggle lists archived sessions (dimmed, tagged); read-only, the daemon has no unarchive action in 0.27.0.
- **Browser dev loop** — `npm run dev:token` writes the gitignored `public/dev-token.json`; `getConnectionInfo` falls back to it when Tauri IPC is absent, so the app runs in a plain browser (Playwright-friendly).

### Fixed

- **Control-plane envelopes no longer render as chat messages** — `<system-reminder>`, `<notification>`, and `<kimi-skill-loaded>` blocks (which arrive as user-role text) are stripped in `MessageView` (`src/state/sysmsg.ts`); messages with nothing real left are hidden entirely.
- `/command` notices survive session switches (store-backed) — `/fork`'s confirmation is no longer lost when the child opens.
- Chat follow-scroll rewritten around a `ResizeObserver` on the content — any growth (deltas, tool progress, subagents, reflow) snaps to bottom while stuck; the streaming `ThinkingBlock` now auto-scrolls its own box.
- `mergeUsage` no longer materializes a field-less usage object from an all-zero payload (crashed the context bar on zero-usage sessions).
- `scripts/probe-*.mjs` archive calls sent `Content-Type: application/json` with an empty body, which the daemon rejects — every probe "cleanup" was a silent no-op and leaked sessions. Now they send `{}`.

## v0.1.0 — initial release

Standalone desktop UI for Kimi Code (Tauri 2, Windows), rendering the kimi daemon's local REST + WebSocket API. Verified against kimi 0.27.0.

### Highlights

- **Core**: multi-project sidebar, streaming chat with markdown + syntax highlighting, collapsible thinking blocks, session restore, crash-safe resync (sessions live in the daemon)
- **Insight rail**: live todos, context bar, token/turn usage (accumulated from step frames — REST usage is all zeros in 0.27.0), files touched, background tasks, goals (create/pause/resume/cancel), MCP servers
- **Tool cards**: Bash terminal style, Edit diffs, Write previews, nested subagent panels with live thinking
- **Interactions**: approval bar (incl. plan review with markdown), multi-question dialogs (all pending items, all sub-questions)
- **Turn control**: Queue / Steer (next step boundary) / ⚡ Now (instant interrupt via abort+takeover), pending strip above composer with edit / steer-now / cancel, Esc abort
- **Extras**: local terminal pane (Rust PTY), session diff view (git status + per-file diffs), image paste, history pagination, settings modal (MCP power toggles, default permission mode, daemon restart), session archiving, taskbar notifications, app icon

### Known notes

- Daemon terminal WS attach is unresponsive in kimi 0.27.0 — the terminal pane uses a local PTY instead (works without the daemon)
- REST usage object reports zeros in 0.27.0 — usage is accumulated client-side from WS frames
- Sessions created by the TUI before the daemon saw them don't stream (snapshot renders; daemon-created sessions stream fully)

### Tested

- 12 vitest cases over the store reducer (streaming, per-agent separation, usage accumulation, spliced merging, snapshot guards, outbox)
- Live protocol probes for WS auth, subscriptions, approvals, questions, subagents, queue/steer/abort, goals, MCP tools
