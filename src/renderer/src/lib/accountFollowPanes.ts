import { ref, type InjectionKey, type Ref } from 'vue'
import {
  FOLLOW_SWITCH_AGENT,
  effectiveAccount,
  type FollowPaneInput,
  type FollowSwitchRow,
} from './accountFollowSwitch'

/**
 * Panes that follow the default account (plan_8debb8, scheme B). A pane is
 * fixed unless the user marks it "follow"; choosing a default account in the
 * quota badge's list then moves only the following panes, through the same
 * follow batch the follow-switch dialog uses.
 *
 * The flag lives in localStorage keyed by pane id, like the messaging names:
 * pane records in project.json are backend-owned. A rebuild or a restore
 * hands a pane a new id, so the caller re-keys it at the same place the
 * lineage is re-keyed.
 */
export const ACCOUNT_FOLLOW_PANES_KEY = 'agentTeam.accountFollowPanes'
export const ACCOUNT_FOLLOW_PANES_CAP = 200

export interface AccountFollowStore {
  ids: Readonly<Ref<ReadonlySet<string>>>
  has: (paneId: string) => boolean
  toggle: (paneId: string) => void
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

  function save(next: Set<string>): void {
    const list = [...next].slice(-ACCOUNT_FOLLOW_PANES_CAP)
    ids.value = new Set(list)
    try { localStorage.setItem(ACCOUNT_FOLLOW_PANES_KEY, JSON.stringify(list)) } catch { /* ignore */ }
  }

  return {
    ids,
    has: (paneId) => ids.value.has(paneId),
    toggle: (paneId) => {
      const next = new Set(ids.value)
      if (next.has(paneId)) next.delete(paneId)
      else next.add(paneId)
      save(next)
    },
    rekey: (oldId, newId) => {
      if (oldId === newId || !ids.value.has(oldId)) return
      const next = new Set(ids.value)
      next.delete(oldId)
      next.add(newId)
      save(next)
    },
  }
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

