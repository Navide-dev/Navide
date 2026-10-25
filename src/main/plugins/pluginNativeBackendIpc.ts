import type { IpcMainInvokeEvent } from 'electron'
import { resolve } from 'node:path'
import { isValidManifestV2PluginId } from './pluginManifestV2'
import type { AgentToolSwitches } from './pluginNativeBackendStore'
import type {
  NativeBackendStatusRow,
  ThirdPartyBackendController,
  ThirdPartyLaunchSpec,
} from './pluginThirdPartyBackends'

export interface NativeBackendOverview {
  /** Global "allow third-party native backends" switch (off by default). */
  enabled: boolean
  plugins: NativeBackendStatusRow[]
  /** Plan B switches: agents may call third-party agent tools (DB8), and so
   * may external MCP clients (DB4). Both off by default. Absent when unwired. */
  agentTools?: AgentToolSwitches
}

/** The agent-tool switches and the catalog refresh behind them. */
export interface NativeBackendAgentToolsControls {
  switches: () => AgentToolSwitches
  setSwitches: (change: Partial<AgentToolSwitches>) => Promise<unknown>
  /** A consent, disable or global-switch decision changed. */
  refresh: () => Promise<unknown>
}

type Handle = (
  channel: string,
  listener: (event: IpcMainInvokeEvent, args: unknown) => unknown,
) => void

function record(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
}

/**
 * `plugins:nativeBackends:*` - the Extensions page controls for third-party
 * native backends. Only the trusted Host window may call them; every change
 * goes through the controller, which also stops running children when a
 * switch is turned off.
 */
export function registerNativeBackendIpc(
  handle: Handle,
  authorize: (event: IpcMainInvokeEvent) => boolean,
  controller: ThirdPartyBackendController,
  listSpecs: () => ThirdPartyLaunchSpec[],
  isEnabled: () => boolean,
  agentTools?: NativeBackendAgentToolsControls,
): void {
  const assertAuthorized = (event: IpcMainInvokeEvent): void => {
    if (!authorize(event)) throw new Error('unauthorized plugin management sender')
  }
  const specFor = (pluginId: unknown): ThirdPartyLaunchSpec => {
    if (!isValidManifestV2PluginId(pluginId)) throw new Error('invalid plugin id')
    const spec = listSpecs().find((candidate) => candidate.pluginId === pluginId)
    if (!spec) throw new Error(`no third-party native backend is installed for ${pluginId}`)
    return spec
  }
  const overview = async (): Promise<NativeBackendOverview> => ({
    enabled: isEnabled(),
    plugins: await controller.statuses(listSpecs()),
    ...(agentTools ? { agentTools: agentTools.switches() } : {}),
  })
  const changed = async (): Promise<void> => {
    await agentTools?.refresh().catch(() => undefined)
  }

  handle('plugins:nativeBackends:list', async (event) => {
    assertAuthorized(event)
    return overview()
  })
  handle('plugins:nativeBackends:setEnabled', async (event, args) => {
    assertAuthorized(event)
    const { enabled } = record(args)
    if (typeof enabled !== 'boolean') throw new Error('invalid native backend setting')
    try {
      await controller.setEnabled(enabled)
    } finally {
      await changed()
    }
    return overview()
  })
  handle('plugins:nativeBackends:takeDefaultOnNotice', async (event) => {
    assertAuthorized(event)
    return controller.takeDefaultOnNotice()
  })
  handle('plugins:nativeBackends:allow', async (event, args) => {
    assertAuthorized(event)
    await controller.allow(specFor(record(args).id))
    await changed()
    return overview()
  })
  handle('plugins:nativeBackends:setDisabled', async (event, args) => {
    assertAuthorized(event)
    const { id, disabled } = record(args)
    if (typeof disabled !== 'boolean') throw new Error('invalid native backend setting')
    try {
      await controller.setDisabled(specFor(id).pluginId, disabled)
    } finally {
      await changed()
    }
    return overview()
  })
  handle('plugins:nativeBackends:setAgentTools', async (event, args) => {
    assertAuthorized(event)
    if (!agentTools) throw new Error('agent tools are unavailable')
    const { enabled, externalCallers } = record(args)
    const change: Partial<AgentToolSwitches> = {}
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') throw new Error('invalid agent tool setting')
      change.enabled = enabled
    }
    if (externalCallers !== undefined) {
      if (typeof externalCallers !== 'boolean') throw new Error('invalid agent tool setting')
      change.externalCallers = externalCallers
    }
    if (Object.keys(change).length !== 1) throw new Error('invalid agent tool setting')
    await agentTools.setSwitches(change)
    return overview()
  })
  // Plan B watchdog option C (contract 5.2): the main window reads the
  // unanswered resource notices (on load and when told they changed) and
  // passes the user's Stop or Keep running on.
  handle('plugins:nativeBackends:resourceNotices', async (event) => {
    assertAuthorized(event)
    return controller.resourceNotices()
  })
  handle('plugins:nativeBackends:resourceStatus', async (event) => {
    assertAuthorized(event)
    return controller.resourceStatus()
  })
  handle('plugins:nativeBackends:answerResourceNotice', async (event, args) => {
    assertAuthorized(event)
    const { id, choice } = record(args)
    if (typeof id !== 'string' || id.length === 0 || (choice !== 'terminate' && choice !== 'continue')) {
      throw new Error('invalid resource notice answer')
    }
    return controller.answerResourceNotice(id, choice)
  })
  handle('plugins:nativeBackends:revokeWorkspaceWrite', async (event, args) => {
    assertAuthorized(event)
    const { id, workspacePath } = record(args)
    if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
      throw new Error('invalid workspace path')
    }
    await controller.setWorkspaceWrite(specFor(id).pluginId, resolve(workspacePath), false)
    return overview()
  })
}
