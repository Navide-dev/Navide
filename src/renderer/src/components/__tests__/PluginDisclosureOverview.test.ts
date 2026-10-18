// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PluginDisclosureOverview from '../PluginDisclosureOverview.vue'
import { computeDisclosure } from '../../../../shared/pluginDisclosure'

const report = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/activity-report.json'), 'utf8')
).valid
const disclosure = computeDisclosure({
  schemaVersion: 2, id: 'nerdtechnic.devmap', version: '0.2.0', publisher: 'nerdtechnic', permissions: { shell: 'allowlist' },
} as never)

let wrapper: VueWrapper | undefined
let saved: typeof i18n.global.locale.value
beforeEach(() => {
  saved = i18n.global.locale.value
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  wrapper?.unmount()
  i18n.global.locale.value = saved
  delete (window as unknown as Record<string, unknown>).agentTeam
})

describe('PluginDisclosureOverview (D5, D-f)', () => {
  it('shows each installed plugin with its card, recent activity and unusual items on one page', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        installedDisclosures: vi.fn().mockResolvedValue([
          { id: 'nerdtechnic.devmap', version: '0.2.0', disclosure, scan: null },
          { id: 'acme.quiet', version: '1.0.0', disclosure: null, scan: null },
        ]),
        activityReport: vi.fn(async (id: string) => id === 'nerdtechnic.devmap'
          ? { ok: true, report }
          : { ok: false, error: 'Navide Host session is not ready' }),
      },
    }
    wrapper = mount(PluginDisclosureOverview, { global: { plugins: [i18n] } })
    await flushPromises()

    const devmap = wrapper.get('[data-id="nerdtechnic.devmap"]')
    expect(devmap.find('.nv-disclosure-level--high').exists()).toBe(true)
    expect(devmap.text()).toContain('42 calls, 3 refused, 1 errors')
    expect(devmap.get('.nv-overview-undeclared').text()).toBe('3 undeclared uses refused')
    expect(devmap.text()).toContain('3 unusual items')
    // Nothing on the page is a link; the full panel is mounted only when opened.
    expect(wrapper.find('a').exists()).toBe(false)
    expect(devmap.find('.nv-activity').exists()).toBe(false)
    expect(wrapper.get('[data-id="acme.quiet"]').text()).toContain('Activity is not available right now: Navide Host session is not ready')
  })

  it('says when no Marketplace plugin is installed', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: { installedDisclosures: vi.fn().mockResolvedValue([]) } }
    wrapper = mount(PluginDisclosureOverview, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.text()).toContain('No Navide plugin from the Navide Marketplace is installed.')
  })

  // Final review part 2 MED-1.
  it('spells out invisible characters in the plugin id and version', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        installedDisclosures: vi.fn().mockResolvedValue([
          { id: 'acme.‮quiet', version: '1.0.0​', disclosure: null, scan: null },
          { id: 'acme.plain', version: '2.0.0', disclosure: null, scan: null },
        ]),
        activityReport: vi.fn(async () => ({ ok: true, report })),
      },
    }
    wrapper = mount(PluginDisclosureOverview, { global: { plugins: [i18n] } })
    await flushPromises()
    const names = wrapper.findAll('.nv-overview-name').map((h) => h.text())
    expect(names[0]).toBe('acme.\\u{202e}quiet 1.0.0\\u{200b}')
    expect(names[1]).toBe('acme.plain 2.0.0')
  })

  // #415 review MED-2: an open activity panel stops polling with the overview.
  it('stops the open activity panel polling while paused and resumes it after', async () => {
    vi.useFakeTimers()
    try {
      const backendCallConcurrency = vi.fn(async () => [])
      ;(window as unknown as Record<string, unknown>).agentTeam = {
        plugins: {
          installedDisclosures: vi.fn().mockResolvedValue([{ id: 'acme.one', version: '1.0.0', disclosure: null, scan: null }]),
          activityReport: vi.fn(async () => ({ ok: true, report })),
          backendCallConcurrency,
          backendResourceUsage: vi.fn(async () => null),
        },
      }
      wrapper = mount(PluginDisclosureOverview, { global: { plugins: [i18n] } })
      await flushPromises()
      const details = wrapper.get('.nv-overview-details').element as HTMLDetailsElement
      details.open = true
      await wrapper.get('.nv-overview-details').trigger('toggle')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(backendCallConcurrency).toHaveBeenCalledTimes(2)

      await wrapper.setProps({ paused: true })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(backendCallConcurrency).toHaveBeenCalledTimes(2)

      await wrapper.setProps({ paused: false })
      await flushPromises()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(backendCallConcurrency.mock.calls.length).toBeGreaterThan(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PluginDisclosureOverview source row (K2)', () => {
  it('gives a card the source row the Host names, and never guesses one', async () => {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        installedDisclosures: vi.fn().mockResolvedValue([
          { id: 'nerdtechnic.devmap', version: '0.2.0', disclosure, scan: null },
          { id: 'acme.pre', version: '2.0.0-beta.1', disclosure: null, scan: null, source: 'prerelease' },
          { id: 'acme.beta', version: '3.0.0-rc.1', disclosure: null, scan: null },
          { id: 'acme.mkt', version: '1.0.0', disclosure: null, scan: null, source: 'marketplace' },
          { id: 'acme.tp', version: '1.0.0', disclosure: null, scan: null, source: 'testplace', expiresAt: '2027-01-17T00:00:00Z' },
        ]),
        activityReport: vi.fn(async () => ({ ok: false, error: 'not ready' })),
      },
    }
    wrapper = mount(PluginDisclosureOverview, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-id="nerdtechnic.devmap"] .nv-source-row').exists()).toBe(false)
    expect(wrapper.get('[data-id="acme.pre"] .nv-source-row').attributes('data-source')).toBe('prerelease')
    expect(wrapper.find('[data-id="acme.beta"] .nv-source-row').exists()).toBe(false)
    // Without a Host source nothing reads as reviewed (a pre-release or testplace build included).
    for (const id of ['nerdtechnic.devmap', 'acme.beta']) {
      expect(wrapper.get(`[data-id="${id}"]`).text()).not.toMatch(/Reviewed|reviewed/)
    }
    expect(wrapper.get('[data-id="acme.mkt"] .nv-source-row').text()).toBe('Source and review Reviewed')
    expect(wrapper.get('[data-id="acme.tp"] .nv-source-row').text()).toBe('Source and review Test build, no human review, expires 2027-01-17')
  })
})
