import { i18n, useNotify } from '@navide/plugin-ui/foundation'

/**
 * The core backend's agent tool result helper (agent-tools contract 4.4, R2)
 * could not be used: Navide plugin results over 1 MiB are refused until it
 * can. The first time in a session the state turns `unavailable` this notes it
 * once, never interrupting; Resource Manager shows the state all along.
 * Returns the unsubscribe.
 */
export function usePluginResultHelperNotice(): () => void {
  const t = i18n.global.t
  const notify = useNotify()
  let noted = false
  const subscribe = window.agentTeam?.plugins?.onResultHelperState
  if (!subscribe) return () => {}
  return subscribe((state) => {
    if (state.state !== 'unavailable' || noted) return
    noted = true
    notify.toast(t('pluginDisclosure.resultHelperUnavailable', { error: state.lastError }), { type: 'error', duration: 0 })
  })
}
