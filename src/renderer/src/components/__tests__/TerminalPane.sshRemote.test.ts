// @vitest-environment happy-dom
// An SSH Remote terminal pane: the header names the target; once ssh ends a
// banner says why, reconnecting on its own after ssh's exit 255 only. A local
// terminal keeps today's exit behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, type Ref } from 'vue'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

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

const sshRemote = { host: 'build-box', user: 'dev', port: 2222, keyPath: '' }

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId: 'pane-1', title: 'Terminal', agentKey: 'terminal', terminalPort: createTerminalDockStub(), cliProfiles: {}, ...props },
    global: { mocks: { $t: tMock }, stubs: { UsageBadge: { template: '<span class="usage-badge-stub" />' } } },
  })
}

describe('TerminalPane – SSH Remote terminal pane', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    __resetSettingsForTest()
    vi.useFakeTimers()
    mockTerminal.displayStatus.value = 'idle'
    mockTerminal.liveStatus.value = 'idle'
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.useRealTimers()
  })

  it('names the target in the header and shows no banner while the shell runs', () => {
    wrapper = mountPane({ sshRemote })
    expect(wrapper.get('[data-testid="ssh-sub"]').text()).toContain('dev@build-box:2222')
    expect(wrapper.find('[data-testid="ssh-disconnected"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="remote-account-disabled"]').exists()).toBe(false)
  })

  it('a lost link reconnects by itself and says why a try failed', async () => {
    const sshReconnect = vi.fn(async () => 'unreachable')
    wrapper = mountPane({ sshRemote, sshReconnect, sshExitCode: 255 })
    mockTerminal.displayStatus.value = 'exited'
    await nextTick()
    expect(wrapper.get('[data-testid="ssh-disconnected"]').text()).toContain('sshRemote.lost-title')
    expect(wrapper.find('[data-testid="ssh-retry-in"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    await nextTick()
    expect(sshReconnect).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-testid="ssh-banner-reason"]').text()).toContain('sshRemote.reason-unreachable')
  })

  it('the first countdown ignores how long the pane was open before the link dropped', async () => {
    const sshReconnect = vi.fn(async () => 'unreachable')
    wrapper = mountPane({ sshRemote, sshReconnect, sshExitCode: 255 })
    await vi.advanceTimersByTimeAsync(22_000)
    mockTerminal.displayStatus.value = 'exited'
    await nextTick()
    expect(wrapper.get('[data-testid="ssh-retry-in"]').text()).toBe('sshRemote.retry-in:{"seconds":2}')
  })

  it('the first countdown shows the retry delay even when the clock moves between the two watchers', async () => {
    const sshReconnect = vi.fn(async () => 'unreachable')
    wrapper = mountPane({ sshRemote, sshReconnect, sshExitCode: 255 })
    let t = Date.now()
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (t += 5))
    mockTerminal.displayStatus.value = 'exited'
    await nextTick()
    expect(wrapper.get('[data-testid="ssh-retry-in"]').text()).toBe('sshRemote.retry-in:{"seconds":2}')
    now.mockRestore()
  })

  it('a shell the user exited offers Reconnect without trying on its own', async () => {
    const sshReconnect = vi.fn(async () => null)
    wrapper = mountPane({ sshRemote, sshReconnect, sshExitCode: 0 })
    mockTerminal.displayStatus.value = 'exited'
    await nextTick()
    expect(wrapper.get('[data-testid="ssh-disconnected"]').text()).toContain('sshRemote.ended-title')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(sshReconnect).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="ssh-reconnect"]').trigger('click')
    expect(sshReconnect).toHaveBeenCalledTimes(1)
  })

  it('a local terminal gets no SSH banner', async () => {
    wrapper = mountPane({})
    mockTerminal.displayStatus.value = 'exited'
    await nextTick()
    expect(wrapper.find('[data-testid="ssh-disconnected"]').exists()).toBe(false)
  })

  it('an SSH pane says it takes no part in account switching', () => {
    wrapper = mountPane({ sshRemote })
    expect(wrapper.get('[data-testid="ssh-account-chip"]').text()).toBe('sshRemote.accounts-chip')
    expect(wrapper.find('.usage-badge-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ssh-no-tools-chip"]').exists()).toBe(false)
  })

  it('a CLI pane runs the TUI of its CLI and says when it has no Navide tools', () => {
    wrapper = mountPane({ agentKey: 'remote', sshRemote: { ...sshRemote, cli: 'claude' } })
    expect(mockTerminal.opts?.agentProfileFor?.('remote')?.agentKey).toBe('claude')
    expect(wrapper.find('[data-testid="ssh-no-tools-chip"]').exists()).toBe(false)
    wrapper.unmount()
    wrapper = mountPane({ agentKey: 'remote', sshRemote: { ...sshRemote, cli: 'opencode' } })
    expect(wrapper.get('[data-testid="ssh-no-tools-chip"]').text()).toBe('sshRemote.no-tools-chip')
  })

  it('says when the previous conversation could not be resumed until dismissed', async () => {
    const dismiss = vi.fn()
    wrapper = mountPane({ agentKey: 'remote', sshRemote: { ...sshRemote, cli: 'codex' }, sshResumeMissed: true, sshResumeMissedDismiss: dismiss })
    expect(wrapper.get('[data-testid="ssh-resume-missed"]').text()).toContain('sshRemote.resume-missed')
    await wrapper.get('[data-testid="ssh-resume-missed-dismiss"]').trigger('click')
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})
