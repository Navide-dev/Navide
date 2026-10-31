import { onScopeDispose, watch, type Ref } from 'vue'
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

/** Tells the user once when a login's quota comes back while the CLI is
 *  spending an API key. Nothing switches back on its own. `isSpent` is the
 *  existing reading; null means there is no reading, which changes nothing. */
export function useLoginResetNotice(
  usageVersion: Ref<number>,
  deps: {
    agents: readonly string[]
    spendingKey: (agentKey: string) => boolean
    logins: (agentKey: string) => (string | null)[]
    isSpent: (agentKey: string, profileId: string | null) => boolean | null
    announce: (agentKey: string) => void
  },
): void {
  const wasSpent = new Map<string, boolean>()
  watch(usageVersion, () => {
    for (const agentKey of deps.agents) {
      let cameBack = false
      for (const id of deps.logins(agentKey)) {
        const spent = deps.isSpent(agentKey, id)
        if (spent === null) continue
        const key = `${agentKey}/${id ?? ''}`
        if (wasSpent.get(key) === true && !spent) cameBack = true
        wasSpent.set(key, spent)
      }
      if (cameBack && deps.spendingKey(agentKey)) deps.announce(agentKey)
    }
  })
}
