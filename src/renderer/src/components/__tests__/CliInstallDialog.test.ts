// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CliInstallDialog from '../CliInstallDialog.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { OnboardDep, OnboardStatus } from '../../composables/useOnboarding'

// The install step embeds a real xterm; happy-dom has no canvas for it.
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

const depBase = {
  binary_path: '', resolved_path: '', install_method: '', update_cmd: '',
  doctor_cmd: '', autoupdate_env: '', autoupdate_policy: '',
} as const

function dep(over: Partial<OnboardDep> & { id: string }): OnboardDep {
  return {
    ...depBase,
    label: over.id,
    description: '',
    group: 'agent_cli',
    status: 'missing',
    version: '',
    min_version: '',
    optional: true,
    needs_terminal: true,
    can_install: true,
    install_cmd: `install ${over.id}`,
    docs_url: 'https://example.invalid/docs',
    ...over,
  } as OnboardDep
}

function status(over: Partial<OnboardStatus> = {}): OnboardStatus {
  return {
    deps: [dep({ id: 'qwen' }), dep({ id: 'homebrew', group: 'foundation', optional: false })],
    models: [],
    model_catalog: [],
    cli_health: {
      entries: [], findings: [], fingerprint: '', dismissed: false, needs_attention: false,
    },
    gate: {
      foundation_ready: false, has_any_cli: false, analyzer_ready: false, ollama_ok: false,
      ollama_service_up: false, has_model: false, all_required_ready: false,
      suggested_model: '',
    },
    install_prompt_dismissed: [],
    complete: true,
    ...over,
  }
}

function stubTerminal(result: { ok: boolean; error?: string } = { ok: true }) {
  const openTerminal = vi.fn((_command: string) => Promise.resolve(result))
  ;(globalThis as unknown as {
    window: { agentTeam: { openTerminal: (c: string) => Promise<{ ok: boolean; error?: string }> } }
  }).window.agentTeam = { openTerminal } as never
  return openTerminal
}

/** Every onboarding.run the dialog sent, in order. */
function runs(mock: ReturnType<typeof createMockBackend>) {
  return mock.sent.filter((s) => s.type === 'onboarding.run')
}

/** Let the command in the embedded terminal end. */
async function exitRun(
  mock: ReturnType<typeof createMockBackend>,
  exit: { exit_code: number | null; signal?: string },
  runId = 'run-1',
): Promise<void> {
  mock.emit('terminal.exit', { terminal_session_id: runId, ...exit })
  await flushPromises()
}

describe('CliInstallDialog', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function open(
    mock: ReturnType<typeof createMockBackend>,
    props: Record<string, unknown> = {},
  ): Promise<VueWrapper> {
    const w = mount(CliInstallDialog, {
      props: { backend: mock.backend, depId: 'qwen', ...props },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return w
  }

  it('opens on the check step of a three-step wizard', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    wrapper = await open(mock)

    const steps = wrapper.findAll('.ci-steps li')
    expect(steps).toHaveLength(3)
    expect(steps[0].classes()).toContain('active')
    expect(wrapper.text()).toContain(i18n.global.t('cli-install.check-title', { label: 'qwen' }))
  })

  it('lists only prerequisites it cannot install for the user', async () => {
    // Anything installable is a numbered link in the chain instead, so the two
    // lists never state the same requirement twice. curl has no provider.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [
        dep({ id: 'qwen', requirements: [{ name: 'npm', ok: false }, { name: 'curl', ok: false }] }),
        dep({ id: 'node', group: 'foundation', label: 'Node.js' }),
      ],
    }))
    wrapper = await open(mock)

    const rows = wrapper.findAll('.ci-reqs li')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('curl')
    // npm comes from Node, which appears in the ordered chain.
    expect(wrapper.findAll('.ci-chain li').map((li) => li.find('.ci-chain-label').text()))
      .toEqual(['Node.js', 'qwen'])
    expect(runs(mock)).toHaveLength(0)
  })

  describe('sign-in step', () => {
    const detected = () => status({ deps: [dep({ id: 'qwen', status: 'ok', version: '1.2.3' })] })

    it('asks for the login when the CLI is installed but signed out', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', detected())
      wrapper = await open(mock, { signInState: 'signed-out' })

      expect(wrapper.find('.ci-signin').exists()).toBe(true)
      expect(wrapper.text()).toContain(i18n.global.t('cli-install.signin-title', { label: 'qwen' }))
      // "Ready" must not be claimed for a CLI that cannot do anything yet.
      expect(wrapper.text()).not.toContain(i18n.global.t('cli-install.done-title', { label: 'qwen' }))
      // Still the verify step; only the verdict inside it changed.
      expect(wrapper.findAll('.ci-steps li')[2].classes()).toContain('active')
    })

    it('reports done when the CLI is installed and signed in', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', detected())
      wrapper = await open(mock, { signInState: 'signed-in' })

      expect(wrapper.find('.ci-signin').exists()).toBe(false)
      expect(wrapper.text()).toContain(i18n.global.t('cli-install.done-title', { label: 'qwen' }))
    })

    it.each([['unknown'], [undefined]])(
      'stays silent when sign-in state is %s',
      async (signInState) => {
        // "no credential file Navide can read" must never be shown as "signed
        // out" — that would put a false sign-in step on every CLI Navide
        // cannot inspect. An OMITTED prop has to land here too: a boolean prop
        // would have been cast to false by Vue and declared every caller that
        // left it out signed out, which is why this is a string union.
        const mock = createMockBackend('connected')
        mock.setResponse('onboarding.status', detected())
        wrapper = await open(mock, signInState === undefined ? {} : { signInState })

        expect(wrapper.find('.ci-signin').exists()).toBe(false)
        expect(wrapper.text()).toContain(i18n.global.t('cli-install.done-title', { label: 'qwen' }))
      },
    )

    it('emits login with the dep id and closes, so the login pane is visible', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', detected())
      wrapper = await open(mock, { signInState: 'signed-out' })

      await wrapper.find('.ci-signin').trigger('click')

      expect(wrapper.emitted('login')).toEqual([['qwen']])
      expect(wrapper.emitted('close')).toHaveLength(1)
    })

    it('reaches the sign-in step once the install exits 0 and a fresh re-detect finds the CLI', async () => {
      // The install runs in the embedded terminal; only its exit, followed by a
      // fresh probe, can tell the opener the CLI is there. The opener has to
      // hear `installed` then — it is what makes it refresh the sign-in state.
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', status())
      mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'install qwen' })
      wrapper = await open(mock, { signInState: 'unknown' })

      await wrapper.find('.ci-install').trigger('click')
      await flushPromises()
      expect(runs(mock).map((s) => s.payload)).toEqual([
        { kind: 'install', dep_id: 'qwen', cols: 100, rows: 24 },
      ])
      // Still running: nothing is installed yet.
      expect(wrapper.emitted('installed')).toBeUndefined()

      mock.setResponse('onboarding.status', detected())
      await exitRun(mock, { exit_code: 0 })

      // The pass after the exit re-probes PATH, since an installer may have
      // just written a new export.
      const probes = mock.sent.filter((s) => s.type === 'onboarding.status')
      expect(probes[probes.length - 1].payload).toEqual({ fresh: true })
      expect(wrapper.emitted('installed')).toEqual([['qwen']])
      // The opener answers `installed` by re-reading the sign-in state.
      await wrapper.setProps({ signInState: 'signed-out' })
      expect(wrapper.find('.ci-signin').exists()).toBe(true)
    })

    it('does not offer a sign-in before the CLI is even installed', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', status())
      wrapper = await open(mock, { signInState: 'signed-out' })

      expect(wrapper.find('.ci-signin').exists()).toBe(false)
    })
  })

  it('moves to the verify step by itself once the CLI is detected', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [dep({ id: 'qwen', status: 'ok', version: '1.2.3' })],
    }))
    wrapper = await open(mock)

    const steps = wrapper.findAll('.ci-steps li')
    expect(steps[2].classes()).toContain('active')
    expect(steps[0].classes()).toContain('done')
  })

  it('shows the exact command before anything runs', async () => {
    // Consent needs the command visible up front, not only in the result.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    wrapper = await open(mock)
    expect(wrapper.text()).toContain('install qwen')
    expect(runs(mock)).toHaveLength(0)
  })

  it('names a prerequisite the probe missed and stops there', async () => {
    // The probe said nothing was needed, but the install came back blocked.
    // The user must still be told which tool is missing.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', {
      ok: false, error: 'brew is required', missing_requirements: ['brew'],
    })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    // A refusal starts nothing: no terminal, nothing left running.
    expect(wrapper.find('[data-testid="install-terminal"]').exists()).toBe(false)
    // The late discovery joins the chain rather than vanishing between lists.
    expect(wrapper.findAll('.ci-chain li').map((li) => li.find('.ci-chain-label').text()))
      .toEqual(['homebrew', 'qwen'])
    // Blocked belongs back at the check step — the environment is the problem.
    expect(wrapper.findAll('.ci-steps li')[0].classes()).toContain('active')
  })

  it('offers the external terminal when the embedded one cannot start, instead of claiming success', async () => {
    const openTerminal = stubTerminal({ ok: true })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', {
      ok: false, spawn_failed: true, command: 'install qwen', error: 'posix_spawn failed',
    })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(wrapper.find('.ci-card.failed').exists()).toBe(true)
    expect(wrapper.emitted('installed')).toBeUndefined()
    const fallback = wrapper.get('[data-testid="install-terminal-fallback"]')
    expect(fallback.text()).toContain('install qwen')

    await wrapper.get('[data-testid="install-terminal-open-external"]').trigger('click')
    await flushPromises()
    expect(openTerminal).toHaveBeenCalledWith('install qwen')
  })

  it('surfaces the backend error text on a refused install', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', { ok: false, error: 'npm ERR! 404 not found' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(wrapper.find('.ci-error').text()).toContain('npm ERR! 404')
    // Retrying has to stay possible — the old confirm() offered one shot only.
    expect(wrapper.find('.ci-install').text()).toBe(i18n.global.t('cli-install.retry'))
  })

  it('shows a non-zero exit as a failure with its exit code', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'install qwen' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()
    await exitRun(mock, { exit_code: 1 })

    expect(wrapper.find('.ci-error').text()).toContain('Exited with code 1')
    expect(wrapper.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.exited-fail', { code: 1 })
    )
    expect(wrapper.emitted('installed')).toBeUndefined()
    // Finished, so everything unlocks again and Retry is on offer.
    expect(wrapper.find('.ci-close').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.ci-install').text()).toBe(i18n.global.t('cli-install.retry'))
  })

  it('reports an install that exited 0 but stayed undetected', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'install qwen' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()
    await exitRun(mock, { exit_code: 0 })

    expect(wrapper.text()).toContain(i18n.global.t('cli-install.installed-not-detected', { label: 'qwen' }))
    expect(wrapper.emitted('installed')).toBeUndefined()
  })

  it('switches to the ready state once the CLI is detected', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [dep({ id: 'qwen', status: 'ok', version: '1.2.3' })],
    }))
    wrapper = await open(mock)

    expect(wrapper.text()).toContain(i18n.global.t('cli-install.done-title', { label: 'qwen' }))
    expect(wrapper.find('.ci-install').exists()).toBe(false)
  })

  it('offers to start the pane again only when the prompt came from one', async () => {
    const ready = status({ deps: [dep({ id: 'qwen', status: 'ok', version: '1.2.3' })] })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', ready)

    wrapper = await open(mock, { origin: 'settings' })
    expect(wrapper.find('.ci-relaunch').exists()).toBe(false)
    wrapper.unmount()

    wrapper = await open(mock, { origin: 'pane' })
    await wrapper.find('.ci-relaunch').trigger('click')
    expect(wrapper.emitted('relaunch')?.[0]).toEqual(['qwen'])
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('persists the per-CLI opt-out', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install_prompt', { ok: true })
    wrapper = await open(mock)

    await wrapper.find('.ci-dont-ask input').setValue(true)
    await flushPromises()

    const sent = mock.sent.find((s) => s.type === 'onboarding.install_prompt')
    expect(sent?.payload).toEqual({ dep_id: 'qwen', dismissed: true })
  })

  it('shows the stored opt-out as already ticked', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({ install_prompt_dismissed: ['qwen'] }))
    wrapper = await open(mock)
    expect((wrapper.find('.ci-dont-ask input').element as HTMLInputElement).checked).toBe(true)
  })

  // A pane or spawn prompt is only ever about an agent CLI, so the box need not
  // wait for status to learn the dep's group. Waiting is what made the opt-out
  // unreachable: "Not Now" pressed before status arrived saved nothing, and the
  // next 127 asked again.
  it('offers the opt-out before status arrives for a pane prompt', async () => {
    const mock = createMockBackend('connected')
    mock.setRejection('onboarding.status', 'request timed out')
    mock.setResponse('onboarding.install_prompt', { ok: true })
    wrapper = await open(mock, { origin: 'pane' })

    await wrapper.find('.ci-dont-ask input').setValue(true)
    await flushPromises()

    const sent = mock.sent.find((s) => s.type === 'onboarding.install_prompt')
    expect(sent?.payload).toEqual({ dep_id: 'qwen', dismissed: true })
    expect(wrapper.emitted('dismiss-changed')?.[0]).toEqual([{ depId: 'qwen', dismissed: true }])
  })

  it('keeps a tick made before status arrived when that status predates it', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.install_prompt', { ok: true })
    const w = mount(CliInstallDialog, {
      props: { backend: mock.backend, depId: 'qwen', origin: 'spawn' },
      global: { plugins: [i18n] },
    })
    wrapper = w
    await w.find('.ci-dont-ask input').setValue(true)
    await flushPromises()
    // A status read that was answered before the write landed.
    mock.setResponse('onboarding.status', status({ install_prompt_dismissed: [] }))
    await w.find('.ci-redetect').trigger('click')
    await flushPromises()

    expect((w.find('.ci-dont-ask input').element as HTMLInputElement).checked).toBe(true)
  })

  it('hides the opt-out for foundation deps', async () => {
    // "Stop asking about Homebrew" would silence a prerequisite, not a choice.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    wrapper = await open(mock, { depId: 'homebrew' })
    expect(wrapper.find('.ci-dont-ask').exists()).toBe(false)
  })

  it('does not claim "no install command" while status is still loading', async () => {
    const mock = createMockBackend('connected')
    // No status response yet: the dep is unknown, not known-uninstallable.
    const w = mount(CliInstallDialog, {
      props: { backend: mock.backend, depId: 'qwen' },
      global: { plugins: [i18n] },
    })
    wrapper = w
    expect(w.text()).not.toContain(i18n.global.t('cli-install.no-install-command', { label: 'qwen' }))
  })

  it('tells the opener about the opt-out instead of making it re-probe', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install_prompt', { ok: true })
    wrapper = await open(mock)

    await wrapper.find('.ci-dont-ask input').setValue(true)
    await flushPromises()

    expect(wrapper.emitted('dismiss-changed')?.[0]).toEqual([{ depId: 'qwen', dismissed: true }])
  })

  it('keeps the box unticked when the backend rejects the opt-out', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.install_prompt', { ok: false, error: 'nope' })
    wrapper = await open(mock)

    await wrapper.find('.ci-dont-ask input').setValue(true)
    await flushPromises()

    expect((wrapper.find('.ci-dont-ask input').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.emitted('dismiss-changed')).toBeUndefined()
  })

  it('says so when a dep has no install command at all', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [dep({ id: 'qwen', can_install: false, install_cmd: '' })],
    }))
    wrapper = await open(mock)
    expect(wrapper.text()).toContain(i18n.global.t('cli-install.no-install-command', { label: 'qwen' }))
    expect(wrapper.find('.ci-install').exists()).toBe(false)
  })
})

/**
 * A machine that has never installed any CLI: picking one means Homebrew →
 * Node → that CLI. This is the case the dialog used to reveal one failure at a
 * time, so each step of the chain is pinned down here.
 */
describe('CliInstallDialog — dependency chain on a bare machine', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  /** homebrew (curl ok) → node (needs brew) → qwen (needs npm). */
  function bare(over: { installed?: string[] } = {}): OnboardStatus {
    const installed = new Set(over.installed ?? [])
    const mark = (id: string) => (installed.has(id) ? 'ok' : 'missing') as OnboardDep['status']
    return status({
      deps: [
        dep({
          id: 'qwen', label: 'Qwen Code', status: mark('qwen'),
          requirements: [{ name: 'npm', ok: installed.has('node') }],
        }),
        dep({
          id: 'node', label: 'Node.js', group: 'foundation', optional: false,
          needs_terminal: false, status: mark('node'),
          requirements: [{ name: 'brew', ok: installed.has('homebrew') }],
        }),
        dep({
          id: 'homebrew', label: 'Homebrew', group: 'foundation', optional: false,
          status: mark('homebrew'), requirements: [{ name: 'curl', ok: true }],
        }),
      ],
    })
  }

  async function open(
    mock: ReturnType<typeof createMockBackend>,
    props: Record<string, unknown> = {},
  ): Promise<VueWrapper> {
    const w = mount(CliInstallDialog, {
      props: { backend: mock.backend, depId: 'qwen', ...props },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return w
  }

  const installedIds = (mock: ReturnType<typeof createMockBackend>): string[] =>
    runs(mock).map((s) => s.payload.dep_id as string)

  it('shows the whole chain in order before anything runs', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare())
    wrapper = await open(mock)

    const links = wrapper.findAll('.ci-chain li')
    expect(links.map((li) => li.find('.ci-chain-label').text())).toEqual(['Homebrew', 'Node.js', 'Qwen Code'])
    expect(links[0].classes()).toContain('next')
    expect(installedIds(mock)).toEqual([])
  })

  it('names the prerequisite on the button rather than the CLI that was asked for', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare())
    wrapper = await open(mock)
    expect(wrapper.find('.ci-install').text()).toBe(
      i18n.global.t('cli-install.install-step', { label: 'Homebrew', total: 3 })
    )
  })

  it('installs the first link, not the CLI', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'install brew' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(runs(mock).map((s) => s.payload)).toEqual([
      { kind: 'install', dep_id: 'homebrew', cols: 100, rows: 24 },
    ])
  })

  /**
   * Run every command to its end in the embedded terminal: each onboarding.run
   * starts a PTY and that PTY exits with `exitCode(dep_id)`. When `takesEffect`,
   * a dep whose install exited 0 becomes detectable on the next status probe;
   * without it the machine never changes, which is a different case.
   */
  function withRunsExiting(
    mock: ReturnType<typeof createMockBackend>,
    opts: { initial?: string[]; exitCode?: (depId: string) => number; takesEffect?: boolean } = {},
  ): void {
    const installed = new Set(opts.initial ?? [])
    const exitCode = opts.exitCode ?? (() => 0)
    let started = 0
    const send = mock.backend.send.bind(mock.backend)
    mock.backend.send = ((type: string, payload: Record<string, unknown>, timeoutMs?: number) => {
      if (type === 'onboarding.status') {
        mock.setResponse('onboarding.status', bare({ installed: [...installed] }))
      }
      if (type !== 'onboarding.run') return send(type, payload, timeoutMs)
      const depId = String(payload.dep_id)
      const runId = `run-${++started}`
      mock.setResponse('onboarding.run', { ok: true, run_id: runId, command: `install ${depId}` })
      const reply = send(type, payload, timeoutMs)
      const code = exitCode(depId)
      if (code === 0 && opts.takesEffect !== false) installed.add(depId)
      // A fast command can exit before its reply lands; the run holds the
      // event until it knows its id.
      mock.emit('terminal.exit', { terminal_session_id: runId, exit_code: code })
      return reply
    }) as typeof mock.backend.send
  }

  it('continues into the next link once a step exits 0 and is detected', async () => {
    // With Homebrew already present the chain should run straight through to
    // the CLI without a second press.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew'] }))
    withRunsExiting(mock, { initial: ['homebrew'] })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['node', 'qwen'])
    expect(wrapper.emitted('installed')).toEqual([['qwen']])
  })

  it('walks the full chain from nothing installed', async () => {
    // The headline case: one press on a bare machine reaches the CLI.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare())
    withRunsExiting(mock)
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['homebrew', 'node', 'qwen'])
    expect(wrapper.emitted('installed')).toEqual([['qwen']])
  })

  it('stops the chain where a step exits non-zero, and shows the exit code', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew'] }))
    withRunsExiting(mock, { initial: ['homebrew'], exitCode: (id) => (id === 'node' ? 1 : 0) })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['node'])
    expect(wrapper.find('.ci-error').text()).toContain('Exited with code 1')
    expect(wrapper.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.exited-fail', { code: 1 })
    )
    expect(wrapper.emitted('installed')).toBeUndefined()
  })

  it('stops the chain where a step is refused', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew'] }))
    mock.setResponse('onboarding.run', { ok: false, error: 'brew: no bottle' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['node'])
    expect(wrapper.find('.ci-error').text()).toContain('no bottle')
  })

  it('stops when a step exits 0 but stays undetected', async () => {
    // "Installed" and "detectable" differ. Running the next command against a
    // machine that still cannot see this one is the exit-127 failure the chain
    // exists to prevent — and repeating the same link would recurse forever.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew'] }))
    withRunsExiting(mock, { initial: ['homebrew'], takesEffect: false })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['node'])
    expect(wrapper.text()).toContain(
      i18n.global.t('cli-install.installed-not-detected', { label: 'Node.js' })
    )
  })

  it('locks Install and Close while a prerequisite runs, and Cancel kills it', async () => {
    // A second press used to start a second install of the same prerequisite;
    // closing mid-run would orphan a prompt nobody can answer.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'install brew' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.ci-steps li')[1].classes()).toContain('active')
    expect(wrapper.text()).toContain(i18n.global.t('cli-install.install-title', { label: 'Homebrew' }))
    const button = wrapper.find('.ci-install')
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.ci-close').attributes('disabled')).toBeDefined()

    await button.trigger('click')
    await wrapper.find('.ci-close').trigger('click')
    await wrapper.find('.ci-page').trigger('click')
    await flushPromises()
    expect(installedIds(mock)).toEqual(['homebrew'])
    expect(wrapper.emitted('close')).toBeUndefined()

    await wrapper.get('[data-testid="install-terminal-cancel"]').trigger('click')
    await flushPromises()
    expect(mock.sent).toContainEqual(expect.objectContaining({
      type: 'terminal.kill', payload: { terminal_session_id: 'run-1' },
    }))

    await exitRun(mock, { exit_code: null, signal: 'SIGTERM' })

    // Cancelled is a stop, not a step forward: the chain goes no further.
    expect(installedIds(mock)).toEqual(['homebrew'])
    expect(wrapper.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.cancelled')
    )
    expect(wrapper.find('.ci-close').attributes('disabled')).toBeUndefined()
  })

  it('shows the install terminal while a prerequisite installs', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew'] }))
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'brew install node' })
    wrapper = await open(mock)

    await wrapper.find('.ci-install').trigger('click')
    await flushPromises()

    expect(installedIds(mock)).toEqual(['node'])
    expect(wrapper.findAll('.ci-steps li')[1].classes()).toContain('active')
    expect(wrapper.text()).toContain(i18n.global.t('cli-install.install-title', { label: 'Node.js' }))
    expect(wrapper.text()).toContain(i18n.global.t('cli-install.installing', { seconds: 0 }))
    const terminal = wrapper.get('[data-testid="install-terminal"]')
    expect(terminal.text()).toContain('brew install node')
    expect(wrapper.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.running')
    )
    expect(wrapper.find('.ci-install').attributes('disabled')).toBeDefined()

    await exitRun(mock, { exit_code: 0 })
  })

  it('hides the chain when the CLI has no unmet prerequisites', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bare({ installed: ['homebrew', 'node'] }))
    wrapper = await open(mock)

    expect(wrapper.find('.ci-chain').exists()).toBe(false)
    expect(wrapper.find('.ci-install').text()).toBe(i18n.global.t('cli-install.install'))
  })
})
