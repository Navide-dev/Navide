// Per-CLI detection of expired-login messages in a pane's clean PTY output,
// plus the login command to send into the CLI to recover. Each vendor declares
// its own `loginExpired` spec (see agents/types.ts) — only `claude` for now.

import { AGENT_SPECS } from '@navide/plugin-shell'

function loginExpiredSpecFor(agentKey: string): { pattern: RegExp; loginCommand: string } | undefined {
  return AGENT_SPECS.find((s) => s.agentKey === agentKey)?.loginExpired
}

/** True when `tail` contains agentKey's login-expired message. Always false
 *  for CLIs without a loginExpired spec. */
export function matchLoginExpired(agentKey: string, tail: string): boolean {
  const spec = loginExpiredSpecFor(agentKey)
  // Collapse whitespace runs to a single space before matching (mirrors
  // matchSessionLimit): cleanBuffer keeps the TUI hard-wrap `\n` a narrow pane
  // inserts mid-phrase, so an unnormalized "Please run\n/login" never matches.
  return spec !== undefined && spec.pattern.test(tail.replace(/\s+/g, ' '))
}

/** The login command to send into agentKey's pane, or null when the CLI has
 *  no loginExpired spec. */
export function loginCommandFor(agentKey: string): string | null {
  return loginExpiredSpecFor(agentKey)?.loginCommand ?? null
}

/** True when a finished turn proves a lit login-expired badge is stale: the
 *  turn ended after the badge lit and carried real assistant text that is not
 *  the expired-login error itself. An empty-text turn end (a failed request's
 *  Stop hook) proves nothing, and an unknown lit time never clears. */
export function turnClearsLoginExpired(
  agentKey: string,
  turnText: string,
  turnAtMs: number,
  litAtMs: number | null
): boolean {
  if (litAtMs == null || !(turnAtMs > litAtMs)) return false
  if (!turnText.trim()) return false
  return !matchLoginExpired(agentKey, turnText)
}
