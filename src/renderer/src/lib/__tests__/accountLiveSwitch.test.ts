// @vitest-environment happy-dom
// Scheme A of plan claude_f1bf4b: the account list swaps the live credential,
// every claude pane follows it unless fixed to an account's own config dir.
// The follow set is what tells a fixed pane from a following one (every pane
// carries a bookkeeping pin), so it now decides where a pane spawns.
import { beforeEach, describe, expect, it } from 'vitest'

import {
  ACCOUNT_FOLLOW_PANES_KEY,
  accountSpawnPin,
  createAccountFollowStore,
  isAccountFixed,
} from '../accountFollowPanes'

describe('follow set: add / remove', () => {
  beforeEach(() => localStorage.clear())

  it('adds and removes a pane, persisted', () => {
    const store = createAccountFollowStore()
    store.add('p1')
    expect(createAccountFollowStore().has('p1')).toBe(true)
    store.remove('p1')
    expect(createAccountFollowStore().has('p1')).toBe(false)
  })

  it('adding twice and removing a stranger are no-ops', () => {
    const store = createAccountFollowStore()
    store.add('p1')
    store.add('p1')
    store.remove('nobody')
    expect([...createAccountFollowStore().ids.value]).toEqual(['p1'])
  })
})

describe('follow set: two windows never overwrite each other', () => {
  beforeEach(() => localStorage.clear())

  it('a write re-reads what another window stored first', () => {
    const a = createAccountFollowStore()
    const b = createAccountFollowStore()
    a.add('from-a')
    b.add('from-b')
    b.toggle('from-b-2')
    a.rekey('from-a', 'from-a-new')
    const fresh = createAccountFollowStore()
    expect(fresh.has('from-a-new')).toBe(true)
    expect(fresh.has('from-b')).toBe(true)
    expect(fresh.has('from-b-2')).toBe(true)
    expect(fresh.has('from-a')).toBe(false)
  })

  it("picks up another window's write from the storage event", () => {
    const a = createAccountFollowStore()
    localStorage.setItem(ACCOUNT_FOLLOW_PANES_KEY, JSON.stringify(['elsewhere']))
    window.dispatchEvent(new StorageEvent('storage', { key: ACCOUNT_FOLLOW_PANES_KEY }))
    expect(a.has('elsewhere')).toBe(true)
  })
})

describe('accountSpawnPin: which pin a (re)spawn sends', () => {
  const dirs = new Set(['work'])
  const signed = (id: string) => dirs.has(id)

  it('drops a following pane\'s pin when that pin would put it in an account dir', () => {
    expect(accountSpawnPin('work', true, signed)).toBeUndefined()
  })

  it('keeps every other pin exactly as before', () => {
    expect(accountSpawnPin('work', false, signed)).toBe('work')
    expect(accountSpawnPin('home', true, signed)).toBe('home')
    expect(accountSpawnPin('__default__', true, signed)).toBe('__default__')
    expect(accountSpawnPin(undefined, true, signed)).toBeUndefined()
  })

  it('with no account dir anywhere, every pin is sent as on main', () => {
    const none = () => false
    expect(accountSpawnPin('work', true, none)).toBe('work')
    expect(accountSpawnPin('work', false, none)).toBe('work')
  })
})

describe('isAccountFixed', () => {
  const signed = (id: string) => id === 'work'

  it('is fixed only when not following and pinned to a signed-in dir', () => {
    expect(isAccountFixed('work', false, signed)).toBe(true)
    expect(isAccountFixed('work', true, signed)).toBe(false)
    expect(isAccountFixed('home', false, signed)).toBe(false)
    expect(isAccountFixed('__default__', false, signed)).toBe(false)
    expect(isAccountFixed(undefined, false, signed)).toBe(false)
  })
})
