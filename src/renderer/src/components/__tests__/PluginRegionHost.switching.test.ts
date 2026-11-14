// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginRegionHost from '../PluginRegionHost.vue'

// H1: while the Host switches a plugin to another version, its region says so
// instead of sitting blank on a drained guest.

type Notice = { pluginId: string; toVersion: string; phase: 'start' | 'end' }

const contribution = {
  pluginId: 'acme.files',
  packageVersion: '1.0.0',
  contributionKey: 'acme.files.left',
  title: 'Files',
  icon: null,
  kind: 'custom' as const,
  location: 'left' as const,
  manifestOrder: 0,
}

const URL_A = 'file:///pkg/index.html?workspace_path=/ws&v2=1&nv_guest=tok-a'
const URL_B = 'file:///pkg/index.html?workspace_path=/ws&v2=1&nv_guest=tok-b'

function stub(prepare: ReturnType<typeof vi.fn>) {
  let listener: ((notice: Notice) => void) | null = null
  const stop = vi.fn(() => { listener = null })
  window.agentTeam = {
    onPluginSwitching: (cb: (notice: Notice) => void) => {
      listener = cb
      return stop
    },
    plugins: {
      prepareContribution: prepare,
      closeContribution: vi.fn(async () => ({ ok: true })),
      hostThemeChanged: vi.fn(),
    },
  } as unknown as typeof window.agentTeam
  return { emit: (notice: Notice) => listener?.(notice), stop }
}

function mountHost() {
  return mount(PluginRegionHost, {
    props: { contribution, workspacePath: '/ws', visible: true },
    global: { plugins: [i18n] },
  })
}

describe('PluginRegionHost – switching to another version (H1)', () => {
  let original: typeof window.agentTeam

  beforeEach(() => {
    original = window.agentTeam
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    window.agentTeam = original
    vi.restoreAllMocks()
  })

  it('says it is switching, keeps the old guest in the DOM, and clears once the new one is ready', async () => {
    let resolveB: (value: unknown) => void = () => {}
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, url: URL_A })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve }))
    const { emit } = stub(prepare)
    const wrapper = mountHost()
    await flushPromises()
    expect(wrapper.find('[data-testid="plugin-region-switching"]').exists()).toBe(false)

    emit({ pluginId: 'acme.files', toVersion: '1.1.0', phase: 'start' })
    await flushPromises()
    const notice = wrapper.find('[data-testid="plugin-region-switching"]')
    expect(notice.text()).toContain('Files')
    expect(notice.text()).toContain('1.1.0')
    // Hidden, not removed: removing it would destroy the guest under the Host.
    expect(wrapper.find('webview').exists()).toBe(true)
    expect(wrapper.find('webview').attributes('style')).toContain('display: none')

    emit({ pluginId: 'acme.files', toVersion: '1.1.0', phase: 'end' })
    await wrapper.setProps({ contribution: { ...contribution, packageVersion: '1.1.0' } })
    await flushPromises()
    // The new guest is still preparing: the notice stays.
    expect(wrapper.find('[data-testid="plugin-region-switching"]').exists()).toBe(true)

    resolveB({ ok: true, url: URL_B })
    await flushPromises()
    expect(wrapper.find('[data-testid="plugin-region-switching"]').exists()).toBe(false)
    expect(wrapper.find('webview').attributes('src')).toBe(URL_B)
    expect(wrapper.find('webview').attributes('style') ?? '').not.toContain('display: none')
    wrapper.unmount()
  })

  it('goes back to the running version when the switch fails', async () => {
    const prepare = vi.fn().mockResolvedValue({ ok: true, url: URL_A })
    const { emit } = stub(prepare)
    const wrapper = mountHost()
    await flushPromises()

    emit({ pluginId: 'acme.files', toVersion: '1.1.0', phase: 'start' })
    emit({ pluginId: 'acme.files', toVersion: '1.1.0', phase: 'end' })
    await flushPromises()
    expect(wrapper.find('[data-testid="plugin-region-switching"]').exists()).toBe(false)
    expect(wrapper.find('webview').attributes('src')).toBe(URL_A)
    expect(prepare).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it("ignores another plugin's switch and stops listening on unmount", async () => {
    const prepare = vi.fn().mockResolvedValue({ ok: true, url: URL_A })
    const { emit, stop } = stub(prepare)
    const wrapper = mountHost()
    await flushPromises()

    emit({ pluginId: 'acme.other', toVersion: '2.0.0', phase: 'start' })
    await flushPromises()
    expect(wrapper.find('[data-testid="plugin-region-switching"]').exists()).toBe(false)
    wrapper.unmount()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
