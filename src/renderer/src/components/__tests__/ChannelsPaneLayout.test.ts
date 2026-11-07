// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import ChannelsPane from '../settings/ChannelsPane.vue'

vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  isMacPlatform: () => true,
}))

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

const ready = { lifecycle: 'ready', connected: true, identity: '@bot', last_error: '' }
const account = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  account: id, name, configured: true, enabled: true, status: ready, config: {}, capabilities: null, ...extra,
})
const platform = (id: string, accounts: Record<string, unknown>[]) => ({
  platform: id, configured: true, enabled: true, status: ready, config: {}, capabilities: null, accounts,
})
const chat = (id: string) => ({ chat_id: id, title: `chat ${id}`, kind: 'group', supports_topics: false, bindings: [] })

function seed(opts: { requests?: unknown[]; entries?: unknown[]; platforms?: unknown[] } = {}): void {
  mock.setResponse('channels.list', {
    ok: true,
    enabled: true,
    platforms: opts.platforms ?? [platform('telegram', [account('default', 'Navide'), account('bot-b1', 'Nerty'), account('bot-c2', 'IDA')])],
  })
  mock.setResponse('channels.bindings', { ok: true, bindings: [] })
  mock.setResponse('channels.overview', {
    ok: true,
    bots: [{ platform: 'telegram', account: 'default', orphans: [], chats: [chat('-1'), chat('-2')] }],
  })
  mock.setResponse('channels.pairing.list', { ok: true, requests: opts.requests ?? [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: opts.entries ?? [] })
}

async function render(): Promise<VueWrapper> {
  wrapper = mount(ChannelsPane, { attachTo: document.body, props: { backend: mock.backend }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

const navItems = (w: VueWrapper) => w.findAll('[data-testid="channel-nav-item"]')
const navItem = (w: VueWrapper, key: string) => w.get(`[data-testid="channel-nav-item"][data-key="${key}"]`)
const activeKey = (w: VueWrapper) => w.get('[data-testid="channel-nav-item"][aria-current="true"]').attributes('data-key')
const detail = (w: VueWrapper, account: string) => w.get(`[data-platform="telegram"] [data-account="${account}"]`)

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  mock = createMockBackend('connected')
})
afterEach(() => wrapper?.unmount())

describe('ChannelsPane two columns', () => {
  it('lists every bot on the left with its platform, people, chats and pending count', async () => {
    seed({
      requests: [{ platform: 'telegram', account: 'bot-b1', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }],
      entries: [{ platform: 'telegram', account: 'default', sender_id: '7', sender_name: 'amy', added_at: 1 }],
    })
    const w = await render()
    expect(navItems(w).map((i) => i.attributes('data-key'))).toEqual(['telegram:default', 'telegram:bot-b1', 'telegram:bot-c2'])
    const main = navItem(w, 'telegram:default')
    expect(main.text()).toContain('TG')
    expect(main.text()).toContain('Navide')
    expect(main.get('[data-testid="channel-nav-summary"]').text()).toBe('People: 1 · Chats: 2')
    expect(main.find('[data-testid="channel-nav-pending"]').exists()).toBe(false)
    expect(navItem(w, 'telegram:bot-b1').get('[data-testid="channel-nav-pending"]').text()).toBe('1 pending')
  })

  it('shows the status of a bot that is not connected in words', async () => {
    seed({ platforms: [platform('telegram', [account('default', 'Navide'), account('bot-b1', 'Off bot', { enabled: false })])] })
    const w = await render()
    expect(navItem(w, 'telegram:default').get('[data-testid="channel-nav-status"]').attributes('data-tone')).toBe('ok')
    expect(navItem(w, 'telegram:bot-b1').get('[data-testid="channel-nav-summary"]').text()).toContain('Off')
  })

  it('names each bot by its live handle with its label, slot id, Telegram id and where it is bound', async () => {
    const binding = { pane_id: 'p1', pane_name: 'HelperCTO', pane_exists: true, workspace_path: '/w/nt-notify-bridge',
      workspace_name: 'nt-notify-bridge', chat_title: 'HelperCTO', created_at: 1 }
    seed({ platforms: [platform('telegram', [account('bot-2e7877', '@NerdtechnicSalesBot', {
      status: { ...ready, identity: '@nt_test_bot', display_name: 'test' }, bot_id: '7421', bindings: [binding],
      last_activity_at: Math.floor(Date.now() / 1000) - 7200,
    })])] })
    const w = await render()
    const row = navItem(w, 'telegram:bot-2e7877')
    expect(row.text()).toContain('@nt_test_bot')
    expect(row.text()).not.toContain('NerdtechnicSalesBot')
    expect(row.get('[data-testid="channel-nav-tag"]').text()).toContain('test')
    expect(row.get('[data-testid="channel-nav-ids"]').text()).toBe('bot-2e7877 · id 7421')
    expect(row.get('[data-testid="channel-nav-binding"]').text()).toBe('nt-notify-bridge / HelperCTO · 2 hours ago')
  })

  it('flags a bot running, not linked, with its pane closed, or with a bad token', async () => {
    const bound = (exists: boolean) => [{ pane_id: 'p', pane_name: 'api', pane_exists: exists, workspace_path: '/w/A',
      workspace_name: 'A', chat_title: '', created_at: 1 }]
    seed({ platforms: [platform('telegram', [
      account('default', 'Run', { bindings: bound(true) }),
      account('bot-b1', 'Free', { bindings: [] }),
      account('bot-c2', 'Shut', { bindings: bound(false) }),
      account('bot-d3', 'Bad', { status: { ...ready, lifecycle: 'blocked', last_error: 'HTTP 401 Unauthorized' }, bindings: [] }),
      account('bot-e4', 'Down', { status: { ...ready, lifecycle: 'blocked', last_error: 'timed out' }, bindings: [] }),
    ])] })
    const w = await render()
    const flag = (key: string) => navItem(w, key).get('[data-testid="channel-nav-flag"]').text()
    expect(flag('telegram:default')).toBe('Running')
    expect(flag('telegram:bot-b1')).toBe('Not linked')
    expect(flag('telegram:bot-c2')).toBe('Pane closed')
    expect(flag('telegram:bot-d3')).toBe('Token invalid')
    expect(flag('telegram:bot-e4')).toBe('Connection failed')
    expect(navItem(w, 'telegram:bot-b1').get('[data-testid="channel-nav-binding"]').text()).toBe('Not linked to any pane')
  })

  describe('search', () => {
    afterEach(() => localStorage.clear())
    const many = () => {
      const target = account('bot-2e7877', '@NerdtechnicSalesBot', {
        status: { ...ready, identity: '@nt_test_bot', display_name: 'test' }, bot_id: '7421000',
        bindings: [{ pane_id: 'p1', pane_name: 'HelperCTO', pane_exists: true, workspace_path: '/w/nt-notify-bridge',
          workspace_name: 'nt-notify-bridge', chat_title: 'HelperCTO', created_at: 1 }],
      })
      const others = Array.from({ length: 24 }, (_, i) => account(`bot-a${i}`, `Other ${i}`, {
        status: { ...ready, identity: `@other_${i}_bot` }, bot_id: `6900${i}`, bindings: [],
      }))
      return [platform('telegram', [...others, target])]
    }
    const search = (w: VueWrapper) => w.get<HTMLInputElement>('[data-testid="channel-nav-search"]')
    const keys = (w: VueWrapper) => navItems(w).map((i) => i.attributes('data-key'))

    it.each(['test', '2e7877', 'HelperCTO', 'nt-notify-bridge', '7421', '@NT_TEST_BOT'])('finds the bot by %s', async (q) => {
      seed({ platforms: many() })
      const w = await render()
      expect(navItems(w)).toHaveLength(25)
      await search(w).setValue(q)
      expect(keys(w)).toEqual(['telegram:bot-2e7877'])
      expect(w.get('[data-testid="channel-nav-search-count"]').text()).toBe('1 / 25')
    })

    it('marks the hit and brings every row back when cleared', async () => {
      seed({ platforms: many() })
      const w = await render()
      await search(w).setValue('test')
      expect(navItem(w, 'telegram:bot-2e7877').find('mark').text()).toBe('test')
      await search(w).trigger('keydown', { key: 'Escape' })
      expect(search(w).element.value).toBe('')
      expect(navItems(w)).toHaveLength(25)
    })

    it('says when nothing matches, with a way to clear', async () => {
      seed({ platforms: many() })
      const w = await render()
      await search(w).setValue('zzz-nothing')
      expect(navItems(w)).toHaveLength(0)
      await w.get('[data-testid="channel-nav-search-clear"]').trigger('click')
      expect(navItems(w)).toHaveLength(25)
    })

    it('moves through the kept rows with the arrow keys', async () => {
      seed({ platforms: many() })
      const w = await render()
      await search(w).setValue('other_1')
      await search(w).trigger('keydown', { key: 'ArrowDown' })
      expect(activeKey(w)).toBe(keys(w)[0])
      await search(w).trigger('keydown', { key: 'ArrowDown' })
      expect(activeKey(w)).toBe(keys(w)[1])
    })

    it('lists the most recently active first, or by name, and groups by workspace', async () => {
      const bound = (ws: string) => [{ pane_id: ws, pane_name: 'p', pane_exists: true, workspace_path: `/w/${ws}`,
        workspace_name: ws, chat_title: '', created_at: 1 }]
      const bots = [
        account('bot-a', 'A', { status: { ...ready, identity: '@zeta_bot' }, last_activity_at: 100, bindings: bound('nt-notify-bridge') }),
        account('bot-b', 'B', { status: { ...ready, identity: '@alpha_bot' }, last_activity_at: 300, bindings: [] }),
        account('bot-c', 'C', { status: { ...ready, identity: '@mid_bot' }, last_activity_at: 200, bindings: bound('Agent-Team') }),
        ...Array.from({ length: 3 }, (_, i) => account(`bot-x${i}`, `X${i}`, { status: { ...ready, identity: `@x${i}_bot` }, bindings: [] })),
      ]
      seed({ platforms: [platform('telegram', bots)] })
      const w = await render()
      expect(keys(w).slice(0, 3)).toEqual(['telegram:bot-b', 'telegram:bot-c', 'telegram:bot-a'])
      await w.get('[data-testid="channel-nav-sort-name"]').trigger('click')
      expect(keys(w).slice(0, 3)).toEqual(['telegram:bot-b', 'telegram:bot-c', 'telegram:bot-x0'])
      await w.get('[data-testid="channel-nav-group-workspace"]').trigger('click')
      expect(w.findAll('[data-testid="channel-nav-group"]').map((g) => g.text())).toEqual(['Agent-Team', 'nt-notify-bridge', 'Not linked'])
      expect(keys(w).slice(0, 2)).toEqual(['telegram:bot-c', 'telegram:bot-a'])
      expect(localStorage.getItem('navide.channels.navSort')).toBe('name')
      expect(localStorage.getItem('navide.channels.navGroup')).toBe('workspace')
    })

    it('stays out of the way of a short list', async () => {
      seed()
      const w = await render()
      expect(w.find('[data-testid="channel-nav-search"]').exists()).toBe(false)
    })
  })

  it('opens on the first bot waiting for approval', async () => {
    seed({ requests: [{ platform: 'telegram', account: 'bot-c2', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }] })
    const w = await render()
    expect(activeKey(w)).toBe('telegram:bot-c2')
    expect(detail(w, 'bot-c2').isVisible()).toBe(true)
    expect(detail(w, 'default').isVisible()).toBe(false)
  })

  it('opens on the first bot when nothing waits, and does not jump when a request arrives later', async () => {
    seed()
    const w = await render()
    expect(activeKey(w)).toBe('telegram:default')
    seed({ requests: [{ platform: 'telegram', account: 'bot-c2', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }] })
    mock.emit('channels.pairing_request', {})
    await flushPromises()
    expect(navItem(w, 'telegram:bot-c2').get('[data-testid="channel-nav-pending"]').text()).toBe('1 pending')
    expect(activeKey(w)).toBe('telegram:default')
  })

  it('shows the picked bot only, and puts its people and requests inside it', async () => {
    seed({
      requests: [{ platform: 'telegram', account: 'bot-b1', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }],
      entries: [
        { platform: 'telegram', account: 'default', sender_id: '7', sender_name: 'amy', added_at: 1 },
        { platform: 'telegram', account: 'bot-b1', sender_id: '8', sender_name: 'bob', added_at: 2 },
      ],
    })
    const w = await render()
    expect(w.text()).not.toContain('Allowed senders')
    expect(detail(w, 'bot-b1').findAll('[data-testid="pairing-row"]')).toHaveLength(1)
    expect(detail(w, 'bot-b1').get('[data-testid="allow-row"]').text()).toContain('bob')
    expect(detail(w, 'default').find('[data-testid="pairing-row"]').exists()).toBe(false)
    expect(detail(w, 'default').get('[data-testid="allow-row"]').text()).toContain('amy')
    expect(detail(w, 'bot-c2').get('[data-testid="allow-empty"]').text()).toBe('No one is allowed yet.')
    await navItem(w, 'telegram:default').trigger('click')
    expect(activeKey(w)).toBe('telegram:default')
    expect(detail(w, 'default').isVisible()).toBe(true)
    expect(detail(w, 'bot-b1').isVisible()).toBe(false)
  })

  it('keeps the picked row in sight in a long list', async () => {
    const scroll = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    seed({ requests: [{ platform: 'telegram', account: 'bot-c2', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }] })
    const w = await render()
    expect(scroll.mock.contexts.at(-1)).toBe(navItem(w, 'telegram:bot-c2').element)
    await navItem(w, 'telegram:default').trigger('click')
    await flushPromises()
    expect(scroll.mock.contexts.at(-1)).toBe(navItem(w, 'telegram:default').element)
    Element.prototype.scrollIntoView = original
  })

  it('keeps the shared flag and hint in sight on the bot', async () => {
    seed({ entries: [{ platform: 'telegram', account: 'default', sender_id: '1087968824', sender_name: 'GroupAnonymousBot', added_at: 1, shared: true }] })
    const w = await render()
    const row = detail(w, 'default').get('[data-testid="allow-row"]')
    expect(row.isVisible()).toBe(true)
    expect(row.get('[data-testid="allow-shared"]').text()).toBe('Shared ID')
    expect(row.get('[data-testid="allow-shared-hint"]').text()).toContain('always refused')
  })

  it('groups by platform only when there are several', async () => {
    seed()
    const one = await render()
    expect(one.find('[data-testid="channel-nav-group"]').exists()).toBe(false)
    one.unmount()
    mock = createMockBackend('connected')
    seed({ platforms: [platform('telegram', [account('default', 'Navide')]), platform('discord', [account('default', 'Disco')])] })
    const w = await render()
    expect(w.findAll('[data-testid="channel-nav-group"]').map((g) => g.text())).toEqual(['Telegram', 'Discord'])
    expect(navItems(w).map((i) => i.attributes('data-key'))).toEqual(['telegram:default', 'discord:default'])
  })

  it('adds a bot from under the list: choosing a platform opens its form', async () => {
    seed()
    const w = await render()
    const tg = w.get('[data-platform="telegram"]')
    expect(tg.get('[data-testid="channel-add-bot"]').isVisible()).toBe(false)
    await w.get('[data-testid="channel-nav-add"]').trigger('click')
    expect(tg.get('[data-testid="channel-add-bot"]').isVisible()).toBe(true)
    expect(w.get('[data-platform="slack"] [data-testid="channel-manage"]').isVisible()).toBe(true)
    await tg.get('[data-testid="channel-add-bot"]').trigger('click')
    const added = navItems(w).at(-1)!
    expect(activeKey(w)).toBe(added.attributes('data-key'))
    expect(added.text()).toContain('New bot')
    expect(tg.find('form').isVisible()).toBe(true)
    await tg.get('form').findAll('button').find((b) => b.text() === 'Cancel')!.trigger('click')
    expect(navItems(w)).toHaveLength(3)
    expect(w.get('[data-testid="channel-nav-add"]').attributes('aria-current')).toBe('true')
  })

  it('opens on the platforms when no bot is set up, and connecting one shows its form', async () => {
    seed({ platforms: [] })
    const w = await render()
    expect(navItems(w)).toHaveLength(0)
    const slack = w.get('[data-platform="slack"]')
    expect(slack.get('[data-testid="channel-manage"]').isVisible()).toBe(true)
    await slack.get('[data-testid="channel-manage"]').trigger('click')
    expect(activeKey(w)).toBe('slack:default')
    expect(slack.get('form').isVisible()).toBe(true)
    expect(w.get('[data-platform="discord"]').isVisible()).toBe(false)
    await slack.get('form').findAll('button').find((b) => b.text() === 'Cancel')!.trigger('click')
    expect(navItems(w)).toHaveLength(0)
    expect(w.get('[data-platform="discord"]').isVisible()).toBe(true)
  })

  it('moves to a bot another bot created, since its link guide lives there', async () => {
    seed({ platforms: [platform('telegram', [account('default', 'Navide', { status: { ...ready, can_manage_bots: true } })])] })
    mock.setResponse('channels.managed_create', { ok: true, request_id: 'r1', url: 'https://t.me/newbot/a/b' })
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { openExternal: vi.fn(async () => ({ ok: true })) }
    const w = await render()
    await w.get('[data-testid="channel-managed-start"]').trigger('click')
    await w.get('[data-testid="channel-managed-confirm"]').trigger('click')
    await flushPromises()
    seed({ platforms: [platform('telegram', [account('default', 'Navide'), account('bot-new', '@made_bot')])] })
    mock.emit('channels.managed_created', { request_id: 'r1', ok: true, account: 'bot-new', name: '@made_bot', link: null })
    await flushPromises()
    expect(activeKey(w)).toBe('telegram:bot-new')
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  it('falls back to a bot that exists when the picked one is removed', async () => {
    seed()
    const w = await render()
    await navItem(w, 'telegram:bot-c2').trigger('click')
    seed({ platforms: [platform('telegram', [account('default', 'Navide'), account('bot-b1', 'Nerty')])] })
    mock.emit('channels.changed', {})
    await flushPromises()
    expect(activeKey(w)).toBe('telegram:default')
  })

  describe('entries no bot owns', () => {
    const orphans = {
      requests: [{ platform: 'telegram', account: 'bot-gone', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }],
      entries: [
        { platform: 'telegram', account: 'bot-gone', sender_id: '8', sender_name: 'bob', added_at: 2 },
        { platform: 'matrix', sender_id: '@a:b', sender_name: 'cy', added_at: 3, shared: false },
        { platform: 'telegram', account: '', sender_id: '9', sender_name: 'dee', added_at: 4 },
      ],
    }

    it('has its own place on the left with a count, naming platform and bot', async () => {
      seed(orphans)
      const w = await render()
      const item = navItem(w, 'orphans')
      expect(item.text()).toContain('No matching bot')
      expect(item.get('[data-testid="channel-nav-pending"]').text()).toBe('1 pending')
      expect(item.get('[data-testid="channel-nav-summary"]').text()).toBe('People: 2')
      // A pending request with no bot is the first thing waiting.
      expect(activeKey(w)).toBe('orphans')
      const view = w.get('[data-testid="channel-orphans"]')
      expect(view.isVisible()).toBe(true)
      expect(view.findAll('[data-testid="allow-bot"]').map((e) => e.text())).toEqual(['bot-gone', 'Main bot'])
      expect(view.get('[data-testid="pairing-bot"]').text()).toBe('bot-gone')
      expect(view.findAll('[data-testid="allow-row"]')[1].text()).toContain('Matrix')
    })

    it('treats an empty account as the default bot, as the bindings do', async () => {
      seed(orphans)
      const w = await render()
      expect(detail(w, 'default').get('[data-testid="allow-row"]').text()).toContain('dee')
    })

    it('can remove them, and approve or reject a request', async () => {
      seed(orphans)
      const w = await render()
      const view = w.get('[data-testid="channel-orphans"]')
      await view.get('[data-testid="pairing-reject"]').trigger('click')
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.pairing.reject')?.payload).toEqual({ platform: 'telegram', code: 'K7Q2M9XA' })
      await view.get('[data-testid="pairing-approve"]').trigger('click')
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.pairing.approve')?.payload).toEqual({ platform: 'telegram', code: 'K7Q2M9XA' })
      await view.findAll('[data-testid="allow-remove"]')[0].trigger('click')
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.allow.remove')?.payload).toEqual({ platform: 'telegram', sender_id: '8', account: 'bot-gone' })
    })

    it('is gone when nothing is left in it', async () => {
      seed()
      const w = await render()
      expect(w.find('[data-testid="channel-orphans"]').exists()).toBe(false)
      expect(w.find('[data-key="orphans"]').exists()).toBe(false)
    })
  })

  describe('in a narrow window', () => {
    const pane = (w: VueWrapper) => w.get('[data-testid="channel-layout"]').attributes('data-narrow-pane')

    it('starts on the list, a pick opens the bot, and back returns to the list', async () => {
      seed()
      const w = await render()
      expect(pane(w)).toBe('list')
      await navItem(w, 'telegram:bot-b1').trigger('click')
      expect(pane(w)).toBe('detail')
      await w.get('[data-testid="channel-nav-back"]').trigger('click')
      expect(pane(w)).toBe('list')
      expect(activeKey(w)).toBe('telegram:bot-b1')
    })

    it('goes straight to the platforms when there is no bot to list', async () => {
      seed({ platforms: [] })
      const w = await render()
      expect(pane(w)).toBe('detail')
      expect(w.find('[data-testid="channel-nav-back"]').exists()).toBe(false)
    })
  })
})
