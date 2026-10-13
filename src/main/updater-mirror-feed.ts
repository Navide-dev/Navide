import type { UpdaterClient } from './updater-service'

/**
 * Release files are published twice: on the GitHub Release (electron-updater's
 * `github` provider, configured at build time) and on dl.navide.dev, a
 * CloudFront mirror of the same bytes written by the release workflow
 * (.github/workflows/mirror.yml). GitHub serves its assets through
 * release-assets.githubusercontent.com, which some networks filter or crawl
 * at tens of KB/s, and which hands out one-hour signed URLs a slow line cannot
 * finish a 200 MB installer inside. So, like the download button on
 * navide.dev, the app takes the mirror first and keeps GitHub as the fallback
 * for when the mirror cannot be reached.
 *
 * electron-updater holds one provider at a time, but `setFeedURL` swaps it at
 * runtime. This wrapper sits between the service and the real updater:
 *
 * - On construction it points the feed at the mirror's `generic` provider.
 * - `checkForUpdates` tries the mirror; on a network-shaped failure it switches
 *   the feed to GitHub and checks again.
 * - `downloadUpdate` does the same, then re-checks on GitHub first so the
 *   download uses GitHub's file list rather than the mirror's URLs.
 * - Once switched, GitHub stays the feed for the rest of the session.
 *
 * electron-updater emits `'error'` *before* rejecting, and the service reacts to
 * that event by settling into an error state — which would make the retry's
 * success invisible. So while a mirror attempt is in flight its error events
 * are held back; they are replayed only when the failure is one GitHub
 * cannot help with, and dropped when the fallback takes over.
 */

export const MIRROR_FEED_URL = 'https://dl.navide.dev/releases/latest'

/**
 * The GitHub Release feed — the same `publish` block package.json hands
 * electron-builder, restated here because electron-updater offers no public
 * way to read the app-update.yml it loaded at startup back out.
 */
export const GITHUB_FEED = { provider: 'github', owner: 'Navide-dev', repo: 'Navide' } as const

/**
 * Failures that mean "could not reach or be served by the mirror". A 404 or a
 * signature/checksum error is left alone: GitHub carries the same files, so it
 * would fail the same way, and hiding that helps nobody.
 */
const NETWORK_FAILURE =
  /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|net::ERR_|timed? ?out|HttpError: (5\d\d|429)|status code (5\d\d|429)/i

export function isNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return NETWORK_FAILURE.test(message)
}

/** The slice of electron-updater's AppUpdater this wrapper needs. */
export interface MirrorCapableUpdater extends UpdaterClient {
  channel?: string | null
  setFeedURL(options: FeedOptions): void
}

export type FeedOptions =
  | { provider: 'generic'; url: string; channel?: string }
  | { provider: 'github'; owner: string; repo: string }

type ErrorListener = (error: Error) => void

export interface MirrorFeedOptions {
  url?: string
  fallback?: FeedOptions
  log?: (message: string) => void
}

export function withMirrorFeed(updater: MirrorCapableUpdater, options: MirrorFeedOptions = {}): UpdaterClient {
  const url = options.url ?? MIRROR_FEED_URL
  const fallback = options.fallback ?? GITHUB_FEED
  const log = options.log ?? ((message: string) => console.warn('[updater]', message))

  updater.setFeedURL({ provider: 'generic', url, channel: updater.channel ?? 'latest' })
  let usingFallback = false
  // While a mirror attempt is in flight, its error events land here instead
  // of reaching the service. `null` means "not holding" — pass through.
  let held: Error[] | null = null
  const errorListeners: ErrorListener[] = []

  updater.on('error', (error: Error) => {
    if (held) {
      held.push(error)
      return
    }
    for (const listener of errorListeners) listener(error)
  })

  const replayHeld = (): void => {
    const errors = held ?? []
    held = null
    for (const error of errors) for (const listener of errorListeners) listener(error)
  }

  const switchToFallback = (reason: string): void => {
    usingFallback = true
    log(`mirror update feed ${url} failed (${reason}); switching to ${fallback.provider}`)
    updater.setFeedURL(fallback)
  }

  /**
   * Run `attempt` against the mirror with error events held. Returns the
   * result, or — for a network failure — switches feeds and returns
   * `undefined` so the caller can retry. Any other failure is replayed to the
   * service's listeners and rethrown, exactly as without this wrapper.
   */
  const tryMirror = async <T>(attempt: () => Promise<T>): Promise<T | undefined> => {
    held = []
    try {
      const result = await attempt()
      replayHeld()
      return result
    } catch (error) {
      if (!isNetworkFailure(error)) {
        replayHeld()
        throw error
      }
      held = null
      switchToFallback(error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  const client: UpdaterClient = {
    get autoDownload() {
      return updater.autoDownload
    },
    set autoDownload(value: boolean) {
      updater.autoDownload = value
    },
    get autoInstallOnAppQuit() {
      return updater.autoInstallOnAppQuit
    },
    set autoInstallOnAppQuit(value: boolean) {
      updater.autoInstallOnAppQuit = value
    },
    on(event: string, listener: (...args: never[]) => unknown): unknown {
      if (event === 'error') {
        errorListeners.push(listener as ErrorListener)
        return client
      }
      return (updater.on as (event: string, listener: unknown) => unknown)(event, listener)
    },
    async checkForUpdates() {
      if (usingFallback) return updater.checkForUpdates()
      const result = await tryMirror(() => updater.checkForUpdates())
      if (result !== undefined) return result
      return updater.checkForUpdates()
    },
    async downloadUpdate() {
      if (usingFallback) return updater.downloadUpdate()
      const result = await tryMirror(() => updater.downloadUpdate())
      if (result !== undefined) return result
      // The pending update info still names the mirror's files; a check on
      // GitHub replaces it with GitHub's before the download starts.
      await updater.checkForUpdates()
      return updater.downloadUpdate()
    },
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
      updater.quitAndInstall(isSilent, isForceRunAfter)
    },
  } as UpdaterClient

  return client
}
