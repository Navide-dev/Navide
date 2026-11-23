/**
 * restoreDiagnostics.ts
 *
 * Two silent ways a pane can miss the next launch's restore, made visible.
 *
 * A pane comes back after a restart only if its record reached the workspace's
 * project document (manual_pane.spawn), and only if the restoring window could
 * read that document (project.peek). Both used to fail without a trace: the
 * record write of a pane opened by an external cli_open_agent was fire-and-
 * forget, and a peek that still failed after its retries fell through as an
 * empty workspace. 0.2.45's macOS VM smoke saw a pane missing after a cold
 * start with nothing in any log to say which.
 *
 * These only record a warn diagnostic (which also lands in the backend's
 * errors.jsonl, so it outlives the restart); what the app does is unchanged.
 * Messages carry the workspace path and the pane name only.
 */
import type { RecordDiagnosticInput } from './uiDiagnostics'

export const PANE_RECORD_WRITE_FAILED = 'restore.pane-record-write-failed'
export const WORKSPACE_CHECK_GAVE_UP = 'restore.workspace-check-gave-up'

/** Waits for a pane record write and records a diagnostic when it failed
 *  (`null`, how sendQuiet reports a refusal or a timeout) or threw. */
export async function notePaneRecordWrite(
  write: Promise<unknown>,
  pane: { workspacePath: string; name: string; paneId: string },
  record: (entry: RecordDiagnosticInput) => void,
): Promise<void> {
  let failure = ''
  try {
    if ((await write) === null) failure = 'refused or timed out'
  } catch (err) {
    failure = err instanceof Error ? err.name : 'threw'
  }
  if (!failure) return
  record({
    level: 'warn',
    code: PANE_RECORD_WRITE_FAILED,
    message: `pane "${pane.name}" in ${pane.workspacePath}: its record was not saved (${failure}); it will not be restored after a restart`,
    paneId: pane.paneId,
  })
}

/** The diagnostic for a workspace check whose project.peek still failed after
 *  every retry: the window shows the workspace without restoring its panes. */
export function workspaceCheckGaveUp(workspacePath: string, attempts: number): RecordDiagnosticInput {
  return {
    level: 'warn',
    code: WORKSPACE_CHECK_GAVE_UP,
    message: `${workspacePath}: project.peek failed ${attempts} times; its panes were not restored`,
  }
}
