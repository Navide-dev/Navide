// Frontend plugin runtime (main process).
//
// Runs a plugin's UI inside an isolated `WebContentsView` attached to a host
// BrowserWindow, with a minimal, dedicated preload (`plugin-preload.js`). The
// pure broker logic lives in `pluginCapabilityBroker.ts` (unit-tested,
// electron-free): it enforces manifest scoping, resolves `ping`/unknown calls
// in-process, and routes everything else to the backend plugin host over the
// shared WebSocket transport below.

import { BrowserWindow, WebContentsView, ipcMain, webFrameMain, type WebContents, type WebFrameMain } from 'electron'
import { warnMain } from '../main-log'
import { recordMainFault } from '../error-ledger'
import { PDF_RENDER_REQUEST, handlePdfRenderRequest } from '../channel-pdf'
import { validateSupportedLocale, type SupportedLocale } from '../hostLocale'
import { webPolicyDeniedMessage } from '../browserAgentStrings'
import { composePluginFrameQuery } from './pluginContributionQuery'
import { systemFrameUnlessMac } from '../window-controls'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isMac } from '../../shared/osplat'
import { URL, pathToFileURL } from 'node:url'
import { WebSocket as NodeWebSocket } from 'ws'
import {
  parseCapabilityCall,
  planCapabilityCall,
  executionPolicyAllows,
  backendResponseToCapability,
  isEventAllowed,
  isPublicCapabilityEventAllowed,
  buildError,
  buildSuccess,
  CASTABLE_WS_TYPES,
  createTerminalOutputBatcher,
  terminalSessionIdOf,
  terminalSessionsFromResponse,
  HOST_CAPABILITIES,
  HOST_EVENT_SOURCE_PLUGIN_ID,
  HOST_USER_INITIATOR,
  undispatched,
  type CapabilityCall,
  type CapabilityErrorCode,
  type CapabilityResponse,
  type AuthenticatedRuntimeBinding,
  type AuthenticatedInitiator,
  type HostCapabilityContext,
  type HostCapabilityGrant,
  type PublicCapabilityExecutionPlan,
  type TerminalOutputBatcher,
} from './pluginCapabilityBroker'
import { WebViewError, type PluginWebViewRegistry, type WebGuestView, type WebHostSurface } from './pluginWebViews'
import { pluginWebViewRegistry, setPluginWebViewChangedHook } from './pluginWebViewHost'
import { dispatchWebBridge } from './webBridge'
import { firstPartyBridgePorts, isFirstPartyAgentToolPlugin } from './pluginFirstPartyBackends'
import type { WebViewInfo, WebViewOwner, WebViewRect } from './webCapability'
import { activityRowFor, backendCallAddress, PluginActivityRecorder } from './pluginActivity'
import type { ExecutionPolicySnapshot } from './executionPolicy'
import {
  PluginStorageError,
  type StorageExecution,
  type StorageExecutionAddress,
} from './pluginStorage'
import { CAP_EVENTS } from './capabilityMap'
import {
  HOST_SHELL_EXECUTABLE_ALLOWLIST,
  PUBLIC_CAPABILITY_EVENT_ADDRESSES,
  publicCapabilityEntry,
} from './pluginCapabilityCatalog'
import { PUBLIC_GIT_METHODS, gitRequestTimeoutMs, publicGitRequest } from './gitPublicCapability'
import { GIT_ACCOUNT_PUBLIC_METHODS } from './gitAccountCapability'
import { PUBLIC_ISSUE_METHODS, issueRequest } from './issueCapability'
import {
  MINI_IDE_PLUGIN_REQUIRES,
  PLANS_PLUGIN_REQUIRES,
} from '../../shared/pluginCapabilities'
import {
  buildActivationCatalog,
  loadPluginDir,
  scanInstalledPlugins,
  verifyOfficialInstall,
  type InstalledPluginPackageSummary,
  type PluginActivationCatalogEntry,
} from './installedPlugins'
import { resolveOfficialPublisherKey } from './pluginVerify'
import {
  verifyInstalledRegistryPackage,
  type InstalledRegistryTrustContext,
} from './pluginInstalledTrust'
import { verifyLocalInstalledPackage } from './pluginLocalInstall'
import { legacyCapabilityPolicy, type PluginCapabilityPolicy } from './pluginPermissions'
import {
  createWsClient,
  type WsClient,
  type WsClientStatus,
  type WsConstructor,
} from '../../shared/wsClient'
import {
  AI_CLI_PROFILES,
  AI_CLI_SHIFT_ENTER_SEQUENCES,
  BRACKETED_PASTE_AI_CLI_PROFILES,
  FULL_SCREEN_AI_CLI_PROFILES,
  TERMINAL_AI_CLI_PROFILES,
} from '../../shared/aiCliProfiles'
import { resolveWsType } from './capabilityMap'
import {
  HOST_GIT_READ_ONLY_KEYS as GIT_HOST_READ_ONLY_KEYS,
  HOST_GIT_USER_PREFERENCE_KEYS as GIT_USER_PREFERENCE_KEYS,
  HOST_GIT_WORKSPACE_REPOSITORY_KEY as GIT_WORKSPACE_REPOSITORY_KEY,
} from '../../shared/gitCompatibility'
import {
  buildPluginContributionCatalog,
  type PluginContributionCatalogEntry,
} from './pluginContributionCatalog'
import {
  BACKEND_RESTART_BUDGET_SPENT_MESSAGE,
  canonicalBackendPackageDir,
  PluginBackendHost,
  type BackendCallConcurrency,
  type BackendResourceUsage,
  type ThirdPartyAdmitter,
} from './pluginBackendHost'
import { currentPluginHostTarget, UNIVERSAL_PLUGIN_TARGET } from './pluginTarget'
import { isAllowedBackendTimeout } from './pluginBackendLimits'
import {
  createHostPlansFilesystemPort,
  createProductionPlansBridgeDispatcher,
  PlansBridgeError,
  type PlansBridgeContext,
  type PlansFilesystemPort,
  type PlansFilesystemServiceOperation,
} from './plansBridge'
import type { PackageShellPort } from './pluginThirdPartyBackends'
import {
  BackendPluginError,
  type BackendPluginLaunchSpec,
  type BackendPluginSubscription,
  type BackendResultText,
  type JsonValue,
} from './pluginBackendSupervisor'
import {
  canonicalExistingDirectory,
  isWorkspaceContainedPath,
  resolvePathForContainment,
  resolveWorkspaceRelativePath,
  workspaceMutationPathError,
} from './workspacePathPolicy'
import { resolvePlansRootPath } from './plansRoot'
import { isAllowedPlanDocumentPath } from './plansDirectories'
import {
  editorFilesystemRequest,
  editorPreviewResourceUrl,
} from './editorFilesystemCapability'
import { EDITOR_AI_METHODS, EditorAiCapability } from './editorAiCapability'
import { EditorNativeCapability, EDITOR_NATIVE_METHODS, type EditorNativeHost } from './editorNativeCapability'
import { EditorSelectionGrants } from './editorSelectionGrants'
import { EDITOR_PREFERENCE_METHODS, projectEditorPreferences } from './editorPreferenceCapability'
import { aiTerminalStorageIdentity, type AiTerminalStorageIdentity } from './aiTerminalStorage'
import type { TerminalOwnerOrigin } from '../terminalStorageOwner'
import type { TerminalStorageOwnerRequest, TerminalStorageOwnerState } from '../../shared/terminalStorageOwner'
import { aiTerminalCommand } from './aiTerminalCommand'
import { buildAgentPaneCommand, quoteCommandWord } from './agentPaneCommand'
import { executeAiTerminalResource } from './aiTerminalResources'
import { AiTerminalOutputDecoder } from './aiTerminalOutput'
import { MINI_IDE_STORAGE_KEYS } from '../../shared/miniIdePreferences'
import { copyManifestPermissionsSummary } from '../../shared/executionPolicy'
import type { AgentToolCallErrorCode, AgentToolUnavailableReason } from '../../shared/pluginAgentTools'
import type { MiniIdeLegacyPreferences } from './miniIdeLegacyPreferences'
import type { FilePickerHost, FilePickerInvocation } from '../filePicker'
import { PluginActivationSelector } from './pluginActivationSelector'
import {
  PluginFrameBindingRegistry,
  type PluginFrameBinding,
  type PluginFrameBindingIdentity,
} from './pluginFrameBinding'
import {
  PLUGIN_FRAME_SCHEME,
  PluginFrameAssetProtocol,
} from './pluginFrameAssetProtocol'
import { validatePluginDetailTarget } from './pluginDetailTargetSchema'
import { canonicalTrustJson } from './pluginRegistryTrust'
import { PLUGIN_RESOURCE_DECISION_MESSAGE, type PluginResourceDecisionRow } from '../../shared/pluginResourceDecision'
import {
  MARKETPLACE_QUERY_REQUEST_EVENT,
  MARKETPLACE_QUERY_RESULT_MESSAGE,
  PLUGIN_ACTIVITY_FORGET_MESSAGE,
  PLUGIN_ACTIVITY_REPORT_MESSAGE,
  PLUGIN_AGENT_ACTION_REQUEST_EVENT,
  PLUGIN_AGENT_ACTION_RESULT_MESSAGE,
  type PluginAgentActionAnswer,
} from '../../shared/pluginAgentTools'
import { BACKEND_CALL_UNDECLARED_ADDRESS, type PluginActivityReportRequest } from '../../shared/pluginActivity'
import type { MarketplaceQueryAnswer } from './marketplaceQuery'
import { dockSurfaceForPlugin } from '../dockSurfaceProvider'
import {
  AGENT_CAPABILITY_PROGRESS_MESSAGE,
  AGENT_CAPABILITY_REQUEST_CHUNK_EVENT,
  AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE,
  AGENT_TOOL_CHUNK_BYTES,
  AGENT_TOOL_CHUNK_IDLE_MS,
  AGENT_TOOLS_SYNC_EVENT,
  AGENT_TOOLS_RESULT_HELPER_EVENT,
  parseAgentToolsResultHelperState,
  type AgentToolsResultHelperState,
  agentToolChunkArrival,
  reassembleAgentToolPayloadText,
  splitAgentToolPayloadText,
  utf8ByteLength,
  type AgentToolCaller,
  type AgentToolCallResponse,
  type AgentToolChunksInvalidReason,
  type AgentToolsSyncPayload,
} from '../../shared/pluginAgentTools'
import { agentToolUnavailableMessage, type PluginAgentToolsHost } from './pluginAgentToolsHost'

/** An agent tool answer as the Host sends it: a result longer than one piece
 *  stays the plugin's text in pieces, never parsed here (contract 4.4, R1 to R2). */
type HostAgentToolResponse =
  | AgentToolCallResponse
  | { ok: true; resultText: BackendResultText; meta: { durationMs: number; resultBytes: number; crossWorkspace: boolean } }

/** The Host's backend session takes messages of any size (agent-tools contract
 *  4.4, A2); the `ws` default would close it at 100 MiB. Pieces keep every
 *  message small anyway. */
class UnboundedNodeWebSocket extends NodeWebSocket {
  constructor(address: string, protocols?: string | string[]) {
    super(address, protocols ?? [], { maxPayload: 0 })
  }
}
import type { ThirdPartyLaunchSpec } from './pluginThirdPartyBackends'

/** Everything the manager needs to launch one plugin view. */
export interface PluginLaunchDescriptor {
  /** Manifest id, e.g. `navide.noop`. */
  id: string
  /** Canonical package version for Manifest v2 descriptors. Legacy descriptors
   *  omit this field because their loader identity is plugin-id keyed. */
  packageVersion?: string
  /** Host-verified package root used for exact backend activation identity. */
  packageDir?: string
  /** Capabilities the plugin's manifest declares (drives broker scoping). */
  requires: string[]
  /** Access-aware policy for Manifest v2; omitted descriptors retain V1 behavior. */
  capabilityPolicy?: PluginCapabilityPolicy
  /** Host-authenticated v2 grant/binding context; never serialized to a plugin. */
  capabilityContext?: HostCapabilityContext | null
  /** Dev-server URL for the plugin entry (used when running under electron-vite dev). */
  devUrl: string
  /** Absolute file path to the built plugin entry (packaged / built runs). */
  entryFile: string
  /** Optional `?a=b` query appended to the entry (e.g. the mini-IDE workspace
   *  path the app reads from `window.location.search`). Omitted → no query. */
  query?: string
  /** Manifest v2 contributions discovered for this package. Legacy descriptors
   *  omit this field and continue to use their single top-level entryFile.
   *  Issue 01 exposes validated metadata only; issue 14 owns runtime instances. */
  views?: PluginViewLaunchDescriptor[]
}

export interface PluginViewLaunchDescriptor {
  id: string
  contributionKey: string
  kind: 'custom'
  location: 'top' | 'bottom' | 'right' | 'left' | 'main' | 'window' | 'detail'
  title: string
  /** Host-verified on-disk icon identity. It never crosses to the renderer. */
  iconFile?: string
  entryFile: string
  /** Canonical detail contribution owned by a left contribution. */
  detailView?: string
  /** Host-verified schema asset for a detail target. */
  targetSchema?: string
  /** Declares which Host frame locations may receive this window contribution. */
  receives?: {
    protocolVersion: 1
    locations: Array<'left' | 'detail'>
    editorTargets?: { protocolVersion: 1 }
    closeGuard?: { protocolVersion: 1 }
  }
}

export interface PluginBounds {
  x: number
  y: number
  width: number
  height: number
}

/** `'fill'` sizes the view to the host window's content bounds and keeps it
 *  in sync on host `resize` (full-overlay views like the mini-IDE editor).
 *  `'hidden'` attaches a deactivated view without inventing visible geometry;
 *  it is used for contributions that must subscribe before their tab opens. */
export type PluginViewBounds = PluginBounds | 'fill' | 'hidden'

/** Host-owned handle for one live contribution view. The instance id is
 * opaque: plugins never choose it and lifecycle calls must use the handle
 * returned by {@link FrontendPluginManager.openView}. */
interface ReceiverRegistration {
  readonly id: string
  readonly receiverInstanceId: string
  readonly documentGeneration: number
  readonly declaration: NonNullable<PluginViewLaunchDescriptor['receives']>
  readonly offers: Map<string, ReceiverOffer>
}

interface DetailTargetState {
  readonly targetId: string
  readonly revision: number
  readonly resourceKey: string
  readonly target: JsonValue
}

interface ReceiverOffer {
  readonly id: string
  /** Host-only origin correlation; never projected into an offer. */
  readonly openId?: string
  readonly location: 'left' | 'detail'
  readonly descriptor: PluginLaunchDescriptor
  readonly view: PluginViewLaunchDescriptor
  readonly workspacePath: string
  /** Host-private detail state; never projected into the receiver offer. */
  readonly detailSourceInstanceId?: string
  readonly detailTarget?: DetailTargetState
}

interface ReceiverItem {
  readonly id: string
  readonly receiverId: string
  readonly bindingId: string
  readonly offer: ReceiverOffer
  /** The current desired target, retained Host-side only. */
  detailTarget?: DetailTargetState
  /** Only a provider acknowledgement advances this applied target. */
  appliedDetailTarget?: DetailTargetState
  /** Allocated revisions are never reused after refusal, busy, or timeout. */
  nextDetailTargetRevision: number
}

interface PendingDetailOpen {
  readonly id: string
  readonly reqId: string
  readonly sourceInstanceId: string
  readonly sourceDocumentGeneration: number
  readonly receiverId: string
  readonly receiverInstanceId: string
  readonly receiverDocumentGeneration: number
  readonly offerId: string
  itemId: string | null
  readonly resolve: (response: CapabilityResponse) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface PendingDetailTarget {
  readonly target: DetailTargetState
  readonly openId: string | undefined
  readonly itemId: string
  readonly receiverId: string
  readonly receiverInstanceId: string
  readonly receiverDocumentGeneration: number
  readonly providerInstanceId: string
  readonly providerDocumentGeneration: number
  readonly bindingId: string
  readonly previousTarget: DetailTargetState | undefined
  readonly resolve: (decision: { applied: true } | { applied: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface DetailPair {
  readonly sourceInstanceId: string
  readonly receiverId: string
  readonly detailView: PluginViewLaunchDescriptor
  readonly workspacePath: string
}

type DetailCloseResult =
  | { closed: true }
  | { closed: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }

type ReceiverCloseReason = 'receiver-item-batch' | 'native-window-close' | 'reload' | 'quit'
type NativeReceiverCloseReason = Exclude<ReceiverCloseReason, 'receiver-item-batch'>

interface DetailCloseTransaction {
  readonly id: string
  readonly receiverId: string
  readonly receiverInstanceId: string
  readonly receiverDocumentGeneration: number
  readonly itemIds: readonly string[]
  readonly reason: ReceiverCloseReason
  /** Main-driven native closes hold every participant until commit/cancel. */
  readonly holdCommit: boolean
  readonly result: Promise<DetailCloseResult>
  /** Settles as soon as every participant is prepared (or the attempt fails). */
  readonly prepared: Promise<DetailCloseResult>
  readonly resolve: (result: DetailCloseResult) => void
  readonly resolvePrepared: (result: DetailCloseResult) => void
  phase: 'preparing' | 'prepared' | 'committing' | 'settled'
}

interface PendingWindowClose {
  readonly hostWindowId: number
  readonly transactionIds: readonly string[]
}

interface PendingReceiverClose {
  readonly closeId: string
  readonly transactionId: string
  readonly receiverId: string
  readonly receiverInstanceId: string
  readonly receiverDocumentGeneration: number
  dispatched: boolean
  accepted: boolean
  timer: ReturnType<typeof setTimeout> | null
}

interface PendingDetailClose {
  readonly closeId: string
  readonly transactionId: string
  readonly itemId: string
  readonly bindingId: string
  readonly providerInstanceId: string
  readonly providerDocumentGeneration: number
  readonly receiverId: string
  readonly receiverInstanceId: string
  readonly receiverDocumentGeneration: number
  dispatched: boolean
  accepted: boolean
  timer: ReturnType<typeof setTimeout> | null
}

interface PendingEditorTarget {
  readonly correlation: string
  readonly sourceInstanceId: string
  readonly sourceDocumentGeneration: number
  readonly sourceItemId: string
  readonly receiverId: string
  readonly receiverInstanceId: string
  readonly receiverDocumentGeneration: number
  readonly workspacePath: string
  readonly targetPath: string
  readonly targetRelativePath: string
  readonly resolve: (opened: boolean) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface PendingPluginFrame {
  readonly bindingId: string
  readonly instanceId: string
  readonly contributionKey: string
  readonly hostWindow: BrowserWindow
  readonly receiverWebContents: WebContents
  readonly receiverInstanceId: string | null
  readonly receiverDocumentGeneration: number
  readonly assetOrigin: string
  readonly artifactId: string
  readonly entryUrl: string
  readonly receiverGeneration: string
  documentNonce: string | null
  frame: WebFrameMain | null
  detachNavigation: (() => void) | null
}

interface PendingGuest {
  readonly token: string
  readonly instanceId: string
  readonly registryKey: string
  readonly contributionKey: string
  readonly descriptor: PluginLaunchDescriptor
  readonly hostWindow: BrowserWindow
  readonly workspacePath: string | null
  readonly query: string
  readonly capabilityContext: HostCapabilityContext | null
  readonly isV2Identity: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** Set once a guest has attached. The reservation is deliberately kept: a
   *  `<webview>` that the DOM merely *moves* is detached and re-attached by
   *  Electron with the same src, and a consumed one-time reservation would
   *  refuse that re-attach — leaving a blank panel with no way back. */
  attached: boolean
}

export interface PluginViewHandle {
  readonly instanceId: string
}

export interface PluginViewOpenOptions {
  hostWindow: BrowserWindow
  bounds: PluginViewBounds
  query?: string
  closeHostOnHide?: boolean
  mirrorTitle?: boolean
  /** Host-owned workspace path used only to resolve bound capabilities. */
  workspacePath?: string
  /** Host-authenticated context for this view instance. Renderer data never
   *  supplies or overrides this value. */
  capabilityContext?: HostCapabilityContext | null
  /** Keep a freshly mounted view deactivated until the Host activates it. */
  initiallyVisible?: boolean
  /** Host-authenticated file target for an editor-style open. The target is
   *  converted into a receiver-owned opaque grant before it reaches the view. */
  trustedEditorFileTarget?: {
    path: string
    expectedCanonicalPath?: string
    /** Host-validated workspace preview: use a relative path without a grant. */
    workspaceOnly?: boolean
  }
  /** Host liveness gate for async opens; checked before mounting and after
   *  backend binding before a trusted target is delivered. */
  canDispatch?: () => boolean
}

/** A Host-private restart record. It deliberately retains placement inputs,
 * but never a package entry path, capability binding, file grant, or caller
 * liveness closure: all of those must be resolved again after selection
 * changes. */
export interface PluginInstanceRestartSnapshot {
  readonly pluginId: string
  readonly packageVersion: string
  readonly contributionKey: string
  readonly hostWindow: BrowserWindow
  readonly bounds: PluginViewBounds
  readonly query: string
  readonly workspacePath: string | null
  readonly closeHostOnHide: boolean
  readonly mirrorTitle: boolean
  readonly initiallyVisible: boolean
  /** Whether this contribution was registered in Host region composition. */
  readonly contributionRegistered: boolean
  /** Renderer-owned guests need an explicit renderer re-prepare; the Host
   * cannot replace their carrier with a native view during restart. */
  readonly carrier: 'native' | 'guest'
}

export interface PluginPackageRestartRestoreReport {
  readonly restoredInstances: number
  readonly skippedDestroyedHostWindows: number
}

declare const pluginPackageRestartTransactionBrand: unique symbol

/** Opaque Host-only handle for one package-version restart. It is backed by a
 * private WeakMap, so renderer data cannot manufacture a usable transaction. */
export interface PluginPackageRestartTransaction {
  readonly [pluginPackageRestartTransactionBrand]: void
}

interface PendingPackageRestart {
  readonly pluginId: string
  readonly packageVersion: string
  readonly snapshots: readonly PluginInstanceRestartSnapshot[]
  restored: boolean
}

/** What the manager needs from a mounted plugin surface.
 *
 *  A `location: 'window'` contribution is a native `WebContentsView`, which the
 *  host positions and shows explicitly. An in-window contribution is a
 *  `<webview>` living in the host document, so its geometry and visibility are
 *  the renderer's CSS — `setBounds` and `setVisible` are then no-ops and the
 *  guest's own `webContents` still carries the instance's identity. */
export interface PluginSurface {
  readonly webContents: WebContents
  /** Present only for a native `WebContentsView`; a `<webview>` guest is owned
   *  by the host document and is never added to / removed from `contentView`. */
  readonly nativeView?: WebContentsView
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  setVisible(visible: boolean): void
}

/** A native `WebContentsView` wrapped as a {@link PluginSurface}. Keeping the
 *  handle on `nativeView` is what lets teardown remove it from `contentView`;
 *  a guest surface has no such child to remove. */
export function nativeSurface(view: WebContentsView): PluginSurface {
  return {
    webContents: view.webContents,
    nativeView: view,
    setBounds: (bounds) => view.setBounds(bounds),
    setVisible: (visible) => view.setVisible(visible),
  }
}

/** A `<webview>` guest wrapped as a {@link PluginSurface}. The renderer owns
 *  layout, so only `webContents` is real here. */
export function guestSurface(webContents: WebContents): PluginSurface {
  return { webContents, setBounds: () => {}, setVisible: () => {} }
}

interface RunningPlugin {
  instanceId: string
  /** Native and GuestAttach surfaces retain their existing WebContents transport;
   * frame receivers use the private MessagePort owned by frameBindings. */
  carrier: 'surface' | 'frame'
  frameBindingId: string | null
  /** Increments for each receiver main-document load. */
  documentGeneration: number
  id: string
  /** True when this instance was created through the plugin-id keyed {@link open} adapter. */
  openedViaLegacyAdapter: boolean
  /** Canonical Manifest v2 contribution key, when this is a view instance. */
  contributionKey: string | null
  /** Canonical Manifest v2 identity; this controls PTY semantics regardless of opener. */
  hasV2DescriptorIdentity: boolean
  requires: string[]
  capabilityPolicy: PluginCapabilityPolicy
  capabilityContext: HostCapabilityContext | null
  view: PluginSurface
  hostWindow: BrowserWindow
  /** Host-owned workspace path; never sourced from plugin payloads. */
  workspacePath: string | null
  /** SHA-256 workspace identity actually bound to the package backend. Null
   *  while the optional backend route is unavailable, so callers can fall
   *  back to the legacy adapter. */
  backendWorkspaceId: string | null
  /** The initial Plans backend bind. The dedicated Plans opener awaits this
   *  before claiming that the v2 surface is usable. */
  backendBindingTask: Promise<void> | null
  /** Query string the entry was last loaded with (drives reload-on-change). */
  query: string
  /** webContents.id captured at creation (not readable after destroy). */
  senderId: number
  /** Whether the view overlays the host's full content area (see {@link PluginViewBounds}). */
  fill: boolean
  /** Placement that the Host can restore after a package-version restart. */
  restartBounds: PluginViewBounds
  /** Removes the host `resize` listener; null when none is attached. */
  detachHostResize: (() => void) | null
  /** Removes the listeners this instance put on its host window — `closed`,
   *  and the `did-start-navigation` watch that reads a host reload as a
   *  deliberate teardown; null after instance teardown. */
  detachHostClosed: (() => void) | null
  /** Removes the receiver-document navigation observer for managed child frames. */
  detachReceiverFrames: (() => void) | null
  /** True when the host window exists solely for this view (dedicated plugin
   *  window): `hideSelf` then closes the window (legacy editor Esc semantics)
   *  instead of hiding the view under a still-visible host. */
  closeHostOnHide: boolean
  /** Whether this native view mirrors its document title to a dedicated Host window. */
  mirrorTitle: boolean
  /** Host-tracked visibility; WebContents does not expose a reliable readback. */
  visible: boolean
  /** True once the entry finished loading — open targets sent before that are
   *  queued in {@link pendingTargets} (mirrors the legacy editor window's
   *  pendingEditorOpenFiles flush on did-finish-load). */
  ready: boolean
  /** Last target actually delivered to this receiver. It is replayed after a
   *  Host-triggered readiness retry without retaining the request's liveness
   *  guard or any caller-owned provenance. */
  lastDeliveredTarget?: Record<string, string>
  /** True once the renderer sent the authenticated readiness handshake. */
  pluginReady: boolean
  /** True once the Host knows this instance is on its way out for a reason
   *  that is not the plugin's fault. Teardowns the Host drives itself
   *  (`destroyInstance`, and so `closeContribution`) need no flag — they
   *  forget the record before the guest dies, so `destroyed` finds nothing.
   *  This covers the one case that cannot: the host document navigating away,
   *  which destroys every guest it carries without running any Host code. */
  releasing: boolean
  pendingTargets: Record<string, string>[]
  /** A legacy adapter target withheld until the entry is ready; unlike
   *  pendingTargets this retains provenance and is never sent raw. */
  pendingTrustedTarget?: {
    query: string
    target: {
      path: string
      expectedCanonicalPath?: string
      workspaceOnly?: boolean
    }
    canDispatch?: () => boolean
  }
}

type PlansBackendHealth = 'unknown' | 'ready' | 'unavailable'

/** Host-minted only after the exact packaged Plans route failed before its
 * child received the request. The Python MCP adapter must never infer this
 * from a broad backend error. */
const LEGACY_SAFE_BEFORE_DISPATCH = 'legacy-safe-before-dispatch' as const
type PlansRecoveryResponse = CapabilityResponse & {
  recoveryDisposition?: typeof LEGACY_SAFE_BEFORE_DISPATCH
}

interface GitContributionState {
  workspacePath: string
  analyzerModel: string
  dispatchTargets: Array<{ id: string; label: string }>
  availableAgents: Array<{ key: string; label: string }>
  issueHandoffs: Record<string, { paneId: string; mode: string; state: string }>
}

interface GitAccountHandlers {
  available(): boolean
  list(): Array<{ id: string; label: string; host: string; username: string; tokenLast4: string }>
  add(input: { label: string; host: string; username: string; token: string }): { id: string; label: string; host: string; username: string; tokenLast4: string }
  update(id: string, patch: Partial<{ label: string; host: string; username: string; token: string }>): void
  remove(id: string): void
  bind(workspacePath: string, accountId: string): void
  unbind(workspacePath: string): void
  getBinding(workspacePath: string): string | null
  getCredential(workspacePath: string): { username: string; token: string; expectedHost: string } | null
}

interface GitCredentialOwner {
  nonce: string
  instanceId: string
  pluginId: string
  packageVersion: string
  workspaceId: string | null
  audience: string | null
  workspacePath: string
  requestIds: Set<string>
}

type GitPathGrantOperation = 'clone_target' | 'open_workspace'

interface GitPathGrant {
  instanceId: string
  workspacePath: string
  packageVersion: string
  path: string
  operations: ReadonlySet<GitPathGrantOperation>
  expiresAt: number
}

interface TerminalRoute {
  pluginId: string
  packageVersion: string | null
  workspaceId: string | null
  audience: string | null
  /** Null while a v2 view is detached and awaiting an authenticated takeover. */
  instanceId: string | null
  /** Legacy route mode is derived from descriptor identity, not the opener. */
  legacy: boolean
}

interface PendingTerminalOperation {
  operationId: string
  instanceId: string
  wsType: 'terminal.create' | 'terminal.reattach'
  client: WsClient
  paneId?: string
  createGeneration?: string
  route: TerminalRoute | null
  cancelled: boolean
  cancelSent: boolean
  cleanupSessionIds: Set<string>
}

interface PendingAiStart {
  pluginInstanceId: string
  paneId: string
  requestId: string
  client: WsClient
}

interface AiSessionLedgerEntry {
  sessionId: string
  profileId: string
  pluginId: string
  packageVersion: string
  workspaceId: string | null
  audience: string | null
  attachedInstanceId: string | null
  client: WsClient
  createdAt: number
  persistView?: boolean
  storageIdentity?: AiTerminalStorageIdentity
}

interface EarlyAiEventBuffer {
  instanceId: string
  expiresAt: number
  events: Array<{ type: 'terminal.output' | 'terminal.exit'; payload: unknown }>
}

interface PendingBackendSubscription {
  controller: AbortController
  subscription: BackendPluginSubscription | null
  unregister: (() => void) | null
  cancelled: boolean
}

const IPC_CALL = 'plugin:cap:call'
const IPC_CAST = 'plugin:cap:cast'
const IPC_HOST_CALL = 'plugin:host:call'
const IPC_EVENT = 'plugin:cap:event'
const IPC_READY = 'plugin:ready'
const IPC_HIDE_SELF = 'plugin:hideSelf'
const IPC_OPEN_TARGET = 'plugin:openTarget'
const IPC_BACKEND_CALL = 'plugin:backend:call'
const IPC_BACKEND_CANCEL = 'plugin:backend:cancel'
const IPC_BACKEND_SUBSCRIBE = 'plugin:backend:subscribe'
const IPC_BACKEND_EVENT = 'plugin:backend:event'
const IPC_BACKEND_STATUS = 'plugin:backend:status'
const IPC_FRAME_DOCUMENT_READY = 'plugin:frame:document-ready'
const IPC_RECEIVER_REGISTER = 'plugin:receiver:register'
const IPC_RECEIVER_LIST_LEFT = 'plugin:receiver:list-left-contributions'
const IPC_RECEIVER_OPEN_LEFT = 'plugin:receiver:open-left'
const IPC_RECEIVER_MOUNT = 'plugin:receiver:mount'
const IPC_RECEIVER_ACCEPT_EXISTING = 'plugin:receiver:accept-existing'
const DETAIL_OPEN_TIMEOUT_MS = 10_000
/** The supervisor's 30 s bridge timer (pluginBackendSupervisor callTimeoutMs)
 *  answers the backend first, with TIMEOUT; this Host wait is only longer than
 *  the Python broker's own 30 s (ws_handlers `shell.run`) so the Host request
 *  itself never ends first. A command the broker already started is not
 *  cancelled: it runs to completion (disclosed in the consent text). */
const THIRD_PARTY_SHELL_RUN_TIMEOUT_MS = 35_000

/** The broker cuts each shell.run text field at 8000 characters; passed on as
 *  sent: `truncated`, and the full UTF-8 sizes (`stderrBytes` only when stderr
 *  was cut). Fields the broker did not send are left out. */
export function shellRunTruncation(
  response: Record<string, unknown>,
): { truncated?: boolean; stdoutBytes?: number; stderrBytes?: number } {
  const out: { truncated?: boolean; stdoutBytes?: number; stderrBytes?: number } = {}
  if (typeof response.truncated === 'boolean') out.truncated = response.truncated
  if (Number.isSafeInteger(response.stdoutBytes)) out.stdoutBytes = response.stdoutBytes as number
  if (Number.isSafeInteger(response.stderrBytes)) out.stderrBytes = response.stderrBytes as number
  return out
}
const IPC_RECEIVER_DISPOSE = 'plugin:receiver:dispose'
const IPC_RECEIVER_ABORT = 'plugin:receiver:abort'
const IPC_RECEIVER_BLANK_READY = 'plugin:receiver:blank-ready'
const IPC_RECEIVER_ITEM_CLOSED = 'plugin:receiver:item-closed'
const IPC_RECEIVER_REQUEST_CLOSE = 'plugin:receiver:request-close'
const IPC_RECEIVER_REQUEST_CLOSE_TRANSACTION = 'plugin:receiver:request-close-transaction'
const IPC_RECEIVER_CLOSE_REQUEST = 'plugin:receiver:close-request'
const IPC_RECEIVER_CLOSE_CANCELLED = 'plugin:receiver:close-cancelled'
const IPC_RECEIVER_RESOLVE_CLOSE = 'plugin:receiver:resolve-close'
const IPC_RECEIVER_EDITOR_TARGET = 'plugin:receiver:editor-target'
const IPC_RECEIVER_RESOLVE_EDITOR_TARGET = 'plugin:receiver:resolve-editor-target'
const IPC_VIEW_CLOSE_REQUEST = 'plugin:view:close-request'
const MAX_DETAIL_CLOSE_TRANSACTION_ITEMS = 24
const PLUGIN_BACKEND_TEMP_ENV_KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const
const BACKEND_IDENTITY_KEYS = new Set([
  'pluginId',
  'packageVersion',
  'workspaceId',
  'instanceId',
  'contributionKey',
  'hostWindowId',
  'runtime',
  'initiator',
])

/** Keep the packaged one-file backend able to extract itself without passing
 * the Electron process environment across the plugin trust boundary. */
export function createPluginBackendChildEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {}
  for (const key of PLUGIN_BACKEND_TEMP_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0 && !value.includes('\u0000')) {
      environment[key] = value
    }
  }
  return Object.freeze(environment)
}
const TERMINAL_OWNED_WS_TYPES = new Set([
  'terminal.input',
  'terminal.log_sent',
  'terminal.resize',
  'terminal.interrupt',
  'terminal.kill',
  'terminal.redraw',
])

/** These first-party packages consume the public aiCli event vocabulary. Other
 * v2 packages may declare aiCli for capability admission without opting into
 * the event translation, so their internal terminal ownership remains intact. */
const PUBLIC_AI_CLI_EVENT_PLUGIN_IDS = new Set(['navide.git', 'navide.plans', 'navide.mini-ide'])

function usesPublicAiCliEvents(plugin: RunningPlugin | undefined): plugin is RunningPlugin {
  return Boolean(
    plugin?.hasV2DescriptorIdentity &&
      PUBLIC_AI_CLI_EVENT_PLUGIN_IDS.has(plugin.id) &&
      plugin.capabilityPolicy.kind === 'manifest-v2' &&
      plugin.capabilityPolicy.system.includes('aiCli')
  )
}

/** First-party compatibility actions used while the existing Git surface is
 *  moved behind the Manifest v2 package boundary. These are deliberately
 *  narrower than a generic Host RPC: package identity, sender identity, and
 *  workspace binding are all checked before any action reaches the backend. */
const GIT_HOST_ACTIONS = new Set(['git.request', 'issues.request', 'fs.request'])
const GIT_PRIVATE_ACTIONS = new Set([
  'git.contribution',
  'git.account',
  'git.legacyRepoSelection',
])
const GIT_CONTRIBUTION_OPERATIONS = new Set([
  'get_state',
  'open_path',
  'open_temp_file',
  'pick_workspace',
  'open_main_window',
  'open_branch_diff_window',
  'open_git_window',
  'open_git_history_window',
  'changes_count',
  'open_workspace',
  'open_file',
  'open_conflict',
  'open_diff',
  'open_branch_diff',
  'dispatch_issue',
  'spawn_for_issue',
  'focus_pane',
  'open_git_accounts',
  'open_worktree',
  'execute_host_command',
])
const GIT_HOST_COMMANDS = new Set([
  'controlPane.selectSidebarTab1',
  'controlPane.selectSidebarTab2',
  'controlPane.selectSidebarTab3',
  'controlPane.selectSidebarTab4',
  'controlPane.selectSidebarTab5',
  'workbench.action.focusSourceControl',
  'workbench.action.openGitWindow',
])
const GIT_ACCOUNT_OPERATIONS = new Set([
  'list',
  'add',
  'get_binding',
  'bind',
  'unbind',
])
const GIT_REMOTE_REQUEST_TYPES = new Set([
  'git.clone',
  'git.sync',
  'git.fetch',
  'git.pull',
  'git.push',
  'git.push_upstream',
  'git.pull_rebase',
  'git.push_force',
])
const GIT_HOST_UI_ACTIONS = new Set([
  'ui.open_in_editor',
  'ui.open_external',
  'ui.reveal_path',
  'ui.open_workspace',
  'ui.pick_folder',
])
/** Upper bound on a preview file the Git package may ask the Host to open. */
const GIT_TEMP_FILE_MAX_CHARS = 10 * 1024 * 1024
const GIT_PATH_GRANT_TTL_MS = 5 * 60 * 1000
const MAX_GIT_PATH_GRANTS_PER_INSTANCE = 16
const GIT_HOST_FS_TYPES = new Set([
  'fs.read_file',
  'fs.write_file',
  'fs.list_dir',
  'fs.list_files_flat',
  'fs.glob_files',
  'fs.delete',
  'fs.rename',
  'fs.read_image',
  'fs.list_archive',
  'fs.convert_office',
  'fs.stat_path',
])
const GIT_HOST_FS_MUTATION_TYPES = new Set([
  'fs.write_file',
  'fs.delete',
  'fs.rename',
])
const PUBLIC_FS_WS_TYPES: Readonly<Record<string, string>> = {
  'fs.readFile': 'fs.read_file',
  'fs.writeFile': 'fs.write_file',
  'fs.readImage': 'fs.read_image',
  'fs.listDirectory': 'fs.list_dir',
  'fs.listFilesFlat': 'fs.list_files_flat',
  'fs.glob': 'fs.glob_files',
  'fs.statPath': 'fs.stat_path',
  'fs.stat': 'fs.stat_path',
}
/** `workspace_path` param of an entry query ('' when absent) — the view's
 *  identity in {@link FrontendPluginManager.open}. Deliberately blind to
 *  `file_ws` (the root of a file opened from outside the workspace): an
 *  external-file open keeps the same workspace and must add a tab in-page,
 *  never reload the view out from under its open buffers. */
function workspaceOf(query: string): string {
  return new URLSearchParams(query).get('workspace_path') ?? ''
}

export type PlansPackageSource =
  | 'official-registry'
  | 'developer-local-unpacked'
  | 'factory-bundled'
  | 'factory-dev'
  | 'host-bundled'
  | 'installed'

const PLANS_PACKAGE_SOURCES = new Set<PlansPackageSource>([
  'official-registry',
  'developer-local-unpacked',
  'factory-bundled',
  'factory-dev',
  'host-bundled',
  'installed',
])

/** Build the Plans DevTools provenance query from fixed Host vocabulary only.
 * This accepts no filesystem identity, so the URL is safe to expose in every
 * runtime while still identifying the selected package class and version. */
export function appendPlansProvenanceQuery(
  query: string,
  packageVersion: string,
  packageSource: PlansPackageSource,
): string {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
  params.set('plans_package_version', packageVersion)
  params.set('plans_package_source', PLANS_PACKAGE_SOURCES.has(packageSource) ? packageSource : 'host-bundled')
  return `?${params.toString()}`
}

/** Entry query string → plain params record (as sent over IPC_OPEN_TARGET). */
function queryToParams(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(query)) out[key] = value
  return out
}

/** Bring a host window to the front (restore if minimized), legacy-editor style. */
function revealHostWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** The `navide.` publisher namespace is reserved for first-party packages;
 *  the internal Host event identity is never a plugin id. First-party ids may
 *  only be registered by the host itself or an install whose official-key
 *  verification passed. */
export function isReservedPluginId(id: string): boolean {
  return id === HOST_EVENT_SOURCE_PLUGIN_ID || id.startsWith('navide.')
}

/** The three bundled first-party Navide plugins. They cannot be removed; the
 *  user can disable them. Their names, for messages the user reads. */
export const BUILTIN_PLUGIN_NAMES: ReadonlyMap<string, string> = new Map([
  ['navide.plans', 'Plans'],
  ['navide.git', 'Git'],
  ['navide.mini-ide', 'Mini-IDE'],
])

/** A web view refusal as a capability error. The view-side contract has no
 *  USER_IN_CONTROL code, so it is CAPABILITY_DENIED with the reason in the
 *  message; the registry's messages are Host-authored. */
function webViewCapabilityError(reqId: string, error: WebViewError): CapabilityResponse {
  switch (error.code) {
    case 'INVALID_ARGUMENT':
      return buildError(reqId, 'INVALID_ARGUMENT', 'invalid web view request')
    case 'RESOURCE_LIMIT':
      return buildError(reqId, 'RESOURCE_LIMIT', 'too many web views')
    case 'USER_IN_CONTROL':
      return buildError(reqId, 'CAPABILITY_DENIED', `the user is in control of this web view (${error.reason ?? 'user-owned'})`)
    default:
      return buildError(reqId, 'CAPABILITY_DENIED', error.message === error.code ? 'web view request denied' : error.message)
  }
}

/** What the Host tells the user (and an agent) when it refuses to act through
 *  a disabled built-in plugin. */
export function builtinPluginDisabledMessage(pluginId: string): string {
  const name = BUILTIN_PLUGIN_NAMES.get(pluginId) ?? pluginId
  return `Navide plugin ${name} is disabled. Enable it in Settings → Extensions.`
}

/** A Host refusal of an agent call into a disabled built-in plugin. The code
 *  and reason are the agent-tools contract's (docs/en-US/plugin-agent-tools-contract.md
 *  §4.2); it never carries a recovery disposition, so the MCP adapter cannot
 *  fall back to serving the call itself. */
export interface BuiltinPluginDisabledResponse {
  reqId: string
  ok: false
  error: { code: Extract<AgentToolCallErrorCode, 'PLUGIN_TOOL_UNAVAILABLE'>; message: string }
  reason: Extract<AgentToolUnavailableReason, 'plugin-disabled'>
}

function hasOfficialRegistryAuthority(trust: InstalledRegistryTrustContext): boolean {
  return (
    trust.registryAuthority === 'official' &&
    trust.officialRegistryUrl !== undefined &&
    trust.snapshot?.metadata.registryProfile === 'official' &&
    trust.pinnedRootKey !== null
  )
}

/**
 * Manages the lifecycle of frontend plugin views and brokers their capability
 * calls. Host-generated instances own plugin views across every host window.
 */
/** Coerce plugin-supplied args into a WS payload object; non-objects become an
 *  empty payload rather than corrupting the backend request. */
function toPayload(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}

/** Project the Host directory listing into the stable public shape. The
 * backend includes Explorer metadata and uses `is_dir`; retain that metadata
 * while deriving the older public `kind` field for SDK consumers. */
function normalizePublicDirectoryResult(value: unknown): Record<string, unknown> {
  const result = toPayload(value)
  const entries = Array.isArray(result.entries)
    ? result.entries.flatMap((value): Record<string, unknown>[] => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
        const entry = value as Record<string, unknown>
        if (typeof entry.name !== 'string') return []
        const kind = typeof entry.is_dir === 'boolean'
          ? (entry.is_dir ? 'directory' : 'file')
          : entry.kind === 'directory' ? 'directory' : 'file'
        const projected: Record<string, unknown> = { name: entry.name, kind }
        for (const key of ['rel_path', 'is_dir', 'is_hidden', 'is_noise']) {
          if (entry[key] !== undefined) projected[key] = entry[key]
        }
        return [projected]
      })
    : []
  return { ...result, entries }
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen))
  seen.delete(value)
  return valid
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isExpectedHttpsRemote(url: unknown, expectedHost: string): boolean {
  if (typeof url !== 'string' || !url) return false
  try {
    const remote = new URL(url)
    return remote.protocol === 'https:' && remote.hostname === expectedHost
  } catch {
    return false
  }
}

function isStorageExecutionAddress(value: string): value is StorageExecutionAddress {
  return value === 'storage.get' || value === 'storage.set' || value === 'storage.delete'
}

function nonEmptyOrNull(value: string | null): boolean {
  return value === null || nonEmptyString(value)
}

function hasV2DescriptorIdentity(descriptor: PluginLaunchDescriptor): boolean {
  return descriptor.packageVersion !== undefined || descriptor.views !== undefined
}

function hasValidBindingFields(binding: AuthenticatedRuntimeBinding): boolean {
  return (
    nonEmptyString(binding.pluginId) &&
    nonEmptyString(binding.packageVersion) &&
    nonEmptyOrNull(binding.workspaceId) &&
    nonEmptyOrNull(binding.instanceId) &&
    nonEmptyOrNull(binding.audience)
  )
}

function sameRuntimeBinding(
  left: AuthenticatedRuntimeBinding | null | undefined,
  right: AuthenticatedRuntimeBinding | null | undefined
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.pluginId === right.pluginId &&
    left.packageVersion === right.packageVersion &&
    left.workspaceId === right.workspaceId &&
    left.instanceId === right.instanceId &&
    left.audience === right.audience
  )
}

function sameTerminalRoute(left: TerminalRoute | null, right: TerminalRoute | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.pluginId === right.pluginId &&
    left.packageVersion === right.packageVersion &&
    left.workspaceId === right.workspaceId &&
    left.audience === right.audience &&
    left.instanceId === right.instanceId &&
    left.legacy === right.legacy
  )
}

function packageVersionKey(pluginId: string, packageVersion: string): string {
  return `${pluginId}\u0000${packageVersion}`
}

function validateV2CapabilityContext(
  descriptor: PluginLaunchDescriptor,
  context: HostCapabilityContext | null
): void {
  if (context === null || !hasV2DescriptorIdentity(descriptor)) return
  const packageVersion = descriptor.packageVersion
  if (!nonEmptyString(packageVersion) || descriptor.views === undefined) {
    throw new Error(`Manifest v2 plugin '${descriptor.id}' is missing canonical package identity`)
  }
  const binding = context.runtimeBinding
  if (
    !binding ||
    !hasValidBindingFields(binding) ||
    binding.pluginId !== descriptor.id ||
    binding.packageVersion !== packageVersion
  ) {
    throw new Error(`capability context identity does not match plugin '${descriptor.id}'`)
  }
  if (context.userGrant && context.userGrant.packageVersion !== packageVersion) {
    throw new Error(`capability context grant version does not match plugin '${descriptor.id}'`)
  }
  if (context.storageSnapshots) {
    for (const [tier, version] of context.storageSnapshots) {
      if (
        !['candidate', 'active', 'previous'].includes(tier) ||
        !nonEmptyString(version)
      ) {
        throw new Error(
          `capability context storage snapshot map is invalid for plugin '${descriptor.id}'`
        )
      }
    }
  }
  if (
    context.storageSnapshotTier !== undefined &&
    context.storageSnapshots?.get(context.storageSnapshotTier) !== packageVersion
  ) {
    throw new Error(
      `capability context selected storage tier does not match plugin '${descriptor.id}'`
    )
  }
  for (const [label, bindings] of [
    ['session', context.sessionBindings],
    ['pending start', context.pendingStartBindings],
  ] as const) {
    if (!bindings) continue
    for (const binding of bindings.values()) {
      if (
        !hasValidBindingFields(binding) ||
        binding.pluginId !== descriptor.id ||
        binding.packageVersion !== packageVersion
      ) {
        throw new Error(`${label} binding does not match plugin '${descriptor.id}'`)
      }
    }
  }
}

export const MAX_DIAGNOSTIC_LINE_CHARS = 2048
export const MAX_DIAGNOSTIC_LINES_PER_EMISSION = 100

export function sanitizeDiagnosticLines(raw: unknown): string[] {
  if (raw === null || raw === undefined) return []
  const text = typeof raw === 'string' ? raw : String(raw)
  const strippedAnsi = text.replace(/\x1B(?:\].*?(?:\x07|\x1B\\\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]|.?)/gu, '')
  const strippedControls = strippedAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/gu, '')
  const rawLines = strippedControls.split(/\r\n|\r|\n|\u2028|\u2029/u)
  const result: string[] = []

  for (const rawLine of rawLines) {
    const line = rawLine.trimEnd()
    if (line.length === 0) continue
    if (result.length >= MAX_DIAGNOSTIC_LINES_PER_EMISSION) {
      result.push('... [diagnostic lines truncated]')
      break
    }
    if (line.length > MAX_DIAGNOSTIC_LINE_CHARS) {
      result.push(`${line.slice(0, MAX_DIAGNOSTIC_LINE_CHARS)}... [line truncated]`)
    } else {
      result.push(line)
    }
  }

  return result
}

const HOST_RESIZE_EVENTS = [
  'resize', 'resized', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen',
] as const
const HOST_RESIZE_SETTLE_MS = 150

export class FrontendPluginManager {
  private readonly descriptorSources = new Map<string, 'installed-catalog' | 'factory-bundle' | 'host-bundled'>()
  private plansDiagnosticsEnabled = false
  private plansShellHandlers: {
    dispatchExecution: (args: { workspace_path: string; rel_path: string; agent_key: string }) => { delivered: boolean }
    openPath: (absolutePath: string) => Promise<{ ok: boolean; error?: string; revealed?: boolean }>
  } | null = null

  setPlansShellHandlers(handlers: NonNullable<FrontendPluginManager['plansShellHandlers']>): void {
    this.plansShellHandlers = handlers
  }

  forwardPlansExecutionResult(payload: { workspace_path: string; rel_path: string; ok: boolean; reason?: string }): void {
    for (const plugin of this.running.values()) {
      if (plugin.id === PLANS_PLUGIN_ID && plugin.hasV2DescriptorIdentity &&
        plugin.workspacePath && resolve(plugin.workspacePath) === resolve(payload.workspace_path)) {
        this.emitToInstance(plugin.instanceId, 'plans.execution-result', payload)
      }
    }
  }

  /** Host-only switch: packaged startup never enables this diagnostic. */
  setPlansDiagnosticsEnabled(enabled: boolean): void {
    this.plansDiagnosticsEnabled = enabled
  }

  /** Inspect the exact selected frontend/backend tuple without granting access
   * or starting a child. Filesystem identities remain inside the Host. */
  getPlansProvenance(): {
    descriptorSource: string
    selectionOrigin: string
    acquisitionProvenance: string | null
    packageDirectory: string | null
    packageVersion: string | null
    frontendEntry: string
    frontendEntries: Record<string, string>
    backendExecutable: string | null
  } | null {
    const descriptor = this.descriptors.get(PLANS_PLUGIN_ID)
    if (!descriptor) return null
    const selectionOrigin = this.descriptorSources.get(PLANS_PLUGIN_ID) ?? 'host-bundled'
    const packageDirectory = canonicalBackendPackageDir(descriptor.packageDir)
    const activation = descriptor.packageVersion && packageDirectory
      ? this.pluginBackendHost.activationFor(PLANS_PLUGIN_ID, descriptor.packageVersion, packageDirectory)
      : undefined
    const installed = selectionOrigin === 'installed-catalog'
      ? this.installedPackages.get(PLANS_PLUGIN_ID)
      : undefined
    return {
      descriptorSource: selectionOrigin,
      selectionOrigin,
      acquisitionProvenance: selectionOrigin === 'factory-bundle'
        ? 'factory-bundled'
        : installed?.provenance ?? null,
      packageDirectory,
      packageVersion: descriptor.packageVersion ?? null,
      frontendEntry: descriptor.entryFile,
      frontendEntries: Object.fromEntries((descriptor.views ?? []).map((view) => [view.contributionKey, view.entryFile])),
      backendExecutable: activation?.entryFile ?? null,
    }
  }
  private readonly loggedDiagnosticCauses = new WeakSet<object>()

  private emitHostDiagnosticChunk(chunk: string): void {
    const lines = sanitizeDiagnosticLines(chunk)
    for (const line of lines) {
      warnMain(`[plugin-backend] ${line}`)
    }
  }

  private emitHostBackendFailureDiagnostic(pluginId: string, error: BackendPluginError): void {
    const cause = error.cause
    if (!cause) return

    if (typeof cause === 'object' && cause !== null) {
      if (this.loggedDiagnosticCauses.has(cause)) return
      this.loggedDiagnosticCauses.add(cause)
    }
    this.loggedDiagnosticCauses.add(error)

    const rawCause = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
    const lines = sanitizeDiagnosticLines(rawCause)
    if (lines.length === 0) return

    warnMain(`[plugin-backend] Backend child failure for ${pluginId}: ${lines[0]}`)
    for (let i = 1; i < lines.length; i++) {
      warnMain(`[plugin-backend] ${lines[i]}`)
    }
  }

  /** What {@link closeBackendPlugins} unregistered, for {@link reopenBackendPlugins}. */
  private activationsBeforeClose: BackendPluginLaunchSpec[] = []
  /** Package-local Backend Wire children receive only Host-approved temp paths. */
  private readonly pluginBackendHost = new PluginBackendHost({
    environment: createPluginBackendChildEnvironment(),
    // D-e: every settled backend call of a third-party plugin, whichever path
    // made it (its own frontend, an agent tool, an agent capability request),
    // counted per key and flushed with the other activity rows. The bundled
    // navide.* packages are not recorded, as for broker calls.
    // A name the backend does not declare is counted under one fixed address:
    // names have no length or variety limit, so they cannot be keys.
    observesCallsOf: (pluginId) => !isReservedPluginId(pluginId),
    onCallSettled: (call) => {
      if (isReservedPluginId(call.pluginId)) return
      this.activityRecorder.recordBackendCall({
        plugin_id: call.pluginId,
        plugin_version: call.packageVersion,
        workspace: call.workspacePath ?? '',
        address: call.declared ? backendCallAddress(call.method) : BACKEND_CALL_UNDECLARED_ADDRESS,
        outcome: call.outcome,
      })
    },
    onStderr: (chunk) => {
      this.emitHostDiagnosticChunk(chunk)
    },
    resolvePlanRoot: async ({ workspacePath, signal }) => {
      if (signal.aborted) throw new BackendPluginError('USER_CANCELLED')
      return resolvePlansRootPath(workspacePath)
    },
    resolveExecutionPolicy: (_runtime, workspacePath) =>
      this.executionPolicyResolver?.(workspacePath),
    onBackendFailure: (runtime, error) => {
      if (error.cause) {
        this.emitHostBackendFailureDiagnostic(runtime.pluginId, error)
      }
      if (error.message === BACKEND_RESTART_BUDGET_SPENT_MESSAGE) {
        // The child stays stopped for good. Outside Plans nothing else tells
        // anyone, and the host's own line went only to the console.
        warnMain(`[plugin-backend] ${runtime.pluginId} failed too often; leaving it stopped (${error.code})`)
        recordMainFault('plugin.backend_gave_up', `${runtime.pluginId} (${runtime.instanceId ?? 'no instance'}): ${error.code}`)
      }
      if (runtime.pluginId === PLANS_PLUGIN_ID && this.isPlansBackendAvailabilityError(error)) {
        if (error.message === BACKEND_RESTART_BUDGET_SPENT_MESSAGE && runtime.instanceId) {
          // A given-up child is never restarted, so it must not hold Plans
          // withdrawn for every workspace: only its own workspace is refused
          // (before dispatch). Unlike an unbind, giving up does mark Plans
          // ready when it was the last dead child - nothing else would ever
          // bring the mark back, and every other child is known to be alive.
          const firstReport = !this.plansAbandonedBackendInstances.has(runtime.instanceId)
          this.plansDeadBackendInstances.delete(runtime.instanceId)
          this.plansAbandonedBackendInstances.add(runtime.instanceId)
          this.markPlansBackendReadyIfChildrenRecovered(runtime.packageVersion)
          // A view's failure is shown by legacy recovery; a headless child has
          // no surface, so tell the user once how to bring it back.
          const workspacePath = this.headlessPlansWorkspacePaths.get(runtime.instanceId)
          if (firstReport && workspacePath) {
            try {
              this.plansBackendStoppedHandler?.({ workspacePath })
            } catch {
              // A notice observer must not change the child failure result.
            }
          }
        } else {
          if (runtime.instanceId) this.plansDeadBackendInstances.add(runtime.instanceId)
          this.markPlansBackendUnavailable('child-unavailable')
        }
        const plugin = runtime.instanceId ? this.running.get(runtime.instanceId) : undefined
        if (plugin?.id === PLANS_PLUGIN_ID && plugin.workspacePath) {
          try {
            this.plansBackendFailureHandler?.({
              instanceId: plugin.instanceId,
              workspacePath: plugin.workspacePath,
              packageVersion: runtime.packageVersion,
              query: plugin.query,
              contributionKey: plugin.contributionKey,
              reason: error.message,
            })
          } catch {
            // A recovery observer must not change the child failure result.
          }
        }
      }
    },
    onBackendRestarted: (runtime) => {
      if (runtime.pluginId !== PLANS_PLUGIN_ID) return
      if (runtime.instanceId) this.plansDeadBackendInstances.delete(runtime.instanceId)
      this.markPlansBackendReadyIfChildrenRecovered(runtime.packageVersion)
    },
    onBackendUnbound: (runtime) => {
      if (runtime.pluginId !== PLANS_PLUGIN_ID || !runtime.instanceId) return
      // A gone view no longer blocks, but its going proves nothing about the
      // backend: the next restart or bind marks Plans ready.
      this.plansDeadBackendInstances.delete(runtime.instanceId)
      this.plansAbandonedBackendInstances.delete(runtime.instanceId)
      this.headlessPlansWorkspacePaths.delete(runtime.instanceId)
    },
  })
  private readonly pendingBackendCalls = new Map<string, Map<string, AbortController>>()
  private readonly pendingBackendSubscriptions = new Map<
    string,
    Map<string, PendingBackendSubscription>
  >()
  /** Host-generated instance id → running view. */
  private readonly running = new Map<string, RunningPlugin>()
  private readonly editorSelectionGrants = new EditorSelectionGrants()
  private editorNativeCapability: EditorNativeCapability | null = null
  private filePickerHost: FilePickerHost | null = null
  /** Plugin id → instances opened through the legacy adapter; a v2 descriptor may still be here. */
  private readonly legacyInstances = new Map<string, string>()
  /** Host-private package backend instances used by MCP when no Plans window
   *  is mounted. The key includes the package version and workspace identity;
   *  callers never receive the generated instance id. */
  private readonly headlessBackendInstances = new Map<string, string>()
  private readonly pendingHeadlessBackendBinds = new Map<string, Promise<string>>()
  /** Third-party agent-tool catalog (plan B1-b); null = never wired, every call refused. */
  private agentToolsHost: PluginAgentToolsHost | null = null
  /** True when a canonical directory is a workspace open in a Navide window
   * (plan B1-b target rule); unset = no workspace qualifies. */
  private agentToolWorkspaceResolver: ((root: string) => boolean) | null = null
  /** Headless third-party bindings created for agent-tool calls, by package/version/workspace. */
  private readonly headlessAgentToolInstances = new Map<string, string>()
  private readonly pendingHeadlessAgentToolBinds = new Map<string, Promise<string>>()
  /** instanceId -> canonical workspace root of a headless agent-tool binding. */
  private readonly headlessAgentToolRoots = new Map<string, string>()
  /** Agent-tool calls in flight, by their initiator id (read by the fs bridge). */
  /** Argument pieces of agent tool requests whose request has not arrived yet (contract 4.4, A2). */
  /** The core backend's agent tool result helper, as it last reported it (contract 4.4, R2). */
  private resultHelperState: AgentToolsResultHelperState = { state: 'idle', lastError: '', since: 0 }
  /** Told each time the backend reports a new result helper state. */
  onResultHelperState?: (state: AgentToolsResultHelperState) => void
  private readonly agentRequestPieces = new Map<string, {
    pieces: string[]
    shortSeen: boolean
    failed?: AgentToolChunksInvalidReason
    idle?: ReturnType<typeof setTimeout>
  }>()
  private readonly agentToolCalls = new Map<string, {
    pluginId: string
    risk: 'read' | 'write'
    workspaceRoot: string
    caller: AgentToolCaller
    spec: ThirdPartyLaunchSpec
  }>()
  /** Headless Plans instance id → its workspace, to tell the user which
   *  workspace's backend stopped. */
  private readonly headlessPlansWorkspacePaths = new Map<string, string>()
  /** webContents.id → opaque instance id, so a call's origin can be trusted,
   *  not the payload. */
  private readonly bySender = new Map<number, string>()
  /** Installed/available plugin descriptors keyed by id (loader registry). The
   *  mini-IDE is registered here as the first built-in; third-party installs are
   *  added by {@link loadInstalledPlugins} / {@link registerDescriptor}. */
  private readonly descriptors = new Map<string, PluginLaunchDescriptor>()
  /** Validated packages installed under userData/plugins, including packages
   *  with no frontend descriptor. */
  private readonly installedPackages = new Map<string, InstalledPluginPackageSummary>()
  /** Canonical roots for installed packages. Backend-only packages have no
   *  descriptor, so their Host-approved backend activation is matched here. */
  private readonly installedPackageDirectories = new Map<string, string>()
  /** Host-bundled builtin descriptors kept as fallbacks: removing a marketplace
   *  override of a bundled plugin reverts to the bundled copy instead of
   *  leaving the surface unavailable (see {@link removeInstalledPlugin}). */
  private readonly builtinFallbacks = new Map<string, PluginLaunchDescriptor>()
  private ipcReady = false
  /** Backend WS url as last reported by main, or null when no backend is up. */
  private backendWsUrl: string | null = null
  /** Main-process-only bearer used to authenticate this Host WS session. */
  private backendHostToken: string | null = null
  private hostSessionRegistered = false
  /** The `plans_backend_v2` feature the current registration advertised. */
  private hostSessionPlansBackendV2: boolean | null = null
  /** The `disabled_plugins` feature the current registration advertised. */
  private hostSessionDisabledPlugins = ''
  /** Backend activations of a disabled built-in, kept so Enable re-registers
   *  exactly what Disable drained. */
  private readonly suspendedBuiltinBackends = new Map<string, BackendPluginLaunchSpec[]>()
  private hostRegistrationTask: Promise<void> | null = null
  /** Lazily-created shared transport to the backend plugin host. */
  private wsClient: WsClient | null = null
  /** Answers `marketplace.query.request` (B2-a); set by registerPluginIpc. */
  private marketplaceQueryHandler: ((query: unknown) => Promise<MarketplaceQueryAnswer>) | null = null
  /** Answers `plugins.agent_action.request` (B2-c); set by registerPluginIpc. */
  private pluginAgentActionHandler: ((request: unknown) => Promise<PluginAgentActionAnswer>) | null = null
  private readonly editorAiCapability = new EditorAiCapability({
    request: (type, payload, beforeDispatch) => this.sendPublicBackend(type, payload, beforeDispatch),
    createReviewClient: (onDisconnected) => {
      const client = createWsClient({
        WebSocketImpl: NodeWebSocket as unknown as WsConstructor,
        onStatus: (status) => {
          if (status === 'disconnected' || status === 'error') onDisconnected()
        },
      })
      if (!this.backendWsUrl) throw new Error('backend not connected')
      client.connect(this.backendWsUrl)
      return client
    },
    publish: (instanceId, event, payload) => {
      const plugin = this.running.get(instanceId)
      const binding = plugin?.capabilityContext?.runtimeBinding
      if (plugin && binding && this.isPublicEventAllowedForInstance(plugin, event, payload, binding)) {
        this.emitToInstance(instanceId, event, payload)
      }
    },
  })
  /** Last transport status, replayed to late-loading plugin views so their
   *  useBackend shims start from real liveness instead of assuming it. */
  private wsStatus: WsClientStatus = 'disconnected'
  /** Plugin browser views (`web`); created on first use. */
  private webViewRegistry: PluginWebViewRegistry | null = null
  /** Host-owned executor seam for cataloged v2 plans. */
  private publicCapabilityHandler:
    | ((plan: PublicCapabilityExecutionPlan) => unknown | Promise<unknown>)
    | null = null
  /** Host-owned executor for the durable storage capability. Kept separate
   *  from the generic public handler so unimplemented public methods retain
   *  their existing unavailable behavior. */
  private publicStorageHandler:
    | ((execution: StorageExecution) => unknown | Promise<unknown>)
    | null = null
  /** Host-owned terminal presentation storage adapter. The adapter receives
   * only an identity derived from the live contribution binding. */
  private terminalStorageHandler:
    | ((
        origin: TerminalOwnerOrigin,
        request: TerminalStorageOwnerRequest,
        canDispatch: () => boolean,
      ) => Promise<TerminalStorageOwnerState | null>)
    | null = null
  /** Legacy v1 mini-IDE preference overlay selected by the Host. */
  private miniIdeLegacyPreferences: MiniIdeLegacyPreferences | null = null
  /** Shell selected by the Host backend for terminal children. Persisted AI
   *  views use this same shell; the legacy launch path remains unchanged. */
  private terminalShell = process.env.SHELL ?? 'bash'
  /** Host-owned source of effective agent Execution Policy snapshots. */
  private executionPolicyResolver:
    | ((workspacePath?: string) => ExecutionPolicySnapshot)
    | null = null
  /** The Host UI locale, for refusals the user reads through their agent. */
  private uiLocaleResolver: (() => SupportedLocale) | null = null
  /** Exact package-version tuples whose complete runtime is being revoked. */
  private readonly stoppingPlugins = new Set<string>()
  private readonly packageRevocationTasks = new Map<string, Promise<void>>()
  /** Old-version admission barriers retained between a restart drain and the
   * Host coordinator's selector/registry cutover. */
  private readonly pendingPackageRestarts = new WeakMap<PluginPackageRestartTransaction, PendingPackageRestart>()
  private readonly packageRestartBarriers = new Set<string>()
  /** Reject all new work for a plugin while its selectors are between old and
   * current versions. Internal restoration mounts directly after re-resolution. */
  private readonly restartingPluginIds = new Set<string>()
  /** Generic package storage selection from the Host activation coordinator.
   * Plans and Mini-IDE keep their existing specialized selection paths. */
  private readonly pluginStorageSnapshotSelections = new Map<
    string,
    { activeVersion: string; previousVersion?: string }
  >()
  /** Package versions displaced by the temporary legacy recovery descriptor. */
  private readonly recoveryPackageVersions = new Map<string, string>()
  /** Host-renderer state for the left Git contribution, keyed by its host
   *  BrowserWindow. It is never serialized into a public capability context. */
  private readonly gitContributionStates = new Map<number, GitContributionState>()
  /** Main-owned safeStorage adapter for the first-party Git account surface. */
  private gitAccountHandlers: GitAccountHandlers | null = null
  private contributionIconResolver: ((iconFile: string) => { url: string; monochrome?: boolean } | null) | null = null
  private capabilityGrantResolver:
    | ((pluginId: string, packageVersion: string) => HostCapabilityGrant | null)
    | null = null
  private disabledPluginResolver: ((pluginId: string) => boolean) | null = null
  /** Previous Plans snapshot selected by the Host lifecycle record. It is
   *  intentionally absent until the lifecycle has found a real prior active
   *  package; current candidate/active identities are never reused as a fake
   *  previous snapshot. */
  private plansStorageSnapshotContext: {
    packageVersion: string
    previousPackageVersion: string | null
  } | null = null
  /** Host-selected Mini-IDE storage identities. The previous package is
   *  supplied by the lifecycle migration, never by a renderer contribution. */
  private miniIdeStorageSnapshotContext: {
    packageVersion: string
    previousPackageVersion: string | null
  } | null = null
  private plansStorageReadinessHandler: ((packageVersion: string) => Promise<boolean>) | null = null

  /** Host-only migration admission shared by renderer and headless requests. */
  setPlansStorageReadinessHandler(handler: (packageVersion: string) => Promise<boolean>): void {
    this.plansStorageReadinessHandler = handler
  }

  private async plansStorageReady(packageVersion: string | undefined): Promise<boolean> {
    if (!packageVersion) return false
    try {
      return await this.plansStorageReadinessHandler!(packageVersion)
    } catch {
      return false
    }
  }

  private async plansInstanceStorageAdmission(plugin: RunningPlugin, reqId: string): Promise<CapabilityResponse | null> {
    if (plugin.id !== PLANS_PLUGIN_ID || !plugin.hasV2DescriptorIdentity || !this.plansStorageReadinessHandler) return null
    const binding = plugin.capabilityContext?.runtimeBinding
    const ready = await this.plansStorageReady(binding?.packageVersion)
    if (this.isPluginStopping(plugin)) return buildError(reqId, 'PLUGIN_STOPPING', 'plugin runtime is stopping')
    if (
      this.running.get(plugin.instanceId) !== plugin ||
      !binding || !sameRuntimeBinding(binding, plugin.capabilityContext?.runtimeBinding) ||
      !this.plansCapabilityContext(binding.packageVersion, plugin.workspacePath ?? '', binding.audience ?? undefined)
    ) {
      warnMain(`[plugin-backend] ${PLANS_PLUGIN_ID} call denied for ${plugin.instanceId}: runtime Grant is unavailable`)
      return buildError(reqId, 'CAPABILITY_DENIED', 'Plans runtime Grant is unavailable')
    }
    return ready ? null : buildError(reqId, 'BACKEND_UNAVAILABLE', 'Plans storage is unavailable')
  }
  private activationFailureHandler:
    | ((failure: { pluginId: string; packageVersion: string; reason: string }) => void)
    | null = null
  private plansBackendFailureHandler:
    | ((failure: {
        instanceId: string
        workspacePath: string
        packageVersion: string
        query: string
        contributionKey: string | null
        reason: string
      }) => void)
    | null = null
  private plansBackendStoppedHandler: ((stopped: { workspacePath: string }) => void) | null = null
  /** Host-only liveness for the exact selected Plans descriptor/activation.
   *  An unavailable child must withdraw the MCP feature until a later bind
   *  succeeds; otherwise MCP keeps selecting the broken v2 adapter. */
  private plansBackendHealth: PlansBackendHealth = 'unknown'
  private plansBackendHealthIdentity: { packageVersion: string; packageDir: string } | null = null
  /** Whether the current unavailable mark comes only from child deaths, which
   *  a child coming back through an automatic restart may undo. Any other
   *  cause (legacy recovery, storage, a failed bind or view) keeps the mark
   *  until its own path clears it. */
  private plansUnavailableByChildDeath = false
  /** Bound Plans instances whose child died and has not come back yet. Plans
   *  is marked ready again only once none is left. */
  private readonly plansDeadBackendInstances = new Set<string>()
  /** Bound Plans instances whose child spent its restart budget. Agent calls
   *  for them are refused before dispatch until they are unbound. */
  private readonly plansAbandonedBackendInstances = new Set<string>()
  /** Headless Plans instances a user retry unbound. Their in-flight calls fail
   *  because of that unbind, not because the backend is unavailable, so they
   *  must not withdraw v2 again. Instance ids are never reused. */
  private readonly plansDiscardedBackendInstances = new Set<string>()
  private readonly pendingActivations = new Map<
    string,
    ReturnType<typeof setTimeout> | null
  >()
  /** Preflight waits are Host-private and deliberately independent of the
   * production activation-failure observer. */
  private readonly pluginReadyWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  /** Instances whose readiness budget already bought them one reload. A missed
   *  budget is usually a loaded machine rather than a broken package, so the
   *  guest is reloaded once before the failure is allowed to cost the session
   *  its v2 activation. */
  private readonly readinessReloaded = new Set<string>()
  /** Opaque picker provenance for the private first-party Git bridge. */
  private readonly gitPathGrants = new Map<string, GitPathGrant>()
  /** One unbound remote operation owns each interactive askpass exchange.
   *  The nonce crosses the backend transport but is never exposed to plugin
   *  code; request ids are accepted only from the exact originating view. */
  private readonly gitCredentialOwners = new Map<string, GitCredentialOwner>()
  private readonly gitCredentialRequests = new Map<string, GitCredentialOwner>()
  /** `terminal_session_id` → authenticated route ownership. v2 teardown
   *  clears the live instance id but retains the stable tuple as a tombstone;
   *  legacy routes retain their plugin-id adapter semantics. */
  private readonly terminalRoutes = new Map<string, TerminalRoute>()
  /** The owner captured when a pending output batch was queued. A flush must
   *  still match the current route, otherwise a delayed timer could deliver a
   *  detached view's bytes to a later instance. */
  private readonly pendingTerminalOwners = new Map<string, string>()
  /** Host-side subscription disposers grouped by exact view instance. */
  private readonly instanceSubscriptions = new Map<string, Set<() => void>>()
  /** Region composition owns these handles by Host window and contribution
   *  key. The renderer only sees catalog metadata and never receives the
   *  opaque instance id. */
  private readonly contributionInstances = new Map<string, PluginViewHandle>()
  /** Frame documents have their own exact-frame identity and a private port;
   * they must never enter the sender-id map used by native/GuestAttach views. */
  private readonly pluginFrameBindings = new PluginFrameBindingRegistry()
  private readonly pluginFrameAssets = new PluginFrameAssetProtocol()
  private readonly pendingPluginFrames = new Map<string, PendingPluginFrame>()
  /** Receiver instance → opaque frame bindings owned by its current document. */
  private readonly receiverFrameBindings = new Map<string, Set<string>>()
  private readonly receiverRegistrations = new Map<string, ReceiverRegistration>()
  private readonly receiverItems = new Map<string, ReceiverItem>()
  private readonly detailPairs = new Map<string, DetailPair>()
  private readonly pendingDetailCloses = new Map<string, PendingDetailClose>()
  private readonly pendingReceiverCloses = new Map<string, PendingReceiverClose>()
  private readonly detailCloseTransactions = new Map<string, DetailCloseTransaction>()
  private readonly detailCloseLocks = new Map<string, string>()
  private readonly receiverCloseLocks = new Map<string, string>()
  private readonly pendingWindowCloses = new Map<string, PendingWindowClose>()
  private readonly pendingDetailOpens = new Map<string, PendingDetailOpen>()
  private readonly pendingDetailTargets = new Map<string, PendingDetailTarget>()
  private readonly pendingEditorTargets = new Map<string, PendingEditorTarget>()
  private capabilityCallHandler: ((plugin: RunningPlugin | undefined, payload: unknown) => Promise<CapabilityResponse>) | null = null
  /** D-e: broker calls of third-party plugins, sent to the backend in batches
   *  over the registered Host session; dropped while there is none. */
  private readonly activityRecorder = new PluginActivityRecorder(() => {
    const client = this.wsClient
    return client && this.hostSessionRegistered
      ? (type, payload) => client.send(type, payload, 10_000)
      : null
  })
  private backendCallHandler: ((plugin: RunningPlugin | undefined, payload: unknown) => Promise<CapabilityResponse>) | null = null
  private backendSubscribeHandler: ((plugin: RunningPlugin | undefined, payload: unknown) => Promise<CapabilityResponse>) | null = null
  /** In-window contributions whose `<webview>` guest has not attached yet,
   *  keyed by the one-time token carried in the entry URL. The token — never
   *  the instance id — is what reaches the renderer, so a guest can neither
   *  claim another instance nor learn its own handle. */
  private readonly pendingGuests = new Map<string, PendingGuest>()
  /** Awaiting terminal create/reattach responses. Teardown invalidates these
   *  records before a late backend response can register a route. */
  private readonly pendingTerminalOperations = new Map<string, PendingTerminalOperation>()
  /** Host-owned public aiCli start transactions. The package only receives an
   *  opaque session id; pane ids and backend payloads stay in this map. */
  private readonly pendingAiStarts = new Map<string, PendingAiStart>()
  /** Detached AI sessions survive a view close and may be resumed only by a
   *  new instance with the same Host-authenticated stable tuple. */
  private readonly aiSessions = new Map<string, AiSessionLedgerEntry>()
  /** PTY output can beat terminal.create's response. Buffer a small, short-
   *  lived ordered prefix until the pending start establishes its route. */
  private readonly earlyAiEvents = new Map<string, EarlyAiEventBuffer>()
  /** Decode raw PTY bytes only after the authenticated public event gate. */
  private readonly aiTerminalOutputDecoder = new AiTerminalOutputDecoder()
  /** Per-session micro-batcher for terminal.output (see the broker module):
   *  coalesces the dense PTY stream into one IPC send per ~12 ms per session. */
  private readonly terminalOutputBatcher: TerminalOutputBatcher = createTerminalOutputBatcher(
    (sessionId, payload) => {
      const owner = this.pendingTerminalOwners.get(sessionId)
      this.pendingTerminalOwners.delete(sessionId)
      const route = this.terminalRoutes.get(sessionId)
      const plugin = route ? this.runningPluginForTerminalRoute(route) : undefined
      if (usesPublicAiCliEvents(plugin)) {
        const data = toPayload(payload).data
        this.emitPublicAiOutput(plugin, sessionId, data)
        return
      }
      this.deliverTerminalEvent('terminal.output', sessionId, payload, owner)
    }
  )

  private resolveInstance(id: string): RunningPlugin | undefined {
    const direct = this.running.get(id)
    if (direct) return direct
    const legacyId = this.legacyInstances.get(id)
    return legacyId ? this.running.get(legacyId) : undefined
  }

  private instancesForPlugin(pluginId: string): RunningPlugin[] {
    return [...this.running.values()].filter((plugin) => plugin.id === pluginId)
  }

  private packageVersionOfPlugin(plugin: RunningPlugin): string | null {
    const packageVersion = plugin.capabilityContext?.runtimeBinding?.packageVersion
    return nonEmptyString(packageVersion) ? packageVersion : null
  }

  private isPluginStopping(plugin: RunningPlugin): boolean {
    const packageVersion = this.packageVersionOfPlugin(plugin)
    return this.restartingPluginIds.has(plugin.id) || (
      packageVersion !== null && this.stoppingPlugins.has(packageVersionKey(plugin.id, packageVersion))
    )
  }

  private isPackageVersionStopping(pluginId: string, packageVersion: unknown): boolean {
    return (
      typeof packageVersion === 'string' &&
      packageVersion.length > 0 &&
      (this.restartingPluginIds.has(pluginId) ||
        this.stoppingPlugins.has(packageVersionKey(pluginId, packageVersion)))
    )
  }

  private packageVersionForPluginId(pluginId: string): string | null {
    const descriptorVersion = this.descriptors.get(pluginId)?.packageVersion
    if (nonEmptyString(descriptorVersion)) return descriptorVersion
    const activationVersion = this.pluginBackendHost.activationForPlugin(pluginId)?.packageVersion
    return nonEmptyString(activationVersion) ? activationVersion : null
  }

  private instancesForPackageVersion(pluginId: string, packageVersion: string): RunningPlugin[] {
    return this.instancesForPlugin(pluginId).filter(
      (plugin) => this.packageVersionOfPlugin(plugin) === packageVersion,
    )
  }

  private nextInstanceId(): string {
    let instanceId = randomUUID()
    while (this.running.has(instanceId)) instanceId = randomUUID()
    return instanceId
  }

  workspaceIdForPath(workspacePath: string): string | null {
    if (!nonEmptyString(workspacePath)) return null
    const normalized = resolve(workspacePath)
    return createHash('sha256').update(normalized).digest('hex')
  }

  private hasPlansBackendView(
    descriptor: PluginLaunchDescriptor,
    workspacePath: string | null | undefined,
    capabilityContext?: HostCapabilityContext | null,
  ): boolean {
    const policy = descriptor.capabilityPolicy
    const isManifestV2 = policy?.kind === 'manifest-v2'
    const grant = capabilityContext?.userGrant
    const v2BindAllowed = !isManifestV2 || (
      policy?.kind === 'manifest-v2' &&
      policy.system.includes('fs') &&
      grant !== null &&
      grant !== undefined &&
      grant.packageVersion === descriptor.packageVersion &&
      grant.system.includes('fs') &&
      grant.storage === true
    )
    return descriptor.id === 'navide.plans' &&
      nonEmptyString(descriptor.packageVersion) &&
      nonEmptyString(descriptor.packageDir) &&
      nonEmptyString(workspacePath) &&
      v2BindAllowed &&
      (!isManifestV2 || this.isPlansBackendAvailable()) &&
      this.pluginBackendHost.activationFor(
        descriptor.id,
        descriptor.packageVersion,
        descriptor.packageDir,
      ) !== undefined
  }

  /** A third-party v2 view binds its backend when its package identity is
   * registered; a package declaring `fs` also needs the user's fs grant for
   * this exact version (the same grant the view itself runs under). */
  private hasThirdPartyBackendView(
    descriptor: PluginLaunchDescriptor,
    capabilityContext?: HostCapabilityContext | null,
  ): boolean {
    const policy = descriptor.capabilityPolicy
    if (policy?.kind !== 'manifest-v2') return false
    if (!nonEmptyString(descriptor.packageVersion) || !nonEmptyString(descriptor.packageDir)) return false
    if (policy.system.includes('fs')) {
      const grant = capabilityContext?.userGrant
      if (!grant || grant.packageVersion !== descriptor.packageVersion || !grant.system.includes('fs')) {
        return false
      }
    }
    return true
  }

  /**
   * The Plans bundle exposes this Host-selected identity in DevTools so a
   * developer can distinguish the package that was selected from an older
   * bundle left in a profile. This deliberately carries only a closed source
   * label, never the package directory or another filesystem-derived value.
   */
  private plansPackageSource(descriptor: PluginLaunchDescriptor): PlansPackageSource {
    const selected = this.descriptors.get(PLANS_PLUGIN_ID)
    const packageDirectory = canonicalBackendPackageDir(descriptor.packageDir)
    const matchesSelection = selected?.id === descriptor.id &&
      selected.packageVersion === descriptor.packageVersion &&
      packageDirectory !== null &&
      canonicalBackendPackageDir(selected.packageDir) === packageDirectory
    if (!matchesSelection) return 'host-bundled'
    if (this.descriptorSources.get(descriptor.id) === 'factory-bundle') return 'factory-bundled'
    const installed = this.installedPackages.get(PLANS_PLUGIN_ID)
    if (this.descriptorSources.get(descriptor.id) === 'installed-catalog' && installed && installed.packageVersion === descriptor.packageVersion) {
      return installed.provenance ?? 'installed'
    }
    return 'host-bundled'
  }

  /** Add immutable Host provenance after caller-provided launch data. The
   * selected descriptor is authoritative: caller query values cannot spoof
   * the active Plans package identity. */
  private plansProvenanceQuery(descriptor: PluginLaunchDescriptor, query: string): string {
    if (descriptor.id !== PLANS_PLUGIN_ID || !nonEmptyString(descriptor.packageVersion)) return query
    if (!this.plansDiagnosticsEnabled) {
      const params = new URLSearchParams(query)
      params.delete('plans_package_version')
      params.delete('plans_package_source')
      params.delete('plans_diagnostics')
      return `?${params.toString()}`
    }
    const params = new URLSearchParams(query)
    params.set('plans_diagnostics', '1')
    return appendPlansProvenanceQuery(params.toString(), descriptor.packageVersion, this.plansPackageSource(descriptor))
  }

  private issueGitCredentialOwner(plugin: RunningPlugin): GitCredentialOwner | null {
    const binding = plugin.capabilityContext?.runtimeBinding
    if (
      !plugin.workspacePath ||
      !binding ||
      binding.instanceId !== plugin.instanceId ||
      binding.pluginId !== plugin.id
    ) return null
    const owner: GitCredentialOwner = {
      nonce: randomUUID(),
      instanceId: plugin.instanceId,
      pluginId: plugin.id,
      packageVersion: binding.packageVersion,
      workspaceId: binding.workspaceId,
      audience: binding.audience,
      workspacePath: resolve(plugin.workspacePath),
      requestIds: new Set(),
    }
    this.gitCredentialOwners.set(owner.nonce, owner)
    return owner
  }

  private ownsGitCredentialRequest(plugin: RunningPlugin, owner: GitCredentialOwner): boolean {
    const binding = plugin.capabilityContext?.runtimeBinding
    return (
      this.gitCredentialOwners.get(owner.nonce) === owner &&
      this.running.get(owner.instanceId) === plugin &&
      binding?.instanceId === owner.instanceId &&
      binding.pluginId === owner.pluginId &&
      binding.packageVersion === owner.packageVersion &&
      binding.workspaceId === owner.workspaceId &&
      binding.audience === owner.audience &&
      plugin.workspacePath !== null &&
      resolve(plugin.workspacePath) === owner.workspacePath
    )
  }

  /** Project the Host-owned askpass exchange into the public shell event
   * contract. The backend nonce, workspace path, and any credential material
   * remain inside the private bridge. */
  private emitGitCredentialPublicEvent(
    plugin: RunningPlugin | undefined,
    event: 'shell.gitCredentialRequested' | 'shell.gitCredentialCancelled',
    requestId: string,
    host?: string,
    prompt?: string,
  ): void {
    if (!plugin) return
    const binding = plugin.capabilityContext?.runtimeBinding
    if (!binding) return
    const payload = event === 'shell.gitCredentialCancelled'
      ? { requestId }
      : { requestId, host: host ?? '', prompt: prompt ?? '' }
    if (this.isPublicEventAllowedForInstance(plugin, event, payload, binding)) {
      this.emitToInstance(plugin.instanceId, event, payload)
    }
  }

  private releaseGitCredentialOwner(owner: GitCredentialOwner): void {
    if (this.gitCredentialOwners.get(owner.nonce) !== owner) return
    const plugin = this.running.get(owner.instanceId)
    const canNotify = plugin ? this.ownsGitCredentialRequest(plugin, owner) : false
    this.gitCredentialOwners.delete(owner.nonce)
    for (const requestId of owner.requestIds) {
      if (this.gitCredentialRequests.get(requestId) === owner) {
        this.gitCredentialRequests.delete(requestId)
      }
      if (plugin && canNotify) {
        this.emitToInstance(plugin.instanceId, 'git.credential_cancelled', { request_id: requestId })
        this.emitGitCredentialPublicEvent(
          plugin,
          'shell.gitCredentialCancelled',
          requestId,
        )
      }
    }
    owner.requestIds.clear()
  }

  private releaseGitCredentialOwnersForInstance(instanceId: string): void {
    for (const owner of [...this.gitCredentialOwners.values()]) {
      if (owner.instanceId === instanceId) this.releaseGitCredentialOwner(owner)
    }
  }

  private gitCredentialRequestOwner(
    plugin: RunningPlugin,
    requestId: unknown,
  ): GitCredentialOwner | null {
    if (!nonEmptyString(requestId)) return null
    const owner = this.gitCredentialRequests.get(requestId)
    return owner && this.ownsGitCredentialRequest(plugin, owner) ? owner : null
  }

  /** Host-selected grant used only by the official bundled Git package. The
   *  package receives the resulting binding through openView; it cannot
   *  choose or widen any of these fields. */
  gitCapabilityContext(
    packageVersion: string,
    workspacePath: string,
    audience = 'git'
  ): HostCapabilityContext {
    const workspaceId = this.workspaceIdForPath(workspacePath)
    return {
      publisherEligible: true,
      userGrant: {
        packageVersion,
        system: ['fs', 'ui', 'aiCli'],
        shell: 'allowlist',
        storage: true,
      },
      runtimeBinding: {
        pluginId: GIT_PLUGIN_ID,
        packageVersion,
        workspaceId,
        instanceId: null,
        audience,
      },
      // These are Host-owned profile ids. The package supplies no command or
      // executable; the public aiCli adapter resolves the profile here before
      // the backend creates a PTY.
      aiCliProfiles: Object.keys(TERMINAL_AI_CLI_PROFILES),
      storageSnapshots: new Map([
        ['candidate', packageVersion],
        ['active', packageVersion],
        ['previous', packageVersion],
      ]),
      storageSnapshotTier: 'active',
    }
  }

  /** Host-selected grant/binding context for the first-party Plans package.
   *  Plans has no public domain permission: its document operations use the
   *  package-local backend and the Host-private filesystem Bridge, while the
   *  embedded AI panel uses the existing public `aiCli` catalog. */
  plansCapabilityContext(
    packageVersion: string,
    workspacePath: string,
    audience = 'plans-window'
  ): HostCapabilityContext | null {
    const workspaceId = this.workspaceIdForPath(workspacePath)
    const descriptor = this.descriptors.get(PLANS_PLUGIN_ID)
    const policy = descriptor?.capabilityPolicy
    if (
      !descriptor ||
      policy?.kind !== 'manifest-v2' ||
      descriptor.packageVersion !== packageVersion ||
      !descriptor.packageDir
    ) return null
    const grant = this.capabilityGrantResolver?.(PLANS_PLUGIN_ID, packageVersion) ?? null
    if (
      !grant ||
      grant.packageVersion !== packageVersion ||
      grant.storage !== true ||
      !policy.system.includes('fs') ||
      !grant.system.includes('fs')
    ) return null
    if (
      grant.shell !== policy.shell ||
      grant.system.length !== policy.system.length ||
      grant.system.some((namespace) => !policy.system.includes(namespace)) ||
      (policy.shell === 'full' && grant.highRiskShellConfirmed !== true)
    ) return null
    const installed = this.installedPackages.get(PLANS_PLUGIN_ID)
    return {
      publisherEligible:
        isReservedPluginId(PLANS_PLUGIN_ID) &&
        (installed?.provenance === 'official-registry' ||
          installed?.provenance === 'factory-bundled' ||
          installed === undefined),
      userGrant: grant,
      runtimeBinding: {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId,
        instanceId: null,
        audience,
      },
      aiCliProfiles: Object.keys(TERMINAL_AI_CLI_PROFILES),
      storageSnapshots: new Map([
        ['candidate', packageVersion],
        ['active', packageVersion],
        ...(this.plansStorageSnapshotContext?.packageVersion === packageVersion &&
        this.plansStorageSnapshotContext.previousPackageVersion
          ? [['previous', this.plansStorageSnapshotContext.previousPackageVersion] as const]
          : []),
      ]),
      storageSnapshotTier: 'active',
    }
  }

  /** Supply the actual previous active identity selected during Plans storage
   *  migration. The renderer cannot choose or replace this value. */
  setPlansStorageSnapshotContext(
    packageVersion: string,
    previousPackageVersion: string | null,
  ): void {
    this.plansStorageSnapshotContext = {
      packageVersion,
      previousPackageVersion,
    }
  }

  /** Supply the Host-selected Mini-IDE storage identities. */
  setMiniIdeStorageSnapshotContext(
    packageVersion: string,
    previousPackageVersion: string | null,
  ): void {
    this.miniIdeStorageSnapshotContext = {
      packageVersion,
      previousPackageVersion,
    }
  }

  /** Return the exact Host-selected Plans descriptor/activation tuple. */
  private plansBackendSelection(): {
    descriptor: PluginLaunchDescriptor
    activation: BackendPluginLaunchSpec
  } | null {
    const descriptor = this.descriptors.get(PLANS_PLUGIN_ID)
    if (
      !descriptor ||
      descriptor.capabilityPolicy?.kind !== 'manifest-v2' ||
      !nonEmptyString(descriptor.packageVersion) ||
      !nonEmptyString(descriptor.packageDir)
    ) return null
    const activation = this.pluginBackendHost.activationFor(
      PLANS_PLUGIN_ID,
      descriptor.packageVersion,
      descriptor.packageDir,
    )
    if (!activation) return null
    if (
      activation.pluginId !== PLANS_PLUGIN_ID ||
      activation.packageVersion !== descriptor.packageVersion ||
      canonicalBackendPackageDir(activation.packageDir) !== canonicalBackendPackageDir(descriptor.packageDir) ||
      !activation.approvedBridgePorts?.includes('filesystem')
    ) return null
    return { descriptor, activation }
  }

  private plansGrantMatchesPolicy(
    descriptor: PluginLaunchDescriptor,
    packageVersion: string,
  ): boolean {
    const policy = descriptor.capabilityPolicy
    const grant = this.capabilityGrantResolver?.(PLANS_PLUGIN_ID, packageVersion) ?? null
    if (
      policy?.kind !== 'manifest-v2' ||
      descriptor.packageVersion !== packageVersion ||
      !grant ||
      grant.packageVersion !== packageVersion ||
      grant.storage !== true ||
      !policy.system.includes('fs') ||
      !grant.system.includes('fs') ||
      grant.shell !== policy.shell ||
      grant.system.length !== policy.system.length ||
      grant.system.some((namespace) => !policy.system.includes(namespace)) ||
      (policy.shell === 'full' && grant.highRiskShellConfirmed !== true)
    ) return false
    return true
  }

  private plansHealthApplies(
    packageVersion: string,
    packageDir: string,
  ): boolean {
    return this.plansBackendHealthIdentity?.packageVersion === packageVersion &&
      canonicalBackendPackageDir(this.plansBackendHealthIdentity.packageDir) ===
        canonicalBackendPackageDir(packageDir)
  }

  /** True only when the descriptor, exact activation, Grant and child health
   * all identify a usable production Plans backend. */
  isPlansBackendAvailable(): boolean {
    const selection = this.plansBackendSelection()
    if (!selection) return false
    if (!this.plansGrantMatchesPolicy(selection.descriptor, selection.descriptor.packageVersion!)) {
      return false
    }
    return !(
      this.plansHealthApplies(selection.descriptor.packageVersion!, selection.descriptor.packageDir!) &&
      this.plansBackendHealth === 'unavailable'
    )
  }

  /**
   * Return whether a failed Plans v2 route may be replaced by the legacy
   * adapter. A descriptor/Grant mismatch is a security decision and must not
   * be hidden by fallback; only a missing exact activation or a failed child
   * is an availability recovery.
   */
  plansBackendFallbackAllowed(): boolean {
    const descriptor = this.descriptors.get(PLANS_PLUGIN_ID)
    if (descriptor?.capabilityPolicy?.kind !== 'manifest-v2') return true
    if (!nonEmptyString(descriptor.packageVersion) || !nonEmptyString(descriptor.packageDir)) {
      return true
    }
    if (!this.plansGrantMatchesPolicy(descriptor, descriptor.packageVersion)) return false
    const activation = this.pluginBackendHost.activationFor(
      PLANS_PLUGIN_ID,
      descriptor.packageVersion,
      descriptor.packageDir,
    )
    if (!activation) return true
    if (
      activation.pluginId !== PLANS_PLUGIN_ID ||
      activation.packageVersion !== descriptor.packageVersion ||
      canonicalBackendPackageDir(activation.packageDir) !==
        canonicalBackendPackageDir(descriptor.packageDir) ||
      !activation.approvedBridgePorts?.includes('filesystem')
    ) return true
    return (
      this.plansHealthApplies(descriptor.packageVersion, descriptor.packageDir) &&
      this.plansBackendHealth === 'unavailable'
    )
  }

  /** Withdraw the v2 availability bit after a bind/child/recovery failure.
   *  The descriptor remains installed so recovery can retry it explicitly. */
  markPlansBackendUnavailable(reason = 'child-unavailable'): void {
    const descriptor = this.descriptors.get(PLANS_PLUGIN_ID)
    if (
      descriptor?.capabilityPolicy?.kind !== 'manifest-v2' ||
      !nonEmptyString(descriptor.packageVersion) ||
      !nonEmptyString(descriptor.packageDir)
    ) return
    if (this.plansBackendHealth !== 'unavailable') {
      warnMain(`[plugin-backend] ${PLANS_PLUGIN_ID} v2 backend withdrawn (${reason})`)
    }
    this.plansUnavailableByChildDeath = reason === 'child-unavailable' &&
      (this.plansBackendHealth !== 'unavailable' || this.plansUnavailableByChildDeath)
    this.plansBackendHealth = 'unavailable'
    this.plansBackendHealthIdentity = {
      packageVersion: descriptor.packageVersion,
      packageDir: descriptor.packageDir,
    }
    this.refreshHostSessionRegistration()
  }

  /** Re-arm the withdrawn v2 availability bit for an explicit user retry.
   *  Only the bit is restored: the child is spawned by the next Plans open, so
   *  a still-broken package simply withdraws it again through the same path.
   *  Returns whether there was an unavailable mark to clear. */
  clearPlansBackendUnavailable(): boolean {
    if (this.plansBackendHealth !== 'unavailable') return false
    this.plansBackendHealth = 'unknown'
    this.plansBackendHealthIdentity = null
    this.plansDeadBackendInstances.clear()
    this.discardHeadlessPlansBackends()
    this.refreshHostSessionRegistration()
    return true
  }

  /** A failed headless MCP child stays cached under its workspace key and
   *  answers every later agent call with the same availability error. After a
   *  re-arm that error withdraws v2 again under a live Plans view, whose
   *  in-flight filesystem Bridge requests are then denied. The retry must give
   *  the MCP route a fresh child, as it does the views. */
  private discardHeadlessPlansBackends(): void {
    for (const [key, instanceId] of this.headlessBackendInstances) {
      if (!key.startsWith(`${PLANS_PLUGIN_ID}\u0000`)) continue
      this.headlessBackendInstances.delete(key)
      this.plansDiscardedBackendInstances.add(instanceId)
      void this.pluginBackendHost.unbindView(instanceId).catch((error: unknown) => {
        warnMain(
          `[plugin-backend] unbind for ${instanceId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      })
    }
  }

  /** Opening Plans for a workspace is how the user brings back its given-up
   *  headless child: drop it so the next agent call binds a fresh one. Only a
   *  given-up child is replaced, so each open replaces at most one. */
  private replaceAbandonedHeadlessPlansBackend(packageVersion: string, workspacePath: string): void {
    const key = this.headlessPlansKey(packageVersion, workspacePath)
    const instanceId = this.headlessBackendInstances.get(key)
    if (!instanceId || !this.plansAbandonedBackendInstances.has(instanceId)) return
    this.headlessBackendInstances.delete(key)
    this.plansAbandonedBackendInstances.delete(instanceId)
    void this.pluginBackendHost.unbindView(instanceId).catch((error: unknown) => {
      warnMain(
        `[plugin-backend] unbind for ${instanceId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
  }

  /** Undo a mark that came only from child deaths once every dead child has
   *  come back or stopped counting, for the same package version. */
  private markPlansBackendReadyIfChildrenRecovered(packageVersion: string): void {
    const identity = this.plansBackendHealthIdentity
    if (
      this.plansBackendHealth !== 'unavailable' ||
      !this.plansUnavailableByChildDeath ||
      this.plansDeadBackendInstances.size > 0 ||
      identity?.packageVersion !== packageVersion
    ) return
    this.markPlansBackendReady(identity.packageVersion, identity.packageDir)
  }

  private markPlansBackendReady(packageVersion: string, packageDir: string): void {
    this.plansBackendHealth = 'ready'
    this.plansBackendHealthIdentity = { packageVersion, packageDir }
    this.refreshHostSessionRegistration()
  }

  /** Whether a failed Plans view call proves the backend unavailable. A call
   *  rejected because its own instance is being closed or restarted says
   *  nothing about the child - closing a Plans window, or a remount, used to
   *  withdraw Plans into legacy recovery for the whole session. Every
   *  withdrawal is logged with the call and code: none of these failures
   *  carries a cause, so main.log otherwise said only "withdrawn". */
  private plansCallFailureWithdraws(plugin: RunningPlugin, method: string, error: unknown): boolean {
    if (!this.isPlansBackendAvailabilityError(error)) return false
    if (plugin.releasing || this.running.get(plugin.instanceId) !== plugin || this.isPluginStopping(plugin)) {
      return false
    }
    warnMain(
      `[plugin-backend] ${PLANS_PLUGIN_ID} ${method} failed with ${(error as BackendPluginError).code} ` +
      `for ${plugin.instanceId}`,
    )
    return true
  }

  private isPlansBackendAvailabilityError(error: unknown): boolean {
    return error instanceof BackendPluginError && (
      error.code === 'BACKEND_UNAVAILABLE' ||
      error.code === 'NOT_READY' ||
      error.code === 'TIMEOUT' ||
      error.code === 'PROTOCOL_ERROR' ||
      error.code === 'INVALID_RUNTIME' ||
      error.code === 'PLUGIN_STOPPING'
    )
  }

  setCapabilityGrantResolver(
    resolver: ((pluginId: string, packageVersion: string) => HostCapabilityGrant | null) | null
  ): void {
    this.capabilityGrantResolver = resolver
    this.refreshHostSessionRegistration()
  }

  /** The user's durable "Disabled" switch for installed packages. */
  setDisabledPluginResolver(resolver: ((pluginId: string) => boolean) | null): void {
    this.disabledPluginResolver = resolver
  }

  /** A disabled package stays in the installed inventory, but the Host
   *  registers neither its views nor its backend. First-party ids are not
   *  governed by this switch. */
  isPluginDisabled(
    pluginId: string,
    provenance: InstalledPluginPackageSummary['provenance'] = this.installedPackages.get(pluginId)?.provenance,
  ): boolean {
    return this.canDisablePlugin(pluginId, provenance) && (this.disabledPluginResolver?.(pluginId) ?? false)
  }

  /** The bundled first-party packages (Plans, Git, Mini-IDE) have their own
   *  factory and recovery paths and are outside the "Disabled" switch. A
   *  Marketplace first-party package ({@link isMarketplaceFirstPartyPackage})
   *  is disabled like any installed package. */
  canDisablePlugin(
    pluginId: string,
    provenance: InstalledPluginPackageSummary['provenance'] = this.installedPackages.get(pluginId)?.provenance,
  ): boolean {
    return !isReservedPluginId(pluginId) || this.isMarketplaceFirstPartyPackage(pluginId, provenance)
  }

  /** A first-party package the Official Registry installed that is not
   *  bundled with the App (navide.browser; never Plans): the user disables
   *  and removes it like any Marketplace package. Every other reserved
   *  `navide.` id keeps its own rules. */
  isMarketplaceFirstPartyPackage(
    pluginId: string,
    provenance: InstalledPluginPackageSummary['provenance'] = this.installedPackages.get(pluginId)?.provenance,
  ): boolean {
    return isFirstPartyAgentToolPlugin(pluginId) && provenance === 'official-registry'
  }

  /** The user's Disabled switch for the built-in Plans, Git and Mini-IDE
   *  (same durable store as {@link isPluginDisabled}). A disabled built-in
   *  stays loaded exactly as when enabled; the Host only refuses to mount its
   *  views, list its contributions or serve agent calls into it. */
  isBuiltinPluginDisabled(pluginId: string): boolean {
    return BUILTIN_PLUGIN_NAMES.has(pluginId) && (this.disabledPluginResolver?.(pluginId) ?? false)
  }

  /** The disabled built-ins, sorted, for the backend and the renderer. */
  listDisabledBuiltinPlugins(): string[] {
    return [...BUILTIN_PLUGIN_NAMES.keys()].filter((id) => this.isBuiltinPluginDisabled(id)).sort()
  }

  /** Drain a just-disabled built-in: every instance, headless backend and AI
   *  session ends. Its descriptor, grant and storage stay. */
  async suspendBuiltinPlugin(pluginId: string): Promise<void> {
    if (!this.isBuiltinPluginDisabled(pluginId)) throw new Error(`plugin ${pluginId} is not disabled`)
    const packageVersion = this.packageVersionForPluginId(pluginId)
    if (packageVersion) {
      const backend = this.getBackendActivation(pluginId, packageVersion)
      if (backend) this.suspendedBuiltinBackends.set(pluginId, [backend])
      await this.revokePackageVersion(pluginId, packageVersion)
    } else {
      this.preparePluginRemoval(pluginId)
    }
    this.refreshHostSessionRegistration()
  }

  /** Undo {@link suspendBuiltinPlugin} for a just-enabled built-in. */
  resumeBuiltinPlugin(pluginId: string): void {
    if (this.isBuiltinPluginDisabled(pluginId)) throw new Error(`plugin ${pluginId} is disabled`)
    for (const backend of this.suspendedBuiltinBackends.get(pluginId) ?? []) {
      if (!this.hasBackendActivation(backend.pluginId, backend.packageVersion)) {
        this.registerBackendActivation(backend)
      }
    }
    this.suspendedBuiltinBackends.delete(pluginId)
    this.refreshHostSessionRegistration()
  }

  /** Registered descriptors a view may be opened from: a disabled built-in's
   *  descriptor stays registered but is never offered or mounted. */
  private enabledDescriptors(): PluginLaunchDescriptor[] {
    return this.listDescriptors().filter((descriptor) => !this.isBuiltinPluginDisabled(descriptor.id))
  }

  /** Stop a just-disabled package and drop its frontend descriptor, keeping
   *  its inventory entry and package directory for Enable, update, rollback
   *  and remove. */
  suspendDisabledPlugin(pluginId: string): void {
    if (!this.isPluginDisabled(pluginId)) throw new Error(`plugin ${pluginId} is not disabled`)
    this.preparePluginRemoval(pluginId)
    this.descriptors.delete(pluginId)
  }

  /** Set the durable Host-selected storage snapshot for a generic package. */
  setPluginStorageSnapshotSelection(
    pluginId: string,
    selection: { activeVersion: string; previousVersion?: string },
  ): void {
    if (!nonEmptyString(pluginId) || !nonEmptyString(selection.activeVersion)) {
      throw new Error('plugin storage snapshot selection requires a package id and active version')
    }
    if (selection.previousVersion !== undefined && !nonEmptyString(selection.previousVersion)) {
      throw new Error('plugin storage snapshot previous version must be non-empty')
    }
    this.pluginStorageSnapshotSelections.set(pluginId, {
      activeVersion: selection.activeVersion,
      ...(selection.previousVersion ? { previousVersion: selection.previousVersion } : {}),
    })
  }

  /** Project valid durable package selections before any plugin instance can
   * mount. Invalid or incomplete records are deliberately not turned into a
   * guessed storage selection. */
  projectPluginStorageSnapshotSelections(root: string): void {
    const lifecycleSelector = new PluginActivationSelector(root)
    for (const record of lifecycleSelector.list()) {
      if (!record.active) continue
      this.setPluginStorageSnapshotSelection(record.pluginId, {
        activeVersion: record.active.packageVersion,
        ...(record.previous ? { previousVersion: record.previous.packageVersion } : {}),
      })
    }
  }

  /** Install the third-party backend admission gate (sandbox, consent, kill
   * switches). Without it every third-party backend is refused. */
  setThirdPartyBackendAdmitter(admitter: ThirdPartyAdmitter | null): void {
    this.pluginBackendHost.setThirdPartyAdmitter(admitter ?? undefined)
  }

  /** Wire the third-party agent-tool catalog (plan B1-b). */
  setAgentToolsHost(host: PluginAgentToolsHost | null): void {
    this.agentToolsHost = host
  }

  /** Which canonical directories are Navide workspaces an agent tool may target. */
  setAgentToolWorkspaceResolver(resolver: ((root: string) => boolean) | null): void {
    this.agentToolWorkspaceResolver = resolver
  }

  /** A target an agent tool may use: an open Navide workspace, never the home
   * folder or a filesystem root, whatever the resolver says. */
  private isAgentToolWorkspace(root: string): boolean {
    const home = canonicalExistingDirectory(homedir()) ?? resolve(homedir())
    if (root === home || root === resolve(root, '..')) return false
    try {
      return this.agentToolWorkspaceResolver?.(root) === true
    } catch {
      return false
    }
  }

  /** Set the agent-callable methods of one registered third-party backend. */
  setThirdPartyAgentMethods(pluginId: string, packageVersion: string, methods: string[]): void {
    this.pluginBackendHost.setAgentMethods(pluginId, packageVersion, methods)
    if (methods.length > 0) return
    // Nothing is served any more: stop and forget its agent-tool bindings.
    for (const [key, instanceId] of [...this.headlessAgentToolInstances]) {
      if (!key.startsWith(`${pluginId}\u0000${packageVersion}\u0000`)) continue
      this.headlessAgentToolInstances.delete(key)
      this.headlessAgentToolRoots.delete(instanceId)
      if (this.pluginBackendHost.isBound(instanceId)) {
        void this.pluginBackendHost.unbindView(instanceId, 'plugin-stopping').catch(() => undefined)
      }
    }
  }

  /** Push one `plugins.agentTools.sync` snapshot to the core backend. False
   * when there is no registered Host session (the snapshot is then re-sent
   * from scratch once the session registers). */
  async sendAgentToolsSync(payload: AgentToolsSyncPayload): Promise<'delivered' | 'failed' | 'no-session'> {
    const client = this.wsClient
    if (!client || !this.hostSessionRegistered) return 'no-session'
    try {
      const response = await client.send(AGENT_TOOLS_SYNC_EVENT, payload as unknown as Record<string, unknown>, 10_000)
      if (response.ok) return 'delivered'
      console.warn('[plugin-backend] agent tool catalog was not accepted by the backend')
      return 'failed'
    } catch {
      return 'failed'
    }
  }

  /** Kill switch: stop running third-party backend children. */
  stopThirdPartyBackends(pluginId: string | null): Promise<void> {
    return this.pluginBackendHost.stopThirdPartyBackends(pluginId)
  }

  /** The Host workspace filesystem service (the same service and path
   * checks Plans uses) as a bridge port for the third-party package bridge,
   * behind its own grant check. */
  createWorkspaceFilesystemPort(): PlansFilesystemPort {
    return createHostPlansFilesystemPort({
      call: (operation, payload, context) => this.sendThirdPartyFilesystemService(operation, payload, context),
    })
  }

  /** Revalidated at every dispatch, like Plans: a third-party backend reaches
   * the workspace only through a live user-initiated binding of its own
   * registered package version, whose manifest declares `fs` and whose user
   * Grant for that version includes `fs`, and only at the bound workspace
   * root. Write grants are enforced by the package bridge before this. */
  private thirdPartyFilesystemGrantAllows(
    payload: Record<string, JsonValue>,
    context: PlansBridgeContext,
  ): boolean {
    const runtime = context.runtime
    if (
      runtime.initiator.kind === 'agent' &&
      nonEmptyString(runtime.instanceId) &&
      this.headlessAgentToolRoots.has(runtime.instanceId)
    ) return this.agentToolFilesystemGrantAllows(payload, context)
    if (
      context.signal.aborted ||
      runtime.pluginId === PLANS_PLUGIN_ID ||
      runtime.initiator.kind !== 'user' ||
      !nonEmptyString(runtime.packageVersion) ||
      !nonEmptyString(runtime.instanceId) ||
      !nonEmptyString(context.workspacePath) ||
      !nonEmptyString(context.authorizedPlanRoot)
    ) return false
    const activation = this.pluginBackendHost.activationForPlugin(runtime.pluginId)
    if (
      !activation?.thirdParty?.system.includes('fs') ||
      activation.packageVersion !== runtime.packageVersion
    ) return false
    const view = this.running.get(runtime.instanceId)
    if (
      !view ||
      view.id !== runtime.pluginId ||
      !view.workspacePath ||
      resolve(view.workspacePath) !== resolve(context.workspacePath) ||
      runtime.workspaceId !== this.workspaceIdForPath(context.workspacePath)
    ) return false
    const grant = this.capabilityGrantResolver?.(runtime.pluginId, runtime.packageVersion) ?? null
    if (!grant || grant.packageVersion !== runtime.packageVersion || !grant.system.includes('fs')) return false
    const root = canonicalExistingDirectory(context.workspacePath)
    return root !== null && root === context.authorizedPlanRoot && payload.workspace_path === root
  }

  /** The agent-tool counterpart of the rule above: the request comes from a
   * headless binding the Host made for an agent-tool call, at the canonical
   * workspace root it bound, while the package's user Grant still includes
   * `fs` and the agent-tool catalog still serves the package. The execution
   * policy and the per-workspace write grant are enforced by the supervisor
   * and the package bridge, as for every other request. */
  private agentToolFilesystemGrantAllows(
    payload: Record<string, JsonValue>,
    context: PlansBridgeContext,
  ): boolean {
    const runtime = context.runtime
    const boundRoot = nonEmptyString(runtime.instanceId) ? this.headlessAgentToolRoots.get(runtime.instanceId) : undefined
    // Only inside an admitted agent-tool call of this package at this root,
    // and only while the catalog still serves it for that caller (switches,
    // DB4, marks, disabled, stopping, update).
    const call = runtime.initiator.kind === 'agent' ? this.agentToolCalls.get(runtime.initiator.id) : undefined
    const stillServed = call !== undefined && this.agentToolsHost !== null && this.agentToolsHost.recheck(
      call.pluginId,
      call.caller,
      (pluginId, packageVersion) => this.isPackageVersionStopping(pluginId, packageVersion),
      call.spec,
    ).ok
    if (
      context.signal.aborted ||
      !boundRoot ||
      !call ||
      !stillServed ||
      call.pluginId !== runtime.pluginId ||
      call.workspaceRoot !== boundRoot ||
      runtime.pluginId === PLANS_PLUGIN_ID ||
      runtime.initiator.kind !== 'agent' ||
      !nonEmptyString(runtime.packageVersion) ||
      !nonEmptyString(context.workspacePath) ||
      !nonEmptyString(context.authorizedPlanRoot) ||
      !this.pluginBackendHost.isBound(runtime.instanceId!)
    ) return false
    const activation = this.pluginBackendHost.activationForPlugin(runtime.pluginId)
    if (
      !activation?.thirdParty?.system.includes('fs') ||
      activation.packageVersion !== runtime.packageVersion ||
      this.isPackageVersionStopping(runtime.pluginId, runtime.packageVersion) ||
      runtime.workspaceId !== this.workspaceIdForPath(boundRoot) ||
      !this.isAgentToolWorkspace(boundRoot)
    ) return false
    const grant = this.capabilityGrantResolver?.(runtime.pluginId, runtime.packageVersion) ?? null
    if (!grant || grant.packageVersion !== runtime.packageVersion || !grant.system.includes('fs')) return false
    const root = canonicalExistingDirectory(context.workspacePath)
    return root !== null && root === boundRoot && root === context.authorizedPlanRoot && payload.workspace_path === root
  }

  private async sendThirdPartyFilesystemService(
    operation: PlansFilesystemServiceOperation,
    payload: Record<string, JsonValue>,
    context: PlansBridgeContext,
  ): Promise<JsonValue> {
    if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
    if (!this.thirdPartyFilesystemGrantAllows(payload, context)) {
      throw new PlansBridgeError('CAPABILITY_DENIED', 'Filesystem capability is denied.')
    }
    try {
      const response = await this.sendPublicBackend(
        operation,
        payload,
        () => this.thirdPartyFilesystemGrantAllows(payload, context),
      )
      if (!isJsonValue(response)) {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Filesystem service returned an invalid response.')
      }
      return response
    } catch (error) {
      if (error instanceof PlansBridgeError) throw error
      if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
      if (error instanceof Error && error.message === 'request denied before dispatch') {
        throw new PlansBridgeError('CAPABILITY_DENIED', 'Filesystem capability is denied.')
      }
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Filesystem service is unavailable.')
    }
  }

  /** The Host shell broker for third-party backends that declare
   *  `shell: "allowlist"` (DB5): the same `shell.run` backend message and
   *  `allowlist` mode a view's shell.run uses, so the Python broker applies the
   *  same argv rules (git/gh/glab only, auth subcommands and -c/-C refused). */
  createThirdPartyShellPort(): PackageShellPort {
    return {
      run: (command, context) => this.sendThirdPartyShellRun(command, context),
    }
  }

  /** Revalidated at every dispatch, like the filesystem port: a live
   *  user-initiated binding of the registered package version, whose manifest
   *  declares `shell: "allowlist"` and whose user Grant for that version has
   *  the same shell mode, at the bound workspace root only. */
  private thirdPartyShellGrantAllows(context: PlansBridgeContext): boolean {
    const runtime = context.runtime
    if (
      context.signal.aborted ||
      runtime.pluginId === PLANS_PLUGIN_ID ||
      runtime.initiator.kind !== 'user' ||
      !nonEmptyString(runtime.packageVersion) ||
      !nonEmptyString(runtime.instanceId) ||
      !nonEmptyString(context.workspacePath) ||
      !nonEmptyString(context.authorizedPlanRoot)
    ) return false
    const activation = this.pluginBackendHost.activationForPlugin(runtime.pluginId)
    if (
      activation?.thirdParty?.shell !== 'allowlist' ||
      activation.packageVersion !== runtime.packageVersion
    ) return false
    const view = this.running.get(runtime.instanceId)
    if (
      !view ||
      view.id !== runtime.pluginId ||
      !view.workspacePath ||
      resolve(view.workspacePath) !== resolve(context.workspacePath) ||
      runtime.workspaceId !== this.workspaceIdForPath(context.workspacePath)
    ) return false
    const grant = this.capabilityGrantResolver?.(runtime.pluginId, runtime.packageVersion) ?? null
    if (!grant || grant.packageVersion !== runtime.packageVersion || grant.shell !== 'allowlist') return false
    const root = canonicalExistingDirectory(context.workspacePath)
    return root !== null && root === context.authorizedPlanRoot
  }

  private async sendThirdPartyShellRun(command: string, context: PlansBridgeContext): Promise<JsonValue> {
    if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
    if (!this.thirdPartyShellGrantAllows(context)) {
      throw new PlansBridgeError('CAPABILITY_DENIED', 'Shell capability is denied.')
    }
    let response: unknown
    try {
      response = await this.sendPublicBackend(
        'shell.run',
        { workspace_path: context.authorizedPlanRoot, command, host_mode: 'allowlist' },
        () => this.thirdPartyShellGrantAllows(context),
        THIRD_PARTY_SHELL_RUN_TIMEOUT_MS,
      )
    } catch (error) {
      if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
      if (error instanceof Error && error.message === 'request denied before dispatch') {
        throw new PlansBridgeError('CAPABILITY_DENIED', 'Shell capability is denied.')
      }
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Shell broker is unavailable.')
    }
    const record = response !== null && typeof response === 'object' && !Array.isArray(response)
      ? response as Record<string, unknown>
      : null
    if (!record) throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Shell broker returned an invalid response.')
    if (record.ok === false) {
      // The broker refused the command (policy, workspace); not command output.
      throw new PlansBridgeError('CAPABILITY_DENIED', typeof record.error === 'string' ? record.error : 'Shell command was refused.')
    }
    return {
      exitCode: Number(record.exit_code ?? 0),
      stdout: String(record.stdout ?? record.output ?? ''),
      stderr: String(record.stderr ?? ''),
      ...shellRunTruncation(record),
    }
  }

  /** Delegate immediate pre-spawn trust revalidation to the backend child Host. */
  setBackendSpawnTrustVerifier(
    verifier: ((activation: Readonly<BackendPluginLaunchSpec>) => void | Promise<void>) | null,
  ): void {
    this.pluginBackendHost.setBeforeSpawnVerifier(verifier ?? undefined)
  }

  setExecutionPolicyResolver(
    resolver: ((workspacePath?: string) => ExecutionPolicySnapshot) | null
  ): void {
    this.executionPolicyResolver = resolver
  }

  setUiLocaleResolver(resolver: (() => SupportedLocale) | null): void {
    this.uiLocaleResolver = resolver
  }

  setTerminalShell(shell: string | null): void {
    this.terminalShell = nonEmptyString(shell) ? shell : 'bash'
  }

  /** Set the main-process-only token for the current backend instance. The
   * token is never included in renderer-facing backend status payloads. */
  setBackendHostToken(token: string | null): void {
    if (token === this.backendHostToken) return
    this.hostRegistrationTask = null
    this.backendHostToken = token
    this.hostSessionRegistered = false
    const client = this.wsClient
    const url = this.backendWsUrl
    if (token && client && url && client.isHealthyFor(url)) {
      this.registerHostSession(client)
    }
  }

  setActivationFailureHandler(
    handler: ((failure: { pluginId: string; packageVersion: string; reason: string }) => void) | null
  ): void {
    this.activationFailureHandler = handler
  }

  setPlansBackendFailureHandler(
    handler: ((failure: {
      instanceId: string
      workspacePath: string
      packageVersion: string
      query: string
      contributionKey: string | null
      reason: string
    }) => void) | null,
  ): void {
    this.plansBackendFailureHandler = handler
  }

  /** Observe a headless Plans child that stopped for good (its restart budget
   *  is spent), once per child. */
  setPlansBackendStoppedHandler(
    handler: ((stopped: { workspacePath: string }) => void) | null,
  ): void {
    this.plansBackendStoppedHandler = handler
  }

  /** Wait for the initial backend/root bind of one exact view. This is used by
   *  the Plans opener so a failed package child can be replaced before the
   *  caller presents the v2 window as successful. */
  async waitForBackendBinding(instanceId: string): Promise<void> {
    const plugin = this.running.get(instanceId)
    if (!plugin) throw new BackendPluginError('INVALID_RUNTIME')
    if (plugin.backendBindingTask) await plugin.backendBindingTask
  }

  /** Wait for the actual entry load before delivering a deferred Host target.
   * This keeps a queued target from outliving the liveness/canonical checks
   * that protect its eventual IPC flush. */
  private waitForEntryReady(instanceId: string): Promise<void> {
    const plugin = this.running.get(instanceId)
    if (!plugin) return Promise.reject(new BackendPluginError('INVALID_RUNTIME'))
    if (plugin.ready) return Promise.resolve()
    const contents = plugin.view.webContents
    return new Promise<void>((resolveReady, rejectReady) => {
      const cleanup = (): void => {
        contents.removeListener('did-finish-load', onReady)
        contents.removeListener('destroyed', onDestroyed)
        contents.removeListener('did-fail-load', onFailed)
      }
      const onReady = (): void => {
        cleanup()
        resolveReady()
      }
      const onDestroyed = (): void => {
        cleanup()
        rejectReady(new BackendPluginError('INVALID_RUNTIME'))
      }
      const onFailed = (
        _event: unknown,
        errorCode: unknown,
        errorDescription: unknown,
        _validatedURL: unknown,
        isMainFrame: unknown,
      ): void => {
        if (isMainFrame !== true) return
        cleanup()
        rejectReady(new BackendPluginError(
          'INVALID_RUNTIME',
          `entry load failed: ${String(errorDescription)} (${String(errorCode)})`,
        ))
      }
      contents.once('did-finish-load', onReady)
      contents.once('destroyed', onDestroyed)
      contents.on('did-fail-load', onFailed)
    })
  }

  /** Wait for the sender-authenticated readiness handshake without involving
   * production activation recovery. Used only by candidate frontend preflight. */
  private waitForPluginReady(instanceId: string): Promise<void> {
    const plugin = this.running.get(instanceId)
    if (!plugin) return Promise.reject(new BackendPluginError('INVALID_RUNTIME'))
    if (plugin.pluginReady) return Promise.resolve()
    return new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        if (this.pluginReadyWaiters.get(instanceId)?.timer !== timer) return
        this.pluginReadyWaiters.delete(instanceId)
        rejectReady(new BackendPluginError('INVALID_RUNTIME', 'plugin readiness handshake timed out'))
      }, 10_000)
      timer.unref?.()
      this.pluginReadyWaiters.set(instanceId, {
        resolve: resolveReady,
        reject: rejectReady,
        timer,
      })
    })
  }

  private settlePluginReadyWaiter(instanceId: string, error?: Error): void {
    const waiter = this.pluginReadyWaiters.get(instanceId)
    if (!waiter) return
    this.pluginReadyWaiters.delete(instanceId)
    clearTimeout(waiter.timer)
    if (error) waiter.reject(error)
    else waiter.resolve()
  }

  /** Host-only readiness seam for the legacy plugin-id opener. */
  async waitForLegacyEntryReady(pluginId: string): Promise<void> {
    const instanceId = this.legacyInstances.get(pluginId)
    if (instanceId) await this.waitForEntryReady(instanceId)
  }

  private settleActivation(instanceId: string): void {
    const timer = this.pendingActivations.get(instanceId)
    if (timer) clearTimeout(timer)
    this.pendingActivations.delete(instanceId)
  }

  private failActivation(instanceId: string, reason: string): void {
    const plugin = this.running.get(instanceId)
    if (!plugin || !this.pendingActivations.has(instanceId)) return
    this.settleActivation(instanceId)
    this.settlePluginReadyWaiter(instanceId, new BackendPluginError('INVALID_RUNTIME'))
    const packageVersion = plugin.capabilityContext?.runtimeBinding?.packageVersion
    if (!packageVersion) return
    if (plugin.id === PLANS_PLUGIN_ID && plugin.workspacePath) {
      this.markPlansBackendUnavailable('child-unavailable')
      this.plansBackendFailureHandler?.({
        instanceId,
        workspacePath: plugin.workspacePath,
        packageVersion,
        query: plugin.query,
        contributionKey: plugin.contributionKey,
        reason,
      })
    }
    this.activationFailureHandler?.({ pluginId: plugin.id, packageVersion, reason })
  }

  private contributionCapabilityContext(
    descriptor: PluginLaunchDescriptor,
    view: PluginViewLaunchDescriptor,
    workspacePath: string
  ): HostCapabilityContext | null {
    const packageVersion = descriptor.packageVersion
    const policy = descriptor.capabilityPolicy
    if (!packageVersion || policy?.kind !== 'manifest-v2') return null
    if (descriptor.id === PLANS_PLUGIN_ID) {
      return this.plansCapabilityContext(packageVersion, workspacePath, view.contributionKey)
    }
    const grant = this.capabilityGrantResolver?.(descriptor.id, packageVersion) ?? null
    if (!grant || grant.packageVersion !== packageVersion || grant.storage !== true) return null
    if (
      grant.shell !== policy.shell ||
      grant.system.length !== policy.system.length ||
      grant.system.some((namespace) => !policy.system.includes(namespace)) ||
      (policy.shell === 'full' && grant.highRiskShellConfirmed !== true)
    ) return null
    const installed = this.installedPackages.get(descriptor.id)
    const selectedStorage = this.pluginStorageSnapshotSelections.get(descriptor.id)
    if (selectedStorage && selectedStorage.activeVersion !== packageVersion) return null
    const previousVersion = selectedStorage?.previousVersion ?? packageVersion
    return {
      publisherEligible:
        isReservedPluginId(descriptor.id) &&
        (installed?.provenance === 'official-registry' ||
          installed?.provenance === 'factory-bundled'),
      userGrant: grant,
      runtimeBinding: {
        pluginId: descriptor.id,
        packageVersion,
        workspaceId: this.workspaceIdForPath(workspacePath),
        instanceId: null,
        audience:
          descriptor.id === GIT_PLUGIN_ID && view.location === 'left'
            ? 'git-left'
            : descriptor.id === GIT_PLUGIN_ID && view.location === 'window'
              ? 'git-window'
              : view.contributionKey,
      },
      aiCliProfiles: Object.keys(TERMINAL_AI_CLI_PROFILES),
      storageSnapshots: new Map([
        ['candidate', packageVersion],
        ['active', packageVersion],
        ...(descriptor.id === MINI_IDE_PLUGIN_ID &&
        this.miniIdeStorageSnapshotContext?.packageVersion === packageVersion &&
        this.miniIdeStorageSnapshotContext.previousPackageVersion
          ? [['previous', this.miniIdeStorageSnapshotContext.previousPackageVersion] as const]
          : descriptor.id === MINI_IDE_PLUGIN_ID
            ? []
            : [['previous', previousVersion] as const]),
      ]),
      storageSnapshotTier: 'active',
    }
  }

  /** Rebind only the Host-created runtime identity. V1 descriptors retain
   *  their existing context shape; v2 view instances receive their own id. */
  private bindCapabilityContext(
    context: HostCapabilityContext | null | undefined,
    instanceId: string
  ): HostCapabilityContext | null {
    const bind = (binding: AuthenticatedRuntimeBinding): AuthenticatedRuntimeBinding => ({
      ...binding,
      instanceId,
    })
    if (!context) return null
    return {
      ...context,
      runtimeBinding: context.runtimeBinding ? bind(context.runtimeBinding) : null,
      ...(context.storageSnapshots
        ? { storageSnapshots: new Map(context.storageSnapshots) }
        : {}),
      ...(context.sessionBindings
        ? {
            sessionBindings: new Map(
              [...context.sessionBindings].map(([sessionId, binding]) => [
                sessionId,
                bind(binding),
              ])
            ),
          }
        : {}),
      ...(context.pendingStartBindings
        ? {
            pendingStartBindings: new Map(
              [...context.pendingStartBindings].map(([requestId, binding]) => [
                requestId,
                bind(binding),
              ])
            ),
          }
        : {}),
    }
  }

  /** Apply a Host context to one live instance and preserve its PTY route only
   *  when the instance is still authenticated for the same v2 tuple. Legacy
   *  descriptors retain their plugin-id route semantics. */
  private updateInstanceCapabilityContext(
    plugin: RunningPlugin,
    context: HostCapabilityContext | null | undefined
  ): void {
    const nextContext =
      plugin.hasV2DescriptorIdentity || !plugin.openedViaLegacyAdapter
        ? this.bindCapabilityContext(context, plugin.instanceId)
        : context ?? null
    if (
      plugin.hasV2DescriptorIdentity &&
      plugin.capabilityContext?.storageSnapshotTier !== nextContext?.storageSnapshotTier
    ) {
      throw new Error('storage snapshot tier is fixed for a live plugin instance; recreate the instance')
    }
    const preserveTerminalOwnership =
      !plugin.hasV2DescriptorIdentity ||
      (sameRuntimeBinding(
        plugin.capabilityContext?.runtimeBinding,
        nextContext?.runtimeBinding
      ) && this.hasValidTerminalBinding({ ...plugin, capabilityContext: nextContext }))
    if (!preserveTerminalOwnership) this.releaseTerminalOwnership(plugin)
    plugin.capabilityContext = nextContext
  }

  /** Attach a Host-authenticated origin at the final broker boundary. The
   *  context supplied while opening a view remains Host state; neither the
   *  renderer payload nor a package backend can select this value. */
  private capabilityContextForInitiator(
    plugin: RunningPlugin,
    initiator: AuthenticatedInitiator,
  ): HostCapabilityContext | null {
    const context = plugin.capabilityContext
    if (!context) return null
    let executionPolicy: ExecutionPolicySnapshot | undefined
    if (initiator.kind === 'agent' && this.executionPolicyResolver) {
      try {
        executionPolicy = this.executionPolicyResolver(plugin.workspacePath ?? undefined)
      } catch (error) {
        this.noteExecutionPolicyFailure(error)
        return null
      }
    }
    return {
      ...context,
      initiator,
      ...(executionPolicy ? { executionPolicy } : {}),
    }
  }

  private instanceForSender(senderId: number): RunningPlugin | undefined {
    const instanceId = this.bySender.get(senderId)
    return instanceId ? this.running.get(instanceId) : undefined
  }

  /** Sender-id attribution belongs only to a plugin WebContents' main frame.
   * A subframe never inherits its parent receiver: frame-provider traffic is
   * admitted only on its bound MessagePort after exact tuple validation. */
  private instanceForIpc(senderId: number, senderFrame: WebFrameMain | null): RunningPlugin | undefined {
    const surface = this.instanceForSender(senderId)
    if (
      surface?.carrier === 'surface' &&
      senderFrame !== null &&
      senderFrame === surface.view.webContents.mainFrame
    ) return surface
    return undefined
  }

  private currentReceiverRegistration(id: string, plugin: RunningPlugin): ReceiverRegistration | undefined {
    const registration = this.receiverRegistrations.get(id)
    return registration &&
      registration.receiverInstanceId === plugin.instanceId &&
      registration.documentGeneration === plugin.documentGeneration
      ? registration
      : undefined
  }

  private declaredReceiver(plugin: RunningPlugin, registration: unknown): NonNullable<PluginViewLaunchDescriptor['receives']> | null {
    if (typeof registration !== 'object' || registration === null || Array.isArray(registration)) return null
    const candidate = registration as Record<string, unknown>
    if (candidate.protocolVersion !== 1 || !Array.isArray(candidate.locations)) return null
    const editorTargets = candidate.editorTargets
    if (editorTargets !== undefined && (
      typeof editorTargets !== 'object' || editorTargets === null || Array.isArray(editorTargets) ||
      Object.keys(editorTargets as Record<string, unknown>).length !== 1 ||
      (editorTargets as Record<string, unknown>).protocolVersion !== 1
    )) return null
    const closeGuard = candidate.closeGuard
    if (closeGuard !== undefined && (
      typeof closeGuard !== 'object' || closeGuard === null || Array.isArray(closeGuard) ||
      Object.keys(closeGuard as Record<string, unknown>).length !== 1 ||
      (closeGuard as Record<string, unknown>).protocolVersion !== 1
    )) return null
    const locations: Array<'left' | 'detail'> = []
    for (const location of candidate.locations) {
      if (location !== 'left' && location !== 'detail') return null
      locations.push(location)
    }
    const descriptor = this.descriptors.get(plugin.id)
    const views = descriptor?.views?.filter((view) =>
      view.receives?.protocolVersion === 1 &&
      (plugin.contributionKey === null || view.contributionKey === plugin.contributionKey)
    ) ?? []
    const declared = views.find((view) =>
      view.receives!.locations.length === locations.length &&
      view.receives!.locations.every((role) => locations.includes(role)) &&
      Boolean(view.receives!.editorTargets) === Boolean(candidate.editorTargets) &&
      Boolean(view.receives!.closeGuard) === Boolean(candidate.closeGuard)
    )?.receives
    if (!declared || !plugin.hasV2DescriptorIdentity || !plugin.capabilityContext) return null
    return declared
  }

  private revokeReceiverRegistration(receiverId: string): void {
    const registration = this.receiverRegistrations.get(receiverId)
    if (!registration) return
    this.cancelPendingEditorTargets((pending) => pending.receiverId === receiverId)
    this.cancelDetailCloseTransactions((transaction) => transaction.receiverId === receiverId)
    this.cancelPendingDetailTargets((pending) => pending.receiverId === receiverId)
    this.cancelPendingDetailOpens((pending) => pending.receiverId === receiverId, 'receiver-unavailable')
    this.receiverRegistrations.delete(receiverId)
    for (const item of this.receiverItems.values()) {
      if (item.receiverId === receiverId) this.closePluginFrame(item.bindingId)
    }
  }

  /** Revalidate an already-admitted port on every ingress and egress. The port
   * is necessary but never sufficient authority for a receiver document. */
  private activePluginFrame(binding: PluginFrameBinding): RunningPlugin | undefined {
    const pending = this.pendingPluginFrames.get(binding.id)
    const active = this.pluginFrameBindings.activeForInstance(binding.instanceId)
    const plugin = this.running.get(binding.instanceId)
    if (
      !pending ||
      !active ||
      !plugin ||
      plugin.carrier !== 'frame' ||
      plugin.frameBindingId !== binding.id ||
      pending.frame === null ||
      pending.documentNonce === null ||
      pending.frame.isDestroyed() ||
      active.id !== binding.id ||
      active.documentGeneration !== binding.documentGeneration ||
      active.frameTreeNodeId !== binding.frameTreeNodeId ||
      active.receiverGeneration !== pending.receiverGeneration ||
      active.artifactId !== pending.artifactId ||
      active.packageId !== plugin.id ||
      active.contributionKey !== plugin.contributionKey ||
      active.packageVersion !== plugin.capabilityContext?.runtimeBinding?.packageVersion ||
      plugin.workspacePath === null ||
      resolve(plugin.workspacePath) !== active.workspacePath ||
      pending.frame.frameTreeNodeId !== active.frameTreeNodeId ||
      (pending.receiverInstanceId !== null &&
        this.running.get(pending.receiverInstanceId)?.documentGeneration !== pending.receiverDocumentGeneration) ||
      pending.frame.parent !== pending.receiverWebContents.mainFrame ||
      // A detached frame keeps its port and would keep answering over it: the
      // receiver can remove the element (or re-parent it) while the frame lives
      // on. Detached frames have no place in a composed surface, so they lose
      // their authority the moment they leave the tree.
      pending.frame.detached ||
      pending.frame.url !== active.entryUrl ||
      // Non-special scheme: the frame's origin is `scheme://host`, while
      // `new URL(...).origin` is opaque ("null") for such schemes.
      pending.frame.origin !== pending.assetOrigin.replace(/\/$/, '')
    ) return undefined
    return plugin
  }

  /** Why a recorded pair is no longer usable, or '' when it is current. Kept
   *  beside {@link currentDetailPair} so a refused detail open can name the
   *  condition that failed instead of answering a bare `receiver-unavailable`. */
  private detailPairRefusal(pair: DetailPair): string {
    const source = this.running.get(pair.sourceInstanceId)
    const registration = this.receiverRegistrations.get(pair.receiverId)
    const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
    const descriptor = source ? this.descriptors.get(source.id) : undefined
    const sourceView = descriptor?.views?.find((view) => view.contributionKey === source?.contributionKey)
    const receiverDescriptor = receiver ? this.descriptors.get(receiver.id) : undefined
    const receiverView = receiverDescriptor?.views?.find((view) => view.contributionKey === receiver?.contributionKey)
    const sourceBinding = source?.carrier === 'frame'
      ? this.pluginFrameBindings.activeForInstance(source.instanceId)
      : null
    if (!source) return 'source instance is not running'
    if (!receiver || !registration) return 'receiver is not registered'
    if (!descriptor || !sourceView) return 'source view is unavailable'
    if (!receiverDescriptor || !receiverView) return 'receiver view is unavailable'
    if (!source.hasV2DescriptorIdentity || !receiver.hasV2DescriptorIdentity) return 'instances are not Manifest v2'
    if (source.workspacePath === null || receiver.workspacePath === null) return 'a workspace path is missing'
    if (resolve(source.workspacePath) !== pair.workspacePath || resolve(receiver.workspacePath) !== pair.workspacePath) {
      return 'source and receiver workspaces differ'
    }
    if (source.hostWindow !== receiver.hostWindow) return 'source and receiver live in different windows'
    if (sourceView.location !== 'left') return 'source view is not a left contribution'
    if (sourceView.detailView !== pair.detailView.id) return 'source no longer declares this detail view'
    if (!descriptor.views?.includes(pair.detailView)) return 'detail view is not part of the source descriptor'
    if (pair.detailView.location !== 'detail') return 'detail view is not a detail contribution'
    if (!pair.detailView.targetSchema) return 'detail view declares no target schema'
    if (this.descriptors.get(descriptor.id) !== descriptor) return 'source descriptor changed'
    if (this.descriptors.get(receiverDescriptor.id) !== receiverDescriptor) return 'receiver descriptor changed'
    if (this.isPackageVersionStopping(descriptor.id, descriptor.packageVersion)) return 'source package is stopping'
    if (this.isPackageVersionStopping(receiverDescriptor.id, receiverDescriptor.packageVersion)) {
      return 'receiver package is stopping'
    }
    if (this.currentReceiverRegistration(pair.receiverId, receiver) !== registration) return 'receiver registration is stale'
    if (!registration.declaration.locations.includes('detail')) return 'receiver does not declare the detail location'
    if (!sourceBinding || this.activePluginFrame(sourceBinding) !== source) return 'source frame is not active'
    if (!source.capabilityContext?.runtimeBinding) return 'source has no runtime binding'
    if (source.capabilityContext.runtimeBinding.instanceId !== source.instanceId) {
      return 'source runtime binding is not this instance'
    }
    if (!receiver.capabilityContext?.runtimeBinding) return 'receiver has no runtime binding'
    if (receiver.capabilityContext.runtimeBinding.instanceId !== receiver.instanceId) {
      return 'receiver runtime binding is not this instance'
    }
    const sourceContext = this.contributionCapabilityContext(descriptor, sourceView, pair.workspacePath)
    const detailContext = this.contributionCapabilityContext(descriptor, pair.detailView, pair.workspacePath)
    const receiverContext = this.contributionCapabilityContext(receiverDescriptor, receiverView, pair.workspacePath)
    if (!sourceContext?.userGrant?.system.includes('ui')) return 'source has no ui grant'
    if (descriptor.capabilityPolicy?.kind !== 'manifest-v2' || !descriptor.capabilityPolicy.system.includes('ui')) {
      return 'source policy does not allow ui'
    }
    if (!detailContext) return 'detail capability context is unavailable'
    if (!receiverContext) return 'receiver capability context is unavailable'
    return ''
  }

  private markPluginReady(plugin: RunningPlugin): void {
    plugin.pluginReady = true
    this.deliverPendingDetailTarget(plugin)
    this.settleActivation(plugin.instanceId)
    this.settlePluginReadyWaiter(plugin.instanceId)
    console.log(`[plugin] ${plugin.id} ready`)
  }

  /** Revalidates the original caller through its private offer or chosen item. */
  private currentPendingDetailOpen(pending: PendingDetailOpen): boolean {
    const source = this.running.get(pending.sourceInstanceId)
    const sourceBinding = source ? this.pluginFrameBindings.activeForInstance(source.instanceId) : null
    const pair = this.detailPairs.get(pending.sourceInstanceId)
    const registration = this.receiverRegistrations.get(pending.receiverId)
    const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
    const item = pending.itemId === null ? undefined : this.receiverItems.get(pending.itemId)
    const itemPair = item?.offer.detailSourceInstanceId
      ? this.detailPairs.get(item.offer.detailSourceInstanceId)
      : undefined
    return Boolean(
      source && source.documentGeneration === pending.sourceDocumentGeneration && sourceBinding &&
      this.activePluginFrame(sourceBinding) === source && pair && pair.receiverId === pending.receiverId &&
      this.currentDetailPair(pair) && registration && receiver &&
      registration.receiverInstanceId === pending.receiverInstanceId &&
      registration.documentGeneration === pending.receiverDocumentGeneration &&
      this.currentReceiverRegistration(pending.receiverId, receiver) === registration &&
      !receiver.view.webContents.isDestroyed() &&
      (pending.itemId === null
        ? registration.offers.get(pending.offerId)?.openId === pending.id
        : item && item.receiverId === pending.receiverId && item.offer.location === 'detail' &&
          itemPair && itemPair.receiverId === pending.receiverId && this.currentDetailPair(itemPair))
    )
  }

  private settlePendingDetailOpen(
    openId: string,
    response: CapabilityResponse,
    closeItem = false,
  ): void {
    const pending = this.pendingDetailOpens.get(openId)
    if (!pending) return
    this.pendingDetailOpens.delete(openId)
    if (pending.timer !== null) clearTimeout(pending.timer)
    const registration = this.receiverRegistrations.get(pending.receiverId)
    if (registration?.offers.get(pending.offerId)?.openId === openId) {
      registration.offers.delete(pending.offerId)
    }
    const item = pending.itemId === null ? undefined : this.receiverItems.get(pending.itemId)
    if (closeItem && item?.offer.openId === openId) this.closePluginFrame(item.bindingId)
    pending.resolve(response)
  }

  private cancelPendingDetailOpens(
    predicate: (pending: PendingDetailOpen) => boolean,
    reason: 'provider-unavailable' | 'receiver-unavailable',
    closeItems = false,
  ): void {
    for (const pending of this.pendingDetailOpens.values()) {
      if (predicate(pending)) {
        this.settlePendingDetailOpen(
          pending.id,
          buildSuccess(pending.reqId, { opened: false, reason }),
          closeItems,
        )
      }
    }
  }

  private settlePendingDetailTarget(
    targetId: string,
    decision: { applied: true } | { applied: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' },
  ): void {
    const pending = this.pendingDetailTargets.get(targetId)
    if (!pending) return
    this.pendingDetailTargets.delete(targetId)
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.resolve(decision)
    if (!decision.applied && pending.openId !== undefined) {
      const open = this.pendingDetailOpens.get(pending.openId)
      if (open) {
        this.settlePendingDetailOpen(
          pending.openId,
          buildSuccess(open.reqId, { opened: false, reason: 'provider-unavailable' }),
          true,
        )
      }
    }
  }

  private cancelPendingDetailTargets(predicate: (pending: PendingDetailTarget) => boolean): void {
    for (const pending of this.pendingDetailTargets.values()) {
      if (predicate(pending)) this.settlePendingDetailTarget(pending.target.targetId, { applied: false, reason: 'unavailable' })
    }
  }

  /** Revalidates an unacknowledged target against its exact admitted detail provider. */
  private currentPendingDetailTarget(pending: PendingDetailTarget): boolean {
    const item = this.receiverItems.get(pending.itemId)
    const provider = this.running.get(pending.providerInstanceId)
    const binding = provider ? this.pluginFrameBindings.activeForInstance(provider.instanceId) : null
    const pair = item?.offer.detailSourceInstanceId
      ? this.detailPairs.get(item.offer.detailSourceInstanceId)
      : undefined
    const registration = this.receiverRegistrations.get(pending.receiverId)
    const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
    return Boolean(
      item && item.receiverId === pending.receiverId && item.bindingId === pending.bindingId &&
      item.offer.location === 'detail' && item.offer.detailSourceInstanceId &&
      (pending.previousTarget === undefined
        ? item.detailTarget === pending.target && item.appliedDetailTarget === undefined
        : item.detailTarget === pending.previousTarget && item.appliedDetailTarget === pending.previousTarget) &&
      provider && provider.documentGeneration === pending.providerDocumentGeneration && provider.pluginReady && binding &&
      this.activePluginFrame(binding) === provider &&
      this.pendingPluginFrames.get(pending.bindingId)?.instanceId === provider.instanceId &&
      pair && pair.receiverId === pending.receiverId && this.currentDetailPair(pair) &&
      registration && receiver && registration.receiverInstanceId === pending.receiverInstanceId &&
      registration.documentGeneration === pending.receiverDocumentGeneration &&
      this.currentReceiverRegistration(pending.receiverId, receiver) === registration &&
      !receiver.view.webContents.isDestroyed() &&
      (pending.previousTarget === undefined || pending.target.resourceKey === pending.previousTarget.resourceKey)
    )
  }

  /** Send one revision only to its exact admitted ready detail provider. */
  private dispatchDetailTarget(
    item: ReceiverItem,
    target: DetailTargetState,
    previousTarget: DetailTargetState | undefined,
    openId?: string,
  ): Promise<{ applied: true } | { applied: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }> {
    if (this.detailCloseLocks.has(item.id)) return Promise.resolve({ applied: false, reason: 'busy' })
    const providerInstanceId = this.pendingPluginFrames.get(item.bindingId)?.instanceId
    const provider = providerInstanceId ? this.running.get(providerInstanceId) : undefined
    const registration = this.receiverRegistrations.get(item.receiverId)
    if (!provider || !registration) return Promise.resolve({ applied: false, reason: 'unavailable' })
    return new Promise((resolveDecision) => {
      const pending: PendingDetailTarget = {
        target,
        openId,
        itemId: item.id,
        receiverId: item.receiverId,
        receiverInstanceId: registration.receiverInstanceId,
        receiverDocumentGeneration: registration.documentGeneration,
        providerInstanceId: provider.instanceId,
        providerDocumentGeneration: provider.documentGeneration,
        bindingId: item.bindingId,
        previousTarget,
        resolve: resolveDecision,
        timer: null,
      }
      const origin = openId === undefined ? undefined : this.pendingDetailOpens.get(openId)
      if (!this.currentPendingDetailTarget(pending) ||
        (openId !== undefined && (!origin || !this.currentPendingDetailOpen(origin)))) {
        resolveDecision({ applied: false, reason: 'unavailable' })
        return
      }
      pending.timer = setTimeout(
        () => {
          console.warn(
            `[plugins] detail target timed out: '${provider.contributionKey}' never applied ` +
            `revision ${target.revision} of resource '${target.resourceKey}'`,
          )
          this.settlePendingDetailTarget(target.targetId, { applied: false, reason: 'timeout' })
        },
        10_000,
      )
      this.pendingDetailTargets.set(target.targetId, pending)
      console.warn(
        `[plugins] detail target dispatched to '${provider.contributionKey}' ` +
        `(revision ${target.revision}, resource '${target.resourceKey}')`,
      )
      if (!this.sendToPlugin(provider, IPC_EVENT, {
        type: 'plugin:view:detail-target',
        data: { targetId: target.targetId, revision: target.revision, target: target.target },
      })) {
        this.settlePendingDetailTarget(target.targetId, { applied: false, reason: 'unavailable' })
      }
    })
  }

  /** Deliver the initial revision only to its exact admitted ready provider. */
  private deliverPendingDetailTarget(provider: RunningPlugin): void {
    if (!provider.pluginReady) return
    const item = [...this.receiverItems.values()].find((candidate) =>
      candidate.detailTarget !== undefined && candidate.offer.detailSourceInstanceId !== undefined &&
      this.pendingPluginFrames.get(candidate.bindingId)?.instanceId === provider.instanceId
    )
    if (!item?.detailTarget || item.appliedDetailTarget === item.detailTarget ||
      this.pendingDetailTargets.has(item.detailTarget.targetId)) return
    const openId = item.offer.openId
    if (openId !== undefined) {
      const pendingOpen = this.pendingDetailOpens.get(openId)
      if (!pendingOpen || !this.currentPendingDetailOpen(pendingOpen)) return
    }
    void this.dispatchDetailTarget(item, item.detailTarget, undefined, openId)
  }

  private hidePlugin(plugin: RunningPlugin): void {
    if (plugin.carrier === 'frame') {
      this.destroyInstance(plugin.instanceId)
      return
    }
    if (plugin.closeHostOnHide && !plugin.hostWindow.isDestroyed()) {
      plugin.hostWindow.close()
    } else {
      this.deactivate(plugin.instanceId)
    }
  }

  private currentDetailCloseCandidate(
    item: ReceiverItem,
    receiver: RunningPlugin,
    registration: ReceiverRegistration,
  ): boolean {
    const providerInstanceId = this.pendingPluginFrames.get(item.bindingId)?.instanceId
    const provider = providerInstanceId ? this.running.get(providerInstanceId) : undefined
    const binding = provider ? this.pluginFrameBindings.activeForInstance(provider.instanceId) : null
    const descriptor = provider ? this.descriptors.get(provider.id) : undefined
    const pair = item.offer.detailSourceInstanceId
      ? this.detailPairs.get(item.offer.detailSourceInstanceId)
      : undefined
    return Boolean(
      item.receiverId === registration.id && receiver.instanceId === registration.receiverInstanceId &&
      receiver.documentGeneration === registration.documentGeneration &&
      this.currentReceiverRegistration(registration.id, receiver) === registration &&
      !receiver.view.webContents.isDestroyed() && provider && provider.pluginReady && binding &&
      this.activePluginFrame(binding) === provider && provider.id === item.offer.descriptor.id &&
      provider.contributionKey === item.offer.view.contributionKey && descriptor === item.offer.descriptor &&
      descriptor.views?.includes(item.offer.view) &&
      this.contributionCapabilityContext(descriptor, item.offer.view, item.offer.workspacePath) &&
      (pair === undefined || (pair.receiverId === item.receiverId && this.currentDetailPair(pair)))
    )
  }

  private currentPendingReceiverClose(close: PendingReceiverClose): boolean {
    const transaction = this.detailCloseTransactions.get(close.transactionId)
    const registration = this.receiverRegistrations.get(close.receiverId)
    const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
    return Boolean(
      transaction && (transaction.phase === 'preparing' || transaction.phase === 'prepared') &&
      transaction.receiverId === close.receiverId && transaction.receiverInstanceId === close.receiverInstanceId &&
      transaction.receiverDocumentGeneration === close.receiverDocumentGeneration &&
      this.receiverCloseLocks.get(close.receiverId) === transaction.id && registration && receiver &&
      registration.declaration.closeGuard?.protocolVersion === 1 &&
      receiver.documentGeneration === close.receiverDocumentGeneration &&
      this.currentReceiverRegistration(close.receiverId, receiver) === registration &&
      !receiver.view.webContents.isDestroyed()
    )
  }

  private dispatchDetailCloseProviderPrepares(transaction: DetailCloseTransaction): void {
    const routes = [...this.pendingDetailCloses.values()].filter((route) => route.transactionId === transaction.id)
    if (routes.length === 0 && transaction.itemIds.length === 0) {
      this.finishDetailClosePreparation(transaction)
      return
    }
    for (const route of routes) {
      if (transaction.phase !== 'preparing') break
      const provider = this.running.get(route.providerInstanceId)
      if (!provider || !this.currentPendingDetailClose(route)) {
        this.failDetailCloseTransaction(transaction.id, 'unavailable')
        break
      }
      route.timer = setTimeout(
        () => this.failDetailCloseTransaction(transaction.id, 'timeout'),
        DETAIL_OPEN_TIMEOUT_MS,
      )
      route.dispatched = this.sendToPlugin(provider, IPC_VIEW_CLOSE_REQUEST, {
        closeId: route.closeId,
        itemId: route.itemId,
        reason: 'user',
        documentGeneration: route.providerDocumentGeneration,
      })
      if (!route.dispatched) this.failDetailCloseTransaction(transaction.id, 'unavailable')
    }
  }

  private currentPendingDetailClose(close: PendingDetailClose): boolean {
    const transaction = this.detailCloseTransactions.get(close.transactionId)
    const registration = this.receiverRegistrations.get(close.receiverId)
    const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
    const item = this.receiverItems.get(close.itemId)
    const provider = this.running.get(close.providerInstanceId)
    return Boolean(
      transaction && (transaction.phase === 'preparing' || transaction.phase === 'prepared') &&
      transaction.receiverId === close.receiverId && transaction.receiverInstanceId === close.receiverInstanceId &&
      transaction.receiverDocumentGeneration === close.receiverDocumentGeneration &&
      this.detailCloseLocks.get(close.itemId) === transaction.id && registration && receiver && item && provider &&
      close.bindingId === item.bindingId && close.providerDocumentGeneration === provider.documentGeneration &&
      this.currentDetailCloseCandidate(item, receiver, registration)
    )
  }

  private failDetailCloseTransaction(
    transactionId: string,
    reason: Exclude<DetailCloseResult, { closed: true }>['reason'],
  ): void {
    const transaction = this.detailCloseTransactions.get(transactionId)
    if (!transaction || (transaction.phase !== 'preparing' && transaction.phase !== 'prepared')) return
    transaction.phase = 'settled'
    this.detailCloseTransactions.delete(transactionId)
    const receiverClose = [...this.pendingReceiverCloses.values()].find((route) => route.transactionId === transactionId)
    if (receiverClose) {
      this.pendingReceiverCloses.delete(receiverClose.closeId)
      if (receiverClose.timer !== null) clearTimeout(receiverClose.timer)
      if (this.receiverCloseLocks.get(receiverClose.receiverId) === transactionId) {
        this.receiverCloseLocks.delete(receiverClose.receiverId)
      }
      const registration = this.receiverRegistrations.get(receiverClose.receiverId)
      const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
      if (receiverClose.dispatched && receiver && this.currentReceiverRegistration(receiverClose.receiverId, receiver) === registration &&
        receiver.documentGeneration === receiverClose.receiverDocumentGeneration && !receiver.view.webContents.isDestroyed()) {
        receiver.view.webContents.send(IPC_RECEIVER_CLOSE_CANCELLED, {
          receiverId: receiverClose.receiverId,
          closeId: receiverClose.closeId,
        })
      }
    }
    const routes = [...this.pendingDetailCloses.values()].filter((route) => route.transactionId === transactionId)
    for (const route of routes) {
      this.pendingDetailCloses.delete(route.closeId)
      if (route.timer !== null) clearTimeout(route.timer)
      if (this.detailCloseLocks.get(route.itemId) === transactionId) this.detailCloseLocks.delete(route.itemId)
      if (!route.dispatched) continue
      const provider = this.running.get(route.providerInstanceId)
      if (provider) {
        this.sendToPlugin(provider, IPC_EVENT, {
          type: 'plugin:view:close-cancelled',
          data: { closeId: route.closeId },
        })
      }
    }
    transaction.resolve({ closed: false, reason })
    transaction.resolvePrepared({ closed: false, reason })
  }

  private cancelDetailCloseTransactions(predicate: (transaction: DetailCloseTransaction) => boolean): void {
    for (const transaction of [...this.detailCloseTransactions.values()]) {
      if (predicate(transaction)) this.failDetailCloseTransaction(transaction.id, 'unavailable')
    }
  }

  private commitDetailCloseTransaction(transactionId: string): void {
    const transaction = this.detailCloseTransactions.get(transactionId)
    if (!transaction || (transaction.phase !== 'preparing' && transaction.phase !== 'prepared')) return
    const routes = [...this.pendingDetailCloses.values()].filter((route) => route.transactionId === transactionId)
    const receiverClose = [...this.pendingReceiverCloses.values()].find((route) => route.transactionId === transactionId)
    if (routes.length !== transaction.itemIds.length ||
      (receiverClose !== undefined && (!receiverClose.accepted || !this.currentPendingReceiverClose(receiverClose))) ||
      !routes.every((route) => route.accepted && this.currentPendingDetailClose(route))) {
      this.failDetailCloseTransaction(transactionId, 'unavailable')
      return
    }
    transaction.phase = 'committing'
    this.detailCloseTransactions.delete(transactionId)
    if (receiverClose) {
      this.pendingReceiverCloses.delete(receiverClose.closeId)
      if (receiverClose.timer !== null) clearTimeout(receiverClose.timer)
      if (this.receiverCloseLocks.get(receiverClose.receiverId) === transactionId) {
        this.receiverCloseLocks.delete(receiverClose.receiverId)
      }
    }
    for (const route of routes) {
      this.pendingDetailCloses.delete(route.closeId)
      if (route.timer !== null) clearTimeout(route.timer)
      if (this.detailCloseLocks.get(route.itemId) === transactionId) this.detailCloseLocks.delete(route.itemId)
    }
    for (const route of routes) this.closePluginFrame(route.bindingId)
    transaction.resolve({ closed: true })
    transaction.resolvePrepared({ closed: true })
  }

  /** A held transaction stops at `prepared` so a native close can commit every
   *  window only after all of them accepted. */
  private finishDetailClosePreparation(transaction: DetailCloseTransaction): void {
    if (transaction.phase !== 'preparing') return
    if (!transaction.holdCommit) {
      this.commitDetailCloseTransaction(transaction.id)
      return
    }
    transaction.phase = 'prepared'
    transaction.resolvePrepared({ closed: true })
  }

  private requestDetailCloseTransaction(
    receiver: RunningPlugin,
    receiverId: string,
    itemIds: readonly string[],
  ): Promise<DetailCloseResult> {
    const started = this.beginDetailCloseTransaction(receiver, receiverId, itemIds, 'receiver-item-batch', false)
    return started.ok ? started.transaction.result : Promise.resolve(started.result)
  }

  private beginDetailCloseTransaction(
    receiver: RunningPlugin,
    receiverId: string,
    itemIds: readonly string[],
    reason: ReceiverCloseReason,
    holdCommit: boolean,
  ): { ok: true; transaction: DetailCloseTransaction } | { ok: false; result: DetailCloseResult } {
    const registration = this.currentReceiverRegistration(receiverId, receiver)
    const nativeClose = reason !== 'receiver-item-batch'
    if (!registration || (!nativeClose && itemIds.length === 0) ||
      itemIds.length > MAX_DETAIL_CLOSE_TRANSACTION_ITEMS ||
      new Set(itemIds).size !== itemIds.length || itemIds.some((itemId) => !nonEmptyString(itemId))) {
      return { ok: false, result: { closed: false, reason: 'unavailable' } }
    }
    const requiresReceiverGuard = registration.declaration.closeGuard?.protocolVersion === 1
    if (requiresReceiverGuard && itemIds.length === 0 && !nativeClose) {
      return { ok: false, result: { closed: false, reason: 'unavailable' } }
    }
    if (!requiresReceiverGuard && itemIds.length === 0) return { ok: false, result: { closed: true } }
    if (itemIds.some((itemId) => this.detailCloseLocks.has(itemId)) ||
      (requiresReceiverGuard && this.receiverCloseLocks.has(receiverId))) {
      return { ok: false, result: { closed: false, reason: 'busy' } }
    }
    if ([...this.pendingDetailTargets.values()].some((pending) => itemIds.includes(pending.itemId))) {
      return { ok: false, result: { closed: false, reason: 'busy' } }
    }
    const items = itemIds.map((itemId) => this.receiverItems.get(itemId))
    if (items.some((item) => !item || item.receiverId !== receiverId ||
      !this.currentDetailCloseCandidate(item, receiver, registration))) {
      return { ok: false, result: { closed: false, reason: 'unavailable' } }
    }

    let resolveResult!: (result: DetailCloseResult) => void
    let resolvePrepared!: (result: DetailCloseResult) => void
    const transaction: DetailCloseTransaction = {
      id: randomUUID(),
      receiverId,
      receiverInstanceId: receiver.instanceId,
      receiverDocumentGeneration: receiver.documentGeneration,
      itemIds: [...itemIds],
      reason,
      holdCommit,
      result: new Promise<DetailCloseResult>((resolve) => { resolveResult = resolve }),
      prepared: new Promise<DetailCloseResult>((resolve) => { resolvePrepared = resolve }),
      resolve: (result) => resolveResult(result),
      resolvePrepared: (result) => resolvePrepared(result),
      phase: 'preparing',
    }
    this.detailCloseTransactions.set(transaction.id, transaction)
    for (const itemId of itemIds) this.detailCloseLocks.set(itemId, transaction.id)
    if (requiresReceiverGuard) this.receiverCloseLocks.set(receiverId, transaction.id)
    const routes = items.map((item) => {
      const candidate = item as ReceiverItem
      const providerInstanceId = this.pendingPluginFrames.get(candidate.bindingId)?.instanceId
      const provider = providerInstanceId ? this.running.get(providerInstanceId) : undefined
      const route: PendingDetailClose = {
        closeId: randomUUID(),
        transactionId: transaction.id,
        itemId: candidate.id,
        bindingId: candidate.bindingId,
        providerInstanceId: provider?.instanceId ?? '',
        providerDocumentGeneration: provider?.documentGeneration ?? -1,
        receiverId,
        receiverInstanceId: receiver.instanceId,
        receiverDocumentGeneration: receiver.documentGeneration,
        dispatched: false,
        accepted: false,
        timer: null,
      }
      this.pendingDetailCloses.set(route.closeId, route)
      return route
    })
    if (!requiresReceiverGuard) {
      this.dispatchDetailCloseProviderPrepares(transaction)
      return { ok: true, transaction }
    }
    const receiverClose: PendingReceiverClose = {
      closeId: randomUUID(),
      transactionId: transaction.id,
      receiverId,
      receiverInstanceId: receiver.instanceId,
      receiverDocumentGeneration: receiver.documentGeneration,
      dispatched: false,
      accepted: false,
      timer: null,
    }
    this.pendingReceiverCloses.set(receiverClose.closeId, receiverClose)
    if (!this.currentPendingReceiverClose(receiverClose)) {
      this.failDetailCloseTransaction(transaction.id, 'unavailable')
      return { ok: true, transaction }
    }
    receiverClose.timer = setTimeout(
      () => this.failDetailCloseTransaction(transaction.id, 'timeout'),
      DETAIL_OPEN_TIMEOUT_MS,
    )
    try {
      if (!receiver.view.webContents.isDestroyed()) {
        receiver.view.webContents.send(IPC_RECEIVER_CLOSE_REQUEST, {
          receiverId,
          closeId: receiverClose.closeId,
          reason: transaction.reason,
          documentGeneration: receiver.documentGeneration,
        })
        receiverClose.dispatched = true
      }
    } catch {
      receiverClose.dispatched = false
    }
    if (!receiverClose.dispatched) this.failDetailCloseTransaction(transaction.id, 'unavailable')
    return { ok: true, transaction }
  }

  private resolveDetailClose(plugin: RunningPlugin, reqId: string, args: unknown): CapabilityResponse {
    const record = typeof args === 'object' && args !== null && !Array.isArray(args)
      ? args as Record<string, unknown>
      : null
    const closeId = typeof record?.closeId === 'string' ? record.closeId : ''
    const itemId = typeof record?.itemId === 'string' ? record.itemId : ''
    const decision = typeof record?.decision === 'object' && record.decision !== null && !Array.isArray(record.decision)
      ? record.decision as Record<string, unknown>
      : null
    const accepted = decision?.accepted
    const reason = decision?.reason
    const acceptedDecision = accepted === true && reason === 'accepted'
    const refusalReason = accepted === false && (reason === 'refused' || reason === 'busy') ? reason : undefined
    const close = this.pendingDetailCloses.get(closeId)
    if (!close || Object.keys(record ?? {}).some((key) => key !== 'closeId' && key !== 'itemId' && key !== 'decision') ||
      !decision || Object.keys(decision).some((key) => key !== 'accepted' && key !== 'reason') ||
      close.providerInstanceId !== plugin.instanceId || close.itemId !== itemId || close.accepted ||
      (!acceptedDecision && refusalReason === undefined) || !this.currentPendingDetailClose(close)) {
      return buildError(reqId, 'CAPABILITY_DENIED', 'detail close is not current')
    }
    if (!acceptedDecision) {
      if (refusalReason === undefined) return buildError(reqId, 'CAPABILITY_DENIED', 'detail close is not current')
      this.failDetailCloseTransaction(close.transactionId, refusalReason)
      return buildSuccess(reqId, null)
    }
    close.accepted = true
    if (close.timer !== null) {
      clearTimeout(close.timer)
      close.timer = null
    }
    const transaction = this.detailCloseTransactions.get(close.transactionId)
    if (transaction && transaction.itemIds.every((item) =>
      [...this.pendingDetailCloses.values()].some((route) => route.transactionId === transaction.id && route.itemId === item && route.accepted)
    )) this.finishDetailClosePreparation(transaction)
    return buildSuccess(reqId, null)
  }

  private resolveReceiverClose(receiver: RunningPlugin, payload: unknown): void {
    const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null
    const receiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
    const closeId = typeof record?.closeId === 'string' ? record.closeId : ''
    const decision = typeof record?.decision === 'object' && record.decision !== null && !Array.isArray(record.decision)
      ? record.decision as Record<string, unknown>
      : null
    const accepted = decision?.accepted
    const reason = decision?.reason
    const acceptedDecision = accepted === true && reason === 'accepted'
    const refusalReason = accepted === false && (reason === 'refused' || reason === 'busy') ? reason : undefined
    const close = this.pendingReceiverCloses.get(closeId)
    if (!close || !record || Object.keys(record).some((key) =>
      key !== 'receiverId' && key !== 'closeId' && key !== 'decision'
    ) || !decision || Object.keys(decision).some((key) => key !== 'accepted' && key !== 'reason') ||
      close.receiverId !== receiverId || close.receiverInstanceId !== receiver.instanceId || close.accepted ||
      (!acceptedDecision && refusalReason === undefined) || !this.currentPendingReceiverClose(close)) {
      throw new Error('receiver close acknowledgement is unavailable')
    }
    if (!acceptedDecision) {
      if (refusalReason === undefined) throw new Error('receiver close acknowledgement is unavailable')
      this.failDetailCloseTransaction(close.transactionId, refusalReason)
      return
    }
    close.accepted = true
    if (close.timer !== null) {
      clearTimeout(close.timer)
      close.timer = null
    }
    const transaction = this.detailCloseTransactions.get(close.transactionId)
    if (!transaction || !this.currentPendingReceiverClose(close)) {
      this.failDetailCloseTransaction(close.transactionId, 'unavailable')
      return
    }
    this.dispatchDetailCloseProviderPrepares(transaction)
  }

  private resolveDetailTarget(plugin: RunningPlugin, reqId: string, args: unknown): CapabilityResponse {
    const record = typeof args === 'object' && args !== null && !Array.isArray(args)
      ? args as Record<string, unknown>
      : null
    const targetId = typeof record?.targetId === 'string' ? record.targetId : ''
    const revision = record?.revision
    const decision = typeof record?.decision === 'object' && record.decision !== null && !Array.isArray(record.decision)
      ? record.decision as Record<string, unknown>
      : null
    const applied = decision?.applied
    const reason = decision?.reason
    const accepted = applied === true && Object.keys(decision ?? {}).length === 1
    const refused = applied === false && (reason === 'refused' || reason === 'busy') &&
      Object.keys(decision ?? {}).length === 2
    const pending = this.pendingDetailTargets.get(targetId)
    const origin = pending?.openId === undefined ? undefined : this.pendingDetailOpens.get(pending.openId)
    const originCurrent = pending?.openId === undefined || Boolean(origin && this.currentPendingDetailOpen(origin))
    if (!record || Object.keys(record).some((key) => key !== 'targetId' && key !== 'revision' && key !== 'decision') ||
      typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0 || !decision || (!accepted && !refused) ||
      !pending || pending.target.revision !== revision || pending.providerInstanceId !== plugin.instanceId ||
      !this.currentPendingDetailTarget(pending) || !originCurrent) {
      if (pending && pending.target.revision === revision && pending.providerInstanceId === plugin.instanceId &&
        pending.openId !== undefined && !originCurrent) {
        this.settlePendingDetailTarget(targetId, { applied: false, reason: 'unavailable' })
      }
      return buildError(reqId, 'CAPABILITY_DENIED', 'detail target acknowledgement is not current')
    }
    this.pendingDetailTargets.delete(targetId)
    if (pending.timer !== null) clearTimeout(pending.timer)
    if (accepted) {
      const item = this.receiverItems.get(pending.itemId)
      if (!item || (pending.previousTarget === undefined
        ? item.detailTarget !== pending.target || item.appliedDetailTarget !== undefined
        : item.detailTarget !== pending.previousTarget || item.appliedDetailTarget !== pending.previousTarget)) {
        pending.resolve({ applied: false, reason: 'unavailable' })
        return buildError(reqId, 'CAPABILITY_DENIED', 'detail target acknowledgement is not current')
      }
      item.detailTarget = pending.target
      item.appliedDetailTarget = pending.target
      console.warn(
        `[plugins] detail target applied by ` +
        `'${this.running.get(pending.providerInstanceId)?.contributionKey ?? pending.providerInstanceId}' ` +
        `(revision ${pending.target.revision})`,
      )
      pending.resolve({ applied: true })
      if (pending.openId !== undefined) {
        const open = this.pendingDetailOpens.get(pending.openId)
        if (open && this.currentPendingDetailOpen(open)) {
          this.settlePendingDetailOpen(pending.openId, buildSuccess(open.reqId, { opened: true }))
        }
      }
    } else {
      pending.resolve({ applied: false, reason: reason as 'refused' | 'busy' })
      if (pending.openId !== undefined) {
        const open = this.pendingDetailOpens.get(pending.openId)
        if (open) {
          this.settlePendingDetailOpen(
            pending.openId,
            buildSuccess(open.reqId, { opened: false, reason: 'provider-unavailable' }),
            true,
          )
        }
      }
    }
    return buildSuccess(reqId, null)
  }

  private settlePendingEditorTarget(correlation: string, opened: boolean): void {
    const pending = this.pendingEditorTargets.get(correlation)
    if (!pending) return
    this.pendingEditorTargets.delete(correlation)
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.resolve(opened)
  }

  private cancelPendingEditorTargets(predicate: (pending: PendingEditorTarget) => boolean): void {
    for (const pending of this.pendingEditorTargets.values()) {
      if (predicate(pending)) this.settlePendingEditorTarget(pending.correlation, false)
    }
  }

  /** Revalidates a callback against the exact detail item and registered receiver document. */
  private currentPendingEditorTarget(pending: PendingEditorTarget): boolean {
    const source = this.running.get(pending.sourceInstanceId)
    const sourceBinding = source ? this.pluginFrameBindings.activeForInstance(source.instanceId) : null
    const item = this.receiverItems.get(pending.sourceItemId)
    const itemPending = item ? this.pendingPluginFrames.get(item.bindingId) : undefined
    const pair = item?.offer.detailSourceInstanceId
      ? this.detailPairs.get(item.offer.detailSourceInstanceId)
      : undefined
    const registration = this.receiverRegistrations.get(pending.receiverId)
    const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
    return Boolean(
      source && source.documentGeneration === pending.sourceDocumentGeneration && sourceBinding &&
      this.activePluginFrame(sourceBinding) === source &&
      item && item.receiverId === pending.receiverId && item.offer.location === 'detail' &&
      itemPending?.instanceId === source.instanceId && pair && pair.receiverId === pending.receiverId &&
      this.currentDetailPair(pair) && registration && receiver &&
      registration.receiverInstanceId === pending.receiverInstanceId &&
      registration.documentGeneration === pending.receiverDocumentGeneration &&
      registration.declaration.editorTargets?.protocolVersion === 1 &&
      this.currentReceiverRegistration(pending.receiverId, receiver) === registration &&
      source.workspacePath !== null && receiver.workspacePath !== null &&
      resolvePathForContainment(source.workspacePath) === pending.workspacePath &&
      resolvePathForContainment(receiver.workspacePath) === pending.workspacePath &&
      resolveWorkspaceRelativePath(pending.workspacePath, pending.targetRelativePath, false) === pending.targetPath &&
      !receiver.view.webContents.isDestroyed()
    )
  }

  /** Delivers one editor target to the exact receiver paired with this detail provider. */
  private async openPairedEditorTarget(
    source: RunningPlugin,
    workspacePath: string,
    filepath: string,
    line: unknown,
    column: unknown,
  ): Promise<boolean | null> {
    const item = [...this.receiverItems.values()].find((candidate) =>
      candidate.offer.location === 'detail' && candidate.offer.detailSourceInstanceId !== undefined &&
      this.pendingPluginFrames.get(candidate.bindingId)?.instanceId === source.instanceId
    )
    if (!item) return null
    const root = source.workspacePath === null ? null : resolvePathForContainment(source.workspacePath)
    const requestedRoot = resolvePathForContainment(workspacePath)
    if (!root || requestedRoot !== root || !filepath || isAbsolute(filepath) ||
      (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line <= 0)) ||
      (column !== undefined && (typeof column !== 'number' || !Number.isInteger(column) || column <= 0))) {
      return false
    }
    const targetPath = resolveWorkspaceRelativePath(root, filepath, false)
    if (!targetPath) return false
    const path = relative(root, targetPath)
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return false
    const registration = this.receiverRegistrations.get(item.receiverId)
    const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
    const pending: PendingEditorTarget = {
      correlation: randomUUID(),
      sourceInstanceId: source.instanceId,
      sourceDocumentGeneration: source.documentGeneration,
      sourceItemId: item.id,
      receiverId: item.receiverId,
      receiverInstanceId: registration?.receiverInstanceId ?? '',
      receiverDocumentGeneration: registration?.documentGeneration ?? -1,
      workspacePath: root,
      targetPath,
      targetRelativePath: path,
      resolve: () => undefined,
      timer: null,
    }
    if (!registration || !receiver || !this.currentPendingEditorTarget(pending)) return false
    return new Promise<boolean>((resolveResult) => {
      const request: PendingEditorTarget = {
        ...pending,
        resolve: resolveResult,
        timer: setTimeout(() => this.settlePendingEditorTarget(pending.correlation, false), 10_000),
      }
      this.pendingEditorTargets.set(request.correlation, request)
      try {
        receiver.view.webContents.send(IPC_RECEIVER_EDITOR_TARGET, {
          receiverId: request.receiverId,
          correlation: request.correlation,
          target: {
            path,
            ...(line === undefined ? {} : { line }),
            ...(column === undefined ? {} : { column }),
            sourceItem: request.sourceItemId,
          },
        })
      } catch {
        this.settlePendingEditorTarget(request.correlation, false)
      }
    })
  }

  /** Revalidates every live identity and Grant participating in a paired detail. */
  private currentDetailPair(pair: DetailPair): boolean {
    return this.detailPairRefusal(pair) === ''
  }

  /** Build an opaque, canonical resource identity without exposing target data. */
  private detailResourceKey(
    pair: DetailPair,
    descriptor: PluginLaunchDescriptor,
    target: JsonValue,
  ): string | null {
    if (typeof target !== 'object' || target === null || Array.isArray(target) ||
      !Object.prototype.hasOwnProperty.call(target, 'resource')) return null
    const resource = (target as Record<string, unknown>).resource
    const workspacePath = resolvePathForContainment(pair.workspacePath)
    if (!isJsonValue(resource) || !workspacePath || !nonEmptyString(descriptor.packageVersion)) return null
    return `detail-resource-v1:${createHash('sha256').update(canonicalTrustJson({
      contributionKey: pair.detailView.contributionKey,
      packageVersion: descriptor.packageVersion,
      workspacePath,
      resource,
    }), 'utf8').digest('hex')}`
  }

  /** Sends one Host-private detail offer after all current pair checks pass. */
  private offerPairedDetail(
    pair: DetailPair,
    descriptor: PluginLaunchDescriptor,
    target: JsonValue,
    resourceKey: string,
    openId: string,
    offerId: string,
  ): boolean {
    const registration = this.receiverRegistrations.get(pair.receiverId)
    const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
    if (!registration || !receiver || !this.currentDetailPair(pair)) return false
    const offer: ReceiverOffer = {
      id: offerId,
      openId,
      location: 'detail',
      descriptor,
      view: pair.detailView,
      workspacePath: pair.workspacePath,
      detailSourceInstanceId: pair.sourceInstanceId,
      detailTarget: { targetId: randomUUID(), revision: 1, resourceKey, target },
    }
    registration.offers.set(offer.id, offer)
    try {
      receiver.view.webContents.send('plugin:receiver:offer', {
        receiverId: registration.id,
        offer: {
          offerId: offer.id,
          contributionKey: offer.view.contributionKey,
          title: offer.view.title,
          location: offer.location,
          resourceKey,
        },
      })
      return true
    } catch {
      registration.offers.delete(offer.id)
      return false
    }
  }

  private openDetail(plugin: RunningPlugin, reqId: string, args: unknown): CapabilityResponse | Promise<CapabilityResponse> {
    const record = typeof args === 'object' && args !== null && !Array.isArray(args)
      ? args as Record<string, unknown>
      : null
    if (!record || Object.keys(record).some((key) => key !== 'contributionKey' && key !== 'target') ||
      typeof record.contributionKey !== 'string' || !Object.prototype.hasOwnProperty.call(record, 'target')) {
      return buildError(reqId, 'INVALID_ARGUMENT', 'detail request is invalid')
    }
    const pair = this.detailPairs.get(plugin.instanceId)
    if (!pair) {
      console.warn(`[plugins] detail open refused: '${plugin.id}' has no paired receiver`)
      return buildSuccess(reqId, { opened: false, reason: 'receiver-unpaired' })
    }
    const pairRefusal = this.detailPairRefusal(pair)
    if (pairRefusal) {
      console.warn(`[plugins] detail open refused: ${pairRefusal}`)
      return buildSuccess(reqId, { opened: false, reason: 'receiver-unavailable' })
    }
    const descriptor = this.descriptors.get(plugin.id)
    if (!descriptor || record.contributionKey !== pair.detailView.contributionKey) {
      console.warn(
        `[plugins] detail open refused: '${plugin.id}' asked for '${record.contributionKey}' ` +
        `but its declared detail view is '${pair.detailView.contributionKey}'`,
      )
      return buildError(reqId, 'INVALID_ARGUMENT', 'detail contribution is not declared by this source')
    }
    const validation = validatePluginDetailTarget({
      packageDir: descriptor.packageDir ?? '',
      targetSchema: pair.detailView.targetSchema,
      target: record.target,
    })
    if (!validation.ok) {
      console.warn(`[plugins] detail open refused: ${validation.reason}`)
      return validation.reason === 'invalid-target'
        ? buildError(reqId, 'INVALID_ARGUMENT', 'detail target is invalid')
        : buildSuccess(reqId, { opened: false, reason: 'provider-unavailable' })
    }
    const resourceKey = this.detailResourceKey(pair, descriptor, validation.target)
    const registration = this.receiverRegistrations.get(pair.receiverId)
    if (!resourceKey) return buildError(reqId, 'INVALID_ARGUMENT', 'detail target resource is invalid')
    if (!registration) return buildSuccess(reqId, { opened: false, reason: 'receiver-unavailable' })
    const openId = randomUUID()
    const offerId = randomUUID()
    return new Promise<CapabilityResponse>((resolveOpen) => {
      const pending: PendingDetailOpen = {
        id: openId,
        reqId,
        sourceInstanceId: plugin.instanceId,
        sourceDocumentGeneration: plugin.documentGeneration,
        receiverId: pair.receiverId,
        receiverInstanceId: registration.receiverInstanceId,
        receiverDocumentGeneration: registration.documentGeneration,
        offerId,
        itemId: null,
        resolve: resolveOpen,
        timer: null,
      }
      this.pendingDetailOpens.set(openId, pending)
      pending.timer = setTimeout(() => {
        console.warn(
          `[plugins] detail open timed out: '${plugin.id}' → '${pair.detailView.contributionKey}' ` +
          `(the receiver mounted the item but the provider never applied the target)`,
        )
        this.settlePendingDetailOpen(
          openId,
          buildSuccess(reqId, { opened: false, reason: 'receiver-unavailable' }),
          true,
        )
      }, DETAIL_OPEN_TIMEOUT_MS)
      if (!this.offerPairedDetail(pair, descriptor, validation.target, resourceKey, openId, offerId)) {
        console.warn('[plugins] detail open refused: the receiver could not be offered the target')
        this.settlePendingDetailOpen(
          openId,
          buildSuccess(reqId, { opened: false, reason: 'receiver-unavailable' }),
        )
      }
    })
  }

  private handlePluginFramePortMessage(binding: PluginFrameBinding, message: unknown): void {
    const plugin = this.activePluginFrame(binding)
    if (!plugin || typeof message !== 'object' || message === null || Array.isArray(message)) return
    const envelope = message as Record<string, unknown>
    const kind = envelope.kind
    const channel = envelope.channel
    const payload = envelope.payload
    const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : ''
    const respond = (response: CapabilityResponse): void => {
      if (requestId && this.activePluginFrame(binding)) {
        this.pluginFrameBindings.post(plugin.instanceId, 'plugin:response', { requestId, response })
      }
    }
    if (kind === 'cast') {
      if (channel === IPC_CAST) this.handleCast(0, payload, null, plugin)
      else if (channel === IPC_BACKEND_CANCEL) {
        const record = this.exactBackendPayload(payload, new Set(['reqId', 'subscriptionId']))
        const keys = record ? Object.keys(record) : []
        const id = keys.length === 1 ? record?.[keys[0] as 'reqId' | 'subscriptionId'] : undefined
        if (nonEmptyString(id)) this.cancelBackendRecord(plugin.instanceId, id)
      } else if (channel === IPC_READY) this.markPluginReady(plugin)
      else if (channel === IPC_HIDE_SELF) this.hidePlugin(plugin)
      return
    }
    if (kind !== 'invoke' || !requestId || typeof channel !== 'string') return
    const invoke = async (): Promise<CapabilityResponse> => {
      if (channel === IPC_CALL) return this.capabilityCallHandler?.(plugin, payload) ?? buildError(requestId, 'BACKEND_UNAVAILABLE', 'capability broker is not connected')
      if (channel === IPC_HOST_CALL) return this.handleHostCall(0, payload, null, plugin)
      if (channel === IPC_BACKEND_CALL) return this.backendCallHandler?.(plugin, payload) ?? buildError(requestId, 'BACKEND_UNAVAILABLE', 'backend broker is not connected')
      if (channel === IPC_BACKEND_SUBSCRIBE) return this.backendSubscribeHandler?.(plugin, payload) ?? buildError(requestId, 'BACKEND_UNAVAILABLE', 'backend broker is not connected')
      if (channel === IPC_READY) {
        this.markPluginReady(plugin)
        return buildSuccess(requestId, null)
      }
      if (channel === IPC_HIDE_SELF) {
        this.hidePlugin(plugin)
        return buildSuccess(requestId, null)
      }
      return buildError(requestId, 'BAD_REQUEST', 'unsupported frame channel')
    }
    void invoke().then(respond, () => respond(buildError(requestId, 'INTERNAL_ERROR', 'frame request failed')))
  }

  private discardGitPathGrants(instanceId: string): void {
    for (const [grant, record] of this.gitPathGrants) {
      if (record.instanceId === instanceId) this.gitPathGrants.delete(grant)
    }
  }

  private issueGitPathGrant(
    plugin: RunningPlugin,
    path: string,
    operations: readonly GitPathGrantOperation[],
  ): string | null {
    const binding = plugin.capabilityContext?.runtimeBinding
    const resolvedPath = resolvePathForContainment(path)
    if (!resolvedPath || !binding?.packageVersion || !plugin.workspacePath) return null
    this.discardExpiredGitPathGrants()
    const existing = [...this.gitPathGrants.entries()]
      .filter(([, grant]) => grant.instanceId === plugin.instanceId)
    while (existing.length >= MAX_GIT_PATH_GRANTS_PER_INSTANCE) {
      const oldest = existing.shift()
      if (oldest) this.gitPathGrants.delete(oldest[0])
    }
    const grant = randomUUID()
    this.gitPathGrants.set(grant, {
      instanceId: plugin.instanceId,
      workspacePath: resolve(plugin.workspacePath),
      packageVersion: binding.packageVersion,
      path: resolvedPath,
      operations: new Set(operations),
      expiresAt: Date.now() + GIT_PATH_GRANT_TTL_MS,
    })
    return grant
  }

  private discardExpiredGitPathGrants(): void {
    const now = Date.now()
    for (const [grant, record] of this.gitPathGrants) {
      if (record.expiresAt <= now) this.gitPathGrants.delete(grant)
    }
  }

  private consumeGitPathGrant(
    plugin: RunningPlugin,
    grant: unknown,
    path: string,
    operation: GitPathGrantOperation,
  ): boolean {
    if (typeof grant !== 'string' || !grant) return false
    this.discardExpiredGitPathGrants()
    const record = this.gitPathGrants.get(grant)
    const binding = plugin.capabilityContext?.runtimeBinding
    const resolvedPath = resolvePathForContainment(path)
    if (
      !record ||
      !binding ||
      !resolvedPath ||
      record.instanceId !== plugin.instanceId ||
      record.workspacePath !== resolve(plugin.workspacePath ?? '') ||
      record.packageVersion !== binding.packageVersion ||
      record.path !== resolvedPath ||
      !record.operations.has(operation)
    ) return false
    this.gitPathGrants.delete(grant)
    return true
  }

  /** A clone grant authorizes exactly one new direct child of the Host-picked
   *  directory.  The plugin cannot turn a picked directory into an arbitrary
   *  containment root by supplying a nested or traversal target. */
  private consumeGitCloneTargetGrant(
    plugin: RunningPlugin,
    grant: unknown,
    targetDir: unknown,
  ): string | null {
    if (typeof grant !== 'string' || !grant || typeof targetDir !== 'string' || !targetDir) return null
    const requestedLeaf = basename(targetDir)
    if (
      requestedLeaf === '.' ||
      requestedLeaf === '..' ||
      requestedLeaf !== targetDir.split(/[\\/]/).at(-1) ||
      requestedLeaf.includes('\\')
    ) return null
    this.discardExpiredGitPathGrants()
    const record = this.gitPathGrants.get(grant)
    const binding = plugin.capabilityContext?.runtimeBinding
    const resolvedTarget = resolvePathForContainment(targetDir)
    if (
      !record ||
      !binding ||
      !resolvedTarget ||
      record.instanceId !== plugin.instanceId ||
      record.workspacePath !== resolve(plugin.workspacePath ?? '') ||
      record.packageVersion !== binding.packageVersion ||
      !record.operations.has('clone_target') ||
      dirname(resolvedTarget) !== record.path
    ) return null
    this.gitPathGrants.delete(grant)
    return resolvedTarget
  }

  private payloadClaimsInstance(payload: unknown): boolean {
    // `pluginId` remains a tolerated legacy envelope field and is ignored by
    // parseCapabilityCall. `instanceId` is new Host-owned identity and must
    // never be supplied by a plugin, even when its value is undefined.
    return (
      typeof payload === 'object' &&
      payload !== null &&
      Object.prototype.hasOwnProperty.call(payload, 'instanceId')
    )
  }

  private payloadClaimsInitiator(payload: unknown): boolean {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      Object.prototype.hasOwnProperty.call(payload, 'initiator')
    )
  }

  private workspaceBoundPayload(
    plugin: RunningPlugin,
    payload: unknown
  ): Record<string, unknown> | CapabilityResponse {
    if (!plugin.workspacePath) {
      return buildError('', 'WORKSPACE_SCOPE_VIOLATION', 'Git view is not bound to a workspace')
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return buildError('', 'BAD_REQUEST', 'Host action payload must be an object')
    }
    const record = payload as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(record, 'instanceId')) {
      return buildError('', 'BAD_REQUEST', 'instance identity is Host-owned')
    }
    if (this.payloadClaimsInitiator(record)) {
      return buildError('', 'BAD_REQUEST', 'initiator identity is Host-owned')
    }
    if (Object.prototype.hasOwnProperty.call(record, 'credential')) {
      return buildError('', 'BAD_REQUEST', 'credentials are Host-owned')
    }
    if (Object.prototype.hasOwnProperty.call(record, 'credential_owner_nonce')) {
      return buildError('', 'BAD_REQUEST', 'credential ownership is Host-owned')
    }
    // A Git repository nested inside the bound workspace is a legitimate
    // target: multi-repo mode gives every repository tab the repository's own
    // absolute path (MultiRepoGit). The binding is therefore a containment
    // root, not a single permitted value — anything outside it, and any
    // traversal out of it, is still rejected. The workspace itself keeps its
    // exact previous value so the common single-repo call is unchanged.
    const boundWorkspace = resolve(plugin.workspacePath)
    let targetWorkspace = boundWorkspace
    if (record.workspace_path !== undefined) {
      const candidate = typeof record.workspace_path === 'string' ? record.workspace_path : ''
      const resolvedCandidate = candidate && isWorkspaceContainedPath(plugin.workspacePath, candidate)
        ? resolvePathForContainment(resolve(plugin.workspacePath, candidate))
        : null
      if (!resolvedCandidate) {
        return buildError('', 'WORKSPACE_SCOPE_VIOLATION', 'workspace path does not match the Host binding')
      }
      targetWorkspace = resolve(candidate) === boundWorkspace ? boundWorkspace : resolvedCandidate
    }
    return { ...record, workspace_path: targetWorkspace }
  }

  /** Store the trusted main-renderer state consumed by the independent Git
   *  left contribution. The renderer is the source of pane/issue state; the
   *  plugin can only read a workspace-matched snapshot through the bridge. */
  setGitContributionState(hostWindow: BrowserWindow, state: GitContributionState): void {
    if (hostWindow.isDestroyed() || !nonEmptyString(state.workspacePath)) return
    if (
      !nonEmptyString(state.analyzerModel) && state.analyzerModel !== '' ||
      !Array.isArray(state.dispatchTargets) ||
      !Array.isArray(state.availableAgents) ||
      typeof state.issueHandoffs !== 'object' ||
      state.issueHandoffs === null ||
      Array.isArray(state.issueHandoffs)
    ) return
    const normalized: GitContributionState = {
      workspacePath: resolve(state.workspacePath),
      analyzerModel: state.analyzerModel,
      dispatchTargets: state.dispatchTargets
        .filter((item) => nonEmptyString(item?.id) && typeof item.label === 'string')
        .map((item) => ({ id: item.id, label: item.label })),
      availableAgents: state.availableAgents
        .filter((item) => nonEmptyString(item?.key) && typeof item.label === 'string')
        .map((item) => ({ key: item.key, label: item.label })),
      issueHandoffs: state.issueHandoffs,
    }
    this.gitContributionStates.set(hostWindow.id, normalized)
    for (const plugin of this.running.values()) {
      if (
        plugin.id === GIT_PLUGIN_ID &&
        plugin.hostWindow === hostWindow &&
        plugin.workspacePath &&
        resolve(plugin.workspacePath) === normalized.workspacePath &&
        plugin.capabilityContext?.runtimeBinding?.audience === 'git-left'
      ) {
        this.emitToInstance(plugin.instanceId, 'git.contribution.state', normalized)
      }
    }
  }

  clearGitContributionState(hostWindow: BrowserWindow): void {
    this.gitContributionStates.delete(hostWindow.id)
  }

  setGitAccountHandlers(handlers: GitAccountHandlers | null): void {
    this.gitAccountHandlers = handlers
  }

  private validateContributionPayload(
    operation: string,
    payload: unknown,
  ): boolean {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
    const record = payload as Record<string, unknown>
    const stringField = (key: string): boolean => typeof record[key] === 'string' && String(record[key]).length > 0
    if (operation === 'open_path') return stringField('path')
    if (operation === 'open_temp_file') {
      return stringField('name') && typeof record.content === 'string' &&
        record.content.length <= GIT_TEMP_FILE_MAX_CHARS
    }
    if (operation === 'pick_workspace') return record.default_path === undefined || typeof record.default_path === 'string'
    if (operation === 'open_main_window') return stringField('workspace_path')
    if (operation === 'open_branch_diff_window') return stringField('workspace_path') && stringField('base')
    if (operation === 'open_git_history_window') return stringField('workspace_path')
    if (operation === 'open_git_window') {
      return stringField('workspace_path') &&
        (record.filepath === undefined || typeof record.filepath === 'string') &&
        (record.staged === undefined || typeof record.staged === 'boolean') &&
        (record.commit === undefined || typeof record.commit === 'string') &&
        (record.base === undefined || typeof record.base === 'string') &&
        (record.compare === undefined || typeof record.compare === 'string')
    }
    if (operation === 'open_workspace') return stringField('path') && stringField('grant')
    if (operation === 'open_worktree') return stringField('path')
    if (operation === 'focus_pane') return stringField('paneId')
    if (operation === 'open_file' || operation === 'open_conflict') {
      return stringField('workspace_path') && stringField('filepath') && stringField('name')
    }
    if (operation === 'open_diff') {
      return stringField('workspace_path') && stringField('filepath') && stringField('name') && typeof record.staged === 'boolean'
    }
    if (operation === 'open_branch_diff') {
      return stringField('workspace_path') && stringField('base') && typeof record.compare === 'string'
    }
    if (operation === 'dispatch_issue') return stringField('paneId') && typeof record.issue === 'object' && record.issue !== null
    if (operation === 'spawn_for_issue') {
      return stringField('agentKey') && stringField('mode') &&
        typeof record.issue === 'object' && record.issue !== null &&
        typeof record.provider === 'string'
    }
    if (operation === 'changes_count') return typeof record.count === 'number' && Number.isInteger(record.count) && record.count >= 0
    if (operation === 'execute_host_command') {
      return typeof record.command === 'string' && GIT_HOST_COMMANDS.has(record.command)
    }
    return operation === 'open_git_accounts'
  }

  private async runGitContributionAction(
    reqId: string,
    args: Record<string, unknown>,
    plugin: RunningPlugin,
  ): Promise<CapabilityResponse> {
    const operation = typeof args.operation === 'string' ? args.operation : ''
    if (!GIT_CONTRIBUTION_OPERATIONS.has(operation)) {
      return buildError(reqId, 'METHOD_NOT_FOUND', 'Git contribution action is not mapped')
    }
    if (operation === 'get_state') {
      const state = this.gitContributionStates.get(plugin.hostWindow.id)
      if (!state || !plugin.workspacePath || state.workspacePath !== resolve(plugin.workspacePath)) {
        return buildSuccess(reqId, null)
      }
      return buildSuccess(reqId, state)
    }
    if (!this.validateContributionPayload(operation, args.payload)) {
      return buildError(reqId, 'BAD_REQUEST', 'Git contribution payload is invalid')
    }
    const audience = plugin.capabilityContext?.runtimeBinding?.audience
    const isWindowPickerAction = audience === 'git-window' &&
      (operation === 'pick_workspace' || operation === 'open_workspace' || operation === 'open_worktree')
    if (operation === 'open_worktree' && audience !== 'git-window') {
      return buildError(reqId, 'CAPABILITY_DENIED', 'worktree opening is only available to the Git window')
    }
    if (audience !== 'git-left' && !isWindowPickerAction) {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git contribution is only available to the left view')
    }
    const payload = args.payload as Record<string, unknown>
    const workspaceField = typeof payload.workspace_path === 'string'
      ? payload.workspace_path
      : operation === 'open_workspace' && typeof payload.path === 'string'
        ? payload.path
        : null
    // `open_workspace` is the one existing Git action whose target is chosen
    // through the Host-owned folder picker and may intentionally leave the
    // current workspace. All repository/file actions remain bound below.
    if (workspaceField !== null && operation !== 'open_workspace') {
      if (!plugin.workspacePath) return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git view is not workspace-bound')
      if (!isWorkspaceContainedPath(plugin.workspacePath, workspaceField)) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git contribution path is outside the Host binding')
      }
    }
    if (['open_file', 'open_conflict', 'open_diff', 'open_git_window'].includes(operation) &&
      typeof payload.filepath === 'string') {
      const fileWorkspace = workspaceField ?? plugin.workspacePath
      if (!fileWorkspace || !isWorkspaceContainedPath(fileWorkspace, payload.filepath)) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git contribution file is outside the Host binding')
      }
    }
    if (operation === 'open_path') {
      if (!plugin.workspacePath || !isAbsolute(String(payload.path)) ||
        !isWorkspaceContainedPath(plugin.workspacePath, String(payload.path))) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git path must be absolute inside the Host binding')
      }
    }
    if (operation === 'pick_workspace') {
      if (!this.hostShellHandlers) return buildError(reqId, 'BACKEND_ERROR', 'host shell handlers not registered')
      const picked = await this.hostShellHandlers.pickFolder(
        typeof payload.default_path === 'string' ? payload.default_path : undefined,
      )
      if (!picked) return buildSuccess(reqId, { path: null, grant: null })
      const grant = this.issueGitPathGrant(plugin, picked, ['clone_target', 'open_workspace'])
      if (!grant) return buildError(reqId, 'CAPABILITY_DENIED', 'Host picker path is unavailable')
      return buildSuccess(reqId, { path: resolvePathForContainment(picked), grant })
    }
    if (operation === 'open_workspace') {
      const path = String(payload.path)
      if (!this.consumeGitPathGrant(plugin, payload.grant, path, 'open_workspace')) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'workspace path lacks a valid Host picker grant')
      }
      const grantedPath = resolvePathForContainment(path)
      if (!grantedPath) return buildError(reqId, 'CAPABILITY_DENIED', 'workspace path lacks a valid Host picker grant')
      if (audience === 'git-window') {
        if (!this.hostShellHandlers) return buildError(reqId, 'BACKEND_ERROR', 'host shell handlers not registered')
        const opened = this.hostShellHandlers.openWorkspace(grantedPath)
        return opened.ok
          ? buildSuccess(reqId, { accepted: true })
          : buildError(reqId, 'BACKEND_ERROR', 'workspace could not be opened')
      }
      plugin.hostWindow.webContents.send('git:contribution-action', {
        operation,
        payload: { path: grantedPath },
      })
      return buildSuccess(reqId, { accepted: true })
    }
    if (operation === 'open_worktree') {
      if (!plugin.workspacePath) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git view is not workspace-bound')
      }
      if (!this.hostShellHandlers) {
        return buildError(reqId, 'BACKEND_ERROR', 'host shell handlers not registered')
      }
      const requestedPath = resolvePathForContainment(String(payload.path))
      if (!requestedPath || !isAbsolute(String(payload.path))) {
        return buildError(reqId, 'BAD_REQUEST', 'worktree path must be an existing absolute path')
      }
      const client = this.ensureBackend()
      if (!client) return buildError(reqId, 'BACKEND_ERROR', 'backend not connected')
      try {
        const response = await client.send<{ worktrees?: unknown }>('git.worktrees', {
          workspace_path: resolve(plugin.workspacePath),
        })
        if (!response.ok) {
          return buildError(reqId, 'BACKEND_ERROR', response.error?.message ?? 'worktrees lookup failed')
        }
        const worktrees = typeof response.payload === 'object' && response.payload !== null &&
          Array.isArray(response.payload.worktrees)
          ? response.payload.worktrees
          : []
        const authorized = worktrees.some((entry) => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
          const path = (entry as { path?: unknown }).path
          return typeof path === 'string' && resolvePathForContainment(path) === requestedPath
        })
        if (!authorized) {
          return buildError(reqId, 'CAPABILITY_DENIED', 'worktree path is not registered for this workspace')
        }
        const opened = this.hostShellHandlers.openWorkspace(requestedPath)
        return opened.ok
          ? buildSuccess(reqId, { accepted: true })
          : buildError(reqId, 'BACKEND_ERROR', 'workspace could not be opened')
      } catch (error) {
        return buildError(
          reqId,
          'BACKEND_ERROR',
          error instanceof Error ? error.message : 'worktrees lookup failed',
        )
      }
    }
    if (plugin.hostWindow.isDestroyed()) return buildError(reqId, 'CAPABILITY_DENIED', 'Git host window is closed')
    plugin.hostWindow.webContents.send('git:contribution-action', { operation, payload })
    return buildSuccess(reqId, { accepted: true })
  }

  private async runGitAccountOperation(
    reqId: string,
    operation: string,
    payload: Record<string, unknown>,
    plugin: RunningPlugin,
  ): Promise<CapabilityResponse> {
    const handlers = this.gitAccountHandlers
    if (!handlers || !GIT_ACCOUNT_OPERATIONS.has(operation)) {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git account service is unavailable')
    }
    try {
      if (operation === 'list') {
        if (Object.keys(payload).length > 0) {
          return buildError(reqId, 'BAD_REQUEST', 'Git account list takes no payload')
        }
        const accounts = handlers.list().map(({ id, label, host, username, tokenLast4 }) => ({
          id, label, host, username, tokenLast4,
        }))
        return buildSuccess(reqId, { available: handlers.available(), accounts })
      }
      if (!plugin.workspacePath) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git view is not workspace-bound')
      }
      const workspacePath = resolve(plugin.workspacePath)
      if (operation === 'get_binding') {
        if (Object.keys(payload).length > 0) {
          return buildError(reqId, 'BAD_REQUEST', 'Git account binding lookup takes no payload')
        }
        return buildSuccess(reqId, { accountId: handlers.getBinding(workspacePath) })
      }
      if (operation === 'add') {
        if (
          Object.keys(payload).some((key) => !['label', 'host', 'username', 'token'].includes(key)) ||
          !nonEmptyString(payload.label) ||
          !nonEmptyString(payload.host) ||
          !nonEmptyString(payload.username) ||
          !nonEmptyString(payload.token)
        ) {
          return buildError(reqId, 'BAD_REQUEST', 'Git account details are invalid')
        }
        const { id, label, host, username, tokenLast4 } = handlers.add({
          label: payload.label,
          host: payload.host,
          username: payload.username,
          token: payload.token,
        })
        return buildSuccess(reqId, { account: { id, label, host, username, tokenLast4 } })
      }
      if (operation === 'bind') {
        if (Object.keys(payload).some((key) => key !== 'accountId') || !nonEmptyString(payload.accountId)) {
          return buildError(reqId, 'BAD_REQUEST', 'Git account binding payload is invalid')
        }
        handlers.bind(workspacePath, payload.accountId)
        return buildSuccess(reqId, { accountId: payload.accountId })
      }
      if (Object.keys(payload).length > 0) {
        return buildError(reqId, 'BAD_REQUEST', 'Git account unbind takes no payload')
      }
      handlers.unbind(workspacePath)
      return buildSuccess(reqId, { accountId: null })
    } catch (error) {
      return buildError(reqId, 'BACKEND_ERROR', error instanceof Error ? error.message : 'Git account operation failed')
    }
  }

  private async runGitAccountAction(
    reqId: string,
    args: Record<string, unknown>,
    plugin: RunningPlugin,
  ): Promise<CapabilityResponse> {
    const audience = plugin.capabilityContext?.runtimeBinding?.audience
    if (audience !== 'git-left' && audience !== 'git-window') {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git account actions are unavailable to this view')
    }
    const rawPayload = args.payload
    const payload = typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
      ? rawPayload as Record<string, unknown>
      : {}
    return this.runGitAccountOperation(
      reqId,
      typeof args.operation === 'string' ? args.operation : '',
      payload,
      plugin,
    )
  }

  private async executeBoundGitRequest(
    plugin: RunningPlugin,
    reqId: string,
    action: string,
    type: string,
    wsPayload: Record<string, unknown>,
    timeoutMs = 10_000,
    beforeDispatch = (): boolean => true,
  ): Promise<CapabilityResponse> {
    let cloneTarget: string | null = null
    let credentialOwner: GitCredentialOwner | null = null
    let credentialReplyOwner: GitCredentialOwner | null = null
    if (action === 'fs.request' && GIT_HOST_FS_MUTATION_TYPES.has(type)) {
      const mutationPaths = type === 'fs.rename'
        ? [wsPayload.src_rel, wsPayload.dst_rel]
        : [wsPayload.rel_path]
      for (const candidate of mutationPaths) {
        const violation = workspaceMutationPathError(plugin.workspacePath ?? '', candidate)
        if (violation) return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', violation)
      }
    }
    if (action === 'fs.request' && type === 'fs.stat_path') {
      const candidate = typeof wsPayload.path === 'string' ? wsPayload.path : ''
      if (!plugin.workspacePath || !isWorkspaceContainedPath(plugin.workspacePath, candidate)) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'path is outside the Host workspace binding')
      }
      wsPayload.path = resolvePathForContainment(resolve(plugin.workspacePath, candidate))
    }
    if (!beforeDispatch()) {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
    }
    if (action === 'git.request' && GIT_REMOTE_REQUEST_TYPES.has(type)) {
      const workspacePath = plugin.workspacePath
      if (!workspacePath) {
        return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Git view is not bound to a workspace')
      }
      let credential: { username: string; token: string; expectedHost: string } | null = null
      if (this.gitAccountHandlers) {
        try {
          credential = this.gitAccountHandlers.getCredential(resolve(workspacePath))
        } catch (error) {
          return buildError(
            reqId,
            'BACKEND_ERROR',
            error instanceof Error ? error.message : 'Git credential lookup failed'
          )
        }
      }
      if (credential && type === 'git.clone') {
        let isHttps = false
        try {
          isHttps = typeof wsPayload.url === 'string' && new URL(wsPayload.url).protocol === 'https:'
        } catch {
          // Invalid and non-URL Git forms stay credential-free; the backend
          // owns clone URL validation and normal SSH authentication.
        }
        if (isHttps && !isExpectedHttpsRemote(wsPayload.url, credential.expectedHost)) {
          return buildError(reqId, 'CREDENTIAL_REQUIRED', 'No workspace-bound Git credential is available for this HTTPS remote')
        }
        if (!isHttps) credential = null
      }
      if (credential) {
        wsPayload.credential = credential
      } else {
        credentialOwner = this.issueGitCredentialOwner(plugin)
        if (!credentialOwner) {
          return buildError(reqId, 'CAPABILITY_DENIED', 'interactive Git credential owner is unavailable')
        }
        wsPayload.credential_owner_nonce = credentialOwner.nonce
      }
    }
    if (
      action === 'git.request' &&
      (type === 'git.credential_submit' || type === 'git.credential_cancel')
    ) {
      credentialReplyOwner = this.gitCredentialRequestOwner(plugin, wsPayload.request_id)
      if (!credentialReplyOwner) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'Git credential request is not owned by this view')
      }
      wsPayload.credential_owner_nonce = credentialReplyOwner.nonce
    }
    if (action === 'git.request' && type === 'git.clone') {
      cloneTarget = this.consumeGitCloneTargetGrant(plugin, wsPayload.target_grant, wsPayload.target_dir)
      if (!cloneTarget) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'clone target lacks a valid Host picker grant')
      }
      wsPayload.target_dir = cloneTarget
      delete wsPayload.target_grant
    }
    const client = this.ensureBackend()
    if (!client) {
      if (credentialOwner) this.releaseGitCredentialOwner(credentialOwner)
      return buildError(reqId, 'BACKEND_ERROR', 'backend not connected')
    }
    try {
      const response = backendResponseToCapability(reqId, await client.send(type, wsPayload, timeoutMs, { beforeDispatch }))
      if (
        type === 'git.clone' &&
        cloneTarget &&
        response.ok &&
        typeof response.result === 'object' &&
        response.result !== null &&
        typeof (response.result as { path?: unknown }).path === 'string' &&
        resolvePathForContainment((response.result as { path: string }).path) === cloneTarget
      ) {
        const grant = this.issueGitPathGrant(plugin, cloneTarget, ['open_workspace'])
        if (!grant) return buildError(reqId, 'CAPABILITY_DENIED', 'cloned workspace is unavailable')
        return buildSuccess(reqId, { ...response.result as Record<string, unknown>, openWorkspaceGrant: grant })
      }
      return response
    } catch (error) {
      return buildError(
        reqId,
        'BACKEND_ERROR',
        error instanceof Error ? error.message : 'backend request failed'
      )
    } finally {
      if (credentialOwner) this.releaseGitCredentialOwner(credentialOwner)
      if (credentialReplyOwner && nonEmptyString(wsPayload.request_id)) {
        credentialReplyOwner.requestIds.delete(wsPayload.request_id)
        if (this.gitCredentialRequests.get(wsPayload.request_id) === credentialReplyOwner) {
          this.gitCredentialRequests.delete(wsPayload.request_id)
        }
      }
    }
  }

  private isLegacyMiniIdeSettings(plugin: RunningPlugin, wsType: string): boolean {
    return Boolean(
      this.miniIdeLegacyPreferences &&
      plugin.id === MINI_IDE_PLUGIN_ID &&
      !plugin.hasV2DescriptorIdentity &&
      (wsType === 'ui.settings.get' || wsType === 'ui.settings.set')
    )
  }

  private async executeLegacyMiniIdeSettings(
    call: CapabilityCall,
    plugin: RunningPlugin,
    wsType: 'ui.settings.get' | 'ui.settings.set',
  ): Promise<CapabilityResponse> {
    const adapter = this.miniIdeLegacyPreferences
    if (!adapter) return buildError(call.reqId, 'BACKEND_UNAVAILABLE', 'mini-IDE preferences are unavailable')
    const client = this.ensureBackend()
    if (!client) return buildError(call.reqId, 'BACKEND_ERROR', 'backend not connected')
    try {
      if (wsType === 'ui.settings.get') {
        const response = await client.send(wsType, toPayload(call.args))
        if (!response.ok) return backendResponseToCapability(call.reqId, response)
        const payload = toPayload(response.payload)
        const settings = await adapter.read(toPayload(payload.settings))
        return backendResponseToCapability(call.reqId, {
          ...response,
          payload: { ...payload, settings },
        })
      }
      const args = toPayload(call.args)
      const updates = toPayload(args.updates)
      const remaining = await adapter.write(updates)
      if (Object.keys(remaining).length === 0) return buildSuccess(call.reqId, { ok: true })
      const response = await client.send(wsType, { ...args, updates: remaining })
      return backendResponseToCapability(call.reqId, response)
    } catch (error) {
      return buildError(
        call.reqId,
        'BACKEND_ERROR',
        error instanceof Error ? error.message : 'mini-IDE preferences failed',
      )
    }
  }

  /** Execute the fixed first-party bridge used by the production Git package.
   *  This is intentionally separate from the public Manifest v2 catalog: Git
   *  and Issues are Host-owned product services, not public permission
   *  namespaces. */
  private async runGitHostAction(
    reqId: string,
    action: string,
    args: Record<string, unknown>,
    plugin: RunningPlugin
  ): Promise<CapabilityResponse> {
    const binding = plugin.capabilityContext?.runtimeBinding
    const grant = plugin.capabilityContext?.userGrant
    const policy = plugin.capabilityPolicy
    const baseDenied =
      !plugin.hasV2DescriptorIdentity ||
      plugin.id !== GIT_PLUGIN_ID ||
      policy?.kind !== 'manifest-v2' ||
      !binding ||
      !grant ||
      grant.packageVersion !== binding.packageVersion ||
      binding.pluginId !== plugin.id ||
      binding.instanceId !== plugin.instanceId ||
      (plugin.workspacePath !== null &&
        binding.workspaceId !== this.workspaceIdForPath(plugin.workspacePath))
    if (baseDenied) {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
    }
    if (!grant || policy?.kind !== 'manifest-v2') {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
    }

    const hasSystemGrant = (namespace: 'fs' | 'ui'): boolean =>
      policy.system.includes(namespace) && grant.system.includes(namespace)
    const hasAllowlistShellGrant = (): boolean =>
      policy.shell === 'allowlist' && grant.shell === 'allowlist'

    if (GIT_PRIVATE_ACTIONS.has(action)) {
      if (!plugin.capabilityContext?.publisherEligible || !hasSystemGrant('ui')) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
      }
      if (action === 'git.contribution') return this.runGitContributionAction(reqId, args, plugin)
      if (action === 'git.account') return this.runGitAccountAction(reqId, args, plugin)
      if (plugin.capabilityContext?.runtimeBinding?.audience !== 'git-left' || !plugin.workspacePath) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'legacy Git selection is unavailable')
      }
      const client = this.ensureBackend()
      if (!client) return buildError(reqId, 'BACKEND_ERROR', 'backend not connected')
      try {
        const response = await client.send<{ project?: { ui_git_tab_repo?: unknown } | null }>(
          'project.peek',
          { workspace_path: resolve(plugin.workspacePath) },
        )
        if (!response.ok) {
          return buildError(reqId, 'BACKEND_ERROR', response.error?.message ?? 'legacy Git selection lookup failed')
        }
        const selection = response.payload?.project?.ui_git_tab_repo
        return buildSuccess(reqId, {
          selection: typeof selection === 'string' && selection ? selection : null,
        })
      } catch (error) {
        return buildError(
          reqId,
          'BACKEND_ERROR',
          error instanceof Error ? error.message : 'legacy Git selection lookup failed',
        )
      }
    }

    if (GIT_HOST_ACTIONS.has(action)) {
      if (!hasSystemGrant('fs')) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
      }
      if ((action === 'git.request' || action === 'issues.request') &&
        (!plugin.capabilityContext?.publisherEligible || !hasAllowlistShellGrant())) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
      }
      const type = typeof args.type === 'string' ? args.type : ''
      const rawPayload = args.payload
      const mapped =
        action === 'git.request'
          ? type.startsWith('git.') && resolveWsType('git', type.slice('git.'.length)) === type
          : action === 'issues.request'
            ? type.startsWith('issues.') && resolveWsType('issues', type.slice('issues.'.length)) === type
            : type.startsWith('fs.') && GIT_HOST_FS_TYPES.has(type)
      if (!mapped) return buildError(reqId, 'METHOD_NOT_FOUND', 'Git Host action is not mapped')
      const payload = this.workspaceBoundPayload(plugin, rawPayload)
      if ('ok' in payload && typeof payload.ok === 'boolean' && 'reqId' in payload) {
        return { ...payload, reqId } as CapabilityResponse
      }
      const wsPayload = payload as Record<string, unknown>
      // The Host deadline must not undercut the operation: a push/pull/clone (or
      // the credential prompt inside it) can outlive 10s, and expiring here
      // reports failure for work the backend may still complete.
      const timeoutMs = action === 'git.request'
        ? gitRequestTimeoutMs(type.slice('git.'.length))
        : action === 'issues.request' ? 30_000 : undefined
      return this.executeBoundGitRequest(plugin, reqId, action, type, wsPayload, timeoutMs)
    }

    if (action === 'ui.request') {
      if (!plugin.capabilityContext?.publisherEligible || !hasSystemGrant('ui')) {
        return buildError(reqId, 'CAPABILITY_DENIED', 'Git Host action is not available')
      }
      const type = typeof args.type === 'string' ? args.type : ''
      if (!GIT_HOST_UI_ACTIONS.has(type)) {
        return buildError(reqId, 'METHOD_NOT_FOUND', 'Git UI Host action is not mapped')
      }
      // A Git plugin may open a workspace only by consuming the opaque grant
      // on the private contribution bridge. Never turn an arbitrary renderer
      // path into another workspace root through the generic UI adapter.
      if (type === 'ui.open_workspace') {
        return buildError(reqId, 'CAPABILITY_DENIED', 'workspace paths require a Host picker grant')
      }
      const rawPayload = args.payload
      if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
        return buildError(reqId, 'BAD_REQUEST', 'Git UI payload must be an object')
      }
      if (Object.prototype.hasOwnProperty.call(rawPayload, 'instanceId')) {
        return buildError(reqId, 'BAD_REQUEST', 'instance identity is Host-owned')
      }
      if (this.payloadClaimsInitiator(rawPayload)) {
        return buildError(reqId, 'BAD_REQUEST', 'initiator identity is Host-owned')
      }
      const call: CapabilityCall = {
        pluginId: plugin.id,
        ns: 'ui',
        method: type.slice('ui.'.length),
        args: rawPayload,
        reqId,
      }
      return this.runHostAction(call, plugin)
    }

    return buildError(reqId, 'METHOD_NOT_FOUND', 'Git Host action is not mapped')
  }

  private async handleHostCall(
    senderId: number,
    payload: unknown,
    senderFrame: WebFrameMain | null = null,
    admittedPlugin?: RunningPlugin,
  ): Promise<CapabilityResponse> {
    const plugin = admittedPlugin ?? this.instanceForIpc(senderId, senderFrame)
    if (!plugin) return buildError('', 'BAD_REQUEST', 'unknown plugin sender')
    if (this.isPluginStopping(plugin)) {
      return buildError('', 'PLUGIN_STOPPING', 'plugin runtime is stopping')
    }
    if (this.payloadClaimsInstance(payload)) {
      return buildError('', 'BAD_REQUEST', 'instance identity is Host-owned')
    }
    if (this.payloadClaimsInitiator(payload)) {
      return buildError('', 'BAD_REQUEST', 'initiator identity is Host-owned')
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return buildError('', 'BAD_REQUEST', 'malformed Host action call')
    }
    const record = payload as Record<string, unknown>
    const reqId = typeof record.reqId === 'string' ? record.reqId : ''
    const action = typeof record.action === 'string' ? record.action : ''
    const args = record.args
    if (!reqId || !action || typeof args !== 'object' || args === null || Array.isArray(args)) {
      return buildError(reqId, 'BAD_REQUEST', 'malformed Host action call')
    }
    if (action === 'plans.shell') return this.runPlansShellAction(reqId, args as Record<string, unknown>, plugin)
    return this.runGitHostAction(reqId, action, args as Record<string, unknown>, plugin)
  }

  /** Private direct-user adapter for retained Plans shell actions. Like the
   * v1 IPC, this is not an Agent/MCP method or a public capability namespace. */
  private async runPlansShellAction(reqId: string, args: Record<string, unknown>, plugin: RunningPlugin): Promise<CapabilityResponse> {
    const context = plugin.capabilityContext
    const binding = context?.runtimeBinding
    const policy = plugin.capabilityPolicy
    const currentGrant = binding ? this.capabilityGrantResolver?.(PLANS_PLUGIN_ID, binding.packageVersion) : null
    const required = args.operation === 'dispatch_execution' ? ['fs', 'ui', 'aiCli'] as const : ['fs', 'ui'] as const
    if (!plugin.hasV2DescriptorIdentity || plugin.id !== PLANS_PLUGIN_ID || !plugin.workspacePath ||
      !context?.publisherEligible || !binding || binding.pluginId !== PLANS_PLUGIN_ID ||
      binding.instanceId !== plugin.instanceId || binding.workspaceId !== this.workspaceIdForPath(plugin.workspacePath) ||
      !binding.audience || !['plans-window', 'plans-left'].includes(binding.audience) || policy.kind !== 'manifest-v2' ||
      !currentGrant || currentGrant.storage !== true || currentGrant.packageVersion !== binding.packageVersion ||
      !context.userGrant || context.userGrant.packageVersion !== binding.packageVersion ||
      required.some((permission) => !policy.system.includes(permission) || !currentGrant.system.includes(permission) || !context.userGrant?.system.includes(permission))) {
      return buildError(reqId, 'CAPABILITY_DENIED', 'Plans shell action is unavailable')
    }
    const operation = args.operation
    if (operation !== 'open_path' && operation !== 'dispatch_execution') {
      return buildError(reqId, 'METHOD_NOT_FOUND', 'Plans shell action is not mapped')
    }
    const allowedKeys = operation === 'open_path' ? ['operation', 'rel_path'] : ['operation', 'rel_path', 'agent_key']
    if (Object.keys(args).some((key) => !allowedKeys.includes(key)) || !nonEmptyString(args.rel_path)) {
      return buildError(reqId, 'BAD_REQUEST', 'Plans shell payload is invalid')
    }
    const root = resolvePlansRootPath(plugin.workspacePath)
    if (!isAllowedPlanDocumentPath(args.rel_path, root)) {
      return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Plans shell path is outside the Plans directories')
    }
    if (!this.plansShellHandlers) return buildError(reqId, 'BACKEND_ERROR', 'Plans shell handlers are unavailable')
    try {
      if (operation === 'open_path') {
        return buildSuccess(reqId, await this.plansShellHandlers.openPath(resolve(root, args.rel_path)))
      }
      if (!nonEmptyString(args.agent_key) || !Object.hasOwn(AI_CLI_PROFILES, args.agent_key)) {
        return buildError(reqId, 'BAD_REQUEST', 'Plans execution agent is invalid')
      }
      return buildSuccess(reqId, this.plansShellHandlers.dispatchExecution({
        workspace_path: plugin.workspacePath, rel_path: args.rel_path, agent_key: args.agent_key,
      }))
    } catch {
      return buildError(reqId, 'BACKEND_ERROR', 'Plans shell action failed')
    }
  }

  private exactBackendPayload(
    payload: unknown,
    allowed: ReadonlySet<string>,
  ): Record<string, unknown> | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.some((key) => BACKEND_IDENTITY_KEYS.has(key) || !allowed.has(key))) return null
    return record
  }

  private backendError(reqId: string, error: unknown): CapabilityResponse {
    if (!(error instanceof BackendPluginError)) {
      return buildError(reqId, 'BACKEND_ERROR', 'Backend plugin request failed.')
    }
    switch (error.code) {
      case 'INVALID_ARGUMENT':
        return buildError(reqId, 'INVALID_ARGUMENT', 'Backend call arguments are invalid.')
      case 'CAPABILITY_DENIED':
        return buildError(reqId, 'CAPABILITY_DENIED', 'Backend capability is denied.')
      case 'RESOURCE_LIMIT':
        return buildError(reqId, 'RESOURCE_LIMIT', 'Backend resource limit reached.')
      case 'RESULT_TOO_LARGE':
        return buildError(reqId, 'RESOURCE_LIMIT', 'Backend result exceeds the allowed size.')
      case 'TIMEOUT':
        return buildError(reqId, 'TIMEOUT', 'Backend plugin call timed out.')
      case 'USER_CANCELLED':
        return buildError(reqId, 'USER_CANCELLED', 'Backend plugin call was cancelled.')
      case 'PLUGIN_STOPPING':
        return buildError(reqId, 'PLUGIN_STOPPING', 'Backend plugin is stopping.')
      case 'PLUGIN_ERROR':
        if (error.pluginCode === 'CAPABILITY_DENIED') {
          return buildError(reqId, 'CAPABILITY_DENIED', 'Backend capability is denied.')
        }
        if (error.pluginCode === 'WORKSPACE_SCOPE_VIOLATION') {
          return buildError(reqId, 'WORKSPACE_SCOPE_VIOLATION', 'Workspace scope is unavailable.')
        }
        if (error.pluginCode === 'INVALID_ARGUMENT') {
          return buildError(reqId, 'INVALID_ARGUMENT', 'Backend call arguments are invalid.')
        }
        if (error.pluginCode === 'RESOURCE_LIMIT') {
          return buildError(reqId, 'RESOURCE_LIMIT', 'Backend resource limit reached.')
        }
        return buildError(reqId, 'BACKEND_ERROR', 'Plugin request failed.')
      default:
        return buildError(reqId, 'BACKEND_UNAVAILABLE', 'Backend plugin is unavailable.')
    }
  }

  /** Keep the package-local Plans resolver inside its sender-bound workspace.
   *  The child receives the renderer's path as an operation argument, but the
   *  authorization decision compares its canonical hash with the Host-bound
   *  workspace id before any child dispatch occurs. */
  private backendCallScopeError(
    plugin: RunningPlugin,
    reqId: string,
    name: unknown,
    args: unknown,
  ): CapabilityResponse | null {
    if (plugin.id !== PLANS_PLUGIN_ID || name !== 'plans.resolve_root') return null
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return buildError(reqId, 'INVALID_ARGUMENT', 'Plans backend arguments are invalid.')
    }
    const workspacePath = (args as Record<string, unknown>).workspace_path
    if (!nonEmptyString(workspacePath)) {
      return buildError(reqId, 'INVALID_ARGUMENT', 'Plans workspace path is invalid.')
    }
    const boundWorkspaceId = plugin.backendWorkspaceId
    if (!boundWorkspaceId) return null
    const requestedWorkspaceId = this.workspaceIdForPath(workspacePath)
    if (requestedWorkspaceId !== boundWorkspaceId) {
      return buildError(
        reqId,
        'WORKSPACE_SCOPE_VIOLATION',
        'Plans backend workspace is outside the bound workspace.',
      )
    }
    return null
  }

  private cancelBackendRecord(instanceId: string, id: string): void {
    const calls = this.pendingBackendCalls.get(instanceId)
    const call = calls?.get(id)
    if (call) {
      calls!.delete(id)
      if (calls!.size === 0) this.pendingBackendCalls.delete(instanceId)
      call.abort()
      return
    }
    const subscriptions = this.pendingBackendSubscriptions.get(instanceId)
    const pending = subscriptions?.get(id)
    if (!pending) return
    pending.cancelled = true
    pending.unregister?.()
  }

  /** Register the broker IPC handlers exactly once. Safe to call repeatedly. */
  registerIpc(): void {
    if (this.ipcReady) return
    this.ipcReady = true

    const handleCapabilityCall = async (
      plugin: RunningPlugin | undefined,
      payload: unknown,
    ): Promise<CapabilityResponse> => {
      if (!plugin) {
        // Not a known plugin view — refuse without leaking anything.
        return buildError('', 'BAD_REQUEST', 'unknown plugin sender')
      }
      if (this.isPluginStopping(plugin)) {
        return undispatched(buildError('', 'PLUGIN_STOPPING', 'plugin runtime is stopping'))
      }
      const pluginId = plugin.id
      const reqId =
        typeof payload === 'object' && payload && 'reqId' in payload
          ? String((payload as Record<string, unknown>).reqId ?? '')
          : ''
      if (this.payloadClaimsInstance(payload)) {
        return undispatched(buildError(reqId, 'BAD_REQUEST', 'instance identity is Host-owned'))
      }
      if (this.payloadClaimsInitiator(payload)) {
        return undispatched(buildError(reqId, 'BAD_REQUEST', 'initiator identity is Host-owned'))
      }
      const call = parseCapabilityCall(payload, pluginId)
      if (!call) {
        return undispatched(buildError(reqId, 'BAD_REQUEST', 'malformed capability call'))
      }
      if (call.ns === 'ui' && call.method === 'resolveDetailClose') {
        return this.resolveDetailClose(plugin, call.reqId, call.args)
      }
      if (call.ns === 'ui' && call.method === 'resolveDetailTarget') {
        return this.resolveDetailTarget(plugin, call.reqId, call.args)
      }
      if (call.ns === 'ui' && call.method === 'openDetail') {
        return this.openDetail(plugin, call.reqId, call.args)
      }
      if (this.plansStorageReadinessHandler) {
        const storageAdmission = await this.plansInstanceStorageAdmission(plugin, reqId)
        if (storageAdmission) return undispatched(storageAdmission)
      }

      // Enforce scoping + route. A denied namespace is rejected here and never
      // reaches the backend; `ping`/unknown resolve in-process.
      let plan: ReturnType<typeof planCapabilityCall>
      try {
        plan = planCapabilityCall(
          call,
          plugin.capabilityPolicy,
          this.capabilityContextForInitiator(plugin, HOST_USER_INITIATOR) ?? undefined
        )
      } catch {
        return undispatched(buildError(call.reqId, 'INVALID_ARGUMENT', 'invalid capability request'))
      }
      if (plan.kind === 'respond') return plan.response

      if (plan.kind === 'public') {
        if (plan.storage) {
          const storageKey = typeof call.args === 'object' && call.args !== null
            ? (call.args as Record<string, unknown>).key
            : null
          const storageScope = typeof call.args === 'object' && call.args !== null
            ? (call.args as Record<string, unknown>).scope
            : null
          if (
            plugin.hasV2DescriptorIdentity &&
            plugin.id === GIT_PLUGIN_ID &&
            (
              typeof storageKey !== 'string' ||
              !(
                (storageScope === 'plugin' && GIT_USER_PREFERENCE_KEYS.includes(storageKey as typeof GIT_USER_PREFERENCE_KEYS[number])) ||
                (storageScope === 'workspace' && storageKey === GIT_WORKSPACE_REPOSITORY_KEY && plugin.workspacePath)
              )
            )
          ) {
            return buildError(call.reqId, 'CAPABILITY_DENIED', 'Git storage key is not owned by the plugin')
          }
          const handler = this.publicStorageHandler
          if (!handler || !isStorageExecutionAddress(plan.address)) {
            return undispatched(buildError(
              call.reqId,
              'BACKEND_UNAVAILABLE',
              'storage capability broker is not connected'
            ))
          }
          try {
            const result = await handler({
              address: plan.address,
              args: plan.args,
              partition: plan.storage.partition,
              snapshot: plan.storage.snapshot,
              ...(plan.initiator ? { initiator: plan.initiator } : {}),
            })
            if (
              (plan.address === 'storage.set' || plan.address === 'storage.delete') &&
              (storageScope === 'plugin' || storageScope === 'workspace') &&
              typeof storageKey === 'string'
            ) {
              const value = plan.address === 'storage.delete'
                ? null
                : (call.args as Record<string, unknown>).value
              if (isJsonValue(value)) {
                this.dispatchPluginStorageChanged(
                  plan,
                  storageScope,
                  storageKey,
                  value,
                  plan.address === 'storage.delete',
                )
              }
            }
            if (
              plugin.hasV2DescriptorIdentity &&
              plugin.id === GIT_PLUGIN_ID &&
              (storageScope === 'plugin' || storageScope === 'workspace') &&
              typeof storageKey === 'string'
            ) {
              const settingsEvent = {
                source: 'plugin-storage' as const,
                scope: storageScope,
                settings: {
                  [storageKey]: plan.address === 'storage.delete'
                    ? null
                    : (call.args as Record<string, unknown>).value,
                },
                ...(storageScope === 'workspace' ? { workspace_path: plugin.workspacePath } : {}),
              }
              this.dispatchEvent('ui.settings_changed', {
                ...settingsEvent,
              })
            }
            return buildSuccess(
              call.reqId,
              result
            )
          } catch (error) {
            if (error instanceof PluginStorageError) {
              const code =
                error.code === 'STORAGE_QUOTA_EXCEEDED' || error.code === 'INVALID_ARGUMENT'
                  ? error.code
                  : 'INTERNAL_ERROR'
              return buildError(call.reqId, code, error.message)
            }
            return buildError(call.reqId, 'INTERNAL_ERROR', 'storage capability failed')
          }
        }
        const handler = this.publicCapabilityHandler
        if (!handler) {
          return buildError(
            call.reqId,
            'BACKEND_UNAVAILABLE',
            'public capability broker is not connected'
          )
        }
        try {
          return buildSuccess(call.reqId, await handler(plan))
        } catch (error) {
          if (error instanceof WebViewError) return webViewCapabilityError(call.reqId, error)
          // The Plugin keeps the fixed opaque message (it must not learn Host
          // paths or internals); the Host console keeps the cause.
          console.error(`[plugins] public capability '${plan.address}' failed:`, error)
          return buildError(call.reqId, 'INTERNAL_ERROR', 'public capability failed')
        }
      }

      // Host-implemented capability (ui.open_in_editor): main services it
      // directly — no backend round-trip.
      if (plan.kind === 'host') {
        return this.runHostAction(call, plugin)
      }

      if (
        (plan.wsType === 'ui.settings.get' || plan.wsType === 'ui.settings.set') &&
        this.isLegacyMiniIdeSettings(plugin, plan.wsType)
      ) {
        return this.executeLegacyMiniIdeSettings(call, plugin, plan.wsType)
      }

      let wsPayload =
        plan.wsType === 'terminal.reattach'
          ? this.filterTerminalReattachPayload(plugin.instanceId, toPayload(call.args))
          : toPayload(call.args)
      if (plan.wsType === 'terminal.create') {
        const generation = nonEmptyString(wsPayload.create_generation)
          ? wsPayload.create_generation
          : randomUUID()
        wsPayload = { ...wsPayload, create_generation: generation }
      }
      if (
        this.requiresTerminalOwnership(plan.wsType) &&
        !this.ownsTerminalSession(plugin, wsPayload)
      ) {
        return buildError(
          call.reqId,
          'CAPABILITY_DENIED',
          'terminal session is not owned by this view'
        )
      }
      const client = this.ensureBackend()
      if (!client) {
        return buildError(call.reqId, 'BACKEND_ERROR', 'backend not connected')
      }
      const pendingOperation = this.beginTerminalOperation(plugin, plan.wsType, client, wsPayload)
      try {
        // A reattach request may not claim PTY sessions bound to a DIFFERENT
        // plugin — strip those ids before the backend re-targets their output.
        const resp = await client.send(plan.wsType, wsPayload)
        // A successful terminal.create/reattach binds the PTY to this plugin so
        // its output/exit events are routed to this view only.
        const canCommit = resp.ok && this.canCommitTerminalOperation(pendingOperation)
        if (canCommit) {
          this.noteTerminalRoutes(plugin.instanceId, plan.wsType, resp.payload)
        } else if (resp.ok && pendingOperation?.wsType === 'terminal.create') {
          // The backend sends the create response immediately before marking
          // its transaction committed. If teardown won that race, clean up
          // only the PTY named by this operation's correlated response.
          this.cleanupCancelledTerminalCreate(pendingOperation, resp.payload)
        }
        return backendResponseToCapability(call.reqId, resp)
      } catch (err) {
        return buildError(
          call.reqId,
          'BACKEND_ERROR',
          err instanceof Error ? err.message : 'backend request failed'
        )
      } finally {
        if (pendingOperation) this.pendingTerminalOperations.delete(pendingOperation.operationId)
      }
    }
    this.capabilityCallHandler = async (
      plugin: RunningPlugin | undefined,
      payload: unknown,
    ): Promise<CapabilityResponse> => {
      const response = await handleCapabilityCall(plugin, payload)
      this.recordCapabilityActivity(plugin, payload, response)
      return response
    }
    ipcMain.handle(IPC_CALL, (event, payload: unknown): Promise<CapabilityResponse> =>
      this.capabilityCallHandler!(this.instanceForIpc(event.sender.id, event.senderFrame), payload)
    )

    // Fixed first-party Git bridge. This does not expose a public `git` or
    // `issues` permission; sender and workspace binding are resolved by the
    // Host before the request reaches the backend.
    ipcMain.handle(IPC_HOST_CALL, async (event, payload: unknown): Promise<CapabilityResponse> =>
      this.handleHostCall(event.sender.id, payload, event.senderFrame)
    )

    // The provider child owns its nonce and is the only party that can invoke
    // this handler. It never supplies a binding id or Host receiver identity.
    ipcMain.handle(IPC_RECEIVER_REGISTER, (event, payload: unknown): { receiverId: string } => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const declaration = receiver ? this.declaredReceiver(receiver, payload) : null
      if (!receiver || !declaration) throw new Error('receiver declaration is unavailable')
      this.revokeReceiverFrames(receiver.instanceId)
      const receiverId = randomUUID()
      this.receiverRegistrations.set(receiverId, {
        id: receiverId,
        receiverInstanceId: receiver.instanceId,
        documentGeneration: receiver.documentGeneration,
        declaration,
        offers: new Map(),
      })
      return { receiverId }
    })

    ipcMain.handle(IPC_RECEIVER_RESOLVE_CLOSE, (event, payload: unknown): void => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      if (!receiver) throw new Error('receiver close acknowledgement is unavailable')
      this.resolveReceiverClose(receiver, payload)
    })

    ipcMain.handle(IPC_RECEIVER_RESOLVE_EDITOR_TARGET, (event, payload: unknown): void => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const receiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
      const correlation = typeof record?.correlation === 'string' ? record.correlation : ''
      const result = typeof record?.result === 'object' && record.result !== null && !Array.isArray(record.result)
        ? record.result as Record<string, unknown>
        : null
      const opened = result?.opened
      const pending = this.pendingEditorTargets.get(correlation)
      if (!receiver || !pending || !result || Object.keys(record ?? {}).some((key) =>
        key !== 'receiverId' && key !== 'correlation' && key !== 'result'
      ) || Object.keys(result).some((key) => key !== 'opened') || typeof opened !== 'boolean' ||
        receiverId !== pending.receiverId || this.currentReceiverRegistration(receiverId, receiver) === undefined ||
        !this.currentPendingEditorTarget(pending)) {
        throw new Error('receiver editor target acknowledgement is unavailable')
      }
      this.settlePendingEditorTarget(correlation, opened)
    })

    ipcMain.handle(IPC_RECEIVER_LIST_LEFT, (event, payload: unknown): Array<{ contributionKey: string; title: string }> => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const receiverId = typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
        Object.keys(payload as Record<string, unknown>).length === 1 &&
        typeof (payload as Record<string, unknown>).receiverId === 'string'
        ? (payload as Record<string, unknown>).receiverId as string
        : ''
      const registration = receiver ? this.currentReceiverRegistration(receiverId, receiver) : undefined
      const workspacePath = receiver?.workspacePath
      const descriptor = receiver ? this.descriptors.get(receiver.id) : undefined
      const receiverView = descriptor?.views?.find((view) => view.contributionKey === receiver?.contributionKey)
      if (!receiver || !registration || !workspacePath || !descriptor || !receiverView ||
        !registration.declaration.locations.includes('left') ||
        !this.contributionCapabilityContext(descriptor, receiverView, workspacePath)) {
        console.warn('[plugins] receiver left catalog refused: the receiver registration or its capability context is not current')
        throw new Error('receiver left catalog is unavailable')
      }
      const catalogued = this.listContributionCatalog().flatMap((entry) => {
        if (entry.location !== 'left') return []
        const provider = this.descriptors.get(entry.pluginId)
        const view = provider?.views?.find((candidate) => candidate.contributionKey === entry.contributionKey)
        if (!provider || !view || this.descriptors.get(provider.id) !== provider ||
          !provider.views?.includes(view) || this.isPackageVersionStopping(provider.id, provider.packageVersion) ||
          !this.contributionCapabilityContext(provider, view, workspacePath)) {
          console.warn(
            `[plugins] receiver left catalog skips '${entry.contributionKey}': ` +
            `${!provider ? 'no descriptor' :
              !view ? 'no view' :
                this.descriptors.get(provider.id) !== provider ? 'descriptor changed' :
                  !provider.views?.includes(view) ? 'view not current' :
                    this.isPackageVersionStopping(provider.id, provider.packageVersion) ? 'package stopping' :
                      'capability context unavailable'}`,
          )
          return []
        }
        // Display metadata only: the receiver learns what to paint, never which
        // plugin provides the view.
        const icon = entry.iconFile && this.contributionIconResolver
          ? this.contributionIconResolver(entry.iconFile)
          : null
        return [{
          contributionKey: entry.contributionKey,
          title: entry.title,
          icon: icon?.url ?? null,
          iconMonochrome: icon?.monochrome ?? false,
        }]
      })
      console.warn(`[plugins] receiver left catalog: ${catalogued.length} contribution(s) offered`)
      return catalogued
    })

    ipcMain.handle(IPC_RECEIVER_OPEN_LEFT, (event, payload: unknown): { offered: true } => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const receiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
      const contributionKey = typeof record?.contributionKey === 'string' ? record.contributionKey : ''
      const registration = receiver ? this.currentReceiverRegistration(receiverId, receiver) : undefined
      const workspacePath = receiver?.workspacePath
      if (!receiver || !registration || !workspacePath ||
        Object.keys(record ?? {}).some((key) => key !== 'receiverId' && key !== 'contributionKey')) {
        throw new Error('receiver left contribution is unavailable')
      }
      const entry = this.listContributionCatalog().find((candidate) =>
        candidate.location === 'left' && candidate.contributionKey === contributionKey
      )
      const descriptor = entry ? this.descriptors.get(entry.pluginId) : undefined
      const view = descriptor?.views?.find((candidate) => candidate.contributionKey === contributionKey)
      if (!descriptor || !view) {
        console.warn(`[plugins] receiver left contribution '${contributionKey}' is not in the catalog`)
        throw new Error('receiver left contribution is unavailable')
      }
      const offer = this.offerReceiverProvider(receiverId, descriptor, view, workspacePath)
      if (!offer.ok) {
        console.warn(
          `[plugins] receiver left contribution '${contributionKey}' was refused (${offer.reason})`,
        )
        throw new Error(`receiver left contribution is unavailable: ${offer.reason}`)
      }
      return { offered: true }
    })

    ipcMain.handle(IPC_RECEIVER_MOUNT, async (event, payload: unknown): Promise<{ itemId: string }> => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const receiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
      const offerId = typeof record?.offerId === 'string' ? record.offerId : ''
      const placement = record?.placement
      const mountHostId =
        typeof placement === 'object' && placement !== null && !Array.isArray(placement) &&
        Object.keys(placement as Record<string, unknown>).length === 1 &&
        nonEmptyString((placement as Record<string, unknown>).mountHostId)
          ? (placement as Record<string, unknown>).mountHostId as string
          : ''
      const registration = receiver ? this.currentReceiverRegistration(receiverId, receiver) : undefined
      if (!receiver || !registration || !mountHostId) {
        throw new Error('receiver mount is unavailable')
      }
      const offer = registration.offers.get(offerId)
      if (!offer ||
        this.isPackageVersionStopping(offer.descriptor.id, offer.descriptor.packageVersion) ||
        this.descriptors.get(offer.descriptor.id) !== offer.descriptor ||
        !offer.descriptor.views?.includes(offer.view) ||
        !registration.declaration.locations.includes(offer.location) ||
        !this.contributionCapabilityContext(offer.descriptor, offer.view, offer.workspacePath)) {
        throw new Error('receiver offer is unavailable')
      }
      const opening = offer.openId === undefined ? undefined : this.pendingDetailOpens.get(offer.openId)
      if (offer.openId !== undefined && (!opening || !this.currentPendingDetailOpen(opening))) {
        registration.offers.delete(offerId)
        throw new Error('receiver offer is unavailable')
      }
      registration.offers.delete(offerId)
      const reserved = await this.reservePluginFrameContribution(
        receiver.hostWindow,
        offer.view.contributionKey,
        offer.workspacePath,
        receiver,
      )
      if (!reserved.ok) {
        console.warn(`[plugins] receiver mount refused: ${reserved.error}`)
        if (opening) this.settlePendingDetailOpen(
          opening.id,
          buildSuccess(opening.reqId, { opened: false, reason: 'provider-unavailable' }),
        )
        throw new Error(reserved.error)
      }
      if (!this.currentReceiverRegistration(receiverId, receiver)) {
        if (opening) this.settlePendingDetailOpen(
          opening.id,
          buildSuccess(opening.reqId, { opened: false, reason: 'receiver-unavailable' }),
        )
        this.closePluginFrame(reserved.bindingId)
        throw new Error('receiver mount is unavailable')
      }
      const pending = this.pendingPluginFrames.get(reserved.bindingId)
      if (!pending) {
        if (opening) this.settlePendingDetailOpen(
          opening.id,
          buildSuccess(opening.reqId, { opened: false, reason: 'provider-unavailable' }),
        )
        this.closePluginFrame(reserved.bindingId)
        throw new Error('receiver mount is unavailable')
      }
      const itemId = randomUUID()
      this.receiverItems.set(itemId, {
        id: itemId,
        receiverId,
        bindingId: reserved.bindingId,
        offer,
        nextDetailTargetRevision: offer.detailTarget === undefined ? 1 : offer.detailTarget.revision + 1,
        ...(offer.detailTarget === undefined ? {} : { detailTarget: offer.detailTarget }),
      })
      if (opening) {
        opening.itemId = itemId
        if (!this.currentPendingDetailOpen(opening)) {
          this.settlePendingDetailOpen(
            opening.id,
            buildSuccess(opening.reqId, { opened: false, reason: 'provider-unavailable' }),
            true,
          )
          throw new Error('receiver detail offer is unavailable')
        }
      }
      if (offer.location === 'left' && offer.view.detailView) {
        const pairing = this.pairDetailSource(pending.instanceId, receiverId)
        if (!pairing.ok) {
          this.closePluginFrame(reserved.bindingId)
          console.warn(
            `[plugins] receiver mount refused: provider detail pairing failed for ` +
            `'${offer.view.contributionKey}' (${pairing.reason})`,
          )
          throw new Error(`receiver detail pairing is unavailable: ${pairing.reason}`)
        }
      }
      if (offer.detailSourceInstanceId) {
        const pair = this.detailPairs.get(offer.detailSourceInstanceId)
        if (!pair || pair.receiverId !== receiverId || offer.detailTarget === undefined || !this.currentDetailPair(pair)) {
          if (opening) this.settlePendingDetailOpen(
            opening.id,
            buildSuccess(opening.reqId, { opened: false, reason: 'provider-unavailable' }),
            true,
          )
          this.closePluginFrame(reserved.bindingId)
          throw new Error('receiver detail offer is unavailable')
        }
      }
      return { itemId }
    })

    ipcMain.handle(IPC_RECEIVER_ACCEPT_EXISTING, async (
      event,
      payload: unknown,
    ): Promise<{ accepted: true; itemId: string } | { accepted: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }> => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const receiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
      const offerId = typeof record?.offerId === 'string' ? record.offerId : ''
      const itemId = typeof record?.itemId === 'string' ? record.itemId : ''
      const registration = receiver ? this.currentReceiverRegistration(receiverId, receiver) : undefined
      if (!receiver || !registration || !record ||
        Object.keys(record).some((key) => key !== 'receiverId' && key !== 'offerId' && key !== 'itemId')) {
        throw new Error('receiver existing detail acceptance is unavailable')
      }
      const offer = registration.offers.get(offerId)
      if (!offer || offer.location !== 'detail' || !offer.detailTarget ||
        !registration.declaration.locations.includes('detail')) {
        return { accepted: false, reason: 'unavailable' }
      }
      const opening = offer.openId === undefined ? undefined : this.pendingDetailOpens.get(offer.openId)
      if (offer.openId !== undefined && (!opening || !this.currentPendingDetailOpen(opening))) {
        registration.offers.delete(offerId)
        return { accepted: false, reason: 'unavailable' }
      }
      // A current receiver can make exactly one authorized decision per offer.
      // Refusal, busy, timeout, or teardown never creates a fallback mount.
      registration.offers.delete(offerId)
      const item = this.receiverItems.get(itemId)
      const previousTarget = item?.appliedDetailTarget
      if (!item || item.receiverId !== receiverId || !previousTarget ||
        previousTarget.resourceKey !== offer.detailTarget.resourceKey) {
        if (opening) this.settlePendingDetailOpen(
          opening.id,
          buildSuccess(opening.reqId, { opened: false, reason: 'receiver-unavailable' }),
        )
        return { accepted: false, reason: 'unavailable' }
      }
      if (this.detailCloseLocks.has(item.id)) {
        if (opening) this.settlePendingDetailOpen(
          opening.id,
          buildSuccess(opening.reqId, { opened: false, reason: 'provider-unavailable' }),
        )
        return { accepted: false, reason: 'busy' }
      }
      if (opening) {
        opening.itemId = itemId
        if (!this.currentPendingDetailOpen(opening)) {
          this.settlePendingDetailOpen(
            opening.id,
            buildSuccess(opening.reqId, { opened: false, reason: 'receiver-unavailable' }),
          )
          return { accepted: false, reason: 'unavailable' }
        }
      }
      const target: DetailTargetState = {
        targetId: randomUUID(),
        revision: item.nextDetailTargetRevision,
        resourceKey: offer.detailTarget.resourceKey,
        target: offer.detailTarget.target,
      }
      item.nextDetailTargetRevision += 1
      const decision = await this.dispatchDetailTarget(item, target, previousTarget, offer.openId)
      if (!decision.applied && opening && this.pendingDetailOpens.has(opening.id)) {
        this.settlePendingDetailOpen(
          opening.id,
          buildSuccess(opening.reqId, { opened: false, reason: 'provider-unavailable' }),
        )
      }
      return decision.applied
        ? { accepted: true, itemId }
        : { accepted: false, reason: decision.reason }
    })

    ipcMain.handle(IPC_RECEIVER_DISPOSE, (event, payload: unknown): void => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const receiverId = typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
        typeof (payload as Record<string, unknown>).receiverId === 'string'
        ? (payload as Record<string, unknown>).receiverId as string
        : ''
      if (!receiver || !this.currentReceiverRegistration(receiverId, receiver)) return
      this.revokeReceiverRegistration(receiverId)
    })

    ipcMain.handle(IPC_RECEIVER_ABORT, (event, payload: unknown): void => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const receiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
      const itemId = typeof record?.itemId === 'string' ? record.itemId : ''
      const registration = receiver ? this.currentReceiverRegistration(receiverId, receiver) : undefined
      const item = this.receiverItems.get(itemId)
      // Abort is intentionally idempotent. A stale/replaced receiver cannot
      // close an item, and a second abort observes the already-removed item.
      if (!registration || !item || item.receiverId !== receiverId) return
      const transactionId = this.detailCloseLocks.get(itemId)
      if (transactionId) this.failDetailCloseTransaction(transactionId, 'unavailable')
      this.closePluginFrame(item.bindingId)
    })

    ipcMain.handle(IPC_RECEIVER_REQUEST_CLOSE_TRANSACTION, (
      event,
      payload: unknown,
    ): Promise<DetailCloseResult> => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const receiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
      const itemIds = Array.isArray(record?.itemIds) ? record.itemIds : null
      if (!receiver || !record || Object.keys(record).some((key) => key !== 'receiverId' && key !== 'itemIds') ||
        !itemIds || itemIds.some((itemId) => typeof itemId !== 'string')) {
        return Promise.resolve({ closed: false, reason: 'unavailable' })
      }
      return this.requestDetailCloseTransaction(receiver, receiverId, itemIds)
    })

    // Preserve the existing one-item result shape through the transaction path.
    ipcMain.handle(IPC_RECEIVER_REQUEST_CLOSE, (event, payload: unknown): Promise<DetailCloseResult> => {
      const receiver = this.instanceForIpc(event.sender.id, event.senderFrame)
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const receiverId = typeof record?.receiverId === 'string' ? record.receiverId : ''
      const itemId = typeof record?.itemId === 'string' ? record.itemId : ''
      if (!receiver || !record || Object.keys(record).some((key) => key !== 'receiverId' && key !== 'itemId')) {
        return Promise.resolve({ closed: false, reason: 'unavailable' })
      }
      return this.requestDetailCloseTransaction(receiver, receiverId, [itemId])
    })

    ipcMain.handle(IPC_RECEIVER_BLANK_READY, (event, payload: unknown): { locator: string } => {
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const itemId = typeof record?.itemId === 'string' ? record.itemId : ''
      const frameToken = typeof record?.frameToken === 'string' ? record.frameToken : ''
      const item = this.receiverItems.get(itemId)
      const registration = item ? this.receiverRegistrations.get(item.receiverId) : undefined
      const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
      const receiverFrame = event.senderFrame
      const frame = receiverFrame
        ? webFrameMain.fromFrameToken(receiverFrame.processId, frameToken)
        : null
      if (!item || !registration || !receiver || !receiverFrame || !frame ||
        receiver.documentGeneration !== registration.documentGeneration ||
        event.sender.id !== receiver.view.webContents.id ||
        receiverFrame !== receiver.view.webContents.mainFrame ||
        frame.parent !== receiver.view.webContents.mainFrame ||
        frame.frameToken !== frameToken || frame.url !== 'about:blank') {
        throw new Error('receiver blank is unavailable')
      }
      if (!this.bindPluginFrameBlank(item.bindingId, frame)) {
        this.closePluginFrame(item.bindingId)
        throw new Error('receiver blank is unavailable')
      }
      const pending = this.pendingPluginFrames.get(item.bindingId)
      if (!pending) throw new Error('receiver blank is unavailable')
      // The trusted receiver preload assigns this locator only after this
      // exact frame-token recheck. Main must never navigate the frame itself.
      return { locator: pending.entryUrl }
    })

    ipcMain.handle(IPC_FRAME_DOCUMENT_READY, (event, payload: unknown): boolean => {
      const nonce =
        typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
        Object.keys(payload as Record<string, unknown>).length === 1 &&
        nonEmptyString((payload as Record<string, unknown>).nonce)
          ? (payload as Record<string, unknown>).nonce as string
          : null
      if (!nonce || !event.senderFrame) return false
      return this.admitPluginFrameDocument(event.senderFrame, event.sender.id, nonce)
    })

    this.backendCallHandler = async (
      plugin: RunningPlugin | undefined,
      payload: unknown,
    ): Promise<CapabilityResponse> => {
      const record = this.exactBackendPayload(
        payload,
        new Set(['reqId', 'name', 'args', 'timeoutMs']),
      )
      const reqId =
        typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
        typeof (payload as Record<string, unknown>).reqId === 'string'
          ? (payload as Record<string, unknown>).reqId as string
          : ''
      if (!plugin) return buildError(reqId, 'BAD_REQUEST', 'unknown plugin sender')
      if (this.isPluginStopping(plugin)) {
        return buildError(reqId, 'PLUGIN_STOPPING', 'plugin runtime is stopping')
      }
      if (
        !record ||
        !nonEmptyString(record.reqId) ||
        !nonEmptyString(record.name) ||
        !Object.prototype.hasOwnProperty.call(record, 'args')
      ) {
        return buildError(reqId, 'BAD_REQUEST', 'malformed backend call')
      }
      if (record.timeoutMs !== undefined && !isAllowedBackendTimeout(record.timeoutMs)) {
        return buildError(reqId, 'INVALID_ARGUMENT', 'backend timeout is invalid')
      }
      const scopeError = this.backendCallScopeError(
        plugin,
        record.reqId,
        record.name,
        record.args,
      )
      if (scopeError) return scopeError
      const calls = this.pendingBackendCalls.get(plugin.instanceId) ?? new Map<string, AbortController>()
      if (calls.has(record.reqId)) {
        return buildError(record.reqId, 'BAD_REQUEST', 'backend request id is already pending')
      }
      if (
        plugin.id === PLANS_PLUGIN_ID &&
        plugin.hasV2DescriptorIdentity &&
        plugin.capabilityPolicy.kind === 'manifest-v2' &&
        !this.isPlansBackendAvailable()
      ) {
        return buildError(record.reqId, 'BACKEND_UNAVAILABLE', 'Plans agent backend is unavailable')
      }
      this.pendingBackendCalls.set(plugin.instanceId, calls)
      const controller = new AbortController()
      calls.set(record.reqId, controller)
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      let abortListener: (() => void) | undefined
      let remainingTimeout = record.timeoutMs as number | undefined
      try {
        if (
          plugin.id === PLANS_PLUGIN_ID &&
          plugin.hasV2DescriptorIdentity &&
          plugin.capabilityPolicy.kind === 'manifest-v2' &&
          (record.name === 'plans.create' || this.plansStorageReadinessHandler)
        ) {
          const timeoutMs = remainingTimeout ?? 30_000
          const deadline = Date.now() + timeoutMs
          const cancelled = new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(new BackendPluginError(
              controller.signal.reason === 'timeout' ? 'TIMEOUT' : 'USER_CANCELLED',
            ))
            controller.signal.addEventListener('abort', abortListener, { once: true })
          })
          timeoutTimer = setTimeout(() => controller.abort('timeout'), timeoutMs)
          const admission = await Promise.race([
            (async () => {
              if (this.plansStorageReadinessHandler) {
                const storageAdmission = await this.plansInstanceStorageAdmission(plugin, reqId)
                if (storageAdmission) return storageAdmission
              }
              if (controller.signal.aborted) throw new BackendPluginError('USER_CANCELLED')
              if (record.name === 'plans.create' && !(await this.provisionPlansAssets(plugin.workspacePath ?? ''))) {
                return buildError(reqId, 'BACKEND_UNAVAILABLE', 'Plans assets are unavailable')
              }
              return null
            })(),
            cancelled,
          ])
          clearTimeout(timeoutTimer)
          remainingTimeout = deadline - Date.now()
          if (remainingTimeout <= 0) throw new BackendPluginError('TIMEOUT')
          if (admission) return admission
        }
        if (controller.signal.aborted) throw new BackendPluginError('USER_CANCELLED')
        const result = await this.pluginBackendHost.call(
          plugin.instanceId,
          record.name,
          record.args as JsonValue,
          { signal: controller.signal, ...(remainingTimeout === undefined ? {} : { timeoutMs: remainingTimeout }) },
        )
        return buildSuccess(record.reqId, result)
      } catch (error) {
        if (plugin.id === PLANS_PLUGIN_ID && this.plansCallFailureWithdraws(plugin, record.name, error)) {
          this.markPlansBackendUnavailable('child-unavailable')
        }
        const response = this.backendError(record.reqId, error)
        if (plugin.id === PLANS_PLUGIN_ID && response.error?.code === 'CAPABILITY_DENIED') {
          warnMain(`[plugin-backend] ${PLANS_PLUGIN_ID} ${record.name} denied for ${plugin.instanceId}`)
        }
        return response
      } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
        if (abortListener) controller.signal.removeEventListener('abort', abortListener)
        if (calls.get(record.reqId) === controller) calls.delete(record.reqId)
        if (calls.size === 0 && this.pendingBackendCalls.get(plugin.instanceId) === calls) {
          this.pendingBackendCalls.delete(plugin.instanceId)
        }
      }
    }
    ipcMain.handle(IPC_BACKEND_CALL, (event, payload: unknown): Promise<CapabilityResponse> =>
      this.backendCallHandler!(this.instanceForIpc(event.sender.id, event.senderFrame), payload)
    )

    ipcMain.on(IPC_BACKEND_CANCEL, (event, payload: unknown) => {
      const plugin = this.instanceForIpc(event.sender.id, event.senderFrame)
      if (!plugin) return
      const record = this.exactBackendPayload(payload, new Set(['reqId', 'subscriptionId']))
      if (!record) return
      const keys = Object.keys(record)
      if (keys.length !== 1) return
      const id = keys[0] === 'reqId' ? record.reqId : record.subscriptionId
      if (!nonEmptyString(id)) return
      this.cancelBackendRecord(plugin.instanceId, id)
    })

    this.backendSubscribeHandler = async (
      plugin: RunningPlugin | undefined,
      payload: unknown,
    ): Promise<CapabilityResponse> => {
      const record = this.exactBackendPayload(payload, new Set(['subscriptionId', 'event']))
      const subscriptionId =
        typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
        typeof (payload as Record<string, unknown>).subscriptionId === 'string'
          ? (payload as Record<string, unknown>).subscriptionId as string
          : ''
      if (
        !plugin ||
        !record ||
        Object.keys(record).length !== 2 ||
        !nonEmptyString(record.subscriptionId) ||
        !nonEmptyString(record.event)
      ) return buildError(subscriptionId, 'BAD_REQUEST', 'malformed backend subscription')
      if (this.isPluginStopping(plugin)) {
        return buildError(subscriptionId, 'PLUGIN_STOPPING', 'plugin runtime is stopping')
      }
      const eventName = record.event as string
      const subscriptions = this.pendingBackendSubscriptions.get(plugin.instanceId) ??
        new Map<string, PendingBackendSubscription>()
      if (subscriptions.has(subscriptionId)) {
        return buildError(subscriptionId, 'BAD_REQUEST', 'backend subscription id is already pending')
      }
      this.pendingBackendSubscriptions.set(plugin.instanceId, subscriptions)
      const pending: PendingBackendSubscription = {
        controller: new AbortController(),
        subscription: null,
        unregister: null,
        cancelled: false,
      }
      subscriptions.set(subscriptionId, pending)
      const dispose = (): void => {
        if (subscriptions.get(subscriptionId) !== pending) return
        subscriptions.delete(subscriptionId)
        if (subscriptions.size === 0) this.pendingBackendSubscriptions.delete(plugin.instanceId)
        pending.cancelled = true
        pending.controller.abort()
        pending.subscription?.dispose('cancelled')
        pending.subscription = null
      }
      pending.unregister = this.registerInstanceSubscription(plugin.instanceId, dispose)
      let subscription: BackendPluginSubscription | null = null
      try {
        subscription = await this.pluginBackendHost.subscribe(
          plugin.instanceId,
          eventName,
          (eventPayload) => {
            const current = this.running.get(plugin.instanceId)
            if (
              pending.cancelled ||
              current !== plugin ||
              current.view.webContents.isDestroyed()
            ) return
            if (!this.sendToPlugin(current, IPC_BACKEND_EVENT, {
              subscriptionId,
              event: eventName,
              payload: eventPayload,
            }) && current.carrier === 'frame') {
              // A revoked/stale generation cannot retain backend work after its
              // private receiver is gone; finish the normal instance cleanup.
              this.destroyInstance(current.instanceId)
            }
          },
          { signal: pending.controller.signal },
        )
        if (pending.cancelled || subscriptions.get(subscriptionId) !== pending) {
          subscription.dispose('cancelled')
          return buildError(subscriptionId, 'USER_CANCELLED', 'Backend plugin subscription was cancelled.')
        }
        pending.subscription = subscription
        void subscription.settled.then((result) => {
          if (
            pending.cancelled ||
            subscriptions.get(subscriptionId) !== pending
          ) return
          if (result.reason !== 'cancelled' && result.reason !== 'view-destroyed') {
            const response = result.error
              ? this.backendError(subscriptionId, result.error)
              : buildError(subscriptionId, 'BACKEND_UNAVAILABLE', 'Backend plugin subscription ended.')
            const current = this.running.get(plugin.instanceId)
            if (
              current === plugin &&
              !current.view.webContents.isDestroyed()
            ) {
              if (!this.sendToPlugin(current, IPC_BACKEND_STATUS, {
                subscriptionId,
                ok: false,
                error: response.error,
              }) && current.carrier === 'frame') {
                this.destroyInstance(current.instanceId)
              }
            }
          }
          pending.unregister?.()
        })
        await subscription.acknowledged
        if (pending.cancelled || subscriptions.get(subscriptionId) !== pending) {
          return buildError(subscriptionId, 'USER_CANCELLED', 'Backend plugin subscription was cancelled.')
        }
        return buildSuccess(subscriptionId, null)
      } catch (error) {
        pending.unregister?.()
        return this.backendError(subscriptionId, error)
      }
    }
    ipcMain.handle(IPC_BACKEND_SUBSCRIBE, (event, payload: unknown): Promise<CapabilityResponse> =>
      this.backendSubscribeHandler!(this.instanceForIpc(event.sender.id, event.senderFrame), payload)
    )

    // Fire-and-forget capability channel (nav.castCapability) — see handleCast.
    ipcMain.on(IPC_CAST, (event, payload: unknown) => {
      this.handleCast(event.sender.id, payload, event.senderFrame)
    })

    // Plugins announce readiness; it is only logged (activation is not gated on it).
    ipcMain.on(IPC_READY, (event) => {
      const plugin = this.instanceForIpc(event.sender.id, event.senderFrame)
      if (plugin) this.markPluginReady(plugin)
    })

    // A plugin dismisses its own view (e.g. the mini-IDE's Esc-close). Scoped
    // to the sender: only the view a webContents belongs to can be hidden by it.
    // A view hosted in a dedicated plugin window closes that window instead
    // (legacy editor Esc behavior; the `closed` hook runs the normal teardown);
    // main-window-hosted views keep the plain view-hide.
    ipcMain.on(IPC_HIDE_SELF, (event) => {
      const plugin = this.instanceForIpc(event.sender.id, event.senderFrame)
      if (!plugin) return
      this.hidePlugin(plugin)
    })
  }

  /**
   * Main tells the manager the backend WS url on every backend transition
   * (ready / restart with a new port / stop / crash). A live client is
   * re-pointed at the new url; a stopped/errored backend puts it into fail-fast
   * so brokered calls reject instead of queueing forever.
   */
  setBackendWsUrl(url: string | null): void {
    if (this.backendWsUrl !== url) this.editorAiCapability.closeAll()
    this.backendWsUrl = url
    const client = this.wsClient
    if (url) {
      if (!client) {
        // Connect eagerly if a running plugin already needs the backend, so
        // server-push events (git.changed) flow without waiting for the first
        // capability call. Otherwise ensureBackend() connects lazily later.
        if (this.anyPluginNeedsBackend()) this.ensureBackend()
        return
      }
      if (client.isHealthyFor(url)) {
        if (this.backendHostToken && !this.hostSessionRegistered) {
          this.registerHostSession(client)
        }
        return
      }
      this.hostRegistrationTask = null
      this.hostSessionRegistered = false
      client.reset('backend changed')
      client.connect(url)
    } else if (client) {
      this.hostRegistrationTask = null
      this.hostSessionRegistered = false
      client.reset('backend stopped')
      client.markErrored()
      // reset()/markErrored() deliberately emit no status transition, so tell
      // the plugins ourselves — their views outlive a backend stop/restart.
      this.dispatchBackendStatus('disconnected')
    }
  }

  /** Rebuild the backend transport after the machine wakes. Not expressible as
   *  setBackendWsUrl: the url has not changed, so it would short-circuit on
   *  isHealthyFor — which reports healthy for a socket whose TCP connection
   *  died during sleep. No-op when no plugin has needed the backend yet;
   *  ensureBackend() still connects lazily on the first call. */
  reconnectAfterResume(): void {
    this.editorAiCapability.closeAll()
    this.wsClient?.reconnectNow('system resumed')
  }

  /** Main-registered handler for the `ui.open_in_editor` host capability
   *  (index.ts wires it to the default-editor router, which sends the file to
   *  the mini-IDE, the OS default app, or the user's external editor). */
  private openInEditorHandler:
    | ((params: Record<string, string>) => boolean | Promise<boolean>)
    | null = null

  /** Main-owned navigation adapter for the first-party Plans left surface. */
  private openPlansWindowHandler:
    | ((workspacePath: string, relPath: string) => boolean | Promise<boolean>)
    | null = null

  setOpenInEditorHandler(fn: (params: Record<string, string>) => boolean | Promise<boolean>): void {
    this.openInEditorHandler = fn
  }

  setOpenPlansWindowHandler(
    fn: ((workspacePath: string, relPath: string) => boolean | Promise<boolean>) | null,
  ): void {
    this.openPlansWindowHandler = fn
  }

  /** Install the Host-owned execution adapter for an already-authorized v2
   * plan. The adapter receives no raw shell, PTY, executable, or transport
   * handle from the Plugin. */
  setPublicCapabilityHandler(
    fn: ((plan: PublicCapabilityExecutionPlan) => unknown | Promise<unknown>) | null
  ): void {
    this.publicCapabilityHandler = fn
  }

  setEditorNativeHandlers(host: EditorNativeHost | null): void {
    this.editorNativeCapability = host
      ? new EditorNativeCapability(this.editorSelectionGrants, host)
      : null
  }

  setFilePickerHost(host: FilePickerHost | null): void {
    this.filePickerHost = host
  }

  notifyEditorKeybindingsChanged(content: string): void {
    for (const plugin of this.running.values()) {
      const binding = plugin.capabilityContext?.runtimeBinding
      if (binding && this.isPublicEventAllowedForInstance(plugin, 'ui.keybindingsChanged', { content }, binding)) {
        this.emitToInstance(plugin.instanceId, 'ui.keybindingsChanged', { content })
      }
    }
  }

  /** Connect the production Plans child to the existing Host filesystem
   * service. The default Backend Host bridge remains fail-closed for tests and
   * for callers that have not completed application wiring. */
  configurePlansFilesystemService(filesystemPort?: PlansFilesystemPort): void {
    this.pluginBackendHost.setBridgeDispatcher(
      createProductionPlansBridgeDispatcher({
        filesystem: filesystemPort ?? this.plansFilesystemPort(),
        web: {
          dispatch: async (operation, arguments_, context) => {
            if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
            if (!this.webBridgeGrantAllows(context)) {
              throw new PlansBridgeError('CAPABILITY_DENIED', 'Web capability is denied.')
            }
            return dispatchWebBridge(this.pluginWebViews(), context.runtime.pluginId, operation, arguments_)
          },
        },
      }),
    )
  }

  /** The `web` Bridge port serves a first-party backend that carries the port
   *  and whose user Grant for the bound package version includes `web`. The
   *  supervisor has already checked the approved ports and an agent's
   *  Execution Policy; the plugin id is the authenticated binding's. */
  private webBridgeGrantAllows(context: PlansBridgeContext): boolean {
    const runtime = context.runtime
    if (!firstPartyBridgePorts(runtime.pluginId)?.includes('web') || !nonEmptyString(runtime.packageVersion)) {
      return false
    }
    const grant = this.capabilityGrantResolver?.(runtime.pluginId, runtime.packageVersion) ?? null
    return Boolean(grant && grant.packageVersion === runtime.packageVersion && grant.system.includes('web'))
  }

  /** The Plans child reads and writes its plan files itself and asks for the
   * root before each request, so resolve_root runs the same Grant and agent
   * Execution Policy checks as every filesystem service operation. */
  private plansFilesystemPort(): PlansFilesystemPort {
    const port = createHostPlansFilesystemPort({
      call: (operation, payload, context) =>
        this.sendPlansFilesystemService(operation, payload, context),
    })
    return {
      ...port,
      resolveRoot: async (arguments_, context) => {
        if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
        if (!this.plansBridgeCanDispatch(context)) {
          this.warnPlansFilesystemDenied('resolve_root', context)
          throw new PlansBridgeError('CAPABILITY_DENIED', 'Filesystem capability is denied.')
        }
        return port.resolveRoot(arguments_, context)
      },
      // The watcher is a local Host primitive, not a filesystem service call,
      // so it gets the same Grant and agent Execution Policy check here.
      watch: async (arguments_, context) => {
        if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
        if (!this.plansBridgeCanDispatch(context)) {
          this.warnPlansFilesystemDenied('watch', context)
          throw new PlansBridgeError('CAPABILITY_DENIED', 'Filesystem capability is denied.')
        }
        return port.watch(arguments_, context)
      },
    }
  }

  /** Provision the canonical Plans assets before a package child can create a
   *  document. This Host-only call keeps template selection out of the child;
   *  a missing template is an availability failure, never a reason to invent
   *  a second document format. */
  private async provisionPlansAssets(workspacePath: string): Promise<boolean> {
    if (!nonEmptyString(workspacePath)) return false
    try {
      const payload = await this.sendPublicBackend(
        'plans.ensure_assets',
        { workspace_path: resolve(workspacePath) },
      )
      return (
        typeof payload === 'object' &&
        payload !== null &&
        !Array.isArray(payload) &&
        (payload as Record<string, unknown>).ok === true
      )
    } catch {
      return false
    }
  }

  /** Execute a cataloged public plan for the Host. The plan is already
   *  authorized by the broker; this method still resolves the exact live
   *  instance so a stale plan cannot borrow a sibling workspace or PTY. */
  async executePublicCapability(plan: PublicCapabilityExecutionPlan): Promise<unknown> {
    const instanceId = plan.runtime.instanceId
    const plugin = instanceId ? this.running.get(instanceId) : undefined
    if (!plugin || plugin.id !== plan.runtime.pluginId) {
      throw new Error('public capability instance is no longer active')
    }
    if (this.isPluginStopping(plugin)) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    if (!sameRuntimeBinding(plugin.capabilityContext?.runtimeBinding, plan.runtime)) {
      throw new Error('public capability runtime binding is stale')
    }
    const workspacePath = plugin.workspacePath
    if (plan.scope === 'workspace' && !workspacePath) {
      throw new Error('public capability workspace binding is missing')
    }
    if (!this.publicPlanPolicyAllows(plan, plugin)) {
      throw new Error('agent execution policy denied the operation')
    }

    const accountOperation = Object.hasOwn(GIT_ACCOUNT_PUBLIC_METHODS, plan.address)
      ? GIT_ACCOUNT_PUBLIC_METHODS[plan.address as keyof typeof GIT_ACCOUNT_PUBLIC_METHODS]
      : undefined
    if (accountOperation) {
      if (!workspacePath) throw new Error('Git account capability workspace binding is missing')
      if (!this.publicPlanCanDispatch(plan, plugin)) {
        throw new Error('agent execution policy denied the operation')
      }
      const response = await this.runGitAccountOperation(
        randomUUID(),
        accountOperation,
        plan.args,
        plugin,
      )
      if (!response.ok) throw new Error(response.error?.message ?? 'Git account request failed')
      return response.result
    }

    if ((PUBLIC_ISSUE_METHODS as readonly string[]).includes(plan.address)) {
      if (!workspacePath) throw new Error('Issue capability workspace binding is missing')
      if (!this.publicPlanCanDispatch(plan, plugin)) {
        throw new Error('agent execution policy denied the operation')
      }
      const request = issueRequest(plan.address, plan.args, workspacePath)
      const currentPolicy = this.currentAgentExecutionPolicy(plugin, plan.initiator)
      if (plan.initiator?.kind === 'agent' && !currentPolicy) {
        throw new Error('agent execution policy is unavailable')
      }
      const allowedCommands = plan.initiator?.kind === 'agent'
        ? HOST_SHELL_EXECUTABLE_ALLOWLIST.filter((command) =>
            executionPolicyAllows(plan.initiator, currentPolicy!, 'shell', command))
        : [...HOST_SHELL_EXECUTABLE_ALLOWLIST]
      const beforeDispatch = (): boolean => {
        if (!this.publicPlanCanDispatch(plan, plugin)) return false
        if (plan.initiator?.kind !== 'agent') return true
        const latestPolicy = this.currentAgentExecutionPolicy(plugin, plan.initiator)
        return latestPolicy?.revision === currentPolicy!.revision
      }
      return await this.sendPublicBackend(
        'issues.public',
        {
          ...request,
          execution_policy: { mode: 'allowlist', shell: allowedCommands },
        },
        beforeDispatch,
        35_000,
      )
    }

    if ((EDITOR_PREFERENCE_METHODS as readonly string[]).includes(plan.address)) {
      if (!workspacePath) throw new Error('Editor preference capability workspace binding is missing')
      if (!this.publicPlanCanDispatch(plan, plugin)) {
        throw new Error('agent execution policy denied the operation')
      }
      const beforeDispatch = (): boolean => this.publicPlanCanDispatch(plan, plugin)
      if (plan.address === 'ui.readEditorPreferences') {
        const response = await this.sendPublicBackend(
          'ui.settings.get',
          {},
          beforeDispatch,
        )
        const settings =
          typeof response === 'object' && response !== null && !Array.isArray(response)
            ? (response as Record<string, unknown>).settings
            : undefined
        return { preferences: projectEditorPreferences(settings) }
      }

      const key = typeof plan.args.key === 'string' ? plan.args.key : ''
      await this.sendPublicBackend(
        'ui.settings.set',
        { updates: { [key]: plan.args.value } },
        beforeDispatch,
      )
      return { ok: true }
    }

    if ((PUBLIC_GIT_METHODS as readonly string[]).includes(plan.address)) {
      if (!workspacePath) throw new Error('Git capability workspace binding is missing')
      if (!this.publicPlanCanDispatch(plan, plugin)) {
        throw new Error('agent execution policy denied the operation')
      }
      const request = publicGitRequest(plan.address, plan.args, workspacePath)
      if (request.operation === 'clone') {
        const binding = plugin.capabilityContext?.runtimeBinding
        if (!binding || !binding.instanceId || !binding.workspaceId || !binding.packageVersion) {
          throw new Error('public capability runtime binding is missing')
        }
        const owner = {
          instanceId: binding.instanceId,
          workspaceId: binding.workspaceId,
          packageVersion: binding.packageVersion,
        }
        const target = this.editorSelectionGrants.resolve(owner, plan.args.selectionGrant, 'directory')
        const canonicalTarget = resolvePathForContainment(resolve(String(request.payload.target_dir)))
        if (!canonicalTarget || canonicalTarget !== target) {
          throw new Error('clone target does not match the selected directory')
        }
        const targetGrant = this.issueGitPathGrant(plugin, target, ['clone_target'])
        if (!targetGrant) throw new Error('clone target grant is unavailable')
        request.payload.target_grant = targetGrant
      }
      const response = await this.executeBoundGitRequest(
        plugin,
        randomUUID(),
        'git.request',
        request.type,
        request.payload,
        request.timeoutMs,
        () => this.publicPlanCanDispatch(plan, plugin),
      )
      if (!response.ok) throw new Error(response.error?.message ?? 'Git request failed')
      return response.result
    }

    if (plan.address === 'ui.openFilePicker') {
      const host = this.filePickerHost
      const binding = plugin.capabilityContext?.runtimeBinding
      if (!host || !binding || !workspacePath) {
        throw new Error('file picker capability is not connected')
      }
      const sessionId = typeof plan.args.sessionId === 'string' ? plan.args.sessionId : undefined
      if (sessionId) {
        const sessionBinding = plugin.capabilityContext?.sessionBindings?.get(sessionId)
        if (!sessionBinding || !sameRuntimeBinding(sessionBinding, binding)) {
          throw new Error('file picker session is no longer owned by this view')
        }
      }
      const canDispatch = (): boolean => {
        if (!this.publicPlanCanDispatch(plan, plugin)) return false
        if (!sessionId) return true
        const sessionBinding = plugin.capabilityContext?.sessionBindings?.get(sessionId)
        return Boolean(sessionBinding && sameRuntimeBinding(sessionBinding, binding))
      }
      if (!canDispatch()) throw new Error('file picker capability is denied')
      const sourceBounds = (): PluginBounds => {
        if (plugin.view.nativeView) return plugin.view.nativeView.getBounds()
        if (!plugin.hostWindow.isDestroyed()) return plugin.hostWindow.getContentBounds()
        return { x: 0, y: 0, width: 0, height: 0 }
      }
      return host.open({
        instanceId: plugin.instanceId,
        ...(sessionId ? { sessionId } : {}),
        sender: plugin.view.webContents,
        hostWindow: plugin.hostWindow,
        workspacePath,
        sourceBounds,
        request: plan.args as unknown as FilePickerInvocation['request'],
        canDispatch,
        search: async (query: string): Promise<string[]> => {
          if (!canDispatch()) throw new Error('file picker capability is denied')
          const response = await this.sendPublicBackend(
            'fs.list_files_flat',
            { workspace_path: workspacePath, query, max_results: 20 },
            canDispatch,
          )
          if (!canDispatch()) throw new Error('file picker capability is denied')
          const files = toPayload(response).files
          return Array.isArray(files)
            ? files.filter((file): file is string => typeof file === 'string')
            : []
        },
      })
    }

    if ((EDITOR_NATIVE_METHODS as readonly string[]).includes(plan.address)) {
      if (!this.editorNativeCapability) throw new Error('editor native capability is not connected')
      const binding = plugin.capabilityContext?.runtimeBinding
      if (!binding || !binding.instanceId || !binding.workspaceId || !binding.packageVersion) {
        throw new Error('public capability runtime binding is missing')
      }
      return this.editorNativeCapability.execute(plan.address, plan.args, {
        instanceId: plugin.instanceId,
        workspaceId: binding.workspaceId,
        packageVersion: binding.packageVersion,
        workspacePath: workspacePath ?? '',
        canDispatch: () => this.publicPlanCanDispatch(plan, plugin),
      })
    }

    if ((EDITOR_AI_METHODS as readonly string[]).includes(plan.address)) {
      return this.editorAiCapability.execute(plan.address, plan.args, {
        instanceId: plugin.instanceId,
        workspacePath: workspacePath ?? '',
        canDispatch: () => this.publicPlanCanDispatch(plan, plugin),
      })
    }

    if (plan.address.startsWith('aiCli.')) {
      return this.executeAiCliCapability(plan, plugin, workspacePath ?? '')
    }

    if (plan.address.startsWith('fs.')) {
      if (!workspacePath) throw new Error('filesystem capability workspace binding is missing')
      const selectionAddresses = new Set([
        'fs.readFile', 'fs.writeFile', 'fs.readImage', 'fs.stat', 'fs.statPath',
        'fs.listArchive', 'fs.convertOffice', 'fs.previewResource',
      ])
      const binding = plugin.capabilityContext?.runtimeBinding
      let fsWorkspacePath = workspacePath
      let fsArgs = plan.args
      if (selectionAddresses.has(plan.address) && plan.args.selectionGrant !== undefined) {
        if (!binding || !binding.instanceId || !binding.workspaceId || !binding.packageVersion) {
          throw new Error('public capability runtime binding is missing')
        }
        const owner = {
          instanceId: binding.instanceId,
          workspaceId: binding.workspaceId,
          packageVersion: binding.packageVersion,
        }
        const target = this.editorSelectionGrants.fileTarget(
          owner,
          plan.args.selectionGrant,
          plan.args.path as string,
        )
        fsWorkspacePath = target.workspacePath
        fsArgs = { ...plan.args, path: target.relPath }
        delete fsArgs.selectionGrant
      }
      const editorRequest = editorFilesystemRequest(plan.address, fsArgs, fsWorkspacePath)
      if (editorRequest) {
        const timeoutMs = plan.address === 'fs.findInFiles' || plan.address === 'fs.replaceInFiles'
          ? 30_000
          : 10_000
        const result = await this.sendPublicBackend(
          editorRequest.type,
          editorRequest.payload,
          () => this.publicPlanCanDispatch(plan, plugin),
          timeoutMs,
        )
        if (plan.address === 'fs.previewResource') {
          if (!this.backendWsUrl) throw new Error('backend not connected')
          return {
            url: editorPreviewResourceUrl(
              this.backendWsUrl,
              result,
              String(fsArgs.path),
            ),
          }
        }
        return result
      }
      const wsType = PUBLIC_FS_WS_TYPES[plan.address]
      if (!wsType) throw new Error(`unsupported public filesystem capability '${plan.address}'`)
      const args = fsArgs
      const path = typeof args.path === 'string' ? args.path : ''
      const payload: Record<string, unknown> = { workspace_path: fsWorkspacePath }
      if (wsType === 'fs.list_dir') {
        payload.rel_path = path
        if (args.showHidden !== undefined) payload.show_hidden = args.showHidden
      }
      else if (wsType === 'fs.list_files_flat') {
        payload.query = typeof args.query === 'string' ? args.query : ''
        payload.max_results = typeof args.maxResults === 'number' ? args.maxResults : 100
      } else if (wsType === 'fs.glob_files') payload.pattern = args.pattern
      else if (wsType === 'fs.stat_path') payload.path = path
      else payload.rel_path = path
      if (wsType === 'fs.stat_path') {
        if (!isWorkspaceContainedPath(fsWorkspacePath, path)) {
          throw new Error('filesystem path escapes the workspace')
        }
        payload.path = resolvePathForContainment(resolve(fsWorkspacePath, path))
      }
      if (wsType === 'fs.write_file') {
        const violation = workspaceMutationPathError(fsWorkspacePath, path)
        if (violation === 'Git metadata paths are protected') {
          throw new Error(violation)
        }
        if (violation) throw new Error(`filesystem ${violation}`)
      }
      if (wsType === 'fs.write_file') payload.content = args.content
      if (wsType === 'fs.read_file' && typeof args.encoding === 'string') {
        payload.encoding_override = args.encoding
      }
      if (wsType === 'fs.write_file') {
        if (typeof args.encoding === 'string') payload.encoding = args.encoding
        if (args.expectedMtime !== undefined) payload.expected_mtime = args.expectedMtime
      }
      const response = await this.sendPublicBackend(
        wsType,
        payload,
        () => this.publicPlanCanDispatch(plan, plugin),
      )
      if (plan.address === 'fs.readFile') {
        // Keep the required public `content` field stable for existing SDK
        // consumers while retaining all backend metadata on binary/errors.
        const readResult = toPayload(response)
        return {
          ...readResult,
          content: typeof readResult.content === 'string' ? readResult.content : '',
        }
      }
      if (plan.address === 'fs.listDirectory') {
        return normalizePublicDirectoryResult(response)
      }
      return response
    }

    if (plan.address === 'ui.openPlansWindow') {
      if (!workspacePath) throw new Error('Plans window capability requires a workspace')
      const path = typeof plan.args.path === 'string' ? plan.args.path : ''
      if (!path || isAbsolute(path)) throw new Error('Plans window path must be relative')
      const root = resolve(resolvePlansRootPath(workspacePath))
      // Plan rel_paths are '/'-separated everywhere else (the plans backend lists them so).
      const relativePath = relative(root, resolve(root, path)).split(sep).join('/')
      if (!isAllowedPlanDocumentPath(relativePath, root)) {
        throw new Error('Plans window path is outside the plans directory')
      }
      if (!this.openPlansWindowHandler) throw new Error('Plans window handler not registered')
      const opened = await this.openPlansWindowHandler(workspacePath, relativePath)
      return { opened }
    }

    if (plan.address === 'ui.shareCaps' || plan.address === 'ui.shareCreate' || plan.address === 'ui.shareChatTargets') {
      return this.executeShareCapability(plan, plugin, workspacePath)
    }

    if (plan.address === 'ui.openInEditor') {
      if (!workspacePath) throw new Error('editor capability requires a workspace')
      const path = typeof plan.args.path === 'string' ? plan.args.path : ''
      // Plans documents are rooted at the repository's plan directories
      // even when the selected workspace is a nested subdirectory.
      // Keep the existing public editor capability and editor router, but use
      // the same Host-selected Plans root for that one first-party surface.
      let root = resolve(
        plugin.id === PLANS_PLUGIN_ID ? resolvePlansRootPath(workspacePath) : workspacePath,
      )
      if (plugin.id === PLANS_PLUGIN_ID) {
        if (!path || isAbsolute(path)) {
          throw new Error('Plans editor path must be relative')
        }
        if (!isAllowedPlanDocumentPath(path, root)) {
          // A `file:line` reference inside a plan cites a source file, not
          // another plan document. Following one is a direct user action, so
          // only a Host-authenticated `user` initiator may leave the plan
          // directories, and only for a target inside the bound workspace. An
          // agent/MCP initiator keeps the plan-document-only reach it has now.
          if (plan.initiator?.kind !== 'user' || !isWorkspaceContainedPath(workspacePath, path)) {
            throw new Error('Plans editor path is outside the plans directory')
          }
          root = resolve(workspacePath)
        }
      }
      const relativePath = relative(root, resolve(root, path))
      if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error('editor path escapes the workspace')
      }
      const pairedOpened = await this.openPairedEditorTarget(
        plugin, root, relativePath, plan.args.line, plan.args.column,
      )
      if (pairedOpened !== null) return { opened: pairedOpened }
      if (!this.openInEditorHandler) throw new Error('editor open handler not registered')
      const opened = await this.openInEditorHandler({
        workspace_path: root,
        filepath: relativePath,
        ...(typeof plan.args.line === 'number' ? { line: String(plan.args.line) } : {}),
        ...(typeof plan.args.column === 'number' ? { column: String(plan.args.column) } : {}),
      })
      return { opened }
    }

    if (plan.address === 'ui.openExternal') {
      const url = typeof plan.args.url === 'string' ? plan.args.url : ''
      if (!this.hostShellHandlers) throw new Error('host shell handlers not registered')
      const result = await this.hostShellHandlers.openExternal(url)
      if (!result.ok) throw new Error(result.error ?? 'open external failed')
      return { opened: true }
    }

    if (plan.address === 'shell.run') {
      const command = typeof plan.args.command === 'string' ? plan.args.command : ''
      const response = await this.sendPublicBackend(
        'shell.run',
        {
          workspace_path: workspacePath,
          command,
          host_mode: plan.shellMode ?? 'allowlist',
        },
        () => this.publicPlanCanDispatch(plan, plugin),
      )
      return {
        exitCode: Number((response as Record<string, unknown>).exit_code ?? 0),
        stdout: String((response as Record<string, unknown>).stdout ?? (response as Record<string, unknown>).output ?? ''),
        stderr: String((response as Record<string, unknown>).stderr ?? ''),
        ...shellRunTruncation(response as Record<string, unknown>),
      }
    }

    if (plan.address.startsWith('web.')) {
      if (!this.publicPlanCanDispatch(plan, plugin)) {
        throw new Error('agent execution policy denied the operation')
      }
      return this.executeWebCapability(plan, plugin)
    }

    throw new Error(`unsupported public capability '${plan.address}'`)
  }

  /** The plugin web view registry, wired to `web.changed` on first use. The
   *  native backend's `web` Bridge port must reach the registry through here
   *  so the change hook is installed before any view exists. */
  pluginWebViews(): PluginWebViewRegistry {
    if (!this.webViewRegistry) {
      setPluginWebViewChangedHook((pluginId, views) => this.dispatchWebChanged(pluginId, views))
      this.webViewRegistry = pluginWebViewRegistry()
    }
    return this.webViewRegistry
  }

  /** Uninstall: wipe the package's browser partition when it declares `web`. */
  async clearPluginWebData(pluginId: string): Promise<void> {
    const policy = this.descriptors.get(pluginId)?.capabilityPolicy
    // A disabled package has no descriptor; its installed summary still says
    // what its manifest declares.
    const system = policy?.kind === 'manifest-v2'
      ? policy.system
      : this.installedPackages.get(pluginId)?.manifestPermissions?.system
    if (!system?.includes('web')) return
    await this.pluginWebViews().clearData(pluginId)
  }

  /** `web.*` view capabilities. The plugin id is the Host binding's, never the
   *  request's; the registry keeps each plugin inside its own views. */
  private async executeWebCapability(plan: PublicCapabilityExecutionPlan, plugin: RunningPlugin): Promise<unknown> {
    const registry = this.pluginWebViews()
    const pluginId = plan.runtime.pluginId
    const args = plan.args
    const viewId = typeof args.viewId === 'string' ? args.viewId : ''
    switch (plan.address) {
      case 'web.list':
        return { views: registry.list(pluginId) }
      case 'web.create':
        return registry.create(pluginId, {
          space: String(args.space),
          ...(typeof args.url === 'string' ? { url: args.url } : {}),
        }, 'user')
      case 'web.attach':
        registry.attach(pluginId, viewId, args.rect as WebViewRect, this.webHostSurface(plugin))
        return { ok: true }
      case 'web.detach':
        registry.detach(pluginId, viewId)
        return { ok: true }
      case 'web.navigate':
        registry.navigate(pluginId, {
          viewId,
          ...(typeof args.url === 'string' ? { url: args.url } : {}),
          ...(typeof args.action === 'string' ? { action: args.action as 'back' | 'forward' | 'reload' | 'stop' } : {}),
        })
        return { ok: true }
      case 'web.setOwner':
        registry.setOwner(pluginId, viewId, args.owner as WebViewOwner)
        return { ok: true }
      case 'web.takeControl':
        registry.takeControl(pluginId, viewId)
        return { ok: true }
      case 'web.returnControl':
        registry.returnControl(pluginId, viewId)
        return { ok: true }
      case 'web.close':
        registry.close(pluginId, viewId, false)
        return { ok: true }
      case 'web.capture':
        return registry.capture(pluginId, viewId, typeof args.maxWidth === 'number' ? args.maxWidth : undefined)
      case 'web.clearData':
        await registry.clearData(pluginId)
        return { ok: true }
      default:
        throw new Error(`unsupported public capability '${plan.address}'`)
    }
  }

  /** The calling instance's native plugin view as a web view host. A frame or
   *  `<webview>` carrier is laid out by the renderer, so the Host cannot stack
   *  a native view on it. */
  private webHostSurface(plugin: RunningPlugin): WebHostSurface {
    const native = plugin.view.nativeView
    if (plugin.carrier === 'frame' || !native) {
      throw new WebViewError('CAPABILITY_DENIED', { message: 'this view cannot host a web view' })
    }
    const hostWindow = plugin.hostWindow
    return {
      key: plugin.instanceId,
      addChildView: (view: WebGuestView) => hostWindow.contentView.addChildView(view as unknown as WebContentsView),
      removeChildView: (view: WebGuestView) => {
        if (!hostWindow.isDestroyed()) hostWindow.contentView.removeChildView(view as unknown as WebContentsView)
      },
      bounds: () => (hostWindow.isDestroyed() ? null : native.getBounds()),
      visible: () => plugin.visible && !hostWindow.isDestroyed(),
    }
  }

  /** Card K4: audit one change of the Developer Mode switch in the plugin
   *  activity log, under the Host's own event identity. Best effort like every
   *  activity row: sent with the next batch over the Host session. */
  recordDeveloperModeChange(enabled: boolean, appVersion: string): void {
    this.activityRecorder.recordHostEvent(enabled ? 'developerMode.on' : 'developerMode.off', appVersion)
  }

  /** D-e: a removed plugin's first-seen activity rows go (`plugin.activity.forget`),
   *  so a reinstall's first writes in a workspace are flagged again. Best effort:
   *  with no Host session it is skipped, and removal never waits for it. */
  forgetPluginActivity(pluginId: string): void {
    const client = this.wsClient
    if (!client || !this.hostSessionRegistered) return
    void Promise.resolve()
      .then(() => client.send(PLUGIN_ACTIVITY_FORGET_MESSAGE, { plugin_id: pluginId }, 10_000))
      .catch((error: unknown) => {
        console.debug(`[plugins] activity of ${pluginId} not forgotten:`, error)
      })
  }

  /** D-e: one `plugin_activity` row for a broker call of a third-party plugin.
   *  The bundled `navide.*` packages are not recorded. Never throws. */
  private recordCapabilityActivity(
    plugin: RunningPlugin | undefined,
    payload: unknown,
    response: CapabilityResponse,
  ): void {
    try {
      if (!plugin || isReservedPluginId(plugin.id)) return
      const call = parseCapabilityCall(payload, plugin.id)
      if (!call) return
      const context = plugin.capabilityContext
      this.activityRecorder.record(activityRowFor({
        pluginId: plugin.id,
        packageVersion: context?.runtimeBinding?.packageVersion ?? context?.userGrant?.packageVersion,
        workspace: plugin.workspacePath,
        call,
        response,
      }))
    } catch (error) {
      console.debug('[plugins] activity not recorded:', error)
    }
  }

  /** Host entry point for an authenticated MCP request. The request shape is
   * untrusted and contains no initiator; the Host mints the agent identity and
   * keeps it attached to the resulting public or backend operation. */
  async executeAgentCapability(instanceId: string, payload: unknown): Promise<CapabilityResponse> {
    const response = await this.executeAgentCapabilityCall(instanceId, payload)
    this.recordCapabilityActivity(this.running.get(instanceId), payload, response)
    return response
  }

  private async executeAgentCapabilityCall(instanceId: string, payload: unknown): Promise<CapabilityResponse> {
    const reqId =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).reqId === 'string'
        ? (payload as Record<string, unknown>).reqId as string
        : ''
    const plugin = this.running.get(instanceId)
    if (!plugin) return undispatched(buildError(reqId, 'BAD_REQUEST', 'unknown plugin instance'))
    if (this.isPluginStopping(plugin)) {
      return undispatched(buildError(reqId, 'PLUGIN_STOPPING', 'plugin runtime is stopping'))
    }
    if (this.payloadClaimsInstance(payload) || this.payloadClaimsInitiator(payload)) {
      return undispatched(buildError(reqId, 'BAD_REQUEST', 'Host-owned identity cannot be supplied'))
    }
    const call = parseCapabilityCall(payload, plugin.id)
    if (!call) return undispatched(buildError(reqId, 'BAD_REQUEST', 'malformed capability call'))
    if (plugin.capabilityPolicy.kind !== 'manifest-v2') {
      return buildError(call.reqId, 'CAPABILITY_DENIED', 'agent calls require a Manifest v2 capability')
    }
    const storageAdmission = await this.plansInstanceStorageAdmission(plugin, reqId)
    if (storageAdmission) return undispatched(storageAdmission)
    const initiator: AuthenticatedInitiator = Object.freeze({
      kind: 'agent',
      source: 'mcp',
      id: randomUUID(),
    })
    const context = this.capabilityContextForInitiator(plugin, initiator)
    if (!context) {
      return buildError(call.reqId, 'CAPABILITY_DENIED', 'agent capability context is unavailable')
    }
    let plan: ReturnType<typeof planCapabilityCall>
    try {
      plan = planCapabilityCall(call, plugin.capabilityPolicy, context)
    } catch {
      return undispatched(buildError(call.reqId, 'INVALID_ARGUMENT', 'invalid capability request'))
    }
    if (plan.kind === 'respond') return plan.response
    if (plan.kind === 'public') {
      if (!this.publicPlanCanDispatch(plan, plugin)) {
        return buildError(call.reqId, 'CAPABILITY_DENIED', 'agent execution policy denied the operation')
      }
      try {
        if (plan.storage) {
          if (!this.publicStorageHandler || !isStorageExecutionAddress(plan.address)) {
            return undispatched(buildError(call.reqId, 'BACKEND_UNAVAILABLE', 'storage capability broker is not connected'))
          }
          const result = await this.publicStorageHandler({
            address: plan.address,
            args: plan.args,
            partition: plan.storage.partition,
            snapshot: plan.storage.snapshot,
            ...(plan.initiator ? { initiator: plan.initiator } : {}),
          })
          if (plan.address === 'storage.set' || plan.address === 'storage.delete') {
            const scope = plan.args.scope
            const key = plan.args.key
            const value = plan.address === 'storage.delete' ? null : plan.args.value
            if (
              (scope === 'plugin' || scope === 'workspace') &&
              typeof key === 'string' &&
              isJsonValue(value)
            ) {
              this.dispatchPluginStorageChanged(plan, scope, key, value, plan.address === 'storage.delete')
            }
          }
          return buildSuccess(call.reqId, result)
        }
        if (!this.publicCapabilityHandler) {
          return undispatched(buildError(call.reqId, 'BACKEND_UNAVAILABLE', 'public capability broker is not connected'))
        }
        return buildSuccess(call.reqId, await this.publicCapabilityHandler(plan))
      } catch (error) {
        if (error instanceof WebViewError) return webViewCapabilityError(call.reqId, error)
        return buildError(call.reqId, 'INTERNAL_ERROR', 'public capability failed')
      }
    }
    // Manifest v2 agent plans are public capability plans. Keep this branch
    // fail-closed if a future planner ever produces a Host action here: agent
    // requests must never reach the legacy Host-action executor.
    if (plan.kind === 'host') {
      return buildError(call.reqId, 'CAPABILITY_DENIED', 'agent Host actions are unavailable')
    }
    return undispatched(buildError(call.reqId, 'UNKNOWN', `no handler for '${call.ns}.${call.method}'`))
  }

  private headlessPlansKey(packageVersion: string, workspacePath: string): string {
    const workspaceId = this.workspaceIdForPath(workspacePath)
    return `${PLANS_PLUGIN_ID}\u0000${packageVersion}\u0000${workspaceId ?? workspacePath}`
  }

  private async bindHeadlessPlansBackend(
    descriptor: PluginLaunchDescriptor,
    activation: BackendPluginLaunchSpec,
    workspacePath: string,
  ): Promise<string> {
    const packageVersion = descriptor.packageVersion
    const packageDir = descriptor.packageDir
    if (!nonEmptyString(packageVersion) || !nonEmptyString(packageDir)) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    const workspaceId = this.workspaceIdForPath(workspacePath)
    if (!workspaceId) throw new BackendPluginError('INVALID_RUNTIME')
    const key = this.headlessPlansKey(packageVersion, workspacePath)
    const existing = this.headlessBackendInstances.get(key)
    if (existing) return existing
    const pending = this.pendingHeadlessBackendBinds.get(key)
    if (pending) return pending

    if (
      activation.pluginId !== PLANS_PLUGIN_ID ||
      activation.packageVersion !== packageVersion ||
      canonicalBackendPackageDir(activation.packageDir) !== canonicalBackendPackageDir(packageDir)
    ) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    let task!: Promise<string>
    task = this.pluginBackendHost.bindWorkspace(
      {
        pluginId: PLANS_PLUGIN_ID,
        packageVersion,
        workspaceId,
        instanceId: null,
        contributionKey: 'navide.plans.mcp',
        hostWindowId: null,
        initiator: HOST_USER_INITIATOR,
      },
      packageDir,
      workspacePath,
    ).then((instanceId) => {
      if (this.isPackageVersionStopping(PLANS_PLUGIN_ID, packageVersion)) {
        void this.pluginBackendHost.unbindView(instanceId, 'plugin-stopping')
        throw new BackendPluginError('PLUGIN_STOPPING')
      }
      this.markPlansBackendReady(packageVersion, packageDir)
      this.headlessBackendInstances.set(key, instanceId)
      this.headlessPlansWorkspacePaths.set(instanceId, workspacePath)
      return instanceId
    }).catch((error: unknown) => {
      if (this.isPlansBackendAvailabilityError(error)) {
        this.markPlansBackendUnavailable('bind-failure')
      }
      throw error
    }).finally(() => {
      if (this.pendingHeadlessBackendBinds.get(key) === task) {
        this.pendingHeadlessBackendBinds.delete(key)
      }
    })
    this.pendingHeadlessBackendBinds.set(key, task)
    return task
  }

  /** Reuse the private Plans bridge's execution-policy evaluation for the
   * headless MCP route. This makes policy a Host gate before either packaged
   * dispatch or recovery is considered, while the bridge rechecks it at the
   * actual filesystem boundary. */
  private plansAgentFilesystemPolicyAllows(
    workspacePath: string,
    initiator: AuthenticatedInitiator,
  ): boolean {
    let snapshot: ExecutionPolicySnapshot | undefined
    try {
      snapshot = this.executionPolicyResolver?.(workspacePath)
    } catch (error) {
      this.noteExecutionPolicyFailure(error)
      return false
    }
    return Boolean(
      snapshot &&
      snapshot.state !== 'corrupt' &&
      executionPolicyAllows(initiator, snapshot, 'fs'),
    )
  }

  /** Revalidate every security property immediately before authorizing the
   * legacy adapter. This is deliberately independent of the broad error code:
   * the caller proves the package child never received the request. */
  private canMintPlansLegacyRecoveryDisposition(
    descriptor: PluginLaunchDescriptor,
    activation: BackendPluginLaunchSpec,
    workspacePath: string,
    method: string,
    initiator: AuthenticatedInitiator,
  ): boolean {
    const selection = this.plansBackendSelection()
    if (
      !selection ||
      selection.descriptor !== descriptor ||
      selection.activation !== activation ||
      !activation.agentMethods?.includes(method) ||
      this.isPackageVersionStopping(PLANS_PLUGIN_ID, descriptor.packageVersion) ||
      !this.plansCapabilityContext(descriptor.packageVersion!, workspacePath, 'plans-mcp') ||
      !this.plansAgentFilesystemPolicyAllows(workspacePath, initiator)
    ) return false
    return this.plansBackendFallbackAllowed()
  }

  private plansPreDispatchFailureResponse(
    reqId: string,
    error: unknown,
    descriptor: PluginLaunchDescriptor,
    activation: BackendPluginLaunchSpec,
    workspacePath: string,
    method: string,
    initiator: AuthenticatedInitiator,
  ): PlansRecoveryResponse {
    const response = this.backendError(reqId, error)
    if (!this.canMintPlansLegacyRecoveryDisposition(
      descriptor, activation, workspacePath, method, initiator,
    )) return response
    return { ...response, recoveryDisposition: LEGACY_SAFE_BEFORE_DISPATCH }
  }

  /** Host entry point for an authenticated MCP request when the Plans window
   *  is closed. The package/version and workspace are selected from the
   *  transport target; the request body contains only a package method call. */
  async executeAgentBackendCallForWorkspace(
    pluginId: string,
    workspacePath: string,
    payload: unknown,
  ): Promise<CapabilityResponse | BuiltinPluginDisabledResponse> {
    const record = this.exactBackendPayload(payload, new Set(['reqId', 'name', 'args', 'timeoutMs']))
    const reqId =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).reqId === 'string'
        ? (payload as Record<string, unknown>).reqId as string
        : ''
    if (
      pluginId !== PLANS_PLUGIN_ID ||
      !nonEmptyString(workspacePath) ||
      !record ||
      !nonEmptyString(record.reqId) ||
      !nonEmptyString(record.name) ||
      !Object.prototype.hasOwnProperty.call(record, 'args') ||
      !isJsonValue(record.args) ||
      (record.timeoutMs !== undefined && !isAllowedBackendTimeout(record.timeoutMs))
    ) return buildError(reqId, 'BAD_REQUEST', 'malformed Plans backend request')

    // The user's Disabled switch wins over every later check, and its refusal
    // carries no recovery disposition: a disabled Plans is off, not degraded.
    if (this.isBuiltinPluginDisabled(PLANS_PLUGIN_ID)) {
      return {
        reqId: record.reqId,
        ok: false,
        error: { code: 'PLUGIN_TOOL_UNAVAILABLE', message: builtinPluginDisabledMessage(PLANS_PLUGIN_ID) },
        reason: 'plugin-disabled',
      }
    }
    const descriptor = this.descriptors.get(PLANS_PLUGIN_ID)
    const packageVersion = descriptor?.packageVersion
    if (!descriptor || !nonEmptyString(packageVersion)) {
      return buildError(record.reqId, 'BACKEND_UNAVAILABLE', 'Plans agent backend is unavailable')
    }
    // Revocation wins over all subsequent grant and policy checks. A package
    // that is draining cannot receive a recovery disposition.
    if (this.isPackageVersionStopping(PLANS_PLUGIN_ID, packageVersion)) {
      return buildError(record.reqId, 'PLUGIN_STOPPING', 'Backend plugin is stopping.')
    }
    const selection = this.plansBackendSelection()
    if (!selection || selection.descriptor !== descriptor) {
      return buildError(record.reqId, 'BACKEND_UNAVAILABLE', 'Plans agent backend is unavailable')
    }
    const { activation } = selection
    if (!activation.agentMethods?.includes(record.name)) {
      return buildError(record.reqId, 'CAPABILITY_DENIED', 'Plans agent method is not allowlisted')
    }
    if (!this.plansCapabilityContext(packageVersion, workspacePath, 'plans-mcp')) {
      return buildError(record.reqId, 'CAPABILITY_DENIED', 'Plans package Grant is unavailable')
    }
    const initiator: AuthenticatedInitiator = Object.freeze({
      kind: 'agent',
      source: 'mcp',
      id: randomUUID(),
    })
    if (!this.plansAgentFilesystemPolicyAllows(workspacePath, initiator)) {
      return buildError(record.reqId, 'CAPABILITY_DENIED', 'agent execution policy denied the operation')
    }
    const deadline = Date.now() + (typeof record.timeoutMs === 'number' ? record.timeoutMs : 30_000)
    if (this.plansStorageReadinessHandler) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let ready: boolean
      try {
        ready = await Promise.race([
          this.plansStorageReady(packageVersion),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new BackendPluginError('TIMEOUT')), Math.max(1, deadline - Date.now()))
          }),
        ])
      } catch (error) {
        return this.backendError(record.reqId, error)
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (this.isPackageVersionStopping(PLANS_PLUGIN_ID, packageVersion)) {
        return buildError(record.reqId, 'PLUGIN_STOPPING', 'Backend plugin is stopping.')
      }
      const current = this.plansBackendSelection()
      if (
        current?.descriptor !== descriptor || current.activation !== activation ||
        !this.plansCapabilityContext(packageVersion, workspacePath, 'plans-mcp') ||
        !this.plansAgentFilesystemPolicyAllows(workspacePath, initiator)
      ) return buildError(record.reqId, 'CAPABILITY_DENIED', 'Plans runtime authorization changed')
      if (!ready) {
        // Nothing has been dispatched, and the agent policy was verified above,
        // so the MCP caller may serve this from its local plan tools instead of
        // failing: withdraw the v2 availability bit (as any other v2 failure
        // does) so the same pre-dispatch recovery verdict is minted.
        this.markPlansBackendUnavailable('storage-unavailable')
        const unavailable: PlansRecoveryResponse = buildError(
          record.reqId, 'BACKEND_UNAVAILABLE', 'Plans storage is unavailable',
        )
        if (this.canMintPlansLegacyRecoveryDisposition(
          descriptor, activation, workspacePath, record.name, initiator,
        )) unavailable.recoveryDisposition = LEGACY_SAFE_BEFORE_DISPATCH
        return unavailable
      }
    }
    if (!this.isPlansBackendAvailable()) {
      return this.plansPreDispatchFailureResponse(
        record.reqId,
        new BackendPluginError('BACKEND_UNAVAILABLE', 'Plans agent backend is unavailable'),
        descriptor,
        activation,
        workspacePath,
        record.name,
        initiator,
      )
    }
    const cachedInstanceId = this.headlessBackendInstances.get(
      this.headlessPlansKey(packageVersion, workspacePath),
    )
    if (cachedInstanceId && this.plansAbandonedBackendInstances.has(cachedInstanceId)) {
      return buildError(record.reqId, 'BACKEND_UNAVAILABLE', PLANS_BACKEND_STOPPED_MESSAGE)
    }
    if (record.name === 'plans.create' && !(await this.provisionPlansAssets(workspacePath))) {
      return buildError(record.reqId, 'BACKEND_UNAVAILABLE', 'Plans assets are unavailable')
    }
    let dispatched = false
    let instanceId: string | undefined
    try {
      instanceId = await this.bindHeadlessPlansBackend(descriptor, activation, workspacePath)
      const remainingTimeout = deadline - Date.now()
      if (remainingTimeout <= 0) return buildError(record.reqId, 'TIMEOUT', 'Plans request timed out')
      // Calling into the Host child marks a request as dispatched even if the
      // Promise rejects immediately: a child may have accepted side effects.
      dispatched = true
      const result = await this.pluginBackendHost.call(
        instanceId,
        record.name,
        record.args,
        {
          initiator,
          ...(this.plansStorageReadinessHandler
            ? { timeoutMs: remainingTimeout }
            : record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs }),
        },
      )
      return buildSuccess(record.reqId, result)
    } catch (error) {
      if (
        this.isPlansBackendAvailabilityError(error) &&
        !(instanceId && this.plansDiscardedBackendInstances.has(instanceId))
      ) {
        this.markPlansBackendUnavailable('child-unavailable')
      }
      if (!dispatched) {
        return this.plansPreDispatchFailureResponse(
          record.reqId, error, descriptor, activation, workspacePath, record.name, initiator,
        )
      }
      return this.backendError(record.reqId, error)
    }
  }

  /**
   * Host entry point for a third-party agent tool call (plan B1-b; contract
   * section 4.2, `operation: "agentTool"`). Checks run on every call, in this
   * order, whatever the CLI or backend has cached: master switch -> caller kind
   * -> package installed, enabled, not quarantined/revoked/stopping -> consent
   * -> tool in the consented list -> name collision -> target workspace grant
   * -> first-write confirmation (DB3) -> execution policy -> headless binding
   * -> call. Plans never comes here: its route above is unchanged.
   */
  async executeAgentToolCall(
    request: Record<string, unknown>,
    onTransferProgress?: (phase: 'arguments' | 'execution' | 'result') => void,
  ): Promise<HostAgentToolResponse> {
    const received = Date.now()
    const parsed = parseAgentToolCallRequest(request)
    if (!parsed) return agentToolError('BAD_REQUEST', 'malformed agent tool request')
    const host = this.agentToolsHost
    if (!host) return agentToolUnavailable('master-switch-off')
    this.pruneAgentToolBindings()
    const isStopping = (pluginId: string, packageVersion: string): boolean =>
      this.isPackageVersionStopping(pluginId, packageVersion)
    const admission = await host.admit({
      pluginId: parsed.pluginId,
      toolName: parsed.toolName,
      pluginVersion: parsed.pluginVersion,
      caller: parsed.caller,
    }, isStopping)
    if (!admission.ok) return agentToolUnavailable(admission.reason)
    const { spec, tool } = admission
    // The core waits the tool's timeout plus a transport margin. The Host
    // never dispatches once its own deadline (the tool's timeout, counted from
    // receipt) has passed: an answer nobody waits for must not have side
    // effects, and the agent's retry must not write twice.
    const deadline = received + tool.timeoutMs
    const late = (): AgentToolCallResponse | null => Date.now() >= deadline
      ? agentToolError('PLUGIN_TOOL_TIMEOUT', 'The call was not started before its deadline.')
      : null
    // A method shared with a write-risk tool is a write, whichever tool names it.
    const risk: 'read' | 'write' = (spec.thirdParty.agentTools ?? [])
      .some((candidate) => candidate.method === tool.method && candidate.risk === 'write') ? 'write' : tool.risk
    const required = tool.inputSchema.required
    if (
      Array.isArray(required) &&
      required.some((key) => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(parsed.arguments, key))
    ) return agentToolError('PLUGIN_TOOL_INVALID_ARGUMENTS', 'A required tool argument is missing.')

    // Target workspace grant: a Navide workspace open in a window (never the
    // home folder, a filesystem root or any other directory), and the user
    // Grant for this exact version, which includes `fs` when the package
    // declares it. Another open workspace than the caller's is allowed and
    // flagged as cross-workspace.
    const root = canonicalExistingDirectory(parsed.workspacePath)
    const workspaceId = root ? this.workspaceIdForPath(root) : null
    const workspaceGranted = (): boolean => {
      const grant = this.capabilityGrantResolver?.(spec.pluginId, spec.packageVersion) ?? null
      return Boolean(
        root && workspaceId && this.isAgentToolWorkspace(root) &&
        grant && grant.packageVersion === spec.packageVersion &&
        (!spec.thirdParty.system.includes('fs') || grant.system.includes('fs')),
      )
    }
    // The package stopped being callable: catalog state or served methods.
    const stoppedReason = (): AgentToolCallResponse | null => {
      const current = host.recheck(spec.pluginId, parsed.caller, isStopping, spec)
      if (!current.ok) return agentToolUnavailable(current.reason)
      const activation = this.pluginBackendHost.activationFor(spec.pluginId, spec.packageVersion, spec.packageDir)
      if (
        !activation ||
        !this.pluginBackendHost.agentToolMethodsFor(spec.pluginId, spec.packageVersion).includes(tool.method)
      ) return agentToolUnavailable('tool-not-consented')
      return null
    }
    // Everything that can change while the call waits, checked again after
    // every wait: catalog state, served methods, workspace and Grant, deadline.
    const recheck = (): AgentToolCallResponse | null => {
      const stopped = stoppedReason()
      if (stopped) return stopped
      if (!workspaceGranted()) {
        return agentToolError(
          'WORKSPACE_NOT_AUTHORIZED',
          parsed.caller.kind === 'pane'
            ? 'The Navide plugin has no grant for this workspace.'
            : 'An external or Host caller must name an open Navide workspace in workspace_path.',
        )
      }
      return late()
    }
    const early = recheck()
    if (early) return early
    if (risk === 'write' && !(await host.confirmWrite(spec, tool, root!))) {
      return agentToolError('WORKSPACE_WRITE_DECLINED', 'The user did not allow changes in this workspace.')
    }
    const afterConfirm = recheck()
    if (afterConfirm) return afterConfirm
    const initiator: AuthenticatedInitiator = Object.freeze({
      kind: 'agent',
      source: 'mcp',
      id: randomUUID(),
      caller: Object.freeze({
        kind: parsed.caller.kind,
        paneId: parsed.caller.paneId,
        workspace: parsed.caller.workspace,
        verifiedTo: parsed.caller.kind === 'pane' ? 'pane' : 'caller-kind',
      }),
    })
    if (!this.agentToolPolicyAllows(root!, initiator, spec)) {
      return agentToolError('EXECUTION_POLICY_DENIED', this.agentToolPolicyDeniedMessage(root!, spec))
    }
    const crossWorkspace = parsed.caller.workspace !== null &&
      (canonicalExistingDirectory(parsed.caller.workspace) ?? resolve(parsed.caller.workspace)) !== root
    const started = Date.now()
    const meta = (resultBytes: number) => ({ durationMs: Date.now() - started, resultBytes, crossWorkspace })
    let instanceId: string
    try {
      instanceId = await this.bindHeadlessAgentToolBackend(spec, root!, workspaceId!)
    } catch (error) {
      // A bind refused or cancelled because the package stopped being
      // callable meanwhile answers with that reason, not as a plugin failure.
      // Any other bind failure keeps its own error, even past the deadline.
      const stopped = stoppedReason()
      if (stopped) return stopped
      return this.agentToolBackendError(error, meta(0))
    }
    const beforeCall = recheck()
    if (beforeCall) return beforeCall
    // The bridge lets this call write only when it came through a write tool.
    this.agentToolCalls.set(initiator.id, { pluginId: spec.pluginId, risk, workspaceRoot: root!, caller: parsed.caller, spec })
    try {
      const text = await this.pluginBackendHost.callForResultText(instanceId, tool.method, parsed.arguments, {
        initiator,
        timeoutMs: Math.max(1, Math.min(tool.timeoutMs, Math.ceil(deadline - Date.now()))),
        ...(onTransferProgress ? { onTransferProgress } : {}),
      })
      // DB9: no result cap. The tool already ran, so the result goes back
      // whole and carries its size. Longer than one piece, it is forwarded as
      // the text it came in (the core parses it); within one piece it is
      // parsed here and sent inline as before.
      if (text.chunks > 1) return { ok: true, resultText: text, meta: meta(text.bytes) }
      let result: unknown
      try {
        result = JSON.parse(text.piece(0))
      } catch {
        return {
          ...agentToolError('PLUGIN_TOOL_CHUNKS_INVALID', 'The Navide plugin result did not arrive whole.'),
          reason: 'json',
          meta: meta(0),
        }
      }
      return { ok: true, result, meta: meta(text.bytes) }
    } catch (error) {
      return this.agentToolBackendError(error, meta(0))
    } finally {
      this.agentToolCalls.delete(initiator.id)
    }
  }

  /** Send an agent tool answer to the core: a result longer than one piece
   *  goes as `agent.capability.result_chunk` requests, each awaited, then the
   *  summary in place of `result` (contract 4.4, R2). */
  private async sendAgentToolResponse(client: WsClient, requestId: string, response: HostAgentToolResponse): Promise<void> {
    if (response.ok && 'resultText' in response) {
      // Each piece is decoded just before it goes, as the plugin spelled it.
      const { resultText, ...rest } = response
      for (let seq = 0; seq < resultText.chunks; seq++) {
        const answer = await client.send<{ accepted?: boolean }>(
          AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE,
          { request_id: requestId, seq, data: resultText.piece(seq) },
          AGENT_TOOL_CHUNK_IDLE_MS,
        ).catch(() => null)
        // The core no longer waits for this request (timeout, client gone): stop.
        if (!answer?.ok || answer.payload?.accepted !== true) return
      }
      await client.send(
        'agent.capability.result',
        { request_id: requestId, response: { ...rest, resultChunks: { chunks: resultText.chunks, bytes: resultText.bytes } } },
        AGENT_TOOL_CHUNK_IDLE_MS,
      ).catch(() => undefined)
      return
    }
    if (response.ok) {
      const text = JSON.stringify(response.result ?? null)
      const bytes = utf8ByteLength(text)
      if (bytes > AGENT_TOOL_CHUNK_BYTES) {
        const pieces = splitAgentToolPayloadText(text)
        for (const [seq, data] of pieces.entries()) {
          const answer = await client.send<{ accepted?: boolean }>(
            AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE,
            { request_id: requestId, seq, data },
            AGENT_TOOL_CHUNK_IDLE_MS,
          ).catch(() => null)
          // The core no longer waits for this request (timeout, client gone): stop.
          if (!answer?.ok || answer.payload?.accepted !== true) return
        }
        const { result: _sent, ...rest } = response
        await client.send(
          'agent.capability.result',
          { request_id: requestId, response: { ...rest, resultChunks: { chunks: pieces.length, bytes } } },
          AGENT_TOOL_CHUNK_IDLE_MS,
        ).catch(() => undefined)
        return
      }
    }
    await client.send('agent.capability.result', { request_id: requestId, response }, 10_000).catch(() => {
      // The MCP waiter has its own timeout; a closed backend is reported there.
    })
  }

  /** The agent-tool call an initiator id belongs to, while it runs. */
  agentToolCallFor(initiatorId: string): { pluginId: string; risk: 'read' | 'write'; workspaceRoot: string } | undefined {
    const call = this.agentToolCalls.get(initiatorId)
    return call ? { pluginId: call.pluginId, risk: call.risk, workspaceRoot: call.workspaceRoot } : undefined
  }

  /** Forget headless agent-tool bindings the Host has since unbound. */
  private pruneAgentToolBindings(): void {
    for (const [key, instanceId] of [...this.headlessAgentToolInstances]) {
      if (this.pluginBackendHost.isBound(instanceId)) continue
      this.headlessAgentToolInstances.delete(key)
      this.headlessAgentToolRoots.delete(instanceId)
    }
  }

  private agentToolBackendError(
    error: unknown,
    meta: { durationMs: number; resultBytes: number; crossWorkspace: boolean },
  ): AgentToolCallResponse {
    if (error instanceof BackendPluginError) {
      // USER_CANCELLED: a stop (disable, removal, revoked consent) cancelled
      // the bind or the call; the plugin did not fail.
      if (error.code === 'PLUGIN_STOPPING' || error.code === 'USER_CANCELLED') {
        return { ...agentToolUnavailable('plugin-stopping'), meta }
      }
      if (error.code === 'TIMEOUT') {
        return {
          ...agentToolError('PLUGIN_TOOL_TIMEOUT', 'The Navide plugin did not answer in time.'),
          reason: error.reason === 'transfer-idle' ? 'transfer-idle' : 'execution',
          meta,
        }
      }
      if (error.code === 'CHUNKS_INVALID') {
        return {
          ...agentToolError('PLUGIN_TOOL_CHUNKS_INVALID', 'The Navide plugin result did not arrive whole.'),
          reason: (error.reason ?? 'bytes') as AgentToolChunksInvalidReason,
          meta,
        }
      }
      if (error.code === 'INVALID_ARGUMENT' || error.pluginCode === 'INVALID_ARGUMENT') {
        return { ...agentToolError('PLUGIN_TOOL_INVALID_ARGUMENTS', 'The tool arguments are invalid.'), meta }
      }
      return {
        ...agentToolError('PLUGIN_TOOL_FAILED', 'The Navide plugin tool failed.'),
        plugin_error: error.code === 'PLUGIN_ERROR' && error.pluginCode ? error.pluginCode : error.code,
        meta,
      }
    }
    return { ...agentToolError('PLUGIN_TOOL_FAILED', 'The Navide plugin tool failed.'), meta }
  }

  /** The agent execution policy must allow every system namespace the package
   * can reach headlessly (`ui` needs a view and is not one of them); a corrupt
   * policy refuses. The supervisor re-checks each bridge request again. */
  private agentToolPolicyAllows(
    workspacePath: string,
    initiator: AuthenticatedInitiator,
    spec: ThirdPartyLaunchSpec,
  ): boolean {
    let snapshot: ExecutionPolicySnapshot | undefined
    try {
      snapshot = this.executionPolicyResolver?.(workspacePath)
    } catch (error) {
      this.noteExecutionPolicyFailure(error)
      return false
    }
    if (!snapshot || snapshot.state === 'corrupt') return false
    const namespaces = spec.thirdParty.system.filter((namespace) => namespace !== 'ui')
    // A package that declares no headless namespace is still governed by the
    // policy: it is evaluated as the narrowest one a backend reaches, `fs`.
    return (namespaces.length > 0 ? namespaces : ['fs' as const])
      .every((namespace) => executionPolicyAllows(initiator, snapshot, namespace))
  }

  /** Why the policy refused a tool: a user policy that leaves out `web` says
   * so and where to add it; anything else keeps the generic text. */
  private agentToolPolicyDeniedMessage(workspacePath: string, spec: ThirdPartyLaunchSpec): string {
    const generic = 'The agent execution policy denied the operation.'
    if (!spec.thirdParty.system.includes('web')) return generic
    let snapshot: ExecutionPolicySnapshot | undefined
    try {
      snapshot = this.executionPolicyResolver?.(workspacePath)
    } catch {
      return generic
    }
    if (!snapshot || snapshot.state === 'corrupt') return generic
    const { mode, system } = snapshot.policy
    if (mode === 'full' || (mode === 'allowlist' && system.includes('web'))) return generic
    return webPolicyDeniedMessage(this.uiLocaleResolver?.() ?? 'en-US', mode)
  }

  /** One headless binding per package version and workspace, made for agent
   * tool calls only. A binding the Host has since stopped is replaced. */
  private bindHeadlessAgentToolBackend(
    spec: ThirdPartyLaunchSpec,
    root: string,
    workspaceId: string,
  ): Promise<string> {
    const key = `${spec.pluginId}\u0000${spec.packageVersion}\u0000${workspaceId}`
    const existing = this.headlessAgentToolInstances.get(key)
    if (existing && this.pluginBackendHost.isBound(existing)) return Promise.resolve(existing)
    if (existing) {
      this.headlessAgentToolInstances.delete(key)
      this.headlessAgentToolRoots.delete(existing)
    }
    const pending = this.pendingHeadlessAgentToolBinds.get(key)
    if (pending) return pending
    let task!: Promise<string>
    task = this.pluginBackendHost.bindAgentToolWorkspace(
      {
        pluginId: spec.pluginId,
        packageVersion: spec.packageVersion,
        workspaceId,
        instanceId: null,
        contributionKey: `${spec.pluginId}.agent-tools`,
        hostWindowId: null,
        initiator: HOST_USER_INITIATOR,
      },
      spec.packageDir,
      root,
    ).then((instanceId) => {
      if (this.isPackageVersionStopping(spec.pluginId, spec.packageVersion)) {
        void this.pluginBackendHost.unbindView(instanceId, 'plugin-stopping')
        throw new BackendPluginError('PLUGIN_STOPPING')
      }
      this.headlessAgentToolInstances.set(key, instanceId)
      this.headlessAgentToolRoots.set(instanceId, root)
      return instanceId
    }).finally(() => {
      if (this.pendingHeadlessAgentToolBinds.get(key) === task) this.pendingHeadlessAgentToolBinds.delete(key)
    })
    this.pendingHeadlessAgentToolBinds.set(key, task)
    return task
  }

  /** Host entry point for a package-local backend call originating at MCP.
   * The child sees only the Host-minted runtime initiator; its arguments cannot
   * add, remove, or replace that identity. */
  async executeAgentBackendCall(instanceId: string, payload: unknown): Promise<CapabilityResponse> {
    const record = this.exactBackendPayload(payload, new Set(['reqId', 'name', 'args', 'timeoutMs']))
    const reqId =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).reqId === 'string'
        ? (payload as Record<string, unknown>).reqId as string
        : ''
    const plugin = this.running.get(instanceId)
    if (!plugin) return buildError(reqId, 'BAD_REQUEST', 'unknown plugin instance')
    if (this.isPluginStopping(plugin)) {
      return buildError(reqId, 'PLUGIN_STOPPING', 'plugin runtime is stopping')
    }
    // Agents reach third-party package code only through consented agent
    // tools (executeAgentToolCall), never through a view's instance id.
    if (this.pluginBackendHost.activationForPlugin(plugin.id)?.thirdParty !== undefined) {
      return buildError(reqId, 'CAPABILITY_DENIED', 'third-party backend methods are reachable only through agent tools')
    }
    if (
      !record ||
      !nonEmptyString(record.reqId) ||
      !nonEmptyString(record.name) ||
      !Object.prototype.hasOwnProperty.call(record, 'args') ||
      !isJsonValue(record.args) ||
      (record.timeoutMs !== undefined && !isAllowedBackendTimeout(record.timeoutMs))
    ) return buildError(reqId, 'BAD_REQUEST', 'malformed backend call')
    const storageAdmission = await this.plansInstanceStorageAdmission(plugin, reqId)
    if (storageAdmission) return storageAdmission
    const scopeError = this.backendCallScopeError(
      plugin,
      record.reqId,
      record.name,
      record.args,
    )
    if (scopeError) return scopeError
    if (!plugin.hasV2DescriptorIdentity || plugin.capabilityPolicy.kind !== 'manifest-v2') {
      return buildError(record.reqId, 'CAPABILITY_DENIED', 'agent calls require a Manifest v2 capability')
    }
    const initiator: AuthenticatedInitiator = Object.freeze({
      kind: 'agent',
      source: 'mcp',
      id: randomUUID(),
    })
    const context = this.capabilityContextForInitiator(plugin, initiator)
    const binding = context?.runtimeBinding
    if (
      !context ||
      !binding ||
      !sameRuntimeBinding(binding, plugin.capabilityContext?.runtimeBinding) ||
      !context.userGrant ||
      context.userGrant.packageVersion !== binding.packageVersion
    ) {
      return buildError(record.reqId, 'CAPABILITY_DENIED', 'agent capability context is unavailable')
    }
    if (plugin.id === PLANS_PLUGIN_ID && !this.isPlansBackendAvailable()) {
      return buildError(record.reqId, 'BACKEND_UNAVAILABLE', 'Plans agent backend is unavailable')
    }
    if (
      plugin.id === PLANS_PLUGIN_ID &&
      record.name === 'plans.create' &&
      !(await this.provisionPlansAssets(plugin.workspacePath ?? ''))
    ) {
      return buildError(record.reqId, 'BACKEND_UNAVAILABLE', 'Plans assets are unavailable')
    }
    try {
      const result = await this.pluginBackendHost.call(
        instanceId,
        record.name,
        record.args,
        {
          initiator,
          ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs }),
        },
      )
      return buildSuccess(record.reqId, result)
    } catch (error) {
      if (plugin.id === PLANS_PLUGIN_ID && this.plansCallFailureWithdraws(plugin, record.name, error)) {
        this.markPlansBackendUnavailable('child-unavailable')
      }
      return this.backendError(record.reqId, error)
    }
  }

  private publicPlanPolicyAllows(
    plan: PublicCapabilityExecutionPlan,
    plugin: RunningPlugin,
  ): boolean {
    const initiator = plan.initiator
    if (!initiator || initiator.kind !== 'agent') return true
    const namespace = plan.address.split('.', 1)[0]
    if (namespace !== 'fs' && namespace !== 'ui' && namespace !== 'aiCli' && namespace !== 'web' && namespace !== 'shell') {
      return true
    }
    let snapshot: ExecutionPolicySnapshot | undefined
    try {
      snapshot = this.executionPolicyResolver?.(plugin.workspacePath ?? undefined)
    } catch (error) {
      this.noteExecutionPolicyFailure(error)
      return false
    }
    if (!snapshot) return false
    if (snapshot.state === 'corrupt') return false
    if (plan.policyRevision !== undefined && snapshot.revision === plan.policyRevision) return true
    const entry = publicCapabilityEntry(plan.address)
    return executionPolicyAllows(
      initiator,
      snapshot,
      namespace,
      namespace === 'shell'
        ? (entry && entry.storage !== true ? entry.shellCommand : undefined) ?? String(plan.args.command)
        : undefined,
    )
  }

  private publicPlanCanDispatch(
    plan: PublicCapabilityExecutionPlan,
    plugin: RunningPlugin,
  ): boolean {
    return (
      this.running.get(plugin.instanceId) === plugin &&
      !this.isPluginStopping(plugin) &&
      sameRuntimeBinding(plugin.capabilityContext?.runtimeBinding, plan.runtime) &&
      this.publicPlanPolicyAllows(plan, plugin)
    )
  }

  private readonly executionPolicyFailuresNoted = new Set<string>()

  /** A resolver that throws still denies (fail closed), but used to do so with
   *  no trace at all. Each distinct failure is written once to main.log and
   *  the error ledger; repeats of it are not, since every agent call would
   *  otherwise log again. */
  private noteExecutionPolicyFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (this.executionPolicyFailuresNoted.has(message)) return
    if (this.executionPolicyFailuresNoted.size >= 50) this.executionPolicyFailuresNoted.clear()
    this.executionPolicyFailuresNoted.add(message)
    warnMain(`[plugin-backend] execution policy could not be read; agent calls are denied: ${message}`)
    recordMainFault('plugin.policy_resolver_failed', message)
  }

  private currentAgentExecutionPolicy(
    plugin: RunningPlugin,
    initiator: AuthenticatedInitiator | undefined,
  ): ExecutionPolicySnapshot | null {
    if (!initiator || initiator.kind !== 'agent') return null
    let snapshot: ExecutionPolicySnapshot | undefined
    try {
      snapshot = this.executionPolicyResolver?.(plugin.workspacePath ?? undefined)
    } catch (error) {
      this.noteExecutionPolicyFailure(error)
      return null
    }
    return snapshot && snapshot.state !== 'corrupt' ? snapshot : null
  }

  private async sendPublicBackend(
    wsType: string,
    payload: Record<string, unknown>,
    beforeDispatch?: () => boolean,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    const client = this.ensureBackend()
    if (!client) throw new Error('backend not connected')
    const response = await client.send(wsType, payload, timeoutMs, {
      ...(beforeDispatch ? { beforeDispatch } : {}),
    })
    if (!response.ok) throw new Error(response.error?.message ?? 'backend request failed')
    return response.payload
  }

  /** Revalidate the live Manifest/Grant pair at every private filesystem
   *  dispatch. A Grant revocation must take effect even for a child that was
   *  bound before the revocation; the backend child never owns this decision. */
  private plansFilesystemGrantAllows(context: PlansBridgeContext): boolean {
    const runtime = context.runtime
    if (
      runtime.pluginId !== PLANS_PLUGIN_ID ||
      !nonEmptyString(runtime.packageVersion) ||
      !nonEmptyString(context.workspacePath)
    ) return false
    const selection = this.plansBackendSelection()
    if (
      !selection ||
      selection.activation.packageVersion !== runtime.packageVersion ||
      !this.isPlansBackendAvailable()
    ) return false
    const expected = this.plansCapabilityContext(
      runtime.packageVersion,
      context.workspacePath,
      runtime.contributionKey ?? 'plans-window',
    )?.runtimeBinding
    return Boolean(
      expected &&
      runtime.pluginId === expected.pluginId &&
      runtime.packageVersion === expected.packageVersion &&
      runtime.workspaceId === expected.workspaceId &&
      runtime.contributionKey === expected.audience
    )
  }

  /** Name why a Plans filesystem Bridge request was refused. The child only
   *  forwards the bare code, so this line is the only record of the cause. */
  private warnPlansFilesystemDenied(operation: string, context: PlansBridgeContext): void {
    const selection = this.plansBackendSelection()
    const cause = context.signal.aborted ? 'request aborted'
      : !selection ? 'no exact Plans activation'
      : selection.activation.packageVersion !== context.runtime.packageVersion ? 'package version changed'
      : !this.isPlansBackendAvailable() ? 'v2 backend withdrawn'
      : 'Grant or execution policy mismatch'
    warnMain(
      `[plugin-backend] ${PLANS_PLUGIN_ID} filesystem ${operation} denied for ${
        context.runtime.contributionKey ?? 'unknown view'
      }: ${cause}`,
    )
  }

  private plansBridgeCanDispatch(context: PlansBridgeContext): boolean {
    if (context.signal.aborted) return false
    if (!nonEmptyString(context.workspacePath)) return false
    if (!this.plansFilesystemGrantAllows(context)) return false
    if (context.runtime.initiator.kind !== 'agent') return true
    return this.plansAgentFilesystemPolicyAllows(
      context.workspacePath,
      context.runtime.initiator,
    )
  }

  private async sendPlansFilesystemService(
    operation: PlansFilesystemServiceOperation,
    payload: Record<string, JsonValue>,
    context: PlansBridgeContext,
  ): Promise<JsonValue> {
    if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
    if (!this.plansBridgeCanDispatch(context)) {
      this.warnPlansFilesystemDenied(operation, context)
      throw new PlansBridgeError('CAPABILITY_DENIED', 'Filesystem capability is denied.')
    }
    try {
      const response = await this.sendPublicBackend(
        operation,
        payload,
        () => this.plansBridgeCanDispatch(context),
      )
      if (!isJsonValue(response)) {
        throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Filesystem service returned an invalid response.')
      }
      return response
    } catch (error) {
      if (error instanceof PlansBridgeError) throw error
      if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
      if (error instanceof Error && error.message === 'request denied before dispatch') {
        this.warnPlansFilesystemDenied(operation, context)
        throw new PlansBridgeError('CAPABILITY_DENIED', 'Filesystem capability is denied.')
      }
      throw new PlansBridgeError('BACKEND_UNAVAILABLE', 'Filesystem service is unavailable.')
    }
  }

  private setAiBindings(
    plugin: RunningPlugin,
    sessionBindings: ReadonlyMap<string, AuthenticatedRuntimeBinding>,
    pendingStartBindings: ReadonlyMap<string, AuthenticatedRuntimeBinding>
  ): void {
    if (!plugin.capabilityContext) return
    plugin.capabilityContext = {
      ...plugin.capabilityContext,
      sessionBindings: new Map(sessionBindings),
      pendingStartBindings: new Map(pendingStartBindings),
    }
  }

  private aiSessionMatchesPlugin(entry: AiSessionLedgerEntry, plugin: RunningPlugin): boolean {
    const binding = plugin.capabilityContext?.runtimeBinding
    return Boolean(
      binding &&
      entry.pluginId === plugin.id &&
      entry.packageVersion === binding.packageVersion &&
      entry.workspaceId === binding.workspaceId &&
      entry.audience === binding.audience
    )
  }

  private terminalStorageIdentity(plugin: RunningPlugin): AiTerminalStorageIdentity | null {
    const binding = plugin.capabilityContext?.runtimeBinding
    const workspacePath = plugin.workspacePath
    const contributionKey = plugin.contributionKey
    if (
      !binding ||
      !workspacePath ||
      !nonEmptyString(contributionKey) ||
      binding.pluginId !== plugin.id ||
      binding.instanceId !== plugin.instanceId ||
      binding.workspaceId !== this.workspaceIdForPath(workspacePath)
    ) return null
    return aiTerminalStorageIdentity({
      pluginId: binding.pluginId,
      contributionKey,
      workspacePath: resolve(workspacePath),
    })
  }

  private aiTerminalMetadataOrigin(plugin: RunningPlugin): string {
    return plugin.id === MINI_IDE_PLUGIN_ID ? 'mini-ide' : plugin.id
  }

  private terminalStorageCanDispatch(plugin: RunningPlugin): boolean {
    return this.running.get(plugin.instanceId) === plugin || plugin.releasing
  }

  private async terminalStorageRequest(
    plugin: RunningPlugin,
    request: TerminalStorageOwnerRequest,
    canDispatch: () => boolean,
  ): Promise<TerminalStorageOwnerState | null> {
    const handler = this.terminalStorageHandler
    const identity = this.terminalStorageIdentity(plugin)
    if (!handler || !identity) throw new Error('terminal storage is unavailable')
    return handler(identity.origin, request, canDispatch)
  }

  private bufferEarlyAiEvent(
    type: 'terminal.output' | 'terminal.exit',
    payload: unknown,
  ): boolean {
    const record = toPayload(payload)
    const paneId = typeof record.pane_id === 'string' ? record.pane_id : ''
    if (!paneId) return false
    const now = Date.now()
    for (const [key, buffer] of this.earlyAiEvents) {
      if (buffer.expiresAt <= now) this.earlyAiEvents.delete(key)
    }
    const pendingEntry = [...this.pendingAiStarts.entries()].find(([, pending]) => pending.paneId === paneId)
    if (!pendingEntry) return false
    const [key, pending] = pendingEntry
    const buffer = this.earlyAiEvents.get(key) ?? {
      instanceId: pending.pluginInstanceId,
      expiresAt: now + 5_000,
      events: [],
    }
    if (buffer.events.length >= 128) buffer.events.shift()
    buffer.events.push({ type, payload })
    this.earlyAiEvents.set(key, buffer)
    return true
  }

  private flushEarlyAiEvents(key: string): void {
    const buffer = this.earlyAiEvents.get(key)
    this.earlyAiEvents.delete(key)
    if (!buffer || buffer.expiresAt <= Date.now()) return
    for (const event of buffer.events) this.dispatchEvent(event.type, event.payload)
  }

  private cancelPendingAiStarts(plugin: RunningPlugin): void {
    for (const [key, pending] of this.pendingAiStarts) {
      if (pending.pluginInstanceId !== plugin.instanceId) continue
      this.pendingAiStarts.delete(key)
      this.earlyAiEvents.delete(key)
      void pending.client.send('terminal.create.cancel', {
        pane_id: pending.paneId,
        create_generation: pending.requestId,
      }).catch(() => {
        // Teardown still owns cancellation even when the backend is gone.
      })
    }
  }

  private clearAiTerminalPersistence(
    plugin: RunningPlugin,
    entry: AiSessionLedgerEntry,
  ): void {
    if (!entry.persistView || !entry.storageIdentity || !this.terminalStorageHandler) return
    void (async () => {
      const canDispatch = (): boolean => this.terminalStorageCanDispatch(plugin)
      await this.terminalStorageRequest(plugin, {
        operation: 'session',
        resumeKey: entry.storageIdentity!.resumeKey,
        ptyId: null,
      }, canDispatch)
      await this.terminalStorageRequest(plugin, {
        operation: 'snapshot',
        resumeKey: entry.storageIdentity!.resumeKey,
        snapshots: [],
      }, canDispatch)
      await this.terminalStorageRequest(plugin, {
        operation: 'release',
        resumeKey: entry.storageIdentity!.resumeKey,
      }, canDispatch)
    })().catch((error) => console.warn(
      `[plugins] AI terminal storage clear failed for ${plugin.id} (${entry.sessionId})`, error))
  }

  private clearDeadAiTerminalSession(
    plugin: RunningPlugin,
    identity: AiTerminalStorageIdentity,
  ): void {
    if (!this.terminalStorageHandler) return
    void this.terminalStorageRequest(plugin, {
      operation: 'session',
      resumeKey: identity.resumeKey,
      ptyId: null,
    }, () => this.publicPlanCanDispatchForPlugin(plugin)).catch((error) => console.warn(
      `[plugins] AI terminal storage could not forget a dead session for ${plugin.id}`, error))
  }

  private publicPlanCanDispatchForPlugin(plugin: RunningPlugin): boolean {
    return this.running.get(plugin.instanceId) === plugin && !this.isPluginStopping(plugin)
  }

  private releaseAiTerminalOwner(plugin: RunningPlugin, identity: AiTerminalStorageIdentity): void {
    // During an app quit the owner views are already being torn down.
    if (!this.terminalStorageHandler || this.appQuitting()) return
    const hasSibling = [...this.running.values()].some((candidate) =>
      candidate !== plugin && this.terminalStorageIdentity(candidate)?.resumeKey === identity.resumeKey)
    if (hasSibling) return
    void this.terminalStorageRequest(plugin, {
      operation: 'release',
      resumeKey: identity.resumeKey,
    }, () => this.terminalStorageCanDispatch(plugin)).catch((error) => console.warn(
      `[plugins] AI terminal storage release failed for ${plugin.id}`, error))
  }

  private removeAiSession(plugin: RunningPlugin, sessionId: string, clean = false): void {
    this.filePickerHost?.cancelSession(plugin.instanceId, sessionId)
    const sessions = new Map(plugin.capabilityContext?.sessionBindings ?? [])
    sessions.delete(sessionId)
    const entry = this.aiSessions.get(sessionId)
    this.aiSessions.delete(sessionId)
    this.setAiBindings(plugin, sessions, plugin.capabilityContext?.pendingStartBindings ?? new Map())
    if (clean && entry) this.clearAiTerminalPersistence(plugin, entry)
  }

  /** Share links for the Plans view. The backend's share.* error codes
   *  (SHARE_REFUSED with a reason, NO_SYNC_KEY, NOT_CONFIGURED, server codes)
   *  come back as values: a thrown error reaches the plugin collapsed into a
   *  generic capability code. The plugin names a plan by its relative path;
   *  the Host resolves it inside the plans root, as for ui.openPlansWindow. */
  private async executeShareCapability(
    plan: PublicCapabilityExecutionPlan,
    plugin: RunningPlugin,
    workspacePath: string | null | undefined
  ): Promise<Record<string, unknown>> {
    let type = 'share.caps'
    let payload: Record<string, unknown> = {}
    if (plan.address === 'ui.shareCreate') {
      if (!workspacePath) throw new Error('share capability requires a workspace')
      const path = typeof plan.args.path === 'string' ? plan.args.path : ''
      if (!path || isAbsolute(path)) throw new Error('share path must be relative')
      const root = resolve(resolvePlansRootPath(workspacePath))
      const relativePath = relative(root, resolve(root, path))
      if (!isAllowedPlanDocumentPath(relativePath, root)) {
        throw new Error('share path is outside the plans directory')
      }
      // The document the check accepted, symlinks resolved: the backend
      // must open that file, not re-resolve the string it was checked by.
      const canonicalDoc = resolveWorkspaceRelativePath(root, relativePath.replace(/\\/g, '/'), false)
      if (!canonicalDoc) throw new Error('share path is outside the plans directory')
      type = 'share.create'
      payload = {
        path: canonicalDoc,
        kind: 'plan',
        ...(typeof plan.args.ttlSeconds === 'number' ? { ttlSeconds: plan.args.ttlSeconds } : {}),
        ...(typeof plan.args.requireLogin === 'boolean' ? { requireLogin: plan.args.requireLogin } : {}),
        ...(typeof plan.args.sendToChat === 'boolean' ? { sendToChat: plan.args.sendToChat } : {}),
        ...(typeof plan.args.chatId === 'string' ? { chatId: plan.args.chatId } : {}),
      }
    }
    if (plan.address === 'ui.shareChatTargets') type = 'channels.share_targets'
    const client = this.ensureBackend()
    if (!client) return { ok: false, code: 'BACKEND_UNAVAILABLE', message: 'backend not connected' }
    const response = await client.send(type, payload, 60_000, {
      beforeDispatch: () => this.publicPlanCanDispatch(plan, plugin),
    })
    if (!response.ok) {
      const reason = response.error?.details?.reason
      return {
        ok: false,
        code: response.error?.code ?? 'BACKEND_ERROR',
        message: response.error?.message ?? '',
        ...(typeof reason === 'string' ? { reason } : {}),
      }
    }
    if (type === 'share.caps') return { ok: true }
    if (type === 'channels.share_targets') {
      const chats = toPayload(response.payload).chats
      return {
        ok: true,
        chats: Array.isArray(chats)
          ? chats.flatMap((chat) => {
              const { chatId, platform, name } = toPayload(chat)
              return typeof chatId === 'string' && typeof platform === 'string' && typeof name === 'string'
                ? [{ chatId, platform, name }]
                : []
            })
          : [],
      }
    }
    const created = toPayload(response.payload)
    return {
      ok: true,
      link: {
        linkId: created.linkId,
        url: created.url,
        expiresAt: created.expiresAt,
        masked: Array.isArray(created.masked) ? created.masked : [],
      },
    }
  }

  private async executeAiCliCapability(
    plan: PublicCapabilityExecutionPlan,
    plugin: RunningPlugin,
    workspacePath: string
  ): Promise<unknown> {
    if (plan.address === 'aiCli.listProfiles') {
      const allowedProfileIds = new Set(plugin.capabilityContext?.aiCliProfiles ?? [])
      const terminalView = toPayload(plan.args).terminalView === true
      const profiles = terminalView ? TERMINAL_AI_CLI_PROFILES : AI_CLI_PROFILES
      return {
        profiles: Object.entries(profiles)
          .filter(([id]) => allowedProfileIds.has(id))
        .map(([id, profile]) => ({
            id,
            label: 'label' in profile && typeof profile.label === 'string' ? profile.label : id,
            ...(terminalView && FULL_SCREEN_AI_CLI_PROFILES.includes(id) ? { fullScreenTui: true } : {}),
            ...(terminalView && BRACKETED_PASTE_AI_CLI_PROFILES.includes(id) ? { bracketedPaste: true } : {}),
            ...(terminalView && AI_CLI_SHIFT_ENTER_SEQUENCES[id]
              ? { shiftEnterSequence: AI_CLI_SHIFT_ENTER_SEQUENCES[id] }
              : {}),
          })),
      }
    }
    const args = plan.args
    const beforeDispatch = (): boolean => this.publicPlanCanDispatch(plan, plugin)
    if (
      plan.address === 'aiCli.readTerminalView' ||
      plan.address === 'aiCli.saveTerminalView' ||
      plan.address === 'aiCli.setTerminalFontSize'
    ) {
      const identity = this.terminalStorageIdentity(plugin)
      if (!identity || !this.terminalStorageHandler) {
        throw new Error('terminal storage is unavailable')
      }
      if (plan.address === 'aiCli.readTerminalView') {
        const state = await this.terminalStorageRequest(plugin, {
          operation: 'read',
          resumeKey: identity.resumeKey,
        }, beforeDispatch)
        return {
          fontSize: state?.fontSize ?? 12,
          lastSize: state?.lastSize ?? null,
          snapshot: state?.snapshot ?? null,
        }
      }
      if (plan.address === 'aiCli.saveTerminalView') {
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
        const binding = plugin.capabilityContext?.runtimeBinding
        const sessionBinding = sessionId && plugin.capabilityContext?.sessionBindings?.get(sessionId)
        if (!binding || !sessionBinding || !sameRuntimeBinding(sessionBinding, binding)) {
          throw new Error('AI CLI session is no longer owned by this view')
        }
        await this.terminalStorageRequest(plugin, {
          operation: 'snapshot',
          resumeKey: identity.resumeKey,
          snapshots: Array.isArray(args.snapshots)
            ? args.snapshots.filter((snapshot): snapshot is string => typeof snapshot === 'string')
            : [],
        }, beforeDispatch)
        return {}
      }
      await this.terminalStorageRequest(plugin, {
        operation: 'font',
        fontSize: Number(args.fontSize),
      }, beforeDispatch)
      return {}
    }
    const runtimeBinding = plugin.capabilityContext?.runtimeBinding
    if (
      plan.address === 'aiCli.showTerminalContextMenu' ||
      plan.address === 'aiCli.reportTerminalSelection'
    ) {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
      if (sessionId) {
        const sessionBinding = plugin.capabilityContext?.sessionBindings?.get(sessionId)
        if (!sessionBinding || !runtimeBinding || !sameRuntimeBinding(sessionBinding, runtimeBinding)) {
          throw new Error('AI CLI session is no longer owned by this view')
        }
      }
      return executeAiTerminalResource(
        plan.address,
        args,
        plugin.view.webContents,
        beforeDispatch,
      )
    }
    if (plan.address === 'aiCli.saveClipboardImage') {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
      const sessionBinding = sessionId
        ? plugin.capabilityContext?.sessionBindings?.get(sessionId)
        : undefined
      if (!sessionId || !sessionBinding || !runtimeBinding || !sameRuntimeBinding(sessionBinding, runtimeBinding)) {
        throw new Error('AI CLI session is no longer owned by this view')
      }
      return executeAiTerminalResource(
        plan.address,
        args,
        plugin.view.webContents,
        beforeDispatch,
      )
    }
    const requestedStartProfileId = plan.address === 'aiCli.startSession'
      ? String(args.profileId)
      : null
    if (
      requestedStartProfileId !== null &&
      !(plugin.capabilityContext?.aiCliProfiles ?? []).includes(requestedStartProfileId)
    ) {
      throw new Error(`AI CLI profile '${requestedStartProfileId}' is not available`)
    }
    const client = this.ensureBackend()
    if (!client) throw new Error('backend not connected')
    if (plan.address === 'aiCli.resumeSession') {
      const persistView = args.persistView === true
      const storageIdentity = persistView ? this.terminalStorageIdentity(plugin) : null
      if (persistView && (!storageIdentity || !this.terminalStorageHandler)) {
        throw new Error('terminal storage is unavailable')
      }
      const candidate = [...this.aiSessions.values()]
        .filter((entry) => entry.attachedInstanceId === null && this.aiSessionMatchesPlugin(entry, plugin))
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (
        candidate &&
        !(plugin.capabilityContext?.aiCliProfiles ?? []).includes(candidate.profileId)
      ) return null
      let ownerState: TerminalStorageOwnerState | null = null
      let ownerSessionId: string | null = null
      if (!candidate && persistView && storageIdentity) {
        ownerState = await this.terminalStorageRequest(plugin, {
          operation: 'read',
          resumeKey: storageIdentity.resumeKey,
        }, beforeDispatch)
        ownerSessionId = ownerState?.ptyId ?? null
        if (!ownerSessionId) return null
        const attached = [...this.aiSessions.values()].find((entry) =>
          entry.sessionId === ownerSessionId && entry.attachedInstanceId !== null)
        if (attached) return null
      }
      if (!candidate && !ownerSessionId) return null
      const sessionId = candidate?.sessionId ?? ownerSessionId!
      const response = await client.send(
        'terminal.reattach',
        {
          terminal_session_ids: [sessionId],
          cols: Number(args.cols),
          rows: Number(args.rows),
          ...(persistView && storageIdentity
            ? {
                expected_workspace_path: resolve(workspacePath),
                expected_origin: this.aiTerminalMetadataOrigin(plugin),
                expected_profile_ids: [...(plugin.capabilityContext?.aiCliProfiles ?? [])],
              }
            : {}),
        },
        10_000,
        { beforeDispatch },
      )
      if (!response.ok) throw new Error(response.error?.message ?? 'AI CLI resume failed')
      const alive = toPayload(response.payload).alive
      if (!Array.isArray(alive) || !alive.includes(sessionId)) {
        if (ownerState && storageIdentity) this.clearDeadAiTerminalSession(plugin, storageIdentity)
        if (candidate) {
          this.aiSessions.delete(candidate.sessionId)
          this.terminalRoutes.delete(candidate.sessionId)
        }
        return null
      }
      const responseRecord = toPayload(response.payload)
      const recovered = !candidate && ownerState && storageIdentity
        ? toPayload(toPayload(responseRecord.sessions)[sessionId])
        : {}
      const profileId = candidate?.profileId ??
        (typeof recovered.agent_key === 'string' ? recovered.agent_key :
          typeof recovered.profile_id === 'string' ? recovered.profile_id :
            typeof recovered.profileId === 'string' ? recovered.profileId : '')
      if (!candidate && ownerState && storageIdentity) {
        const allowedProfiles = plugin.capabilityContext?.aiCliProfiles ?? []
        const recoveredWorkspace = typeof recovered.workspace_path === 'string'
          ? resolvePathForContainment(recovered.workspace_path)
          : null
        const expectedWorkspace = resolvePathForContainment(workspacePath)
        const recoveredOrigin = typeof recovered.origin === 'string' ? recovered.origin : ''
        if (
          !profileId ||
          !allowedProfiles.includes(profileId) ||
          !expectedWorkspace ||
          recoveredWorkspace !== expectedWorkspace ||
          (recoveredOrigin !== 'editor' && recoveredOrigin !== this.aiTerminalMetadataOrigin(plugin))
        ) {
          this.clearDeadAiTerminalSession(plugin, storageIdentity)
          return null
        }
      }
      if (!profileId) {
        if (ownerState && storageIdentity) this.clearDeadAiTerminalSession(plugin, storageIdentity)
        return null
      }
      this.noteTerminalRoutes(plugin.instanceId, 'terminal.reattach', response.payload)
      if (candidate) candidate.attachedInstanceId = plugin.instanceId
      const binding = plugin.capabilityContext?.runtimeBinding
      if (!binding) throw new Error('AI CLI runtime binding is missing')
      const sessions = new Map(plugin.capabilityContext?.sessionBindings ?? [])
      sessions.set(sessionId, binding)
      this.setAiBindings(plugin, sessions, plugin.capabilityContext?.pendingStartBindings ?? new Map())
      if (!candidate) {
        this.aiSessions.set(sessionId, {
          sessionId,
          profileId,
          pluginId: binding.pluginId,
          packageVersion: binding.packageVersion,
          workspaceId: binding.workspaceId,
          audience: binding.audience,
          attachedInstanceId: plugin.instanceId,
          client,
          createdAt: Date.now(),
          persistView: true,
          storageIdentity: storageIdentity ?? undefined,
        })
      }
      return { sessionId, profileId }
    }
    if (plan.address === 'aiCli.startSession') {
      const profileId = requestedStartProfileId!
      const persistView = args.persistView === true
      const storageIdentity = persistView ? this.terminalStorageIdentity(plugin) : null
      if (persistView && (!storageIdentity || !this.terminalStorageHandler)) {
        throw new Error('terminal storage is unavailable')
      }
      const requestId = nonEmptyString(args.requestId) ? args.requestId : randomUUID()
      const paneId = `navide-${plugin.id}-${plugin.instanceId}-${requestId}`
      const pending = new Map(plugin.capabilityContext?.pendingStartBindings ?? [])
      const binding = plugin.capabilityContext?.runtimeBinding
      if (!binding) throw new Error('AI CLI runtime binding is missing')
      pending.set(requestId, binding)
      this.setAiBindings(plugin, plugin.capabilityContext?.sessionBindings ?? new Map(), pending)
      const pendingKey = `${plugin.instanceId}:${requestId}`
      this.pendingAiStarts.set(pendingKey, {
        pluginInstanceId: plugin.instanceId,
        paneId,
        requestId,
        client,
      })
      let committed = false
      try {
        let command: string | string[] | null
        let persistedYolo = false
        if (persistView && storageIdentity) {
        // Persisted views inherit the Host's current shell and the same
        // per-profile settings as the built-in AI dock. Neither setting is
        // accepted from the package request.
          const settingsPayload = await this.sendPublicBackend(
            'ui.settings.get',
            {},
            beforeDispatch,
          )
          const settings = toPayload(settingsPayload).settings
          const stored = toPayload(settings)
          const permissionStored = stored[`agentTeam.cliPermission.${profileId}`]
          const yoloStored = stored['agentTeam.yolo']
          persistedYolo = permissionStored === 'force-on' ||
            (permissionStored !== 'force-off' && (yoloStored == null || yoloStored === '1'))
          command = aiTerminalCommand({
            profileId,
            workspacePath,
            resumeKey: storageIdentity.resumeKey,
            shell: this.terminalShell,
            yoloStored,
            permissionStored,
          })
        } else {
          command = this.aiCliCommand(profileId, args, workspacePath)
        }
        if (!command) throw new Error(`AI CLI profile '${profileId}' is not available`)
        const response = await client.send(
          'terminal.create',
          {
            pane_id: paneId,
            create_generation: requestId,
            agent_key: profileId,
            // The Host chooses the executable from the allowlisted profile. The
            // package never supplies a command, shell, cwd, or environment.
            command,
            cwd: workspacePath,
            cols: args.cols,
            rows: args.rows,
            metadata: {
              workspace_path: workspacePath,
              origin: persistView ? this.aiTerminalMetadataOrigin(plugin) : plugin.id,
              ...(persistView ? { yolo: persistedYolo } : {}),
            },
          },
          10_000,
          { beforeDispatch },
        )
        if (!response.ok) throw new Error(response.error?.message ?? 'AI CLI start failed')
        const result = toPayload(response.payload)
        const sessionId = typeof result.terminal_session_id === 'string' ? result.terminal_session_id : ''
        if (!sessionId) throw new Error('AI CLI start returned no session id')
        this.noteTerminalRoutes(plugin.instanceId, 'terminal.create', result)
        const sessions = new Map(plugin.capabilityContext?.sessionBindings ?? [])
        sessions.set(sessionId, binding)
        this.setAiBindings(plugin, sessions, plugin.capabilityContext?.pendingStartBindings ?? new Map())
        this.aiSessions.set(sessionId, {
          sessionId,
          profileId,
          pluginId: binding.pluginId,
          packageVersion: binding.packageVersion,
          workspaceId: binding.workspaceId,
          audience: binding.audience,
          attachedInstanceId: plugin.instanceId,
          client,
          createdAt: Date.now(),
          persistView,
          storageIdentity: storageIdentity ?? undefined,
        })
        if (persistView && storageIdentity) {
          await this.terminalStorageRequest(plugin, {
            operation: 'session',
            resumeKey: storageIdentity.resumeKey,
            ptyId: sessionId,
          }, beforeDispatch).catch((error) => console.warn(
            `[plugins] AI terminal storage could not bind session ${sessionId} for ${plugin.id}; it will not resume`, error))
        }
        committed = true
        this.flushEarlyAiEvents(pendingKey)
        return { sessionId }
      } finally {
        const nextPending = new Map(plugin.capabilityContext?.pendingStartBindings ?? [])
        nextPending.delete(requestId)
        this.setAiBindings(plugin, plugin.capabilityContext?.sessionBindings ?? new Map(), nextPending)
        this.pendingAiStarts.delete(pendingKey)
        if (!committed) this.earlyAiEvents.delete(pendingKey)
      }
    }

    if (plan.address === 'aiCli.cancelStart') {
      const requestId = String(args.requestId)
      const pending = this.pendingAiStarts.get(`${plugin.instanceId}:${requestId}`)
      if (!pending) throw new Error('AI CLI start request is no longer pending')
      const response = await pending.client.send(
        'terminal.create.cancel',
        {
          pane_id: pending.paneId,
          create_generation: pending.requestId,
        },
        10_000,
        { beforeDispatch },
      )
      if (!response.ok) throw new Error(response.error?.message ?? 'AI CLI cancel failed')
      const pendingBindings = new Map(plugin.capabilityContext?.pendingStartBindings ?? [])
      pendingBindings.delete(requestId)
      this.setAiBindings(plugin, plugin.capabilityContext?.sessionBindings ?? new Map(), pendingBindings)
      this.pendingAiStarts.delete(`${plugin.instanceId}:${requestId}`)
      return {}
    }
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
    if (!sessionId) throw new Error('AI CLI session id is required')
    const sessionBinding = plugin.capabilityContext?.sessionBindings?.get(sessionId)
    if (!sessionBinding || !runtimeBinding || !sameRuntimeBinding(sessionBinding, runtimeBinding)) {
      throw new Error('AI CLI session is no longer owned by this view')
    }
    if (plan.address === 'aiCli.listMentionTargets') {
      const response = await this.sendPublicBackend('agent_msg.list', {}, beforeDispatch)
      const panes = toPayload(response).panes
      const targets = Array.isArray(panes)
        ? panes.flatMap((pane): Array<{ address: string; group?: string }> => {
            if (typeof pane !== 'object' || pane === null || Array.isArray(pane)) return []
            const record = pane as Record<string, unknown>
            if (typeof record.qualified_name !== 'string' || record.qualified_name.length === 0) return []
            const group = typeof record.workspace_label === 'string' && record.workspace_label.length > 0
              ? record.workspace_label
              : undefined
            return [{ address: record.qualified_name, ...(group ? { group } : {}) }]
          })
        : []
      return { targets }
    }
    if (plan.address === 'aiCli.reattachSession') {
      const response = await client.send(
        'terminal.reattach',
        {
          terminal_session_ids: [sessionId],
          cols: Number(args.cols),
          rows: Number(args.rows),
        },
        10_000,
        { beforeDispatch },
      )
      if (!response.ok) throw new Error(response.error?.message ?? 'AI CLI reattach failed')
      const alive = toPayload(response.payload).alive
      if (!Array.isArray(alive) || !alive.includes(sessionId)) {
        throw new Error('AI CLI session is no longer alive')
      }
      this.noteTerminalRoutes(plugin.instanceId, 'terminal.reattach', response.payload)
      return { sessionId }
    }
    const wsType: Record<string, string> = {
      'aiCli.sendInput': 'terminal.input',
      'aiCli.resizeSession': 'terminal.resize',
      'aiCli.redrawSession': 'terminal.redraw',
      'aiCli.interruptSession': 'terminal.interrupt',
      'aiCli.stopSession': 'terminal.kill',
    }
    const type = wsType[plan.address]
    if (!type) throw new Error(`unsupported AI CLI capability '${plan.address}'`)
    const payload: Record<string, unknown> = { terminal_session_id: sessionId }
    if (type === 'terminal.input') payload.data = args.data
    if (type === 'terminal.resize' || type === 'terminal.redraw') {
      payload.cols = args.cols
      payload.rows = args.rows
    }
    if (type === 'terminal.kill') payload.force = args.force === true
    const response = await client.send(type, payload, 10_000, { beforeDispatch })
    if (!response.ok) throw new Error(response.error?.message ?? 'AI CLI request failed')
    if (type === 'terminal.resize') {
      const entry = this.aiSessions.get(sessionId)
      if (entry?.persistView && entry.storageIdentity) {
        await this.terminalStorageRequest(plugin, {
          operation: 'size',
          cols: Number(args.cols),
          rows: Number(args.rows),
        }, beforeDispatch).catch((error) => console.warn(
          `[plugins] AI terminal storage could not save the size of ${sessionId} for ${plugin.id}`, error))
      }
    }
    if (type === 'terminal.kill') {
      this.removeAiSession(plugin, sessionId, true)
      this.terminalRoutes.delete(sessionId)
    }
    return {}
  }

  /** Resolve the small semantic AI CLI contract into a Host-owned command.
   * The package can select a registered profile and pane identity only; it
   * cannot provide an executable, shell fragment, cwd, or environment. */
  private aiCliCommand(
    profileId: string,
    args: Record<string, unknown>,
    workspacePath: string
  ): string | string[] | null {
    const profile = AI_CLI_PROFILES[profileId as keyof typeof AI_CLI_PROFILES]
    if (!profile || !workspacePath) return null
    const parts: string[] = [profile.command]
    if (profileId === 'aider') {
      const paneId = typeof args.paneId === 'string' ? args.paneId : ''
      const token = paneId.slice(0, 8).toLowerCase()
      const historyName = /^[0-9a-f]{8}$/.test(token)
        ? `.aider.chat.history.${token}.md`
        : '.aider.chat.history.md'
      parts.push('--chat-history-file', quoteCommandWord(join(workspacePath, historyName)))
    }
    if (args.yolo === true && 'yoloFlag' in profile && profile.yoloFlag) parts.push(profile.yoloFlag)
    return buildAgentPaneCommand(this.terminalShell, parts)
  }

  /** Install the Host-owned durable storage adapter for an already-authorized
   * storage plan. The adapter receives only the derived partition and snapshot
   * identity; it never receives the raw renderer request as an authority. */
  /** Host-owned projection from a manifest icon file to a paintable URL, shared
   *  by the main window's contribution list and receiver catalogues. */
  setContributionIconResolver(
    fn: ((iconFile: string) => { url: string; monochrome?: boolean } | null) | null
  ): void {
    this.contributionIconResolver = fn
  }

  setPublicStorageHandler(
    fn: ((execution: StorageExecution) => unknown | Promise<unknown>) | null
  ): void {
    this.publicStorageHandler = fn
  }

  setTerminalStorageHandler(
    fn: ((
      origin: TerminalOwnerOrigin,
      request: TerminalStorageOwnerRequest,
      canDispatch: () => boolean,
    ) => Promise<TerminalStorageOwnerState | null>) | null,
  ): void {
    this.terminalStorageHandler = fn
  }

  setMiniIdeLegacyPreferences(adapter: MiniIdeLegacyPreferences | null): void {
    this.miniIdeLegacyPreferences = adapter
  }

  /** Notify matching instances after a successful public storage mutation.
   * The event source is each receiver's current Host binding, while the
   * snapshot identity and partition scope come from the authenticated plan. */
  private dispatchPluginStorageChanged(
    plan: PublicCapabilityExecutionPlan,
    scope: 'plugin' | 'workspace',
    key: string,
    value: JsonValue,
    deleted: boolean,
  ): void {
    if (!plan.storage || !isStorageExecutionAddress(plan.address)) return
    const snapshot = plan.storage.snapshot
    const workspaceId = plan.storage.partition.workspaceId
    const payload = { scope, key, value, deleted }
    for (const receiver of this.running.values()) {
      const context = receiver.capabilityContext
      const binding = context?.runtimeBinding
      if (
        !context ||
        !binding ||
        binding.pluginId !== plan.runtime.pluginId ||
        binding.packageVersion !== snapshot.packageVersion ||
        context.storageSnapshotTier !== snapshot.tier ||
        context.storageSnapshots?.get(snapshot.tier) !== snapshot.packageVersion ||
        (scope === 'workspace' && binding.workspaceId !== workspaceId)
      ) continue
      if (this.isPublicEventAllowedForInstance(receiver, 'ui.pluginStorageChanged', payload, binding)) {
        this.emitToInstance(receiver.instanceId, 'ui.pluginStorageChanged', payload)
      }
    }
  }

  /** `web.changed` to every live instance of the plugin whose grant allows it. */
  private dispatchWebChanged(pluginId: string, views: WebViewInfo[]): void {
    const payload = { views }
    for (const receiver of this.running.values()) {
      const binding = receiver.capabilityContext?.runtimeBinding
      if (!binding || binding.pluginId !== pluginId || this.isPluginStopping(receiver)) continue
      if (this.isPublicEventAllowedForInstance(receiver, 'web.changed', payload, binding)) {
        this.emitToInstance(receiver.instanceId, 'web.changed', payload)
      }
    }
  }

  /** Host-only event ingress for cataloged public events. The target package id
   * is Host-selected and never comes from renderer payload. The source binding
   * must come from the Host producer, not the master package context: AI CLI
   * output/exit requires the exact per-instance binding (including instanceId
   * and audience), while workspace.filesChanged accepts the reserved Host
   * source with matching workspace/packageVersion. Unbound shared-WS fan-out
   * is intentionally dropped by {@link dispatchEvent}. */
  dispatchPublicCapabilityEvent(
    targetPluginId: string,
    event: string,
    payload: unknown,
    sourceBinding: AuthenticatedRuntimeBinding
  ): void {
    if (
      typeof targetPluginId !== 'string' ||
      targetPluginId.length === 0 ||
      !PUBLIC_CAPABILITY_EVENT_ADDRESSES.includes(event)
    ) {
      return
    }
    this.dispatchEvent(event, payload, sourceBinding, targetPluginId)
  }

  /** Route only the fixed Host-owned settings contract to v2 views. */
  dispatchHostSettingsChanged(payload: unknown): void {
    const rawSettings =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).settings
        : null
    if (typeof rawSettings !== 'object' || rawSettings === null || Array.isArray(rawSettings)) return
    const preferences = projectEditorPreferences(rawSettings)
    if (Object.keys(preferences).length > 0) {
      for (const plugin of this.running.values()) {
        const binding = plugin.capabilityContext?.runtimeBinding
        if (binding && this.isPublicEventAllowedForInstance(
          plugin,
          'ui.editorPreferencesChanged',
          { preferences },
          binding,
        )) {
          this.emitToInstance(plugin.instanceId, 'ui.editorPreferencesChanged', { preferences })
        }
      }
    }
    const allowedKeys: readonly string[] = [...GIT_HOST_READ_ONLY_KEYS, 'agent-team:language']
    const settings = Object.fromEntries(
      Object.entries(rawSettings as Record<string, unknown>)
        .filter(([key]) => allowedKeys.includes(key))
    )
    if (Object.keys(settings).length === 0) return
    this.dispatchEvent('ui.settings_changed', { source: 'host', settings })
  }

  /** Main-registered handlers for the shell-level host capabilities
   *  (open_external / reveal_path / open_workspace / pick_folder). index.ts
   *  wires them to shell.openExternal / shell.showItemInFolder /
   *  window:openMain / dialog.showOpenDialog respectively. */
  private hostShellHandlers: {
    openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
    revealPath: (path: string) => { ok: boolean; error?: string }
    openWorkspace: (workspacePath: string) => { ok: boolean }
    pickFolder: (defaultPath?: string) => Promise<string | null>
  } | null = null

  setHostShellHandlers(handlers: NonNullable<FrontendPluginManager['hostShellHandlers']>): void {
    this.hostShellHandlers = handlers
  }

  /** Service a host-implemented capability call (see HOST_CAPABILITIES). */
  private async runHostAction(
    call: CapabilityCall,
    plugin: RunningPlugin
  ): Promise<CapabilityResponse> {
    const args = (typeof call.args === 'object' && call.args !== null ? call.args : {}) as Record<
      string,
      unknown
    >
    const action = HOST_CAPABILITIES[`${call.ns}.${call.method}`]

    if (action === 'open_in_editor') {
      // The root defaults to the query the HOST launched this view with. A
      // call MAY name its own `workspace_path` — that is how a view opens a
      // file that lives outside the workspace it was given (the safety
      // boundary for such opens sits in the caller, by product decision).
      // The target is handed to the mini-IDE or (as a fallback) to the OS
      // default app.
      const callerRoot = typeof args.workspace_path === 'string' ? args.workspace_path : ''
      const workspacePath = callerRoot || workspaceOf(plugin.query)
      const filepath = typeof args.filepath === 'string' ? args.filepath : ''
      if (!workspacePath || !filepath) {
        return buildError(call.reqId, 'BAD_REQUEST', 'filepath is required inside a workspace view')
      }
      // Containment: resolve against the root and keep only targets that stay
      // under it, so neither '../' traversal nor an absolute path can reach a
      // file outside it. This holds for a caller-supplied root too: naming the
      // file's own root is the supported way to reach it, so the target never
      // needs to escape whichever root won.
      const root = resolve(workspacePath)
      const rel = relative(root, resolve(root, filepath))
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return buildError(call.reqId, 'BAD_REQUEST', 'filepath escapes the root')
      }
      const pairedOpened = await this.openPairedEditorTarget(
        plugin, root, rel, args.line, args.column,
      )
      if (pairedOpened !== null) return buildSuccess(call.reqId, { ok: true, opened: pairedOpened })
      const handler = this.openInEditorHandler
      if (!handler) {
        return buildError(call.reqId, 'BACKEND_ERROR', 'editor open handler not registered')
      }
      // Hand the RESOLVED root downstream: an unnormalized one ('/ws/sub/..')
      // passes containment yet reads as a different view identity, which would
      // reload the mini-IDE for a file that is in fact inside its workspace.
      const opened = await handler({ workspace_path: root, filepath: rel })
      return buildSuccess(call.reqId, { ok: true, opened })
    }

    // Shell-level actions. reveal_path / open_workspace intentionally accept
    // absolute paths outside the view's workspace: their legitimate targets
    // are git worktrees, which live beside (not under) the repo root. Both are
    // display-only surfaces (file manager reveal / opening a Navide window);
    // neither reads nor writes the target, and only first-party `navide.*`
    // plugins can be granted `ui` (reserved publisher namespace).
    const shell = this.hostShellHandlers
    if (!shell) {
      return buildError(call.reqId, 'BACKEND_ERROR', 'host shell handlers not registered')
    }
    if (action === 'open_external') {
      const url = typeof args.url === 'string' ? args.url : ''
      if (!/^https?:\/\/[^\s]+$/i.test(url)) {
        return buildError(call.reqId, 'BAD_REQUEST', 'only http/https urls allowed')
      }
      const r = await shell.openExternal(url)
      return r.ok
        ? buildSuccess(call.reqId, { ok: true })
        : buildError(call.reqId, 'BACKEND_ERROR', r.error ?? 'open failed')
    }
    if (action === 'reveal_path') {
      const path = typeof args.path === 'string' ? args.path : ''
      if (!path || !isAbsolute(path)) {
        return buildError(call.reqId, 'BAD_REQUEST', 'an absolute path is required')
      }
      const r = shell.revealPath(path)
      return r.ok
        ? buildSuccess(call.reqId, { ok: true })
        : buildError(call.reqId, 'BACKEND_ERROR', r.error ?? 'reveal failed')
    }
    if (action === 'open_workspace') {
      const workspacePath = typeof args.workspace_path === 'string' ? args.workspace_path : ''
      if (!workspacePath || !isAbsolute(workspacePath)) {
        return buildError(call.reqId, 'BAD_REQUEST', 'an absolute workspace_path is required')
      }
      const r = shell.openWorkspace(workspacePath)
      return buildSuccess(call.reqId, { ok: r.ok })
    }
    if (action === 'pick_folder') {
      const defaultPath = typeof args.default_path === 'string' ? args.default_path : undefined
      const picked = await shell.pickFolder(defaultPath)
      return buildSuccess(call.reqId, { ok: true, path: picked })
    }
    return buildError(call.reqId, 'UNKNOWN', `no host action '${String(action)}'`)
  }

  /** Fan a transport status transition out to every backend-needing plugin as
   *  the host-synthesized `nav.backend_status` event, so plugin-side useBackend
   *  shims track real liveness instead of assuming 'connected'. */
  private dispatchBackendStatus(status: WsClientStatus): void {
    this.wsStatus = status
    for (const plugin of this.running.values()) {
      if (plugin.requires.length > 0 && plugin.capabilityPolicy.kind !== 'manifest-v2') {
        this.emitToInstance(plugin.instanceId, 'nav.backend_status', { status })
      }
    }
  }

  /** True when any running plugin declares a non-empty `requires` (i.e. needs
   *  the backend for calls and/or events; `ping`-only plugins don't). */
  private anyPluginNeedsBackend(): boolean {
    for (const plugin of this.running.values()) {
      if (plugin.requires.length > 0) return true
    }
    return false
  }

  /** Whether the app is quitting; index.ts owns the quit flags. */
  private appQuitting: () => boolean = () => false

  setAppQuittingProbe(probe: () => boolean): void {
    this.appQuitting = probe
  }

  /** A window hosting embedded AI panels (AiCliDock) closed: end the panels of
   *  its `surface` — in `workspacePath`, or in every workspace when the window
   *  cannot say which (terminal.kill_surface). Skipped during an app quit, so
   *  the panels' records stay 'spawned' and restore next launch.
   *  Fire-and-forget: a backend that is down has no PTY to end. */
  endDockSurface(surface: string, workspacePath = ''): void {
    if (this.appQuitting()) return
    const client = this.ensureBackend()
    if (!client) return
    void client.send('terminal.kill_surface', { surface, workspace_path: workspacePath }).then((response) => {
      // A panel whose kill failed is still running; nothing here can retry it,
      // but the log says which one outlived its window.
      const failed = toPayload(response.payload).failed
      if (!Array.isArray(failed)) return
      for (const entry of failed) {
        const item = toPayload(entry)
        warnMain(
          `[plugins] terminal.kill_surface for ${surface} could not end panel ` +
          `${String(item.pane_id)} (${String(item.terminal_session_id)}): ${String(item.error)}`,
        )
      }
    }, (error) => {
      // Nothing to undo: the panels linger until the backend's ownerless sweep.
      console.warn(`[plugins] terminal.kill_surface for ${surface} failed`, error)
    })
  }

  /** Lazily create + connect the backend transport, subscribing to the
   *  server-push events the broker forwards. Returns null when no backend url
   *  is known yet. */
  private ensureBackend(): WsClient | null {
    if (!this.backendWsUrl) return null
    if (!this.wsClient) {
      const client = createWsClient({
        WebSocketImpl: UnboundedNodeWebSocket as unknown as WsConstructor,
        onStatus: (s) => {
          if (s !== 'connected') {
            this.hostSessionRegistered = false
            // Pieces belong to the session that sent them.
            for (const held of this.agentRequestPieces.values()) clearTimeout(held.idle)
            this.agentRequestPieces.clear()
          }
          this.dispatchBackendStatus(s)
          if (s === 'connected') {
            // A new backend session (a restarted backend among them) starts
            // from idle; a backend whose helper is ready or unavailable
            // reports it again once the session is registered.
            this.resultHelperState = { state: 'idle', lastError: '', since: Date.now() }
            this.onResultHelperState?.({ ...this.resultHelperState })
            this.registerHostSession(client)
          }
        },
      })
      this.wsClient = client
      for (const event of new Set([...Object.keys(CAP_EVENTS), ...PUBLIC_CAPABILITY_EVENT_ADDRESSES])) {
        client.on(event, (payload) => {
          // The shared backend listener has no authenticated public-event
          // source binding. Manifest v2 events therefore fail closed here;
          // Host producers must use dispatchPublicCapabilityEvent().
          if (event === 'ui.settings_changed') {
            this.dispatchHostSettingsChanged(payload)
          } else {
            this.dispatchEvent(event, payload)
          }
        })
      }
      client.on('agent.capability.request', (payload) => {
        void this.handleAgentCapabilityRequest(client, payload)
      })
      client.on(AGENT_CAPABILITY_REQUEST_CHUNK_EVENT, (payload) => {
        this.holdAgentRequestPiece(client, payload)
      })
      client.on(AGENT_TOOLS_RESULT_HELPER_EVENT, (payload) => {
        const state = parseAgentToolsResultHelperState(payload)
        if (!state || this.wsClient !== client) return
        this.resultHelperState = state
        this.onResultHelperState?.(state)
      })
      client.on(MARKETPLACE_QUERY_REQUEST_EVENT, (payload) => {
        void this.handleMarketplaceQueryRequest(client, payload)
      })
      client.on(PLUGIN_AGENT_ACTION_REQUEST_EVENT, (payload) => {
        void this.handlePluginAgentActionRequest(client, payload)
      })
      client.on(PDF_RENDER_REQUEST, (payload) => {
        // Only the live client answers: a replaced one's backend is gone.
        if (this.wsClient === client) void handlePdfRenderRequest(client, payload)
      })
      client.connect(this.backendWsUrl)
    }
    return this.wsClient
  }

  /** Best-effort display-name alias for the entry query of a plugin view, so
   *  the window it lives in can wear the name the user gave the workspace
   *  instead of the folder name. `''` means "no alias" and is also what every
   *  failure returns — a sub-window that receives no alias falls back to
   *  `basename(workspace_path)`, exactly what it showed before aliases
   *  existed.
   *
   *  Read from `workspace.list_recent`, the recent-list MIRROR of
   *  `Project.display_name`, and not from `project.peek`: peek is not a pure
   *  read — it registers the path as a workspace (token attribution, a log
   *  rescan) and provisions `.agent-team/plans/` inside it. Opening a
   *  sub-folder of a workspace in the editor must not turn that folder into a
   *  workspace with three files it never asked for. The mirror is read-only
   *  and is exactly what the list views already show; a real workspace is in
   *  it as soon as the App has opened it once, and a sub-folder is not — and
   *  has no alias to report. An entry whose name is the folder basename is the
   *  mirror's own fallback for "no alias", so it reports `''` too.
   *
   *  Path match: both sides are absolute with trailing slashes trimmed. The
   *  backend files entries under `abspath(expanduser(path))`; `resolve` here
   *  matches that for the absolute paths the renderer hands over. No realpath
   *  on either side — a symlinked workspace is filed under the path the user
   *  opened.
   *
   *  Bounded on purpose. `WsClient.send` waits up to 10s for a reply and
   *  queues while the transport is down; a window open should not wait that
   *  long for a title. The race caps it at `timeoutMs`, after which the
   *  window opens with no alias.
   *
   *  Not cached: a rename between two opens must not be served a stale name,
   *  and the Host has no `workspace.recent_changed` subscription to invalidate
   *  a cache with. One local round trip per window open is the cheaper side of
   *  that trade. */
  async peekWorkspaceDisplayName(workspacePath: string, timeoutMs = 300): Promise<string> {
    if (!workspacePath) return ''
    const client = this.ensureBackend()
    if (!client) return ''
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const wanted = resolve(workspacePath).replace(/\/+$/, '')
      // Swallowed here rather than at the race: a rejection arriving after the
      // timeout already won would otherwise be an unhandled rejection.
      const listing = client
        .send<{ recent?: unknown }>('workspace.list_recent', {})
        .then(
          (response) => response,
          () => null,
        )
      const response = await Promise.race([
        listing,
        new Promise<null>((settle) => {
          timer = setTimeout(() => settle(null), timeoutMs)
        }),
      ])
      if (!response || !response.ok) return ''
      const recent = response.payload?.recent
      if (!Array.isArray(recent)) return ''
      for (const entry of recent as Array<{ path?: unknown; name?: unknown }>) {
        if (typeof entry?.path !== 'string') continue
        if (entry.path.replace(/\/+$/, '') !== wanted) continue
        const name = typeof entry.name === 'string' ? entry.name.trim() : ''
        return name === basename(wanted) ? '' : name
      }
      return ''
    } catch {
      return ''
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private hasActivePlansBackend(): boolean {
    return this.isPlansBackendAvailable()
  }

  private refreshHostSessionRegistration(): void {
    const client = this.wsClient
    const url = this.backendWsUrl
    if (
      !client ||
      !url ||
      !this.backendHostToken ||
      !client.isHealthyFor(url) ||
      this.hostRegistrationTask
    ) return
    // Re-registering only re-advertises the features. Dropping a registration
    // that already advertises the current value would fail every agent request
    // in flight as "lapsed" - and in Plans legacy recovery each Plans request
    // re-marks the backend unavailable, so every one of them lapsed.
    if (
      this.hostSessionRegistered &&
      this.hostSessionPlansBackendV2 === this.hasActivePlansBackend() &&
      this.hostSessionDisabledPlugins === this.listDisabledBuiltinPlugins().join('\n')
    ) return
    this.hostSessionRegistered = false
    this.registerHostSession(client)
  }

  private registerHostSession(client: WsClient): void {
    const token = this.backendHostToken
    const url = this.backendWsUrl
    if (!token || !url || this.wsClient !== client || this.hostRegistrationTask) return
    const plansBackendV2 = this.hasActivePlansBackend()
    // Sent only while a built-in is disabled, so the registration is exactly
    // main's otherwise.
    const disabledPlugins = this.listDisabledBuiltinPlugins()
    const task = (async (): Promise<void> => {
      try {
        const response = await client.send<{ registered?: unknown }>(
          'host.register',
          {
            token,
            features: {
              plans_backend_v2: plansBackendV2,
              ...(disabledPlugins.length > 0 ? { disabled_plugins: disabledPlugins } : {}),
            },
          },
          5_000,
        )
        if (
          this.wsClient === client &&
          this.backendWsUrl === url &&
          client.isHealthyFor(url) &&
          this.backendHostToken === token
        ) {
          this.hostSessionRegistered = response.ok && response.payload?.registered === true
          this.hostSessionPlansBackendV2 = plansBackendV2
          this.hostSessionDisabledPlugins = disabledPlugins.join('\n')
          if (!this.hostSessionRegistered) {
            console.warn('[plugin-backend] Host session registration was rejected')
          } else {
            // A (re)connected backend starts with no third-party tools.
            void this.agentToolsHost?.onBackendConnected().catch(() => undefined)
          }
        }
      } catch (error) {
        if (
          this.wsClient === client &&
          this.backendWsUrl === url &&
          this.backendHostToken === token
        ) {
          console.warn(
            `[plugin-backend] Host session registration failed: ${
              error instanceof Error ? error.message : 'backend unavailable'
            }`,
          )
        }
      }
    })()
    this.hostRegistrationTask = task
    void task.finally(() => {
      if (this.hostRegistrationTask !== task) return
      this.hostRegistrationTask = null
      if (
        (plansBackendV2 !== this.hasActivePlansBackend() ||
          disabledPlugins.join('\n') !== this.listDisabledBuiltinPlugins().join('\n')) &&
        this.wsClient === client &&
        this.backendWsUrl === url &&
        this.backendHostToken === token &&
        client.isHealthyFor(url)
      ) {
        this.hostSessionRegistered = false
        this.registerHostSession(client)
      }
    })
  }

  /** Keep one argument piece of an agent tool request until the request arrives (contract 4.4, A2). */
  private holdAgentRequestPiece(client: WsClient, payload: unknown): void {
    if (this.wsClient !== client || !this.hostSessionRegistered) return
    const record = exactRecord(payload, ['request_id', 'seq', 'data'])
    if (!record || !nonEmptyString(record.request_id)) return
    const requestId = record.request_id
    const held = this.agentRequestPieces.get(requestId) ?? { pieces: [], shortSeen: false }
    if (held.failed) return
    const arrival = agentToolChunkArrival(held.shortSeen, record.data, AGENT_TOOL_CHUNK_BYTES, record.seq, held.pieces.length)
    if (!arrival.ok) {
      held.failed = arrival.reason
    } else {
      held.pieces.push(record.data as string)
      held.shortSeen = arrival.short
    }
    // A piece that never gets its request is dropped after the idle time; a
    // short piece (the last one) does not restart it.
    if (!arrival.ok || held.pieces.length === 1 || !arrival.short) {
      clearTimeout(held.idle)
      held.idle = setTimeout(() => {
        if (this.agentRequestPieces.get(requestId) === held) this.agentRequestPieces.delete(requestId)
      }, AGENT_TOOL_CHUNK_IDLE_MS)
      held.idle.unref?.()
    }
    this.agentRequestPieces.set(requestId, held)
  }

  /** Join the argument pieces of a request that carries `payload.argumentChunks`. */
  private joinAgentRequestArguments(
    requestId: string,
    summary: unknown,
  ): { ok: true; arguments: unknown } | { ok: false; reason: AgentToolChunksInvalidReason } {
    const held = this.agentRequestPieces.get(requestId)
    this.agentRequestPieces.delete(requestId)
    clearTimeout(held?.idle)
    if (held?.failed) return { ok: false, reason: held.failed }
    const joined = reassembleAgentToolPayloadText((held?.pieces ?? []).map((data, seq) => ({ seq, data })), summary)
    if (!joined.ok) return { ok: false, reason: joined.reason }
    try {
      return { ok: true, arguments: JSON.parse(joined.text) }
    } catch {
      return { ok: false, reason: 'json' }
    }
  }

  private async handleAgentCapabilityRequest(client: WsClient, payload: unknown): Promise<void> {
    const record: Record<string, unknown> =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {}
    // Every request the Host will not serve is logged and, when it carries a
    // request id, answered at once — otherwise the MCP waiter sits out its
    // full timeout with nothing to explain why.
    const refuse = (code: CapabilityErrorCode, reason: string): Promise<void> => {
      const requestId = nonEmptyString(record.request_id) ? record.request_id : null
      console.warn(`[plugin-backend] agent capability request ${requestId ?? '(no request_id)'} not served: ${reason}`)
      if (requestId === null) return Promise.resolve()
      const inner = record.payload
      const reqId =
        typeof inner === 'object' && inner !== null && !Array.isArray(inner) &&
        typeof (inner as Record<string, unknown>).reqId === 'string'
          ? (inner as Record<string, unknown>).reqId as string
          : ''
      return client.send(
        'agent.capability.result',
        { request_id: requestId, response: buildError(reqId, code, reason) },
        10_000,
      ).then(() => undefined, () => {
        // The requesting client may already be closed; the log above stands.
      })
    }
    if (this.wsClient !== client || !this.hostSessionRegistered) {
      return refuse('BACKEND_UNAVAILABLE', 'Host backend session is not registered')
    }
    const legacyRequest =
      Object.keys(record).length === 4 &&
      Object.keys(record).every((key) => ['request_id', 'instance_id', 'operation', 'payload'].includes(key)) &&
      nonEmptyString(record.request_id) &&
      nonEmptyString(record.instance_id) &&
      (record.operation === 'capability' || record.operation === 'backend') &&
      isJsonValue(record.payload)
    const workspaceRequest =
      Object.keys(record).length === 4 &&
      Object.keys(record).every((key) => ['request_id', 'target', 'operation', 'payload'].includes(key)) &&
      nonEmptyString(record.request_id) &&
      record.operation === 'backend' &&
      isJsonValue(record.payload) &&
      typeof record.target === 'object' &&
      record.target !== null &&
      !Array.isArray(record.target) &&
      Object.keys(record.target).length === 2 &&
      nonEmptyString((record.target as Record<string, unknown>).plugin_id) &&
      nonEmptyString((record.target as Record<string, unknown>).workspace_path)
    if (record.operation === 'agentTool' && nonEmptyString(record.request_id)) {
      const requestId = record.request_id
      let toolResponse: HostAgentToolResponse
      // Arguments sent in pieces (contract 4.4, A2) are joined before anything else.
      const chunked = exactRecord(record.payload, ['argumentChunks'])
      const joined = chunked ? this.joinAgentRequestArguments(requestId, chunked.argumentChunks) : null
      if (joined && !joined.ok) {
        toolResponse = {
          ...agentToolError('PLUGIN_TOOL_CHUNKS_INVALID', 'The tool arguments did not arrive whole.'),
          reason: joined.reason,
        }
      } else {
        // Each step of a long call tells the core the call is alive (contract 4.4, Timing).
        const progress = (phase: 'arguments' | 'execution' | 'result'): void => {
          if (this.wsClient !== client) return
          void client.send(AGENT_CAPABILITY_PROGRESS_MESSAGE, { request_id: requestId, phase }, AGENT_TOOL_CHUNK_IDLE_MS)
            .catch(() => undefined)
        }
        try {
          toolResponse = await this.executeAgentToolCall(
            joined ? { ...record, payload: { arguments: joined.arguments } } : record,
            progress,
          )
        } catch (error) {
          // Never forward an internal message (it can carry local paths).
          console.warn(`[plugin-backend] agent tool request failed: ${error instanceof Error ? error.message : String(error)}`)
          toolResponse = agentToolError('PLUGIN_TOOL_FAILED', 'The Navide plugin tool failed.')
        }
      }
      if (this.wsClient !== client || !this.hostSessionRegistered) {
        return refuse('BACKEND_UNAVAILABLE', 'Host backend session lapsed while the request ran')
      }
      await this.sendAgentToolResponse(client, requestId, toolResponse)
      return
    }
    if (!legacyRequest && !workspaceRequest) {
      return refuse('BAD_REQUEST', 'agent capability request is malformed')
    }

    let response: CapabilityResponse | BuiltinPluginDisabledResponse
    try {
      response = legacyRequest
        ? record.operation === 'capability'
          ? await this.executeAgentCapability(record.instance_id as string, record.payload)
          : await this.executeAgentBackendCall(record.instance_id as string, record.payload)
        : await this.executeAgentBackendCallForWorkspace(
          (record.target as Record<string, unknown>).plugin_id as string,
          (record.target as Record<string, unknown>).workspace_path as string,
          record.payload,
        )
    } catch (error) {
      return refuse('BACKEND_ERROR', error instanceof Error ? error.message : String(error))
    }
    if (this.wsClient !== client || !this.hostSessionRegistered) {
      return refuse('BACKEND_UNAVAILABLE', 'Host backend session lapsed while the request ran')
    }
    await client.send(
      'agent.capability.result',
      { request_id: record.request_id, response },
      10_000,
    ).catch(() => {
      // The MCP waiter has its own timeout; a closed backend is reported there.
    })
  }

  /** Install the function that answers the backend's read-only Marketplace
   *  queries (plan B, B2-a). It is the Marketplace page's own search, detail
   *  and inventory; see marketplaceQuery.ts. */
  setMarketplaceQueryHandler(handler: (query: unknown) => Promise<MarketplaceQueryAnswer>): void {
    this.marketplaceQueryHandler = handler
  }

  /** Plan B watchdog option C (contract 5.2): one resource decision row for
   *  the backend's audit, over this Host's authenticated session. Never throws
   *  and never waits: a row that cannot be sent is logged and dropped, so the
   *  user's choice is never held up. */
  recordResourceDecision(row: PluginResourceDecisionRow): void {
    const client = this.wsClient
    if (!client || !this.hostSessionRegistered) {
      console.warn(`[plugin-backend] resource decision for ${row.plugin_id} not recorded: Navide Host session is not ready`)
      return
    }
    void client.send(PLUGIN_RESOURCE_DECISION_MESSAGE, { rows: [row] }, 10_000).then((response) => {
      if (!response.ok) console.warn(`[plugin-backend] resource decision for ${row.plugin_id} not recorded: ${response.error?.message ?? 'refused'}`)
    }).catch((error: unknown) => {
      console.warn(`[plugin-backend] resource decision for ${row.plugin_id} not recorded: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Plan B D-f: one plugin's activity report from the backend, asked over
   *  this Host's authenticated session (contract 5.1; the backend accepts it
   *  from that session only). Throws when the session is not ready or the
   *  backend refuses; the caller shows that instead of a report. */
  async requestPluginActivityReport(request: PluginActivityReportRequest): Promise<unknown> {
    const client = this.wsClient
    if (!client || !this.hostSessionRegistered) throw new Error('Navide Host session is not ready')
    const response = await client.send(PLUGIN_ACTIVITY_REPORT_MESSAGE, { ...request }, 15_000)
    if (!response.ok) throw new Error(response.error?.message ?? 'the backend did not answer the activity report')
    return response.payload
  }

  /** Install the function that carries out an agent's plugins_disable /
   *  plugins_enable (plan B, B2-c): the Extensions Disabled switch for an
   *  installed Marketplace package, then a notice naming the caller. */
  setPluginAgentActionHandler(handler: (request: unknown) => Promise<PluginAgentActionAnswer>): void {
    this.pluginAgentActionHandler = handler
  }

  /** Answer one `plugins.agent_action.request` on the registered Host session.
   *  Only the backend this Host authenticated to can ask, over this client. */
  private async handlePluginAgentActionRequest(client: WsClient, payload: unknown): Promise<void> {
    const record: Record<string, unknown> =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {}
    const requestId = nonEmptyString(record.request_id) ? record.request_id : null
    if (requestId === null) {
      console.warn('[plugin-backend] plugin agent action without a request_id was not served')
      return
    }
    let answer: PluginAgentActionAnswer
    const handler = this.pluginAgentActionHandler
    if (this.wsClient !== client || !this.hostSessionRegistered || !handler) {
      answer = { ok: false, error: 'Navide Host cannot change plugins now', error_code: 'HOST_UNAVAILABLE' }
    } else {
      try {
        answer = await handler(record)
      } catch (error) {
        answer = { ok: false, error: error instanceof Error ? error.message : String(error), error_code: 'ACTION_FAILED' }
      }
    }
    if (this.wsClient !== client) return
    await client.send(
      PLUGIN_AGENT_ACTION_RESULT_MESSAGE,
      { request_id: requestId, ...answer },
      10_000,
    ).catch(() => {
      // The backend's waiter has its own timeout and reports it there.
    })
  }

  /** Answer one `marketplace.query.request` on the registered Host session.
   *  Only the backend this Host authenticated to can ask, over this client;
   *  the query is read-only and carries no caller identity. */
  private async handleMarketplaceQueryRequest(client: WsClient, payload: unknown): Promise<void> {
    const record: Record<string, unknown> =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {}
    const requestId = nonEmptyString(record.request_id) ? record.request_id : null
    if (requestId === null) {
      console.warn('[plugin-backend] marketplace query without a request_id was not served')
      return
    }
    let answer: MarketplaceQueryAnswer
    const handler = this.marketplaceQueryHandler
    if (this.wsClient !== client || !this.hostSessionRegistered || !handler) {
      answer = { ok: false, error: 'Navide Host cannot answer Marketplace queries now', error_code: 'HOST_UNAVAILABLE' }
    } else if (Object.keys(record).length !== 2 || !('query' in record)) {
      answer = { ok: false, error: 'marketplace query is malformed', error_code: 'BAD_REQUEST' }
    } else {
      try {
        answer = await handler(record.query)
      } catch (error) {
        answer = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: 'HOST_UNAVAILABLE',
        }
      }
    }
    if (this.wsClient !== client) return
    await client.send(
      MARKETPLACE_QUERY_RESULT_MESSAGE,
      { request_id: requestId, ...answer },
      10_000,
    ).catch(() => {
      // The backend's waiter has its own timeout and reports it there.
    })
  }

  private routeForPlugin(plugin: RunningPlugin): TerminalRoute | null {
    const binding = plugin.capabilityContext?.runtimeBinding
    if (plugin.hasV2DescriptorIdentity && !this.hasValidTerminalBinding(plugin)) {
      return null
    }
    return {
      pluginId: plugin.id,
      packageVersion: binding?.packageVersion ?? null,
      workspaceId: binding?.workspaceId ?? null,
      audience: binding?.audience ?? null,
      instanceId: plugin.hasV2DescriptorIdentity ? plugin.instanceId : null,
      legacy: !plugin.hasV2DescriptorIdentity,
    }
  }

  private routeMatchesPlugin(route: TerminalRoute, plugin: RunningPlugin): boolean {
    if (
      route.pluginId !== plugin.id ||
      route.legacy !== !plugin.hasV2DescriptorIdentity
    ) return false
    if (route.legacy) return true
    const binding = plugin.capabilityContext?.runtimeBinding
    return (
      this.hasValidTerminalBinding(plugin) &&
      binding !== null &&
      binding !== undefined &&
      route.packageVersion === binding.packageVersion &&
      route.workspaceId === binding.workspaceId &&
      route.audience === binding.audience
    )
  }

  private hasValidTerminalBinding(plugin: RunningPlugin): boolean {
    const context = plugin.capabilityContext
    const binding = context?.runtimeBinding
    return (
      plugin.hasV2DescriptorIdentity &&
      context !== null &&
      context !== undefined &&
      binding !== null &&
      binding !== undefined &&
      binding.pluginId === plugin.id &&
      nonEmptyString(binding.packageVersion) &&
      nonEmptyString(binding.workspaceId) &&
      nonEmptyString(binding.instanceId) &&
      nonEmptyString(binding.audience) &&
      context.userGrant !== null &&
      context.userGrant.packageVersion === binding.packageVersion
    )
  }

  private canRouteBeClaimed(route: TerminalRoute, plugin: RunningPlugin): boolean {
    if (!this.routeMatchesPlugin(route, plugin)) return false
    return route.legacy || route.instanceId === null || route.instanceId === plugin.instanceId
  }

  private runningPluginForTerminalRoute(route: TerminalRoute | undefined): RunningPlugin | undefined {
    if (!route) return undefined
    if (route.legacy) {
      const legacyInstanceId = this.legacyInstances.get(route.pluginId)
      return legacyInstanceId ? this.running.get(legacyInstanceId) : undefined
    }
    if (!route.instanceId) return undefined
    const plugin = this.running.get(route.instanceId)
    return plugin && !this.isPluginStopping(plugin) && this.routeMatchesPlugin(route, plugin)
      ? plugin
      : undefined
  }

  private activeTerminalOwnerKey(route: TerminalRoute): string | null {
    if (route.legacy) {
      return this.runningPluginForTerminalRoute(route) ? `legacy:${route.pluginId}` : null
    }
    return this.runningPluginForTerminalRoute(route) ? `instance:${route.instanceId}` : null
  }

  private logDroppedTerminalEvent(
    event: string,
    sessionId: string,
    route: TerminalRoute | undefined
  ): void {
    const owner = route?.instanceId ?? route?.pluginId
    console.debug(
      `[plugin] dropping ${event} for terminal session ${sessionId}: ` +
        (owner ? `owner ${owner} is not active` : 'no active route')
    )
  }

  private requiresTerminalOwnership(wsType: string): boolean {
    return TERMINAL_OWNED_WS_TYPES.has(wsType)
  }

  private ownsTerminalSession(plugin: RunningPlugin, payload: unknown): boolean {
    const sessionId = terminalSessionIdOf(payload)
    if (!sessionId) return false
    const route = this.terminalRoutes.get(sessionId)
    if (!route || !this.routeMatchesPlugin(route, plugin)) return false
    return route.legacy || route.instanceId === plugin.instanceId
  }

  /** Fan a backend server-push event out to every running plugin whose
   *  manifest grants the namespace gating that event. terminal.output rides the
   *  per-session micro-batcher instead of going out per event, and
   *  terminal.exit flushes that batch first (ordering barrier) then retires the
   *  session's route. */
  private dispatchEvent(
    event: string,
    payload: unknown,
    sourceBinding?: AuthenticatedRuntimeBinding,
    targetPluginId?: string
  ): void {
    if (event === 'git.credential_request' || event === 'git.credential_cancelled') {
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const nonce = typeof record?.credential_owner_nonce === 'string'
        ? record.credential_owner_nonce
        : ''
      const requestId = typeof record?.request_id === 'string' ? record.request_id : ''
      const owner = nonce ? this.gitCredentialOwners.get(nonce) : undefined
      const plugin = owner ? this.running.get(owner.instanceId) : undefined
      if (record && owner && plugin && requestId && this.ownsGitCredentialRequest(plugin, owner)) {
        const eventWorkspace = typeof record?.workspace_path === 'string'
          ? resolve(record.workspace_path)
          : null
        if (eventWorkspace !== owner.workspacePath) return
        if (event === 'git.credential_request') {
          const existing = this.gitCredentialRequests.get(requestId)
          if (existing && existing !== owner) return
          owner.requestIds.add(requestId)
          this.gitCredentialRequests.set(requestId, owner)
        } else {
          owner.requestIds.delete(requestId)
          if (this.gitCredentialRequests.get(requestId) === owner) {
            this.gitCredentialRequests.delete(requestId)
          }
        }
        this.emitGitCredentialPublicEvent(
          plugin,
          event === 'git.credential_request'
            ? 'shell.gitCredentialRequested'
            : 'shell.gitCredentialCancelled',
          requestId,
          typeof record.host === 'string' ? record.host : '',
          typeof record.prompt === 'string' ? record.prompt : '',
        )
        const { credential_owner_nonce: _nonce, ...safePayload } = record
        this.emitToInstance(plugin.instanceId, event, safePayload)
        return
      }
      // Legacy Git operations predate the Host correlation nonce and retain
      // their workspace-scoped event fan-out during the recovery window.
      if (nonce) return
    }
    const deliveredInstanceIds = new Set<string>()

    // Settings are a private first-party contract for the Git package. The
    // v2 surface receives only the typed Host read-only keys or the exact
    // plugin-owned storage key; explicit recovery Git remains baseline and
    // language must not enter legacy Git fan-out.
    if (event === 'ui.settings_changed') {
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      const rawSettings = record?.settings
      const source = record?.source
      if (typeof rawSettings === 'object' && rawSettings !== null && !Array.isArray(rawSettings)) {
        for (const plugin of this.running.values()) {
          const isV2Ui =
            plugin.hasV2DescriptorIdentity &&
            plugin.capabilityPolicy.kind === 'manifest-v2' &&
            plugin.capabilityPolicy.system.includes('ui') &&
            Boolean(plugin.capabilityContext?.userGrant?.system.includes('ui'))

          const isLegacyGit =
            !plugin.hasV2DescriptorIdentity &&
            plugin.id === GIT_PLUGIN_ID &&
            isEventAllowed(plugin.capabilityPolicy, event)

          const isLegacyPlans =
            !plugin.hasV2DescriptorIdentity &&
            plugin.id === PLANS_PLUGIN_ID &&
            isEventAllowed(plugin.capabilityPolicy, event)

          const isLegacyMiniIde =
            this.miniIdeLegacyPreferences !== null &&
            !plugin.hasV2DescriptorIdentity &&
            plugin.id === MINI_IDE_PLUGIN_ID &&
            isEventAllowed(plugin.capabilityPolicy, event)

          if (!isV2Ui && !isLegacyGit && !isLegacyPlans && !isLegacyMiniIde) {
            continue
          }

          if (isLegacyMiniIde) {
            const settings = Object.fromEntries(
              Object.entries(rawSettings as Record<string, unknown>)
                .filter(([key]) => !MINI_IDE_STORAGE_KEYS.includes(key as typeof MINI_IDE_STORAGE_KEYS[number]))
            )
            if (Object.keys(settings).length > 0) {
              this.emitToInstance(plugin.instanceId, event, { source, settings })
            }
            deliveredInstanceIds.add(plugin.instanceId)
          } else if (plugin.id === GIT_PLUGIN_ID) {
            if (source === 'host') {
              const gitSettings = Object.fromEntries(
                Object.entries(rawSettings as Record<string, unknown>)
                  .filter(([key]) => GIT_HOST_READ_ONLY_KEYS.includes(key as typeof GIT_HOST_READ_ONLY_KEYS[number]) && (isV2Ui || key !== 'agent-team:language'))
              )
              if (Object.keys(gitSettings).length > 0) {
                this.emitToInstance(plugin.instanceId, event, { source, settings: gitSettings })
              }
              deliveredInstanceIds.add(plugin.instanceId)
            } else if (source === 'plugin-storage' && isV2Ui) {
              const scope = record?.scope
              const allowedKeys = scope === 'plugin'
                ? GIT_USER_PREFERENCE_KEYS
                : scope === 'workspace'
                  ? [GIT_WORKSPACE_REPOSITORY_KEY]
                  : []
              const gitSettings = Object.fromEntries(
                Object.entries(rawSettings as Record<string, unknown>)
                  .filter(([key]) => allowedKeys.includes(key as never))
              )
              const workspacePath = record?.workspace_path
              const settingsWorkspace = scope === 'workspace' && typeof workspacePath === 'string' && workspacePath.length > 0
                ? resolve(workspacePath)
                : null
              if (
                Object.keys(gitSettings).length > 0 &&
                (scope !== 'workspace' || (settingsWorkspace !== null && plugin.workspacePath !== null && resolve(plugin.workspacePath) === settingsWorkspace))
              ) {
                this.emitToInstance(plugin.instanceId, event, {
                  source,
                  scope,
                  settings: gitSettings,
                  ...(settingsWorkspace ? { workspace_path: workspacePath } : {}),
                })
              }
              deliveredInstanceIds.add(plugin.instanceId)
            }
          } else if (plugin.id === PLANS_PLUGIN_ID && (isV2Ui || isLegacyPlans)) {
            if (source === 'host') {
              const language = (rawSettings as Record<string, unknown>)['agent-team:language']
              if (language === 'zh-TW' || language === 'en-US' || language === 'ja-JP') {
                this.emitToInstance(plugin.instanceId, event, {
                  source: 'host',
                  settings: { 'agent-team:language': language },
                })
              }
              deliveredInstanceIds.add(plugin.instanceId)
            }
          }
        }
      }
      // Keep the legacy loop below active while the rollback bundle is live.
    }
    // Git's existing changed event is a private first-party transport seam,
    // not a public Manifest v2 capability. Route it by the Host-owned
    // workspace path so two Git view instances never receive one another's
    // refresh. Credential events take the dedicated branch at the top of this
    // method instead, routed to their owning instance by the Host-issued
    // credential-owner nonce.
    if (event === 'git.changed') {
      const eventWorkspace =
        typeof payload === 'object' && payload !== null &&
        typeof (payload as Record<string, unknown>).workspace_path === 'string'
          ? resolve((payload as Record<string, unknown>).workspace_path as string)
          : null
      if (!eventWorkspace) return
      for (const plugin of this.running.values()) {
        if (
          !plugin.hasV2DescriptorIdentity ||
          plugin.id !== GIT_PLUGIN_ID ||
          (targetPluginId !== undefined && plugin.id !== targetPluginId) ||
          !plugin.workspacePath ||
          resolve(plugin.workspacePath) !== eventWorkspace
        ) {
          continue
        }
        const context = plugin.capabilityContext
        const policy = plugin.capabilityPolicy
        if (
          policy.kind !== 'manifest-v2' ||
          !policy.system.includes('fs') ||
          !context?.userGrant?.system.includes('fs')
        ) {
          continue
        }
        this.emitToInstance(plugin.instanceId, event, payload)
        deliveredInstanceIds.add(plugin.instanceId)
      }
    }
    if (event === 'terminal.output') {
      const sessionId = terminalSessionIdOf(payload)
      if (!sessionId) return
      const route = this.terminalRoutes.get(sessionId)
      const owner = route ? this.activeTerminalOwnerKey(route) : null
      if (!owner) {
        if (this.bufferEarlyAiEvent('terminal.output', payload)) return
        this.logDroppedTerminalEvent(event, sessionId, route)
        return
      }
      const pendingOwner = this.pendingTerminalOwners.get(sessionId)
      if (pendingOwner && pendingOwner !== owner) {
        this.terminalOutputBatcher.dropSession(sessionId)
        this.aiTerminalOutputDecoder.dropSession(sessionId)
        this.pendingTerminalOwners.delete(sessionId)
      }
      this.pendingTerminalOwners.set(sessionId, owner)
      this.terminalOutputBatcher.push(sessionId, toPayload(payload))
      return
    } else if (event === 'terminal.exit') {
      const sessionId = terminalSessionIdOf(payload)
      if (!sessionId) return
      const route = this.terminalRoutes.get(sessionId)
      if (!route && this.bufferEarlyAiEvent('terminal.exit', payload)) return
      const ownerPlugin = route ? this.runningPluginForTerminalRoute(route) : undefined
      if (usesPublicAiCliEvents(ownerPlugin)) {
        this.terminalOutputBatcher.flushSession(sessionId)
        this.finishPublicAiOutput(ownerPlugin, sessionId)
        const binding = ownerPlugin.capabilityContext?.runtimeBinding
        const exitCode = toPayload(payload).exit_code
        const normalizedExitCode = typeof exitCode === 'number' ? exitCode : null
        if (
          binding &&
          this.isPublicEventAllowedForInstance(
            ownerPlugin,
            'aiCli.exited',
            { sessionId, exitCode: normalizedExitCode },
            binding
          )
        ) {
          this.emitToInstance(ownerPlugin.instanceId, 'aiCli.exited', {
            sessionId,
            exitCode: normalizedExitCode,
          })
        }
        this.removeAiSession(ownerPlugin, sessionId, true)
        this.terminalRoutes.delete(sessionId)
        return
      }
      this.terminalOutputBatcher.flushSession(sessionId)
      this.aiTerminalOutputDecoder.dropSession(sessionId)
      this.deliverTerminalEvent(event, sessionId, payload)
      this.terminalRoutes.delete(sessionId)
      this.pendingTerminalOwners.delete(sessionId)
      return
    }
    for (const plugin of this.running.values()) {
      if (deliveredInstanceIds.has(plugin.instanceId)) continue
      if (targetPluginId !== undefined && plugin.id !== targetPluginId) continue
      const allowed =
        plugin.capabilityPolicy.kind === 'manifest-v2'
          ? plugin.capabilityContext !== null &&
            isPublicCapabilityEventAllowed(
              plugin.capabilityPolicy,
              event,
              payload,
              plugin.capabilityContext,
              targetPluginId ?? '',
              sourceBinding
            )
          : isEventAllowed(plugin.capabilityPolicy, event)
      if (allowed) {
        this.emitToInstance(plugin.instanceId, event, payload)
      }
    }
  }

  private isPublicEventAllowedForInstance(
    plugin: RunningPlugin,
    event: string,
    payload: unknown,
    sourceBinding: AuthenticatedRuntimeBinding
  ): boolean {
    return (
      plugin.capabilityPolicy.kind === 'manifest-v2' &&
      plugin.capabilityContext !== null &&
      isPublicCapabilityEventAllowed(
        plugin.capabilityPolicy,
        event,
        payload,
        plugin.capabilityContext,
        plugin.id,
        sourceBinding
      )
    )
  }

  private emitPublicAiOutput(
    plugin: RunningPlugin,
    sessionId: string,
    data: unknown,
  ): void {
    const binding = plugin.capabilityContext?.runtimeBinding
    if (!binding || !this.isPublicEventAllowedForInstance(
      plugin,
      'aiCli.output',
      { sessionId, data: '' },
      binding,
    )) return
    const text = this.aiTerminalOutputDecoder.decode(plugin.instanceId, sessionId, data)
    if (
      text &&
      this.isPublicEventAllowedForInstance(plugin, 'aiCli.output', { sessionId, data: text }, binding)
    ) {
      this.emitToInstance(plugin.instanceId, 'aiCli.output', { sessionId, data: text })
    }
  }

  private finishPublicAiOutput(plugin: RunningPlugin, sessionId: string): void {
    const binding = plugin.capabilityContext?.runtimeBinding
    if (!binding || !this.isPublicEventAllowedForInstance(
      plugin,
      'aiCli.output',
      { sessionId, data: '' },
      binding,
    )) {
      this.aiTerminalOutputDecoder.dropSession(sessionId)
      return
    }
    const text = this.aiTerminalOutputDecoder.finish(plugin.instanceId, sessionId)
    if (
      text &&
      this.isPublicEventAllowedForInstance(plugin, 'aiCli.output', { sessionId, data: text }, binding)
    ) {
      this.emitToInstance(plugin.instanceId, 'aiCli.output', { sessionId, data: text })
    }
  }

  /** Deliver a terminal.output/exit event to the session's registered owner —
   *  and ONLY the owner. Unrouted sessions, detached tombstones, and stale
   *  batches are dropped; PTY content must not leak to a sibling or a later
   *  instance. */
  private deliverTerminalEvent(
    event: string,
    sessionId: string,
    payload: unknown,
    expectedOwner?: string
  ): void {
    const route = this.terminalRoutes.get(sessionId)
    const owner = route ? this.activeTerminalOwnerKey(route) : null
    if (!owner || (expectedOwner !== undefined && owner !== expectedOwner)) {
      this.logDroppedTerminalEvent(event, sessionId, route)
      return
    }
    const plugin = this.runningPluginForTerminalRoute(route)
    if (plugin) {
      this.emitToInstance(plugin.instanceId, event, payload)
    }
  }

  /** Register the PTY sessions a successful terminal.create/terminal.reattach
   *  response binds to one authenticated view instance. Legacy callers may
   *  still pass their plugin id through the v1 adapter. */
  noteTerminalRoutes(instanceOrPluginId: string, wsType: string, result: unknown): void {
    const plugin = this.resolveInstance(instanceOrPluginId)
    if (!plugin || this.isPluginStopping(plugin)) return
    const route = this.routeForPlugin(plugin)
    if (!route) return
    for (const sessionId of terminalSessionsFromResponse(wsType, result)) {
      const previous = this.terminalRoutes.get(sessionId)
      if (previous && !this.canRouteBeClaimed(previous, plugin)) continue
      const previousOwner = previous ? this.activeTerminalOwnerKey(previous) : null
      const nextOwner = this.activeTerminalOwnerKey(route)
      if (previousOwner && previousOwner !== nextOwner) {
        this.terminalOutputBatcher.dropSession(sessionId)
        this.aiTerminalOutputDecoder.dropSession(sessionId)
        this.pendingTerminalOwners.delete(sessionId)
      }
      this.terminalRoutes.set(sessionId, route)
    }
  }

  /**
   * Strip every session id that the authenticated instance cannot claim. v2
   * reattach is fail-closed for unknown ids: the session id is not a free
   * credential. A live legacy adapter retains its bounded v1 compatibility for
   * unknown ids; stale/unknown senders are fail-closed even when an old route
   * remains in memory.
   */
  filterTerminalReattachPayload(
    instanceOrPluginId: string,
    payload: Record<string, unknown>
  ): Record<string, unknown> {
    const ids = payload.terminal_session_ids
    if (!Array.isArray(ids)) return payload
    const plugin = this.resolveInstance(instanceOrPluginId)
    if (!plugin) {
      return { ...payload, terminal_session_ids: [] }
    }
    const kept = ids.filter((id) => {
      if (typeof id !== 'string') return false
      const route = this.terminalRoutes.get(id)
      if (!route) return plugin.openedViaLegacyAdapter && !plugin.hasV2DescriptorIdentity
      return this.canRouteBeClaimed(route, plugin)
    })
    if (kept.length === ids.length) return payload
    console.debug(
      `[plugin] reattach: stripped ${ids.length - kept.length} session id(s) not owned by ${plugin.id}`
    )
    return { ...payload, terminal_session_ids: kept }
  }

  /**
   * Service one fire-and-forget capability cast (IPC_CAST / nav.castCapability).
   * Same scoping + routing as IPC_CALL, but no response ever returns to the
   * view, and ONLY the {@link CASTABLE_WS_TYPES} whitelist may dispatch
   * (main-side enforcement mirroring the shims' CAST_TYPES). Every drop logs a
   * distinct debug line; the outcome is returned for tests.
   */
  handleCast(
    senderId: number,
    payload: unknown,
    senderFrame: WebFrameMain | null = null,
    admittedPlugin?: RunningPlugin,
  ): 'dispatched' | 'no-backend' | 'unknown-sender' | 'malformed' | 'denied' | 'unmapped' | 'not-castable' {
    const plugin = admittedPlugin ?? this.instanceForIpc(senderId, senderFrame)
    if (!plugin) {
      console.debug('[plugin] cast dropped: unknown sender')
      return 'unknown-sender'
    }
    if (this.isPluginStopping(plugin)) {
      console.debug(`[plugin] cast dropped: ${plugin.id} plugin runtime is stopping`)
      return 'denied'
    }
    const pluginId = plugin.id
    if (this.payloadClaimsInstance(payload)) {
      console.debug(`[plugin] cast dropped: ${pluginId} instance identity is Host-owned`)
      return 'malformed'
    }
    if (this.payloadClaimsInitiator(payload)) {
      console.debug(`[plugin] cast dropped: ${pluginId} initiator identity is Host-owned`)
      return 'malformed'
    }
    const call = parseCapabilityCall(payload, pluginId)
    if (!call) {
      console.debug(`[plugin] cast dropped: malformed call from ${pluginId}`)
      return 'malformed'
    }
    const plan = planCapabilityCall(
      call,
      plugin.capabilityPolicy,
      plugin.capabilityContext ?? undefined
    )
    if (plan.kind === 'public') {
      console.debug(`[plugin] cast dropped: ${pluginId} public capabilities are request/response only`)
      return 'not-castable'
    }
    if (plan.kind === 'host') {
      console.debug(
        `[plugin] cast dropped: ${pluginId} ${call.ns}.${call.method} is a host capability (not castable)`
      )
      return 'not-castable'
    }
    if (plan.kind === 'respond') {
      if (plan.response.error?.code === 'CAP_DENIED') {
        console.debug(`[plugin] cast dropped: ${pluginId} ${call.ns}.${call.method} denied`)
        // Dispatched casts (terminal input) are not recorded; a refused one is.
        this.recordCapabilityActivity(plugin, payload, plan.response)
        return 'denied'
      }
      console.debug(`[plugin] cast dropped: ${pluginId} ${call.ns}.${call.method} unmapped`)
      return 'unmapped'
    }
    if (!CASTABLE_WS_TYPES.has(plan.wsType)) {
      console.debug(
        `[plugin] cast dropped: ${pluginId} ${plan.wsType} is not in the cast whitelist`
      )
      return 'not-castable'
    }
    const castPayload = toPayload(call.args)
    if (
      this.requiresTerminalOwnership(plan.wsType) &&
      !this.ownsTerminalSession(plugin, castPayload)
    ) {
      console.debug(`[plugin] cast dropped: ${pluginId} ${plan.wsType} terminal session is not owned`)
      return 'denied'
    }
    const client = this.ensureBackend()
    if (!client) {
      console.debug(`[plugin] cast dropped: ${pluginId} ${plan.wsType} — backend not connected`)
      return 'no-backend'
    }
    void client.send(plan.wsType, castPayload).catch(() => {
      // Nobody is awaiting — a failed input write surfaces through the PTY
      // stream itself (or the next request/response call).
    })
    return 'dispatched'
  }

  private beginTerminalOperation(
    plugin: RunningPlugin,
    wsType: string,
    client: WsClient,
    payload: Record<string, unknown>
  ): PendingTerminalOperation | null {
    if (wsType !== 'terminal.create' && wsType !== 'terminal.reattach') return null
    const operation: PendingTerminalOperation = {
      operationId: randomUUID(),
      instanceId: plugin.instanceId,
      wsType,
      client,
      route: this.routeForPlugin(plugin),
      cancelled: false,
      cancelSent: false,
      cleanupSessionIds: new Set<string>(),
      ...(wsType === 'terminal.create' && nonEmptyString(payload.pane_id)
        ? { paneId: payload.pane_id }
        : {}),
      ...(wsType === 'terminal.create' && nonEmptyString(payload.create_generation)
        ? { createGeneration: payload.create_generation }
        : {}),
    }
    this.pendingTerminalOperations.set(operation.operationId, operation)
    return operation
  }

  private canCommitTerminalOperation(operation: PendingTerminalOperation | null): boolean {
    if (!operation || operation.cancelled) return false
    const plugin = this.running.get(operation.instanceId)
    if (!plugin) return false
    return sameTerminalRoute(operation.route, this.routeForPlugin(plugin))
  }

  private cleanupCancelledTerminalCreate(
    operation: PendingTerminalOperation,
    result: unknown
  ): void {
    if (!operation.paneId || !operation.createGeneration) return
    if (typeof result !== 'object' || result === null) return
    const response = result as Record<string, unknown>
    if (
      response.pane_id !== operation.paneId ||
      response.create_generation !== operation.createGeneration
    ) {
      return
    }
    const sessionIds = terminalSessionsFromResponse(operation.wsType, result)
    if (sessionIds.length !== 1) return
    const sessionId = sessionIds[0]
    if (operation.cleanupSessionIds.has(sessionId)) return
    operation.cleanupSessionIds.add(sessionId)

    // This is Host cleanup for a create operation that could not be committed
    // to a live view, not a plugin capability call. It intentionally bypasses
    // the plugin authorization path and targets only this response's session.
    void operation.client
      .send('terminal.kill', { terminal_session_id: sessionId, force: true })
      .then((response) => {
        if (!response.ok) {
          // The expected outcome when the cancellation won the race: the
          // backend already rolled the create back and dropped its ownership,
          // so the kill has nothing left to reclaim.
          console.debug(`[plugin] late terminal.create cleanup was rejected for ${sessionId}`)
        }
      })
      .catch(() => {
        console.warn(`[plugin] late terminal.create cleanup failed for ${sessionId}`)
      })
  }

  private invalidatePendingTerminalOperations(plugin: RunningPlugin): void {
    for (const operation of this.pendingTerminalOperations.values()) {
      if (operation.instanceId !== plugin.instanceId || operation.cancelled) continue
      operation.cancelled = true
      if (
        operation.wsType === 'terminal.create' &&
        !operation.cancelSent &&
        operation.paneId &&
        operation.createGeneration
      ) {
        operation.cancelSent = true
        void operation.client
          .send('terminal.create.cancel', {
            pane_id: operation.paneId,
            create_generation: operation.createGeneration,
          })
          .catch(() => {
            // The ledger remains cancelled even if the backend is already
            // unavailable; a late create response must never revive a route.
          })
      }
    }
  }

  /** Shared terminal teardown for BOTH view-death paths ({@link destroy} and
   *  the defensive webContents 'destroyed' hook): discard this instance's
   *  pending output and detach only its live route ownership. The stable v2
   *  tuple remains as a Host-owned tombstone for safe reattach. */
  private releaseTerminalOwnership(plugin: RunningPlugin): void {
    this.invalidatePendingTerminalOperations(plugin)
    for (const [sessionId, route] of this.terminalRoutes) {
      const ownsRoute = route.legacy
        ? plugin.openedViaLegacyAdapter && route.pluginId === plugin.id
        : route.instanceId === plugin.instanceId && this.routeMatchesPlugin(route, plugin)
      if (!ownsRoute) continue
      this.terminalOutputBatcher.dropSession(sessionId)
      this.aiTerminalOutputDecoder.dropSession(sessionId)
      this.pendingTerminalOwners.delete(sessionId)
      if (!route.legacy) {
        const aiSession = this.aiSessions.get(sessionId)
        if (aiSession?.attachedInstanceId === plugin.instanceId) {
          aiSession.attachedInstanceId = null
        }
        this.terminalRoutes.set(sessionId, { ...route, instanceId: null })
      }
    }
  }

  private releaseInstanceSubscriptions(instanceId: string): void {
    const subscriptions = this.instanceSubscriptions.get(instanceId)
    if (!subscriptions) return
    this.instanceSubscriptions.delete(instanceId)
    for (const dispose of subscriptions) {
      try {
        dispose()
      } catch {
        // One broken subscription must not prevent sibling cleanup.
      }
    }
  }

  /** Detach a view from its host without changing the WebContents lifecycle. */
  private detachView(plugin: RunningPlugin): void {
    try {
      const native = plugin.view.nativeView
      if (native && !plugin.hostWindow.isDestroyed()) {
        plugin.hostWindow.contentView.removeChildView(native)
      }
    } catch {
      // Host teardown may already have removed the view.
    }
  }

  private forgetInstance(
    instanceId: string,
    options: { unbindBackend?: boolean } = {},
  ): RunningPlugin | undefined {
    const plugin = this.running.get(instanceId)
    if (!plugin) return undefined
    // Teardown may arrive directly from a destroyed WebContents rather than
    // destroyInstance(); keep the owner gate live while the release request
    // drains so its marker is not stranded.
    plugin.releasing = true
    // Its web views leave the closed view and keep running in the background.
    this.webViewRegistry?.hostClosed(instanceId)
    if (plugin.carrier === 'frame') this.revokePluginFrameInstance(instanceId)
    this.filePickerHost?.cancelInstance(instanceId)
    this.aiTerminalOutputDecoder.dropInstance(instanceId)
    this.editorSelectionGrants.close(instanceId)
    this.editorAiCapability.close(instanceId)
    this.settleActivation(instanceId)
    this.settlePluginReadyWaiter(instanceId, new BackendPluginError('INVALID_RUNTIME'))
    this.readinessReloaded.delete(instanceId)
    plugin.detachHostResize?.()
    plugin.detachHostResize = null
    plugin.detachHostClosed?.()
    plugin.detachHostClosed = null
    plugin.detachReceiverFrames?.()
    plugin.detachReceiverFrames = null
    this.revokeReceiverFrames(instanceId)
    this.cancelPendingEditorTargets((pending) =>
      pending.sourceInstanceId === instanceId || pending.receiverInstanceId === instanceId ||
      this.receiverItems.get(pending.sourceItemId)?.offer.detailSourceInstanceId === instanceId
    )
    this.cancelPendingDetailTargets((pending) =>
      pending.providerInstanceId === instanceId || pending.receiverInstanceId === instanceId ||
      this.receiverItems.get(pending.itemId)?.offer.detailSourceInstanceId === instanceId
    )
    this.cancelDetailCloseTransactions((transaction) =>
      transaction.receiverInstanceId === instanceId || transaction.itemIds.some((itemId) => {
        const item = this.receiverItems.get(itemId)
        const providerInstanceId = item ? this.pendingPluginFrames.get(item.bindingId)?.instanceId : undefined
        return providerInstanceId === instanceId || item?.offer.detailSourceInstanceId === instanceId
      })
    )
    this.cancelPendingDetailOpens((pending) => pending.sourceInstanceId === instanceId ||
      this.receiverItems.get(pending.itemId ?? '')?.offer.detailSourceInstanceId === instanceId,
    'provider-unavailable', true)
    this.cancelPendingDetailOpens((pending) => pending.receiverInstanceId === instanceId,
      'receiver-unavailable')
    this.detailPairs.delete(instanceId)
    this.cancelPendingAiStarts(plugin)
    this.releaseTerminalOwnership(plugin)
    const backendCalls = this.pendingBackendCalls.get(instanceId)
    this.pendingBackendCalls.delete(instanceId)
    for (const controller of backendCalls?.values() ?? []) controller.abort()
    const backendSubscriptions = this.pendingBackendSubscriptions.get(instanceId)
    for (const pending of backendSubscriptions?.values() ?? []) {
      pending.cancelled = true
      pending.controller.abort()
      // PluginBackendHost owns live subscription disposal during unbind.
      pending.subscription = null
    }
    if (options.unbindBackend !== false) {
      // Deliberately not awaited: forgetInstance is synchronous and is called
      // from synchronous Electron callbacks. The drain is not lost by that -
      // PluginBackendHost registers its unbind task before this returns, so
      // hasBackendActivity() keeps reporting the child until close() settles
      // and a quit cannot take the native fast path mid-drain. The rejection
      // must still be consumed here: unbindView rethrows a failed close so the
      // child slot stays retained, and nothing else observes this call.
      void this.pluginBackendHost.unbindView(instanceId).catch((error: unknown) => {
        warnMain(
          `[plugin-backend] unbind for ${instanceId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      })
    }
    this.releaseInstanceSubscriptions(instanceId)
    this.discardGitPathGrants(instanceId)
    this.releaseGitCredentialOwnersForInstance(instanceId)
    const terminalIdentity = this.terminalStorageIdentity(plugin)
    if (terminalIdentity) this.releaseAiTerminalOwner(plugin, terminalIdentity)
    this.running.delete(instanceId)
    if (plugin.carrier === 'surface') this.bySender.delete(plugin.senderId)
    for (const [key, handle] of this.contributionInstances) {
      if (handle.instanceId === instanceId) this.contributionInstances.delete(key)
    }
    if (![...this.running.values()].some((candidate) => candidate.hostWindow.id === plugin.hostWindow.id)) {
      this.gitContributionStates.delete(plugin.hostWindow.id)
    }
    if (this.legacyInstances.get(plugin.id) === instanceId) {
      this.legacyInstances.delete(plugin.id)
    }
    return plugin
  }

  private destroyPluginInstances(pluginId: string): void {
    for (const plugin of this.instancesForPlugin(pluginId)) {
      this.destroyInstance(plugin.instanceId)
    }
  }

  private clearTerminalRoutes(pluginId: string): void {
    for (const [sessionId, route] of this.terminalRoutes) {
      if (route.pluginId !== pluginId) continue
      this.terminalOutputBatcher.dropSession(sessionId)
      this.aiTerminalOutputDecoder.dropSession(sessionId)
      this.pendingTerminalOwners.delete(sessionId)
      this.terminalRoutes.delete(sessionId)
    }
  }

  private clearTerminalRoutesForPackageVersion(pluginId: string, packageVersion: string): void {
    for (const [sessionId, route] of this.terminalRoutes) {
      if (route.pluginId !== pluginId || route.packageVersion !== packageVersion) continue
      this.terminalOutputBatcher.dropSession(sessionId)
      this.aiTerminalOutputDecoder.dropSession(sessionId)
      this.pendingTerminalOwners.delete(sessionId)
      this.terminalRoutes.delete(sessionId)
    }
  }

  private stopAiSessionsForPlugin(pluginId: string): void {
    this.stopAiSessions((session) => session.pluginId === pluginId)
  }

  private stopAiSessionsForPackageVersion(pluginId: string, packageVersion: string): void {
    this.stopAiSessions(
      (session) => session.pluginId === pluginId && session.packageVersion === packageVersion,
    )
  }

  private stopAiSessions(predicate: (session: AiSessionLedgerEntry) => boolean): void {
    for (const [sessionId, session] of this.aiSessions) {
      if (!predicate(session)) continue
      this.aiSessions.delete(sessionId)
      this.aiTerminalOutputDecoder.dropSession(sessionId)
      void session.client.send('terminal.kill', {
        terminal_session_id: sessionId,
        force: true,
      }).catch(() => {
        // Removal still forgets ownership when the backend is unavailable.
      })
    }
  }

  private revokePackageVersionInBackground(pluginId: string, packageVersion: string): void {
    void this.revokePackageVersion(pluginId, packageVersion).catch((error: unknown) => {
      console.warn(
        `[plugin] package revocation failed for ${pluginId}@${packageVersion}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    })
  }

  private mintTrustedEditorFileGrant(
    capabilityContext: HostCapabilityContext | null | undefined,
    target: { path: string; expectedCanonicalPath?: string; workspaceOnly?: boolean } | undefined,
  ): string | undefined {
    if (!target) return undefined
    const binding = capabilityContext?.runtimeBinding
    if (!binding || !binding.instanceId || !binding.workspaceId || !binding.packageVersion) {
      throw new Error('trusted editor target requires a runtime binding')
    }
    return this.editorSelectionGrants.mint({
      instanceId: binding.instanceId,
      workspaceId: binding.workspaceId,
      packageVersion: binding.packageVersion,
    }, target.path, 'file', target.expectedCanonicalPath).grant
  }

  private canonicalTrustedEditorTarget(target: {
    path: string
    expectedCanonicalPath?: string
  }): string {
    const canonicalPath = resolvePathForContainment(resolve(target.path))
    if (!canonicalPath) throw new Error('selected resource cannot be safely resolved')
    if (target.expectedCanonicalPath !== undefined && canonicalPath !== target.expectedCanonicalPath) {
      throw new Error('selected resource changed before opening')
    }
    return canonicalPath
  }

  private applyTrustedEditorFileTarget(
    params: URLSearchParams | Record<string, string>,
    target: {
      path: string
      expectedCanonicalPath?: string
      workspaceOnly?: boolean
    } | undefined,
    workspacePath: string | null | undefined,
    capabilityContext: HostCapabilityContext | null | undefined,
  ): void {
    const remove = (key: string): void => {
      if (params instanceof URLSearchParams) params.delete(key)
      else delete params[key]
    }
    const set = (key: string, value: string): void => {
      if (params instanceof URLSearchParams) params.set(key, value)
      else params[key] = value
    }
    remove('file_grant')
    if (!target) return
    if (target.workspaceOnly) {
      const canonicalPath = this.canonicalTrustedEditorTarget(target)
      const workspaceRoot = workspacePath
        ? resolvePathForContainment(resolve(workspacePath))
        : null
      if (!workspaceRoot) throw new Error('workspace preview requires a valid workspace binding')
      const relPath = relative(workspaceRoot, canonicalPath)
      if (
        !relPath ||
        relPath === '..' ||
        relPath.startsWith(`..${sep}`) ||
        isAbsolute(relPath)
      ) throw new Error('preview resource escapes the Host workspace binding')
      // PlansApp receives the Host canonical absolute path and performs its
      // own workspace-relative normalization for the preview tab.
      set('filepath', canonicalPath)
      remove('file_ws')
      remove('rel_path')
      return
    }
    const fileGrant = this.mintTrustedEditorFileGrant(capabilityContext, target)
    if (fileGrant) set('file_grant', fileGrant)
  }

  /**
   * create → attach → activate. If the plugin is already running it is brought
   * back to visible and re-bounded (idempotent open); a new open target for the
   * same workspace is delivered in-page (no reload), while a workspace change
   * reloads the entry — mirroring the legacy editor window's routing.
   */
  open(
    hostWindow: BrowserWindow,
    descriptor: PluginLaunchDescriptor,
    bounds: PluginViewBounds,
    opts: {
      closeHostOnHide?: boolean
      mirrorTitle?: boolean
      workspacePath?: string
      capabilityContext?: HostCapabilityContext | null
      trustedEditorFileTarget?: {
        path: string
        expectedCanonicalPath?: string
        workspaceOnly?: boolean
      }
      canDispatch?: () => boolean
    } = {}
  ): string | null {
    if (opts.canDispatch && !opts.canDispatch()) return null
    if (this.isPackageVersionStopping(descriptor.id, descriptor.packageVersion)) return null
    this.registerIpc()

    const existingId = this.legacyInstances.get(descriptor.id)
    const existing = existingId ? this.running.get(existingId) : undefined
    if (existing) {
      if (existing.view.webContents.isDestroyed() || existing.hostWindow.isDestroyed()) {
        // Stale record (renderer crash / host teardown race) — drop it and fall
        // through to a fresh create; loadEntry on a dead webContents would brick.
        this.destroyInstance(existing.instanceId)
      } else if (
        opts.workspacePath !== undefined &&
        (existing.workspacePath === null ||
          resolve(existing.workspacePath) !== resolve(opts.workspacePath))
      ) {
        // A package backend is bound to the workspace at bind time. Recreate
        // the view on a workspace switch instead of reusing a child with the
        // old filesystem root.
        this.destroyInstance(existing.instanceId)
      } else {
        const nextDescriptorContext =
          opts.capabilityContext !== undefined
            ? opts.capabilityContext
            : descriptor.capabilityContext === undefined
              ? existing.capabilityContext
              : descriptor.capabilityContext
        validateV2CapabilityContext(descriptor, nextDescriptorContext ?? null)
        if (existing.hasV2DescriptorIdentity !== hasV2DescriptorIdentity(descriptor)) {
          // A live instance must not switch between v1 and v2 route semantics.
          // Recreate it so all existing routes are released under the old identity.
          this.destroyInstance(existing.instanceId)
        } else {
          if (opts.canDispatch && !opts.canDispatch()) return null
          this.updateInstanceCapabilityContext(existing, nextDescriptorContext)
          const query = descriptor.query ?? ''
          const prevQuery = existing.query
          if (!opts.trustedEditorFileTarget) existing.pendingTrustedTarget = undefined
          if (workspaceOf(query) !== workspaceOf(prevQuery)) {
            // Different workspace → reload the entry with the new params (matches
            // legacy routeEditorWindowOpen's `reload` branch). In-flight queued
            // targets belong to the old workspace and are dropped with it.
            existing.ready = false
            existing.pendingTargets = []
            existing.lastDeliveredTarget = undefined
            this.loadEntry(existing.view, descriptor)
          } else if (query) {
            // Same workspace → deliver the open target in-page (legacy
            // `editor:openFile`/`editor:openDiff` semantics: add/reveal the tab
            // without reloading, so open tabs and unsaved buffers survive). This
            // is also the path an out-of-workspace open takes: it carries
            // `file_ws` in the params, which is not part of the identity above.
            if (opts.trustedEditorFileTarget && !existing.ready) {
              existing.pendingTrustedTarget = {
                query,
                target: opts.trustedEditorFileTarget,
                canDispatch: opts.canDispatch,
              }
            } else {
              const params = queryToParams(query)
              try {
                this.applyTrustedEditorFileTarget(
                  params,
                  opts.trustedEditorFileTarget,
                  existing.workspacePath ?? opts.workspacePath,
                  existing.capabilityContext,
                )
                this.sendOpenTarget(existing, params)
              } catch (error) {
                return null
              }
            }
          }
          existing.query = query
          if (bounds === 'hidden') {
            this.deactivate(existing.instanceId)
          } else {
            existing.fill = bounds === 'fill'
            existing.restartBounds = bounds
            this.applyBounds(existing, bounds)
            this.trackHostResize(existing)
            existing.view.setVisible(true)
            existing.visible = true
          }
          // Surface the window that actually hosts the view. Cross-window opens
          // keep the view on its original host, so focus that one — the open
          // must never land invisibly behind another window.
          revealHostWindow(existing.hostWindow)
          return existing.instanceId
        }
      }
    }

    return this.mountView(hostWindow, descriptor, bounds, descriptor.query ?? '', opts, undefined, true).instanceId
  }

  /**
   * Open one validated Manifest v2 contribution as a fresh Host-owned
   * instance. The descriptor and view contribute only stable registry keys;
   * entry launch data always comes from the current Host registry record.
   * Capability context is either that registry context or an explicitly
   * Host-supplied per-view context; renderer data never supplies either one.
   */
  async openView(
    packageDescriptor: PluginLaunchDescriptor,
    view: PluginViewLaunchDescriptor,
    options: PluginViewOpenOptions
  ): Promise<PluginViewHandle> {
    if (options.canDispatch && !options.canDispatch()) {
      throw new Error('request is no longer active')
    }
    const registered = this.descriptors.get(packageDescriptor.id)
    if (!registered) {
      throw new Error(`package descriptor '${packageDescriptor.id}' is not registered by the Host`)
    }
    if (this.isBuiltinPluginDisabled(registered.id)) {
      throw new Error(builtinPluginDisabledMessage(registered.id))
    }
    if (this.isPackageVersionStopping(registered.id, registered.packageVersion)) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    const canonicalView = registered.views?.find(
      (candidate) => candidate.contributionKey === view.contributionKey
    )
    if (!canonicalView) {
      throw new Error(
        `view '${view.contributionKey}' is not registered by the Host package descriptor`
      )
    }
    const capabilityContext =
      options.capabilityContext === undefined
        ? registered.capabilityContext ?? null
        : options.capabilityContext
    validateV2CapabilityContext(registered, capabilityContext)
    this.registerIpc()

    const trustedEditorFileTarget = options.trustedEditorFileTarget
    const handle = this.mountView(
      options.hostWindow,
      registered,
      options.bounds,
      options.query ?? '',
      {
        ...options,
        capabilityContext,
        trustedEditorFileTarget: undefined,
        deferTrustedEditorFileTarget: trustedEditorFileTarget !== undefined,
      },
      canonicalView,
      false
    )
    if (options.initiallyVisible !== false && options.bounds !== 'hidden') {
      this.focusInstance(handle.instanceId)
    } else {
      this.deactivate(handle.instanceId)
    }
    try {
      await this.waitForBackendBinding(handle.instanceId)
      if (trustedEditorFileTarget) await this.waitForEntryReady(handle.instanceId)
    } catch (error) {
      this.destroyInstance(handle.instanceId)
      throw error
    }
    try {
      if (options.canDispatch && !options.canDispatch()) {
        throw new Error('request is no longer active')
      }
      if (trustedEditorFileTarget) {
        this.updateViewQuery(handle.instanceId, options.query ?? '', trustedEditorFileTarget)
      }
    } catch (error) {
      // A target can become invalid while the initial backend bind is pending.
      // The newly mounted view has no useful caller-visible state in that case;
      // tear it down without touching an existing contribution instance.
      this.destroyInstance(handle.instanceId)
      throw error
    }
    return handle
  }

  /** Restricted Host-only candidate preflight. Each declared frontend view is
   * mounted hidden with no capability binding and must complete its
   * sender-authenticated readiness handshake. The candidate never enters the
   * descriptor/catalog or contribution registries, and every temporary view is
   * destroyed even when a later view fails. */
  async preflightPackageFrontend(
    descriptor: PluginLaunchDescriptor,
    hostWindow: BrowserWindow,
  ): Promise<void> {
    if (hostWindow.isDestroyed()) throw new Error('frontend preflight host window is unavailable')
    const views = descriptor.views ?? []
    if (views.length === 0) throw new Error('frontend preflight requires at least one contributed view')
    this.registerIpc()
    const mounted: PluginViewHandle[] = []
    try {
      for (const view of views) {
        if (hostWindow.isDestroyed()) throw new Error('frontend preflight host window was destroyed')
        const handle = this.mountView(
          hostWindow,
          descriptor,
          'hidden',
          '',
          { capabilityContext: null, initiallyVisible: false, preflight: true },
          view,
          false,
        )
        mounted.push(handle)
        await this.waitForPluginReady(handle.instanceId)
      }
    } finally {
      for (const handle of mounted.reverse()) this.destroyInstance(handle.instanceId)
    }
  }

  /** Ensure a contribution has a live, deactivated instance without creating
   *  a visible placeholder rectangle. The renderer later activates the same
   *  Host-owned instance through {@link openContribution}. */
  async ensureContribution(
    hostWindow: BrowserWindow,
    contributionKey: string,
    options: Omit<PluginViewOpenOptions, 'hostWindow' | 'bounds'>,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.openContribution(hostWindow, contributionKey, {
      ...options,
      bounds: 'hidden',
      initiallyVisible: false,
    })
  }

  /** Everything a mounted instance needs regardless of its carrier: the record
   *  goes live, the sender is bound for capability attribution, and the
   *  webContents hooks driving readiness, failure and queued open targets are
   *  installed. Geometry is deliberately absent — a native view is placed by
   *  {@link applyBounds}, a `<webview>` guest by the host document's CSS. */
  /** The one place a RunningPlugin is shaped, so a `<webview>` guest and a
   *  native view can never drift apart on identity or capability binding. */
  private buildRecord(input: {
    instanceId: string
    carrier?: 'surface' | 'frame'
    frameBindingId?: string | null
    descriptor: PluginLaunchDescriptor
    surface: PluginSurface
    hostWindow: BrowserWindow
    workspacePath: string | null
    query: string
    capabilityContext: HostCapabilityContext | null
    contributionKey: string | null
    isV2Identity: boolean
    openedViaLegacyAdapter: boolean
    fill: boolean
    restartBounds: PluginViewBounds
    closeHostOnHide: boolean
    mirrorTitle: boolean
    visible: boolean
  }): RunningPlugin {
    const { instanceId, descriptor, isV2Identity, openedViaLegacyAdapter } = input
    return {
      instanceId,
      carrier: input.carrier ?? 'surface',
      frameBindingId: input.frameBindingId ?? null,
      documentGeneration: 0,
      id: descriptor.id,
      openedViaLegacyAdapter,
      contributionKey: input.contributionKey,
      hasV2DescriptorIdentity: isV2Identity,
      requires: descriptor.requires,
      capabilityPolicy: descriptor.capabilityPolicy ?? legacyCapabilityPolicy(descriptor.requires),
      capabilityContext:
        isV2Identity || !openedViaLegacyAdapter
          ? this.bindCapabilityContext(input.capabilityContext, instanceId)
          : input.capabilityContext ?? null,
      view: input.surface,
      hostWindow: input.hostWindow,
      workspacePath: input.workspacePath,
      backendWorkspaceId: null,
      backendBindingTask: null,
      query: input.query,
      senderId: input.surface.webContents.id,
      fill: input.fill,
      restartBounds: input.restartBounds,
      detachHostResize: null,
      detachHostClosed: null,
      detachReceiverFrames: null,
      closeHostOnHide: input.closeHostOnHide,
      mirrorTitle: input.mirrorTitle,
      visible: input.visible,
      ready: false,
      lastDeliveredTarget: undefined,
      pluginReady: false,
      releasing: false,
      pendingTargets: [],
    }
  }

  /** Bind a view's package backend: the Plans window's, or a third-party
   *  view's. Runs when the view mounts, and again for a still-open view when
   *  the backends come back after a cancelled quit. */
  private bindViewBackend(
    instanceId: string,
    record: RunningPlugin,
    hostWindow: BrowserWindow,
    descriptor: PluginLaunchDescriptor,
  ): void {
    const activation = nonEmptyString(descriptor.packageVersion) && nonEmptyString(descriptor.packageDir)
      ? this.pluginBackendHost.activationFor(
          descriptor.id,
          descriptor.packageVersion,
          descriptor.packageDir,
        )
      : undefined
    if (
      this.hasPlansBackendView(descriptor, record.workspacePath, record.capabilityContext) &&
      record.workspacePath &&
      activation
    ) {
      const workspaceId = this.workspaceIdForPath(record.workspacePath)
      if (workspaceId) {
        const workspacePath = record.workspacePath
        const binding = Promise.resolve().then(() => this.pluginBackendHost.bindView({
            pluginId: descriptor.id,
            packageVersion: activation.packageVersion,
            workspaceId,
            instanceId,
            contributionKey: record.contributionKey ?? 'navide.plans.window',
            hostWindowId: String(hostWindow.id),
            initiator: HOST_USER_INITIATOR,
          }, descriptor.packageDir!, workspacePath))
        record.backendBindingTask = binding.then(() => {
            if (this.running.get(instanceId) === record) record.backendWorkspaceId = workspaceId
            this.markPlansBackendReady(activation.packageVersion, descriptor.packageDir!)
            this.replaceAbandonedHeadlessPlansBackend(activation.packageVersion, workspacePath)
          }).catch((error: unknown) => {
            if (this.isPlansBackendAvailabilityError(error)) {
              this.markPlansBackendUnavailable('bind-failure')
              try {
                this.plansBackendFailureHandler?.({
                  instanceId,
                  workspacePath,
                  packageVersion: activation.packageVersion,
                  query: record.query,
                  contributionKey: record.contributionKey,
                  reason: error instanceof Error ? error.message : 'Plans backend bind failed',
                })
              } catch {
                // A recovery observer must not change the bind result.
              }
            }
            warnMain(
              `[plugin-backend] Plans view ${instanceId} could not bind: ${
                error instanceof Error ? error.message : 'invalid backend runtime'
              }`,
            )
            if (error instanceof Error && (error as any).cause) {
              const cause = (error as any).cause
              const alreadyLogged =
                (typeof cause === 'object' && cause !== null && this.loggedDiagnosticCauses.has(cause)) ||
                this.loggedDiagnosticCauses.has(error)
              if (!alreadyLogged) {
                if (typeof cause === 'object' && cause !== null) {
                  this.loggedDiagnosticCauses.add(cause)
                }
                this.loggedDiagnosticCauses.add(error)
                const rawCause = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)
                const lines = sanitizeDiagnosticLines(rawCause)
                if (lines.length > 0) {
                  warnMain(`[plugin-backend] Cause: ${lines[0]}`)
                  for (let i = 1; i < lines.length; i++) {
                    warnMain(`[plugin-backend] ${lines[i]}`)
                  }
                }
              }
            }
            throw error
          })
        // The opener consumes this rejection; the attached no-op handler keeps
        // direct callers that do not await open() from producing an unhandled
        // rejection while still allowing waitForBackendBinding to observe it.
        void record.backendBindingTask.catch(() => undefined)
      }
    } else if (
      activation?.thirdParty !== undefined &&
      record.workspacePath &&
      this.hasThirdPartyBackendView(descriptor, record.capabilityContext)
    ) {
      // Third-party children are admitted (consent, sandbox, kill switches)
      // and launched by the Backend Host; a refusal leaves the view running
      // with every backend call failing closed.
      const workspaceId = this.workspaceIdForPath(record.workspacePath)
      if (workspaceId) {
        const workspacePath = record.workspacePath
        const binding = Promise.resolve().then(() => this.pluginBackendHost.bindView({
          pluginId: descriptor.id,
          packageVersion: activation.packageVersion,
          workspaceId,
          instanceId,
          contributionKey: record.contributionKey ?? `${descriptor.id}.view`,
          hostWindowId: String(hostWindow.id),
          initiator: HOST_USER_INITIATOR,
        }, descriptor.packageDir!, workspacePath))
        record.backendBindingTask = binding.then(() => {
          if (this.running.get(instanceId) === record) record.backendWorkspaceId = workspaceId
        }).catch((error: unknown) => {
          warnMain(
            `[plugin-backend] ${descriptor.id} view ${instanceId} could not bind: ${
              error instanceof Error ? error.message : 'invalid backend runtime'
            }`,
          )
          throw error
        })
        void record.backendBindingTask.catch(() => undefined)
      }
    }
  }

  private wireSurface(
    instanceId: string,
    record: RunningPlugin,
    hostWindow: BrowserWindow,
    descriptor: PluginLaunchDescriptor,
    isV2Identity: boolean,
    openedViaLegacyAdapter: boolean,
    preflight = false,
  ): void {
    const contents = record.view.webContents
    this.running.set(instanceId, record)
    const onReceiverNavigation = (): void => {
      // did-navigate fires only after a new main-frame document commits. A
      // cancelled navigation must leave the still-live receiver authoritative.
      this.revokeReceiverFrames(instanceId)
      const current = this.running.get(instanceId)
      if (current?.view.webContents === contents) current.documentGeneration += 1
    }
    contents.on('did-navigate', onReceiverNavigation)
    record.detachReceiverFrames = () => {
      if (!contents.isDestroyed()) contents.removeListener('did-navigate', onReceiverNavigation)
    }
    if (isV2Identity && this.activationFailureHandler && !preflight) {
      // Register the activation immediately so load failure / renderer death
      // remain observable, but do not spend the readiness budget while the
      // entry document itself is still loading.
      this.pendingActivations.set(instanceId, null)
    }
    if (openedViaLegacyAdapter) this.legacyInstances.set(descriptor.id, instanceId)
    if (record.carrier === 'surface') this.bySender.set(record.senderId, instanceId)

    this.bindViewBackend(instanceId, record, hostWindow, descriptor)

    // A plugin needing the backend gets the shared transport connected now (if
    // the backend url is already known) so server-push events reach it without
    // waiting for its first capability call.
    if (descriptor.requires.length > 0) this.ensureBackend()

    // A frame is carried by the Host document, not a plugin WebContents. Its
    // exact-frame observer owns document readiness and revocation; only the
    // host-window close hook belongs to the shared lifecycle.
    if (record.carrier === 'frame') {
      const onHostClosed = (): void => {
        if (this.running.get(instanceId) === record) this.destroyInstance(instanceId)
      }
      hostWindow.on('closed', onHostClosed)
      record.detachHostClosed = () => hostWindow.removeListener('closed', onHostClosed)
      return
    }

    // If the host window goes away, tear the view down with it. Guarded so a
    // later record (view recreated on another window) is never torn down by a
    // stale hook.
    const onHostClosed = (): void => {
      if (this.running.get(instanceId)?.view.webContents === contents) this.destroyInstance(instanceId)
    }
    // A host document that navigates away — reload, devtools reload, dev HMR,
    // crash restore — takes its `<webview>` guests down with it, and a document
    // unload runs no renderer unmount hook, so nothing on the Host side would
    // otherwise mark these teardowns deliberate.
    const onHostNavigated = (
      _event: unknown,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame || isInPlace) return
      const current = this.running.get(instanceId)
      if (current?.view.webContents === contents) current.releasing = true
    }
    hostWindow.on('closed', onHostClosed)
    hostWindow.webContents.on('did-start-navigation', onHostNavigated)
    record.detachHostClosed = () => {
      hostWindow.removeListener('closed', onHostClosed)
      if (!hostWindow.isDestroyed()) {
        hostWindow.webContents.removeListener('did-start-navigation', onHostNavigated)
      }
    }

    // Defensive cleanup: if the view's webContents dies through any path other
    // than destroy() (renderer crash, Electron teardown), drop the record so
    // the next open() recreates instead of loading into a destroyed view.
    //
    // Guarded on identity because a `<webview>` the DOM moves is detached and
    // re-attached: the detached guest's `destroyed` arrives *after* the
    // replacement has been wired onto the same instance id, and would
    // otherwise tear down the live panel and report a spurious activation
    // failure for a plugin that is running fine.
    //
    // `destroyed` cannot tell a fault from an ordinary teardown on its own, so
    // the Host says which it is: every path that takes an instance down on
    // purpose marks the record `releasing` first. Keying on the load phase
    // instead does not work — a guest torn down by the UI seconds *after* its
    // entry loaded (a region re-preparing for another workspace, the host
    // document navigating away) looks exactly like one that died on its own,
    // and reporting it downgrades a working package for the rest of the
    // session. `forgetInstance` settles the pending activation either way.
    contents.once('destroyed', () => {
      const record = this.running.get(instanceId)
      if (record?.view.webContents !== contents) return
      if (!record.releasing) {
        this.failActivation(instanceId, 'plugin renderer exited before readiness')
      }
      const plugin = this.forgetInstance(instanceId)
      if (plugin) this.detachView(plugin)
    })

    // A renderer that crashes (OOM on a large diff, say) leaves its webContents
    // alive, so neither `destroyed` nor `did-fail-load` fires and the record
    // stays "ready" while the surface shows a crash page. An in-window
    // contribution is long-lived, so without this the panel is dead for the
    // rest of the window's life.
    contents.on('render-process-gone', () => {
      if (this.running.get(instanceId)?.view.webContents !== contents) return
      this.failActivation(instanceId, 'plugin renderer process gone')
      this.destroyInstance(instanceId)
    })

    contents.on(
      'did-fail-load',
      (_event, errorCode: number, errorDescription: string, _url: string, isMainFrame: boolean) => {
        if (isMainFrame) {
          this.failActivation(
            instanceId,
            `entry load failed: ${errorDescription} (${errorCode})`
          )
        }
      }
    )

    // Open targets sent before the entry finished loading are queued and
    // flushed here (mirrors the legacy editor window's did-finish-load flush).
    contents.on('did-finish-load', () => {
      const current = this.running.get(instanceId)
      if (current?.view.webContents !== contents) return
      current.ready = true
      if (
        this.pendingActivations.get(instanceId) === null &&
        !current.pluginReady
      ) {
        const timer = setTimeout(() => {
          const live = this.running.get(instanceId)
          if (live?.view.webContents !== contents || live.pluginReady) return
          if (!this.readinessReloaded.has(instanceId)) {
            this.readinessReloaded.add(instanceId)
            // Re-arm through `did-finish-load` by handing the budget back its
            // "entry still loading" sentinel, then reload the guest only.
            this.pendingActivations.set(instanceId, null)
            try {
              // A reload starts a new receiver document. Do this before the
              // Electron call so a racing target is queued for that document
              // instead of being sent to the stale one.
              live.ready = false
              contents.reload()
              return
            } catch {
              // Guest already gone — fall through and report the failure.
            }
          }
          this.failActivation(instanceId, 'plugin readiness handshake timed out')
        }, 10_000)
        timer.unref?.()
        this.pendingActivations.set(instanceId, timer)
      }
      const pendingTrustedTarget = current.pendingTrustedTarget
      current.pendingTrustedTarget = undefined
      if (pendingTrustedTarget) {
        const canDispatch = pendingTrustedTarget.canDispatch ?? (() => true)
        if (canDispatch()) {
          try {
            this.updateViewQuery(
              instanceId,
              pendingTrustedTarget.query,
              pendingTrustedTarget.target,
            )
          } catch {
            // The Host target may have changed while the legacy entry loaded;
            // leave the existing view alive without disclosing a grant/target.
          }
        }
      }
      // A previously delivered receiver-owned target is safe to restore after
      // a readiness retry. A trusted target waiting on this load is delivered
      // after the readiness promise, so it supersedes this replay if valid;
      // replaying first also preserves the old view when that request is
      // revoked or fails its final canonical check.
      if (
        !pendingTrustedTarget &&
        current.pendingTargets.length === 0 &&
        current.lastDeliveredTarget
      ) {
        const replay = { ...current.lastDeliveredTarget }
        contents.send(IPC_OPEN_TARGET, replay)
      }
      for (const params of current.pendingTargets.splice(0)) {
        contents.send(IPC_OPEN_TARGET, params)
        current.lastDeliveredTarget = { ...params }
      }
      // Replay the current transport status: transitions before this load (or
      // while a queued view was still booting) would otherwise be missed and
      // the plugin's optimistic 'connected' default never corrected.
      if (
        current.requires.length > 0 &&
        current.capabilityPolicy.kind !== 'manifest-v2' &&
        this.wsClient
      ) {
        this.emitToInstance(instanceId, 'nav.backend_status', { status: this.wsStatus })
      }
    })

  }

  private mountView(
    hostWindow: BrowserWindow,
    descriptor: PluginLaunchDescriptor,
    bounds: PluginViewBounds,
    query: string,
    opts: {
      closeHostOnHide?: boolean
      mirrorTitle?: boolean
      workspacePath?: string
      capabilityContext?: HostCapabilityContext | null
      initiallyVisible?: boolean
      trustedEditorFileTarget?: {
        path: string
        expectedCanonicalPath?: string
        workspaceOnly?: boolean
      }
      deferTrustedEditorFileTarget?: boolean
      /** Candidate preflight never registers production failure recovery. */
      preflight?: boolean
    },
    viewDescriptor: PluginViewLaunchDescriptor | undefined,
    openedViaLegacyAdapter: boolean
  ): PluginViewHandle {
    const capabilityContext =
      opts.capabilityContext === undefined ? descriptor.capabilityContext : opts.capabilityContext
    validateV2CapabilityContext(descriptor, capabilityContext ?? null)
    const isV2Identity = hasV2DescriptorIdentity(descriptor)
    const instanceId = this.nextInstanceId()
    const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
    params.delete('file_grant')
    const grantContext = isV2Identity
      ? this.bindCapabilityContext(capabilityContext, instanceId)
      : capabilityContext
    if (opts.deferTrustedEditorFileTarget) {
      params.delete('filepath')
      params.delete('file_ws')
      params.delete('line')
    } else {
      this.applyTrustedEditorFileTarget(
        params,
        opts.trustedEditorFileTarget,
        opts.workspacePath,
        grantContext,
      )
    }
    const loadQuery = params.toString() ? `?${params.toString()}` : ''
    const loadDescriptor: PluginLaunchDescriptor = {
      ...descriptor,
      entryFile: viewDescriptor?.entryFile ?? descriptor.entryFile,
      query: loadQuery,
    }

    const preload = join(__dirname, '../preload/plugin-preload.js')
    // A receiver window hosts provider frames as iframes, and each of those
    // frames is a plugin view in its own right: the same Host-owned, node-free
    // preload has to run inside it to announce the document and carry the
    // frame's capability port. Electron only runs preloads in sub-frames when
    // this is on, and only a window that declares `receives` can be a receiver.
    const hostsProviderFrames =
      viewDescriptor?.receives !== undefined ||
      descriptor.views?.some((candidate) => candidate.receives !== undefined) === true
    const view = new WebContentsView({
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        ...(hostsProviderFrames ? { nodeIntegrationInSubFrames: true } : {}),
        // The plugin preload is node-free (webcrypto only), so views run fully
        // sandboxed.
        sandbox: true,
        // Plugin views host AiCliDock terminals — see the main window for why
        // throttling must stay off. One non-throttled webContents also keeps
        // frames drawn for the whole host window, which is how the plugin host
        // windows below (they declare no webPreferences of their own) inherit
        // it. Note Electron 33 still reports visibilityState 'hidden' for an
        // occluded WebContentsView regardless (electron#44590), so do not rely
        // on the Page Visibility API inside plugin views.
        backgroundThrottling: false,
        // Injected so the preload can stamp calls with an authoritative plugin id.
        additionalArguments: [
          `--plugin-id=${descriptor.id}`,
          ...(this.hasPlansBackendView(descriptor, opts.workspacePath, capabilityContext)
            ? ['--plugin-backend=1']
            : []),
        ],
      },
    })

    // A dedicated host window carries no UI of its own — its webContents stays
    // blank, so the plugin's document.title never reaches the window and the
    // macOS Window menu / Mission Control / Dock keep showing the static
    // creation-time title. Mirror the view's page title onto the host so every
    // window follows the same `<context> — <feature>` naming (see
    // docs/en-US/plugin-development.md). Opt-in: a plugin embedded in the main
    // window must not overwrite that window's title.
    if (opts.mirrorTitle) {
      view.webContents.on('page-title-updated', (_event, title) => {
        if (!hostWindow.isDestroyed() && title) hostWindow.setTitle(title)
      })
    }

    // attach
    hostWindow.contentView.addChildView(view)

    const record = this.buildRecord({
      instanceId,
      descriptor,
      surface: nativeSurface(view),
      hostWindow,
      workspacePath: opts.workspacePath ?? null,
      query: loadQuery,
      capabilityContext: capabilityContext ?? null,
      contributionKey: viewDescriptor?.contributionKey ?? null,
      isV2Identity,
      openedViaLegacyAdapter,
      fill: bounds === 'fill',
      restartBounds: bounds,
      closeHostOnHide: opts.closeHostOnHide ?? false,
      mirrorTitle: opts.mirrorTitle ?? false,
      visible: opts.initiallyVisible !== false && bounds !== 'hidden',
    })
    this.wireSurface(
      instanceId,
      record,
      hostWindow,
      descriptor,
      isV2Identity,
      openedViaLegacyAdapter,
      opts.preflight === true,
    )
    this.applyBounds(record, bounds)
    this.trackHostResize(record)

    this.loadEntry(view, loadDescriptor, viewDescriptor !== undefined)

    // Activate only when requested. Hidden contributions have no visible
    // placeholder bounds; their WebContents is still alive for subscriptions.
    if (opts.initiallyVisible !== false && bounds !== 'hidden') view.setVisible(true)
    else view.setVisible(false)
    return Object.freeze({ instanceId })
  }

  /** Resolve a Host-supplied workspace path for an authenticated instance. */
  workspacePathOfInstance(instanceId: string): string | null {
    return this.running.get(instanceId)?.workspacePath ?? null
  }

  /** Deliver only through the receiver that owns this instance. Frame traffic
   * never transits the Host document's webContents. */
  private sendToPlugin(record: RunningPlugin, channel: string, payload: unknown): boolean {
    if (record.carrier === 'frame') {
      const binding = this.pluginFrameBindings.activeForInstance(record.instanceId)
      if (!binding || this.activePluginFrame(binding) !== record) return false
      return this.pluginFrameBindings.post(record.instanceId, channel, payload)
    }
    if (record.view.webContents.isDestroyed()) return false
    record.view.webContents.send(channel, payload)
    return true
  }

  /** Deliver a new open target to a running view, queueing until its entry has
   *  finished loading (so a target racing the first load is never lost). */
  private sendOpenTarget(record: RunningPlugin, params: Record<string, string>): void {
    if (this.isPluginStopping(record)) return
    if (record.ready || record.carrier === 'frame') {
      if (this.sendToPlugin(record, IPC_OPEN_TARGET, params)) {
        record.lastDeliveredTarget = { ...params }
      } else if (record.carrier === 'frame') {
        record.pendingTargets.push(params)
      }
    } else record.pendingTargets.push(params)
  }

  /** Apply a bounds spec: `'fill'` overlays the host's full content area. */
  private applyBounds(record: RunningPlugin, bounds: PluginViewBounds): void {
    if (bounds === 'hidden') return
    if (bounds === 'fill') {
      const { width, height } = record.hostWindow.getContentBounds()
      record.view.setBounds({ x: 0, y: 0, width, height })
    } else {
      record.view.setBounds(bounds)
    }
    this.webViewRegistry?.hostChanged(record.instanceId)
  }

  /** (Re)attach the host `resize` listener for a fill view — the overlay tracks
   *  the host's content bounds. Fixed-rect views detach and don't track. */
  private trackHostResize(record: RunningPlugin): void {
    record.detachHostResize?.()
    record.detachHostResize = null
    if (!record.fill) return
    const host = record.hostWindow
    const apply = (): void => {
      if (host.isDestroyed() || record.view.webContents.isDestroyed()) return
      this.applyBounds(record, 'fill')
    }
    if (isMac()) {
      host.on('resize', apply)
      record.detachHostResize = () => host.removeListener('resize', apply)
      return
    }
    // Windows and Linux: a maximize or full-screen switch can land without a
    // `resize`, or with the old content bounds still reported (GNOME), which
    // left the view at its first size. Follow the state events too, and read
    // the bounds once more after the window manager has settled.
    let settle: ReturnType<typeof setTimeout> | null = null
    const onChange = (): void => {
      apply()
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => { settle = null; apply() }, HOST_RESIZE_SETTLE_MS)
    }
    for (const event of HOST_RESIZE_EVENTS) host.on(event as 'resize', onChange)
    record.detachHostResize = () => {
      for (const event of HOST_RESIZE_EVENTS) host.removeListener(event as 'resize', onChange)
      if (settle) clearTimeout(settle)
      settle = null
    }
  }

  /** Load a legacy entry from the dev server when available, or a built file.
   *  Contribution views always load their canonical view entry file so one
   *  package-level devUrl cannot collapse multiple views onto one document. */
  private loadEntry(
    view: PluginSurface,
    descriptor: PluginLaunchDescriptor,
    forceFile = false
  ): void {
    const devUrl = !forceFile && process.env['ELECTRON_RENDERER_URL'] ? descriptor.devUrl : null
    const query = this.plansProvenanceQuery(descriptor, descriptor.query ?? '')
    if (devUrl) void view.webContents.loadURL(devUrl + query)
    else void view.webContents.loadFile(descriptor.entryFile, query ? { search: query } : undefined)
  }

  /** Show a plugin view without recreating it. A fill view re-syncs to the
   *  host's content bounds and resumes tracking host resizes. This does not
   *  change OS focus; call {@link focusInstance} explicitly when needed. */
  activate(instanceId: string): void {
    const plugin = this.resolveInstance(instanceId)
    if (!plugin) return
    if (this.isPluginStopping(plugin)) return
    if (plugin.carrier === 'frame') {
      plugin.visible = true
      return
    }
    if (plugin.fill && !plugin.hostWindow.isDestroyed()) {
      this.applyBounds(plugin, 'fill')
      this.trackHostResize(plugin)
    }
    plugin.view.setVisible(true)
    plugin.visible = true
    this.webViewRegistry?.hostChanged(plugin.instanceId)
  }

  /** Focus one exact live Host-owned instance without changing its visibility
   *  or bounds. Stale/unknown instance ids are ignored. */
  focusInstance(instanceId: string): void {
    const plugin = this.running.get(instanceId)
    if (!plugin || this.isPluginStopping(plugin) || plugin.view.webContents.isDestroyed()) return
    if (plugin.carrier === 'frame') return
    revealHostWindow(plugin.hostWindow)
    plugin.view.webContents.focus()
  }

  /** Hide a plugin view without destroying its WebContents. Stops tracking
   *  host resizes while hidden (open()/activate re-attach the listener). */
  deactivate(instanceId: string): void {
    const plugin = this.resolveInstance(instanceId)
    if (!plugin) return
    if (plugin.carrier === 'frame') {
      plugin.visible = false
      return
    }
    plugin.detachHostResize?.()
    plugin.detachHostResize = null
    plugin.view.setVisible(false)
    plugin.visible = false
    this.webViewRegistry?.hostChanged(plugin.instanceId)
  }

  /** Update the plugin view's rect (host-driven layout). */
  setBounds(instanceId: string, bounds: PluginBounds): void {
    const plugin = this.resolveInstance(instanceId)
    if (!plugin || plugin.carrier === 'frame') return
    plugin.fill = false
    plugin.restartBounds = { ...bounds }
    plugin.view.setBounds(bounds)
    this.webViewRegistry?.hostChanged(plugin.instanceId)
  }

  /** Host-driven incremental entry target update for one exact v2 instance.
   *  The package keeps its in-page state while the Host changes a diff target;
   *  the workspace identity itself is changed only by recreating the view. */
  updateViewQuery(
    instanceId: string,
    query: string,
    trustedEditorFileTarget?: {
      path: string
      expectedCanonicalPath?: string
      workspaceOnly?: boolean
    },
  ): void {
    const plugin = this.running.get(instanceId)
    if (!plugin || this.isPluginStopping(plugin)) return
    if (query) {
      const params = queryToParams(query)
      this.applyTrustedEditorFileTarget(
        params,
        trustedEditorFileTarget,
        plugin.workspacePath,
        plugin.capabilityContext,
      )
      this.sendOpenTarget(plugin, params)
    }
    plugin.query = query
  }

  /** Host-only integration seam: register an event/backend subscription under
   *  one exact view instance. The returned function unregisters and disposes
   *  it exactly once; instance teardown invokes the same wrapper for any
   *  remaining subscription. */
  registerInstanceSubscription(instanceId: string, dispose: () => void): () => void {
    if (!this.running.has(instanceId)) {
      try {
        dispose()
      } catch {
        // A stale registration must not make a caller's cleanup path throw.
      }
      return () => undefined
    }
    const subscriptions = this.instanceSubscriptions.get(instanceId) ?? new Set<() => void>()
    this.instanceSubscriptions.set(instanceId, subscriptions)
    let registered = true
    const unregister = (): void => {
      if (!registered) return
      registered = false
      subscriptions.delete(unregister)
      if (
        subscriptions.size === 0 &&
        this.instanceSubscriptions.get(instanceId) === subscriptions
      ) {
        this.instanceSubscriptions.delete(instanceId)
      }
      try {
        dispose()
      } catch {
        // A broken subscription must not make caller or instance teardown throw.
      }
    }
    subscriptions.add(unregister)
    return unregister
  }

  /** Destroy the legacy v1 instance identified by plugin id. */
  destroy(pluginId: string): void {
    const legacyInstanceId = this.legacyInstances.get(pluginId)
    if (legacyInstanceId) this.destroyInstance(legacyInstanceId)
  }

  /** Detach and destroy one exact Host-owned instance. Stale/unknown ids are
   *  ignored and never fall back to a plugin id. */
  destroyInstance(instanceId: string): void {
    const current = this.running.get(instanceId)
    if (current) current.releasing = true
    const plugin = this.forgetInstance(instanceId)
    if (!plugin || plugin.carrier === 'frame') return
    this.detachView(plugin)
    try {
      if (!plugin.view.webContents.isDestroyed()) {
        plugin.view.webContents.close()
      }
    } catch {
      // View/window already torn down by Electron — nothing to release.
    }
  }

  // -- loader registry (installed / available descriptors) ----------------

  /**
   * Register (or replace) an available plugin descriptor. Ids under the
   * reserved `navide.` namespace may only be registered by the host itself
   * (`opts.builtin`) or by an install whose App-authorized Official Registry
   * verification passed (`opts.official`); the internal `host` identity is
   * never a plugin id.
   */
  registerDescriptor(
    descriptor: PluginLaunchDescriptor,
    opts: { builtin?: boolean; official?: boolean } = {}
  ): void {
    if (descriptor.id === HOST_EVENT_SOURCE_PLUGIN_ID) {
      throw new Error(`internal Host event identity '${HOST_EVENT_SOURCE_PLUGIN_ID}' is not a plugin id`)
    }
    if (!opts.builtin && !opts.official && isReservedPluginId(descriptor.id)) {
      throw new Error(
        `refusing to register reserved plugin id '${descriptor.id}' without official verification`
      )
    }
    this.descriptors.set(descriptor.id, descriptor)
    this.descriptorSources.set(descriptor.id, opts.builtin ? 'host-bundled' : 'installed-catalog')
  }

  /** Register one Host-approved package-local backend activation. */
  registerBackendActivation(activation: BackendPluginLaunchSpec): void {
    if (this.isPluginDisabled(activation.pluginId)) {
      throw new BackendPluginError('INVALID_ACTIVATION', 'Backend plugin is disabled.')
    }
    const descriptor = this.descriptors.get(activation.pluginId)
    const activationPackageDir = canonicalBackendPackageDir(activation.packageDir)
    const descriptorPackageDir = descriptor
      ? canonicalBackendPackageDir(descriptor.packageDir)
      : null
    const installed = !descriptor ? this.installedPackages.get(activation.pluginId) : undefined
    const installedPackageDir = !descriptor
      ? this.installedPackageDirectories.get(activation.pluginId)
      : undefined
    const matchesDescriptor = Boolean(
      descriptor &&
      descriptor.id === activation.pluginId &&
      descriptor.packageVersion === activation.packageVersion &&
      descriptorPackageDir &&
      activationPackageDir &&
      descriptorPackageDir === activationPackageDir,
    )
    // A verified Manifest v2 package can legitimately contribute only a
    // backend. It has no selected frontend descriptor, but it must still
    // match the exact installed package identity recorded by the Host loader.
    const matchesBackendOnlyPackage = Boolean(
      !descriptor &&
      installed &&
      installed.packageVersion === activation.packageVersion &&
      installedPackageDir &&
      activationPackageDir &&
      installedPackageDir === activationPackageDir,
    )
    if (!matchesDescriptor && !matchesBackendOnlyPackage) {
      throw new BackendPluginError(
        'INVALID_ACTIVATION',
        descriptor
          ? 'Backend activation does not match the selected package descriptor.'
          : installed
            ? 'Backend activation does not match the installed package identity.'
            : 'Backend activation has no selected package descriptor.',
      )
    }
    activation = { ...activation, packageDir: descriptorPackageDir ?? installedPackageDir! }
    const existing = this.pluginBackendHost.activationForPlugin(activation.pluginId)
    if (existing) {
      throw new BackendPluginError(
        'INVALID_ACTIVATION',
        existing.packageVersion === activation.packageVersion
          ? 'Backend package version is already registered.'
          : 'Backend plugin id is already registered with a different package version.',
      )
    }
    this.pluginBackendHost.register(activation)
    this.refreshHostSessionRegistration()
  }

  /**
   * True only while this Host holds, or is acquiring, a package backend child.
   *
   * A registered activation is not activity: `registerBundledPlans()` registers
   * the bundled Plans backend as metadata on every packaged launch and spawns
   * nothing, so counting registrations made this predicate permanently true and
   * any caller that branched on it dead. Only bound runtimes count: a view or
   * headless MCP instance whose backend runtime is bound or still draining, and
   * the in-flight work that can only exist against one of those.
   *
   * Liveness is answered by {@link PluginBackendHost.hasLiveBackendChildren},
   * which owns the child processes. Manager-side view bookkeeping must not be
   * read here: every asynchronous teardown drops it synchronously at its head
   * (`forgetInstance` before the unbind drains) or never resets it at all
   * (`backendWorkspaceId`), so the predicate would be false while a child is
   * still closing and true forever after `closeBackendPlugins()` - the second
   * of which livelocks the re-entrant `before-quit` that drives shutdown.
   * Only in-flight work the Host cannot see yet is added on top: renderer
   * calls and subscriptions, and a headless bind that has not produced a bound
   * runtime yet.
   */
  hasBackendActivity(): boolean {
    return (
      this.pendingBackendCalls.size > 0 ||
      this.pendingBackendSubscriptions.size > 0 ||
      this.pendingHeadlessBackendBinds.size > 0 ||
      this.pendingHeadlessAgentToolBinds.size > 0 ||
      this.pluginBackendHost.hasLiveBackendChildren()
    )
  }

  /** True only when the Host has registered the exact package-version backend
   * activation that a v2 view or headless agent route will use. */
  hasBackendActivation(pluginId: string, packageVersion: string): boolean {
    return this.pluginBackendHost.hasActivation(pluginId, packageVersion)
  }

  /** Host-only rollback snapshot of an already approved backend registration. */
  getBackendActivation(pluginId: string, packageVersion: string): BackendPluginLaunchSpec | undefined {
    const packageDir = this.descriptors.get(pluginId)?.packageDir
      ?? this.installedPackageDirectories.get(pluginId)
    return packageDir ? this.pluginBackendHost.activationFor(pluginId, packageVersion, packageDir) : undefined
  }

  async closeBackendPlugins(): Promise<void> {
    for (const calls of this.pendingBackendCalls.values()) {
      for (const controller of calls.values()) controller.abort()
    }
    for (const subscriptions of this.pendingBackendSubscriptions.values()) {
      for (const pending of subscriptions.values()) pending.unregister?.()
    }
    this.pendingBackendCalls.clear()
    this.pendingBackendSubscriptions.clear()
    this.headlessBackendInstances.clear()
    this.pendingHeadlessBackendBinds.clear()
    this.headlessAgentToolInstances.clear()
    this.pendingHeadlessAgentToolBinds.clear()
    this.headlessAgentToolRoots.clear()
    this.plansBackendHealth = 'unknown'
    this.plansBackendHealthIdentity = null
    this.plansDeadBackendInstances.clear()
    this.plansAbandonedBackendInstances.clear()
    this.headlessPlansWorkspacePaths.clear()
    this.activationsBeforeClose = this.pluginBackendHost.registeredActivations()
    await this.pluginBackendHost.close()
  }

  /** Undo {@link closeBackendPlugins} for an app that keeps running (a quit
   *  cancelled after its teardown): register the activations again and bind
   *  every still-open view that had a backend. Children start on first call,
   *  as after a launch. */
  reopenBackendPlugins(): void {
    const activations = this.activationsBeforeClose
    this.activationsBeforeClose = []
    for (const activation of activations) {
      try {
        this.registerBackendActivation(activation)
      } catch (error) {
        warnMain(`[plugin-backend] ${activation.pluginId} could not be registered again: ${
          error instanceof Error ? error.message : String(error)
        }`)
      }
    }
    for (const [instanceId, record] of this.running) {
      if (!record.backendBindingTask || record.hostWindow.isDestroyed()) continue
      const descriptor = this.descriptors.get(record.id)
      if (!descriptor) continue
      record.backendWorkspaceId = null
      record.backendBindingTask = null
      this.bindViewBackend(instanceId, record, record.hostWindow, descriptor)
    }
  }

  /**
   * Register a host-bundled builtin descriptor. If an officially-verified
   * marketplace package for the id was scanned first, its frontend descriptor
   * or backend-only inventory entry takes precedence. The builtin is only
   * remembered as the fallback {@link removeInstalledPlugin} reverts to.
   */
  registerBuiltin(descriptor: PluginLaunchDescriptor): void {
    this.builtinFallbacks.set(descriptor.id, descriptor)
    if (!this.installedPackages.has(descriptor.id) && !this.descriptors.has(descriptor.id)) {
      this.registerDescriptor(descriptor, { builtin: true })
    }
  }

  /** Replace the active descriptor with an explicit Host recovery copy.
   *  Recovery is intentionally destructive to live instances: a running v2
   *  view must not continue using the old package after its descriptor has
   *  been rolled back. The package inventory itself is left untouched. */
  replaceBuiltinForRecovery(descriptor: PluginLaunchDescriptor): void {
    const packageVersion = this.packageVersionForPluginId(descriptor.id)
    if (packageVersion) {
      this.recoveryPackageVersions.set(descriptor.id, packageVersion)
      this.revokePackageVersionInBackground(descriptor.id, packageVersion)
    }
    this.builtinFallbacks.set(descriptor.id, descriptor)
    this.stopAiSessionsForPlugin(descriptor.id)
    this.destroyPluginInstances(descriptor.id)
    this.clearTerminalRoutes(descriptor.id)
    this.registerDescriptor(descriptor, { builtin: true })
  }

  /** Undo {@link replaceBuiltinForRecovery}: drop the recovery builtin and
   *  re-register the Manifest v2 descriptor scanned from the App-bundled
   *  package directory.
   *
   *  Recovery leaves the package registered in `installedPackages`, so
   *  {@link loadFactoryPlugin} refuses to run a second time ('installed
   *  package is active'). Without this seam a session that fell back to legacy
   *  Git could only reach v2 again by restarting the App — the Extensions
   *  restore button threw instead of restoring. */
  restoreFactoryAfterRecovery(
    packageDir: string,
    expectedPluginId: string,
  ):
    | { restored: true; activation: PluginActivationCatalogEntry }
    | { restored: false; reason: string } {
    if (!this.builtinFallbacks.has(expectedPluginId)) {
      return { restored: false, reason: 'plugin is not in legacy recovery' }
    }
    const scanned = loadPluginDir(packageDir)
    if (scanned.error) return { restored: false, reason: scanned.error }
    const { activation, descriptor } = scanned
    if (!activation || !descriptor) {
      return { restored: false, reason: 'factory package must use Manifest v2' }
    }
    if (activation.pluginId !== expectedPluginId || descriptor.id !== expectedPluginId) {
      return {
        restored: false,
        reason: `expected factory plugin '${expectedPluginId}', received '${activation.pluginId}'`,
      }
    }
    if (descriptor.capabilityPolicy?.kind !== 'manifest-v2') {
      return { restored: false, reason: 'factory package has no Manifest v2 policy' }
    }
    activation.provenance = 'factory-bundled'
    const previousVersion =
      this.packageVersionForPluginId(expectedPluginId) ?? this.recoveryPackageVersions.get(expectedPluginId)
    // Revoking the exact version this call is about to re-register would mark
    // the restored package stopping before it is even registered (the stopping
    // key is added synchronously), so the restored Git contribution would be
    // refused for the whole drain. Only a genuinely older version is worth
    // revoking; the plugin-scoped teardown below covers the same-version case.
    if (previousVersion && previousVersion !== descriptor.packageVersion) {
      this.revokePackageVersionInBackground(expectedPluginId, previousVersion)
    }
    this.stopAiSessionsForPlugin(expectedPluginId)
    this.destroyPluginInstances(expectedPluginId)
    this.clearTerminalRoutes(expectedPluginId)
    this.descriptors.delete(expectedPluginId)
    this.registerDescriptor(descriptor, { official: true })
    this.descriptorSources.set(expectedPluginId, 'factory-bundle')
    this.recoveryPackageVersions.delete(expectedPluginId)
    this.builtinFallbacks.delete(expectedPluginId)
    return { restored: true, activation }
  }

  /** Look up a registered descriptor by id. */
  getDescriptor(id: string): PluginLaunchDescriptor | undefined {
    return this.descriptors.get(id)
  }

  /** Inject a Host-authenticated grant/binding after package approval. This is
   * deliberately separate from registerDescriptor/official eligibility so a
   * first-party identity can never become an automatic capability grant. */
  setCapabilityContext(pluginId: string, context: HostCapabilityContext | null): void {
    const descriptor = this.descriptors.get(pluginId)
    const running = this.instancesForPlugin(pluginId)
    if (descriptor) validateV2CapabilityContext(descriptor, context)
    if (
      context !== null &&
      running.some(
        (instance) =>
          instance.hasV2DescriptorIdentity &&
          (descriptor === undefined || !hasV2DescriptorIdentity(descriptor))
      )
    ) {
      throw new Error(`cannot validate capability context for unregistered plugin '${pluginId}'`)
    }
    if (
      running.some(
        (instance) =>
          instance.hasV2DescriptorIdentity &&
          instance.capabilityContext?.storageSnapshotTier !== context?.storageSnapshotTier
      )
    ) {
      throw new Error('storage snapshot tier is fixed for a live plugin instance; recreate the instance')
    }
    if (descriptor) this.descriptors.set(pluginId, { ...descriptor, capabilityContext: context })
    for (const runningInstance of running) {
      this.updateInstanceCapabilityContext(runningInstance, context)
    }
  }

  /** All registered (installed + built-in) descriptors. */
  listDescriptors(): PluginLaunchDescriptor[] {
    return [...this.descriptors.values()]
  }

  /** Current and peak in-flight backend calls per plugin (never capped); the activity page (D-f) reads this. */
  backendCallConcurrency(): BackendCallConcurrency[] {
    return this.pluginBackendHost.backendCallConcurrency()
  }

  /** Backend children, subscriptions, Bridge requests and queue backlog, now and at the most (never capped); the activity page (D-f) reads this. */
  backendResourceUsage(): BackendResourceUsage {
    return { ...this.pluginBackendHost.backendResourceUsage(), backend: { resultHelper: { ...this.resultHelperState } } }
  }

  /** All validated packages installed from disk, including backend-only packages. */
  listInstalledPackages(): InstalledPluginPackageSummary[] {
    return [...this.installedPackages.values()].map((summary) => ({
      id: summary.id,
      requires: [...summary.requires],
      ...(summary.packageVersion ? { packageVersion: summary.packageVersion } : {}),
      ...(summary.manifestPermissions
        ? { manifestPermissions: copyManifestPermissionsSummary(summary.manifestPermissions) }
        : {}),
      ...(summary.provenance ? { provenance: summary.provenance } : {}),
      ...(summary.source ? { source: summary.source } : {}),
      ...(summary.warning ? { warning: summary.warning } : {}),
    }))
  }

  /** Whether an installed package's manifest declares a native backend (B2-a inventory). */
  installedPackageHasBackend(pluginId: string): boolean {
    return this.installedPackages.get(pluginId)?.hasBackend === true
  }

  /** Register one Host-selected local unpacked development bundle. The fixed
   * Host call site, not package data, grants the reserved builtin identity.
   * These fixed app bundles are not the explicit local-package acceptance
   * path and therefore do not enter the installed-package inventory. */
  registerDeveloperDescriptor(descriptor: PluginLaunchDescriptor): void {
    this.registerDescriptor(descriptor, { builtin: true })
  }

  /**
   * Load exactly one Host-selected frontend package for Developer
   * Mode. This intentionally reads the selected directory only; it never
   * scans a parent directory or turns an arbitrary package tree into a
   * registry-like inventory. Backend contributions remain fail-closed, except
   * for a folder the user picked in Settings with Developer Mode on (card K4,
   * `allowBackend`): its backend then goes through the same sandboxed
   * third-party admission and native backend consent as any other.
   */
  loadExplicitDeveloperPlugin(
    packageDir: string | undefined,
    optedIn = process.env['AGENT_TEAM_PLUGIN_DEV'] === '1',
    options: { allowBackend?: boolean } = {},
  ): { loaded: true; pluginId: string } | { loaded: false; error: string } {
    if (!optedIn) {
      return { loaded: false, error: 'Developer Mode explicit package loading requires opt-in' }
    }
    if (!packageDir || packageDir.trim().length === 0) {
      return { loaded: false, error: 'an explicit package directory must be selected' }
    }
    const scanned = loadPluginDir(packageDir)
    if (scanned.error) return { loaded: false, error: scanned.error }
    const activation = scanned.activation
    const descriptor = scanned.descriptor
    const pluginId = activation?.pluginId ?? descriptor?.id
    if (!pluginId || !scanned.packageSummary) {
      return {
        loaded: false,
        error: 'Developer Mode requires a valid frontend package',
      }
    }
    if (activation?.backend && options.allowBackend !== true) {
      return { loaded: false, error: 'Developer Mode cannot load backend contributions' }
    }
    if (!descriptor) {
      return {
        loaded: false,
        error: 'Developer Mode requires a valid frontend package',
      }
    }
    if (isReservedPluginId(pluginId)) {
      return {
        loaded: false,
        error: `Developer Mode cannot claim reserved plugin id '${pluginId}'`,
      }
    }
    const summary: InstalledPluginPackageSummary = {
      ...scanned.packageSummary,
      provenance: 'developer-local-unpacked',
      warning: 'Unsigned local unpacked plugin — Developer Mode only',
    }
    try {
      this.registerInstalledPackage(summary, descriptor, {}, packageDir)
    } catch (error) {
      return { loaded: false, error: error instanceof Error ? error.message : String(error) }
    }
    return { loaded: true, pluginId }
  }

  /** Load one App-bundled Manifest v2 package through the same descriptor,
   * catalog, grant, and instance runtime as a Registry package. App bundle
   * integrity is the trust source, so no Registry receipt is consulted. */
  loadFactoryPlugin(
    packageDir: string,
    expectedPluginId: string,
  ):
    | {
        loaded: true
        pluginId: string
        packageVersion: string
        activation: PluginActivationCatalogEntry
      }
    | { loaded: false; reason: string } {
    if (this.installedPackages.has(expectedPluginId)) {
      return { loaded: false, reason: 'installed package is active' }
    }
    const scanned = loadPluginDir(packageDir)
    if (scanned.error) return { loaded: false, reason: scanned.error }
    const activation = scanned.activation
    const summary = scanned.packageSummary
    if (!activation || !summary) {
      return { loaded: false, reason: 'factory package must use Manifest v2' }
    }
    if (activation.pluginId !== expectedPluginId || summary.id !== expectedPluginId) {
      return {
        loaded: false,
        reason: `expected factory plugin '${expectedPluginId}', received '${activation.pluginId}'`,
      }
    }
    if (!scanned.descriptor) {
      return { loaded: false, reason: 'factory package must contribute a frontend view' }
    }
    summary.provenance = 'factory-bundled'
    activation.provenance = 'factory-bundled'
    this.registerInstalledPackage(summary, scanned.descriptor, { official: true }, packageDir)
    this.descriptorSources.set(expectedPluginId, 'factory-bundle')
    return {
      loaded: true,
      pluginId: activation.pluginId,
      packageVersion: activation.packageVersion,
      activation,
    }
  }

  /** Replace one installed package's inventory and optional frontend descriptor
   *  together. A backend-only update therefore cannot retain an older view. */
  registerInstalledPackage(
    summary: InstalledPluginPackageSummary,
    descriptor?: PluginLaunchDescriptor,
    opts: { official?: boolean } = {},
    packageDir?: string,
  ): void {
    if (summary.id === HOST_EVENT_SOURCE_PLUGIN_ID) {
      throw new Error(`internal Host event identity '${HOST_EVENT_SOURCE_PLUGIN_ID}' is not a plugin id`)
    }
    if (descriptor && descriptor.id !== summary.id) {
      throw new Error(
        `installed package id '${summary.id}' does not match descriptor id '${descriptor.id}'`
      )
    }
    if (!opts.official && isReservedPluginId(summary.id)) {
      throw new Error(
        `refusing to register reserved plugin id '${summary.id}' without official verification`
      )
    }

    const previousVersion = this.packageVersionForPluginId(summary.id)
    if (previousVersion && (
      this.pluginBackendHost.hasActivation(summary.id, previousVersion) ||
      this.instancesForPackageVersion(summary.id, previousVersion).length > 0
    )) {
      this.revokePackageVersionInBackground(summary.id, previousVersion)
    }
    this.destroyPluginInstances(summary.id)
    this.clearTerminalRoutes(summary.id)
    this.descriptors.delete(summary.id)
    if (descriptor && !this.isPluginDisabled(summary.id, summary.provenance)) this.registerDescriptor(descriptor, opts)
    const canonicalPackageDir = canonicalBackendPackageDir(packageDir ?? descriptor?.packageDir)
    if (canonicalPackageDir) this.installedPackageDirectories.set(summary.id, canonicalPackageDir)
    else this.installedPackageDirectories.delete(summary.id)
    this.installedPackages.set(summary.id, {
      id: summary.id,
      requires: [...summary.requires],
      ...(summary.packageVersion ? { packageVersion: summary.packageVersion } : {}),
      ...(summary.manifestPermissions
        ? { manifestPermissions: copyManifestPermissionsSummary(summary.manifestPermissions) }
        : {}),
      ...(summary.provenance ? { provenance: summary.provenance } : {}),
      ...(summary.source ? { source: summary.source } : {}),
      ...(summary.warning ? { warning: summary.warning } : {}),
      ...(summary.hasBackend ? { hasBackend: true as const } : {}),
    })
  }

  /**
   * Flatten validated Manifest v2 contribution metadata for Host discovery.
   * This is the issue 01 seam; issue 14 consumes this catalog for instance
   * creation and owns placement, mounting, and lifecycle. This method does not
   * create or reuse runtime views.
   */
  listViewContributions(): PluginViewLaunchDescriptor[] {
    return [...this.descriptors.values()].flatMap((descriptor) => descriptor.views ?? [])
  }

  /** Deterministic registry projection used by Host navigation and region
   *  composition. This projection contains no live view identity. */
  listContributionCatalog(): PluginContributionCatalogEntry[] {
    return buildPluginContributionCatalog(this.enabledDescriptors())
  }

  /** Host-only left/detail pairing. The Host supplies opaque live identities;
   * neither receiver nor provider selects its counterpart. */
  pairDetailSource(sourceInstanceId: string, receiverId: string): { ok: true } | { ok: false; reason: string } {
    const source = this.running.get(sourceInstanceId)
    const receiver = this.receiverRegistrations.get(receiverId)
    const sourceDescriptor = source ? this.descriptors.get(source.id) : undefined
    const sourceView = sourceDescriptor?.views?.find((view) => view.contributionKey === source?.contributionKey)
    const detailView = sourceView?.detailView
      ? sourceDescriptor?.views?.find((view) => view.id === sourceView.detailView && view.location === 'detail')
      : undefined
    const receiverPlugin = receiver ? this.running.get(receiver.receiverInstanceId) : undefined
    const receiverDescriptor = receiverPlugin ? this.descriptors.get(receiverPlugin.id) : undefined
    const receiverView = receiverDescriptor?.views?.find((view) => view.contributionKey === receiverPlugin?.contributionKey)
    const workspacePath = source?.workspacePath ? resolve(source.workspacePath) : null
    if (!source) return { ok: false, reason: 'source instance is not running' }
    if (!receiver) return { ok: false, reason: 'receiver is not registered' }
    if (!receiverPlugin) return { ok: false, reason: 'receiver instance is not running' }
    if (!sourceDescriptor || !sourceView) return { ok: false, reason: 'source view is unavailable' }
    if (!detailView) return { ok: false, reason: 'source declares no detail view' }
    if (!receiverDescriptor || !receiverView) return { ok: false, reason: 'receiver view is unavailable' }
    if (sourceView.location !== 'left') return { ok: false, reason: 'source view is not a left contribution' }
    if (!detailView.targetSchema) return { ok: false, reason: 'detail view declares no target schema' }
    if (!source.hasV2DescriptorIdentity || !receiverPlugin.hasV2DescriptorIdentity) {
      return { ok: false, reason: 'source and receiver must both be Manifest v2 instances' }
    }
    if (!source.capabilityContext || !receiverPlugin.capabilityContext) {
      return { ok: false, reason: 'capability context is missing' }
    }
    if (!workspacePath || receiverPlugin.workspacePath === null) {
      return { ok: false, reason: 'workspace path is missing' }
    }
    if (resolve(receiverPlugin.workspacePath) !== workspacePath) {
      return { ok: false, reason: 'source and receiver workspaces differ' }
    }
    if (source.hostWindow !== receiverPlugin.hostWindow) {
      return { ok: false, reason: 'source and receiver live in different windows' }
    }
    if (this.currentReceiverRegistration(receiverId, receiverPlugin) !== receiver) {
      return { ok: false, reason: 'receiver registration is stale' }
    }
    if (!receiver.declaration.locations.includes('detail')) {
      return { ok: false, reason: 'receiver does not declare the detail location' }
    }
    if (!this.contributionCapabilityContext(sourceDescriptor, sourceView, workspacePath) ||
      !this.contributionCapabilityContext(sourceDescriptor, detailView, workspacePath) ||
      !this.contributionCapabilityContext(receiverDescriptor, receiverView, workspacePath)) {
      return { ok: false, reason: 'a capability context is unavailable' }
    }
    this.detailPairs.set(sourceInstanceId, {
      sourceInstanceId,
      receiverId,
      detailView,
      workspacePath,
    })
    return { ok: true }
  }

  /** Host-only provider pairing. The receiver never selects provider identity;
   * it receives only opaque offer metadata for an already validated view. */
  offerReceiverProvider(
    receiverId: string,
    descriptor: PluginLaunchDescriptor,
    view: PluginViewLaunchDescriptor,
    workspacePath: string,
  ): { ok: true } | { ok: false; reason: string } {
    const registration = this.receiverRegistrations.get(receiverId)
    const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
    const location = view.location === 'left' || view.location === 'detail' ? view.location : null
    if (!registration) return { ok: false, reason: 'receiver is not registered' }
    if (!receiver) return { ok: false, reason: 'receiver instance is not running' }
    if (receiver.documentGeneration !== registration.documentGeneration) {
      return { ok: false, reason: 'receiver document changed' }
    }
    if (!location) return { ok: false, reason: 'contribution is not a receiver location' }
    if (!registration.declaration.locations.includes(location)) {
      return { ok: false, reason: 'receiver does not declare this location' }
    }
    if (this.descriptors.get(descriptor.id) !== descriptor) {
      return { ok: false, reason: 'provider descriptor changed' }
    }
    if (!descriptor.views?.includes(view)) return { ok: false, reason: 'provider view is not current' }
    if (!this.contributionCapabilityContext(descriptor, view, workspacePath)) {
      return { ok: false, reason: 'provider capability context is unavailable' }
    }
    const offer: ReceiverOffer = {
      id: randomUUID(),
      location,
      descriptor,
      view,
      workspacePath: resolve(workspacePath),
    }
    console.warn(`[plugins] receiver offer sent: '${view.contributionKey}' (${location})`)
    registration.offers.set(offer.id, offer)
    receiver.view.webContents.send('plugin:receiver:offer', {
      receiverId,
      offer: { offerId: offer.id, contributionKey: view.contributionKey, title: view.title, location: offer.location },
    })
    return { ok: true }
  }

  /** Reserve a generic iframe receiver. The caller must locate its initial
   * blank iframe and bind that exact WebFrameMain before assigning entryUrl to
   * the child; no renderer-selected identity is accepted here. */
  async reservePluginFrameContribution(
    hostWindow: BrowserWindow,
    contributionKey: string,
    workspacePath: string,
    receiver?: RunningPlugin,
  ): Promise<
    | { ok: true; bindingId: string; entryUrl: string }
    | { ok: false; error: string }
  > {
    const descriptor = this.enabledDescriptors().find((candidate) =>
      candidate.views?.some((view) => view.contributionKey === contributionKey)
    )
    const view = descriptor?.views?.find((candidate) => candidate.contributionKey === contributionKey)
    if (!descriptor || !view) return { ok: false, error: 'contribution is not installed' }
    const receiverWebContents = receiver?.view.webContents ?? hostWindow.webContents
    const receiverInstanceId = receiver?.instanceId ?? null
    const receiverDocumentGeneration = receiver?.documentGeneration ?? 0
    if (receiver && (receiver.carrier !== 'surface' || receiverWebContents.isDestroyed())) {
      return { ok: false, error: 'receiver document is unavailable' }
    }
    if (!descriptor.packageVersion || !descriptor.packageDir || this.isPackageVersionStopping(descriptor.id, descriptor.packageVersion)) {
      return { ok: false, error: 'frame contribution is unavailable' }
    }
    const capabilityContext = this.contributionCapabilityContext(descriptor, view, workspacePath)
    if (!capabilityContext) return { ok: false, error: 'package-version capability grant is missing' }
    this.registerIpc()
    const entryPath = relative(descriptor.packageDir, view.entryFile)
    if (!entryPath || entryPath === '..' || entryPath.startsWith(`..${sep}`) || isAbsolute(entryPath)) {
      return { ok: false, error: 'frame entry is outside its package artifact' }
    }
    const artifactId = createHash('sha256')
      .update(`${descriptor.id}\u0000${descriptor.packageVersion}\u0000${descriptor.packageDir}`)
      .digest('hex')
    let assetOrigin: string
    try {
      assetOrigin = await this.pluginFrameAssets.mount({
        artifactId,
        packageId: descriptor.id,
        packageVersion: descriptor.packageVersion,
        root: descriptor.packageDir,
      })
    } catch {
      return { ok: false, error: 'frame assets are unavailable' }
    }
    // A provider frame is the plugin's own UI for one workspace, so it needs the
    // same load-time context a contribution window gets. Without it the app
    // starts with an empty workspace and renders a blank pane — the query is
    // what tells it which workspace it belongs to and that it runs on the
    // manifest-v2 capability runtime.
    // A detail frame that gets no view id mounts the wrong surface: the shipped
    // Git package then boots its window app, never registers the detail-target
    // listener, and the Host's target is dropped.
    const frameQuery = composePluginFrameQuery(contributionKey, resolve(workspacePath))
    const entryUrl = new URL(
      `${entryPath.split(sep).map(encodeURIComponent).join('/')}${frameQuery}`,
      assetOrigin,
    ).toString()
    const instanceId = this.nextInstanceId()
    // A composed frame is a view instance like any other: its context carries
    // this instance's Host-created id, which is what later pairs the frame with
    // the detail it opens (`currentDetailPair` compares it).
    const boundCapabilityContext = this.bindCapabilityContext(capabilityContext, instanceId)
    if (!boundCapabilityContext) return { ok: false, error: 'package-version capability grant is missing' }
    const receiverGeneration = randomUUID()
    const identity: PluginFrameBindingIdentity = {
      artifactId,
      contributionKey,
      entryUrl,
      instanceId,
      packageId: descriptor.id,
      packageVersion: descriptor.packageVersion,
      receiverGeneration,
      receiverWebContentsId: receiverWebContents.id,
      workspacePath: resolve(workspacePath),
    }
    const binding = this.pluginFrameBindings.reserve(identity)
    const record = this.buildRecord({
      instanceId,
      carrier: 'frame',
      frameBindingId: binding.id,
      descriptor,
      surface: {
        webContents: receiverWebContents,
        setBounds: () => undefined,
        setVisible: () => undefined,
      },
      hostWindow,
      workspacePath: resolve(workspacePath),
      query: frameQuery,
      capabilityContext: boundCapabilityContext,
      contributionKey,
      isV2Identity: true,
      openedViaLegacyAdapter: false,
      fill: false,
      restartBounds: 'hidden',
      closeHostOnHide: false,
      mirrorTitle: false,
      visible: false,
    })
    this.wireSurface(instanceId, record, hostWindow, descriptor, true, false)
    this.pendingPluginFrames.set(binding.id, {
      bindingId: binding.id,
      instanceId,
      contributionKey,
      hostWindow,
      receiverWebContents,
      receiverInstanceId,
      receiverDocumentGeneration,
      assetOrigin,
      artifactId,
      entryUrl,
      receiverGeneration,
      documentNonce: null,
      frame: null,
      detachNavigation: null,
    })
    if (receiverInstanceId !== null) {
      const bindings = this.receiverFrameBindings.get(receiverInstanceId) ?? new Set<string>()
      bindings.add(binding.id)
      this.receiverFrameBindings.set(receiverInstanceId, bindings)
    }
    return { ok: true, bindingId: binding.id, entryUrl }
  }

  /** Bind only a Host-managed blank iframe. No page selector or frame handle
   * is accepted from renderer input. */
  bindPluginFrameBlank(bindingId: string, frame: WebFrameMain): boolean {
    const pending = this.pendingPluginFrames.get(bindingId)
    if (!pending) {
      console.warn(`[plugins] receiver frame blank refused: binding ${bindingId} is not pending`)
      return false
    }
    if (pending.hostWindow.isDestroyed() || frame.isDestroyed()) {
      console.warn('[plugins] receiver frame blank refused: window or frame is gone')
      return false
    }
    if (frame.parent !== pending.receiverWebContents.mainFrame) {
      console.warn('[plugins] receiver frame blank refused: frame is not a child of the receiver document')
      return false
    }
    if (frame.url !== 'about:blank') {
      console.warn(`[plugins] receiver frame blank refused: frame is not blank (${frame.url})`)
      return false
    }
    const binding = this.pluginFrameBindings.bindBlank(bindingId, frame)
    if (!binding) {
      console.warn(`[plugins] receiver frame blank refused: binding ${bindingId} could not be reserved`)
      return false
    }
    pending.frame = frame
    const onNavigation = (details: {
      frame: WebFrameMain | null
      isSameDocument: boolean
      url: string
    }): void => {
      const receiver = details.frame
      if (
        !receiver ||
        receiver.isDestroyed() ||
        receiver.frameTreeNodeId !== binding.frameTreeNodeId ||
        receiver.parent !== pending.receiverWebContents.mainFrame
      ) return
      if (this.pluginFrameBindings.activeForInstance(pending.instanceId)) {
        this.destroyInstance(pending.instanceId)
        return
      }
      if (
        details.isSameDocument ||
        !this.pluginFrameBindings.beginNavigation(bindingId, receiver, details.url)
      ) {
        this.destroyInstance(pending.instanceId)
      }
    }
    const onWillFrameNavigate = (details: { frame: WebFrameMain | null }): void => {
      const receiver = details.frame
      if (
        receiver &&
        receiver.frameTreeNodeId === binding.frameTreeNodeId &&
        receiver.parent === pending.receiverWebContents.mainFrame &&
        this.pluginFrameBindings.activeForInstance(pending.instanceId)
      ) this.destroyInstance(pending.instanceId)
    }
    pending.receiverWebContents.on('did-start-navigation', onNavigation)
    pending.receiverWebContents.on('will-frame-navigate', onWillFrameNavigate)
    pending.detachNavigation = () => {
      if (!pending.receiverWebContents.isDestroyed()) {
        pending.receiverWebContents.removeListener('did-start-navigation', onNavigation)
        pending.receiverWebContents.removeListener('will-frame-navigate', onWillFrameNavigate)
      }
    }
    return true
  }

  /** Admit only the document that proved possession of its child-private nonce.
   * The child never names a binding or Host receiver; both come from Electron. */
  private admitPluginFrameDocument(
    frame: WebFrameMain,
    receiverWebContentsId: number,
    documentNonce: string,
  ): boolean {
    const pending = [...this.pendingPluginFrames.values()].find((candidate) =>
      candidate.frame === frame &&
      candidate.receiverWebContents.id === receiverWebContentsId
    )
    if (!pending) {
      console.warn('[plugins] receiver frame document refused: no pending frame for this sender')
      return false
    }
    const refusal = pending.documentNonce !== null
      ? 'the frame already reported a document'
      : pending.hostWindow.isDestroyed() || frame.isDestroyed()
        ? 'window or frame is gone'
        : frame.parent !== pending.receiverWebContents.mainFrame
          ? 'frame is not a child of the receiver document'
          : frame.url !== pending.entryUrl
            ? `frame url is not the reserved entry (${frame.url})`
            : frame.origin !== pending.assetOrigin.replace(/\/$/, '')
              // A non-special scheme (`navide-plugin-frame:`) has an opaque
              // `origin` in WHATWG URL terms, so the expected value is the
              // Host-generated asset origin, never `new URL(...).origin`.
              ? `frame origin is not the reserved origin (${frame.origin} != ${pending.assetOrigin})`
              : ''
    if (refusal) {
      console.warn(`[plugins] receiver frame document refused: ${refusal}`)
      this.destroyInstance(pending.instanceId)
      return false
    }
    pending.documentNonce = documentNonce
    const admission = this.pluginFrameBindings.admit(
      frame,
      receiverWebContentsId,
      documentNonce,
      (binding, message) => this.handlePluginFramePortMessage(binding, message),
    )
    if (
      !admission ||
      admission.binding.id !== pending.bindingId ||
      admission.binding.receiverGeneration !== pending.receiverGeneration ||
      !this.activePluginFrame(admission.binding)
    ) {
      console.warn('[plugins] receiver frame document refused: the frame could not be admitted')
      this.destroyInstance(pending.instanceId)
      return false
    }
    console.warn(`[plugins] receiver frame live: '${pending.contributionKey}'`)
    try {
      frame.postMessage('plugin:frame:port', {
        documentGeneration: admission.binding.documentGeneration,
        nonce: documentNonce,
      }, [admission.port])
      const plugin = this.activePluginFrame(admission.binding)
      if (plugin) {
        for (const target of plugin.pendingTargets.splice(0)) {
          if (this.sendToPlugin(plugin, IPC_OPEN_TARGET, target)) {
            plugin.lastDeliveredTarget = { ...target }
          }
        }
      }
      return true
    } catch {
      this.destroyInstance(pending.instanceId)
      return false
    }
  }

  /** Close one opaque item receiver without affecting a sibling contribution. */
  closePluginFrame(bindingId: string): boolean {
    const pending = this.pendingPluginFrames.get(bindingId)
    if (!pending) return false
    this.destroyInstance(pending.instanceId)
    return true
  }

  /** Main protocol registration delegates only to this Host-owned asset map. */
  handlePluginFrameAssetRequest(request: Request): Promise<Response> {
    return this.pluginFrameAssets.handle(request)
  }

  /** A receiver document is an authority boundary: replacing it withdraws all
   * child registrations before its next document can observe old targets. */
  private revokeReceiverFrames(receiverInstanceId: string): void {
    for (const [receiverId, registration] of this.receiverRegistrations) {
      if (registration.receiverInstanceId === receiverInstanceId) this.revokeReceiverRegistration(receiverId)
    }
    const bindings = this.receiverFrameBindings.get(receiverInstanceId)
    if (!bindings) return
    this.receiverFrameBindings.delete(receiverInstanceId)
    for (const bindingId of bindings) {
      const pending = this.pendingPluginFrames.get(bindingId)
      if (pending) this.destroyInstance(pending.instanceId)
    }
  }

  private revokePluginFrameInstance(instanceId: string): void {
    this.cancelDetailCloseTransactions((transaction) => transaction.itemIds.some((itemId) =>
      this.pendingPluginFrames.get(this.receiverItems.get(itemId)?.bindingId ?? '')?.instanceId === instanceId
    ))
    const plugin = this.running.get(instanceId)
    if (plugin?.carrier === 'frame') {
      // A revoked document must never replay buffered ready/target state.
      plugin.ready = false
      plugin.pluginReady = false
      plugin.pendingTargets = []
      plugin.lastDeliveredTarget = undefined
      // sendToPlugin revalidates the active binding/generation; only that exact
      // receiver is told to settle its pending port work before revocation.
      this.sendToPlugin(plugin, 'plugin:frame:revoked', null)
    }
    this.pluginFrameBindings.revokeInstance(instanceId)
    for (const [bindingId, pending] of this.pendingPluginFrames) {
      if (pending.instanceId !== instanceId) continue
      pending.detachNavigation?.()
      this.pluginFrameAssets.revoke(pending.assetOrigin)
      if (pending.receiverInstanceId !== null) {
        const bindings = this.receiverFrameBindings.get(pending.receiverInstanceId)
        bindings?.delete(bindingId)
        if (bindings?.size === 0) this.receiverFrameBindings.delete(pending.receiverInstanceId)
      }
      this.pendingPluginFrames.delete(bindingId)
      for (const [itemId, item] of this.receiverItems) {
        if (item.bindingId !== bindingId) continue
        const registration = this.receiverRegistrations.get(item.receiverId)
        const receiver = registration ? this.running.get(registration.receiverInstanceId) : undefined
        // Replacement/reload/dispose removes the registration first, so an old
        // item can never report closure into a newer receiver document.
        if (
          registration && receiver &&
          registration.documentGeneration === receiver.documentGeneration &&
          this.currentReceiverRegistration(item.receiverId, receiver) === registration &&
          !receiver.view.webContents.isDestroyed()
        ) {
          receiver.view.webContents.send(IPC_RECEIVER_ITEM_CLOSED, {
            receiverId: item.receiverId,
            itemId,
            documentGeneration: registration.documentGeneration,
          })
        }
        this.cancelPendingEditorTargets((pending) => pending.sourceItemId === itemId)
        this.cancelDetailCloseTransactions((transaction) => transaction.itemIds.includes(itemId))
        this.cancelPendingDetailTargets((pending) => pending.itemId === itemId)
        this.cancelPendingDetailOpens((pending) => pending.itemId === itemId, 'provider-unavailable')
        this.receiverItems.delete(itemId)
      }
    }
  }

  /** Compose the entry URL for an in-window contribution and reserve the Host
   *  identity it will attach with. Everything authoritative — instance id,
   *  workspace, package version, capability grant — is resolved here; the
   *  renderer receives only a URL carrying an opaque one-time token, which it
   *  puts on a `<webview src>`. */
  async prepareGuestContribution(
    hostWindow: BrowserWindow,
    contributionKey: string,
    options: { workspacePath: string; query: string }
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const listed = this.enabledDescriptors().find((candidate) =>
      candidate.views?.some((view) => view.contributionKey === contributionKey)
    )
    // Re-resolve against the registered descriptor rather than the listing, and
    // require the view to be one the Host itself registered (mirrors openView).
    const descriptor = listed ? this.descriptors.get(listed.id) : undefined
    const view = descriptor?.views?.find((candidate) => candidate.contributionKey === contributionKey)
    if (!descriptor || !view) return { ok: false, error: 'contribution is not installed' }
    if (this.isPackageVersionStopping(descriptor.id, descriptor.packageVersion)) {
      return { ok: false, error: 'Backend plugin is stopping.' }
    }
    if (view.location === 'window') {
      return { ok: false, error: 'window contributions require a dedicated Host window' }
    }
    if (
      descriptor.id === PLANS_PLUGIN_ID &&
      descriptor.capabilityPolicy?.kind === 'manifest-v2' &&
      !this.isPlansBackendAvailable()
    ) {
      return { ok: false, error: 'Plans agent backend is unavailable' }
    }
    const capabilityContext = this.contributionCapabilityContext(descriptor, view, options.workspacePath)
    if (descriptor.capabilityPolicy?.kind === 'manifest-v2' && !capabilityContext) {
      return { ok: false, error: 'package-version capability grant is missing' }
    }
    validateV2CapabilityContext(descriptor, capabilityContext ?? null)
    // The guest starts calling as soon as its preload runs, which is before
    // any native view may have registered the broker. (The native paths call
    // this from mountView; a guest never goes through it.)
    this.registerIpc()

    // One live instance per (window, contribution). A re-prepare means the
    // renderer is mounting a fresh guest, so the previous one is finished.
    const registryKey = this.contributionInstanceKey(hostWindow, contributionKey)
    const existing = this.contributionInstances.get(registryKey)
    if (existing) {
      this.destroyInstance(existing.instanceId)
      this.contributionInstances.delete(registryKey)
    }
    this.releaseGuestReservations(registryKey)

    const token = randomUUID()
    const guestQuery = `${options.query}&nv_guest=${token}`
    const query = this.plansProvenanceQuery(descriptor, guestQuery)
    const entryFile = view.entryFile ?? descriptor.entryFile
    const pending: PendingGuest = {
      token,
      instanceId: this.nextInstanceId(),
      registryKey,
      descriptor: { ...descriptor, entryFile, query },
      hostWindow,
      workspacePath: options.workspacePath || null,
      query,
      capabilityContext: capabilityContext ?? null,
      contributionKey,
      isV2Identity: hasV2DescriptorIdentity(descriptor),
      timer: null,
      attached: false,
    }
    // A guest that never attaches (renderer error, unmount mid-flight) must not
    // pin an identity forever.
    pending.timer = setTimeout(() => this.pendingGuests.delete(token), 30_000)
    pending.timer.unref?.()
    this.pendingGuests.set(token, pending)
    return { ok: true, url: `${pathToFileURL(entryFile).toString()}${query}` }
  }

  /** Drop every reservation held for one contribution slot. Called when the
   *  slot is re-prepared or closed: without this a reservation whose guest
   *  never rendered would pin its host window and capability context until the
   *  30s timer fired. */
  private releaseGuestReservations(registryKey: string): void {
    for (const [token, pending] of this.pendingGuests) {
      if (pending.registryKey !== registryKey) continue
      if (pending.timer) clearTimeout(pending.timer)
      this.pendingGuests.delete(token)
    }
  }

  private clearGuestReservationsForPackageVersion(pluginId: string, packageVersion: string): void {
    for (const [token, pending] of this.pendingGuests) {
      if (
        pending.descriptor.id !== pluginId ||
        pending.descriptor.packageVersion !== packageVersion
      ) continue
      if (pending.timer) clearTimeout(pending.timer)
      this.pendingGuests.delete(token)
    }
  }

  /** Drop every reservation held for a window that is going away. */
  releaseGuestReservationsForWindow(hostWindow: BrowserWindow): void {
    for (const [token, pending] of this.pendingGuests) {
      if (pending.hostWindow !== hostWindow) continue
      if (pending.timer) clearTimeout(pending.timer)
      this.pendingGuests.delete(token)
    }
  }

  private pendingGuestFor(src: string): PendingGuest | null {
    try {
      const token = new URL(src).searchParams.get('nv_guest')
      return token ? this.pendingGuests.get(token) ?? null : null
    } catch {
      return null
    }
  }

  /** The webPreferences main must force onto an attaching guest. Null means the
   *  src was not handed out by {@link prepareGuestContribution}, which is the
   *  caller's signal to veto the attach. */
  guestAttachPreferences(src: string): {
    preload: string
    pluginId: string
    additionalArguments: string[]
  } | null {
    const pending = this.pendingGuestFor(src)
    if (!pending || this.isPackageVersionStopping(pending.descriptor.id, pending.descriptor.packageVersion)) {
      return null
    }
    return {
      preload: join(__dirname, '../preload/plugin-preload.js'),
      pluginId: pending.descriptor.id,
      additionalArguments: [
        `--plugin-id=${pending.descriptor.id}`,
        ...(this.hasPlansBackendView(pending.descriptor, pending.workspacePath, pending.capabilityContext)
          ? ['--plugin-backend=1']
          : []),
      ],
    }
  }

  /** Bind an attached guest to the identity reserved for it. The guest carries
   *  its own webContents, so capability calls stay attributable by sender
   *  exactly as they are for a native view. */
  attachGuestContribution(src: string, guest: WebContents): boolean {
    const pending = this.pendingGuestFor(src)
    if (!pending) return false
    if (this.isPackageVersionStopping(pending.descriptor.id, pending.descriptor.packageVersion)) {
      if (pending.timer) clearTimeout(pending.timer)
      this.pendingGuests.delete(pending.token)
      return false
    }
    // Pairing a guest with a reservation by event order alone rests on an
    // Electron-internal detail. Verify the guest really belongs to the window
    // the reservation was made for, so a future async step between the two
    // events cannot bind a guest to another contribution's identity.
    const embedder = (guest as WebContents & { hostWebContents?: WebContents }).hostWebContents
    if (
      embedder &&
      (pending.hostWindow.isDestroyed() || embedder !== pending.hostWindow.webContents)
    ) {
      return false
    }
    if (pending.timer) {
      clearTimeout(pending.timer)
      pending.timer = null
    }
    // Re-attach of the same element: retire the record bound to the guest that
    // Electron just detached before wiring the replacement onto the same
    // instance id, so storage and grants carry over.
    const previous = this.running.get(pending.instanceId)
    if (previous) {
      const timer = this.pendingActivations.get(pending.instanceId)
      if (timer) clearTimeout(timer)
      this.pendingActivations.delete(pending.instanceId)
      previous.detachHostClosed?.()
      this.bySender.delete(previous.senderId)
      this.running.delete(pending.instanceId)
    }
    pending.attached = true
    const record = this.buildRecord({
      instanceId: pending.instanceId,
      descriptor: pending.descriptor,
      surface: guestSurface(guest),
      hostWindow: pending.hostWindow,
      workspacePath: pending.workspacePath,
      query: pending.query,
      capabilityContext: pending.capabilityContext,
      contributionKey: pending.contributionKey,
      isV2Identity: pending.isV2Identity,
      openedViaLegacyAdapter: false,
      fill: false,
      restartBounds: 'hidden',
      closeHostOnHide: false,
      mirrorTitle: false,
      visible: false,
    })
    this.wireSurface(
      pending.instanceId,
      record,
      pending.hostWindow,
      pending.descriptor,
      pending.isV2Identity,
      false
    )
    this.contributionInstances.set(pending.registryKey, { instanceId: pending.instanceId })
    return true
  }

  private contributionInstanceKey(hostWindow: BrowserWindow, contributionKey: string): string {
    return `${hostWindow.id}:${contributionKey}`
  }

  /** Open or update one catalog contribution without exposing the runtime
   *  instance handle to renderer code. The Host resolves the canonical view
   *  by contribution key and retains the handle in the main process. */
  async openContribution(
    hostWindow: BrowserWindow,
    contributionKey: string,
    options: Omit<PluginViewOpenOptions, 'hostWindow'>,
  ): Promise<{ ok: boolean; error?: string }> {
    const descriptor = this.enabledDescriptors().find((candidate) =>
      candidate.views?.some((view) => view.contributionKey === contributionKey)
    )
    const view = descriptor?.views?.find((candidate) => candidate.contributionKey === contributionKey)
    if (!descriptor || !view) return { ok: false, error: 'contribution is not installed' }
    if (this.isPackageVersionStopping(descriptor.id, descriptor.packageVersion)) {
      return { ok: false, error: 'Backend plugin is stopping.' }
    }
    if (view.location === 'window') {
      return { ok: false, error: 'window contributions require a dedicated Host window' }
    }
    if (
      descriptor.id === PLANS_PLUGIN_ID &&
      descriptor.capabilityPolicy?.kind === 'manifest-v2' &&
      !this.isPlansBackendAvailable()
    ) {
      return { ok: false, error: 'Plans agent backend is unavailable' }
    }
    const capabilityContext = this.contributionCapabilityContext(
      descriptor,
      view,
      options.workspacePath ?? ''
    )
    if (descriptor.capabilityPolicy?.kind === 'manifest-v2' && !capabilityContext) {
      return { ok: false, error: 'package-version capability grant is missing' }
    }

    const key = this.contributionInstanceKey(hostWindow, contributionKey)
    const existing = this.contributionInstances.get(key)
    if (existing && this.running.has(existing.instanceId)) {
      const workspace = options.workspacePath ?? null
      const currentWorkspace = this.workspacePathOfInstance(existing.instanceId)
      if (!workspace || !currentWorkspace || resolve(workspace) === resolve(currentWorkspace)) {
        this.updateViewQuery(existing.instanceId, options.query ?? '')
        if (options.bounds === 'hidden') {
          this.deactivate(existing.instanceId)
        } else if (options.bounds === 'fill') {
          this.activate(existing.instanceId)
        } else {
          this.setBounds(existing.instanceId, options.bounds)
          this.activate(existing.instanceId)
        }
        return { ok: true }
      }
      this.destroyInstance(existing.instanceId)
      this.contributionInstances.delete(key)
    } else if (existing) {
      this.contributionInstances.delete(key)
    }

    try {
      const handle = await this.openView(descriptor, view, {
        ...options,
        hostWindow,
        capabilityContext,
      })
      this.contributionInstances.set(key, handle)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Open a catalog contribution whose placement is a dedicated BrowserWindow.
   * The window host is supplied by Electron main; renderer callers only send
   * the stable contribution key and workspace/query metadata. */
  async openContributionWindow(
    hostWindow: BrowserWindow,
    contributionKey: string,
    options: Omit<PluginViewOpenOptions, 'hostWindow' | 'bounds'>,
  ): Promise<{ ok: boolean; error?: string }> {
    const canDispatch = options.canDispatch ?? (() => true)
    if (!canDispatch()) return { ok: false, error: 'request is no longer active' }
    const descriptor = this.enabledDescriptors().find((candidate) =>
      candidate.views?.some((view) => view.contributionKey === contributionKey)
    )
    const view = descriptor?.views?.find((candidate) => candidate.contributionKey === contributionKey)
    if (!descriptor || !view) return { ok: false, error: 'contribution is not installed' }
    if (this.isPackageVersionStopping(descriptor.id, descriptor.packageVersion)) {
      return { ok: false, error: 'Backend plugin is stopping.' }
    }
    if (view.location !== 'window') {
      return { ok: false, error: 'contribution is not a window view' }
    }
    if (
      descriptor.id === PLANS_PLUGIN_ID &&
      descriptor.capabilityPolicy?.kind === 'manifest-v2' &&
      !this.isPlansBackendAvailable()
    ) {
      return { ok: false, error: 'Plans agent backend is unavailable' }
    }
    const capabilityContext = this.contributionCapabilityContext(
      descriptor,
      view,
      options.workspacePath ?? ''
    )
    if (descriptor.capabilityPolicy?.kind === 'manifest-v2' && !capabilityContext) {
      return { ok: false, error: 'package-version capability grant is missing' }
    }

    const key = this.contributionInstanceKey(hostWindow, contributionKey)
    const existing = this.contributionInstances.get(key)
    if (existing && this.running.has(existing.instanceId)) {
      const workspace = options.workspacePath ?? null
      const currentWorkspace = this.workspacePathOfInstance(existing.instanceId)
      if (!workspace || !currentWorkspace || resolve(workspace) === resolve(currentWorkspace)) {
        const current = this.running.get(existing.instanceId)
        if (options.trustedEditorFileTarget && current && !current.ready) {
          try {
            await this.waitForEntryReady(existing.instanceId)
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }
        if (!canDispatch()) return { ok: false, error: 'request is no longer active' }
        try {
          this.updateViewQuery(
            existing.instanceId,
            options.query ?? '',
            options.trustedEditorFileTarget,
          )
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        this.activate(existing.instanceId)
        this.focusInstance(existing.instanceId)
        return { ok: true }
      }
      this.destroyInstance(existing.instanceId)
      this.contributionInstances.delete(key)
    } else if (existing) {
      this.contributionInstances.delete(key)
    }

    try {
      const handle = await this.openView(descriptor, view, {
        ...options,
        hostWindow,
        bounds: 'fill',
        closeHostOnHide: true,
        mirrorTitle: true,
        capabilityContext,
      })
      this.contributionInstances.set(key, handle)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Update visibility/bounds for a Host region without accepting an opaque
   *  instance id from renderer input. */
  updateContribution(
    hostWindow: BrowserWindow,
    contributionKey: string,
    bounds: PluginBounds | null,
    visible: boolean,
  ): { ok: boolean } {
    const key = this.contributionInstanceKey(hostWindow, contributionKey)
    const handle = this.contributionInstances.get(key)
    if (!handle || !this.running.has(handle.instanceId)) {
      this.contributionInstances.delete(key)
      return { ok: false }
    }
    const plugin = this.running.get(handle.instanceId)
    if (!plugin || this.isPluginStopping(plugin)) return { ok: false }
    if (visible && !bounds) return { ok: false }
    if (bounds) this.setBounds(handle.instanceId, bounds)
    if (visible) this.activate(handle.instanceId)
    else this.deactivate(handle.instanceId)
    return { ok: true }
  }

  /** Destroy one contribution in one Host region. */
  closeContribution(hostWindow: BrowserWindow, contributionKey: string): { ok: boolean } {
    const key = this.contributionInstanceKey(hostWindow, contributionKey)
    const handle = this.contributionInstances.get(key)
    this.contributionInstances.delete(key)
    this.releaseGuestReservations(key)
    if (handle) this.destroyInstance(handle.instanceId)
    return { ok: true }
  }

  private activeReceiverRegistrationsForWindow(hostWindow: BrowserWindow): Array<{
    registration: ReceiverRegistration
    receiver: RunningPlugin
  }> {
    const active: Array<{ registration: ReceiverRegistration; receiver: RunningPlugin }> = []
    for (const registration of this.receiverRegistrations.values()) {
      const receiver = this.running.get(registration.receiverInstanceId)
      if (!receiver || receiver.hostWindow !== hostWindow) continue
      if (this.currentReceiverRegistration(registration.id, receiver) !== registration) continue
      if (receiver.view.webContents.isDestroyed()) continue
      active.push({ registration, receiver })
    }
    return active
  }

  /** Main asks before preventing a native window close. True when this window
   *  hosts a guarded receiver or any mounted provider item. */
  hasWindowCloseParticipants(hostWindow: BrowserWindow): boolean {
    if (hostWindow.isDestroyed()) return false
    return this.activeReceiverRegistrationsForWindow(hostWindow).some(({ registration }) =>
      registration.declaration.closeGuard?.protocolVersion === 1 ||
      [...this.receiverItems.values()].some((item) => item.receiverId === registration.id),
    )
  }

  /** One two-phase close preparation for every participant in one window.
   *  Reaches `prepared` only after receiver consent and every provider
   *  prepare; the caller must commit or cancel before the window is destroyed. */
  async prepareWindowClose(
    hostWindow: BrowserWindow,
    reason: NativeReceiverCloseReason,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: Exclude<DetailCloseResult, { closed: true }>['reason'] }> {
    if (hostWindow.isDestroyed()) return { ok: false, reason: 'unavailable' }
    const plans: Array<{ receiver: RunningPlugin; receiverId: string; itemIds: string[] }> = []
    for (const { registration, receiver } of this.activeReceiverRegistrationsForWindow(hostWindow)) {
      const itemIds = [...this.receiverItems.values()]
        .filter((item) => item.receiverId === registration.id && this.currentDetailCloseCandidate(item, receiver, registration))
        .map((item) => item.id)
      const guarded = registration.declaration.closeGuard?.protocolVersion === 1
      if (!guarded && itemIds.length === 0) continue
      plans.push({ receiver, receiverId: registration.id, itemIds })
    }
    if (plans.length === 0) return { ok: true, id: '' }
    const transactions: DetailCloseTransaction[] = []
    const cancelAll = (reason: Exclude<DetailCloseResult, { closed: true }>['reason']): void => {
      for (const transaction of transactions) this.failDetailCloseTransaction(transaction.id, reason)
    }
    for (const plan of plans) {
      const started = this.beginDetailCloseTransaction(plan.receiver, plan.receiverId, plan.itemIds, reason, true)
      if (!started.ok) {
        const failureReason = started.result.closed ? 'unavailable' : started.result.reason
        cancelAll(failureReason)
        return { ok: false, reason: failureReason }
      }
      transactions.push(started.transaction)
    }
    for (const transaction of transactions) {
      const prepared = await transaction.prepared
      if (prepared.closed) continue
      cancelAll(prepared.reason)
      return { ok: false, reason: prepared.reason }
    }
    if (hostWindow.isDestroyed()) {
      cancelAll('unavailable')
      return { ok: false, reason: 'unavailable' }
    }
    const id = randomUUID()
    this.pendingWindowCloses.set(id, {
      hostWindowId: hostWindow.id,
      transactionIds: transactions.map((transaction) => transaction.id),
    })
    return { ok: true, id }
  }

  commitWindowClose(id: string): void {
    const pending = this.pendingWindowCloses.get(id)
    if (!pending) return
    this.pendingWindowCloses.delete(id)
    for (const transactionId of pending.transactionIds) this.commitDetailCloseTransaction(transactionId)
  }

  cancelWindowClose(id: string): void {
    const pending = this.pendingWindowCloses.get(id)
    if (!pending) return
    this.pendingWindowCloses.delete(id)
    for (const transactionId of pending.transactionIds) this.failDetailCloseTransaction(transactionId, 'unavailable')
  }

  /**
   * Scan an installed-plugins root and register a descriptor for every valid
   * plugin found. A directory with an invalid manifest is skipped and returned
   * in `errors` rather than aborting the scan. The returned activation catalog
   * contains only validated, trusted package contributions whose optional frontend
   * registration succeeded; `loaded` retains its descriptor-only meaning.
   */
  loadInstalledPlugins(
    root: string,
    source?:
      | { provenance: 'official-registry'; trust: InstalledRegistryTrustContext }
      | { provenance: 'developer-local-unpacked' },
    includePluginIds?: ReadonlySet<string>
  ): {
    loaded: string[]
    errors: string[]
    activationCatalog: PluginActivationCatalogEntry[]
  } {
    const loaded: string[] = []
    const errors: string[] = []
    const lifecycleSelector = new PluginActivationSelector(root)
    const blockedRecoveryPluginIds = new Set<string>()
    // A selector transition is not recovery authority on its own. For an
    // official package, authenticate precisely the package that a cold
    // recovery would select before changing the durable pointer or scanning
    // any contribution. This keeps a post-drain crash from reviving a
    // revoked/mutated prior package merely because it is retained on disk.
    if (source?.provenance === 'official-registry') {
      for (const record of lifecycleSelector.list()) {
        if (!record.activation) continue
        const recoveredSelection = record.activation.phase === 'prepared'
          ? record.active
          : record.activation.kind === 'candidate'
            ? record.previous
            : record.active
        // A virgin first-install candidate has no prior selected package and
        // can only recover to no active package. It has nothing to admit.
        if (!recoveredSelection) {
          lifecycleSelector.recoverInterruptedActivation(record.pluginId)
          continue
        }
        const recoveredDir = lifecycleSelector.packageDir(record.pluginId, recoveredSelection)
        const decision = verifyLocalInstalledPackage(root, recoveredDir, record.pluginId, source.trust) ??
          verifyInstalledRegistryPackage(recoveredDir, record.pluginId, source.trust)
        if (
          decision.action === 'quarantine' ||
          decision.artifactDigest !== recoveredSelection.artifactDigest
        ) {
          blockedRecoveryPluginIds.add(record.pluginId)
          errors.push(
            `${record.pluginId}: interrupted lifecycle recovery blocked: ${
              decision.action === 'quarantine'
                ? decision.reason
                : 'retained artifact digest does not match the lifecycle selector'
            }`,
          )
          continue
        }
        lifecycleSelector.recoverInterruptedActivation(record.pluginId)
      }
    }
    const scannedPlugins = scanInstalledPlugins(root)
    const durableSelections = new Map(
      lifecycleSelector.list().map((record) => [record.pluginId, record] as const),
    )
    const approved: Array<{
      scanned: ReturnType<typeof scanInstalledPlugins>[number]
      pluginId: string
      packageSummary: InstalledPluginPackageSummary
      opts: { official?: boolean }
    }> = []

    for (const scanned of scannedPlugins) {
      if (scanned.error) {
        errors.push(`${scanned.dir}: ${scanned.error}`)
        continue
      }
      const pluginId = scanned.activation?.pluginId ?? scanned.descriptor?.id
      if (pluginId === undefined || scanned.packageSummary === undefined) continue
      if (includePluginIds && !includePluginIds.has(pluginId)) continue
      if (blockedRecoveryPluginIds.has(pluginId)) continue

      const isV2 = scanned.activation !== undefined
      if (source?.provenance === 'official-registry') {
        if (isReservedPluginId(pluginId) && !hasOfficialRegistryAuthority(source.trust)) {
          errors.push(
            `${scanned.dir}: reserved plugin id '${pluginId}' requires the App-authorized Official Registry`
          )
          continue
        }
        // Card K3: a package installed from a file is verified against the
        // user's consent record; it has no Registry receipt to verify.
        const localDecision = verifyLocalInstalledPackage(root, scanned.dir, pluginId, source.trust)
        const decision = localDecision ?? verifyInstalledRegistryPackage(scanned.dir, pluginId, source.trust)
        if (decision.action === 'quarantine') {
          errors.push(`${scanned.dir}: quarantined: ${decision.reason ?? 'trust verification failed'}`)
          continue
        }
        const durableSelection = durableSelections.get(pluginId)
        if (
          durableSelection?.active &&
          decision.artifactDigest !== durableSelection.active.artifactDigest
        ) {
          errors.push(`${scanned.dir}: active artifact digest does not match the durable lifecycle selector`)
          continue
        }
        if (localDecision) {
          scanned.packageSummary.source = 'local-unsigned'
          if (scanned.activation) {
            scanned.activation.source = 'local-unsigned'
            scanned.activation.artifactDigest = decision.artifactDigest
          }
        } else {
          scanned.packageSummary.provenance = 'official-registry'
          if (scanned.activation) {
            scanned.activation.provenance = 'official-registry'
            scanned.activation.artifactDigest = decision.artifactDigest
          }
        }
      } else if (source?.provenance === 'developer-local-unpacked') {
        if (isReservedPluginId(pluginId)) {
          errors.push(
            `${scanned.dir}: Developer Mode cannot claim reserved plugin id '${pluginId}'`
          )
          continue
        }
        scanned.packageSummary.provenance = 'developer-local-unpacked'
        scanned.packageSummary.warning = 'Unsigned local unpacked plugin — Developer Mode only'
        if (scanned.activation) scanned.activation.provenance = 'developer-local-unpacked'
      } else if (isV2) {
        errors.push(`${scanned.dir}: Registry trust context is required for Manifest v2`)
        continue
      }

      // Reserved backend-only packages must pass the same receipt gate as view
      // packages before any contribution can enter the activation catalog.
      let opts: { official?: boolean } = {}
      if (isReservedPluginId(pluginId)) {
        if (source?.provenance === 'official-registry') {
          if (hasOfficialRegistryAuthority(source.trust)) {
            opts = { official: true }
          } else {
            errors.push(
              `${scanned.dir}: reserved plugin id '${pluginId}' requires the App-authorized Official Registry`
            )
            continue
          }
        } else {
          const check = verifyOfficialInstall(scanned.dir, pluginId, resolveOfficialPublisherKey())
          if (!check.ok) {
            errors.push(`${scanned.dir}: ${check.reason}`)
            continue
          }
          opts = { official: true }
        }
      }
      approved.push({ scanned, pluginId, packageSummary: scanned.packageSummary, opts })
    }

    // A plugin identity may be supplied by either a legacy descriptor or a v2
    // activation. Reject duplicates before registering either contribution so
    // a v1 frontend cannot combine with a v2 backend from another directory.
    const packageGroups = new Map<string, typeof approved>()
    for (const entry of approved) {
      const group = packageGroups.get(entry.pluginId) ?? []
      group.push(entry)
      packageGroups.set(entry.pluginId, group)
    }
    const uniqueApproved: typeof approved = []
    for (const [pluginId, entries] of packageGroups) {
      if (entries.length === 1) {
        uniqueApproved.push(entries[0])
        continue
      }
      const directories = entries.map(({ scanned }) => scanned.dir).join(', ')
      errors.push(`${pluginId}: duplicate plugin packages found in ${directories}`)
    }

    const activations = uniqueApproved.flatMap(({ scanned }) =>
      scanned.activation ? [scanned.activation] : []
    )
    let activationCatalog = buildActivationCatalog(activations)

    for (const { scanned, packageSummary, opts } of uniqueApproved) {
      try {
        this.registerInstalledPackage(packageSummary, scanned.descriptor, opts, scanned.dir)
        // A disabled package was verified like any other and stays in the
        // inventory; it contributes no view and no backend activation.
        if (this.isPluginDisabled(packageSummary.id)) {
          if (scanned.activation) {
            activationCatalog = activationCatalog.filter((entry) => entry !== scanned.activation)
          }
          continue
        }
        if (scanned.descriptor) loaded.push(scanned.descriptor.id)
      } catch (err) {
        errors.push(`${scanned.dir}: ${err instanceof Error ? err.message : String(err)}`)
        if (scanned.activation) {
          activationCatalog = activationCatalog.filter((entry) => entry !== scanned.activation)
        }
      }
    }
    return { loaded, errors, activationCatalog }
  }

  /** Re-evaluate installed Registry packages after a root-signed trust/blocklist
   * refresh. A quarantine only stops/unregisters frontend state; it never
   * deletes the retained package evidence. A future backend supervisor must
   * consume these same decisions before spawn and when trust changes. */
  refreshInstalledPluginTrust(
    root: string,
    trust: InstalledRegistryTrustContext,
    includePluginIds?: ReadonlySet<string>
  ): Array<{ pluginId: string; action: 'allow' | 'quarantine'; reason?: string; artifactDigest?: string }> {
    const decisions: Array<{
      pluginId: string
      action: 'allow' | 'quarantine'
      reason?: string
      artifactDigest?: string
    }> = []
    for (const scanned of scanInstalledPlugins(root)) {
      const pluginId = scanned.activation?.pluginId ?? scanned.descriptor?.id
      if (!pluginId) continue
      if (includePluginIds && !includePluginIds.has(pluginId)) continue
      const decision = verifyLocalInstalledPackage(root, scanned.dir, pluginId, trust) ??
        verifyInstalledRegistryPackage(scanned.dir, pluginId, trust)
      if (
        decision.action === 'allow' &&
        isReservedPluginId(pluginId) &&
        !hasOfficialRegistryAuthority(trust)
      ) {
        decisions.push({
          pluginId,
          action: 'quarantine',
          reason: 'reserved plugin id requires the App-authorized Official Registry',
        })
        const packageVersion = scanned.activation?.packageVersion ?? scanned.descriptor?.packageVersion
        if (packageVersion) this.revokePackageVersionInBackground(pluginId, packageVersion)
        this.destroyPluginInstances(pluginId)
        this.clearTerminalRoutes(pluginId)
        this.installedPackages.delete(pluginId)
        this.installedPackageDirectories.delete(pluginId)
        this.descriptors.delete(pluginId)
        const fallback = this.builtinFallbacks.get(pluginId)
        if (fallback) this.registerDescriptor(fallback, { builtin: true })
        continue
      }
      decisions.push(decision.action === 'allow'
        ? { pluginId, action: 'allow', artifactDigest: decision.artifactDigest }
        : { pluginId, action: 'quarantine', reason: decision.reason })
      if (decision.action === 'quarantine') {
        const packageVersion = scanned.activation?.packageVersion ?? scanned.descriptor?.packageVersion
        if (packageVersion) this.revokePackageVersionInBackground(pluginId, packageVersion)
        this.destroyPluginInstances(pluginId)
        this.clearTerminalRoutes(pluginId)
        this.installedPackages.delete(pluginId)
        this.installedPackageDirectories.delete(pluginId)
        this.descriptors.delete(pluginId)
        const fallback = this.builtinFallbacks.get(pluginId)
        if (fallback) this.registerDescriptor(fallback, { builtin: true })
      }
    }
    return decisions
  }

  /** Stop a plugin's live frontend runtime without unregistering its package.
   * Destructive package-owned cleanup must use this phase before touching
   * storage, while leaving the package registered so a failed cleanup can be
   * retried. */
  preparePluginRemoval(id: string): void {
    const packageVersion = this.packageVersionForPluginId(id)
    if (packageVersion && (
      this.pluginBackendHost.hasActivation(id, packageVersion) ||
      this.instancesForPackageVersion(id, packageVersion).length > 0
    )) {
      this.revokePackageVersionInBackground(id, packageVersion)
    }
    this.stopAiSessionsForPlugin(id)
    // Its embedded AI panels are not in the AI-session ledger, so nothing above
    // ends them. A built-in fallback taking over keeps them (it serves the same
    // surface); otherwise they end as when their window closes.
    const surface = dockSurfaceForPlugin(id)
    if (surface && !this.builtinFallbacks.has(id)) this.endDockSurface(surface)
    this.destroyPluginInstances(id)
    this.clearTerminalRoutes(id)
    this.webViewRegistry?.destroyPlugin(id)
  }

  /** Revoke one exact package-version Grant and drain the complete runtime
   *  attached to it. Completed filesystem, shell, and external effects are not
   *  rolled back; this only prevents further work and tears down live state. */
  async revokePackageVersion(pluginId: string, packageVersion: string): Promise<void> {
    const key = packageVersionKey(pluginId, packageVersion)
    const existing = this.packageRevocationTasks.get(key)
    if (existing) {
      await existing
      return
    }
    this.stoppingPlugins.add(key)
    // Everything after the add lives inside the try that clears it. The
    // synchronous prelude below can throw (a capability sweep, a Host lookup),
    // and a barrier stranded that way is permanent: the isPluginStopping and
    // isPackageVersionStopping sites then answer PLUGIN_STOPPING for a package
    // that can never be prepared again - the exact failure the clearing
    // `finally` was added to prevent, through a narrower door.
    try {
      for (const headlessKey of this.headlessBackendInstances.keys()) {
        if (headlessKey.startsWith(`${pluginId}\u0000${packageVersion}\u0000`)) {
          this.headlessBackendInstances.delete(headlessKey)
        }
      }
      for (const headlessKey of this.pendingHeadlessBackendBinds.keys()) {
        if (headlessKey.startsWith(`${pluginId}\u0000${packageVersion}\u0000`)) {
          this.pendingHeadlessBackendBinds.delete(headlessKey)
        }
      }
      this.clearGuestReservationsForPackageVersion(pluginId, packageVersion)
      const hadActivation = this.pluginBackendHost.hasActivation(pluginId, packageVersion)
      const task = Promise.resolve().then(async () => {
        this.stopAiSessionsForPackageVersion(pluginId, packageVersion)
        this.clearTerminalRoutesForPackageVersion(pluginId, packageVersion)
        for (const plugin of this.instancesForPackageVersion(pluginId, packageVersion)) {
          this.deactivate(plugin.instanceId)
          const forgotten = this.forgetInstance(plugin.instanceId, { unbindBackend: false })
          if (!forgotten) continue
          this.detachView(forgotten)
          try {
            if (!forgotten.view.webContents.isDestroyed()) forgotten.view.webContents.close()
          } catch {
            // Electron may already be tearing the view down; Host state is gone.
          }
        }
        // Its web views go with the revoked grant, agent-created ones included.
        this.webViewRegistry?.destroyPlugin(pluginId)
        await this.pluginBackendHost.revokePackageVersion(pluginId, packageVersion)
        if (hadActivation) this.refreshHostSessionRegistration()
      })
      this.packageRevocationTasks.set(key, task)
      try {
        await task
      } finally {
        if (this.packageRevocationTasks.get(key) === task) this.packageRevocationTasks.delete(key)
      }
    } finally {
      // This barrier only has to outlive the frontend teardown sweep above, and
      // that sweep is over once the task settles either way. The fail-closed
      // admission barrier for a child that may have survived a rejected drain
      // lives in PluginBackendHost.revokePackageVersion, which retains it for
      // the life of the process; keeping this one as well would not add to that
      // guarantee and would strand UI-only packages that have no backend child
      // (Git) with a dead contribution until the App restarts.
      if (!this.packageRestartBarriers.has(key)) this.stoppingPlugins.delete(key)
    }
  }

  /** Capture one exact v2 package's Host-owned placements. Query strings are
   * data only; receiver grants and renderer guest tokens never survive a
   * restart. */
  private snapshotPackageRestart(
    pluginId: string,
    packageVersion: string,
  ): readonly PluginInstanceRestartSnapshot[] {
    const snapshots: PluginInstanceRestartSnapshot[] = []
    const seen = new Set<string>()
    const snapshotKey = (hostWindow: BrowserWindow, contributionKey: string): string =>
      `${hostWindow.id}\u0000${contributionKey}`
    const cleanQuery = (query: string): string => {
      const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
      params.delete('file_grant')
      params.delete('nv_guest')
      const value = params.toString()
      return value ? `?${value}` : ''
    }
    for (const plugin of this.instancesForPackageVersion(pluginId, packageVersion)) {
      if (!plugin.hasV2DescriptorIdentity || !plugin.contributionKey) {
        throw new Error('package restart requires canonical contribution instances')
      }
      const key = snapshotKey(plugin.hostWindow, plugin.contributionKey)
      seen.add(key)
      const contributionRegistered =
        this.contributionInstances.get(key)?.instanceId === plugin.instanceId
      snapshots.push(Object.freeze({
        pluginId,
        packageVersion,
        contributionKey: plugin.contributionKey,
        hostWindow: plugin.hostWindow,
        bounds:
          typeof plugin.restartBounds === 'string'
            ? plugin.restartBounds
            : Object.freeze({ ...plugin.restartBounds }),
        query: cleanQuery(plugin.query),
        workspacePath: plugin.workspacePath,
        closeHostOnHide: plugin.closeHostOnHide,
        mirrorTitle: plugin.mirrorTitle,
        initiallyVisible: plugin.visible,
        contributionRegistered,
        carrier: plugin.view.nativeView ? 'native' : 'guest',
      }))
    }
    // A renderer may have received a guest URL but not attached before the
    // restart begins. Preserve it as an explicit guest-reprepare requirement;
    // silently dropping it leaves a blank region after the old token is swept.
    for (const pending of this.pendingGuests.values()) {
      if (pending.descriptor.id !== pluginId || pending.descriptor.packageVersion !== packageVersion) continue
      const key = snapshotKey(pending.hostWindow, pending.contributionKey)
      if (seen.has(key)) continue
      seen.add(key)
      snapshots.push(Object.freeze({
        pluginId,
        packageVersion,
        contributionKey: pending.contributionKey,
        hostWindow: pending.hostWindow,
        bounds: 'hidden',
        query: cleanQuery(pending.query),
        workspacePath: pending.workspacePath,
        closeHostOnHide: false,
        mirrorTitle: false,
        initiallyVisible: false,
        contributionRegistered: true,
        carrier: 'guest',
      }))
    }
    return Object.freeze(snapshots)
  }

  /** Begin a Host-only restart transaction. The admission barrier covers the
   * whole plugin through selector cutover, while the existing revoke method
   * performs the actual in-flight backend drain. */
  async beginPackageRestart(
    pluginId: string,
    expectedActiveVersion: string,
  ): Promise<PluginPackageRestartTransaction> {
    const descriptor = this.descriptors.get(pluginId)
    if (
      !descriptor ||
      !hasV2DescriptorIdentity(descriptor) ||
      descriptor.packageVersion !== expectedActiveVersion
    ) {
      throw new Error('package restart does not match the current Host descriptor')
    }
    if (this.restartingPluginIds.has(pluginId)) throw new Error('package restart is already in progress')
    const key = packageVersionKey(pluginId, expectedActiveVersion)
    const snapshots = this.snapshotPackageRestart(pluginId, expectedActiveVersion)
    const transaction = Object.freeze({}) as PluginPackageRestartTransaction
    this.pendingPackageRestarts.set(transaction, {
      pluginId,
      packageVersion: expectedActiveVersion,
      snapshots,
      restored: false,
    })
    this.restartingPluginIds.add(pluginId)
    this.packageRestartBarriers.add(key)
    try {
      await this.revokePackageVersion(pluginId, expectedActiveVersion)
      return transaction
    } catch (error) {
      this.pendingPackageRestarts.delete(transaction)
      this.restartingPluginIds.delete(pluginId)
      this.packageRestartBarriers.delete(key)
      this.stoppingPlugins.delete(key)
      throw error
    }
  }

  /** Restore native placements through the current descriptor only. Guest
   * placements are deliberately reported as incomplete rather than mounted as
   * a different carrier; their renderer must request a fresh guest URL. */
  async restorePackageRestart(
    transaction: PluginPackageRestartTransaction,
    expectedSelectedVersion: string,
  ): Promise<PluginPackageRestartRestoreReport> {
    const pending = this.pendingPackageRestarts.get(transaction)
    if (!pending || pending.restored) throw new Error('package restart transaction is not active')
    const descriptor = this.descriptors.get(pending.pluginId)
    if (!descriptor || !hasV2DescriptorIdentity(descriptor) || descriptor.packageVersion !== expectedSelectedVersion) {
      throw new Error('package restart selected descriptor is not current')
    }
    const guests = pending.snapshots.filter((snapshot) => snapshot.carrier === 'guest')
    if (guests.length > 0) {
      throw new Error('package restart requires renderer guest re-prepare before completion')
    }
    for (const snapshot of pending.snapshots) {
      if (snapshot.pluginId !== pending.pluginId || snapshot.packageVersion !== pending.packageVersion) {
        throw new Error('package restart transaction snapshot is invalid')
      }
      if (!descriptor.views?.some((view) => view.contributionKey === snapshot.contributionKey)) {
        throw new Error(`package restart contribution '${snapshot.contributionKey}' is not registered`) 
      }
    }
    let restoredInstances = 0
    let skippedDestroyedHostWindows = 0
    for (const snapshot of pending.snapshots) {
      if (snapshot.hostWindow.isDestroyed()) {
        skippedDestroyedHostWindows++
        continue
      }
      const view = descriptor.views!.find((candidate) => candidate.contributionKey === snapshot.contributionKey)!
      const capabilityContext = this.contributionCapabilityContext(
        descriptor,
        view,
        snapshot.workspacePath ?? '',
      )
      if (descriptor.capabilityPolicy?.kind === 'manifest-v2' && !capabilityContext) {
        throw new Error('package restart capability grant is missing')
      }
      const handle = this.mountView(
        snapshot.hostWindow,
        descriptor,
        snapshot.bounds,
        snapshot.query,
        {
          closeHostOnHide: snapshot.closeHostOnHide,
          mirrorTitle: snapshot.mirrorTitle,
          ...(snapshot.workspacePath ? { workspacePath: snapshot.workspacePath } : {}),
          capabilityContext,
          initiallyVisible: snapshot.initiallyVisible,
        },
        view,
        false,
      )
      if (snapshot.contributionRegistered) {
        this.contributionInstances.set(
          this.contributionInstanceKey(snapshot.hostWindow, snapshot.contributionKey),
          handle,
        )
      }
      await this.waitForBackendBinding(handle.instanceId)
      await this.waitForPluginReady(handle.instanceId)
      restoredInstances++
    }
    pending.restored = true
    return Object.freeze({ restoredInstances, skippedDestroyedHostWindows })
  }

  /** Complete only a successful (or explicitly host-destroyed) restore. */
  completePackageRestart(transaction: PluginPackageRestartTransaction): void {
    const pending = this.pendingPackageRestarts.get(transaction)
    if (!pending) throw new Error('package restart transaction is not active')
    if (!pending.restored && pending.snapshots.length > 0) {
      throw new Error('package restart cannot complete before required placements restore')
    }
    this.finishPackageRestart(transaction, pending)
  }

  /** Complete a restart whose selected package contributes no frontend. Its
   * drained placements have nothing to restore into, so a Host window that
   * existed only to carry one closes, as hiding that view would. */
  completePackageRestartWithoutFrontend(transaction: PluginPackageRestartTransaction): void {
    const pending = this.pendingPackageRestarts.get(transaction)
    if (!pending || pending.restored) throw new Error('package restart transaction is not active')
    if (this.descriptors.has(pending.pluginId)) {
      throw new Error('package restart selected package still has a frontend')
    }
    for (const snapshot of pending.snapshots) {
      if (snapshot.closeHostOnHide && !snapshot.hostWindow.isDestroyed()) snapshot.hostWindow.close()
    }
    this.finishPackageRestart(transaction, pending)
  }

  /** Release a failed Host-side selector/re-registration transaction. This
   * does not attempt rollback or claim to undo completed external effects. */
  cancelPackageRestart(transaction: PluginPackageRestartTransaction): void {
    const pending = this.pendingPackageRestarts.get(transaction)
    if (pending) this.finishPackageRestart(transaction, pending)
  }

  private finishPackageRestart(
    transaction: PluginPackageRestartTransaction,
    pending: PendingPackageRestart,
  ): void {
    this.pendingPackageRestarts.delete(transaction)
    this.restartingPluginIds.delete(pending.pluginId)
    const key = packageVersionKey(pending.pluginId, pending.packageVersion)
    this.packageRestartBarriers.delete(key)
    this.stoppingPlugins.delete(key)
  }

  /** Unregister a descriptor and tear down its view if it is open. Used by the
   *  remove/update flow so a removed plugin's window does not linger. Removing
   *  a marketplace override of a bundled builtin re-registers the bundled copy
   *  (recorded by {@link registerBuiltin}) so the surface keeps working. */
  removeInstalledPlugin(id: string, opts: { restoreBuiltin?: boolean } = {}): void {
    this.preparePluginRemoval(id)
    this.installedPackages.delete(id)
    this.installedPackageDirectories.delete(id)
    this.descriptors.delete(id)
    if (opts.restoreBuiltin !== false) {
      const fallback = this.builtinFallbacks.get(id)
      if (fallback) this.registerDescriptor(fallback, { builtin: true })
    }
  }

  /** Push an event to a plugin view (fed by the backend server-push fan-out
   *  in {@link dispatchEvent}). */
  private emitToInstance(instanceId: string, type: string, data: unknown): void {
    const plugin = this.running.get(instanceId)
    if (plugin && !this.isPluginStopping(plugin) && !plugin.view.webContents.isDestroyed()) {
      this.sendToPlugin(plugin, IPC_EVENT, { type, data })
    }
  }

  /** Emit to one exact Host instance when the id is an instance id; otherwise
   *  resolve the legacy plugin-id adapter and emit to its sole v1 view. This is
   *  intentionally not a broadcast API for v2 packages. */
  emit(instanceOrPluginId: string, type: string, data: unknown): void {
    const direct = this.resolveInstance(instanceOrPluginId)
    if (direct) {
      this.emitToInstance(direct.instanceId, type, data)
    }
  }
}

/** Process-wide singleton. */
export const frontendPluginManager = new FrontendPluginManager()

/** Main protocol handler exported for registration by the main entrypoint. */
export function handlePluginFrameAssetRequest(request: Request): Promise<Response> {
  return frontendPluginManager.handlePluginFrameAssetRequest(request)
}

export { PLUGIN_FRAME_SCHEME }

/**
 * The M1 no-op plugin descriptor. Its entry is built as a second renderer input
 * (see electron.vite.config.ts), so in dev it is served by the renderer dev
 * server and in packaged builds it sits next to the main renderer bundle.
 */
export function noopPluginDescriptor(): PluginLaunchDescriptor {
  const base = process.env['ELECTRON_RENDERER_URL'] ?? ''
  return {
    id: 'navide.noop',
    requires: [], // only the built-in `ping` capability is used
    devUrl: `${base}/plugins/noop/index.html`,
    entryFile: join(__dirname, '../renderer/plugins/noop/index.html'),
  }
}

/**
 * Convenience used by the dev-only menu entry: open the no-op plugin view in a
 * fixed rect at the top-left of the host window. Precise host-rect sync is left
 * for later — see the manual-verification notes in the M1 report.
 */
export function openNoopPluginView(hostWindow: BrowserWindow): void {
  frontendPluginManager.open(hostWindow, noopPluginDescriptor(), {
    x: 40,
    y: 60,
    width: 480,
    height: 360,
  })
}

/**
 * The M2 fs-probe plugin descriptor. Declares `requires: ['fs']` so its
 * brokered `fs.*` calls reach the backend WS and it receives `git.changed`.
 */
export function fsProbePluginDescriptor(): PluginLaunchDescriptor {
  const base = process.env['ELECTRON_RENDERER_URL'] ?? ''
  return {
    id: 'navide.fs_probe',
    requires: ['fs'],
    devUrl: `${base}/plugins/fs_probe/index.html`,
    entryFile: join(__dirname, '../renderer/plugins/fs_probe/index.html'),
  }
}

/** Dev-only helper mirroring {@link openNoopPluginView} for the fs probe. */
export function openFsProbePluginView(hostWindow: BrowserWindow): void {
  frontendPluginManager.open(hostWindow, fsProbePluginDescriptor(), {
    x: 40,
    y: 60,
    width: 520,
    height: 480,
  })
}

/** Id of the mini-IDE extension (the editor surface). The official example
 *  plugin: it ships bundled with the app and is registered at startup as a
 *  builtin (see {@link registerBundledMiniIde}); an officially-verified
 *  marketplace install overrides the bundled copy. */
export const MINI_IDE_PLUGIN_ID = 'navide.mini-ide'

/** Where {@link registerBundledMiniIde} looks for the bundled copy. */
export interface BundledMiniIdeSource {
  /** `app.isPackaged` — selects resourcesPath vs the local dev build. */
  isPackaged: boolean
  /** `process.resourcesPath` (packaged builds only). */
  resourcesPath: string
  /** Version selected by the running App for every bundled artifact lookup. */
  artifactVersion: string
  /** Repo root holding `dist-plugins/` when unpackaged. Defaults to the
   *  built main bundle's `../..` (`out/main` → repo root). */
  devRoot?: string
}

/** Explicit coordinates for an App-bundled Manifest v2 artifact. The version
 * comes from the running App, never from a directory scan or package manifest.
 * Legacy recovery helpers accept the same coordinates but continue selecting
 * their retained, unversioned paths. */
export interface OfficialPluginArtifactSource extends BundledMiniIdeSource {}

/** Optional selected activation supplied by the startup installer scan. The
 * installed package must win over the bundled copy, but its already-verified
 * activation must still be registered with the package-local Host broker. */
export interface BundledPlansSource extends OfficialPluginArtifactSource {
  installedActivation?: PluginActivationCatalogEntry
}

/** Resolve one versioned App artifact without discovering sibling versions.
 * Frontend-only packages use {@link UNIVERSAL_PLUGIN_TARGET}; packages with a
 * self-contained backend use {@link currentPluginHostTarget}. */
export function officialPluginArtifactPackageDir(
  source: OfficialPluginArtifactSource,
  pluginId: string,
  target: string,
): string {
  const artifactRoot = source.isPackaged
    ? join(source.resourcesPath, 'official-artifacts')
    : join(
        source.devRoot ?? join(__dirname, '../..'),
        'dist-plugins',
        'official-artifacts',
        'factory-resources',
      )
  return join(
    artifactRoot,
    pluginId,
    source.artifactVersion,
    target,
    'package',
  )
}

/** Directory of the bundled mini-IDE copy: `resources/plugins/mini-ide` inside
 *  the app package (shipped via electron-builder `extraResources`), or the
 *  local `dist-plugins/mini-ide` build output when running unpackaged. */
export function bundledMiniIdeDir(source: BundledMiniIdeSource): string {
  return source.isPackaged
    ? join(source.resourcesPath, 'plugins', 'mini-ide')
    : join(source.devRoot ?? join(__dirname, '../..'), 'dist-plugins', 'mini-ide')
}

/**
 * Register the app-bundled mini-IDE as a builtin descriptor at startup.
 *
 * Precedence for the mini-IDE editor surface (resolved here, once):
 *   1. an officially-verified marketplace install under `userData/plugins`
 *      (scanned by `loadInstalledPlugins` BEFORE this call, gated by the
 *      fail-closed pinned-key receipt check) — the future update path always
 *      wins over the copy frozen into the app package;
 *   2. the bundled builtin copy ({@link bundledMiniIdeDir}: resourcesPath in
 *      packaged builds, `dist-plugins/mini-ide` when unpackaged), validated
 *      through the SAME manifest parsing as an installed plugin;
 *   3. nothing registered → `openMiniIdePluginView` returns false and callers
 *      fall back to the "Mini-IDE unavailable" dialog.
 * (`AGENT_TEAM_PLUGIN_DEV=1` additionally force-registers the dist-plugins
 * copy later in startup, overriding 1–2 for that run — unchanged semantics.)
 *
 * Never throws: a missing dir, invalid manifest, spoofed id, or missing entry
 * file returns `registered: false` with a reason (caller logs; dialog fallback
 * stays), so a corrupt bundle degrades instead of crashing startup.
 */
export function registerBundledMiniIde(
  manager: FrontendPluginManager,
  source: BundledMiniIdeSource
): { registered: boolean; reason?: string } {
  const dir = bundledMiniIdeDir(source)
  const scanned = loadPluginDir(dir)
  if (!scanned.descriptor) {
    return { registered: false, reason: `${dir}: ${scanned.error ?? 'invalid plugin dir'}` }
  }
  if (scanned.descriptor.id !== MINI_IDE_PLUGIN_ID) {
    return {
      registered: false,
      reason: `${dir}: manifest id '${scanned.descriptor.id}' is not '${MINI_IDE_PLUGIN_ID}'`,
    }
  }
  if (!existsSync(scanned.descriptor.entryFile)) {
    return { registered: false, reason: `${dir}: entry file missing (${scanned.descriptor.entryFile})` }
  }
  manager.registerBuiltin(scanned.descriptor)
  return { registered: true }
}

/** Build the entry query the mini-IDE reads from `window.location.search`:
 *  `workspacePath` plus the backend `httpUrl` (the capabilityBackend shim
 *  resolves backend HTTP URLs from it), `extraParams` forwarding editor
 *  open params (`filepath`/`file_ws`/`line`/`sidebar`/`diff_*`/`branch_diff_*`)
 *  EditorWindowApp also reads from the search string, and the current `theme`
 *  id so the plugin paints with the app theme before its first settings
 *  reconcile (zero-flash; see plugins/mini-ide/mount.ts). A theme change alone
 *  never reloads a running view — open() only compares `workspace_path`, which
 *  is also why `file_ws` (an out-of-workspace file's own root) rides along as
 *  an ordinary param instead of altering the workspace.
 *  `workspace_display_name` carries the workspace's user-set alias for the
 *  window title. KNOWN LIMITATION: it is a load-time snapshot — renaming the
 *  workspace while this window is open does NOT retitle it, because plugin
 *  views have no `project.ui_state_changed` subscription (project.* is in
 *  neither CAP_MAP nor CAP_EVENTS). The next open shows the new name. */
function miniIdeQuery(
  workspacePath: string,
  httpUrl: string,
  extraParams: Record<string, string>,
  theme: string,
  workspaceDisplayName = ''
): string {
  const params = new URLSearchParams()
  if (workspacePath) params.set('workspace_path', workspacePath)
  // Omitted when blank so the view can tell "no alias" (fall back to the
  // folder name) from an alias that happens to equal the folder name.
  if (workspaceDisplayName.trim()) params.set('workspace_display_name', workspaceDisplayName.trim())
  if (httpUrl) params.set('http_url', httpUrl)
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) params.set(key, value)
  }
  if (theme) params.set('theme', theme)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** The dedicated mini-IDE host window (one at a time, recreated after close).
 *  The plugin WebContentsView fills its content bounds; the main window is
 *  never overlaid. */
let miniIdeWindow: BrowserWindow | null = null

/** Reuse the live dedicated window or create a fresh one. Window options
 *  mirror the retired legacy editor BrowserWindow (`openEditorWindow` in git
 *  history: 1100x760, hidden title bar, #0d1117). The window's own webContents
 *  stays blank — the plugin view carries the UI, so no preload/webPreferences
 *  are needed here. The bare feature name is only the pre-load title; once the
 *  view reports a page title, `mirrorTitle` replaces it with
 *  `<file> — Mini-IDE`. */
function ensureMiniIdeWindow(): BrowserWindow {
  if (miniIdeWindow && !miniIdeWindow.isDestroyed()) return miniIdeWindow
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Mini-IDE',
    // See systemFrameUnlessMac: this window hosts plugin content that draws no
    // window controls, so off macOS it needs the system's own frame.
    ...systemFrameUnlessMac(),
    backgroundColor: '#0d1117',
  })
  miniIdeWindow = win
  win.on('closed', () => {
    if (miniIdeWindow === win) miniIdeWindow = null
    // The one window an editor panel lives in; it does not track which
    // workspace that panel last ran in, so every editor panel ends with it.
    frontendPluginManager.endDockSurface('editor')
  })
  return win
}

/**
 * Dev-only mini-IDE descriptor pointing at the LOCAL build output
 * (`dist-plugins/mini-ide/`, produced by `pnpm run build:mini-ide`). Registered
 * at startup only under `AGENT_TEAM_PLUGIN_DEV=1` so development never needs a
 * registry install. The bundle is built separately (vite.mini-ide.config.ts)
 * with the `useBackend` → capabilityBackend alias, so it is not served by the
 * electron-vite dev server: `devUrl` is empty and it always loadFiles.
 */
export function devMiniIdePluginDescriptor(): PluginLaunchDescriptor {
  return {
    id: MINI_IDE_PLUGIN_ID,
    requires: [...MINI_IDE_PLUGIN_REQUIRES],
    devUrl: '',
    // __dirname is out/main in dev, so ../../ is the repo root.
    entryFile: join(__dirname, '../../dist-plugins/mini-ide/index.html'),
  }
}

/**
 * Open the mini-IDE plugin view — the `window:openEditor` / `window:openDiff` /
 * branch-diff surface (see index.ts) and the dev menu. The view lives in its
 * own dedicated BrowserWindow (legacy editor parity): opening never touches or
 * covers the main window, reopening restores/focuses the live window and
 * delivers the target incrementally, and closing the window tears the view
 * down so the next open recreates both cleanly.
 * Looks the descriptor up in the loader registry; returns false when the
 * mini-IDE extension is not installed (the caller surfaces the install hint).
 */
export async function openMiniIdePluginView(
  workspacePath: string,
  httpUrl = '',
  extraParams: Record<string, string> = {},
  theme = '',
  options: {
    canDispatch?: () => boolean
    trustedEditorFileTarget?: {
      path: string
      expectedCanonicalPath?: string
      workspaceOnly?: boolean
    }
    // Resolved by the caller (openMiniIdeEditor) so this stays synchronous.
    workspaceDisplayName?: string
  } = {},
): Promise<boolean> {
  const base = frontendPluginManager.getDescriptor(MINI_IDE_PLUGIN_ID)
  if (!base) return false
  const canDispatch = options.canDispatch ?? (() => true)
  if (!canDispatch()) return false
  if (options.trustedEditorFileTarget) {
    try {
      await frontendPluginManager.waitForLegacyEntryReady(MINI_IDE_PLUGIN_ID)
    } catch {
      return false
    }
    if (!canDispatch()) return false
  }
  const filepath = extraParams.filepath
  const fileWorkspace = extraParams.file_ws
  const derivedTrustedEditorFileTarget = filepath && fileWorkspace
    ? { path: resolve(fileWorkspace, filepath) }
    : undefined
  const trustedEditorFileTarget = options.trustedEditorFileTarget ?? (
    derivedTrustedEditorFileTarget &&
    !isWorkspaceContainedPath(workspacePath, derivedTrustedEditorFileTarget.path)
      ? derivedTrustedEditorFileTarget
      : undefined
  )
  const previousWindow = miniIdeWindow
  const hostWindow = ensureMiniIdeWindow()
  try {
    const instanceId = frontendPluginManager.open(
      hostWindow,
      { ...base, query: miniIdeQuery(workspacePath, httpUrl, extraParams, theme, options.workspaceDisplayName ?? '') },
      // Fill the dedicated window's content bounds and track its resizes.
      'fill',
      // Esc (nav.hideSelf) closes the dedicated window, like the legacy editor.
      // The window is this plugin's alone, so it wears the plugin's page title.
      {
        closeHostOnHide: true,
        mirrorTitle: true,
        workspacePath,
        trustedEditorFileTarget,
        canDispatch,
      }
    )
    if (instanceId !== null) return true
    if (previousWindow !== hostWindow && !hostWindow.isDestroyed()) hostWindow.close()
    return false
  } catch {
    // A Host-selected target may change between the caller's async check and
    // this synchronous recovery mount. No guest or grant is usable then.
    if (previousWindow !== hostWindow && !hostWindow.isDestroyed()) hostWindow.close()
    return false
  }
}

/** Id of the Plans extension (the plan review surface). */
export const PLANS_PLUGIN_ID = 'navide.plans'

/** What an agent call gets for a workspace whose Plans child failed too often
 *  to be restarted, including how the user brings it back. */
export const PLANS_BACKEND_STOPPED_MESSAGE =
  'The Plans backend for this workspace stopped after repeated failures. ' +
  'Open Plans for this workspace to restart it, or restart Navide.'

/** The production Plans package owns both the embedded left surface and the
 * dedicated window. A v2 descriptor with only one is an incomplete cutover
 * and must stay on the explicit legacy recovery path. */
export function hasCompletePlansContributions(
  descriptor: PluginLaunchDescriptor | undefined,
): boolean {
  return Boolean(
    descriptor?.capabilityPolicy?.kind === 'manifest-v2' &&
    descriptor.views?.some((view) =>
      view.contributionKey === `${PLANS_PLUGIN_ID}.left` && view.location === 'left'
    ) &&
    descriptor.views?.some((view) =>
      view.contributionKey === `${PLANS_PLUGIN_ID}.window` && view.location === 'window'
    )
  )
}

/** Methods exposed by the first-party Plans Backend Wire child. The list is
 *  Host-owned and intentionally narrower than the backend implementation. */
export const PLANS_BACKEND_METHODS = [
  'plans.resolve_root',
  'plans.list',
  'plans.list_docs',
  'plans.read',
  'plans.read_document',
  'plans.write_document',
  'plans.write_document_part',
  'plans.write_document_commit',
  'plans.write_document_abort',
  'plans.list_directory',
  'plans.cache_put',
  'plans.create',
  'plans.update_stage',
  'plans.update_todo',
  'plans.add_note',
  'plans.add_todo',
  'plans.review_note_add',
  'plans.review_note_edit',
  'plans.review_note_resolve',
  'plans.review_note_delete',
  'plans.update_archive',
  'plans.promote',
  'plans.rename',
  'plans.delete',
] as const

/** MCP-facing package adapter methods. Destructive document deletion is not
 *  an agent tool, even though the manual UI can use the same package child. */
export const PLANS_AGENT_BACKEND_METHODS = [
  'plans.list',
  'plans.list_docs',
  'plans.read',
  'plans.create',
  'plans.update_stage',
  'plans.update_todo',
  'plans.add_note',
  'plans.add_todo',
] as const

export const PLANS_BACKEND_EVENTS = ['plans.changed'] as const
export const PLANS_BACKEND_BRIDGE_PORTS = ['filesystem'] as const

/** Directory of the bundled Plans copy: `resources/plugins/plans` inside the
 *  app package (shipped via electron-builder `extraResources`), or the local
 *  `dist-plugins/plans` build output when running unpackaged. Mirrors
 *  {@link bundledMiniIdeDir}. */
export function bundledPlansDir(source: BundledMiniIdeSource): string {
  return source.isPackaged
    ? join(source.resourcesPath, 'plugins', 'plans')
    : join(source.devRoot ?? join(__dirname, '../..'), 'dist-plugins', 'plans')
}

/** Directory of the production combined Plans package selected by explicit App
 *  version and host target. The old `dist-plugins/plans` bundle remains a
 *  separate rollback adapter. */
export function bundledPlansV2Dir(source: OfficialPluginArtifactSource): string {
  return officialPluginArtifactPackageDir(source, PLANS_PLUGIN_ID, currentPluginHostTarget())
}

export function plansBackendActivation(
  activation: PluginActivationCatalogEntry,
): BackendPluginLaunchSpec | null {
  if (activation.pluginId !== PLANS_PLUGIN_ID || !activation.backend) return null
  return {
    pluginId: activation.pluginId,
    packageVersion: activation.packageVersion,
    packageDir: activation.packageDir,
    entryFile: activation.backend.entryFile,
    protocolVersion: activation.backend.protocolVersion,
    activation: activation.backend.activation,
    approvedMethods: [...PLANS_BACKEND_METHODS],
    agentMethods: [...PLANS_AGENT_BACKEND_METHODS],
    approvedEvents: [...PLANS_BACKEND_EVENTS],
    approvedBridgePorts: [...PLANS_BACKEND_BRIDGE_PORTS],
  }
}

/**
 * The Settings → Extensions Bundled row for Plans. It is live only while the
 * App-bundled v2 package serves Plans; legacy recovery serves the old bundle
 * instead. Plans is not a removable factory package, so it is never opted out.
 */
export function plansFactoryPackageSummary(
  manager: FrontendPluginManager,
  recoveryEnabled: boolean,
): { id: string; version: string | null; active: boolean; optedOut: boolean } {
  const descriptor = manager.getDescriptor(PLANS_PLUGIN_ID)
  const active =
    manager
      .listInstalledPackages()
      .some((pkg) => pkg.id === PLANS_PLUGIN_ID && pkg.provenance === 'factory-bundled') &&
    descriptor?.capabilityPolicy?.kind === 'manifest-v2' &&
    !recoveryEnabled
  return {
    id: PLANS_PLUGIN_ID,
    version: active ? descriptor?.packageVersion ?? null : null,
    active,
    optedOut: false,
  }
}

/**
 * Register the app-bundled combined Plans package at startup. The v2 package
 * is selected as one descriptor/backend tuple; the old frontend-only bundle
 * is retained only as an explicit fallback while the migration is available.
 * A missing dir, invalid manifest, spoofed id, missing entry, or missing
 * packaged backend returns `registered: false` for the v2 candidate and lets
 * the legacy adapter be considered.
 */
export function registerBundledPlans(
  manager: FrontendPluginManager,
  source: BundledPlansSource
): { registered: boolean; reason?: string } {
  const selected = manager.getDescriptor(PLANS_PLUGIN_ID)
  if (selected?.capabilityPolicy?.kind === 'manifest-v2' && selected.packageVersion) {
    if (manager.hasBackendActivation(PLANS_PLUGIN_ID, selected.packageVersion)) {
      return hasCompletePlansContributions(selected)
        ? { registered: true }
        : { registered: false, reason: 'selected Plans package is missing a production view contribution' }
    }
    const installed = source.installedActivation
    if (
      !installed ||
      installed.pluginId !== PLANS_PLUGIN_ID ||
      installed.packageVersion !== selected.packageVersion
    ) {
      return {
        registered: false,
        reason: 'selected installed Plans package has no matching verified backend activation',
      }
    }
    const activation = plansBackendActivation(installed)
    if (!activation || !existsSync(activation.entryFile)) {
      return { registered: false, reason: 'selected installed Plans backend entry is missing' }
    }
    try {
      manager.registerBackendActivation(activation)
    } catch (error) {
      return {
        registered: false,
        reason: `selected installed Plans backend activation rejected: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const registered = manager.getDescriptor(PLANS_PLUGIN_ID)
    return hasCompletePlansContributions(registered)
      ? { registered: true }
      : { registered: false, reason: 'selected Plans package is missing a production view contribution' }
  }
  const v2Dir = bundledPlansV2Dir(source)
  const v2 = loadPluginDir(v2Dir)
  if (v2.descriptor && v2.activation && v2.descriptor.id === PLANS_PLUGIN_ID) {
    if (!existsSync(v2.descriptor.entryFile)) {
      return { registered: false, reason: `${v2Dir}: entry file missing (${v2.descriptor.entryFile})` }
    }
    const activation = plansBackendActivation(v2.activation)
    if (!activation || !existsSync(activation.entryFile)) {
      return { registered: false, reason: `${v2Dir}: packaged backend entry is missing` }
    }
    const loaded = manager.loadFactoryPlugin(v2Dir, PLANS_PLUGIN_ID)
    if (!loaded.loaded) {
      // An officially verified installed package has precedence over the app
      // copy. Its activation is managed by the installed-package lifecycle;
      // do not replace it with the bundled package's backend.
      const installed = manager.getDescriptor(PLANS_PLUGIN_ID)
      if (installed?.packageVersion && hasCompletePlansContributions(installed)) {
        return { registered: true }
      }
      return { registered: false, reason: `${v2Dir}: ${loaded.reason}` }
    }
    try {
      manager.registerBackendActivation(activation)
    } catch (error) {
      return {
        registered: false,
        reason: `${v2Dir}: backend activation rejected: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const registered = manager.getDescriptor(PLANS_PLUGIN_ID)
    return hasCompletePlansContributions(registered)
      ? { registered: true }
      : { registered: false, reason: `${v2Dir}: production view contribution is incomplete` }
  }

  const legacyDir = bundledPlansDir(source)
  const legacy = loadPluginDir(legacyDir)
  if (!legacy.descriptor) {
    return {
      registered: false,
      reason: `${v2Dir}: ${v2.error ?? 'invalid v2 package'}; ${legacyDir}: ${legacy.error ?? 'invalid plugin dir'}`,
    }
  }
  if (legacy.descriptor.id !== PLANS_PLUGIN_ID) {
    return {
      registered: false,
      reason: `${legacyDir}: manifest id '${legacy.descriptor.id}' is not '${PLANS_PLUGIN_ID}'`,
    }
  }
  if (!existsSync(legacy.descriptor.entryFile)) {
    return { registered: false, reason: `${legacyDir}: entry file missing (${legacy.descriptor.entryFile})` }
  }
  manager.registerBuiltin(legacy.descriptor)
  return { registered: true }
}

/** Build the entry query PlanWindowApp reads from `window.location.search`:
 *  `workspace_path`, the backend `http_url` (resolved by the plans
 *  capabilityBackend shim), the optional `rel_path` of a plan to auto-open,
 *  the current `theme` id so the plugin paints with the app theme before its
 *  first settings reconcile (zero-flash; see plugins/plans/mount.ts), and the
 *  validated Host `locale`.
 *  `workspace_display_name` carries the workspace's user-set alias for the
 *  window title; blank/absent means "no alias" and the view falls back to
 *  `basename(workspace_path)`. KNOWN LIMITATION: a load-time snapshot — a
 *  rename while the window is open does not retitle it (plugin views get no
 *  `project.ui_state_changed`). */
export function plansQuery(
  workspacePath: string,
  httpUrl: string,
  relPath: string,
  theme: string,
  locale?: string,
  workspaceDisplayName = ''
): string {
  const params = new URLSearchParams()
  if (workspacePath) params.set('workspace_path', workspacePath)
  if (workspaceDisplayName.trim()) params.set('workspace_display_name', workspaceDisplayName.trim())
  if (httpUrl) params.set('http_url', httpUrl)
  if (relPath) params.set('rel_path', relPath)
  if (theme) params.set('theme', theme)
  const trimmed = typeof locale === 'string' ? locale.trim() : ''
  const validLocale = validateSupportedLocale(trimmed) ?? 'zh-TW'
  params.set('locale', validLocale)
  params.set('v2', '1')
  params.set('contribution', 'window')
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Dev-only Plans descriptor pointing at the LOCAL build output
 * (`dist-plugins/plans/`, produced by `pnpm run build:plans`). Registered at
 * startup only under `AGENT_TEAM_PLUGIN_DEV=1`, mirroring
 * {@link devMiniIdePluginDescriptor}. The bundle is built separately
 * (vite.plans.config.ts) with the `useBackend` → capabilityBackend alias, so it
 * is not served by the electron-vite dev server: `devUrl` is empty and it
 * always loadFiles. `plans` grants only the `plans.changed` live-refresh event.
 */
export function devPlansPluginDescriptor(): PluginLaunchDescriptor {
  return {
    id: PLANS_PLUGIN_ID,
    requires: [...PLANS_PLUGIN_REQUIRES],
    devUrl: '',
    // __dirname is out/main in dev, so ../../ is the repo root.
    entryFile: join(__dirname, '../../dist-plugins/plans/index.html'),
  }
}

/** Dev descriptor for the combined package selected by an explicit App
 * version. The legacy descriptor above is intentionally preserved for
 * rollback tests and manual fallback checks. */
export function devPlansV2PluginBundle(
  artifactVersion: string,
  devRoot?: string,
): {
  descriptor: PluginLaunchDescriptor
  activation: BackendPluginLaunchSpec
} | null {
  const dir = bundledPlansV2Dir({
    isPackaged: false,
    resourcesPath: '',
    artifactVersion,
    devRoot,
  })
  const scanned = loadPluginDir(dir)
  if (
    !scanned.descriptor ||
    !hasCompletePlansContributions(scanned.descriptor) ||
    !scanned.activation?.backend ||
    !existsSync(scanned.activation.backend.entryFile)
  ) return null
  const activation = plansBackendActivation(scanned.activation)
  return activation ? { descriptor: scanned.descriptor, activation } : null
}

export function devPlansV2PluginDescriptor(
  artifactVersion: string,
  devRoot?: string,
): PluginLaunchDescriptor | null {
  return devPlansV2PluginBundle(artifactVersion, devRoot)?.descriptor ?? null
}

let plansWindow: BrowserWindow | null = null

function ensurePlansWindow(): BrowserWindow {
  if (plansWindow && !plansWindow.isDestroyed()) return plansWindow
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Plans',
    // See systemFrameUnlessMac: this window hosts plugin content that draws no
    // window controls, so off macOS it needs the system's own frame.
    ...systemFrameUnlessMac(),
    backgroundColor: '#0d1117',
  })
  plansWindow = win
  win.on('closed', () => {
    if (plansWindow === win) plansWindow = null
  })
  return win
}

/**
 * Open the Plans plugin view for a workspace (dev menu / future plan-window
 * surface). Looks the descriptor up in the loader registry; returns false when
 * the Plans extension is not registered. The core `?window=plans` BrowserWindow
 * path (plan-windows.ts) is untouched — this is a parallel, opt-in surface.
 */
export async function openPlansPluginView(
  hostWindow: BrowserWindow,
  workspacePath: string,
  httpUrl = '',
  relPath = '',
  theme = '',
  locale = ''
): Promise<boolean> {
  const base = frontendPluginManager.getDescriptor(PLANS_PLUGIN_ID)
  if (!base) return false
  const displayName = await frontendPluginManager.peekWorkspaceDisplayName(workspacePath)
  if (base.capabilityPolicy?.kind === 'manifest-v2') {
    if (
      !base.packageVersion ||
      !base.packageDir ||
      !frontendPluginManager.isPlansBackendAvailable() ||
      !hasCompletePlansContributions(base)
    ) return false
    const window = ensurePlansWindow()
    return frontendPluginManager.openContributionWindow(
      window,
      `${PLANS_PLUGIN_ID}.window`,
      {
        workspacePath,
        query: plansQuery(workspacePath, httpUrl, relPath, theme, locale, displayName),
      },
    ).then((result) => {
      if (result.ok) return true
      frontendPluginManager.markPlansBackendUnavailable('view-failure')
      if (!window.isDestroyed()) window.close()
      return false
    })
  }
  const instanceId = frontendPluginManager.open(
    hostWindow,
    { ...base, query: plansQuery(workspacePath, httpUrl, relPath, theme, locale, displayName) },
    {
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    }
  )
  return instanceId !== null
}

/** Id of the Git extension (the standalone Git client surface). */
export const GIT_PLUGIN_ID = 'navide.git'

/** Legacy Git bundle retained as an explicit rollback artifact. It is no
 *  longer selected by the production composition, but remains buildable and
 *  available until the next migration issue removes it. */
export function bundledGitDir(source: BundledMiniIdeSource): string {
  return source.isPackaged
    ? join(source.resourcesPath, 'plugins', 'git')
    : join(source.devRoot ?? join(__dirname, '../..'), 'dist-plugins', 'git')
}

/** Explicit rollback registration for diagnostics and recovery tooling. The
 *  normal Host startup prefers v2; this path replaces live v2 instances only
 *  when recovery is explicitly requested. */
export function registerLegacyBundledGit(
  manager: FrontendPluginManager,
  source: BundledMiniIdeSource
): { registered: boolean; reason?: string } {
  const dir = bundledGitDir(source)
  const scanned = loadPluginDir(dir)
  if (!scanned.descriptor || scanned.descriptor.id !== GIT_PLUGIN_ID) {
    return { registered: false, reason: `${dir}: legacy Git bundle unavailable` }
  }
  if (!existsSync(scanned.descriptor.entryFile)) {
    return { registered: false, reason: `${dir}: entry file missing (${scanned.descriptor.entryFile})` }
  }
  manager.replaceBuiltinForRecovery(scanned.descriptor)
  return { registered: true }
}

/** Build the entry query GitWindowApp reads from `window.location.search`:
 *  `workspace_path`, the backend `http_url` (resolved by the Git package's
 *  capability backend), the current `theme` id so the plugin paints with the
 *  app theme before its first settings reconcile (zero-flash; see
 *  plugins/navide-git/src/mount.ts), plus `extraParams` forwarding an optional diff target
 *  (`git_diff_filepath`/`git_diff_staged`/`git_diff_commit`) GitWindowApp reads
 *  to show a file diff in its own panel instead of the mini-IDE.
 *  `workspaceDisplayName` carries the workspace's user-set alias and is only
 *  passed for the dedicated window, the one surface with a title of its own;
 *  blank/absent means "no alias" and GitWindowApp falls back to
 *  `basename(workspace_path)`. KNOWN LIMITATION: a load-time snapshot — a
 *  rename while the window is open does not retitle it (plugin views get no
 *  `project.ui_state_changed`). */
function gitQuery(
  workspacePath: string,
  httpUrl: string,
  theme: string,
  extraParams: Record<string, string> = {},
  v2 = true,
  contribution: 'left' | 'window' = 'window',
  workspaceDisplayName = '',
): string {
  const params = new URLSearchParams()
  if (workspacePath) params.set('workspace_path', workspacePath)
  if (workspaceDisplayName.trim()) params.set('workspace_display_name', workspaceDisplayName.trim())
  if (httpUrl) params.set('http_url', httpUrl)
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) params.set(key, value)
  }
  if (v2) params.set('v2', '1')
  if (v2) params.set('contribution', contribution)
  if (theme) params.set('theme', theme)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Dev-only Git descriptor pointing at the LOCAL Manifest v2 build output
 * (the explicit `official-artifacts/navide.git/<version>/universal/package/`
 * directory in packaged apps, or
 * `official-artifacts/factory-resources/navide.git/<version>/universal/package/`
 * during unpackaged dev lookup).
 * Registered at startup only under `AGENT_TEAM_PLUGIN_DEV=1`, mirroring
 * {@link devPlansPluginDescriptor}. The bundle is built separately
 * (plugins/navide-git/vite.config.ts) with the package-local capability
 * backend, so it
 * is not served by the electron-vite dev server: `devUrl` is empty and it
 * always loadFiles. The packaged Manifest v2 permissions are the source of the
 * system grant; the Host adds the official package's authenticated workspace
 * binding at open time.
 */
export function devGitPluginDescriptor(
  artifactVersion: string,
  devRoot?: string,
): PluginLaunchDescriptor {
  const dir = officialPluginArtifactPackageDir(
    { isPackaged: false, resourcesPath: '', artifactVersion, devRoot },
    GIT_PLUGIN_ID,
    UNIVERSAL_PLUGIN_TARGET,
  )
  const scanned = loadPluginDir(dir)
  if (scanned.descriptor) return scanned.descriptor
  return {
    id: GIT_PLUGIN_ID,
    packageVersion: '0.0.0-dev',
    requires: [],
    capabilityPolicy: {
      kind: 'manifest-v2',
      system: ['fs', 'ui', 'aiCli'],
      shell: 'allowlist',
      grants: [],
    },
    devUrl: '',
    entryFile: join(dir, 'frontend/window/index.html'),
    views: [
      {
        id: 'left',
        contributionKey: `${GIT_PLUGIN_ID}.left`,
        kind: 'custom',
        location: 'left',
        title: 'Git',
        entryFile: join(dir, 'frontend/left/index.html'),
      },
      {
        id: 'window',
        contributionKey: `${GIT_PLUGIN_ID}.window`,
        kind: 'custom',
        location: 'window',
        title: 'Git',
        entryFile: join(dir, 'frontend/window/index.html'),
      },
    ],
  }
}

/** The dedicated Git host window (one at a time, recreated after close). The
 *  plugin WebContentsView fills its content bounds; the main window is never
 *  overlaid. Mirrors {@link ensureMiniIdeWindow} — the standalone SourceTree-
 *  style Git client lives in its own window, wider (1280x820) than the editor. */
let gitWindow: BrowserWindow | null = null
let gitWindowViewInstanceId: string | null = null
const gitLeftViews = new Map<number, PluginViewHandle>()
const gitLeftViewHostCleanup = new Map<number, () => void>()

type GitLeftViewResult = { ok: boolean; fallback?: 'legacy' }

function clearGitLeftView(hostWindow: BrowserWindow): void {
  const handle = gitLeftViews.get(hostWindow.id)
  if (handle) frontendPluginManager.destroyInstance(handle.instanceId)
  gitLeftViews.delete(hostWindow.id)
  gitLeftViewHostCleanup.get(hostWindow.id)?.()
  gitLeftViewHostCleanup.delete(hostWindow.id)
}

function ensureGitWindow(): BrowserWindow {
  if (gitWindow && !gitWindow.isDestroyed()) return gitWindow
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Git',
    // See systemFrameUnlessMac: this window hosts plugin content that draws no
    // window controls, so off macOS it needs the system's own frame.
    ...systemFrameUnlessMac(),
    backgroundColor: '#0d1117',
  })
  gitWindow = win
  win.on('closed', () => {
    if (gitWindow === win) {
      gitWindow = null
      gitWindowViewInstanceId = null
    }
    // The one window a git panel lives in (see the Mini-IDE window above).
    frontendPluginManager.endDockSurface('git')
  })
  return win
}

/**
 * Open the Git plugin view in its own dedicated BrowserWindow (mini-IDE
 * parity): opening never touches or covers the main window, reopening
 * restores/focuses the live window and re-points its workspace, and closing the
 * window tears the view down so the next open recreates both cleanly. Looks the
 * descriptor up in the loader registry; returns false when the Git extension is
 * not registered (the caller surfaces the fallback).
 */
export async function openGitPluginView(
  workspacePath: string,
  httpUrl = '',
  theme = '',
  extraParams: Record<string, string> = {}
): Promise<boolean> {
  const base = frontendPluginManager.getDescriptor(GIT_PLUGIN_ID)
  if (!base) return false
  const displayName = await frontendPluginManager.peekWorkspaceDisplayName(workspacePath)
  const hostWindow = ensureGitWindow()
  if (base.capabilityPolicy?.kind !== 'manifest-v2' || !base.views) {
    // Explicit recovery may select the untouched V1 bundle. Keep this branch
    // isolated from the production package path: it uses the legacy adapter,
    // its original entry, and no v2 query/capability context.
    frontendPluginManager.open(
      hostWindow,
      {
        ...base,
        query: gitQuery(workspacePath, httpUrl, theme, extraParams, false, 'window', displayName),
      },
      'fill',
      { closeHostOnHide: true, mirrorTitle: true },
    )
    gitWindowViewInstanceId = null
    return true
  }
  const query = gitQuery(workspacePath, httpUrl, theme, extraParams, true, 'window', displayName)
  const currentWorkspace = gitWindowViewInstanceId
    ? frontendPluginManager.workspacePathOfInstance(gitWindowViewInstanceId)
    : null
  if (gitWindowViewInstanceId && currentWorkspace && resolve(currentWorkspace) === resolve(workspacePath)) {
    frontendPluginManager.updateViewQuery(gitWindowViewInstanceId, query)
    frontendPluginManager.activate(gitWindowViewInstanceId)
    frontendPluginManager.focusInstance(gitWindowViewInstanceId)
    return true
  }
  if (gitWindowViewInstanceId) frontendPluginManager.destroyInstance(gitWindowViewInstanceId)
  const context = frontendPluginManager.gitCapabilityContext(
    base.packageVersion ?? '0.0.0-dev',
    workspacePath,
    'git-window'
  )
  const view = base.views?.find((candidate) => candidate.contributionKey === `${GIT_PLUGIN_ID}.window`)
  if (!view) return false
  const handle = await frontendPluginManager.openView(base, view, {
    hostWindow,
    bounds: 'fill',
    query,
    closeHostOnHide: true,
    mirrorTitle: true,
    workspacePath,
    capabilityContext: context,
  })
  gitWindowViewInstanceId = handle.instanceId
  return true
}

/** Open the same active package's left contribution in a Host-owned main
 *  window. One left instance is tracked per host window; workspace changes
 *  recreate only that instance and never touch the separate Git window. */
export async function openGitLeftPluginView(
  hostWindow: BrowserWindow,
  workspacePath: string,
  bounds: PluginBounds,
  httpUrl = '',
  theme = '',
  extraParams: Record<string, string> = {}
): Promise<GitLeftViewResult> {
  const base = frontendPluginManager.getDescriptor(GIT_PLUGIN_ID)
  if (!base) return { ok: false }
  if (base.capabilityPolicy?.kind !== 'manifest-v2' || !base.packageVersion || !base.views) {
    // Recovery swaps the descriptor before the renderer's next geometry tick.
    // Clear any stale v2 handle and let the main-window renderer compose the
    // retained legacy bundle in-process.
    clearGitLeftView(hostWindow)
    return { ok: true, fallback: 'legacy' }
  }
  const view = base.views?.find((candidate) => candidate.contributionKey === `${GIT_PLUGIN_ID}.left`)
  if (!view) return { ok: false }
  const existing = gitLeftViews.get(hostWindow.id)
  if (existing) {
    const existingWorkspace = frontendPluginManager.workspacePathOfInstance(existing.instanceId)
    if (existingWorkspace && resolve(existingWorkspace) === resolve(workspacePath)) {
      frontendPluginManager.setBounds(existing.instanceId, bounds)
      frontendPluginManager.updateViewQuery(existing.instanceId, gitQuery(workspacePath, httpUrl, theme, extraParams, true, 'left'))
      frontendPluginManager.activate(existing.instanceId)
      return { ok: true }
    }
    clearGitLeftView(hostWindow)
  }
  const handle = await frontendPluginManager.openView(base, view, {
    hostWindow,
    bounds,
    query: gitQuery(workspacePath, httpUrl, theme, extraParams, true, 'left'),
    workspacePath,
    capabilityContext: frontendPluginManager.gitCapabilityContext(
      base.packageVersion,
      workspacePath,
      'git-left'
    ),
  })
  gitLeftViews.set(hostWindow.id, handle)
  const onHostClosed = (): void => {
    if (gitLeftViews.get(hostWindow.id)?.instanceId !== handle.instanceId) return
    gitLeftViews.delete(hostWindow.id)
    gitLeftViewHostCleanup.delete(hostWindow.id)
  }
  hostWindow.once('closed', onHostClosed)
  gitLeftViewHostCleanup.set(hostWindow.id, () => hostWindow.removeListener('closed', onHostClosed))
  return { ok: true }
}

export function updateGitLeftPluginView(
  hostWindow: BrowserWindow,
  bounds: PluginBounds,
  visible: boolean
): GitLeftViewResult {
  const base = frontendPluginManager.getDescriptor(GIT_PLUGIN_ID)
  const isLegacy = !!base && (base.capabilityPolicy?.kind !== 'manifest-v2' || !base.packageVersion || !base.views)
  if (isLegacy) {
    clearGitLeftView(hostWindow)
    return { ok: true, fallback: 'legacy' }
  }
  const handle = gitLeftViews.get(hostWindow.id)
  if (!handle) return { ok: false }
  frontendPluginManager.setBounds(handle.instanceId, bounds)
  if (visible) frontendPluginManager.activate(handle.instanceId)
  else frontendPluginManager.deactivate(handle.instanceId)
  return { ok: true }
}

export function closeGitLeftPluginView(hostWindow: BrowserWindow): { ok: boolean } {
  const handle = gitLeftViews.get(hostWindow.id)
  const cleanup = gitLeftViewHostCleanup.get(hostWindow.id)
  if (!handle) {
    cleanup?.()
    gitLeftViewHostCleanup.delete(hostWindow.id)
    return { ok: true }
  }
  frontendPluginManager.destroyInstance(handle.instanceId)
  gitLeftViews.delete(hostWindow.id)
  cleanup?.()
  gitLeftViewHostCleanup.delete(hostWindow.id)
  return { ok: true }
}

function agentToolError(
  code: Exclude<AgentToolCallErrorCode, 'PLUGIN_TOOL_UNAVAILABLE'>,
  error: string,
): Extract<AgentToolCallResponse, { ok: false }> {
  return { ok: false, error, error_code: code }
}

function agentToolUnavailable(reason: AgentToolUnavailableReason): Extract<AgentToolCallResponse, { ok: false }> {
  return { ok: false, error: agentToolUnavailableMessage(reason), error_code: 'PLUGIN_TOOL_UNAVAILABLE', reason }
}

export interface ParsedAgentToolCall {
  pluginId: string
  workspacePath: string
  toolName: string
  pluginVersion: string
  caller: AgentToolCaller
  arguments: JsonValue
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const present = Object.keys(record)
  return present.length === keys.length && present.every((key) => keys.includes(key)) ? record : null
}

/** Contract section 4.2. `caller` comes from the core server's credential
 * check, never from tool arguments; a pane caller names its pane. */
export function parseAgentToolCallRequest(value: Record<string, unknown>): ParsedAgentToolCall | null {
  const record = exactRecord(value, ['request_id', 'operation', 'target', 'tool', 'caller', 'payload'])
  const target = exactRecord(record?.target, ['plugin_id', 'workspace_path'])
  const tool = exactRecord(record?.tool, ['name', 'plugin_version', 'sync_revision'])
  // `verifiedTo` is optional on the wire (the core may send its own label);
  // it must agree with the caller kind, and the Host derives its own anyway.
  const caller = exactRecord(record?.caller, ['kind', 'paneId', 'workspace'])
    ?? exactRecord(record?.caller, ['kind', 'paneId', 'workspace', 'verifiedTo'])
  const payload = exactRecord(record?.payload, ['arguments'])
  if (!record || !target || !tool || !caller || !payload || record.operation !== 'agentTool') return null
  if (
    !nonEmptyString(record.request_id) ||
    !nonEmptyString(target.plugin_id) || !nonEmptyString(target.workspace_path) || !isAbsolute(target.workspace_path) ||
    !nonEmptyString(tool.name) || !nonEmptyString(tool.plugin_version) ||
    typeof tool.sync_revision !== 'number' || !Number.isSafeInteger(tool.sync_revision)
  ) return null
  const expectedLabel = caller.kind === 'pane' ? 'pane' : 'caller-kind'
  const callerOk = (caller.verifiedTo === undefined || caller.verifiedTo === expectedLabel) && (caller.kind === 'pane'
    ? nonEmptyString(caller.paneId) &&
      (caller.workspace === null || (nonEmptyString(caller.workspace) && isAbsolute(caller.workspace)))
    : (caller.kind === 'external' || caller.kind === 'host') && caller.paneId === null && caller.workspace === null)
  const args = payload.arguments
  if (!callerOk || typeof args !== 'object' || args === null || Array.isArray(args) || !isJsonValue(args)) return null
  return {
    pluginId: target.plugin_id,
    workspacePath: target.workspace_path,
    toolName: tool.name,
    pluginVersion: tool.plugin_version,
    caller: {
      kind: caller.kind as AgentToolCaller['kind'],
      paneId: caller.kind === 'pane' ? caller.paneId as string : null,
      workspace: caller.kind === 'pane' ? caller.workspace as string | null : null,
    },
    arguments: args,
  }
}
