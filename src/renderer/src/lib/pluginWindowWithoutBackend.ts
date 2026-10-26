// #641 follow-up (0.2.32): a plugin window opens even when its native backend
// was refused or failed, and the main window says why once. The reason is
// shown in the user's language, as the Settings row words it, and the next
// step only offers "allow" where allowing is something the user can do.

type Translate = (key: string, values?: Record<string, unknown>) => string

const STATUS_KEYS: Readonly<Record<string, string>> = {
  'disabled-globally': 'disabledGlobally',
  disabled: 'disabled',
  'needs-consent': 'needsConsent',
  'sandbox-unavailable': 'sandboxUnavailable',
  'shell-not-allowed': 'shellNotAllowed',
  'stopped-after-crashes': 'stoppedAfterCrashes',
  unavailable: 'unavailable',
}

/** The two refusals the Settings page can lift (the global switch, the
 *  plugin's consent); every other one is only explained there. */
const ALLOWABLE = new Set(['disabled-globally', 'needs-consent'])

export function pluginWindowWithoutBackendText(
  t: Translate,
  notice: { name: string; reason: string; status?: string },
): string {
  const statusKey = notice.status ? STATUS_KEYS[notice.status] : undefined
  const page = t('settings.extensions.developerNative')
  return t('settings.extensions.nativeBackends.windowWithout', {
    name: notice.name,
    // An older main sends only the English reason: shown as it is.
    reason: statusKey ? t(`settings.extensions.nativeBackends.status.${statusKey}`) : notice.reason,
    next: t(
      notice.status && ALLOWABLE.has(notice.status)
        ? 'settings.extensions.nativeBackends.windowWithoutAllow'
        : 'settings.extensions.nativeBackends.windowWithoutDetails',
      { page },
    ),
  })
}
