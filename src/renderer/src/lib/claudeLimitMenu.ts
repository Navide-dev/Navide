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
 * "confirm", not "select"). The backend channel only reports it
 * (channels/manager.py _LIMIT_MENU_RE); this one writes keys, so it is stricter.
 *
 * After the swap the pane's next request already uses the new account, so the
 * menu is only in the way. It is left with Esc, the menu's own cancel: Enter
 * could approve some other prompt if the screen were misread, and the cursor
 * is never moved, so the "usage credits" option can never be picked.
 *
 * Only the live menu counts: the footer must be the last non-empty line on
 * screen and the limit header and the "stop" option must sit in the block
 * right above it. The same words anywhere higher up (scrollback, an agent's
 * own output, a file it printed) are not the menu.
 */

export const LIMIT_MENU_RE = /hit your .{0,40}limit.{0,200}?Stop and wait for limit to reset.{0,300}?Enter to confirm · Esc to cancel$/
const FOOTER_RE = /Enter to confirm · Esc to cancel\s*$/
/** The menu, header to footer, is about nine lines. */
const MENU_BLOCK_LINES = 14

function collapse(lines: string[]): string {
  return lines.join(' ').split(/\s+/).filter(Boolean).join(' ')
}

export function screenShowsLimitMenu(screen: string): boolean {
  const lines = screen.split('\n').filter((line) => line.trim() !== '')
  if (!lines.length || !FOOTER_RE.test(lines[lines.length - 1])) return false
  return LIMIT_MENU_RE.test(collapse(lines.slice(-MENU_BLOCK_LINES)))
}

/** The key that leaves the menu: its own cancel, never a choice. */
export const LIMIT_MENU_DISMISS_KEY = '\x1b'

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
  deps.write(LIMIT_MENU_DISMISS_KEY)
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
