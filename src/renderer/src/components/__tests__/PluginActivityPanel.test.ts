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

  // #397: a refused or failed call keeps no path, and an unknown capability no
  // name; what is shown says so and is styled apart from a real path.
  it('shows the fixed values in words, apart from real paths and commands', async () => {
    const report = {
      ...fixture,
      files: [
        { path: '<denied>', address: 'fs.readFile', workspace: '/w', outcome: 'denied', count: 7, lastAt: 1 },
        { path: '<failed>', address: 'fs.readFile', workspace: '/w', outcome: 'error', count: 3, lastAt: 1 },
        { path: 'src/a.py', address: 'fs.readFile', workspace: '/w', outcome: 'allowed', count: 1, lastAt: 1 },
      ],
      commands: [{ command: '<denied>', workspace: '/w', outcome: 'denied', count: 2, lastAt: 1 }],
      undeclared: [{ source: 'broker', address: '<unknown>', workspace: '/w', count: 4, lastAt: 1, reasons: [{ reason: 'undeclared', count: 4 }] }],
    }
    mockPlugins({ activityReport: vi.fn().mockResolvedValue({ ok: true, report }) })
    const panel = await render()
    const files = panel.findAll('.nv-activity-files li')
    expect(files[0].text()).toContain('path or command not kept: the call was refused')
    expect(files[1].text()).toContain('path or command not kept: the call failed')
    expect(files.map((li) => li.classes('nv-activity-marker'))).toEqual([true, true, false])
    expect(files[2].text()).toContain('src/a.py')
    expect(panel.get('.nv-activity-commands li').classes()).toContain('nv-activity-marker')
    expect(panel.text()).toContain('not a Navide capability')
    expect(panel.text()).not.toContain('<denied>')
  })

  // Review of #397 (MED-1): a fixed value counts only with the outcome it is
  // recorded for; an allowed path spelled like one is the plugin's own text.
  it('shows an allowed path spelled like a fixed value as a plain path', async () => {
    const file = (path: string, outcome = 'allowed') =>
      ({ path, address: 'fs.stat', workspace: '/w', outcome, count: 1, lastAt: 1 })
    const report = {
      ...fixture,
      files: [
        file('<denied>'), file('<failed>'), file('<unknown>'), file('./<missing>'), file('./<denied>'),
        file('<missing>'), file('<missing>', 'denied'),
      ],
      commands: [{ command: '<failed>', workspace: '/w', outcome: 'allowed', count: 1, lastAt: 1 }],
    }
    mockPlugins({ activityReport: vi.fn().mockResolvedValue({ ok: true, report }) })
    const panel = await render()
    const files = panel.findAll('.nv-activity-files li')
    expect(files.map((li) => li.classes('nv-activity-marker'))).toEqual([false, false, false, false, false, true, false])
    expect(files[0].text()).toContain('<denied>')
    expect(files[0].text()).not.toContain('the call was refused')
    expect(files[3].text()).toContain('./<missing>')
    expect(files[5].text()).toContain('path not kept: nothing usable was there')
    expect(panel.get('.nv-activity-commands li').classes()).not.toContain('nv-activity-marker')
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

  // Watchdog option C: the live usage of this backend against its thresholds.
  it('shows the backend usage against each threshold, what is over and what waits for a choice', async () => {
    const MiB = 1024 * 1024
    const status = {
      pluginId: 'nerdtechnic.devmap', name: 'Dev map', packageVersion: '0.2.0',
      usage: { memory: 600 * MiB, cpu: 0.2, processes: 2, disk: 10 * MiB, stdoutPending: 300 * MiB },
      thresholds: { memory: 512 * MiB, cpu: 0.95, processes: 8, disk: 1024 * MiB, stdoutPending: 256 * MiB },
      levels: { memory: 512 * MiB, cpu: 1.9, processes: 8, disk: 1024 * MiB, stdoutPending: 256 * MiB },
      waiting: ['memory'],
    }
    mockPlugins()
    ;((window as unknown as { agentTeam: { plugins: Record<string, unknown> } }).agentTeam.plugins).nativeBackends = {
      resourceStatus: vi.fn().mockResolvedValue([status]),
    }
    const resource = (await render()).get('.nv-activity-resources')
    const rows = resource.findAll('li').map((li) => li.text())
    expect(rows[0]).toContain('Memory: 600 MB of 512 MB')
    expect(rows[0]).toContain('over the threshold')
    expect(rows[0]).toContain('waiting for your choice')
    expect(rows[1]).toContain('CPU: 0.2 cores of 0.95 cores')
    expect(rows[1]).toContain('kept running; next notice above 1.9 cores')
    expect(rows[2]).toContain('Processes: 2 of 8')
    expect(rows[2]).not.toContain('over the threshold')
    expect(rows[4]).toContain('Stdout waiting for a line break: 300 MB of 256 MB')
    expect(rows[4]).toContain('over the threshold')
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

  // #397 merged with #396: a fixed value is words only with its outcome; any
  // other text, a marker spelling with an invisible character included, is
  // the plugin's and shows its invisible characters.
  it('words a fixed value only with its outcome and spells out invisible characters in anything else', async () => {
    const ZW = '\u200b'
    const file = (path: string, outcome: string) => ({ path, address: 'fs.stat', workspace: '/w', outcome, count: 1, lastAt: 1 })
    const report = { ...fixture, files: [file('<denied>', 'denied'), file(`<denied>${ZW}`, 'denied'), file('<denied>', 'allowed')] }
    mockPlugins({ activityReport: vi.fn().mockResolvedValue({ ok: true, report }) })
    const files = (await render()).findAll('.nv-activity-files li')
    expect(files.map((li) => li.classes('nv-activity-marker'))).toEqual([true, false, false])
    expect(files[0].text()).toContain('path or command not kept: the call was refused')
    expect(files[1].text()).not.toContain(ZW)
    expect(files[1].text()).toContain('<denied>')
    expect(files[2].text()).toContain('<denied>')
  })

  // Final review part 2 MED-1: text from the plugin shows its invisible characters.
  it('spells out invisible characters in every plugin-provided string', async () => {
    const ZW = '​'
    const RLO = '‮'
    const report = structuredClone(fixture)
    report.files[0].path = `src/${RLO}gnp.exe`
    report.files[0].address = `fs.read${ZW}File`
    report.commands[0].command = `git${ZW} status`
    report.undeclared[0].address = `shell${RLO}.run`
    report.undeclared[0].workspace = `/Users/me/${ZW}project`
    report.declaredUnused[0].key = `ai${ZW}Cli`
    report.toolCalls[0].tool = `devmap${RLO}_read`
    report.anomalies[1].workspace = `/Users/${RLO}me`
    report.anomalies[1].tool = `devmap${ZW}_write`
    report.agentActions = [{ at: 1, action: `enable${ZW}`, callerKind: 'pane', paneId: 'p-1', paneName: 'dev', workspace: '/w', version: `1.0.0${RLO}` }]
    mockPlugins({ activityReport: vi.fn().mockResolvedValue({ ok: true, report }) })
    const panel = await render()
    const text = panel.text()
    expect(text).not.toContain(ZW)
    expect(text).not.toContain(RLO)
    expect(panel.get('.nv-activity-files').text()).toContain('src/\\u{202e}gnp.exe')
    expect(panel.get('.nv-activity-files').text()).toContain('fs.read\\u{200b}File')
    expect(panel.get('.nv-activity-commands').text()).toContain('git\\u{200b} status')
    expect(panel.get('.nv-activity-undeclared').text()).toContain('shell\\u{202e}.run')
    expect(panel.get('.nv-activity-undeclared').text()).toContain('/Users/me/\\u{200b}project')
    expect(panel.get('.nv-activity-unused').text()).toContain('ai\\u{200b}Cli')
    expect(panel.get('.nv-activity-tools').text()).toContain('devmap\\u{202e}_read')
    expect(panel.get('.nv-activity-anomalies').text()).toContain('/Users/\\u{202e}me')
    expect(panel.get('.nv-activity-anomalies').text()).toContain('devmap\\u{200b}_write')
    expect(panel.get('.nv-activity-actions').text()).toContain('enable\\u{200b}')
    expect(panel.get('.nv-activity-actions').text()).toContain('1.0.0\\u{202e}')
    expect(panel.find('a').exists()).toBe(false)
  })

  it('shows ordinary strings exactly as given', async () => {
    mockPlugins()
    const panel = await render()
    expect(panel.text()).not.toContain('\\u{')
    expect(panel.get('.nv-activity-files').text()).toContain('docs/devmap.md')
    expect(panel.get('.nv-activity-commands').text()).toContain('git status')
    expect(panel.get('.nv-activity-unused').text()).toContain('aiCli')
  })
})
