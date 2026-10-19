// IPC surface for the Extensions view: list installed plugins, search the
// marketplace, and drive the verified install / remove flow. The security
// chain lives in `pluginInstaller` (download → digest → signature → scope →
// zip-slip); this module only wires it to `ipcMain` and the loader registry.
//
// Install is two-step so the renderer can interpose a trust confirmation for
// sensitive (fs/aiCli/shell) capabilities or native backend code:
// `plugins:prepareInstall` downloads +
// verifies and returns the trust facts WITHOUT writing to disk; the renderer
// shows the warning, then `plugins:commitInstall` writes the verified package.
// Download bytes never cross to the renderer — the prepared package is held
// main-side, keyed by id, until commit.

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { backendCallAddress } from './pluginActivity'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  prepareInstall,
  prepareLocalInstall,
  stageInstallCandidate,
  commitInstallTransaction,
  removePlugin,
  isUpdateAvailable,
  type PreparedInstall,
  type InstallerTrustConfig,
} from './pluginInstaller'
import {
  sensitiveCapabilities,
  assertRegistryUrlAllowed,
  sha256Hex,
} from './pluginVerify'
import type { RegistryPackageEnvelope, RegistryTrustMetadata } from './pluginRegistryTrust'
import { verifyRegistryTrustMetadata } from './pluginRegistryTrust'
import {
  loadOfficialRegistryRootKey,
  resolveMarketplaceRegistryRoot,
} from './pluginRegistryRootApproval'
import {
  loadPluginDir,
  manifestCapabilities,
  manifestToInstalledPackageSummary,
  type PluginActivationCatalogEntry,
} from './installedPlugins'
import { isManifestV2, manifestHasViews, parseInstalledManifest } from './pluginManifest'
import { parseManifestJson } from './pluginManifestJson'
import { isValidManifestV2PluginId } from './pluginManifestV2'
import { PluginPublisherTrustStore } from './pluginPublisherTrust'
import {
  readRegistryReceiptChannel,
  readRegistryReceiptExpiresAt,
  readRegistryTrustSnapshot,
  discoverInstalledRegistryPackageIds,
  verifyInstalledRegistryPackage,
  writeRegistryTrustSnapshot,
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  assertRegistryTrustSnapshotDoesNotRollback,
  type InstalledTrustDecision,
} from './pluginInstalledTrust'
import { pluginDeveloperModeEnabled } from './pluginDeveloperMode'
import { developerPermissionsDigest, PluginDeveloperModeStore } from './pluginDeveloperModeStore'
import {
  currentPluginHostTarget,
  isPluginTargetCompatible,
  selectPluginArtifact,
} from './pluginTarget'
import { assertEngineCompatible, isEngineCompatible, minNavideVersion } from './pluginEngineCompat'
import { compareSemver } from './pluginManifestV2'
import { MAX_EXTENSION_PACK_MEMBERS } from '../../../packages/plugin-contracts/src/index'
import { PluginPrereleaseStore } from './pluginPrereleaseStore'
import {
  forgetKeptNativeBackendDataSource,
  inspectNativeBackendData,
  keptNativeBackendDataSource,
  latestSetAsideNativeBackendData,
  recordedNativeBackendDataSource,
  recordKeptNativeBackendDataSource,
  reattachNativeBackendData,
  removeNativeBackendData,
  returnReattachedNativeBackendData,
  setAsideNativeBackendData,
} from './pluginNativeBackendData'
import { packOnlyMembers, PluginPackStore, type InstalledPackRecord } from './pluginPackStore'
import type {
  FrontendPluginManager,
  PluginLaunchDescriptor,
  PluginPackageRestartTransaction,
} from './frontendPluginManager'
import { BUILTIN_PLUGIN_NAMES, isReservedPluginId } from './frontendPluginManager'
import { answerPluginAgentAction, type PluginAgentActionNotice } from './pluginAgentAction'
import type { ContributionIcon } from './pluginContributionIcon'
import type { BackendCallConcurrency, BackendResourceUsage } from './pluginBackendHost'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'
import { PluginDisabledStore } from './pluginDisabledStore'
import { PluginDisableSourceStore, type DisableSource } from './pluginDisableSource'
import { answerMarketplaceQuery, MarketplaceHttpError, rowCard } from './marketplaceQuery'
import type { PluginIdStoreStatus } from './pluginFactoryOptOutStore'
import { PluginActivationSelector, type PluginPackageSelection } from './pluginActivationSelector'
import type { HostCapabilityGrant } from './pluginCapabilityBroker'
import {
  copyManifestPermissionsSummary,
  type ManifestPermissionsSummary,
  type PackageVersionGrantSummary,
} from '../../shared/executionPolicy'
import {
  parsePluginActivityReport,
  type PluginActivityReport,
  type PluginActivityReportRequest,
} from '../../shared/pluginActivity'
import {
  computeDisclosure,
  diffDisclosure,
  disclosureItems,
  type DisclosureDiff,
  type DisclosureManifestInput,
  type DisclosureRiskLevel,
  type ManifestDisclosure,
} from '../../shared/pluginDisclosure'
import { cardRiskLevel, type ScanItem, type ScanReport } from '../../shared/pluginDisclosureScan'
import { pluginSourceFromLegacyProvenance, type PluginSource } from '../../shared/pluginSource'
import { PluginInstallScanStore } from './pluginInstallScanStore'
import { pluginStorageDirName } from './pluginStorage'
import { rescanFinding } from './pluginRescanNotice'
import { createLocalTrustRecord, localTakedownDecision, writeLocalTrustRecord } from './pluginLocalTrust'
import { canonicalArchivePath } from './pluginPathPolicy'
import {
  forgetLocalTrustRecords,
  isLocalInstalledPackage,
  localTrustRecordPath,
  promoteLocalCandidateRecord,
  verifyLocalInstalledPackage,
} from './pluginLocalInstall'

/** Development-only endpoint. It is intentionally not the official Registry
 * identity: a local Registry must establish trust through root approval. */
const DEV_MARKETPLACE_URL = 'http://localhost:8787'
/** App-shipped Official Registry identity. A normalized match is always
 * resolved through the independent packaged root pin and cannot be downgraded
 * by approval. The path is part of the identity: the Registry is served under
 * the `/registry` prefix of the Navide server host. */
export const OFFICIAL_MARKETPLACE_URL = 'https://server.navide.dev/registry'

/** Packaged builds talk to the Official Registry; development builds keep the
 * local Registry. `AGENT_TEAM_MARKETPLACE_URL` overrides both. */
function defaultMarketplaceUrl(): string {
  return app.isPackaged ? OFFICIAL_MARKETPLACE_URL : DEV_MARKETPLACE_URL
}

/** Card K4 (D6): whether this Host honors `AGENT_TEAM_MARKETPLACE_URL` and
 * `AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE`. A development build always does;
 * a packaged build only while the user's Developer Mode switch is on, which
 * the Host supplies at startup. Until it does, a packaged build ignores both. */
let marketplaceOverridesAllowed: () => boolean = () => !app.isPackaged

export function setMarketplaceOverridesAllowed(allowed: () => boolean): void {
  marketplaceOverridesAllowed = allowed
}

function marketplaceOverride(
  name: 'AGENT_TEAM_MARKETPLACE_URL' | 'AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE',
): string | undefined {
  return marketplaceOverridesAllowed() ? process.env[name] : undefined
}

/** Resolve the marketplace registry URL, enforcing the transport policy
 *  (production forbids plaintext http except loopback). Throws before any
 *  fetch when the configured URL is disallowed. */
export function resolveConfiguredMarketplace(
  explicitTrust?: InstallerTrustConfig
): { registryUrl: string; trust: InstallerTrustConfig } {
  if (explicitTrust) {
    const registryUrl = marketplaceOverride('AGENT_TEAM_MARKETPLACE_URL') ?? defaultMarketplaceUrl()
    assertRegistryUrlAllowed(registryUrl, app.isPackaged)
    return {
      registryUrl,
      trust: {
        ...explicitTrust,
        registryAuthority: explicitTrust.registryAuthority ?? 'self-hosted',
        officialRegistryUrl: explicitTrust.officialRegistryUrl ?? OFFICIAL_MARKETPLACE_URL,
        expectedTarget: explicitTrust.expectedTarget ?? currentPluginHostTarget(),
      },
    }
  }
  const resolved = resolveMarketplaceRegistryRoot({
    registryUrlOverride: marketplaceOverride('AGENT_TEAM_MARKETPLACE_URL'),
    defaultRegistryUrl: defaultMarketplaceUrl(),
    officialRegistryUrl: OFFICIAL_MARKETPLACE_URL,
    officialRootPublicKey: loadOfficialRegistryRootKey(process.resourcesPath),
    approvalFile: marketplaceOverride('AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE'),
  })
  assertRegistryUrlAllowed(resolved.registryUrl, app.isPackaged)
  return {
    registryUrl: resolved.registryUrl,
    trust: {
      pinnedRegistryRootKey: resolved.rootPublicKey,
      registryAuthority: resolved.authority,
      officialRegistryUrl: OFFICIAL_MARKETPLACE_URL,
      expectedTarget: currentPluginHostTarget(),
    },
  }
}

interface InstalledSummary {
  id: string
  requires: string[]
  sensitive: string[]
  packageVersion?: string
  manifestPermissions?: ManifestPermissionsSummary
  packageVersionGrant?: PackageVersionGrantSummary | null
  provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
  /** Source and review state; see `shared/pluginSource.ts`. */
  source?: PluginSource
  /** Registry-signed expiry; present only when `source` is `testplace`. */
  expiresAt?: string
  warning?: string
  pendingCandidateVersion?: string
  rollbackKind?: 'factory' | 'previous'
  rollbackToVersion?: string
  /** Lowest Navide release the installed version needs (label only). */
  minNavideVersion?: string
  /** False when this Navide release is older than that; the Host still runs
   *  the package — the Extensions page only labels it. */
  engineCompatible?: boolean
  /** The user's per-extension "Get pre-releases" switch (default off). */
  getsPrereleases?: boolean
  /** The user's "Disabled" switch; present only on rows it applies to. */
  disabled?: boolean
}

export interface FactoryPackageSummary {
  id: string
  version: string | null
  active: boolean
  optedOut: boolean
  /** The user's Disabled switch for this built-in. */
  disabled?: boolean
  /** Removed by an earlier Navide version, which deleted its stored data; the
   *  upgrade turned that removal into Disabled. */
  dataDeletedByEarlierRemoval?: boolean
}

const MARKETPLACE_SORTS = new Set(['updated', 'downloads', 'rating'])
const MARKETPLACE_CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/**
 * Newest non-yanked version with an artifact this Host can install. The
 * Registry's `latest_version` ignores targets, so a platform-only release for
 * another OS must not count as an installable update here. With `appVersion`,
 * a version whose `engines.navide` this Navide release does not meet is
 * skipped too (an unknown requirement is not). A pre-release (`2.5.0-beta.1`)
 * counts only with `includePrerelease`, the user's per-extension opt-in.
 */
function newestInstallableVersion(
  versions: ReadonlyArray<{
    version?: unknown
    target?: unknown
    yanked?: unknown
    engines_navide?: unknown
  }>,
  hostTarget: string,
  appVersion?: string,
  includePrerelease = false
): string | null {
  let newest: string | null = null
  for (const row of versions) {
    if (row.yanked === true || typeof row.version !== 'string') continue
    if (!includePrerelease && isPrereleaseVersion(row.version)) continue
    if (!isPluginTargetCompatible(row.target, hostTarget)) continue
    if (appVersion !== undefined && isEngineCompatible(row.engines_navide, appVersion) === false) continue
    if (newest === null || isUpdateAvailable(newest, row.version)) newest = row.version
  }
  return newest
}

/** SemVer prerelease suffix ⇒ pre-release channel (build metadata is not one). */
export function isPrereleaseVersion(version: string): boolean {
  return version.split('+', 1)[0].includes('-')
}

/** Source and review state of an installed package: its own `source` when a
 * loader set one, else read from the legacy provenance it carries and, for a
 * Registry install, the channel in its signed envelope. */
function installedSource(
  summary: {
    provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
    source?: PluginSource
    packageVersion?: string
  },
  registryChannel?: string
): PluginSource | undefined {
  return summary.source ?? pluginSourceFromLegacyProvenance(
    summary.provenance,
    summary.packageVersion !== undefined && isPrereleaseVersion(summary.packageVersion),
    registryChannel
  )
}

/** The list card's disclosure and scan (plan B D1) from a Registry listing
 * item: display data, kept only when well formed and naming that item's
 * package and latest version (the MCP card's rule), else both null. */
function listingDisclosure(item: Record<string, unknown>): {
  disclosure: ManifestDisclosure | null
  scan: ScanReport | null
  listRisk: ListRisk | null
} {
  const id = `${String(item.namespace)}.${String(item.name)}`
  const card = rowCard(item, id, typeof item.latest_version === 'string' ? item.latest_version : '')
  return {
    disclosure: card?.manifest ?? null,
    scan: card?.scan ?? null,
    listRisk: card ? listRisk(cardRiskLevel(card.manifest, card.scan), item.risk_by_target) : null,
  }
}

const RISK_ORDER: readonly DisclosureRiskLevel[] = ['low', 'medium', 'high', 'highest']

/** What the installed manifest declares, for `declaredUnused` (contract 5.1).
 *  A backend method is keyed `backend.<method>`: a frontend's calls to its own
 *  backend (plugin:backend:call) are recorded under that address (#374). */
export function declaredForActivity(disclosure: ManifestDisclosure): NonNullable<PluginActivityReportRequest['declared']> {
  const out: NonNullable<PluginActivityReportRequest['declared']> = []
  for (const item of disclosureItems(disclosure)) {
    if (item.kind === 'system' || item.kind === 'shell' || item.kind === 'agentTool') {
      out.push({ kind: item.kind, key: item.key })
    } else if (item.kind === 'backendMethod') {
      out.push({ kind: 'backendMethod', key: backendCallAddress(item.key) })
    }
  }
  return out
}

/** The level a list card shows (D-f): the highest of this App's own
 * `cardRiskLevel` and every platform's level the Registry lists, so the card
 * never reads lower than what some platform installs; `variesByPlatform` when
 * the platforms differ. The detail page and the consent dialog keep this
 * platform's own level. A malformed `risk_by_target` is ignored whole. */
export interface ListRisk {
  level: DisclosureRiskLevel
  variesByPlatform: boolean
}

function listRisk(own: DisclosureRiskLevel, byTarget: unknown): ListRisk {
  const listed = jsonObjectOrNull(byTarget)
  const levels = listed ? Object.values(listed) : []
  const valid = levels.length > 0 && levels.every((level) => RISK_ORDER.includes(level as DisclosureRiskLevel))
  const platform = valid ? (levels as DisclosureRiskLevel[]) : []
  const highest = [own, ...platform].reduce((a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a))
  return { level: highest, variesByPlatform: new Set(platform).size > 1 }
}

/** A Registry-supplied JSON object (disclosure data), or null for anything
 * else. Display data only: install re-verifies the signed disclosure in
 * prepareInstall. */
function jsonObjectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** A Registry-supplied link, kept only when it is an https URL. */
function httpsLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

/** Largest icon the Marketplace will display; bigger ones fall back to the
 *  letter placeholder. */
export const MARKETPLACE_ICON_MAX_BYTES = 256 * 1024
const ICON_PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/

/** Read a response body, giving up (and cancelling the stream) as soon as it
 *  passes `cap` bytes, so a chunked or lying response never lands in memory
 *  whole. A response without a stream (a test double) is read directly. */
async function readBodyCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const body = res.body
  if (!body) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    return bytes.byteLength <= cap ? bytes : null
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Raster type by magic bytes; the Registry's Content-Type is not trusted. */
function sniffIconMime(bytes: Uint8Array): string | null {
  const starts = (sig: number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b)
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}

/** Validate one Registry URL path segment supplied by the renderer. */
function marketplacePathSegment(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error('invalid marketplace extension identifier')
  }
  return encodeURIComponent(value)
}

export interface PackMemberSummary {
  id: string
  /** ready: will be offered for install; installed: already on this device;
   *  missing: not in the Registry; nested: itself a pack (refused);
   *  unavailable: no artifact for this platform; incompatible: needs a newer
   *  Navide; error: the Registry could not be read for it. */
  status: 'ready' | 'installed' | 'missing' | 'nested' | 'unavailable' | 'incompatible' | 'error'
  display_name: string | null
  version: string | null
  capabilities: string[]
  sensitive_capabilities: string[]
  min_navide_version: string | null
}

export interface PluginUpdateInfo {
  id: string
  namespace: string
  name: string
  installedVersion: string
  latestVersion: string
  /** Plan B D2 badge: whether the latest version adds permissions, from the
   *  Registry's listing (unverified; prepareInstall computes the binding diff
   *  from the package itself). Absent when the listing carries no disclosure. */
  permissionChange?: 'more' | 'same'
}

export interface PluginTrustRefreshController {
  refreshRegistryTrust(): Promise<{
    decisions: Array<{ pluginId: string; action: 'allow' | 'quarantine'; reason?: string }>
    activationCatalog: ReturnType<FrontendPluginManager['loadInstalledPlugins']>['activationCatalog']
  }>
  /** Detect newer installable Registry versions of installed packages and
   *  remember the answer for `plugins:pendingUpdates`. Detection only.
   *  Rejects when the Registry did not answer for some package, after
   *  remembering the merged answer (those packages keep their last update). */
  checkUpdates(): Promise<PluginUpdateInfo[]>
  /** D-f: rescans of installed versions that found new items since the last
   *  call, each reported once. Notice only. */
  takeRescanNotices(): PluginRescanNotice[]
  /** Card K4: at startup, load the developer folders the user consented to,
   *  when Developer Mode is on. A folder whose permissions or backend changed
   *  since is left unloaded until the user consents again. */
  loadDeveloperFolders(): Promise<void>
  /** Put back notices no window received, to be sent after the next check. */
  restoreRescanNotices(notices: PluginRescanNotice[]): void
}

/** A rescan of an installed version found these new scan items (D-f). */
export interface PluginRescanNotice {
  id: string
  version: string
  added: ScanItem[]
}

export interface PluginIpcOptions {
  /** Convert a Host-verified icon file into renderer-safe image bytes. */
  resolveContributionIcon?: (iconFile: string) => ContributionIcon | null
  verifyCommittedInstall?: (
    pluginDir: string,
    pluginId: string,
    trust: InstallerTrustConfig
  ) => InstalledTrustDecision
  onActivationChange?: (change: {
    pluginId: string
    activation?: PluginActivationCatalogEntry
  }) => void
  /** Actual uninstall boundary; rollback/quarantine paths deliberately do not call this. */
  cleanupPluginStorage?: (pluginId: string) => Promise<void>
  /** `<userData>/plugin-native-backends/data`: third-party native backends keep
   *  their private data in `<root>/<pluginId>/`. Removal deletes that directory
   *  only when the caller passes `nativeBackendData: 'delete'`. */
  nativeBackendDataRoot?: string
  factoryPackageIds?: readonly string[]
  /** Why rolling this id back to its factory package is refused right now, or
   *  undefined when it is allowed. Checked before a rollback is offered or its
   *  views are drained. */
  factoryRollbackRefusal?: (pluginId: string) => string | undefined
  listFactoryPackages?: () => FactoryPackageSummary[]
  /** Current and peak in-flight backend calls and dropped Host event notifications per plugin; calls are never capped. */
  backendCallConcurrency?: () => BackendCallConcurrency[]
  /** Backend children, subscriptions, Bridge requests and queue backlog, now and at the most; none are capped. */
  backendResourceUsage?: () => BackendResourceUsage
  restoreFactoryPackage?: (pluginId: string) => Promise<void> | void
  /** Host side of the Disabled switch for the built-in Plans, Git and
   *  Mini-IDE, called after the switch is recorded: drain on disable, reload
   *  on enable. Its storage, grant and package stay either way. */
  setBuiltinDisabled?: (pluginId: string, disabled: boolean) => Promise<void> | void
  /** Called after the user reset an unreadable Disabled store: the built-ins
   *  it held off are enabled again. `resumed` names them, so the Host can
   *  finish enabling each one as the Enable switch does. */
  onBuiltinSwitchReset?: (resumed: string[]) => void
  /** Runs the built-in switch and the reset, so the Host's own check of the
   *  Disabled store never interleaves with them. */
  holdBuiltinSwitch?: <T>(task: () => Promise<T>) => Promise<T>
  onFactoryPackageRemoved?: (pluginId: string) => void
  /** Load the App-bundled package and its grant after an installed package
   *  that replaced it was unregistered; the rollback path back to the factory. */
  loadFactoryPackage?: (pluginId: string) =>
    | { loaded: true; packageVersion: string; activation: PluginActivationCatalogEntry }
    | { loaded: false; reason: string }
  onPackageInstalled?: (pluginId: string) => void
  /** Host-only hidden-window preflight. The candidate must not enter catalog state. */
  preflightCandidateFrontend?: (descriptor: PluginLaunchDescriptor) => Promise<void>
  /** Host-only standalone backend health check with no production bridge route. */
  preflightCandidateBackend?: (activation: PluginActivationCatalogEntry) => Promise<void>
  /** Card K3: the Host's own file dialog, parented to the window that asked.
   * The path it returns is the only path a local install ever reads; nothing
   * the renderer sends is used as a path. Absent, installing from a file is
   * unavailable. */
  pickLocalPackageFile?: (event: IpcMainInvokeEvent) => Promise<string | null>
  /** Card K3 (D7): drop the native backend consent and the agent tool write
   * answers of a package whose source changed, so nothing carries over. */
  forgetBackendConsent?: (pluginId: string) => void
  /** `<userData>/plugin-storage-v2`: view storage, set aside with the native
   * backend data when a package's source changes (card K3, D7). */
  pluginStorageRoot?: string
  /** Card K4: the Host's own folder dialog, parented to the window that
   * asked. Absent, loading from a folder is unavailable. */
  pickDeveloperFolder?: (event: IpcMainInvokeEvent) => Promise<string | null>
  /** The running Navide release that `engines.navide` is checked against. */
  appVersion?: () => string
  /** An agent disabled or enabled an installed Marketplace package (B2-c):
   *  tell the user who, with a one-click undo. */
  onPluginAgentAction?: (notice: PluginAgentActionNotice) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertPluginRemovalTarget(pluginsRoot: string, value: unknown): string {
  if (!isValidManifestV2PluginId(value)) throw new Error('invalid plugin id')
  const root = resolve(pluginsRoot)
  const target = resolve(root, value)
  if (dirname(target) !== root) throw new Error('invalid plugin id')
  return value
}

function installedPackageVersion(
  manager: FrontendPluginManager,
  pluginsRoot: string,
  pluginId: string,
): string | null {
  const descriptorVersion = manager.getDescriptor(pluginId)?.packageVersion
  if (typeof descriptorVersion === 'string' && descriptorVersion.length > 0) {
    return descriptorVersion
  }
  try {
    const activation = loadPluginDir(join(pluginsRoot, pluginId)).activation
    return activation?.packageVersion ?? null
  } catch {
    return null
  }
}

async function revokeInstalledPackageRuntime(
  manager: FrontendPluginManager,
  pluginsRoot: string,
  pluginId: string,
): Promise<void> {
  const packageVersion = installedPackageVersion(manager, pluginsRoot, pluginId)
  if (packageVersion) {
    await manager.revokePackageVersion(pluginId, packageVersion)
  } else {
    manager.preparePluginRemoval(pluginId)
  }
}

/** Best-effort runtime cleanup after a failed install: the install failure stays
 *  the reported error, and a cleanup failure must not mask it. */
function cleanupFailedPluginInstall(
  manager: FrontendPluginManager,
  onActivationChange: PluginIpcOptions['onActivationChange'],
  pluginId: string
): void {
  try {
    manager.removeInstalledPlugin(pluginId)
  } catch {
    // Best-effort; the install failure remains the reported error.
  }
  try {
    onActivationChange?.({ pluginId })
  } catch {
    // Keep manager cleanup and the original install failure from being masked.
  }
}

/** Restrict plugin management to the owning WebContents of a live Host window. */
export function isTrustedPluginManagementSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  trustedWindows: ReadonlySet<BrowserWindow>
): boolean {
  const window = BrowserWindow.fromWebContents(event.sender)
  return Boolean(
    window &&
      !window.isDestroyed() &&
      trustedWindows.has(window) &&
      window.webContents === event.sender &&
      !event.senderFrame?.parent
  )
}

/** Register every `plugins:*` handler exactly once. `pluginsRoot` is where
 *  verified packages are written (`userData/plugins`). */
export function registerPluginIpc(
  manager: FrontendPluginManager,
  pluginsRoot: string,
  authorizeSender: (event: IpcMainInvokeEvent) => boolean,
  trust?: InstallerTrustConfig,
  publisherTrust = new PluginPublisherTrustStore(
    join(pluginsRoot, '.navide-publisher-trust.json')
  ),
  options: PluginIpcOptions = {}
): PluginTrustRefreshController {
  // Packages verified by prepareInstall, awaiting a commit, keyed by plugin id.
  const prepared = new Map<string, { pkg: PreparedInstall }>()
  // Local packages awaiting consent (card K3). Kept apart from Registry
  // prepares so commitInstall can never commit one, nor the reverse.
  const preparedLocal = new Map<string, PreparedInstall>()
  // D7: a set-aside native backend data directory the user chose to take back
  // when this id returns to that source; applied at its restart, never assumed.
  const pendingReattach = new Set<string>()
  /** Review LOW-11: whose data an installed package's data is. Only a
   * Registry-verified id (Marketplace, pre-release, or a Registry install
   * that carries no source) may hand its data on; every other source, a
   * developer folder and any unknown value included, is treated as local. */
  const dataSourceOf = (pkg: { source?: PluginSource; provenance?: string } | undefined): 'marketplace' | 'local-unsigned' =>
    pkg !== undefined && (
      pkg.source === 'marketplace' ||
      pkg.source === 'prerelease' ||
      (pkg.source === undefined && pkg.provenance === 'official-registry')
    )
      ? 'marketplace'
      : 'local-unsigned'
  /** D7: every per-plugin data location a change of source sets aside: the
   * native backend's private folder and the view storage (all versions, so a
   * package of the same version but another target never shares it). */
  const dataPlaces = (id: string): Array<{ root: string; name: string }> => [
    ...(options.nativeBackendDataRoot ? [{ root: options.nativeBackendDataRoot, name: id }] : []),
    ...(options.pluginStorageRoot ? [{ root: options.pluginStorageRoot, name: pluginStorageDirName(id) }] : []),
  ]
  /** D7: what replacing `id` with `incoming` does to its data: whether some is
   * set aside (only when the source changes) and whether data set aside from
   * `incoming` earlier may be taken back. */
  const backendDataOnReplace = (id: string, incoming: 'marketplace' | 'local-unsigned') => {
    const installed = manager.listInstalledPackages().find((pkg) => pkg.id === id)
    if (!installed) {
      // HIGH-3: data a removal kept from another source is set aside, too.
      const root = options.nativeBackendDataRoot
      const kept = root ? keptNativeBackendDataSource(root, id) : null
      // MED-4: data a local file kept is never handed on, even to another
      // local file: its id is only what each file claims.
      return kept !== null && (kept === 'local-unsigned' || kept !== incoming) ? { backendDataSetAside: true } : {}
    }
    const current = dataSourceOf(installed)
    if (current === incoming && current !== 'local-unsigned') return {}
    const places = dataPlaces(id)
    // Only data of a Marketplace package can be taken back: its id is the
    // Registry's, while a local file's id is only what the file claims.
    const reattachable = incoming === 'marketplace' &&
      places.some((place) => latestSetAsideNativeBackendData(place.root, place.name, 'marketplace') !== null)
    return {
      ...(places.some((place) => existsSync(join(place.root, place.name))) ? { backendDataSetAside: true } : {}),
      ...(reattachable ? { reattachableBackendData: true } : {}),
    }
  }
  const rememberReattach = (id: string, incoming: 'marketplace' | 'local-unsigned', wanted: unknown): void => {
    pendingReattach.delete(id)
    if (wanted !== true) return
    if (backendDataOnReplace(id, incoming).reattachableBackendData !== true) {
      throw new Error(`there is no set-aside data of ${id} to take back`)
    }
    pendingReattach.add(id)
  }
  const activeTransactions = new Set<string>()
  const capabilityGrants = new PluginCapabilityGrantStore(pluginsRoot)
  const lifecycleSelector = new PluginActivationSelector(pluginsRoot)
  /** The signed envelope channel of the active Registry package, read from
   * the receipt beside the package that load-time verification checked. */
  const activeRegistryPackageDir = (summary: {
    id: string
    provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
  }): string | undefined => {
    if (summary.provenance !== 'official-registry') return undefined
    try {
      const active = lifecycleSelector.read(summary.id)?.active
      return active ? lifecycleSelector.packageDir(summary.id, active) : join(pluginsRoot, summary.id)
    } catch {
      return undefined
    }
  }
  const activeRegistryChannel = (summary: {
    id: string
    provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
  }): string | undefined => {
    const dir = activeRegistryPackageDir(summary)
    return dir === undefined ? undefined : readRegistryReceiptChannel(dir)
  }
  /** `source`, plus the signed testplace expiry when the source is testplace. */
  const sourceFields = (summary: {
    id: string
    provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
    source?: PluginSource
    packageVersion?: string
  }): { source?: PluginSource; expiresAt?: string } => {
    const source = installedSource(summary, activeRegistryChannel(summary))
    if (!source) return {}
    const dir = source === 'testplace' ? activeRegistryPackageDir(summary) : undefined
    const expiresAt = dir === undefined ? undefined : readRegistryReceiptExpiresAt(dir)
    return expiresAt === undefined ? { source } : { source, expiresAt }
  }
  // Plan B D2 (D-d): what an update changes, computed by the Host from the
  // active version's installed manifest and the verified package's own
  // manifest, never from Registry data. Null when there is nothing to
  // compare: a first install, a Manifest v1 package on either side, or an
  // active version whose manifest cannot be read (that update asks as before).
  const activeDisclosure = (id: string): ManifestDisclosure | null => {
    const active = lifecycleSelector.read(id)?.active
    if (!active) return null
    try {
      const dir = lifecycleSelector.packageDir(id, active)
      const installed = parseInstalledManifest(parseManifestJson(readFileSync(join(dir, 'manifest.json'), 'utf8')))
      return isManifestV2(installed) ? computeDisclosure(installed as unknown as DisclosureManifestInput) : null
    } catch {
      return null
    }
  }
  /** R2 MED-6 on #436: whether the active package has views, for the
   *  disclosure card; absent when its manifest cannot be read. */
  const activeHasViews = (id: string): { hasViews?: boolean } => {
    const active = lifecycleSelector.read(id)?.active
    if (!active) return {}
    try {
      const dir = lifecycleSelector.packageDir(id, active)
      return { hasViews: manifestHasViews(parseInstalledManifest(parseManifestJson(readFileSync(join(dir, 'manifest.json'), 'utf8')))) }
    } catch {
      return {}
    }
  }
  const updateDisclosureDiff = (pkg: PreparedInstall): DisclosureDiff | null => {
    if (!isManifestV2(pkg.manifest)) return null
    const from = activeDisclosure(pkg.id)
    if (!from) return null
    try {
      return diffDisclosure(from, computeDisclosure(pkg.manifest as unknown as DisclosureManifestInput))
    } catch {
      return null
    }
  }
  const hostAppVersion = options.appVersion ?? ((): string => app.getVersion())
  const prereleases = new PluginPrereleaseStore(pluginsRoot)
  // D-f: the scan verified at install, per version; a record for the rescan
  // notice only. Its failures never fail an install or a removal.
  const installScans = new PluginInstallScanStore(pluginsRoot)
  let rescanNotices: PluginRescanNotice[] = []
  // #373 follow-up: installedAt is recorded when a fresh install becomes
  // active: the restart found no version of the id in place (no registered
  // descriptor, no selector active, no legacy backend-only install), so an
  // update over any layout, a rollback, or a staged-then-discarded candidate
  // never records one (review MED-1, LOW1 on #380). Record only.
  const recordFreshInstall = (id: string): void => {
    try {
      installScans.markInstalled(id, Date.now())
    } catch (error) {
      console.warn(`[plugins] installedAt for ${id} not recorded: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const packs = new PluginPackStore(pluginsRoot)
  // The manager reads the same file through the resolver the Host installs
  // before the first package load; this handle only records the user's switch.
  const disabledPlugins = new PluginDisabledStore(pluginsRoot)
  // Who disabled each Marketplace package (B2-c option B). A write that fails
  // leaves an older entry behind, but the Disabled list changed since, so an
  // agent's entry then reads as the user: the conservative side.
  const disableSources = new PluginDisableSourceStore(pluginsRoot)
  const recordDisableSource = (id: string, disabled: boolean | null, source?: DisableSource): void => {
    try {
      if (disabled && source) disableSources.set(id, source)
      else disableSources.remove(id)
    } catch (error) {
      console.warn(`[plugins] who disabled ${id} was not recorded: ${errorText(error)}`)
    }
  }
  // Update, rollback and restart re-register a package. While it is disabled
  // they may change which version is selected, but they never hand the Host an
  // activation to start.
  const activationChange = options.onActivationChange
  if (activationChange) {
    options = {
      ...options,
      onActivationChange: (change) =>
        activationChange(manager.isPluginDisabled(change.pluginId) ? { pluginId: change.pluginId } : change),
    }
  }
  // Pack installs in progress, keyed by pack id: the verified member list and
  // which members were installed before the pack flow started.
  const packSessions = new Map<
    string,
    { version: string; displayName: string | null; members: string[]; preInstalled: Set<string> }
  >()

  /** Post-write verification of an installed package tree, shared by the staged
   *  (v2) and legacy (v1) commit paths. */
  const verifyCommittedInstall = (
    pluginDir: string,
    pluginId: string,
    trustConfig: InstallerTrustConfig
  ): InstalledTrustDecision =>
    // A local install (no Registry receipt, a consent record for this exact
    // id and version) is verified against that record; everything else takes
    // the Registry path exactly as before.
    verifyLocalInstalledPackage(pluginsRoot, pluginDir, pluginId, {
      pinnedRootKey: trustConfig.pinnedRegistryRootKey,
      snapshot: readRegistryTrustSnapshot(pluginsRoot),
      now: trustConfig.now,
    }) ??
    (
      options.verifyCommittedInstall ??
      ((dir: string, id: string, config: InstallerTrustConfig) =>
        verifyInstalledRegistryPackage(dir, id, {
          pinnedRootKey: config.pinnedRegistryRootKey,
          snapshot: readRegistryTrustSnapshot(pluginsRoot),
          registryAuthority: config.registryAuthority,
          officialRegistryUrl: config.officialRegistryUrl,
          expectedTarget: config.expectedTarget ?? currentPluginHostTarget(),
          now: config.now,
        }))
    )(pluginDir, pluginId, trustConfig)

  const assertAuthorized = (event: IpcMainInvokeEvent): void => {
    if (!authorizeSender(event)) throw new Error('unauthorized plugin management request')
  }

  // The rollback the Extensions page may offer, derived from the same selector
  // preconditions `plugins:rollback` enforces so a visible button can never
  // reach a refusal; a parity test pins the two together. `factory` returns the
  // id to the App bundle, which keeps no selector record of its own.
  function rollbackTargetFor(
    id: string,
  ): { kind: 'factory' } | { kind: 'previous'; version: string } | null {
    const selected = lifecycleSelector.read(id)
    if (!selected?.active || selected.candidate || selected.activation) return null
    if (!selected.previous) {
      return options.factoryPackageIds?.includes(id) && !options.factoryRollbackRefusal?.(id)
        ? { kind: 'factory' }
        : null
    }
    // The handler also refuses a retained package with no grant to restore.
    // What stays unprojected is everything that needs the package on disk:
    // trust re-verification, the artifact digest, and a readable manifest. Those
    // can change after the row is drawn, so a refusal is still reachable and its
    // message is shown to the user rather than swallowed.
    if (!selected.previousGrant) return null
    return { kind: 'previous', version: selected.previous.packageVersion }
  }

  // The installed package when it came from a local file (card K3).
  const installedLocalPackage = (id: unknown) =>
    typeof id === 'string'
      ? manager.listInstalledPackages().find((pkg) => pkg.id === id && pkg.source === 'local-unsigned')
      : undefined
  // Card K4: a developer folder holding an id is removed before anything else
  // installs that id, so no install replaces it without the D7 rules.
  const assertNoDeveloperFolder = (id: string): void => {
    // A consented folder counts while Developer Mode is off and it is unloaded:
    // its backend data is the developer's and goes to no other install.
    if (developerMode.folder(id) ||
        manager.listInstalledPackages().some((pkg) => pkg.id === id && pkg.provenance === 'developer-local-unpacked')) {
      throw new Error(`DEVELOPER_FOLDER_HOLDS_ID [${id}]: ${id} is loaded from a developer folder; remove that folder in Developer Mode first`)
    }
  }
  /** Review MED-2 on #428: a package registered again after a failed restart
   * or by a rollback keeps the source its own evidence shows: a directory a
   * local consent record covers is local, anything else is a Registry package
   * as on main. */
  const evidenceSource = (dir: string, id: string) =>
    isLocalInstalledPackage(pluginsRoot, dir, id)
      ? { fields: { source: 'local-unsigned' as const }, registration: {} }
      : { fields: { provenance: 'official-registry' as const }, registration: { official: true } }

  // A file install committed but not restarted yet (review LOW-6).
  const stagedLocalCandidate = (id: string): boolean => {
    const candidate = lifecycleSelector.read(id)?.candidate
    return candidate !== undefined && isLocalInstalledPackage(pluginsRoot, lifecycleSelector.packageDir(id, candidate), id)
  }

  // The installed inventory, shared by the Extensions page and the agent's
  // read-only `plugins_list_installed` (marketplace.query, B2-a).
  const listInstalledSummaries = (): InstalledSummary[] => {
    const summaries = new Map<
      string,
      {
        id: string
        requires: string[]
        packageVersion?: string
        manifestPermissions?: ManifestPermissionsSummary
        provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
        source?: PluginSource
        warning?: string
        enginesNavide?: string
      }
    >()
    for (const descriptor of manager.listDescriptors()) {
      const manifestPermissions = descriptor.capabilityPolicy?.kind === 'manifest-v2'
        ? {
            system: [...descriptor.capabilityPolicy.system],
            ...(descriptor.capabilityPolicy.shell
              ? { shell: descriptor.capabilityPolicy.shell }
              : {}),
          }
        : undefined
      summaries.set(descriptor.id, {
        id: descriptor.id,
        requires: [...descriptor.requires],
        ...(descriptor.packageVersion ? { packageVersion: descriptor.packageVersion } : {}),
        ...(manifestPermissions ? { manifestPermissions } : {}),
      })
    }
    for (const pkg of manager.listInstalledPackages()) summaries.set(pkg.id, pkg)
    // A first install has no selected descriptor yet, so project a staged
    // candidate into the inventory without treating that query result as an
    // activation authority. Restart independently re-verifies its package.
    for (const record of lifecycleSelector.list()) {
      if (!record.candidate || summaries.has(record.pluginId)) continue
      try {
        const staged = loadPluginDir(lifecycleSelector.packageDir(record.pluginId, record.candidate))
        if (staged.packageSummary) summaries.set(record.pluginId, staged.packageSummary)
      } catch {
        // A malformed candidate remains unavailable; its selector is not a grant.
      }
    }
    const optedIn = new Set(prereleases.list())
    return [...summaries.values()].map((summary) => {
      const candidate = lifecycleSelector.read(summary.id)?.candidate
      return {
      id: summary.id,
      requires: summary.requires,
      sensitive: sensitiveCapabilities(summary.requires),
      ...(summary.packageVersion ? { packageVersion: summary.packageVersion } : {}),
      ...(summary.manifestPermissions
        ? { manifestPermissions: copyManifestPermissionsSummary(summary.manifestPermissions) }
        : {}),
      ...(summary.packageVersion
        ? {
            packageVersionGrant: (() => {
              const grant = capabilityGrants.get(summary.id, summary.packageVersion)
              return grant
                ? {
                    packageVersion: grant.packageVersion,
                    system: [...grant.system],
                    ...(grant.shell ? { shell: grant.shell } : {}),
                    ...(grant.highRiskShellConfirmed !== undefined
                      ? { highRiskShellConfirmed: grant.highRiskShellConfirmed }
                      : {}),
                    ...(grant.storage !== undefined ? { storage: grant.storage } : {}),
                  }
                : null
            })(),
          }
        : {}),
      ...(summary.provenance ? { provenance: summary.provenance } : {}),
      ...sourceFields(summary),
      ...(summary.warning ? { warning: summary.warning } : {}),
      ...(candidate ? { pendingCandidateVersion: candidate.packageVersion } : {}),
      ...(() => {
        const floor = minNavideVersion(summary.enginesNavide)
        const compatible = isEngineCompatible(summary.enginesNavide, hostAppVersion())
        return floor !== null && compatible !== null
          ? { minNavideVersion: floor, engineCompatible: compatible }
          : {}
      })(),
      ...(summary.provenance === 'official-registry'
        ? { getsPrereleases: optedIn.has(summary.id) }
        : {}),
      ...(summary.provenance === 'official-registry' && manager.canDisablePlugin(summary.id)
        ? { disabled: disabledPlugins.has(summary.id) }
        : {}),
      ...(() => {
        const rollback = rollbackTargetFor(summary.id)
        if (!rollback) return {}
        return rollback.kind === 'factory'
          ? { rollbackKind: 'factory' as const }
          : { rollbackKind: 'previous' as const, rollbackToVersion: rollback.version }
      })(),
    }
    })
  }

  ipcMain.handle('plugins:listInstalled', (event): InstalledSummary[] => {
    assertAuthorized(event)
    return listInstalledSummaries()
  })

  ipcMain.handle('plugins:listContributions', (event) => {
    assertAuthorized(event)
    const installed = new Map(manager.listInstalledPackages().map((pkg) => [pkg.id, pkg] as const))
    return manager.listContributionCatalog().map(({ iconFile, ...entry }) => {
      const icon = iconFile ? options.resolveContributionIcon?.(iconFile) ?? null : null
      const pkg = installed.get(entry.pluginId)
      // Only the selected package's own record may label its views.
      const source = pkg && pkg.packageVersion === (entry.packageVersion ?? undefined)
        ? installedSource(pkg, activeRegistryChannel(pkg))
        : undefined
      return {
        ...entry,
        icon: icon?.url ?? null,
        // A silhouette is painted in the current text colour by the renderer,
        // so it follows the theme the way the built-in SVG icons do.
        iconMonochrome: icon?.monochrome ?? false,
        ...(source ? { source } : {}),
      }
    })
  })

  ipcMain.handle('plugins:listFactoryPackages', (event): FactoryPackageSummary[] => {
    assertAuthorized(event)
    return options.listFactoryPackages?.() ?? []
  })

  ipcMain.handle('plugins:backendCallConcurrency', (event): BackendCallConcurrency[] => {
    assertAuthorized(event)
    return options.backendCallConcurrency?.() ?? []
  })

  // Plan B D-f: one installed plugin's activity report. The Host fills
  // `declared` from the installed manifest (the backend has none) and asks the
  // backend over its authenticated session; the answer is rebuilt from
  // validated fields before it reaches the page. Read only.
  ipcMain.handle('plugins:activityReport', async (event, args: { id?: unknown } | null): Promise<
    { ok: true; report: PluginActivityReport } | { ok: false; error: string }
  > => {
    assertAuthorized(event)
    const id = typeof args?.id === 'string' ? args.id : ''
    if (!manager.listInstalledPackages().some((pkg) => pkg.id === id)) {
      return { ok: false, error: `${id || '(none)'} is not an installed Navide plugin` }
    }
    const disclosure = activeDisclosure(id)
    const declared = disclosure ? declaredForActivity(disclosure) : []
    try {
      // Sent only when known: an id installed before this was recorded has
      // none, and the backend then keeps its earlier behaviour (#373).
      const installedAt = installScans.installedAt(id)
      const report = parsePluginActivityReport(await manager.requestPluginActivityReport({
        plugin_id: id,
        declared,
        ...(installedAt !== null ? { installedAt } : {}),
      }))
      return report ? { ok: true, report } : { ok: false, error: 'the activity report was malformed' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // D-f disclosure overview: each installed Registry package's disclosure,
  // computed from its installed manifest, and the scan verified at install.
  ipcMain.handle('plugins:installedDisclosures', (event): Array<{
    id: string
    version: string
    disclosure: ManifestDisclosure | null
    scan: ScanReport | null
    source?: PluginSource
    expiresAt?: string
    hasViews?: boolean
  }> => {
    assertAuthorized(event)
    return manager.listInstalledPackages()
      .filter((pkg) => pkg.provenance === 'official-registry' && pkg.packageVersion)
      .map((pkg) => ({
        id: pkg.id,
        version: pkg.packageVersion!,
        disclosure: activeDisclosure(pkg.id),
        ...activeHasViews(pkg.id),
        scan: installScans.get(pkg.id, pkg.packageVersion!),
        ...sourceFields(pkg),
      }))
  })

  ipcMain.handle('plugins:backendResourceUsage', (event): BackendResourceUsage => {
    assertAuthorized(event)
    return options.backendResourceUsage?.() ?? { children: { current: 0, peak: 0, retained: 0 }, views: [], plugins: [] }
  })

  ipcMain.handle(
    'plugins:restoreFactoryPackage',
    async (event, args: { id?: unknown } | null) => {
      assertAuthorized(event)
      const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
      // Built-ins are never removed any more, so there is nothing to restore.
      if (isReservedPluginId(id)) throw new Error(`first-party plugin ${id} cannot be removed or restored`)
      if (!options.restoreFactoryPackage) throw new Error('factory package restore is unavailable')
      await options.restoreFactoryPackage(id)
      return { ok: true }
    }
  )

  // The Marketplace search, shared by the Marketplace page and the agent's
  // read-only `marketplace_search` (marketplace.query, B2-a).
  const marketplaceSearch = async (
      query?: string,
      sort?: string,
      options?: { category?: unknown; offset?: unknown; limit?: unknown; hideIncompatible?: unknown } | null
    ) => {
      const marketplace = resolveConfiguredMarketplace(trust)
      const appVersion = hostAppVersion()
      // Resolve relative to the base path: the Registry may be served under a
      // path prefix (the Official Registry lives at `/registry`).
      const url = new URL(`${marketplace.registryUrl.replace(/\/+$/, '')}/api/extensions`)
      if (query) url.searchParams.set('q', query)
      if (sort && MARKETPLACE_SORTS.has(sort)) url.searchParams.set('sort', sort)
      if (typeof options?.category === 'string' && MARKETPLACE_CATEGORY_RE.test(options.category)) {
        url.searchParams.set('category', options.category)
      }
      if (Number.isSafeInteger(options?.offset) && (options?.offset as number) > 0) {
        url.searchParams.set('offset', String(options?.offset))
      }
      if (Number.isSafeInteger(options?.limit) && (options?.limit as number) > 0) {
        url.searchParams.set('limit', String(Math.min(options?.limit as number, 100)))
      }
      // The Registry only needs the client release to filter; the per-item
      // verdict below is computed here from `engines_navide`.
      if (options?.hideIncompatible === true) {
        url.searchParams.set('navide_version', appVersion)
        url.searchParams.set('compatible_only', 'true')
      }
      const res = await fetch(url)
      if (!res.ok) throw new MarketplaceHttpError(`marketplace search failed: HTTP ${res.status}`, res.status)
      const body = (await res.json()) as { items?: Array<Record<string, unknown>> }
      // Target and engine compatibility are decided here, with the same rules
      // install uses, so the renderer never re-derives them. A Registry that
      // predates per-target artifacts sends no `latest_targets`; those stay
      // installable, and one without `engines_navide` reports compatibility
      // as unknown (null), which never blocks.
      const hostTarget = marketplace.trust.expectedTarget ?? currentPluginHostTarget()
      return {
        ...body,
        items: (body.items ?? []).map((item) => ({
          ...item,
          installable: Array.isArray(item.latest_targets)
            ? item.latest_targets.some((target) => isPluginTargetCompatible(target, hostTarget))
            : true,
          compatible: isEngineCompatible(item.engines_navide, appVersion),
          min_navide_version: minNavideVersion(item.engines_navide),
          app_version: appVersion,
          license: typeof item.license === 'string' ? item.license : null,
          repository: httpsLink(item.repository),
          homepage: httpsLink(item.homepage),
          icon_path: typeof item.icon_path === 'string' ? item.icon_path : null,
          // Plan B D1 list card: display data, kept only when well formed and
          // naming this item's package and latest version (as for the MCP card).
          ...listingDisclosure(item),
        })),
      }
    }

  ipcMain.handle(
    'plugins:marketplaceSearch',
    async (
      event,
      query?: string,
      sort?: string,
      options?: { category?: unknown; offset?: unknown; limit?: unknown; hideIncompatible?: unknown } | null
    ) => {
      assertAuthorized(event)
      return marketplaceSearch(query, sort, options)
    }
  )

  // The closed category list; a Registry that predates it yields none, and
  // the renderer then shows no category chips.
  ipcMain.handle('plugins:marketplaceCategories', async (event) => {
    assertAuthorized(event)
    const marketplace = resolveConfiguredMarketplace(trust)
    const res = await fetch(`${marketplace.registryUrl.replace(/\/+$/, '')}/api/categories`)
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`marketplace categories failed: HTTP ${res.status}`)
    const body = (await res.json()) as { items?: Array<Record<string, unknown>> }
    return (body.items ?? [])
      .filter((item) => typeof item.slug === 'string' && MARKETPLACE_CATEGORY_RE.test(item.slug))
      .map((item) => ({
        slug: item.slug as string,
        label: typeof item.label === 'string' ? item.label : (item.slug as string),
        count: typeof item.count === 'number' ? item.count : 0,
      }))
  })

  // Marketplace icons are display-only bytes that the signed package digest
  // does not cover on this path, so they are treated as untrusted: fetched
  // from the configured Registry origin only (no redirects), capped in size,
  // typed by magic bytes (raster only, never SVG) and handed to the renderer
  // as a data: URL for an <img>. Any failure yields null (letter placeholder).
  const iconCache = new Map<string, string | null>()
  ipcMain.handle(
    'plugins:marketplaceIcon',
    async (event, args: { namespace?: unknown; name?: unknown; version?: unknown; path?: unknown } | null) => {
      assertAuthorized(event)
      const namespace = marketplacePathSegment(args?.namespace)
      const name = marketplacePathSegment(args?.name)
      const version = args?.version
      const path = args?.path
      if (typeof version !== 'string' || compareSemver(version, version) !== 0) return null
      if (typeof path !== 'string' || path.length > 256 || !ICON_PATH_RE.test(path)) return null
      if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null
      const key = `${namespace}/${name}/${version}/${path}`
      if (iconCache.has(key)) return iconCache.get(key) ?? null
      const marketplace = resolveConfiguredMarketplace(trust)
      const encodedPath = path.split('/').map(encodeURIComponent).join('/')
      let dataUrl: string | null = null
      try {
        const res = await fetch(
          `${marketplace.registryUrl.replace(/\/+$/, '')}/extensions/${namespace}/${name}/${encodeURIComponent(version)}/assets/${encodedPath}`,
          { redirect: 'error' }
        )
        const declared = Number(res.headers.get('content-length') ?? '0')
        if (res.ok && declared <= MARKETPLACE_ICON_MAX_BYTES) {
          const bytes = await readBodyCapped(res, MARKETPLACE_ICON_MAX_BYTES)
          const mime = bytes ? sniffIconMime(bytes) : null
          if (bytes && mime) dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
        }
      } catch {
        dataUrl = null
      }
      if (iconCache.size >= 256) iconCache.clear()
      iconCache.set(key, dataUrl)
      return dataUrl
    }
  )

  // Raw CHANGELOG markdown of the latest version; rendered as text nodes.
  ipcMain.handle(
    'plugins:marketplaceChangelog',
    async (event, args: { namespace?: unknown; name?: unknown } | null) => {
      assertAuthorized(event)
      const namespace = marketplacePathSegment(args?.namespace)
      const name = marketplacePathSegment(args?.name)
      const marketplace = resolveConfiguredMarketplace(trust)
      const res = await fetch(
        `${marketplace.registryUrl.replace(/\/+$/, '')}/api/extensions/${namespace}/${name}/changelog`
      )
      if (!res.ok) throw new Error(`marketplace changelog failed: HTTP ${res.status}`)
      const body = (await res.json()) as { markdown?: unknown }
      return typeof body.markdown === 'string' ? body.markdown : null
    }
  )

  // Read-only detail for the Marketplace detail view. Trust metadata and
  // signed envelopes stay main-side: the renderer only needs display fields,
  // and install still re-fetches and verifies through prepareInstall.
  // Shared with the agent's read-only `marketplace_detail` (marketplace.query, B2-a).
  const marketplaceDetail = async (args: { namespace?: unknown; name?: unknown } | null) => {
      const namespace = marketplacePathSegment(args?.namespace)
      const name = marketplacePathSegment(args?.name)
      const marketplace = resolveConfiguredMarketplace(trust)
      const hostTarget = marketplace.trust.expectedTarget ?? currentPluginHostTarget()
      const appVersion = hostAppVersion()
      const getsPrereleases = prereleases.has(`${args?.namespace}.${args?.name}`)
      const base = `${marketplace.registryUrl.replace(/\/+$/, '')}/api/extensions/${namespace}/${name}`
      // Compatibility is computed here from each row's `engines_navide`, so
      // the Registry's own verdict (and its `navide_version` input) is unused.
      const res = await fetch(base)
      if (!res.ok) throw new MarketplaceHttpError(`marketplace detail failed: HTTP ${res.status}`, res.status)
      const detail = (await res.json()) as Record<string, unknown> & {
        versions?: Array<Record<string, unknown>>
      }
      // A Registry without the README endpoint (or a package without a
      // README) still yields a usable detail view.
      let readme: string | null = null
      try {
        const readmeRes = await fetch(`${base}/readme`)
        if (readmeRes.ok) {
          const body = (await readmeRes.json()) as { markdown?: unknown }
          if (typeof body.markdown === 'string') readme = body.markdown
        }
      } catch {
        readme = null
      }
      return {
        namespace: detail.namespace,
        name: detail.name,
        identity: detail.identity,
        display_name: detail.display_name ?? null,
        description: detail.description ?? null,
        categories: detail.categories ?? [],
        latest_version: detail.latest_version ?? null,
        updated_at: detail.updated_at ?? null,
        download_count: detail.download_count ?? 0,
        rating_average: detail.rating_average ?? 0,
        rating_count: detail.rating_count ?? 0,
        featured: detail.featured ?? false,
        publisher: detail.publisher ?? detail.namespace,
        host_target: hostTarget,
        app_version: appVersion,
        latest_installable_version: newestInstallableVersion(detail.versions ?? [], hostTarget, undefined, getsPrereleases),
        latest_compatible_version: newestInstallableVersion(
          detail.versions ?? [],
          hostTarget,
          appVersion,
          getsPrereleases
        ),
        latest_prerelease_version: typeof detail.latest_prerelease_version === 'string'
          ? detail.latest_prerelease_version
          : null,
        gets_prereleases: getsPrereleases,
        compatible: isEngineCompatible(detail.engines_navide, appVersion),
        min_navide_version: minNavideVersion(detail.engines_navide),
        license: typeof detail.license === 'string' ? detail.license : null,
        repository: httpsLink(detail.repository),
        homepage: httpsLink(detail.homepage),
        icon_path: typeof detail.icon_path === 'string' ? detail.icon_path : null,
        has_changelog: detail.has_changelog === true,
        extension_pack: Array.isArray(detail.extension_pack)
          ? detail.extension_pack.filter((member): member is string => typeof member === 'string')
          : null,
        versions: (detail.versions ?? []).map((v) => ({
          version: v.version,
          published_at: v.published_at,
          target: v.target,
          yanked: v.yanked,
          trust_tier: v.trust_tier,
          capabilities: v.capabilities ?? [],
          sensitive_capabilities: v.sensitive_capabilities ?? [],
          download_count: v.download_count ?? 0,
          installable: isPluginTargetCompatible(v.target, hostTarget),
          compatible: isEngineCompatible(v.engines_navide, appVersion),
          min_navide_version: minNavideVersion(v.engines_navide),
          channel: typeof v.version === 'string' && isPrereleaseVersion(v.version) ? 'pre-release' : 'stable',
          // Contract 3.4/3.5: shown before download, verified at prepareInstall.
          disclosure: jsonObjectOrNull(v.disclosure),
          scan: jsonObjectOrNull(v.scan),
          registry: jsonObjectOrNull(v.registry),
        })),
        readme,
      }
    }

  ipcMain.handle(
    'plugins:marketplaceDetail',
    async (event, args: { namespace?: unknown; name?: unknown } | null) => {
      assertAuthorized(event)
      return marketplaceDetail(args)
    }
  )

  // B2-a: the backend's read-only Marketplace MCP tools ask through the
  // authenticated Host session; the answer comes from the functions above.
  manager.setMarketplaceQueryHandler?.((query) =>
    answerMarketplaceQuery(query, {
      search: (text, searchOptions) => marketplaceSearch(text, undefined, searchOptions),
      detail: (namespace, name) => marketplaceDetail({ namespace, name }),
      installed: () =>
        listInstalledSummaries().map((summary) => ({
          id: summary.id,
          packageVersion: summary.packageVersion,
          disabled: summary.disabled,
          hasBackend: manager.installedPackageHasBackend(summary.id),
        })),
    })
  )

  // Update detection for installed Registry packages: compares each installed
  // version against the newest version this Host can install. Detection only —
  // installing the update goes through the normal prepareInstall/commitInstall
  // consent path. The last answer is kept for windows that open later.
  let pendingUpdates: PluginUpdateInfo[] = []
  // The update badge only: a malformed listing disclosure means no badge.
  const listedPermissionChange = (id: string, listed: unknown): 'more' | 'same' | undefined => {
    const from = activeDisclosure(id)
    if (!from || !jsonObjectOrNull(listed)) return undefined
    try {
      return diffDisclosure(from, listed as ManifestDisclosure).widened ? 'more' : 'same'
    } catch {
      return undefined
    }
  }
  const checkInstalledUpdates = async (): Promise<PluginUpdateInfo[]> => {
    const candidates = manager
      .listInstalledPackages()
      .filter((pkg) => pkg.provenance === 'official-registry' && pkg.packageVersion)
    if (candidates.length === 0) {
      pendingUpdates = []
      return pendingUpdates
    }
    const marketplace = resolveConfiguredMarketplace(trust)
    const base = marketplace.registryUrl.replace(/\/+$/, '')
    const hostTarget = marketplace.trust.expectedTarget ?? currentPluginHostTarget()
    const appVersion = hostAppVersion()
    const optedIn = new Set(prereleases.list())
    const checked = await Promise.all(
      candidates.map(async (pkg) => {
        const dot = pkg.id.indexOf('.')
        if (dot <= 0) return null
        const namespace = pkg.id.slice(0, dot)
        const name = pkg.id.slice(dot + 1)
        try {
          const res = await fetch(
            `${base}/api/extensions/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
          )
          if (!res.ok) return { failed: pkg.id, reason: `HTTP ${res.status}` }
          const detail = (await res.json()) as {
            versions?: Array<{
              version?: unknown
              target?: unknown
              yanked?: unknown
              engines_navide?: unknown
              disclosure?: unknown
              scan?: unknown
            }>
          }
          // D-f: a rescan of the installed version that found new items is
          // noticed once, from this same answer (no request of its own).
          try {
            const finding = rescanFinding(
              installScans.get(pkg.id, pkg.packageVersion!), detail.versions ?? [], pkg.packageVersion!, hostTarget
            )
            if (finding && installScans.noticeOnce(pkg.id, pkg.packageVersion!, finding.digest)) {
              rescanNotices.push({ id: pkg.id, version: pkg.packageVersion!, added: finding.added })
            }
          } catch (error) {
            console.warn(`[plugins] rescan check for ${pkg.id} failed: ${error instanceof Error ? error.message : String(error)}`)
          }
          // A stable user is never offered a pre-release. Switching the opt-in
          // off again never downgrades: a newer stable release is offered
          // once it exists.
          const latestVersion = newestInstallableVersion(
            detail.versions ?? [],
            hostTarget,
            appVersion,
            optedIn.has(pkg.id)
          )
          if (!latestVersion || !isUpdateAvailable(pkg.packageVersion!, latestVersion)) return null
          const permissionChange = listedPermissionChange(
            pkg.id,
            (detail.versions ?? []).find((row) => row.version === latestVersion && jsonObjectOrNull(row.disclosure))
              ?.disclosure
          )
          return {
            id: pkg.id,
            namespace,
            name,
            installedVersion: pkg.packageVersion!,
            latestVersion,
            ...(permissionChange ? { permissionChange } : {}),
          }
        } catch (error) {
          // One unreachable package must not hide updates for the others.
          return { failed: pkg.id, reason: error instanceof Error ? error.message : String(error) }
        }
      })
    )
    // A package the Registry did not answer for keeps its last known update
    // (while it is still newer than what is installed) instead of reading as
    // "up to date".
    const failures = checked.filter(
      (entry): entry is { failed: string; reason: string } => entry !== null && 'failed' in entry
    )
    const next: PluginUpdateInfo[] = []
    for (const [index, entry] of checked.entries()) {
      if (entry === null) continue
      if (!('failed' in entry)) {
        next.push(entry)
        continue
      }
      const pkg = candidates[index]
      const previous = pendingUpdates.find((update) => update.id === pkg.id)
      if (previous && isUpdateAvailable(pkg.packageVersion!, previous.latestVersion)) {
        next.push({ ...previous, installedVersion: pkg.packageVersion! })
      }
    }
    pendingUpdates = next
    // The merged answer is kept for `plugins:pendingUpdates`; the caller still
    // learns that the check was incomplete.
    if (failures.length > 0) {
      throw new Error(
        `update check failed for ${failures
          .map((failure) => `${failure.failed} (${failure.reason})`)
          .join(', ')}; their last known updates were kept`
      )
    }
    return pendingUpdates
  }

  // D2: the per-extension "Get pre-releases" switch, default off. Turning it
  // on or off only changes which versions count as candidates; nothing is
  // installed until the user runs the normal update/install flow.
  ipcMain.handle(
    'plugins:setPrerelease',
    async (event, args: { id?: unknown; enabled?: unknown } | null) => {
      assertAuthorized(event)
      if (!isValidManifestV2PluginId(args?.id)) throw new Error('invalid plugin id')
      if (typeof args?.enabled !== 'boolean') throw new Error('invalid pre-release setting')
      prereleases.set(args.id, args.enabled)
      return { id: args.id, enabled: args.enabled }
    }
  )

  /** Every plugin id this Host has installed, including staged candidates. */
  const installedPluginIds = (): Set<string> => {
    const ids = new Set<string>()
    for (const descriptor of manager.listDescriptors()) ids.add(descriptor.id)
    for (const pkg of manager.listInstalledPackages()) ids.add(pkg.id)
    for (const record of lifecycleSelector.list()) if (record.candidate) ids.add(record.pluginId)
    return ids
  }

  /** What installing each pack member would do, from the Registry listing.
   *  Display only: every member is still verified by prepareInstall before
   *  anything is written, and a member that is itself a pack is refused. */
  const resolvePackMembers = async (memberIds: readonly string[]): Promise<PackMemberSummary[]> => {
    const marketplace = resolveConfiguredMarketplace(trust)
    const base = marketplace.registryUrl.replace(/\/+$/, '')
    const hostTarget = marketplace.trust.expectedTarget ?? currentPluginHostTarget()
    const appVersion = hostAppVersion()
    const installed = installedPluginIds()
    const optedIn = new Set(prereleases.list())
    return Promise.all(
      memberIds.map(async (id): Promise<PackMemberSummary> => {
        const none: PackMemberSummary = {
          id,
          status: 'missing',
          display_name: null,
          version: null,
          capabilities: [],
          sensitive_capabilities: [],
          min_navide_version: null,
        }
        if (!isValidManifestV2PluginId(id)) return none
        const dot = id.indexOf('.')
        let detail: Record<string, unknown> & { versions?: Array<Record<string, unknown>> }
        try {
          const res = await fetch(
            `${base}/api/extensions/${encodeURIComponent(id.slice(0, dot))}/${encodeURIComponent(id.slice(dot + 1))}`
          )
          if (res.status === 404) return none
          if (!res.ok) return { ...none, status: 'error' }
          detail = (await res.json()) as typeof detail
        } catch {
          return { ...none, status: 'error' }
        }
        const versions = detail.versions ?? []
        const displayName = typeof detail.display_name === 'string' ? detail.display_name : null
        if (Array.isArray(detail.extension_pack) && detail.extension_pack.length > 0) {
          return { ...none, status: 'nested', display_name: displayName }
        }
        const pick = (version: string | null) =>
          versions.find((v) => v.version === version && !v.yanked && isPluginTargetCompatible(v.target, hostTarget))
        const compatibleVersion = newestInstallableVersion(versions, hostTarget, appVersion, optedIn.has(id))
        const targetVersion = newestInstallableVersion(versions, hostTarget, undefined, optedIn.has(id))
        const row = pick(compatibleVersion) ?? pick(targetVersion)
        const summary: PackMemberSummary = {
          ...none,
          display_name: displayName,
          version: typeof row?.version === 'string' ? row.version : null,
          capabilities: Array.isArray(row?.capabilities) ? (row.capabilities as string[]) : [],
          sensitive_capabilities: Array.isArray(row?.sensitive_capabilities)
            ? (row.sensitive_capabilities as string[])
            : [],
          min_navide_version: minNavideVersion(row?.engines_navide),
        }
        if (installed.has(id)) return { ...summary, status: 'installed' }
        if (targetVersion === null) return { ...summary, status: 'unavailable' }
        if (compatibleVersion === null) return { ...summary, status: 'incompatible' }
        return { ...summary, status: 'ready' }
      })
    )
  }

  // Pack detail: each member's name, version and permissions before install.
  ipcMain.handle('plugins:marketplacePackMembers', async (event, args: { members?: unknown } | null) => {
    assertAuthorized(event)
    const members = args?.members
    if (!Array.isArray(members) || members.length > MAX_EXTENSION_PACK_MEMBERS) {
      throw new Error('invalid extension pack members')
    }
    return resolvePackMembers(members.filter((id): id is string => typeof id === 'string'))
  })

  // D5: start a pack install. The pack package itself is downloaded and
  // verified like any Registry package, so its member list is the signed
  // one, but it is never written: the renderer then installs each "ready"
  // member through plugins:prepareInstall/commitInstall, each with its own
  // confirmation. A pack carries no permissions (Manifest v2 refuses them),
  // so it can never widen what a member is granted.
  ipcMain.handle(
    'plugins:preparePack',
    async (event, args: { namespace?: unknown; name?: unknown } | null) => {
      assertAuthorized(event)
      const namespace = marketplacePathSegment(args?.namespace)
      const name = marketplacePathSegment(args?.name)
      const packId = `${String(args?.namespace)}.${String(args?.name)}`
      if (!isValidManifestV2PluginId(packId)) throw new Error('invalid extension pack id')
      const marketplace = resolveConfiguredMarketplace(trust)
      const base = marketplace.registryUrl.replace(/\/+$/, '')
      const hostTarget = marketplace.trust.expectedTarget ?? currentPluginHostTarget()
      const detailRes = await fetch(`${base}/api/extensions/${namespace}/${name}`)
      if (!detailRes.ok) throw new Error(`extension not found: HTTP ${detailRes.status}`)
      const detail = (await detailRes.json()) as { display_name?: unknown; versions?: Array<Record<string, unknown>> }
      const version = newestInstallableVersion(
        detail.versions ?? [],
        hostTarget,
        hostAppVersion(),
        prereleases.has(packId)
      )
      if (!version) throw new Error(`no installable version of ${packId} found`)
      const verified = await verifyRegistryPackage({
        namespace: String(args?.namespace),
        name: String(args?.name),
        version,
      })
      const members = isManifestV2(verified.manifest) ? verified.manifest.extensionPack : undefined
      if (!members) throw new Error(`${packId} is not an extension pack`)
      const displayName = typeof detail.display_name === 'string' ? detail.display_name : null
      packSessions.set(packId, {
        version: verified.version,
        displayName,
        members: [...members],
        preInstalled: installedPluginIds(),
      })
      return {
        id: packId,
        version: verified.version,
        display_name: displayName,
        trustTier: verified.trustTier,
        publisherId: verified.publisherId,
        members: await resolvePackMembers(members),
      }
    }
  )

  // End a pack install (finished, or cancelled part-way): record the pack
  // when any member is installed, remembering which members this pack
  // installed. Members already installed before the flow are never counted.
  ipcMain.handle('plugins:finishPack', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    const id = args?.id
    if (!isValidManifestV2PluginId(id)) throw new Error('invalid extension pack id')
    const session = packSessions.get(id)
    if (!session) throw new Error(`no extension pack install in progress for ${id}`)
    packSessions.delete(id)
    const installed = installedPluginIds()
    const previous = packs.get(id)
    const installedByPack = session.members.filter(
      (member) =>
        installed.has(member) &&
        (!session.preInstalled.has(member) || previous?.installedByPack.includes(member) === true)
    )
    if (!session.members.some((member) => installed.has(member))) {
      return { recorded: false }
    }
    const record: InstalledPackRecord = {
      id,
      ...(session.displayName ? { displayName: session.displayName } : {}),
      version: session.version,
      members: session.members,
      installedByPack,
    }
    packs.put(record)
    return { recorded: true, pack: record }
  })

  ipcMain.handle('plugins:listPacks', (event): InstalledPackRecord[] => {
    assertAuthorized(event)
    const installed = installedPluginIds()
    const all = packs.list()
    // A member the user already removed on its own, or that another installed
    // pack still uses, is not offered.
    return all.map((pack) => ({ ...pack, installedByPack: packOnlyMembers(pack, all, installed) }))
  })

  // D8: uninstalling a pack removes the pack record and only the members the
  // user chose. The Host removes those members itself, so no caller can take
  // out a member this pack did not install or another pack still uses.
  ipcMain.handle('plugins:removePack', async (event, args: { id?: unknown; members?: unknown } | null) => {
    assertAuthorized(event)
    const id = args?.id
    if (!isValidManifestV2PluginId(id)) throw new Error('invalid extension pack id')
    const members = args?.members ?? []
    if (!Array.isArray(members) || !members.every(isValidManifestV2PluginId)) {
      throw new Error('invalid extension pack members')
    }
    const all = packs.list()
    const pack = all.find((record) => record.id === id)
    const removable = pack ? packOnlyMembers(pack, all, installedPluginIds()) : []
    const refused = members.find((member) => !removable.includes(member))
    if (refused) throw new Error(`${refused} is not removable with ${id}`)
    for (const member of new Set(members)) await uninstallPlugin(member)
    return { removed: packs.remove(id) !== null }
  })

  ipcMain.handle('plugins:checkUpdates', async (event) => {
    assertAuthorized(event)
    return checkInstalledUpdates()
  })

  ipcMain.handle('plugins:pendingUpdates', (event) => {
    assertAuthorized(event)
    return pendingUpdates
  })

  /** Download and verify one Registry package (digest, Registry signature,
   *  trust metadata, target and engine) without writing anything. */
  const verifyRegistryPackage = async (args: {
    namespace: string
    name: string
    version?: string
  }): Promise<PreparedInstall & { registryFacts: Record<string, unknown> | null }> => {
    const marketplace = resolveConfiguredMarketplace(trust)
    const base = marketplace.registryUrl.replace(/\/+$/, '')
    const detailRes = await fetch(`${base}/api/extensions/${args.namespace}/${args.name}`)
    if (!detailRes.ok) throw new Error(`extension not found: HTTP ${detailRes.status}`)
    const detail = (await detailRes.json()) as {
      latest_version: string | null
      trust_metadata: RegistryTrustMetadata
      trust_metadata_signature: string
      versions: Array<{
        version: string
        package_digest: string
        target: string
        registry_envelope: RegistryPackageEnvelope
        registry_signature: string
        trust_tier: string
        yanked: boolean
        engines_navide?: string | null
        disclosure?: unknown
        disclosure_envelope?: unknown
        disclosure_signature?: unknown
        scan?: unknown
        registry?: unknown
      }>
    }
    const wanted = args.version ?? detail.latest_version
    const artifacts = detail.versions.filter((v) => v.version === wanted && !v.yanked)
    if (artifacts.length === 0) throw new Error(`no installable version ${wanted ?? '(latest)'} found`)
    // One row per target artifact: take this Host's platform build, else the
    // universal one.
    const versionRow = selectPluginArtifact(
      artifacts,
      marketplace.trust.expectedTarget ?? currentPluginHostTarget()
    )
    // Engine compatibility is checked before anything is downloaded, from
    // the listing, and again below on the verified manifest itself.
    const appVersion = hostAppVersion()
    assertEngineCompatible(
      `${args.namespace}.${args.name}`,
      versionRow.version,
      { engines: { navide: versionRow.engines_navide ?? undefined } },
      appVersion
    )

    // The selected Registry envelope and current root-signed trust metadata
    // are verified against the Host-owned root pin before any install write.
    const result = await prepareInstall({
      registryUrl: marketplace.registryUrl,
      namespace: args.namespace,
      name: args.name,
      version: versionRow.version,
      expectedDigest: versionRow.package_digest,
      target: versionRow.target,
      registryEnvelope: versionRow.registry_envelope,
      registrySignature: versionRow.registry_signature,
      trustMetadata: detail.trust_metadata,
      trustMetadataSignature: detail.trust_metadata_signature,
      claimedTrustTier: versionRow.trust_tier,
      disclosure: versionRow.disclosure,
      disclosureEnvelope: versionRow.disclosure_envelope,
      disclosureSignature: versionRow.disclosure_signature,
      scan: versionRow.scan,
      provenance: 'official-registry',
    }, undefined, marketplace.trust)
    assertEngineCompatible(result.id, result.version, result.manifest, appVersion)
    // The `registry` facts are unsigned Registry information (contract 3.4).
    return { ...result, registryFacts: jsonObjectOrNull(versionRow.registry) }
  }

  ipcMain.handle(
    'plugins:prepareInstall',
    async (event, args: { namespace: string; name: string; version?: string }) => {
      assertAuthorized(event)
      const result = await verifyRegistryPackage(args)
      assertNoDeveloperFolder(result.id)
      // A pack is never installed as a package: its members are installed one
      // by one through plugins:preparePack and the ordinary install flow.
      if (isManifestV2(result.manifest) && result.manifest.extensionPack) {
        throw new Error(`${result.id} is an extension pack; install it from its Marketplace page`)
      }
      prepared.set(result.id, { pkg: result })
      const disclosureDiff = updateDisclosureDiff(result)
      // Declared agent tools, for the trust dialog; absent when there are none.
      const agentTools = isManifestV2(result.manifest) ? computeDisclosure(result.manifest).agentTools : []
      // From the envelope verifyRegistryPackageTrust just verified, never a file.
      const source = result.registryEvidence
        ? pluginSourceFromLegacyProvenance(
            'official-registry',
            isPrereleaseVersion(result.version),
            result.registryEvidence.receipt.envelope.channel
          )
        : undefined
      return {
        id: result.id,
        version: result.version,
        trustTier: result.trustTier,
        sensitive: result.sensitive,
        containsBackendExecutable: result.containsBackendExecutable,
        hasViews: manifestHasViews(result.manifest),
        ...(agentTools.length > 0 ? { agentTools } : {}),
        requiresConfirmation: result.requiresConfirmation,
        publisherId: result.publisherId,
        requiresPublisherTrust:
          result.registryEvidence !== undefined &&
          !result.official &&
          !publisherTrust.isTrusted(result.publisherId, result.id),
        // Asked exactly as before D-d (user ruling 2026-10-17, option B): the
        // diff is shown in the dialog, never used to skip the confirmation.
        requiresRiskConfirmation: result.requiresConfirmation,
        disclosureDiff,
        disclosure: result.disclosure ?? null,
        scan: result.scan ?? null,
        registry: result.registryFacts,
        ...(source ? { source } : {}),
        // D7: a Marketplace install over a local one asks first.
        ...(() => {
          const local = installedLocalPackage(result.id)
          return local
            ? { replacesLocal: { version: local.packageVersion ?? null }, ...backendDataOnReplace(result.id, 'marketplace') }
            : stagedLocalCandidate(result.id)
              ? { replacesLocal: { version: lifecycleSelector.read(result.id)?.candidate?.packageVersion ?? null } }
              : manager.listInstalledPackages().some((pkg) => pkg.id === result.id)
                ? {}
                : backendDataOnReplace(result.id, 'marketplace')
        })(),
      }
    }
  )

  /** Manifest v1 packages carry no activation to stage, so they keep the mutable
   *  install path: the verified package is written into `<pluginsRoot>/<id>` and
   *  registered immediately, with no restart. That path revokes the previous
   *  version before writing, so its failure path restores the captured runtime
   *  state (summary, descriptor, grant, backend activation). Manifest v2
   *  installs are staged as an immutable candidate and promoted on restart. */
  const commitLegacyInstall = async (
    pkg: PreparedInstall,
    publisherRequiresTrust: boolean,
    commitTrust: InstallerTrustConfig
  ): Promise<{ id: string; requires: string[] }> => {
    const previousSummary = manager.listInstalledPackages().find((item) => item.id === pkg.id)
    const previousDescriptor = manager.getDescriptor(pkg.id)
    const previousGrant = previousDescriptor?.packageVersion
      ? capabilityGrants.get(pkg.id, previousDescriptor.packageVersion)
      : null
    const previousActivation =
      previousSummary?.provenance === 'official-registry'
        ? loadPluginDir(join(pluginsRoot, pkg.id)).activation
        : undefined
    const previousArtifactDigest = previousActivation
      ? (() => {
          try {
            return sha256Hex(
              new Uint8Array(
                readFileSync(join(pluginsRoot, pkg.id, REGISTRY_ARTIFACT_NAME))
              )
            )
          } catch {
            return undefined
          }
        })()
      : undefined
    const previousPackageVersion = installedPackageVersion(manager, pluginsRoot, pkg.id)
    const previousBackend = previousPackageVersion
      ? manager.getBackendActivation(pkg.id, previousPackageVersion)
      : undefined
    let transaction: ReturnType<typeof commitInstallTransaction> | undefined
    let publisherConsentPersisted = false
    try {
      if (previousPackageVersion) {
        await manager.revokePackageVersion(pkg.id, previousPackageVersion)
      }
      transaction = commitInstallTransaction(pkg, pluginsRoot)
      const descriptor = transaction.descriptor
      if (pkg.registryEvidence) {
        const decision = verifyCommittedInstall(join(pluginsRoot, pkg.id), pkg.id, commitTrust)
        if (decision.action === 'quarantine') {
          throw new Error(`installed plugin quarantined: ${decision.reason}`)
        }
      }
      const summary = manifestToInstalledPackageSummary(pkg.manifest, pkg.provenance)
      // `official` was earned in prepareInstall (Host-authorized Official
      // Registry check); it is what allows a verified `navide.` install to
      // claim its reserved id.
      options.onActivationChange?.({ pluginId: pkg.id })
      manager.registerInstalledPackage(summary, descriptor, { official: pkg.official })
      capabilityGrants.remove(pkg.id)
      if (publisherRequiresTrust) {
        publisherTrust.trust(pkg.publisherId, pkg.id)
        publisherConsentPersisted = true
      }
      options.onPackageInstalled?.(pkg.id)
      // The v1 package now owns `<pluginsRoot>/<id>`; its atomic write moved any
      // staged/active v2 candidate aside, so the selection record must not keep
      // pointing at a directory this install replaced.
      lifecycleSelector.clear(pkg.id)
      transaction.finalize()
      return { id: pkg.id, requires: summary.requires }
    } catch (error) {
      if (publisherConsentPersisted) {
        try {
          publisherTrust.revoke(pkg.publisherId, pkg.id)
        } catch {
          // Preserve the original install failure if consent cleanup fails.
        }
      }
      try {
        // Drain a candidate activated earlier in this transaction before
        // restoring files underneath its launch specification.
        if (manager.hasBackendActivation(pkg.id, pkg.version)) {
          await manager.revokePackageVersion(pkg.id, pkg.version)
        }
        transaction?.rollback()
      } catch (rollbackError) {
        cleanupFailedPluginInstall(manager, options.onActivationChange, pkg.id)
        throw new AggregateError([error, rollbackError], 'Plugin install and rollback failed; runtime remains unavailable.')
      }
      cleanupFailedPluginInstall(manager, options.onActivationChange, pkg.id)
      try {
        if (previousGrant) capabilityGrants.set(pkg.id, previousGrant)
        else capabilityGrants.remove(pkg.id)
      } catch (grantError) {
        throw new AggregateError([error, grantError], 'Plugin install and grant restoration failed; runtime remains unavailable.')
      }
      // Each restoration step is gated on the state it actually replaces: the
      // package summary restores the package, the captured activation restores
      // the backend. A Host can hold a descriptor and an approved backend
      // without an installed-package summary, and that backend must still come
      // back after the revocation this transaction performed.
      try {
        let restoredFactoryActivation: PluginActivationCatalogEntry | undefined
        if (previousSummary) {
          if (previousSummary.provenance === 'factory-bundled' && previousDescriptor?.packageDir) {
            const restored = manager.loadFactoryPlugin(previousDescriptor.packageDir, pkg.id)
            if (!restored.loaded) throw new Error(`Factory package restoration failed: ${restored.reason}`)
            restoredFactoryActivation = restored.activation
          } else {
            manager.registerInstalledPackage(
              previousSummary,
              previousDescriptor,
              { official: previousSummary.provenance === 'official-registry' }
            )
          }
        } else if (previousBackend && previousDescriptor) {
          // Without a summary there is no package registration to carry the
          // descriptor back, and cleanupFailedPluginInstall dropped it. A
          // backend activation is refused without its matching descriptor, so
          // put back the one this Host held before the install. `builtin`
          // records that the Host call site, not package data, is the identity
          // source — as it was for the original registration.
          manager.registerDescriptor(previousDescriptor, { builtin: true })
        }
        if (previousBackend && !manager.hasBackendActivation(pkg.id, previousBackend.packageVersion)) {
          manager.registerBackendActivation(previousBackend)
        }
        if (restoredFactoryActivation) options.onActivationChange?.({ pluginId: pkg.id, activation: restoredFactoryActivation })
        if (previousSummary?.provenance === 'official-registry') {
          if (previousActivation && previousArtifactDigest) {
            const activation = {
              ...previousActivation,
              provenance: 'official-registry' as const,
              artifactDigest: previousArtifactDigest,
            }
            options.onActivationChange?.({ pluginId: pkg.id, activation })
          }
        }
      } catch (restoreError) {
        cleanupFailedPluginInstall(manager, options.onActivationChange, pkg.id)
        throw new AggregateError([error, restoreError], 'Plugin install and runtime restoration failed.')
      }
      throw error
    }
  }

  ipcMain.handle(
    'plugins:commitInstall',
    async (
      event,
      args: { id: string; publisherConfirmed?: boolean; riskConfirmed?: boolean; replaceConfirmed?: boolean; reattachBackendData?: boolean }
    ) => {
      assertAuthorized(event)
      assertNoDeveloperFolder(args.id)
      // D7: never replace a local install with the Marketplace version unasked.
      if (installedLocalPackage(args.id) && args.replaceConfirmed !== true) {
        throw new Error(`replacing the local file version of ${args.id} requires confirmation`)
      }
      if (installedLocalPackage(args.id)) rememberReattach(args.id, 'marketplace', args.reattachBackendData)
      if (activeTransactions.has(args.id)) {
        throw new Error(`plugin transaction already in progress for ${args.id}`)
      }
      const pending = prepared.get(args.id)
      if (!pending) throw new Error(`no prepared install for ${args.id}; call prepareInstall first`)
      const { pkg } = pending
      // Re-resolve Host-owned trust at commit time. Prepare-time evidence is
      // retained for the transaction, but expiry, root approval, and target
      // policy must not be frozen across the renderer confirmation round trip.
      const commitTrust = resolveConfiguredMarketplace(trust).trust
      const publisherRequiresTrust =
        pkg.registryEvidence !== undefined &&
        !pkg.official &&
        !publisherTrust.isTrusted(pkg.publisherId, pkg.id)
      if (publisherRequiresTrust && args.publisherConfirmed !== true) {
        throw new Error(`publisher trust confirmation is required for ${pkg.publisherId}`)
      }
      if (pkg.requiresConfirmation && args.riskConfirmed !== true) {
        throw new Error(`capability and backend risk confirmation is required for ${args.id}`)
      }
      // Commit deliberately stages only. It never drains the selected package,
      // registers a candidate descriptor, or changes a production grant.
      activeTransactions.add(pkg.id)
      prepared.delete(args.id)
      try {
        // Manifest v1 packages have no activation to stage, so they keep the
        // mutable install path; v2 installs are staged immutably below.
        if (!isManifestV2(pkg.manifest)) {
          return await commitLegacyInstall(pkg, publisherRequiresTrust, commitTrust)
        }
        const staged = stageInstallCandidate(pkg, pluginsRoot)
        const scanned = loadPluginDir(staged.candidateDir)
        if (scanned.error) throw new Error(`staged candidate is invalid: ${scanned.error}`)
        if (!scanned.activation || !scanned.packageSummary) {
          throw new Error('immutable activation requires a Manifest v2 candidate')
        }
        const decision = verifyCommittedInstall(staged.candidateDir, pkg.id, commitTrust)
        if (decision.action === 'quarantine') {
          throw new Error(`staged candidate quarantined: ${decision.reason}`)
        }
        const activation: PluginActivationCatalogEntry = {
          ...scanned.activation,
          provenance: 'official-registry',
          artifactDigest: decision.artifactDigest,
        }
        if (scanned.descriptor) {
          if (!options.preflightCandidateFrontend) {
            throw new Error('candidate frontend preflight is unavailable')
          }
          await options.preflightCandidateFrontend(scanned.descriptor)
        }
        if (activation.backend) {
          if (!options.preflightCandidateBackend) {
            throw new Error('candidate backend preflight is unavailable')
          }
          await options.preflightCandidateBackend(activation)
        }
        const candidate: PluginPackageSelection = {
          packageVersion: pkg.version,
          target: staged.target,
          artifactDigest: decision.artifactDigest,
        }
        let candidateGrant: HostCapabilityGrant
        if (scanned.descriptor) {
          const policy = scanned.descriptor.capabilityPolicy
          if (!policy || policy.kind !== 'manifest-v2') {
            throw new Error('invalid Manifest v2 capability policy')
          }
          candidateGrant = {
            packageVersion: candidate.packageVersion,
            system: [...policy.system],
            ...(policy.shell ? { shell: policy.shell } : {}),
            ...(policy.shell === 'full' && args.riskConfirmed === true
              ? { highRiskShellConfirmed: true as const }
              : {}),
            storage: true,
          }
        } else {
          candidateGrant = { packageVersion: candidate.packageVersion, system: [], storage: true }
        }
        lifecycleSelector.stageCandidate(pkg.id, candidate, {
          candidateGrant: { selection: candidate, grant: candidateGrant },
        })
        try {
          if (pkg.scan) installScans.record(pkg.id, pkg.version, pkg.scan)
          const kept = lifecycleSelector.read(pkg.id)
          installScans.keepVersions(pkg.id, [kept?.active, kept?.previous, kept?.candidate]
            .filter((selection) => selection !== undefined && selection !== null)
            .map((selection) => selection!.packageVersion))
        } catch (error) {
          console.warn(`[plugins] install scan record for ${pkg.id} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (publisherRequiresTrust) {
          publisherTrust.trust(pkg.publisherId, pkg.id)
        }
        return {
          id: pkg.id,
          requires: scanned.packageSummary.requires,
          restartRequired: true,
        }
      } finally {
        activeTransactions.delete(pkg.id)
      }
    }
  )

  // DX report A1 (card K3): install a `.vsix` the user picked in this window.
  // The file comes only from the Host's own dialog; the call takes no
  // arguments, so neither a plugin, an agent nor the environment can name
  // one. The file is read once, here; every later step uses those bytes.
  // MED-1 on #425: fetch the root-signed takedown list before a file install,
  // so a Host that never stored one still checks it. Any failure leaves the
  // stored list as it was; the dialog then says the check could not be done.
  const refreshTakedownList = async (): Promise<void> => {
    try {
      const marketplace = resolveConfiguredMarketplace(trust)
      const base = marketplace.registryUrl.replace(/\/+$/, '')
      const listing = await fetch(`${base}/api/extensions?limit=1`)
      if (!listing.ok) return
      const item = ((await listing.json()) as { items?: Array<Record<string, unknown>> }).items?.[0]
      if (typeof item?.namespace !== 'string' || typeof item.name !== 'string') return
      const res = await fetch(`${base}/api/extensions/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.name)}`)
      if (!res.ok) return
      const detail = (await res.json()) as { trust_metadata: RegistryTrustMetadata; trust_metadata_signature: string }
      verifyRegistryTrustMetadata(
        detail.trust_metadata,
        detail.trust_metadata_signature,
        marketplace.trust.pinnedRegistryRootKey,
        marketplace.trust.now,
      )
      const snapshot = {
        schemaVersion: 1 as const,
        metadata: detail.trust_metadata,
        metadataSignature: detail.trust_metadata_signature,
      }
      let stored: Uint8Array | null = null
      try {
        stored = new Uint8Array(readFileSync(join(pluginsRoot, REGISTRY_TRUST_SNAPSHOT_NAME)))
      } catch {
        stored = null
      }
      assertRegistryTrustSnapshotDoesNotRollback(stored, snapshot)
      writeRegistryTrustSnapshot(pluginsRoot, snapshot)
    } catch (error) {
      console.warn(`[plugins] takedown list not refreshed before a file install: ${errorText(error)}`)
    }
  }

  ipcMain.handle('plugins:installFromFile', async (event) => {
    assertAuthorized(event)
    const pickFile = options.pickLocalPackageFile
    if (!pickFile) throw new Error('installing from a file is unavailable')
    const path = await pickFile(event)
    if (!path) return null
    // Review LOW-1: only a regular file is read (never a FIFO or a device).
    if (!statSync(path).isFile()) throw new Error('the chosen path is not a regular file')
    const bytes = new Uint8Array(readFileSync(path))
    await refreshTakedownList()
    const marketplace = resolveConfiguredMarketplace(trust)
    const pkg = prepareLocalInstall(bytes, {
      pinnedRegistryRootKey: marketplace.trust.pinnedRegistryRootKey,
      trustSnapshot: readRegistryTrustSnapshot(pluginsRoot),
      expectedTarget: marketplace.trust.expectedTarget,
    })
    if (isManifestV2(pkg.manifest) && pkg.manifest.extensionPack) {
      throw new Error(`${pkg.id} is an extension pack; packs install only from the Marketplace`)
    }
    assertNoDeveloperFolder(pkg.id)
    assertEngineCompatible(pkg.id, pkg.version, pkg.manifest, hostAppVersion())
    preparedLocal.set(pkg.id, pkg)
    const replaced = manager.listInstalledPackages().find((item) => item.id === pkg.id)
    const agentTools = isManifestV2(pkg.manifest) ? computeDisclosure(pkg.manifest).agentTools : []
    return {
      id: pkg.id,
      version: pkg.version,
      trustTier: pkg.trustTier,
      sensitive: pkg.sensitive,
      containsBackendExecutable: pkg.containsBackendExecutable,
      hasViews: manifestHasViews(pkg.manifest),
      ...(agentTools.length > 0 ? { agentTools } : {}),
      requiresConfirmation: true,
      publisherId: pkg.publisherId,
      requiresPublisherTrust: false,
      requiresRiskConfirmation: true,
      disclosureDiff: updateDisclosureDiff(pkg),
      disclosure: pkg.disclosure ?? null,
      scan: null,
      registry: null,
      source: pkg.source,
      digest: pkg.digest,
      takedownChecked: pkg.takedownChecked === true,
      ...(replaced
        ? {
            replaces: {
              version: replaced.packageVersion ?? null,
              source: replaced.source === 'local-unsigned' ? 'local-unsigned' : 'marketplace',
            },
            ...backendDataOnReplace(pkg.id, 'local-unsigned'),
          }
        : backendDataOnReplace(pkg.id, 'local-unsigned')),
    }
  })

  ipcMain.handle(
    'plugins:commitLocalInstall',
    async (event, args: { id?: unknown; riskConfirmed?: unknown; replaceConfirmed?: unknown; reattachBackendData?: unknown } | null) => {
      assertAuthorized(event)
      const id = typeof args?.id === 'string' ? args.id : ''
      const pkg = preparedLocal.get(id)
      if (!pkg) throw new Error(`no prepared local install for ${id}; choose the file again`)
      assertNoDeveloperFolder(id)
      if (activeTransactions.has(id)) {
        throw new Error(`plugin transaction already in progress for ${id}`)
      }
      // Unreviewed code: consent is always required, whatever it declares.
      if (args?.riskConfirmed !== true) {
        throw new Error(`consent is required to install ${id} from a file`)
      }
      // D7: replacing an installed package of the same id is asked first.
      const installedNow = manager.listInstalledPackages().some((item) => item.id === id) ||
        lifecycleSelector.read(id)?.active !== undefined
      if (installedNow && args?.replaceConfirmed !== true) {
        throw new Error(`replacing the installed ${id} with the file version requires confirmation`)
      }
      rememberReattach(id, 'local-unsigned', args?.reattachBackendData)
      const commitTrust = resolveConfiguredMarketplace(trust).trust
      activeTransactions.add(id)
      preparedLocal.delete(id)
      const candidateRecord = localTrustRecordPath(pluginsRoot, id, 'candidate')
      try {
        const staged = stageInstallCandidate(pkg, pluginsRoot)
        const scanned = loadPluginDir(staged.candidateDir)
        if (scanned.error) throw new Error(`staged candidate is invalid: ${scanned.error}`)
        if (!scanned.activation || !scanned.packageSummary) {
          throw new Error('immutable activation requires a Manifest v2 candidate')
        }
        // The consent covers exactly the copy just written under the plugins
        // root, never the file the user picked (which may change later).
        const record = createLocalTrustRecord(staged.candidateDir, { source: 'file', consentedAt: new Date().toISOString() })
        // Review LOW-2: the record must cover exactly the bytes read from the
        // chosen file, not whatever the staged directory holds by now.
        const expected = new Map(pkg.entries
          .filter((entry) => entry.type === 'regular')
          .map((entry) => [canonicalArchivePath(entry.path, 'regular'), sha256Hex(entry.data)] as const))
        const recorded = Object.entries(record.fileDigests)
        if (recorded.length !== expected.size || recorded.some(([path, digest]) => expected.get(path) !== digest)) {
          throw new Error(`the staged copy of ${id} does not match the chosen file`)
        }
        writeLocalTrustRecord(candidateRecord, record)
        const decision = verifyCommittedInstall(staged.candidateDir, id, commitTrust)
        if (decision.action === 'quarantine') {
          throw new Error(`staged candidate refused: ${decision.reason}`)
        }
        const activation: PluginActivationCatalogEntry = {
          ...scanned.activation,
          source: 'local-unsigned',
          artifactDigest: decision.artifactDigest,
        }
        if (scanned.descriptor) {
          if (!options.preflightCandidateFrontend) {
            throw new Error('candidate frontend preflight is unavailable')
          }
          await options.preflightCandidateFrontend(scanned.descriptor)
        }
        if (activation.backend) {
          if (!options.preflightCandidateBackend) {
            throw new Error('candidate backend preflight is unavailable')
          }
          await options.preflightCandidateBackend(activation)
        }
        const candidate: PluginPackageSelection = {
          packageVersion: pkg.version,
          target: staged.target,
          artifactDigest: decision.artifactDigest,
        }
        // The same version-bound grant a Registry candidate gets; it only
        // takes effect when the user restarts the package.
        let candidateGrant: HostCapabilityGrant
        if (scanned.descriptor) {
          const policy = scanned.descriptor.capabilityPolicy
          if (!policy || policy.kind !== 'manifest-v2') {
            throw new Error('invalid Manifest v2 capability policy')
          }
          candidateGrant = {
            packageVersion: candidate.packageVersion,
            system: [...policy.system],
            ...(policy.shell ? { shell: policy.shell } : {}),
            ...(policy.shell === 'full' ? { highRiskShellConfirmed: true as const } : {}),
            storage: true,
          }
        } else {
          candidateGrant = { packageVersion: candidate.packageVersion, system: [], storage: true }
        }
        lifecycleSelector.stageCandidate(id, candidate, {
          candidateGrant: { selection: candidate, grant: candidateGrant },
        })
        return { id, requires: scanned.packageSummary.requires, restartRequired: true }
      } catch (error) {
        try {
          forgetLocalTrustRecords(pluginsRoot, id, ['candidate'])
        } catch {
          // The install failure stays the reported error.
        }
        throw error
      } finally {
        activeTransactions.delete(id)
      }
    }
  )

  // ---- Card K4 (DX report A2): Developer Mode and developer folders ----
  // The switch lives in a main-process file; only this window's settings page
  // changes it, and every change is audited in the plugin activity log. With
  // it on, the user may load a folder they pick in the Host dialog: it is not
  // reviewed, its content may change at any time, and its consent is bound to
  // the folder and its declared permissions and backend.
  const developerMode = new PluginDeveloperModeStore(pluginsRoot)
  const developerModeOn = (): boolean =>
    pluginDeveloperModeEnabled(process.env, app.isPackaged, developerMode.isEnabled())
  const preparedFolders = new Map<string, { dir: string; permissionsDigest: string }>()

  /** What the consent dialog shows for a developer folder, from its manifest. */
  const describeFolder = (dir: string): {
    pluginId: string
    permissionsDigest: string
    summary: Record<string, unknown>
  } => {
    const scanned = loadPluginDir(dir)
    if (scanned.error) throw new Error(scanned.error)
    const manifest = parseInstalledManifest(parseManifestJson(readFileSync(join(dir, 'manifest.json'), 'utf8')))
    if (!isManifestV2(manifest) || !scanned.activation) {
      throw new Error('DEVELOPER_FOLDER_V2_ONLY: Developer Mode loads Manifest v2 folders only')
    }
    if (isReservedPluginId(manifest.id)) {
      throw new Error(`DEVELOPER_FOLDER_RESERVED_ID [${manifest.id}]: Developer Mode cannot claim reserved plugin id '${manifest.id}'`)
    }
    // Review MED-1 on #428: the root-signed takedown list applies to a
    // folder as to a file, on every load, reload and start.
    const takedown = localTakedownDecision(manifest, {
      pinnedRootKey: resolveConfiguredMarketplace(trust).trust.pinnedRegistryRootKey,
      snapshot: readRegistryTrustSnapshot(pluginsRoot),
    })
    if (takedown.action === 'blocked') {
      throw new Error(`DEVELOPER_FOLDER_TAKEN_DOWN [${manifest.id}]: ${takedown.reason}`)
    }
    const disclosure = computeDisclosure(manifest as unknown as DisclosureManifestInput)
    const permissionsDigest = developerPermissionsDigest(manifest)
    return {
      pluginId: manifest.id,
      permissionsDigest,
      summary: {
        id: manifest.id,
        version: manifest.version,
        trustTier: 'unsigned',
        sensitive: sensitiveCapabilities(manifestCapabilities(manifest)),
        containsBackendExecutable: manifest.backend !== undefined,
        hasViews: manifestHasViews(manifest),
        ...(disclosure.agentTools.length > 0 ? { agentTools: disclosure.agentTools } : {}),
        requiresConfirmation: true,
        publisherId: manifest.publisher,
        requiresPublisherTrust: false,
        requiresRiskConfirmation: true,
        disclosureDiff: null,
        disclosure,
        scan: null,
        registry: null,
        source: 'developer-unpacked',
        folder: dir,
        takedownChecked: takedown.blocklistChecked,
      },
    }
  }

  /** A developer folder may not take an id something else installed holds:
   * the grant and the package registration are per id. */
  const assertFolderIdFree = (pluginId: string, dir?: string): void => {
    const prior = developerMode.folder(pluginId)
    if (dir !== undefined && prior && resolve(prior.path) !== resolve(dir)) {
      throw new Error(`ANOTHER_DEVELOPER_FOLDER [${pluginId}]: ${pluginId} is loaded from another developer folder (${prior.path}); remove that folder first`)
    }
    const installed = manager.listInstalledPackages().find((pkg) => pkg.id === pluginId)
    if ((installed && installed.provenance !== 'developer-local-unpacked') || lifecycleSelector.read(pluginId)) {
      throw new Error(`DEVELOPER_FOLDER_ID_INSTALLED [${pluginId}]: ${pluginId} is installed; remove it before loading a developer folder with the same id`)
    }
  }

  const unloadDeveloperFolder = async (pluginId: string): Promise<void> => {
    const installed = manager.listInstalledPackages().find((pkg) => pkg.id === pluginId)
    if (installed?.provenance !== 'developer-local-unpacked') return
    await revokeInstalledPackageRuntime(manager, pluginsRoot, pluginId)
    manager.removeInstalledPlugin(pluginId)
    capabilityGrants.remove(pluginId)
    options.onActivationChange?.({ pluginId })
  }

  /** Load one consented folder: the view's grant and the backend activation.
   * Returns false, loading nothing, when its permissions or backend changed. */
  const activateDeveloperFolder = (pluginId: string): boolean => {
    const consent = developerMode.folder(pluginId)
    if (!consent) return false
    const described = describeFolder(consent.path)
    if (described.pluginId !== pluginId || described.permissionsDigest !== consent.permissionsDigest) return false
    assertFolderIdFree(pluginId)
    const result = manager.loadExplicitDeveloperPlugin(consent.path, true, { allowBackend: true })
    if (!result.loaded) throw new Error(result.error)
    const scanned = loadPluginDir(consent.path)
    const policy = scanned.descriptor?.capabilityPolicy
    if (scanned.descriptor && policy?.kind === 'manifest-v2' && scanned.descriptor.packageVersion) {
      capabilityGrants.set(pluginId, {
        packageVersion: scanned.descriptor.packageVersion,
        system: [...policy.system],
        ...(policy.shell ? { shell: policy.shell } : {}),
        ...(policy.shell === 'full' ? { highRiskShellConfirmed: true as const } : {}),
        storage: true,
      })
    }
    if (scanned.activation) {
      options.onActivationChange?.({
        pluginId,
        activation: { ...scanned.activation, provenance: 'developer-local-unpacked' },
      })
    }
    return true
  }

  const developerModeState = () => ({
    enabled: developerMode.isEnabled(),
    folders: developerMode.folders().map((folder) => ({
      pluginId: folder.pluginId,
      path: folder.path,
      consentedAt: folder.consentedAt,
      loaded: manager.listInstalledPackages().some(
        (pkg) => pkg.id === folder.pluginId && pkg.provenance === 'developer-local-unpacked',
      ),
      ...(() => {
        try {
          describeFolder(folder.path)
          return {}
        } catch (error) {
          return { unavailable: errorText(error) }
        }
      })(),
    })),
  })

  ipcMain.handle('plugins:developerMode', (event) => {
    assertAuthorized(event)
    return developerModeState()
  })

  ipcMain.handle('plugins:setDeveloperMode', async (event, args: { enabled?: unknown } | null) => {
    assertAuthorized(event)
    if (typeof args?.enabled !== 'boolean') throw new Error('invalid Developer Mode switch value')
    const enabled = args.enabled
    if (developerMode.isEnabled() !== enabled) {
      developerMode.setEnabled(enabled)
      manager.recordDeveloperModeChange(enabled, hostAppVersion())
      if (!developerModeOn()) {
        for (const folder of developerMode.folders()) await unloadDeveloperFolder(folder.pluginId)
      } else {
        await loadDeveloperFolders()
      }
    }
    return developerModeState()
  })

  ipcMain.handle('plugins:loadFromFolder', async (event) => {
    assertAuthorized(event)
    if (!developerModeOn()) throw new Error('DEVELOPER_MODE_OFF: turn on Developer Mode to load a Navide plugin from a folder')
    const pickFolder = options.pickDeveloperFolder
    if (!pickFolder) throw new Error('loading from a folder is unavailable')
    const dir = await pickFolder(event)
    if (!dir) return null
    const described = describeFolder(dir)
    assertFolderIdFree(described.pluginId, dir)
    preparedFolders.set(described.pluginId, { dir, permissionsDigest: described.permissionsDigest })
    return described.summary
  })

  ipcMain.handle('plugins:commitFolderLoad', async (event, args: { id?: unknown; riskConfirmed?: unknown } | null) => {
    assertAuthorized(event)
    if (!developerModeOn()) throw new Error('DEVELOPER_MODE_OFF: turn on Developer Mode to load a Navide plugin from a folder')
    const id = typeof args?.id === 'string' ? args.id : ''
    const pending = preparedFolders.get(id)
    if (!pending) throw new Error(`no prepared developer folder for ${id}; choose the folder again`)
    if (args?.riskConfirmed !== true) throw new Error(`consent is required to load ${id} from a folder`)
    preparedFolders.delete(id)
    // What the user saw is what they consent to: a permissions or backend
    // change while the dialog was open asks again.
    const described = describeFolder(pending.dir)
    if (described.pluginId !== id || described.permissionsDigest !== pending.permissionsDigest) {
      throw new Error(`DEVELOPER_FOLDER_CHANGED [${id}]: the permissions or backend of ${id} changed; choose the folder again`)
    }
    assertFolderIdFree(id, pending.dir)
    // No install prepared for this id before the folder took it may commit.
    prepared.delete(id)
    preparedLocal.delete(id)
    await unloadDeveloperFolder(id)
    // The first load of an id takes no data an earlier package of it kept
    // (review HIGH-3 / MED-4 on #425): a developer folder's id is only what
    // its manifest claims. A reload of the same folder keeps its own data.
    const dataRoot = options.nativeBackendDataRoot
    if (!developerMode.folder(id) && dataRoot) {
      const kept = keptNativeBackendDataSource(dataRoot, id)
      if (kept !== null) {
        setAsideNativeBackendData(dataRoot, id, kept)
        forgetKeptNativeBackendDataSource(dataRoot, id)
      }
    }
    developerMode.consent({
      path: pending.dir,
      pluginId: id,
      permissionsDigest: pending.permissionsDigest,
      consentedAt: new Date().toISOString(),
    })
    activateDeveloperFolder(id)
    return developerModeState()
  })

  ipcMain.handle('plugins:reloadDeveloperPlugin', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    if (!developerModeOn()) throw new Error('DEVELOPER_MODE_OFF: turn on Developer Mode to reload a developer folder')
    const id = typeof args?.id === 'string' ? args.id : ''
    const consent = developerMode.folder(id)
    if (!consent) throw new Error(`${id} is not a developer folder`)
    const described = describeFolder(consent.path)
    if (described.pluginId !== id || described.permissionsDigest !== consent.permissionsDigest) {
      // Changed permissions or backend: unload and ask again. File content
      // alone never asks; it is expected to change during development.
      await unloadDeveloperFolder(id)
      preparedFolders.set(described.pluginId, { dir: consent.path, permissionsDigest: described.permissionsDigest })
      return { reloaded: false, requiresConsent: true, prepared: described.summary }
    }
    await unloadDeveloperFolder(id)
    activateDeveloperFolder(id)
    return { reloaded: true, requiresConsent: false }
  })

  ipcMain.handle('plugins:removeDeveloperFolder', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    const id = typeof args?.id === 'string' ? args.id : ''
    await unloadDeveloperFolder(id)
    // Its backend data stays, recorded as local, so no later install of the
    // id takes it over.
    if (developerMode.folder(id) && options.nativeBackendDataRoot) {
      recordKeptNativeBackendDataSource(options.nativeBackendDataRoot, id, 'local-unsigned')
    }
    developerMode.forget(id)
    return developerModeState()
  })

  // D6: a package installed from a self-hosted Registry is quarantined in a
  // packaged build while Developer Mode is off. Say so instead of letting it
  // disappear: the Extensions page lists these with that reason.
  ipcMain.handle('plugins:selfHostedQuarantine', (event): Array<{ id: string; version: string | null }> => {
    assertAuthorized(event)
    if (marketplaceOverridesAllowed()) return []
    const loaded = new Set(manager.listInstalledPackages().map((pkg) => pkg.id))
    return discoverInstalledRegistryPackageIds(pluginsRoot).flatMap((id) => {
      if (loaded.has(id)) return []
      try {
        const active = lifecycleSelector.read(id)?.active
        const dir = active ? lifecycleSelector.packageDir(id, active) : join(pluginsRoot, id)
        const receipt = JSON.parse(readFileSync(join(dir, REGISTRY_RECEIPT_NAME), 'utf8')) as Record<string, unknown>
        return receipt.registryAuthority === 'self-hosted'
          ? [{ id, version: typeof receipt.version === 'string' ? receipt.version : null }]
          : []
      } catch {
        return []
      }
    })
  })

  async function loadDeveloperFolders(): Promise<void> {
    if (!developerModeOn()) return
    for (const folder of developerMode.folders()) {
      try {
        activateDeveloperFolder(folder.pluginId)
      } catch (error) {
        console.warn(`[plugins] developer folder ${folder.pluginId} was not loaded: ${errorText(error)}`)
      }
    }
  }

  ipcMain.handle('plugins:restart', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
    assertNoDeveloperFolder(id)
    if (activeTransactions.has(id)) {
      throw new Error(`plugin transaction already in progress for ${id}`)
    }
    const selectedBeforeRestart = lifecycleSelector.read(id)
    if (!selectedBeforeRestart?.candidate) {
      throw new Error(`plugin ${id} has no staged candidate to restart`)
    }
    const candidateDir = lifecycleSelector.packageDir(id, selectedBeforeRestart.candidate)
    const restartTrust = resolveConfiguredMarketplace(trust).trust
    const currentTrust = verifyCommittedInstall(candidateDir, id, restartTrust)
    if (currentTrust.action === 'quarantine') {
      throw new Error(`staged candidate quarantined: ${currentTrust.reason}`)
    }
    if (currentTrust.artifactDigest !== selectedBeforeRestart.candidate.artifactDigest) {
      throw new Error('staged candidate artifact identity changed before restart')
    }
    const scanned = loadPluginDir(candidateDir)
    if (scanned.error || !scanned.activation || !scanned.packageSummary) {
      throw new Error(`staged candidate is invalid${scanned.error ? `: ${scanned.error}` : ''}`)
    }
    // Card K3: a candidate installed from a file carries its local source,
    // never the Registry provenance or the official registration.
    const localCandidate = isLocalInstalledPackage(pluginsRoot, candidateDir, id)
    const candidateSource = localCandidate
      ? { source: 'local-unsigned' as const }
      : { provenance: 'official-registry' as const }
    const activation: PluginActivationCatalogEntry = {
      ...scanned.activation,
      ...candidateSource,
      artifactDigest: currentTrust.artifactDigest,
    }
    const previousDescriptor = manager.getDescriptor(id)
    const installedSummary = manager.listInstalledPackages().find((item) => item.id === id)
    const isFactory = installedSummary?.provenance === 'factory-bundled'
    // D7: a change to or from a local source keeps nothing of the replaced
    // package's consent: grant, rollback grant, backend and agent tool answers.
    const sourceReplaced = localCandidate || installedSummary?.source === 'local-unsigned'
    // D7: the native backend data moves aside only when the source changes
    // (Marketplace ↔ local file); an update within one source keeps it as on main.
    const replacedSource = dataSourceOf(installedSummary)
    const sourceChanged = installedSummary !== undefined && !isFactory &&
      (replacedSource === 'local-unsigned') !== localCandidate
    // MED-4: one local file replacing another hands over no data either.
    const dataMoves = sourceChanged ||
      (installedSummary !== undefined && localCandidate && replacedSource === 'local-unsigned')
    const incomingSource = localCandidate ? 'local-unsigned' as const : 'marketplace' as const
    const moved: Array<{ root: string; name: string; setAside: string | null; reattached: string | null }> = []
    /** Put every data location back as it was before this restart. Never
     * throws: each failure is returned, and whatever is then at a live path
     * is set aside so the package rolled back to never gets the new source's
     * data (review of cd04b987d). */
    const undoDataMove = (): unknown[] => {
      const errors: unknown[] = []
      for (const place of moved.splice(0).reverse()) {
        try {
          if (place.reattached) returnReattachedNativeBackendData(place.root, place.name, place.reattached)
          if (place.setAside) {
            // A backend of the new source that already started may have made
            // a folder of its own: that one is set aside too, never merged.
            if (existsSync(join(place.root, place.name))) setAsideNativeBackendData(place.root, place.name, incomingSource)
            reattachNativeBackendData(place.root, place.name, place.setAside)
          }
        } catch (error) {
          errors.push(error)
          try {
            if (existsSync(join(place.root, place.name))) setAsideNativeBackendData(place.root, place.name, incomingSource)
          } catch (isolationError) {
            errors.push(isolationError)
          }
        }
      }
      return errors
    }
    const finishSourceReplacement = (): void => {
      if (!sourceReplaced) return
      lifecycleSelector.forgetPrevious(id)
      options.forgetBackendConsent?.(id)
      if (!localCandidate) forgetLocalTrustRecords(pluginsRoot, id)
    }
    const legacyDir = join(pluginsRoot, id)
    // A v0.2.9 backend-only install has neither a descriptor nor a selector
    // record; its installed summary still names the version living at the
    // mutable legacy path.
    const legacyBackendOnly = !previousDescriptor && !selectedBeforeRestart.active && !isFactory &&
      installedSummary?.provenance === 'official-registry'
    // Backend-only packages deliberately have no frontend descriptor. The
    // durable active selector remains the authoritative runtime identity, so
    // it must still be drained before candidate promotion.
    const previousVersion = previousDescriptor?.packageVersion ?? selectedBeforeRestart.active?.packageVersion ??
      (legacyBackendOnly ? installedSummary?.packageVersion : undefined)
    const previousGrant = previousVersion ? capabilityGrants.get(id, previousVersion) : null
    if (previousVersion && !previousGrant && !isFactory) {
      throw new Error(`active package grant is unavailable for ${id}`)
    }
    let promotedGrant: HostCapabilityGrant
    if (scanned.descriptor) {
      const policy = scanned.descriptor.capabilityPolicy
      if (!policy || policy.kind !== 'manifest-v2') {
        throw new Error('invalid Manifest v2 capability policy')
      }
      const candidateProof = selectedBeforeRestart.candidateGrant
      const fullShellConfirmed = policy.shell === 'full' &&
        (candidateProof
          ? candidateProof.highRiskShellConfirmed === true
          : selectedBeforeRestart.candidateFullShellConfirmed === true)
      if (policy.shell === 'full' && !fullShellConfirmed) {
        throw new Error('staged candidate full-shell approval is unavailable')
      }
      promotedGrant = {
        packageVersion: selectedBeforeRestart.candidate.packageVersion,
        system: [...policy.system],
        ...(policy.shell ? { shell: policy.shell } : {}),
        ...(fullShellConfirmed ? { highRiskShellConfirmed: true as const } : {}),
        storage: true,
      }
      if (candidateProof && JSON.stringify(candidateProof) !== JSON.stringify(promotedGrant)) {
        throw new Error('staged candidate grant does not match the current capability policy')
      }
    } else {
      promotedGrant = {
        packageVersion: selectedBeforeRestart.candidate.packageVersion,
        system: [],
        storage: true,
      }
      if (
        selectedBeforeRestart.candidateGrant &&
        JSON.stringify(selectedBeforeRestart.candidateGrant) !== JSON.stringify(promotedGrant)
      ) {
        throw new Error('staged candidate grant does not match the current backend policy')
      }
    }
    activeTransactions.add(id)
    let restartTransaction: PluginPackageRestartTransaction | undefined
    let drainedBackendOnly = false
    let promoted = false
    try {
      if (!selectedBeforeRestart.active && previousVersion && previousGrant &&
          (previousDescriptor?.packageDir === legacyDir || legacyBackendOnly)) {
        const legacyScanned = loadPluginDir(legacyDir)
        if (!legacyScanned.activation || legacyScanned.activation.packageVersion !== previousVersion) {
          throw new Error('legacy active package is unavailable for migration')
        }
        const legacyTrust = verifyCommittedInstall(legacyDir, id, resolveConfiguredMarketplace(trust).trust)
        if (legacyTrust.action === 'quarantine' || !legacyTrust.target) {
          throw new Error(`legacy active package cannot be verified: ${legacyTrust.action === 'quarantine' ? legacyTrust.reason : 'Registry target is unavailable'}`)
        }
        lifecycleSelector.adoptLegacyActive(id, {
          packageVersion: previousVersion,
          target: legacyTrust.target,
          artifactDigest: legacyTrust.artifactDigest,
          layout: 'legacy-mutable',
        }, previousGrant)
      }
      lifecycleSelector.beginActivation(id, previousGrant && !isFactory ? { previousGrant } : {})
      if (previousVersion) {
        if (previousDescriptor) {
          restartTransaction = await manager.beginPackageRestart(id, previousVersion)
        } else {
          await manager.revokePackageVersion(id, previousVersion)
          drainedBackendOnly = true
        }
      }
      // D7: with the old backend stopped, set its data aside before cutover.
      // A failed move stops the restart here; nothing has been promoted yet.
      // HIGH-3: a fresh install never takes data a removal kept from another
      // source; data kept from its own source is reused exactly as on main.
      // A recorded source applies whatever is installed now: an install path
      // that does not restart (a Manifest v1 package) leaves the record in place.
      const keptRoot = options.nativeBackendDataRoot
      const recordedSource = keptRoot ? recordedNativeBackendDataSource(keptRoot, id) : null
      const keptSource = recordedSource ?? (!installedSummary && keptRoot ? keptNativeBackendDataSource(keptRoot, id) : null)
      if (keptRoot && keptSource !== null && (keptSource === 'local-unsigned' || keptSource !== incomingSource)) {
        const entry: (typeof moved)[number] = { root: keptRoot, name: id, setAside: null, reattached: null }
        moved.push(entry)
        entry.setAside = setAsideNativeBackendData(keptRoot, id, keptSource)
      }
      if (dataMoves) {
        const reattach = pendingReattach.delete(id)
        for (const place of dataPlaces(id)) {
          const entry: (typeof moved)[number] = { ...place, setAside: null, reattached: null }
          moved.push(entry)
          entry.setAside = setAsideNativeBackendData(place.root, place.name, replacedSource)
          const back = reattach ? latestSetAsideNativeBackendData(place.root, place.name, 'marketplace') : null
          if (back) {
            reattachNativeBackendData(place.root, place.name, back)
            entry.reattached = back
          }
        }
      }
      // The old runtime may take time to drain. Re-check the exact candidate
      // bytes and current Registry authority at the cutover seam, not only
      // before the drain started.
      const cutoverSelection = lifecycleSelector.read(id)
      if (
        !cutoverSelection?.candidate ||
        cutoverSelection.candidate.packageVersion !== selectedBeforeRestart.candidate.packageVersion ||
        cutoverSelection.candidate.target !== selectedBeforeRestart.candidate.target ||
        cutoverSelection.candidate.artifactDigest !== selectedBeforeRestart.candidate.artifactDigest
      ) {
        throw new Error('staged candidate identity changed during restart')
      }
      const cutoverTrust = verifyCommittedInstall(candidateDir, id, resolveConfiguredMarketplace(trust).trust)
      if (cutoverTrust.action === 'quarantine') {
        throw new Error(`staged candidate quarantined: ${cutoverTrust.reason}`)
      }
      if (cutoverTrust.artifactDigest !== selectedBeforeRestart.candidate.artifactDigest) {
        throw new Error('staged candidate artifact identity changed during restart')
      }
      const selected = lifecycleSelector.activateCandidate(id)
      promoted = true
      if (localCandidate) promoteLocalCandidateRecord(pluginsRoot, id)
      const summary = { ...scanned.packageSummary, ...candidateSource }
      const registration = localCandidate ? {} : { official: true }
      if (scanned.descriptor) {
        manager.registerInstalledPackage(summary, scanned.descriptor, registration)
        capabilityGrants.set(id, promotedGrant)
        manager.setPluginStorageSnapshotSelection(id, {
          activeVersion: selected.active!.packageVersion,
          // D7: the replacing source never reads the replaced one's storage.
          ...(selected.previous && !sourceReplaced ? { previousVersion: selected.previous.packageVersion } : {}),
        })
      } else {
        // Backend-only packages have no frontend descriptor, but they still
        // need a version-bound grant for their next update or rollback.
        manager.registerInstalledPackage(summary, undefined, registration, candidateDir)
        capabilityGrants.set(id, promotedGrant)
        manager.setPluginStorageSnapshotSelection(id, {
          activeVersion: selected.active!.packageVersion,
          // D7: the replacing source never reads the replaced one's storage.
          ...(selected.previous && !sourceReplaced ? { previousVersion: selected.previous.packageVersion } : {}),
        })
      }
      options.onActivationChange?.({ pluginId: id, activation })
      if (restartTransaction && !scanned.descriptor) {
        manager.completePackageRestartWithoutFrontend(restartTransaction)
        restartTransaction = undefined
      }
      if (restartTransaction) {
        const report = await manager.restorePackageRestart(
          restartTransaction,
          selected.active!.packageVersion,
        )
        manager.completePackageRestart(restartTransaction)
        lifecycleSelector.completeActivation(id, { activeGrant: promotedGrant })
        finishSourceReplacement()
        if (options.nativeBackendDataRoot) forgetKeptNativeBackendDataSource(options.nativeBackendDataRoot, id)
        if (!previousVersion) recordFreshInstall(id)
        options.onPackageInstalled?.(id)
        return {
          id,
          packageVersion: selected.active!.packageVersion,
          restoredInstances: report.restoredInstances,
          skippedDestroyedHostWindows: report.skippedDestroyedHostWindows,
        }
      }
      lifecycleSelector.completeActivation(id, { activeGrant: promotedGrant })
      finishSourceReplacement()
      if (options.nativeBackendDataRoot) forgetKeptNativeBackendDataSource(options.nativeBackendDataRoot, id)
      if (!previousVersion) recordFreshInstall(id)
      options.onPackageInstalled?.(id)
      return { id, packageVersion: selected.active!.packageVersion, restoredInstances: 0, skippedDestroyedHostWindows: 0 }
    } catch (error) {
      // A failed data move back is reported with the restart's own error,
      // after the package rollback below has run, never instead of it.
      // The data move back and the package rollback below never depend on
      // each other: both run, and every failure is reported (LOW-7).
      const moveErrors = undoDataMove()
      // Only a move this restart made can fail to come back.
      if (moveErrors.length > 0) {
        // Fail closed until the user sorts the data out: no backend of this
        // id runs again on an earlier consent.
        try {
          options.forgetBackendConsent?.(id)
        } catch (forgetError) {
          moveErrors.push(forgetError)
        }
      }
      if (promoted) {
        try {
          const promotedSelection = lifecycleSelector.read(id)
          const previous = promotedSelection?.previous
          if (previous) {
            const previousDir = lifecycleSelector.packageDir(id, previous)
            const previousTrust = verifyCommittedInstall(
              previousDir,
              id,
              resolveConfiguredMarketplace(trust).trust,
            )
            if (previousTrust.action === 'quarantine') {
              throw new Error(`previous package is unavailable for rollback: ${previousTrust.reason}`)
            }
            if (previousTrust.artifactDigest !== previous.artifactDigest) {
              throw new Error('previous package artifact identity changed before rollback')
            }
            const previousScanned = loadPluginDir(previousDir)
            if (
              previousScanned.error ||
              !previousScanned.activation ||
              !previousScanned.packageSummary
            ) {
              throw new Error(
                `previous package is invalid for rollback${previousScanned.error ? `: ${previousScanned.error}` : ''}`,
              )
            }
            await manager.revokePackageVersion(id, promotedSelection.active!.packageVersion)
            lifecycleSelector.rollbackPromotedActivation(id)
            const retainedGrant = promotedSelection.previousGrant
            if (!retainedGrant) throw new Error('previous package grant is unavailable for rollback')
            capabilityGrants.set(id, retainedGrant)
            const previousSource = evidenceSource(previousDir, id)
            manager.registerInstalledPackage(
              { ...previousScanned.packageSummary, ...previousSource.fields },
              previousScanned.descriptor,
              previousSource.registration,
              previousDir,
            )
            manager.setPluginStorageSnapshotSelection(id, { activeVersion: previous.packageVersion })
            options.onActivationChange?.({
              pluginId: id,
              activation: {
                ...previousScanned.activation,
                ...previousSource.fields,
                artifactDigest: previousTrust.artifactDigest,
              },
            })
            if (restartTransaction && previousScanned.descriptor) {
              await manager.restorePackageRestart(restartTransaction, previous.packageVersion)
              manager.completePackageRestart(restartTransaction)
              restartTransaction = undefined
            }
          } else {
            await manager.revokePackageVersion(id, promotedSelection?.active?.packageVersion ?? selectedBeforeRestart.candidate.packageVersion)
            lifecycleSelector.rollbackPromotedActivation(id)
            manager.removeInstalledPlugin(id, { restoreBuiltin: false })
            if (isFactory && previousDescriptor?.packageDir) {
              // A factory package has no retained Registry selection; its
              // return path is the App bundle it was loaded from.
              const restored = manager.loadFactoryPlugin(previousDescriptor.packageDir, id)
              if (!restored.loaded) throw new Error(`Factory package restoration failed: ${restored.reason}`)
              if (previousGrant) capabilityGrants.set(id, previousGrant)
              else capabilityGrants.remove(id)
              manager.setPluginStorageSnapshotSelection(id, { activeVersion: restored.packageVersion })
              options.onActivationChange?.({ pluginId: id, activation: restored.activation })
              if (restartTransaction) {
                await manager.restorePackageRestart(restartTransaction, restored.packageVersion)
                manager.completePackageRestart(restartTransaction)
                restartTransaction = undefined
              }
            } else {
              options.onActivationChange?.({ pluginId: id })
            }
          }
        } catch (rollbackError) {
          if (restartTransaction) manager.cancelPackageRestart(restartTransaction)
          // Fail closed: a source-changing candidate left promoted keeps none
          // of the replaced package's native backend permissions.
          if (sourceReplaced) {
            try {
              options.forgetBackendConsent?.(id)
            } catch {
              // The rollback failure stays the reported error.
            }
          }
          throw new AggregateError(
            [error, rollbackError, ...moveErrors],
            'Plugin restart and rollback failed.',
          )
        }
      }
      if (!promoted) {
        try {
          lifecycleSelector.recoverInterruptedActivation(id)
          if (restartTransaction && previousVersion) {
            await manager.restorePackageRestart(restartTransaction, previousVersion)
            manager.completePackageRestart(restartTransaction)
            restartTransaction = undefined
          }
          if (drainedBackendOnly && selectedBeforeRestart.active) {
            const priorDir = lifecycleSelector.packageDir(id, selectedBeforeRestart.active)
            const priorScanned = loadPluginDir(priorDir)
            if (priorScanned.activation) {
              options.onActivationChange?.({
                pluginId: id,
                activation: {
                  ...priorScanned.activation,
                  ...evidenceSource(priorDir, id).fields,
                  artifactDigest: selectedBeforeRestart.active.artifactDigest,
                },
              })
            }
          }
        } catch (recoveryError) {
          if (restartTransaction) manager.cancelPackageRestart(restartTransaction)
          throw new AggregateError([error, recoveryError, ...moveErrors], 'Plugin restart recovery failed.')
        }
      }
      if (restartTransaction) manager.cancelPackageRestart(restartTransaction)
      if (moveErrors.length > 0) {
        throw new AggregateError([error, ...moveErrors], 'Plugin restart failed and its data could not be put back.')
      }
      throw error
    } finally {
      activeTransactions.delete(id)
    }
  })

  // Leaves the selected package running; the only exit from a candidate that
  // cannot be activated (for example over an unverifiable legacy install).
  ipcMain.handle('plugins:discardCandidate', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
    if (activeTransactions.has(id)) {
      throw new Error(`plugin transaction already in progress for ${id}`)
    }
    lifecycleSelector.discardCandidate(id)
    forgetLocalTrustRecords(pluginsRoot, id, ['candidate'])
    return { ok: true }
  })

  // A rollback that fails before selecting its target leaves the drained
  // version selected again; remount its views instead of leaving it closed.
  async function restoreDrainedViews(
    transaction: PluginPackageRestartTransaction,
    packageVersion: string,
    cause: unknown,
  ): Promise<void> {
    try {
      await manager.restorePackageRestart(transaction, packageVersion)
      manager.completePackageRestart(transaction)
    } catch (restoreError) {
      manager.cancelPackageRestart(transaction)
      // IPC carries only the message, so it names both causes itself.
      throw new AggregateError(
        [cause, restoreError],
        `Plugin rollback failed and its views could not be restored: ${errorText(cause)}; ${errorText(restoreError)}`,
      )
    }
  }

  // A factory package has no selection to retain as `previous`, so rolling
  // back the package that replaced it returns the id to the App bundle. The
  // displaced package stays staged as a candidate plugins:restart re-activates.
  async function rollbackToFactoryPackage(id: string, active: PluginPackageSelection) {
    const loadFactoryPackage = options.loadFactoryPackage
    if (!loadFactoryPackage) throw new Error('factory package rollback is unavailable')
    const refusal = options.factoryRollbackRefusal?.(id)
    if (refusal) throw new Error(refusal)
    const currentDescriptor = manager.getDescriptor(id)
    const currentVersion = currentDescriptor?.packageVersion ?? active.packageVersion
    const currentGrant = capabilityGrants.get(id, currentVersion)
    if (!currentGrant) throw new Error(`active package grant is unavailable for ${id}`)
    activeTransactions.add(id)
    let restartTransaction: PluginPackageRestartTransaction | undefined
    let journaled = false
    let factoryLoaded = false
    let factorySelected = false
    // Nothing replaces the drained package until the factory package loads, so
    // every failure before that has to select the displaced package again.
    // A backend-only plugin is the case that cannot be left alone: its child is
    // already revoked, and without this its selector would keep calling a
    // version active that no longer runs.
    const reselectDisplacedPackage = (): void => {
      if (journaled) {
        lifecycleSelector.recoverInterruptedActivation(id)
        journaled = false
      }
      // The factory package loaded but could not be made the durable selection.
      if (factoryLoaded) manager.removeInstalledPlugin(id, { restoreBuiltin: false })
      capabilityGrants.set(id, currentGrant)
      const activeDir = lifecycleSelector.packageDir(id, active)
      const activeScanned = loadPluginDir(activeDir)
      if (!activeScanned.packageSummary) {
        // Its descriptor is already gone and nothing can re-register it, so say
        // so instead of leaving the renderer holding contributions that no
        // longer resolve. The caller reports this alongside the original cause.
        options.onActivationChange?.({ pluginId: id })
        throw new Error(
          `displaced package is no longer readable${activeScanned.error ? `: ${activeScanned.error}` : ''}`,
        )
      }
      const activeSource = evidenceSource(activeDir, id)
      manager.registerInstalledPackage(
        { ...activeScanned.packageSummary, ...activeSource.fields },
        activeScanned.descriptor,
        activeSource.registration,
        activeDir,
      )
      manager.setPluginStorageSnapshotSelection(id, { activeVersion: active.packageVersion })
      if (activeScanned.activation) {
        options.onActivationChange?.({
          pluginId: id,
          activation: {
            ...activeScanned.activation,
            ...activeSource.fields,
            artifactDigest: active.artifactDigest,
          },
        })
      }
    }
    try {
      // Journaled like the previous-version rollback, so a crash before the
      // factory package is durably selected recovers to the displaced package.
      lifecycleSelector.beginFactoryRollback(id)
      journaled = true
      if (currentDescriptor) {
        restartTransaction = await manager.beginPackageRestart(id, currentVersion)
      } else {
        await manager.revokePackageVersion(id, currentVersion)
      }
      manager.removeInstalledPlugin(id, { restoreBuiltin: false })
      const restored = loadFactoryPackage(id)
      if (!restored.loaded) {
        throw new Error(`Factory package restoration failed: ${restored.reason}`)
      }
      factoryLoaded = true
      lifecycleSelector.demoteActiveToCandidate(id)
      journaled = false
      factorySelected = true
      manager.setPluginStorageSnapshotSelection(id, { activeVersion: restored.packageVersion })
      options.onActivationChange?.({ pluginId: id, activation: restored.activation })
      if (restartTransaction) {
        const report = await manager.restorePackageRestart(restartTransaction, restored.packageVersion)
        manager.completePackageRestart(restartTransaction)
        restartTransaction = undefined
        return { id, packageVersion: restored.packageVersion, ...report }
      }
      return { id, packageVersion: restored.packageVersion, restoredInstances: 0, skippedDestroyedHostWindows: 0 }
    } catch (error) {
      if (factorySelected) throw error
      try {
        reselectDisplacedPackage()
      } catch (recoveryError) {
        if (restartTransaction) manager.cancelPackageRestart(restartTransaction)
        restartTransaction = undefined
        // IPC carries only the message, so it names both causes itself.
        throw new AggregateError(
          [error, recoveryError],
          `Factory package rollback recovery failed: ${errorText(error)}; ${errorText(recoveryError)}`,
        )
      }
      if (restartTransaction) {
        const transaction = restartTransaction
        restartTransaction = undefined
        await restoreDrainedViews(transaction, currentVersion, error)
      }
      throw error
    } finally {
      if (restartTransaction) manager.cancelPackageRestart(restartTransaction)
      activeTransactions.delete(id)
    }
  }

  ipcMain.handle('plugins:rollback', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
    if (activeTransactions.has(id)) {
      throw new Error(`plugin transaction already in progress for ${id}`)
    }
    const selectedBeforeRollback = lifecycleSelector.read(id)
    if (
      selectedBeforeRollback?.active &&
      !selectedBeforeRollback.previous &&
      !selectedBeforeRollback.candidate &&
      !selectedBeforeRollback.activation &&
      options.factoryPackageIds?.includes(id)
    ) {
      return rollbackToFactoryPackage(id, selectedBeforeRollback.active)
    }
    if (
      !selectedBeforeRollback?.active ||
      !selectedBeforeRollback.previous ||
      selectedBeforeRollback.candidate ||
      selectedBeforeRollback.activation
    ) {
      throw new Error(`plugin ${id} has no completed activation to roll back`)
    }
    const previous = selectedBeforeRollback.previous
    const previousDir = lifecycleSelector.packageDir(id, previous)
    const verifyPrevious = () => {
      const decision = verifyCommittedInstall(previousDir, id, resolveConfiguredMarketplace(trust).trust)
      if (decision.action === 'quarantine') {
        throw new Error(`previous package is unavailable for rollback: ${decision.reason}`)
      }
      if (decision.artifactDigest !== previous.artifactDigest) {
        throw new Error('previous package artifact identity changed before rollback')
      }
      return decision
    }
    verifyPrevious()
    const previousScanned = loadPluginDir(previousDir)
    if (
      previousScanned.error ||
      !previousScanned.activation ||
      !previousScanned.packageSummary ||
      !selectedBeforeRollback.previousGrant
    ) {
      throw new Error(
        `previous package is unavailable for rollback${previousScanned.error ? `: ${previousScanned.error}` : ''}`,
      )
    }
    const currentDescriptor = manager.getDescriptor(id)
    // A backend-only activation has no descriptor, but its exact active
    // selector identity still owns a live runtime that must drain first.
    const currentVersion = currentDescriptor?.packageVersion ?? selectedBeforeRollback.active.packageVersion
    activeTransactions.add(id)
    let restartTransaction: PluginPackageRestartTransaction | undefined
    let drainedBackendOnly = false
    let promoted = false
    try {
      lifecycleSelector.beginRollback(id)
      if (currentDescriptor) {
        restartTransaction = await manager.beginPackageRestart(id, currentVersion)
      } else {
        await manager.revokePackageVersion(id, currentVersion)
        drainedBackendOnly = true
      }
      const currentPreviousTrust = verifyPrevious()
      const selected = lifecycleSelector.activatePrevious(id)
      promoted = true
      capabilityGrants.set(id, selectedBeforeRollback.previousGrant!)
      const previousSource = evidenceSource(previousDir, id)
      manager.registerInstalledPackage(
        { ...previousScanned.packageSummary, ...previousSource.fields },
        previousScanned.descriptor,
        previousSource.registration,
        previousDir,
      )
      manager.setPluginStorageSnapshotSelection(id, { activeVersion: selected.active!.packageVersion })
      options.onActivationChange?.({
        pluginId: id,
        activation: {
          ...previousScanned.activation,
          ...previousSource.fields,
          artifactDigest: currentPreviousTrust.artifactDigest,
        },
      })
      if (restartTransaction && previousScanned.descriptor) {
        const report = await manager.restorePackageRestart(restartTransaction, selected.active!.packageVersion)
        manager.completePackageRestart(restartTransaction)
        restartTransaction = undefined
        lifecycleSelector.completeRollback(id)
        return {
          id,
          packageVersion: selected.active!.packageVersion,
          restoredInstances: report.restoredInstances,
          skippedDestroyedHostWindows: report.skippedDestroyedHostWindows,
        }
      }
      if (restartTransaction) {
        manager.completePackageRestartWithoutFrontend(restartTransaction)
        restartTransaction = undefined
      }
      lifecycleSelector.completeRollback(id)
      return { id, packageVersion: selected.active!.packageVersion, restoredInstances: 0, skippedDestroyedHostWindows: 0 }
    } catch (error) {
      if (promoted && restartTransaction) {
        // The durable journal retains the verified promoted selection for cold recovery.
        manager.cancelPackageRestart(restartTransaction)
        restartTransaction = undefined
      }
      try {
        if (!promoted) {
          lifecycleSelector.recoverInterruptedActivation(id)
          if (drainedBackendOnly) {
            const currentDir = lifecycleSelector.packageDir(id, selectedBeforeRollback.active)
            const currentScanned = loadPluginDir(currentDir)
            if (currentScanned.activation) {
              options.onActivationChange?.({
                pluginId: id,
                activation: {
                  ...currentScanned.activation,
                  ...evidenceSource(currentDir, id).fields,
                  artifactDigest: selectedBeforeRollback.active.artifactDigest,
                },
              })
            }
          }
        }
      } catch (recoveryError) {
        if (restartTransaction) manager.cancelPackageRestart(restartTransaction)
        throw new AggregateError([error, recoveryError], 'Plugin rollback recovery failed.')
      }
      if (!promoted && restartTransaction) {
        const transaction = restartTransaction
        restartTransaction = undefined
        await restoreDrainedViews(transaction, currentVersion, error)
      }
      throw error
    } finally {
      activeTransactions.delete(id)
    }
  })

  const uninstallPlugin = async (rawId: unknown, rawDataChoice?: unknown): Promise<{ ok: true }> => {
    const id = assertPluginRemovalTarget(pluginsRoot, rawId)
    // Plans, Git and Mini-IDE ship with Navide and can only be disabled; no
    // `navide.` package is removable, so its storage and grant always stay.
    if (isReservedPluginId(id)) throw new Error(`first-party plugin ${id} cannot be removed or restored`)
    // No choice means keep, exactly as before this option existed.
    if (rawDataChoice !== undefined && rawDataChoice !== 'keep' && rawDataChoice !== 'delete') {
      throw new Error('invalid native backend data choice')
    }
    const deleteNativeBackendData = rawDataChoice === 'delete'
    const nativeBackendDataRoot = options.nativeBackendDataRoot
    if (deleteNativeBackendData && !nativeBackendDataRoot) {
      throw new Error('native backend data cleanup is unavailable')
    }
    if (activeTransactions.has(id)) {
      throw new Error(`plugin transaction already in progress for ${id}`)
    }
    const cleanupPluginStorage = options.cleanupPluginStorage
    if (!cleanupPluginStorage) {
      throw new Error('plugin storage cleanup is unavailable')
    }
    // Stop live instances before storage cleanup. The storage adapter drains
    // operations already admitted for this plugin; this phase also prevents
    // new renderer calls from being admitted while cleanup is in progress.
    const previousVersion = installedPackageVersion(manager, pluginsRoot, id)
    const previousBackend = previousVersion ? manager.getBackendActivation(id, previousVersion) : undefined
    const removedSource = dataSourceOf(manager.listInstalledPackages().find((pkg) => pkg.id === id))
    const pending = prepared.get(id)
    activeTransactions.add(id)
    try {
      await revokeInstalledPackageRuntime(manager, pluginsRoot, id)
      // Storage cleanup is an explicit uninstall operation. On failure retain
      // the package and restore its approved backend tuple for this session.
      try {
        await cleanupPluginStorage(id)
        // Storage a source change set aside goes with the plugin's storage.
        if (options.pluginStorageRoot) removeNativeBackendData(options.pluginStorageRoot, pluginStorageDirName(id))
        // The backend child was stopped with the runtime above. Deleting its
        // data here keeps a refused deletion on the same fail-closed path:
        // the package stays installed and its backend registration returns.
        if (deleteNativeBackendData) removeNativeBackendData(nativeBackendDataRoot!, id)
      } catch (error) {
        if (previousBackend) {
          try {
            manager.registerBackendActivation(previousBackend)
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], 'Plugin storage cleanup and runtime restoration failed.')
          }
        }
        throw error
      }
      // Drop the grant before the package files. The grant store lives beside
      // the package directory, not inside it, so it does not need those files;
      // ordering it first keeps a package whose directory removal fails
      // fail-closed instead of leaving a full grant over wiped storage.
      capabilityGrants.remove(id)
      removePlugin(pluginsRoot, id)
      lifecycleSelector.clear(id)
      forgetLocalTrustRecords(pluginsRoot, id)
      // Review LOW-1 on #428: removing a developer folder's plugin (also by an
      // agent's request) forgets its consent, so the next start does not load
      // it again. The folder itself is never touched.
      developerMode.forget(id)
      // HIGH-3: kept data remembers whose it is, so only an install of the
      // same source takes it over. If that cannot be recorded, the data is
      // set aside instead of being left for any later install of the id.
      if (!deleteNativeBackendData && nativeBackendDataRoot) {
        try {
          recordKeptNativeBackendDataSource(nativeBackendDataRoot, id, removedSource)
        } catch (error) {
          console.warn(`[plugins] source of the kept data of ${id} not recorded: ${errorText(error)}; setting it aside`)
          setAsideNativeBackendData(nativeBackendDataRoot, id, removedSource)
        }
      }
      disabledPlugins.remove(id)
      // A reinstalled package starts with no record of who disabled it.
      recordDisableSource(id, null)
      try {
        installScans.removePlugin(id)
      } catch (error) {
        console.warn(`[plugins] install scan record for ${id} not removed: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Its activity "first write in a workspace" rows go with it (D-e).
      manager.forgetPluginActivity(id)
      if (options.factoryPackageIds?.includes(id)) {
        if (!options.onFactoryPackageRemoved) {
          throw new Error('factory package removal is unavailable')
        }
        options.onFactoryPackageRemoved(id)
        manager.removeInstalledPlugin(id, { restoreBuiltin: false })
      } else {
        manager.removeInstalledPlugin(id)
      }
      if (prepared.get(id) === pending) prepared.delete(id)
      options.onActivationChange?.({ pluginId: id })
      return { ok: true }
    } finally {
      activeTransactions.delete(id)
    }
  }

  ipcMain.handle(
    'plugins:remove',
    async (event, args: { id?: unknown; nativeBackendData?: unknown } | null) => {
      assertAuthorized(event)
      return uninstallPlugin(args?.id, args?.nativeBackendData)
    },
  )

  // What the remove dialog discloses: whether this plugin's native backend left
  // private data on this device, how large it is and where.
  ipcMain.handle('plugins:nativeBackendData', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
    const root = options.nativeBackendDataRoot
    if (!root) return { exists: false, bytes: 0, path: '' }
    return inspectNativeBackendData(root, id)
  })

  // The installed (active) version's disclosure, for the agent request card's
  // permission diff (B2): from the installed manifest, never Registry data.
  // Null when nothing is installed or the package is Manifest v1.
  ipcMain.handle('plugins:installedDisclosure', async (event, args: { id?: unknown } | null) => {
    assertAuthorized(event)
    return activeDisclosure(assertPluginRemovalTarget(pluginsRoot, args?.id))
  })

  // The Disabled switch for the built-in Plans, Git and Mini-IDE. Same store as
  // the Marketplace switch below; the package stays loaded and the Host stops
  // offering, mounting and serving it (FrontendPluginManager.isBuiltinPluginDisabled).
  // Nothing here touches its storage, grant or lifecycle selection.
  const holdBuiltinSwitch = options.holdBuiltinSwitch ?? (<T>(task: () => Promise<T>) => task())
  async function setBuiltinDisabled(id: string, disabled: boolean): Promise<{ id: string; disabled: boolean }> {
    return holdBuiltinSwitch(() => switchBuiltin(id, disabled))
  }
  async function switchBuiltin(id: string, disabled: boolean): Promise<{ id: string; disabled: boolean }> {
    const hostSwitch = options.setBuiltinDisabled
    if (!hostSwitch) throw new Error('built-in plugin disable is unavailable')
    if (activeTransactions.has(id)) {
      throw new Error(`plugin transaction already in progress for ${id}`)
    }
    if (disabledPlugins.has(id) === disabled) return { id, disabled }
    activeTransactions.add(id)
    try {
      if (disabled) {
        // Recorded first, so nothing can mount it again while it drains.
        disabledPlugins.add(id)
        await hostSwitch(id, true)
      } else {
        disabledPlugins.remove(id)
        try {
          await hostSwitch(id, false)
        } catch (error) {
          disabledPlugins.add(id)
          throw error
        }
      }
      return { id, disabled }
    } finally {
      activeTransactions.delete(id)
    }
  }

  // Which built-ins are disabled, for the main window's tabs, commands and
  // "open in editor" entries.
  ipcMain.handle('plugins:disabledBuiltins', (event): string[] => {
    assertAuthorized(event)
    return manager.listDisabledBuiltinPlugins()
  })

  // Whether the Disabled store read normally, was rebuilt from its backup, or
  // cannot be read (the built-ins then count as disabled until a reset).
  ipcMain.handle('plugins:disabledStoreStatus', (event): { status: PluginIdStoreStatus } => {
    assertAuthorized(event)
    return { status: disabledPlugins.status() }
  })

  // The user's one-click reset of an unreadable Disabled store. Both damaged
  // copies are kept aside; every switch starts from enabled.
  ipcMain.handle('plugins:resetDisabledStore', async (event): Promise<{ status: PluginIdStoreStatus }> => {
    assertAuthorized(event)
    return holdBuiltinSwitch(async () => {
      if (disabledPlugins.status() !== 'unreadable') return { status: disabledPlugins.status() }
      disabledPlugins.resetUnreadable()
      const resumed: string[] = []
      for (const id of BUILTIN_PLUGIN_NAMES.keys()) {
        if (!manager.isBuiltinPluginDisabled(id)) {
          manager.resumeBuiltinPlugin(id)
          resumed.push(id)
        }
      }
      options.onBuiltinSwitchReset?.(resumed)
      return { status: disabledPlugins.status() }
    })
  })

  // The user's "Disabled" switch for an installed Marketplace package. Disable
  // stops the package and unregisters its views and backend; its files, grant,
  // storage and lifecycle selection stay. Enable re-verifies the selected
  // package and registers it again under the grant it already holds.
  ipcMain.handle(
    'plugins:setDisabled',
    async (event, args: { id?: unknown; disabled?: unknown } | null) => {
      assertAuthorized(event)
      const id = assertPluginRemovalTarget(pluginsRoot, args?.id)
      const disabled = args?.disabled
      if (typeof disabled !== 'boolean') throw new Error('invalid plugin disabled setting')
      if (BUILTIN_PLUGIN_NAMES.has(id)) return setBuiltinDisabled(id, disabled)
      const result = await setInstalledPackageDisabled(id, disabled)
      // The user's own switch (and the undo on an agent notice).
      if (result.changed) recordDisableSource(id, disabled, { by: 'user', at: Date.now(), agent: null })
      return { id: result.id, disabled: result.disabled }
    }
  )

  // The Disabled switch for an installed Marketplace package, shared by the
  // user's Extensions page (above) and an agent's plugins_disable /
  // plugins_enable (B2-c, below).
  const setInstalledPackageDisabled = async (
    id: string,
    disabled: boolean,
  ): Promise<{ id: string; disabled: boolean; changed: boolean }> => {
      if (!manager.canDisablePlugin(id)) throw new Error(`first-party plugin ${id} cannot be disabled`)
      if (activeTransactions.has(id)) {
        throw new Error(`plugin transaction already in progress for ${id}`)
      }
      const installed = manager.listInstalledPackages().find((pkg) => pkg.id === id)
      if (!installed || installed.provenance !== 'official-registry') {
        throw new Error(`plugin ${id} is not an installed Marketplace package`)
      }
      if (disabledPlugins.has(id) === disabled) return { id, disabled, changed: false }
      activeTransactions.add(id)
      try {
        if (disabled) {
          // Recorded first so that nothing re-registered during the drain can
          // start again.
          disabledPlugins.add(id)
          await revokeInstalledPackageRuntime(manager, pluginsRoot, id)
          manager.suspendDisabledPlugin(id)
          options.onActivationChange?.({ pluginId: id })
          return { id, disabled, changed: true }
        }
        const selected = lifecycleSelector.read(id)
        const packageDir = selected?.active
          ? lifecycleSelector.packageDir(id, selected.active)
          : join(pluginsRoot, id)
        const decision = verifyCommittedInstall(packageDir, id, resolveConfiguredMarketplace(trust).trust)
        if (decision.action === 'quarantine') {
          throw new Error(`plugin ${id} cannot be enabled: ${decision.reason}`)
        }
        if (selected?.active && decision.artifactDigest !== selected.active.artifactDigest) {
          throw new Error(`plugin ${id} cannot be enabled: artifact identity changed`)
        }
        const scanned = loadPluginDir(packageDir)
        if (scanned.error || !scanned.packageSummary) {
          throw new Error(`plugin ${id} cannot be enabled${scanned.error ? `: ${scanned.error}` : ''}`)
        }
        disabledPlugins.remove(id)
        const enabledSource = evidenceSource(packageDir, id)
        try {
          manager.registerInstalledPackage(
            { ...scanned.packageSummary, ...enabledSource.fields },
            scanned.descriptor,
            {},
            packageDir,
          )
        } catch (error) {
          disabledPlugins.add(id)
          throw error
        }
        if (scanned.activation) {
          options.onActivationChange?.({
            pluginId: id,
            activation: {
              ...scanned.activation,
              ...enabledSource.fields,
              artifactDigest: decision.artifactDigest,
            },
          })
        }
        return { id, disabled, changed: true }
      } finally {
        activeTransactions.delete(id)
      }
  }

  manager.setPluginAgentActionHandler?.((request) =>
    answerPluginAgentAction(request, {
      isBuiltin: (pluginId) => BUILTIN_PLUGIN_NAMES.has(pluginId) || isReservedPluginId(pluginId),
      installedVersion: (pluginId) => {
        const installed = manager.listInstalledPackages().find((pkg) => pkg.id === pluginId)
        return installed?.provenance === 'official-registry' ? installed.packageVersion ?? null : null
      },
      setDisabled: async (pluginId, disabled, source) => {
        const result = await setInstalledPackageDisabled(pluginId, disabled)
        if (result.changed) {
          recordDisableSource(pluginId, disabled, source ?? { by: 'agent', at: Date.now(), agent: null })
        }
        return result
      },
      notify: (notice) => options.onPluginAgentAction?.(notice),
      isDisabled: (pluginId) => disabledPlugins.has(pluginId),
      disableSource: (pluginId) => disableSources.get(pluginId),
      now: () => Date.now(),
    })
  )

  return {
    checkUpdates: checkInstalledUpdates,
    loadDeveloperFolders,
    takeRescanNotices() {
      const taken = rescanNotices
      rescanNotices = []
      return taken
    },
    restoreRescanNotices(notices) {
      rescanNotices = [...notices, ...rescanNotices]
    },
    async refreshRegistryTrust() {
      const packageIds = discoverInstalledRegistryPackageIds(pluginsRoot)
      const activeRegistryPackages = new Set(
        manager
          .listInstalledPackages()
          .filter((pkg) => pkg.provenance === 'official-registry')
          .map((pkg) => pkg.id)
      )
      const decisions: Array<{
        pluginId: string
        action: 'allow' | 'quarantine'
        reason?: string
      }> = []
      const safePackageIds = new Set(packageIds)
      for (const pluginId of activeRegistryPackages) {
        if (safePackageIds.has(pluginId)) continue
        // A package that disappeared or no longer has a coherent Host-owned
        // manifest is not a refresh candidate. It is nevertheless an active
        // Registry package in memory and must be stopped before this refresh
        // can return, including when there are no network candidates.
        manager.removeInstalledPlugin(pluginId)
        options.onActivationChange?.({ pluginId })
        decisions.push({
          pluginId,
          action: 'quarantine',
          reason:
            'installed Registry package is missing or has a malformed/identity-mismatched manifest',
        })
      }
      if (packageIds.length === 0) return { decisions, activationCatalog: [] }

      const marketplace = resolveConfiguredMarketplace(trust)
      const base = marketplace.registryUrl.replace(/\/+$/, '')
      const fallbackToCachedTrust = () => {
        const snapshot = readRegistryTrustSnapshot(pluginsRoot)
        const refreshed = manager.refreshInstalledPluginTrust(pluginsRoot, {
          pinnedRootKey: marketplace.trust.pinnedRegistryRootKey,
          snapshot,
          registryAuthority: marketplace.trust.registryAuthority,
          officialRegistryUrl: marketplace.trust.officialRegistryUrl,
          expectedTarget: marketplace.trust.expectedTarget ?? currentPluginHostTarget(),
          now: marketplace.trust.now,
        }, new Set([...packageIds, ...activeRegistryPackages]))
        for (const decision of refreshed) {
          if (decision.action === 'quarantine') {
            options.onActivationChange?.({ pluginId: decision.pluginId })
          }
        }
        return refreshed
      }

      let detail: {
        trust_metadata: RegistryTrustMetadata
        trust_metadata_signature: string
      } | null = null
      let lastRefreshError: Error | null = null
      for (const packageId of packageIds) {
        const [namespace, ...nameParts] = packageId.split('.')
        if (!namespace || nameParts.length === 0) continue
        try {
          const response = await fetch(
            `${base}/api/extensions/${namespace}/${nameParts.join('.')}`
          )
          if (!response.ok) {
            lastRefreshError = new Error(
              `trust metadata refresh failed: HTTP ${response.status}`
            )
            continue
          }
          const candidate = (await response.json()) as {
            trust_metadata: RegistryTrustMetadata
            trust_metadata_signature: string
          }
          verifyRegistryTrustMetadata(
            candidate.trust_metadata,
            candidate.trust_metadata_signature,
            marketplace.trust.pinnedRegistryRootKey,
            marketplace.trust.now
          )
          detail = candidate
          break
        } catch (error) {
          lastRefreshError = error instanceof Error ? error : new Error(String(error))
        }
      }
      if (!detail) {
        fallbackToCachedTrust()
        throw lastRefreshError ?? new Error('trust metadata refresh failed')
      }

      try {
        const snapshot = {
          schemaVersion: 1 as const,
          metadata: detail.trust_metadata,
          metadataSignature: detail.trust_metadata_signature,
        }
        writeRegistryTrustSnapshot(pluginsRoot, snapshot)
        const currentTrust = {
          pinnedRootKey: marketplace.trust.pinnedRegistryRootKey,
          snapshot,
          registryAuthority: marketplace.trust.registryAuthority,
          officialRegistryUrl: marketplace.trust.officialRegistryUrl,
          expectedTarget: marketplace.trust.expectedTarget ?? currentPluginHostTarget(),
          now: marketplace.trust.now,
        }
        const activeBeforeRefresh = new Set(
          manager
            .listInstalledPackages()
            .filter((pkg) => pkg.provenance === 'official-registry')
            .map((pkg) => pkg.id)
        )
        const refreshedDecisions = manager.refreshInstalledPluginTrust(
          pluginsRoot,
          currentTrust,
          new Set([...packageIds, ...activeBeforeRefresh])
        )
        for (const decision of refreshedDecisions) {
          if (decision.action === 'quarantine') {
            options.onActivationChange?.({ pluginId: decision.pluginId })
          }
        }
        decisions.push(...refreshedDecisions)
        const restoreIds = new Set(
          refreshedDecisions
            .filter(
              (decision) => decision.action === 'allow' && !activeBeforeRefresh.has(decision.pluginId)
            )
            .map((decision) => decision.pluginId)
        )
        const reloaded =
          restoreIds.size > 0
            ? manager.loadInstalledPlugins(
                pluginsRoot,
                { provenance: 'official-registry', trust: currentTrust },
                restoreIds
              )
            : { activationCatalog: [] }
        return { decisions, activationCatalog: reloaded.activationCatalog }
      } catch (error) {
        fallbackToCachedTrust()
        throw error
      }
    },
  }
}
