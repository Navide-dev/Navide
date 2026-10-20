// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginRegionHost from '../PluginRegionHost.vue'

type PluginRegionContribution = {
  pluginId: string
  packageVersion: string | null
  contributionKey: string
  title: string
  icon: string | null
  kind: 'custom'
  location: 'top' | 'bottom' | 'right' | 'left' | 'main' | 'window'
  manifestOrder: number
}

const contribution: PluginRegionContribution = {
  pluginId: 'acme.files',
  packageVersion: '1.0.0',
  contributionKey: 'acme.files.left',
  title: 'Files',
  icon: null,
  kind: 'custom',
  location: 'left',
  manifestOrder: 0,
}

const URL_A = 'file:///pkg/index.html?workspace_path=/ws&v2=1&nv_guest=tok-a'
const URL_B = 'file:///pkg/index.html?workspace_path=/other&v2=1&nv_guest=tok-b'

function stubPlugins(prepare: ReturnType<typeof vi.fn>) {
  const closeContribution = vi.fn(async () => ({ ok: true }))
  const openContribution = vi.fn(async () => ({ ok: true }))
  const updateContribution = vi.fn(async () => ({ ok: true }))
  const hostThemeChanged = vi.fn()
  window.agentTeam = {
    plugins: {
      prepareContribution: prepare,
      closeContribution,
      openContribution,
      updateContribution,
      hostThemeChanged,
    },
  } as unknown as typeof window.agentTeam
  return { closeContribution, openContribution, updateContribution, hostThemeChanged }
}

describe('PluginRegionHost', () => {
  let originalAgentTeam: typeof window.agentTeam

  beforeEach(() => {
    originalAgentTeam = window.agentTeam
    document.documentElement.setAttribute('data-theme', 'dark-github')
  })

  afterEach(() => {
    window.agentTeam = originalAgentTeam
    vi.restoreAllMocks()
  })

  it('asks the Host by contribution key and never handles an instance id', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    expect(prepare).toHaveBeenCalledWith({
      contributionKey: 'acme.files.left',
      workspace_path: '/ws',
      // A guest is its own document: it cannot inherit our CSS variables, so the
      // theme we are actually rendering with travels with the request.
      theme: 'dark-github',
    })
    // The renderer receives a URL with an opaque token — never an instance id.
    const view = wrapper.find('webview')
    expect(view.exists()).toBe(true)
    expect(view.attributes('src')).toBe(URL_A)
    expect(JSON.stringify(prepare.mock.calls)).not.toContain('instance')
    wrapper.unmount()
  })

  it('runs the Host migration funnel before preparing the guest', async () => {
    const order: string[] = []
    const beforePrepare = vi.fn(async () => { order.push('migrate') })
    const prepare = vi.fn(async () => {
      order.push('prepare')
      return { ok: true, url: URL_A }
    })
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true, beforePrepare },
    })
    await flushPromises()

    expect(beforePrepare).toHaveBeenCalledOnce()
    expect(order).toEqual(['migrate', 'prepare'])
    wrapper.unmount()
  })

  it('leaves geometry to CSS: no bounds are mirrored to the Host', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    const { openContribution, updateContribution } = stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    expect(openContribution).not.toHaveBeenCalled()
    expect(updateContribution).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps the guest in the DOM while its tab is hidden', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    await wrapper.setProps({ visible: false })
    await flushPromises()

    // Hidden through `display: none`, which keeps the guest's webContents alive
    // so a background contribution can still push updates (Git's changes badge).
    expect(wrapper.find('webview').exists()).toBe(true)
    expect(wrapper.element.getAttribute('style')).toContain('display: none')
    // Not re-prepared: the same guest is reused across visibility changes.
    expect(prepare).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('re-prepares against the new workspace when it changes', async () => {
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, url: URL_A })
      .mockResolvedValueOnce({ ok: true, url: URL_B })
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    await wrapper.setProps({ workspacePath: '/other' })
    await flushPromises()

    expect(prepare).toHaveBeenLastCalledWith({
      contributionKey: 'acme.files.left',
      workspace_path: '/other',
      theme: 'dark-github',
    })
    expect(wrapper.find('webview').attributes('src')).toBe(URL_B)
    wrapper.unmount()
  })

  it('shows the unavailable state when the Host refuses to prepare', async () => {
    const prepare = vi.fn(async () => ({ ok: false, error: 'grant is missing' }))
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    expect(wrapper.find('webview').exists()).toBe(false)
    expect(wrapper.text()).toContain('unavailable')
    wrapper.unmount()
  })

  it('drops a prepare that resolves after the workspace moved on', async () => {
    type PrepareResult = { ok: boolean; url: string }
    let resolveFirst!: (value: PrepareResult) => void
    const stalled = new Promise<PrepareResult>((resolve) => { resolveFirst = resolve })
    const prepare = vi
      .fn()
      .mockImplementationOnce(() => stalled)
      .mockResolvedValueOnce({ ok: true, url: URL_B })
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await wrapper.setProps({ workspacePath: '/other' })
    await flushPromises()
    // The stale request lands last; it must not overwrite the current guest.
    resolveFirst({ ok: true, url: URL_A })
    await flushPromises()

    expect(wrapper.find('webview').attributes('src')).toBe(URL_B)
    wrapper.unmount()
  })

  it('clears the Host registry entry on unmount', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    const { closeContribution } = stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()
    wrapper.unmount()
    await flushPromises()

    expect(closeContribution).toHaveBeenCalledWith({ contributionKey: 'acme.files.left' })
  })

  it('re-asserts the theme only once the guest can receive it, then follows every switch', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    const { hostThemeChanged } = stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()

    // Nothing may be pushed before dom-ready: at that point Vue has not even
    // rendered the <webview>, so the contribution has no guest and the push
    // reaches nobody while still broadcasting to every other plugin.
    expect(hostThemeChanged).not.toHaveBeenCalled()

    await wrapper.find('webview').trigger('dom-ready')
    expect(hostThemeChanged).toHaveBeenCalledWith('dark-github')

    hostThemeChanged.mockClear()
    document.documentElement.setAttribute('data-theme', 'light')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hostThemeChanged).toHaveBeenCalledWith('light')

    wrapper.unmount()
    hostThemeChanged.mockClear()
    document.documentElement.setAttribute('data-theme', 'dark-github')
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The observer is disconnected with the component.
    expect(hostThemeChanged).not.toHaveBeenCalled()
  })

  it('closes the Host instance when a prepare is still in flight at unmount', async () => {
    let resolveLate!: (value: { ok: boolean; url: string }) => void
    const stalled = new Promise<{ ok: boolean; url: string }>((resolve) => { resolveLate = resolve })
    const prepare = vi.fn(() => stalled)
    const { closeContribution } = stubPlugins(prepare as ReturnType<typeof vi.fn>)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    wrapper.unmount()
    expect(closeContribution).toHaveBeenCalledWith({ contributionKey: 'acme.files.left' })

    // The response lands after teardown; it must not resurrect the instance.
    resolveLate({ ok: true, url: URL_A })
    await flushPromises()
    expect(closeContribution).toHaveBeenCalledTimes(1)
  })

  it('prepares a hidden contribution so it is live before its tab is opened', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: false },
    })
    await flushPromises()

    // A guest created inside a display:none subtree still attaches and runs, so
    // a background contribution (Git's changes badge) is live from the start.
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(wrapper.find('webview').exists()).toBe(true)
    wrapper.unmount()
  })

  it('retries a failed prepare when its tab is opened', async () => {
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'backend is not ready' })
      .mockResolvedValueOnce({ ok: true, url: URL_A })
    stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: false },
    })
    await flushPromises()
    expect(wrapper.find('webview').exists()).toBe(false)

    // Opening the tab is the user's natural retry; a contribution that came up
    // while the backend was still starting must not stay unavailable forever.
    await wrapper.setProps({ visible: true })
    await flushPromises()
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(wrapper.find('webview').attributes('src')).toBe(URL_A)
    wrapper.unmount()
  })

  it('releases the Host instance before a workspace change destroys the guest', async () => {
    const prepare = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, url: URL_A })
      .mockResolvedValueOnce({ ok: true, url: URL_B })
    const { closeContribution } = stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()
    closeContribution.mockClear()
    prepare.mockClear()

    await wrapper.setProps({ workspacePath: '/other' })
    await flushPromises()

    // Dropping `src` destroys the guest synchronously. Unless the Host is told
    // first it reads that as the plugin dying before its readiness handshake,
    // which downgrades navide.git to legacy recovery for the whole session.
    expect(closeContribution).toHaveBeenCalledWith({ contributionKey: 'acme.files.left' })
    expect(closeContribution.mock.invocationCallOrder[0]).toBeLessThan(
      prepare.mock.invocationCallOrder[0]
    )
    wrapper.unmount()
  })

  it('releases the Host instance when the window drops its workspace', async () => {
    const prepare = vi.fn(async () => ({ ok: true, url: URL_A }))
    const { closeContribution } = stubPlugins(prepare)
    const wrapper = mount(PluginRegionHost, {
      props: { contribution, workspacePath: '/ws', visible: true },
    })
    await flushPromises()
    closeContribution.mockClear()

    await wrapper.setProps({ workspacePath: '' })
    await flushPromises()

    // Back at the workspace picker: the element is gone, but the Host-side
    // instance keeps its backend subscriptions until it is told to close.
    expect(wrapper.find('webview').exists()).toBe(false)
    expect(closeContribution).toHaveBeenCalledWith({ contributionKey: 'acme.files.left' })
    expect(prepare).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

// Card K2: the source strip sits in Navide's chrome above the guest, so the
// plugin's content cannot cover it. Marketplace and built-in views are unchanged.
describe('PluginRegionHost source strip (K2)', () => {
  let originalAgentTeam: typeof window.agentTeam
  beforeEach(() => {
    originalAgentTeam = window.agentTeam
  })
  afterEach(() => {
    window.agentTeam = originalAgentTeam
  })

  async function render(source?: string) {
    stubPlugins(vi.fn(async () => ({ ok: true, url: URL_A })))
    const wrapper = mount(PluginRegionHost, {
      props: { contribution: { ...contribution, ...(source ? { source } : {}) } as never, workspacePath: '/ws', visible: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return wrapper
  }

  it('shows a local source above the webview, outside it', async () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = await render('developer-unpacked')
    const strip = wrapper.get('.plugin-region-host__source')
    expect(strip.get('.plugin-region-host__title').text()).toBe('Files')
    expect(strip.get('.nv-source-badge').text()).toBe('Local folder')
    expect(strip.element.nextElementSibling?.tagName).toBe('WEBVIEW')
    expect(wrapper.get('webview').find('.plugin-region-host__source').exists()).toBe(false)
    wrapper.unmount()
  })

  it("shows a test build's expiry, read from its signed envelope, instead of \"expiry unknown\" (W5b)", async () => {
    i18n.global.locale.value = 'en-US'
    stubPlugins(vi.fn(async () => ({ ok: true, url: URL_A })))
    const wrapper = mount(PluginRegionHost, {
      props: {
        contribution: { ...contribution, source: 'testplace', expiresAt: '2099-01-31T00:00:00Z', testplaceVia: 'invite' } as never,
        workspacePath: '/ws',
        visible: true,
      },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.get('.plugin-region-host__source .nv-source-badge').text()).toBe('Test build: automated scan only, expires 2099-01-31')
    wrapper.unmount()
  })

  it('renders a Marketplace, built-in or unknown source exactly as before', async () => {
    const plain = await render()
    const html = plain.html()
    plain.unmount()
    for (const source of ['marketplace', 'factory-bundled']) {
      const wrapper = await render(source)
      expect(wrapper.html()).toBe(html)
      wrapper.unmount()
    }
  })
})
