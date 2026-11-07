import { describe, expect, it } from 'vitest'
import {
  clampWebPaneIdleMinutes,
  clampWebPaneLimit,
  createWebPaneHost,
  isCloudflareChallenge,
  isGoogleSignInUrl,
  webPaneLoginState,
  webPanesToUnload,
} from '../webPaneHost'
import {
  isWebPaneSameSite,
  webPaneAgentKey,
  webPanePartition,
  webPaneSite,
  webPaneSiteForAgentKey,
  webPaneSiteForPartition,
  WEB_PANE_SITES,
} from '../../../../shared/webPaneSites'

const grok = webPaneSite('grok')!
const dots = webPaneSite('dots')!

describe('web pane sites', () => {
  it('derives agent key and partition from the site id, and back', () => {
    for (const site of WEB_PANE_SITES) {
      expect(webPaneSiteForAgentKey(webPaneAgentKey(site.id))).toBe(site)
      expect(webPaneSiteForPartition(webPanePartition(site.id))).toBe(site)
      expect(isWebPaneSameSite(site, site.url)).toBe(true)
    }
    expect(webPanePartition('grok')).toBe('persist:web-grok')
    expect(webPaneSiteForAgentKey('claude')).toBeUndefined()
    expect(webPaneSiteForAgentKey('web:nope')).toBeUndefined()
    expect(webPaneSiteForPartition('persist:navide-web:x')).toBeUndefined()
  })

  it('counts subdomains as the site and look-alikes as foreign', () => {
    expect(isWebPaneSameSite(dots, 'https://auth.openai.com/log-in')).toBe(true)
    expect(isWebPaneSameSite(dots, 'https://chatgpt.com.evil.example/')).toBe(false)
    expect(isWebPaneSameSite(dots, 'https://notchatgpt.com/')).toBe(false)
    expect(isWebPaneSameSite(dots, 'javascript:alert(1)')).toBe(false)
    expect(isWebPaneSameSite(dots, 'not a url')).toBe(false)
  })
})

describe('web pane login state', () => {
  it('reads a sign-in page as signed out and anything else on the site as signed in', () => {
    expect(webPaneLoginState(dots, 'https://chatgpt.com/auth/login')).toBe('signed-out')
    expect(webPaneLoginState(dots, 'https://auth.openai.com/u/1')).toBe('signed-out')
    expect(webPaneLoginState(webPaneSite('manus')!, 'https://manus.im/login')).toBe('signed-out')
    expect(webPaneLoginState(grok, 'https://authenticator.cursor.sh/')).toBe('signed-out')
    expect(webPaneLoginState(dots, 'https://chatgpt.com/c/123')).toBe('signed-in')
    expect(webPaneLoginState(grok, 'https://cursor.com/dashboard/bot')).toBe('signed-in')
  })

  it('detects Google account pages and Cloudflare challenges', () => {
    expect(isGoogleSignInUrl('https://accounts.google.com/ServiceLogin?continue=x')).toBe(true)
    expect(isGoogleSignInUrl('https://gemini.google.com/app')).toBe(false)
    expect(isCloudflareChallenge('Just a moment...', 'https://www.perplexity.ai/')).toBe(true)
    expect(isCloudflareChallenge('', 'https://x.example/cdn-cgi/challenge-platform/h/g')).toBe(true)
    expect(isCloudflareChallenge('Perplexity', 'https://www.perplexity.ai/computer')).toBe(false)
  })
})

describe('web pane unload order', () => {
  const idleMs = 10 * 60_000
  it('unloads idle panes, then the least recently used beyond the limit, never the kept one', () => {
    const now = 100 * 60_000
    const loaded = [
      { id: 'a', lastActive: now - 1000 },
      { id: 'b', lastActive: now - 2000 },
      { id: 'c', lastActive: now - 3000 },
      { id: 'd', lastActive: now - 4000 },
      { id: 'old', lastActive: now - idleMs },
    ]
    expect(webPanesToUnload(loaded, { limit: 3, idleMs, now, keep: 'a' })).toEqual(['old', 'd'])
    expect(webPanesToUnload(loaded, { limit: 3, idleMs, now, keep: 'd' })).toEqual(['old', 'c'])
    expect(webPanesToUnload(loaded, { limit: 10, idleMs, now, keep: 'old' })).toEqual([])
  })

  it('host: the fourth activation unloads the least recently used, idle sweep unloads, clicking reloads', () => {
    let t = 0
    const host = createWebPaneHost({ limit: () => 3, idleMinutes: () => 10, now: () => t })
    for (const id of ['p1', 'p2', 'p3']) {
      t += 1000
      host.activate(id)
    }
    t += 1000
    host.activate('p4')
    expect(host.isLoaded('p1')).toBe(false)
    expect(['p2', 'p3', 'p4'].every((id) => host.isLoaded(id))).toBe(true)

    t += idleMs
    host.sweep('p4')
    expect(host.isLoaded('p4')).toBe(true)
    expect(host.isLoaded('p2')).toBe(false)
    expect(host.isLoaded('p3')).toBe(false)

    host.activate('p1')
    expect(host.isLoaded('p1')).toBe(true)
    host.release('p1')
    expect(host.isLoaded('p1')).toBe(false)
    expect(host.loadedCount()).toBe(1)
  })

  it('clamps the two settings', () => {
    expect(clampWebPaneIdleMinutes('0')).toBe(1)
    expect(clampWebPaneIdleMinutes('abc')).toBe(10)
    expect(clampWebPaneIdleMinutes(999)).toBe(240)
    expect(clampWebPaneLimit('5')).toBe(5)
    expect(clampWebPaneLimit(0)).toBe(1)
    expect(clampWebPaneLimit(undefined)).toBe(3)
  })
})
