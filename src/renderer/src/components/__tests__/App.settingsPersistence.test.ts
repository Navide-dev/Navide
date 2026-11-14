// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { nextTick, ref } from 'vue'
import {
  initSettingsBackend,
  settingsGet,
  settingsSet,
  SETTINGS_FLUSH_DEBOUNCE_MS,
} from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import { createHostSettingsPort } from '../../composables/hostSettingsPort'
import type { useBackend } from '../../composables/useBackend'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('App.vue host settings backend initialization and language persistence wiring', () => {
  it('imports createHostSettingsPort from hostSettingsPort and initSettingsBackend from shared', () => {
    expect(appSource).toContain('createHostSettingsPort')
    expect(appSource).toContain('initSettingsBackend')
  })

  it('initializes shared settings backend with createHostSettingsPort(backend) using its useBackend() instance', () => {
    // App.vue source assertion for the canonical composition pattern matching EditorWindowApp and PlanWindowApp
    const initWiring = appSource.slice(
      appSource.indexOf('const backend = useBackend()'),
      appSource.indexOf('const settingsApi = useSettings()')
    )
    expect(initWiring).toContain('initSettingsBackend(createHostSettingsPort(backend))')
  })
})

describe('Host settings port and language write persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetSettingsForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    __resetSettingsForTest()
  })

  it('flushes settingsSet("agent-team:language") to backend via ui.settings.set when connected', async () => {
    const status = ref<'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'>('connected')
    const sent: { type: string; payload: Record<string, unknown> }[] = []
    const listeners = new Map<string, Set<(p: unknown) => void>>()

    const backendMock = {
      status,
      send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
        sent.push({ type, payload })
        if (type === 'ui.settings.get') {
          return { ok: true, payload: { settings: {} } }
        }
        if (type === 'ui.settings.set') {
          return { ok: true, payload: { ok: true } }
        }
        return { ok: true, payload: {} }
      }),
      on: vi.fn((type: string, cb: (p: unknown) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(cb)
        return () => listeners.get(type)?.delete(cb)
      }),
    } as unknown as ReturnType<typeof useBackend>

    const settingsPort = createHostSettingsPort(backendMock)
    initSettingsBackend(settingsPort)

    // Wait for initial reconcile
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(backendMock.send).toHaveBeenCalledWith('ui.settings.get', {})

    // Simulate selecting language in Host shell settings UI
    settingsSet('agent-team:language', 'zh-TW')
    expect(settingsGet('agent-team:language', '')).toBe('zh-TW')

    // Advance timers past debounce flush
    await vi.advanceTimersByTimeAsync(SETTINGS_FLUSH_DEBOUNCE_MS)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // Assert that ui.settings.set was invoked with the language update
    const setCall = sent.find((msg) => msg.type === 'ui.settings.set')
    expect(setCall).toBeDefined()
    expect(setCall?.payload).toEqual({
      updates: {
        'agent-team:language': 'zh-TW',
      },
    })
  })
})
