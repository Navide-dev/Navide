import { computed, ref, type ComputedRef, type Ref } from 'vue'

// Available updates for installed Registry packages, shared by the Marketplace
// and Extensions pages the same way the inventory is: an update installed from
// one page must clear the badge on the other without a remount.
const updates = ref<PluginUpdateInfo[]>([])
const count = computed(() => updates.value.length)

export interface PluginUpdates {
  updates: Ref<PluginUpdateInfo[]>
  count: ComputedRef<number>
  refresh: () => Promise<void>
  subscribe: () => () => void
}

export function usePluginUpdates(): PluginUpdates {
  async function refresh(): Promise<void> {
    const api = window.agentTeam?.plugins
    if (!api?.checkUpdates) return
    try {
      updates.value = await api.checkUpdates()
    } catch {
      // Detection is advisory: a failed check is not surfaced on pages that
      // did not ask for one. A package the Registry did not answer for keeps
      // the main process's last known update, so badge that merged answer
      // (cached, no network); if even that fails, keep this page's last answer.
      try {
        updates.value = (await api.pendingUpdates?.()) ?? updates.value
      } catch {
        // Keep the last answer.
      }
    }
  }

  // Follow the main process's periodic check (pushed after each trust
  // refresh) and seed from its last answer, without a network round trip.
  // Returns the unsubscribe for the caller's unmount.
  function subscribe(): () => void {
    const api = window.agentTeam?.plugins
    if (!api?.onUpdatesChanged) return () => {}
    const stop = api.onUpdatesChanged((next) => {
      updates.value = next
    })
    void api
      .pendingUpdates?.()
      .then((cached) => {
        updates.value = cached
      })
      .catch(() => {})
    return stop
  }

  return { updates, count, refresh, subscribe }
}
