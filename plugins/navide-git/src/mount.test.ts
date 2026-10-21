// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'

const state = vi.hoisted(() => {
  return {
    initSettingsBackend: vi.fn(),
    seedSettings: vi.fn(),
    language: 'en-US',
    languageListener: null as null | ((keys: string[]) => void),
  }
})

vi.mock('@navide/plugin-ui', () => ({ createAiCliSessionController: vi.fn(() => ({})) }))
vi.mock('@navide/plugin-ui/shared', () => ({
  initKeybindingsPort: vi.fn(),
  initSettingsBackend: state.initSettingsBackend,
  seedSettings: state.seedSettings,
  settingsGet: (key: string, fallback: unknown) => key === 'agent-team:language' ? state.language : fallback,
  onSettingsChanged: (callback: (keys: string[]) => void) => { state.languageListener = callback; return () => { state.languageListener = null } },
}))
vi.mock('./capabilityBackend', () => ({ useBackend: vi.fn(() => ({})) }))
vi.mock('./sdkGitTransport', () => ({ createPluginGitTransport: vi.fn(() => ({})) }))
vi.mock('./pluginSurfacePorts', () => ({
  createPluginCapabilitySdk: vi.fn(() => ({
    request: vi.fn(),
    status: { value: 'connected' },
    subscribe: vi.fn(() => () => undefined),
  })),
  createPluginKeybindingsPort: vi.fn(() => ({})),
  createPluginGitSurfacePorts: vi.fn(() => ({
    gitTransport: {}, fileAccess: {}, ui: {}, branchDiff: {}, accounts: {}, issues: {},
  })),
  createPluginGitContributionHostPort: vi.fn(() => ({})),
  createPluginGitWorkspaceGrantPort: vi.fn(() => ({})),
  createPluginGitSettingsPort: vi.fn(() => ({})),
  createPluginLegacyRepoSelectionPort: vi.fn(() => ({})),
}))
vi.mock('./GitWindowApp.vue', () => ({ default: { template: '<button>{{ $t("action.close") }}</button>' } }))
vi.mock('./GitLeftApp.vue', () => ({ default: { template: '<button>{{ $t("action.close") }}</button>' } }))
vi.mock('./GitDetailApp.vue', () => ({ default: {} }))

describe('Git plugin composition root', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' })
    i18n.global.locale.value = 'en-US'
    document.body.innerHTML = '<div id="app"></div>'
    Object.defineProperty(window, 'nav', {
      configurable: true,
      value: { ready: vi.fn() },
    })
  })

  it('mounts and announces readiness while the owned settings snapshot is pending', async () => {
    window.history.replaceState({}, '', '/?v2=1&locale=ja-JP')
    await import('./mount')
    await vi.waitFor(() => expect(state.initSettingsBackend).toHaveBeenCalledTimes(1))

    expect(document.querySelector('#app button')?.textContent).toBe('閉じる')
    expect(i18n.global.locale.value).toBe('ja-JP')
    expect(state.seedSettings).toHaveBeenCalledWith(expect.objectContaining({ 'agent-team:language': 'ja-JP' }))
    state.language = 'en-US'
    state.languageListener?.(['agent-team:language'])
    await nextTick()
    expect(i18n.global.locale.value).toBe('en-US')
    expect(document.querySelector('#app button')?.textContent).toBe('Close')
    state.language = 'ja-JP'
    state.languageListener?.(['agent-team:language'])
    expect(i18n.global.locale.value).toBe('ja-JP')
    await nextTick()
    expect(document.querySelector('#app button')?.textContent).toBe('閉じる')
    state.language = 'it-IT'
    state.languageListener?.(['agent-team:language'])
    expect(i18n.global.locale.value).toBe('ja-JP')
    // A Beta locale with a catalog renders in itself
    state.language = 'ko-KR'
    state.languageListener?.(['agent-team:language'])
    expect(i18n.global.locale.value).toBe('ko-KR')
    await nextTick()
    expect(document.querySelector('#app button')?.textContent).toBe('닫기')
    // A UI locale without a catalog renders in en-US
    state.language = 'fr-FR'
    state.languageListener?.(['agent-team:language'])
    expect(i18n.global.locale.value).toBe('en-US')
    expect((window as unknown as { nav?: { ready: ReturnType<typeof vi.fn> } }).nav?.ready)
      .toHaveBeenCalledTimes(1)
  })
})
