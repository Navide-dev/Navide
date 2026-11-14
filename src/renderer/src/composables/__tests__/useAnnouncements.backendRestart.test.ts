// @vitest-environment happy-dom
// H3: the row a backend restart leaves in the announcements centre. Same module
// setup as useAnnouncements.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
  settingsSet: (key: string, value: unknown) => {
    store.set(key, value)
  },
}))

/** Fresh module graph per test — the composable is a module-level singleton. */
async function load() {
  vi.resetModules()
  const mod = await import('../useAnnouncements')
  const { i18n } = await import('@navide/plugin-ui/foundation')
  return { ...mod, i18n }
}

describe('useAnnouncements – backend restart (H3)', () => {
  beforeEach(() => {
    store.clear()
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { version: '0.1.77' }
  })

  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  it('lists resumed, interrupted and ended panes, with a Rebuild for each ended one', async () => {
    const { useAnnouncements, i18n } = await load()
    i18n.global.locale.value = 'en-US'
    const a = useAnnouncements()
    a.noteBackendRestart({
      crashLoop: false,
      resumed: ['lead'],
      interrupted: ['lead', 'worker'],
      notResumed: [{ paneId: 'p-w', name: 'worker', reason: 'over-limit' }],
    }, 1_800_000_000_000)
    const rows = a.items.value.filter((i) => i.kind === 'backend-restart')
    expect(rows).toHaveLength(1)
    expect(rows[0].highlights).toEqual([
      i18n.global.t('announce.backend-restart.resumed', { names: 'lead' }),
      i18n.global.t('announce.backend-restart.interrupted', { names: 'lead, worker' }),
      i18n.global.t('announce.backend-restart.not-resumed.over-limit', { name: 'worker' }),
    ])
    expect(rows[0].note).toBe(i18n.global.t('announce.backend-restart.note'))
    expect(rows[0].actions).toEqual([{ kind: 'pane-rebuild', paneId: 'p-w', name: 'worker' }])
    expect(rows[0].read).toBe(false)

    a.dropBackendRestartPane('p-w')
    expect(a.items.value.find((i) => i.kind === 'backend-restart')?.actions).toEqual([])
  })

  it('says why nothing came back in a crash loop', async () => {
    const { useAnnouncements, i18n } = await load()
    const a = useAnnouncements()
    a.noteBackendRestart({
      crashLoop: true,
      resumed: [],
      interrupted: [],
      notResumed: [{ paneId: 'p-1', name: 'lead', reason: 'crash-loop' }],
    })
    const row = a.items.value.find((i) => i.kind === 'backend-restart')
    expect(row?.note).toBe(i18n.global.t('announce.backend-restart.crash-loop'))
    expect(row?.highlights).toEqual([i18n.global.t('announce.backend-restart.not-resumed.crash-loop', { name: 'lead' })])
  })

  it('leaves no row for a restart that touched no pane', async () => {
    const { useAnnouncements } = await load()
    const a = useAnnouncements()
    a.noteBackendRestart({ crashLoop: false, resumed: [], interrupted: [], notResumed: [] })
    expect(a.items.value.some((i) => i.kind === 'backend-restart')).toBe(false)
  })
})
