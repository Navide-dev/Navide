import { describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceRestoreSession,
  explicitRestoreDecision,
  normalizeAutoResumeOnReconnect,
  normalizeResumeBehavior,
  normalizeRestoreScope,
  pendingRestorePaneIds,
  resolveWorkspaceRestoreSession,
  restoreScopeTargetIds,
  runWithConcurrency,
  settleWorkspaceRestoreSession,
  stripPinnedSessionId,
  stripDeadOpencodeAutoFlag,
  wasLiveAtLastLaunch,
} from '../resumeBehavior'

describe('normalizeResumeBehavior', () => {
  it('passes through the known behaviors', () => {
    expect(normalizeResumeBehavior('always')).toBe('always')
    expect(normalizeResumeBehavior('never')).toBe('never')
    expect(normalizeResumeBehavior('ask')).toBe('ask')
  })

  it('defaults anything else to always', () => {
    expect(normalizeResumeBehavior(undefined)).toBe('always')
    expect(normalizeResumeBehavior(null)).toBe('always')
    expect(normalizeResumeBehavior('sometimes')).toBe('always')
    expect(normalizeResumeBehavior(42)).toBe('always')
  })
})

describe('normalizeAutoResumeOnReconnect', () => {
  // Default ON: a backend crash interrupted work the user never asked to stop,
  // so the automation is the expected behavior and the setting exists to
  // switch it off. An install that predates the key gets the automation too.
  it('defaults to on for anything that is not an explicit false', () => {
    expect(normalizeAutoResumeOnReconnect(undefined)).toBe(true)
    expect(normalizeAutoResumeOnReconnect(null)).toBe(true)
    expect(normalizeAutoResumeOnReconnect(true)).toBe(true)
  })

  it('is off only when explicitly disabled', () => {
    expect(normalizeAutoResumeOnReconnect(false)).toBe(false)
  })
})

describe('normalizeRestoreScope', () => {
  it('accepts the configured restore scopes', () => {
    expect(normalizeRestoreScope('single')).toBe('single')
    expect(normalizeRestoreScope('page')).toBe('page')
    expect(normalizeRestoreScope('tab')).toBe('tab')
    expect(normalizeRestoreScope('all')).toBe('all')
    expect(normalizeRestoreScope('auto')).toBe('auto')
  })

  it('defaults missing or invalid values to one CLI', () => {
    expect(normalizeRestoreScope(undefined)).toBe('single')
    expect(normalizeRestoreScope('workspace')).toBe('single')
  })
})

describe('restoreScopeTargetIds', () => {
  const base = {
    pendingPaneIds: ['a', 'b', 'c', 'd'],
    activeTabPaneIds: ['a', 'b', 'c'],
    gridPagePaneIds: ['b', 'c'],
    minimizedPaneIds: new Set(['c']),
  }

  it('uses the focused eligible pane for a single cold, tab, or layout restore', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'single', focusedPaneId: 'b', trigger: 'layout' })).toEqual(['b'])
  })

  it('uses the first eligible pane on a newly selected Grid page', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'single', focusedPaneId: 'a', trigger: 'grid-page' })).toEqual(['b'])
  })

  it('uses the supplied Grid page independent of the active layout', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'page' })).toEqual(['b'])
  })

  it('uses every eligible pane in the active tab', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'tab' })).toEqual(['a', 'b'])
  })

  it('uses every eligible pending pane for all, active tab first', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'all' })).toEqual(['a', 'b', 'd'])
  })

  it('uses only the panes live at the last launch for auto, active tab first', () => {
    const liveAtLastLaunchIds = new Set(['b', 'c', 'd'])
    expect(restoreScopeTargetIds({ ...base, scope: 'auto', liveAtLastLaunchIds })).toEqual(['b', 'd'])
  })

  it('restores nothing for auto when no pane was live at the last launch', () => {
    expect(restoreScopeTargetIds({ ...base, scope: 'auto' })).toEqual([])
    expect(restoreScopeTargetIds({ ...base, scope: 'auto', liveAtLastLaunchIds: new Set() })).toEqual([])
  })

  it('leaves the other four scopes unchanged by the live set', () => {
    const liveAtLastLaunchIds = new Set(['d'])
    for (const scope of ['single', 'page', 'tab', 'all'] as const) {
      for (const trigger of ['cold', 'grid-page'] as const) {
        const opts = { ...base, scope, focusedPaneId: 'b', trigger }
        expect(restoreScopeTargetIds({ ...opts, liveAtLastLaunchIds })).toEqual(restoreScopeTargetIds(opts))
      }
    }
  })
})

describe('wasLiveAtLastLaunch', () => {
  it('matches the stamp against the previous launch id', () => {
    expect(wasLiveAtLastLaunch({ last_live_launch: 'L1' }, 'L1')).toBe(true)
    expect(wasLiveAtLastLaunch({ last_live_launch: 'L0' }, 'L1')).toBe(false)
  })

  it('treats a missing stamp or an unknown previous launch as not live', () => {
    expect(wasLiveAtLastLaunch({}, 'L1')).toBe(false)
    expect(wasLiveAtLastLaunch({ last_live_launch: '' }, '')).toBe(false)
    expect(wasLiveAtLastLaunch({ last_live_launch: 'L1' }, '')).toBe(false)
    expect(wasLiveAtLastLaunch({ last_live_launch: 'L1' }, 42)).toBe(false)
  })
})

describe('runWithConcurrency', () => {
  it('runs at most the given number of tasks at once, in id order', async () => {
    const started: string[] = []
    let active = 0
    let peak = 0
    const resolvers = new Map<string, () => void>()
    const run = runWithConcurrency(['a', 'b', 'c', 'd'], 2, (id) => {
      started.push(id)
      active += 1
      peak = Math.max(peak, active)
      return new Promise<void>((resolve) => {
        resolvers.set(id, () => { active -= 1; resolve() })
      })
    })
    await Promise.resolve()
    expect(started).toEqual(['a', 'b'])
    resolvers.get('a')!()
    await Promise.resolve()
    expect(started).toEqual(['a', 'b', 'c'])
    resolvers.get('b')!()
    resolvers.get('c')!()
    await Promise.resolve()
    resolvers.get('d')!()
    await run
    expect(started).toEqual(['a', 'b', 'c', 'd'])
    expect(peak).toBe(2)
  })

  it('resolves immediately with no ids', async () => {
    await expect(runWithConcurrency([], 2, async () => {})).resolves.toBeUndefined()
  })
})

describe('pendingRestorePaneIds', () => {
  it('uses workspace, unrealized state, and deferred metadata rather than batch identity', () => {
    expect(pendingRestorePaneIds([
      { id: 'pending', workspacePath: '/ws/a', realized: false, deferredRestore: { batch: { session: {} } } },
      { id: 'realized', workspacePath: '/ws/a', realized: true, deferredRestore: {} },
      { id: 'no-deferred', workspacePath: '/ws/a', realized: false },
      { id: 'other-workspace', workspacePath: '/ws/b', realized: false, deferredRestore: {} },
    ], '/ws/a')).toEqual(['pending'])
  })
})

describe('stripPinnedSessionId', () => {
  const id = 'abcdef12-3456-7890-abcd-ef1234567890'

  it('removes a space-separated --session-id and its value', () => {
    expect(stripPinnedSessionId(`claude --session-id ${id}`)).toBe('claude')
    expect(stripPinnedSessionId(`claude --session-id ${id} --foo`)).toBe('claude --foo')
  })

  it('removes an =-separated --session-id', () => {
    expect(stripPinnedSessionId(`claude --session-id=${id}`)).toBe('claude')
  })

  it('leaves commands without --session-id untouched', () => {
    expect(stripPinnedSessionId('claude --dangerously-skip-permissions')).toBe(
      'claude --dangerously-skip-permissions'
    )
    expect(stripPinnedSessionId('')).toBe('')
  })
})

describe('stripDeadOpencodeAutoFlag', () => {
  it('drops the flag a saved opencode pane could never have run', () => {
    expect(stripDeadOpencodeAutoFlag('opencode', 'opencode --auto')).toBe('opencode')
    expect(stripDeadOpencodeAutoFlag('opencode', 'opencode --auto --port 1234'))
      .toBe('opencode --port 1234')
  })

  it('leaves kilo alone — its root command really takes --auto', () => {
    expect(stripDeadOpencodeAutoFlag('kilo', 'kilo --auto')).toBe('kilo --auto')
  })

  it('leaves an opencode command without the flag untouched', () => {
    expect(stripDeadOpencodeAutoFlag('opencode', 'opencode --port 1234'))
      .toBe('opencode --port 1234')
    expect(stripDeadOpencodeAutoFlag('opencode', '')).toBe('')
  })

  it('does not touch a longer flag that merely starts with --auto', () => {
    expect(stripDeadOpencodeAutoFlag('opencode', 'opencode --autoupdate'))
      .toBe('opencode --autoupdate')
  })
})

describe('workspace restore session', () => {
  const create = (behavior: unknown = 'always', scope: unknown = 'single') =>
    createWorkspaceRestoreSession({ workspacePath: '/ws/a', behavior, scope })

  it('snapshots the configured behavior and scope for the workspace open', () => {
    expect(create('ask', 'page')).toMatchObject({
      workspacePath: '/ws/a', behavior: 'ask', scope: 'page',
    })
  })

  it('always → resume without prompting', async () => {
    const ask = vi.fn()
    await expect(
      resolveWorkspaceRestoreSession({ session: create('always'), restorableCount: 3, ask })
    ).resolves.toBe('resume')
    expect(ask).not.toHaveBeenCalled()
  })

  it('never → fresh without prompting', async () => {
    const ask = vi.fn()
    await expect(
      resolveWorkspaceRestoreSession({ session: create('never'), restorableCount: 3, ask })
    ).resolves.toBe('fresh')
    expect(ask).not.toHaveBeenCalled()
  })

  it('ask with nothing restorable → resume without prompting', async () => {
    const ask = vi.fn()
    await expect(
      resolveWorkspaceRestoreSession({
        session: create('ask'), restorableCount: 0, ask,
      })
    ).resolves.toBe('resume')
    expect(ask).not.toHaveBeenCalled()
  })

  it('ask records the selected scope or fresh decision for the session', async () => {
    const resume = create('ask')
    await expect(
      resolveWorkspaceRestoreSession({ session: resume, restorableCount: 3, ask: async () => 'tab' })
    ).resolves.toBe('resume')
    expect(resume.scope).toBe('tab')
    expect(resume.decision).toBe('resume')
    const fresh = create('ask')
    await expect(
      resolveWorkspaceRestoreSession({ session: fresh, restorableCount: 3, ask: async () => 'fresh' })
    ).resolves.toBe('fresh')
    expect(fresh.decision).toBe('fresh')
  })

  it('keeps cancellation for automatic triggers but permits an explicit retry', async () => {
    const session = create('ask')
    await expect(
      resolveWorkspaceRestoreSession({ session, restorableCount: 3, ask: async () => null })
    ).resolves.toBe('cancelled')
    const automaticAsk = vi.fn(async () => 'page' as const)
    await expect(
      resolveWorkspaceRestoreSession({ session, restorableCount: 3, ask: automaticAsk })
    ).resolves.toBe('cancelled')
    expect(automaticAsk).not.toHaveBeenCalled()
    await expect(
      resolveWorkspaceRestoreSession({ session, restorableCount: 3, retryCancelled: true, ask: async () => 'page' })
    ).resolves.toBe('resume')
    expect(session.scope).toBe('page')
  })

  it('settles a preselected decision without rereading settings', () => {
    const session = create('always', 'single')
    settleWorkspaceRestoreSession(session, 'fresh')
    expect(session).toMatchObject({ behavior: 'always', scope: 'single', decision: 'fresh' })
  })

  describe('explicitRestoreDecision', () => {
    it('resumes an undecided or cancelled session without settling it', () => {
      // Naming one pane answers "which ones", so ask collapses to resume — but
      // the workspace-wide question stays open for the user's own next click.
      const undecided = create('ask')
      expect(explicitRestoreDecision(undecided)).toBe('resume')
      expect(undecided.decision).toBeUndefined()

      const cancelled = create('ask')
      settleWorkspaceRestoreSession(cancelled, 'cancelled')
      expect(explicitRestoreDecision(cancelled)).toBe('resume')
      expect(cancelled.decision).toBe('cancelled')
    })

    it('keeps a decision the user already made', () => {
      const resume = create('ask')
      settleWorkspaceRestoreSession(resume, 'resume', 'page')
      expect(explicitRestoreDecision(resume)).toBe('resume')
      const fresh = create('never')
      settleWorkspaceRestoreSession(fresh, 'fresh')
      expect(explicitRestoreDecision(fresh)).toBe('fresh')
      expect(fresh.decision).toBe('fresh')
    })

    it('opens fresh, not resumed, when the user chose never and nothing is settled yet', () => {
      // A pane reclaimed while idle can leave the session undecided. The agent
      // naming it must not turn `never` into a resume of the old conversation.
      const never = create('never')
      expect(explicitRestoreDecision(never)).toBe('fresh')
      expect(never.decision).toBeUndefined()
    })
  })
})
