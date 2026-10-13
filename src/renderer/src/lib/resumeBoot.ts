/**
 * resumeBoot.ts
 *
 * Whether a pane whose CLI was just resumed is still booting, for the
 * messaging gate.
 *
 * A resumed CLI reloads its transcript before it paints or reads input —
 * observed 20-30s of silence on a real claude session. Silence is what the
 * badge reads as idle, so the gate used to open as soon as the shell's own
 * first bytes went quiet, and a message typed then was wiped by the resume
 * repaint that followed. That repaint grew the buffer, which the echo and
 * submit checks accept as evidence, so the message was reported delivered to
 * a CLI that never received it (cli_send open_target, 2026-10-10).
 *
 * So for a resume, quiet proves nothing: the CLI has to say something itself.
 */

/** Longest a resumed CLI is waited for before the gate falls back to its
 *  ordinary idle verdict. The resume ceiling kickoffRequestedPane already uses
 *  (KICKOFF_PROMPT_READY_TIMEOUT_RESUME_MS), so a resumed pane is not held
 *  forever by a vendor that reports nothing until its first turn. */
export const RESUME_BOOT_MAX_MS = 90_000

export interface ResumeBootInput {
  /** The pane's terminal has a PTY session. */
  hasPty: boolean
  /** When this terminal created a PTY for a resume spawn; 0 for a fresh spawn
   *  or a reattach to a CLI that kept running. */
  resumeSpawnedAt: number
  /** The backend announced a push channel for the pane — for claude that is
   *  the rewake waiter its SessionStart hook parks, which only a CLI that has
   *  finished starting runs. */
  pushReady: boolean
  /** Newest CLI-side signal for the pane (activity or turn end). */
  lastSignalAt: number
  now: number
}

/** True while a message must not be typed into the pane yet. */
export function resumeBootHold(input: ResumeBootInput): boolean {
  // No PTY yet — a resume parked for a hidden tab reads idle on the badge while
  // nothing is there to type into.
  if (!input.hasPty) return true
  if (input.resumeSpawnedAt <= 0) return false
  if (input.pushReady) return false
  if (input.lastSignalAt > input.resumeSpawnedAt) return false
  return input.now - input.resumeSpawnedAt < RESUME_BOOT_MAX_MS
}

/** How long a typed message to a still-unconfirmed resume waits for the CLI to
 *  show it received it (its user record, read back as pane activity) before it
 *  is failed. Generous: the incident pane was under a load average of 80. */
export const RESUME_CONSUME_WAIT_MS = 30_000

/** True while nothing from the resumed CLI has been seen since its spawn. Past
 *  the boot hold that still happens — the hold gives up at RESUME_BOOT_MAX_MS,
 *  and a push channel can be announced while the screen is still repainting —
 *  and then buffer growth is exactly what the CLI's own repaint produces, so it
 *  cannot vouch for a delivery. */
export function resumeUnconfirmed(input: { resumeSpawnedAt: number; lastSignalAt: number }): boolean {
  return input.resumeSpawnedAt > 0 && input.lastSignalAt <= input.resumeSpawnedAt
}
