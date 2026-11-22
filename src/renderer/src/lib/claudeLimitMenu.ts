/**
 * Claude Code's "You've hit your limit" menu, and leaving it after a hot
 * account switch so the pane carries on with its task.
 *
 * The menu (whitespace collapsed):
 *   What do you want to do? ❯ 1. Stop and wait for limit to reset
 *   2. Wait here, then continue automatically at … 3. Switch to usage credits
 *   Enter to confirm · Esc to cancel
 *
 * The window's awaiting detector does not match it (its footer says
 * "confirm", not "select"); the backend channel reads it with the same
 * pattern as LIMIT_MENU_RE (channels/manager.py _LIMIT_MENU_RE).
 *
 * After the swap the pane's next request already uses the new account, so the
 * menu is only in the way. It is left with option 1 when the cursor is on it,
 * otherwise with Esc — never by moving the cursor, so the "usage credits"
 * option can never be picked.
 */

export const LIMIT_MENU_RE = /Stop and wait for limit to reset.{0,300}?Enter to confirm · Esc to cancel/
const CURSOR_ON_STOP_RE = /❯\s*1\.\s*Stop and wait for limit to reset/

function collapse(screen: string): string {
  return screen.split(/\s+/).filter(Boolean).join(' ')
}

export function screenShowsLimitMenu(screen: string): boolean {
  return LIMIT_MENU_RE.test(collapse(screen))
}

/** The key that leaves the menu without choosing anything but "stop". */
export function limitMenuDismissKey(screen: string): string {
  return CURSOR_ON_STOP_RE.test(collapse(screen)) ? '\r' : '\x1b'
}

export interface LimitMenuDeps {
  read(): string
  write(data: string): void
  sleep(ms: number): Promise<void>
  /** Types the continue text; false when it could not go in. Omitted: leave the menu only. */
  resume?: () => Promise<boolean>
  pollMs?: number
  timeoutMs?: number
  settleMs?: number
}

export type LimitMenuOutcome = 'not-on-menu' | 'menu-stuck' | 'dismissed' | 'resumed' | 'resume-failed'

export async function leaveLimitMenuAndResume(deps: LimitMenuDeps): Promise<LimitMenuOutcome> {
  const screen = deps.read()
  if (!screenShowsLimitMenu(screen)) return 'not-on-menu'
  deps.write(limitMenuDismissKey(screen))
  const pollMs = deps.pollMs ?? 150
  const deadline = (deps.timeoutMs ?? 3000) / pollMs
  let gone = false
  for (let i = 0; i < deadline; i++) {
    await deps.sleep(pollMs)
    if (!screenShowsLimitMenu(deps.read())) {
      gone = true
      break
    }
  }
  if (!gone) return 'menu-stuck'
  if (!deps.resume) return 'dismissed'
  // Let the prompt redraw before typing into it.
  await deps.sleep(deps.settleMs ?? 400)
  return (await deps.resume()) ? 'resumed' : 'resume-failed'
}
