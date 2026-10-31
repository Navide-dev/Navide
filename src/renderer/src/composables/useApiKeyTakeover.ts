import { onScopeDispose } from 'vue'
import type { useBackend } from './useBackend'

interface TakeoverEvent {
  profileId?: string
  name?: string
  paneIds?: string[]
}

/** Every login ran out and the user opened an API key account to automatic
 *  switching: reopen this window's panes on it, resuming their conversations.
 *  The backend decided; this only carries it out on the panes it owns. */
export function useApiKeyTakeover(
  backend: Pick<ReturnType<typeof useBackend>, 'on'>,
  deps: {
    ownsPane: (paneId: string) => boolean
    reopen: (paneId: string, profileId: string) => Promise<unknown>
    announce: (name: string) => void
  },
): void {
  const unsubscribe = backend.on('quota_failover.api_key_takeover', (raw) => {
    const { profileId, name, paneIds } = raw as TakeoverEvent
    if (!profileId) return
    const mine = (paneIds ?? []).filter(deps.ownsPane)
    if (mine.length === 0) return
    deps.announce(name ?? '')
    for (const paneId of mine) void deps.reopen(paneId, profileId)
  })
  onScopeDispose(unsubscribe)
}
