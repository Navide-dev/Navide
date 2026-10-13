// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import SyncSettings from '../SyncSettings.vue'

const conflict = {
  scope: 'prompts',
  itemId: 'p1',
  local: { id: 'p1', prompt: 'mine' },
  remote: { id: 'p1', prompt: 'theirs' },
  remoteRev: 4,
  remoteDevice: 'laptop',
  seenAt: 1,
}

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    'sync.status': {
      ok: true,
      payload: {
        available: ['prompts', 'mcp', 'skills', 'memory'],
        scopes: { prompts: false, mcp: false, skills: false, memory: false },
        hasKey: true,
        conflicts: 0,
        link: { state: 'connected' },
      },
    },
    'sync.conflicts': { ok: true, payload: { conflicts: [] } },
    'sync.set_scope': {
      ok: true,
      payload: { scopes: { prompts: true, mcp: false, skills: false, memory: false } },
    },
    'sync.now': { ok: true, payload: { results: [] } },
    'sync.resolve': { ok: true, payload: { ok: true, conflicts: [] } },
    ...overrides,
  }
  const send = vi.fn(async (type: string, _payload?: unknown) => responses[type])
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const on = vi.fn((type: string, fn: (payload: unknown) => void) => {
    if (!handlers.has(type)) handlers.set(type, new Set())
    handlers.get(type)!.add(fn)
    return () => handlers.get(type)?.delete(fn)
  })
  const emit = (type: string, payload: unknown) => handlers.get(type)?.forEach((fn) => fn(payload))
  return { backend: { send, on } as never, send, on, emit, handlers }
}

describe('SyncSettings', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  it('lists every scope with its switch off until someone turns it on', async () => {
    const { backend } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const switches = wrapper.findAll('button[role="switch"]')
    // Memory is no longer synced: with its switch off it is not listed.
    expect(switches).toHaveLength(3)
    expect(switches.every((s) => s.attributes('aria-checked') === 'false')).toBe(true)
    expect(wrapper.text()).not.toContain('Memory')
  })

  it('shows memory left on with only an off switch and a note that it is not synced', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts', 'mcp', 'skills', 'memory'],
          scopes: { prompts: false, mcp: false, skills: false, memory: true },
          hasKey: true,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
      'sync.set_scope': { ok: true, payload: { scopes: { prompts: false, mcp: false, skills: false, memory: false } } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    const switches = wrapper.findAll('button[role="switch"]')
    expect(switches).toHaveLength(4)
    expect(wrapper.text()).toContain('Memory is not synced any more')
    expect(switches[3].attributes('disabled')).toBeUndefined()
    await switches[3].trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('sync.set_scope', { scope: 'memory', enabled: false })
    // Once off, it is gone from the list.
    expect(wrapper.findAll('button[role="switch"]')).toHaveLength(3)
  })

  it('turning a scope on sends exactly that scope', async () => {
    const { backend, send } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.findAll('button[role="switch"]')[0].trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('sync.set_scope', { scope: 'prompts', enabled: true })
  })

  it('shows both sides of a conflict and offers neither as the default', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': { ok: true, payload: { conflicts: [conflict] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('mine')
    expect(text).toContain('theirs')
    expect(text).toContain('laptop')
    // Two buttons, one per side: nothing is pre-selected for the user.
    const sides = wrapper.findAll('.sync-conflict-side button')
    expect(sides).toHaveLength(2)
  })

  it('answering a conflict says which side to keep', async () => {
    const { backend, send } = mockBackend({
      'sync.conflicts': { ok: true, payload: { conflicts: [conflict] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.findAll('.sync-conflict-side button')[1].trigger('click')
    await flushPromises()

    expect(send).toHaveBeenCalledWith('sync.resolve', {
      scope: 'prompts',
      itemId: 'p1',
      keep: 'remote',
    })
  })

  it('says "not connected" rather than looking broken when the link is down', async () => {
    const { backend } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts'],
          scopes: { prompts: true },
          hasKey: true,
          conflicts: 0,
          link: { state: 'unreachable' },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.find('.sync-note').text()).toContain('Not connected')
    expect(wrapper.find('.err-msg').exists()).toBe(false)
  })

  it('a connected device with no key says so instead of silently syncing nothing', async () => {
    const { backend } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts'],
          scopes: { prompts: true },
          hasKey: false,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.find('.sync-note').text()).toContain('no sync key')
  })

  // The credentials adapter is complete and tested but its review is not, and
  // it is the one scope that puts a CLI credential on the wire. Holding it out
  // of READY is the whole gate: the Accounts pane reads the cloud side only
  // while `scopes.credentials` is on, so a scope that cannot be switched on
  // leaves nothing downstream able to reach a credential either. Re-adding it
  // to READY without finishing that review is what this test exists to catch.
  it('lists credentials but does not let it be turned on', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts', 'mcp', 'skills', 'memory', 'credentials'],
          scopes: { prompts: false, mcp: false, skills: false, memory: false, credentials: false },
          hasKey: true,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const switches = wrapper.findAll('button[role="switch"]')
    expect(switches).toHaveLength(4)
    // Still listed, so the section does not silently disappear…
    expect(wrapper.text()).toContain('Credentials')
    // …but described as unavailable rather than by what it would sync.
    expect(wrapper.text()).toContain('Not syncable yet.')
    expect(wrapper.text()).not.toContain('never removes it from the cloud')
    expect(switches[3].attributes('disabled')).toBeDefined()

    await switches[3].trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('sync.set_scope', {
      scope: 'credentials',
      enabled: true,
    })
  })

  // K-2: a credentials switch left on by an older build used to show ON and
  // disabled, so it could never be switched off. Off must stay reachable;
  // on must stay unreachable.
  it('lets a credentials switch left on be turned off, and never back on', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts', 'credentials'],
          scopes: { prompts: false, credentials: true },
          hasKey: true,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
      'sync.set_scope': { ok: true, payload: { scopes: { prompts: false, credentials: false } } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    let creds = wrapper.findAll('button[role="switch"]')[1]
    expect(creds.attributes('aria-checked')).toBe('true')
    expect(creds.attributes('disabled')).toBeUndefined()
    await creds.trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('sync.set_scope', { scope: 'credentials', enabled: false })

    creds = wrapper.findAll('button[role="switch"]')[1]
    expect(creds.attributes('aria-checked')).toBe('false')
    expect(creds.attributes('disabled')).toBeDefined()
    await creds.trigger('click')
    await flushPromises()
    expect(send).not.toHaveBeenCalledWith('sync.set_scope', {
      scope: 'credentials',
      enabled: true,
    })
  })

  it('still lets the three reviewed scopes be turned on', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts', 'mcp', 'skills', 'memory', 'credentials'],
          scopes: { prompts: false, mcp: false, skills: false, memory: false, credentials: false },
          hasKey: true,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const switches = wrapper.findAll('button[role="switch"]')
    for (const [index, scope] of ['prompts', 'mcp', 'skills'].entries()) {
      expect(switches[index].attributes('disabled')).toBeUndefined()
      await switches[index].trigger('click')
      await flushPromises()
      expect(send).toHaveBeenCalledWith('sync.set_scope', { scope, enabled: true })
    }
  })

  it('shows a sealed conflict by slot, never by content', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': {
        ok: true,
        payload: {
          conflicts: [
            {
              scope: 'credentials',
              itemId: 'c-0123456789abcdef0123456789abcdef',
              local: { agentKey: 'claude', slotId: '__default__' },
              remote: { sealed: true },
              remoteRev: 7,
              remoteDevice: 'laptop',
              seenAt: 1,
              sealed: true,
            },
          ],
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const bodies = wrapper.findAll('.sync-side-body').map((b) => b.text())
    expect(bodies).toEqual(['claude / __default__', '(credential — not shown)'])
    expect(wrapper.text()).not.toContain('agentKey')
    expect(wrapper.findAll('.sync-conflict-side button')).toHaveLength(2)
  })

  // C-3: an MCP record carries its secrets in env and headers; a conflict
  // preview names them but never shows their values, in the text or the hover.
  it('masks MCP env and header values in a conflict preview', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': {
        ok: true,
        payload: {
          conflicts: [
            {
              scope: 'mcp',
              itemId: 'github',
              local: { name: 'github', command: 'npx', env: { GITHUB_TOKEN: 'ghp_localsecret' } },
              remote: {
                name: 'github',
                url: 'https://x.example',
                headers: { Authorization: 'Bearer remotesecret' },
              },
              remoteRev: 2,
              remoteDevice: 'laptop',
              seenAt: 1,
            },
          ],
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const html = wrapper.html()
    expect(html).not.toContain('ghp_localsecret')
    expect(html).not.toContain('remotesecret')
    expect(wrapper.text()).toContain('GITHUB_TOKEN')
    expect(wrapper.text()).toContain('Authorization')
    expect(wrapper.text()).toContain('npx')
  })

  // X-5: "Sync now" used to look only at resp.ok, so a scope that failed,
  // was skipped or left items behind looked exactly like one that synced.
  it('shows what each scope did after "Sync now", not only that the call returned', async () => {
    const { backend } = mockBackend({
      'sync.now': {
        ok: true,
        payload: {
          results: [
            { scope: 'prompts', error: 'server said no' },
            { scope: 'mcp', skipped: 'no-key' },
            {
              scope: 'skills',
              pulled: 1,
              pushed: 2,
              conflicts: 0,
              held: ['waiting-skill'],
              refused: ['refused-skill'],
              tooLarge: ['huge-skill'],
            },
            { scope: 'memory', skipped: 'disabled' },
          ],
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.sync-actions button').trigger('click')
    await flushPromises()

    const rows = wrapper.findAll('.sync-result')
    // A switched-off scope says nothing: off is the default, not news.
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('Prompts')
    expect(rows[0].text()).toContain('server said no')
    expect(rows[0].find('.sync-result-error').exists()).toBe(true)
    expect(rows[1].text()).toContain('no sync key')
    expect(rows[2].text()).toContain('Pulled 1, pushed 2')
    expect(rows[2].text()).toContain('waiting-skill')
    expect(rows[2].text()).toContain('refused-skill')
    expect(rows[2].text()).toContain('huge-skill')
  })

  it('says "not connected" when Sync now could not reach the server', async () => {
    const { backend } = mockBackend({
      'sync.now': { ok: true, payload: { results: [{ scope: 'all', skipped: 'not-connected' }] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.sync-actions button').trigger('click')
    await flushPromises()

    const rows = wrapper.findAll('.sync-result')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('All sections')
    expect(rows[0].text()).toContain('not connected')
  })

  it('shows each scope\'s last result from sync.status on open', async () => {
    const { backend } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts', 'memory'],
          scopes: { prompts: true, memory: true },
          hasKey: true,
          link: { state: 'connected' },
          last: {
            prompts: { scope: 'prompts', ok: true, pulled: 3, pushed: 0, conflicts: 0, at: 1 },
            memory: { scope: 'memory', ok: true, pulled: 0, pushed: 0, tooLarge: ['CLAUDE.md'] },
          },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const rows = wrapper.findAll('.sync-result')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Pulled 3, pushed 0')
    expect(rows[1].text()).toContain('CLAUDE.md')
  })

  // A round the backend runs on its own (after a local save, on reconnect)
  // must show up without reopening Settings.
  it('updates live on sync.result and reloads the conflicts', async () => {
    const { backend, send, emit, handlers } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()
    const conflictLoads = () => send.mock.calls.filter(([type]) => type === 'sync.conflicts').length
    const before = conflictLoads()

    emit('sync.result', {
      scope: 'mcp',
      ok: false,
      error: 'page too large',
      pulled: 0,
      pushed: 0,
      conflicts: 1,
      held: [],
      refused: [],
      tooLarge: [],
      at: 2,
    })
    await flushPromises()

    const rows = wrapper.findAll('.sync-result')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('MCP')
    expect(rows[0].text()).toContain('page too large')
    expect(conflictLoads()).toBe(before + 1)

    wrapper.unmount()
    wrapper = undefined
    expect(handlers.get('sync.result')?.size ?? 0).toBe(0)
  })

  // ACC-12: with more than one account on a machine, "Sync" alone does not
  // say whose cloud these sections go to.
  it('names the account that is syncing', async () => {
    const { backend } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts'],
          scopes: { prompts: true },
          hasKey: true,
          link: { state: 'connected' },
          account: { email: 'me@example.com', memberId: 'm-123' },
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.get('.sync-account').text()).toContain('me@example.com')
  })

  it('says nothing about an account when sync.status names none', async () => {
    const { backend } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.find('.sync-account').exists()).toBe(false)
  })

  // The backend also reports its internal skill-files scope; it must read as
  // a named section, not as a missing translation key.
  it('names the skill-files scope in a live result', async () => {
    const { backend, emit } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    emit('sync.result', {
      scope: 'skill-files',
      ok: true,
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      held: [],
      refused: [],
      tooLarge: ['big-skill'],
      at: '2026-10-09T05:00:00Z',
    })
    await flushPromises()

    const row = wrapper.get('.sync-result')
    expect(row.text()).toContain('Skill files')
    expect(row.text()).not.toContain('settings.sync')
    expect(row.text()).toContain('big-skill')
  })

  // remoteAbsent: the cloud never had this item (a rev-0 synthetic tombstone);
  // "keep theirs" would delete the local copy and the backend refuses it.
  it('offers only "keep this one" when the cloud side never existed', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': {
        ok: true,
        payload: { conflicts: [{ ...conflict, remote: null, remoteRev: 0, remoteAbsent: true }] },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const buttons = wrapper.findAll('.sync-conflict-side button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].text()).toBe('Keep this one')
  })

  // C-3 follow-up: secrets also ride in an MCP record's url (userinfo, query)
  // and args (secret flags, KEY=value, Bearer tokens).
  it('masks secrets in MCP url and args in a conflict preview', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': {
        ok: true,
        payload: {
          conflicts: [
            {
              scope: 'mcp',
              itemId: 'svc',
              local: {
                name: 'svc',
                command: 'npx',
                args: [
                  '--api-key',
                  'flagsecret1',
                  '--Token=flagsecret2',
                  'GITHUB_PAT_KEY=kvsecret3',
                  'Bearer bearersecret4',
                  '--verbose',
                  'plain-arg',
                ],
              },
              remote: {
                name: 'svc',
                url: 'https://alice:pwsecret5@host.example/mcp?access=qsecret6&mode=qsecret7#top',
              },
              remoteRev: 2,
              remoteDevice: 'laptop',
              seenAt: 1,
            },
          ],
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const html = wrapper.html()
    for (let i = 1; i <= 7; i += 1) expect(html).not.toMatch(new RegExp(`secret${i}`))
    expect(html).not.toContain('alice')
    const text = wrapper.text()
    for (const kept of ['--api-key', '--Token=', 'GITHUB_PAT_KEY=', 'Bearer', '--verbose', 'plain-arg']) {
      expect(text).toContain(kept)
    }
    expect(text).toContain('host.example/mcp?access=')
    expect(text).toContain('mode=')
  })

  it('masks an Authorization header and a Bearer token anywhere in an MCP arg', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': {
        ok: true,
        payload: {
          conflicts: [
            {
              scope: 'mcp',
              itemId: 'svc',
              local: {
                name: 'svc',
                args: ['-H', 'Authorization: Basic hdrsecret8==', '--header=authorization: Basic inlinesecret10'],
              },
              remote: {
                name: 'svc',
                args: ['-H', 'X-Upstream: Bearer midsecret9= tail'],
              },
              remoteRev: 2,
              remoteDevice: 'laptop',
              seenAt: 1,
            },
          ],
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const html = wrapper.html()
    expect(html).not.toContain('hdrsecret8')
    expect(html).not.toContain('Basic')
    expect(html).not.toContain('midsecret9')
    expect(html).not.toContain('inlinesecret10')
    const text = wrapper.text()
    expect(text).toContain('Authorization: ••••')
    // Any `Name: value` header loses its whole value (D2), Bearer included.
    expect(text).toContain('X-Upstream: ••••')
  })

  // gaveUp is the part of held that has been deferred for long (5+ rounds or
  // 30+ minutes): stuck, still retrying, and not the same as "waiting".
  it('shows stuck items apart from the ones that are only waiting', async () => {
    const { backend, emit } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    emit('sync.result', {
      scope: 'skills',
      ok: true,
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      held: ['fresh-skill', 'stuck-skill'],
      gaveUp: ['stuck-skill'],
      refused: [],
      tooLarge: [],
      at: '2026-10-09T05:00:00Z',
    })
    await flushPromises()

    const lines = wrapper.findAll('.sync-result-line').map((l) => l.text())
    const waiting = lines.find((l) => l.startsWith('Waiting'))
    const stuck = lines.find((l) => l.startsWith('Stuck'))
    expect(waiting).toContain('fresh-skill')
    expect(waiting).not.toContain('stuck-skill')
    expect(stuck).toContain('stuck-skill')
    expect(stuck).toContain('retrying')
  })

  // resetThrottled: the server asked this scope to start over a second time
  // within an hour; the backend refused, so nothing moved. "Pulled 0, pushed 0"
  // would read as an ordinary quiet round.
  it('says a throttled reset paused the scope instead of reporting a quiet round', async () => {
    const { backend, emit } = mockBackend()
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    emit('sync.result', {
      scope: 'prompts',
      ok: true,
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      held: [],
      gaveUp: [],
      refused: [],
      tooLarge: [],
      resetThrottled: true,
      at: '2026-10-09T06:30:00Z',
    })
    await flushPromises()

    const row = wrapper.get('.sync-result')
    expect(row.text()).toContain('paused')
    expect(row.text()).toContain('an hour')
    expect(row.text()).not.toContain('Pulled 0')
    expect(row.find('.sync-result-error').exists()).toBe(true)
  })

  // R-C4: env and header values are masked on both sides, so the backend
  // compares them and says per name whether picking a side changes a secret.
  it('says which masked MCP secrets differ between the sides, never their values', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': {
        ok: true,
        payload: {
          conflicts: [
            {
              scope: 'mcp',
              itemId: 'github',
              local: { name: 'github', env: { API_KEY: '••••••', REGION: '••••••' } },
              remote: { name: 'github', env: { API_KEY: '••••••', REGION: '••••••', NEW: '••••••' } },
              remoteRev: 2,
              remoteDevice: 'laptop',
              seenAt: 1,
              masked: {
                env: { API_KEY: 'differs', REGION: 'same', NEW: 'remote-only' },
                headers: { Authorization: 'local-only' },
              },
            },
          ],
        },
      },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const items = wrapper.findAll('.sync-secret-state').map((i) => i.text())
    expect(items).toEqual([
      'API_KEY: differs',
      'REGION: same',
      'NEW: only on the other device',
      'Authorization: only on this device',
    ])
    expect(wrapper.findAll('.sync-secret-state.is-differs')).toHaveLength(3)
  })

  it('shows no secret comparison when the row has none', async () => {
    const { backend } = mockBackend({
      'sync.conflicts': { ok: true, payload: { conflicts: [{ ...conflict, scope: 'mcp', masked: {} }] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    expect(wrapper.find('.sync-secrets').exists()).toBe(false)
  })

  it('shows the active key by id and rotates only on the second click', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts'],
          scopes: { prompts: false },
          hasKey: true,
          keyId: 'abcdef0123456789',
          legacyRingPending: false,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
      'sync.rotate_key': { ok: true, payload: { keyId: 'fedcba9876543210', results: [] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const row = wrapper.get('.sync-key-row')
    expect(row.text()).toContain('abcdef01')
    expect(row.text()).not.toContain('abcdef0123456789') // the id is shortened, and it is only an id
    const rotate = row.findAll('button')[0]
    expect(rotate.text()).toBe('Rotate key')
    await rotate.trigger('click')
    expect(send).not.toHaveBeenCalledWith('sync.rotate_key', {}, 60_000)
    expect(row.findAll('button')[0].text()).toBe('Rotate now')
    await row.findAll('button')[0].trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('sync.rotate_key', {}, 60_000)
  })

  it('offers to adopt a key from before accounts were bound, and only then', async () => {
    const { backend, send } = mockBackend({
      'sync.status': {
        ok: true,
        payload: {
          available: ['prompts'],
          scopes: { prompts: false },
          hasKey: false,
          keyId: '',
          legacyRingPending: true,
          conflicts: 0,
          link: { state: 'connected' },
        },
      },
      'sync.adopt_legacy_key': { ok: true, payload: { results: [] } },
    })
    wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
    await flushPromises()

    const legacy = wrapper.get('.sync-key-legacy')
    expect(legacy.text()).toContain('before accounts were bound')
    expect(wrapper.find('.sync-key-row').exists()).toBe(false) // nothing to rotate yet
    await legacy.get('button').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('sync.adopt_legacy_key', {}, 30_000)
  })

  describe('approvals and secret warnings', () => {
    const held = {
      scope: 'mcp',
      itemId: 'runner',
      digest: 'd1',
      status: 'pending',
      kind: 'new',
      displayable: true,
      summary: {
        name: 'runner',
        command: '/tmp/evil',
        args: ['--x', 'a b'],
        env: { NODE_OPTIONS: '--require /tmp/x.js', TOKEN: '••••••' },
      },
      at: 1,
    }

    it('lists what is waiting for approval and approves exactly one', async () => {
      const { backend, send } = mockBackend({
        'sync.approvals': { ok: true, payload: { approvals: [held] } },
        'sync.approval.decide': { ok: true, payload: { approval: { status: 'applied' }, approvals: [] } },
      })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()

      const card = wrapper.find('.sync-approval')
      expect(card.exists()).toBe(true)
      expect(card.text()).toContain('runner')
      expect(card.text()).toContain('/tmp/evil')
      // Args as a JSON array: ["a b"] and ["a", "b"] must not look alike.
      expect(card.text()).toContain('["--x","a b"]')
      // Non-secret env values are shown; secret ones arrive masked.
      expect(card.text()).toContain('NODE_OPTIONS=--require /tmp/x.js')
      expect(card.text()).toContain('TOKEN=••••••')
      await card.find('button.sync-approve').trigger('click')
      await flushPromises()
      // The decision names the exact version shown.
      expect(send).toHaveBeenCalledWith('sync.approval.decide', {
        scope: 'mcp',
        itemId: 'runner',
        approve: true,
        digest: 'd1',
      })
      expect(wrapper.find('.sync-approval').exists()).toBe(false)
    })

    it('rejects without approving', async () => {
      const { backend, send } = mockBackend({
        'sync.approvals': { ok: true, payload: { approvals: [held] } },
        'sync.approval.decide': {
          ok: true,
          payload: { approval: { status: 'rejected' }, approvals: [{ ...held, status: 'rejected' }] },
        },
      })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      await wrapper.find('button.sync-reject').trigger('click')
      await flushPromises()
      expect(send).toHaveBeenCalledWith('sync.approval.decide', {
        scope: 'mcp',
        itemId: 'runner',
        approve: false,
        digest: 'd1',
      })
      // A rejected record is no longer asked about.
      expect(wrapper.find('.sync-approval').exists()).toBe(false)
    })

    it('shows invisible and direction-changing characters escaped', async () => {
      const sneaky = {
        ...held,
        summary: { name: 'runner', command: 'np\u200bx', args: ['safe\u202e.js', 'x\u2028y'] },
      }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [sneaky] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const text = wrapper.find('.sync-approval').text()
      expect(text).toContain('np\\u{200B}x')
      expect(text).toContain('safe\\u{202E}.js')
      expect(text).toContain('x\\u{2028}y')
      expect(text).not.toMatch(/[\u200b\u202e\u2028]/)
    })

    it('lists a skill file by file with size and hash, and previews SKILL.md and scripts', async () => {
      const skill = {
        scope: 'skills',
        itemId: 'runner',
        digest: 'd2',
        status: 'pending',
        kind: 'new',
        displayable: true,
        summary: {
          name: 'runner',
          files: [
            { path: 'SKILL.md', size: 36, sha256: 'a'.repeat(64) },
            { path: 'a, b.sh', size: 10, sha256: 'b'.repeat(64) },
          ],
          skillMd: '---\nname: runner\n---\nrun the thing',
          skillMdTruncated: true,
          executable: ['a, b.sh'],
          previews: [{ path: 'a, b.sh', preview: '#!/bin/sh\necho hi', truncated: true, executable: true }],
        },
      }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [skill] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const card = wrapper.find('.sync-approval')
      const rows = card.findAll('li.sync-approval-file')
      expect(rows).toHaveLength(2)
      expect(rows[1].text()).toContain('a, b.sh')
      expect(rows[1].text()).toContain('bbbbbbbbbbbb')
      expect(card.find('pre.sync-approval-skillmd').text()).toContain('run the thing')
      // A cut preview says so, SKILL.md included.
      expect(card.findAll('.sync-approval-cut')).toHaveLength(2)
      expect(card.find('pre.sync-approval-script').text()).toContain('echo hi')
    })

    it('shows every env entry on its own row', async () => {
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [held] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const rows = wrapper.findAll('li.sync-approval-env')
      expect(rows.map((r) => r.text())).toEqual(['NODE_OPTIONS=--require /tmp/x.js', 'TOKEN=••••••'])
    })

    it('offers no Approve for a record it cannot show in full', async () => {
      const stub = { ...held, displayable: false, summary: { name: 'runner', truncated: true } }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [stub] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const card = wrapper.find('.sync-approval')
      expect(card.find('button.sync-approve').exists()).toBe(false)
      expect(card.find('button.sync-reject').exists()).toBe(true)
      expect(card.find('.sync-approval-undisplayable').exists()).toBe(true)
    })

    it('escapes blank-looking, separator and combining characters too', async () => {
      const sneaky = { ...held, summary: { name: 'runner', command: 'a\u00a0b\u3164c\u0301d e' } }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [sneaky] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const text = wrapper.find('.sync-approval').text()
      expect(text).toContain('a\\u{00A0}b\\u{3164}c\\u{0301}d e')
    })

    it('says why a held large skill cannot be approved', async () => {
      const stuck = {
        ...held,
        scope: 'skill-files',
        displayable: false,
        summary: { name: 'big', files: [], unavailable: 'its files could not be downloaded for review: gone' },
      }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [stuck] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const card = wrapper.find('.sync-approval')
      expect(card.find('button.sync-approve').exists()).toBe(false)
      expect(card.find('.sync-approval-undisplayable').text()).toContain('could not be downloaded for review: gone')
    })

    it('shows a skill frontmatter whole and calls out hooks and allowed-tools', async () => {
      const skill = {
        ...held,
        scope: 'skills',
        summary: {
          name: 'runner',
          files: [{ path: 'SKILL.md', size: 10, sha256: 'a'.repeat(64) }],
          skillMd: 'body',
          frontmatter: 'name: runner\nallowed-tools: Bash\nhooks:\n  PreToolUse: []',
          frontmatterFlags: ['allowed-tools', 'hooks'],
          previews: [],
          executable: [],
        },
      }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [skill] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const card = wrapper.find('.sync-approval')
      expect(card.find('pre.sync-approval-frontmatter').text()).toContain('PreToolUse')
      expect(card.findAll('.sync-approval-flag').map((f) => f.text().split(':')[0])).toEqual(['allowed-tools', 'hooks'])
    })

    it('says a skill switched off here would be switched on', async () => {
      const decision = {
        ...held,
        scope: 'skills',
        kind: 'changed',
        summary: { name: 'writer', enabled: true, targets: null, previousEnabled: false, previousTargets: null },
      }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [decision] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      expect(wrapper.find('.sync-approval-decision').exists()).toBe(true)
    })

    it('shows a held memory file whole, with a diff against this device', async () => {
      const memory = {
        ...held,
        scope: 'memory',
        itemId: '.claude:CLAUDE.md',
        kind: 'changed',
        summary: {
          path: '~/.claude/CLAUDE.md',
          bytes: 9,
          text: 'one\nTWO\u202e\n',
          diff: '--- this device\n+++ incoming\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n',
        },
      }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [memory] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const card = wrapper.find('.sync-approval')
      expect(card.text()).toContain('~/.claude/CLAUDE.md')
      expect(card.find('pre.sync-approval-text').text()).toContain('TWO\\u{202E}')
      expect(card.findAll('.sync-diff-del').map((l) => l.text())).toEqual(['-two'])
      expect(card.findAll('.sync-diff-add').map((l) => l.text())).toEqual(['+TWO'])
    })

    it('shows every field of a held prompt and what changed', async () => {
      const prompt = {
        ...held,
        scope: 'prompts',
        itemId: 'p1',
        kind: 'changed',
        summary: {
          id: 'p1',
          name: 'loop',
          record: { name: 'loop', prompt: 'exfiltrate ~/.ssh', isDefault: true },
          changes: [{ field: 'prompt', from: 'be nice', to: 'exfiltrate ~/.ssh' }],
        },
      }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [prompt] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const card = wrapper.find('.sync-approval')
      expect(card.findAll('li.sync-approval-field').map((f) => f.text())).toEqual([
        'name: "loop"',
        'prompt: "exfiltrate ~/.ssh"',
        'isDefault: true',
      ])
      expect(card.find('.sync-approval-change').text()).toContain('"be nice"')
    })

    it('keeps the lines of a held text as lines', async () => {
      const memory = {
        ...held,
        scope: 'memory',
        itemId: '.claude:CLAUDE.md',
        summary: { path: '~/.claude/CLAUDE.md', text: 'one\ntwo\u200b\n', diff: '' },
      }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [memory] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const text = wrapper.find('pre.sync-approval-text').text()
      expect(text).toContain('one\ntwo\\u{200B}')
      expect(text).not.toContain('\\u{000A}')
    })

    it('loads a collapsed card whole before it offers Approve', async () => {
      const brief = { ...held, scope: 'memory', itemId: '.claude:CLAUDE.md', collapsed: true,
        summary: { path: '~/.claude/CLAUDE.md', bytes: 300000 } }
      const whole = { ...brief, collapsed: false, summary: { ...brief.summary, text: 'big body', diff: '+big body\n' } }
      const { backend, send } = mockBackend({
        'sync.approvals': { ok: true, payload: { approvals: [brief] } },
        'sync.approval.detail': { ok: true, payload: { approval: whole } },
      })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      expect(wrapper.find('button.sync-approve').exists()).toBe(false)
      await wrapper.find('button.sync-expand').trigger('click')
      await flushPromises()
      expect(send).toHaveBeenCalledWith('sync.approval.detail', { scope: 'memory', itemId: '.claude:CLAUDE.md' })
      expect(wrapper.find('pre.sync-approval-text').text()).toContain('big body')
      expect(wrapper.find('button.sync-approve').exists()).toBe(true)
    })

    it('says which prompt a held delete would make the loop prompt', async () => {
      const del = { ...held, scope: 'prompts', itemId: 'p1', kind: 'delete',
        summary: { id: 'p1', name: 'a', deletes: true, newLoopPrompt: 'force' } }
      const { backend } = mockBackend({ 'sync.approvals': { ok: true, payload: { approvals: [del] } } })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const lines = wrapper.findAll('.sync-approval-decision').map((l) => l.text())
      expect(lines[0]).toContain('delete')
      expect(lines[1]).toContain('force')
    })

    it('says when a queue is full and new records are being refused', async () => {
      const { backend } = mockBackend({
        'sync.approvals': { ok: true, payload: { approvals: [], full: ['mcp'] } },
      })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      expect(wrapper.find('.sync-approvals-full').exists()).toBe(true)
    })

    it('names an item that may carry a secret, and dismisses it', async () => {
      const warning = { scope: 'prompts', itemId: 'p1', label: 'deploy', fields: ['prompt'] }
      const { backend, send } = mockBackend({
        'sync.secret_warnings': { ok: true, payload: { warnings: [warning] } },
        'sync.secret_warning.dismiss': { ok: true, payload: { warnings: [] } },
      })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const row = wrapper.find('.sync-secret-warning')
      expect(row.text()).toContain('deploy')
      await row.find('button').trigger('click')
      await flushPromises()
      expect(send).toHaveBeenCalledWith('sync.secret_warning.dismiss', { scope: 'prompts', itemId: 'p1' })
      expect(wrapper.find('.sync-secret-warning').exists()).toBe(false)
    })

    it('re-reads both lists when a round reports', async () => {
      const { backend, send, emit } = mockBackend({
        'sync.approvals': { ok: true, payload: { approvals: [] } },
        'sync.secret_warnings': { ok: true, payload: { warnings: [] } },
      })
      wrapper = mount(SyncSettings, { props: { backend }, global: { plugins: [i18n] } })
      await flushPromises()
      const count = (type: string) => send.mock.calls.filter(([t]) => t === type).length
      const before = [count('sync.approvals'), count('sync.secret_warnings')]
      emit('sync.result', { scope: 'mcp', ok: true })
      await flushPromises()
      expect([count('sync.approvals'), count('sync.secret_warnings')]).toEqual([before[0] + 1, before[1] + 1])
    })
  })
})
