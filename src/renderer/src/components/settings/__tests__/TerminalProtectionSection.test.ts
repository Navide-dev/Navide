// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'
import TerminalProtectionSection from '../TerminalProtectionSection.vue'
import SecurityPane from '../SecurityPane.vue'

const IDS = [
  'rm-system', 'privilege', 'disk', 'power', 'mass-kill', 'recursive-perms', 'system-write',
  'service-disable', 'fork-bomb', 'pipe-to-shell', 'credential', 'force-push-main',
  'classifier-critical', 'classifier-high', 'unanalyzable',
]

function state(overrides: { off?: string[]; patterns?: Array<{ id: number; kind: 'block' | 'allow'; pattern: string }> } = {}) {
  const off = new Set(overrides.off ?? ['classifier-high'])
  return {
    ok: true,
    categories: IDS.map((id) => ({
      id, description: `desc ${id}`, example: `example ${id}`,
      enabled: !off.has(id), default_enabled: id !== 'classifier-high',
    })),
    patterns: overrides.patterns ?? [],
  }
}

const TOKEN = { nonce: 'n', expires: '9', mac: 'm' }
let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>
let trustConfirm: ReturnType<typeof vi.fn>

async function render(): Promise<VueWrapper> {
  wrapper = mount(TerminalProtectionSection, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

function sentOf(type: string) {
  return mock.sent.filter((s) => s.type === type).map((s) => s.payload)
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  mock = createMockBackend('connected')
  mock.setResponse('guard.terminal.get', state())
  trustConfirm = vi.fn(async () => TOKEN)
  ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm }
})
afterEach(() => {
  wrapper?.unmount()
  delete (window as unknown as { agentTeam?: unknown }).agentTeam
})

describe('TerminalProtectionSection', () => {
  it('lists every built-in category with its example, all on except classifier-high', async () => {
    const w = await render()
    const rows = w.findAll('[data-testid="terminal-category-row"]')
    expect(rows.map((r) => r.attributes('data-category'))).toEqual(IDS)
    expect(rows[1].text()).toContain('Running as another user or administrator')
    expect(rows[1].text()).toContain('example privilege')
    const high = w.get('[data-category="classifier-high"]')
    expect(high.text()).toContain('Off by default')
    expect(high.get('[data-testid="terminal-category-toggle"]').attributes('aria-checked')).toBe('false')
    expect(w.get('[data-category="power"] [data-testid="terminal-category-toggle"]').attributes('aria-checked')).toBe('true')
  })

  it('switching a category ON is tightening: no confirmation is asked for', async () => {
    mock.setResponse('guard.terminal.set_category', state({ off: [] }))
    const w = await render()
    await w.get('[data-category="classifier-high"] [data-testid="terminal-category-toggle"]').trigger('click')
    await flushPromises()
    expect(sentOf('guard.terminal.set_category')).toEqual([{ id: 'classifier-high', enabled: true }])
    expect(trustConfirm).not.toHaveBeenCalled()
  })

  it('switching a category OFF carries a confirmation bound to that category', async () => {
    mock.setResponse('guard.terminal.set_category', state({ off: ['classifier-high', 'power'] }))
    const w = await render()
    await w.get('[data-category="power"] [data-testid="terminal-category-toggle"]').trigger('click')
    await flushPromises()
    expect(trustConfirm).toHaveBeenCalledWith('guard.terminal.set_category', '', 'power:off')
    expect(sentOf('guard.terminal.set_category')).toEqual([{ id: 'power', enabled: false, confirm: TOKEN }])
  })

  it('adds a block pattern without confirmation and validates it first', async () => {
    mock.setResponse('guard.terminal.add_pattern', state({ patterns: [{ id: 1, kind: 'block', pattern: 'docker system prune' }] }))
    const w = await render()
    await w.get('[data-testid="terminal-block-input"]').setValue('*')
    expect(w.get('[data-testid="terminal-block-problem"]').text()).toContain('match every command')
    expect(w.get('[data-testid="terminal-block-add"]').attributes('disabled')).toBeDefined()
    await w.get('[data-testid="terminal-block-input"]').setValue('a[b')
    expect(w.get('[data-testid="terminal-block-problem"]').text()).toContain('unclosed')
    await w.get('[data-testid="terminal-block-input"]').setValue('docker system prune')
    expect(w.find('[data-testid="terminal-block-problem"]').exists()).toBe(false)
    await w.get('[data-testid="terminal-block-add"]').trigger('submit')
    await flushPromises()
    expect(sentOf('guard.terminal.add_pattern')).toEqual([{ kind: 'block', pattern: 'docker system prune' }])
    expect(trustConfirm).not.toHaveBeenCalled()
    expect(w.findAll('[data-testid="terminal-block-row"]')[0].text()).toContain('docker system prune')
  })

  it('shows the allow warning and confirms an added allow prefix', async () => {
    mock.setResponse('guard.terminal.add_pattern', state({ patterns: [{ id: 2, kind: 'allow', pattern: 'git push origin' }] }))
    const w = await render()
    expect(w.get('[data-testid="terminal-allow-warning"]').text()).toContain('skips every built-in check')
    await w.get('[data-testid="terminal-allow-input"]').setValue('git push origin')
    await w.get('[data-testid="terminal-allow-add"]').trigger('submit')
    await flushPromises()
    expect(trustConfirm).toHaveBeenCalledWith('guard.terminal.add_pattern', '', 'allow:git push origin')
    expect(sentOf('guard.terminal.add_pattern')).toEqual([{ kind: 'allow', pattern: 'git push origin', confirm: TOKEN }])
  })

  it('confirms removing a block pattern but not removing an allow prefix', async () => {
    mock.setResponse('guard.terminal.get', state({ patterns: [
      { id: 5, kind: 'block', pattern: 'npm publish' }, { id: 6, kind: 'allow', pattern: 'git push' },
    ] }))
    mock.setResponse('guard.terminal.remove_pattern', state({ patterns: [{ id: 5, kind: 'block', pattern: 'npm publish' }] }))
    const w = await render()
    await w.get('[data-testid="terminal-allow-remove"]').trigger('click')
    await flushPromises()
    expect(trustConfirm).not.toHaveBeenCalled()
    await w.get('[data-testid="terminal-block-remove"]').trigger('click')
    await flushPromises()
    expect(trustConfirm).toHaveBeenCalledWith('guard.terminal.remove_pattern', '', '5')
    expect(sentOf('guard.terminal.remove_pattern')).toEqual([{ id: 6 }, { id: 5, confirm: TOKEN }])
  })

  it('confirms an added exemption and removes one without confirmation', async () => {
    const withRule = { ...state(), exemptable_rules: ['credential-pipe-upload'], exemptions: [] }
    mock.setResponse('guard.terminal.get', withRule)
    mock.setResponse('guard.terminal.add_exemption', {
      ...withRule, exemptions: [{ id: 3, rule: 'credential-pipe-upload', pattern: 'cat ~/.ssh/deploy.pub | curl *' }],
    })
    mock.setResponse('guard.terminal.remove_exemption', withRule)
    const w = await render()
    expect(w.get('[data-testid="terminal-exempt-warning"]').text()).toContain('~/.ssh')
    await w.get('[data-testid="terminal-exempt-input"]').setValue('cat ~/.ssh/deploy.pub | curl *')
    await w.get('[data-testid="terminal-exempt-add"]').trigger('submit')
    await flushPromises()
    expect(trustConfirm).toHaveBeenCalledWith('guard.terminal.add_exemption', '', 'credential-pipe-upload:cat ~/.ssh/deploy.pub | curl *')
    expect(sentOf('guard.terminal.add_exemption')).toEqual([
      { rule: 'credential-pipe-upload', pattern: 'cat ~/.ssh/deploy.pub | curl *', confirm: TOKEN },
    ])
    expect(w.get('[data-testid="terminal-exempt-row"]').text()).toContain('Pipes a file from ~/.ssh')
    trustConfirm.mockClear()
    await w.get('[data-testid="terminal-exempt-remove"]').trigger('click')
    await flushPromises()
    expect(trustConfirm).not.toHaveBeenCalled()
    expect(sentOf('guard.terminal.remove_exemption')).toEqual([{ id: 3 }])
  })

  it('shows the backend refusing a loosening change', async () => {
    mock.setResponse('guard.terminal.set_category', null, {
      ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'this action needs a confirmation from the app window' },
    })
    const w = await render()
    await w.get('[data-category="disk"] [data-testid="terminal-category-toggle"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="terminal-protection-error"]').text()).toContain('needs a confirmation')
  })

  it('tests a command and names the rule that refuses it', async () => {
    mock.setResponse('guard.terminal.test', {
      ok: true, refused: true,
      refusal: { rule: 'privilege', segment: 'sudo rm -rf /opt/app', reason: 'sudo runs the command with elevated privileges', message: 'x' },
    })
    const w = await render()
    await w.get('[data-testid="terminal-test-input"]').setValue('ls && sudo rm -rf /opt/app')
    await w.get('[data-testid="terminal-test-run"]').trigger('submit')
    await flushPromises()
    expect(sentOf('guard.terminal.test')).toEqual([{ command: 'ls && sudo rm -rf /opt/app' }])
    const result = w.get('[data-testid="terminal-test-result"]').text()
    expect(result).toContain('Would be refused')
    expect(result).toContain('Running as another user or administrator')
    expect(result).toContain('sudo rm -rf /opt/app')
  })

  it('reports an allowed command as typed', async () => {
    mock.setResponse('guard.terminal.test', { ok: true, refused: false, refusal: null })
    const w = await render()
    await w.get('[data-testid="terminal-test-input"]').setValue('npm test')
    await w.get('[data-testid="terminal-test-run"]').trigger('submit')
    await flushPromises()
    expect(w.get('[data-testid="terminal-test-result"]').text()).toContain('Would be typed')
  })

  it('is part of Settings → Security', async () => {
    wrapper = mount(SecurityPane, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="terminal-protection"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="terminal-category-row"]')).toHaveLength(IDS.length)
  })

  it('has a title for every category in every locale', () => {
    for (const locale of ['en-US', 'zh-TW', 'ja-JP'] as const) {
      for (const id of IDS) {
        expect(i18n.global.te(`guard.terminal.category.${id}`, locale), `${locale} ${id}`).toBe(true)
      }
    }
  })
})
