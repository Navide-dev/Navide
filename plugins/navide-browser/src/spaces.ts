export type SpaceOwner = 'agent' | 'user'
export type SpaceState = 'idle' | 'running' | 'need-action' | 'done'

/** One Host web view (f38238 §9.2). A Space is one view. */
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
}

const OWNERS = new Set<unknown>(['agent', 'user'])
const STATES = new Set<unknown>(['idle', 'running', 'need-action', 'done'])

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
