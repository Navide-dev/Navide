import { ref, type InjectionKey, type Ref } from 'vue'
import {
  DEFAULT_SLOT_ID,
  FOLLOW_SWITCH_AGENT,
  effectiveAccount,
  type FollowPaneInput,
  type FollowSwitchRow,
} from './accountFollowSwitch'

/**
 * Panes that follow the account (plan_8debb8, then plan claude_f1bf4b).
 *
 * Scheme A (claude_f1bf4b, what the main window does): every claude pane on
 * the live login is in this set and moves with an account switch on its next
 * turn; a pane fixed to an account's own config dir is not. Every pane carries
 * a bookkeeping pin, so the pin alone cannot tell the two apart — this set
 * does, and it decides whether a (re)spawn sends that pin (accountSpawnPin).
 * Scheme B (plan_8debb8) used the same set for its follow batch.
 *
 * The flag lives in localStorage keyed by pane id, like the messaging names:
 * pane records in project.json are backend-owned. A rebuild or a restore
 * hands a pane a new id, so the caller re-keys it at the same place the
 * lineage is re-keyed. Every write re-reads the stored set first and the
 * other windows' writes arrive through the storage event, so two windows
 * never overwrite each other's panes.
 */
export const ACCOUNT_FOLLOW_PANES_KEY = 'agentTeam.accountFollowPanes'
/** Generous on purpose: an id dropped by the cap would make a live pane read
 *  as fixed on its next restore. */
export const ACCOUNT_FOLLOW_PANES_CAP = 2000

export interface AccountFollowStore {
  ids: Readonly<Ref<ReadonlySet<string>>>
  has: (paneId: string) => boolean
  toggle: (paneId: string) => void
  add: (paneId: string) => void
  remove: (paneId: string) => void
  rekey: (oldId: string, newId: string) => void
}

function load(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ACCOUNT_FOLLOW_PANES_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function createAccountFollowStore(): AccountFollowStore {
  // Insertion order is age order, so the cap drops the oldest first.
  const ids = ref<Set<string>>(new Set(load()))

  window.addEventListener('storage', (e) => {
    if (e.key === ACCOUNT_FOLLOW_PANES_KEY || e.key === null) ids.value = new Set(load())
  })

  function save(next: Set<string>): void {
    const list = [...next].slice(-ACCOUNT_FOLLOW_PANES_CAP)
    ids.value = new Set(list)
    try { localStorage.setItem(ACCOUNT_FOLLOW_PANES_KEY, JSON.stringify(list)) } catch { /* ignore */ }
  }

  // Read-modify-write against what is stored now, not this window's copy.
  function update(change: (next: Set<string>) => boolean): void {
    const next = new Set(load())
    if (!change(next)) {
      ids.value = next
      return
    }
    save(next)
  }

  return {
    ids,
    has: (paneId) => ids.value.has(paneId),
    toggle: (paneId) => update((next) => {
      if (next.has(paneId)) next.delete(paneId)
      else next.add(paneId)
      return true
    }),
    add: (paneId) => update((next) => {
      if (next.has(paneId)) return false
      next.add(paneId)
      return true
    }),
    remove: (paneId) => update((next) => next.delete(paneId)),
    rekey: (oldId, newId) => update((next) => {
      if (oldId === newId || !next.has(oldId)) return false
      next.delete(oldId)
      next.add(newId)
      return true
    }),
  }
}

/**
 * The pin a (re)spawn of a claude pane sends (scheme A). A following pane
 * whose bookkeeping pin names an account signed in inside its own dir would be
 * put in that dir by it, out of the live switch's reach — so it goes without.
 * Every other pin is sent unchanged, which with no account dir at all is
 * exactly what main sends.
 */
export function accountSpawnPin(
  pin: string | undefined,
  following: boolean,
  dirSignedIn: (id: string) => boolean,
): string | undefined {
  if (pin && following && dirSignedIn(pin)) return undefined
  return pin
}

/** Where a restore learns whether the account dirs are known yet. */
export interface AccountDirsGate {
  /** True once cli_profiles.list has answered. */
  loaded: () => boolean
  /** Settles when the list has answered or failed (the request's own timeout). */
  load: () => Promise<void>
  /** Called when the list could still not be read: the pin goes out as on main. */
  disclose: (pin: string) => void
}

/**
 * accountSpawnPin for a restore, which can run before cli_profiles.list has
 * answered. Until then every account dir reads as not signed in, so a
 * following pane would send its saved pin and the backend — which does know
 * the dir is signed in — would put the pane in that account's dir. Only a
 * following pane with a pin is decided by the dirs, so only it waits.
 */
export async function restoreSpawnPin(
  pin: string | undefined,
  following: boolean,
  dirSignedIn: (id: string) => boolean,
  gate: AccountDirsGate,
): Promise<string | undefined> {
  if (pin && pin !== DEFAULT_SLOT_ID && following && !gate.loaded()) {
    await gate.load()
    if (!gate.loaded()) gate.disclose(pin)
  }
  return accountSpawnPin(pin, following, dirSignedIn)
}

/** A pane fixed to its account: not following, and pinned to an account
 *  signed in inside its own dir (so it runs there). */
export function isAccountFixed(
  pin: string | undefined,
  following: boolean,
  dirSignedIn: (id: string) => boolean,
): boolean {
  return !following && !!pin && pin !== DEFAULT_SLOT_ID && dirSignedIn(pin)
}

/**
 * The following panes a new default `target` would move: claude panes that
 * can be rebuilt and do not already run on it. On the shared login or on an
 * account dir alike — the rebuild pins the pane to the target either way.
 * `profileId` on a row is the account the pane runs on now.
 */
export function followingPaneRows(
  panes: FollowPaneInput[],
  opts: {
    target: string
    liveId: string | null
    dirSignedIn: (id: string) => boolean
    isFollowing: (paneId: string) => boolean
  },
): FollowSwitchRow[] {
  const rows: FollowSwitchRow[] = []
  for (const p of panes) {
    if (!p.realized || p.agentKey !== FOLLOW_SWITCH_AGENT || !p.canRebuild) continue
    if (!opts.isFollowing(p.id)) continue
    const current = effectiveAccount(p.profileId, opts.liveId, opts.dirSignedIn)
    if (current === opts.target) continue
    rows.push({
      paneId: p.id,
      name: p.name,
      profileId: current,
      state: p.busy ? 'running' : p.usageLimited ? 'quota' : 'idle',
      checked: true,
    })
  }
  return rows
}

/** What the main window lends the quota badge's account list. */
export interface AccountFollowActions {
  followingCount: () => number
  /** The pane ids choosing `target` would move, after asking about running
   *  ones; null when the user cancelled. `target` is a pin (the built-in
   *  Default as DEFAULT_SLOT_ID). */
  plan: (target: string) => Promise<string[] | null>
  move: (paneIds: string[], target: string) => Promise<void>
}

export const accountFollowKey: InjectionKey<AccountFollowActions> = Symbol('account-follow')

/** What the main window lends the quota badge under scheme A. */
export interface AccountPinActions {
  /** Claude panes in this window fixed to an account's own dir. */
  fixedCount: () => number
  /** "Make all follow": reopen the fixed panes on the live login. */
  unpinAll: () => Promise<void>
}

export const accountPinKey: InjectionKey<AccountPinActions> = Symbol('account-pin')

