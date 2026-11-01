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

/** A missing CLI next to the foundation and analyzer deps the wizard no longer shows. */
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

const listOf = (...names: string[]): string =>
  new Intl.ListFormat(i18n.global.locale.value, { style: 'long', type: 'conjunction' }).format(names)

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
        ['繁體中文', 'English', '日本語', `한국어 (${beta})`, `简体中文 (${beta})`, `Deutsch (${beta})`, `Español (España) (${beta})`, `Français (${beta})`, `Português (Brasil) (${beta})`, `Русский (${beta})`, `Tiếng Việt (${beta})`]
      )
      await select.setValue('ja-JP')
      expect(i18n.global.locale.value).toBe('ja-JP')
      expect(wrapper.text()).toContain(i18n.global.t('onboard.step.agents'))
    } finally { useSettings().setLanguage(previous, { broadcast: false }) }
  })

  // ── No environment step ─────────────────────────────────────────────────────
  // The packaged app never runs Homebrew, Node, pnpm, Python or uv itself; a CLI
  // that needs one brings it in through its own Install.

  it('opens on the Agents step and has no environment step', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    wrapper = await open(mock)

    const steps = wrapper.findAll('.ob-steps button').map((b) => b.text())
    expect(steps[0]).toBe(i18n.global.t('onboard.step.agents'))
    expect(steps).not.toContain(i18n.global.t('onboard.step.environment'))
    expect(wrapper.get('.ob-head').text()).toBe(i18n.global.t('onboard.head.agents'))
  })

  it('lists the agent CLIs only: no foundation, Ollama or model card', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    wrapper = await open(mock)

    expect(wrapper.findAll('.oc-card')).toHaveLength(1)
    expect(wrapper.text()).toContain('claude')
    expect(wrapper.text()).not.toContain('ollama')
    expect(wrapper.text()).not.toContain(i18n.global.t('label.analysis-model'))
  })

  it('opens the app with a CLI in, whatever the foundation tools say', async () => {
    const s = status()
    // What the backend reports now: one CLI is the whole gate.
    s.gate = { ...s.gate, foundation_ready: false, has_any_cli: true, all_required_ready: true }
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    mock.setResponse('onboarding.complete', { ok: true })
    wrapper = await open(mock)
    const steps = wrapper.findAll('.ob-steps button')
    await steps[steps.length - 1].trigger('click')

    const gate = wrapper.get('.ob-gate').text()
    expect(gate).not.toContain(i18n.global.t('label.foundation-ready'))
    expect(gate).not.toContain(i18n.global.t('label.ollama-model-ready'))
    const openApp = wrapper.findAll('.ob-footer button').find(
      (button) => button.text() === i18n.global.t('action.open-app'))!
    expect(openApp.attributes('disabled')).toBeUndefined()
    await openApp.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('complete')).toEqual([[]])
  })

  // ── A CLI's Install runs its prerequisites first ────────────────────────────

  /** Claude Code on a bare Mac: it needs npm, Node needs brew, brew needs curl. */
  function bareMac(installed: Set<string> = new Set()): OnboardStatus {
    const has = (id: string) => installed.has(id)
    return status({
      deps: [
        dep({ id: 'homebrew', label: 'Homebrew', group: 'foundation', needs_terminal: true,
          status: has('homebrew') ? 'ok' : 'missing' }),
        dep({ id: 'node', label: 'Node.js', group: 'foundation', install_cmd: 'brew install node',
          status: has('node') ? 'ok' : 'missing', requirements: [{ name: 'brew', ok: has('homebrew') }] }),
        dep({ id: 'claude', label: 'Claude Code', group: 'agent_cli', optional: true, needs_terminal: true,
          install_cmd: 'npm install -g @anthropic-ai/claude-code',
          status: has('claude') ? 'ok' : 'missing', requirements: [{ name: 'npm', ok: has('node') }] }),
      ],
    })
  }

  /** The Install button on the currently expanded card. */
  function installButton(w: VueWrapper) {
    return w.findAll('.oc-card.expanded .ob-btn.primary')[0]
  }

  it('installs Homebrew, then Node, then the CLI from the CLI card', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareMac())
    withRunsExiting(mock, { statusFor: bareMac })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(installRuns(mock).map((s) => s.payload.dep_id)).toEqual(['homebrew', 'node', 'claude'])
    // Each exit was followed by a fresh re-detect before the next install.
    expect(mock.sent.filter((s) => s.type === 'onboarding.status' && s.payload.fresh)).toHaveLength(3)
  })

  it('stops the chain once a prerequisite exits non-zero, and says so on the CLI card', async () => {
    // Homebrew failed, so `brew install node` right after it would fail with
    // exit 127 on a fresh Mac.
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareMac())
    withRunsExiting(mock, { exitCode: () => 1 })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(installRuns(mock).map((s) => s.payload.dep_id)).toEqual(['homebrew'])
    // Homebrew has no card here: its failure lands on the card that ran it.
    const card = wrapper.findAll('.oc-card.expanded')[0]
    expect(card.find('.oc-error').text()).toContain('Exited with code 1')
    expect(card.find('.oc-error').text()).toContain('install homebrew')
    expect(wrapper.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.exited-fail', { code: 1 })
    )
  })

  it('waits for a running prerequisite before the next link', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareMac())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'install-brew.sh' })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    // Homebrew is still running: Node and the CLI wait for it.
    expect(installRuns(mock)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ kind: 'install', dep_id: 'homebrew' }) }),
    ])
    await exitRun(mock, { exit_code: 0 })
  })

  it('stops when an install is blocked by a missing bootstrap binary', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareMac())
    mock.setResponse('onboarding.run', {
      ok: false, error: 'curl is required', missing_requirements: ['curl'],
    })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(installCount(mock)).toBe(1)
    expect(wrapper.get('.oc-card.expanded .oc-error').text()).toContain('curl is required')
  })

  it('announces the prerequisites it will install before the user clicks', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareMac())
    wrapper = await open(mock)

    // The whole chain Install runs, not only the nearest link.
    expect(wrapper.get('.oc-card.expanded .oc-notice').text()).toBe(
      i18n.global.t('onboard.installs-first', { names: listOf('Homebrew', 'Node.js') })
    )
    // No install has been attempted, and there is no card to jump to.
    expect(installCount(mock)).toBe(0)
    expect(wrapper.findAll('.oc-card.expanded .ob-btn.ghost').map((b) => b.text())).toEqual([
      i18n.global.t('action.re-detect'),
    ])
  })

  // ── A notice is not an error ────────────────────────────────────────────────

  it('never dresses an announcement as a failure, expanded or collapsed', async () => {
    const s = bareMac()
    s.deps.push(dep({ id: 'qwen', label: 'Qwen', group: 'agent_cli', optional: true,
      requirements: [{ name: 'npm', ok: false }] }))
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    wrapper = await open(mock)

    // A bare machine is the normal first run: nothing here has gone wrong.
    expect(wrapper.find('.oc-error').exists()).toBe(false)
    expect(wrapper.find('.oc-alert').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(installButton(wrapper).text()).toBe(i18n.global.t('onboard.install'))
  })

  it('keeps a real failure red, and flags it on the card once collapsed', async () => {
    const s = bareMac()
    s.deps.push(dep({ id: 'grok', label: 'Grok', group: 'agent_cli', optional: true }))
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    withRunsExiting(mock, { exitCode: () => 1 })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const card = wrapper.get('.oc-card.expanded')
    expect(card.get('.oc-error').attributes('role')).toBe('alert')
    expect(card.get('.oc-error').text()).toContain('Exited with code 1')
    expect(card.find('.oc-notice').exists()).toBe(false)

    await wrapper.findAll('.oc-head')[1].trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.oc-card')[0].find('.oc-alert').exists()).toBe(true)
  })

  it('reports a shared prerequisite failure only on the card that ran it', async () => {
    const s = bareMac()
    s.deps.push(dep({ id: 'qwen', label: 'Qwen', group: 'agent_cli', optional: true,
      requirements: [{ name: 'npm', ok: false }] }))
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    withRunsExiting(mock, { exitCode: () => 1 })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()
    await wrapper.findAll('.oc-head')[1].trigger('click')
    await flushPromises()

    // Qwen was never installed: it still offers its own Install, no red "!".
    expect(wrapper.findAll('.oc-card')[1].find('.oc-error').exists()).toBe(false)
    expect(wrapper.findAll('.oc-card')[0].find('.oc-alert').exists()).toBe(true)
    expect(wrapper.findAll('.oc-alert')).toHaveLength(1)
  })

  it('announces nothing on a CLI that is already installed', async () => {
    const s = bareMac()
    s.deps = s.deps.map((d) => (d.id === 'claude' ? { ...d, status: 'ok' as const, version: '2.1.0' } : d))
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    wrapper = await open(mock)

    await wrapper.findAll('.oc-head')[0].trigger('click')
    await flushPromises()

    expect(wrapper.get('.oc-card.expanded').classes()).toContain('done')
    expect(wrapper.find('.oc-notice').exists()).toBe(false)
  })

  it('does not call a CLI optional on the step that needs one', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareMac())
    wrapper = await open(mock)

    expect(wrapper.find('.oc-tag').exists()).toBe(false)
  })

  describe('the Ready aside', () => {
    const goToReady = async (w: VueWrapper) => {
      const steps = w.findAll('.ob-steps button')
      await steps[steps.length - 1].trigger('click')
      await flushPromises()
    }

    it('says what is missing while Open App is locked', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', status())
      wrapper = await open(mock)
      await goToReady(wrapper)

      expect(wrapper.text()).toContain(i18n.global.t('onboard.aside.ready-locked'))
      expect(wrapper.get('.ob-head').text()).toBe(i18n.global.t('onboard.head.ready-locked'))
      expect(wrapper.text()).not.toContain(i18n.global.t('onboard.aside.ready'))
    })

    it('keeps its message once Open App is available', async () => {
      const s = status()
      s.gate = { ...s.gate, has_any_cli: true, all_required_ready: true }
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', s)
      wrapper = await open(mock)
      await goToReady(wrapper)

      expect(wrapper.text()).toContain(i18n.global.t('onboard.aside.ready'))
      expect(wrapper.get('.ob-head').text()).toBe(i18n.global.t('onboard.head.ready'))
    })
  })

  // ── A prerequisite this app cannot install ──────────────────────────────────

  /** Linux: the registry has no install command for Node. */
  function bareLinux(): OnboardStatus {
    const s = bareMac()
    s.deps = s.deps
      .filter((d) => d.id !== 'homebrew')
      .map((d) => (d.id === 'node'
        ? { ...d, can_install: false, install_cmd: '', requirements: [], docs_url: 'https://nodejs.org' }
        : d))
    s.deps.find((d) => d.id === 'claude')!.docs_url = 'https://example.test/claude'
    return s
  }

  it('tells the user what to do about a prerequisite it cannot install', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareLinux())
    wrapper = await open(mock)

    const card = wrapper.get('.oc-card.expanded')
    expect(card.get('.oc-warn').text()).toBe(
      i18n.global.t('onboard.blocked-by', { names: 'Node.js', action: i18n.global.t('action.re-detect') })
    )
    expect(card.find('.oc-error').exists()).toBe(false)
    const guide = card.get('a.ob-btn.primary')
    expect(guide.text()).toBe(i18n.global.t('onboard.manual-guide', { name: 'Node.js' }))
    expect(guide.attributes('href')).toBe('https://nodejs.org')
    expect(guide.attributes('target')).toBe('_blank')
  })

  it('has no Install to press while a prerequisite blocks it', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareLinux())
    wrapper = await open(mock)

    const card = wrapper.get('.oc-card.expanded')
    const install = i18n.global.t('onboard.install')
    expect(card.findAll('button').map((b) => b.text())).not.toContain(install)
    // The vendor's own guide stays reachable: it may list a route without Node.
    expect(card.findAll('a.ob-btn.ghost').map((a) => a.attributes('href'))).toEqual(['https://example.test/claude'])
    expect(installCount(mock)).toBe(0)
  })

  it('marks a blocked card while collapsed, without calling it a failure', async () => {
    const s = bareLinux()
    s.deps.push(dep({ id: 'grok', label: 'Grok', group: 'agent_cli', optional: true }))
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    wrapper = await open(mock)

    await wrapper.findAll('.oc-head')[1].trigger('click')
    await flushPromises()

    const collapsed = wrapper.findAll('.oc-card')[0]
    expect(collapsed.get('.oc-tag-blocked').text()).toBe(
      i18n.global.t('onboard.needs-prereq', { names: 'Node.js' })
    )
    expect(collapsed.find('.oc-alert').exists()).toBe(false)
  })

  it('re-probes the login shell PATH on Re-detect, and offers Install once Node is there', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareLinux())
    wrapper = await open(mock)

    // Node installed by hand: nvm and friends only reach PATH via the login shell.
    const fixed = bareLinux()
    fixed.deps = fixed.deps.map((d) => {
      if (d.id === 'node') return { ...d, status: 'ok' as const, version: '24.0.0' }
      return d.id === 'claude' ? { ...d, requirements: [{ name: 'npm', ok: true }] } : d
    })
    mock.setResponse('onboarding.status', fixed)
    await wrapper.get('.oc-card.expanded .ob-btn.ghost:not(a)').trigger('click')
    await flushPromises()

    expect(mock.sent.filter((m) => m.type === 'onboarding.status').at(-1)?.payload).toEqual({ fresh: true })
    expect(wrapper.find('.oc-warn').exists()).toBe(false)
    expect(wrapper.find('.oc-tag-blocked').exists()).toBe(false)
    expect(installButton(wrapper).text()).toBe(i18n.global.t('onboard.install'))
  })

  it('leaves Re-detect as it was on a card with nothing blocking it', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', bareMac())
    wrapper = await open(mock)

    await wrapper.get('.oc-card.expanded .ob-btn.ghost').trigger('click')
    await flushPromises()

    expect(mock.sent.filter((m) => m.type === 'onboarding.status').at(-1)?.payload).toEqual({})
  })

  it('says nothing about a prerequisite an installed CLI got by without', async () => {
    // Claude Code from the native installer, on a machine with no Node.
    const s = bareLinux()
    s.deps = s.deps.map((d) => (d.id === 'claude' ? { ...d, status: 'ok' as const, version: '2.1.0' } : d))
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    wrapper = await open(mock)

    await wrapper.findAll('.oc-head')[0].trigger('click')
    await flushPromises()

    expect(wrapper.get('.oc-card.expanded').classes()).toContain('done')
    expect(wrapper.find('.oc-warn').exists()).toBe(false)
    expect(wrapper.find('.oc-tag-blocked').exists()).toBe(false)
  })

  it('names a binary with no dep behind it, with no Install and no invented link', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [dep({ id: 'aider', label: 'Aider', group: 'agent_cli', requirements: [{ name: 'curl', ok: false }] })],
    }))
    wrapper = await open(mock)

    const card = wrapper.get('.oc-card.expanded')
    expect(card.get('.oc-warn').text()).toBe(
      i18n.global.t('onboard.blocked-by', { names: 'curl', action: i18n.global.t('action.re-detect') })
    )
    expect(card.findAll('.ob-btn').map((b) => b.text())).toEqual([i18n.global.t('action.re-detect')])
  })

  it('blocks on Node, not on its package manager, when the chain cannot start', async () => {
    // Windows without winget: Node has an install command nothing can run.
    const s = bareMac()
    s.deps = s.deps
      .filter((d) => d.id !== 'homebrew')
      .map((d) => (d.id === 'node'
        ? { ...d, docs_url: 'https://nodejs.org', requirements: [{ name: 'winget', ok: false }] }
        : d))
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', s)
    wrapper = await open(mock)

    expect(wrapper.get('.oc-card.expanded a.ob-btn.primary').attributes('href')).toBe('https://nodejs.org')
    expect(wrapper.find('.oc-card.expanded .oc-tag-blocked').text()).toBe(
      i18n.global.t('onboard.needs-prereq', { names: 'Node.js' })
    )
  })

  it('sends the install request when a single card Install is clicked', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'npm install -g claude' })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(installRuns(mock)).toEqual([
      expect.objectContaining({ payload: { kind: 'install', dep_id: 'claude', cols: 100, rows: 24 } }),
    ])
    await exitRun(mock, { exit_code: 0 })
  })

  it('surfaces a failed install in the log and on the card with the backend text', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [dep({ id: 'claude', group: 'agent_cli', install_cmd: 'npm install -g @anthropic-ai/claude-code' })],
    }))
    mock.setResponse('onboarding.run', { ok: false, error: 'Error: npm ERR! EACCES' })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const log = wrapper.find('.ob-log').text()
    expect(log).toContain('EACCES')
    expect(log).not.toContain('unknown')
    const text = wrapper.get('.oc-card.expanded .oc-error').text()
    expect(text).toContain('EACCES')
    // A failing in-app install must still leave a way forward by hand.
    expect(text).toContain('npm install -g @anthropic-ai/claude-code')
  })

  it('shows the install terminal and locks Skip and Next while a command runs', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status())
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'npm install -g claude' })
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const terminal = wrapper.get('[data-testid="install-terminal"]')
    expect(terminal.text()).toContain('npm install -g claude')
    expect(wrapper.get('[data-testid="install-terminal-status"]').text()).toBe(
      i18n.global.t('install-terminal.running')
    )
    const footer = (label: string) => wrapper!.findAll('.ob-footer button').find((b) => b.text() === label)!
    for (const label of ['action.skip-for-now', 'action.next']) {
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
    for (const label of ['action.skip-for-now', 'action.next']) {
      expect(footer(i18n.global.t(label)).attributes('disabled'), label).toBeUndefined()
    }
  })

  it('says "still the old version" rather than "not detected" for an outdated CLI', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', status({
      deps: [
        dep({
          id: 'codex', label: 'Codex CLI', group: 'agent_cli',
          status: 'outdated', version: '0.1.0', min_version: '0.2.0',
          install_cmd: 'npm install -g @openai/codex',
        }),
      ],
    }))
    withRunsExiting(mock)
    wrapper = await open(mock)

    await installButton(wrapper).trigger('click')
    await flushPromises()

    const text = wrapper.find('.oc-error').text()
    expect(text).toBe(i18n.global.t('onboard.installed-still-outdated', { label: 'Codex CLI', version: '0.1.0' }))
    expect(text).not.toContain('brew link')
  })

  describe('agents step with every CLI detected', () => {
    function allCliOk(): OnboardStatus {
      const s = status()
      s.deps = [
        dep({ id: 'claude', group: 'agent_cli', status: 'ok', version: '2.1.0' }),
        dep({ id: 'codex', group: 'agent_cli', status: 'ok', version: '0.155.0' }),
      ]
      s.gate = { ...s.gate, has_any_cli: true, all_required_ready: true }
      return s
    }

    it('leaves every card collapsed', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', allCliOk())
      wrapper = await open(mock)

      expect(wrapper.findAll('.oc-card.expanded')).toHaveLength(0)
      expect(wrapper.findAll('.oc-card.done')).toHaveLength(2)
    })

    it('opens a finished card to re-detect only, without an install action', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', allCliOk())
      wrapper = await open(mock)

      await wrapper.findAll('.oc-head')[1].trigger('click')
      await flushPromises()

      const card = wrapper.get('.oc-card.expanded')
      expect(card.findAll('.ob-btn.primary')).toHaveLength(0)
      expect(card.text()).toContain(i18n.global.t('action.re-detect'))
    })
  })
})
