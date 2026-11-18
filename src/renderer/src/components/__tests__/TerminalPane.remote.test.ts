// @vitest-environment happy-dom
// A remote container pane: the header names host and container, the account
// controls are replaced by a disabled chip, a sign-in card shows on the first
// open of each host + container + CLI (claude gets `/login` typed, never
// submitted), and an exited CLI gets a reconnect banner. Local panes keep
// every control and today's exit behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, type Ref } from 'vue'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'
import { isRemoteLoginDone, markRemoteLoginDone } from '../../composables/useRemoteDevcontainerPrefs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Real Claude Code 2.1.327 screens from a fresh devcontainer (lib fixtures).
const realScreen = (name: string): string =>
  readFileSync(join(__dirname, '../../lib/__tests__/fixtures', name), 'utf8')
const PROMPT_SCREEN = realScreen('claude-2.1.327-prompt.txt')

const mockTerminal = vi.hoisted(() => ({
  displayStatus: null as unknown as Ref<string>,
  liveStatus: null as unknown as Ref<string>,
  lastRawActivityAt: null as unknown as Ref<number>,
  pasteText: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  screen: '',
  opts: null as null | { agentProfileFor?: (key?: string) => { agentKey: string } | undefined },
}))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const { vi: v } = await import('vitest')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  mockTerminal.displayStatus = ref('idle')
  mockTerminal.liveStatus = ref('starting')
  mockTerminal.lastRawActivityAt = ref(0)
  mockTerminal.pasteText = v.fn(() => true)
  return {
    ...actual,
    useTerminal: (_paneId: string, _port: unknown, opts: typeof mockTerminal.opts) => (mockTerminal.opts = opts, {
      mount: v.fn(),
      stopIneffective: { value: false },
      pasteText: mockTerminal.pasteText,
      readVisibleScreen: () => mockTerminal.screen,
      updateXtermTheme: v.fn(),
      setDisableStdin: v.fn(),
      displayStatus: mockTerminal.displayStatus,
      liveStatus: mockTerminal.liveStatus,
      lastRawActivityAt: mockTerminal.lastRawActivityAt,
      sessionId: { value: 'sess-1' },
      isAltBuffer: ref(false),
    }),
  }
})

function tMock(key: string, params?: Record<string, unknown>): string {
  return params ? `${key}:${JSON.stringify(params)}` : key
}

// A remote pane's own agent key is 'remote'; the CLI it runs is remote.cli.
const remote = { host: 'devbox', container: 'app', network: { mode: 'host' as const }, cli: 'claude' as const }

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Claude', agentKey: 'claude', terminalPort: createTerminalDockStub(), cliProfiles: {}, ...props },
    global: { mocks: { $t: tMock }, stubs: { UsageBadge: { template: '<span class="usage-badge-stub" />' } } },
  })
}

describe('TerminalPane – remote container pane', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    __resetSettingsForTest()
    mockTerminal.displayStatus.value = 'idle'
    mockTerminal.liveStatus.value = 'starting'
    mockTerminal.lastRawActivityAt.value = 0
    mockTerminal.pasteText.mockClear()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('a local pane keeps its account controls and shows no remote markup', () => {
    wrapper = mountPane({ accountFollow: 'fixed', usageLimitHit: true, quotaSwitchOffered: true })
    expect(wrapper.find('.usage-badge-stub').exists()).toBe(true)
    expect(wrapper.find('[data-testid="account-pin-indicator"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="usage-limit-switch"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="remote-badge"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="remote-account-disabled"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="remote-login-card"]').exists()).toBe(false)
  })

  it('a remote pane shows its badge and sub line, and a disabled account chip instead of the account controls', () => {
    markRemoteLoginDone('devbox', 'app', 'claude')
    wrapper = mountPane({ agentKey: 'remote', remote, accountFollow: 'fixed', usageLimitHit: true, quotaSwitchOffered: true, subtitle: 'local subtitle' })
    expect(wrapper.get('[data-testid="remote-badge"]').text()).toBe('remoteDevcontainer.badge:{"host":"devbox","container":"app"}')
    expect(wrapper.get('[data-testid="remote-sub"]').text()).toBe(
      'remoteDevcontainer.sub:{"cli":"Claude Code","host":"devbox","container":"app"}',
    )
    expect(wrapper.text()).not.toContain('local subtitle')
    const chip = wrapper.get('[data-testid="remote-account-disabled"]')
    expect(chip.text()).toBe('remoteDevcontainer.account-disabled')
    expect(chip.attributes('aria-disabled')).toBe('true')
    expect(chip.attributes('title')).toContain('remoteDevcontainer.account-disabled-title')
    expect(chip.attributes('title')).toContain('remoteDevcontainer.account-disabled-body')
    expect(wrapper.find('.usage-badge-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid="account-pin-indicator"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="usage-limit-switch"]').exists()).toBe(false)
  })

  it('the sign-in card shows once per target and prefills /login without pressing Enter', async () => {
    mockTerminal.screen = PROMPT_SCREEN
    wrapper = mountPane({ agentKey: 'remote', remote })
    const card = wrapper.get('[data-testid="remote-login-card"]')
    expect(card.text()).toContain('remoteDevcontainer.login-title:{"cli":"Claude Code"}')
    // Nothing is typed until the CLI sits at its prompt.
    expect(mockTerminal.pasteText).not.toHaveBeenCalled()
    mockTerminal.liveStatus.value = 'idle'
    await nextTick()
    expect(mockTerminal.pasteText).toHaveBeenCalledTimes(1)
    expect(mockTerminal.pasteText.mock.calls[0][0]).toBe('/login')
    mockTerminal.liveStatus.value = 'running'
    await nextTick()
    mockTerminal.liveStatus.value = 'idle'
    await nextTick()
    expect(mockTerminal.pasteText).toHaveBeenCalledTimes(1)
    for (const call of mockTerminal.pasteText.mock.calls) expect(String(call[0])).not.toMatch(/[\r\n]/)

    await wrapper.get('[data-testid="remote-login-done"]').trigger('click')
    expect(wrapper.find('[data-testid="remote-login-card"]').exists()).toBe(false)
    expect(isRemoteLoginDone('devbox', 'app', 'claude')).toBe(true)
    wrapper.unmount()
    wrapper = mountPane({ agentKey: 'remote', remote })
    expect(wrapper.find('[data-testid="remote-login-card"]').exists()).toBe(false)
    // Reopened from the badge.
    await wrapper.get('[data-testid="remote-badge"]').trigger('click')
    expect(wrapper.find('[data-testid="remote-login-card"]').exists()).toBe(true)
    // Asked for from the badge, so the steps are open already.
    expect(wrapper.get('[data-testid="remote-login-card"]').text()).toContain('remoteDevcontainer.login-step3')
    expect(wrapper.get('[data-testid="remote-login-card"]').text()).not.toContain('remoteDevcontainer.login-codex')
  })

  it.each([
    ['the real unnumbered text-style picker', realScreen('claude-2.1.327-first-run-theme.txt')],
    ['the real numbered login-method menu', realScreen('claude-2.1.327-first-run-login-method.txt')],
    ['a numbered picker', [
      " Let's get started.",
      ' Choose the text style that looks best with your terminal',
      ' ❯ 1. Dark mode ✔',
      '   2. Light mode',
      '   3. Dark mode (colorblind-friendly)',
    ].join('\n')],
  ])('%s cancels the /login prefill instead of typing into it', async (_name, setup) => {
    // A fresh container's Claude Code opens on its first-run setup; it reads
    // as idle, but a pasted /login lands on the menu and Enter picks a theme.
    mockTerminal.screen = setup
    wrapper = mountPane({ agentKey: 'remote', remote })
    mockTerminal.liveStatus.value = 'idle'
    await nextTick()
    expect(mockTerminal.pasteText).not.toHaveBeenCalled()
    // Setup finished and the CLI reached its prompt: still nothing typed —
    // the setup screens run their own sign-in.
    vi.useFakeTimers()
    try {
      mockTerminal.screen = PROMPT_SCREEN
      mockTerminal.lastRawActivityAt.value = Date.now()
      mockTerminal.liveStatus.value = 'running'
      await nextTick()
      mockTerminal.liveStatus.value = 'idle'
      await nextTick()
      vi.advanceTimersByTime(1000)
    } finally {
      vi.useRealTimers()
    }
    expect(mockTerminal.pasteText).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="remote-login-card"]').exists()).toBe(true)
  })

  // On a set-up container the CLI goes idle before Claude Code has drawn its
  // prompt, then only repaints: idle never changes again, so the prompt is
  // found from the output that follows. A half-drawn prompt (rule above the
  // ❯ row, nothing below yet) is not a menu and must not drop the prefill.
  it.each([
    ['an empty screen', ''],
    ['a half-drawn prompt', PROMPT_SCREEN.split('\n').slice(0, 7).join('\n')],
  ])('prefills once the prompt is drawn after the first idle on %s, with no status change', async (_name, first) => {
    vi.useFakeTimers()
    try {
      mockTerminal.screen = first
      wrapper = mountPane({ agentKey: 'remote', remote })
      mockTerminal.liveStatus.value = 'idle'
      await nextTick()
      expect(mockTerminal.pasteText).not.toHaveBeenCalled()
      mockTerminal.screen = PROMPT_SCREEN
      mockTerminal.lastRawActivityAt.value = Date.now()
      await nextTick()
      vi.advanceTimersByTime(1000)
      expect(mockTerminal.pasteText).toHaveBeenCalledTimes(1)
      expect(mockTerminal.pasteText.mock.calls[0][0]).toBe('/login')
      mockTerminal.lastRawActivityAt.value = Date.now() + 1
      await nextTick()
      vi.advanceTimersByTime(1000)
      expect(mockTerminal.pasteText).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('codex gets the device-code hint and nothing typed', async () => {
    wrapper = mountPane({ agentKey: 'remote', remote: { ...remote, cli: 'codex' } })
    const card = wrapper.get('[data-testid="remote-login-card"]')
    expect(card.text()).toContain('remoteDevcontainer.login-title:{"cli":"Codex CLI"}')
    expect(card.text()).not.toContain('remoteDevcontainer.login-step1')
    await card.get('[data-testid="remote-login-help"]').trigger('click')
    expect(card.text()).toContain('remoteDevcontainer.login-step1')
    expect(card.text()).toContain('remoteDevcontainer.login-codex')
    mockTerminal.liveStatus.value = 'idle'
    await nextTick()
    expect(mockTerminal.pasteText).not.toHaveBeenCalled()
  })

  it('reads paste and Shift+Enter behaviour from the CLI the container runs', () => {
    wrapper = mountPane({ agentKey: 'remote', remote: { ...remote, cli: 'codex' } })
    expect(mockTerminal.opts?.agentProfileFor?.('remote')?.agentKey).toBe('codex')
    expect(mockTerminal.opts?.agentProfileFor?.('claude')?.agentKey).toBe('claude')
    wrapper.unmount()
    // A local pane resolves its own key, exactly as before.
    wrapper = mountPane({})
    expect(mockTerminal.opts?.agentProfileFor?.('claude')?.agentKey).toBe('claude')
    expect(mockTerminal.opts?.agentProfileFor?.('remote')?.agentKey).toBe('remote')
  })

  it('an exited remote pane offers reconnect and close; a local one does not', async () => {
    markRemoteLoginDone('devbox', 'app', 'claude')
    const reconnect = vi.fn()
    const close = vi.fn()
    wrapper = mountPane({ agentKey: 'remote', remote, remoteReconnect: reconnect, remoteClosePane: close })
    expect(wrapper.find('[data-testid="remote-disconnected"]').exists()).toBe(false)
    mockTerminal.displayStatus.value = 'exited'
    await nextTick()
    const banner = wrapper.get('[data-testid="remote-disconnected"]')
    expect(banner.text()).toContain('remoteDevcontainer.disconnected-title:{"host":"devbox"}')
    expect(banner.text()).toContain('remoteDevcontainer.disconnected-ago')
    expect(banner.text()).toContain('remoteDevcontainer.disconnected-body')
    await banner.get('[data-testid="remote-reconnect"]').trigger('click')
    expect(reconnect).toHaveBeenCalledTimes(1)
    await banner.get('[data-testid="remote-close-pane"]').trigger('click')
    expect(close).toHaveBeenCalledTimes(1)
    wrapper.unmount()

    wrapper = mountPane({})
    await nextTick()
    expect(wrapper.find('[data-testid="remote-disconnected"]').exists()).toBe(false)
  })
})
