// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginStopStatusItem from '../PluginStopStatusItem.vue'

let wrapper: VueWrapper | undefined
let saved: typeof i18n.global.locale.value
beforeEach(() => {
  saved = i18n.global.locale.value
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = saved
  delete (window as unknown as Record<string, unknown>).agentTeam
})

const THIRD_PARTY = [
  { id: 'acme.grok', requires: [], sensitive: [], packageVersion: '1.2.0', provenance: 'official-registry', disabled: false },
  { id: 'acme.off', requires: [], sensitive: [], packageVersion: '0.1.0', provenance: 'official-registry', disabled: true },
]
const BUNDLED = [{ id: 'navide.plans', requires: [], sensitive: [], packageVersion: '1.1.4', provenance: 'factory-bundled' }]

function mockPlugins(list: unknown[], overrides: Record<string, unknown> = {}) {
  const api = {
    listInstalled: vi.fn().mockResolvedValue(list),
    stop: vi.fn().mockResolvedValue({ id: 'acme.grok', disabled: true, changed: true, summary: {} }),
    stopAll: vi.fn().mockResolvedValue({ stopped: ['acme.grok'], failed: [] }),
    globalStopState: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

async function render(open = false) {
  wrapper = mount(PluginStopStatusItem, { props: { open }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

describe('PluginStopStatusItem (plan P2)', () => {
  it('is hidden while no third-party plugin is installed', async () => {
    mockPlugins(BUNDLED)
    const w = await render(true)
    expect(w.find('.nv-sb-plugins').exists()).toBe(false)
    expect(w.find('.nv-sbp-pop').exists()).toBe(false)
  })

  it('shows how many run and asks the status bar to open its popover', async () => {
    mockPlugins([...THIRD_PARTY, ...BUNDLED])
    const w = await render()
    expect(w.get('.nv-sb-plugins').text()).toBe('Navide plugins 1')
    await w.get('.nv-sb-plugins').trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
  })

  it('lists the third-party plugins and stops a running one after a second press', async () => {
    const api = mockPlugins([...THIRD_PARTY, ...BUNDLED])
    const w = await render(true)
    expect(w.findAll('.nv-sbp-row').map((r) => r.attributes('data-id'))).toEqual(['acme.grok', 'acme.off'])
    expect(w.get('.nv-sbp-row[data-id="acme.off"]').find('.nv-sbp-stop').exists()).toBe(false)
    const stop = () => w.get('.nv-sbp-row[data-id="acme.grok"] .nv-sbp-stop')
    await stop().trigger('click')
    expect(api.stop).not.toHaveBeenCalled()
    expect(stop().text()).toBe('Stop now')
    await stop().trigger('click')
    await flushPromises()
    expect(api.stop).toHaveBeenCalledWith('acme.grok', 'status-bar')
  })

  it('opens Settings from its footer, and closes on Escape', async () => {
    mockPlugins(THIRD_PARTY)
    const w = await render(true)
    await w.get('[data-act="open-settings"]').trigger('click')
    expect(w.emitted('open-settings')).toHaveLength(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('P3: stops all from the popover, and turns red while every third-party plugin is stopped', async () => {
    const api = mockPlugins(THIRD_PARTY)
    const w = await render(true)
    await w.get('.nv-sbp-stop-all').trigger('click')
    expect(api.stopAll).not.toHaveBeenCalled()
    api.globalStopState.mockResolvedValue({
      at: 1, via: 'status-bar', by: 'user', stopped: ['acme.grok'],
      previous: { nativeBackends: true, agentTools: false, externalCallers: false },
    })
    await w.get('.nv-sbp-stop-all').trigger('click')
    await flushPromises()
    expect(api.stopAll).toHaveBeenCalledWith('status-bar')
    const item = w.get('.nv-sb-plugins')
    expect(item.classes()).toContain('nv-sb-plugins--stopped')
    expect(item.text()).toBe('Navide plugins stopped')
    // Resume is in Settings only.
    expect(w.find('.nv-sbp-stop-all').exists()).toBe(false)
    expect(w.get('.nv-sbp-global').text()).toContain('Resume all in Settings')
  })

  it('P5: turns orange while a plugin is paused on a rule, and says so when one is', async () => {
    let told: ((notice: unknown) => void) | undefined
    const paused = { ...THIRD_PARTY[1], stopRecord: { at: 1, via: 'auto', rule: 'R2', summary: { inFlightCalls: 0, toolCallsLastMinute: 0, capabilityCallsLastMinute: 0, consecutiveFailures: 0, undeclaredHosts: ['evil.io'] } } }
    const api = mockPlugins([THIRD_PARTY[0], paused], { onAutoPaused: vi.fn((handler) => { told = handler; return () => {} }) })
    const w = await render(true)
    expect(w.get('.nv-sb-plugins').classes()).toContain('nv-sb-plugins--paused')
    expect(w.get('.nv-sbp-row[data-id="acme.off"]').text()).toContain('Paused (R2)')
    const { useNotify } = await import('@navide/plugin-ui/foundation')
    const before = useNotify().toasts.value.length
    told!({ pluginId: 'acme.grok', rule: 'R1', value: 61, threshold: 60, detail: 'toolCalls' })
    await flushPromises()
    const toasts = useNotify().toasts.value
    expect(toasts.length).toBe(before + 1)
    expect(toasts[toasts.length - 1]!.message).toBe('Navide paused the Navide plugin acme.grok: too many tool or capability calls. Check it in Settings → Navide Plugins.')
    expect(api.listInstalled.mock.calls.length).toBeGreaterThan(1)
  })
})
