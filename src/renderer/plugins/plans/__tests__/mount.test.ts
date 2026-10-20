// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const app = {
    use: vi.fn(),
    mount: vi.fn(),
  }
  return {
    app,
    createApp: vi.fn(() => app),
    seedSettings: vi.fn(),
    localeRef: { value: 'zh-TW' },
  }
})

vi.mock('vue', () => ({
  createApp: state.createApp,
}))

vi.mock('@navide/plugin-ui/foundation', async () => {
  const locales = await vi.importActual<typeof import('../../../../../packages/plugin-ui/src/foundation/i18n/uiLocales')>(
    '../../../../../packages/plugin-ui/src/foundation/i18n/uiLocales',
  )
  return {
    i18n: {
      global: {
        locale: state.localeRef,
      },
    },
    resolveAvailableUiLocale: (value: unknown) =>
      locales.isUiLocale(value) ? locales.resolveAvailableLocale(value, ['zh-TW', 'en-US', 'ja-JP']) : null,
  }
})

vi.mock('@navide/plugin-ui/shared', () => ({
  seedSettings: state.seedSettings,
}))

vi.mock('../../../src/PlanWindowApp.vue', () => ({
  default: { name: 'PlanWindowApp' },
}))

describe('Plans legacy plugin mount entry', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    state.localeRef.value = 'zh-TW'
    document.body.innerHTML = '<div id="app"></div>'
  })

  it('propagates Host locale and theme before mounting', async () => {
    window.history.replaceState({}, '', '/?theme=nord&locale=en-US')
    const readyMock = vi.fn()
    Object.defineProperty(window, 'nav', {
      configurable: true,
      value: { ready: readyMock },
    })

    await import('../mount')

    expect(document.documentElement.getAttribute('data-theme')).toBe('nord')
    expect(state.seedSettings).toHaveBeenCalledWith({ 'agent-team:theme': JSON.stringify('nord') })
    expect(state.seedSettings).toHaveBeenCalledWith({ 'agent-team:language': 'en-US' })
    expect(state.localeRef.value).toBe('en-US')
    expect(state.createApp).toHaveBeenCalled()
    expect(state.app.mount).toHaveBeenCalledWith('#app')
    expect(readyMock).toHaveBeenCalled()
  })

  it('updates locale on openTarget delivery', async () => {
    let openTargetCallback: ((p: Record<string, string>) => void) | null = null
    Object.defineProperty(window, 'nav', {
      configurable: true,
      value: {
        ready: vi.fn(),
        onOpenTarget: vi.fn((cb: (p: Record<string, string>) => void) => {
          openTargetCallback = cb
          return () => undefined
        }),
      },
    })

    await import('../mount')
    expect(openTargetCallback).toBeDefined()

    openTargetCallback!({ rel_path: '.agent-team/plans/my-plan.html', locale: 'zh-TW' })

    expect(state.localeRef.value).toBe('zh-TW')
    expect(state.seedSettings).toHaveBeenCalledWith({ 'agent-team:language': 'zh-TW' })
  })
})
