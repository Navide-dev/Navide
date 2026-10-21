// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import CliHealthGuide from '../CliHealthGuide.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import type { CliHealthStatus } from '../../composables/useOnboarding'

const health: CliHealthStatus = {
  entries: [{
    agent_key: 'claude',
    label: 'Claude Code',
    npm_package: '@anthropic-ai/claude-code',
    diagnostic_command: 'claude doctor',
    update_command: 'claude update',
    docs_url: '',
    update_state: [],
    candidates: [
      {
        path: '/Users/test/.nvm/bin/claude',
        resolved_path: '/Users/test/.nvm/lib/claude.exe',
        aliases: ['/Users/test/.nvm/bin/claude'],
        version: '2.1.210',
        status: 'ok',
        exit_code: 0,
        signal: '',
        duration_ms: 42,
        is_primary: true,
        install_manager: 'npm',
        removal_command: "printf 'remove'; npm uninstall -g @anthropic-ai/claude-code",
      },
      {
        path: '/opt/homebrew/bin/claude',
        resolved_path: '/opt/homebrew/lib/claude.exe',
        aliases: ['/opt/homebrew/bin/claude'],
        version: '2.1.168',
        status: 'ok',
        exit_code: 0,
        signal: '',
        duration_ms: 100,
        is_primary: false,
        install_manager: 'npm',
        removal_command: "printf 'remove'; npm uninstall -g @anthropic-ai/claude-code",
      },
    ],
  }],
  findings: [{
    type: 'duplicate_install',
    agent_key: 'claude',
    label: 'Claude Code',
  }],
  fingerprint: '0123456789abcdef',
  dismissed: false,
  needs_attention: true,
}

describe('CliHealthGuide', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => wrapper?.unmount())

  it('shows the active and alternate binaries with exact versions and paths', () => {
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    expect(wrapper.text()).toContain('2.1.210')
    expect(wrapper.text()).toContain('/Users/test/.nvm/bin/claude')
    expect(wrapper.text()).toContain('2.1.168')
    expect(wrapper.text()).toContain('/opt/homebrew/bin/claude')
    expect(wrapper.get('.ch-dialog').attributes('role')).toBe('dialog')
    expect(wrapper.get('.ch-dialog').attributes('aria-modal')).toBe('true')
  })

  it('persists the exact fingerprint when the user skips the guide', async () => {
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.ch-footer .ghost').trigger('click')

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_health.dismiss',
      payload: { fingerprint: '0123456789abcdef' },
    })
    expect(wrapper.emitted('close')).toEqual([[]])
  })

  it('persists the fingerprint when closing from the verify step', async () => {
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })
    const next = () => wrapper!.findAll('button').find((button) => button.text() === 'Next')!

    await next().trigger('click')
    await next().trigger('click')
    const close = wrapper.findAll('button').find((button) => button.text() === "Close and Don't Remind Me")
    await close!.trigger('click')

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_health.dismiss',
      payload: { fingerprint: '0123456789abcdef' },
    })
    expect(wrapper.emitted('close')).toEqual([[]])
  })

  it('offers a working alternate as an immediate Navide action', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', {
      cli_health: { ...structuredClone(health), findings: [], fingerprint: '', needs_attention: false },
    })
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.ch-use-binary').trigger('click')
    await flushPromises()

    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_health.select_binary',
      payload: { agent_key: 'claude', path: '/opt/homebrew/bin/claude' },
    })
    // The override resolves this CLI on the backend; nothing is dismissed on
    // the side, and the guide closes because nothing repairable is left.
    expect(mock.sent.some((s) => s.type === 'onboarding.cli_health.dismiss')).toBe(false)
    expect(mock.sent.find((s) => s.type === 'onboarding.status')?.timeoutMs).toBe(45_000)
    expect(wrapper.emitted('resolved')).toEqual([[]])
  })

  it('stays open after one choice while another CLI still needs repair', async () => {
    const mock = createMockBackend('connected')
    const remaining = structuredClone(health)
    remaining.findings = [{ type: 'probe_failed', agent_key: 'codex', label: 'Codex' }]
    remaining.fingerprint = 'fedcba9876543210'
    mock.setResponse('onboarding.status', { cli_health: remaining })
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.ch-use-binary').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('resolved')).toBeUndefined()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('.ch-message').text()).toBe(
      i18n.global.t('cli-health.binary-selected', { label: 'Claude Code' })
    )
    // A later skip dismisses what is left now, not the old set of findings.
    await wrapper.get('.ch-footer .ghost').trigger('click')
    expect(mock.sent).toContainEqual({
      type: 'onboarding.cli_health.dismiss',
      payload: { fingerprint: 'fedcba9876543210' },
    })
  })

  it('says so when the choice could not be saved, and stays open', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.cli_health.select_binary', { ok: false, error: 'disk full' })
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.ch-use-binary').trigger('click')
    await flushPromises()

    expect(wrapper.get('.ch-message').text()).toBe(
      i18n.global.t('cli-health.save-failed', { error: 'disk full' })
    )
    expect(mock.sent.some((s) => s.type === 'onboarding.cli_health.dismiss')).toBe(false)
    expect(mock.sent.some((s) => s.type === 'onboarding.status')).toBe(false)
    expect(wrapper.emitted('resolved')).toBeUndefined()
  })

  it('does not close when skipping could not be saved, so it can be retried', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.cli_health.dismiss', { ok: false, error: 'disk full' })
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.get('.ch-footer .ghost').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('.ch-message').text()).toBe(
      i18n.global.t('cli-health.save-failed', { error: 'disk full' })
    )

    mock.setRejection('onboarding.cli_health.dismiss', 'ws not open')
    await wrapper.get('.ch-footer .ghost').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.get('.ch-message').text()).toBe(
      i18n.global.t('cli-health.save-failed', { error: 'ws not open' })
    )
  })

  it('asks for in-app confirmation before opening removal in Terminal', async () => {
    const commands: string[] = []
    window.agentTeam = {
      openTerminal: async (command: string) => {
        commands.push(command)
        return { ok: true }
      },
    } as typeof window.agentTeam
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.findAll('.ch-remove-binary')[1].trigger('click')

    expect(commands).toEqual([])
    expect(wrapper.get('.ch-confirm').text()).toContain('/opt/homebrew/bin/claude')
    expect(wrapper.get('.ch-confirm').text()).toContain('/Users/test/.nvm/bin/claude')

    await wrapper.get('.ch-confirm-removal').trigger('click')

    expect(commands).toEqual(["printf 'remove'; npm uninstall -g @anthropic-ai/claude-code"])
    expect(wrapper.text()).toContain('confirmation prompt')
  })

  it('cancelling the in-app confirmation opens nothing in Terminal', async () => {
    const commands: string[] = []
    window.agentTeam = {
      openTerminal: async (command: string) => {
        commands.push(command)
        return { ok: true }
      },
    } as typeof window.agentTeam
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.findAll('.ch-remove-binary')[1].trigger('click')
    await wrapper.get('.ch-cancel-removal').trigger('click')

    expect(commands).toEqual([])
    expect(wrapper.find('.ch-confirm').exists()).toBe(false)
  })

  it('never offers removal for the only working installation', () => {
    const soleWorking = structuredClone(health)
    soleWorking.entries[0].candidates[0].resolved_path = '/Users/test/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    soleWorking.entries[0].candidates[1].resolved_path = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    soleWorking.entries[0].candidates[1].status = 'failed'
    const mock = createMockBackend('connected')

    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: soleWorking },
      global: { plugins: [i18n] },
    })

    // Only the broken duplicate is removable; the sole working install shows
    // a blocked note even though the (legacy) backend supplied a command.
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(1)
    expect(wrapper.get('.ch-blocked').text()).toContain('no other working installation')
  })

  it('never builds its own removal command when the backend sent none', () => {
    const legacyHealth = structuredClone(health)
    delete legacyHealth.entries[0].candidates[0].install_manager
    delete legacyHealth.entries[0].candidates[0].removal_command
    delete legacyHealth.entries[0].candidates[1].install_manager
    delete legacyHealth.entries[0].candidates[1].removal_command
    legacyHealth.entries[0].candidates[0].resolved_path = '/Users/test/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    legacyHealth.entries[0].candidates[1].resolved_path = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    const mock = createMockBackend('connected')

    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: legacyHealth },
      global: { plugins: [i18n] },
    })

    // Only the backend knows the platform's terminal shell, so a locally
    // reconstructed (POSIX-only) command is never offered.
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(0)
  })

  it('blocks the second removal until re-detect refreshes the data', async () => {
    const dual = structuredClone(health)
    dual.entries[0].candidates[0].resolved_path = '/Users/test/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    dual.entries[0].candidates[1].resolved_path = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    const commands: string[] = []
    window.agentTeam = {
      openTerminal: async (command: string) => {
        commands.push(command)
        return { ok: true }
      },
    } as typeof window.agentTeam
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: dual },
      global: { plugins: [i18n] },
    })

    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(2)

    await wrapper.findAll('.ch-remove-binary')[1].trigger('click')
    await wrapper.get('.ch-confirm-removal').trigger('click')
    await flushPromises()

    // The initiated removal consumed the only backup: no further removal is
    // offered on the stale snapshot, and the survivor explains why.
    expect(commands).toHaveLength(1)
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(0)
    expect(wrapper.findAll('.ch-blocked')).toHaveLength(1)
  })

  it('judges same-install backups by the npm package the backend sends, for any vendor', async () => {
    // Two PATH entries of one qwen npm install plus one separate install: the
    // backend offers removal on all three (each has a different-prefix backup).
    const pkg = '@qwen-code/qwen-code'
    const candidate = (path: string, resolved: string): CliHealthStatus['entries'][0]['candidates'][0] => ({
      path,
      resolved_path: resolved,
      aliases: [path],
      version: '0.9.0',
      status: 'ok',
      exit_code: 0,
      signal: '',
      duration_ms: 10,
      is_primary: path === '/a/bin/qwen',
      install_manager: 'npm',
      removal_command: `npm uninstall -g ${pkg}`,
    })
    const qwen: CliHealthStatus = {
      ...structuredClone(health),
      entries: [{
        agent_key: 'qwen',
        label: 'Qwen Code',
        npm_package: pkg,
        diagnostic_command: 'qwen --version',
        update_command: '',
        docs_url: '',
        update_state: [],
        candidates: [
          candidate('/a/bin/qwen', `/a/lib/node_modules/${pkg}/cli.js`),
          candidate('/a/bin/qwen-alias', `/a/lib/node_modules/${pkg}/cli.js.alias`),
          candidate('/b/bin/qwen', `/b/lib/node_modules/${pkg}/cli.js`),
        ],
      }],
      findings: [{ type: 'duplicate_install', agent_key: 'qwen', label: 'Qwen Code' }],
    }
    window.agentTeam = { openTerminal: async () => ({ ok: true }) } as unknown as typeof window.agentTeam
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: qwen },
      global: { plugins: [i18n] },
    })
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(3)

    await wrapper.findAll('.ch-remove-binary')[2].trigger('click')
    await wrapper.get('.ch-confirm-removal').trigger('click')
    await flushPromises()

    // What survives is one physical install behind two PATH entries: neither
    // is the other's backup, exactly as the backend's own check decides.
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(0)
    expect(wrapper.findAll('.ch-blocked')).toHaveLength(2)
  })

  it('judges same-install backups on Windows backslash paths like the backend does', async () => {
    const pkg = '@qwen-code/qwen-code'
    const winPkg = pkg.replace('/', '\\')
    const candidate = (path: string, resolved: string): CliHealthStatus['entries'][0]['candidates'][0] => ({
      path,
      resolved_path: resolved,
      aliases: [path],
      version: '0.9.0',
      status: 'ok',
      exit_code: 0,
      signal: '',
      duration_ms: 10,
      is_primary: path === 'C:\\a\\qwen.cmd',
      install_manager: 'npm',
      removal_command: `npm uninstall -g ${pkg}`,
    })
    const qwen: CliHealthStatus = {
      ...structuredClone(health),
      entries: [{
        agent_key: 'qwen',
        label: 'Qwen Code',
        npm_package: pkg,
        diagnostic_command: 'qwen --version',
        update_command: '',
        docs_url: '',
        update_state: [],
        candidates: [
          candidate('C:\\a\\qwen.cmd', `C:\\a\\node_modules\\${winPkg}\\cli.js`),
          candidate('C:\\a\\qwen.ps1', `C:\\a\\node_modules\\${winPkg}\\cli.js.alias`),
          candidate('C:\\b\\qwen.cmd', `C:\\b\\node_modules\\${winPkg}\\cli.js`),
        ],
      }],
      findings: [{ type: 'duplicate_install', agent_key: 'qwen', label: 'Qwen Code' }],
    }
    window.agentTeam = { openTerminal: async () => ({ ok: true }) } as unknown as typeof window.agentTeam
    const mock = createMockBackend('connected')
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: qwen },
      global: { plugins: [i18n] },
    })

    await wrapper.findAll('.ch-remove-binary')[2].trigger('click')
    await wrapper.get('.ch-confirm-removal').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(0)
    expect(wrapper.findAll('.ch-blocked')).toHaveLength(2)
  })

  it('keeps guided removal available for a broken sole install', () => {
    const brokenOnly = structuredClone(health)
    brokenOnly.entries[0].candidates = [{ ...brokenOnly.entries[0].candidates[0], status: 'failed' }]
    const mock = createMockBackend('connected')

    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: brokenOnly },
      global: { plugins: [i18n] },
    })

    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(1)
    expect(wrapper.find('.ch-blocked').exists()).toBe(false)
  })

  it('does not reconstruct a command the backend deliberately left empty', () => {
    const suppressed = structuredClone(health)
    suppressed.entries[0].candidates[0].resolved_path = '/Users/test/.nvm/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    suppressed.entries[0].candidates[1].resolved_path = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    suppressed.entries[0].candidates[1].removal_command = ''
    const mock = createMockBackend('connected')

    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: suppressed },
      global: { plugins: [i18n] },
    })

    // Candidate 1 is allowed by the gate but the backend said "unavailable"
    // (e.g. npm missing): no fabricated fallback button, no blocked note.
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(1)
    expect(wrapper.find('.ch-blocked').exists()).toBe(false)
  })

  it('clears an open confirmation when re-detect replaces the health data', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', { cli_health: structuredClone(health) })
    wrapper = mount(CliHealthGuide, {
      props: { backend: mock.backend, initialHealth: health },
      global: { plugins: [i18n] },
    })

    await wrapper.findAll('.ch-remove-binary')[1].trigger('click')
    expect(wrapper.find('.ch-confirm').exists()).toBe(true)

    const next = () => wrapper!.findAll('button').find((button) => button.text() === 'Next')!
    await next().trigger('click')
    await next().trigger('click')
    await wrapper.get('.ch-verify button').trigger('click')
    await flushPromises()

    const back = () => wrapper!.findAll('.ch-footer .ch-btn.ghost')[1]
    await back().trigger('click')
    await back().trigger('click')

    expect(wrapper.find('.ch-confirm').exists()).toBe(false)
    expect(wrapper.findAll('.ch-remove-binary')).toHaveLength(2)
  })

  describe('re-detect', () => {
    async function recheckWith(mock: ReturnType<typeof createMockBackend>): Promise<VueWrapper> {
      const w = mount(CliHealthGuide, {
        props: { backend: mock.backend, initialHealth: health },
        global: { plugins: [i18n] },
      })
      const next = () => w.findAll('button').find((button) => button.text() === 'Next')!
      await next().trigger('click')
      await next().trigger('click')
      await w.get('.ch-verify button').trigger('click')
      await flushPromises()
      return w
    }

    it('resolves when only a failed vendor update remains, which this guide never shows', async () => {
      // update_failed is fixed from CLI management; the launch gate does not
      // open the guide for it, so it must not keep the guide "still detected".
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', {
        cli_health: {
          ...structuredClone(health),
          findings: [{ type: 'update_failed', agent_key: 'claude', label: 'Claude Code' }],
        },
      })
      wrapper = await recheckWith(mock)

      expect(wrapper.emitted('resolved')).toHaveLength(1)
      expect(wrapper.text()).not.toContain(i18n.global.t('cli-health.still-detected'))
    })

    it('re-probes the login-shell PATH with the full status deadline', async () => {
      // The user just ran a removal in Terminal: the cached PATH cannot have
      // seen it, and a full probe routinely outlives the 10s default.
      const mock = createMockBackend('connected')
      mock.setResponse('onboarding.status', { cli_health: structuredClone(health) })
      wrapper = await recheckWith(mock)

      const sent = mock.sent.find((s) => s.type === 'onboarding.status')
      expect(sent?.payload).toEqual({ fresh: true })
      expect(sent?.timeoutMs).toBe(45_000)
    })

    it('shows a failed detection instead of rejecting silently', async () => {
      const mock = createMockBackend('connected')
      mock.setRejection('onboarding.status', 'request onboarding.status timeout')
      wrapper = await recheckWith(mock)

      expect(wrapper.get('.ch-message').text()).toBe(
        i18n.global.t('cli-health.recheck-failed', { error: 'request onboarding.status timeout' })
      )
      expect(wrapper.emitted('resolved')).toBeUndefined()
      // The button is usable again for another try.
      expect(wrapper.get('.ch-verify button').attributes('disabled')).toBeUndefined()
    })
  })
})
