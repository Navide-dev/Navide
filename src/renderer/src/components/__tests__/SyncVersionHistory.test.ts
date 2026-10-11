// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import SyncVersionHistory from '../SyncVersionHistory.vue'

type Resp = { ok: boolean; payload?: unknown; error?: { message: string } }

function mockBackend(overrides: Record<string, Resp> = {}) {
  const responses: Record<string, Resp> = {
    'sync.inventory': {
      ok: true,
      payload: {
        scopes: {
          prompts: { scope: 'prompts', status: 'ok', items: [{ itemId: 'deploy' }, { itemId: 'review' }] },
        },
      },
    },
    'sync.versions': {
      ok: true,
      payload: {
        versions: [
          { rev: 7, updatedAt: '2026-10-10T08:00:00+00:00', deviceId: 'laptop', supersededAt: '2026-10-11T08:00:00+00:00' },
          { rev: 4, updatedAt: '2026-10-09T08:00:00+00:00', deviceId: 'desktop', supersededAt: '2026-10-10T08:00:00+00:00' },
        ],
      },
    },
    'sync.restore_version': { ok: true, payload: { held: false } },
    ...overrides,
  }
  const send = vi.fn(async (type: string, _payload?: unknown) => responses[type])
  return { backend: { send, on: vi.fn(() => () => {}) } as never, send }
}

async function mounted(overrides: Record<string, Resp> = {}) {
  i18n.global.locale.value = 'en-US'
  const m = mockBackend(overrides)
  const wrapper = mount(SyncVersionHistory, { props: { backend: m.backend }, global: { plugins: [i18n] } })
  await flushPromises()
  await wrapper.find('[data-test="history-open"]').trigger('click')
  await flushPromises()
  return { wrapper, ...m }
}

describe('SyncVersionHistory', () => {
  it('asks the backend for nothing until it is opened', async () => {
    i18n.global.locale.value = 'en-US'
    const m = mockBackend()
    mount(SyncVersionHistory, { props: { backend: m.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(m.send).not.toHaveBeenCalled()
  })

  it('lists the synced items of the chosen section', async () => {
    const { wrapper, send } = await mounted()
    expect(send).toHaveBeenCalledWith('sync.inventory', { scope: 'prompts' })
    const options = wrapper.findAll('[data-test="history-item"] option').map((o) => o.text())
    expect(options).toEqual(['deploy', 'review'])
  })

  it('shows an item’s earlier versions, newest first', async () => {
    const { wrapper, send } = await mounted()
    await wrapper.find('[data-test="history-show"]').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('sync.versions', { scope: 'prompts', itemId: 'deploy' })
    const rows = wrapper.findAll('[data-test="history-version"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('laptop')
  })

  it('restores the previous version and says it will sync', async () => {
    const { wrapper, send } = await mounted()
    await wrapper.find('[data-test="history-show"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="history-restore-previous"]').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('sync.restore_version', { scope: 'prompts', itemId: 'deploy', rev: 7 })
    expect(wrapper.text()).toContain(i18n.global.t('settings.sync.history-restored'))
  })

  it('says so when the restored version waits for approval', async () => {
    const { wrapper } = await mounted({ 'sync.restore_version': { ok: true, payload: { held: true } } })
    await wrapper.find('[data-test="history-show"]').trigger('click')
    await flushPromises()
    await wrapper.findAll('[data-test="history-restore"]')[1].trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain(i18n.global.t('settings.sync.history-held'))
  })

  it('does not claim a restore that applied nothing', async () => {
    const { wrapper } = await mounted({
      'sync.restore_version': { ok: true, payload: { held: false, outcome: 'not-applied' } },
    })
    await wrapper.find('[data-test="history-show"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="history-restore-previous"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain(i18n.global.t('settings.sync.history-not-applied'))
    expect(wrapper.text()).not.toContain(i18n.global.t('settings.sync.history-restored'))
  })

  it('shows the server’s refusal instead of an empty list', async () => {
    const { wrapper } = await mounted({
      'sync.versions': { ok: false, error: { message: 'VERSIONS_UNAVAILABLE: not on this account' } },
    })
    await wrapper.find('[data-test="history-show"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('VERSIONS_UNAVAILABLE')
    expect(wrapper.findAll('[data-test="history-version"]')).toHaveLength(0)
  })
})
