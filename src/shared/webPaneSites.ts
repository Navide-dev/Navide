/**
 * The sites a web pane can show. A web pane is an official agent website in a
 * pane's frame: the user signs in there themselves, the cookies stay in that
 * site's own persistent partition under userData, and Navide neither reads nor
 * syncs them. Shared by main (which only lets a `<webview>` attach on one of
 * these partitions) and the renderer (which draws the pane and the ＋ menu row).
 */

export interface WebPaneSite {
  /** Stable id: the partition and the pane's agent key are derived from it. */
  id: string
  name: string
  /** Page the pane opens on. */
  url: string
  /** Registrable domains that count as "this site": a window.open to one of
   *  them stays in the pane, anything else goes to the system browser. */
  hosts: readonly string[]
  /** macOS bundle id of the site's desktop app, when it has one Navide can
   *  find (Spotlight) and open (`open -b`). Absent: the site is web only. */
  macAppBundleId?: string
}

export const WEB_PANE_SITES: readonly WebPaneSite[] = [
  { id: 'grok', name: 'Grok Bot', url: 'https://cursor.com/dashboard/bot', hosts: ['cursor.com'] },
  { id: 'dots', name: 'OpenAI dots', url: 'https://chatgpt.com', hosts: ['chatgpt.com', 'openai.com'], macAppBundleId: 'com.openai.chat' },
  { id: 'muse', name: 'Meta Muse', url: 'https://muse.ai', hosts: ['muse.ai'] },
  { id: 'manus', name: 'Manus', url: 'https://manus.im', hosts: ['manus.im'] },
  { id: 'gemini', name: 'Gemini Tasks', url: 'https://gemini.google.com', hosts: ['google.com'] },
  { id: 'perplexity', name: 'Perplexity Computer', url: 'https://www.perplexity.ai/computer', hosts: ['perplexity.ai'] },
]

/** A web pane's agent key is this prefix plus the site id (`web:grok`). */
export const WEB_PANE_AGENT_PREFIX = 'web:'
const PARTITION_PREFIX = 'persist:web-'

export function webPaneSite(id: string): WebPaneSite | undefined {
  return WEB_PANE_SITES.find((s) => s.id === id)
}

export function webPaneAgentKey(siteId: string): string {
  return WEB_PANE_AGENT_PREFIX + siteId
}

export function isWebPaneAgentKey(agentKey: string | undefined): boolean {
  return !!agentKey && agentKey.startsWith(WEB_PANE_AGENT_PREFIX)
}

export function webPaneSiteForAgentKey(agentKey: string | undefined): WebPaneSite | undefined {
  return isWebPaneAgentKey(agentKey) ? webPaneSite(agentKey!.slice(WEB_PANE_AGENT_PREFIX.length)) : undefined
}

/** Every pane of one site shares this partition, so one sign-in covers them. */
export function webPanePartition(siteId: string): string {
  return PARTITION_PREFIX + siteId
}

export function webPaneSiteForPartition(partition: string | undefined): WebPaneSite | undefined {
  return partition?.startsWith(PARTITION_PREFIX) ? webPaneSite(partition.slice(PARTITION_PREFIX.length)) : undefined
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/** http(s) URL on one of the site's own domains (or a subdomain of one). */
export function isWebPaneSameSite(site: WebPaneSite, url: string): boolean {
  const host = hostOf(url)
  return !!host && site.hosts.some((d) => host === d || host.endsWith('.' + d))
}
