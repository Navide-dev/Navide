import { DEFAULT_SLOT_ID, FOLLOW_SWITCH_AGENT } from './accountFollowSwitch'

/**
 * Two-step Claude sign-in (plan claude-vault-slot_71f222, scheme D).
 *
 * A Settings sign-in lands in the account's vault slot; the account's own
 * config dir needs a sign-in of its own, because one OAuth grant cannot live
 * in two places that both refresh (Claude Code rotates refresh tokens with no
 * grace period). So once the slot sign-in is harvested the window opens the
 * existing own-folder login pane and tells the user to authorize once more.
 * Nothing here reads, copies or writes a credential: both steps are the login
 * panes that already exist, and these helpers only decide when to open one.
 */
export type LoginStep = 'slot' | 'dir'

export interface PendingLogin {
  paneId: string
  agentKey: string
  step: LoginStep
}

/** Whether a harvested slot sign-in goes on to the own-folder sign-in. Not
 *  for the account that is active by then (switched to while step one was
 *  open): it runs on the live login, and #433 refuses it a folder sign-in. */
export function chainsDirLogin(
  pending: PendingLogin,
  profileId: string,
  dirSignedIn: (profileId: string) => boolean,
  activeProfileId: string | null,
): boolean {
  return (
    pending.step === 'slot' &&
    pending.agentKey === FOLLOW_SWITCH_AGENT &&
    profileId !== DEFAULT_SLOT_ID &&
    profileId !== activeProfileId &&
    !dirSignedIn(profileId)
  )
}

/** Whether the own-folder step is done: only a folder that reads signed in
 *  ends it, so a stray broadcast cannot close the pane mid-authorization. */
export function dirLoginLanded(
  pending: PendingLogin,
  profileId: string,
  dirSignedIn: (profileId: string) => boolean,
): boolean {
  return pending.step === 'dir' && dirSignedIn(profileId)
}

/** Own-folder steps whose pane was closed before the folder login landed. */
export function skippedDirLogins(pending: ReadonlyMap<string, PendingLogin>, livePaneIds: ReadonlySet<string>): string[] {
  const skipped: string[] = []
  for (const [profileId, entry] of pending) {
    if (entry.step === 'dir' && !livePaneIds.has(entry.paneId)) skipped.push(profileId)
  }
  return skipped
}

/**
 * Accounts signed in before the two-step sign-in existed: signed in to their
 * slot, not to their own folder. Each is reminded once; nothing converts them.
 */
export function dirLoginReminderTargets(
  profileIds: readonly string[],
  signedIn: (profileId: string) => boolean,
  dirSignedIn: (profileId: string) => boolean,
  reminded: ReadonlySet<string>,
): string[] {
  return profileIds.filter(
    (id) => id !== DEFAULT_SLOT_ID && !reminded.has(id) && signedIn(id) && !dirSignedIn(id),
  )
}

/** Shared by every window, so an account is reminded once per install. */
export const ACCOUNT_DIR_REMINDED_KEY = 'agentTeam.accountDirLoginReminded'

export function loadDirLoginReminded(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ACCOUNT_DIR_REMINDED_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveDirLoginReminded(ids: ReadonlySet<string>): void {
  try { localStorage.setItem(ACCOUNT_DIR_REMINDED_KEY, JSON.stringify([...ids])) } catch { /* ignore */ }
}
