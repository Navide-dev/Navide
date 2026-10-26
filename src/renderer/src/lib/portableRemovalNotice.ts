// The 0.2.32 upgrade erased the credentials pasted through "Paste Credential"
// (a feature since removed) from a machine that used it. The backend answers
// `show: true` exactly once there and false everywhere else, so this toast
// reaches only the people whose new panes now run on a different sign-in.

interface NoticeBackend {
  send<T>(type: string, payload: Record<string, unknown>): Promise<{ ok: boolean; payload?: T | null }>
}

type NoticeToast = (message: string, opts: { type: 'info'; duration: number; title: string }) => void

export async function showPortableRemovalNotice(
  backend: NoticeBackend,
  toast: NoticeToast,
  t: (key: string) => string,
): Promise<boolean> {
  try {
    const resp = await backend.send<{ show?: boolean }>('cli_profiles.portable_removal_notice', {})
    if (!resp.ok || resp.payload?.show !== true) return false
  } catch {
    // Advisory only; the backend keeps the notice for the next launch.
    return false
  }
  // Stays up until dismissed: it explains a change of account and quota.
  toast(t('settings.accounts.cli.portable-removed-text'), {
    type: 'info',
    duration: 0,
    title: t('settings.accounts.cli.portable-removed-title'),
  })
  return true
}
