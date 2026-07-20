/** Control-plane envelopes the runtime injects into user-role messages
 *  (todo reminders, plan-mode notices, background-task notifications, …).
 *  They are not chat content and must not render in the message log. */
const ENVELOPES = [
  // Skill loads: host wrapper sentence + the full skill body envelope.
  /Skill tool loaded instructions for this request\. Follow them\.\s*<kimi-skill-loaded\b[^>]*>[\s\S]*?<\/kimi-skill-loaded>/g,
  /<kimi-skill-loaded\b[^>]*>[\s\S]*?<\/kimi-skill-loaded>/g,
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g,
  /<notification\b[^>]*>[\s\S]*?<\/notification>/g,
]

/** Strip injected system envelopes from a message text; the remainder is
 *  the real user text (may be empty for pure control-plane messages). */
export function stripSystemEnvelopes(text: string): string {
  let out = text
  for (const re of ENVELOPES) out = out.replace(re, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
