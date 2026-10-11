import { settingsGet } from '@navide/plugin-ui/shared'

/** Settings key: when a claude account switch succeeds, offer to move the
 *  panes running on another account's own config dir along with it, and offer
 *  "switch account and resume" on a pane that ran out of quota. Default off;
 *  off means every surface behaves exactly as before this flag existed. */
export const ACCOUNT_FOLLOW_SWITCH_SETTING_KEY = 'agentTeam.accounts.followSwitch'

export function accountFollowSwitchEnabled(): boolean {
  return settingsGet<boolean>(ACCOUNT_FOLLOW_SWITCH_SETTING_KEY, false) === true
}

/** The built-in Default slot (the real home). Mirrors the backend's id. */
export const DEFAULT_SLOT_ID = '__default__'

/** The only agent whose accounts can run on their own config dir — the panes
 *  an account switch (which swaps the live credential) never reaches. */
export const FOLLOW_SWITCH_AGENT = 'claude'

export type FollowPaneState = 'idle' | 'running' | 'quota'

export interface FollowPaneInput {
  id: string
  name: string
  agentKey: string
  realized?: boolean
  isLogin?: boolean
  profileId?: string
  /** The pane announced it is out of quota. */
  usageLimited: boolean
  /** A turn is in progress (a rebuild now would stop it). */
  busy: boolean
  /** It has a resumable session (the Rebuild button's preconditions). */
  canRebuild: boolean
}

export interface FollowSwitchRow {
  paneId: string
  name: string
  /** The account whose own config dir the pane runs on now. */
  profileId: string
  state: FollowPaneState
  checked: boolean
}

/** The account a claude pane actually runs on: its pin when that account
 *  signed in inside its own config dir (the backend then runs it there),
 *  else the live credential's owner. */
export function effectiveAccount(
  profileId: string | undefined,
  liveId: string | null,
  dirSignedIn: (id: string) => boolean,
): string {
  if (profileId && profileId !== DEFAULT_SLOT_ID && dirSignedIn(profileId)) return profileId
  return liveId ?? DEFAULT_SLOT_ID
}

function paneState(p: FollowPaneInput): FollowPaneState {
  if (p.usageLimited) return 'quota'
  return p.busy ? 'running' : 'idle'
}

function movable(p: FollowPaneInput): boolean {
  return !!p.realized && !p.isLogin && p.agentKey === FOLLOW_SWITCH_AGENT && p.canRebuild
}

/**
 * Panes a successful switch to `targetId` leaves behind: claude panes running
 * on some other account's own config dir. Panes on the live credential are
 * not listed — the switch already reached them. Pre-checked are the panes on
 * the account being switched away from and the ones out of quota; any other
 * pinned pane stays where it is unless the user ticks it.
 */
export function followSwitchRows(
  panes: FollowPaneInput[],
  opts: { targetId: string | null; outgoingId: string | null; dirSignedIn: (id: string) => boolean },
): FollowSwitchRow[] {
  const target = opts.targetId ?? DEFAULT_SLOT_ID
  const rows: FollowSwitchRow[] = []
  for (const p of panes) {
    if (!movable(p)) continue
    const pin = p.profileId
    if (!pin || pin === DEFAULT_SLOT_ID || pin === target || !opts.dirSignedIn(pin)) continue
    rows.push({
      paneId: p.id,
      name: p.name,
      profileId: pin,
      state: paneState(p),
      checked: pin === opts.outgoingId || p.usageLimited,
    })
  }
  return rows
}

export interface QuotaTargetInput {
  /** null = the built-in Default. */
  id: string | null
  label: string
  remaining?: string
  exhausted?: boolean
}

export interface QuotaTarget {
  /** The pin to rebuild with (the Default as its reserved id). */
  id: string
  label: string
  remaining: string
  /** False when a rebuild could not land on it: it has no sign-in of its own
   *  and is not the live account, so the backend would fall back to live. */
  eligible: boolean
  exhausted: boolean
}

/**
 * Accounts an out-of-quota claude pane can move to: every account except the
 * one it runs on. Only the live account and accounts signed in inside their
 * own config dir can actually be landed on.
 */
export function quotaSwitchTargets(
  accounts: QuotaTargetInput[],
  opts: { current: string; liveId: string | null; dirSignedIn: (id: string) => boolean },
): QuotaTarget[] {
  const live = opts.liveId ?? DEFAULT_SLOT_ID
  const out: QuotaTarget[] = []
  for (const a of accounts) {
    const id = a.id ?? DEFAULT_SLOT_ID
    if (id === opts.current) continue
    out.push({
      id,
      label: a.label,
      remaining: a.remaining ?? '',
      eligible: id === live || (id !== DEFAULT_SLOT_ID && opts.dirSignedIn(id)),
      exhausted: a.exhausted === true,
    })
  }
  return out
}

/** Other out-of-quota claude panes on the same account as `paneId` — the
 *  ones a "move them all" choice takes along. */
export function quotaPeerRows(
  panes: FollowPaneInput[],
  paneId: string,
  account: string,
  effective: (p: FollowPaneInput) => string,
): FollowSwitchRow[] {
  return panes
    .filter((p) => p.id !== paneId && movable(p) && p.usageLimited && effective(p) === account)
    .map((p) => ({ paneId: p.id, name: p.name, profileId: account, state: 'quota' as const, checked: true }))
}

/**
 * Rebuild the chosen panes onto the new account, one at a time. Idle ones go
 * first; a pane mid-turn is waited for until its turn ends (polled), so no
 * work is cut off. `rebuild` resolves undefined on success, "busy" when the
 * pane started a turn after all (it is then waited for again), or another
 * failure token. Returns the failed pane ids with their reasons.
 */
export async function runFollowSwitchBatch(
  ids: string[],
  deps: {
    isBusy: (id: string) => boolean
    rebuild: (id: string) => Promise<string | undefined>
    sleep: (ms: number) => Promise<void>
    pollMs?: number
    timeoutMs?: number
  },
): Promise<Array<{ id: string; reason: string }>> {
  const pollMs = deps.pollMs ?? 2000
  const timeoutMs = deps.timeoutMs ?? 30 * 60_000
  const failures: Array<{ id: string; reason: string }> = []
  const ordered = [...ids.filter((id) => !deps.isBusy(id)), ...ids.filter((id) => deps.isBusy(id))]
  for (const id of ordered) {
    let waited = 0
    for (;;) {
      if (deps.isBusy(id)) {
        if (waited >= timeoutMs) {
          failures.push({ id, reason: 'busy' })
          break
        }
        await deps.sleep(pollMs)
        waited += pollMs
        continue
      }
      let outcome: string | undefined
      try {
        outcome = await deps.rebuild(id)
      } catch (error) {
        outcome = error instanceof Error ? error.message : String(error)
      }
      if (outcome === 'busy' && waited < timeoutMs) {
        await deps.sleep(pollMs)
        waited += pollMs
        continue
      }
      if (outcome !== undefined) failures.push({ id, reason: outcome })
      break
    }
  }
  return failures
}
