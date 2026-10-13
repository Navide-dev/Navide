// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import CredentialsPane from '../CredentialsPane.vue'

const scan = {
  ok: true,
  scanned_at: '2026-10-09T08:00:00Z',
  duration_ms: 412,
  platform: 'darwin',
  keyring: { available: true, backend: 'macos-keychain' },
  roots: [
    { path: '/Users/x/work', source: 'workspace', repo_count: 4 },
    { path: '/Users/x/src', source: 'user', repo_count: 2 },
  ],
  summary: { high: 1, medium: 1, low: 1, active_reminders: 2 },
  items: [
    { id: 'i1', kind: 'ssh-key', label: 'id_ed25519', detail: { path: '~/.ssh/id_ed25519', has_passphrase: false, mode: 600 } },
    { id: 'i2', kind: 'git-helper', label: 'osxkeychain', detail: { scope: 'global' } },
  ],
  findings: [
    { id: 'f1', code: 'url-token', severity: 'high', kind: 'remote', location: '~/proj (origin: https://****@github.com/x/y)', params: {}, links: [{ label: 'GitHub tokens', url: 'https://github.com/settings/tokens' }], steps: ['git remote set-url origin https://github.com/x/y.git'], reminder: { state: 'active' } },
    { id: 'f2', code: 'ssh-key-mode', severity: 'medium', kind: 'ssh-key', location: '~/.ssh/id_rsa', params: {}, links: [], steps: ['chmod 600 ~/.ssh/id_rsa'], reminder: { state: 'active' } },
    { id: 'f3', code: 'helper-duplicate', severity: 'low', kind: 'git-helper', location: '~/.gitconfig', params: {}, links: [], steps: [], reminder: { state: 'snoozed', until: '2026-10-16T08:00:00Z' } },
  ],
}

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    'credentials.scan': { ok: true, payload: scan },
    'credentials.roots.get': { ok: true, payload: { ok: true, roots: ['/Users/x/extra'] } },
    'credentials.roots.set': { ok: true, payload: { ok: true, roots: ['/Users/x/extra', '/Users/x/more'] } },
    'credentials.reminder.set': { ok: true, payload: { ok: true, reminder: { state: 'snoozed' } } },
    ...overrides,
  }
  const send = vi.fn(async (type: string, _payload?: unknown) => responses[type])
  const status = ref('connected')
  const on = vi.fn(() => () => {})
  return { backend: { send, on, status } as never, send }
}

describe('CredentialsPane', () => {
  let wrapper: VueWrapper | undefined
  const openExternal = vi.fn().mockResolvedValue({ ok: true })
  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    window.agentTeam = { openExternal } as unknown as typeof window.agentTeam
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })
  async function mountPane(overrides: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
    const m = mockBackend(overrides)
    wrapper = mount(CredentialsPane, { props: { backend: m.backend, ...props }, global: { plugins: [i18n] } })
    await flushPromises()
    return m
  }

  it('scans on mount and groups findings by severity', async () => {
    const { send } = await mountPane()
    expect(send).toHaveBeenCalledWith('credentials.scan', {})
    const groups = wrapper!.findAll('.cred-group')
    expect(groups.map((g) => g.attributes('data-severity'))).toEqual(['high', 'medium', 'low'])
    expect(groups[0]!.text()).toContain('Token embedded in a remote URL')
    expect(wrapper!.find('.cred-banner').text()).toContain('1')
    expect(wrapper!.text()).toContain('Local only')
  })

  it('does not scan until the tab is active', async () => {
    const { send } = await mountPane({}, { active: false })
    expect(send).not.toHaveBeenCalled()
    await wrapper!.setProps({ active: true })
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('rescans with force on the Scan button', async () => {
    const { send } = await mountPane()
    await wrapper!.find('.cred-scan-btn').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenLastCalledWith('credentials.scan', { force: true })
  })

  it('flags an incomplete scan and each truncated root', async () => {
    const partial = {
      ...scan,
      complete: false,
      roots: [
        { path: '/Users/x/work', source: 'workspace', repo_count: 4, truncated: true },
        { path: '/Users/x/src', source: 'user', repo_count: 2, truncated: false },
      ],
    }
    await mountPane({ 'credentials.scan': { ok: true, payload: partial } })
    expect(wrapper!.find('.cred-incomplete').text()).toBe(i18n.global.t('settings.credentials.incomplete'))
    const marks = wrapper!.findAll('.cred-root-truncated')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.text()).toBe(i18n.global.t('settings.credentials.roots.truncated'))
  })

  it('shows no incomplete banner for a complete scan', async () => {
    await mountPane({ 'credentials.scan': { ok: true, payload: { ...scan, complete: true } } })
    expect(wrapper!.find('.cred-incomplete').exists()).toBe(false)
    expect(wrapper!.find('.cred-root-truncated').exists()).toBe(false)
  })

  it('shows a manual-fix note instead of steps when the backend withheld them', async () => {
    const manual = {
      ...scan,
      findings: [{ id: 'f9', code: 'url-token', severity: 'high', kind: 'remote', location: '~/evil · origin · https://github.com/a/b;x', params: {}, links: [], steps: [], actions: ['remote-set-url', 'manual-fix'], manual_fix: true, reminder: { state: 'active' } }],
    }
    await mountPane({ 'credentials.scan': { ok: true, payload: manual } })
    await wrapper!.findAll('.cred-card')[0]!.trigger('click')
    await flushPromises()
    const note = wrapper!.find('.cred-manual-fix')
    expect(note.exists()).toBe(true)
    expect(note.text()).toBe(i18n.global.t('settings.credentials.drawer.manual-fix'))
    expect(wrapper!.find('.cred-copy').exists()).toBe(false)
  })

  it('snoozes from the drawer with the right params and shows steps as copy-only', async () => {
    const { send } = await mountPane()
    await wrapper!.findAll('.cred-card')[0]!.trigger('click')
    await flushPromises()
    expect(wrapper!.find('.cred-drawer').text()).toContain('git remote set-url origin')
    await wrapper!.find('.cred-snooze').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('credentials.reminder.set', { id: 'f1', state: 'snoozed', days: 7 })
    await wrapper!.find('.cred-dismiss').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('credentials.reminder.set', { id: 'f1', state: 'dismissed' })
  })

  it('opens provider links through the app opener', async () => {
    await mountPane()
    await wrapper!.findAll('.cred-card')[0]!.trigger('click')
    await wrapper!.find('.cred-link').trigger('click')
    expect(openExternal).toHaveBeenCalledWith('https://github.com/settings/tokens')
  })

  it('shows inventory grouped by kind with detail rows and no reveal control', async () => {
    await mountPane()
    const buttons = wrapper!.findAll('.cred-view-switch button')
    await buttons[1]!.trigger('click')
    expect(wrapper!.findAll('.cred-group').length).toBe(2)
    await wrapper!.findAll('.cred-card')[0]!.trigger('click')
    expect(wrapper!.find('.cred-drawer').text()).toContain('has_passphrase')
    const controls = wrapper!.findAll('button').map((b) => b.text().toLowerCase())
    expect(controls.some((c) => /reveal|show value|show secret/.test(c))).toBe(false)
  })

  it('edits and saves scan roots', async () => {
    const { send } = await mountPane()
    await wrapper!.find('.cred-roots-btn').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('credentials.roots.get', {})
    expect(wrapper!.find('.cred-roots').text()).toContain('/Users/x/extra')
    expect(wrapper!.find('.cred-roots').text()).toContain('4 repos')
    await wrapper!.find('.cred-roots input').setValue('/Users/x/more')
    await wrapper!.find('.cred-roots-add').trigger('click')
    await wrapper!.find('.cred-roots-save').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('credentials.roots.set', { roots: ['/Users/x/extra', '/Users/x/more'] })
    expect(send).toHaveBeenLastCalledWith('credentials.scan', { force: true })
  })

  it('explains an unavailable keyring', async () => {
    await mountPane({ 'credentials.scan': { ok: true, payload: { ...scan, keyring: { available: false, backend: null, reason: 'no secret service' } } } })
    expect(wrapper!.find('.cred-keyring').text()).toContain('unavailable')
    expect(wrapper!.find('.cred-keyring').text()).toContain('no secret service')
  })

  it('shows an inline error when the scan fails', async () => {
    await mountPane({ 'credentials.scan': { ok: true, payload: { ok: false, error: 'boom', error_code: 'scan_failed' } } })
    expect(wrapper!.find('.cred-error').text()).toContain('boom')
  })

  it('never renders fields outside the whitelist', async () => {
    const dirty = { ...scan, findings: [{ ...scan.findings[0], value: 'SENTINEL_VALUE', secret: 'SENTINEL_SECRET', params: { token: 'SENTINEL_PARAM' } }] }
    await mountPane({ 'credentials.scan': { ok: true, payload: dirty } })
    await wrapper!.find('.cred-card').trigger('click')
    expect(wrapper!.html()).not.toContain('SENTINEL')
  })
})
