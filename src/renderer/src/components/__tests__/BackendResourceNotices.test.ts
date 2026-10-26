// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import BackendResourceNotices from '../BackendResourceNotices.vue'

const MiB = 1024 * 1024
const memory = {
  id: 'n-1', pluginId: 'acme.indexer', name: 'Indexer', packageVersion: '1.0.0',
  item: 'memory' as const, usage: 600 * MiB, threshold: 512 * MiB, at: 1,
}
const cpu = { ...memory, id: 'n-2', item: 'cpu' as const, usage: 1.4, threshold: 0.95 }

let wrapper: VueWrapper | undefined
let saved: typeof i18n.global.locale.value
let changed: (() => void) | null = null

function mockApi(notices: () => unknown[]) {
  const api = {
    resourceNotices: vi.fn(async () => notices()),
    answerResourceNotice: vi.fn(async () => true),
    onResourceNoticesChanged: vi.fn((handler: () => void) => {
      changed = handler
      return () => { changed = null }
    }),
  }
  ;(window as unknown as Record<string, unknown>).agentTeam = { plugins: { nativeBackends: api } }
  return api
}

beforeEach(() => {
  saved = i18n.global.locale.value
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = saved
  delete (window as unknown as Record<string, unknown>).agentTeam
})

describe('BackendResourceNotices (watchdog option C)', () => {
  it('shows each notice with the plugin, the item and the usage, and both choices', async () => {
    mockApi(() => [memory, cpu])
    wrapper = mount(BackendResourceNotices, { global: { plugins: [i18n] } })
    await flushPromises()
    const items = wrapper.findAll('.nv-resource-notice')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('Indexer (acme.indexer 1.0.0)')
    expect(items[0].text()).toContain('memory is 600 MB, over its threshold of 512 MB')
    expect(items[1].text()).toContain('CPU is 1.4 cores, over its threshold of 0.95 cores')
    expect(items[0].text()).toContain('It keeps running until you choose.')
    expect(items[0].text()).toContain('twice the current level')
    expect(items[0].find('.nv-resource-stop').exists()).toBe(true)
    expect(items[0].find('.nv-resource-continue').exists()).toBe(true)
  })

  it('passes the choice on and reads the list again', async () => {
    let list: unknown[] = [memory]
    const api = mockApi(() => list)
    wrapper = mount(BackendResourceNotices, { global: { plugins: [i18n] } })
    await flushPromises()
    list = []
    await wrapper.get('.nv-resource-continue').trigger('click')
    await flushPromises()
    expect(api.answerResourceNotice).toHaveBeenCalledWith('n-1', 'continue')
    expect(wrapper.findAll('.nv-resource-notice')).toHaveLength(0)
  })

  it('reads the list when it mounts and whenever the Host says it changed (nothing is lost while loading)', async () => {
    let list: unknown[] = []
    const api = mockApi(() => list)
    wrapper = mount(BackendResourceNotices, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(api.resourceNotices).toHaveBeenCalledTimes(1)
    list = [memory]
    changed!()
    await flushPromises()
    expect(wrapper.findAll('.nv-resource-notice')).toHaveLength(1)
    wrapper.unmount()
    wrapper = undefined
    expect(changed).toBeNull()
  })

  it.each(['en-US', 'zh-TW', 'ja-JP'] as const)('renders without a missing string (%s)', async (locale) => {
    i18n.global.locale.value = locale
    mockApi(() => [memory, cpu, { ...memory, id: 'n-3', item: 'processes', usage: 9, threshold: 8 }, { ...memory, id: 'n-4', item: 'disk' }])
    wrapper = mount(BackendResourceNotices, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.text()).not.toMatch(/backendResource\./)
  })

  // Final review part 2 MED-1: the name the user decides on cannot hide or reorder text.
  it('spells out invisible characters in the plugin name, id and version; ordinary text is unchanged', async () => {
    mockApi(() => [
      { ...memory, name: 'Navide​ Git‮', pluginId: 'acme.‮indexer', packageVersion: '1.0.0​' },
      memory,
    ])
    wrapper = mount(BackendResourceNotices, { global: { plugins: [i18n] } })
    await flushPromises()
    const items = wrapper.findAll('.nv-resource-notice')
    expect(items[0].text()).toContain('Navide\\u{200b} Git\\u{202e} (acme.\\u{202e}indexer 1.0.0\\u{200b})')
    expect(items[0].text()).not.toMatch(/[​‮]/)
    expect(items[1].text()).toContain('Indexer (acme.indexer 1.0.0)')
  })
})
