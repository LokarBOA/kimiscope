# Changelog

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
