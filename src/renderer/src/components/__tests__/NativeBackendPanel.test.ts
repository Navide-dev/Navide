// @vitest-environment happy-dom
// The Native backends panel keeps a shell grant visible after the one-time
// consent dialog, and its header never promises "no network access" without
// the shell exception (review M2 of #344).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import NativeBackendPanel from '../NativeBackendPanel.vue'

const row = (pluginId: string, extra: Record<string, unknown> = {}) => ({
  pluginId, packageVersion: '0.2.0', name: pluginId, status: 'ready',
  changedSinceConsent: false, canWriteWorkspace: true, workspaceWrite: [], ...extra,
})

let wrapper: VueWrapper | undefined

async function mountPanel(
  plugins = [row('acme.indexer'), row('nerdtechnic.devmap', { shell: 'allowlist' })],
): Promise<VueWrapper> {
  const overview = { enabled: true, plugins }
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    plugins: {
      list: vi.fn(async () => []),
      listInstalled: vi.fn(async () => []),
      nativeBackends: { list: vi.fn(async () => overview) },
    },
  }
  wrapper = mount(NativeBackendPanel, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  delete (window as unknown as Record<string, unknown>).agentTeam
  i18n.global.locale.value = 'en-US'
})

describe('NativeBackendPanel shell disclosure', () => {
  it('marks only the shell package as high risk, with what shell allows', async () => {
    const panel = await mountPanel()
    const plain = panel.get('[data-native-backend-id="acme.indexer"]')
    const shell = panel.get('[data-native-backend-id="nerdtechnic.devmap"]')
    expect(plain.find('.native-backend-shell').exists()).toBe(false)
    const badge = shell.get('.native-backend-shell')
    expect(badge.text()).toBe('High risk: runs git, gh and glab')
    const detail = shell.get('.native-backend-shell-detail').text()
    expect(detail).toContain('contact network hosts and send workspace data')
    expect(detail).toContain('without the separate file-change permission')
    expect(detail).toContain('run to completion (up to about 30 seconds)')
  })

  it('qualifies the "no network access" promise in every locale', async () => {
    for (const [locale, needle] of [['en-US', 'git, gh and glab'], ['zh-TW', 'git、gh、glab'], ['ja-JP', 'git、gh、glab']] as const) {
      i18n.global.locale.value = locale
      const panel = await mountPanel()
      const description = panel.get('.native-backends-description').text()
      expect(description).toContain(needle)
      expect(panel.get('[data-native-backend-id="nerdtechnic.devmap"] .native-backend-shell').text()).not.toBe('')
      panel.unmount()
      wrapper = undefined
    }
  })
})

describe('NativeBackendPanel pre-0.2.31 install disclosure', () => {
  it('says on its row that a package installed before 0.2.31 was allowed without asking', async () => {
    const panel = await mountPanel([row('acme.indexer'), row('nerdtechnic.devmap', { allowedBy: 'pre-0.2.31-install' })])
    expect(panel.find('[data-native-backend-id="acme.indexer"] .native-backend-pre-install').exists()).toBe(false)
    expect(panel.get('[data-native-backend-id="nerdtechnic.devmap"] .native-backend-pre-install').text())
      .toBe('Allowed without asking: it was installed before Navide 0.2.31, which did not record install consent.')
  })
})

describe('NativeBackendPanel saved decline', () => {
  it('says a declined package stays off and offers Allow', async () => {
    const panel = await mountPanel([row('acme.indexer', { status: 'needs-consent', declined: true })])
    const item = panel.get('[data-native-backend-id="acme.indexer"]')
    expect(item.get('.native-backend-declined').text()).toContain('Press Allow to run it.')
    expect(item.findAll('button').some((button) => button.text() === 'Allow')).toBe(true)
  })
})

describe('NativeBackendPanel: an "off" that could not be saved (#642 L2)', () => {
  async function mountWith(nativeBackends: Record<string, unknown>): Promise<VueWrapper> {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: { list: vi.fn(async () => []), listInstalled: vi.fn(async () => []), nativeBackends },
    }
    wrapper = mount(NativeBackendPanel, { global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }

  it('shows the real state after a failed save, says it will be on after a restart, and retries', async () => {
    const state = { enabled: true, plugins: [] as unknown[], offUnsaved: undefined as true | undefined }
    const setEnabled = vi.fn(async (on: boolean) => {
      state.enabled = on
      if (!on && setEnabled.mock.calls.length === 1) {
        state.offUnsaved = true
        throw new Error("Error invoking remote method 'plugins:nativeBackends:setEnabled': Error: ENOSPC")
      }
      state.offUnsaved = undefined
      return { ...state }
    })
    const panel = await mountWith({ list: vi.fn(async () => ({ ...state })), setEnabled })
    expect(panel.find('.native-backends-unsaved').exists()).toBe(false)
    await panel.get('[data-native-backends-switch="enabled"]').trigger('click')
    await flushPromises()
    const notice = panel.get('.native-backends-unsaved')
    expect(notice.text()).toContain(i18n.global.t('settings.extensions.nativeBackends.offUnsaved'))
    expect(panel.get('.ext-error').text()).toContain('ENOSPC')
    await panel.get('.native-backends-unsaved-retry').trigger('click')
    await flushPromises()
    expect(setEnabled).toHaveBeenLastCalledWith(false)
    expect(panel.find('.native-backends-unsaved').exists()).toBe(false)
  })

  it('shows nothing extra when the overview carries no flag, as on main', async () => {
    const panel = await mountWith({ list: vi.fn(async () => ({ enabled: false, plugins: [] })) })
    expect(panel.find('.native-backends-unsaved').exists()).toBe(false)
  })
})
