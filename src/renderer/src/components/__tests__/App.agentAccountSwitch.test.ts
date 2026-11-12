// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { runAgentAccountSwitch, switchRequester } from '../../lib/agentAccountSwitch'
import { runAgentPaneAccountSwitch } from '../../lib/agentPaneAccountSwitch'
import { createAccountSwitchQueue } from '../../lib/accountSwitchQueue'
import { createCliAccountSwitchHandler, type SetDefaultResult } from '../../composables/useCliProfiles'
import { revealInvisibleText } from '../../../../shared/pluginAgentTools'

// Plan agent-0-2-42_3f728e: App.vue's ui.accounts.switch (MCP
// cli_account_switch, the Telegram account button) is the user's own click
// without the questions. Executes the real App.vue functions with the
// window's state and IO replaced, around the REAL switch handler
// (createCliAccountSwitchHandler) the user's click goes through, so the
// switch path is the same one and a dialog anywhere on it fails here.
const source = parse(readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
const NAMES = [
  'switchToastContext', 'toastAccountSwitch', 'onQueuedAccountSwitchSettled', 'accountSwitchBusy',
  'accountSwitchBusyPaneCount', 'agentAccountSwitch', 'agentPaneAccountSwitch', 'moveAgentPaneAccount',
  'restartAgentPanes',
]
const js = NAMES.map((name) => {
  const decl = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!decl) throw new Error(`App.vue has no function ${name}`)
  return ts.transpileModule(decl.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
}).join('\n')

type Status = 'running' | 'idle'

function harness(opts: { panesRunning?: boolean } = {}) {
  const profiles: Record<string, { agentKey: string; name: string }> = {
    'p-a': { agentKey: 'codex', name: 'Account 1' },
    'p-b': { agentKey: 'codex', name: 'Account 2' },
    'p-c': { agentKey: 'codex', name: 'Account 3' },
    'c-1': { agentKey: 'claude', name: 'Claude 1' },
  }
  let active: string | null = 'p-a'
  const setDefault = vi.fn(async (_agentKey: string, profileId: string | null, o?: { force?: boolean }): Promise<SetDefaultResult> => {
    if (opts.panesRunning && !o?.force) return { ok: false, code: 'PANES_RUNNING', count: 1 }
    active = profileId
    return { ok: true }
  })
  const confirm = vi.fn(async () => true)
  const status: Record<string, Status> = { w1: 'idle', pa: 'running' }
  // Panes of OTHER windows the backend's registry reports at work.
  const otherWindowBusy: string[] = []
  const cliProfilesApi = {
    findProfile: (id: string | null) => (id ? profiles[id] : undefined),
    defaultProfileId: (agentKey: string) => (agentKey === 'codex' ? active : 'c-0'),
    aliasFor: () => undefined,
    setDefault,
  }
  const cliAccountSwitch = createCliAccountSwitchHandler(cliProfilesApi, {
    confirm,
    agentLabel: (k) => k,
    startLogin: vi.fn(),
  })
  const queue = createAccountSwitchQueue({ setTimer: () => 0, clearTimer: () => undefined })
  const rebuildPaneViaResume = vi.fn(async (paneId: string, o: { suppressBusyToast?: boolean }) => {
    if (status[paneId] === 'running') {
      // The single-pane rebuild asks before stopping a working pane unless told not to.
      if (o.suppressBusyToast) return 'busy'
      await confirm()
    }
    return undefined
  })
  const scope = {
    runAgentAccountSwitch,
    runAgentPaneAccountSwitch,
    switchRequester,
    revealInvisibleText,
    cliProfilesApi,
    cliAccountSwitch,
    accountSwitchQueue: queue,
    panes: ref([
      { id: 'pa', agentKey: 'claude', workspacePath: '/ws/alpha', messagingName: 'builder​' },
      { id: 'w1', agentKey: 'codex', workspacePath: '/ws/alpha', customName: 'worker' },
    ]),
    paneRefs: new Proxy({}, { get: (_t, id: string) => ({ displayStatus: status[id] ?? 'idle', status: 'running' }) }),
    paneBusyForRebuild: (display?: string) => (display === 'running' ? 'running' : false),
    paneNeedsAccountRestart: (p: { agentKey: string }, agentKey: string) => p.agentKey === agentKey,
    paneAccountFixed: () => true,
    followDirSignedIn: () => true,
    FOLLOW_SWITCH_AGENT: 'claude',
    rebuildPaneViaResume,
    accountFollow: { add: vi.fn(), remove: vi.fn() },
    backend: {
      send: vi.fn(async (type: string, payload: Record<string, unknown>) =>
        type === 'account_switch.busy_panes'
          ? { payload: { pane_ids: payload.agent_key === 'codex' ? [...otherWindowBusy] : [] } }
          : { payload: { recorded: true } }),
    },
    runAccountRestartBatch: vi.fn(async (ids: string[], rebuild: (id: string) => Promise<unknown>) => {
      for (const id of ids) await rebuild(id)
    }),
    paneResumeSessionId: () => 'sess',
    pipelineLog: vi.fn(),
    notifyRestore: { toast: vi.fn(), confirm },
    i18n: { global: { t: (key: string, params?: Record<string, unknown>) => `${key} ${JSON.stringify(params ?? {})}` } },
  }
  const fns = new Function(...Object.keys(scope), `${js}\nreturn { agentAccountSwitch, agentPaneAccountSwitch, restartAgentPanes }`)(
    ...Object.values(scope),
  ) as Record<'agentAccountSwitch' | 'agentPaneAccountSwitch', (args: Record<string, unknown>, callerPaneId: string) => Promise<Record<string, unknown>>>
    & { restartAgentPanes: (agentKey: string, opts?: { unattended?: boolean }) => Promise<void> }
  return { scope, status, otherWindowBusy, queue, confirm, setDefault, cliAccountSwitch, ...fns }
}

const args = (over: Record<string, unknown> = {}) => ({
  agentKey: 'codex', profileId: 'p-b', reason: 'quota ran out', reasonTruncated: false,
  requestId: '7', requester: { source: 'mcp', name: 'builder' }, ...over,
})

describe('App.vue ui.accounts.switch: the user\'s switch without the questions', () => {
  it('switches at once when no pane is working: no dialog, a toast', async () => {
    const h = harness()
    expect(await h.agentAccountSwitch(args(), 'pa')).toMatchObject({ status: 'switched', from: 'Account 1', to: 'Account 2' })
    expect(h.setDefault.mock.calls).toEqual([['codex', 'p-b']])
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.scope.notifyRestore.toast).toHaveBeenCalledTimes(1)
    expect(String(h.scope.notifyRestore.toast.mock.calls[0][0])).toContain('agent-switch-done')
    expect(h.queue.size).toBe(0)
  })

  it('queues behind a working pane, never asks, and finishes once the pane is idle', async () => {
    const h = harness({ panesRunning: true })
    h.status.w1 = 'running'
    expect(await h.agentAccountSwitch(args(), 'pa')).toMatchObject({ status: 'queued', waiting: 1, to: 'Account 2' })
    expect(h.setDefault.mock.calls).toEqual([['codex', 'p-b']]) // tried plainly, never forced while working
    expect(h.queue.size).toBe(1)
    await h.queue.tick()
    expect(h.setDefault).toHaveBeenCalledTimes(1) // still working: nothing more
    h.status.w1 = 'idle'
    await h.queue.tick()
    expect(h.setDefault.mock.calls.at(-1)).toEqual(['codex', 'p-b', { force: true, unattended: true }])
    expect(h.queue.size).toBe(0)
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.scope.backend.send).toHaveBeenCalledWith('account_switch.settled', expect.objectContaining({
      request_id: '7', status: 'switched', from: 'Account 1', to: 'Account 2', from_profile_id: 'p-a',
    }))
    const toasts = h.scope.notifyRestore.toast.mock.calls.map(([text]) => String(text))
    expect(toasts[0]).toContain('agent-switch-queued')
    expect(toasts[1]).toContain('agent-switch-done')
  })

  it('restarts idle panes at once (the forced switch) without asking', async () => {
    const h = harness({ panesRunning: true })
    expect(await h.agentAccountSwitch(args(), 'pa')).toMatchObject({ status: 'switched' })
    expect(h.setDefault.mock.calls.at(-1)).toEqual(['codex', 'p-b', { force: true, unattended: true }])
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('the user\'s own click with running panes still asks, as before', async () => {
    const h = harness({ panesRunning: true })
    h.confirm.mockResolvedValueOnce(false)
    expect(await h.cliAccountSwitch('codex', 'p-b')).toEqual({ ok: false, code: 'PANES_RUNNING' })
    expect(h.confirm).toHaveBeenCalledTimes(1)
  })

  it('the newest request wins: a second request replaces the queued one', async () => {
    const h = harness({ panesRunning: true })
    h.status.w1 = 'running'
    expect((await h.agentAccountSwitch(args({ requestId: '1' }), 'pa')).status).toBe('queued')
    expect((await h.agentAccountSwitch(args({ requestId: '2', profileId: 'p-c' }), 'pa')).status).toBe('queued')
    expect(h.scope.backend.send).toHaveBeenCalledWith('account_switch.settled', expect.objectContaining({ request_id: '1', status: 'superseded' }))
    h.status.w1 = 'idle'
    await h.queue.tick()
    expect(h.setDefault.mock.calls.at(-1)).toEqual(['codex', 'p-c', { force: true, unattended: true }])
    expect(h.scope.backend.send).toHaveBeenCalledWith('account_switch.settled', expect.objectContaining({ request_id: '2', status: 'switched', to: 'Account 3' }))
  })

  it('drops a queued switch whose account changed some other way meanwhile', async () => {
    const h = harness({ panesRunning: true })
    h.status.w1 = 'running'
    await h.agentAccountSwitch(args(), 'pa')
    await h.cliAccountSwitch('codex', 'p-c') // the user's own switch (confirmed)
    h.status.w1 = 'idle'
    const before = h.setDefault.mock.calls.length
    await h.queue.tick()
    expect(h.setDefault.mock.calls.length).toBe(before)
    expect(h.scope.backend.send).toHaveBeenCalledWith('account_switch.settled', expect.objectContaining({ request_id: '7', status: 'stale' }))
  })

  it('moves a working pane once its turn ends, without asking', async () => {
    const h = harness()
    const paneArgs = { agentKey: 'claude', profileId: 'c-1', paneId: 'pa', reason: 'own quota', requestId: '9', requester: { source: 'mcp', name: 'builder' } }
    expect(await h.agentPaneAccountSwitch(paneArgs, 'pa')).toMatchObject({ status: 'queued', waiting: 1 })
    expect(h.scope.rebuildPaneViaResume).not.toHaveBeenCalled()
    h.status.pa = 'idle'
    await h.queue.tick()
    expect(h.scope.rebuildPaneViaResume).toHaveBeenCalledWith('pa', expect.objectContaining({ profileId: 'c-1', suppressBusyToast: true }))
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.scope.backend.send).toHaveBeenCalledWith('account_switch.settled', expect.objectContaining({ request_id: '9', status: 'switched-pane' }))
  })

  it('names a chat requester in the toast and reveals invisible characters', async () => {
    const h = harness()
    await h.agentAccountSwitch(args({ requester: { source: 'telegram', name: 'Telegram @me' }, reason: 'quota‮ out' }), '')
    const text = String(h.scope.notifyRestore.toast.mock.calls[0][0])
    expect(text).toContain('Telegram @me')
    expect(text).toContain('quota\\\\u{202e} out')
    expect(text).not.toMatch(/[​‮]/)
  })

  it('names the calling pane for an agent and reveals invisible characters', async () => {
    const h = harness()
    await h.agentAccountSwitch(args(), 'pa')
    const text = String(h.scope.notifyRestore.toast.mock.calls[0][0])
    expect(text).toContain('builder\\\\u{200b}')
  })

  // R6: a forced switch restarts the panes of EVERY window, so a working pane
  // in another window is waited for too, through the backend's registry.
  it('waits for a working pane in another window before switching', async () => {
    const h = harness({ panesRunning: true })
    h.otherWindowBusy.push('other-window-pane')
    expect(await h.agentAccountSwitch(args(), 'pa')).toMatchObject({ status: 'queued', waiting: 1 })
    expect(h.setDefault.mock.calls).toEqual([['codex', 'p-b']])
    await h.queue.tick()
    expect(h.setDefault).toHaveBeenCalledTimes(1)
    h.otherWindowBusy.length = 0
    await h.queue.tick()
    expect(h.setDefault.mock.calls.at(-1)).toEqual(['codex', 'p-b', { force: true, unattended: true }])
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('keeps waiting when the backend cannot say who is working', async () => {
    const h = harness({ panesRunning: true })
    h.scope.backend.send.mockImplementation(async (type: string) => {
      if (type === 'account_switch.busy_panes') throw new Error('offline')
      return { payload: { recorded: true } }
    })
    expect((await h.agentAccountSwitch(args(), 'pa')).status).toBe('queued')
    expect(h.setDefault).toHaveBeenCalledTimes(1)
  })

  // Every window restarts its own panes from the forced broadcast. An
  // unattended one restarts idle panes now and a working one after its turn,
  // so a pane that started working after the check is not interrupted either.
  it('an unattended restart broadcast never stops a working pane', async () => {
    const h = harness()
    h.status.w1 = 'running'
    await h.restartAgentPanes('codex', { unattended: true })
    expect(h.scope.rebuildPaneViaResume).not.toHaveBeenCalled()
    expect(h.queue.has('restart:w1')).toBe(true)
    h.status.w1 = 'idle'
    await h.queue.tick()
    expect(h.scope.rebuildPaneViaResume).toHaveBeenCalledWith('w1', { suppressBusyToast: true })
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('the user\'s own forced restart is unchanged', async () => {
    const h = harness()
    h.status.w1 = 'running'
    await h.restartAgentPanes('codex')
    expect(h.scope.rebuildPaneViaResume).toHaveBeenCalledWith('w1', { suppressBusyToast: true, forceWhenRunning: true })
  })
})
