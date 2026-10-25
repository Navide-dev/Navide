// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ExtensionsPane from '../ExtensionsPane.vue'

function mockPlugins(developerMode: { enabled: boolean; folders: [] }, setDeveloperMode = vi.fn()) {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    plugins: {
      listInstalled: vi.fn().mockResolvedValue([]),
      listFactoryPackages: vi.fn().mockResolvedValue([]),
      checkUpdates: vi.fn().mockResolvedValue([]),
      listPacks: vi.fn().mockResolvedValue([]),
      disabledStoreStatus: vi.fn().mockResolvedValue({ status: 'ok' }),
      developerMode: vi.fn().mockResolvedValue(developerMode),
      setDeveloperMode,
    },
  }
  return setDeveloperMode
}

describe('ExtensionsPane developer page', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('shows Developer Mode only on the developer page, as a switch row', async () => {
    mockPlugins({ enabled: true, folders: [] })
    wrapper = mount(ExtensionsPane, { props: { page: 'plugins' }, global: { plugins: [i18n] } })
    await flushPromises()
    const section = () => wrapper!.get('[data-settings-section="extensions-developer-mode"]').element as HTMLElement
    expect(section().style.display).toBe('none')
    expect((wrapper.get('.ext-md').element as HTMLElement).style.display).not.toBe('none')

    await wrapper.setProps({ page: 'developer' })
    expect(section().style.display).not.toBe('none')
    expect((wrapper.get('.ext-md').element as HTMLElement).style.display).toBe('none')
    const toggle = wrapper.get('.ext-devmode-toggle')
    expect(toggle.attributes('role')).toBe('switch')
    expect(toggle.attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-settings-section="extensions-developer-mode"]').text()).toContain(i18n.global.t('settings.extensions.developerMode.hint'))
  })

  it('turns Developer Mode off from its switch', async () => {
    const setDeveloperMode = mockPlugins({ enabled: true, folders: [] }, vi.fn().mockResolvedValue({ enabled: false, folders: [] }))
    wrapper = mount(ExtensionsPane, { props: { page: 'developer' }, global: { plugins: [i18n] } })
    await flushPromises()

    await wrapper.get('.ext-devmode-toggle').trigger('click')
    await flushPromises()
    expect(setDeveloperMode).toHaveBeenCalledWith(false)
  })

  it('reports Developer Mode as on to Settings, and nothing once it is off', async () => {
    mockPlugins({ enabled: true, folders: [] }, vi.fn().mockResolvedValue({ enabled: false, folders: [] }))
    wrapper = mount(ExtensionsPane, { props: { page: 'developer' }, global: { plugins: [i18n] } })
    await flushPromises()
    const last = () => (wrapper!.emitted('developerOn') as string[][][]).at(-1)![0]
    expect(last()).toEqual([i18n.global.t('settings.extensions.developerMode.switch')])

    await wrapper.get('.ext-devmode-toggle').trigger('click')
    await flushPromises()
    expect(last()).toEqual([])
  })

  it('reports the native-backend switches it shows as on to Settings', async () => {
    mockPlugins({ enabled: false, folders: [] })
    const plugins = (window as unknown as { agentTeam: { plugins: Record<string, unknown> } }).agentTeam.plugins
    plugins.nativeBackends = { list: vi.fn().mockResolvedValue({ enabled: true, plugins: [] }) }
    wrapper = mount(ExtensionsPane, { props: { page: 'developer' }, global: { plugins: [i18n] } })
    await flushPromises()
    expect((wrapper.emitted('developerOn') as string[][][]).at(-1)![0]).toEqual([
      i18n.global.t('settings.extensions.nativeBackends.enable'),
    ])
  })

  it('shows the clock-quarantine banner on the plugins page only', async () => {
    // Like the self-hosted and expired-test banners beside it: an alert shown on
    // both sub-pages is announced twice and belongs to the plugin list.
    mockPlugins({ enabled: false, folders: [] })
    const plugins = (window as unknown as { agentTeam: { plugins: Record<string, unknown> } }).agentTeam.plugins
    plugins.clockQuarantine = vi.fn().mockResolvedValue([{ id: 'acme.tool', version: '1.0.0', clock: 'behind' }])
    wrapper = mount(ExtensionsPane, { props: { page: 'plugins' }, global: { plugins: [i18n] } })
    await flushPromises()
    const banner = () => wrapper!.get('[data-clock-id="acme.tool"]').element as HTMLElement
    expect(banner().style.display).not.toBe('none')

    await wrapper.setProps({ page: 'developer' })
    expect(banner().style.display).toBe('none')
  })
})
