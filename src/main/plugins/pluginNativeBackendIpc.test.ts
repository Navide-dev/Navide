import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeBackendStore } from './pluginNativeBackendStore'
import type { IpcMainInvokeEvent } from 'electron'
import { registerNativeBackendIpc, type NativeBackendAgentToolsControls } from './pluginNativeBackendIpc'
import type { ThirdPartyBackendController, ThirdPartyLaunchSpec } from './pluginThirdPartyBackends'

type Listener = (event: IpcMainInvokeEvent, args: unknown) => unknown

function setup(options: { agentTools?: boolean; authorized?: boolean; isEnabled?: () => boolean } = {}) {
  const handlers = new Map<string, Listener>()
  const controller = {
    status: vi.fn(async (spec: ThirdPartyLaunchSpec) => ({ pluginId: spec.pluginId, status: 'ready' })),
    statuses: vi.fn(async (specs: readonly ThirdPartyLaunchSpec[]) =>
      specs.map((spec) => ({ pluginId: spec.pluginId, status: 'ready' }))),
    setEnabled: vi.fn(async () => undefined),
    allow: vi.fn(async () => undefined),
    setDisabled: vi.fn(async () => undefined),
    setWorkspaceWrite: vi.fn(async () => undefined),
    takeDefaultOnNotice: vi.fn(() => true),
  }
  const switches = { enabled: false, externalCallers: false }
  const controls: NativeBackendAgentToolsControls = {
    switches: () => ({ ...switches }),
    setSwitches: vi.fn(async (change) => Object.assign(switches, change)),
    refresh: vi.fn(async () => undefined),
  }
  registerNativeBackendIpc(
    (channel, listener) => handlers.set(channel, listener),
    () => options.authorized ?? true,
    controller as unknown as ThirdPartyBackendController,
    () => [{ pluginId: 'acme.indexer' } as ThirdPartyLaunchSpec],
    options.isEnabled ?? (() => true),
    options.agentTools === false ? undefined : controls,
  )
  const invoke = (channel: string, args?: unknown) =>
    Promise.resolve(handlers.get(channel)!({} as IpcMainInvokeEvent, args))
  return { invoke, controls, controller, handlers }
}

describe('native backend IPC: agent-tool switches (plan B1-b)', () => {
  it('keeps the overview as on main when the agent-tool controls are not wired', async () => {
    const { invoke, handlers } = setup({ agentTools: false })
    await expect(invoke('plugins:nativeBackends:list')).resolves.toEqual({
      enabled: true, plugins: [{ pluginId: 'acme.indexer', status: 'ready' }],
    })
    await expect(invoke('plugins:nativeBackends:setAgentTools', { enabled: true })).rejects.toThrow('unavailable')
    expect(handlers.has('plugins:nativeBackends:setAgentTools')).toBe(true)
  })

  it('reports both switches, off by default, and changes one at a time', async () => {
    const { invoke, controls } = setup()
    await expect(invoke('plugins:nativeBackends:list')).resolves.toMatchObject({
      agentTools: { enabled: false, externalCallers: false },
    })
    await expect(invoke('plugins:nativeBackends:setAgentTools', { enabled: true })).resolves.toMatchObject({
      agentTools: { enabled: true, externalCallers: false },
    })
    expect(controls.setSwitches).toHaveBeenCalledWith({ enabled: true })
    await expect(invoke('plugins:nativeBackends:setAgentTools', { externalCallers: true })).resolves.toMatchObject({
      agentTools: { enabled: true, externalCallers: true },
    })
  })

  it('refuses malformed changes and untrusted senders', async () => {
    const { invoke, controls } = setup()
    await expect(invoke('plugins:nativeBackends:setAgentTools', { enabled: 'yes' })).rejects.toThrow('invalid')
    await expect(invoke('plugins:nativeBackends:setAgentTools', { enabled: true, externalCallers: true })).rejects.toThrow('invalid')
    await expect(invoke('plugins:nativeBackends:setAgentTools', {})).rejects.toThrow('invalid')
    expect(controls.setSwitches).not.toHaveBeenCalled()
    const untrusted = setup({ authorized: false })
    await expect(untrusted.invoke('plugins:nativeBackends:setAgentTools', { enabled: true })).rejects.toThrow('unauthorized')
  })

  it('refreshes the agent-tool catalog after consent, disable and the native backend switch', async () => {
    const { invoke, controls, controller } = setup()
    await invoke('plugins:nativeBackends:allow', { id: 'acme.indexer' })
    await invoke('plugins:nativeBackends:setDisabled', { id: 'acme.indexer', disabled: true })
    await invoke('plugins:nativeBackends:setEnabled', { enabled: false })
    expect(controls.refresh).toHaveBeenCalledTimes(3)
    // A failed save still refreshes: off must reach the catalog.
    controller.setEnabled.mockRejectedValueOnce(new Error('disk full'))
    await expect(invoke('plugins:nativeBackends:setEnabled', { enabled: false })).rejects.toThrow('disk full')
    expect(controls.refresh).toHaveBeenCalledTimes(4)
  })
})

// Plan B watchdog option C (contract 5.2): the main window lists the notices
// and answers them; only the trusted Host window may.
describe('resource notice IPC', () => {
  const notice = { id: 'n-1', pluginId: 'acme.indexer', name: 'Indexer', packageVersion: '1.0.0', item: 'memory', usage: 1, threshold: 1, at: 1 }

  function withNotices(authorized = true) {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, args?: unknown) => unknown>()
    const controller = {
      resourceNotices: vi.fn(() => [notice]),
      resourceStatus: vi.fn(() => [{ pluginId: 'acme.indexer', waiting: [] }]),
      answerResourceNotice: vi.fn(async () => true),
    }
    registerNativeBackendIpc(
      (channel, listener) => handlers.set(channel, listener),
      () => authorized,
      controller as unknown as ThirdPartyBackendController,
      () => [],
      () => true,
    )
    const invoke = (channel: string, args?: unknown) => Promise.resolve(handlers.get(channel)!({} as IpcMainInvokeEvent, args))
    return { invoke, controller }
  }

  it('lists the unanswered notices and passes a Stop or Keep running answer on', async () => {
    const { invoke, controller } = withNotices()
    await expect(invoke('plugins:nativeBackends:resourceNotices')).resolves.toEqual([notice])
    await expect(invoke('plugins:nativeBackends:resourceStatus')).resolves.toEqual([{ pluginId: 'acme.indexer', waiting: [] }])
    await expect(invoke('plugins:nativeBackends:answerResourceNotice', { id: 'n-1', choice: 'continue' })).resolves.toBe(true)
    expect(controller.answerResourceNotice).toHaveBeenCalledWith('n-1', 'continue')
    await expect(invoke('plugins:nativeBackends:answerResourceNotice', { id: 'n-1', choice: 'later' })).rejects.toThrow(/invalid/)
    await expect(invoke('plugins:nativeBackends:answerResourceNotice', { id: 7, choice: 'terminate' })).rejects.toThrow(/invalid/)
  })

  it('refuses an unauthorized sender', async () => {
    const { invoke, controller } = withNotices(false)
    await expect(invoke('plugins:nativeBackends:resourceNotices')).rejects.toThrow(/unauthorized/)
    await expect(invoke('plugins:nativeBackends:resourceStatus')).rejects.toThrow(/unauthorized/)
    await expect(invoke('plugins:nativeBackends:answerResourceNotice', { id: 'n-1', choice: 'terminate' })).rejects.toThrow(/unauthorized/)
    expect(controller.answerResourceNotice).not.toHaveBeenCalled()
  })
})


describe('native backend IPC: the default-on notice (0.2.31)', () => {
  it('reports the switch on for a fresh profile and off once the user turns it off (the Developer page and its On badge)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-backend-ipc-'))
    try {
      const store = new NativeBackendStore(join(dir, 'store'))
      const { invoke } = setup({ isEnabled: () => store.isEnabled() })
      await expect(invoke('plugins:nativeBackends:list')).resolves.toMatchObject({ enabled: true })
      store.setEnabled(false)
      await expect(invoke('plugins:nativeBackends:list')).resolves.toMatchObject({ enabled: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes the one-time answer through, for the trusted Host window only', async () => {
    const { invoke, controller } = setup()
    await expect(invoke('plugins:nativeBackends:takeDefaultOnNotice')).resolves.toBe(true)
    expect(controller.takeDefaultOnNotice).toHaveBeenCalledTimes(1)
    const denied = setup({ authorized: false })
    await expect(denied.invoke('plugins:nativeBackends:takeDefaultOnNotice')).rejects.toThrow('unauthorized')
    expect(denied.controller.takeDefaultOnNotice).not.toHaveBeenCalled()
  })
})
