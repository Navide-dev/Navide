// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import OnboardingWizard from '../OnboardingWizard.vue'
import { useSettings } from '../../composables/useSettings'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { OnboardDep, OnboardStatus } from '../../composables/useOnboarding'

// The wizard embeds a real xterm for the running command; happy-dom has no
// canvas for it.
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

function dep(over: Partial<OnboardDep> & { id: string; group: OnboardDep['group'] }): OnboardDep {
  return {
    ...depBase,
    label: over.id,
    description: '',
    status: 'missing',
    version: '',
    min_version: '',
    optional: false,
    needs_terminal: false,
    can_install: true,
    docs_url: '',
    ...over,
  } as OnboardDep
}

/** Two missing foundation deps — enough to see whether the loop stops. */
function status(over: Partial<OnboardStatus> = {}): OnboardStatus {
  return {
    deps: [
      dep({ id: 'homebrew', group: 'foundation', needs_terminal: true }),
      dep({ id: 'node', group: 'foundation' }),
      dep({ id: 'claude', group: 'agent_cli', optional: true, needs_terminal: true }),
      dep({ id: 'ollama', group: 'analyzer' }),
    ],
    models: [],
    model_catalog: [],
    cli_health: {
      entries: [], findings: [], fingerprint: '', dismissed: false, needs_attention: false,
    },
    gate: {
      foundation_ready: false,
      has_any_cli: false,
      analyzer_ready: false,
      ollama_ok: false,
      ollama_service_up: false,
      has_model: false,
      all_required_ready: false,
      suggested_model: 'qwen2.5-coder:7b',
    },
    complete: false,
    ...over,
  }
}

/** Every install the wizard started, in order. */
function installRuns(mock: ReturnType<typeof createMockBackend>) {
  return mock.sent.filter((s) => s.type === 'onboarding.run' && s.payload.kind === 'install')
}

function installCount(mock: ReturnType<typeof createMockBackend>): number {
  return installRuns(mock).length
}

/**
 * Run every install to its end: each onboarding.run starts a PTY that exits
 * with `exitCode(dep_id)`. With `detected`, a dep whose command exited 0 reads
 * as installed on the next status probe (built by `statusFor`).
 */
function withRunsExiting(
  mock: ReturnType<typeof createMockBackend>,
  opts: {
    exitCode?: (depId: string) => number
    statusFor?: (installed: Set<string>) => OnboardStatus
  } = {},
): void {
  const installed = new Set<string>()
  const exitCode = opts.exitCode ?? (() => 0)
  let started = 0
  const send = mock.backend.send.bind(mock.backend)
  mock.backend.send = ((type: string, payload: Record<string, unknown>, timeoutMs?: number) => {
    if (type === 'onboarding.status' && opts.statusFor) {
      mock.setResponse('onboarding.status', opts.statusFor(installed))
    }
    if (type !== 'onboarding.run') return send(type, payload, timeoutMs)
    const depId = String(payload.dep_id)
    const runId = `run-${++started}`
    mock.setResponse('onboarding.run', { ok: true, run_id: runId, command: `install ${depId}` })
    const reply = send(type, payload, timeoutMs)
    const code = exitCode(depId)
    if (code === 0) installed.add(depId)
    // Held by the run until its reply names the id, like a fast command.
    mock.emit('terminal.exit', { terminal_session_id: runId, exit_code: code })
    return reply
  }) as typeof mock.backend.send
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

describe('OnboardingWizard', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function open(mock: ReturnType<typeof createMockBackend>): Promise<VueWrapper> {
    const w = mount(OnboardingWizard, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return w
  }

  describe('saving completion', () => {
    const skip = (w: VueWrapper) => w.findAll('.ob-footer button').find(
      (button) => button.text() === i18n.global.t('action.skip-for-now'))!

    it('stays open and says so when skipping could not be saved, then closes on a retry', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', status())
      mock.setResponse('onboarding.complete', { ok: false, error: 'disk full' })
      wrapper = await open(mock)

      await skip(wrapper).trigger('click')
      await flushPromises()

      expect(wrapper.emitted('close')).toBeUndefined()
      expect(wrapper.get('.ob-complete-error').text()).toBe(
        i18n.global.t('onboard.complete-failed', { error: 'disk full' })
      )

      mock.setResponse('onboarding.complete', { ok: true })
      await skip(wrapper).trigger('click')
      await flushPromises()

      expect(wrapper.emitted('close')).toEqual([[]])
    })

    it('does not open the app on a finish that could not be saved', async () => {
      const ready = status()
      ready.gate = { ...ready.gate, all_required_ready: true }
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', ready)
      mock.setRejection('onboarding.complete', 'ws not open')
      wrapper = await open(mock)
      const steps = wrapper.findAll('.ob-steps button')
      await steps[steps.length - 1].trigger('click')

      await wrapper.findAll('.ob-footer button').find(
        (button) => button.text() === i18n.global.t('action.open-app'))!.trigger('click')
      await flushPromises()

      expect(wrapper.emitted('complete')).toBeUndefined()
      expect(wrapper.get('.ob-complete-error').text()).toBe(
        i18n.global.t('onboard.complete-failed', { error: 'ws not open' })
      )
    })
  })

  it('offers native language names and switches to Japanese', async () => {
    const previous = i18n.global.locale.value
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    try {
      wrapper = await open(mock)
      const select = wrapper.get('select.ob-lang-btn')
      const beta = i18n.global.t('settings.appearance.language-beta')
      expect(select.findAll('option').map(option => option.text())).toEqual(
        ['繁體中文', 'English', '日本語', `한국어 (${beta})`, `简体中文 (${beta})`]
      )
      await select.setValue('ja-JP')
      expect(i18n.global.locale.value).toBe('ja-JP')
      expect(wrapper.text()).toContain(i18n.global.t('onboard.step.environment'))
    } finally { useSettings().setLanguage(previous, { broadcast: false }) }
  })

  it('stops installing the rest once one install exits non-zero', async () => {
    // Homebrew failed, so `brew install node` right after it would fail with
    // exit 127 on a fresh Mac.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    withRunsExiting(mock, { exitCode: () => 1 })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    expect(installRuns(mock).map((s) => s.payload.dep_id)).toEqual(['homebrew'])
    // The failure is on the card, with the exit code, not only in the log.
    const card = wrapper.findAll('.oc-card.expanded')[0]
    expect(card.find('.oc-error').text()).toContain('Exited with code 1')
    expect(wrapper.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.exited-fail', { code: 1 })
    )
  })

  it('stops when an install is blocked by a missing bootstrap binary', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', {
      ok: false, error: 'brew is required', missing_requirements: ['brew'],
    })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    expect(installCount(mock)).toBe(1)
  })

  it('still installs every missing dep when nothing blocks', async () => {
    // Guards the stop conditions above from becoming an unconditional break.
    const initial = (installed: Set<string>) => status({
      deps: [
        dep({ id: 'node', group: 'foundation', status: installed.has('node') ? 'ok' : 'missing' }),
        dep({ id: 'pnpm', group: 'foundation', status: installed.has('pnpm') ? 'ok' : 'missing' }),
      ],
    })
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', initial(new Set()))
    withRunsExiting(mock, { statusFor: initial })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    expect(installRuns(mock).map((s) => s.payload.dep_id)).toEqual(['node', 'pnpm'])
    // Each exit was followed by a fresh re-detect before the next install.
    expect(mock.sent.filter((s) => s.type === 'onboarding.status' && s.payload.fresh)).toHaveLength(2)
  })

  it('surfaces a failed install in the log with the backend text', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', { ok: false, error: 'Error: no bottle available' })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    const log = wrapper.find('.ob-log').text()
    expect(log).toContain('no bottle available')
    expect(log).not.toContain('unknown')
  })

  // ── A single card's Install button ──────────────────────────────────────────
  // The reported symptom was "I click Python and nothing happens". Every case
  // below ends with the backend failing in well under a second, which used to
  // reach the user only through the log pane at the bottom of the column.

  /** Python as the backend actually reports it on a Mac without Homebrew. */
  function pythonStatus(brewOk: boolean): OnboardStatus {
    return status({
      deps: [
        dep({
          id: 'homebrew', label: 'Homebrew', group: 'foundation',
          needs_terminal: true, status: brewOk ? 'ok' : 'missing',
        }),
        dep({
          id: 'python', label: 'Python', group: 'foundation',
          install_cmd: 'brew install python3',
          requirements: [{ name: 'brew', ok: brewOk }],
        }),
      ],
    })
  }

  /** The Install button on the currently expanded card. */
  function installButton(w: VueWrapper) {
    return w.findAll('.oc-card.expanded .ob-btn.primary')[0]
  }

  it('sends the install request when a single card Install is clicked', async () => {
    // Nothing covered this at all: the existing cases all went through the
    // batch "install missing" link, not a card's own button.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', pythonStatus(true))
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'brew install python3' })
    wrapper = await open(mock)

    // Homebrew is ok, so Python is the first unfinished card and is expanded.
    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(installRuns(mock)).toEqual([
      expect.objectContaining({ payload: { kind: 'install', dep_id: 'python', cols: 100, rows: 24 } }),
    ])
    await exitRun(mock, { exit_code: 0 })
  })

  it('shows a blocked install on the card, not only in the log', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', pythonStatus(true))
    mock.setResponse('onboarding.run', {
      ok: false,
      error: 'brew is required to install Python. Install brew first, then retry.',
      missing_requirements: ['brew'],
    })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const card = wrapper.findAll('.oc-card.expanded')[0]
    expect(card.find('.oc-error').exists()).toBe(true)
    const text = card.find('.oc-error').text()
    expect(text).toContain('brew is required')
    // A failing in-app install must still leave a way forward by hand.
    expect(text).toContain('brew install python3')
  })

  it('names the missing prerequisite before the user clicks Install', async () => {
    // The backend already reports each dep's prerequisites and their state;
    // the wizard used to drop that and let the click fail instead.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', pythonStatus(false))
    wrapper = await open(mock)

    // Homebrew is the first unfinished card; open Python's.
    await wrapper.findAll('.oc-head')[1].trigger('click')
    await flushPromises()

    const card = wrapper.findAll('.oc-card.expanded')[0]
    expect(card.find('.oc-error').text()).toContain('Homebrew')
    // No install has been attempted — this is a pre-click warning.
    expect(installCount(mock)).toBe(0)
  })

  it('jumps to the prerequisite card from the blocked dep', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', pythonStatus(false))
    wrapper = await open(mock)

    await wrapper.findAll('.oc-head')[1].trigger('click')
    await flushPromises()
    const goTo = wrapper
      .findAll('.oc-card.expanded .ob-btn.ghost')
      .find((b) => b.text().includes('Homebrew'))
    expect(goTo).toBeDefined()

    await goTo!.trigger('click')
    await flushPromises()

    // Homebrew's card is now the expanded one.
    const cards = wrapper.findAll('.oc-card')
    expect(cards[0].classes()).toContain('expanded')
    expect(cards[1].classes()).not.toContain('expanded')
  })

  it('shows the install terminal and locks Skip, Back and Next while a command runs', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'npm install -g claude' })
    wrapper = await open(mock)
    // The agents step: it has Back as well as Skip and Next.
    await wrapper.findAll('.ob-steps button')[1].trigger('click')
    await flushPromises()

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const terminal = wrapper.get('[data-testid="install-terminal"]')
    expect(terminal.text()).toContain('npm install -g claude')
    expect(wrapper.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.running')
    )
    const footer = (label: string) => wrapper!.findAll('.ob-footer button').find((b) => b.text() === label)!
    for (const label of ['action.skip-for-now', 'action.back', 'action.next']) {
      expect(footer(i18n.global.t(label)).attributes('disabled'), label).toBeDefined()
    }
    expect(installButton(wrapper).attributes('disabled')).toBeDefined()

    await wrapper.get('[data-testid="install-terminal-cancel"]').trigger('click')
    await flushPromises()
    expect(mock.sent).toContainEqual(expect.objectContaining({
      type: 'terminal.kill', payload: { terminal_session_id: 'run-1' },
    }))

    await exitRun(mock, { exit_code: null, signal: 'SIGTERM' })

    expect(wrapper.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.cancelled')
    )
    for (const label of ['action.skip-for-now', 'action.back', 'action.next']) {
      expect(footer(i18n.global.t(label)).attributes('disabled'), label).toBeUndefined()
    }
  })

  it('distinguishes "still the old version" from "not detected at all"', async () => {
    // `brew install python3` exits 0 while /usr/bin/python3 (3.9) keeps winning
    // the PATH. Saying "not detected" there is simply untrue.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [
        dep({
          id: 'python', label: 'Python', group: 'foundation',
          status: 'outdated', version: '3.9.6', min_version: '3.12.0',
          install_cmd: 'brew install python3',
        }),
      ],
    }))
    withRunsExiting(mock)
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const text = wrapper.find('.oc-error').text()
    expect(text).toContain('3.9.6')
    expect(text).not.toContain(i18n.global.t('onboard.installed-not-detected', { label: 'Python' }))
    // Both fixes spelled out literally — `@` and `$(` are message-syntax
    // characters, so a wrong escape would garble exactly these commands.
    expect(text).toContain('brew link --overwrite python@3.x')
    expect(text).toContain('eval "$(/opt/homebrew/bin/brew shellenv)"')
  })

  it('keeps the Python-only repairs off any other outdated dep', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [
        dep({
          id: 'node', label: 'Node.js', group: 'foundation',
          status: 'outdated', version: '20.11.0', min_version: '22.0.0',
          install_cmd: 'brew install node',
        }),
      ],
    }))
    withRunsExiting(mock)
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const text = wrapper.find('.oc-error').text()
    expect(text).toBe(i18n.global.t('onboard.installed-still-outdated', { label: 'Node.js', version: '20.11.0' }))
    expect(text).not.toContain('brew link')
  })

  it('installs a prerequisite before whatever needs it', async () => {
    // In list order this ran `brew install python3` first, which exits 127 on
    // a Mac with no Homebrew.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [
        dep({ id: 'python', group: 'foundation', requirements: [{ name: 'brew', ok: false }] }),
        dep({ id: 'homebrew', group: 'foundation', needs_terminal: true }),
      ],
    }))
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'install-brew.sh' })
    wrapper = await open(mock)

    await wrapper.find('.ob-linkbtn').trigger('click')
    await flushPromises()

    // Homebrew is still running: Python waits for it.
    expect(installRuns(mock)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ kind: 'install', dep_id: 'homebrew' }) }),
    ])
    await exitRun(mock, { exit_code: 0 })
  })

  describe('starting the Ollama service fails', () => {
    async function clickStart(mock: ReturnType<typeof createMockBackend>): Promise<VueWrapper> {
      const s = status()
      s.deps = s.deps.map((d) => (d.id === 'ollama' ? { ...d, status: 'ok' as const } : d))
      s.gate = { ...s.gate, ollama_ok: true, ollama_service_up: false }
      mock.setResponse('onboarding.status', s)
      const w = await open(mock)
      await w.findAll('.ob-steps button')[1].trigger('click')
      await flushPromises()
      await w.findAll('.oc-head')[1].trigger('click')
      await flushPromises()
      await w.findAll('button').find((b) => b.text() === i18n.global.t('action.start-ollama'))!.trigger('click')
      await flushPromises()
      return w
    }

    it('shows a refusal on the Ollama card', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.run', { ok: false, error: 'ollama is not installed' })
      wrapper = await clickStart(mock)

      expect(mock.sent.find((s) => s.type === 'onboarding.run')?.payload).toEqual(
        { kind: 'start_ollama', cols: 100, rows: 24 }
      )
      expect(wrapper.get('.oc-error').text()).toBe(i18n.global.t('onboard.ollama-start-failed'))
    })

    it('shows a transport failure on the Ollama card', async () => {
      const mock = createMockBackend('connected')
      mock.setRejection('onboarding.run', 'ws not open')
      wrapper = await clickStart(mock)

      expect(wrapper.get('.oc-error').text()).toBe(i18n.global.t('onboard.ollama-start-failed'))
    })
  })

  it('offers to start the Ollama service when it is installed but down', async () => {
    const s = status()
    s.deps = s.deps.map((d) => (d.id === 'ollama' ? { ...d, status: 'ok' as const } : d))
    s.gate = { ...s.gate, ollama_ok: true, ollama_service_up: false }
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    wrapper = await open(mock)

    // Step 2 holds the agent CLIs and the analyzer.
    await wrapper.findAll('.ob-steps button')[1].trigger('click')
    await flushPromises()
    // ollama detects as ok, so its card is collapsed — expanding a finished
    // card is exactly what used to be a dead click.
    await wrapper.findAll('.oc-head')[1].trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain(i18n.global.t('action.start-ollama'))
    expect(wrapper.text()).toContain(i18n.global.t('onboard.ollama-stopped'))
  })

  describe('environment step with everything detected', () => {
    function allFoundationOk(): OnboardStatus {
      const s = status()
      s.deps = [
        dep({ id: 'homebrew', group: 'foundation', status: 'ok', version: '5.0.14' }),
        dep({ id: 'python', group: 'foundation', status: 'ok', version: '3.13.11', min_version: '3.12.0' }),
        dep({ id: 'uv', group: 'foundation', status: 'ok', version: '0.6.6', docs_url: 'https://docs.astral.sh/uv' }),
      ]
      s.gate = { ...s.gate, foundation_ready: true }
      return s
    }

    it('leaves every card collapsed and drops "Install missing"', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', allFoundationOk())
      wrapper = await open(mock)

      // Used to fall back to the last card (uv), expanded with an Install button.
      expect(wrapper.findAll('.oc-card.expanded')).toHaveLength(0)
      expect(wrapper.findAll('.oc-card.done')).toHaveLength(3)
      expect(wrapper.find('.ob-linkbtn').exists()).toBe(false)
    })

    it('opens a finished card to re-detect only, without an install action', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', allFoundationOk())
      wrapper = await open(mock)

      await wrapper.findAll('.oc-head')[2].trigger('click')
      await flushPromises()

      const card = wrapper.get('.oc-card.expanded')
      expect(card.findAll('.ob-btn.primary')).toHaveLength(0)
      expect(card.text()).toContain(i18n.global.t('action.re-detect'))
    })

    it('still flags an outdated dep instead of a checkmark, and offers its install', async () => {
      const s = allFoundationOk()
      s.deps = s.deps.map((d) => (d.id === 'python'
        ? { ...d, status: 'outdated' as const, version: '3.9.6' }
        : d))
      s.gate = { ...s.gate, foundation_ready: false }
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', s)
      wrapper = await open(mock)

      const card = wrapper.get('.oc-card.expanded')
      expect(card.classes()).not.toContain('done')
      expect(card.get('.oc-warn').text()).toBe(i18n.global.t('onboard.outdated', { min: '3.12.0' }))
      expect(card.get('.ob-btn.primary').text()).toBe(i18n.global.t('onboard.install'))
      expect(wrapper.find('.ob-linkbtn').exists()).toBe(true)
    })
  })
})
