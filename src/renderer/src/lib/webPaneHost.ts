// Web panes (src/shared/webPaneSites.ts): which ones keep a live <webview>.
//
// A web pane's <webview> is a whole renderer process (200–520 MB each in the
// webpane spike), so only a few are kept loaded. A pane not focused for the
// idle window is unloaded, and opening one more than the active limit unloads
// the least recently used. Unloading removes the <webview> only: the pane's
// frame stays, and the site's persistent partition keeps the sign-in, so
// clicking the pane loads it again still signed in.
import { reactive } from 'vue'
import { isWebPaneSameSite, type WebPaneSite } from '../../../shared/webPaneSites'

export const WEB_PANE_IDLE_SETTING_KEY = 'agentTeam.webPane.idleUnloadMinutes'
export const WEB_PANE_IDLE_DEFAULT = 10
export const WEB_PANE_IDLE_MIN = 1
export const WEB_PANE_IDLE_MAX = 240
export const WEB_PANE_LIMIT_SETTING_KEY = 'agentTeam.webPane.activeLimit'
export const WEB_PANE_LIMIT_DEFAULT = 3
export const WEB_PANE_LIMIT_MIN = 1
export const WEB_PANE_LIMIT_MAX = 10

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function clampWebPaneIdleMinutes(value: unknown): number {
  return clampInt(value, WEB_PANE_IDLE_MIN, WEB_PANE_IDLE_MAX, WEB_PANE_IDLE_DEFAULT)
}

export function clampWebPaneLimit(value: unknown): number {
  return clampInt(value, WEB_PANE_LIMIT_MIN, WEB_PANE_LIMIT_MAX, WEB_PANE_LIMIT_DEFAULT)
}

export type WebPaneLoginState = 'signed-out' | 'signed-in'

const SIGN_IN_HOST = /^(accounts|auth|login|signin)\./i
const SIGN_IN_PATH = /\/(log-?in|sign-?in|sign-?up|auth)(\/|$)/i

/** Read from the page the pane is on, not from any cookie: a sign-in page —
 *  the site's own login path, a sign-in host, or another site's page (an
 *  identity provider mid-OAuth) — means signed out; anything else on the site
 *  means signed in. A heuristic, shown as a hint in the pane header. */
export function webPaneLoginState(site: WebPaneSite, url: string): WebPaneLoginState {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'signed-out'
  }
  if (!isWebPaneSameSite(site, url)) return 'signed-out'
  return SIGN_IN_HOST.test(u.hostname) || SIGN_IN_PATH.test(u.pathname) ? 'signed-out' : 'signed-in'
}

/** Google's account pages, where sign-in in an embedded browser may be refused
 *  after the email step ("This browser or app may not be secure"). */
export function isGoogleSignInUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'accounts.google.com'
  } catch {
    return false
  }
}

const CLOUDFLARE_TITLE = /just a moment|attention required|verify you are human|checking your browser/i

/** A Cloudflare challenge page. Nothing is done about it: it passes on its own
 *  with Electron's default UA, or asks the user to tick a box themselves. */
export function isCloudflareChallenge(title: string, url: string): boolean {
  return CLOUDFLARE_TITLE.test(title) || url.includes('/cdn-cgi/challenge-platform')
}

/**
 * The loaded panes to unload now: every one idle for `idleMs` or longer, then
 * the least recently used beyond `limit`. `keep` (the focused pane) is never
 * unloaded.
 */
export function webPanesToUnload(
  loaded: ReadonlyArray<{ id: string; lastActive: number }>,
  opts: { limit: number; idleMs: number; now: number; keep?: string },
): string[] {
  const out: string[] = []
  const live: Array<{ id: string; lastActive: number }> = []
  for (const p of loaded) {
    if (p.id !== opts.keep && opts.now - p.lastActive >= opts.idleMs) out.push(p.id)
    else live.push(p)
  }
  live.sort((a, b) => {
    if (a.id === opts.keep) return -1
    if (b.id === opts.keep) return 1
    return b.lastActive - a.lastActive
  })
  for (const p of live.slice(Math.max(0, opts.limit))) if (p.id !== opts.keep) out.push(p.id)
  return out
}

export interface WebPaneHost {
  isLoaded(id: string): boolean
  /** The pane was focused or opened: load it and apply the active limit. */
  activate(id: string): void
  /** Unload what has been idle too long. `focused` counts as in use now. */
  sweep(focused: string | undefined): void
  unload(id: string): void
  release(id: string): void
  loadedCount(): number
}

export function createWebPaneHost(opts: {
  limit: () => number
  idleMinutes: () => number
  now?: () => number
}): WebPaneHost {
  const now = opts.now ?? (() => Date.now())
  const loaded = reactive(new Set<string>())
  const lastActive = new Map<string, number>()

  function apply(keep: string | undefined): void {
    const entries = [...loaded].map((id) => ({ id, lastActive: lastActive.get(id) ?? 0 }))
    for (const id of webPanesToUnload(entries, {
      limit: opts.limit(),
      idleMs: opts.idleMinutes() * 60_000,
      now: now(),
      keep,
    })) loaded.delete(id)
  }

  return {
    isLoaded: (id) => loaded.has(id),
    activate(id) {
      lastActive.set(id, now())
      loaded.add(id)
      apply(id)
    },
    sweep(focused) {
      if (focused && loaded.has(focused)) lastActive.set(focused, now())
      apply(focused && loaded.has(focused) ? focused : undefined)
    },
    unload: (id) => void loaded.delete(id),
    release(id) {
      loaded.delete(id)
      lastActive.delete(id)
    },
    loadedCount: () => loaded.size,
  }
}
