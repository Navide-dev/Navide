// The user's action buttons: userData/workbench.json. Plain data, never code:
// a step names an action from the registry, and the Host draws the button.
//
// A step has no args, on purpose. An agent with a shell can write this file, so
// args would let a button labelled anything call ui.settings.yolo with yolo
// true on the user's click. Which actions may run is decided where they run
// (runWorkbenchButton), since the file itself is not trusted.

export interface WorkbenchStep {
  action: string
}

export interface WorkbenchButton {
  id: string
  label: string
  steps: WorkbenchStep[]
}

export interface WorkbenchConfig {
  schemaVersion: 1
  /** The whole bar is hidden; the buttons stay in the file. */
  hidden: boolean
  buttons: WorkbenchButton[]
}

export const MAX_WORKBENCH_BUTTONS = 12
export const MAX_WORKBENCH_LABEL = 24
export const MAX_WORKBENCH_STEPS = 8

export const EMPTY_WORKBENCH: WorkbenchConfig = Object.freeze({
  schemaVersion: 1,
  hidden: false,
  buttons: Object.freeze([]) as unknown as WorkbenchButton[],
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStep(raw: unknown): WorkbenchStep | null {
  if (!isRecord(raw) || typeof raw.action !== 'string' || !raw.action) return null
  return { action: raw.action }
}

function parseButton(raw: unknown): WorkbenchButton | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.label !== 'string') return null
  const label = raw.label.trim()
  if (!label || label.length > MAX_WORKBENCH_LABEL || /[\r\n<>]/.test(label)) return null
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > MAX_WORKBENCH_STEPS) return null
  const steps = raw.steps.map(parseStep)
  if (steps.some((step) => step === null)) return null
  return { id: raw.id, label, steps: steps as WorkbenchStep[] }
}

/** Tolerant, like the keybindings reader: the file is user-editable, so a bad
 *  entry is dropped and counted rather than costing the rest. Text that is not
 *  a config at all reads as empty. */
export function parseWorkbench(text: string): { config: WorkbenchConfig; dropped: number } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { config: EMPTY_WORKBENCH, dropped: 0 }
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.buttons)) {
    return { config: EMPTY_WORKBENCH, dropped: 0 }
  }
  const seen = new Set<string>()
  const buttons: WorkbenchButton[] = []
  let dropped = 0
  for (const item of raw.buttons) {
    const button = parseButton(item)
    if (!button || seen.has(button.id) || buttons.length >= MAX_WORKBENCH_BUTTONS) dropped++
    else {
      seen.add(button.id)
      buttons.push(button)
    }
  }
  return { config: { schemaVersion: 1, hidden: raw.hidden === true, buttons }, dropped }
}
