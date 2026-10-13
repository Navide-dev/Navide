// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createMockBackend, flush } from './mockBackend'
import { chatRows, useChannels } from '../useChannels'

function seed(mock: ReturnType<typeof createMockBackend>): void {
  mock.setResponse('channels.list', {
    ok: true,
    enabled: true,
    platforms: [
      {
        platform: 'telegram',
        configured: true,
        enabled: true,
        status: { lifecycle: 'ready', connected: true, identity: '@navide_bot' },
        config: { permission_relay: false },
        capabilities: { threads: true, create_location: true, edit: true, typing: true, buttons: true, text_limit: 4000 },
      },
    ],
  })
  mock.setResponse('channels.bindings', {
    ok: true,
    bindings: [{ pane_id: 'p1', platform: 'telegram', account: 'a', chat_id: '-100', thread_id: '7', title: 'api-refactor' }],
  })
  mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: [] })
}

describe('useChannels', () => {
  it('loads platforms and bindings when connected', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()
    expect(mock.sent.map((s) => s.type)).toEqual(
      expect.arrayContaining(['channels.list', 'channels.bindings', 'channels.pairing.list', 'channels.allow.list'])
    )
    expect(store.platformState('telegram')?.status.identity).toBe('@navide_bot')
    expect(store.platformState('telegram')?.status.last_error).toBe('')
    expect(store.configuredPlatforms.value.map((p) => p.platform)).toEqual(['telegram'])
    expect(store.bindingFor('p1')?.title).toBe('api-refactor')
    expect(store.bindingFor('p2')).toBeNull()
  })

  it('shares one store per backend', () => {
    const mock = createMockBackend('disconnected')
    expect(useChannels(mock.backend)).toBe(useChannels(mock.backend))
  })

  it('waits for the connection before fetching, then fetches on connect', async () => {
    const mock = createMockBackend('disconnected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()
    expect(mock.sent).toHaveLength(0)
    mock.status.value = 'connected'
    await flush()
    expect(store.loaded.value).toBe(true)
  })

  it('re-fetches on channels.changed and patches status in place on channels.status', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()
    mock.sent.length = 0
    mock.emit('channels.changed', {})
    await flush()
    expect(mock.sent.some((s) => s.type === 'channels.list')).toBe(true)

    mock.sent.length = 0
    mock.emit('channels.status', { platform: 'telegram', status: { lifecycle: 'blocked', last_error: 'bad token' } })
    expect(store.platformState('telegram')?.status.lifecycle).toBe('blocked')
    expect(store.platformState('telegram')?.status.last_error).toBe('bad token')
    expect(mock.sent).toHaveLength(0)
  })

  it('treats an older backend\'s configured platform as its default bot, and patches each bot\'s status', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()
    expect(store.platformState('telegram')?.accounts.map((a) => a.account)).toEqual(['default'])
    expect(store.accountState('telegram')?.status.identity).toBe('@navide_bot')

    const ready = { lifecycle: 'ready', connected: true, identity: '' }
    mock.setResponse('channels.list', {
      ok: true,
      enabled: true,
      platforms: [{
        platform: 'telegram', configured: true, enabled: true, status: ready, config: {}, capabilities: null,
        accounts: [
          { account: 'default', name: '', configured: true, enabled: true, status: ready, config: {}, capabilities: null },
          { account: 'bot-b1', name: 'Ops', configured: true, enabled: true, status: ready, config: {}, capabilities: null },
        ],
      }],
    })
    await store.refresh()
    mock.emit('channels.status', { platform: 'telegram', account: 'bot-b1', status: { lifecycle: 'blocked' } })
    expect(store.accountState('telegram', 'bot-b1')?.status.lifecycle).toBe('blocked')
    // Not the platform's first bot: the platform-level status stays the default bot's.
    expect(store.platformState('telegram')?.status.lifecycle).toBe('ready')
    mock.emit('channels.status', { platform: 'telegram', status: { lifecycle: 'recovering' } })
    expect(store.accountState('telegram')?.status.lifecycle).toBe('recovering')
    expect(store.platformState('telegram')?.status.lifecycle).toBe('recovering')
  })

  it('sends mutations with the contract payloads and reports backend errors', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()

    await store.configure('slack', { permission_relay: false }, { app_token: 'xapp', bot_token: 'xoxb' })
    await store.configure('telegram', { permission_relay: true })
    await store.bind({ pane_id: 'p2', pane_name: 'docs', platform: 'telegram', mode: 'new', chat_id: '-100', title: 'docs', verbosity: 'standard' })
    await store.unbind('p1')
    await store.approvePairing('telegram', 'K7Q2M9XA')
    await store.setGlobalEnabled(false)
    const types = mock.sent.map((s) => s.type)
    expect(mock.sent.find((s) => s.type === 'channels.configure')?.payload).toEqual({
      platform: 'slack',
      config: { permission_relay: false },
      secret: { app_token: 'xapp', bot_token: 'xoxb' },
    })
    expect(mock.sent.filter((s) => s.type === 'channels.configure')[1].payload).not.toHaveProperty('secret')
    expect(types).toEqual(expect.arrayContaining(['channels.bind', 'channels.unbind', 'channels.pairing.approve', 'channels.set_global_enabled']))
    expect(mock.sent.find((s) => s.type === 'channels.unbind')?.payload).toEqual({ pane_id: 'p1', pane_name: '' })
    expect(mock.sent.find((s) => s.type === 'channels.bind')?.payload).toMatchObject({ pane_id: 'p2', verbosity: 'standard' })

    mock.setResponse('channels.remove', { ok: false, error: 'nope' })
    expect(await store.remove('telegram')).toEqual({ ok: false, error: 'nope' })
    mock.setRejection('channels.set_enabled', 'ws not open')
    expect(await store.setEnabled('telegram', false)).toEqual({ ok: false, error: 'ws not open' })
  })

  it('releases a binding only for a bound pane that really closed, and carries it over on replacement', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useChannels(mock.backend)
    await flush()
    mock.sent.length = 0
    store.paneClosed('unbound-pane')
    store.paneReplaced('unbound-pane', 'p9')
    expect(mock.sent).toHaveLength(0)
    store.paneReplaced('p1', 'p1b')
    store.paneClosed('p1')
    expect(mock.sent).toEqual([
      expect.objectContaining({ type: 'channels.rebind', payload: { from_pane_id: 'p1', to_pane_id: 'p1b' } }),
      expect.objectContaining({ type: 'channels.unbind', payload: { pane_id: 'p1', reason: 'closed' } }),
    ])
  })

  it('still asks the backend when bindings have not loaded yet', () => {
    const mock = createMockBackend('disconnected')
    const store = useChannels(mock.backend)
    store.paneClosed('p1')
    expect(mock.sent.map((s) => s.type)).toEqual(['channels.unbind'])
  })

  it('creates a link invite and records the chat a link brings in', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    mock.setResponse('channels.link.create', {
      ok: true, code: 'K7Q2M9XA', target: 'group', expires_at: 5, url: 'https://t.me/b?startgroup=K7Q2M9XA',
    })
    const store = useChannels(mock.backend)
    await flush()
    const res = await store.createLink('telegram', 'group')
    expect(res.ok && res.data?.url).toBe('https://t.me/b?startgroup=K7Q2M9XA')
    expect(mock.sent.find((s) => s.type === 'channels.link.create')?.payload).toEqual({ platform: 'telegram', target: 'group' })
    expect(store.lastLinked.value).toBeNull()
    mock.emit('channels.linked', { platform: 'telegram', chat_id: '-5', title: 'Team', kind: 'group' })
    expect(store.lastLinked.value).toEqual({ platform: 'telegram', chat_id: '-5', title: 'Team', kind: 'group' })
  })
})

describe('useChannels overview (Settings → Channels)', () => {
  const pane = (name: string, exists = true) => ({
    exists, name, qualified_name: exists ? `Agent-Team/${name}` : '', workspace_path: exists ? '/w/Agent-Team' : '',
    display_status: exists ? 'idle' : '', agent_key: exists ? 'claude' : '',
  })
  const binding = (paneId: string, extra: Record<string, unknown> = {}) => ({
    pane_id: paneId, platform: 'telegram', account: 'default', chat_id: '-100', thread_id: '', title: paneId,
    verbosity: 'replies', parent_pane_id: '', auto: false, created_at: 1, pane: pane(paneId), ...extra,
  })
  const overview = {
    ok: true,
    bots: [{
      platform: 'telegram', account: 'default', orphans: ['gone'],
      chats: [
        { chat_id: '-100', title: 'Dev', kind: 'supergroup', supports_topics: true, bindings: [
          binding('p1', { thread_id: '50' }),
          binding('kid', { thread_id: '51', auto: true, parent_pane_id: 'p1' }),
          binding('gone', { thread_id: '52', pane: pane('support', false) }),
        ] },
        { chat_id: '-200', title: 'Quiet', kind: 'group', supports_topics: false, bindings: [] },
      ],
    }],
  }

  it('fetches the overview only once asked, then again on every change', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    mock.setResponse('channels.overview', overview)
    const store = useChannels(mock.backend)
    await flush()
    expect(mock.sent.some((s) => s.type === 'channels.overview')).toBe(false)
    await store.loadOverview()
    expect(store.overviewFor('telegram', 'default')?.chats.map((c) => c.chat_id)).toEqual(['-100', '-200'])
    expect(store.overviewFor('telegram', 'other')).toBeNull()
    mock.sent.length = 0
    mock.emit('channels.changed', {})
    await flush()
    expect(mock.sent.filter((s) => s.type === 'channels.overview')).toHaveLength(1)
  })

  it('keeps an overview failure apart from the rest of the store', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    mock.setResponse('channels.overview', { ok: false, error: 'boom' })
    const store = useChannels(mock.backend)
    await store.loadOverview()
    expect(store.overviewError.value).toBe('boom')
    expect(store.error.value).toBe('')
  })

  it('nests auto child topics under their parent and marks orphans', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    mock.setResponse('channels.overview', overview)
    const store = useChannels(mock.backend)
    await store.loadOverview()
    const [dev, quiet] = store.overviewFor('telegram', 'default')!.chats.map(chatRows)
    expect(dev.map((r) => [r.binding.pane_id, r.orphan, r.children.map((c) => c.pane_id)])).toEqual([
      ['p1', false, ['kid']],
      ['gone', true, []],
    ])
    expect(quiet).toEqual([])
  })

  it('unbinds a batch in one request and reports each pane', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    mock.setResponse('channels.unbind_many', {
      ok: true, results: [{ pane_id: 'p1', ok: true, removed: true }, { pane_id: 'p2', ok: false, error: 'locked' }],
    })
    const store = useChannels(mock.backend)
    await flush()
    mock.sent.length = 0
    const res = await store.unbindMany(['p1', 'p2'])
    expect(mock.sent[0]).toMatchObject({ type: 'channels.unbind_many', payload: { pane_ids: ['p1', 'p2'] } })
    expect(res.ok).toBe(true)
    expect(res.data?.results.map((r) => r.ok)).toEqual([true, false])
    expect(mock.sent.some((s) => s.type === 'channels.list')).toBe(true) // refreshed
  })

  it('jumps to a bound pane through its current id, in whichever window owns it', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    mock.setResponse('channels.focus_pane', { ok: true, pane_id: 'p1-new', workspace_path: '/w/Other' })
    const requestPaneAction = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { requestPaneAction }
    try {
      const store = useChannels(mock.backend)
      expect(await store.focusPane('p1')).toEqual({ ok: true })
      expect(mock.sent.find((s) => s.type === 'channels.focus_pane')?.payload).toEqual({ pane_id: 'p1' })
      expect(requestPaneAction).toHaveBeenCalledWith({ paneId: 'p1-new', action: 'focus' })
      requestPaneAction.mockResolvedValueOnce({ error: 'not-found' } as never)
      expect(await store.focusPane('p1')).toEqual({ ok: false, error: 'not-found' })
      mock.setResponse('channels.focus_pane', { ok: false, error: 'pane not found' })
      expect(await store.focusPane('p1')).toEqual({ ok: false, error: 'pane not found' })
    } finally {
      delete (window as unknown as { agentTeam?: unknown }).agentTeam
    }
  })
})
