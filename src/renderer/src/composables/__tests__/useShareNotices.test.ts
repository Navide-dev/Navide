// @vitest-environment happy-dom
// Share-link notices in the announcements feed: a link was created (by the
// user or by an agent's pane, with how much was masked), or opened for the
// first time or by a new viewer. Nothing else becomes a row.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
  settingsSet: (key: string, value: unknown) => {
    store.set(key, value)
  },
}))

async function load() {
  vi.resetModules()
  const announcements = await import('../useAnnouncements')
  const notices = await import('../useShareNotices')
  const { i18n } = await import('@navide/plugin-ui/foundation')
  i18n.global.locale.value = 'en-US'
  const handlers = new Map<string, (payload: unknown) => void>()
  const backend = {
    on: vi.fn((type: string, fn: (payload: unknown) => void) => {
      handlers.set(type, fn)
      return () => handlers.delete(type)
    }),
  }
  const stop = notices.useShareNotices(backend as never)
  const feed = announcements.useAnnouncements()
  const shareRows = () => feed.items.value.filter((item) => item.kind === 'share')
  return { handlers, stop, shareRows }
}

describe('useShareNotices', () => {
  beforeEach(() => {
    store.clear()
    store.set('agentTeam.announcements.readIds', [])
  })

  it('announces an agent-made link with its pane and what was masked, never the URL', async () => {
    const { handlers, shareRows } = await load()
    handlers.get('share.created')!({
      linkId: 'ab'.repeat(16),
      createdBy: 'agent',
      pane: 'release',
      agent: 'claude',
      expiresAt: '2026-10-18T00:00:00Z',
      masked: [{ line: 3, category: 'github-token', action: 'masked' }],
    })
    const [row] = shareRows()
    expect(row.title).toContain('release')
    expect(row.highlights.join(' ')).toContain('1')
    expect(JSON.stringify(row)).not.toContain('#k=')
    expect(row.read).toBe(false)
  })

  it('announces the first open and a new viewer, not every open', async () => {
    const { handlers, shareRows } = await load()
    const open = handlers.get('share.opened')!
    open({ linkId: 'cd'.repeat(16), openCount: 1, openedAt: '2026-10-11T10:00:00Z', newViewer: true })
    open({ linkId: 'cd'.repeat(16), openCount: 2, openedAt: '2026-10-11T10:05:00Z', newViewer: false })
    open({ linkId: 'cd'.repeat(16), openCount: 3, openedAt: '2026-10-11T11:00:00Z', newViewer: true })
    expect(shareRows()).toHaveLength(2)
  })

  it('ignores malformed events', async () => {
    const { handlers, shareRows } = await load()
    handlers.get('share.created')!(null)
    handlers.get('share.opened')!({ openCount: 1 })
    expect(shareRows()).toHaveLength(0)
  })

  it('stops listening when stopped', async () => {
    const { handlers, stop } = await load()
    stop()
    expect(handlers.size).toBe(0)
  })
})
