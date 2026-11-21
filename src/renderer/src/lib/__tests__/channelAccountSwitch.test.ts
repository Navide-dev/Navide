import { describe, it, expect } from 'vitest'
import { channelAccountMenu, type ChannelAccountDeps } from '../channelAccountSwitch'

// Plan telegram_904bcf: a chat's /account menu reads the rows the usage badge
// shows — the name the pane header chip shows (alias, else the email's local
// part, never the whole address), remaining %, stale, signed out — for claude
// only. API key accounts are not offered.
function deps(over: Partial<ChannelAccountDeps> = {}): ChannelAccountDeps {
  const profiles: Record<string, { agentKey: string; name: string; nameIsCustom?: boolean; authKind?: string }> = {
    'p-work': { agentKey: 'claude', name: 'Work', nameIsCustom: true },
    'p-two': { agentKey: 'claude', name: 'Account 2' },
    'p-key': { agentKey: 'claude', name: 'Key', authKind: 'api-key' },
  }
  return {
    accounts: {
      findProfile: (id) => (id ? profiles[id] : undefined),
      defaultProfileId: () => 'p-work',
      aliasFor: (_agentKey, id) => (id && profiles[id]?.nameIsCustom ? profiles[id].name : undefined),
      profilesForAgent: () => Object.entries(profiles).map(([id, p]) => ({ id, authKind: p.authKind })),
      orderedSlotIds: () => [null, ...Object.keys(profiles)],
      signedOut: (_agentKey, id) => id === 'p-two',
      email: (_agentKey, id) => (id === 'p-work' ? 'work.person@example.com' : null),
    },
    usage: (_agentKey, id) => (id === 'p-work' ? { remaining: 2, stale: false } : id === null ? { remaining: 80, stale: true } : { remaining: null, stale: false }),
    fixedCount: () => 6,
    ...over,
  }
}

describe('channelAccountMenu', () => {
  it('lists Default and every login account with the badge figures, the active one marked', () => {
    const menu = channelAccountMenu({ agentKey: 'claude' }, deps())
    expect(menu).toEqual({
      status: 'ok',
      agentKey: 'claude',
      activeId: 'p-work',
      fixedCount: 6,
      rows: [
        { id: '__default__', label: 'Default', builtin: true, remaining: 80, stale: true, signedOut: false, active: false },
        { id: 'p-work', label: 'Work', builtin: false, remaining: 2, stale: false, signedOut: false, active: true },
        { id: 'p-two', label: 'Account 2', builtin: false, remaining: null, stale: false, signedOut: true, active: false },
      ],
    })
  })

  it('names an account without an alias by its email\'s local part, as the desktop header chip does', () => {
    const d = deps()
    d.accounts.email = (_agentKey, id) => (id === 'p-two' ? 'second.user@example.com' : id === null ? 'home.user@example.com' : null)
    const menu = channelAccountMenu({ agentKey: 'claude' }, d) as { rows: { id: string; label: string; builtin: boolean }[] }
    expect(menu.rows.map((r) => [r.id, r.label, r.builtin])).toEqual([
      ['__default__', 'home.user', false],
      ['p-work', 'Work', false],
      ['p-two', 'second.user', false],
    ])
    expect(JSON.stringify(menu)).not.toContain('@')
  })

  it('marks the built-in Default active when no account is', () => {
    const d = deps()
    d.accounts.defaultProfileId = () => null
    const menu = channelAccountMenu({ agentKey: 'claude' }, d) as { activeId: string; rows: { id: string; active: boolean }[] }
    expect(menu.activeId).toBe('__default__')
    expect(menu.rows.filter((r) => r.active).map((r) => r.id)).toEqual(['__default__'])
  })

  it('lists the accounts in the user\'s order, as automatic switching tries them', () => {
    const d = deps()
    d.accounts.orderedSlotIds = () => ['p-two', 'p-key', null, 'p-work']
    const menu = channelAccountMenu({ agentKey: 'claude' }, d) as { rows: { id: string }[] }
    expect(menu.rows.map((r) => r.id)).toEqual(['p-two', '__default__', 'p-work'])
  })

  it('refuses any CLI but claude', () => {
    expect(channelAccountMenu({ agentKey: 'codex' }, deps())).toEqual({ status: 'unsupported', agentKey: 'codex' })
  })
})
