// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useChannels } from '../../composables/useChannels'
import ChannelMonitorModal from '../ChannelMonitorModal.vue'

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

function seed(
  bindings: Record<string, unknown>[],
  lifecycle = 'ready',
  chats: Record<string, unknown>[] = [],
  status: Record<string, unknown> = {},
): void {
  mock.setResponse('channels.list', {
    ok: true,
    enabled: true,
    platforms: [{
      platform: 'telegram',
      configured: true,
      enabled: true,
      status: { lifecycle, connected: lifecycle === 'ready', identity: '@navide_bot', ...status },
      config: {},
      capabilities: null,
    }],
  })
  mock.setResponse('channels.bindings', { ok: true, bindings })
  mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: [] })
  mock.setResponse('channels.unbind', { ok: true })
  mock.setResponse('channels.overview', { ok: true, bots: [{ platform: 'telegram', account: 'default', chats, orphans: [] }] })
}

/** An overview chat holding `bindings`, each with the pane the backend's registry reports. */
function chat(title: string, bindings: Record<string, unknown>[]): Record<string, unknown> {
  return { chat_id: '-100', title, kind: 'supergroup', supports_topics: true, bindings }
}

function pane(name: string, exists = true): Record<string, unknown> {
  return { exists, name, qualified_name: name, workspace_path: '/w', display_status: '', agent_key: 'claude' }
}

const binding = { pane_id: 'p1', platform: 'telegram', account: 'default', chat_id: '-100', thread_id: '7', title: 'api-refactor' }

async function render(open = true) {
  const store = useChannels(mock.backend)
  await store.refresh()
  wrapper = mount(ChannelMonitorModal, {
    props: { open, store, paneLabel: (id: string) => (id === 'p1' ? 'Claude 1' : id) },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return store
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null

describe('ChannelMonitorModal', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    mock = createMockBackend('connected')
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.innerHTML = ''
  })

  it('renders nothing while closed', async () => {
    seed([binding])
    await render(false)
    expect(q('[data-testid="channel-monitor"]')).toBeNull()
  })

  it('lists each link with pane, channel and status', async () => {
    seed([binding])
    await render()
    const rows = document.querySelectorAll('[data-testid="channel-monitor-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Claude 1')
    expect(rows[0].textContent).toContain('Telegram · @navide_bot')
    expect(rows[0].textContent).toContain(i18n.global.t('channels.lifecycle.ready'))
  })

  it('draws its own header mark instead of the Cloud one', async () => {
    seed([binding])
    await render()
    expect(q('.cmon-mark svg')).not.toBeNull()
    expect(q('.nv-cloud-mark')).toBeNull()
  })

  it('marks a blocked platform row with the error tone', async () => {
    seed([binding], 'blocked')
    await render()
    expect(q('.cmon-dot')!.classList.contains('err')).toBe(true)
  })

  it('shows the empty state without bindings', async () => {
    seed([])
    await render()
    expect(q('[data-testid="channel-monitor-empty"]')).not.toBeNull()
  })

  it('updates when the backend pushes a status change', async () => {
    seed([binding])
    await render()
    mock.emit('channels.status', { platform: 'telegram', status: { lifecycle: 'blocked', connected: false } })
    await flushPromises()
    expect(q('[data-testid="channel-monitor-row"]')!.textContent).toContain(i18n.global.t('channels.lifecycle.blocked'))
  })

  it('emits focus-pane when a row is clicked', async () => {
    seed([binding])
    await render()
    q('[data-testid="channel-monitor-go"]')!.click()
    expect(wrapper!.emitted('focus-pane')![0]).toEqual(['p1'])
  })

  it('unbinds the pane without a confirmation step', async () => {
    seed([binding])
    await render()
    q('[data-testid="channel-monitor-unlink"]')!.click()
    await flushPromises()
    const sent = mock.sent.filter((s) => s.type === 'channels.unbind')
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ pane_id: 'p1', pane_name: 'Claude 1' })
  })

  it('names the bot, the chat and the topic on the channel line', async () => {
    seed([binding], 'ready', [chat('Team room', [{ ...binding, created_at: 1, pane: pane('Claude 1') }])])
    await render()
    expect(q('.cmon-channel')!.textContent).toBe('Telegram · @navide_bot · Team room · api-refactor')
  })

  it("names the bot by the platform's display name, as every channel label does", async () => {
    seed([binding], 'ready', [chat('Team room', [{ ...binding, created_at: 1, pane: pane('Claude 1') }])], { display_name: 'Navide Bot' })
    await render()
    expect(q('.cmon-channel')!.textContent).toBe('Telegram · Navide Bot · Team room · api-refactor')
  })

  it('leaves the bind-time pane name off a binding without a topic', async () => {
    const direct = { ...binding, thread_id: '', title: 'Claude 1' }
    seed([direct], 'ready', [chat('Neil', [{ ...direct, created_at: 1, pane: pane('Claude 1') }])])
    await render()
    expect(q('.cmon-channel')!.textContent).toBe('Telegram · @navide_bot · Neil')
  })

  it('falls back to the chat id when the chat has no title of its own', async () => {
    seed([binding], 'ready', [chat('-100', [{ ...binding, created_at: 1, pane: pane('Claude 1') }])])
    await render()
    expect(q('.cmon-channel')!.textContent).toBe('Telegram · @navide_bot · ' + i18n.global.t('channels.monitor.chat-id', { id: '-100' }) + ' · api-refactor')
  })

  it('names a pane from another window by the backend registry, never by its id', async () => {
    const other = { ...binding, pane_id: '7aa28068-5d9b-4f00-9a00-000000000001' }
    seed([other], 'ready', [chat('Team room', [{ ...other, created_at: 1, pane: pane('IDA指揮') }])])
    await render()
    const row = q('[data-testid="channel-monitor-row"]')!
    expect(q('.cmon-pane')!.textContent).toBe('IDA指揮')
    expect(row.textContent).not.toContain(other.pane_id)
  })

  it('marks a closed pane and names it by the title it was bound under', async () => {
    const orphan = { ...binding, pane_id: 'b797dda4-5869-4f00-9a00-000000000002' }
    seed([orphan], 'ready', [chat('Team room', [{ ...orphan, created_at: 1, pane: pane('api-refactor', false) }])])
    await render()
    const row = q('[data-testid="channel-monitor-row"]')!
    expect(q('.cmon-pane')!.textContent).toContain('api-refactor')
    expect(row.textContent).toContain(i18n.global.t('channels.monitor.pane-closed'))
    expect(row.textContent).not.toContain(orphan.pane_id)
  })

  it('never shows a pane id, even with no name anywhere', async () => {
    const bare = { ...binding, pane_id: 'b797dda4-5869-4f00-9a00-000000000003', thread_id: '', title: '' }
    seed([bare])
    await render()
    const row = q('[data-testid="channel-monitor-row"]')!
    expect(q('.cmon-pane')!.textContent).toBe(i18n.global.t('channels.monitor.unnamed-pane'))
    expect(row.textContent).not.toContain(bare.pane_id)
  })

  it('files auto child topics under their root pane, without a disconnect of their own', async () => {
    const child = { ...binding, pane_id: 'c1', thread_id: '8', title: '↳ worker', parent_pane_id: 'p1', auto: true }
    const grandchild = { ...binding, pane_id: 'g1', thread_id: '9', title: '↳ helper', parent_pane_id: 'c1', auto: true }
    seed([binding, child, grandchild])
    await render()
    expect(document.querySelectorAll('[data-testid="channel-monitor-row"]')).toHaveLength(1)
    const children = document.querySelectorAll('[data-testid="channel-monitor-child"]')
    expect(children).toHaveLength(2)
    expect(children[0].textContent).toContain(i18n.global.t('channels.monitor.auto-child'))
    expect(children[1].textContent).toContain('↳ helper')
    expect(children[1].textContent).not.toContain('g1')
    expect(document.querySelectorAll('[data-testid="channel-monitor-unlink"]')).toHaveLength(1)
    ;(children[0].querySelector('[data-testid="channel-monitor-go"]') as HTMLElement).click()
    expect(wrapper!.emitted('focus-pane')![0]).toEqual(['c1'])
  })

  it('keeps an auto topic whose parent is no longer bound as its own row', async () => {
    seed([{ ...binding, pane_id: 'c1', parent_pane_id: 'gone', auto: true }])
    await render()
    expect(document.querySelectorAll('[data-testid="channel-monitor-row"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-testid="channel-monitor-child"]')).toHaveLength(0)
  })

  it('emits close from the X button and the backdrop', async () => {
    seed([binding])
    await render()
    q('[data-testid="channel-monitor-close"]')!.click()
    q('[data-testid="channel-monitor"]')!.click()
    expect(wrapper!.emitted('close')).toHaveLength(2)
  })
})
