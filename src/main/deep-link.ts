// Routes navide:// links (macOS `open-url`, Windows/Linux argv on launch or
// `second-instance`) to a main window's Settings → Marketplace detail page.
//
// A link can arrive before any window exists (cold start) or while the only
// window is still loading, so targets queue here until a renderer says it is
// ready to show them. The queue is bounded and de-duplicated, and a burst of the
// same link opens the page once: a hostile page firing links in a loop must not
// be able to flood the app. Nothing here installs anything — the renderer only
// opens the detail view, where the user still has to press Install and pass the
// trust dialog (decision D4).
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  DEEP_LINK_OPEN_CHANNEL,
  DEEP_LINK_PUBLISH_CHANNEL,
  DEEP_LINK_READY_CHANNEL,
  isPublishDeepLink,
  parseDeepLink,
  parsePublishDeepLink,
  type DeepLinkTarget,
} from '../shared/deepLink'

export const MAX_PENDING_DEEP_LINKS = 8
/** The same link again within this window is a repeat, not a new request. */
export const DEEP_LINK_REPEAT_MS = 1500
/** How many recent ids the repeat check remembers (oldest dropped first). */
export const MAX_RECENT_DEEP_LINKS = 16

export interface DeepLinkRouterDeps {
  /** The ready renderer that should show a link now, or null when none is. */
  pickTarget: (ready: ReadonlySet<number>) => WebContents | null
  /** Bring the window hosting `contents` to the front. */
  reveal: (contents: WebContents) => void
  /** Make sure some main window exists / is loading (it will call ready). */
  ensureWindow: () => void
  log: (message: string) => void
  now?: () => number
}

export interface DeepLinkRouter {
  handle: (url: unknown) => void
  ready: (contents: WebContents) => DeepLinkTarget[]
  /** Test/diagnostic view of the queue. */
  pending: () => readonly DeepLinkTarget[]
}

function idOf(t: DeepLinkTarget): string {
  return isPublishDeepLink(t) ? `publish:${t.path}` : `${t.namespace}.${t.name}`
}

// Logged, never echoed back anywhere: trimmed and JSON-quoted so control bytes
// in a hostile link cannot forge log lines.
function describe(url: unknown): string {
  return typeof url === 'string' ? JSON.stringify(url.slice(0, 80)) : typeof url
}

export function createDeepLinkRouter(deps: DeepLinkRouterDeps): DeepLinkRouter {
  const now = deps.now ?? Date.now
  const queue: DeepLinkTarget[] = []
  const readyIds = new Set<number>()
  // id → when it was last accepted. Per id, so alternating links (A, B, A, B)
  // are each suppressed within the window too; bounded, insertion-ordered.
  const recent = new Map<string, number>()

  function handle(url: unknown): void {
    // A publish link only opens the publish form with that package (W3).
    const publish = parsePublishDeepLink(url)
    const parsed = publish.ok ? publish : parseDeepLink(url)
    if (!parsed.ok) {
      deps.log(`[deeplink] rejected ${describe(url)}: ${parsed.reason}`)
      return
    }
    const target: DeepLinkTarget = parsed.target
    const id = idOf(target)
    const at = now()
    const seen = recent.get(id)
    if (seen !== undefined && at - seen < DEEP_LINK_REPEAT_MS) {
      deps.log(`[deeplink] ignored repeat of ${id}`)
      return
    }
    recent.delete(id)
    recent.set(id, at)
    if (recent.size > MAX_RECENT_DEEP_LINKS) recent.delete(recent.keys().next().value as string)
    const contents = deps.pickTarget(readyIds)
    if (contents && !contents.isDestroyed()) {
      deps.log(isPublishDeepLink(target) ? '[deeplink] open publish form' : `[deeplink] open extension ${id}`)
      contents.send(isPublishDeepLink(target) ? DEEP_LINK_PUBLISH_CHANNEL : DEEP_LINK_OPEN_CHANNEL, target)
      deps.reveal(contents)
      return
    }
    if (queue.some((t) => idOf(t) === id)) return
    if (queue.length >= MAX_PENDING_DEEP_LINKS) {
      deps.log(`[deeplink] queue full, dropped ${id}`)
      return
    }
    deps.log(`[deeplink] queued ${id} until a window is ready`)
    queue.push(target)
    deps.ensureWindow()
  }

  function ready(contents: WebContents): DeepLinkTarget[] {
    if (!readyIds.has(contents.id)) {
      readyIds.add(contents.id)
      contents.once('destroyed', () => readyIds.delete(contents.id))
    }
    const drained = queue.splice(0, queue.length)
    if (drained.length) deps.reveal(contents)
    return drained
  }

  return { handle, ready, pending: () => [...queue] }
}

/** Wire the router's ready handshake; only main-window renderers may take links. */
export function registerDeepLinkIpc(
  router: DeepLinkRouter,
  isMainRenderer: (contents: WebContents) => boolean
): void {
  ipcMain.handle(DEEP_LINK_READY_CHANNEL, (event: IpcMainInvokeEvent) =>
    isMainRenderer(event.sender) ? router.ready(event.sender) : []
  )
}
