/**
 * failedRunStop.ts
 *
 * What a run that failed does to the agents of its other slots. On the 0.2.37
 * Linux VM (70e669130, run 20261103-204149) one slot parked on a permission
 * box failed the run, and the manager slot, whose kickoff had gone out a
 * moment earlier, kept working: it printed MANAGER-READY, ran `touch RAN.txt`
 * and parked on a permission box of its own. In an unattended webhook run
 * (bypass permissions) nothing stops such an agent. So a failed run presses
 * the stop key of every other slot still in a turn, and leaves the prompt of
 * every slot parked on one. The panes stay open for the person to read.
 */

/** 'interrupt': the pane is in a turn, press its vendor's interrupt key (the
 *  pane's stop button). 'dismiss': it is parked on a prompt, leave it with
 *  Esc rather than sit on Yes/No. null: idle, starting, exited — nothing. */
export type FailedRunStop = 'interrupt' | 'dismiss'

export function failedRunStop(displayStatus: string | undefined): FailedRunStop | null {
  if (displayStatus === 'running') return 'interrupt'
  if (displayStatus === 'awaiting') return 'dismiss'
  return null
}
