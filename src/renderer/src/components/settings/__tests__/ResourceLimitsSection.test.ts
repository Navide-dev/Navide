// @vitest-environment happy-dom
// Settings → General → Resource limits. Two promises are pinned here for every
// limit: its default is "what Navide did before" (nothing changes until the
// user turns it on), and changing it writes the key the backend reads.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'
import { settingsGet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'

import ResourceLimitsSection from '../ResourceLimitsSection.vue'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'
import {
  EVOLVE_RECLAIM_KEY,
  FOCUSED_RECLAIM_KEY,
  TRACK_DETACHED_KEY,
  TEST_MAX_WORKERS_KEY,
  _resetResourceLimitsForTest,
} from '../../../composables/useResourceLimits'

const here = dirname(fileURLToPath(import.meta.url))

function mountSection(mock = createMockBackend()) {
  return mount(ResourceLimitsSection, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
}

describe('Resource limits — test-runner worker cap', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    _resetResourceLimitsForTest()
  })

  it('is off by default and writes nothing', () => {
    const w = mountSection()
    const toggle = w.get('[data-testid="limit-test-workers-toggle"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(w.find('[data-testid="limit-test-workers-value"]').exists()).toBe(false)
    expect(settingsGet(TEST_MAX_WORKERS_KEY, 'unset')).toBe('unset')
  })

  it('turning it on stores a cap the backend reads, and the value is adjustable', async () => {
    const w = mountSection()
    await w.get('[data-testid="limit-test-workers-toggle"]').trigger('click')
    expect(settingsGet(TEST_MAX_WORKERS_KEY, 0)).toBe(4)

    const input = w.get('[data-testid="limit-test-workers-value"]')
    await input.setValue('2')
    await input.trigger('change')
    expect(settingsGet(TEST_MAX_WORKERS_KEY, 0)).toBe(2)
  })

  it('turning it back off stores 0, which the backend reads as off', async () => {
    const w = mountSection()
    const toggle = w.get('[data-testid="limit-test-workers-toggle"]')
    await toggle.trigger('click')
    await toggle.trigger('click')
    expect(settingsGet(TEST_MAX_WORKERS_KEY, -1)).toBe(0)
  })

  it('ignores an out-of-range value instead of storing it', async () => {
    const w = mountSection()
    await w.get('[data-testid="limit-test-workers-toggle"]').trigger('click')
    const input = w.get('[data-testid="limit-test-workers-value"]')
    await input.setValue('500')
    await input.trigger('change')
    expect(settingsGet(TEST_MAX_WORKERS_KEY, 0)).toBe(4)
  })
})

describe('Resource limits — evolve timeout reclaim', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    _resetResourceLimitsForTest()
  })

  it('is on at 30 minutes by default without writing anything', () => {
    const w = mountSection()
    expect(w.get('[data-testid="limit-evolve-reclaim-toggle"]').attributes('aria-checked')).toBe('true')
    expect((w.get('[data-testid="limit-evolve-reclaim-value"]').element as HTMLInputElement).value).toBe('30')
    expect(settingsGet(EVOLVE_RECLAIM_KEY, 'unset')).toBe('unset')
  })

  it('switching it off stores 0, which the backend reads as never', async () => {
    const w = mountSection()
    await w.get('[data-testid="limit-evolve-reclaim-toggle"]').trigger('click')
    expect(settingsGet(EVOLVE_RECLAIM_KEY, -1)).toBe(0)
    expect(w.find('[data-testid="limit-evolve-reclaim-value"]').exists()).toBe(false)
  })

  it('stores a changed grace', async () => {
    const w = mountSection()
    const input = w.get('[data-testid="limit-evolve-reclaim-value"]')
    await input.setValue('90')
    await input.trigger('change')
    expect(settingsGet(EVOLVE_RECLAIM_KEY, 0)).toBe(90)
  })
})

describe('Resource limits — servers left behind by closed panes', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    _resetResourceLimitsForTest()
  })

  const leftover = { pid: 4242, started_at: 1700000000.5, command: 'next-server PORT=3219', cwd: '/repo', rss: 47185920 }

  it('tracks by default, writes nothing, and scans nothing until asked', () => {
    const mock = createMockBackend()
    const w = mountSection(mock)
    expect(w.get('[data-testid="limit-detached-toggle"]').attributes('aria-checked')).toBe('true')
    expect(settingsGet(TRACK_DETACHED_KEY, 'unset')).toBe('unset')
    expect(mock.sent.some((m) => m.type === 'limits.detached.list')).toBe(false)
  })

  it('switching it off stores false and hides the list', async () => {
    const w = mountSection()
    await w.get('[data-testid="limit-detached-toggle"]').trigger('click')
    expect(settingsGet(TRACK_DETACHED_KEY, true)).toBe(false)
    expect(w.find('[data-testid="limit-detached-find"]').exists()).toBe(false)
  })

  it('lists leftovers on request and stops one only when clicked', async () => {
    const mock = createMockBackend()
    mock.setResponse('limits.detached.list', { ok: true, enabled: true, items: [leftover] })
    mock.setResponse('limits.detached.stop', { ok: true })
    const w = mountSection(mock)

    await w.get('[data-testid="limit-detached-find"]').trigger('click')
    await flushPromises()
    const rows = w.findAll('[data-testid="limit-detached-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('next-server PORT=3219')
    expect(rows[0].text()).toContain('/repo')
    expect(mock.sent.some((m) => m.type === 'limits.detached.stop')).toBe(false)

    await rows[0].get('[data-testid="limit-detached-stop"]').trigger('click')
    await flushPromises()
    const stop = mock.sent.filter((m) => m.type === 'limits.detached.stop')
    expect(stop.map((m) => m.payload)).toEqual([{ pid: 4242, started_at: 1700000000.5 }])
    expect(w.findAll('[data-testid="limit-detached-row"]')).toHaveLength(0)
  })

  it('says so when nothing is left behind', async () => {
    const mock = createMockBackend()
    mock.setResponse('limits.detached.list', { ok: true, enabled: true, items: [] })
    const w = mountSection(mock)
    await w.get('[data-testid="limit-detached-find"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="limit-detached-empty"]').exists()).toBe(true)
  })

  it('keeps the row and shows why when a stop is refused', async () => {
    const mock = createMockBackend()
    mock.setResponse('limits.detached.list', { ok: true, enabled: true, items: [leftover] })
    mock.setResponse('limits.detached.stop', { ok: false, error: 'that process has already exited' })
    const w = mountSection(mock)
    await w.get('[data-testid="limit-detached-find"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="limit-detached-stop"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-testid="limit-detached-row"]')).toHaveLength(1)
    expect(w.get('[data-testid="limit-detached-error"]').text()).toContain('already exited')
  })
})

describe('Resource limits — reclaim the focused pane too', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    _resetResourceLimitsForTest()
  })

  it('is off by default (the focused pane is never reclaimed) and writes nothing', () => {
    const w = mountSection()
    expect(w.get('[data-testid="limit-focused-reclaim-toggle"]').attributes('aria-checked')).toBe('false')
    expect(w.find('[data-testid="limit-focused-reclaim-value"]').exists()).toBe(false)
    expect(settingsGet(FOCUSED_RECLAIM_KEY, 'unset')).toBe('unset')
  })

  it('turning it on stores hours the sweep reads, and they are adjustable', async () => {
    const w = mountSection()
    await w.get('[data-testid="limit-focused-reclaim-toggle"]').trigger('click')
    expect(settingsGet(FOCUSED_RECLAIM_KEY, 0)).toBe(4)
    const input = w.get('[data-testid="limit-focused-reclaim-value"]')
    await input.setValue('12')
    await input.trigger('change')
    expect(settingsGet(FOCUSED_RECLAIM_KEY, 0)).toBe(12)
  })

  it('turning it off stores 0', async () => {
    const w = mountSection()
    const toggle = w.get('[data-testid="limit-focused-reclaim-toggle"]')
    await toggle.trigger('click')
    await toggle.trigger('click')
    expect(settingsGet(FOCUSED_RECLAIM_KEY, -1)).toBe(0)
  })
})

describe('Resource limits — Spotlight indexing', () => {
  const api = window as unknown as { agentTeam?: { openSpotlightSettings?: () => Promise<{ ok: boolean }> } }
  let open: ReturnType<typeof vi.fn>

  beforeEach(() => {
    open = vi.fn(async () => ({ ok: true }))
    api.agentTeam = { openSpotlightSettings: open }
  })
  afterEach(() => {
    delete api.agentTeam
    vi.unstubAllGlobals()
  })

  it('changes nothing on its own: the system settings open only on a click', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', userAgent: 'Macintosh' })
    const w = mountSection()
    expect(open).not.toHaveBeenCalled()
    await w.get('[data-testid="limit-spotlight-open"]').trigger('click')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('is not offered off macOS', () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'Win32', userAgent: 'Windows NT 10.0' })
    const w = mountSection()
    expect(w.find('[data-testid="limit-spotlight-open"]').exists()).toBe(false)
  })
})

describe('Resource limits — placement', () => {
  it('sits in Settings → General', () => {
    const modal = readFileSync(resolve(here, '../../SettingsModal.vue'), 'utf8')
    const general = modal.slice(modal.indexOf(`v-show="activeTab === 'general'"`), modal.indexOf(`v-show="activeTab === 'appearance'"`))
    expect(general).toContain('<ResourceLimitsSection :backend="backend"')
  })

  it.each(['en-US', 'zh-TW', 'ja-JP'] as const)('has its strings in %s', (locale) => {
    for (const key of [
      'settings.section.resource-limits',
      'settings.limits.hint',
      'settings.limits.test-workers',
      'settings.limits.test-workers-hint',
      'settings.limits.test-workers-value',
      'settings.limits.evolve-reclaim',
      'settings.limits.evolve-reclaim-hint',
      'settings.limits.evolve-reclaim-value',
      'settings.limits.focused-reclaim',
      'settings.limits.focused-reclaim-hint',
      'settings.limits.focused-reclaim-value',
      'settings.limits.spotlight',
      'settings.limits.spotlight-hint',
      'settings.limits.spotlight-open',
      'settings.limits.detached',
      'settings.limits.detached-hint',
      'settings.limits.detached-find',
      'settings.limits.detached-empty',
      'settings.limits.detached-stop',
    ]) {
      expect(i18n.global.te(key, locale), `${locale}: ${key}`).toBe(true)
    }
  })
})
