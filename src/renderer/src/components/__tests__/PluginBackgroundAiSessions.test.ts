// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginBackgroundAiSessions from '../PluginBackgroundAiSessions.vue'

const session = { sessionId: 's1', profileId: 'claude', packageVersion: '1.2.0', since: Date.UTC(2026, 9, 26, 12) }

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
  vi.useRealTimers()
})

function mockPlugins(overrides: Record<string, unknown> = {}) {
  const api = {
    backgroundAiSessions: vi.fn().mockResolvedValue([session]),
    endBackgroundAiSession: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

async function render(props: Record<string, unknown> = {}) {
  wrapper = mount(PluginBackgroundAiSessions, {
    props: { pluginId: 'acme.devmap', ...props },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return wrapper
}

describe('PluginBackgroundAiSessions', () => {
  it('renders nothing while the plugin has no session in the background', async () => {
    const api = mockPlugins({ backgroundAiSessions: vi.fn().mockResolvedValue([]) })
    const w = await render()
    expect(api.backgroundAiSessions).toHaveBeenCalledWith('acme.devmap')
    expect(w.find('.ext-background-ai').exists()).toBe(false)
  })

  it('lists each session with its CLI, version and an End button', async () => {
    mockPlugins()
    const w = await render()
    expect(w.get('.ext-background-ai-title').text()).toBe('AI CLI running in the background (1)')
    expect(w.get('.ext-background-ai-desc').text()).toContain('Claude Code · version 1.2.0 · since ')
    expect(w.get('.ext-background-ai-end').text()).toBe('End')
  })

  it('ends a session only when End is pressed, then reads the list again', async () => {
    const api = mockPlugins()
    const w = await render()
    expect(api.endBackgroundAiSession).not.toHaveBeenCalled()
    api.backgroundAiSessions.mockResolvedValue([])
    await w.get('.ext-background-ai-end').trigger('click')
    await flushPromises()
    expect(api.endBackgroundAiSession).toHaveBeenCalledWith('acme.devmap', 's1')
    expect(w.find('.ext-background-ai').exists()).toBe(false)
  })

  it('says so when the session was no longer running in the background', async () => {
    const api = mockPlugins({ endBackgroundAiSession: vi.fn().mockResolvedValue({ ok: false }) })
    const w = await render()
    api.backgroundAiSessions.mockResolvedValue([])
    await w.get('.ext-background-ai-end').trigger('click')
    await flushPromises()
    expect(w.get('.ext-background-ai-error').text()).toBe('That session is no longer running in the background.')
  })

  it('polls only while not paused', async () => {
    vi.useFakeTimers()
    const api = mockPlugins()
    const w = await render({ paused: true, pollMs: 1000 })
    expect(api.backgroundAiSessions).not.toHaveBeenCalled()
    await w.setProps({ paused: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.backgroundAiSessions).toHaveBeenCalledTimes(3)
    await w.setProps({ paused: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.backgroundAiSessions).toHaveBeenCalledTimes(3)
  })
})
