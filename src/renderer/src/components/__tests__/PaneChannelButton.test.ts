// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useChannels } from '../../composables/useChannels'
import { useGuard } from '../../composables/useGuard'
import { useAgentMessaging } from '../../composables/useAgentMessaging'
import { settingsSet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import PaneChannelButton from '../PaneChannelButton.vue'

const exec = vi.hoisted(() => vi.fn())
vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  executeCommand: exec,
}))

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

function seed(opts: {
  configured: boolean
  bound?: boolean
  extra?: Record<string, unknown>[]
  locations?: Record<string, unknown>[]
  bindings?: Record<string, unknown>[]
  status?: Record<string, unknown>
}): void {
  mock.setResponse('channels.list', {
    ok: true,
    enabled: true,
    platforms: opts.configured
      ? [{
          platform: 'telegram',
          configured: true,
          enabled: true,
          status: { lifecycle: 'ready', connected: true, identity: '@navide_bot', ...opts.status },
          config: {},
          capabilities: { threads: true, create_location: true, edit: true, typing: true, buttons: true, text_limit: 4000 },
        }, ...(opts.extra ?? [])]
      : [],
  })
  mock.setResponse('channels.bindings', {
    ok: true,
    bindings: opts.bindings ?? (opts.bound
      ? [{ pane_id: 'p1', platform: 'telegram', account: 'default', chat_id: '-100', thread_id: '7', title: 'api-refactor' }]
      : []),
  })
  mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: [] })
  mock.setResponse('channels.bind', { ok: true, binding: {} })
  mock.setResponse('channels.locations', {
    ok: true,
    locations: opts.locations ?? [{ chat_id: '-100', title: 'Navide', kind: 'supergroup', supports_topics: true }],
  })
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const qa = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[]

async function openPopover(w: VueWrapper): Promise<void> {
  await w.get('[data-testid="channel-connect"]').trigger('click')
  await flushPromises()
}

let lastStore: ReturnType<typeof useChannels> | null = null

async function render(): Promise<VueWrapper> {
  const store = useChannels(mock.backend)
  lastStore = store
  wrapper = mount(PaneChannelButton, {
    props: { paneId: 'p1', paneName: 'api-refactor', store },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  exec.mockReset()
  mock = createMockBackend('connected')
})
afterEach(() => {
  wrapper?.unmount()
  document.body.innerHTML = ''
})

describe('PaneChannelButton', () => {
  it('opens Settings → Channels when no platform is configured', async () => {
    seed({ configured: false })
    const w = await render()
    const btn = w.get('[data-testid="channel-connect"]')
    // An SVG icon button like its header neighbours, labelled by tooltip, not a text glyph.
    expect(btn.find('svg').exists()).toBe(true)
    expect(btn.text()).toBe('')
    expect(btn.attributes('title')).toBe('Connect to a Chat')
    await btn.trigger('click')
    expect(exec).toHaveBeenCalledWith('workbench.action.openSettingsChannels')
    expect(document.querySelector('[data-testid="channel-popover"]')).toBeNull()
  })

  it('lists the known chats on open, without picking a platform first', async () => {
    seed({
      configured: true,
      locations: [
        { chat_id: '-100', title: 'Navide', kind: 'supergroup', supports_topics: true },
        { chat_id: '42', title: 'Alice', kind: 'private', supports_topics: false },
      ],
    })
    const w = await render()
    await openPopover(w)
    expect(mock.sent.filter((s) => s.type === 'channels.locations').map((s) => s.payload)).toEqual([{ platform: 'telegram' }])
    const group = q('[data-testid="channel-group"]')!
    expect(group.textContent).toContain('Telegram')
    expect(group.textContent).toContain('@navide_bot')
    const rows = qa('[data-testid="channel-location"]')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Navide'),
      expect.stringContaining('Alice'),
    ])
    expect(rows[0].textContent).toContain('Group')
    expect(rows[1].textContent).toContain('DM')
    // Only the topic-capable group offers a new topic.
    expect(rows[0].querySelector('[data-testid="channel-bind-new"]')).not.toBeNull()
    expect(rows[1].querySelector('[data-testid="channel-bind-new"]')).toBeNull()
  })

  it('loads every connected platform and greys out the ones that are not', async () => {
    seed({
      configured: true,
      extra: [
        {
          platform: 'discord', configured: true, enabled: true,
          status: { lifecycle: 'ready', connected: true, identity: '' }, config: {},
          capabilities: { threads: true, create_location: false, edit: true, typing: true, buttons: true, text_limit: 2000 },
        },
        {
          platform: 'slack', configured: true, enabled: true,
          status: { lifecycle: 'blocked', connected: false, identity: '' }, config: {}, capabilities: null,
        },
        {
          platform: 'matrix', configured: true, enabled: false,
          status: { lifecycle: 'stopped', connected: false, identity: '' }, config: {}, capabilities: null,
        },
      ],
    })
    const w = await render()
    await openPopover(w)
    expect(mock.sent.filter((s) => s.type === 'channels.locations').map((s) => s.payload)).toEqual([
      { platform: 'telegram' },
      { platform: 'discord' },
    ])
    expect(qa('[data-testid="channel-group"]')).toHaveLength(4)
    const off = qa('[data-testid="channel-platform-off"]').map((r) => r.textContent)
    expect(off).toEqual(['Blocked — check the credentials', 'Off'])
    // Discord cannot create a location, so its topic-capable chat offers no new topic.
    expect(qa('[data-testid="channel-bind-new"]')).toHaveLength(1)
  })

  describe('linking guide when a connected platform knows no chat yet', () => {
    let openExternal: ReturnType<typeof vi.fn>
    beforeEach(() => {
      openExternal = vi.fn(async () => ({ ok: true }))
      ;(window as unknown as { agentTeam?: unknown }).agentTeam = { openExternal }
    })
    afterEach(() => {
      delete (window as unknown as { agentTeam?: unknown }).agentTeam
    })

    it('offers the Telegram deep links and opens the one clicked', async () => {
      seed({ configured: true, locations: [] })
      mock.setResponse('channels.link.create', {
        ok: true, code: 'K7Q2M9XA', target: 'direct', expires_at: Date.now() / 1000 + 600, url: 'https://t.me/navide_bot?start=K7Q2M9XA',
      })
      const w = await render()
      await openPopover(w)
      expect(q('[data-testid="channel-no-chats"]')?.textContent).toContain('Next: link your chat account')
      const actions = qa('[data-testid="channel-link-action"]')
      expect(actions.map((a) => a.textContent)).toEqual(['Open in Telegram (DM)', 'Add to a Group'])
      actions[0].click()
      await flushPromises()
      expect(mock.sent.find((m) => m.type === 'channels.link.create')?.payload).toEqual({ platform: 'telegram', target: 'direct' })
      expect(openExternal).toHaveBeenCalledWith('https://t.me/navide_bot?start=K7Q2M9XA')
      expect(q('[data-testid="channel-link-waiting"]')?.textContent).toContain('tap Start in Telegram')
      expect(q('[data-testid="channel-link-code"]')?.textContent).toBe('/start K7Q2M9XA')
      // The picker stays open while the user is in Telegram.
      expect(q('[data-testid="channel-popover"]')).not.toBeNull()
    })

    it('shows a code to send on a platform without a deep link', async () => {
      seed({ configured: false })
      mock.setResponse('channels.list', {
        ok: true,
        enabled: true,
        platforms: [{
          platform: 'mattermost', configured: true, enabled: true,
          status: { lifecycle: 'ready', connected: true, identity: '@navide' }, config: {}, capabilities: null,
        }],
      })
      mock.setResponse('channels.locations', { ok: true, locations: [] })
      mock.setResponse('channels.link.create', {
        ok: true, code: 'ABCD2345', target: 'direct', expires_at: Date.now() / 1000 + 600, url: null,
      })
      const w = await render()
      await openPopover(w)
      const actions = qa('[data-testid="channel-link-action"]')
      expect(actions.map((a) => a.textContent)).toEqual(['Get a Link Code'])
      actions[0].click()
      await flushPromises()
      expect(openExternal).not.toHaveBeenCalled()
      expect(q('[data-testid="channel-link-code"]')?.textContent).toBe('link ABCD2345')
      expect(q('[data-testid="channel-link-waiting"]')?.textContent).toContain('mention the bot in a group')
    })

    it('approves a pending pairing request inline', async () => {
      seed({ configured: true, locations: [] })
      mock.setResponse('channels.pairing.list', {
        ok: true,
        requests: [{ platform: 'telegram', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }],
      })
      mock.setResponse('channels.pairing.approve', { ok: true, sender_id: '42' })
      const w = await render()
      await openPopover(w)
      expect(q('[data-testid="channel-link-pairing"]')?.textContent).toContain('neil asks to pair')
      q('[data-testid="channel-link-approve"]')!.click()
      await flushPromises()
      expect(mock.sent.find((m) => m.type === 'channels.pairing.approve')?.payload).toEqual({ platform: 'telegram', code: 'K7Q2M9XA' })
    })

    async function startTelegramLink(overrides: Record<string, unknown> = {}): Promise<void> {
      seed({ configured: true, locations: [] })
      mock.setResponse('channels.link.create', {
        ok: true, code: 'K7Q2M9XA', target: 'direct', expires_at: Date.now() / 1000 + 600,
        url: 'https://t.me/navide_bot?start=K7Q2M9XA', ...overrides,
      })
      const w = await render()
      await openPopover(w)
      qa('[data-testid="channel-link-action"]')[0].click()
      await flushPromises()
      expect(q('[data-testid="channel-link-waiting"]')).not.toBeNull()
    }

    it('stops waiting and says so once the code expires', async () => {
      // Only setTimeout is faked: flushPromises schedules on setImmediate.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await startTelegramLink()
        vi.advanceTimersByTime(599_000)
        await flushPromises()
        expect(q('[data-testid="channel-link-waiting"]')).not.toBeNull()
        vi.advanceTimersByTime(2_000)
        await flushPromises()
        expect(q('[data-testid="channel-link-waiting"]')).toBeNull()
        expect(q('[data-testid="channel-link-guide"] [role="alert"]')?.textContent).toContain('This code has expired')
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops waiting when the backend connection drops, since the code may be gone', async () => {
      await startTelegramLink()
      mock.status.value = 'disconnected'
      await flushPromises()
      expect(q('[data-testid="channel-link-waiting"]')).toBeNull()
      expect(q('[data-testid="channel-link-guide"] [role="alert"]')?.textContent).toContain('may no longer work')
    })

    it('shows a failed link for its own code and ignores other codes', async () => {
      await startTelegramLink()
      mock.emit('channels.link_failed', { platform: 'telegram', code: 'OTHER234', error: 'x' })
      mock.emit('channels.linked', { platform: 'telegram', code: 'OTHER234', chat_id: '1', title: 'bob', kind: 'direct', confirmed: true })
      await flushPromises()
      expect(q('[data-testid="channel-link-waiting"]')).not.toBeNull()
      expect(q('[data-testid="channel-link-done"]')).toBeNull()
      mock.emit('channels.link_failed', { platform: 'telegram', code: 'K7Q2M9XA', error: 'database is locked' })
      await flushPromises()
      expect(q('[data-testid="channel-link-waiting"]')).toBeNull()
      expect(q('[data-testid="channel-link-guide"] [role="alert"]')?.textContent).toContain('Linking failed: database is locked')
    })

    it('says when the bot could not post its confirmation', async () => {
      await startTelegramLink()
      mock.emit('channels.linked', { platform: 'telegram', code: 'K7Q2M9XA', chat_id: '5', title: 'neil', kind: 'direct', confirmed: false })
      await flushPromises()
      expect(q('[data-testid="channel-link-done"]')?.textContent).toContain('could not post its confirmation')
    })

    it('reports a copy that failed', async () => {
      await startTelegramLink()
      const writeText = vi.fn(async () => { throw new Error('denied') })
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
      q('[data-testid="channel-link-copy"]')!.click()
      await flushPromises()
      expect(q('[data-testid="channel-link-guide"] [role="alert"]')?.textContent).toContain('Could not copy')
    })

    it('says so when a platform link was expected but none came back', async () => {
      await startTelegramLink({ url: null })
      expect(openExternal).not.toHaveBeenCalled()
      expect(q('[data-testid="channel-link-waiting"]')?.textContent).toContain('Could not open Telegram directly')
    })

    it('tells a Discord DM that the bot must share a server', async () => {
      seed({ configured: false })
      mock.setResponse('channels.list', {
        ok: true,
        enabled: true,
        platforms: [{
          platform: 'discord', configured: true, enabled: true,
          status: { lifecycle: 'ready', connected: true, identity: '@navide' }, config: {}, capabilities: null,
        }],
      })
      mock.setResponse('channels.locations', { ok: true, locations: [] })
      mock.setResponse('channels.link.create', { ok: true, code: 'ABCD2345', target: 'direct', expires_at: Date.now() / 1000 + 600, url: null })
      const w = await render()
      await openPopover(w)
      qa('[data-testid="channel-link-action"]')[1].click()
      await flushPromises()
      const waiting = q('[data-testid="channel-link-waiting"]')?.textContent ?? ''
      expect(waiting).toContain('share a server with')
      expect(waiting).not.toContain('Could not open')
    })

    it('replaces the guide with the chat once the link lands', async () => {
      seed({ configured: true, locations: [] })
      const w = await render()
      await openPopover(w)
      expect(q('[data-testid="channel-link-guide"]')).not.toBeNull()
      mock.setResponse('channels.locations', {
        ok: true,
        locations: [{ chat_id: '555', title: 'neil', kind: 'private', supports_topics: false }],
      })
      mock.emit('channels.linked', { platform: 'telegram', chat_id: '555', title: 'neil', kind: 'direct' })
      mock.emit('channels.changed', {})
      await flushPromises()
      expect(q('[data-testid="channel-link-guide"]')).toBeNull()
      expect(q('[data-testid="channel-bind-existing"]')?.textContent).toContain('neil')
    })
  })

  it('links to channel settings from the footer', async () => {
    seed({ configured: true })
    const w = await render()
    await openPopover(w)
    const link = q('[data-testid="channel-manage"]')!
    expect(link.textContent).toBe('Manage chat settings')
    link.click()
    await flushPromises()
    expect(exec).toHaveBeenCalledWith('workbench.action.openSettingsChannels')
    expect(q('[data-testid="channel-popover"]')).toBeNull()
  })

  const levelTestids = ['channel-bind-level-replies', 'channel-bind-level-minimal', 'channel-bind-level-standard', 'channel-bind-level-full']
  const checkedLevels = (): (string | null)[] => qa('[data-testid^="channel-bind-level-"]').map((e) => e.getAttribute('aria-checked'))
  const selectedLevels = (): boolean[] => qa('[data-testid^="channel-bind-level-"]').map((e) => e.classList.contains('pch-level-selected'))
  const bindsSent = () => mock.sent.filter((s) => s.type === 'channels.bind')

  it('lists only chats in step 1, and picking one opens step 2 without binding', async () => {
    seed({ configured: true })
    const w = await render()
    await openPopover(w)
    expect(q('[data-testid="channel-bind-levels"]')).toBeNull()
    expect(q('[data-testid="channel-bind-confirm"]')).toBeNull()
    q('[data-testid="channel-bind-existing"]')!.click()
    await flushPromises()
    expect(bindsSent()).toEqual([])
    expect(q('[data-testid="channel-bind-existing"]')).toBeNull()
    expect(q('[data-testid="channel-manage"]')).toBeNull()
    expect(q('[data-testid="channel-bind-chosen"]')?.textContent).toContain('Navide')
    expect(q('[data-testid="channel-bind-chosen"]')?.textContent).toContain('Telegram')
    expect(q('[data-testid="channel-bind-back"]')?.textContent).toContain('Back')
    expect(q('[data-testid="channel-bind-confirm"]')?.textContent).toBe('Connect')
    expect(q('[data-testid="channel-bind-cancel"]')?.textContent).toBe('Cancel')
    expect(q('[data-testid="channel-popover"] [data-testid="channel-redact-note"]')?.textContent).toContain('only masks this channel')
  })

  it('binds a new topic named after the pane on Connect', async () => {
    seed({ configured: true })
    const w = await render()
    await openPopover(w)
    const newBtn = q('[data-testid="channel-bind-new"]')!
    expect(newBtn.textContent).toBe('New Topic')
    expect(newBtn.getAttribute('title')).toContain('api-refactor')
    newBtn.click()
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.locations')?.payload).toEqual({ platform: 'telegram' })
    expect(bindsSent()).toEqual([])
    expect(q('[data-testid="channel-bind-chosen"]')?.textContent).toContain('New topic “api-refactor”')
    q('[data-testid="channel-bind-confirm"]')!.click()
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.bind')?.payload).toEqual({
      pane_id: 'p1', pane_name: 'api-refactor', platform: 'telegram', mode: 'new', chat_id: '-100', title: 'api-refactor',
      verbosity: 'replies',
    })
    expect(document.querySelector('[data-testid="channel-popover"]')).toBeNull()
  })

  it('binds an existing chat on Connect', async () => {
    seed({ configured: true })
    const w = await render()
    await openPopover(w)
    q('[data-testid="channel-bind-existing"]')!.click()
    await flushPromises()
    q('[data-testid="channel-bind-confirm"]')!.click()
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.bind')?.payload).toEqual({
      pane_id: 'p1', pane_name: 'api-refactor', platform: 'telegram', mode: 'existing', chat_id: '-100',
      verbosity: 'replies',
    })
    expect(q('[data-testid="channel-popover"]')).toBeNull()
  })

  describe('several bots on one platform', () => {
    const ready = { lifecycle: 'ready', connected: true, identity: '' }
    const caps = { threads: true, create_location: true, edit: true, typing: true, buttons: true, text_limit: 4000 }

    function seedTwoBots(bindings: Record<string, unknown>[] = []): void {
      seed({ configured: true, bindings })
      mock.setResponse('channels.list', {
        ok: true,
        enabled: true,
        platforms: [{
          platform: 'telegram', configured: true, enabled: true, status: ready, config: {}, capabilities: caps,
          accounts: [
            { account: 'default', name: '', configured: true, enabled: true, status: { ...ready, identity: '@main_bot' }, config: {}, capabilities: caps },
            { account: 'bot-b1', name: 'Ops', configured: true, enabled: true, status: { ...ready, identity: '@ops_bot' }, config: {}, capabilities: caps },
          ],
        }],
      })
    }

    it('groups the chats by bot and binds through the bot picked', async () => {
      seedTwoBots()
      const w = await render()
      await openPopover(w)
      const groups = qa('[data-testid="channel-group"]')
      expect(groups.map((g) => g.getAttribute('data-account'))).toEqual(['default', 'bot-b1'])
      expect(qa('[data-testid="channel-group-bot"]').map((e) => e.textContent)).toEqual(['Main bot', 'Ops'])
      expect(mock.sent.filter((s) => s.type === 'channels.locations').map((s) => s.payload)).toEqual([
        { platform: 'telegram' }, { platform: 'telegram', account: 'bot-b1' },
      ])
      groups[1].querySelector<HTMLElement>('[data-testid="channel-bind-existing"]')!.click()
      await flushPromises()
      expect(q('[data-testid="channel-bind-chosen"]')!.textContent).toContain('Telegram · Ops')
      q('[data-testid="channel-bind-confirm"]')!.click()
      await flushPromises()
      expect(mock.sent.find((s) => s.type === 'channels.bind')?.payload).toEqual({
        pane_id: 'p1', pane_name: 'api-refactor', platform: 'telegram', mode: 'existing', chat_id: '-100',
        verbosity: 'replies', account: 'bot-b1',
      })
    })

    it('a chat taken through one bot is still free through the other', async () => {
      seedTwoBots([{ pane_id: 'p2', platform: 'telegram', account: 'default', chat_id: '-100', thread_id: '', title: 'Navide' }])
      const messaging = useAgentMessaging()
      messaging.registerPane('p2', 'claude', 'other-pane')
      try {
        const w = await render()
        await openPopover(w)
        const [main, ops] = qa('[data-testid="channel-group"]')
        expect(main.querySelector('[data-testid="channel-bind-existing"]')!.hasAttribute('disabled')).toBe(true)
        expect(ops.querySelector('[data-testid="channel-bind-existing"]')!.hasAttribute('disabled')).toBe(false)
      } finally {
        messaging.unregisterPane('p2')
      }
    })

    it("shows a pairing request only under the bot it came to", async () => {
      seedTwoBots()
      mock.setResponse('channels.locations', { ok: true, locations: [] })
      mock.setResponse('channels.pairing.list', {
        ok: true,
        requests: [{ platform: 'telegram', account: 'bot-b1', code: 'K7Q2M9XA', sender_id: '42', sender_name: 'neil', created_at: 1 }],
      })
      const w = await render()
      await openPopover(w)
      const [main, ops] = qa('[data-testid="channel-group"]')
      expect(main.querySelector('[data-testid="channel-link-pairing"]')).toBeNull()
      expect(ops.querySelector('[data-testid="channel-link-pairing"]')?.textContent).toContain('neil asks to pair')
    })

    it('one bot: no bot label and no account in the request', async () => {
      seed({ configured: true })
      const w = await render()
      await openPopover(w)
      expect(q('[data-testid="channel-group-bot"]')).toBeNull()
      expect(mock.sent.find((s) => s.type === 'channels.locations')?.payload).toEqual({ platform: 'telegram' })
    })
  })

  it('preselects replies-only, marks exactly the selected level, and sends Full after clicking it', async () => {
    seed({ configured: true })
    const w = await render()
    await openPopover(w)
    q('[data-testid="channel-bind-existing"]')!.click()
    await flushPromises()
    const options = qa('[data-testid^="channel-bind-level-"]')
    expect(options.map((e) => e.getAttribute('data-testid'))).toEqual(levelTestids)
    expect(options.map((e) => e.getAttribute('role'))).toEqual(['radio', 'radio', 'radio', 'radio'])
    expect(checkedLevels()).toEqual(['true', 'false', 'false', 'false'])
    expect(selectedLevels()).toEqual([true, false, false, false])
    // Every option carries the radio dot; only the selected one is in the tab order.
    expect(options.every((e) => e.querySelector('.pch-level-dot'))).toBe(true)
    expect(options.map((e) => e.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1'])
    expect(document.activeElement?.getAttribute('data-testid')).toBe('channel-bind-level-replies')
    expect(q('[data-testid="channel-bind-level-full"]')?.textContent).toContain('what you type on this machine')
    q('[data-testid="channel-bind-level-full"]')!.click()
    await flushPromises()
    expect(checkedLevels()).toEqual(['false', 'false', 'false', 'true'])
    expect(selectedLevels()).toEqual([false, false, false, true])
    expect(bindsSent()).toEqual([])
    q('[data-testid="channel-bind-confirm"]')!.click()
    await flushPromises()
    expect(bindsSent().map((s) => s.payload)).toEqual([expect.objectContaining({ chat_id: '-100', verbosity: 'full' })])
  })

  it('Back returns to the chat list and Cancel closes, neither binding', async () => {
    seed({ configured: true })
    const w = await render()
    await openPopover(w)
    q('[data-testid="channel-bind-existing"]')!.click()
    await flushPromises()
    q('[data-testid="channel-bind-level-full"]')!.click()
    q('[data-testid="channel-bind-back"]')!.click()
    await flushPromises()
    expect(q('[data-testid="channel-bind-levels"]')).toBeNull()
    expect(document.activeElement?.getAttribute('data-testid')).toBe('channel-bind-existing')
    q('[data-testid="channel-bind-existing"]')!.click()
    await flushPromises()
    // A fresh pick starts from the chat's own level again, not the abandoned choice.
    expect(checkedLevels()).toEqual(['true', 'false', 'false', 'false'])
    q('[data-testid="channel-bind-cancel"]')!.click()
    await flushPromises()
    expect(q('[data-testid="channel-popover"]')).toBeNull()
    expect(bindsSent()).toEqual([])
  })

  it('keyboard: arrows move the level with focus, Esc goes back, Enter connects', async () => {
    seed({ configured: true })
    const w = await render()
    await openPopover(w)
    const key = (testid: string, k: string): void => {
      q(`[data-testid="${testid}"]`)!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    }
    q('[data-testid="channel-bind-existing"]')!.click()
    await flushPromises()
    key('channel-bind-level-replies', 'ArrowDown')
    await flushPromises()
    expect(checkedLevels()).toEqual(['false', 'true', 'false', 'false'])
    expect(document.activeElement?.getAttribute('data-testid')).toBe('channel-bind-level-minimal')
    key('channel-bind-level-minimal', 'ArrowUp')
    key('channel-bind-level-replies', 'ArrowUp')
    await flushPromises()
    expect(checkedLevels()).toEqual(['false', 'false', 'false', 'true'])
    expect(document.activeElement?.getAttribute('data-testid')).toBe('channel-bind-level-full')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(q('[data-testid="channel-popover"]')).not.toBeNull()
    expect(q('[data-testid="channel-bind-levels"]')).toBeNull()
    expect(bindsSent()).toEqual([])
    q('[data-testid="channel-bind-existing"]')!.click()
    await flushPromises()
    key('channel-bind-level-replies', 'ArrowDown')
    key('channel-bind-level-minimal', 'Enter')
    await flushPromises()
    expect(bindsSent().map((s) => s.payload)).toEqual([expect.objectContaining({ verbosity: 'minimal' })])
  })

  it("preselects a chat's own previous level and never borrows another chat's", async () => {
    seed({
      configured: true,
      locations: [
        { chat_id: 'A', title: 'Chat A', kind: 'supergroup', supports_topics: false },
        { chat_id: 'B', title: 'Chat B', kind: 'supergroup', supports_topics: false },
      ],
      // Chat B serves another pane at Full; this pane last used Chat A at Standard.
      bindings: [
        { pane_id: 'p2', platform: 'telegram', account: 'default', chat_id: 'B', thread_id: '', title: 'Chat B', verbosity: 'full' },
      ],
    })
    const w = await render()
    await openPopover(w)
    lastStore!.bindings.value = [
      ...lastStore!.bindings.value,
      { pane_id: 'p1', platform: 'telegram', account: 'default', chat_id: 'A', thread_id: '', title: 'Chat A', verbosity: 'standard' },
    ]
    await flushPromises()
    q('[data-chat-id="A"]')!.click()
    await flushPromises()
    expect(checkedLevels()).toEqual(['false', 'false', 'true', 'false'])
    q('[data-testid="channel-bind-back"]')!.click()
    await flushPromises()
    lastStore!.bindings.value = lastStore!.bindings.value.filter((b) => b.pane_id !== 'p1')
    await flushPromises()
    q('[data-chat-id="A"]')!.click()
    await flushPromises()
    // No binding of its own: replies-only, not Chat B's Full.
    expect(checkedLevels()).toEqual(['true', 'false', 'false', 'false'])
  })

  it('keeps each binding on its own level', async () => {
    seed({
      configured: true,
      bindings: [
        { pane_id: 'p1', platform: 'telegram', account: 'default', chat_id: 'A', thread_id: '', title: 'Chat A', verbosity: 'minimal' },
        { pane_id: 'p2', platform: 'telegram', account: 'default', chat_id: 'B', thread_id: '', title: 'Chat B', verbosity: 'full' },
      ],
    })
    mock.setResponse('channels.set_binding_options', { ok: true, binding: {} })
    const store = useChannels(mock.backend)
    const a = mount(PaneChannelButton, { props: { paneId: 'p1', paneName: 'a', store }, global: { plugins: [i18n] }, attachTo: document.body })
    const b = mount(PaneChannelButton, { props: { paneId: 'p2', paneName: 'b', store }, global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    expect(a.get('[data-testid="channel-chip-level"]').text()).toBe('Minimal')
    expect(b.get('[data-testid="channel-chip-level"]').text()).toBe('Full')
    await a.get('[data-testid="channel-chip-menu"]').trigger('click')
    await flushPromises()
    expect(qa('[data-testid^="channel-verbosity-"]').map((e) => e.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
    q('[data-testid="channel-verbosity-standard"]')!.click()
    await flushPromises()
    expect(mock.sent.filter((m) => m.type === 'channels.set_binding_options').map((m) => m.payload)).toEqual([
      { pane_id: 'p1', verbosity: 'standard' },
    ])
    await b.get('[data-testid="channel-chip-menu"]').trigger('click')
    await flushPromises()
    const bMenu = qa('[data-testid="channel-menu"]').at(-1)!
    expect(Array.from(bMenu.querySelectorAll('[role="menuitemradio"]')).map((e) => e.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false', 'true'])
    a.unmount()
    b.unmount()
  })

  describe('Guard warning for a CLI Guard cannot block', () => {
    async function renderFor(agentKey: string, support: Record<string, string>): Promise<VueWrapper> {
      mock.setResponse('guard.status', { enabled: true, counts: {}, hook_support: support })
      mock.setResponse('guard.taint.list', { panes: [] })
      const store = useChannels(mock.backend)
      const guardStore = useGuard(mock.backend)
      wrapper = mount(PaneChannelButton, {
        props: { paneId: 'p1', paneName: 'api-refactor', agentKey, store, guardStore },
        global: { plugins: [i18n] },
        attachTo: document.body,
      })
      await flushPromises()
      await wrapper.get('[data-testid="channel-connect"]').trigger('click')
      return wrapper
    }
    const warning = () => document.querySelector('[data-testid="channel-guard-warning"]')

    beforeEach(() => {
      __resetSettingsForTest()
      seed({ configured: true })
    })

    it('warns when the vendor has no hook and runs in YOLO', async () => {
      settingsSet('agentTeam.yolo', '1')
      await renderFor('cursor', { cursor: 'none', claude: 'block' })
      expect(warning()?.textContent).toContain('cannot block this CLI')
    })

    it('stays quiet for a vendor Guard can block', async () => {
      settingsSet('agentTeam.yolo', '1')
      await renderFor('claude', { cursor: 'none', claude: 'block' })
      expect(warning()).toBeNull()
    })

    it('stays quiet when YOLO is off', async () => {
      settingsSet('agentTeam.yolo', '0')
      await renderFor('cursor', { cursor: 'none' })
      expect(warning()).toBeNull()
    })
  })

  describe('chip label', () => {
    // The pane's name is already on the pane header; the chip names where it talks to.
    const label = (w: VueWrapper) => w.get('[data-testid="channel-chip-label"]').text()

    it('names the bot, never the chat user or the pane; the tooltip keeps the chat', async () => {
      seed({ configured: true, bound: true, locations: [{ chat_id: '-100', title: 'neillu123', kind: 'private', supports_topics: false }] })
      const w = await render()
      expect(label(w)).toBe('Telegram · @navide_bot')
      const tip = w.get('[data-testid="channel-chip"]').attributes('title')
      expect(tip).toBe('Telegram · @navide_bot · neillu123 · Chat replies only')
      expect(tip).not.toContain('api-refactor')
    })

    it("prefers the bot's display name from the platform over its handle", async () => {
      seed({ configured: true, bound: true, status: { display_name: 'Neil M4' } })
      const w = await render()
      expect(label(w)).toBe('Telegram · Neil M4')
      expect(w.get('[data-testid="channel-chip"]').attributes('title')).toBe('Telegram · Neil M4 · Navide · Chat replies only')
    })

    it('falls back to the chat while the bot has no name', async () => {
      seed({ configured: true, bound: true, status: { identity: '' } })
      const w = await render()
      expect(label(w)).toBe('Telegram · Navide')
    })

    it('shows the platform alone when neither chat nor bot has a name', async () => {
      seed({
        configured: true,
        bindings: [{ pane_id: 'p1', platform: 'discord', account: 'default', chat_id: '9', thread_id: '', title: 'api-refactor' }],
        extra: [{
          platform: 'discord', configured: true, enabled: true,
          status: { lifecycle: 'ready', connected: true, identity: '' }, config: {},
          capabilities: { threads: true, create_location: false, edit: true, typing: true, buttons: true, text_limit: 2000 },
        }],
        locations: [],
      })
      const w = await render()
      expect(label(w)).toBe('Discord')
      expect(w.get('[data-testid="channel-chip"]').text()).not.toContain('api-refactor')
    })
  })

  it('shows a chip for a bound pane and unbinds from it', async () => {
    seed({ configured: true, bound: true })
    const w = await render()
    expect(w.find('[data-testid="channel-connect"]').exists()).toBe(false)
    expect(w.get('[data-testid="channel-chip"]').text()).toContain('Telegram · @navide_bot')
    await w.get('[data-testid="channel-unbind"]').trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.unbind')?.payload).toEqual({ pane_id: 'p1', pane_name: 'api-refactor' })
  })

  it('shows a chat held by another pane as taken, and offers it again once released', async () => {
    seed({
      configured: true,
      locations: [{ chat_id: '555', title: 'neillu123', kind: 'direct', supports_topics: false }],
      bindings: [{ pane_id: 'p2', platform: 'telegram', account: 'default', chat_id: '555', thread_id: '', title: 'other-pane' }],
    })
    const messaging = useAgentMessaging()
    messaging.registerPane('p2', 'claude', 'other-pane')
    try {
      const w = await render()
      await openPopover(w)
      const row = q('[data-testid="channel-bind-existing"]') as HTMLButtonElement
      expect(row.disabled).toBe(true)
      expect(q('[data-testid="channel-taken"]')?.textContent).toContain('other-pane')
      lastStore!.bindings.value = []
      await flushPromises()
      expect((q('[data-testid="channel-bind-existing"]') as HTMLButtonElement).disabled).toBe(false)
      expect(q('[data-testid="channel-taken"]')).toBeNull()
    } finally {
      messaging.unregisterPane('p2')
    }
  })

  describe('a holder this window does not know', () => {
    const dm = { chat_id: '555', title: 'neillu123', kind: 'direct', supports_topics: false }

    function seedHeldBy(paneId: string, title: string): void {
      seed({
        configured: true,
        locations: [dm],
        bindings: [{ pane_id: paneId, platform: 'telegram', account: 'default', chat_id: '555', thread_id: '', title }],
      })
    }

    function overviewWith(paneId: string, pane: { exists: boolean; name: string }): void {
      mock.setResponse('channels.overview', {
        ok: true,
        bots: [{
          platform: 'telegram', account: 'default', orphans: pane.exists ? [] : [paneId],
          chats: [{
            ...dm,
            bindings: [{
              pane_id: paneId, platform: 'telegram', account: 'default', chat_id: '555', thread_id: '', title: 'stale-title',
              created_at: 1, pane: { ...pane, qualified_name: '', workspace_path: '', display_status: '', agent_key: '' },
            }],
          }],
        }],
      })
    }

    const overviewsSent = () => mock.sent.filter((s) => s.type === 'channels.overview')

    it('names a live pane in another window and disables the row', async () => {
      seedHeldBy('far', 'stale-title')
      overviewWith('far', { exists: true, name: 'billing-check' })
      const w = await render()
      await openPopover(w)
      expect(overviewsSent()).toHaveLength(1)
      expect((q('[data-testid="channel-bind-existing"]') as HTMLButtonElement).disabled).toBe(true)
      expect(q('[data-testid="channel-taken"]')?.textContent).toBe('Connected to billing-check')
    })

    it('offers a chat whose holder closed without its unbind landing, leaving the verdict to the backend', async () => {
      // A disabled row would lock the chat for good.
      seedHeldBy('ghost', 'closed-pane')
      overviewWith('ghost', { exists: false, name: 'closed-pane' })
      const w = await render()
      await openPopover(w)
      expect(overviewsSent()).toHaveLength(1)
      expect((q('[data-testid="channel-bind-existing"]') as HTMLButtonElement).disabled).toBe(false)
      expect(q('[data-testid="channel-taken"]')).toBeNull()
      expect(q('[data-testid="channel-bind-existing"]')?.textContent).toContain('DM')
    })

    it('never asks for the overview when this window knows every holder', async () => {
      seedHeldBy('p2', 'other-pane')
      const messaging = useAgentMessaging()
      messaging.registerPane('p2', 'claude', 'other-pane')
      try {
        const w = await render()
        await openPopover(w)
        expect(q('[data-testid="channel-taken"]')?.textContent).toBe('Connected to other-pane')
        expect(overviewsSent()).toEqual([])
      } finally {
        messaging.unregisterPane('p2')
      }
    })

    it('keeps the row free while the overview is pending or failed', async () => {
      seedHeldBy('far', 'stale-title')
      let answer: (v: unknown) => void = () => {}
      const send = mock.backend.send
      mock.backend.send = ((type: string, payload?: Record<string, unknown>) => {
        if (type !== 'channels.overview') return send(type, payload)
        mock.sent.push({ type, payload: payload ?? {} })
        return new Promise((resolve) => { answer = resolve as (v: unknown) => void })
      }) as typeof mock.backend.send
      const w = await render()
      await openPopover(w)
      expect(overviewsSent()).toHaveLength(1)
      const row = () => q('[data-testid="channel-bind-existing"]') as HTMLButtonElement
      expect(row().disabled).toBe(false)
      expect(row().textContent).toContain('DM')
      answer({ ok: false, payload: null, error: { message: 'boom' } })
      await flushPromises()
      expect(lastStore!.overviewError.value).not.toBe('')
      expect(row().disabled).toBe(false)
      expect(row().textContent).toContain('DM')
      expect(q('[data-testid="channel-taken"]')).toBeNull()
    })
  })

  it('reloads an open picker when a new chat shows up', async () => {
    seed({ configured: true, locations: [] })
    const w = await render()
    await openPopover(w)
    expect(q('[data-testid="channel-no-chats"]')).not.toBeNull()
    mock.setResponse('channels.locations', {
      ok: true,
      locations: [{ chat_id: '555', title: 'neillu123', kind: 'private', supports_topics: false }],
    })
    await lastStore!.refresh()
    await flushPromises()
    expect(q('[data-testid="channel-no-chats"]')).toBeNull()
    expect(q('[data-testid="channel-bind-existing"]')?.textContent).toContain('neillu123')
  })
  it('shows the mirror verbosity menu (default replies) and sends the pick', async () => {
    seed({ configured: true, bound: true })
    mock.setResponse('channels.set_binding_options', { ok: true, binding: {} })
    const w = await render()
    await w.get('[data-testid="channel-chip-menu"]').trigger('click')
    await flushPromises()
    expect(q('[data-testid="channel-verbosity-replies"]')?.getAttribute('aria-checked')).toBe('true')
    q('[data-testid="channel-verbosity-minimal"]')!.click()
    await flushPromises()
    expect(mock.sent.find((m) => m.type === 'channels.set_binding_options')?.payload).toEqual({
      pane_id: 'p1',
      verbosity: 'minimal',
    })
  })

  it('offers the replies-only level and says redaction covers channel credentials only', async () => {
    seed({
      configured: true,
      bindings: [{ pane_id: 'p1', platform: 'telegram', account: 'default', chat_id: '-100', thread_id: '7', title: 'api-refactor', verbosity: 'replies' }],
    })
    mock.setResponse('channels.set_binding_options', { ok: true, binding: {} })
    const w = await render()
    await w.get('[data-testid="channel-chip-menu"]').trigger('click')
    await flushPromises()
    expect(qa('[role="menuitemradio"]').map((e) => e.getAttribute('data-testid'))).toEqual([
      'channel-verbosity-replies',
      'channel-verbosity-minimal',
      'channel-verbosity-standard',
      'channel-verbosity-full',
    ])
    expect(q('[data-testid="channel-verbosity-replies"]')?.getAttribute('aria-checked')).toBe('true')
    expect(q('[data-testid="channel-verbosity-replies"]')?.textContent).toContain('Chat replies only')
    expect(q('[data-testid="channel-redact-note"]')?.textContent).toContain('only masks this channel')
    q('[data-testid="channel-verbosity-full"]')!.click()
    await flushPromises()
    expect(mock.sent.find((m) => m.type === 'channels.set_binding_options')?.payload).toEqual({
      pane_id: 'p1',
      verbosity: 'full',
    })
  })

  it('reflects the binding verbosity and lists auto-bound child topics', async () => {
    seed({
      configured: true,
      bindings: [
        { pane_id: 'p1', platform: 'telegram', account: 'default', chat_id: '-100', thread_id: '7', title: 'api-refactor', verbosity: 'standard' },
        { pane_id: 'c1', platform: 'telegram', account: 'default', chat_id: '-100', thread_id: '9', title: '↳ worker', verbosity: 'full', parent_pane_id: 'p1' },
      ],
    })
    const w = await render()
    await w.get('[data-testid="channel-chip-menu"]').trigger('click')
    await flushPromises()
    expect(q('[data-testid="channel-verbosity-standard"]')?.getAttribute('aria-checked')).toBe('true')
    const levels = qa('[data-testid^="channel-verbosity-"]')
    expect(levels.map((e) => e.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false'])
    expect(levels.map((e) => e.classList.contains('pch-level-selected'))).toEqual([false, false, true, false])
    expect(levels.every((e) => e.querySelector('.pch-level-dot'))).toBe(true)
    expect(qa('[data-testid="channel-child"]').map((e) => e.textContent)).toEqual(['↳ ↳ worker'])
  })
})
