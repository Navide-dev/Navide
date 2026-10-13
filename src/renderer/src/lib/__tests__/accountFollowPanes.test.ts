// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import {
  ACCOUNT_FOLLOW_PANES_KEY,
  ACCOUNT_FOLLOW_PANES_CAP,
  createAccountFollowStore,
  followingPaneRows,
} from '../accountFollowPanes'
import { DEFAULT_SLOT_ID, type FollowPaneInput } from '../accountFollowSwitch'

function pane(over: Partial<FollowPaneInput> & { id: string }): FollowPaneInput {
  return {
    name: over.id,
    agentKey: 'claude',
    realized: true,
    usageLimited: false,
    busy: false,
    canRebuild: true,
    ...over,
  }
}

describe('account follow store', () => {
  beforeEach(() => localStorage.clear())

  it('starts with no pane following', () => {
    const store = createAccountFollowStore()
    expect(store.has('p1')).toBe(false)
    expect(store.ids.value.size).toBe(0)
  })

  it('toggles a pane and persists it across a new store (restart)', () => {
    createAccountFollowStore().toggle('p1')
    const reloaded = createAccountFollowStore()
    expect(reloaded.has('p1')).toBe(true)
    reloaded.toggle('p1')
    expect(createAccountFollowStore().has('p1')).toBe(false)
  })

  it('moves the flag to the new id when a pane is rebuilt or restored', () => {
    const store = createAccountFollowStore()
    store.toggle('old')
    store.rekey('old', 'new')
    expect(store.has('old')).toBe(false)
    expect(store.has('new')).toBe(true)
    expect(createAccountFollowStore().has('new')).toBe(true)
  })

  it('leaves the store alone when rekeying a pane that was not following', () => {
    const store = createAccountFollowStore()
    store.rekey('a', 'b')
    expect(store.has('b')).toBe(false)
    expect(localStorage.getItem(ACCOUNT_FOLLOW_PANES_KEY)).toBeNull()
  })

  it('keeps only the newest entries past the cap', () => {
    const store = createAccountFollowStore()
    for (let i = 0; i <= ACCOUNT_FOLLOW_PANES_CAP; i++) store.toggle(`p${i}`)
    const reloaded = createAccountFollowStore()
    expect(reloaded.ids.value.size).toBe(ACCOUNT_FOLLOW_PANES_CAP)
    expect(reloaded.has('p0')).toBe(false)
    expect(reloaded.has(`p${ACCOUNT_FOLLOW_PANES_CAP}`)).toBe(true)
  })

  it('reads a corrupt value as empty', () => {
    localStorage.setItem(ACCOUNT_FOLLOW_PANES_KEY, '{not json')
    expect(createAccountFollowStore().ids.value.size).toBe(0)
  })
})

describe('followingPaneRows', () => {
  const dirs = new Set(['work', 'home'])
  const opts = (following: string[], target: string, liveId: string | null = null) => ({
    target,
    liveId,
    dirSignedIn: (id: string) => dirs.has(id),
    isFollowing: (id: string) => following.includes(id),
  })

  it('never lists a pane that is not following', () => {
    const rows = followingPaneRows([pane({ id: 'a', profileId: 'work' }), pane({ id: 'b' })], opts([], 'home'))
    expect(rows).toEqual([])
  })

  it('lists following panes on another account, whether on the shared login or an account dir', () => {
    const rows = followingPaneRows(
      [pane({ id: 'shared' }), pane({ id: 'dir', profileId: 'work' }), pane({ id: 'fixed', profileId: 'work' })],
      opts(['shared', 'dir'], 'home'),
    )
    expect(rows.map((r) => [r.paneId, r.profileId])).toEqual([
      ['shared', DEFAULT_SLOT_ID],
      ['dir', 'work'],
    ])
  })

  it('skips a following pane already on the target', () => {
    const rows = followingPaneRows(
      [pane({ id: 'a', profileId: 'home' }), pane({ id: 'b' })],
      opts(['a', 'b'], 'home'),
    )
    expect(rows.map((r) => r.paneId)).toEqual(['b'])
    // The live owner as target: a pane on the shared login is already there.
    expect(followingPaneRows([pane({ id: 'b' })], opts(['b'], DEFAULT_SLOT_ID))).toEqual([])
  })

  it('skips panes that cannot be rebuilt or are not claude', () => {
    const rows = followingPaneRows(
      [
        pane({ id: 'x', canRebuild: false }),
        pane({ id: 'y', realized: false }),
        pane({ id: 'z', agentKey: 'codex' }),
      ],
      opts(['x', 'y', 'z'], 'home'),
    )
    expect(rows).toEqual([])
  })

  it('marks a busy pane as running so the caller can ask first', () => {
    const rows = followingPaneRows([pane({ id: 'a', busy: true }), pane({ id: 'b' })], opts(['a', 'b'], 'home'))
    expect(rows.map((r) => [r.paneId, r.state])).toEqual([
      ['a', 'running'],
      ['b', 'idle'],
    ])
  })
})
