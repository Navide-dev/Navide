import { describe, it, expect } from 'vitest'
import { channelAccountMenu, type ChannelAccountDeps } from '../channelAccountSwitch'

// Plan telegram_904bcf: a chat's /account menu reads the rows the usage badge
// shows — names (never the email identity), remaining %, stale, signed out —
// for claude only. API key accounts are not offered.
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
      signedOut: (_agentKey, id) => id === 'p-two',
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
        { id: '__default__', label: 'Default', remaining: 80, stale: true, signedOut: false, active: false },
        { id: 'p-work', label: 'Work', remaining: 2, stale: false, signedOut: false, active: true },
        { id: 'p-two', label: 'Account 2', remaining: null, stale: false, signedOut: true, active: false },
      ],
    })
  })

  it('marks the built-in Default active when no account is', () => {
    const d = deps()
    d.accounts.defaultProfileId = () => null
    const menu = channelAccountMenu({ agentKey: 'claude' }, d) as { activeId: string; rows: { id: string; active: boolean }[] }
    expect(menu.activeId).toBe('__default__')
    expect(menu.rows.filter((r) => r.active).map((r) => r.id)).toEqual(['__default__'])
  })

  it('refuses any CLI but claude', () => {
    expect(channelAccountMenu({ agentKey: 'codex' }, deps())).toEqual({ status: 'unsupported', agentKey: 'codex' })
  })
})
