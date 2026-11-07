/**
 * Network of plugin views (PR C1, `permissions.network`): enforcement for
 * surfaces, and the activity record for every view.
 *
 * A view's network requests never pass through the capability broker, so the
 * declared hosts are enforced at the two places a view's traffic exists:
 *
 * - a composed **frame** (`navide-plugin-frame://`) carries a Content-Security-
 *   Policy whose `connect-src` admits exactly the declared hosts
 *   (pluginFrameAssetProtocol); the renderer refuses the rest and logs a
 *   `connect-src` refusal to the console;
 * - a **surface** (a `<webview>` guest or a native WebContentsView, loaded from
 *   the package directory) has no CSP, so the session's `webRequest`
 *   `onBeforeRequest` refuses a request to a host the package does not declare
 *   (`cancel: true`). A legacy (Manifest v1) descriptor has no declaration
 *   model and stays unfiltered; the dev server a view loads from in
 *   development is always admitted.
 *
 * Both paths are recorded as Activity rows under the address `network.<host>`
 * (host only, never a path, query or body): a completed request is `allowed`,
 * a failed one `error`, a refusal `denied` with the reason `undeclared`, the
 * same shape a refused broker call has, so the Activity page lists it under
 * "used but not declared". Nothing here can fail or delay a request that is
 * allowed: an observer that throws is caught and ignored.
 *
 * Every plugin surface shares the default session (pluginGuestAttach drops a
 * tag-sourced `partition`), and Electron allows one `webRequest` listener per
 * event per session, so each session is observed once and the requester is
 * attributed per request: a frame by its URL (a live mount names the package),
 * a surface by `webContentsId`. A request nothing attributes to a plugin is
 * left alone, because the Host's own windows share that session; what that
 * leaves open is bounded: a dedicated or shared worker of a surface runs in
 * the surface's renderer and carries its `webContentsId`, a page loaded from
 * `file:` or a custom scheme cannot register a service worker, and a frame
 * whose URL is a plugin frame origin but names no live mount (revoked, or
 * never mounted) is refused rather than trusted.
 */

import { networkHostMatches } from '../../shared/pluginDisclosureScan'
import type { PluginActivityRow } from './pluginActivity'
import { PLUGIN_FRAME_SCHEME, type PluginFrameAssetMount } from './pluginFrameAssetProtocol'

export const NETWORK_ACTIVITY_SOURCE = 'network'
const NETWORK_ADDRESS_PREFIX = 'network.'
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])
const CSP_CONNECT_REFUSAL =
  /^Refused to connect to '([^']+)' because it violates the following Content Security Policy directive: "connect-src/
/** The error Chromium reports for a request `onBeforeRequest` cancelled: it is
 *  already recorded as `denied`, so it is not an `error` row as well. */
const BLOCKED_BY_CLIENT = 'net::ERR_BLOCKED_BY_CLIENT'

/** The activity address of one host: `network.<host>`. */
export function networkActivityAddress(host: string): string {
  return `${NETWORK_ADDRESS_PREFIX}${host}`
}

/** The host of a request URL that leaves the view, or null for anything else
 *  (package assets, `navide-preview:` resources, data: and blob: URLs, an
 *  unparsable string). */
export function networkHostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (!NETWORK_SCHEMES.has(parsed.protocol) || !parsed.hostname) return null
    return parsed.hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Whether `host` is covered by the declared list (exact, or below a `*.` wildcard). */
export function hostDeclared(hosts: readonly string[], host: string): boolean {
  return hosts.some((declared) => networkHostMatches(declared, host))
}

function isPluginFrameUrl(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith(`${PLUGIN_FRAME_SCHEME}://`)
}

/** The host a `connect-src` refusal names, or null for any other console line. */
export function refusedConnectHost(message: string): string | null {
  const match = CSP_CONNECT_REFUSAL.exec(message)
  return match ? networkHostOf(match[1]) : null
}

/** The workspace a frame was opened for: the Host put it in the frame URL's
 *  query (`composePluginFrameQuery`). Empty when the URL carries none. */
export function frameWorkspaceOf(frameUrl: string | undefined): string {
  if (!frameUrl) return ''
  try {
    return new URL(frameUrl).searchParams.get('workspace_path') ?? ''
  } catch {
    return ''
  }
}

export interface NetworkActivityInput {
  pluginId: string
  packageVersion: string
  workspace: string
  host: string
  outcome: 'allowed' | 'denied' | 'error'
  at?: number
}

/** One network activity row. A refusal is always `undeclared`: a view is
 *  refused exactly the hosts its manifest does not declare. */
export function networkActivityRow(input: NetworkActivityInput): PluginActivityRow {
  return {
    plugin_id: input.pluginId,
    plugin_version: input.packageVersion,
    workspace: input.workspace,
    source: NETWORK_ACTIVITY_SOURCE,
    address: networkActivityAddress(input.host),
    outcome: input.outcome,
    ...(input.outcome === 'denied' ? { denied_reason: 'undeclared' as const } : {}),
    at: input.at ?? Date.now(),
    count: 1,
  }
}

// ── Electron seams, kept structural so the observer is testable without Electron ──

export interface ObservedFrame {
  url: string
}

export interface ObservedRequestDetails {
  url: string
  /** The frame that made the request; absent for a request without one. */
  frame?: ObservedFrame | null
  /** The contents that made the request; absent for a request without one. */
  webContentsId?: number
  /** onErrorOccurred: the network error. */
  error?: string
}

export interface ObservedWebRequest {
  onBeforeRequest(listener: (details: ObservedRequestDetails, callback: (response: { cancel?: boolean }) => void) => void): void
  onCompleted(listener: (details: ObservedRequestDetails) => void): void
  onErrorOccurred(listener: (details: ObservedRequestDetails) => void): void
}

export interface ObservedSession {
  webRequest: ObservedWebRequest
}

export interface ObservedConsoleMessage {
  level: string
  message: string
  frame: ObservedFrame | null
}

export interface ObservedWebContents {
  readonly session: ObservedSession
  on(event: 'console-message', listener: (event: ObservedConsoleMessage) => void): unknown
}

/** What the observer needs to know about a plugin surface making a request. */
export interface SurfaceNetworkPolicy {
  pluginId: string
  packageVersion: string
  workspace: string
  /** The declared hosts; null for a legacy descriptor, which is not filtered. */
  hosts: readonly string[] | null
  /** The dev server origin the entry loads from in development; always admitted. */
  devOrigin: string | null
}

export interface PluginFrameNetworkObserverDeps {
  /** The live mount a frame URL belongs to (PluginFrameAssetProtocol.mountOf). */
  mountOf(frameUrl: string | undefined): PluginFrameAssetMount | null
  /** The surface a webContents id belongs to, or null for any other contents. */
  surfaceOf(webContentsId: number | undefined): SurfaceNetworkPolicy | null
  record(row: PluginActivityRow): void
  now?: () => number
}

type Requester = SurfaceNetworkPolicy & { kind: 'frame' | 'surface' }

export class PluginFrameNetworkObserver {
  private readonly sessions = new WeakSet<ObservedSession>()
  private readonly contents = new WeakSet<ObservedWebContents>()

  constructor(private readonly deps: PluginFrameNetworkObserverDeps) {}

  /** Start observing the contents a plugin view runs in (a surface, or the
   *  receiver a frame was mounted into). Idempotent per contents and per session. */
  observe(webContents: ObservedWebContents): void {
    try {
      const session = webContents.session
      if (!this.sessions.has(session)) {
        this.sessions.add(session)
        session.webRequest.onBeforeRequest((details, callback) => callback(this.decide(details)))
        session.webRequest.onCompleted((details) => this.onRequest(details, 'allowed'))
        session.webRequest.onErrorOccurred((details) => this.onRequest(details, 'error'))
      }
      if (!this.contents.has(webContents)) {
        this.contents.add(webContents)
        webContents.on('console-message', (event) => this.onConsoleMessage(event))
      }
    } catch (error) {
      console.debug('[plugins] view network observer not attached:', error)
    }
  }

  /** Whether a request may proceed: anything that is not a plugin view's
   *  network request is left alone; a view's request to an undeclared host is
   *  cancelled and recorded as refused. Never throws (a failure allows). */
  decide(details: ObservedRequestDetails): { cancel?: boolean } {
    try {
      const host = networkHostOf(details.url)
      if (!host) return {}
      const requester = this.requesterOf(details)
      // A frame on the plugin frame scheme that no live mount names is a
      // revoked or forged origin: nothing vouches for it, so nothing leaves.
      if (!requester && isPluginFrameUrl(details.frame?.url)) return { cancel: true }
      if (!requester || requester.hosts === null) return {}
      if (requester.devOrigin && new URL(details.url).origin === requester.devOrigin) return {}
      if (hostDeclared(requester.hosts, host)) return {}
      this.deps.record(this.rowFor(requester, host, 'denied'))
      return { cancel: true }
    } catch (error) {
      console.debug('[plugins] view network request not judged:', error)
      return {}
    }
  }

  /** A request a view made and the network answered (or failed). */
  onRequest(details: ObservedRequestDetails, outcome: 'allowed' | 'error'): void {
    try {
      if (outcome === 'error' && details.error === BLOCKED_BY_CLIENT) return
      const host = networkHostOf(details.url)
      if (!host) return
      const requester = this.requesterOf(details)
      if (requester) this.deps.record(this.rowFor(requester, host, outcome))
    } catch (error) {
      console.debug('[plugins] view network request not recorded:', error)
    }
  }

  /** A `connect-src` refusal Chromium logged for a frame. */
  onConsoleMessage(event: ObservedConsoleMessage): void {
    try {
      if (event.level !== 'error') return
      const host = refusedConnectHost(event.message)
      if (!host) return
      const mount = this.deps.mountOf(event.frame?.url)
      if (mount) this.deps.record(this.rowFor(this.frameRequester(mount, event.frame?.url), host, 'denied'))
    } catch (error) {
      console.debug('[plugins] view network refusal not recorded:', error)
    }
  }

  private requesterOf(details: ObservedRequestDetails): Requester | null {
    const mount = this.deps.mountOf(details.frame?.url)
    if (mount) return this.frameRequester(mount, details.frame?.url)
    const surface = this.deps.surfaceOf(details.webContentsId)
    return surface ? { ...surface, kind: 'surface' } : null
  }

  private frameRequester(mount: PluginFrameAssetMount, frameUrl: string | undefined): Requester {
    return {
      kind: 'frame',
      pluginId: mount.packageId,
      packageVersion: mount.packageVersion,
      workspace: frameWorkspaceOf(frameUrl),
      hosts: mount.connectHosts ?? [],
      devOrigin: null,
    }
  }

  private rowFor(requester: Requester, host: string, outcome: NetworkActivityInput['outcome']): PluginActivityRow {
    return networkActivityRow({
      pluginId: requester.pluginId,
      packageVersion: requester.packageVersion,
      workspace: requester.workspace,
      host,
      outcome,
      at: this.deps.now?.() ?? Date.now(),
    })
  }
}
