import { ref } from 'vue'
import { onSettingsChanged } from '@navide/plugin-ui/shared'
import { SYSTEM_NOTIFY_ENABLED_KEY, setSystemNotifyEnabled, systemNotifyEnabled } from './useSystemNotify'
import { NOTIFY_SOUND_ENABLED_KEY, notifySoundEnabled, setNotifySoundEnabled } from './useSoundNotify'

/**
 * Reactive view of the two notification toggles (Settings → Notifications),
 * shared by every surface that shows them — the Settings page and the status
 * bar's notifications popover — so flipping one repaints the other.
 *
 * The settings themselves are unchanged: reads and writes still go through
 * systemNotifyEnabled/setSystemNotifyEnabled and notifySoundEnabled/
 * setNotifySoundEnabled, which is what the notification and sound gates
 * consult. These refs only mirror them.
 */
export const systemNotifyOn = ref(systemNotifyEnabled())
export const notifySoundOn = ref(notifySoundEnabled())

export function setSystemNotifyOn(enabled: boolean): void {
  systemNotifyOn.value = enabled
  setSystemNotifyEnabled(enabled)
}

export function setNotifySoundOn(enabled: boolean): void {
  notifySoundOn.value = enabled
  setNotifySoundEnabled(enabled)
}

// Another window flipping either toggle (or the connect-time reconcile) must
// repaint this one; this window's own writes already updated the refs.
onSettingsChanged((keys) => {
  if (keys.includes(SYSTEM_NOTIFY_ENABLED_KEY)) systemNotifyOn.value = systemNotifyEnabled()
  if (keys.includes(NOTIFY_SOUND_ENABLED_KEY)) notifySoundOn.value = notifySoundEnabled()
})

/** Re-read both settings, for tests that seed the store after import. */
export function __reloadNotifyPrefsForTest(): void {
  systemNotifyOn.value = systemNotifyEnabled()
  notifySoundOn.value = notifySoundEnabled()
}
