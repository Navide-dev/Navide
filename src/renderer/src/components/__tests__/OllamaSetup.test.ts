// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import OllamaSetup from '../OllamaSetup.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useOnboarding, type OnboardDep, type OnboardStatus } from '../../composables/useOnboarding'

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
// The guided install dialog has its own tests; here only its opening matters.
vi.mock('../CliInstallDialog.vue', () => ({
  // defineAsyncComponent only unwraps `default` from a module it recognises.
  __esModule: true,
  default: defineComponent({
    props: { depId: { type: String, default: '' }, origin: { type: String, default: '' } },
    emits: ['close'],
    setup(props) {
      return () => h('div', { 'data-testid': 'install-dialog', 'data-origin': props.origin }, props.depId)
    },
  }),
}))

function ollama(status: OnboardDep['status']): OnboardDep {
  return {
    id: 'ollama', label: 'Ollama', description: '', group: 'analyzer', status,
    version: '', min_version: '', optional: false, needs_terminal: false, can_install: true,
    docs_url: '', binary_path: '', resolved_path: '', install_method: '', update_cmd: '',
    doctor_cmd: '', autoupdate_env: '', autoupdate_policy: '',
  }
}

function status(dep: OnboardDep, serviceUp: boolean, models: string[] = []): OnboardStatus {
  return {
    deps: [dep],
    models,
    model_catalog: [
      { name: 'qwen2.5-coder:7b', size: '4.7 GB', desc: 'coder', recommended: true },
      { name: 'llama3.2:3b', size: '2.0 GB', desc: 'small', recommended: false },
    ],
    cli_health: { entries: [], findings: [], fingerprint: '', dismissed: false, needs_attention: false },
    gate: {
      foundation_ready: false, has_any_cli: true, analyzer_ready: serviceUp && models.length > 0,
      ollama_ok: dep.status === 'ok', ollama_service_up: serviceUp, has_model: models.length > 0,
      all_required_ready: true, suggested_model: 'qwen2.5-coder:7b',
    },
    complete: true,
  }
}

describe('OllamaSetup', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function open(s: OnboardStatus, mock = createMockBackend('connected')) {
    mock.setResponse('onboarding.status', s)
    const onboarding = useOnboarding(mock.backend)
    await onboarding.refresh()
    wrapper = mount(OllamaSetup, {
      props: { backend: mock.backend, onboarding },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return { mock, w: wrapper }
  }

  it('offers the guided install when Ollama is missing', async () => {
    const { w } = await open(status(ollama('missing'), false))

    expect(w.get('[data-testid="ollama-setup-missing"]').text()).toContain(
      i18n.global.t('settings.analyzer.ollama-missing'))
    await w.get('[data-testid="ollama-setup-missing"] button').trigger('click')
    await flushPromises()

    const dialog = w.get('[data-testid="install-dialog"]')
    expect(dialog.text()).toBe('ollama')
    expect(dialog.attributes('data-origin')).toBe('settings')
    expect(w.emitted('install-open-change')).toEqual([[true]])
  })

  it('offers to start the service when Ollama is installed but down', async () => {
    const { w } = await open(status(ollama('ok'), false))

    const row = w.get('[data-testid="ollama-setup-stopped"]')
    expect(row.text()).toContain(i18n.global.t('onboard.ollama-stopped'))
    expect(row.text()).toContain(i18n.global.t('action.start-ollama'))
  })

  describe('starting the Ollama service fails', () => {
    async function clickStart(mock: ReturnType<typeof createMockBackend>): Promise<VueWrapper> {
      const { w } = await open(status(ollama('ok'), false), mock)
      await w.findAll('button').find((b) => b.text() === i18n.global.t('action.start-ollama'))!.trigger('click')
      await flushPromises()
      return w
    }

    it('shows a refusal', async () => {
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.run', { ok: false, error: 'ollama is not installed' })
      const w = await clickStart(mock)

      expect(mock.sent.find((s) => s.type === 'onboarding.run')?.payload).toEqual(
        { kind: 'start_ollama', cols: 100, rows: 24 }
      )
      expect(w.get('.os-error').text()).toBe(i18n.global.t('onboard.ollama-start-failed'))
      expect(w.emitted('changed')).toBeUndefined()
    })

    it('shows a transport failure', async () => {
      const mock = createMockBackend('connected')
      mock.setRejection('onboarding.run', 'ws not open')
      const w = await clickStart(mock)

      expect(w.get('.os-error').text()).toBe(i18n.global.t('onboard.ollama-start-failed'))
    })
  })

  it('downloads the recommended model when the service is up with none', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.run', { ok: true, run_id: 'run-1', command: 'ollama pull qwen2.5-coder:7b' })
    const { w } = await open(status(ollama('ok'), true), mock)

    expect(w.get('[data-testid="ollama-setup-model"]').text()).toContain(i18n.global.t('label.analysis-model'))
    expect(w.get('.ob-model-card.selected').text()).toContain('qwen2.5-coder:7b')
    await w.findAll('button').find((b) => b.text() === i18n.global.t('action.download-model', { name: 'qwen2.5-coder:7b' }))!
      .trigger('click')
    await flushPromises()

    expect(mock.sent.find((s) => s.type === 'onboarding.run')?.payload).toEqual(
      { kind: 'pull_model', model: 'qwen2.5-coder:7b', cols: 100, rows: 24 }
    )
    mock.emit('terminal.exit', { terminal_session_id: 'run-1', exit_code: 0 })
    await flushPromises()
    expect(w.emitted('changed')).toEqual([[]])
  })

  it('renders nothing once Ollama is up and has a model', async () => {
    const { w } = await open(status(ollama('ok'), true, ['qwen2.5-coder:7b']))

    expect(w.find('[data-testid="ollama-setup"]').exists()).toBe(false)
  })
})
