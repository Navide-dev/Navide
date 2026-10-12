// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ConvenienceOverview from '../ConvenienceOverview.vue'
import CliExtensionsPane from '../CliExtensionsPane.vue'
import { __resetConvenienceForTest, openConvenienceOverview } from '../../composables/useConvenience'
import { __resetConvenienceAnnouncementsForTest } from '../../composables/useAnnouncements'

const features = [
  {
    id: 'claude.hooks', cli: 'claude', toggleable: true, state: 'allowed', reason: 'default',
    targets: [
      { path: '/Users/me/.claude/settings.json', writtenAt: 1_900_000_000, present: true },
      { path: '/Users/me/.claude/old.json', writtenAt: 1_900_000_000, present: false },
    ],
  },
  { id: 'cursor.project-mcp', cli: 'cursor', toggleable: true, state: 'off', reason: 'removed', targets: [] },
  { id: 'codex.pane-homes', cli: 'codex', toggleable: false, state: 'allowed', reason: 'default', targets: [] },
]

let wrapper: VueWrapper
let replies: Record<string, unknown>
const send = vi.fn()

function render(): VueWrapper {
  wrapper = mount(ConvenienceOverview, { props: { backend: { send } }, global: { plugins: [i18n] } })
  return wrapper
}

function card(id: string) {
  return wrapper.get(`[data-feature="${id}"]`)
}

beforeEach(() => {
  i18n.global.locale.value = 'zh-TW'
  __resetConvenienceForTest()
  __resetConvenienceAnnouncementsForTest()
  replies = {
    'convenience.list': { features, notices: [], upgrade: null },
    'convenience.history': {
      entries: [{ id: 3, at: 1_900_000_000, feature: 'claude.hooks', action: 'first', target: '/Users/me/.claude/settings.json', detail: '', backup: '/data/b.bak', notify: true }],
    },
    'convenience.set': { feature: { ...features[0], state: 'off', reason: 'user' } },
  }
  send.mockReset().mockImplementation(async (type: string) => ({ ok: true, payload: replies[type], error: null }))
})
afterEach(() => wrapper?.unmount())

describe('ConvenienceOverview', () => {
  it('shows one card per feature with its name, benefit, targets and cost', async () => {
    render()
    await flushPromises()
    expect(wrapper.get('.conv-title').text()).toBe('便利功能與 Navide 對你電腦的修改')
    expect(wrapper.findAll('.conv-card').length).toBe(3)
    const hooks = card('claude.hooks')
    expect(hooks.get('.conv-name').text()).toBe('Claude hook：回合偵測、Navide Guard 與喚醒')
    expect(hooks.get('.conv-benefit').text()).toContain('Navide Guard 會檢查 Claude 的工具呼叫')
    expect(hooks.findAll('.conv-target').map((t) => t.get('.conv-presence').text())).toEqual(['存在', '已不存在'])
    expect(hooks.text()).toContain('推播頻道無法喚醒閒置的 Claude')
    expect(hooks.get('.conv-switch').text()).toBe('已允許')
  })

  it('shows required features without a switch', async () => {
    render()
    await flushPromises()
    const homes = card('codex.pane-homes')
    expect(homes.find('.conv-switch').exists()).toBe(false)
    expect(homes.get('.conv-required').text()).toBe('必要')
  })

  it('says why a feature is off after a removal', async () => {
    render()
    await flushPromises()
    expect(card('cursor.project-mcp').get('.conv-reason').text()).toContain('你手動移除了 Navide 寫入的內容')
  })

  it('confirms before turning off, naming only what is still present', async () => {
    render()
    await flushPromises()
    await card('claude.hooks').get('.conv-switch').trigger('click')
    expect(send).not.toHaveBeenCalledWith('convenience.set', expect.anything(), expect.anything())
    const confirm = card('claude.hooks').get('.conv-confirm')
    expect(confirm.text()).toContain('關閉「Claude hook：回合偵測、Navide Guard 與喚醒」？')
    expect(confirm.findAll('li').map((li) => li.text())).toEqual(['/Users/me/.claude/settings.json'])

    replies['convenience.list'] = { features: [{ ...features[0], state: 'off', reason: 'user' }, ...features.slice(1)], notices: [], upgrade: null }
    await confirm.get('[data-act="confirm-off"]').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('convenience.set', { id: 'claude.hooks', allowed: false }, expect.any(Number))
    expect(card('claude.hooks').get('.conv-switch').text()).toBe('已關閉')
  })

  it('cancel leaves the feature alone', async () => {
    render()
    await flushPromises()
    await card('claude.hooks').get('.conv-switch').trigger('click')
    await card('claude.hooks').get('[data-act="cancel-off"]').trigger('click')
    expect(card('claude.hooks').find('.conv-confirm').exists()).toBe(false)
    expect(send.mock.calls.map((c) => c[0])).not.toContain('convenience.set')
  })

  it('allows an off feature without asking', async () => {
    replies['convenience.set'] = { feature: { ...features[1], state: 'allowed', reason: 'user' } }
    render()
    await flushPromises()
    await card('cursor.project-mcp').get('.conv-switch').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('convenience.set', { id: 'cursor.project-mcp', allowed: true }, expect.any(Number))
  })

  it('shows a refused change', async () => {
    send.mockImplementation(async (type: string) =>
      type === 'convenience.set'
        ? { ok: false, payload: null, error: { code: 'UNKNOWN_FEATURE', message: 'no such feature' } }
        : { ok: true, payload: replies[type], error: null })
    render()
    await flushPromises()
    await card('cursor.project-mcp').get('.conv-switch').trigger('click')
    await flushPromises()
    expect(card('cursor.project-mcp').get('[role="alert"]').text()).toBe('無法變更：no such feature')
  })

  it('loads a feature history when it is expanded', async () => {
    render()
    await flushPromises()
    const details = card('claude.hooks').get('details')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('convenience.history', { feature: 'claude.hooks', limit: 50 }, expect.any(Number))
    const row = card('claude.hooks').get('.conv-log-row')
    expect(row.get('.conv-log-action').text()).toBe('首次寫入')
    expect(row.text()).toContain('備份：/data/b.bak')
  })
})

describe('CliExtensionsPane tabs', () => {
  it('opens on the installed tab and switches to the overview on request', async () => {
    send.mockImplementation(async (type: string) =>
      ({ ok: true, payload: type === 'cli_extensions.list' ? { vendors: [], items: [] } : replies[type], error: null }))
    wrapper = mount(CliExtensionsPane, { props: { backend: { send } }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('.conv').exists()).toBe(false)
    openConvenienceOverview()
    await flushPromises()
    expect(wrapper.find('.conv').exists()).toBe(true)
    expect(wrapper.get('[data-tab="convenience"]').attributes('aria-selected')).toBe('true')
  })

  it('mounts straight on the overview when a request is waiting', async () => {
    openConvenienceOverview()
    wrapper = mount(CliExtensionsPane, { props: { backend: { send } }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('.conv').exists()).toBe(true)
  })

  it('links a navide-change row to its feature card on the overview', async () => {
    const row = {
      cli: 'codex', id: 'nc-1', name: 'codex.hook-trust', version: '', kind: 'navide-change', type_label: 'Navide change',
      scope: 'user', enabled: true, exec_tier: 'L1', capabilities: [], native_consent: 'none', owner: 'navide',
      evidence: 'recorded', path: '/Users/me/.codex/config.toml', components: [], detail: '', valid: true, error: '',
    }
    replies['convenience.list'] = { features: [{ id: 'codex.hook-trust', cli: 'codex', toggleable: true, state: 'allowed', reason: 'default', targets: [] }], notices: [], upgrade: null }
    send.mockImplementation(async (type: string) =>
      ({ ok: true, payload: type === 'cli_extensions.list' ? { vendors: [{ cli: 'codex', label: 'Codex', supported: true, note: '', count: 1 }], items: [row] } : replies[type], error: null }))
    wrapper = mount(CliExtensionsPane, { props: { backend: { send } }, global: { plugins: [i18n] } })
    await flushPromises()
    const link = wrapper.get('.cli-ext-feature-link')
    expect(link.text()).toBe('Codex hook 信任沿用')
    await link.trigger('click')
    await flushPromises()
    expect(wrapper.get('.conv-card.focused').attributes('data-feature')).toBe('codex.hook-trust')
  })
})
