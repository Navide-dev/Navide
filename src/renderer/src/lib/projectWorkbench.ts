// What this project's .navide/workbench.json adds to the workbench. The file is
// untrusted: the main process hands over `active` only for content the user
// accepted, and a button from it still runs through runWorkbenchButton, which
// checks every step. With no file every value here stays empty.
import { computed, shallowRef } from 'vue'
import type { ProjectWorkbenchResult, ProjectWorkbenchSnapshot } from '../../../shared/projectWorkbench'
import type { WorkbenchButton } from '../../../shared/workbench'
import { workbench } from './workbench'

const NO_PROJECT: ProjectWorkbenchSnapshot = {
  status: 'none', fingerprint: null, recommendation: null, active: null, shouldNotify: false,
}

export const projectWorkbench = shallowRef<ProjectWorkbenchSnapshot>(NO_PROJECT)
/** The folder's name: how the bar says where a button came from. */
export const projectName = shallowRef('')

/** The buttons of the accepted file. Hiding the bar hides these too. */
export const visibleProjectButtons = computed<WorkbenchButton[]>(() =>
  (workbench.value.hidden ? [] : projectWorkbench.value.active?.buttons ?? []))

/** There is something here for the user to decide or to know about. */
export const projectWorkbenchNeedsReview = computed(() =>
  ['pending', 'stale', 'invalid', 'unavailable'].includes(projectWorkbench.value.status))

let reading = 0

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/** Reads the file again. A reply that lost the race to a newer read is dropped,
 *  so a project switch can never leave the last project's buttons on screen. */
export async function refreshProjectWorkbench(): Promise<ProjectWorkbenchSnapshot> {
  const turn = ++reading
  let next = NO_PROJECT
  try {
    next = (await window.agentTeam?.workbenchProject?.inspect()) ?? NO_PROJECT
  } catch {
    // A window this does not apply to. Nothing applies, which is the safe reading.
  }
  if (turn === reading) projectWorkbench.value = next
  return next
}

/** The reminder goes up once for each content: the fingerprint is recorded
 *  first, so a failed write can only cost a reminder, never repeat one forever. */
async function remindOnce(
  snapshot: ProjectWorkbenchSnapshot,
  remind: (status: ProjectWorkbenchSnapshot['status']) => void,
): Promise<void> {
  if (!snapshot.shouldNotify || !snapshot.fingerprint) return
  const result = await window.agentTeam?.workbenchProject?.markNotified(snapshot.fingerprint)
  if (result?.ok) {
    projectWorkbench.value = result.snapshot
    remind(snapshot.status)
  }
}

export async function syncProjectWorkbench(
  workspacePath: string,
  remind: (status: ProjectWorkbenchSnapshot['status']) => void,
): Promise<void> {
  projectName.value = folderName(workspacePath)
  await remindOnce(await refreshProjectWorkbench(), remind)
}

async function settle(call: Promise<ProjectWorkbenchResult> | undefined): Promise<ProjectWorkbenchResult['ok'] | string> {
  const result = await call
  if (!result) return 'unavailable'
  projectWorkbench.value = result.snapshot
  return result.ok ? true : result.reason
}

/** Answers true, or why it was refused. */
export function acceptProjectWorkbench(fingerprint: string): Promise<boolean | string> {
  return settle(window.agentTeam?.workbenchProject?.accept(fingerprint))
}

export function revokeProjectWorkbench(): Promise<boolean | string> {
  return settle(window.agentTeam?.workbenchProject?.revoke())
}
