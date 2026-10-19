// @vitest-environment happy-dom
// Scheme A of plan claude_f1bf4b: the account list swaps the live credential,
// every claude pane follows it unless fixed to an account's own config dir.
// The follow set is what tells a fixed pane from a following one (every pane
// carries a bookkeeping pin), so it now decides where a pane spawns.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACCOUNT_FOLLOW_PANES_KEY,
  accountSpawnPin,
  createAccountFollowStore,
  isAccountFixed,
  restoreSpawnPin,
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

describe('restoreSpawnPin: a restore decides the pin only once the account dirs are known', () => {
  // The restart of 10-18 22:24: a following pane whose saved pin names an
  // account signed in inside its own dir was restored before cli_profiles.list
  // arrived, read that dir as not signed in, sent the pin and was put in the
  // old account's dir.
  function gate(signedAfterLoad: string[], loadSucceeds = true) {
    const dirs = new Set<string>()
    let loaded = false
    return {
      signed: (id: string) => dirs.has(id),
      gate: {
        loaded: () => loaded,
        load: vi.fn(async () => {
          if (!loadSucceeds) return
          signedAfterLoad.forEach((id) => dirs.add(id))
          loaded = true
        }),
        disclose: vi.fn(),
      },
    }
  }

  it('waits for the account dirs, so a following pane is not pinned back to its old account', async () => {
    const g = gate(['old'])
    expect(await restoreSpawnPin('old', true, g.signed, g.gate)).toBeUndefined()
    expect(g.gate.load).toHaveBeenCalledTimes(1)
    expect(g.gate.disclose).not.toHaveBeenCalled()
  })

  it('once loaded, decides exactly as accountSpawnPin and does not load again', async () => {
    const g = gate(['work'])
    await g.gate.load()
    g.gate.load.mockClear()
    for (const [pin, following] of [['work', true], ['work', false], ['home', true], ['__default__', true], [undefined, true]] as const) {
      expect(await restoreSpawnPin(pin, following, g.signed, g.gate)).toBe(accountSpawnPin(pin, following, g.signed))
    }
    expect(g.gate.load).not.toHaveBeenCalled()
  })

  it('a pane that does not follow keeps its pin as on main, without waiting', async () => {
    const g = gate(['work'])
    expect(await restoreSpawnPin('work', false, g.signed, g.gate)).toBe('work')
    expect(g.gate.load).not.toHaveBeenCalled()
  })

  it('when the account data still cannot be loaded, sends the pin as on main and says so', async () => {
    const g = gate(['old'], false)
    expect(await restoreSpawnPin('old', true, g.signed, g.gate)).toBe('old')
    expect(g.gate.disclose).toHaveBeenCalledWith('old')
  })
})
