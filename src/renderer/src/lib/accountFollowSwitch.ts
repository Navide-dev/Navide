import { readonly, ref, type Ref } from 'vue'
import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

/** Settings key: when a claude account switch succeeds, offer to move the
 *  panes running on another account's own config dir along with it, and offer
 *  "switch account and resume" on a pane that ran out of quota. Default off;
 *  off means every surface behaves exactly as before this flag existed. */
export const ACCOUNT_FOLLOW_SWITCH_SETTING_KEY = 'agentTeam.accounts.followSwitch'

export function accountFollowSwitchEnabled(): boolean {
  return settingsGet<boolean>(ACCOUNT_FOLLOW_SWITCH_SETTING_KEY, false) === true
}

// Reactive copy for templates. The settings store notifies only changes from
// elsewhere (other windows, reconcile), so this window's own toggle goes
// through setAccountFollowSwitch to update it as well.
const flag = ref(accountFollowSwitchEnabled())
onSettingsChanged((keys) => {
  if (keys.includes(ACCOUNT_FOLLOW_SWITCH_SETTING_KEY)) flag.value = accountFollowSwitchEnabled()
})

export function useAccountFollowSwitchFlag(): Readonly<Ref<boolean>> {
  return readonly(flag)
}

export function setAccountFollowSwitch(on: boolean): void {
  settingsSet(ACCOUNT_FOLLOW_SWITCH_SETTING_KEY, on)
  flag.value = on
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
  profileId?: string
  /** The pane announced it is out of quota. */
  usageLimited: boolean
  /** Not free to stop: a turn in progress, a prompt waiting on the user, or
   *  someone typing into it (a rebuild now would lose that). */
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
  if (p.busy) return 'running'
  return p.usageLimited ? 'quota' : 'idle'
}

function movable(p: FollowPaneInput): boolean {
  return !!p.realized && p.agentKey === FOLLOW_SWITCH_AGENT && p.canRebuild
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

/** Rebuild outcomes worth waiting out: the pane got busy again, or another
 *  rebuild of it (a restart batch) holds its lock right now. */
const RETRYABLE = new Set(['busy', 'locked'])

/**
 * Rebuild the chosen panes onto the new account, one at a time. Idle ones go
 * first; a busy pane is waited for (polled) until it is free, so no work and
 * no half-typed input is cut off. `resolve` maps a chosen id to the pane's
 * id now — a rebuild elsewhere replaces ids — or null when it is gone.
 * `rebuild` resolves undefined on success, "busy"/"locked" to be retried, or
 * another failure token. Returns the failed pane ids with their reasons.
 */
export async function runFollowSwitchBatch(
  ids: string[],
  deps: {
    resolve: (id: string) => string | null
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
  for (const chosen of ordered) {
    let waited = 0
    for (;;) {
      const id = deps.resolve(chosen)
      if (id === null) {
        failures.push({ id: chosen, reason: 'missing-pane' })
        break
      }
      if (deps.isBusy(id)) {
        if (waited >= timeoutMs) {
          failures.push({ id: chosen, reason: 'busy' })
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
      if (outcome !== undefined && RETRYABLE.has(outcome) && waited < timeoutMs) {
        await deps.sleep(pollMs)
        waited += pollMs
        continue
      }
      if (outcome !== undefined) failures.push({ id: chosen, reason: outcome })
      break
    }
  }
  return failures
}

type SwitchHandler<R extends { ok: boolean; needsLogin?: boolean }> = (agentKey: string, profileId: string | null) => Promise<R>

/**
 * Wrap the main window's account-switch handler with the follow step. The
 * switch itself is untouched: with the flag off — or for any CLI but claude —
 * the call goes straight through and nothing else runs. With it on, a claude
 * switch that succeeded hands the account it left and the one it landed on to
 * `afterSwitch` (which asks the user which pinned panes come along); its
 * result is returned as-is, without waiting for that step. A switch that
 * landed on an account still to be signed in offers nothing: the panes would
 * reopen at a login prompt.
 */
export function withFollowSwitch<R extends { ok: boolean; needsLogin?: boolean }>(
  base: SwitchHandler<R>,
  deps: {
    enabled: () => boolean
    outgoing: (agentKey: string) => string | null
    afterSwitch: (agentKey: string, outgoingId: string | null, targetId: string | null) => Promise<void>
  },
): SwitchHandler<R> {
  return async (agentKey, profileId) => {
    if (agentKey !== FOLLOW_SWITCH_AGENT || !deps.enabled()) return base(agentKey, profileId)
    const outgoingId = deps.outgoing(agentKey)
    const res = await base(agentKey, profileId)
    if (res.ok && !res.needsLogin) void deps.afterSwitch(agentKey, outgoingId, profileId)
    return res
  }
}
