import { onScopeDispose, watch, type Ref } from 'vue'
import type { useBackend } from './useBackend'
import { exhaustedWindow, type UsageSnapshot } from './useUsage'

interface TakeoverEvent {
  profileId?: string
  name?: string
  paneIds?: string[]
  /** False when the panes moved to a subscription account's own folder. */
  paid?: boolean
}

/** Reopen one pane on the key, unless it is not ready: a pane running, waiting
 *  on a permission prompt or holding unsent input stays, and the reason comes
 *  back. A falsy answer means the pane moved. */
export async function reopenOnKey(
  paneId: string,
  profileId: string,
  deps: {
    readiness: (paneId: string) => Promise<{ ready: boolean; reason?: string }>
    rebuild: (paneId: string, profileId: string) => Promise<unknown>
  },
): Promise<unknown> {
  const state = await deps.readiness(paneId)
  return state.ready ? deps.rebuild(paneId, profileId) : (state.reason ?? 'busy')
}

/** Whether a login still has a spent window, by the clock as well as the
 *  reading: every spent window has to have reset before it counts as back, and
 *  one with no known reset never has. null when there is no good reading. */
export function loginSpent(snap: UsageSnapshot | undefined, nowMs: number): boolean | null {
  if (!snap || snap.status !== 'ok') return null
  let rest = snap
  for (let w = exhaustedWindow(rest); w; w = exhaustedWindow(rest)) {
    if (!w.resetsAt || Date.parse(w.resetsAt) > nowMs) return true
    const reset = w
    rest = { ...rest, windows: rest.windows.filter((x) => x !== reset) }
  }
  return false
}

/** The backend moved claude to an API key account, or to a subscription account
 *  with quota in its own folder. Reopen this window's panes on it, resuming
 *  their conversations. A pane that is busy or cannot be reopened stays as it
 *  is, and `announce` or `announceFolderLogin` says how many did. `reopen`
 *  answers a falsy value when the pane moved. */
export function useApiKeyTakeover(
  backend: Pick<ReturnType<typeof useBackend>, 'on'>,
  deps: {
    ownsPane: (paneId: string) => boolean
    reopen: (paneId: string, profileId: string) => Promise<unknown>
    announce: (name: string, stayed: number) => void
    announceFolderLogin: (name: string, stayed: number) => void
  },
): void {
  const unsubscribe = backend.on('quota_failover.api_key_takeover', (raw) => {
    const { profileId, name, paneIds, paid } = raw as TakeoverEvent
    if (!profileId) return
    const all = paneIds ?? []
    const mine = all.filter(deps.ownsPane)
    // With panes elsewhere only, the window that owns them says it. With none
    // at all, the new default still has to be said once.
    if (all.length > 0 && mine.length === 0) return
    void (async () => {
      const results = await Promise.all(
        mine.map((paneId) => deps.reopen(paneId, profileId).catch(() => 'failed')),
      )
      const tell = paid === false ? deps.announceFolderLogin : deps.announce
      tell(name ?? '', results.filter(Boolean).length)
    })()
  })
  onScopeDispose(unsubscribe)
}

/** Tells the user once when a login's quota comes back while the CLI is
 *  spending an API key. Nothing switches back on its own. `isSpent` is the
 *  existing reading, judged against the clock as well: nothing polls a parked
 *  Codex login while a key is live, so the reading alone would never change.
 *  null means there is no reading, which changes nothing. */
export function useLoginResetNotice(
  usageVersion: Ref<number>,
  deps: {
    agents: readonly string[]
    spendingKey: (agentKey: string) => boolean
    logins: (agentKey: string) => (string | null)[]
    isSpent: (agentKey: string, profileId: string | null) => boolean | null
    announce: (agentKey: string) => void
  },
  checkEveryMs = 60_000,
): void {
  const wasSpent = new Map<string, boolean>()
  function check(): void {
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
  }
  watch(usageVersion, check)
  const timer = setInterval(check, checkEveryMs)
  onScopeDispose(() => clearInterval(timer))
}
