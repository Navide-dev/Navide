// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginActivityMonitor from '../PluginActivityMonitor.vue'

const ITEMS = ['memory', 'cpu', 'processes', 'disk', 'stdoutPending'] as const
const values = (n: number) => Object.fromEntries(ITEMS.map((item) => [item, n])) as Record<(typeof ITEMS)[number], number>

function overview() {
  return {
    schemaVersion: 1,
    generatedAt: 1,
    plugins: [
      {
        pluginId: 'acme.grok', toolCallsLastMinute: 61, capabilityCallsLastMinute: 8, consecutiveFailures: 3,
        hosts: [
          { host: 'grok.com', refused: false, lastAt: 3, declared: true },
          { host: 'api.unknown.io', refused: false, lastAt: 2, declared: false },
          { host: 'evil.io', refused: true, lastAt: 1, declared: false },
        ],
      },
      { pluginId: 'navide.plans', toolCallsLastMinute: 0, capabilityCallsLastMinute: 0, consecutiveFailures: 0, hosts: [] },
    ],
  }
}

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
    listInstalled: vi.fn().mockResolvedValue([
      { id: 'acme.grok', requires: [], sensitive: [], packageVersion: '1.2.0', provenance: 'official-registry', disabled: false },
      { id: 'acme.off', requires: [], sensitive: [], packageVersion: '0.1.0', provenance: 'official-registry', disabled: true },
      { id: 'navide.plans', requires: [], sensitive: [], packageVersion: '1.1.0', provenance: 'factory-bundled' },
    ]),
    disabledBuiltins: vi.fn().mockResolvedValue([]),
    activityOverview: vi.fn().mockResolvedValue({ ok: true, overview: overview() }),
    activityReport: vi.fn().mockResolvedValue({ ok: false, error: 'not in this test' }),
    backendCallConcurrency: vi.fn().mockResolvedValue([]),
    stop: vi.fn().mockResolvedValue({ id: '', disabled: true, changed: true, summary: {} }),
    stopAll: vi.fn().mockResolvedValue({ stopped: ['acme.grok'], failed: [] }),
    resumeAll: vi.fn().mockResolvedValue({ resumed: ['acme.grok'], failed: [] }),
    globalStopState: vi.fn().mockResolvedValue(null),
    nativeBackends: {
      resourceStatus: vi.fn().mockResolvedValue([
        { pluginId: 'acme.grok', name: 'Grok', packageVersion: '1.2.0', usage: { ...values(1), memory: 210 * 1024 * 1024, processes: 9 }, thresholds: values(8), levels: values(0), waiting: [] },
      ]),
    },
    ...overrides,
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

async function render(props: Record<string, unknown> = {}) {
  wrapper = mount(PluginActivityMonitor, { props, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

function row(w: VueWrapper, id: string) {
  return w.get(`.nv-monitor-row[data-id="${id}"]`)
}

describe('PluginActivityMonitor (plan P1)', () => {
  it('shows every installed plugin on one table with its last-minute counts, hosts, failures and resources', async () => {
    mockPlugins()
    const w = await render()
    expect(w.findAll('.nv-monitor-row').map((r) => r.attributes('data-id'))).toEqual(['acme.grok', 'acme.off', 'navide.plans'])
    const grok = row(w, 'acme.grok').findAll('td').map((cell) => cell.text())
    expect(grok[0]).toBe('Running')
    expect(grok.slice(1, 3)).toEqual(['61', '8'])
    expect(grok[3]).toContain('grok.com')
    expect(grok[4]).toBe('3')
    expect(grok[5]).toContain('210 MB')
    expect(grok[5]).toContain('over the threshold')
    expect(row(w, 'acme.off').text()).toContain('Disabled')
    // No overview row: nothing is guessed.
    expect(row(w, 'acme.off').findAll('td').map((cell) => cell.text()).slice(1, 3)).toEqual(['—', '—'])
    expect(row(w, 'navide.plans').text()).toContain('built-in')
    expect(row(w, 'navide.plans').text()).toContain('No backend')
  })

  it('marks a host the manifest does not declare, and a refused one, in red', async () => {
    mockPlugins()
    const hosts = row(await render(), 'acme.grok').findAll('.nv-monitor-host')
    expect(hosts.map((h) => [h.text(), h.classes('nv-monitor-host--flagged')])).toEqual([
      ['grok.com', false],
      ['api.unknown.io (not declared)', true],
      ['evil.io (refused)', true],
    ])
  })

  it('opens the existing Activity panel of a row', async () => {
    const api = mockPlugins()
    const w = await render()
    await row(w, 'acme.grok').get('.nv-monitor-open').trigger('click')
    await flushPromises()
    expect(w.find('.nv-monitor-detail .nv-activity').exists()).toBe(true)
    expect(api.activityReport).toHaveBeenCalledWith('acme.grok')
    await row(w, 'acme.grok').get('.nv-monitor-open').trigger('click')
    expect(w.find('.nv-monitor-detail').exists()).toBe(false)
  })

  it('says why when the overview cannot be read, and still lists the plugins', async () => {
    mockPlugins({ activityOverview: vi.fn().mockResolvedValue({ ok: false, error: 'Navide Host session is not ready' }) })
    const w = await render()
    expect(w.get('.nv-monitor-error').text()).toContain('Navide Host session is not ready')
    expect(w.findAll('.nv-monitor-row')).toHaveLength(3)
  })

  it('P2: stops a running third-party plugin after a second press, never a bundled or disabled one', async () => {
    const api = mockPlugins()
    const w = await render()
    expect(row(w, 'navide.plans').find('.nv-monitor-stop').exists()).toBe(false)
    expect(row(w, 'acme.off').find('.nv-monitor-stop').exists()).toBe(false)
    const stop = () => row(w, 'acme.grok').get('.nv-monitor-stop')
    expect(stop().text()).toBe('Stop')
    await stop().trigger('click')
    expect(api.stop).not.toHaveBeenCalled()
    expect(stop().text()).toBe('Stop now')
    await row(w, 'acme.grok').get('.nv-monitor-cancel').trigger('click')
    expect(stop().text()).toBe('Stop')
    await stop().trigger('click')
    await stop().trigger('click')
    await flushPromises()
    expect(api.stop).toHaveBeenCalledWith('acme.grok', 'settings')
    // The table is read again after the stop.
    expect(api.activityOverview).toHaveBeenCalledTimes(2)
  })

  it('P2: says why a stop failed', async () => {
    mockPlugins({ stop: vi.fn().mockRejectedValue(new Error('drain failed')) })
    const w = await render()
    await row(w, 'acme.grok').get('.nv-monitor-stop').trigger('click')
    await row(w, 'acme.grok').get('.nv-monitor-stop').trigger('click')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toBe('acme.grok could not be stopped: drain failed')
  })

  it('P3: Stop all after a second press, then the stopped banner offers Resume all', async () => {
    const api = mockPlugins()
    const w = await render()
    await w.get('.nv-monitor-stop-all').trigger('click')
    expect(api.stopAll).not.toHaveBeenCalled()
    expect(w.get('.nv-monitor-stop-all').text()).toBe('Stop all now')
    api.globalStopState.mockResolvedValue({
      at: 1_792_108_800_000, via: 'settings', by: 'user', stopped: ['acme.grok'],
      previous: { nativeBackends: true, agentTools: true, externalCallers: false },
    })
    await w.get('.nv-monitor-stop-all').trigger('click')
    await flushPromises()
    expect(api.stopAll).toHaveBeenCalledWith('settings')
    expect(w.find('.nv-monitor-stop-all').exists()).toBe(false)
    expect(w.get('.nv-monitor-global').text()).toContain('Every third-party Navide plugin is stopped.')
    expect(w.get('.nv-monitor-global').text()).toContain('1 Navide plugins')
    await w.get('.nv-monitor-resume-all').trigger('click')
    expect(api.resumeAll).not.toHaveBeenCalled()
    await w.get('.nv-monitor-resume-all').trigger('click')
    await flushPromises()
    expect(api.resumeAll).toHaveBeenCalledTimes(1)
  })

  it('polls while shown and stops while paused', async () => {
    vi.useFakeTimers()
    const api = mockPlugins()
    const w = await render({ pollMs: 1000 })
    expect(api.activityOverview).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.activityOverview).toHaveBeenCalledTimes(2)
    await w.setProps({ paused: true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.activityOverview).toHaveBeenCalledTimes(2)
  })
})
