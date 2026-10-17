import type {
  PluginAgentActionAnswer,
  PluginAgentActionKind,
  PluginApprovalRequest,
} from '../../shared/pluginAgentTools'
import { isValidManifestV2PluginId } from './pluginManifestV2'

/** Who asked, as the backend resolved it from the MCP credential. */
export type PluginAgentRequester = PluginApprovalRequest['requester']

/** What the user is told after an agent disabled or enabled a package. */
export interface PluginAgentActionNotice {
  action: PluginAgentActionKind
  pluginId: string
  pluginVersion: string
  requester: PluginAgentRequester
}

export interface PluginAgentActionDeps {
  /** The bundled Navide plugins (Plans, Git, Mini-IDE) and the reserved namespace. */
  isBuiltin(pluginId: string): boolean
  /** Installed version of a Marketplace (official-registry) package, else null. */
  installedVersion(pluginId: string): string | null
  /** The Extensions Disabled switch for an installed Marketplace package;
   *  `changed` is false when the package was already in that state. */
  setDisabled(pluginId: string, disabled: boolean): Promise<{ changed: boolean }>
  notify(notice: PluginAgentActionNotice): void
}

const REQUESTER_KEYS = ['paneId', 'paneName', 'workspace', 'callerKind']

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseRequester(value: unknown): PluginAgentRequester | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== REQUESTER_KEYS.length || !REQUESTER_KEYS.every((key) => keys.includes(key))) return null
  const { paneId, paneName, workspace, callerKind } = record
  if (callerKind !== 'pane' && callerKind !== 'external' && callerKind !== 'host') return null
  if (!nullableString(paneId) || !nullableString(paneName) || !nullableString(workspace)) return null
  return { paneId, paneName, workspace, callerKind }
}

/** `plugins.agent_action.request` (contract 4.3.1): exact keys, or null. */
export function parsePluginAgentActionRequest(
  value: unknown,
): { action: PluginAgentActionKind; pluginId: string; requester: PluginAgentRequester } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 4 || !['request_id', 'action', 'plugin_id', 'requester'].every((key) => keys.includes(key))) {
    return null
  }
  const { action, plugin_id: pluginId } = record
  if (action !== 'disable' && action !== 'enable') return null
  if (typeof pluginId !== 'string' || !isValidManifestV2PluginId(pluginId)) return null
  const requester = parseRequester(record.requester)
  return requester ? { action, pluginId, requester } : null
}

/**
 * Carry out an agent's plugins_disable / plugins_enable (plan B, B2-c, DB6):
 * only for an installed Marketplace package, never a bundled Navide plugin,
 * through the same switch the user's Extensions page uses, then tell the user
 * who did it. Enabling keeps the consent the user already gave.
 */
export async function answerPluginAgentAction(
  value: unknown,
  deps: PluginAgentActionDeps,
): Promise<PluginAgentActionAnswer> {
  const request = parsePluginAgentActionRequest(value)
  if (!request) return { ok: false, error: 'plugin agent action is malformed', error_code: 'BAD_REQUEST' }
  const { action, pluginId, requester } = request
  if (deps.isBuiltin(pluginId)) {
    return {
      ok: false,
      error: 'the bundled Navide plugins are disabled and enabled by the user in Extensions',
      error_code: 'BUILTIN_PLUGIN',
    }
  }
  const version = deps.installedVersion(pluginId)
  if (version === null) {
    return { ok: false, error: `${pluginId} is not an installed Marketplace package`, error_code: 'NOT_INSTALLED' }
  }
  const disabled = action === 'disable'
  let changed: boolean
  try {
    ({ changed } = await deps.setDisabled(pluginId, disabled))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), error_code: 'ACTION_FAILED' }
  }
  // Nothing changed (already in that state): no notice, so no undo that
  // would flip the user's own choice.
  if (changed) deps.notify({ action, pluginId, pluginVersion: version, requester })
  return { ok: true, pluginId, pluginVersion: version, disabled, changed }
}
