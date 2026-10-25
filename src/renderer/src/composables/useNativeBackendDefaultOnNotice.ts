import { i18n, useNotify } from '@navide/plugin-ui/foundation'

/**
 * Third-party native backends are on by default since 0.2.31. A profile whose
 * switch an earlier version left off (and that never recorded the user
 * setting it) now reads as on; the main process reports that once, and this
 * tells the user where the switch is.
 */
export function useNativeBackendDefaultOnNotice(openSwitch: () => void): void {
  const t = i18n.global.t
  const notify = useNotify()
  const take = window.agentTeam?.plugins?.nativeBackends?.takeDefaultOnNotice
  if (!take) return
  void take().then((shown) => {
    if (!shown) return
    notify.toast(t('settings.extensions.nativeBackends.defaultOnNotice'), {
      type: 'info',
      duration: 0,
      action: { label: t('settings.extensions.nativeBackends.defaultOnNoticeAction'), run: openSwitch },
    })
  }, () => undefined)
}
