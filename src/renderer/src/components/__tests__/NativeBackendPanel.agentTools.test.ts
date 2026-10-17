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
    const enabled = wrapper.find<HTMLInputElement>('[data-agent-tools-switch="enabled"]')
    const external = wrapper.find<HTMLInputElement>('[data-agent-tools-switch="externalCallers"]')
    expect(enabled.element.checked).toBe(false)
    expect(external.element.checked).toBe(false)
    expect(external.element.disabled).toBe(true)
    expect(wrapper.text()).toContain('Let agents call tools from third-party Navide plugins')
    expect(wrapper.text()).toContain('External programs share a single token')

    enabled.element.checked = true
    await enabled.trigger('change')
    await flushPromises()
    expect(setAgentTools).toHaveBeenCalledWith({ enabled: true })
    expect(wrapper.find<HTMLInputElement>('[data-agent-tools-switch="externalCallers"]').element.disabled).toBe(false)
  })
})
