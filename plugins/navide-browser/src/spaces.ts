export type SpaceOwner = 'agent' | 'user'
export type SpaceState = 'idle' | 'running' | 'need-action' | 'done'

/** A JavaScript dialog open in the page (message at most 500 characters). */
export interface WebViewDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
}

/** One file the agent uploaded into the page, as the Host checked it. */
export interface WebViewUpload {
  /** Path relative to the pane's workspace. */
  file: string
  origin: string
  sensitive: boolean
  /** ISO 8601 time. */
  at: string
}

/** One Host web view (f38238 §9.2): one tab. A Space is every view that
 *  shares its `space` name. */
export interface WebViewInfo {
  viewId: string
  space: string
  owner: SpaceOwner
  control: SpaceOwner
  state: SpaceState
  note?: string
  url: string
  title: string
  loading: boolean
  attached: boolean
  /** The agent ran script in the page since it last loaded a new document. */
  agentScriptSinceLoad: boolean
  /** The tab whose window.open created this one. */
  openerViewId?: string
  dialog?: WebViewDialog
  uploads?: WebViewUpload[]
}

const OWNERS = new Set<unknown>(['agent', 'user'])
const STATES = new Set<unknown>(['idle', 'running', 'need-action', 'done'])
const DIALOG_TYPES = new Set<unknown>(['alert', 'confirm', 'prompt', 'beforeunload'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDialog(value: unknown): WebViewDialog | null {
  if (!isRecord(value) || !DIALOG_TYPES.has(value.type)) return null
  return { type: value.type as WebViewDialog['type'], message: typeof value.message === 'string' ? value.message : '' }
}

function parseUploads(value: unknown): WebViewUpload[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).filter((upload) => typeof upload.file === 'string' && upload.file).map((upload) => ({
    file: upload.file as string,
    origin: typeof upload.origin === 'string' ? upload.origin : '',
    sensitive: upload.sensitive === true,
    at: typeof upload.at === 'string' ? upload.at : '',
  }))
}

function parseView(value: unknown): WebViewInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const view = value as Record<string, unknown>
  if (typeof view.viewId !== 'string' || !view.viewId) return null
  if (!OWNERS.has(view.owner) || !OWNERS.has(view.control) || !STATES.has(view.state)) return null
  return {
    viewId: view.viewId,
    space: typeof view.space === 'string' ? view.space : '',
    owner: view.owner as SpaceOwner,
    control: view.control as SpaceOwner,
    state: view.state as SpaceState,
    ...(typeof view.note === 'string' && view.note ? { note: view.note } : {}),
    url: typeof view.url === 'string' ? view.url : '',
    title: typeof view.title === 'string' ? view.title : '',
    loading: view.loading === true,
    attached: view.attached === true,
    agentScriptSinceLoad: view.agentScriptSinceLoad === true,
    ...(typeof view.openerViewId === 'string' && view.openerViewId ? { openerViewId: view.openerViewId } : {}),
    ...(parseDialog(view.dialog) ? { dialog: parseDialog(view.dialog)! } : {}),
    ...(parseUploads(view.uploads).length > 0 ? { uploads: parseUploads(view.uploads) } : {}),
  }
}

/** The "agent script may still run" banner: the user controls a page the
 *  agent ran script in, and has not chosen to keep that page as it is. */
export function showsAgentScriptWarning(view: WebViewInfo | null, kept: ReadonlySet<string>): boolean {
  return view !== null && view.control === 'user' && view.agentScriptSinceLoad && !kept.has(view.viewId)
}

/** The pages the user kept that still hold agent script; a new document
 *  ends the choice, so the banner returns the next time it applies. */
export function keptPages(views: readonly WebViewInfo[], kept: ReadonlySet<string>): Set<string> {
  return new Set(views.filter((view) => view.agentScriptSinceLoad && kept.has(view.viewId)).map((view) => view.viewId))
}

/** Keep every well-formed view; drop anything else rather than guess. */
export function parseViews(value: unknown): WebViewInfo[] {
  if (!Array.isArray(value)) return []
  return value.map(parseView).filter((view): view is WebViewInfo => view !== null)
}

const STATE_ORDER: Record<SpaceState, number> = { 'need-action': 0, running: 1, idle: 2, done: 3 }

/** The user's own Spaces first (pinned), then the agents' by urgency. */
export function sortSpaces(views: readonly WebViewInfo[]): WebViewInfo[] {
  return [...views].sort((a, b) => {
    if (a.owner !== b.owner) return a.owner === 'user' ? -1 : 1
    return STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.space.localeCompare(b.space)
  })
}

export function pendingCount(views: readonly WebViewInfo[]): number {
  return views.filter((view) => view.state === 'need-action').length
}

export function stateLabelKey(state: SpaceState): string {
  return `browser.state.${state}`
}

/** Turn what was typed in the address bar into an http(s) URL, or null. */
export function normalizeAddress(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).href
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^:/]+:\d+(\/|$)/.test(text)) return null
  try {
    return new URL(`https://${text}`).href
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Spaces with tabs (0.2.35)
// ---------------------------------------------------------------------------

/** A tab the plugin closed to free memory; restored from its URL on demand. */
export interface DiscardedTab {
  id: string
  space: string
  owner: SpaceOwner
  url: string
  title: string
  thumbnail: string | null
}

/** One Space: every live tab and discarded tab sharing a `space` name. */
export interface BrowserSpace {
  key: string
  name: string
  /** The owner of the Space's first tab. */
  owner: SpaceOwner
  /** The most urgent state of any tab. */
  state: SpaceState
  tabs: WebViewInfo[]
  discarded: DiscardedTab[]
}

/** The grouping key: a nameless view is a Space of its own. */
export function spaceKey(view: Pick<WebViewInfo, 'space' | 'viewId'>): string {
  return view.space ? `space:${view.space}` : `view:${view.viewId}`
}

/** Host order, with each popup right after its opener (and the opener's
 *  earlier popups), so a page opened from a tab sits next to it. */
export function orderTabs(tabs: readonly WebViewInfo[]): WebViewInfo[] {
  const ids = new Set(tabs.map((tab) => tab.viewId))
  const children = new Map<string, WebViewInfo[]>()
  const roots: WebViewInfo[] = []
  for (const tab of tabs) {
    if (tab.openerViewId && tab.openerViewId !== tab.viewId && ids.has(tab.openerViewId)) {
      children.set(tab.openerViewId, [...(children.get(tab.openerViewId) ?? []), tab])
    } else {
      roots.push(tab)
    }
  }
  const ordered: WebViewInfo[] = []
  const seen = new Set<string>()
  const visit = (tab: WebViewInfo): void => {
    if (seen.has(tab.viewId)) return
    seen.add(tab.viewId)
    ordered.push(tab)
    for (const child of children.get(tab.viewId) ?? []) visit(child)
  }
  roots.forEach(visit)
  // An opener cycle has no root; keep its tabs rather than lose them.
  tabs.forEach(visit)
  return ordered
}

/** Group views into Spaces: the user's first, then the agents' by urgency. */
export function groupSpaces(views: readonly WebViewInfo[], discarded: readonly DiscardedTab[] = []): BrowserSpace[] {
  const groups = new Map<string, BrowserSpace>()
  const group = (key: string, name: string, owner: SpaceOwner): BrowserSpace => {
    let space = groups.get(key)
    if (!space) {
      space = { key, name, owner, state: 'done', tabs: [], discarded: [] }
      groups.set(key, space)
    }
    return space
  }
  for (const view of views) group(spaceKey(view), view.space, view.owner).tabs.push(view)
  for (const tab of discarded) group(spaceKey({ space: tab.space, viewId: tab.id }), tab.space, tab.owner).discarded.push(tab)
  const spaces = [...groups.values()]
  for (const space of spaces) {
    space.tabs = orderTabs(space.tabs)
    const states = space.tabs.map((tab) => tab.state)
    space.state = states.length === 0 ? 'idle' : states.reduce((a, b) => (STATE_ORDER[b] < STATE_ORDER[a] ? b : a))
  }
  return spaces.sort((a, b) => {
    if (a.owner !== b.owner) return a.owner === 'user' ? -1 : 1
    return STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
  })
}

/** The tab a Space shows: the remembered one while it exists, else its first. */
export function activeTabId(space: BrowserSpace, remembered: string | undefined): string | null {
  if (remembered && (space.tabs.some((tab) => tab.viewId === remembered) || space.discarded.some((tab) => tab.id === remembered))) {
    return remembered
  }
  return space.tabs[0]?.viewId ?? space.discarded[0]?.id ?? null
}

/** Tiles at once in the tiled mode: a 3×3 grid, the Host's attach cap. */
export const MAX_TILES = 9

/** Columns and rows for `count` tiles: the most square grid that fits them. */
export function tileGrid(count: number): { cols: number; rows: number } {
  const n = Math.min(Math.max(1, count), MAX_TILES)
  const cols = Math.ceil(Math.sqrt(n))
  return { cols, rows: Math.ceil(n / cols) }
}

/** A hidden tab is discarded after this long without being shown. */
export const DISCARD_AFTER_MS = 10 * 60 * 1000

/** Whether a tab may be closed to free memory now. Never one on screen, one
 *  with an open dialog, one waiting for the user, or an agent's tab that is
 *  still working; an agent's tab only once it is done or idle. */
export function mayDiscard(view: WebViewInfo, lastShownAt: number | undefined, now: number, visible: boolean): boolean {
  if (visible || lastShownAt === undefined || now - lastShownAt < DISCARD_AFTER_MS) return false
  if (view.dialog || view.state === 'need-action' || view.state === 'running') return false
  if (view.owner === 'agent') return view.state === 'done' || view.state === 'idle'
  return true
}

/** Every upload in a Space, newest first, with the tab it went through. */
export function spaceUploads(space: BrowserSpace): Array<WebViewUpload & { viewId: string }> {
  return space.tabs
    .flatMap((tab) => (tab.uploads ?? []).map((upload) => ({ ...upload, viewId: tab.viewId })))
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** The direction of a Ctrl+Tab style keystroke, from the Navide pane
 *  cycling commands, or 0 for any other command. */
export function cycleDirection(command: string | null | undefined): 1 | -1 | 0 {
  if (command === 'workbench.action.focusNextPane') return 1
  if (command === 'workbench.action.focusPreviousPane') return -1
  return 0
}

export type LayoutMode = 'tiled' | 'switch'

export function parseLayoutMode(value: unknown): LayoutMode {
  return value === 'switch' ? 'switch' : 'tiled'
}
