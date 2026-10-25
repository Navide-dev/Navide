// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import NativeBackendPanel from '../NativeBackendPanel.vue'

function overview(agentTools?: { enabled: boolean; externalCallers: boolean }) {
  return { enabled: true, plugins: [], ...(agentTools ? { agentTools } : {}) }
}

function mockApi(nativeBackends: Record<string, unknown>) {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    plugins: { listInstalled: vi.fn().mockResolvedValue([]), nativeBackends },
  }
}

describe('NativeBackendPanel agent-tool switches (plan B1-b)', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('shows no agent-tool switch when the Host does not offer one', async () => {
    mockApi({ list: vi.fn().mockResolvedValue(overview()) })
    wrapper = mount(NativeBackendPanel, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-agent-tools-switch]').exists()).toBe(false)
  })

  it('shows both switches off, keeps the external one unavailable until agents may call tools, and forwards changes', async () => {
    const setAgentTools = vi.fn().mockResolvedValue(overview({ enabled: true, externalCallers: false }))
    mockApi({ list: vi.fn().mockResolvedValue(overview({ enabled: false, externalCallers: false })), setAgentTools })
    wrapper = mount(NativeBackendPanel, { global: { plugins: [i18n] } })
    await flushPromises()
    const enabled = wrapper.find<HTMLButtonElement>('[data-agent-tools-switch="enabled"]')
    const external = wrapper.find<HTMLButtonElement>('[data-agent-tools-switch="externalCallers"]')
    expect(enabled.attributes('role')).toBe('switch')
    expect(enabled.attributes('aria-checked')).toBe('false')
    expect(external.attributes('aria-checked')).toBe('false')
    expect(external.element.disabled).toBe(true)
    expect(wrapper.text()).toContain('Let agents call tools from third-party Navide plugins')
    expect(wrapper.text()).toContain('External programs share a single token')

    await enabled.trigger('click')
    await flushPromises()
    expect(setAgentTools).toHaveBeenCalledWith({ enabled: true })
    expect(wrapper.find<HTMLButtonElement>('[data-agent-tools-switch="externalCallers"]').element.disabled).toBe(false)
  })

  it('turns native backends off with its switch, and keeps the warning in the same card above it', async () => {
    const setEnabled = vi.fn().mockResolvedValue({ ...overview(), enabled: false })
    mockApi({ list: vi.fn().mockResolvedValue(overview()), setEnabled })
    wrapper = mount(NativeBackendPanel, { global: { plugins: [i18n] } })
    await flushPromises()

    const card = wrapper.get('.native-backends-card')
    const children = card.element.children
    expect(children[0].classList.contains('native-backends-callout')).toBe(true)
    const toggle = card.get('[data-native-backends-switch="enabled"]')
    expect(toggle.attributes('role')).toBe('switch')
    expect(toggle.attributes('aria-checked')).toBe('true')
    await toggle.trigger('click')
    await flushPromises()
    expect(setEnabled).toHaveBeenCalledWith(false)
  })
})
