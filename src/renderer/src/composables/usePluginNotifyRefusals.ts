import { ref } from 'vue'

/** The part of useBackend the pane menu's plugin-notification switch needs. */
interface NotifyBackend {
  send(type: string, payload: Record<string, unknown>): Promise<{ ok?: boolean; payload?: unknown } | undefined>
}

/**
 * Plan P4: which panes refuse notifications from Navide plugins (the pane
 * menu's "Refuse plugin notifications"). The backend keeps the setting and
 * makes it follow a pane across a reclaim or restart; this is the window's
 * mirror for the menu label, read on connect and after each change.
 */
export function usePluginNotifyRefusals(backend: NotifyBackend) {
  const refusing = ref(new Set<string>())

  async function load(): Promise<void> {
    try {
      const resp = await backend.send('plugins.agent_notify.pane_refusals', {})
      const ids = (resp?.payload as { pane_ids?: unknown } | undefined)?.pane_ids
      if (resp?.ok && Array.isArray(ids)) refusing.value = new Set(ids.filter((id): id is string => typeof id === 'string'))
    } catch {
      // Advisory: the menu reads "accept" until the backend answers.
    }
  }

  async function toggle(paneId: string): Promise<void> {
    const refuse = !refusing.value.has(paneId)
    try {
      const resp = await backend.send('plugins.agent_notify.set_pane_refusal', { pane_id: paneId, refuse })
      if (!resp?.ok) return
      const next = new Set(refusing.value)
      if (refuse) next.add(paneId)
      else next.delete(paneId)
      refusing.value = next
    } catch {
      // The setting is unchanged; the menu keeps showing it as it was.
    }
  }

  return { refusing, load, toggle, refuses: (paneId: string) => refusing.value.has(paneId) }
}
