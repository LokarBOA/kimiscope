import type { SkillInfo } from '../api/events'

/** Static metadata for the client-side session commands in the `/` menu.
 *  Skills arrive per session from the daemon; dispatch lives in sync.ts. */
export interface SlashCommand {
  name: string
  description: string
  /** Hint shown in the menu, e.g. '<text>' or '[on|off]'. */
  args?: string
}

export const COMMANDS: SlashCommand[] = [
  { name: 'yolo', description: 'Skip approvals for regular tool calls' },
  { name: 'auto', description: 'Approvals handled automatically; no questions' },
  { name: 'manual', description: 'Ask before every tool call' },
  { name: 'plan', description: 'Toggle plan mode', args: '[on|off]' },
  { name: 'model', description: 'Switch model', args: '[alias]' },
  { name: 'thinking', description: 'Set thinking effort', args: '[level]' },
  { name: 'title', description: 'Rename this session', args: '<text>' },
  { name: 'goal', description: 'Start a goal, or pause|resume|cancel', args: '<objective|pause|resume|cancel>' },
  { name: 'fork', description: 'Fork this session, keeping full history' },
  { name: 'export', description: 'Export session + logs as a zip' },
  { name: 'copy', description: 'Copy the last assistant message' },
  { name: 'new', description: 'Start a fresh session in this folder' },
]

/** Thinking effort levels offered by the `/thinking` picker (from the CLI's
 *  THINKING_EFFORTS; the daemon rejects unsupported ones with an error notice). */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Parse `/name rest of line…` — null when the input is not slash-prefixed. */
export function parseSlash(raw: string): { name: string; args: string } | null {
  const m = raw.match(/^\/(\S+)(?:\s+(.*))?$/)
  if (!m) return null
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() }
}

/** True while the user is still typing the command name (no space yet). */
export function slashNameFilter(text: string): string | null {
  const m = text.match(/^\/(\S*)$/)
  return m ? m[1] : null
}

export interface CommandGroups {
  commands: SlashCommand[]
  skills: SkillInfo[]
}

/** Sectioned, filtered view model for the menu. Matches name substrings,
 *  case-insensitive; empty query returns everything. */
export function filterCommands(query: string, skills: SkillInfo[]): CommandGroups {
  const q = query.toLowerCase()
  return {
    commands: COMMANDS.filter((c) => c.name.includes(q)),
    skills: skills.filter((s) => s.name.toLowerCase().includes(q)),
  }
}
