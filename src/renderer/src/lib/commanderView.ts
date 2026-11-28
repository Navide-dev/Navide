// Display helpers shared by the commander list, detail modal and pane chips.
import type { CommanderState } from './commander'

/** The CSS class that colours a state's dot and chip (CommanderList.vue's global block). */
export function commanderStateClass(state: CommanderState | string): string {
  return `is-${state}`
}

/** A folder's last path segment, for "Workspace <name>". */
export function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

/** Unix seconds → local "MM/DD HH:MM". */
export function formatCommanderTime(seconds: number): string {
  if (!seconds) return ''
  const d = new Date(seconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
