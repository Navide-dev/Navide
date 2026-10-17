// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginActivityPanel from '../PluginActivityPanel.vue'

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/activity-report.json'), 'utf8')
).valid

function usage(bytes: number) {
  const queue = (b: number) => ({ frames: b > 0 ? 2 : 0, bytes: b, peakFrames: 2, peakBytes: b })
  return {
    children: { current: 1, peak: 1, retained: 0 },
    views: [{
      pluginId: 'nerdtechnic.devmap', instanceId: 'v1', subscriptions: { current: 1, peak: 1 },
      child: {
        subscriptions: { current: 1, peak: 1 }, bridgeRequests: { current: 0, peak: 1 },
        outputQueue: { requests: queue(bytes), notifications: queue(bytes / 2) }, droppedNotifications: 0,
      },
    }],
    plugins: [],
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
    activityReport: vi.fn().mockResolvedValue({ ok: true, report: fixture }),
    backendCallConcurrency: vi.fn().mockResolvedValue([{ pluginId: 'nerdtechnic.devmap', current: 1, peak: 3, droppedNotifications: 0 }]),
    ...overrides,
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: api }
  return api
}

async function render(pollMs = 5000) {
  wrapper = mount(PluginActivityPanel, { props: { pluginId: 'nerdtechnic.devmap', pollMs }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

describe('PluginActivityPanel (D-f)', () => {
  it('shows unknown sizes as unknown and never adds them up', async () => {
    mockPlugins()
    const text = (await render()).text()
    expect(text).toContain('arguments unknown, result unknown')
    expect(text).toContain('Arguments 16 B and results 2.0 KB in total; 2 sizes are unknown and not counted')
  })

  it('shows paths and commands as plain text, never as links or HTML', async () => {
    mockPlugins()
    const panel = await render()
    const files = panel.get('.nv-activity-files').text()
    expect(files).toContain('javascript:alert(1)')
    expect(files).toContain('mailto:someone@example.com')
    expect(panel.find('a').exists()).toBe(false)
    expect(panel.html()).not.toMatch(/href=/)
  })

  it('marks undeclared uses in red with their reasons, and anomalies as marks only', async () => {
    mockPlugins()
    const panel = await render()
    const undeclared = panel.get('.nv-activity-undeclared').text()
    // Review L5 on #371: sources, kinds and reasons are worded, not codes.
    expect(undeclared).toContain('shell.run (shell command)')
    expect(undeclared).toContain('not declared × 2')
    expect(undeclared).toContain('EXECUTION_POLICY_DENIED × 1')
    expect(panel.get('.nv-activity-anomalies').text()).toContain('more than 10 times the 7-day average (2.1)')
    const unused = panel.get('.nv-activity-unused').text()
    expect(unused).toContain('Permission: aiCli · never used')
    expect(unused).toContain('Agent tool: devmap_reset')
  })

  it('keeps the live numbers apart from the historical one, and says what children count', async () => {
    mockPlugins({ backendResourceUsage: vi.fn().mockResolvedValue(usage(100)) })
    const text = (await render()).text()
    expect(text).toContain('Calls in progress: 1 (at most 3 at once since Navide started)')
    expect(text).toContain('Most calls at once in the records: 2 (last 7 days)')
    expect(text).toContain('Views bound to a backend: 1 (not the number of running processes)')
  })

  it('says when the queue to the backend keeps growing, without stopping anything', async () => {
    vi.useFakeTimers()
    let bytes = 100
    const backendResourceUsage = vi.fn(async () => usage((bytes += 1000)))
    mockPlugins({ backendResourceUsage })
    const panel = await render(1000)
    expect(panel.find('.nv-activity-queue-growing').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    await flushPromises()
    expect(panel.get('.nv-activity-queue-growing').text()).toBe("This Navide plugin's backend is not reading; Navide's memory keeps growing.")
  })

  it('says why when the report is not available', async () => {
    mockPlugins({ activityReport: vi.fn().mockResolvedValue({ ok: false, error: 'Navide Host session is not ready' }) })
    expect((await render()).get('.nv-activity-error').text()).toBe('Activity is not available right now: Navide Host session is not ready')
  })

  it.each(['en-US', 'zh-TW', 'ja-JP'] as const)('renders without a missing string (%s)', async (locale) => {
    i18n.global.locale.value = locale
    mockPlugins({ backendResourceUsage: vi.fn().mockResolvedValue(usage(100)) })
    expect((await render()).text()).not.toMatch(/pluginActivity\./)
  })
})
