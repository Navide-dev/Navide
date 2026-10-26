// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CliManagementPanel from '../CliManagementPanel.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useOnboarding } from '../../composables/useOnboarding'
import type { OnboardDep, OnboardStatus } from '../../composables/useOnboarding'

// Maintenance commands run in an embedded xterm; happy-dom has no canvas for it.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100
    rows = 24
    loadAddon(): void {}
    open(): void {}
    onData(): { dispose(): void } { return { dispose(): void {} } }
    write(): void {}
    reset(): void {}
    focus(): void {}
    dispose(): void {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    dispose(): void {}
  },
}))

/** Let the command in the embedded terminal end. */
async function exitRun(
  mock: ReturnType<typeof createMockBackend>,
  exit: { exit_code: number | null; signal?: string },
  runId = 'run-1',
): Promise<void> {
  mock.emit('terminal.exit', { terminal_session_id: runId, ...exit })
  await flushPromises()
}

const depBase = {
  description: '', group: 'agent_cli' as const, min_version: '', optional: true,
  needs_terminal: true, can_install: true, docs_url: '',
}

const claude: OnboardDep = {
  ...depBase,
  id: 'claude', label: 'Claude Code', status: 'ok', version: '2.1.219',
  docs_url: 'https://docs.anthropic.com/claude-code',
  binary_path: '/Users/test/.local/bin/claude',
  resolved_path: '/Users/test/.local/share/claude/versions/2.1.219',
  install_method: 'native', update_cmd: 'claude update', doctor_cmd: 'claude doctor',
  autoupdate_env: 'DISABLE_AUTOUPDATER', autoupdate_policy: 'vendor',
}

// Kimi ships a doctor but no update subcommand.
const kimi: OnboardDep = {
  ...depBase,
  id: 'kimi', label: 'Kimi Code', status: 'ok', version: '0.9.0',
  docs_url: 'https://moonshotai.github.io/kimi-cli/en/',
  binary_path: '/Users/test/.kimi-code/bin/kimi',
  resolved_path: '/Users/test/.kimi-code/bin/kimi',
  install_method: 'script', update_cmd: '', doctor_cmd: 'kimi doctor',
  autoupdate_env: '', autoupdate_policy: '',
}

function status(): OnboardStatus {
  return {
    deps: [claude, kimi],
    models: [],
    model_catalog: [],
    gate: {
      foundation_ready: true, has_any_cli: true, analyzer_ready: false,
      ollama_ok: false, ollama_service_up: false, has_model: false,
      all_required_ready: true, suggested_model: '',
    },
    cli_health: {
      entries: [{
        agent_key: 'claude',
        label: 'Claude Code',
        npm_package: '@anthropic-ai/claude-code',
        diagnostic_command: 'claude doctor',
        update_command: 'claude update',
        docs_url: '',
        update_state: [{
          scope: 'profile:4ad13e88', home: '/Users/test/.navide/cli-profiles/claude/4ad13e88',
          timestamp: '2026-07-25T00:07:12.372Z', outcome: 'failed', status: 'install_failed',
          version_from: '2.1.219', version_to: '',
        }],
        candidates: [],
      }],
      findings: [{ type: 'update_failed', agent_key: 'claude', label: 'Claude Code' }],
      fingerprint: '0123456789abcdef',
      dismissed: false,
      needs_attention: true,
    },
    complete: true,
  }
}

describe('CliManagementPanel', () => {
  let wrapper: VueWrapper | undefined
  const opened: string[] = []

  afterEach(() => { wrapper?.unmount(); opened.length = 0 })

  // Attach to the existing happy-dom window; replacing it wholesale would strip
  // the DOM event constructors vue-test-utils needs to trigger clicks.
  function stubTerminal(): void {
    ;(window as unknown as { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean }> } }).agentTeam = {
      openTerminal: (c: string) => { opened.push(c); return Promise.resolve({ ok: true }) },
    }
  }

  async function mountPanel() {
    stubTerminal()
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'claude update' })
    wrapper = mount(CliManagementPanel, {
      props: { backend: mock.backend, onboarding: useOnboarding(mock.backend) },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return mock
  }

  it('shows each CLI with its version, install method and the failed vendor update', async () => {
    await mountPanel()

    const text = wrapper!.text()
    expect(text).toContain('Claude Code')
    expect(text).toContain('2.1.219')
    expect(text).toContain('native installer')
    expect(text).toContain('/Users/test/.local/share/claude/versions/2.1.219')
    expect(text).toContain('failed')
    expect(wrapper!.get('.cm-update').classes()).toContain('failed')
  })

  describe('choosing an installation', () => {
    async function mountWithDuplicates(fingerprint = '0123456789abcdef') {
      stubTerminal()
      const mock = createMockBackend('connected')
      const withDupes = status()
      withDupes.cli_health.fingerprint = fingerprint
      withDupes.cli_health.entries[0].candidates = [
        { path: '/a/claude', resolved_path: '/a/claude', version: '2.1.219', status: 'ok', is_primary: true },
        { path: '/b/claude', resolved_path: '/b/claude', version: '2.1.200', status: 'ok', is_primary: false },
      ] as OnboardStatus['cli_health']['entries'][number]['candidates']
      mock.setResponse('onboarding.status', withDupes)
      wrapper = mount(CliManagementPanel, {
        props: { backend: mock.backend, onboarding: useOnboarding(mock.backend) },
        global: { plugins: [i18n] },
      })
      await flushPromises()
      return mock
    }

    const useThis = () => wrapper!.findAll('button').find((button) => button.text() === 'Use This One')!

    it('saves just the choice — no fingerprint needed — and says so', async () => {
      const mock = await mountWithDuplicates('')
      mock.setResponse('onboarding.cli_health.select_binary', { ok: true, agent_key: 'claude', path: '/b/claude' })

      await useThis().trigger('click')
      await flushPromises()

      expect(mock.sent).toContainEqual({
        type: 'onboarding.cli_health.select_binary',
        payload: { agent_key: 'claude', path: '/b/claude' },
      })
      expect(wrapper!.get('.cm-message').text()).toBe(
        i18n.global.t('cli-manage.use-done', { label: 'Claude Code', path: '/b/claude' })
      )
    })

    it('shows a refused choice instead of dropping it', async () => {
      const mock = await mountWithDuplicates()
      mock.setResponse('onboarding.cli_health.select_binary', {
        ok: false, error: 'binary is not an installed PATH candidate',
      })

      await useThis().trigger('click')
      await flushPromises()

      expect(wrapper!.get('.cm-message').text()).toBe(i18n.global.t('cli-manage.use-failed', {
        label: 'Claude Code', error: 'binary is not an installed PATH candidate',
      }))
    })

    it('shows a transport failure instead of rejecting unhandled', async () => {
      const mock = await mountWithDuplicates()
      mock.setRejection('onboarding.cli_health.select_binary', 'ws not open')

      await useThis().trigger('click')
      await flushPromises()

      expect(wrapper!.get('.cm-message').text()).toBe(
        i18n.global.t('cli-manage.use-failed', { label: 'Claude Code', error: 'ws not open' })
      )
    })
  })

  it('runs the vendor update command rather than one of its own', async () => {
    const mock = await mountPanel()

    const update = wrapper!.findAll('button').find((button) => button.text().includes('claude update'))
    await update!.trigger('click')
    await flushPromises()

    expect(mock.sent).toContainEqual(expect.objectContaining({
      type: 'onboarding.run',
      payload: { kind: 'maintenance', agent_key: 'claude', action: 'update', cols: 100, rows: 24 },
    }))
    // In the embedded terminal, not an external one.
    expect(opened).toEqual([])
    expect(wrapper!.get('[data-testid="install-terminal"]').text()).toContain('claude update')
    // One command at a time: every other maintenance button waits for it.
    const actions = wrapper!.findAll('.cm-actions button')
    expect(actions.length).toBeGreaterThan(0)
    for (const button of actions) expect(button.attributes('disabled')).toBeDefined()

    await exitRun(mock, { exit_code: 0 })

    const probes = mock.sent.filter((s) => s.type === 'onboarding.status')
    expect(probes[probes.length - 1].payload).toEqual({ fresh: true })
    expect(wrapper!.get('.cm-message').text()).toBe(
      i18n.global.t('cli-manage.run-finished', { command: 'claude update' })
    )
    for (const button of wrapper!.findAll('.cm-actions button')) {
      expect(button.attributes('disabled')).toBeUndefined()
    }
  })

  it('says so when the vendor command exits non-zero', async () => {
    const mock = await mountPanel()

    const update = wrapper!.findAll('button').find((button) => button.text().includes('claude update'))
    await update!.trigger('click')
    await flushPromises()
    await exitRun(mock, { exit_code: 2 })

    expect(wrapper!.get('.cm-message').text()).toBe(
      i18n.global.t('cli-manage.run-failed', { command: 'claude update', error: 'Exited with code 2' })
    )
    expect(wrapper!.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.exited-fail', { code: 2 })
    )
  })

  it('says a refused command is unavailable instead of starting anything', async () => {
    const mock = await mountPanel()
    mock.setResponse('onboarding.run', { ok: false, error: 'agent has no update command' })

    const update = wrapper!.findAll('button').find((button) => button.text().includes('claude update'))
    await update!.trigger('click')
    await flushPromises()

    expect(wrapper!.get('.cm-message').text()).toBe(
      i18n.global.t('cli-manage.command-unavailable', { label: 'Claude Code' })
    )
    expect(wrapper!.find('[data-testid="install-terminal"]').exists()).toBe(false)
  })

  it('says why when the command could not even be requested', async () => {
    // Settings has no log view: a timed-out or disconnected start used to
    // leave the panel showing nothing at all.
    const mock = await mountPanel()
    mock.setRejection('onboarding.run', 'request onboarding.run timeout')

    const update = wrapper!.findAll('button').find((button) => button.text().includes('claude update'))
    await update!.trigger('click')
    await flushPromises()

    expect(wrapper!.get('.cm-message').text()).toBe(i18n.global.t('cli-manage.start-failed', {
      label: 'Claude Code', error: 'request onboarding.run timeout',
    }))
  })

  it('shows the backend\'s reason when an install is refused', async () => {
    stubTerminal()
    const mock = createMockBackend('connected')
    const payload = status()
    payload.deps = [{ ...claude, install_cmd: 'curl -fsSL https://claude.ai/install.sh | bash' }]
    mock.setResponse('onboarding.status', payload)
    mock.setResponse('onboarding.run', { ok: false, error: 'npm is required but was not found' })
    wrapper = mount(CliManagementPanel, {
      props: { backend: mock.backend, onboarding: useOnboarding(mock.backend) },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    const reinstall = wrapper.findAll('button').find((button) => button.text().includes('install.sh'))
    await reinstall!.trigger('click')
    await flushPromises()

    expect(wrapper!.get('.cm-message').text()).toBe(i18n.global.t('cli-manage.start-failed', {
      label: 'Claude Code', error: 'npm is required but was not found',
    }))
  })

  it('offers to reinstall an installed CLI through the vendor install command', async () => {
    // A CLI the launch guide flagged (and the user dismissed) still needs a
    // repair path in settings: the guided dialog reads an installed CLI as
    // done, so reinstall runs the vendor's own install command in a terminal.
    stubTerminal()
    const mock = createMockBackend('connected')
    const payload = status()
    payload.deps = [{ ...claude, install_cmd: 'curl -fsSL https://claude.ai/install.sh | bash' }]
    mock.setResponse('onboarding.status', payload)
    mock.setResponse('onboarding.run', {
      ok: true, run_id: 'run-1', command: 'curl -fsSL https://claude.ai/install.sh | bash',
    })
    wrapper = mount(CliManagementPanel, {
      props: { backend: mock.backend, onboarding: useOnboarding(mock.backend) },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    const reinstall = wrapper.findAll('button').find((button) => button.text().includes('install.sh'))
    expect(reinstall).toBeDefined()
    // The guided-install entry is for missing CLIs only.
    expect(wrapper.findAll('button').some((b) => b.text() === i18n.global.t('cli-manage.install'))).toBe(false)
    await reinstall!.trigger('click')
    await flushPromises()

    expect(mock.sent).toContainEqual(expect.objectContaining({
      type: 'onboarding.run',
      payload: { kind: 'maintenance', agent_key: 'claude', action: 'install', cols: 100, rows: 24 },
    }))
    expect(opened).toEqual([])
    expect(wrapper.get('[data-testid="install-terminal"]').text()).toContain('install.sh')
    await exitRun(mock, { exit_code: 0 })
  })

  it('passes an unrecognised vendor outcome through verbatim', async () => {
    stubTerminal()
    const mock = createMockBackend('connected')
    const payload = status()
    payload.cli_health.entries[0].update_state[0].outcome = 'cancelled'
    mock.setResponse('onboarding.status', payload)
    wrapper = mount(CliManagementPanel, {
      props: { backend: mock.backend, onboarding: useOnboarding(mock.backend) },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.get('.cm-update').text()).toContain('cancelled')
  })

  it('links to vendor docs for a CLI with no update subcommand', async () => {
    await mountPanel()

    const link = wrapper!.findAll('a').find((anchor) => anchor.text().includes('Vendor Docs'))
    expect(link?.attributes('href')).toBe('https://moonshotai.github.io/kimi-cli/en/')
  })

  it('persists an auto-update policy change through the vendor switch', async () => {
    const mock = await mountPanel()

    const select = wrapper!.get('.cm-policy select')
    await select.setValue('manual')
    await flushPromises()

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_autoupdate',
      payload: { agent_key: 'claude', policy: 'manual' },
    })
  })

  it('says so and puts the select back when a policy change is refused', async () => {
    const mock = await mountPanel()
    mock.setResponse('onboarding.cli_autoupdate', { ok: false, error: 'agent has no vendor auto-update switch' })

    const select = wrapper!.get('.cm-policy select')
    await select.setValue('manual')
    await flushPromises()

    expect(wrapper!.get('.cm-message').text()).toBe(
      i18n.global.t('cli-manage.autoupdate-failed', { label: 'Claude Code' })
    )
    expect((select.element as HTMLSelectElement).value).toBe('vendor')
  })

  it('offers no policy control for a CLI without a vendor switch', async () => {
    await mountPanel()

    expect(wrapper!.findAll('.cm-policy')).toHaveLength(1)
  })

  it('shows all vendors without a filter and only the selected vendor when filtered', async () => {
    await mountPanel()
    expect(wrapper!.findAll('.cm-name').map((row) => row.text())).toEqual(['Claude Code', 'Kimi Code'])

    await wrapper!.setProps({ agentKey: 'claude' })
    expect(wrapper!.findAll('.cm-name').map((row) => row.text())).toEqual(['Claude Code'])
    expect(wrapper!.find('.cm-policy').exists()).toBe(true)

    await wrapper!.setProps({ agentKey: 'kimi' })
    expect(wrapper!.findAll('.cm-name').map((row) => row.text())).toEqual(['Kimi Code'])
    expect(wrapper!.find('.cm-policy').exists()).toBe(false)
    expect(wrapper!.find('.cm-update').exists()).toBe(false)

    await wrapper!.setProps({ agentKey: undefined })
    expect(wrapper!.findAll('.cm-row')).toHaveLength(2)
  })

  it('runs maintenance for the newly selected vendor, without reprobing on every switch', async () => {
    stubTerminal()
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'kimi doctor' })
    const onboarding = useOnboarding(mock.backend)
    await onboarding.refresh()
    wrapper = mount(CliManagementPanel, {
      props: { backend: mock.backend, onboarding, agentKey: 'claude' },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    await wrapper.setProps({ agentKey: 'kimi' })
    expect(mock.sent.filter((entry) => entry.type === 'onboarding.status')).toHaveLength(1)

    await wrapper.get('button[title="kimi doctor"]').trigger('click')
    await flushPromises()
    expect(mock.sent).toContainEqual(expect.objectContaining({
      type: 'onboarding.run',
      payload: { kind: 'maintenance', agent_key: 'kimi', action: 'doctor', cols: 100, rows: 24 },
    }))
    expect(opened).toEqual([])
    await exitRun(mock, { exit_code: 0 })
    onboarding.dispose()
  })

  it('never falls back to other vendors for an unknown selected key', async () => {
    await mountPanel()
    await wrapper!.setProps({ agentKey: 'unregistered-agent' })
    expect(wrapper!.findAll('.cm-row')).toHaveLength(0)
  })

  it('opens the guided install dialog instead of a bare terminal handoff', async () => {
    // Installing from Settings used to differ from the wizard: it only opened
    // a terminal and reported nothing afterwards.
    stubTerminal()
    const mock = createMockBackend('connected')
    const payload = status()
    payload.deps = [{ ...kimi, status: 'missing', version: '' }]
    mock.setResponse('onboarding.status', payload)
    wrapper = mount(CliManagementPanel, {
      props: { backend: mock.backend, onboarding: useOnboarding(mock.backend) },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    const install = wrapper.findAll('button').find(
      (button) => button.text() === i18n.global.t('cli-manage.install')
    )
    await install!.trigger('click')
    await vi.dynamicImportSettled() // the dialog is a defineAsyncComponent
    await flushPromises()

    expect(wrapper.find('.ci-dialog').exists()).toBe(true)
    expect(mock.sent.some((s) => s.type === 'onboarding.run')).toBe(false)
    expect(wrapper.emitted('install-open-change')).toEqual([[true]])

    const panel = wrapper.vm as unknown as { closeInstallDialog: () => boolean }
    expect(panel.closeInstallDialog()).toBe(true)
    await flushPromises()
    expect(wrapper.find('.ci-dialog').exists()).toBe(false)
    expect(wrapper.emitted('install-open-change')).toEqual([[true], [false]])
    expect(panel.closeInstallDialog()).toBe(false)
  })

  it('re-reads the account store once the install dialog reports an install', async () => {
    // The store was loaded before the CLI existed, so its sign-in state is
    // "unknown" until re-read — the dialog would skip the sign-in step.
    stubTerminal()
    const mock = createMockBackend('connected')
    const payload = status()
    payload.deps = [{ ...kimi, status: 'missing', version: '' }]
    mock.setResponse('onboarding.status', payload)
    const cliProfiles = { identityFor: () => null, refresh: vi.fn(() => Promise.resolve()) }
    wrapper = mount(CliManagementPanel, {
      props: { backend: mock.backend, onboarding: useOnboarding(mock.backend), cliProfiles: cliProfiles as never },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    const install = wrapper.findAll('button').find(
      (button) => button.text() === i18n.global.t('cli-manage.install')
    )
    await install!.trigger('click')
    await vi.dynamicImportSettled()
    await flushPromises()

    wrapper.findComponent({ name: 'CliInstallDialog' }).vm.$emit('installed', 'kimi')
    expect(cliProfiles.refresh).toHaveBeenCalledTimes(1)
  })

  it('focuses an enabled installer control while dependency detection is still pending', async () => {
    stubTerminal()
    const mock = createMockBackend('connected')
    const payload = status()
    payload.deps = [{ ...kimi, status: 'missing', version: '' }]
    mock.setResponse('onboarding.status', payload)
    wrapper = mount(CliManagementPanel, {
      attachTo: document.body,
      props: { backend: mock.backend, onboarding: useOnboarding(mock.backend) },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve })
    const originalSend = mock.backend.send
    const pendingProbe = vi.spyOn(mock.backend, 'send').mockImplementationOnce(async (...args) => {
      await probeGate
      return originalSend(...args)
    })
    try {
      const install = wrapper.findAll('button').find((button) => button.text() === i18n.global.t('cli-manage.install'))!
      ;(install.element as HTMLButtonElement).focus()
      await install.trigger('click')
      await vi.dynamicImportSettled()
      await flushPromises()

      expect(wrapper.get('.ci-redetect').attributes('disabled')).toBeDefined()
      expect(document.activeElement).toBe(wrapper.get('.ci-close').element)
    } finally {
      releaseProbe()
      await flushPromises()
      pendingProbe.mockRestore()
    }
  })
})
