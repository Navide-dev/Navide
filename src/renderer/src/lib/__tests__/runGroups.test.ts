import { describe, it, expect } from 'vitest'
import {
  groupPeers,
  parseLegacyRunGroups,
  resolveActiveTab,
  resolveManualSpawnGroupId,
  resolveSpawnGroupId,
  runGroupCreatedAt,
  savedGroupToRecreate,
} from '../runGroups'

describe('resolveActiveTab', () => {
  const groups = [{ id: 'rg-default' }, { id: 'rg-1' }, { id: 'rg-2' }]

  it('keeps the current tab when it still exists', () => {
    expect(resolveActiveTab(groups, 'rg-1')).toBe('rg-1')
  })

  it("keeps the special 'manual' tab even with no groups", () => {
    expect(resolveActiveTab([], 'manual')).toBe('manual')
    expect(resolveActiveTab(groups, 'manual')).toBe('manual')
  })

  it('falls back to the last remaining group when the current tab was deleted', () => {
    // simulates a peer window deleting the group this window was viewing
    expect(resolveActiveTab(groups, 'rg-removed')).toBe('rg-2')
  })

  it("falls back to 'manual' when no groups remain", () => {
    expect(resolveActiveTab([], 'rg-1')).toBe('manual')
  })

  it("treats an empty current id as invalid and falls back", () => {
    expect(resolveActiveTab(groups, '')).toBe('rg-2')
    expect(resolveActiveTab([], '')).toBe('manual')
  })
})

describe('resolveSpawnGroupId', () => {
  const groups = [{ id: 'run-a' }, { id: 'run-b' }]

  it('honours a group the caller asked for outright', () => {
    // The sidebar's per-group ＋ can name a group the active tab is not showing.
    expect(resolveSpawnGroupId(groups, 'run-a', 'run-b')).toBe('run-b')
  })

  it('ignores an asked-for group this workspace does not have', () => {
    // Run groups are per-workspace and only the viewed one's are loaded, so an
    // unknown id would leave the pane on no tab at all.
    expect(resolveSpawnGroupId(groups, 'run-a', 'run-elsewhere')).toBe('run-a')
  })

  it('falls back to the active tab when nothing was asked for', () => {
    expect(resolveSpawnGroupId(groups, 'run-b')).toBe('run-b')
    expect(resolveSpawnGroupId(groups, 'run-b', '')).toBe('run-b')
  })

  it('still leaves the synthetic manual tab unassigned', () => {
    expect(resolveSpawnGroupId(groups, 'manual')).toBe('')
  })
})

describe('resolveManualSpawnGroupId', () => {
  const groups = [{ id: 'run-a' }, { id: 'run-b' }]

  it('keeps a manual pane in the currently viewed run tab', () => {
    expect(resolveManualSpawnGroupId(groups, 'run-b')).toBe('run-b')
  })

  it('leaves panes unassigned in the synthetic manual tab', () => {
    expect(resolveManualSpawnGroupId(groups, 'manual')).toBe('')
  })

  it('does not assign a stale tab to an unrelated run', () => {
    expect(resolveManualSpawnGroupId(groups, 'missing')).toBe('')
  })
})

describe('runGroupCreatedAt', () => {
  const NOW = 1_800_000_000_000

  it('recovers the minting time from an `rg-<epoch ms>` id', () => {
    // A rebuilt group sorts where it always belonged instead of after every
    // group made since.
    expect(runGroupCreatedAt('rg-1755000000000', NOW)).toBe(1755000000000)
  })

  it('takes now for the fixed default id, which carries no time', () => {
    expect(runGroupCreatedAt('rg-default', NOW)).toBe(NOW)
  })

  it('takes now for an id from some other scheme', () => {
    expect(runGroupCreatedAt('run-1755000000000', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('rg-', NOW)).toBe(NOW)
  })

  it('takes now rather than trusting a nonsensical stamp', () => {
    expect(runGroupCreatedAt('rg--5', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('rg-0', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('rg-abc', NOW)).toBe(NOW)
    expect(runGroupCreatedAt('rg-1.5', NOW)).toBe(NOW)
    // Beyond Number.MAX_SAFE_INTEGER the value read back is not the value
    // written, so it is no better evidence than now.
    expect(runGroupCreatedAt('rg-99999999999999999999', NOW)).toBe(NOW)
  })

  it('defaults to the wall clock when no time is passed', () => {
    const before = Date.now()
    const got = runGroupCreatedAt('rg-default')
    expect(got).toBeGreaterThanOrEqual(before)
    expect(got).toBeLessThanOrEqual(Date.now())
  })
})

describe('parseLegacyRunGroups', () => {
  it('returns the stored groups verbatim', () => {
    const groups = [{ id: 'rg-default', name: '預設', createdAt: 1 }]
    expect(parseLegacyRunGroups(JSON.stringify(groups))).toEqual(groups)
  })

  it('returns null when nothing was stored (default group may be created)', () => {
    expect(parseLegacyRunGroups(null)).toBeNull()
  })

  it('keeps an explicitly stored empty list (user deleted the default group)', () => {
    expect(parseLegacyRunGroups('[]')).toEqual([])
  })

  it('yields [] (not null) for corrupt or non-array data', () => {
    expect(parseLegacyRunGroups('{not json')).toEqual([])
    expect(parseLegacyRunGroups('{"id":"rg-1"}')).toEqual([])
  })
})


describe('groupPeers', () => {
  const pane = (
    id: string,
    over: Partial<{ runGroupId: string; workspacePath: string; messagingName: string }> = {},
  ) => ({ id, workspacePath: '/ws/a', messagingName: id, ...over })

  it('reaches the sender group-mates and nobody else', () => {
    const panes = [
      pane('me', { runGroupId: 'rg-1' }),
      pane('mate', { runGroupId: 'rg-1' }),
      pane('other-group', { runGroupId: 'rg-2' }),
      pane('other-ws', { runGroupId: 'rg-1', workspacePath: '/ws/b' }),
    ]
    expect(groupPeers(panes, 'me')?.map((p) => p.id)).toEqual(['mate'])
  })

  it('never includes the sender itself', () => {
    const panes = [pane('me', { runGroupId: 'rg-1' })]
    expect(groupPeers(panes, 'me')).toEqual([])
  })

  it('skips panes that cannot receive at all', () => {
    // A plain terminal pane has no messaging handle, so it is not addressable.
    const panes = [
      pane('me', { runGroupId: 'rg-1' }),
      { id: 'terminal', workspacePath: '/ws/a', runGroupId: 'rg-1' },
    ]
    expect(groupPeers(panes, 'me')).toEqual([])
  })

  it('lets unassigned panes reach each other', () => {
    // Otherwise "broadcast to my group" would mean nothing for a user who never
    // made a group — a silent surprise rather than a useful default.
    const panes = [pane('me'), pane('also-loose'), pane('grouped', { runGroupId: 'rg-1' })]
    expect(groupPeers(panes, 'me')?.map((p) => p.id)).toEqual(['also-loose'])
  })

  it('treats a trailing slash on a workspace path as the same workspace', () => {
    const panes = [
      pane('me', { workspacePath: '/ws/a/' }),
      pane('mate', { workspacePath: '/ws/a' }),
    ]
    expect(groupPeers(panes, 'me')?.map((p) => p.id)).toEqual(['mate'])
  })

  it('answers null when the sender is not here at all', () => {
    // Distinct from an empty group: the caller reports the two differently.
    expect(groupPeers([pane('someone')], 'ghost')).toBeNull()
  })
})

describe('savedGroupToRecreate', () => {
  const viewed = [{ id: 'rg-1791251453915' }]

  it('rebuilds a missing group of the workspace on screen under the same id', () => {
    expect(savedGroupToRecreate(viewed, 'rg-1788161983083', '/ws/a', '/ws/a/', 42)).toEqual({
      id: 'rg-1788161983083',
      name: 'Run 2',
      createdAt: 42,
    })
  })

  it('adds nothing when the group is already listed', () => {
    expect(savedGroupToRecreate(viewed, 'rg-1791251453915', '/ws/a', '/ws/a')).toBeNull()
  })

  it("never files another workspace's group into the list on screen", () => {
    // A relaunch restores every held workspace, while the list on screen is
    // the viewed one's. Recreating there put an empty `Run N` tab into the
    // viewed project for each group the others' panes carried — once per
    // relaunch, for every new id.
    expect(savedGroupToRecreate(viewed, 'rg-default', '/ws/other', '/ws/a')).toBeNull()
  })
})
