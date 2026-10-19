// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_DIR_REMINDED_KEY,
  chainsDirLogin,
  dirLoginLanded,
  dirLoginReminderTargets,
  loadDirLoginReminded,
  saveDirLoginReminded,
  skippedDirLogins,
  type PendingLogin,
} from '../accountDirLoginChain'

const slot = (agentKey = 'claude'): PendingLogin => ({ paneId: 'p1', agentKey, step: 'slot' })
const dir = (paneId = 'p2'): PendingLogin => ({ paneId, agentKey: 'claude', step: 'dir' })
const none = () => false
const all = () => true

afterEach(() => {
  localStorage.clear()
})

describe('chainsDirLogin: a finished slot sign-in goes on to the own-folder sign-in', () => {
  it('chains a claude account whose own folder is not signed in yet', () => {
    expect(chainsDirLogin(slot(), 'acct-2', none, null)).toBe(true)
  })

  it('never chains another vendor: its sign-in ends as it does on main', () => {
    for (const agentKey of ['codex', 'kimi', 'grok', 'opencode']) {
      expect(chainsDirLogin(slot(agentKey), 'acct-2', none, null), agentKey).toBe(false)
    }
  })

  it('does not chain an account whose own folder is already signed in', () => {
    expect(chainsDirLogin(slot(), 'acct-2', all, null)).toBe(false)
  })

  it('never chains the built-in Default, which has no own folder', () => {
    expect(chainsDirLogin(slot(), '__default__', none, null)).toBe(false)
  })

  it('does not chain from the own-folder step itself', () => {
    expect(chainsDirLogin(dir(), 'acct-2', none, null)).toBe(false)
  })

  it('does not chain an account that became the active one while step one was open', () => {
    // The live account signs in on the live login; a folder sign-in is not
    // opened for it here, as #433 refuses it to agents.
    expect(chainsDirLogin(slot(), 'acct-2', none, 'acct-2')).toBe(false)
    expect(chainsDirLogin(slot(), 'acct-2', none, 'acct-3')).toBe(true)
  })
})

describe('dirLoginLanded: the own-folder step ends only on a real folder login', () => {
  it('ends once the folder is signed in', () => {
    expect(dirLoginLanded(dir(), 'acct-2', all)).toBe(true)
  })

  it('keeps waiting on a broadcast that does not show the folder signed in', () => {
    expect(dirLoginLanded(dir(), 'acct-2', none)).toBe(false)
  })

  it('is not about the slot step', () => {
    expect(dirLoginLanded(slot(), 'acct-2', all)).toBe(false)
  })
})

describe('skippedDirLogins: closing the own-folder pane leaves only a reminder', () => {
  it('reports a dir step whose pane is gone', () => {
    const pending = new Map<string, PendingLogin>([['acct-2', dir('p2')]])
    expect(skippedDirLogins(pending, new Set(['p9']))).toEqual(['acct-2'])
  })

  it('ignores a dir step whose pane is still open', () => {
    const pending = new Map<string, PendingLogin>([['acct-2', dir('p2')]])
    expect(skippedDirLogins(pending, new Set(['p2']))).toEqual([])
  })

  it('leaves a closed slot-step pane exactly as main does', () => {
    const pending = new Map<string, PendingLogin>([['acct-2', slot()]])
    expect(skippedDirLogins(pending, new Set())).toEqual([])
  })
})

describe('dirLoginReminderTargets: an existing account is reminded once', () => {
  const signedIn = (id: string) => id !== 'acct-out'

  it('picks a claude account signed in to its slot but not to its own folder', () => {
    expect(dirLoginReminderTargets(['acct-2', 'acct-3'], signedIn, (id) => id === 'acct-3', new Set())).toEqual([
      'acct-2',
    ])
  })

  it('skips an account already reminded, one not signed in at all, and the Default', () => {
    expect(
      dirLoginReminderTargets(['acct-2', 'acct-out', '__default__'], signedIn, none, new Set(['acct-2'])),
    ).toEqual([])
  })

  it('remembers the reminded accounts across windows and reloads', () => {
    saveDirLoginReminded(new Set(['acct-2']))
    expect(localStorage.getItem(ACCOUNT_DIR_REMINDED_KEY)).toBe('["acct-2"]')
    expect([...loadDirLoginReminded()]).toEqual(['acct-2'])
  })

  it('reads a missing or corrupt entry as nobody reminded yet', () => {
    expect(loadDirLoginReminded().size).toBe(0)
    localStorage.setItem(ACCOUNT_DIR_REMINDED_KEY, '{nope')
    expect(loadDirLoginReminded().size).toBe(0)
  })
})
