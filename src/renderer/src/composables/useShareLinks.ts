/**
 * useShareLinks.ts
 *
 * The account's share links as the Share sub-tab lists them. Reads
 * `share.list`; a backend without that method (this build's, until the server
 * calls land) answers UNKNOWN_TYPE, which leaves the list `unavailable`. Any
 * other failure, a timeout or a dropped socket included, is an `error`.
 */
import { ref } from 'vue'
import type { useBackend } from './useBackend'

type Backend = ReturnType<typeof useBackend>

/** The list is a server round trip; the default 10 s is too short on a slow link. */
const LIST_TIMEOUT_MS = 30_000

export interface ShareLink {
  linkId: string
  kind: string
  /** Decrypted on this device from the link's metadata; '' when it could not be. */
  title: string
  createdBy: 'user' | 'agent'
  pane: string
  deviceName: string
  createdAt: string
  expiresAt: string
  revokedAt: string
  openCount: number
  lastOpenedAt: string
}

export type ShareLinksStatus = 'idle' | 'ok' | 'unavailable' | 'error'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function readShareLinks(payload: unknown): ShareLink[] {
  const links = (payload as { links?: unknown } | null)?.links
  if (!Array.isArray(links)) return []
  return links
    .filter((raw): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !!str((raw as Record<string, unknown>).linkId))
    .map((raw) => ({
      linkId: str(raw.linkId),
      kind: str(raw.kind),
      title: str(raw.title),
      createdBy: raw.createdBy === 'agent' ? 'agent' : 'user',
      pane: str(raw.pane),
      deviceName: str(raw.deviceName),
      createdAt: str(raw.createdAt),
      expiresAt: str(raw.expiresAt),
      revokedAt: str(raw.revokedAt),
      openCount: typeof raw.openCount === 'number' ? raw.openCount : 0,
      lastOpenedAt: str(raw.lastOpenedAt),
    }))
}

export function useShareLinks(backend: Backend) {
  const links = ref<ShareLink[]>([])
  const status = ref<ShareLinksStatus>('idle')
  const loading = ref(false)

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const resp = await backend.send('share.list', {}, LIST_TIMEOUT_MS)
      if (!resp.ok) {
        links.value = []
        status.value = resp.error?.code === 'UNKNOWN_TYPE' ? 'unavailable' : 'error'
        return
      }
      links.value = readShareLinks(resp.payload)
      status.value = 'ok'
    } catch {
      links.value = []
      status.value = 'error'
    } finally {
      loading.value = false
    }
  }

  return { links, status, loading, refresh }
}
