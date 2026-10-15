/** A CLI pane's exit worth a badge and a ledger entry. */
export interface PaneExitFault {
  code: number
  /** Wall-clock ms the exit was seen. */
  at: number
}

/**
 * Whether a pane's exit is a fault. Before this, any exit but a missing CLI's
 * 127 only turned the status word to "exited": a CLI that crashed looked the
 * same as one the user quit, and nothing recorded the code.
 *
 * A plain terminal's shell is left alone, since its exit code is whatever the
 * user's last command returned. A 127 the spawn probe already explained as a
 * missing CLI has its own install prompt.
 */
export function paneExitFault(
  exitCode: number | null | undefined,
  agentKey: string,
  probeReason?: string,
  now: number = Date.now(),
): PaneExitFault | null {
  if (typeof exitCode !== 'number' || exitCode === 0) return null
  if (agentKey === 'terminal') return null
  if (exitCode === 127 && probeReason === 'not_found') return null
  return { code: exitCode, at: now }
}
