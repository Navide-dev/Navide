// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { i18n } from '@navide/plugin-ui/foundation'
import CliExtensionsPane from '../CliExtensionsPane.vue'

const item = (over: Record<string, unknown>) => ({
  cli: 'claude', id: 'x', name: 'x', version: '', kind: 'plugin', type_label: 'Claude plugin', scope: 'user',
  enabled: true, exec_tier: 'L1', capabilities: [], native_consent: 'none', owner: 'user', evidence: 'verified',
  path: '/home/u/.claude/plugins/x', components: [], detail: '', valid: true, error: '', ...over,
})

const payload = {
  vendors: [
    { cli: 'claude', label: 'Claude Code (Anthropic)', supported: true, note: '', count: 3 },
    { cli: 'antigravity', label: 'Antigravity CLI (Google)', supported: false, note: 'n', count: 0 },
    { cli: 'kilo', label: 'Kilo Code CLI', supported: true, note: '', count: 0 },
  ],
  items: [
    item({ id: 'helper@mkt', name: 'helper', exec_tier: 'L2', capabilities: ['exec', 'intercept-tools'], version: '1.0.0' }),
    item({ id: 'nextstep@mkt', name: 'nextstep', kind: 'mod', type_label: 'Claude mod', exec_tier: 'L3',
      capabilities: ['exec', 'network'], native_consent: 'hot-reload', evidence: 'inferred', enabled: false }),
    item({ id: 'Stop#0', name: 'Stop', kind: 'hook', type_label: 'Claude hook', exec_tier: 'L2', capabilities: ['exec'],
      owner: 'navide', detail: 'PORT=$(cat …)' }),
    item({ id: '!broken', name: 'installed_plugins.json', valid: false, error: 'no plugins map' }),
  ],
}

let wrapper: VueWrapper
const send = vi.fn()

function render(): VueWrapper {
  wrapper = mount(CliExtensionsPane, { props: { backend: { send } }, global: { plugins: [i18n] } })
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  send.mockReset().mockResolvedValue({ ok: true, payload, error: null })
})
afterEach(() => wrapper?.unmount())

describe('CliExtensionsPane', () => {
  it('asks the backend for the inventory once on mount', async () => {
    render()
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('cli_extensions.list', {})
  })

  it('counts valid CLI extensions and in-process code', async () => {
    render()
    await flushPromises()
    expect(wrapper.get('.cli-ext-counts').text()).toBe('3 CLI extensions · 1 run code inside their CLI')
  })

  it('puts in-process code first and shows the vendor type label untranslated', async () => {
    i18n.global.locale.value = 'zh-TW'
    render()
    await flushPromises()
    const ids = wrapper.findAll('[data-cli="claude"] .cli-ext-card').map((card) => card.attributes('data-id'))
    expect(ids[0]).toBe('nextstep@mkt')
    const mod = wrapper.get('[data-id="nextstep@mkt"]')
    expect(mod.get('.cli-ext-type').text()).toBe('Claude mod')
    expect(mod.get('.cli-ext-tier').text()).toBe('L3 程序內程式碼')
    expect(mod.get('.cli-ext-disabled').text()).toBe('已停用')
    expect(mod.find('.cli-ext-inferred').exists()).toBe(true)
    expect(mod.findAll('.cli-ext-cap').map((cap) => cap.text())).toEqual(['執行指令', '連網'])
  })

  it('marks the hooks Navide installed and shows their masked command line', async () => {
    render()
    await flushPromises()
    const hook = wrapper.get('[data-id="Stop#0"]')
    expect(hook.get('.cli-ext-owner').text()).toBe('Installed by Navide')
    expect(hook.get('.cli-ext-detail').text()).toBe('PORT=$(cat …)')
  })

  it('says when a CLI cannot be read yet, and when it has nothing installed', async () => {
    render()
    await flushPromises()
    expect(wrapper.find('[data-cli="antigravity"] .cli-ext-unsupported').exists()).toBe(true)
    expect(wrapper.get('[data-cli="kilo"] .cli-ext-empty').text()).toBe('No CLI extensions found.')
  })

  it('reports a broken file on its own row', async () => {
    render()
    await flushPromises()
    expect(wrapper.get('[data-id="!broken"] .cli-ext-error').text()).toBe('Could not read: no plugins map')
  })

  it('shows an unreadable on/off switch as an unknown state with its reason, not as enabled or disabled', async () => {
    send.mockResolvedValue({ ok: true, error: null, payload: { ...payload, items: [
      item({ id: 'a@mkt', name: 'a', enabled: true, enabled_error: 'cannot parse settings.json: Expecting value',
        capabilities: ['exec'], path: '/home/u/a' }),
      item({ id: 'b@mkt', name: 'b', enabled: true }),
      item({ id: '!broken', name: 'installed_plugins.json', valid: false, error: 'no plugins map', capabilities: ['exec'] }),
    ] } })
    render()
    await flushPromises()
    const unknown = wrapper.get('[data-id="a@mkt"]')
    expect(unknown.get('.cli-ext-unknown').text()).toBe('State unknown')
    expect(unknown.find('.cli-ext-disabled').exists()).toBe(false)
    expect(unknown.classes()).not.toContain('off')
    expect(unknown.get('.cli-ext-warning').text()).toBe('Could not tell whether this is enabled: cannot parse settings.json: Expecting value')
    // The rest of a readable row is still shown; a broken row still shows only its error.
    expect(unknown.find('.cli-ext-caps').exists()).toBe(true)
    expect(unknown.find('.cli-ext-consent').exists()).toBe(true)
    expect(unknown.get('.cli-ext-path').text()).toBe('/home/u/a')
    const broken = wrapper.get('[data-id="!broken"]')
    expect(broken.find('.cli-ext-caps').exists()).toBe(false)
    expect(broken.find('.cli-ext-consent').exists()).toBe(false)
    const known = wrapper.get('[data-id="b@mkt"]')
    expect(known.find('.cli-ext-unknown').exists()).toBe(false)
    expect(known.find('.cli-ext-warning').exists()).toBe(false)
  })

  it('has no button that changes anything: the only one rescans', async () => {
    render()
    await flushPromises()
    // The tab strip only switches views; the inventory tab is what is checked.
    const buttons = wrapper.findAll('.cli-ext button')
    expect(buttons.map((button) => button.classes())).toEqual([['cli-ext-rescan']])
    expect(wrapper.findAll('input, select, textarea')).toHaveLength(0)
    await buttons[0].trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('cli_extensions.list', {})
  })

  it('shows a load failure', async () => {
    send.mockResolvedValue({ ok: false, payload: null, error: { code: 'X', message: 'boom' } })
    render()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not read CLI extensions: boom')
  })

  // Layout rules a DOM without CSS layout cannot measure, read from the SFC's
  // own scoped styles. The Settings tab body is full-bleed (no gutter) and
  // overflow:hidden, so the pane must carry the gutter and the scroll itself.
  describe('layout', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/CliExtensionsPane.vue'), 'utf8')
    const style = source.slice(source.indexOf('<style scoped>'))
    const rule = (selector: string): string => {
      const match = style.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
      expect(match, `no rule for ${selector}`).not.toBeNull()
      return match![1]
    }

    it('owns the page gutter and its own vertical scroll inside the bleed tab body', () => {
      const root = rule('.cli-ext')
      expect(root).toMatch(/flex:\s*1/)
      expect(root).toMatch(/min-height:\s*0/)
      expect(root).toMatch(/overflow-y:\s*auto/)
      expect(root).toMatch(/padding:\s*16px 22px 18px/)
    })

    it('never scrolls sideways: long names wrap, paths and command lines truncate', () => {
      expect(rule('.cli-ext')).toMatch(/overflow-x:\s*hidden/)
      expect(rule('.cli-ext-name')).toMatch(/overflow-wrap:\s*anywhere/)
      expect(rule('.cli-ext-detail, .cli-ext-path')).toMatch(/text-overflow:\s*ellipsis/)
    })

    it('puts the name on its own line above the badges', async () => {
      render()
      await flushPromises()
      const card = wrapper.get('[data-id="helper@mkt"]')
      expect(card.get('.cli-ext-title .cli-ext-name').text()).toBe('helper')
      expect(card.get('.cli-ext-title .cli-ext-version').text()).toBe('1.0.0')
      expect(card.findAll('.cli-ext-badges > span').map((badge) => badge.classes()[0])).toEqual(['cli-ext-type', 'cli-ext-tier'])
    })

    it('shows a CLI with nothing to list as one compact row, not an open box', async () => {
      render()
      await flushPromises()
      const kilo = wrapper.get('[data-cli="kilo"]')
      expect(kilo.element.tagName).toBe('DIV')
      expect(kilo.classes()).toContain('is-empty')
      expect(kilo.get('.cli-ext-group-head .cli-ext-empty').text()).toBe('No CLI extensions found.')
      const antigravity = wrapper.get('[data-cli="antigravity"]')
      expect(antigravity.element.tagName).toBe('DIV')
      expect(antigravity.find('.cli-ext-group-head .cli-ext-unsupported').exists()).toBe(true)
      const claude = wrapper.get('[data-cli="claude"]')
      expect(claude.element.tagName).toBe('DETAILS')
      expect(claude.find('summary .cli-ext-chevron').exists()).toBe(true)
    })
  })
})
