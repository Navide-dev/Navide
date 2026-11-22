// @vitest-environment happy-dom
// ＋ menu → SSH Remote…: host, user, port (22 by default), key path and the
// recent list. Connect ends in an opened pane or a plain-language reason,
// never a hang. Only the four fields are remembered, and the key is a path only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import SshRemoteDialog from '../SshRemoteDialog.vue'
import { SSH_REMOTE_RECENT_KEY, loadSshRemoteRecent, rememberSshRemoteRecent } from '../../composables/useSshRemotePrefs'

type Reply = { ok: boolean; payload?: unknown; error?: unknown }

function mountDialog(send: (type: string, payload?: Record<string, unknown>) => Promise<Reply>): VueWrapper {
  return mount(SshRemoteDialog, {
    attachTo: document.body,
    props: { open: true, backend: { send: vi.fn(send) } as never },
    global: { mocks: { $t: (key: string) => key }, stubs: { Teleport: true } },
  })
}

const connected: Reply = { ok: true, payload: { spec: { kind: 'ssh' } } }
const failed = (reason: string): Reply =>
  ({ ok: false, error: { code: 'REMOTE_SSH_FAILED', message: 'ssh failed', details: { reason } } })

describe('SshRemoteDialog', () => {
  let wrapper: VueWrapper | undefined
  beforeEach(() => __resetSettingsForTest())
  afterEach(() => {
    wrapper?.unmount()
    document.body.replaceChildren()
  })

  it('defaults the port to 22 and sends the four fields to remote_ssh.connect', async () => {
    const send = vi.fn(async () => connected)
    wrapper = mountDialog(send)
    expect((wrapper.get('[data-testid="ssh-port"]').element as HTMLInputElement).value).toBe('22')
    expect(wrapper.get('[data-testid="ssh-connect"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="ssh-host"]').setValue('build-box')
    await wrapper.get('[data-testid="ssh-user"]').setValue('dev')
    await wrapper.get('[data-testid="ssh-key"]').setValue('/Users/me/.ssh/id_test')
    await wrapper.get('[data-testid="ssh-connect"]').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith(
      'remote_ssh.connect',
      { target: { host: 'build-box', user: 'dev', port: 22, keyPath: '/Users/me/.ssh/id_test' } },
      expect.any(Number),
    )
  })

  it('a checked host emits connected and is remembered', async () => {
    wrapper = mountDialog(async () => connected)
    await wrapper.get('[data-testid="ssh-host"]').setValue('build-box')
    await wrapper.get('[data-testid="ssh-connect"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('connected')?.[0]).toEqual([{ host: 'build-box', user: '', port: 22, keyPath: '' }])
    expect(loadSshRemoteRecent().map((r) => r.host)).toEqual(['build-box'])
  })

  it.each(['unreachable', 'auth', 'host-key', 'other'])('names a %s failure in plain terms', async (reason) => {
    wrapper = mountDialog(async () => failed(reason))
    await wrapper.get('[data-testid="ssh-host"]').setValue('build-box')
    await wrapper.get('[data-testid="ssh-connect"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="ssh-reason"]').text()).toContain(`sshRemote.reason-${reason}`)
    expect(wrapper.emitted('connected')).toBeUndefined()
    expect(wrapper.get('[data-testid="ssh-connect"]').attributes('disabled')).toBeUndefined()
    expect(loadSshRemoteRecent()).toEqual([])
    // Only a key or host-key refusal can be opened anyway: the pane's ssh asks.
    expect(wrapper.find('[data-testid="ssh-force"]').exists()).toBe(reason === 'auth' || reason === 'host-key')
  })

  it('open anyway sends force and then emits connected', async () => {
    const send = vi.fn(async (_type: string, payload?: Record<string, unknown>) => (payload?.force ? connected : failed('host-key')))
    wrapper = mountDialog(send)
    await wrapper.get('[data-testid="ssh-host"]').setValue('build-box')
    await wrapper.get('[data-testid="ssh-connect"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="ssh-force"]').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenLastCalledWith('remote_ssh.connect', expect.objectContaining({ force: true }), expect.any(Number))
    expect(wrapper.emitted('connected')).toHaveLength(1)
  })

  it('a backend that throws or times out shows an error instead of hanging', async () => {
    wrapper = mountDialog(async () => { throw new Error('timeout') })
    await wrapper.get('[data-testid="ssh-host"]').setValue('build-box')
    await wrapper.get('[data-testid="ssh-connect"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="ssh-connect"]').attributes('disabled')).toBeUndefined()
    expect(loadSshRemoteRecent()).toEqual([])
  })

  it('a recent row fills the form', async () => {
    rememberSshRemoteRecent({ host: 'gpu', user: 'ml', port: 2222, keyPath: '/k/id' })
    wrapper = mountDialog(async () => connected)
    const row = wrapper.get('[data-testid="ssh-recent-row"]')
    expect(row.text()).toBe('ml@gpu:2222')
    await row.trigger('click')
    expect((wrapper.get('[data-testid="ssh-host"]').element as HTMLInputElement).value).toBe('gpu')
    expect((wrapper.get('[data-testid="ssh-port"]').element as HTMLInputElement).value).toBe('2222')
    expect((wrapper.get('[data-testid="ssh-key"]').element as HTMLInputElement).value).toBe('/k/id')
  })
})

describe('useSshRemotePrefs', () => {
  beforeEach(() => __resetSettingsForTest())

  it('keeps host, user, port and key path only — never key material', () => {
    const material = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----' + 'ZmFrZQ'.repeat(4)
    rememberSshRemoteRecent({ host: 'box', user: '', port: 22, keyPath: '/k/id', privateKey: material, passphrase: 'pw' + '1' } as never)
    settingsSet(SSH_REMOTE_RECENT_KEY, [...(settingsGet<unknown[]>(SSH_REMOTE_RECENT_KEY, []) ?? []), { host: 'x', agentKey: material }])
    const stored = JSON.stringify(settingsGet(SSH_REMOTE_RECENT_KEY, []))
    expect(stored).toContain('/k/id')
    expect(stored).not.toContain('pw1')
    expect(JSON.stringify(loadSshRemoteRecent())).not.toContain('ZmFrZQ')
    expect(loadSshRemoteRecent()[0]).toEqual({ host: 'box', user: '', port: 22, keyPath: '/k/id' })
  })

  it('puts the newest first, de-duplicates and caps the list', () => {
    for (let i = 0; i < 10; i++) rememberSshRemoteRecent({ host: `h${i}`, user: '', port: 22, keyPath: '' })
    rememberSshRemoteRecent({ host: 'h3', user: '', port: 22, keyPath: '' })
    const hosts = loadSshRemoteRecent().map((r) => r.host)
    expect(hosts[0]).toBe('h3')
    expect(hosts).toHaveLength(8)
    expect(new Set(hosts).size).toBe(8)
  })
})
