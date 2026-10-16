import type { IpcMainInvokeEvent } from 'electron'
import { resolve } from 'node:path'
import { isValidManifestV2PluginId } from './pluginManifestV2'
import type {
  NativeBackendStatusRow,
  ThirdPartyBackendController,
  ThirdPartyLaunchSpec,
} from './pluginThirdPartyBackends'

export interface NativeBackendOverview {
  /** Global "allow third-party native backends" switch (off by default). */
  enabled: boolean
  plugins: NativeBackendStatusRow[]
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
  })

  handle('plugins:nativeBackends:list', async (event) => {
    assertAuthorized(event)
    return overview()
  })
  handle('plugins:nativeBackends:setEnabled', async (event, args) => {
    assertAuthorized(event)
    const { enabled } = record(args)
    if (typeof enabled !== 'boolean') throw new Error('invalid native backend setting')
    await controller.setEnabled(enabled)
    return overview()
  })
  handle('plugins:nativeBackends:allow', async (event, args) => {
    assertAuthorized(event)
    await controller.allow(specFor(record(args).id))
    return overview()
  })
  handle('plugins:nativeBackends:setDisabled', async (event, args) => {
    assertAuthorized(event)
    const { id, disabled } = record(args)
    if (typeof disabled !== 'boolean') throw new Error('invalid native backend setting')
    await controller.setDisabled(specFor(id).pluginId, disabled)
    return overview()
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
