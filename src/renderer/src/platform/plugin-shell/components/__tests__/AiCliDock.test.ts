// @vitest-environment happy-dom
// AiCliDock — the shared right-side CLI agent terminal shell (rail toggle +
// resize + agent picker + Start/Interrupt/Stop + lazily mounted PTY terminal)
// used by the Pipeline Manager and Plan windows.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { resolve } from 'node:path'
import { CLI_AGENT_SPECS } from '../../agents'
import { bracketedPaste, dockOutputLogFile } from '../../lib/aiCliContext'
import type { MentionCandidate, TerminalDockPort } from '@navide/terminal'

let i18n: typeof import('@navide/plugin-ui/foundation').i18n
let AiCliDock: typeof import('../AiCliDock.vue').default

const settingsState = vi.hoisted(() => ({
  stored: {} as Record<string, string>,
  sets: [] as { key: string; value: string }[],
}))

// Stubbed terminal host: the dock drives it purely through the exposed
// imperative surface, so the stub exposes spies plus mutable status /
// lastRawActivityAt refs the tests poke to simulate the PTY lifecycle.
const termSpies = vi.hoisted(() => ({
  spawn: vi.fn(async () => undefined),
  tryReattach: vi.fn(async () => undefined),
  // Returns true like the real one: pasteText reports whether the write left,
  // and a staged paste stops rather than send its CR when it did not.
  pasteText: vi.fn(() => true),
  interrupt: vi.fn(async () => undefined),
  kill: vi.fn(async () => undefined),
  cancelPendingCreate: vi.fn(async () => undefined),
  fitTerminal: vi.fn(),
  focus: vi.fn(),
}))
const termState = {
  status: ref('idle'),
  lastRawActivityAt: ref(0),
} as { status: Ref<string>; lastRawActivityAt: Ref<number> }
const terminalStub = defineComponent({
  name: 'AiCliTerminal',
  props: { paneId: String, terminalPort: Object, workspacePath: String },
  inheritAttrs: false,
  setup(_, { expose }) {
    expose({
      ...termSpies,
      status: termState.status,
      displayStatus: termState.status,
      lastRawActivityAt: termState.lastRawActivityAt,
      sessionId: ref(''),
      error: ref(''),
    })
    return () => h('div', { class: 'stub-AiCliTerminal' })
  },
})

beforeAll(async () => {
  const settingsModule = resolve(process.cwd(), 'packages/plugin-ui/src/shared/index.ts')
  vi.doMock(settingsModule, () => ({
    settingsGet: vi.fn(
      (key: string, def: string | null) => settingsState.stored[key] ?? def
    ),
    settingsSet: vi.fn((key: string, value: string) => {
      settingsState.sets.push({ key, value })
      settingsState.stored[key] = value
    }),
  }))
  i18n = (await import('@navide/plugin-ui/foundation')).i18n
  i18n.global.locale.value = 'en-US'
  AiCliDock = (await import('../AiCliDock.vue')).default
})

function makeTerminalPort(status = 'connected'): TerminalDockPort {
  return {
    status: ref(status),
    shell: ref(''),
    autoRestart: ref(null),
  } as unknown as TerminalDockPort
}

const mounted: VueWrapper[] = []
function mountDock(props: Record<string, unknown> = {}): VueWrapper {
  const wrapper = mount(AiCliDock, {
    props: {
      widthKey: 'test-cli-panel-width',
      workspacePath: '/tmp/ws',
      terminalPort: makeTerminalPort(),
      paneId: 'ab12cd34-test-cli-dock',
      origin: 'test-window',
      ...props,
    },
    global: { plugins: [i18n], stubs: { AiCliTerminal: terminalStub } },
  })
  mounted.push(wrapper)
  return wrapper
}

async function openDock(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.ai-dock-rail-btn').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  settingsState.stored = {}
  settingsState.sets.length = 0
  for (const spy of Object.values(termSpies)) spy.mockClear()
  termSpies.spawn.mockImplementation(async () => undefined)
  termSpies.tryReattach.mockImplementation(async () => undefined)
  termState.status.value = 'idle'
  termState.lastRawActivityAt.value = 0
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('AiCliDock — eager terminal mount + keep-alive toggle', () => {
  it('mounts the terminal eagerly and claims the PTY while the panel is still closed', async () => {
    const wrapper = mountDock()
    await flushPromises()
    expect(wrapper.find('.ai-dock-rail-btn').exists()).toBe(true)
    // The terminal exists even though the panel was never opened: ownership of
    // a still-running PTY must be claimed or the backend janitor reaps it.
    const term = wrapper.findComponent({ name: 'AiCliTerminal' })
    expect(term.exists()).toBe(true)
    expect(term.props('paneId')).toBe('ab12cd34-test-cli-dock')
    expect(term.props('workspacePath')).toBe('/tmp/ws')
    expect(termSpies.tryReattach).toHaveBeenCalledTimes(1)
    // The agent must ride along: this path never calls spawn(), and without it
    // useTerminal falls back to plain-shell input encoding (Shift+Enter, paste).
    expect(termSpies.tryReattach).toHaveBeenCalledWith({ agentKey: expect.any(String) })
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).toBe('none')
  })

  it('open/close toggles v-show only; the terminal instance survives', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).not.toBe('none')
    // Closing hides via v-show but keeps the instance (CLI session preserved).
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    expect(wrapper.findComponent({ name: 'AiCliTerminal' }).exists()).toBe(true)
    expect(panelEl.style.display).toBe('none')
  })

  it('defers the reattach until the backend connects, then runs it exactly once', async () => {
    const terminalPort = makeTerminalPort('connecting')
    const wrapper = mountDock({ terminalPort })
    await flushPromises()
    expect(termSpies.tryReattach).not.toHaveBeenCalled()
    ;(terminalPort as unknown as { status: Ref<string> }).status.value = 'connected'
    await flushPromises()
    expect(termSpies.tryReattach).toHaveBeenCalledTimes(1)
    // Panel toggles do not re-run it (once per window life).
    await openDock(wrapper)
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    await openDock(wrapper)
    expect(termSpies.tryReattach).toHaveBeenCalledTimes(1)
  })

  it('refits the terminal when the panel opens from display:none', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    expect(termSpies.fitTerminal).toHaveBeenCalledWith({ redrawAfterSettle: true })
  })

  it('supports v-model:open (host-driven open shows the panel)', async () => {
    const wrapper = mountDock({
      open: false,
      'onUpdate:open': (v: boolean) => wrapper.setProps({ open: v }),
    })
    const panelEl = wrapper.find('.ai-dock-panel').element as HTMLElement
    expect(panelEl.style.display).toBe('none')
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(panelEl.style.display).not.toBe('none')
    await wrapper.find('.ai-dock-rail-btn').trigger('click')
    expect((wrapper.props() as { open?: boolean }).open).toBe(false)
  })

  it('without a workspace: empty state, no terminal, no reattach, Start disabled', async () => {
    const wrapper = mountDock({ workspacePath: '' })
    await openDock(wrapper)
    expect(wrapper.find('.ai-cli-empty').text()).toBe('No workspace available')
    expect(wrapper.findComponent({ name: 'AiCliTerminal' }).exists()).toBe(false)
    expect(termSpies.tryReattach).not.toHaveBeenCalled()
    expect(
      (wrapper.find('.ai-cli-btn.primary').element as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('suppresses the empty state until the host reports the workspace resolved', async () => {
    const wrapper = mountDock({ workspacePath: '', workspaceResolved: false })
    await openDock(wrapper)
    expect(wrapper.find('.ai-cli-empty').exists()).toBe(false)
    await wrapper.setProps({ workspaceResolved: true })
    expect(wrapper.find('.ai-cli-empty').exists()).toBe(true)
  })
})

describe('AiCliDock — width persistence', () => {
  it('reads the persisted width from widthKey, clamped to 280–600', () => {
    settingsState.stored['test-cli-panel-width'] = '9999'
    const wide = mountDock()
    expect((wide.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('600px')

    settingsState.stored['test-cli-panel-width'] = '10'
    const narrow = mountDock()
    expect((narrow.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('280px')
  })

  it('falls back to defaultWidth when nothing is persisted', () => {
    const wrapper = mountDock({ defaultWidth: 320 })
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('320px')
  })

  it('tracks drag on the handle (clamped) and persists the width on release', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    await wrapper.find('.ai-dock-resize-handle').trigger('mousedown')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: window.innerWidth - 400 }))
    await flushPromises()
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('400px')
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 }))
    await flushPromises()
    expect((wrapper.find('.ai-dock-panel').element as HTMLElement).style.width).toBe('600px')
    document.dispatchEvent(new MouseEvent('mouseup'))
    expect(settingsState.sets).toEqual([{ key: 'test-cli-panel-width', value: '600' }])
  })
})

describe('AiCliDock — agent picker persistence', () => {
  it('offers every CLI agent spec (the plain-shell terminal entry is excluded)', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    const values = wrapper
      .find('.ai-cli-agent-select')
      .findAll('option')
      .map((o) => (o.element as HTMLOptionElement).value)
    expect(values).toEqual(CLI_AGENT_SPECS.map((s) => s.agentKey))
    expect(values).not.toContain('terminal')
  })

  it('honors the agentKeys subset filter', async () => {
    const wrapper = mountDock({ agentKeys: ['claude', 'codex'] })
    await openDock(wrapper)
    const values = wrapper
      .find('.ai-cli-agent-select')
      .findAll('option')
      .map((o) => (o.element as HTMLOptionElement).value)
    expect(values).toEqual(['claude', 'codex'])
  })

  it('persists the selection under the derived `${widthKey}.agent` key by default', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    await wrapper.find('.ai-cli-agent-select').setValue('codex')
    expect(settingsState.sets).toContainEqual({ key: 'test-cli-panel-width.agent', value: 'codex' })
  })

  it('uses an explicit agentKeyStorageKey (legacy key preservation) and reads it back', async () => {
    settingsState.stored['pm-ai-agent'] = 'aider'
    const wrapper = mountDock({ agentKeyStorageKey: 'pm-ai-agent' })
    await openDock(wrapper)
    expect(
      (wrapper.find('.ai-cli-agent-select').element as HTMLSelectElement).value
    ).toBe('aider')
    await wrapper.find('.ai-cli-agent-select').setValue('claude')
    expect(settingsState.sets).toContainEqual({ key: 'pm-ai-agent', value: 'claude' })
  })
})

describe('AiCliDock — start guards and spawn path', () => {
  it('disables Start while the backend is not connected', async () => {
    const wrapper = mountDock({ terminalPort: makeTerminalPort('disconnected') })
    await openDock(wrapper)
    expect(
      (wrapper.find('.ai-cli-btn.primary').element as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('locks Start (Reattaching…) while the connect-time reattach is in flight', async () => {
    let release!: () => void
    termSpies.tryReattach.mockImplementation(
      () => new Promise<undefined>((r) => { release = () => r(undefined) })
    )
    const wrapper = mountDock()
    await openDock(wrapper)
    const btn = wrapper.find('.ai-cli-btn.primary')
    expect(btn.text()).toBe('Reattaching…')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    release()
    await flushPromises()
    expect(btn.text()).toBe('Start')
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('spawns a NEW PTY with the shell-wrapped command, origin metadata and skipReattach', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    expect(termSpies.spawn).toHaveBeenCalledTimes(1)
    expect(termSpies.spawn).toHaveBeenCalledWith({
      // backend.shell is '' → 'bash' fallback; yolo unset → default ON.
      command: ['bash', '-lc', 'claude --dangerously-skip-permissions'],
      cwd: '/tmp/ws',
      agentKey: 'claude',
      metadata: {
        workspace_path: '/tmp/ws',
        origin: 'test-window',
        yolo: true,
        surface: 'test-window',
        window_kind: 'test-window',
        cli_command: 'claude --dangerously-skip-permissions',
        agent_label: 'Claude Code (Anthropic)',
      },
      outputLogFile: dockOutputLogFile('/tmp/ws', 'claude', 'ab12cd34-test-cli-dock', 'test-window'),
      skipReattach: true,
    })
  })

  it('pins a fresh session id through the host port and files it in the metadata', async () => {
    const pin = vi.fn((_agent: string, _resume: boolean, command: string) => ({
      command: `${command} --session-id S-1`,
      explicitSessionId: 'S-1',
    }))
    const terminalPort = { ...makeTerminalPort(), pinFreshSessionAtLaunch: pin } as unknown as TerminalDockPort
    const wrapper = mountDock({ terminalPort, origin: 'plan-window' })
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    expect(pin).toHaveBeenCalledWith(
      'claude', false, 'claude --dangerously-skip-permissions', undefined, expect.any(Function),
    )
    const opts = (termSpies.spawn.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(opts.command).toEqual(['bash', '-lc', 'claude --dangerously-skip-permissions --session-id S-1'])
    expect(opts.metadata).toMatchObject({
      explicit_session_id: 'S-1',
      cli_command: 'claude --dangerously-skip-permissions --session-id S-1',
      surface: 'plans',
      window_kind: 'plans',
    })
    // resumeKey would rewrite useTerminal's persist key and break the
    // connect-time reattach, which looks the PTY up by pane id.
    expect(opts).not.toHaveProperty('resumeKey')
  })

  it('sends no explicit session id when the vendor cannot pin one', async () => {
    const pin = vi.fn((_agent: string, _resume: boolean, command: string) => ({ command, explicitSessionId: '' }))
    const terminalPort = { ...makeTerminalPort(), pinFreshSessionAtLaunch: pin } as unknown as TerminalDockPort
    const wrapper = mountDock({ terminalPort })
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    const opts = (termSpies.spawn.mock.calls[0] as unknown as [{ metadata: Record<string, unknown> }])[0]
    expect(opts.metadata).not.toHaveProperty('explicit_session_id')
  })

  it('lets the host port build the spawn argv when it offers to', async () => {
    // The port owns the shell and the platform; a Windows host answers with
    // PowerShell flags here, which the dock must not second-guess.
    const terminalPort = makeTerminalPort()
    ;(terminalPort as unknown as { shell: Ref<string> }).shell.value = 'powershell.exe'
    ;(terminalPort as unknown as { spawnArgv: (shell: string, command: string) => string[] }).spawnArgv =
      (shell, command) => [shell, '-NoLogo', '-NoExit', '-Command', command]
    const wrapper = mountDock({ terminalPort })
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    expect(termSpies.spawn).toHaveBeenCalledWith(expect.objectContaining({
      command: ['powershell.exe', '-NoLogo', '-NoExit', '-Command', 'claude --dangerously-skip-permissions'],
    }))
  })

  it('injects the host context (bracketed paste + CR) only after a fresh spawn goes quiet', async () => {
    const buildContext = vi.fn(() => 'CONTEXT SNAPSHOT')
    termSpies.spawn.mockImplementation(async () => {
      termState.status.value = 'running'
      // Startup output already quiet: past the injectQuietMs window.
      termState.lastRawActivityAt.value = Date.now() - 60000
    })
    const wrapper = mountDock({ buildContext })
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('spawned')).toEqual([['claude']])
    expect(buildContext).toHaveBeenCalledTimes(1)
    expect(termSpies.pasteText).toHaveBeenCalledWith(bracketedPaste('CONTEXT SNAPSHOT'))
    // The submitting CR follows after the 300 ms ingest delay.
    expect(termSpies.pasteText).not.toHaveBeenCalledWith('\r')
    await new Promise((r) => setTimeout(r, 350))
    expect(termSpies.pasteText).toHaveBeenCalledWith('\r')
  })

  // The context and its submitting CR are two sends 300 ms apart, so the
  // transport can go down between them. A CR on its own submits whatever the
  // prompt already held — or an empty line — as if it were the context.
  it('does not follow a refused context paste with a bare CR', async () => {
    const buildContext = vi.fn(() => 'CONTEXT SNAPSHOT')
    // Once, so the stub's default stays true for every other test in the file
    // (clearAllMocks resets calls, not implementations).
    termSpies.pasteText.mockReturnValueOnce(false) // e.g. the backend went away
    termSpies.spawn.mockImplementation(async () => {
      termState.status.value = 'running'
      termState.lastRawActivityAt.value = Date.now() - 60000
    })
    const wrapper = mountDock({ buildContext })
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    await new Promise((r) => setTimeout(r, 350))

    expect(termSpies.pasteText).toHaveBeenCalledWith(bracketedPaste('CONTEXT SNAPSHOT'))
    expect(termSpies.pasteText).not.toHaveBeenCalledWith('\r')
  })

  it('injects nothing when the host provides no buildContext', async () => {
    termSpies.spawn.mockImplementation(async () => {
      termState.status.value = 'running'
      termState.lastRawActivityAt.value = Date.now() - 60000
    })
    const wrapper = mountDock()
    await openDock(wrapper)
    await wrapper.find('.ai-cli-btn.primary').trigger('click')
    await flushPromises()
    await new Promise((r) => setTimeout(r, 350))
    expect(termSpies.pasteText).not.toHaveBeenCalled()
  })
})

describe('AiCliDock — running controls and lifecycle events', () => {
  it('Interrupt sends Ctrl+C; Stop on a running PTY kills it', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    termState.status.value = 'running'
    await nextTick()
    await wrapper.find('.ai-cli-btn.ghost').trigger('click')
    expect(termSpies.interrupt).toHaveBeenCalledTimes(1)
    await wrapper.find('.ai-cli-btn.danger').trigger('click')
    expect(termSpies.kill).toHaveBeenCalledTimes(1)
    // Stop is the one kill that tells the backend not to restore this CLI.
    expect(termSpies.kill).toHaveBeenCalledWith({ retireRestore: true })
    expect(termSpies.cancelPendingCreate).not.toHaveBeenCalled()
  })

  it('Stop while starting cancels the pending create instead of kill()', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    termState.status.value = 'starting'
    await nextTick()
    await wrapper.find('.ai-cli-btn.danger').trigger('click')
    expect(termSpies.cancelPendingCreate).toHaveBeenCalledTimes(1)
    expect(termSpies.kill).not.toHaveBeenCalled()
  })

  it('emits status on every transition and exited when the PTY leaves active', async () => {
    const wrapper = mountDock()
    await openDock(wrapper)
    termState.status.value = 'running'
    await nextTick()
    termState.status.value = 'exited'
    await nextTick()
    expect(wrapper.emitted('status')).toEqual([['running'], ['exited']])
    expect(wrapper.emitted('exited')).toHaveLength(1)
  })

  it('exposes the imperative API (start/stop/interrupt/pasteText/injectNow/toggle/terminal)', async () => {
    const wrapper = mountDock()
    const vm = wrapper.vm as unknown as Record<string, unknown>
    for (const key of ['start', 'stop', 'interrupt', 'pasteText', 'injectNow', 'toggle']) {
      expect(typeof vm[key], key).toBe('function')
    }
    await openDock(wrapper)
    ;(vm.pasteText as (t: string) => void)('hello')
    expect(termSpies.pasteText).toHaveBeenCalledWith('hello')
    // injectNow: immediate re-injection into a RUNNING CLI, no quiet-wait.
    termState.status.value = 'running'
    await nextTick()
    await wrapper.setProps({ buildContext: () => 'NOW' })
    const injectPromise = (vm.injectNow as () => Promise<void>)()
    await flushPromises()
    expect(termSpies.pasteText).toHaveBeenCalledWith(bracketedPaste('NOW'))
    await new Promise((r) => setTimeout(r, 350))
    await injectPromise
    expect(termSpies.pasteText).toHaveBeenCalledWith('\r')
  })
})

describe('AiCliDock — @-mention sections key on the workspace path', () => {
  function mountWithRoster(panes: Record<string, unknown>[]): VueWrapper {
    const port = {
      status: ref('connected'),
      shell: ref(''),
      autoRestart: ref(null),
      listAgentPanes: vi.fn(async () => ({ ok: true, payload: { panes } })),
    } as unknown as TerminalDockPort
    return mountDock({ terminalPort: port })
  }

  // The getter the dock hands the terminal; `mention-candidates` is an attr on
  // the stub rather than a declared prop, hence the $attrs read.
  function readCandidates(wrapper: VueWrapper): MentionCandidate[] {
    const attrs = wrapper.findComponent(terminalStub).vm.$attrs as Record<string, unknown>
    const getter = attrs['mention-candidates'] as () => MentionCandidate[]
    return getter()
  }

  it('keeps same-named folders in separate sections titled with the folder name', async () => {
    const wrapper = mountWithRoster([
      {
        pane_id: 'p1',
        qualified_name: 'api/claude-1',
        workspace_label: 'api',
        workspace_path: '/Users/me/work/api',
      },
      {
        pane_id: 'p2',
        qualified_name: 'api/codex-1',
        workspace_label: 'api',
        workspace_path: '/Users/me/side/api',
      },
    ])
    await flushPromises()

    const candidates = readCandidates(wrapper)
    expect(candidates).toHaveLength(2)
    const byAddress = new Map(candidates.map((c) => [c.address, c]))
    // The bug this guards: keying on the folder name merged both projects into
    // a single "api" section, leaving the two panes indistinguishable.
    expect(byAddress.get('api/claude-1')!.group).toBe('/Users/me/work/api')
    expect(byAddress.get('api/codex-1')!.group).toBe('/Users/me/side/api')
    expect(new Set(candidates.map((c) => c.group)).size).toBe(2)
    // The header still reads as a folder name, not a whole absolute path.
    expect(candidates.map((c) => c.groupLabel)).toEqual(['api', 'api'])
  })

  it('falls back to the folder name as the key when an older backend sends no workspace_path', async () => {
    const wrapper = mountWithRoster([
      { pane_id: 'p1', qualified_name: 'api/claude-1', workspace_label: 'api' },
      { pane_id: 'p2', qualified_name: 'web/codex-1' },
    ])
    await flushPromises()

    expect(readCandidates(wrapper)).toEqual([
      { address: 'api/claude-1', group: 'api', groupLabel: 'api' },
      { address: 'web/codex-1', group: 'web', groupLabel: 'web' },
    ])
  })

  it('titles a section with the workspace alias when the roster carries one', async () => {
    const wrapper = mountWithRoster([
      {
        pane_id: 'p1',
        qualified_name: 'api/claude-1',
        workspace_label: 'api',
        workspace_path: '/Users/me/work/api',
        workspace_display_name: 'Client Portal',
      },
      {
        pane_id: 'p2',
        qualified_name: 'api/codex-1',
        workspace_label: 'api',
        workspace_path: '/Users/me/side/api',
      },
    ])
    await flushPromises()

    const byAddress = new Map(readCandidates(wrapper).map((c) => [c.address, c]))
    // The alias wins for the header…
    expect(byAddress.get('api/claude-1')!.groupLabel).toBe('Client Portal')
    // …and a pane whose workspace has no alias still reads as its folder name.
    expect(byAddress.get('api/codex-1')!.groupLabel).toBe('api')
    // The key stays the path either way: aliases are not unique either.
    expect(byAddress.get('api/claude-1')!.group).toBe('/Users/me/work/api')
    expect(byAddress.get('api/codex-1')!.group).toBe('/Users/me/side/api')
    // The inserted handle is untouched by any of this.
    expect(byAddress.get('api/claude-1')!.address).toBe('api/claude-1')
  })

  it('falls back to the folder name when the alias is blank or whitespace', async () => {
    const wrapper = mountWithRoster([
      {
        pane_id: 'p1',
        qualified_name: 'api/claude-1',
        workspace_label: 'api',
        workspace_path: '/Users/me/work/api',
        workspace_display_name: '   ',
      },
    ])
    await flushPromises()

    expect(readCandidates(wrapper)[0].groupLabel).toBe('api')
  })

  it('names the window an embedded panel lives in, and nothing for a window pane', async () => {
    const wrapper = mountWithRoster([
      { pane_id: 'p1', qualified_name: 'ws/pm-claude', workspace_path: '/tmp/ws', surface: 'pm' },
      { pane_id: 'p2', qualified_name: 'ws/claude-1', workspace_path: '/tmp/ws' },
    ])
    await flushPromises()

    const byAddress = new Map(readCandidates(wrapper).map((c) => [c.address, c]))
    expect(byAddress.get('ws/pm-claude')!.windowLabel).toBe('Pipeline Manager')
    expect('windowLabel' in byAddress.get('ws/claude-1')!).toBe(false)
  })

  it('leaves this panel out of its own mention list', async () => {
    const wrapper = mountWithRoster([
      {
        pane_id: 'ab12cd34-test-cli-dock',
        qualified_name: 'ws/self',
        workspace_path: '/tmp/ws',
      },
      {
        pane_id: 'p2',
        qualified_name: 'ws/claude-1',
        workspace_path: '/tmp/ws',
      },
    ])
    await flushPromises()

    expect(readCandidates(wrapper).map((c) => c.address)).toEqual(['ws/claude-1'])
  })
})

describe('AiCliDock — messaging roster registration', () => {
  function registeringPort(panes: Array<Record<string, string>> = []) {
    const registerAgentPane = vi.fn(async (_pane: Record<string, string>) => ({ ok: true }))
    const unregisterAgentPane = vi.fn(async () => ({ ok: true }))
    const port = {
      ...makeTerminalPort(),
      listAgentPanes: vi.fn(async () => ({ ok: true, payload: { panes } })),
      registerAgentPane,
      unregisterAgentPane,
    } as unknown as TerminalDockPort
    return { port, registerAgentPane, unregisterAgentPane }
  }

  it('registers once its CLI is running, naming the window it lives in', async () => {
    const { port, registerAgentPane } = registeringPort()
    mountDock({ terminalPort: port, origin: 'pipeline-manager' })
    await flushPromises()
    expect(registerAgentPane).not.toHaveBeenCalled()

    termState.status.value = 'running'
    await flushPromises()
    expect(registerAgentPane).toHaveBeenCalledTimes(1)
    expect(registerAgentPane).toHaveBeenCalledWith({
      pane_id: 'ab12cd34-test-cli-dock',
      name: 'pm-claude',
      workspace_path: '/tmp/ws',
      agent_key: 'claude',
      surface: 'pm',
      window_kind: 'main',
    })
  })

  it('takes the next free name when the workspace already has one', async () => {
    const { port, registerAgentPane } = registeringPort([
      { pane_id: 'other', name: 'pm-claude', workspace_path: '/tmp/ws' },
    ])
    mountDock({ terminalPort: port, origin: 'pipeline-manager' })
    termState.status.value = 'running'
    await flushPromises()
    expect(registerAgentPane.mock.calls[0][0]).toMatchObject({ name: 'pm-claude-2' })
  })

  it('unregisters when the CLI exits, and again on unmount only if still registered', async () => {
    const { port, registerAgentPane, unregisterAgentPane } = registeringPort()
    const wrapper = mountDock({ terminalPort: port, origin: 'plan-window' })
    termState.status.value = 'running'
    await flushPromises()
    expect(registerAgentPane).toHaveBeenCalledTimes(1)

    termState.status.value = 'exited'
    await flushPromises()
    expect(unregisterAgentPane).toHaveBeenCalledWith('ab12cd34-test-cli-dock')

    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)
    await flushPromises()
    expect(unregisterAgentPane).toHaveBeenCalledTimes(1)
  })

  it('unregisters on unmount while the CLI is still running', async () => {
    const { port, unregisterAgentPane } = registeringPort()
    const wrapper = mountDock({ terminalPort: port, origin: 'git-window' })
    termState.status.value = 'running'
    await flushPromises()
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)
    await flushPromises()
    expect(unregisterAgentPane).toHaveBeenCalledWith('ab12cd34-test-cli-dock')
  })

  it('re-registers after the backend connection comes back', async () => {
    const { port, registerAgentPane } = registeringPort()
    mountDock({ terminalPort: port, origin: 'pipeline-manager' })
    termState.status.value = 'running'
    await flushPromises()
    const status = (port as unknown as { status: Ref<string> }).status
    status.value = 'disconnected'
    await flushPromises()
    status.value = 'connected'
    await flushPromises()
    expect(registerAgentPane).toHaveBeenCalledTimes(2)
  })

  it('shows its address in the header once the backend accepts the registration', async () => {
    const { port } = registeringPort()
    const wrapper = mountDock({ terminalPort: port, origin: 'pipeline-manager' })
    termState.status.value = 'running'
    await flushPromises()
    expect(wrapper.find('.ai-cli-address').text()).toBe('@pm-claude')
  })

  it('shows no address when the backend refuses the registration', async () => {
    const { port, registerAgentPane } = registeringPort()
    // A host whose bridge cannot map the call answers ok:false rather than
    // throwing (the plugin shim's UNMAPPED_CAPABILITY), as does a backend refusal.
    registerAgentPane.mockImplementation(async () => ({
      ok: false,
      error: { code: 'UNMAPPED_CAPABILITY', message: 'no capability mapping' },
    }) as never)
    const wrapper = mountDock({ terminalPort: port, origin: 'mini-ide' })
    termState.status.value = 'running'
    await flushPromises()
    expect(registerAgentPane).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.ai-cli-address').exists()).toBe(false)
  })

  it('retries a failed registration and shows the address once it succeeds', async () => {
    vi.useFakeTimers()
    try {
      const { port, registerAgentPane } = registeringPort()
      // A Plan window reload: the old window's connection still holds the id.
      registerAgentPane.mockImplementationOnce(async () => ({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'pane is held by another window' },
      }) as never)
      const wrapper = mountDock({ terminalPort: port, origin: 'plan-window' })
      termState.status.value = 'running'
      await flushPromises()
      expect(registerAgentPane).toHaveBeenCalledTimes(1)
      expect(wrapper.find('.ai-cli-address').exists()).toBe(false)

      await vi.advanceTimersByTimeAsync(1000)
      await flushPromises()
      expect(registerAgentPane).toHaveBeenCalledTimes(2)
      expect(wrapper.find('.ai-cli-address').text()).toBe('@plans-claude')
      expect(wrapper.find('.ai-cli-roster-error').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says why in the panel when every registration attempt fails', async () => {
    vi.useFakeTimers()
    try {
      const { port, registerAgentPane } = registeringPort()
      registerAgentPane.mockImplementation(async () => ({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'pane is held by another window' },
      }) as never)
      const wrapper = mountDock({ terminalPort: port, origin: 'plan-window' })
      termState.status.value = 'running'
      await flushPromises()
      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      expect(registerAgentPane).toHaveBeenCalledTimes(4)
      const error = wrapper.find('.ai-cli-roster-error')
      expect(error.exists()).toBe(true)
      expect(error.text()).toContain('pane is held by another window')

      // The CLI ends: nothing is left to be unreachable.
      termState.status.value = 'exited'
      await flushPromises()
      expect(wrapper.find('.ai-cli-roster-error').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying once the CLI ends', async () => {
    vi.useFakeTimers()
    try {
      const { port, registerAgentPane } = registeringPort()
      registerAgentPane.mockImplementation(async () => { throw new Error('socket closed') })
      mountDock({ terminalPort: port, origin: 'plan-window' })
      termState.status.value = 'running'
      await flushPromises()
      termState.status.value = 'exited'
      await flushPromises()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(registerAgentPane).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing on a port that cannot register (older host)', async () => {
    mountDock({ origin: 'pipeline-manager' })
    termState.status.value = 'running'
    await flushPromises()
    // No throw, no unhandled rejection: the dock simply stays unregistered.
    expect(termSpies.spawn).not.toHaveBeenCalled()
  })
})

describe('AiCliDock — message delivery into the panel', () => {
  type Delivery = { msgKey: string; targetPaneId: string; text: string; fromDisplay: string; kind?: 'ack' }
  function deliveringPort() {
    let listener: ((m: Delivery) => void) | null = null
    const off = vi.fn(() => { listener = null })
    const reportAgentDelivery = vi.fn(async (_k: string, _ok: boolean, _reason?: string) => ({ ok: true }))
    const registerAgentPane = vi.fn(async (_pane: Record<string, unknown>) => ({ ok: true }))
    const port = {
      ...makeTerminalPort(),
      listAgentPanes: vi.fn(async () => ({ ok: true, payload: { panes: [] } })),
      registerAgentPane,
      unregisterAgentPane: vi.fn(async () => ({ ok: true })),
      onAgentMessage: vi.fn((cb: (m: Delivery) => void) => { listener = cb; return off }),
      reportAgentDelivery,
    } as unknown as TerminalDockPort
    const send = (m: Partial<Delivery>) => listener?.({
      msgKey: 'k-1',
      targetPaneId: 'ab12cd34-test-cli-dock',
      text: 'ENVELOPE',
      fromDisplay: 'reviewer',
      ...m,
    })
    return { port, send, off, reportAgentDelivery, registerAgentPane }
  }

  function runningQuiet(): void {
    termState.status.value = 'running'
    termState.lastRawActivityAt.value = Date.now() - 60000
  }

  it('registers as deliverable when its port can deliver', async () => {
    const { port, registerAgentPane } = deliveringPort()
    mountDock({ terminalPort: port, origin: 'plan-window' })
    termState.status.value = 'running'
    await flushPromises()
    expect(registerAgentPane.mock.calls[0][0]).toMatchObject({ surface: 'plans', deliverable: true })
  })

  it('pastes a message for this panel once the CLI is quiet, submits it and reports ok', async () => {
    const { port, send, reportAgentDelivery } = deliveringPort()
    mountDock({ terminalPort: port })
    runningQuiet()
    await flushPromises()
    send({})
    await flushPromises()
    expect(termSpies.pasteText).toHaveBeenCalledWith(bracketedPaste('ENVELOPE'))
    await new Promise((r) => setTimeout(r, 350))
    expect(termSpies.pasteText).toHaveBeenCalledWith('\r')
    expect(reportAgentDelivery).toHaveBeenCalledWith('k-1', true)
  })

  it('ignores a message for another pane without reporting', async () => {
    const { port, send, reportAgentDelivery } = deliveringPort()
    mountDock({ terminalPort: port })
    runningQuiet()
    await flushPromises()
    send({ targetPaneId: 'someone-else' })
    await new Promise((r) => setTimeout(r, 350))
    expect(termSpies.pasteText).not.toHaveBeenCalled()
    expect(reportAgentDelivery).not.toHaveBeenCalled()
  })

  it('delivers a repeated msgKey only once', async () => {
    const { port, send, reportAgentDelivery } = deliveringPort()
    mountDock({ terminalPort: port })
    runningQuiet()
    await flushPromises()
    send({})
    send({})
    await new Promise((r) => setTimeout(r, 400))
    expect(termSpies.pasteText.mock.calls.filter((c) => (c as unknown[])[0] === bracketedPaste('ENVELOPE'))).toHaveLength(1)
    expect(reportAgentDelivery).toHaveBeenCalledTimes(1)
  })

  it('still delivers to a CLI that never goes quiet, reporting it went in while busy', async () => {
    const { port, send, reportAgentDelivery } = deliveringPort()
    mountDock({ terminalPort: port, injectTimeoutMs: 300 })
    termState.status.value = 'running'
    // Output keeps arriving: the CLI is busy for the whole wait.
    termState.lastRawActivityAt.value = Date.now() + 60000
    await flushPromises()
    send({})
    await new Promise((r) => setTimeout(r, 1000))
    expect(termSpies.pasteText).toHaveBeenCalledWith(bracketedPaste('ENVELOPE'))
    expect(termSpies.pasteText).toHaveBeenCalledWith('\r')
    expect(reportAgentDelivery).toHaveBeenCalledWith('k-1', true, 'delivered-while-busy')
  })

  it('reports pane-closed when no CLI is running', async () => {
    const { port, send, reportAgentDelivery } = deliveringPort()
    mountDock({ terminalPort: port })
    await flushPromises()
    send({})
    await flushPromises()
    expect(termSpies.pasteText).not.toHaveBeenCalled()
    expect(reportAgentDelivery).toHaveBeenCalledWith('k-1', false, 'pane-closed')
  })

  it('reports inject-failed when the paste does not leave', async () => {
    const { port, send, reportAgentDelivery } = deliveringPort()
    termSpies.pasteText.mockReturnValueOnce(false)
    mountDock({ terminalPort: port })
    runningQuiet()
    await flushPromises()
    send({})
    await flushPromises()
    expect(termSpies.pasteText).not.toHaveBeenCalledWith('\r')
    expect(reportAgentDelivery).toHaveBeenCalledWith('k-1', false, 'inject-failed')
  })

  it('reports an ack without typing it', async () => {
    const { port, send, reportAgentDelivery } = deliveringPort()
    mountDock({ terminalPort: port })
    runningQuiet()
    await flushPromises()
    send({ kind: 'ack' })
    await flushPromises()
    expect(termSpies.pasteText).not.toHaveBeenCalled()
    expect(reportAgentDelivery).toHaveBeenCalledWith('k-1', true, 'ack')
  })

  it('stops listening on unmount', async () => {
    const { port, off } = deliveringPort()
    const wrapper = mountDock({ terminalPort: port })
    await flushPromises()
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('registers without the flag on a port that cannot deliver', async () => {
    const registerAgentPane = vi.fn(async (_pane: Record<string, unknown>) => ({ ok: true }))
    const port = {
      ...makeTerminalPort(),
      listAgentPanes: vi.fn(async () => ({ ok: true, payload: { panes: [] } })),
      registerAgentPane,
      unregisterAgentPane: vi.fn(async () => ({ ok: true })),
    } as unknown as TerminalDockPort
    mountDock({ terminalPort: port, origin: 'git-window' })
    termState.status.value = 'running'
    await flushPromises()
    expect(registerAgentPane.mock.calls[0][0]).not.toHaveProperty('deliverable')
  })
})

describe('AiCliDock — restore from the panel record', () => {
  // The backend keeps a panel's record 'spawned' across an app quit (closing
  // its window retires it). When the window comes back and its PTY is gone, the
  // panel resumes that conversation instead of waiting for Start.
  function restorePort(record: { agentKey: string; sessionId: string } | null): TerminalDockPort {
    return {
      ...makeTerminalPort(),
      readDockRestore: vi.fn(async () => record),
    } as unknown as TerminalDockPort
  }

  it('resumes the recorded session when the reattach finds no PTY', async () => {
    const terminalPort = restorePort({ agentKey: 'claude', sessionId: 'sess-123' })
    const pin = vi.fn()
    mountDock({ terminalPort: { ...terminalPort, pinFreshSessionAtLaunch: pin } as unknown as TerminalDockPort, origin: 'plan-window' })
    await flushPromises()
    expect(terminalPort.readDockRestore).toHaveBeenCalledWith('/tmp/ws', 'ab12cd34-test-cli-dock')
    expect(termSpies.spawn).toHaveBeenCalledTimes(1)
    const opts = (termSpies.spawn.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(opts.command).toEqual(['bash', '-lc', 'claude --resume sess-123 --dangerously-skip-permissions'])
    expect(opts.skipReattach).toBe(true)
    expect(opts.outputLogFile).toBe(dockOutputLogFile('/tmp/ws', 'claude', 'ab12cd34-test-cli-dock', 'plans'))
    expect(opts.metadata).toMatchObject({
      surface: 'plans',
      window_kind: 'plans',
      cli_command: 'claude --resume sess-123 --dangerously-skip-permissions',
      explicit_session_id: 'sess-123',
    })
    // A resume is not a fresh launch: no new pin.
    expect(pin).not.toHaveBeenCalled()
  })

  it('retires instead of resuming when the plugin providing its surface is gone', async () => {
    const terminalPort = {
      ...restorePort({ agentKey: 'claude', sessionId: 'sess-123' }),
      dockSurfaceRetired: vi.fn(async () => true),
    } as unknown as TerminalDockPort
    mountDock({ terminalPort, origin: 'git-window' })
    await flushPromises()
    expect(terminalPort.dockSurfaceRetired).toHaveBeenCalledWith('/tmp/ws', 'ab12cd34-test-cli-dock', 'git')
    expect(termSpies.spawn).not.toHaveBeenCalled()
  })

  it('resumes when the plugin providing its surface is still there', async () => {
    const terminalPort = {
      ...restorePort({ agentKey: 'claude', sessionId: 'sess-123' }),
      dockSurfaceRetired: vi.fn(async () => false),
    } as unknown as TerminalDockPort
    mountDock({ terminalPort, origin: 'plan-window' })
    await flushPromises()
    expect(termSpies.spawn).toHaveBeenCalledTimes(1)
  })

  it('injects no context into a resumed conversation', async () => {
    const buildContext = vi.fn(() => 'CTX')
    termSpies.spawn.mockImplementation(async () => { termState.status.value = 'running' })
    mountDock({ terminalPort: restorePort({ agentKey: 'claude', sessionId: 'sess-123' }), buildContext })
    await flushPromises()
    expect(termSpies.spawn).toHaveBeenCalledTimes(1)
    expect(buildContext).not.toHaveBeenCalled()
    expect(termSpies.pasteText).not.toHaveBeenCalled()
  })

  it('resumes with the recorded agent, not the picker default', async () => {
    settingsState.stored['test-cli-panel-width.agent'] = 'claude'
    mountDock({ terminalPort: restorePort({ agentKey: 'codex', sessionId: 'abc-1' }) })
    await flushPromises()
    const opts = (termSpies.spawn.mock.calls[0] as unknown as [{ agentKey: string }])[0]
    expect(opts.agentKey).toBe('codex')
  })

  it('leaves the Start UI when there is no record', async () => {
    const terminalPort = restorePort(null)
    mountDock({ terminalPort })
    await flushPromises()
    expect(terminalPort.readDockRestore).toHaveBeenCalledTimes(1)
    expect(termSpies.spawn).not.toHaveBeenCalled()
  })

  it('leaves the Start UI when the record has no session id', async () => {
    mountDock({ terminalPort: restorePort({ agentKey: 'claude', sessionId: '' }) })
    await flushPromises()
    expect(termSpies.spawn).not.toHaveBeenCalled()
  })

  it('refuses a session id that is not shell-safe', async () => {
    mountDock({ terminalPort: restorePort({ agentKey: 'claude', sessionId: 'x; rm -rf ~' }) })
    await flushPromises()
    expect(termSpies.spawn).not.toHaveBeenCalled()
  })

  it('does not resume when the reattach claimed a live PTY', async () => {
    termSpies.tryReattach.mockImplementation(async () => {
      termState.status.value = 'running'
      return true as unknown as undefined
    })
    const terminalPort = restorePort({ agentKey: 'claude', sessionId: 'sess-123' })
    mountDock({ terminalPort })
    await flushPromises()
    expect(terminalPort.readDockRestore).not.toHaveBeenCalled()
    expect(termSpies.spawn).not.toHaveBeenCalled()
  })

  it('does nothing on a port that cannot read the record (older host)', async () => {
    mountDock()
    await flushPromises()
    expect(termSpies.spawn).not.toHaveBeenCalled()
  })
})

describe('AiCliDock — the header names the address other panes reach it by', () => {
  function rosterPort() {
    return {
      ...makeTerminalPort(),
      listAgentPanes: vi.fn(async () => ({ ok: true, payload: { panes: [] } })),
      registerAgentPane: vi.fn(async () => ({ ok: true })),
      unregisterAgentPane: vi.fn(async () => ({ ok: true })),
    } as unknown as TerminalDockPort
  }
  // `<!--v-if-->` is Vue's invisible placeholder for an untaken branch.
  const head = (w: VueWrapper): string => w.find('.ai-cli-head').element.outerHTML.replace(/<!--v-if-->/g, '')

  it('shows the roster name once the panel is registered', async () => {
    const wrapper = mountDock({ terminalPort: rosterPort(), origin: 'pipeline-manager' })
    termState.status.value = 'running'
    await flushPromises()
    const address = wrapper.find('.ai-cli-head .ai-cli-address')
    expect(address.exists()).toBe(true)
    expect(address.text()).toBe('@pm-claude')
    expect(address.attributes('title')).toContain('pm-claude')
  })

  it('draws the header exactly as before while nothing is registered', async () => {
    const wrapper = mountDock({ terminalPort: rosterPort(), origin: 'pipeline-manager' })
    await flushPromises()
    expect(wrapper.find('.ai-cli-address').exists()).toBe(false)
    expect(head(wrapper)).toMatchSnapshot()

    // And again once the CLI has ended and the panel left the roster.
    termState.status.value = 'running'
    await flushPromises()
    termState.status.value = 'exited'
    await flushPromises()
    expect(wrapper.find('.ai-cli-address').exists()).toBe(false)
    expect(head(wrapper)).toMatchSnapshot()
  })
})
