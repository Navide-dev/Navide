import type {
  PluginAgentActionAnswer,
  PluginAgentActionKind,
  PluginApprovalRequest,
} from '../../shared/pluginAgentTools'
import type { DisclosureDiff } from '../../shared/pluginDisclosure'
import type { PluginSource } from '../../shared/pluginSource'
import type { DisableSource } from './pluginDisableSource'
import { compareSemver, isValidManifestV2PluginId } from './pluginManifestV2'

/** Who asked, as the backend resolved it from the MCP credential. */
export type PluginAgentRequester = PluginApprovalRequest['requester']

/** What the user is told after an agent disabled, enabled or updated a package. */
export interface PluginAgentActionNotice {
  action: PluginAgentActionKind
  pluginId: string
  pluginVersion: string
  /** `update` only: the version it was updated from, which the downgrade restores. */
  fromVersion?: string
  requester: PluginAgentRequester
}

/** O1: what the Host knows about an update it prepared for an agent, before
 *  anything is written. */
export interface PluginAgentUpdateCheck {
  installedSource: PluginSource | undefined
  installedHasViews: boolean | undefined
  /** A version is already staged for the next restart. */
  candidatePending: boolean
  prepared: {
    source?: PluginSource
    hasViews?: boolean
    requiresPublisherTrust?: boolean
    replacesLocal?: unknown
    disclosureDiff?: DisclosureDiff | null
  }
}

/** O1 (user 2026-10-20 01:40): why an agent's update needs the user's
 *  approval, or null when the new version discloses exactly what the
 *  installed one does: no permission, backend, agent tool or network item
 *  added or removed, the same risk level, the same source and publisher
 *  trust, the same views. Anything it cannot compare needs approval. */
export function agentUpdateNeedsApproval(check: PluginAgentUpdateCheck): string | null {
  const { prepared } = check
  const diff = prepared.disclosureDiff
  if (!diff) return 'the disclosures could not be compared'
  if (diff.added.length > 0 || diff.removed.length > 0 || diff.to.risk !== diff.from.risk || diff.widened) {
    return 'the new version discloses something different'
  }
  if (!check.installedSource || prepared.source !== check.installedSource) return 'the source changes'
  if (check.installedHasViews === undefined || prepared.hasViews !== check.installedHasViews) {
    return 'the views change, or could not be compared'
  }
  if (prepared.requiresPublisherTrust !== false) return 'the publisher is not trusted yet'
  if (prepared.replacesLocal !== undefined) return 'it would replace a local file install'
  if (check.candidatePending) return 'another version is already waiting for a restart'
  return null
}

export interface PluginAgentActionDeps {
  /** The bundled Navide plugins (Plans, Git, Mini-IDE) and the reserved namespace. */
  isBuiltin(pluginId: string): boolean
  /** Installed version of a Marketplace (official-registry) package, else null. */
  installedVersion(pluginId: string): string | null
  /** The Extensions Disabled switch for an installed Marketplace package;
   *  `changed` is false when the package was already in that state. `source`
   *  is recorded with a disable that changed something. */
  setDisabled(pluginId: string, disabled: boolean, source?: DisableSource): Promise<{ changed: boolean }>
  notify(notice: PluginAgentActionNotice): void
  /** Whether the package is disabled now, and who disabled it (B2-c option B). */
  isDisabled(pluginId: string): boolean
  disableSource(pluginId: string): DisableSource
  now(): number
  /** O1: verify and hold a Registry version for an agent's update; nothing
   *  is written. Throws while the user is installing the same id. */
  prepareUpdate?(pluginId: string, version: string): Promise<PluginAgentUpdateCheck>
  /** O1: commit the held version through the window's own commit. */
  /** Stage the update and (user decision A, 2026-10-21) switch to it at
   *  once; `requester` is the agent the switch record names. */
  commitUpdate?(pluginId: string, requester?: PluginAgentRequester): Promise<void | { switched?: true; switchError?: string }>
  /** O1: drop the held version. */
  discardUpdate?(pluginId: string): void
}

const REQUESTER_KEYS = ['paneId', 'paneName', 'workspace', 'callerKind']

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseRequester(value: unknown): PluginAgentRequester | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  // S8-M1: `tainted` is optional and only ever true (a pane that read third-party content).
  const keys = Object.keys(record).filter((key) => key !== 'tainted')
  if (keys.length !== REQUESTER_KEYS.length || !REQUESTER_KEYS.every((key) => keys.includes(key))) return null
  const { paneId, paneName, workspace, callerKind, tainted } = record
  if (callerKind !== 'pane' && callerKind !== 'external' && callerKind !== 'host') return null
  if (!nullableString(paneId) || !nullableString(paneName) || !nullableString(workspace)) return null
  if ('tainted' in record && tainted !== true) return null
  return tainted === true ? { paneId, paneName, workspace, callerKind, tainted } : { paneId, paneName, workspace, callerKind }
}

/** `plugins.agent_action.request` (contract 4.3.1): exact keys, or null.
 *  An `update` (O1) carries one more key, `version`. */
export function parsePluginAgentActionRequest(
  value: unknown,
): { action: PluginAgentActionKind; pluginId: string; requester: PluginAgentRequester; version?: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const expected = ['request_id', 'action', 'plugin_id', 'requester', ...(record.action === 'update' ? ['version'] : [])]
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    return null
  }
  const { action, plugin_id: pluginId, version } = record
  if (action !== 'disable' && action !== 'enable' && action !== 'update') return null
  if (typeof pluginId !== 'string' || !isValidManifestV2PluginId(pluginId)) return null
  if (action === 'update' && (typeof version !== 'string' || compareSemver(version, version) === null)) return null
  const requester = parseRequester(record.requester)
  if (!requester) return null
  return action === 'update' ? { action, pluginId, requester, version: version as string } : { action, pluginId, requester }
}

/** O1: an agent's update, carried out only when nothing it discloses changes;
 *  any other answer sends the agent back to the user's approval. */
async function answerAgentUpdate(
  pluginId: string,
  version: string,
  from: string,
  requester: PluginAgentRequester,
  deps: PluginAgentActionDeps,
): Promise<PluginAgentActionAnswer> {
  const approval = (error: string): PluginAgentActionAnswer =>
    ({ ok: false, error, error_code: 'APPROVAL_REQUIRED', pluginId, pluginVersion: from })
  const order = compareSemver(version, from)
  if (order === null || order <= 0) return approval(`${version} is not newer than the installed ${from}`)
  if (!deps.prepareUpdate || !deps.commitUpdate || !deps.discardUpdate) return approval('Navide cannot compare updates now')
  let check: PluginAgentUpdateCheck
  try {
    check = await deps.prepareUpdate(pluginId, version)
  } catch {
    return approval('Navide could not compare this update')
  }
  const reason = agentUpdateNeedsApproval(check)
  if (reason !== null) {
    deps.discardUpdate(pluginId)
    return approval(reason)
  }
  let committed: void | { switched?: true; switchError?: string }
  try {
    committed = await deps.commitUpdate(pluginId, requester)
  } catch (error) {
    deps.discardUpdate(pluginId)
    return { ok: false, error: error instanceof Error ? error.message : String(error), error_code: 'ACTION_FAILED' }
  }
  // Review M2: staged, but the switch failed and `from` runs again. Said as it
  // is; the main window shows only its "switch failed" row (with Apply now),
  // never an "updated" one.
  if (committed && committed.switchError !== undefined) {
    return { ok: true, updated: true, switched: false, switchError: committed.switchError, pluginId, fromVersion: from, pluginVersion: version }
  }
  // Review r2: a switched update is recorded by the switch row itself (it names
  // the agent and offers Back), so the window shows one row, not two.
  if (!committed || committed.switched !== true) {
    deps.notify({ action: 'update', pluginId, pluginVersion: version, fromVersion: from, requester })
  }
  return { ok: true, updated: true, pluginId, fromVersion: from, pluginVersion: version }
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
  if (action === 'update') return answerAgentUpdate(pluginId, request.version ?? '', version, requester, deps)
  const disabled = action === 'disable'
  // Option B: an agent re-enables only what an agent disabled. A package the
  // user disabled (or with no recorded source) needs the user's approval.
  if (!disabled && deps.isDisabled(pluginId)) {
    const source = deps.disableSource(pluginId)
    if (source.by !== 'agent') {
      return {
        ok: false,
        error: `the user disabled ${pluginId}; enabling it needs the user's approval in Navide`,
        error_code: 'APPROVAL_REQUIRED',
        pluginId,
        pluginVersion: version,
        disabled: source,
      }
    }
  }
  const agentSource: DisableSource = {
    by: 'agent',
    at: deps.now(),
    agent: { callerKind: requester.callerKind, paneId: requester.paneId, paneName: requester.paneName },
  }
  let changed: boolean
  try {
    ({ changed } = await deps.setDisabled(pluginId, disabled, disabled ? agentSource : undefined))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), error_code: 'ACTION_FAILED' }
  }
  // Nothing changed (already in that state): no notice, so no undo that
  // would flip the user's own choice.
  if (changed) deps.notify({ action, pluginId, pluginVersion: version, requester })
  return { ok: true, pluginId, pluginVersion: version, disabled, changed }
}
