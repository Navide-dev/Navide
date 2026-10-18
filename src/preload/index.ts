import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentToolsResultHelperState } from '../shared/pluginAgentTools'
import { normalizePlatformId } from '../shared/osplat'
import type {
  UpdateActionResult,
  UpdateSettingsResult,
  UpdaterSettings,
  UpdateState,
} from '../shared/updater'
import type {
  ExecutionPolicyApi,
  ManifestPermissionsSummary,
  PackageVersionGrantSummary,
} from '../shared/executionPolicy'
import type { LegacyPlansPreferenceProjection } from '../shared/plansPreferences'
import type {
  DisclosureDiff as PluginDisclosureDiff,
  ManifestDisclosure as PluginManifestDisclosure,
  RegistryDisclosureFacts as PluginRegistryDisclosureFacts,
} from '../shared/pluginDisclosure'
import type { ScanReport as PluginScanReport } from '../shared/pluginDisclosureScan'
import type { PluginActivityReport } from '../shared/pluginActivity'
import { LEGAL_LINKS, type LegalRoute } from '../shared/legalLinks'
import type { NewWorkspaceResult } from '../shared/workspaceCreate'
import { FN_KEY_EVENT_CHANNEL, FN_KEY_STATUS_CHANNEL, type FnKeyApi } from '../shared/fnKey'
import { DEEP_LINK_OPEN_CHANNEL, DEEP_LINK_READY_CHANNEL, type DeepLinkApi } from '../shared/deepLink'
import type { PluginSource } from '../shared/pluginSource'

/** Which Electron-owned cache groups to clear. Never touches user state. */
export interface ClearElectronCachesOptions {
  chromium: boolean
  updater: boolean
}

export interface ClearElectronCachesResult {
  ok: boolean
  freedBytes: number
  error: string | null
}

export interface BackendInfo {
  status: 'starting' | 'ready' | 'error'
  host?: string
  port?: number
  pid?: number
  shell?: string
  httpUrl?: string
  wsUrl?: string
  error?: string
}

export interface GitAccountPublic {
  id: string
  label: string
  host: string
  username: string
  tokenLast4: string
}

export interface GitAccountInput {
  label: string
  host: string
  username: string
  token: string
}

export interface GitCredential {
  username: string
  token: string
  expectedHost: string
}

/** Main-owned recovery transition. The renderer can only move into recovery;
 * there is deliberately no public event or API for switching back. */
export interface GitRecoveryChanged {
  legacy: boolean
}

function isGitRecoveryChanged(payload: unknown): payload is GitRecoveryChanged {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'legacy' in payload &&
    typeof payload.legacy === 'boolean'
  )
}

export interface PlansRecoveryChanged {
  legacy: boolean
  /** Host-side reason for the downgrade. Absent when leaving recovery. */
  reason?: string
}

export interface PlansBackendStopped {
  workspacePath: string
}

function isPlansBackendStopped(payload: unknown): payload is PlansBackendStopped {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'workspacePath' in payload &&
    typeof payload.workspacePath === 'string'
  )
}

/** An agent disabled or enabled a Navide plugin (B2-c), as the Host reports it. */
export interface PluginAgentActionNotice {
  action: 'disable' | 'enable'
  pluginId: string
  pluginVersion: string
  requester: { paneId: string | null; paneName: string | null; workspace: string | null; callerKind: 'pane' | 'external' | 'host' }
}

function isPluginAgentActionNotice(payload: unknown): payload is PluginAgentActionNotice {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  const requester = record.requester as Record<string, unknown> | null
  const nullableString = (value: unknown): boolean => value === null || typeof value === 'string'
  return (
    (record.action === 'disable' || record.action === 'enable') &&
    typeof record.pluginId === 'string' &&
    typeof record.pluginVersion === 'string' &&
    typeof requester === 'object' && requester !== null &&
    ['pane', 'external', 'host'].includes(String(requester.callerKind)) &&
    nullableString(requester.paneId) && nullableString(requester.paneName) && nullableString(requester.workspace)
  )
}

function isPlansRecoveryChanged(payload: unknown): payload is PlansRecoveryChanged {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'legacy' in payload &&
    typeof payload.legacy === 'boolean' &&
    (!('reason' in payload) || typeof payload.reason === 'string')
  )
}

export interface GitContributionState {
  workspacePath: string
  analyzerModel: string
  dispatchTargets: { id: string; label: string }[]
  availableAgents: { key: string; label: string }[]
  issueHandoffs: Record<string, { paneId: string; mode: string; state: string }>
}

export interface GitContributionActionEnvelope {
  operation: string
  payload?: Record<string, unknown>
}

export type PermissionKey = 'automation' | 'notifications' | 'folders' | 'fullDisk'
export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-applicable'

export interface InstalledPluginSummary {
  id: string
  requires: string[]
  sensitive: string[]
  packageVersion?: string
  manifestPermissions?: ManifestPermissionsSummary
  packageVersionGrant?: PackageVersionGrantSummary | null
  provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
  /** Source and review state; see `shared/pluginSource.ts`. */
  source?: PluginSource
  warning?: string
  pendingCandidateVersion?: string
  rollbackKind?: 'factory' | 'previous'
  rollbackToVersion?: string
  /** Lowest Navide release the installed version needs (label only). */
  minNavideVersion?: string
  /** False when this Navide release is older; the Host still runs it. */
  engineCompatible?: boolean
  /** Per-extension "Get pre-releases" switch (Registry installs only). */
  getsPrereleases?: boolean
}

export interface FactoryPluginSummary {
  id: string
  version: string | null
  active: boolean
  optedOut: boolean
}

interface BackendUsageCount {
  current: number
  peak: number
}

interface BackendQueueUsage {
  frames: number
  bytes: number
  peakFrames: number
  peakBytes: number
}

/** Backend resources the Host holds now and at the most (none capped): children, per-view subscriptions and child usage, per-plugin calls. */
export interface BackendResourceUsage {
  /** The core backend's agent tool result helper process. */
  backend?: { resultHelper: AgentToolsResultHelperState }
  children: BackendUsageCount & { retained: number }
  views: Array<{
    pluginId: string
    instanceId: string
    subscriptions: BackendUsageCount
    child: {
      subscriptions: BackendUsageCount
      bridgeRequests: BackendUsageCount
      outputQueue: { requests: BackendQueueUsage; notifications: BackendQueueUsage }
      droppedNotifications: number
      droppedResultPieces: number
      stdoutPending: { bytes: number; peakBytes: number }
    } | null
  }>
  plugins: BackendCallConcurrency[]
}

/** In-flight backend calls of one plugin: now, and the most at once since the Host started;
 *  plus the Host event notifications its children dropped because their event backlog was full. */
export interface BackendCallConcurrency {
  pluginId: string
  current: number
  peak: number
  droppedNotifications: number
}

export interface MarketplaceExtension {
  namespace: string
  name: string
  identity: string
  display_name: string | null
  description: string | null
  categories: string[]
  latest_version: string | null
  /** Targets the latest version is published for (multi-target Registries). */
  latest_targets?: string[]
  /** Main-process verdict: the latest version has an artifact for this Host. */
  installable?: boolean
  download_count: number
  rating_average: number
  featured: boolean
  /** Main-process verdict: the latest version's `engines.navide` against
   *  this Navide release; null when unknown (never blocks). */
  compatible?: boolean | null
  /** Lowest Navide release the latest version accepts. */
  min_navide_version?: string | null
  /** The running Navide release the verdict was computed against. */
  app_version?: string
  license?: string | null
  /** https links only (the main process drops anything else). */
  repository?: string | null
  homepage?: string | null
  /** Package-relative raster icon of the latest version. */
  icon_path?: string | null
  /** Member ids when this is an Extension Pack. */
  extension_pack?: string[] | null
  /** Trust tier of the latest version ('signed-verified' or 'unsigned'). */
  trust_tier?: string | null
  /** Plan B D1 list card: the latest version's manifest disclosure and scan
   *  report as the Registry listed them, kept by the main process only when
   *  well formed and naming this item; unverified display data. */
  disclosure?: PluginManifestDisclosure | null
  scan?: PluginScanReport | null
  /** D-f: the highest risk level across the latest version's platforms. */
  listRisk?: { level: 'low' | 'medium' | 'high' | 'highest'; variesByPlatform: boolean } | null
}

export interface PackMemberSummary {
  id: string
  status: 'ready' | 'installed' | 'missing' | 'nested' | 'unavailable' | 'incompatible' | 'error'
  display_name: string | null
  version: string | null
  capabilities: string[]
  sensitive_capabilities: string[]
  min_navide_version: string | null
}

export interface PreparedPackSummary {
  id: string
  version: string
  display_name: string | null
  trustTier: 'signed-verified' | 'unsigned'
  publisherId: string
  members: PackMemberSummary[]
}

/** Third-party native backend state for the Extensions page. */
export interface NativeBackendStatusRow {
  pluginId: string
  packageVersion: string
  name: string
  status:
    | 'ready'
    | 'disabled-globally'
    | 'disabled'
    | 'needs-consent'
    | 'sandbox-unavailable'
    | 'shell-not-allowed'
    | 'stopped-after-crashes'
    | 'unavailable'
  reason?: string
  /** Declared agent tools; absent when none. `collidesWith`: the plugin id
   *  that holds the same name, so this tool stays offline. */
  agentTools?: Array<{
    name: string
    title: string
    description: string
    risk: 'read' | 'write'
    timeoutMs: number
    method: string
    inputSchema: Record<string, unknown>
    collidesWith?: string
    sharedWith?: string[]
  }>
  changedSinceConsent: boolean
  canWriteWorkspace: boolean
  workspaceWrite: string[]
  lastViolation?: 'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending'
  shell?: 'allowlist' | 'full'
}

export interface NativeBackendOverview {
  enabled: boolean
  plugins: NativeBackendStatusRow[]
  agentTools?: { enabled: boolean; externalCallers: boolean }
}

export interface InstalledPackRecord {
  id: string
  displayName?: string
  version: string
  members: string[]
  /** Members installed only because of this pack (still installed, and not
   *  listed by any other installed pack). */
  installedByPack: string[]
}

export interface MarketplaceSearchOptions {
  category?: string
  offset?: number
  limit?: number
  /** Ask the Registry for known-compatible extensions only (D1 filter). */
  hideIncompatible?: boolean
}

export interface MarketplaceCategory {
  slug: string
  label: string
  count: number
}

export interface MarketplaceVersionInfo {
  version: string
  published_at: string
  target: string
  yanked: boolean
  trust_tier: string
  capabilities: string[]
  sensitive_capabilities: string[]
  download_count: number
  /** Main-process verdict: this row's target can be installed on this Host. */
  installable: boolean
  /** This row's `engines.navide` against this Navide release (null: unknown). */
  compatible?: boolean | null
  min_navide_version?: string | null
  channel?: 'stable' | 'pre-release'
  /** Contract 3.4/3.8, as the Registry sent them: display data that nothing
   *  has verified yet (prepareInstall verifies the signed disclosure). */
  disclosure?: PluginManifestDisclosure | null
  scan?: PluginScanReport | null
  registry?: PluginRegistryDisclosureFacts | null
}

export interface MarketplaceExtensionDetail extends MarketplaceExtension {
  updated_at: string | null
  rating_count: number
  publisher: string
  host_target: string
  /** Newest non-yanked version with an artifact for this Host. */
  latest_installable_version: string | null
  /** Newest version this Host can install that this Navide release also runs. */
  latest_compatible_version?: string | null
  /** Newest pre-release newer than `latest_version` (Registry's view). */
  latest_prerelease_version?: string | null
  /** This extension's "Get pre-releases" switch; the installable
   *  versions above already honour it. */
  gets_prereleases?: boolean
  has_changelog?: boolean
  versions: MarketplaceVersionInfo[]
  /** Raw README markdown; rendered as text nodes, never as HTML. */
  readme: string | null
}

export interface BackendResourceNoticeView {
  id: string
  pluginId: string
  name: string
  packageVersion: string
  item: 'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending'
  usage: number
  threshold: number
  at: number
}

type ResourceItemValues = Record<'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending', number>

export interface BackendResourceStatusView {
  pluginId: string
  name: string
  packageVersion: string
  usage: ResourceItemValues
  thresholds: ResourceItemValues
  levels: ResourceItemValues
  waiting: Array<'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending'>
}

export interface PluginRescanNotice {
  id: string
  version: string
  added: Array<{ kind: string; key: string }>
}

export interface PluginUpdateInfo {
  id: string
  namespace: string
  name: string
  installedVersion: string
  latestVersion: string
  /** Plan B D2 badge, from the Registry's unverified listing. */
  permissionChange?: 'more' | 'same'
}

export interface MarketplaceListResponse {
  items: MarketplaceExtension[]
  total: number
  offset: number
  limit: number
}

export interface PreparedInstallSummary {
  id: string
  version: string
  trustTier: 'signed-verified' | 'unsigned'
  sensitive: string[]
  containsBackendExecutable: boolean
  /** Declared agent tools (sorted, timeouts defaulted); absent when none. */
  agentTools?: Array<{
    name: string
    method: string
    risk: 'read' | 'write'
    title: string
    description: string
    timeoutMs: number
    inputSchema: Record<string, unknown>
  }>
  requiresConfirmation: boolean
  publisherId: string
  requiresPublisherTrust: boolean
  requiresRiskConfirmation: boolean
  /** Plan B D2: what this update changes, computed by the Host from the
   *  installed and the downloaded manifests; null for a first install. */
  disclosureDiff?: PluginDisclosureDiff | null
  /** Verified against the package and the Registry signature; null when the
   *  version carries no disclosure. */
  disclosure?: PluginManifestDisclosure | null
  /** Registry-signed scan report (digest verified); null when none. */
  scan?: PluginScanReport | null
  /** Unsigned Registry facts, never verified. */
  registry?: PluginRegistryDisclosureFacts | null
  /** Card K3: the package's source; `local-unsigned` for a file install. */
  source?: PluginSource
  /** Card K3: sha256 of the picked file, shown in the consent dialog. */
  digest?: string
  /** Card K3 (D7): the installed package of the same id a file install replaces. */
  replaces?: { version: string | null; source: 'marketplace' | 'local-unsigned' }
  /** Card K3 (D7): the local file install a Marketplace install replaces. */
  replacesLocal?: { version: string | null }
  /** D7: the replaced package's native backend data will be set aside. */
  backendDataSetAside?: boolean
  /** D7: data set aside earlier from the incoming source, which the user may take back. */
  reattachableBackendData?: string
  /** MED-1 on #425: false when the takedown list could not be checked. */
  takedownChecked?: boolean
}

const pendingEditorOpenFiles: Record<string, string>[] = []
let editorOpenFileCallback: ((params: Record<string, string>) => void) | null = null
ipcRenderer.on('editor:openFile', (_event, params: Record<string, string>) => {
  if (editorOpenFileCallback) editorOpenFileCallback(params)
  else pendingEditorOpenFiles.push(params)
})

contextBridge.exposeInMainWorld('agentTeam', {
  appName: 'Agent-Team',
  version: __APP_VERSION__,
  // The renderer has no `process` under contextIsolation, so the platform it
  // is drawing for has to cross the bridge. `shared/osplat` reads this and is
  // the only thing that should: components ask it for a capability
  // (`needsDrawnWindowControls`) rather than comparing this string.
  platform: normalizePlatformId(process.platform),
  // Minimise / maximise / close, for the platforms where the system does not
  // draw them over our frameless window. Present on every platform because
  // the main-side handlers are; macOS simply never draws buttons that call it.
  windowControls: {
    minimize: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<{ ok: boolean; maximized: boolean }> =>
      ipcRenderer.invoke('window:toggleMaximize'),
    close: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<{ maximized: boolean }> =>
      ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChanged: (cb: (maximized: boolean) => void): (() => void) => {
      const handler = (_event: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on('window:maximize-changed', handler)
      // Returns its own disposer: the bridge has both shapes today, and a
      // component that mounts per window needs to be able to let go.
      return () => ipcRenderer.removeListener('window:maximize-changed', handler)
    },
  },
  getBackendInfo: (): Promise<BackendInfo> => ipcRenderer.invoke('backend:info'),
  /** Answer a ws connection's window challenge; null outside a main window. */
  proveWindow: (nonce: string): Promise<string | null> => ipcRenderer.invoke('backend:proveWindow', nonce),
  restartBackend: (): Promise<BackendInfo> => ipcRenderer.invoke('backend:restart'),
  stopBackend: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('backend:stop'),
  onBackendChanged: (cb: (info: BackendInfo) => void): void => {
    ipcRenderer.on('backend:changed', (_event, info: BackendInfo) => cb(info))
  },
  // Ask the Host to leave legacy Git recovery and re-activate the bundled v2
  // package. Called when the user opens the Git tab, which is the natural
  // retry for a downgrade caused by a transient activation failure.
  retryGitV2: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('git:retryV2'),
  // Ask the Host to re-arm the withdrawn Plans v2 package. Same shape as the
  // Git retry, but re-arming is not proof of recovery here: the backend child
  // is spawned by the next Plans open, so a still-broken package downgrades
  // the session again through the usual path.
  retryPlansV2: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('plans:retryV2'),
  // Ask the Host to discard a Plans lifecycle record it cannot read. Offered as
  // an explicit action in the Plans recovery panel: the Host never clears such
  // a record on its own, because a discarded record reads as a first install
  // and gives up the upgrade source.
  repairPlansStorageRecord: (): Promise<{ ok: boolean; repaired: boolean; reason?: string }> =>
    ipcRenderer.invoke('plans:repairStorageRecord'),
  onGitRecoveryChanged: (cb: (change: GitRecoveryChanged) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (isGitRecoveryChanged(payload)) cb(payload)
    }
    ipcRenderer.on('git:recoveryChanged', listener)
    return () => ipcRenderer.removeListener('git:recoveryChanged', listener)
  },
  onPlansRecoveryChanged: (cb: (change: PlansRecoveryChanged) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (isPlansRecoveryChanged(payload)) cb(payload)
    }
    ipcRenderer.on('plans:recoveryChanged', listener)
    return () => ipcRenderer.removeListener('plans:recoveryChanged', listener)
  },
  // The Host gave up restarting a workspace's agent Plans backend.
  onPlansBackendStopped: (cb: (stopped: PlansBackendStopped) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (isPlansBackendStopped(payload)) cb(payload)
    }
    ipcRenderer.on('plans:backendStopped', listener)
    return () => ipcRenderer.removeListener('plans:backendStopped', listener)
  },
  // An agent disabled or enabled a Navide plugin (B2-c): who, and the undo.
  onPluginAgentAction: (cb: (notice: PluginAgentActionNotice) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (isPluginAgentActionNotice(payload)) cb(payload)
    }
    ipcRenderer.on('plugins:agentAction', listener)
    return () => ipcRenderer.removeListener('plugins:agentAction', listener)
  },
  onMenuAction: (cb: (action: string) => void): void => {
    ipcRenderer.on('menu:action', (_event, action: string) => cb(action))
  },
  // Returns a disposer — subscribed per useBackend scope. Fires when the
  // machine wakes, so the renderer can rebuild a socket that slept through it.
  onSystemResumed: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('system:resumed', listener)
    return () => ipcRenderer.removeListener('system:resumed', listener)
  },
  setRecentWorkspaces: (list: { path: string; name: string; exists: boolean }[]): void =>
    ipcRenderer.send('menu:setRecents', list),
  pickWorkspace: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('workspace:pick', defaultPath),
  newWorkspace: (): Promise<NewWorkspaceResult> => ipcRenderer.invoke('workspace:new'),
  getHomeDir: (): Promise<string> => ipcRenderer.invoke('app:home-dir'),
  dockSurfaceProvided: (surface: string): Promise<boolean> => ipcRenderer.invoke('plugins:dockSurfaceProvided', surface),
  listOpenWorkspaces: (): Promise<string[]> => ipcRenderer.invoke('workspace:listOpen'),
  focusWorkspaceWindow: (workspacePath: string): Promise<boolean> =>
    ipcRenderer.invoke('workspace:focusExisting', workspacePath),
  reportAdoptedWorkspaces: (paths: string[]): void =>
    ipcRenderer.send('window:reportAdoptedWorkspaces', paths),
  takeRestoredAdoptedWorkspaces: (): Promise<string[]> =>
    ipcRenderer.invoke('window:takeRestoredAdopted'),
  // Returns a disposer, like the workspace listener below.
  // Returns a disposer — Welcome mounts/unmounts with the workspace gate.
  onOpenWorkspacesChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('workspace:openChanged', listener)
    return () => ipcRenderer.removeListener('workspace:openChanged', listener)
  },
  openPath: (target: string): Promise<{ ok: boolean; revealed?: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openPath', target),
  revealPath: (target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:revealPath', target),
  openTerminal: (command: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openTerminal', command),
  openTempFile: (filename: string, content: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('shell:openTempFile', filename, content),
  openMainWindow: (args?: { workspace_path?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openMain', args ?? {}),
  detachGroup: (args: { groupId: string; workspacePath: string; bounds?: { x: number; y: number; width: number; height: number } }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:detachGroup', args),
  detachWorkspace: (args: { workspacePath: string; bounds?: { x: number; y: number; width: number; height: number } }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:detachWorkspace', args),
  getDetachedGroups: (): Promise<string[]> => ipcRenderer.invoke('window:getDetachedGroups'),
  /** Merge a detached group back. Omit groupId from the detached window itself
   *  — main resolves it from the sender. */
  reattachGroup: (args?: { groupId?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:reattachGroup', args ?? {}),
  onGroupDetached: (cb: (groupId: string) => void): void => {
    ipcRenderer.on('group:detached', (_event, arg: { groupId: string }) => cb(arg.groupId))
  },
  onGroupReattached: (cb: (groupId: string) => void): void => {
    ipcRenderer.on('group:reattached', (_event, arg: { groupId: string }) => cb(arg.groupId))
  },
  onOpenPipelineManager: (handler: (payload: { pipelineId?: string }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { pipelineId?: string }): void => handler(payload ?? {})
    ipcRenderer.on('menu:open-pipeline-manager', listener)
    return () => ipcRenderer.removeListener('menu:open-pipeline-manager', listener)
  },
  onOpenResourceManager: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('menu:open-resource-manager', listener)
    return () => ipcRenderer.removeListener('menu:open-resource-manager', listener)
  },
  onOpenTurnStats: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('menu:open-turn-stats', listener)
    return () => ipcRenderer.removeListener('menu:open-turn-stats', listener)
  },
  openPlansWindow: (args: { workspace_path: string; rel_path?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openPlans', {
      workspace_path: args.workspace_path,
      ...(args.rel_path ? { rel_path: args.rel_path } : {}),
    }),
  projectLegacyPlansPreferences: (args: {
    workspace_path: string
    values: LegacyPlansPreferenceProjection
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('plans:projectLegacyPreferences', {
      workspace_path: args.workspace_path,
      values: args.values,
    }),
  /** Read the Host-selected previous Plans snapshot projection for the
   * retained legacy route. The sender/window determines the workspace; the
   * renderer cannot supply a snapshot, tier, or package version. */
  getPlansLegacyRecoveryPreferences: (): Promise<LegacyPlansPreferenceProjection | null> =>
    ipcRenderer.invoke('plans:getLegacyRecoveryPreferences'),
  onPlansLegacyRecoveryPreferences: (
    cb: (values: LegacyPlansPreferenceProjection) => void,
  ): (() => void) => {
    const listener = (_event: unknown, values: unknown): void => {
      if (!values || typeof values !== 'object' || Array.isArray(values)) return
      cb(values as LegacyPlansPreferenceProjection)
    }
    ipcRenderer.on('plans:legacyRecoveryPreferences', listener)
    return () => ipcRenderer.removeListener('plans:legacyRecoveryPreferences', listener)
  },
  openGitHistoryWindow: (args: { workspace_path: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openGitHistory', { workspace_path: args.workspace_path }),
  openGitWindow: (args: {
    workspace_path: string
    filepath?: string
    staged?: boolean
    commit?: string
    base?: string
    compare?: string
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openGit', {
      workspace_path: args.workspace_path,
      ...(args.filepath
        ? { filepath: args.filepath, staged: String(args.staged ?? false), commit: args.commit ?? '' }
        : {}),
      ...(args.base === undefined ? {} : { base: args.base }),
      ...(args.compare === undefined ? {} : { compare: args.compare }),
    }),
  openGitLeftView: (args: {
    workspace_path: string
    bounds: { x: number; y: number; width: number; height: number }
  }): Promise<{ ok: boolean; fallback?: 'legacy' }> =>
    ipcRenderer.invoke('window:openGitLeft', args),
  updateGitLeftView: (args: {
    bounds: { x: number; y: number; width: number; height: number }
    visible: boolean
  }): Promise<{ ok: boolean; fallback?: 'legacy' }> =>
    ipcRenderer.invoke('window:updateGitLeft', args),
  closeGitLeftView: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:closeGitLeft'),
  getZoomFactor: (): Promise<number> => ipcRenderer.invoke('window:getZoomFactor'),
  // Interface scale: main applies it to every window's WebContents at once.
  setUiScale: (scale: number): Promise<number> => ipcRenderer.invoke('window:setUiScale', scale),
  onZoomChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('window:zoom-changed', listener)
    return () => ipcRenderer.removeListener('window:zoom-changed', listener)
  },
  // Plan-window side receiver: main asks an already-open plan window to switch
  // to a newly clicked plan instead of reopening the window. Returns a disposer.
  onPlanOpenDoc: (handler: (relPath: string) => void): (() => void) => {
    const listener = (_event: unknown, relPath: string): void => handler(relPath)
    ipcRenderer.on('plan:open-doc', listener)
    return () => ipcRenderer.removeListener('plan:open-doc', listener)
  },
  openDiffWindow: (args: {
    workspace_path: string
    filepath: string
    staged: boolean
    name?: string
    commit?: string
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openDiff', {
      workspace_path: args.workspace_path,
      filepath: args.filepath,
      staged: String(args.staged),
      name: args.name ?? args.filepath,
      commit: args.commit ?? '',
    }),
  openEditorWindow: (args: {
    workspace_path: string
    filepath?: string
    // Root the file itself belongs to (normally its parent directory) when it
    // lives outside `workspace_path`. Omitted/empty means the file is opened
    // against the workspace, as before.
    file_ws?: string
    name?: string
    line?: number
    sidebar?: 'explorer' | 'search' | 'git'
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openEditor', {
      workspace_path: args.workspace_path,
      ...(args.filepath ? { filepath: args.filepath, name: args.name ?? args.filepath } : {}),
      ...(args.file_ws ? { file_ws: args.file_ws } : {}),
      ...(args.line ? { line: String(args.line) } : {}),
      ...(args.sidebar ? { sidebar: args.sidebar } : {}),
    }),
  // Default-editor routing: the editors Navide can drive on this machine, and
  // opening a folder in one of them ("Open with…"; omit editorId for the
  // user's default).
  listEditors: (refresh = false): Promise<{ id: string; command: string; available: boolean }[]> =>
    ipcRenderer.invoke('editors:list', { refresh }),
  openFolderInEditor: (dir: string, editorId?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('editor:openFolder', { dir, ...(editorId ? { editorId } : {}) }),
  onSwitchEditorSidebar: (cb: (sidebar: string) => void): void => {
    ipcRenderer.on('editor:switchSidebar', (_event, sidebar: string) => cb(sidebar))
  },
  onOpenEditorFile: (cb: (params: Record<string, string>) => void): void => {
    editorOpenFileCallback = cb
    for (const params of pendingEditorOpenFiles.splice(0)) cb(params)
  },
  onOpenEditorDiff: (cb: (params: Record<string, string>) => void): void => {
    ipcRenderer.on('editor:openDiff', (_event, params: Record<string, string>) => cb(params))
  },
  openBranchDiffWindow: (args: {
    workspace_path: string
    base: string
    compare?: string
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:openBranchDiff', {
      workspace_path: args.workspace_path,
      branch_diff_base: args.base,
      branch_diff_compare: args.compare ?? '',
    }),
  onOpenEditorBranchDiff: (cb: (params: Record<string, string>) => void): void => {
    ipcRenderer.on('editor:openBranchDiff', (_event, params: Record<string, string>) => cb(params))
  },
  gitDiffHead: (args: {
    workspace_path: string
    base?: string
    compare?: string
  }): Promise<{ ok: boolean; diff: string; error?: string }> =>
    ipcRenderer.invoke('git:diff-head', args),
  saveJson: (args: {
    defaultName?: string
    content: string
    title?: string
  }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('dialog:saveJson', args),
  openJson: (args?: {
    title?: string
  }): Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('dialog:openJson', args),
  readFileFrom: (filePath: string, fromByte: number): Promise<{ ok: boolean; content: string; newOffset: number; error?: string }> =>
    ipcRenderer.invoke('fs:readFrom', filePath, fromByte),
  realpath: (target: string): Promise<string> =>
    ipcRenderer.invoke('fs:realpath', target),
  findManualLog: (workspacePath: string, filename: string): Promise<{ ok: boolean; path: string | null; error?: string }> =>
    ipcRenderer.invoke('logs:findManualLog', workspacePath, filename),
  searchHistoryLogs: (args: { query: string; files: Array<{ id: string; path: string }> }): Promise<{ matchedIds: string[] }> =>
    ipcRenderer.invoke('logs:searchContent', args),
  pickFile: (args?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    defaultPath?: string
  }): Promise<{ ok: boolean; path?: string; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:pickFile', args),
  pickFiles: (args?: {
    title?: string
    filters?: Array<{ name: string; extensions: string[] }>
    defaultPath?: string
  }): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }> =>
    ipcRenderer.invoke('dialog:pickFiles', args),
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shell:openExternal', url),
  /** The legal pages on navide.dev, by route; the same table main's Help menu uses. */
  legalLinks: { ...LEGAL_LINKS } as Readonly<Record<LegalRoute, string>>,
  /**
   * A one-time confirmation for one trust-changing action.
   *
   * Only a window can get one: the key that signs it lives in the main process
   * and never reaches the backend's socket, which MCP and the plugin broker
   * also hold. Null when there is no backend yet, or when the action is not one
   * of the six this covers.
   */
  trustConfirm: (
    action: string,
    deviceId: string,
    subject = '',
  ): Promise<{ nonce: string; expires: string; mac: string } | null> =>
    ipcRenderer.invoke('trust:confirm', action, deviceId, subject),

  /** Open one legal page in the default browser; the URL is main's, not the caller's. */
  openLegal: (route: LegalRoute): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('legal:open', route),
  /** Open Spotlight's privacy settings (macOS); the destination is main's. */
  openSpotlightSettings: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('system:open-spotlight-settings'),
  /** Open Accessibility › Spoken Content (macOS) to download voices; the destination is main's. */
  openSpokenContentSettings: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('system:open-spoken-content-settings'),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  stabilizeDroppedPaths: (paths: string[]): Promise<{ ok: boolean; paths: string[] }> =>
    ipcRenderer.invoke('drop:stabilize', paths),
  saveClipboardImage: (args: {
    bytes: Uint8Array
    mediaType: string
  }): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke('clipboard:saveImage', args),
  readKeybindings: (): Promise<{ ok: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('keybindings:read'),
  writeKeybindings: (content: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('keybindings:write', content),
  onKeybindingsChanged: (cb: (content: string) => void): void => {
    ipcRenderer.on('keybindings:changed', (_event, content: string) => cb(content))
  },
  // Synchronous on purpose: seeds the renderer settings cache before first
  // paint (zero-flash theme/language). Returns the ui_settings.json text,
  // '{}' when missing/corrupt.
  getBootstrapSettings: (): string => ipcRenderer.sendSync('settings:bootstrap') as string,
  broadcastLanguageChange: (locale: string): void => {
    ipcRenderer.send('settings:language-changed', locale)
  },
  onLanguageChanged: (cb: (locale: string) => void): void => {
    ipcRenderer.on('settings:language-changed', (_event, locale: string) => cb(locale))
  },
  setQuitConfirm: (cfg: {
    enabled: boolean
    message: string
    detail: string
    quitLabel: string
    cancelLabel: string
    dontShowLabel: string
    cancelledMessage: string
    cancelledDetail: string
    cancelledUnknownWindow: string
  }): void => ipcRenderer.send('app:setQuitConfirm', cfg),
  onQuitConfirmDisabled: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('app:quitConfirmDisabled', listener)
    return () => ipcRenderer.removeListener('app:quitConfirmDisabled', listener)
  },
  /** Stages of the quit sequence, so the window can show a shutdown screen
   *  instead of sitting there looking hung while the backend is stopped. */
  onQuitProgress: (cb: (stage: 'saving' | 'stopping' | 'closing' | 'cancelled') => void): (() => void) => {
    const listener = (_event: unknown, stage: 'saving' | 'stopping' | 'closing' | 'cancelled'): void => cb(stage)
    ipcRenderer.on('app:quitProgress', listener)
    return () => ipcRenderer.removeListener('app:quitProgress', listener)
  },
  // Real window visibility, reported by main. The Page Visibility API cannot be
  // used for this: terminal panes need backgroundThrottling disabled, which also
  // pins document.hidden to false for the whole renderer.
  onWindowVisibility: (cb: (visible: boolean) => void): (() => void) => {
    const listener = (_event: unknown, visible: boolean): void => cb(visible)
    ipcRenderer.on('window:visibility', listener)
    return () => ipcRenderer.removeListener('window:visibility', listener)
  },
  readHealthCheckTimeout: (): Promise<{ ok: boolean; timeoutSec?: number }> =>
    ipcRenderer.invoke('settings:health-timeout-read'),
  writeHealthCheckTimeout: (timeoutSec: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:health-timeout-write', timeoutSec),
  readCdpDebugConfig: (): Promise<{ ok: boolean; config?: { enabled: boolean; port: number } }> =>
    ipcRenderer.invoke('settings:cdp-debug-read'),
  writeCdpDebugConfig: (config: { enabled: boolean; port: number }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:cdp-debug-write', config),
  notify: (args: { paneId?: string; title: string; body?: string; silent?: boolean }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('window:notify', args),
  // Plan execute dispatch: the plan window hands an approved plan to a CLI
  // agent. Main focuses the workspace's main window and forwards the payload;
  // that window creates/reuses the agent pane and injects the execution
  // prompt. delivered:false when no main window is open for the workspace.
  dispatchPlanExecution: (args: {
    workspace_path: string
    rel_path: string
    agent_key: string
  }): Promise<{ delivered: boolean }> =>
    ipcRenderer.invoke('plans:dispatch-execution', args),
  // Main-window side receiver. Returns a disposer.
  onPlanExecutionDispatch: (
    handler: (args: { workspace_path: string; rel_path: string; agent_key: string }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      args: { workspace_path: string; rel_path: string; agent_key: string }
    ): void => handler(args)
    ipcRenderer.on('plans:execute-dispatch', listener)
    return () => ipcRenderer.removeListener('plans:execute-dispatch', listener)
  },
  // Main-window side: report the dispatch outcome so the plan window can
  // confirm (toast) or roll back the in-progress execution record.
  reportPlanExecutionResult: (args: {
    workspace_path: string
    rel_path: string
    ok: boolean
    reason?: string
  }): void => {
    ipcRenderer.send('plans:execution-result', args)
  },
  // Plan-window side receiver for the dispatch outcome. Returns a disposer.
  onPlanExecutionResult: (
    handler: (args: { workspace_path: string; rel_path: string; ok: boolean; reason?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      args: { workspace_path: string; rel_path: string; ok: boolean; reason?: string }
    ): void => handler(args)
    ipcRenderer.on('plans:execution-result', listener)
    return () => ipcRenderer.removeListener('plans:execution-result', listener)
  },
  onFocusPane: (cb: (paneId: string) => void): void => {
    ipcRenderer.on('notify:focusPane', (_event, paneId: string) => cb(paneId))
  },
  // Cross-window CLI-context bridge: the editor window's AI Chat invokes
  // getCliPaneBuffer; the main process relays it to the main window(s), where
  // onCliPaneBufferRequest answers from the pane's live metadata and rendered scrollback.
  getCliPaneBuffer: (
    paneId: string
  ): Promise<{
    label?: string
    agentKey?: string
    sessionId?: string | null
    sessionHomeId?: string
    workspacePath?: string
    conversationLogPath?: string
    buffer?: string
    error?: string
  }> =>
    ipcRenderer.invoke('cli:get-pane-buffer', paneId),
  // Resource Manager row actions: the window lists panes from every main
  // window, so jumping to one or reclaiming it has to be relayed to whichever
  // window owns it.
  requestPaneAction: (args: {
    paneId: string
    action: 'focus' | 'reclaim'
  }): Promise<{ ok?: boolean; error?: string }> => ipcRenderer.invoke('pane:action', args),
  onPaneActionRequest: (
    handler: (
      paneId: string,
      action: 'focus' | 'reclaim'
    ) => Promise<{ ok?: boolean; error?: string }> | { ok?: boolean; error?: string }
  ): void => {
    ipcRenderer.on(
      'pane:action:request',
      (_event, requestId: string, paneId: string, action: 'focus' | 'reclaim') => {
        void Promise.resolve(handler(paneId, action)).then((result) => {
          ipcRenderer.send('pane:action:reply', requestId, result)
        })
      }
    )
  },
  onCliPaneBufferRequest: (
    handler: (
      paneId: string
    ) => {
      label: string
      agentKey: string
      sessionId: string | null
      sessionHomeId: string
      workspacePath: string
      conversationLogPath: string
      buffer: string
    } | { error: string }
  ): void => {
    ipcRenderer.on('cli:get-pane-buffer:request', (_event, requestId: string, paneId: string) => {
      ipcRenderer.send('cli:get-pane-buffer:reply', requestId, handler(paneId))
    })
  },
  // Cross-window pane drop handoff: HTML5 DnD events never reach another
  // BrowserWindow, so the drag source reports the release point (screen coords
  // from dragend) and main forwards it to the window under that point.
  // `paneIds` carries every pane of a multi-select drag (the dragged pane alone
  // when there is no selection), so the receiving window can share all of them.
  cliPaneDragEnd: (
    paneId: string,
    screenX: number,
    screenY: number,
    paneIds?: string[]
  ): void => {
    ipcRenderer.send('cli:pane-drag-end', { paneId, screenX, screenY, paneIds })
  },
  // Returns a disposer — the AI Chat mounts/unmounts with the panel toggle.
  onExternalPaneDrop: (
    handler: (args: { paneId: string; paneIds?: string[]; screenX: number; screenY: number }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      args: { paneId: string; paneIds?: string[]; screenX: number; screenY: number }
    ): void => handler(args)
    ipcRenderer.on('cli:external-pane-drop', listener)
    return () => ipcRenderer.removeListener('cli:external-pane-drop', listener)
  },
  // Terminal right-click. xterm keeps its selection out of the DOM, so main
  // cannot read it from the context-menu params and the pane hands it over.
  showTerminalContextMenu: (selection: string): void => {
    ipcRenderer.send('terminal:context-menu', selection)
  },
  // Terminal selection, pushed as it changes. Edit > Copy then reads it from
  // main synchronously instead of racing this renderer for an answer — see
  // terminal-selection-cache.ts.
  reportTerminalSelection: (selection: string): void => {
    ipcRenderer.send('terminal:selection-changed', selection)
  },
  // Edit > Copy fell through to a copy that cannot work over a terminal, so the
  // clipboard is unchanged. The focused pane turns this into a visible notice.
  onTerminalCopyEmpty: (cb: (branch: string) => void) =>
    ipcRenderer.on('terminal:copy-empty', (_event, branch: string) => cb(branch)),
  setBadgeCount: (count: number): void => {
    ipcRenderer.send('window:setBadgeCount', count)
  },
  reportWorkspace: (workspacePath: string): void => {
    ipcRenderer.send('window:reportWorkspace', workspacePath)
  },
  setGitContributionState: (state: GitContributionState): void => {
    ipcRenderer.send('git:contribution-state', state)
  },
  clearGitContributionState: (): void => {
    ipcRenderer.send('git:contribution-state-clear')
  },
  onGitContributionAction: (handler: (action: GitContributionActionEnvelope) => void): (() => void) => {
    const listener = (_event: unknown, action: GitContributionActionEnvelope): void => handler(action)
    ipcRenderer.on('git:contribution-action', listener)
    return () => ipcRenderer.removeListener('git:contribution-action', listener)
  },
  restore: {
    getPending: (): Promise<string[] | null> => ipcRenderer.invoke('restore:getPending'),
    getSkipped: (): Promise<string[]> => ipcRenderer.invoke('restore:getSkipped'),
    apply: (): Promise<{ ok: boolean; opened: number }> => ipcRenderer.invoke('restore:apply'),
    dismiss: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('restore:dismiss'),
    getAutoRestore: (): Promise<boolean> => ipcRenderer.invoke('restore:getAutoRestore'),
    setAutoRestore: (value: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('restore:setAutoRestore', value),
  },
  storage: {
    clearElectronCaches: (opts: ClearElectronCachesOptions): Promise<ClearElectronCachesResult> =>
      ipcRenderer.invoke('storage:clear-electron-caches', opts),
  },
  updater: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke('updater:get-state'),
    check: (): Promise<UpdateActionResult> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<UpdateActionResult> => ipcRenderer.invoke('updater:download'),
    install: (): Promise<UpdateActionResult> => ipcRenderer.invoke('updater:install'),
    getSettings: (): Promise<UpdaterSettings> => ipcRenderer.invoke('updater:get-settings'),
    setSettings: (patch: Partial<UpdaterSettings>): Promise<UpdateSettingsResult> =>
      ipcRenderer.invoke('updater:set-settings', patch),
    onStateChanged: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_event: unknown, state: UpdateState): void => cb(state)
      ipcRenderer.on('updater:state-changed', listener)
      return () => ipcRenderer.removeListener('updater:state-changed', listener)
    },
  },
  gitAccounts: {
    isAvailable: (): Promise<{ ok: boolean; available?: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:available'),
    list: (): Promise<{ ok: boolean; accounts?: GitAccountPublic[]; error?: string }> =>
      ipcRenderer.invoke('git-accounts:list'),
    add: (input: GitAccountInput): Promise<{ ok: boolean; account?: GitAccountPublic; error?: string }> =>
      ipcRenderer.invoke('git-accounts:add', input),
    update: (id: string, patch: Partial<GitAccountInput>): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:update', id, patch),
    remove: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:remove', id),
    bind: (workspacePath: string, accountId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:bind', workspacePath, accountId),
    unbind: (workspacePath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('git-accounts:unbind', workspacePath),
    getBinding: (workspacePath: string): Promise<{ ok: boolean; accountId?: string | null; error?: string }> =>
      ipcRenderer.invoke('git-accounts:getBinding', workspacePath),
    getCredential: (
      workspacePath: string
    ): Promise<{ ok: boolean; credential?: GitCredential | null; error?: string }> =>
      ipcRenderer.invoke('git-accounts:getCredential', workspacePath),
  },
  permissions: {
    status: (): Promise<Record<PermissionKey, PermissionStatus>> =>
      ipcRenderer.invoke('permissions:status'),
    request: (
      key: PermissionKey,
      payload?: { title?: string; body?: string }
    ): Promise<PermissionStatus> => ipcRenderer.invoke('permissions:request', key, payload),
    openSettings: (key: PermissionKey): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('permissions:open-settings', key),
  },
  media: {
    /** macOS microphone consent for voice input; granted elsewhere. */
    askMicrophone: (): Promise<{ granted: boolean; status: string; prompted?: boolean }> =>
      ipcRenderer.invoke('media:ask-microphone'),
  },
  // The fn (🌐) key for voice input (macOS); see src/main/fn-key-helper.ts.
  fnKey: {
    subscribe: () => ipcRenderer.invoke('voice:fn-key-subscribe'),
    unsubscribe: () => ipcRenderer.invoke('voice:fn-key-unsubscribe'),
    status: () => ipcRenderer.invoke('voice:fn-key-status'),
    requestPermission: () => ipcRenderer.invoke('voice:fn-key-request-permission'),
    openSettings: (which) => ipcRenderer.invoke('voice:fn-key-open-settings', which),
    onEvent: (handler) => {
      const listener = (_e: unknown, payload: Parameters<typeof handler>[0]): void => handler(payload)
      ipcRenderer.on(FN_KEY_EVENT_CHANNEL, listener)
      return () => ipcRenderer.removeListener(FN_KEY_EVENT_CHANNEL, listener)
    },
    onStatus: (handler) => {
      const listener = (_e: unknown, payload: Parameters<typeof handler>[0]): void => handler(payload)
      ipcRenderer.on(FN_KEY_STATUS_CHANNEL, listener)
      return () => ipcRenderer.removeListener(FN_KEY_STATUS_CHANNEL, listener)
    },
  } satisfies FnKeyApi,
  // navide://extension/<id> links routed by src/main/deep-link.ts.
  deepLink: {
    ready: () => ipcRenderer.invoke(DEEP_LINK_READY_CHANNEL),
    onOpenExtension: (handler) => {
      const listener = (_e: unknown, target: Parameters<typeof handler>[0]): void => handler(target)
      ipcRenderer.on(DEEP_LINK_OPEN_CHANNEL, listener)
      return () => ipcRenderer.removeListener(DEEP_LINK_OPEN_CHANNEL, listener)
    },
  } satisfies DeepLinkApi,
  executionPolicy: {
    inspect: (workspacePath?: string): ReturnType<ExecutionPolicyApi['inspect']> =>
      ipcRenderer.invoke('execution-policy:inspect', workspacePath),
    setUser: (args: Parameters<ExecutionPolicyApi['setUser']>[0]): ReturnType<ExecutionPolicyApi['setUser']> =>
      ipcRenderer.invoke('execution-policy:set-user', args),
    resetUser: (args: Parameters<ExecutionPolicyApi['resetUser']>[0]): ReturnType<ExecutionPolicyApi['resetUser']> =>
      ipcRenderer.invoke('execution-policy:reset-user', args),
    selectSource: (
      args: Parameters<ExecutionPolicyApi['selectSource']>[0]
    ): ReturnType<ExecutionPolicyApi['selectSource']> =>
      ipcRenderer.invoke('execution-policy:select-source', args),
    rebuild: (
      args: Parameters<ExecutionPolicyApi['rebuild']>[0]
    ): ReturnType<ExecutionPolicyApi['rebuild']> =>
      ipcRenderer.invoke('execution-policy:rebuild', args),
    resetSourceSelections: (
      args: Parameters<ExecutionPolicyApi['resetSourceSelections']>[0]
    ): ReturnType<ExecutionPolicyApi['resetSourceSelections']> =>
      ipcRenderer.invoke('execution-policy:reset-source-selections', args),
    onChanged: (handler: Parameters<ExecutionPolicyApi['onChanged']>[0]): ReturnType<ExecutionPolicyApi['onChanged']> => {
      const listener = (): void => handler()
      ipcRenderer.on('execution-policy:changed', listener)
      return () => ipcRenderer.removeListener('execution-policy:changed', listener)
    },
  },
  plugins: {
    listInstalled: (): Promise<InstalledPluginSummary[]> =>
      ipcRenderer.invoke('plugins:listInstalled'),
    listFactoryPackages: (): Promise<FactoryPluginSummary[]> =>
      ipcRenderer.invoke('plugins:listFactoryPackages'),
    backendCallConcurrency: (): Promise<BackendCallConcurrency[]> =>
      ipcRenderer.invoke('plugins:backendCallConcurrency'),
    /** D-f: one installed plugin's activity report (read only). */
    activityReport: (id: string): Promise<
      { ok: true; report: PluginActivityReport } | { ok: false; error: string }
    > => ipcRenderer.invoke('plugins:activityReport', { id }),
    /** D-f: installed Registry packages' disclosures and install-time scans. */
    installedDisclosures: (): Promise<Array<{
      id: string
      version: string
      disclosure: PluginManifestDisclosure | null
      scan: PluginScanReport | null
    }>> => ipcRenderer.invoke('plugins:installedDisclosures'),
    backendResourceUsage: (): Promise<BackendResourceUsage> =>
      ipcRenderer.invoke('plugins:backendResourceUsage'),
    disabledBuiltins: (): Promise<string[]> => ipcRenderer.invoke('plugins:disabledBuiltins'),
    disabledStoreStatus: (): Promise<{ status: 'ok' | 'restored' | 'unreadable' }> =>
      ipcRenderer.invoke('plugins:disabledStoreStatus'),
    resetDisabledStore: (): Promise<{ status: 'ok' | 'restored' | 'unreadable' }> =>
      ipcRenderer.invoke('plugins:resetDisabledStore'),
    listContributions: (): Promise<Array<{
      pluginId: string
      packageVersion: string | null
      contributionKey: string
      title: string
      icon: string | null
      /** The icon is a single-colour silhouette, so it is painted in the
       *  current text colour rather than the shade baked into the artwork. */
      iconMonochrome: boolean
      kind: 'custom'
      location: 'top' | 'bottom' | 'right' | 'left' | 'main' | 'window'
      manifestOrder: number
      /** Source and review state of the package that contributes this view. */
      source?: PluginSource
    }>> => ipcRenderer.invoke('plugins:listContributions'),
    hostThemeChanged: (theme: string): void =>
      ipcRenderer.send('plugins:hostThemeChanged', theme),
    prepareContribution: (args: {
      contributionKey: string
      workspace_path: string
      theme?: string
    }): Promise<{ ok: boolean; url?: string; error?: string }> =>
      ipcRenderer.invoke('plugins:prepareContribution', args),
    openContributionWindow: (args: {
      contributionKey: string
      workspace_path: string
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('plugins:openContributionWindow', args),
    closeContribution: (args: { contributionKey: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('plugins:closeContribution', args),
    onContributionsChanged: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('plugins:contributionsChanged', listener)
      return () => ipcRenderer.removeListener('plugins:contributionsChanged', listener)
    },
    marketplaceSearch: (
      query?: string,
      sort?: 'updated' | 'downloads' | 'rating',
      options?: MarketplaceSearchOptions
    ): Promise<MarketplaceListResponse> =>
      ipcRenderer.invoke('plugins:marketplaceSearch', query, sort, options),
    marketplaceCategories: (): Promise<MarketplaceCategory[]> =>
      ipcRenderer.invoke('plugins:marketplaceCategories'),
    marketplaceIcon: (args: {
      namespace: string
      name: string
      version: string
      path: string
    }): Promise<string | null> => ipcRenderer.invoke('plugins:marketplaceIcon', args),
    marketplaceChangelog: (args: { namespace: string; name: string }): Promise<string | null> =>
      ipcRenderer.invoke('plugins:marketplaceChangelog', args),
    marketplaceDetail: (args: { namespace: string; name: string }): Promise<MarketplaceExtensionDetail> =>
      ipcRenderer.invoke('plugins:marketplaceDetail', args),
    checkUpdates: (): Promise<PluginUpdateInfo[]> => ipcRenderer.invoke('plugins:checkUpdates'),
    pendingUpdates: (): Promise<PluginUpdateInfo[]> => ipcRenderer.invoke('plugins:pendingUpdates'),
    onUpdatesChanged: (handler: (updates: PluginUpdateInfo[]) => void): (() => void) => {
      const listener = (_event: unknown, updates: PluginUpdateInfo[]): void => handler(updates)
      ipcRenderer.on('plugins:updatesChanged', listener)
      return () => ipcRenderer.removeListener('plugins:updatesChanged', listener)
    },
    /** The core backend's agent tool result helper changed state. */
    onResultHelperState: (handler: (state: AgentToolsResultHelperState) => void): (() => void) => {
      const listener = (_event: unknown, state: AgentToolsResultHelperState): void => handler(state)
      ipcRenderer.on('plugins:resultHelperState', listener)
      return () => ipcRenderer.removeListener('plugins:resultHelperState', listener)
    },
    /** D-f: rescans of installed versions that found new items (notice only). */
    onRescanNotices: (handler: (notices: PluginRescanNotice[]) => void): (() => void) => {
      const listener = (_event: unknown, notices: PluginRescanNotice[]): void => handler(notices)
      ipcRenderer.on('plugins:rescanNotices', listener)
      return () => ipcRenderer.removeListener('plugins:rescanNotices', listener)
    },
    prepareInstall: (args: {
      namespace: string
      name: string
      version?: string
    }): Promise<PreparedInstallSummary> => ipcRenderer.invoke('plugins:prepareInstall', args),
    commitInstall: (
      id: string,
      approval: { publisherConfirmed?: boolean; riskConfirmed?: boolean; replaceConfirmed?: boolean; reattachBackendData?: boolean } = {}
    ): Promise<{ id: string; requires: string[]; restartRequired: true }> =>
      ipcRenderer.invoke('plugins:commitInstall', { id, ...approval }),
    /** Card K3: the main process opens its own file dialog; nothing names a path. */
    installFromFile: (): Promise<PreparedInstallSummary | null> => ipcRenderer.invoke('plugins:installFromFile'),
    commitLocalInstall: (
      id: string,
      approval: { riskConfirmed: boolean; replaceConfirmed?: boolean; reattachBackendData?: boolean }
    ): Promise<{ id: string; requires: string[]; restartRequired: true }> =>
      ipcRenderer.invoke('plugins:commitLocalInstall', { id, ...approval }),
    restart: (id: string): Promise<{
      id: string
      packageVersion: string
      restoredInstances: number
      skippedDestroyedHostWindows: number
    }> => ipcRenderer.invoke('plugins:restart', { id }),
    rollback: (id: string): Promise<{
      id: string
      packageVersion: string
      restoredInstances: number
      skippedDestroyedHostWindows: number
    }> => ipcRenderer.invoke('plugins:rollback', { id }),
    remove: (id: string, nativeBackendData?: 'keep' | 'delete'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('plugins:remove', nativeBackendData === undefined ? { id } : { id, nativeBackendData }),
    nativeBackendData: (id: string): Promise<{ exists: boolean; bytes: number; path: string }> =>
      ipcRenderer.invoke('plugins:nativeBackendData', { id }),
    installedDisclosure: (id: string): Promise<unknown> => ipcRenderer.invoke('plugins:installedDisclosure', { id }),
    setPrerelease: (id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> =>
      ipcRenderer.invoke('plugins:setPrerelease', { id, enabled }),
    setDisabled: (id: string, disabled: boolean): Promise<{ id: string; disabled: boolean }> =>
      ipcRenderer.invoke('plugins:setDisabled', { id, disabled }),
    marketplacePackMembers: (members: string[]): Promise<PackMemberSummary[]> =>
      ipcRenderer.invoke('plugins:marketplacePackMembers', { members }),
    preparePack: (args: { namespace: string; name: string }): Promise<PreparedPackSummary> =>
      ipcRenderer.invoke('plugins:preparePack', args),
    finishPack: (id: string): Promise<{ recorded: boolean; pack?: InstalledPackRecord }> =>
      ipcRenderer.invoke('plugins:finishPack', { id }),
    listPacks: (): Promise<InstalledPackRecord[]> => ipcRenderer.invoke('plugins:listPacks'),
    removePack: (id: string, members: string[]): Promise<{ removed: boolean }> =>
      ipcRenderer.invoke('plugins:removePack', { id, members }),
    restoreFactoryPackage: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('plugins:restoreFactoryPackage', { id }),
    nativeBackends: {
      list: (): Promise<NativeBackendOverview> => ipcRenderer.invoke('plugins:nativeBackends:list'),
      setEnabled: (enabled: boolean): Promise<NativeBackendOverview> =>
        ipcRenderer.invoke('plugins:nativeBackends:setEnabled', { enabled }),
      allow: (id: string): Promise<NativeBackendOverview> =>
        ipcRenderer.invoke('plugins:nativeBackends:allow', { id }),
      setDisabled: (id: string, disabled: boolean): Promise<NativeBackendOverview> =>
        ipcRenderer.invoke('plugins:nativeBackends:setDisabled', { id, disabled }),
      revokeWorkspaceWrite: (id: string, workspacePath: string): Promise<NativeBackendOverview> =>
        ipcRenderer.invoke('plugins:nativeBackends:revokeWorkspaceWrite', { id, workspacePath }),
      setAgentTools: (change: { enabled: boolean } | { externalCallers: boolean }): Promise<NativeBackendOverview> =>
        ipcRenderer.invoke('plugins:nativeBackends:setAgentTools', change),
      /** Watchdog option C: unanswered resource notices (contract 5.2). */
      resourceNotices: (): Promise<BackendResourceNoticeView[]> =>
        ipcRenderer.invoke('plugins:nativeBackends:resourceNotices'),
      /** Each running third-party backend's usage against its thresholds. */
      resourceStatus: (): Promise<BackendResourceStatusView[]> =>
        ipcRenderer.invoke('plugins:nativeBackends:resourceStatus'),
      answerResourceNotice: (id: string, choice: 'terminate' | 'continue'): Promise<boolean> =>
        ipcRenderer.invoke('plugins:nativeBackends:answerResourceNotice', { id, choice }),
      onResourceNoticesChanged: (handler: () => void): (() => void) => {
        const listener = (): void => handler()
        ipcRenderer.on('plugins:nativeBackends:resourceNoticesChanged', listener)
        return () => ipcRenderer.removeListener('plugins:nativeBackends:resourceNoticesChanged', listener)
      },
    },
  },
})
