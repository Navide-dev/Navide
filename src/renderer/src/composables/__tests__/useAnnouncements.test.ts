// @vitest-environment happy-dom
// Announcements centre feed: how the two sources (curated release notes and the
// live updater state) merge, how read state is persisted and bounded, and how a
// fresh install is baselined so it isn't greeted by every historical entry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { UpdateState } from '../../../../shared/updater'
import type { QuotaIncidentNotice } from '../useAnnouncements'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
  settingsSet: (key: string, value: unknown) => {
    store.set(key, value)
  },
}))

const READ_IDS_KEY = 'agentTeam.announcements.readIds'

/** Fresh module graph per test — the composable is a module-level singleton. */
async function load() {
  vi.resetModules()
  const mod = await import('../useAnnouncements')
  const { i18n } = await import('@navide/plugin-ui/foundation')
  return { ...mod, i18n }
}

function updateState(patch: Partial<UpdateState> = {}) {
  return ref<UpdateState>({ status: 'idle', currentVersion: '0.1.77', ...patch })
}

describe('useAnnouncements', () => {
  beforeEach(() => {
    store.clear()
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.1.77' }
  })

  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  it('lists every shipped release note, newest version first', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements } = await load()
    const a = useAnnouncements()

    expect(a.items.value.map((i) => i.version)).toEqual([
      '0.1.77', '0.1.76', '0.1.75', '0.1.74', '0.1.73',
      '0.1.72', '0.1.71', '0.1.70', '0.1.69', '0.1.68',
      '0.1.67', '0.1.66', '0.1.65',
    ])
    expect(a.items.value.every((i) => i.kind === 'release')).toBe(true)
    expect(a.items.value[0].id).toBe('release:0.1.77')
    expect(a.items.value[0].highlights.length).toBeGreaterThan(0)
    // No real timestamp exists for a curated entry, so none is invented.
    expect(a.items.value[0].createdAt).toBeUndefined()
  })

  it('hides release notes authored for versions the app has not reached', async () => {
    store.set(READ_IDS_KEY, [])
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.1.70' }
    const { useAnnouncements } = await load()

    expect(useAnnouncements().items.value.map((i) => i.version)).toEqual([
      '0.1.70', '0.1.69', '0.1.68', '0.1.67', '0.1.66', '0.1.65',
    ])
  })

  it('baselines a fresh install: everything present starts read', async () => {
    const { useAnnouncements } = await load()
    const a = useAnnouncements()

    expect(a.unreadCount.value).toBe(0)
    expect(a.items.value.every((i) => i.read)).toBe(true)
    // Stored oldest-first: persist() truncates to the tail, so the newest ids
    // have to sit at the end to survive a feed bigger than the cap.
    expect(store.get(READ_IDS_KEY)).toEqual(a.items.value.map((i) => i.id).reverse())
  })

  it('counts stored-but-unseen entries as unread and marks them read', async () => {
    store.set(READ_IDS_KEY, ['release:0.1.65'])
    const { useAnnouncements } = await load()
    const a = useAnnouncements()

    expect(a.unreadCount.value).toBe(12)

    a.markRead('release:0.1.77')
    expect(a.unreadCount.value).toBe(11)
    expect(store.get(READ_IDS_KEY)).toEqual(['release:0.1.65', 'release:0.1.77'])

    // Marking the same id again is a no-op, not a duplicate.
    a.markRead('release:0.1.77')
    expect(store.get(READ_IDS_KEY)).toEqual(['release:0.1.65', 'release:0.1.77'])

    a.markAllRead()
    expect(a.unreadCount.value).toBe(0)
    expect((store.get(READ_IDS_KEY) as string[]).length).toBe(13)
  })

  it('caps the persisted read set so the shared settings document stays small', async () => {
    store.set(READ_IDS_KEY, Array.from({ length: 100 }, (_, i) => `old:${i}`))
    const { useAnnouncements } = await load()
    const a = useAnnouncements()

    a.markRead('release:0.1.77')
    const ids = store.get(READ_IDS_KEY) as string[]
    expect(ids).toHaveLength(100)
    expect(ids[0]).toBe('old:1')
    expect(ids[99]).toBe('release:0.1.77')
  })

  it('markAllRead appends oldest-first so the cap drops the oldest ids', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements } = await load()
    const a = useAnnouncements()

    a.markAllRead()
    const ids = store.get(READ_IDS_KEY) as string[]
    // `items` is newest-first and persist() keeps only the tail, so appending
    // in feed order would put the NEWEST ids first — a feed longer than the cap
    // would truncate them away and resurrect them as unread.
    expect(ids[0]).toBe('release:0.1.65')
    expect(ids[ids.length - 1]).toBe('release:0.1.77')
  })

  it('re-localizes the feed when the locale changes', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements, i18n } = await load()
    const a = useAnnouncements()

    i18n.global.locale.value = 'zh-TW'
    const zh = a.items.value[0].title
    i18n.global.locale.value = 'en-US'
    const en = a.items.value[0].title

    expect(zh).not.toBe('')
    expect(en).not.toBe('')
    expect(en).not.toBe(zh)
  })

  it('tracks the updater through its status transitions', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements } = await load()
    const a = useAnnouncements()
    const state = updateState()
    a.setUpdateSource(state)

    // An idle updater contributes nothing.
    expect(a.items.value.every((i) => i.kind === 'release')).toBe(true)

    state.value = {
      status: 'available',
      currentVersion: '0.1.77',
      availableVersion: '0.1.78',
      releaseNotes: 'Fixes things',
      checkedAt: '2026-08-07T10:00:00.000Z',
    }
    let top = a.items.value[0]
    expect(top.id).toBe('update:0.1.78')
    expect(top.kind).toBe('update')
    expect(top.action).toBe('download')
    expect(top.highlights).toEqual(['Fixes things'])
    expect(top.createdAt).toBe(Date.parse('2026-08-07T10:00:00.000Z'))
    expect(top.read).toBe(false)

    state.value = { ...state.value, status: 'downloading', percent: 42 }
    top = a.items.value[0]
    expect(top.id).toBe('update:0.1.78')
    expect(top.action).toBeUndefined()
    expect(top.title).toContain('42')

    state.value = { ...state.value, status: 'downloaded', quitInstallArmed: true }
    top = a.items.value[0]
    expect(top.action).toBe('install')
    expect(top.note).toBeTruthy()

    // Read state is keyed on the version, so it survives those transitions.
    a.markRead('update:0.1.78')
    expect(a.items.value[0].read).toBe(true)
  })

  it('gives a run of failed background checks its own item', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements } = await load()
    const a = useAnnouncements()
    a.setUpdateSource(
      updateState({
        lastCheckFailure: { message: 'network down', count: 3, at: '2026-08-07T09:00:00.000Z' },
      })
    )

    const top = a.items.value[0]
    expect(top.id).toBe('update-failed')
    expect(top.kind).toBe('update')
    expect(top.highlights[0]).toContain('network down')
    expect(top.createdAt).toBe(Date.parse('2026-08-07T09:00:00.000Z'))
  })

  it('exposes the release id used by the What is New modal', async () => {
    const { releaseAnnouncementId } = await load()
    expect(releaseAnnouncementId('0.1.77')).toBe('release:0.1.77')
  })

  it('surfaces a scheduled job the backend disabled for a gone target, unread, once per notice', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements, i18n } = await load()
    const a = useAnnouncements()
    const before = a.unreadCount.value
    const ev = { id: 'j1', name: 'tk-watch', reason: 'target_gone', pane_id: 'p-9', count: 3 }
    a.noteSchedulerDisabled(ev, 1_800_000_000_000)
    a.noteSchedulerDisabled(ev, 1_800_000_000_000)
    const rows = a.items.value.filter((i) => i.kind === 'scheduler')
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe(i18n.global.t('announce.scheduler-disabled', { name: 'tk-watch' }))
    expect(rows[0].note).toBe(i18n.global.t('announce.scheduler-disabled-note', { n: 3 }))
    expect(rows[0].read).toBe(false)
    expect(a.unreadCount.value).toBe(before + 1)
    a.markRead(rows[0].id)
    expect(a.unreadCount.value).toBe(before)
  })

  describe('quota incidents', () => {
    const T0 = Date.parse('2026-09-21T10:00:00.000Z')

    function notice(patch: Partial<QuotaIncidentNotice> = {}): QuotaIncidentNotice {
      return {
        incidentId: 'inc-1',
        agentKey: 'claude',
        agentLabel: 'Claude Code',
        authScope: 'anthropic',
        epoch: 7,
        status: 'detected',
        cause: 'quota-exhausted',
        sourceLabel: 'dev@example.com',
        affected: { workspaces: 2, panes: 3 },
        candidates: [
          { slotId: 'slot-b', label: 'work@example.com', tier: 'fresh-headroom', detail: '5h 78% left' },
          { slotId: '__default__', label: 'Default', tier: 'unknown' },
        ],
        excluded: [{ label: 'spare@example.com', reason: 'signed-out' }],
        observedAt: T0,
        updatedAt: T0,
        ...patch,
      }
    }

    it('tops the feed with the incident and one typed switch button per candidate', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements, quotaAnnouncementId } = await load()
      const a = useAnnouncements()
      a.setUpdateSource(updateState({ status: 'available', availableVersion: '0.1.78' }))

      a.noteQuotaIncident(notice())

      const top = a.items.value[0]
      expect(top.id).toBe(quotaAnnouncementId('inc-1'))
      expect(top.kind).toBe('quota')
      expect(top.read).toBe(false)
      expect(top.createdAt).toBe(T0)
      expect(top.title).toContain('dev@example.com')
      expect(top.title).toContain('Claude Code')
      expect(top.highlights.join('\n')).toContain('work@example.com')
      expect(top.highlights.join('\n')).toContain('spare@example.com')
      expect(top.actions).toEqual([
        { kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-b', label: 'work@example.com', tier: 'fresh-headroom' },
        { kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: '__default__', label: 'Default', tier: 'unknown' },
      ])
      // The updater row and its download button are untouched underneath.
      expect(a.items.value[1]).toMatchObject({ id: 'update:0.1.78', action: 'download', actions: [{ kind: 'download' }] })
      // No raw i18n key leaks while the locale files lack the quota entries.
      expect(top.title + top.highlights.join() + (top.note ?? '')).not.toContain('announce.')
      expect(a.unreadCount.value).toBeGreaterThan(0)
    })

    it('updates the same incident in place — one row however many windows relay it', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()

      a.noteQuotaIncident(notice())
      a.noteQuotaIncident(notice())
      a.noteQuotaIncident(notice({ status: 'switching', targetLabel: 'work@example.com', candidates: [], updatedAt: T0 + 1000 }))

      const rows = a.items.value.filter((i) => i.kind === 'quota')
      expect(rows).toHaveLength(1)
      expect(rows[0].title).toContain('work@example.com')
      expect(rows[0].actions).toBeUndefined()
    })

    it('drops an update older than the one on screen', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()

      a.noteQuotaIncident(notice({ status: 'switching', targetLabel: 'work@example.com', candidates: [], updatedAt: T0 + 1000 }))
      a.noteQuotaIncident(notice({ updatedAt: T0 }))

      expect(a.items.value[0].quota?.status).toBe('switching')
    })

    it('read marks are per status and epoch, and never reach the shared settings document', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements, quotaAnnouncementId } = await load()
      const a = useAnnouncements()
      const id = quotaAnnouncementId('inc-1')

      a.noteQuotaIncident(notice())
      a.markRead(id)
      expect(a.items.value[0].read).toBe(true)
      expect(store.get(READ_IDS_KEY)).toEqual([])

      // A new status is news again; so is the same status under a new epoch.
      a.noteQuotaIncident(notice({ status: 'ready', targetLabel: 'work@example.com', reason: 'quota-confirmed', updatedAt: T0 + 1000 }))
      expect(a.items.value[0].read).toBe(false)
      a.markRead(id)
      expect(a.items.value[0].read).toBe(true)
      a.noteQuotaIncident(notice({ status: 'ready', targetLabel: 'work@example.com', reason: 'quota-confirmed', epoch: 8, updatedAt: T0 + 2000 }))
      expect(a.items.value[0].read).toBe(false)

      a.markAllRead()
      expect(a.items.value[0].read).toBe(true)
      expect(store.get(READ_IDS_KEY)).not.toContain(id)
    })

    it('a new epoch replaces every button with ones carrying the new epoch', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()

      a.noteQuotaIncident(notice())
      a.noteQuotaIncident(notice({ epoch: 8, candidates: [{ slotId: 'slot-c', label: 'c@example.com', tier: 'stale-headroom' }], updatedAt: T0 + 1000 }))

      expect(a.items.value[0].actions).toEqual([
        { kind: 'quota-switch', incidentId: 'inc-1', agentKey: 'claude', epoch: 8, slotId: 'slot-c', label: 'c@example.com', tier: 'stale-headroom' },
      ])
    })

    it('invalidating withdraws the buttons but keeps the row, until the next state', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()

      a.noteQuotaIncident(notice())
      a.invalidateQuotaActions('inc-1')
      expect(a.items.value[0].actions).toBeUndefined()
      expect(a.items.value[0].note).toBeTruthy()
      // Same state re-sent: still withdrawn.
      a.noteQuotaIncident(notice({ updatedAt: T0 + 500 }))
      expect(a.items.value[0].actions).toBeUndefined()
      // A new state is a fresh offer.
      a.noteQuotaIncident(notice({ status: 'notify-stopped', reason: 'swap-failed', targetLabel: 'work@example.com', updatedAt: T0 + 1000 }))
      expect(a.items.value[0].actions).toHaveLength(2)
      expect(a.items.value[0].note).toContain('work@example.com')
      // Unknown incident: no-op.
      a.invalidateQuotaActions('nope')
    })

    it('dismissing removes the row and forgets its marks', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements, quotaAnnouncementId } = await load()
      const a = useAnnouncements()

      a.noteQuotaIncident(notice())
      a.markRead(quotaAnnouncementId('inc-1'))
      a.dismissQuotaIncident('inc-1')
      expect(a.items.value.some((i) => i.kind === 'quota')).toBe(false)
      a.noteQuotaIncident(notice())
      expect(a.items.value[0].read).toBe(false)
    })

    it('an untrusted incident informs and offers nothing', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()

      a.noteQuotaIncident(notice({ untrusted: true, reason: 'usage-window-disagrees' }))

      expect(a.items.value[0].actions).toBeUndefined()
      expect(a.items.value[0].note).toContain('nothing was switched')
    })

    it('offers switch-back after a switch and retry after a partial resume, with ids and epoch', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()

      a.noteQuotaIncident(notice({
        status: 'ready',
        targetLabel: 'work@example.com',
        reason: 'turn-complete',
        candidates: [],
        switchBack: { slotId: 'slot-a', label: 'dev@example.com' },
        resetExpectedAt: T0 + 3_600_000,
        updatedAt: T0 + 1000,
      }))
      expect(a.items.value[0].actions).toEqual([
        { kind: 'quota-switch-back', incidentId: 'inc-1', agentKey: 'claude', epoch: 7, slotId: 'slot-a', label: 'dev@example.com' },
      ])
      // "Expected back" is an estimate and says so; turn-complete is not a
      // verified quota reading and says so.
      expect(a.items.value[0].note).toContain('not verified')
      expect(a.items.value[0].note).toContain('was not read')

      a.noteQuotaIncident(notice({
        status: 'partial',
        targetLabel: 'work@example.com',
        candidates: [],
        retryResume: true,
        switchBack: { slotId: 'slot-a', label: 'dev@example.com' },
        updatedAt: T0 + 2000,
      }))
      expect(a.items.value[0].actions?.map((x) => x.kind)).toEqual(['quota-retry-resume', 'quota-switch-back'])
      // Candidates are only offered while the incident is open for a choice.
      a.noteQuotaIncident(notice({ status: 'settling', targetLabel: 'work@example.com', updatedAt: T0 + 3000 }))
      expect(a.items.value[0].actions).toBeUndefined()
    })

    it('prints an unknown backend reason verbatim rather than hiding it', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()

      a.noteQuotaIncident(notice({ status: 'notify-stopped', reason: 'some-new-reason', candidates: [] }))
      expect(a.items.value[0].note).toContain('some-new-reason')
    })

    it('exposes the locale keys the rows read, each with its English fallback', async () => {
      const { QUOTA_I18N_KEYS } = await load()
      expect(QUOTA_I18N_KEYS['announce.quota.status.ready']).toContain('{target}')
      expect(QUOTA_I18N_KEYS['announce.quota.reason.no-candidate']).toBeTruthy()
      expect(QUOTA_I18N_KEYS['announce.quota.excluded.exhausted']).toBeTruthy()
      expect(Object.keys(QUOTA_I18N_KEYS).every((k) => k.startsWith('announce.quota.'))).toBe(true)
    })
  })

  describe('backend upgrade', () => {
    it('tops the feed with what an upgrade means for MCP clients', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()

      a.noteBackendUpgrade('0.1.85', '0.1.86')

      const top = a.items.value[0]
      expect(top.id).toBe('mcp-tools:0.1.86')
      expect(top.version).toBe('0.1.86')
      // The version it replaced is what tells the reader which clients are old.
      expect(top.note).toContain('0.1.85')
      expect(top.read).toBe(false)
    })

    it('says nothing at all when the backend did not change version', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()
      const before = a.items.value.length

      a.noteBackendUpgrade('0.1.86', '0.1.86')
      a.noteBackendUpgrade('', '0.1.86')

      expect(a.items.value).toHaveLength(before)
    })

    it('stays one item across the reconnects that report it again', async () => {
      store.set(READ_IDS_KEY, [])
      const { useAnnouncements } = await load()
      const a = useAnnouncements()

      a.noteBackendUpgrade('0.1.85', '0.1.86')
      a.markRead('mcp-tools:0.1.86')
      a.noteBackendUpgrade('0.1.85', '0.1.86')

      const rows = a.items.value.filter((i) => i.id === 'mcp-tools:0.1.86')
      expect(rows).toHaveLength(1)
      // Reading it is final: the backend re-reporting on reconnect must not
      // resurrect it as unread.
      expect(rows[0].read).toBe(true)
    })
  })
})

describe('useAnnouncements — release tours', () => {
  beforeEach(() => {
    store.clear()
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.2.10' }
  })
  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  it('gives a release row with a tour its Take the tour button, and others none', async () => {
    store.set(READ_IDS_KEY, [])
    const { useAnnouncements } = await load()
    const items = useAnnouncements().items.value
    const r0210 = items.find((i) => i.id === 'release:0.2.10')
    const r029 = items.find((i) => i.id === 'release:0.2.9')
    expect(r0210?.actions).toEqual([{ kind: 'tour', version: '0.2.10' }])
    expect(r029?.actions).toBeUndefined()
  })
})

describe('agent plugin notices (B2-c)', () => {
  beforeEach(() => {
    store.clear()
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.1.77' }
  })

  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  const base = { pluginId: 'nerdtechnic.devmap', pluginVersion: '0.2.0' }

  it('names the caller and offers the undo of what the agent did', async () => {
    const { useAnnouncements, i18n } = await load()
    i18n.global.locale.value = 'en-US'
    const a = useAnnouncements()
    a.notePluginAgentNotice({ ...base, action: 'disable', requester: { paneId: 'p-41', paneName: 'dev', workspace: '/w', callerKind: 'pane' } }, 2)
    a.notePluginAgentNotice({ ...base, action: 'enable', requester: { paneId: null, paneName: null, workspace: null, callerKind: 'external' } }, 3)
    a.notePluginAgentNotice({ ...base, action: 'disable', requester: { paneId: null, paneName: null, workspace: null, callerKind: 'host' } }, 4)
    const rows = a.items.value.filter((item) => item.kind === 'plugin-agent')
    expect(rows.map((row) => row.title)).toEqual([
      'Navide Host disabled the Navide plugin nerdtechnic.devmap',
      'An external MCP client enabled the Navide plugin nerdtechnic.devmap',
      'Agent pane “dev” disabled the Navide plugin nerdtechnic.devmap',
    ])
    expect(rows.map((row) => row.actions)).toEqual([
      [{ kind: 'plugin-agent-undo', pluginId: 'nerdtechnic.devmap', disable: false }],
      [{ kind: 'plugin-agent-undo', pluginId: 'nerdtechnic.devmap', disable: true }],
      [{ kind: 'plugin-agent-undo', pluginId: 'nerdtechnic.devmap', disable: false }],
    ])
    expect(rows[0].highlights).toEqual(['Version 0.2.0. Its files, grants and data are kept.'])
  })

  it('says the caller in each language', async () => {
    const { pluginAgentNoticeTitle, i18n } = await load()
    const notice = { ...base, action: 'disable' as const, requester: { paneId: 'p', paneName: 'dev', workspace: null, callerKind: 'pane' as const } }
    i18n.global.locale.value = 'zh-TW'
    expect(pluginAgentNoticeTitle(notice)).toBe('Agent pane「dev」停用了 Navide 外掛 nerdtechnic.devmap')
    i18n.global.locale.value = 'ja-JP'
    expect(pluginAgentNoticeTitle(notice)).toContain('nerdtechnic.devmap')
    i18n.global.locale.value = 'en-US'
  })

  it('undoes only what the agent did: not after the user changed the plugin since', async () => {
    const { pluginAgentUndoApplies } = await load()
    const reEnable = { kind: 'plugin-agent-undo' as const, pluginId: 'nerdtechnic.devmap', disable: false }
    const reDisable = { kind: 'plugin-agent-undo' as const, pluginId: 'nerdtechnic.devmap', disable: true }
    expect(pluginAgentUndoApplies(reEnable, [{ id: 'nerdtechnic.devmap', disabled: true }])).toBe(true)
    expect(pluginAgentUndoApplies(reEnable, [{ id: 'nerdtechnic.devmap', disabled: false }])).toBe(false)
    expect(pluginAgentUndoApplies(reDisable, [{ id: 'nerdtechnic.devmap', disabled: false }])).toBe(true)
    expect(pluginAgentUndoApplies(reDisable, [{ id: 'nerdtechnic.devmap', disabled: true }])).toBe(false)
    expect(pluginAgentUndoApplies(reEnable, [])).toBe(false)
  })

  it('O1: says which agent updated the plugin from which version, and offers the way back', async () => {
    const { useAnnouncements, i18n } = await load()
    const a = useAnnouncements()
    const requester = { paneId: 'p-41', paneName: 'dev', workspace: '/w', callerKind: 'pane' as const }
    for (const locale of ['en-US', 'zh-TW', 'ja-JP'] as const) {
      i18n.global.locale.value = locale
      a.notePluginAgentNotice({ pluginId: 'nerdtechnic.devmap', pluginVersion: '0.3.0', fromVersion: '0.2.0', action: 'update', requester }, 5)
      const [row] = a.items.value.filter((item) => item.kind === 'plugin-agent' && item.id.startsWith('plugin-agent:update:'))
      expect(row.title).toBe(i18n.global.t('plugin-agent.notice.updated', {
        caller: i18n.global.t('plugin-agent.caller.pane', { pane: 'dev' }), plugin: 'nerdtechnic.devmap', from: '0.2.0', to: '0.3.0',
      }))
      expect(row.title).toContain('0.2.0')
      expect(row.title).toContain('0.3.0')
      expect(row.highlights).toEqual([i18n.global.t('plugin-agent.notice.updated-detail', { from: '0.2.0', to: '0.3.0' })])
      expect(row.actions).toEqual([{ kind: 'plugin-agent-downgrade', pluginId: 'nerdtechnic.devmap', fromVersion: '0.2.0', toVersion: '0.3.0' }])
    }
    i18n.global.locale.value = 'en-US'
  })

  it('O1: the downgrade drops a staged update, rolls back one in use, and leaves a changed plugin alone', async () => {
    const { pluginAgentDowngradeStep } = await load()
    const action = { kind: 'plugin-agent-downgrade' as const, pluginId: 'nerdtechnic.devmap', fromVersion: '0.2.0', toVersion: '0.3.0' }
    const id = 'nerdtechnic.devmap'
    expect(pluginAgentDowngradeStep(action, [{ id, packageVersion: '0.2.0', pendingCandidateVersion: '0.3.0' }])).toBe('discard')
    expect(pluginAgentDowngradeStep(action, [{ id, packageVersion: '0.3.0', rollbackToVersion: '0.2.0' }])).toBe('rollback')
    expect(pluginAgentDowngradeStep(action, [{ id, packageVersion: '0.4.0', rollbackToVersion: '0.3.0' }])).toBeNull()
    expect(pluginAgentDowngradeStep(action, [{ id, packageVersion: '0.3.0', rollbackToVersion: '0.1.0' }])).toBeNull()
    expect(pluginAgentDowngradeStep(action, [{ id, packageVersion: '0.2.0', pendingCandidateVersion: '0.4.0' }])).toBeNull()
    expect(pluginAgentDowngradeStep(action, [])).toBeNull()
  })
})

describe('staged plugin packages found at launch', () => {
  beforeEach(() => {
    store.clear()
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.1.77' }
  })

  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  const update = { pluginId: 'acme.todo', activeVersion: '1.0.0', stagedVersion: '1.1.0' }

  it('keeps one row per staged package, naming both versions, with "Apply now"', async () => {
    const { useAnnouncements, i18n } = await load()
    i18n.global.locale.value = 'en-US'
    const a = useAnnouncements()
    a.notePluginStagedUpdates([update])
    const rows = a.items.value.filter((item) => item.kind === 'plugin-staged')
    expect(rows.map((row) => row.title)).toEqual([
      'The Navide plugin acme.todo has version 1.1.0 waiting to be applied; version 1.0.0 is running.',
    ])
    expect(rows[0].actions).toEqual([{ kind: 'plugin-staged-apply', ...update }])
    // Read is not dismissed: the row stays until it is applied.
    a.markAllRead()
    expect(a.items.value.filter((item) => item.kind === 'plugin-staged')).toHaveLength(1)
    a.dropPluginStagedUpdate('acme.todo')
    expect(a.items.value.filter((item) => item.kind === 'plugin-staged')).toEqual([])
  })

  it('says it in each language', async () => {
    const { useAnnouncements, i18n } = await load()
    const a = useAnnouncements()
    a.notePluginStagedUpdates([update])
    const title = () => a.items.value.find((item) => item.kind === 'plugin-staged')?.title
    i18n.global.locale.value = 'zh-TW'
    expect(title()).toBe('Navide 外掛 acme.todo 有版本 1.1.0 等待套用，目前執行的是 1.0.0。')
    i18n.global.locale.value = 'ja-JP'
    expect(title()).toBe('Navide プラグイン acme.todo のバージョン 1.1.0 が適用待ちです。現在実行中のバージョンは 1.0.0 です。')
    i18n.global.locale.value = 'en-US'
  })

  it('applies only while the same version is still staged beside the same active one', async () => {
    const { pluginStagedApplyApplies } = await load()
    const action = { kind: 'plugin-staged-apply' as const, ...update }
    expect(pluginStagedApplyApplies(action, [{ id: 'acme.todo', packageVersion: '1.0.0', pendingCandidateVersion: '1.1.0' }])).toBe(true)
    expect(pluginStagedApplyApplies(action, [{ id: 'acme.todo', packageVersion: '1.1.0' }])).toBe(false)
    expect(pluginStagedApplyApplies(action, [{ id: 'acme.todo', packageVersion: '1.0.0', pendingCandidateVersion: '1.2.0' }])).toBe(false)
    expect(pluginStagedApplyApplies(action, [])).toBe(false)
  })
})

describe('plugin version switches (L3)', () => {
  beforeEach(() => {
    store.clear()
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.1.77' }
  })

  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  const switched = { pluginId: 'acme.todo', fromVersion: '1.0.0', toVersion: '1.1.0', source: 'local-unsigned' as const, at: 1_000 }

  it('records each switch with both versions and offers the way back', async () => {
    const { useAnnouncements, i18n } = await load()
    i18n.global.locale.value = 'en-US'
    const a = useAnnouncements()
    a.notePluginSwitch(switched)
    const rows = a.items.value.filter((item) => item.kind === 'plugin-switch')
    expect(rows.map((row) => row.title)).toEqual(['acme.todo switched from 1.0.0 to 1.1.0'])
    expect(rows[0].highlights[0]).toContain('local file')
    expect(rows[0].actions).toEqual([{ kind: 'plugin-switch-back', pluginId: 'acme.todo', fromVersion: '1.0.0', toVersion: '1.1.0' }])
    i18n.global.locale.value = 'zh-TW'
    expect(a.items.value.find((item) => item.kind === 'plugin-switch')?.title).toBe('acme.todo 已從 1.0.0 切換到 1.1.0')
    i18n.global.locale.value = 'en-US'
  })

  it('goes back only while the switch it names is still installed with its previous version kept', async () => {
    const { pluginSwitchBackApplies } = await load()
    const action = { kind: 'plugin-switch-back' as const, pluginId: 'acme.todo', fromVersion: '1.0.0', toVersion: '1.1.0' }
    expect(pluginSwitchBackApplies(action, [{ id: 'acme.todo', packageVersion: '1.1.0', rollbackToVersion: '1.0.0' }])).toBe(true)
    // No earlier version kept (a file update before L4), switched again, or another update waiting.
    expect(pluginSwitchBackApplies(action, [{ id: 'acme.todo', packageVersion: '1.1.0' }])).toBe(false)
    expect(pluginSwitchBackApplies(action, [{ id: 'acme.todo', packageVersion: '1.2.0', rollbackToVersion: '1.1.0' }])).toBe(false)
    expect(pluginSwitchBackApplies(action, [{ id: 'acme.todo', packageVersion: '1.1.0', rollbackToVersion: '1.0.0', pendingCandidateVersion: '1.2.0' }])).toBe(false)
  })
})

describe('switches an agent started, and a failed switch (O1, decision A)', () => {
  beforeEach(() => {
    store.clear()
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.1.77' }
  })

  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  it('names the agent on the switch row, in each language', async () => {
    const { useAnnouncements, i18n } = await load()
    const a = useAnnouncements()
    a.notePluginSwitch({
      pluginId: 'acme.todo', fromVersion: '1.0.0', toVersion: '1.0.1', source: 'marketplace', at: 2_000,
      agent: { paneId: 'p-7', paneName: 'dev', workspace: '/w', callerKind: 'pane' },
    })
    const title = () => a.items.value.find((item) => item.kind === 'plugin-switch')?.title
    i18n.global.locale.value = 'en-US'
    expect(title()).toBe('An automatic update started by Agent pane “dev” switched acme.todo from 1.0.0 to 1.0.1')
    i18n.global.locale.value = 'zh-TW'
    expect(title()).toContain('自動更新')
    expect(title()).toContain('「dev」')
    i18n.global.locale.value = 'ja-JP'
    expect(title()).toContain('自動更新')
    i18n.global.locale.value = 'en-US'
    expect(a.items.value.find((item) => item.kind === 'plugin-switch')?.actions).toEqual([
      { kind: 'plugin-switch-back', pluginId: 'acme.todo', fromVersion: '1.0.0', toVersion: '1.0.1' },
    ])
  })

  it('keeps a "switch failed" row with Apply now, beside the rows found at launch', async () => {
    const { useAnnouncements, i18n } = await load()
    i18n.global.locale.value = 'en-US'
    const a = useAnnouncements()
    a.notePluginStagedUpdates([{ pluginId: 'acme.other', activeVersion: '2.0.0', stagedVersion: '2.1.0' }])
    a.notePluginStagedUpdates([{ pluginId: 'acme.todo', activeVersion: '1.0.0', stagedVersion: '1.0.1', reason: 'view did not start' }])
    const rows = a.items.value.filter((item) => item.kind === 'plugin-staged')
    expect(rows.map((row) => row.title)).toEqual([
      'Switching acme.todo to 1.0.1 failed: view did not start. Version 1.0.0 runs again.',
      'The Navide plugin acme.other has version 2.1.0 waiting to be applied; version 2.0.0 is running.',
    ])
    expect(rows[0].actions).toEqual([{ kind: 'plugin-staged-apply', pluginId: 'acme.todo', activeVersion: '1.0.0', stagedVersion: '1.0.1' }])
  })
})
