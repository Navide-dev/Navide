// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import AddAccountPanel from '../accounts/AddAccountPanel.vue'
import ApiKeyDetail from '../accounts/ApiKeyDetail.vue'
import type { ApiKeyRow, useApiKeys } from '../../composables/useApiKeys'

const FAKE_KEY = 'sk-ant-' + 'api03-' + 'fake7F2A'
const ROW: ApiKeyRow = {
  id: 'k1',
  kind: 'api-key',
  agentKey: 'claude',
  name: 'Project',
  last4: '7F2A',
  monthlyReminderUsd: 50,
  createdAt: 1,
}

function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    supportedAgents: { value: ['claude', 'codex'] },
    testPasted: vi.fn(async () => ({ ok: true, result: 'ok' })),
    testStored: vi.fn(async () => ({ ok: true, result: 'ok' })),
    create: vi.fn(async () => ({ ok: true, key: ROW })),
    update: vi.fn(async () => ({ ok: true, key: ROW })),
    replaceSecret: vi.fn(async () => ({ ok: true, key: ROW })),
    remove: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as ReturnType<typeof useApiKeys>
}

const AGENTS = [
  { agentKey: 'claude', label: 'Claude Code' },
  { agentKey: 'kimi', label: 'Kimi' },
]

function mountAdd(apiKeys = fakeApi(), agentKey = 'claude') {
  return mount(AddAccountPanel, {
    props: { apiKeys, agents: AGENTS, agentKey },
    global: { plugins: [i18n] },
  })
}

async function openForm(w: ReturnType<typeof mountAdd>): Promise<void> {
  await w.get('[data-way="api-key"]').trigger('click')
}

describe('AddAccountPanel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('hands the subscription path back to the page', async () => {
    const w = mountAdd()
    await w.findAll('.add-way')[0].trigger('click')
    expect(w.emitted('subscribe')).toEqual([['claude']])
  })

  it('keeps cloud services and custom endpoints visible but off', () => {
    const buttons = mountAdd().findAll('.add-way')
    expect(buttons.map((b) => b.attributes('disabled') !== undefined)).toEqual([false, false, true, true])
  })

  it('says so when a CLI has no API key support', () => {
    const way = mountAdd(fakeApi(), 'kimi').get('[data-way="api-key"]')
    expect(way.attributes('disabled')).toBeDefined()
  })

  it('saves and forgets the pasted key', async () => {
    const api = fakeApi()
    const w = mountAdd(api)
    await openForm(w)
    await w.get('#api-key-name').setValue('Project')
    await w.get('#api-key-secret').setValue(FAKE_KEY)
    await w.get('#api-key-reminder').setValue('50')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(api.create).toHaveBeenCalledWith('claude', 'Project', FAKE_KEY, 50)
    expect(w.emitted('saved')).toEqual([[ROW]])
  })

  it('blocks saving a key the vendor rejected, until it changes', async () => {
    const api = fakeApi({ testPasted: vi.fn(async () => ({ ok: true, result: 'rejected' })) })
    const w = mountAdd(api)
    await openForm(w)
    await w.get('#api-key-name').setValue('Project')
    await w.get('#api-key-secret').setValue(FAKE_KEY)
    const save = () => w.get('button[type="submit"]').attributes('disabled')
    expect(save()).toBeUndefined()
    await w.get('.ak-secret button').trigger('click')
    await flushPromises()
    expect(save()).toBeDefined()
    await w.get('#api-key-secret').setValue(FAKE_KEY + 'x')
    expect(save()).toBeUndefined()
  })

  it('shows the error for the code the backend sent', async () => {
    const api = fakeApi({ create: vi.fn(async () => ({ ok: false, error_code: 'subscription-token' })) })
    const w = mountAdd(api)
    await openForm(w)
    await w.get('#api-key-name').setValue('Project')
    await w.get('#api-key-secret').setValue(FAKE_KEY)
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(w.get('.ak-error').text()).toBe(i18n.global.t('settings.accounts.api-keys.error.subscription-token'))
    expect(w.text()).not.toContain(FAKE_KEY)
  })
})

describe('ApiKeyDetail', () => {
  function mountDetail(apiKeys = fakeApi()) {
    return mount(ApiKeyDetail, {
      props: { apiKeys, row: ROW, agentLabel: 'Claude Code' },
      global: { plugins: [i18n] },
    })
  }

  it('shows the suffix and says panes cannot use the key yet', () => {
    const w = mountDetail()
    expect(w.text()).toContain('7F2A')
    expect(w.text()).toContain(i18n.global.t('settings.accounts.api-keys.detail.not-in-use'))
  })

  it('offers no way to switch to a key', () => {
    const labels = mountDetail().findAll('button').map((b) => b.text())
    expect(labels).not.toContain(i18n.global.t('settings.accounts.cli.switch'))
  })

  it('replaces a key and clears the field', async () => {
    const api = fakeApi()
    const w = mountDetail(api)
    await w.findAll('.ak-actions button')[1].trigger('click')
    await w.get('#api-key-secret').setValue(FAKE_KEY)
    await w.get('.ak-btn.primary').trigger('click')
    await flushPromises()
    expect(api.replaceSecret).toHaveBeenCalledWith('k1', FAKE_KEY)
    expect(w.find('#api-key-secret').exists()).toBe(false)
  })
})
