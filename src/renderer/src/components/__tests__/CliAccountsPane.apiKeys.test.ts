// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { computed, ref } from 'vue'
import AddAccountPanel from '../accounts/AddAccountPanel.vue'
import ApiKeyDetail from '../accounts/ApiKeyDetail.vue'
import CliAccountsPane from '../CliAccountsPane.vue'
import { apiKeyAccountCalls, isApiKeyProfile, type ApiKeyProfile } from '../accounts/apiKeyAccount'

const platform = vi.hoisted(() => ({ windows: false }))
vi.mock('../../../../shared/osplat', async (original) => ({
  ...(await original<object>()),
  isWindows: () => platform.windows,
}))

const FAKE_KEY = 'sk-ant-' + 'api03-' + 'fake7F2A'
const ROW: ApiKeyProfile = {
  id: 'k1',
  agentKey: 'claude',
  name: 'Project',
  createdAt: '2026-11-01',
  authKind: 'api-key',
  last4: '7F2A',
  monthlyReminderUsd: 50,
  autoSwitch: false,
}

type Calls = ReturnType<typeof apiKeyAccountCalls>

function fakeCalls(overrides: Partial<Record<keyof Calls, unknown>> = {}): Calls {
  return {
    testPasted: vi.fn(async () => ({ ok: true, result: 'ok' })),
    testStored: vi.fn(async () => ({ ok: true, result: 'ok' })),
    create: vi.fn(async () => ({ ok: true, profile: ROW })),
    update: vi.fn(async () => ({ ok: true, profile: ROW })),
    replaceSecret: vi.fn(async () => ({ ok: true, profile: ROW })),
    remove: vi.fn(async () => ({ ok: true })),
    ...overrides,
  } as unknown as Calls
}

const AGENTS = [
  { agentKey: 'claude', label: 'Claude Code' },
  { agentKey: 'kimi', label: 'Kimi' },
]

beforeEach(() => {
  vi.clearAllMocks()
  platform.windows = false
})

describe('apiKeyAccountCalls', () => {
  it('reads the answer from the envelope payload', async () => {
    const send = vi.fn(async () => ({ ok: true, payload: { ok: false, error_code: 'wrong-vendor' } }))
    const calls = apiKeyAccountCalls({ send } as never)
    expect(await calls.create('claude', 'n', FAKE_KEY, null)).toEqual({ ok: false, error_code: 'wrong-vendor' })
    expect(send).toHaveBeenCalledWith('cli_profiles.api_key_create', {
      agentKey: 'claude', name: 'n', secret: FAKE_KEY, monthlyReminderUsd: null,
    })
  })

  it('answers instead of throwing when the backend is gone', async () => {
    const calls = apiKeyAccountCalls({ send: vi.fn(async () => { throw new Error('down') }) } as never)
    expect(await calls.remove('k1')).toEqual({ ok: false, error_code: 'internal-error' })
  })
})

describe('isApiKeyProfile', () => {
  it('is false for a login account, which has no authKind', () => {
    expect(isApiKeyProfile({ id: 'a', agentKey: 'claude', name: 'A', createdAt: '' })).toBe(false)
    expect(isApiKeyProfile(null)).toBe(false)
    expect(isApiKeyProfile(ROW)).toBe(true)
  })
})

describe('AddAccountPanel', () => {
  function mountAdd(calls = fakeCalls(), agentKey = 'claude') {
    return mount(AddAccountPanel, {
      props: { calls, agents: AGENTS, agentKey, scopes: [], scope: '' },
      global: { plugins: [i18n] },
    })
  }

  async function openForm(w: ReturnType<typeof mountAdd>): Promise<void> {
    await w.get('[data-way="api-key"]').trigger('click')
  }

  it('hands the sign-in path back to the page', async () => {
    const w = mountAdd()
    await w.findAll('.add-way')[0].trigger('click')
    expect(w.emitted('subscribe')).toEqual([['claude']])
  })

  it('keeps cloud services and custom endpoints visible but off', () => {
    const buttons = mountAdd().findAll('.add-way')
    expect(buttons.map((b) => b.attributes('disabled') !== undefined)).toEqual([false, false, true, true])
  })

  it('says so when a CLI has no API key support', () => {
    expect(mountAdd(fakeCalls(), 'kimi').get('[data-way="api-key"]').attributes('disabled')).toBeDefined()
  })

  it('turns off Claude API keys on Windows and says why before anything is pasted', () => {
    platform.windows = true
    const way = mountAdd().get('[data-way="api-key"]')
    expect(way.attributes('disabled')).toBeDefined()
    expect(way.text()).toContain(i18n.global.t('settings.accounts.api-keys.error.unsupported-platform'))
  })

  it('leaves Codex API keys on, on Windows too', () => {
    platform.windows = true
    expect(mountAdd(fakeCalls(), 'codex').get('[data-way="api-key"]').attributes('disabled')).toBeUndefined()
  })

  it('saves and forgets the pasted key', async () => {
    const calls = fakeCalls()
    const w = mountAdd(calls)
    await openForm(w)
    await w.get('#api-key-name').setValue('Project')
    await w.get('#api-key-secret').setValue(FAKE_KEY)
    await w.get('#api-key-reminder').setValue('50')
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(calls.create).toHaveBeenCalledWith('claude', 'Project', FAKE_KEY, 50)
    expect(w.emitted('saved')).toEqual([[ROW]])
    expect((w.get('#api-key-secret').element as HTMLInputElement).value).toBe('')
  })

  it('forgets the pasted key on cancel', async () => {
    const w = mountAdd()
    await openForm(w)
    await w.get('#api-key-secret').setValue(FAKE_KEY)
    await w.findAll('.ak-actions button')[0].trigger('click')
    await openForm(w)
    expect((w.get('#api-key-secret').element as HTMLInputElement).value).toBe('')
  })

  it('blocks saving a key the vendor rejected, until it changes', async () => {
    const calls = fakeCalls({ testPasted: vi.fn(async () => ({ ok: true, result: 'rejected' })) })
    const w = mountAdd(calls)
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

  it.each(['subscription-token', 'unsupported-platform'])('shows the %s error the backend sent', async (code) => {
    const calls = fakeCalls({ create: vi.fn(async () => ({ ok: false, error_code: code })) })
    const w = mountAdd(calls)
    await openForm(w)
    await w.get('#api-key-name').setValue('Project')
    await w.get('#api-key-secret').setValue(FAKE_KEY)
    await w.get('form').trigger('submit')
    await flushPromises()
    expect(w.get('.ak-error').text()).toBe(i18n.global.t(`settings.accounts.api-keys.error.${code}`))
    expect(w.text()).not.toContain(FAKE_KEY)
  })
})

describe('ApiKeyDetail', () => {
  function mountDetail(calls = fakeCalls(), props: Record<string, unknown> = {}) {
    return mount(ApiKeyDetail, {
      props: { calls, row: ROW, agentLabel: 'Claude Code', inUse: false, switching: false, ...props },
      global: { plugins: [i18n] },
    })
  }

  it('shows the last four, and no quota figure', () => {
    const text = mountDetail().text()
    expect(text).toContain('7F2A')
    expect(text).not.toContain('%')
  })

  it('makes no promise about agents', () => {
    expect(mountDetail().findAll('.ak-safe li')).toHaveLength(2)
  })

  it('writes the auto-switch opt-in, which starts off', async () => {
    const calls = fakeCalls()
    const w = mountDetail(calls)
    const toggle = w.get('[data-testid="api-key-auto-switch"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    expect(calls.update).toHaveBeenCalledWith('k1', { autoSwitch: true })
  })

  it('tests the stored key by id', async () => {
    const calls = fakeCalls()
    const w = mountDetail(calls)
    await w.get('[data-testid="api-key-test"]').trigger('click')
    await flushPromises()
    expect(calls.testStored).toHaveBeenCalledWith('k1')
    expect(w.get('.ak-result').text()).toBe(i18n.global.t('settings.accounts.api-keys.form.test-ok'))
  })

  it('replaces a key and clears the field', async () => {
    const calls = fakeCalls()
    const w = mountDetail(calls)
    await w.get('[data-testid="api-key-replace"]').trigger('click')
    await w.get('#api-key-secret').setValue(FAKE_KEY)
    await w.get('.ak-btn.primary').trigger('click')
    await flushPromises()
    expect(calls.replaceSecret).toHaveBeenCalledWith('k1', FAKE_KEY)
    expect(w.find('#api-key-secret').exists()).toBe(false)
  })

  it('tells a Claude account it applies to new panes', () => {
    const w = mountDetail()
    expect(w.get('[data-testid="api-key-switch"]').text()).toBe(i18n.global.t('settings.accounts.api-keys.detail.use-for-new-panes'))
    expect(w.text()).toContain(i18n.global.t('settings.accounts.api-keys.detail.switch-hint'))
  })

  it('offers a Codex account the plain switch', () => {
    const w = mountDetail(fakeCalls(), { row: { ...ROW, agentKey: 'codex' } })
    expect(w.get('[data-testid="api-key-switch"]').text()).toBe(i18n.global.t('settings.accounts.cli.set-default'))
    expect(w.text()).not.toContain(i18n.global.t('settings.accounts.api-keys.detail.switch-hint'))
  })

  it('lets a Claude account in use be stopped; a Codex one has nothing to stop', () => {
    expect(mountDetail(fakeCalls(), { inUse: true }).find('[data-testid="api-key-stop-using"]').exists()).toBe(true)
    const codex = mountDetail(fakeCalls(), { inUse: true, row: { ...ROW, agentKey: 'codex' } })
    expect(codex.find('[data-testid="api-key-stop-using"]').exists()).toBe(false)
    expect(codex.find('[data-testid="api-key-switch"]').exists()).toBe(false)
  })
})

describe('CliAccountsPane with an API key account', () => {
  function fakeApi(profiles: unknown[], agentKey = 'claude') {
    const paneDefaults = ref<Record<string, string>>({})
    return {
      error: ref(''),
      supportedAgents: computed(() => [agentKey]),
      paneDefaults,
      profilesForAgent: (agent: string) => (agent === agentKey ? profiles : []),
      findProfile: (id: string) => (profiles as { id: string }[]).find((p) => p.id === id),
      defaultProfileId: () => null,
      newPaneProfileId: () => null,
      identityFor: (_agent: string): { email: string | null; signedIn: boolean } => ({ email: 'me@example.com', signedIn: true }),
      aliasFor: () => null,
      duplicateFor: () => null,
      accountDirFor: () => null,
      scopesFor: () => [],
      loginIsGlobal: () => false,
      setDefault: vi.fn(async () => ({ ok: true })),
      setPaneDefault: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => true),
    }
  }

  function mountPane(api: ReturnType<typeof fakeApi>) {
    return mount(CliAccountsPane, {
      props: { api: api as never, backend: { send: vi.fn() } as never, workspaceOpen: true },
      global: { plugins: [i18n] },
    })
  }

  it('lists the account once, as a row of its CLI, with no second list', async () => {
    const w = mountPane(fakeApi([ROW]))
    const row = w.get(`[data-account="claude/${ROW.id}"]`)
    expect(row.text()).toContain('Project')
    expect(row.text()).toContain(i18n.global.t('settings.accounts.api-keys.kind'))
    expect(w.get('[data-account="claude/__default__"]').text()).toContain(i18n.global.t('settings.accounts.api-keys.list.login'))
  })

  it('turns a CLI nobody signed in to into one line, under one heading', () => {
    const api = { ...fakeApi([ROW]), identityFor: (agent: string) => ({ email: agent === 'claude' ? 'me@example.com' : null, signedIn: agent === 'claude' }) }
    api.supportedAgents = computed(() => ['codex', 'claude'])
    const w = mountPane(api)
    expect(w.get('.acct-rows').text()).toMatch(/Claude[\s\S]*Project[\s\S]*Codex/)
    expect(w.get('[data-account="codex/__default__"]').find('.acct-row-kind').exists()).toBe(false)
  })

  it('keeps every login card mounted while an API key account is open', async () => {
    const w = mountPane(fakeApi([ROW]))
    await w.get(`[data-account="claude/${ROW.id}"]`).trigger('click')
    expect(w.findComponent(ApiKeyDetail).exists()).toBe(true)
    expect(w.findAll('.cli-card').length).toBeGreaterThan(0)
    expect((w.get('section.cli-agent').element as HTMLElement).style.display).toBe('none')
  })

  it('never sends a Claude API key account through set_default', async () => {
    const api = fakeApi([ROW])
    const w = mountPane(api)
    await w.get(`[data-account="claude/${ROW.id}"]`).trigger('click')
    await w.get('[data-testid="api-key-switch"]').trigger('click')
    await flushPromises()
    expect(api.setPaneDefault).toHaveBeenCalledWith('claude', ROW.id)
    expect(api.setDefault).not.toHaveBeenCalled()
  })

  it('switches a Codex API key account through set_default', async () => {
    const row = { ...ROW, agentKey: 'codex' }
    const api = fakeApi([row], 'codex')
    const w = mountPane(api)
    await w.get(`[data-account="codex/${ROW.id}"]`).trigger('click')
    await w.get('[data-testid="api-key-switch"]').trigger('click')
    await flushPromises()
    expect(api.setDefault).toHaveBeenCalledWith('codex', ROW.id)
    expect(api.setPaneDefault).not.toHaveBeenCalled()
  })

  it('clears the pane default when a Claude account stops being used', async () => {
    const api = fakeApi([ROW])
    api.paneDefaults.value = { claude: ROW.id }
    const w = mountPane(api)
    await w.get(`[data-account="claude/${ROW.id}"]`).trigger('click')
    await w.get('[data-testid="api-key-stop-using"]').trigger('click')
    await flushPromises()
    expect(api.setPaneDefault).toHaveBeenCalledWith('claude', null)
  })
})
