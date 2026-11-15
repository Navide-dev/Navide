// @vitest-environment happy-dom
// The remote container setup dialog: host → list containers → pick a running
// one with a supported network → (optionally) test → open. Only the host,
// container and CLI names are remembered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { settingsGet } from '@navide/plugin-ui/shared'
import { i18n } from '@navide/plugin-ui/foundation'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import RemoteDevcontainerDialog from '../RemoteDevcontainerDialog.vue'
import { REMOTE_RECENT_KEY, rememberRemoteRecent } from '../../composables/useRemoteDevcontainerPrefs'

const containers = [
  { name: 'app', running: true, network: { mode: 'bridge', gateway: '172.17.0.1' } },
  { name: 'old', running: false, network: { mode: 'host' } },
  { name: 'odd', running: true, network: { mode: 'unsupported', detail: 'macvlan' } },
  { name: 'hostnet', running: true, network: { mode: 'host' } },
]

function tMock(key: string, params?: Record<string, unknown>): string {
  return params ? `${key}:${JSON.stringify(params)}` : key
}

type Reply = { ok: boolean; payload?: unknown; error?: unknown }

function mountDialog(replies: Record<string, Reply>): { wrapper: VueWrapper; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (type: string) => replies[type] ?? { ok: false, error: { code: 'BAD_REQUEST', message: 'unexpected' } })
  const wrapper = mount(RemoteDevcontainerDialog, {
    attachTo: document.body,
    props: { open: true, backend: { send } as never },
    global: { mocks: { $t: tMock }, stubs: { Teleport: true } },
  })
  return { wrapper, send }
}

async function listFor(wrapper: VueWrapper, host: string): Promise<void> {
  await wrapper.get('[data-testid="remote-host"]').setValue(host)
  await wrapper.get('[data-testid="remote-list"]').trigger('click')
  await flushPromises()
}

describe('RemoteDevcontainerDialog', () => {
  let wrapper: VueWrapper | undefined
  beforeEach(() => __resetSettingsForTest())
  afterEach(() => {
    wrapper?.unmount()
    document.body.replaceChildren()
  })

  it('lists, selects, probes and opens with the exact remote payload', async () => {
    const m = mountDialog({
      'remote_devcontainer.list': { ok: true, payload: { containers } },
      'remote_devcontainer.probe': {
        ok: true,
        payload: { host_ok: true, container_ok: true, cli_path: '/usr/bin/codex', cli_version: '0.9.1', mcp: 'ok', elapsed_ms: 120 },
      },
    })
    wrapper = m.wrapper
    const openBtn = () => wrapper!.get('[data-testid="remote-open"]')
    expect(openBtn().attributes('disabled')).toBeDefined()
    await listFor(wrapper, ' devbox ')
    expect(m.send).toHaveBeenCalledWith('remote_devcontainer.list', { host: 'devbox' }, expect.any(Number))
    const rows = wrapper.findAll('[data-testid="remote-container-row"]')
    expect(rows).toHaveLength(4)
    expect(openBtn().attributes('disabled')).toBeDefined()

    await rows[0].get('input[type="radio"]').setValue(true)
    await wrapper.get('[data-testid="remote-cli-codex"]').trigger('click')
    expect(openBtn().attributes('disabled')).toBeUndefined()

    await wrapper.get('[data-testid="remote-test"]').trigger('click')
    await flushPromises()
    const remote = { host: 'devbox', container: 'app', network: { mode: 'bridge', gateway: '172.17.0.1' } }
    expect(m.send).toHaveBeenCalledWith('remote_devcontainer.probe', { agent_key: 'codex', remote }, expect.any(Number))
    const result = wrapper.get('[data-testid="remote-test-result"]').text()
    const t = i18n.global.t
    expect(result).toContain(t('remoteDevcontainer.test-host-ok', { ms: 120 }))
    expect(result).toContain(t('remoteDevcontainer.test-cli-ok', { cli: 'Codex CLI', container: 'app', version: '0.9.1' }))
    expect(result).toContain(t('remoteDevcontainer.test-mcp-ok'))
    expect(result).not.toContain('✗')

    await openBtn().trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual([{ agentKey: 'codex', remote }])
    expect(settingsGet(REMOTE_RECENT_KEY, [])).toEqual([{ host: 'devbox', container: 'app', agentKey: 'codex' }])
  })

  it('keeps stopped and unsupported-network containers unselectable', async () => {
    const m = mountDialog({ 'remote_devcontainer.list': { ok: true, payload: { containers } } })
    wrapper = m.wrapper
    await listFor(wrapper, 'devbox')
    const rows = wrapper.findAll('[data-testid="remote-container-row"]')
    expect(rows[1].get('input').attributes('disabled')).toBeDefined()
    expect(rows[1].text()).toContain('remoteDevcontainer.stopped')
    expect(rows[2].get('input').attributes('disabled')).toBeDefined()
    expect(rows[2].text()).toContain('remoteDevcontainer.network-unsupported')
    expect(rows[3].get('input').attributes('disabled')).toBeUndefined()
    expect(rows[3].text()).toContain('remoteDevcontainer.running')
    expect(wrapper.get('[data-testid="remote-open"]').attributes('disabled')).toBeDefined()
  })

  it('a host network target is sent as mode host only', async () => {
    const m = mountDialog({ 'remote_devcontainer.list': { ok: true, payload: { containers } } })
    wrapper = m.wrapper
    await listFor(wrapper, 'devbox')
    await wrapper.findAll('[data-testid="remote-container-row"]')[3].get('input').setValue(true)
    await wrapper.get('[data-testid="remote-open"]').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual([{ agentKey: 'claude', remote: { host: 'devbox', container: 'hostnet', network: { mode: 'host' } } }])
  })

  it('shows an ssh failure with the stderr detail', async () => {
    const m = mountDialog({
      'remote_devcontainer.list': { ok: false, error: { code: 'REMOTE_SSH_FAILED', message: 'ssh failed', details: { exit_code: 255, stderr: 'Could not resolve hostname devbox' } } },
    })
    wrapper = m.wrapper
    await listFor(wrapper, 'devbox')
    expect(wrapper.get('[role="alert"]').text()).toBe(
      i18n.global.t('remoteDevcontainer.error-ssh', { host: 'devbox', detail: 'Could not resolve hostname devbox' }),
    )
    expect(wrapper.findAll('[data-testid="remote-container-row"]')).toHaveLength(0)
  })

  it('offers recent hosts and preselects the remembered container and CLI', async () => {
    rememberRemoteRecent({ host: 'devbox', container: 'hostnet', agentKey: 'codex' })
    rememberRemoteRecent({ host: 'other', container: 'x', agentKey: 'claude' })
    const m = mountDialog({ 'remote_devcontainer.list': { ok: true, payload: { containers } } })
    wrapper = m.wrapper
    const options = wrapper.findAll('[data-testid="remote-recent-hosts"] option').map((o) => o.attributes('value'))
    expect(options).toEqual(['other', 'devbox'])
    await listFor(wrapper, 'devbox')
    await wrapper.get('[data-testid="remote-open"]').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual([{ agentKey: 'codex', remote: { host: 'devbox', container: 'hostnet', network: { mode: 'host' } } }])
  })

  it('cancel emits cancel and opens nothing', async () => {
    const m = mountDialog({})
    wrapper = m.wrapper
    await wrapper.get('[data-testid="remote-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('open')).toBeUndefined()
    expect(m.send).not.toHaveBeenCalled()
  })
})
