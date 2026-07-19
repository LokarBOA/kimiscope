# KimiScope

A standalone desktop app for [Kimi Code](https://www.kimi.com/code) — rich, reliable UI on top of the kimi daemon's local API.

- Live streaming with collapsible **thinking** blocks
- **Todo list**, context/token usage, files touched, tasks, goals in the insight rail
- **Tool cards**: terminal-style Bash, diffs for edits, nested **subagent** panels
- **Approvals & questions** in the UI (all sub-questions, works with yolo/auto/manual)
- Queue / steer / interrupt control of running turns, local terminal pane, session diffs
- Multi-project sidebar; sessions keep streaming in the background
- Crash-proof: sessions live in the daemon, the window is a disposable renderer
- Optional agent powers via MCP: browser automation, screen vision + GUI control, GitHub, memory

## Install (fresh machine)

KimiScope itself is one installer, but the full setup has a few system dependencies.
**An agent (or human) can perform all of these:**

```powershell
# 1. Node.js (includes npm) — required by the kimi CLI and npx-based MCP servers
winget install OpenJS.NodeJS

# 2. Kimi Code CLI — provides the daemon KimiScope renders against
npm install -g @moonshot-ai/kimi-code

# 3. Log in (device-code flow, opens a browser once)
kimi login

# 4. uv — required for the Windows GUI-control server (hands)
winget install astral-sh.uv        # or: pip install uv
```

Then install KimiScope from `src-tauri/target/release/bundle/` (MSI or NSIS `KimiScope_*_setup.exe`).
The app auto-starts the daemon and reads its token from `~/.kimi-code/server.token` — no further wiring.

## Optional agent powers (MCP)

These are configured in `~/.kimi-code/mcp.json` (toggleable in the app's Settings ⚙). Example:

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--browser", "chromium"] },
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
    "windows": {
      "command": "uvx",
      "args": ["windows-mcp", "serve", "--transport", "stdio", "--tools",
               "Snapshot,Screenshot,Click,Type,Scroll,Move,Shortcut,Wait,WaitFor,App,Clipboard,Notification,MultiSelect"]
    }
  }
}
```

- Everything above **self-downloads on first use** (npx/uvx fetch the servers; Playwright fetches its Chromium on first browser call).
- Restart the daemon after editing `mcp.json` (`kimi server kill`, or the Settings ⚙ restart button).
- **GitHub tools** (optional): requires the GitHub CLI (`winget install GitHub.cli`) and `gh auth login`; then add the remote server with your token — see `AGENTS.md` for the exact entry.
- **Logged-in browser** (optional): a dedicated Edge profile entry (`playwright-personal`) is in `AGENTS.md`.
- Caution: yolo permission mode auto-approves MCP tool calls. Keep GUI-control servers scoped like the example above (no Registry/PowerShell/Process).

## Dev

```sh
npm run dev                                # terminal 1 (vite)
cd src-tauri && cargo run --no-default-features   # terminal 2 (app window)
```

Build: `npm run tauri build` (kill any running KimiScope.exe first — Windows locks it).
Requires Rust + Node. Architecture, protocol facts, and pitfalls: `AGENTS.md`.
