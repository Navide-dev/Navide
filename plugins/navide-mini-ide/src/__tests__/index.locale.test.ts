// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'

vi.mock('../MiniIdeApp.vue', () => ({ default: defineComponent({ render: () => h('div') }) }))
vi.mock('../composables/useBackend', () => ({
  disposeBackend: vi.fn(),
  viewRuntime: { ready: vi.fn() },
}))

afterEach(() => {
  document.body.innerHTML = ''
})

// Boots a fresh copy of the entry (and the i18n / settings singletons it
// imports) as the host would load it with `?locale=`.
async function bootWithLocale(locale: string) {
  vi.resetModules()
  window.history.replaceState(null, '', `/?locale=${locale}`)
  document.body.innerHTML = '<div id="app"></div>'
  const { i18n } = await import('@navide/plugin-ui/foundation')
  const { settingsGet } = await import('@navide/plugin-ui/shared')
  const before = i18n.global.locale.value
  await import('../index')
  return { locale: i18n.global.locale.value, before, saved: settingsGet<string | null>('agent-team:language', null) }
}

describe('mini-IDE entry locale', () => {
  it.each(['en-US', 'zh-TW', 'ja-JP'])('adopts and persists the host locale %s', async (locale) => {
    const booted = await bootWithLocale(locale)

    expect(booted.locale).toBe(locale)
    expect(booted.saved).toBe(locale)
  })

  it('ignores a locale the UI has no messages for', async () => {
    const booted = await bootWithLocale('it-IT')

    expect(booted.locale).toBe(booted.before)
    expect(booted.saved).toBeNull()
  })
})
