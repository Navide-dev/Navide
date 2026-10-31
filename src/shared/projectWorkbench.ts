// .navide/workbench.json: what a project suggests for its Navide workbench.
//
// Anyone who can commit to the repository can write this file, so it is
// untrusted input. It holds data only, and a step has no args. The parser is
// strict: a file it refuses has no effect at all, so a typo cannot half apply.

export type ProjectLayoutMode = 'auto' | 'grid' | 'spotlight' | 'fullscreen'

export interface ProjectWorkbenchPlugin {
  id: string
  version?: string
}

export interface ProjectWorkbenchButton {
  id: string
  label: string
  steps: { action: string }[]
}

export interface ProjectWorkbench {
  schemaVersion: 1
  layoutMode?: ProjectLayoutMode
  plugins?: ProjectWorkbenchPlugin[]
  buttons?: ProjectWorkbenchButton[]
}

const LAYOUT_MODES: readonly string[] = ['auto', 'grid', 'spotlight', 'fullscreen']
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const MAX_PLUGINS = 32
const MAX_BUTTONS = 12
const MAX_LABEL = 24
const MAX_STEPS = 8
const MAX_TEXT = 128

function fail(message: string): never {
  throw new Error(`workbench.json: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has unknown field '${key}'`)
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEXT) fail(`${label} must be text`)
  return value
}

function parsePlugin(raw: unknown, index: number): ProjectWorkbenchPlugin {
  const label = `plugins[${index}]`
  if (!isRecord(raw)) fail(`${label} must be an object`)
  onlyKeys(raw, ['id', 'version'], label)
  const id = text(raw.id, `${label}.id`)
  if (!PLUGIN_ID.test(id)) fail(`${label}.id is not a plugin id`)
  return raw.version === undefined ? { id } : { id, version: text(raw.version, `${label}.version`) }
}

function parseButton(raw: unknown, index: number): ProjectWorkbenchButton {
  const at = `buttons[${index}]`
  if (!isRecord(raw)) fail(`${at} must be an object`)
  onlyKeys(raw, ['id', 'label', 'steps'], at)
  const label = text(raw.label, `${at}.label`).trim()
  if (!label || label.length > MAX_LABEL || /[\r\n<>]/.test(label)) fail(`${at}.label is not a safe label`)
  if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > MAX_STEPS) {
    fail(`${at}.steps must hold 1-${MAX_STEPS} steps`)
  }
  const steps = raw.steps.map((step, stepIndex) => {
    const stepAt = `${at}.steps[${stepIndex}]`
    if (!isRecord(step)) fail(`${stepAt} must be an object`)
    onlyKeys(step, ['action'], stepAt)
    return { action: text(step.action, `${stepAt}.action`) }
  })
  return { id: text(raw.id, `${at}.id`), label, steps }
}

/** Throws on anything it does not fully understand. */
export function parseProjectWorkbench(content: string): ProjectWorkbench {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    fail('not valid JSON')
  }
  if (!isRecord(raw)) fail('must be a JSON object')
  onlyKeys(raw, ['schemaVersion', 'layoutMode', 'plugins', 'buttons'], 'the file')
  if (raw.schemaVersion !== 1) fail('schemaVersion must be 1')
  const workbench: ProjectWorkbench = { schemaVersion: 1 }
  if (raw.layoutMode !== undefined) {
    if (typeof raw.layoutMode !== 'string' || !LAYOUT_MODES.includes(raw.layoutMode)) fail('layoutMode is not a layout mode')
    workbench.layoutMode = raw.layoutMode as ProjectLayoutMode
  }
  if (raw.plugins !== undefined) {
    if (!Array.isArray(raw.plugins) || raw.plugins.length > MAX_PLUGINS) fail(`plugins must hold at most ${MAX_PLUGINS} entries`)
    workbench.plugins = raw.plugins.map(parsePlugin)
  }
  if (raw.buttons !== undefined) {
    if (!Array.isArray(raw.buttons) || raw.buttons.length > MAX_BUTTONS) fail(`buttons must hold at most ${MAX_BUTTONS} entries`)
    workbench.buttons = raw.buttons.map(parseButton)
    if (new Set(workbench.buttons.map((button) => button.id)).size !== workbench.buttons.length) fail('button ids must be unique')
  }
  return workbench
}

export type ProjectWorkbenchStatus =
  /** No file: everything behaves as if this feature did not exist. */
  | 'none'
  | 'invalid'
  | 'unavailable'
  /** A valid file the user has not accepted. */
  | 'pending'
  | 'accepted'
  /** The file changed after it was accepted. Nothing from it applies. */
  | 'stale'

export interface ProjectWorkbenchSnapshot {
  status: ProjectWorkbenchStatus
  fingerprint: string | null
  /** What the file says, to review. Applies to nothing on its own. */
  recommendation: ProjectWorkbench | null
  /** What applies: only ever an accepted file, unchanged since. */
  active: ProjectWorkbench | null
  /** This fingerprint has not been raised with the user yet. */
  shouldNotify: boolean
}

export type ProjectWorkbenchResult =
  | { ok: true; snapshot: ProjectWorkbenchSnapshot }
  | { ok: false; reason: 'stale' | 'unavailable'; snapshot: ProjectWorkbenchSnapshot }
