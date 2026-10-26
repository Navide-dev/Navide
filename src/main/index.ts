import { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, powerMonitor, protocol, safeStorage, screen, session, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import { devUserDataPath } from './devUserData'
import { createGuestAttachHooks, type MutableWebPreferences } from './plugins/pluginGuestAttach'
import { guardLastWindowClose } from './last-window-close'
import { join, dirname, basename, isAbsolute, relative, sep } from 'node:path'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { readFileSync, statSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import {
  startBackend,
  setBackendDisabledBuiltinsProvider,
  getResolvedUserPath,
  readWsToken,
  mintTrustConfirmation,
  backendDataDir,
  type BackendHandle,
} from './backend'
import { answerWindowChallenge, backendChangedTargets, backendInfoFor } from './backendIpc'
import { abandonPendingBackends } from './backend-pending'
import { installApplicationMenu, type AppMenuHooks, type RecentMenuEntry } from './menu'
import { LEGAL_LINKS, isLegalRoute } from '../shared/legalLinks'
import { createWorkspaceFolder } from './workspace-create'
import type { NewWorkspaceResult } from '../shared/workspaceCreate'
import { openNoopPluginView, openFsProbePluginView, openMiniIdePluginView, devMiniIdePluginDescriptor, openPlansPluginView, devPlansPluginDescriptor, devPlansV2PluginBundle, openGitPluginView, openGitLeftPluginView, updateGitLeftPluginView, closeGitLeftPluginView, registerBundledMiniIde, bundledMiniIdeDir, officialPluginArtifactPackageDir, registerBundledPlans, plansFactoryPackageSummary, registerLegacyBundledGit, hasCompletePlansContributions, createPluginBackendChildEnvironment, frontendPluginManager } from './plugins/frontendPluginManager'
import { createWindowCloseCoordinator } from './plugins/windowCloseCoordinator'
import { createQuitCancelReset, createQuitCancelWatch } from './quit-cancel-watch'
import { dockSurfaceProvided } from './dockSurfaceProvider'
import {
  handlePluginFrameAssetRequest,
  PLUGIN_FRAME_SCHEME,
  plansBackendActivation,
  PLANS_PLUGIN_ID,
} from './plugins/frontendPluginManager'
import {
  isTrustedPluginManagementSender,
  registerPluginIpc,
  resolveConfiguredMarketplace,
  setMarketplaceOverridesAllowed,
} from './plugins/pluginIpc'
import { scanLocalPackageInWorker } from './plugins/pluginLocalScan'
import { developerFolderBackendDigest, PluginDeveloperModeStore, type DeveloperModeIntegrity } from './plugins/pluginDeveloperModeStore'
import { disableOfficialKeyOverride } from './plugins/pluginVerify'
import { publishRescanNotices, refreshTrustThenUpdates } from './plugins/pluginUpdateReminder'
import { readRegistryTrustSnapshot } from './plugins/pluginInstalledTrust'
import { PluginTestplaceStore } from './plugins/pluginTestplaceStore'
import { DeveloperAccount, setDeveloperAccount } from './plugins/developerAccount'
import { DeveloperVault } from './plugins/developerVault'
import { createDeveloperQueryHandler, registerDeveloperIpc } from './plugins/developerIpc'
import { prepareLocalInstall } from './plugins/pluginInstaller'
import { contributionIcon } from './plugins/pluginContributionIcon'
import { broadcastQuitStage } from './quit-progress'
import { currentPluginHostTarget, UNIVERSAL_PLUGIN_TARGET } from './plugins/pluginTarget'
import { PluginStorageStore } from './plugins/pluginStorage'
import { TerminalStorageOwnerService } from './terminalStorageOwner'
import { FilePickerHostService } from './filePicker'
import { PluginCapabilityGrantStore } from './plugins/pluginCapabilityGrantStore'
import {
  ExecutionPolicySourceStore,
} from './plugins/executionPolicySourceStore'
import { registerExecutionPolicyIpc } from './plugins/executionPolicyIpc'
import { FAIL_CLOSED_EXECUTION_POLICY, type ExecutionPolicySnapshot } from './plugins/executionPolicy'
import { PluginFactoryOptOutStore } from './plugins/pluginFactoryOptOutStore'
import { BuiltinRemovedEarlierStore, migrateBuiltinRemovalsToDisabled, PluginDisabledStore } from './plugins/pluginDisabledStore'
import { createBuiltinSwitchReconciler } from './plugins/builtinSwitchReconciler'
import { BUILTIN_PLUGIN_NAMES, builtinPluginDisabledMessage } from './plugins/frontendPluginManager'
import { builtinPluginDisabledDialog } from './builtinPluginStrings'
import { webAgentWritePrompt } from './browserAgentStrings'
import { loadPluginDir, type PluginActivationCatalogEntry } from './plugins/installedPlugins'
import { verifyInstalledBackendSpawnTrust } from './plugins/pluginBackendSpawnTrust'
import { localTakedownDecision } from './plugins/pluginLocalTrust'
import { agentApprovalSourceNote, installedPackageSource, nativeBackendConsentDialog } from './plugins/pluginLocalInstall'
import { digestBlockDialogText, type DigestBlockChoice, type DigestBlockPrompt } from './plugins/pluginDigestBlock'
import { revealUnsafeLineText } from '../shared/pluginAgentTools'
import {
  BackendPluginError,
  PluginBackendSupervisor,
  type BackendPluginLaunchSpec,
} from './plugins/pluginBackendSupervisor'
import { bundledMiniIdeV2Dir, MINI_IDE_CONTRIBUTION, activateInstalledMiniIdeRecovery } from './plugins/miniIdePackage'
import { MINI_IDE_PLUGIN_ID, MiniIdeStorageLifecycleSelector } from './plugins/miniIdeStorageLifecycle'
import { createMiniIdeStorageMigrationGate, type MiniIdeStorageAvailability } from './plugins/miniIdeStorageMigrationGate'
import { createMiniIdeLegacyPreferences } from './plugins/miniIdeLegacyPreferences'
import { recoverFailedGitV2Activation } from './plugins/gitV2ActivationRecovery'
import { composePluginContributionQuery } from './plugins/pluginContributionQuery'
import {
  createPlansWindowRouter,
  getContributionWindowConfig,
  getContributionWindowKey,
} from './plansWindowRouting'
import { menuStringsFor } from './menuStrings'
import { HostLocaleManager, readPersistedLocaleFromSettings, type SupportedLocale } from './hostLocale'
import {
  activateFactoryGitWithLegacyFallback,
  assertFactoryGitRestoreAllowed,
  shouldAttemptFactoryGit,
} from './plugins/factoryGitStartup'
import { migrateBundledGitPreferences } from './plugins/gitStorageMigration'
import { GitStorageLifecycleSelector } from './plugins/gitStorageLifecycle'
import { PlansStorageLifecycleSelector } from './plugins/plansStorageLifecycle'
import { resolvePlansRootPath } from './plugins/plansRoot'
import {
  projectLegacyPlansPreferences,
  runPlansLegacyRecovery,
} from './plugins/plansStorageMigration'
import { createPlansStorageMigrationGate, type PlansStorageAvailability } from './plugins/plansStorageMigrationGate'
import { repairPlansStorageRecord, type PlansStorageRepairResult } from './plugins/plansStorageRepair'
import { retainedPlansLegacyAdapter, type PlansLegacyRecoveryBootstrap } from './plugins/plansLegacyAdapter'
import type { LegacyPlansPreferenceProjection } from '../shared/plansPreferences'
import { decidePlansV2Retry } from '../shared/plansRecovery'
import {
  projectBackendPluginActivationCatalog,
  writeBackendPluginActivationCatalog,
} from './plugins/pluginBackendActivationCatalog'
import { registerStorageIpc } from './storage-ipc'
import { lockPageZoom } from './web-contents-zoom'
import { createUiZoomStore, initialUiScaleFrom, type UiZoomStore } from './ui-zoom-store'
import { installContextMenu, registerTerminalContextMenu } from './context-menu'
import { inAppUpdateSupported, initUpdater } from './updater'
import { withDeadline } from './deadline'
import { MAX_RESTORE_ATTEMPTS, onScreenBounds, WindowRegistry, type AuxWindowEntry, type AuxWindowKind, type WindowBounds, type WindowEntry } from './window-registry'
import { registeredGitLeftWorkspace, trustedGitLeftWindow } from './gitLeftIpc'
import { setWindowDockTileBadge } from './dock-tile-badge'
import { writeTempTextArtifact } from './temp-text-artifact'
import { BackendBroadcastTracker } from './backend-broadcast'
import { createResumeGate } from './resume-gate'
import { stabilizeDroppedPaths, pruneDroppedFiles, saveClipboardImage } from './dropped-file-store'
import { watchBackendExit } from './backend-crash'
import { createBackendAutoRestart } from './backend-autorestart'
import {
  CliBufferRelay,
  CLI_BUFFER_REPLY_CHANNEL,
  type CliPaneBufferResult
} from './cli-buffer-relay'
import { uniqueOpenWorkspaces, workspaceIdentityKey } from './workspace-identity'
import {
  PaneActionRelay,
  PANE_ACTION_REPLY_CHANNEL,
  type PaneActionKind,
  type PaneActionResult
} from './pane-action-relay'
import {
  hitTestWindows,
  selectDropCandidates,
  PANE_DRAG_END_CHANNEL,
  EXTERNAL_PANE_DROP_CHANNEL,
  type CandidateWindow
} from './cross-window-drag'
import { readHealthCheckTimeoutSec, writeHealthCheckTimeoutSec } from './health-timeout'
import { readCdpDebugConfig, writeCdpDebugConfig, type CdpDebugConfig } from './cdp-debug'
import { classifyEditorOpen, resolveExternalOpenTarget } from './editor-fallback'
import {
  buildEditorArgv,
  classifyOpenRequest,
  detectEditors,
  launchEditorProcess,
  needsWindowsShell,
  quoteForCmd,
  normalizeEditorId,
  DEFAULT_EDITOR_ID,
  type DetectedEditor,
  type EditorPreference
} from './editors'
import { findManualLogFile } from './manual-log-search'
import { searchLogFiles } from './log-content-search'
import { setTerminalSelection, forgetTerminalSelection } from './terminal-selection-cache'
import {
  getPermissionStatuses,
  requestPermission,
  openPermissionSettings,
  type PermissionKey,
} from './permissions'
import { resolveBackendDataDir, readUiSettingsText, UI_SETTINGS_FILE } from './ui-settings-bootstrap'
import { PlanWindowRegistry } from './plan-windows'
import { createTokenMonitorWindowOpener } from './token-monitor-window'
import { errorMain, infoMain, logMain, logRendererConsole, warnMain } from './main-log'
import { isRendererCrashWatched, watchRendererCrashes } from './renderer-crash-reload'
import { watchConsoleMessages, watchProcessGone } from './renderer-diagnostics'
import { PDF_PARTITION } from './channel-pdf'
import { recordMainFault, setMainLedgerDataDir } from './error-ledger'
import { createPlansBackendStoppedRelay } from './plansBackendStoppedRelay'
import { createPluginAgentActionRelay } from './pluginAgentActionRelay'
import { createPluginStagedCandidateRelay } from './pluginStagedCandidateRelay'
import { isAppWindowSender, UNTRUSTED_SENDER } from './ipcSender'
import { drawnFrameWhereNeeded, installWindowControls } from './window-controls'
import { openInExternalTerminal } from './external-terminal'
import { isLinux, isMac } from '../shared/osplat'
import { installMediaPermissionHandlers } from './media-permissions'
import { registerFnKeyIpc } from './fn-key-ipc'
import { registerSpotlightSettingsIpc } from './spotlight-settings-ipc'
import { registerSpokenContentSettingsIpc } from './spoken-content-settings-ipc'
import { createDeepLinkRouter, registerDeepLinkIpc } from './deep-link'
import { DEEP_LINK_SCHEME, deepLinkFromArgv } from '../shared/deepLink'
import {
  GitAccountsStore,
  type GitAccountCrypto,
  type GitAccountInput
} from './gitAccountsStore'
import { applyLinuxKeyringPreflight } from './linuxKeyring'
import { applyLinuxSpeechDispatcher } from './linuxSpeech'
import type { EditorNativeHost } from './plugins/editorNativeCapability'
import { NativeBackendStore } from './plugins/pluginNativeBackendStore'
import { registerNativeBackendIpc } from './plugins/pluginNativeBackendIpc'
import { PluginAgentToolsHost } from './plugins/pluginAgentToolsHost'
import { canonicalExistingDirectory } from './plugins/workspacePathPolicy'
import { pluginDeveloperModeEnabled } from './plugins/pluginDeveloperMode'
import { isFirstPartyAgentToolPlugin, isFirstPartyBackendPlugin } from './plugins/pluginFirstPartyBackends'
import { isPluginWebGuest } from './plugins/pluginWebViews'
import { guardPlanFrameNavigation } from './planFrameNavigation'
import {
  firstPartyAgentToolSpec,
  firstPartyBackendLaunchSpec,
  isThirdPartyLaunchSpec,
  thirdPartyBackendLaunchSpec,
  packageContentDigest,
  preInstallConsentCandidates,
  type ThirdPartyLaunchSpec,
  ThirdPartyBackendController,
  type AgentToolWritePrompt,
  type NativeBackendConsentPrompt,
  type NativeBackendWritePrompt,
  stdoutPendingOf,
} from './plugins/pluginThirdPartyBackends'

protocol.registerSchemesAsPrivileged([
  {
    scheme: PLUGIN_FRAME_SCHEME,
    privileges: {
      standard: true,
      secure: true,
    },
  },
])

// Dev isolation: give a `npm run dev` instance its own Electron userData so its
// renderer localStorage (layout, settings) doesn't clobber the packaged app's
// when both run at once. Must be set before the app is ready / userData is read
// — and module-level state below (plugin capability grants, factory opt-outs,
// the installed-plugin scan, plugin storage lifecycle) resolves userData
// eagerly, so this has to run before any of it. The backend's state dir is
// isolated separately (see backend.ts). Packaged builds are untouched.
const requestedPlansDevProfile = process.env['NAVIDE_PLANS_DEV_PROFILE']
const plansDevProfile =
  !app.isPackaged &&
  process.env['AGENT_TEAM_PLUGIN_DEV'] === '1' &&
  typeof requestedPlansDevProfile === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(requestedPlansDevProfile)
    ? requestedPlansDevProfile
    : null
if (!app.isPackaged) {
  const devUserData = devUserDataPath(app.getPath('userData'), process.env, plansDevProfile)
  app.setPath('userData', devUserData.path)
  if (devUserData.ignored !== null) {
    console.warn(`[main] NAVIDE_DEV_USER_DATA_DIR must be an absolute path; ignoring ${devUserData.ignored}`)
  }
}
if (
  !app.isPackaged &&
  process.env['AGENT_TEAM_PLUGIN_DEV'] === '1' &&
  requestedPlansDevProfile !== undefined &&
  plansDevProfile === null
) {
  console.warn(
    '[main] NAVIDE_PLANS_DEV_PROFILE must be 1-64 ASCII letters, digits, underscores, or hyphens; using the standard dev profile',
  )
}

if (isMac()) {
  app.dock?.setIcon(nativeImage.createFromPath(join(__dirname, '../../resources/icon.png')))
}

let backend: BackendHandle | null = null
// In-flight initial backend start, so before-quit can wait for it (capped) and
// stop the process instead of orphaning it when the user quits mid-startup.
let backendStarting: Promise<void> | null = null
// Message from the most recent failed start/restart attempt, so the renderer
// can show a real error instead of sitting in "starting" forever after a
// retry also fails. Cleared as soon as a start attempt succeeds.
let backendLastError: string | null = null
// Set while a crashed backend has an auto-restart attempt scheduled. It keeps
// the reported status at 'starting' rather than the terminal 'error', so the
// renderer waits for the respawn instead of failing every send fast. Cleared
// when a restart succeeds, when the attempt budget runs out, and by any
// deliberate lifecycle op.
let backendRestartPending: { attempt: number; max: number; reason: string } | null = null
// Bumped by every deliberate lifecycle op (manual restart, stop, quit). An
// auto-restart already awaiting startBackend when one of those lands must not
// adopt the process it eventually gets: the user has since asked for a
// different backend, or for none at all. Without this the spawn wins by virtue
// of finishing later, and an explicit Stop ends with a running backend.
let backendLifecycleEpoch = 0
// Confirm-before-quit config, driven from the renderer (shared "confirm before
// close" setting). Localized strings are supplied by the renderer.
let quitConfirm = {
  enabled: true,
  message: 'Quit?',
  detail: '',
  quitLabel: 'Quit',
  cancelLabel: 'Cancel',
  dontShowLabel: "Don't show this again",
  cancelledMessage: 'Navide did not quit',
  cancelledDetail: 'A window stopped the quit: {windows}. Finish or close what it is doing, then quit again.',
  cancelledUnknownWindow: 'a window that has closed since',
}
let quitConfirmed = false
let quittingWindowsPrepared = false
// Whether a confirmed quit is under way, for embedded AI panels only (see
// setAppQuittingProbe). Set wherever quitConfirmed is set to begin a quit, but
// unlike quitConfirmed — which stays true after a plugin vetoes the quit, so
// the prompt is not shown again — it is cleared on every path that keeps the
// app running.
let dockQuitInProgress = false
let quittingWindowsPreparation: Promise<boolean> | null = null
// Set once teardownBackendAndQuit has stopped the backend and put up the
// shutdown screen, so a quit cancelled after that can bring both back.
let quitTeardownRan = false
// Every path that cancels a quit undoes it through this one reset.
const resetCancelledQuit = createQuitCancelReset({
  clearQuitFlags: () => {
    dockQuitInProgress = false
    quittingWindowsPrepared = false
  },
  clearCleanExit: () => {
    infoMain('[main] quit cancelled; the app keeps running and the restore snapshot is kept')
    windowRegistry.clearCleanExit()
  },
  takeTeardownRan: () => {
    const ran = quitTeardownRan
    quitTeardownRan = false
    return ran
  },
  restartBackend: () => restartBackendNow(),
  reopenBackendPlugins: () => frontendPluginManager.reopenBackendPlugins(),
  broadcastCancelled: () => broadcastQuitStage('cancelled'),
})
// A quit that before-quit let through can still be cancelled while Electron
// closes the windows, silently. Clear what the quit set and say which window
// stopped it, as an abandoned update install does.
// Windows/Linux title a message box with app.getName(), which is the package
// name ("agent-team"); macOS ignores the field.
const QUIT_DIALOG_TITLE = 'Navide'
const quitCancelWatch = createQuitCancelWatch({
  timeoutMs: 5000,
  openWindowTitles: () => BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .map((window) => window.getTitle()),
  onCancelled: (titles) => {
    const windows = titles.length > 0 ? titles.join(', ') : quitConfirm.cancelledUnknownWindow
    warnMain(`[main] quit did not finish; still open: ${windows}`)
    void (async () => {
      // Bring the app back before saying why it stayed.
      await resetCancelledQuit()
      await dialog.showMessageBox({
        type: 'warning',
        title: QUIT_DIALOG_TITLE,
        message: quitConfirm.cancelledMessage,
        detail: quitConfirm.cancelledDetail.replace('{windows}', windows),
      })
    })().catch(() => undefined)
  },
})
// True while the quit confirmation dialog is on screen, so a second close
// request cannot stack another one.
let quitPromptOpen = false
// Multiple independent main windows (VS Code-style cmd+shift+N). `mainWindow`
// tracks the most-recently-focused one so dialogs parent to it; `mainWindows`
// holds them all for lifecycle code that must reach every main window.
let mainWindow: BrowserWindow | null = null
const mainWindows = new Set<BrowserWindow>()
/** Dedicated hosts are keyed by the stable catalog contribution key. The
 * renderer never receives the corresponding plugin instance id. */
const contributionWindows = new Map<string, BrowserWindow>()
const gitRecoveryForced = process.env['NAVIDE_GIT_RECOVERY'] === 'legacy'
let gitRecoveryEnabled = gitRecoveryForced
let legacyGitRegisteredForForcedRecovery = false
/** The ready-time legacy Git registration for a recovery session. */
function registerForcedLegacyGit(): void {
  legacyGitRegisteredForForcedRecovery = true
  const recovery = registerLegacyBundledGit(frontendPluginManager, {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    artifactVersion: app.getVersion(),
  })
  if (!recovery.registered) {
    warnMain(`[main] NAVIDE_GIT_RECOVERY=legacy but legacy Git bundle is unavailable: ${recovery.reason}`)
  }
}
const plansRecoveryForced = process.env['NAVIDE_PLANS_RECOVERY'] === 'legacy'
let plansRecoveryEnabled = plansRecoveryForced
/** The Host-selected v2 package being recovered by the retained legacy route.
 * Never derive this from the legacy descriptor after fallback. */
let plansRecoveryPackageVersion: string | null = null
/** Why this session dropped to legacy. Kept because it is the only thing the
 * recovery panel can honestly tell the user, and because the storage repair
 * applies to exactly one of these reasons. */
let plansRecoveryReason: string | null = plansRecoveryForced ? 'forced' : null
// Focus recency per window id — approximates z-order for the cross-window pane
// drop hit-test (Electron has no cross-platform z-order query).
const windowFocusSeq = new Map<number, number>()
let windowFocusCounter = 0
app.on('browser-window-focus', (_event, win) => {
  windowFocusSeq.set(win.id, ++windowFocusCounter)
})
app.on('browser-window-created', (_event, win) => {
  const id = win.id
  win.on('closed', () => windowFocusSeq.delete(id))
})
// Maps each main window to its workspace_path so we can focus an existing window
// instead of creating a duplicate when the same folder is opened again.
const mainWindowWorkspaces = new Map<BrowserWindow, string>()
// Detached run-group child windows. A detached window shows only one run group of
// its workspace. It is deliberately kept OUT of mainWindowWorkspaces and the
// crash-restore registry (see detachedWindowIds) so it is never treated as a
// standalone workspace window (no focus-instead-of-open, no restore reopen).
const detachedGroups = new Map<string, BrowserWindow>()          // groupId → child window
const detachedGroupWorkspace = new Map<string, string>()         // groupId → workspace_path
const detachedWindowIds = new Set<number>()                      // child window ids

// The core backend's agent tool result helper (agent-tools contract 4.4, R2):
// resource usage shows its state; every change goes to the main windows, where
// the first `unavailable` raises a notice.
frontendPluginManager.onResultHelperState = (state) => {
  for (const hostWindow of mainWindows) {
    if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
    hostWindow.webContents.send('plugins:resultHelperState', state)
  }
}
// Navide windows main created that are not main windows (Plans, Token
// Monitor): they get the full backend:info, but never a window proof.
const navideAuxWindows = new Set<BrowserWindow>()
// Workspaces a window has taken on from its sidebar, beyond the one it was
// opened with. Kept apart from mainWindowWorkspaces so everything that means
// "this window's own workspace" — the registry, run-group hand-offs, the
// titlebar — keeps meaning exactly that. Only the two "is this folder already
// open somewhere?" answers below consult it, which is the whole point: a
// second window must not open a folder this one is already running.
const adoptedWorkspaces = new Map<BrowserWindow, string[]>()
// Adopted lists waiting to be claimed by the window being restored for them.
// Keyed by window id because the renderer asks for its own after mounting.
const pendingAdoptedWorkspaces = new Map<number, string[]>()

/** Switch all main-window Plans surfaces to the trusted legacy adapter after
 * a v2 package/child availability failure. The descriptor and package remain
 * registered for diagnostics, but no renderer is allowed to keep presenting
 * a dead v2 contribution or MCP availability bit. */
function enterPlansRecovery(reason: string): void {
  // A disabled Plans is off, not degraded: nothing it does may leave the
  // session in legacy recovery once it is enabled again.
  if (frontendPluginManager.isBuiltinPluginDisabled(PLANS_PLUGIN_ID)) return
  frontendPluginManager.markPlansBackendUnavailable(reason)
  if (plansRecoveryEnabled) return
  plansRecoveryEnabled = true
  plansRecoveryReason = reason
  warnMain(`[main] navide.plans entering legacy recovery (${reason})`)
  for (const [key, hostWindow] of contributionWindows) {
    if (key.startsWith('navide.plans.') && !hostWindow.isDestroyed()) hostWindow.close()
  }
  for (const hostWindow of mainWindows) {
    if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
    hostWindow.webContents.send('plugins:contributionsChanged')
    hostWindow.webContents.send('plans:recoveryChanged', { legacy: true, reason })
  }
}

// Send an event to every non-detached main window bound to a workspace (used to
// hand a run group off to / back from a detached child window).
function broadcastToWorkspace(workspacePath: string, channel: string, payload: unknown): void {
  for (const win of mainWindows) {
    if (win.isDestroyed() || detachedWindowIds.has(win.id)) continue
    if (mainWindowWorkspaces.get(win) !== workspacePath) continue
    win.webContents.send(channel, payload)
  }
}
// Workspace paths can refer to the same folder via a trailing slash, a symlink,
// or different casing (macOS FS is case-insensitive); realpath settles all
// three. Falls back to the trimmed string when the folder no longer exists.
function normalizeWorkspacePath(p: string): string {
  const trimmed = (p ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  try {
    return realpathSync(trimmed)
  } catch {
    return trimmed
  }
}

function findMainWindowForWorkspace(workspacePath: string): BrowserWindow | null {
  // Compared by the folder's real identity, case included (review #546): the
  // JS realpath behind normalizeWorkspacePath keeps the case it is given.
  const target = workspaceIdentityKey(workspacePath)
  if (!target) return null
  // A window whose primary it is wins: that is where its tabs, git and
  // explorer already point.
  for (const [win, wp] of mainWindowWorkspaces) {
    if (!win.isDestroyed() && workspaceIdentityKey(wp) === target) return win
  }
  for (const [win, list] of adoptedWorkspaces) {
    if (win.isDestroyed()) continue
    if (list.some((wp) => workspaceIdentityKey(wp) === target)) return win
  }
  return null
}

// Tell every main window the set of open workspaces changed so Welcome screens
// refresh their "open" badges (they re-query workspace:listOpen on this event).
function broadcastOpenWorkspacesChanged(): void {
  for (const win of mainWindows) {
    if (win.isDestroyed() || detachedWindowIds.has(win.id)) continue
    win.webContents.send('workspace:openChanged')
  }
}
// Route a native application-menu action to the renderer of the most relevant
// main window: the focused window when it is a real workspace window (editor /
// detached child windows never receive these), else the most-recently-focused
// main window.
function sendMenuAction(action: string): void {
  const focused = BrowserWindow.getFocusedWindow()
  const target =
    focused && !focused.isDestroyed() && mainWindows.has(focused) && !detachedWindowIds.has(focused.id)
      ? focused
      : mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : null
  target?.webContents.send('menu:action', action)
}
// Application menu is rebuilt whenever the recent-workspaces list changes (each
// window's renderer pushes the latest list via 'menu:setRecents'). Hooks are
// assembled once in whenReady and stored so rebuildAppMenu can reuse them.
let appMenuHooks: AppMenuHooks = {}
let lastRecents: RecentMenuEntry[] = []
function rebuildAppMenu(): void {
  installApplicationMenu(appMenuHooks, lastRecents, currentUiLocale())
}
// Registered once for the process: `ipcMain.handle` throws on a second
// registration, and rebuildAppMenu above runs again on every recents change.
installWindowControls()
// Crash-restore: persists open workspace windows so an unexpected exit can be
// detected and offered for restore on the next launch (see window-registry.ts).
// Path resolved lazily — dev re-points userData (…-dev) below, after imports.
const windowRegistry = new WindowRegistry(() => join(app.getPath('userData'), 'open-windows.json'))
// Notified with each auxiliary window as it is created, and only while the
// startup restore is driving an opener. The openers (the plans router, the
// contribution window host, the standalone opener) all answer with a boolean,
// and threading a bounds argument down through those three layers to serve one
// caller would change four signatures for one launch-time concern — so the
// tracker below, which every auxiliary window already passes through, hands the
// window to whoever is listening instead.
let auxWindowCreatedHook: ((win: BrowserWindow) => void) | null = null
// Track a long-lived auxiliary window (Plans, Git, Token Monitor) so a clean
// exit can bring it back. Called from the one spot that owns the window, and
// only for a genuinely new window — the openers focus an existing one instead,
// and a second addAux for the same window is not what that means.
function trackAuxWindow(win: BrowserWindow, entry: AuxWindowEntry): void {
  const winId = win.id // captured — win.id is not readable after destroy
  windowRegistry.addAux(winId, entry)
  win.on('moved', () => { if (!win.isDestroyed()) windowRegistry.setAuxBounds(winId, win.getBounds()) })
  win.on('resized', () => { if (!win.isDestroyed()) windowRegistry.setAuxBounds(winId, win.getBounds()) })
  win.on('closed', () => windowRegistry.remove(winId))
  auxWindowCreatedHook?.(win)
}
// Health-check timeout: user-configurable via Settings, persisted here so
// startBackend() (called before any renderer window exists) can read it.
// Path resolved lazily for the same reason as windowRegistry's, above.
const healthTimeoutPath = (): string => join(app.getPath('userData'), 'health-check-timeout.json')
// Chrome DevTools Protocol (CDP) debug toggle: user-configurable via Settings.
// Path resolved lazily for the same dev-userData reason as above — see the
// pre-ready read of this file, below the dev userData override.
const cdpDebugPath = (): string => join(app.getPath('userData'), 'cdp-debug.json')
// Git account registry: main-owned, safeStorage-encrypted PATs bound per
// workspace (see gitAccountsStore.ts). Built lazily so app.getPath / safeStorage
// are only touched after the app is ready (IPC calls arrive from renderers).
let gitAccountsStore: GitAccountsStore | null = null
// Set by the pre-ready Linux keyring preflight when it fell back to
// --password-store=basic (see applyLinuxKeyringPreflight below).
let linuxKeyringDowngraded = false
function getGitAccountsStore(): GitAccountsStore {
  if (!gitAccountsStore) {
    // Under basic_text Electron reports encryption unavailable unless plain-text
    // encryption is opted into explicitly.
    if (linuxKeyringDowngraded) safeStorage.setUsePlainTextEncryption(true)
    const crypto: GitAccountCrypto = {
      get available(): boolean {
        return safeStorage.isEncryptionAvailable()
      },
      encrypt: (plain: string): string => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (enc: string): string => safeStorage.decryptString(Buffer.from(enc, 'base64'))
    }
    gitAccountsStore = new GitAccountsStore(join(app.getPath('userData'), 'git-accounts.json'), crypto)
  }
  return gitAccountsStore
}

// The production Git package reaches account storage through the private
// first-party bridge. Keep safeStorage and decrypted credentials in main; the
// renderer-facing package receives only masked accounts or one authenticated
// workspace-bound credential response.
frontendPluginManager.setGitAccountHandlers({
  available: () => getGitAccountsStore().available,
  list: () => getGitAccountsStore().list(),
  add: (input) => getGitAccountsStore().add(input),
  update: (id, patch) => getGitAccountsStore().update(id, patch),
  remove: (id) => getGitAccountsStore().remove(id),
  bind: (workspacePath, accountId) => getGitAccountsStore().bind(workspacePath, accountId),
  unbind: (workspacePath) => getGitAccountsStore().unbind(workspacePath),
  getBinding: (workspacePath) => getGitAccountsStore().getBinding(workspacePath),
  getCredential: (workspacePath) => getGitAccountsStore().getCredentialForWorkspace(workspacePath),
})

// Native close/reload/quit preparation for windows that host a receiver. The
// coordinator only commits once every participant accepted, so a refusal keeps
// every uncommitted window and item alive.
const windowCloseCoordinator = createWindowCloseCoordinator({
  hasWindowCloseParticipants: (window) => frontendPluginManager.hasWindowCloseParticipants(window),
  notifyCloseRefused: (window, reason, cause) => {
    // A refusal is a normal outcome (a plugin keeps a draft), but silence would
    // look like a hang. Say what happened and where it comes from.
    const detail = cause === 'timeout'
      ? 'A plugin did not answer in time.'
      : cause === 'busy'
        ? 'A plugin is still busy.'
        : 'A plugin refused the close.'
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: reason === 'quit' ? 'Quit cancelled' : reason === 'reload' ? 'Reload cancelled' : 'Close cancelled',
      message: reason === 'reload'
        ? 'The window was not reloaded.'
        : 'The window stays open.',
      detail: `${detail} Finish or discard the pending work in the plugin's own view, then try again.`,
    }
    void (window.isDestroyed() ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options))
      .catch(() => undefined)
  },
  prepareWindowClose: (window, reason) => frontendPluginManager.prepareWindowClose(window, reason),
  commitWindowClose: (id) => frontendPluginManager.commitWindowClose(id),
  cancelWindowClose: (id) => frontendPluginManager.cancelWindowClose(id),
  windowForWebContents: (target) => BrowserWindow.fromWebContents(target),
})
// Windows from the previous (uncleanly exited) run, offered to the FIRST
// renderer that asks via restore:getPending; cleared on apply/dismiss.
let pendingRestore: WindowEntry[] | null = null
let pendingRestoreClaimed = false
// Workspaces the restore failure breaker refused to reopen this launch (see
// window-registry.ts). Unlike the crash banner above this is not one-shot: it
// describes this whole run, so any window may ask for it at any time.
let skippedRestores: string[] = []

function loadWindow(win: BrowserWindow, params: Record<string, string>): void {
  const qs = new URLSearchParams(params).toString()
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}${qs ? '?' + qs : ''}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: qs ? '?' + qs : '' })
  }
}

async function createWindow(
  params: Record<string, string> = {},
  opts?: { bounds?: WindowBounds; background?: boolean }
): Promise<BrowserWindow> {
  // Saved bounds may point at a display that is no longer attached.
  const bounds = opts?.bounds && onScreenBounds(
    opts.bounds,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  )
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    // Second line of defence for the shell layout. The side panels can be
    // dragged to 560 + 520 px between them; below this the stage would be down
    // to its floor with the panels squeezed, which is usable but not pleasant,
    // and there is no reason to let the window go narrower than that.
    minWidth: 640,
    minHeight: 420,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    title: 'Navide',
    titleBarStyle: 'hidden',
    // `titleBarStyle: 'hidden'` means something different on each platform:
    // macOS still paints its traffic lights, Windows paints nothing unless
    // asked through `titleBarOverlay`, and Linux paints nothing at all. The
    // renderer draws its own controls where the system will not (see
    // `needsDrawnWindowControls`), so here we only have to stop the native
    // menu bar from stacking a second bar on top of the drawn one.
    autoHideMenuBar: !isMac(),
    // Start hidden and show only once the renderer has painted its first frame,
    // so the user never sees the white flash of an unpainted window. The dark
    // backgroundColor matches the default theme as a safety net for the instant
    // between show() and paint.
    show: false,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium throttles occluded windows: rAF pauses, setTimeout is clamped
      // to >=1s, and after 5 minutes hidden it drops to roughly once a minute.
      // Terminal panes drain PTY output through a timer and xterm's WriteBuffer
      // yields with setTimeout every 12ms, so throttling turns a backgrounded
      // window into multi-second keystroke lag once the user switches back.
      backgroundThrottling: false,
      // In-window plugin contributions (any manifest `location` other than
      // 'window') mount as <webview> so they join this document's stacking
      // context. A native WebContentsView always composites above the DOM,
      // which left modals unable to cover a plugin panel. Every guest's
      // webPreferences are overridden from main in 'will-attach-webview',
      // so enabling the tag grants the renderer no authority of its own.
      webviewTag: true
    }
  })
  mainWindows.add(win)
  watchRendererCrashes(win, { kind: params.detached_group ? 'detached-group' : 'main', log: warnMain, fault: recordRendererGone })
  // In-window plugin contributions attach as <webview> guests. Main overrides
  // their webPreferences here, so the tag the renderer wrote cannot widen what
  // a guest gets, and binds each guest to the identity reserved for it.
  {
    const guestHooks = createGuestAttachHooks(frontendPluginManager)
    win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
      // Electron types WebPreferences without an index signature; the hook needs
      // one to clear the keys the <webview> tag contributed.
      guestHooks.onWillAttach(event, webPreferences as MutableWebPreferences, params)
    })
    win.webContents.on('did-attach-webview', (_event, guest) => {
      guestHooks.onDidAttach(guest)
    })
    // A reservation whose guest never rendered would otherwise hold this window
    // and its resolved capability context until the 30s timer fired.
    win.on('closed', () => frontendPluginManager.releaseGuestReservationsForWindow(win))
  }
  mainWindow = win
  const winId = win.id // captured — win.id is not readable after destroy
  // A detached run-group child window is scoped to one group of its workspace —
  // never track it as a standalone workspace window (no dedup focus, no restore).
  if (params.detached_group) {
    detachedWindowIds.add(winId)
    // Tracked, but as a detached view of one group rather than as a standalone
    // workspace window: no dedup focus, and restore reopens it detached. Before
    // this the detached state lived only in main's memory, so every relaunch
    // silently folded these groups back into the main window.
    if (params.workspace_path) {
      windowRegistry.setWorkspace(winId, params.workspace_path)
      windowRegistry.setDetachedGroup(winId, params.detached_group)
    }
  } else if (params.workspace_path) {
    mainWindowWorkspaces.set(win, params.workspace_path)
    windowRegistry.setWorkspace(winId, params.workspace_path)
  }
  win.on('moved', () => { if (!win.isDestroyed()) windowRegistry.setBounds(winId, win.getBounds()) })
  win.on('resized', () => { if (!win.isDestroyed()) windowRegistry.setBounds(winId, win.getBounds()) })
  // backgroundThrottling is off for the terminals, which also pins the
  // renderer's document.hidden to false — so the Page Visibility API can no
  // longer tell it when to pause background polling. Report the window state
  // directly instead (see App.vue's git status poll).
  const sendVisibility = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send('window:visibility', win.isVisible() && !win.isMinimized())
  }
  win.on('hide', sendVisibility)
  win.on('show', sendVisibility)
  win.on('minimize', sendVisibility)
  win.on('restore', sendVisibility)
  // Show on first paint (theme already applied → no white/wrong-theme flash).
  // Fallback timer guarantees the window appears even if ready-to-show is missed.
  let _shown = false
  const showOnce = (): void => {
    if (_shown || win.isDestroyed()) return
    _shown = true
    // A window an agent opened for a child pane appears without taking focus
    // from whatever the user is doing (cli_open_agent window "new").
    if (opts?.background) win.showInactive()
    else win.show()
  }
  win.once('ready-to-show', showOnce)
  setTimeout(showOnce, 4000)
  // A Plans notice that found no loaded main window is handed to this one.
  win.webContents.on('did-finish-load', () => plansBackendStoppedRelay.flush(win))
  win.webContents.on('did-finish-load', () => pluginAgentActionRelay.flush(win))
  win.webContents.on('did-finish-load', () => pluginStagedCandidateRelay.flush(win))
  win.on('focus', () => { mainWindow = win })
  win.on('closed', () => {
    mainWindows.delete(win)
    mainWindowWorkspaces.delete(win)
    adoptedWorkspaces.delete(win)
    windowRegistry.remove(winId)
    detachedWindowIds.delete(winId)
    if (mainWindow === win) {
      const remaining = [...mainWindows]
      mainWindow = remaining.length ? remaining[remaining.length - 1] : null
    }
    broadcastOpenWorkspacesChanged()
  })

  const mainBootParams: Record<string, string> = {
    ...(gitRecoveryEnabled ? { legacy_git_recovery: '1' } : {}),
    ...(plansRecoveryEnabled ? { legacy_plans_recovery: '1' } : {}),
    // A window opened after the downgrade never sees the IPC event, so the
    // reason has to travel with it or its recovery panel has nothing to say.
    ...(plansRecoveryEnabled && plansRecoveryReason
      ? { plans_recovery_reason: plansRecoveryReason }
      : {}),
  }
  loadWindow(win, { window: 'main', ...params, ...mainBootParams })
  return win
}

function revealMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  app.focus({ steal: true })
  win.focus()
}

function focusOrCreateMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealMainWindow(mainWindow)
    return
  }

  void createWindow().then((win) => {
    // createWindow intentionally stays hidden until its first painted frame.
    // Focus it after that initial show so reopening from the Dock never appears
    // to do nothing and does not reintroduce the startup white flash.
    if (win.isVisible()) revealMainWindow(win)
    else win.once('show', () => revealMainWindow(win))
  })
}

// The Pipeline Manager and the Resource Manager are modals inside a workspace
// window: reveal one and let its renderer open the modal. Target selection
// mirrors sendMenuAction (detached run-group children never host them), and a
// window is created when none is left — on macOS the app outlives its last
// window, where a silent no-op would make the menu item look broken. The send
// waits for the first paint so it can never race the renderer's listener
// registration.
function requestMainWindowModal(channel: string): void {
  const focused = BrowserWindow.getFocusedWindow()
  const target =
    focused && !focused.isDestroyed() && mainWindows.has(focused) && !detachedWindowIds.has(focused.id)
      ? focused
      : [...mainWindows].reverse().find((w) => !w.isDestroyed() && !detachedWindowIds.has(w.id))

  const send = (win: BrowserWindow): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, {})
  }
  const revealAndSend = (win: BrowserWindow): void => {
    if (win.isVisible()) {
      revealMainWindow(win)
      send(win)
    } else {
      win.once('show', () => {
        revealMainWindow(win)
        send(win)
      })
    }
  }

  if (target) revealAndSend(target)
  else void createWindow().then(revealAndSend)
}

function requestPipelineManager(): void {
  requestMainWindowModal('menu:open-pipeline-manager')
}

function requestResourceManager(): void {
  requestMainWindowModal('menu:open-resource-manager')
}

function requestTurnStats(): void {
  requestMainWindowModal('menu:open-turn-stats')
}

const requestTokenMonitor = createTokenMonitorWindowOpener({
  preload: join(__dirname, '../preload/index.js'),
  frame: drawnFrameWhereNeeded(),
  locale: currentUiLocale,
  load: loadWindow,
  // Machine-wide: no workspace_path, so the restore filter reopens it without
  // asking which workspace came back.
  onWindowCreated: (win) => {
    navideAuxWindows.add(win)
    win.once('closed', () => navideAuxWindows.delete(win))
    watchRendererCrashes(win, { kind: 'token-monitor', log: warnMain, fault: recordRendererGone })
    trackAuxWindow(win, { kind: 'token-monitor' })
  },
})

function backendInfoPayload() {
  if (!backend) {
    // A scheduled auto-restart outranks the crash message: the backend IS
    // coming back, so report the same 'starting' the initial spawn reports and
    // let the renderer show "reconnecting" instead of a terminal error.
    if (backendRestartPending) {
      return {
        status: 'starting' as const,
        autoRestart: {
          attempt: backendRestartPending.attempt,
          max: backendRestartPending.max,
          reason: backendRestartPending.reason,
        },
      }
    }
    return backendLastError
      ? { status: 'error' as const, error: backendLastError }
      : { status: 'starting' as const }
  }
  return {
    status: 'ready' as const,
    host: backend.host,
    port: backend.port,
    pid: backend.proc.pid,
    shell: backend.shell,
    httpUrl: `http://${backend.host}:${backend.port}`,
    // The token travels inside the URL the windows and the plugin broker
    // already receive, so nothing downstream had to learn a new mechanism —
    // one change here reaches every /ws client at once. A page in a browser
    // can guess the port but cannot read the file this came from, which is
    // the whole of the defence; see backend/agent_team_backend/ws_auth.py.
    // Nothing here marks a Navide window: a main window answers the
    // connection's challenge through backend:proveWindow instead, so the URL
    // carries no replayable proof and the plugin broker uses the same one.
    wsUrl: brokerWsUrl(backend)
  }
}

function brokerWsUrl(handle: BackendHandle): string {
  return `ws://${handle.host}:${handle.port}/ws?t=${encodeURIComponent(readWsToken(handle))}`
}

// Push the current backend info to every window so each renderer's useBackend
// can reconnect after a restart (the port changes) or show disconnected on stop.
// Only the focused window(s) get it immediately — otherwise a single backend
// blip flashes "reconnecting" in every open window at once. Backgrounded
// windows get the latest snapshot queued and delivered on their next 'focus'
// event (see below).
const backendBroadcastTracker = new BackendBroadcastTracker<ReturnType<typeof backendInfoPayload>>()

function broadcastBackendChanged(): void {
  const payload = backendInfoPayload()
  // Point the main-process transport at the new backend before changing its
  // bearer. This prevents a reconnect from registering the new token on the
  // old socket while that socket's registration task is still in flight.
  frontendPluginManager.setBackendWsUrl(payload.status === 'ready' && backend ? brokerWsUrl(backend) : null)
  frontendPluginManager.setBackendHostToken(
    payload.status === 'ready' && backend ? backend.hostSessionToken : null
  )
  // A terminal error bypasses the focus gate — see BackendBroadcastTracker.
  const urgent = payload.status === 'error'
  // Navide windows only, like backend:info: the payload carries the ws token.
  for (const win of backendChangedTargets(BrowserWindow.getAllWindows(), [mainWindows, navideAuxWindows])) {
    if (win.isDestroyed()) continue
    const { immediate } = backendBroadcastTracker.dispatch(win.id, win.isFocused(), payload, urgent)
    if (immediate) win.webContents.send('backend:changed', payload)
  }
}

// Flush a queued backend info snapshot to a window as soon as it regains
// focus, and stop tracking it once closed. Registered on every BrowserWindow,
// but only a window broadcastBackendChanged pushed to has anything queued.
app.on('browser-window-created', (_event, win) => {
  win.on('focus', () => {
    const payload = backendBroadcastTracker.takePending(win.id)
    if (payload !== undefined && !win.isDestroyed()) win.webContents.send('backend:changed', payload)
  })
  win.on('closed', () => backendBroadcastTracker.forget(win.id))
})

// Rebuild every WebSocket the moment the machine wakes.
//
// Sleep kills the TCP connections underneath, but nothing tells the sockets:
// readyState still reads OPEN and isHealthyFor() still agrees, so the loss is
// only discovered when the frontend's ping watchdog has timed out three times
// — some 40 seconds of a UI that looks connected and is not. Waking is the one
// moment the staleness is certain, so reconnect then instead of waiting to be
// told.
//
// Only a full wake fires this; macOS maintenance/dark wakes do not. That is
// the case worth covering anyway — it is when the user comes back to the
// machine.
const resumeGate = createResumeGate()
app.whenReady().then(() => {
  powerMonitor.on('resume', () => {
    if (!resumeGate.admit(Date.now())) return
    // Main holds its own backend socket for the plugin broker; it went stale
    // with the rest.
    frontendPluginManager.reconnectAfterResume()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      // Deliberately not focus-gated, unlike backend:changed: a backgrounded
      // window would otherwise sit on a dead socket until someone clicks it.
      win.webContents.send('system:resumed')
    }
  })
})

// Extensions view: install/update/remove third-party plugins. Verified packages
// are written under userData/plugins and scanned back on next launch.
const pluginsRoot = (): string => join(app.getPath('userData'), 'plugins')
// Card K4 (D6): a packaged build honors the self-hosted Registry overrides only
// while the user's Developer Mode switch is on, and never takes the official
// publisher key from the environment. Set before anything resolves either.
// A2-5 (G5): entries of that file another program wrote are disclosed and
// asked about again. Its HMAC key is wrapped by safeStorage, touched only once
// the app is ready and only while Developer Mode is in use; before that, or
// without secure storage, nothing is checked (disclosed).
const pluginDeveloperModeIntegrity: DeveloperModeIntegrity = {
  get available(): boolean {
    return app.isReady() && !linuxKeyringDowngraded && safeStorage.isEncryptionAvailable() &&
      (!isLinux() || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  },
  encrypt: (plain: string): string => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (enc: string): string => safeStorage.decryptString(Buffer.from(enc, 'base64')),
  onExternalChange: () => frontendPluginManager.recordDeveloperModeExternalChange(app.getVersion()),
}
const pluginDeveloperModeStore = new PluginDeveloperModeStore(pluginsRoot(), pluginDeveloperModeIntegrity)
setMarketplaceOverridesAllowed(() => !app.isPackaged || pluginDeveloperModeStore.isEnabled())
if (app.isPackaged) disableOfficialKeyOverride()
let installedRegistryRootKey: string | null = null
let installedRegistryAuthority: 'official' | 'self-hosted' = 'self-hosted'
let installedOfficialRegistryUrl: string | undefined
try {
  const configuredMarketplace = resolveConfiguredMarketplace()
  installedRegistryRootKey = configuredMarketplace.trust.pinnedRegistryRootKey
  installedRegistryAuthority = configuredMarketplace.trust.registryAuthority ?? 'self-hosted'
  installedOfficialRegistryUrl = configuredMarketplace.trust.officialRegistryUrl
} catch (error) {
  console.warn(
    `[main] marketplace Registry root is not approved; installed v2 plugins remain quarantined: ${error instanceof Error ? error.message : String(error)}`
  )
}
// D3: an expired Testplace build the user chose to keep using loads on.
const pluginTestplaceStore = new PluginTestplaceStore(pluginsRoot())
const keepsExpiredTestplace = (packageId: string, artifactDigest: string): boolean =>
  pluginTestplaceStore.keepsExpired(packageId, artifactDigest)
const installedPluginTrust = {
  pinnedRootKey: installedRegistryRootKey,
  snapshot: readRegistryTrustSnapshot(pluginsRoot()),
  registryAuthority: installedRegistryAuthority,
  officialRegistryUrl: installedOfficialRegistryUrl,
  expectedTarget: currentPluginHostTarget(),
  keepsExpiredTestplace,
  // 0.2.28 (user, 10-21): a Testplace withdrawal never stops a build at
  // start; Extensions labels it and the tester is asked once.
}

function currentInstalledRegistryTrust() {
  const marketplace = resolveConfiguredMarketplace()
  return {
    pinnedRootKey: marketplace.trust.pinnedRegistryRootKey,
    snapshot: readRegistryTrustSnapshot(pluginsRoot()),
    registryAuthority: marketplace.trust.registryAuthority,
    officialRegistryUrl: marketplace.trust.officialRegistryUrl,
    expectedTarget: marketplace.trust.expectedTarget ?? currentPluginHostTarget(),
    now: marketplace.trust.now,
    keepsExpiredTestplace,
  }
}

/** Why a developer folder is taken down by Navide, or null (card K4). */
function developerFolderTakedown(packageDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    const decision = localTakedownDecision(
      {
        id: String(manifest.id),
        version: String(manifest.version),
        ...(typeof manifest.publisher === 'string' ? { publisher: manifest.publisher } : {}),
      },
      currentInstalledRegistryTrust(),
    )
    return decision.action === 'blocked' ? decision.reason : null
  } catch {
    // An unreadable manifest is refused by the loader itself.
    return null
  }
}

function verifyCurrentInstalledBackendTrust(
  activation: Pick<BackendPluginLaunchSpec, 'pluginId' | 'packageVersion' | 'packageDir'>,
): void {
  verifyInstalledBackendSpawnTrust(activation, {
    pluginsRoot,
    currentRegistryTrust: currentInstalledRegistryTrust,
  })
}

function scheduleDeniedBackendRuntimeQuarantine(
  activation: Pick<BackendPluginLaunchSpec, 'pluginId' | 'packageVersion' | 'packageDir'>,
): void {
  agentToolsHost?.mark(activation.pluginId, 'revoked')
  void agentToolsHost?.refresh().catch(() => undefined)
  void frontendPluginManager
    .revokePackageVersion(activation.pluginId, activation.packageVersion)
    .catch((drainError: unknown) => {
      console.warn(
        `[main] revoked plugin runtime could not be drained: ${
          drainError instanceof Error ? drainError.message : String(drainError)
        }`,
      )
    })
    .finally(() => {
      const descriptor = frontendPluginManager.getDescriptor(activation.pluginId)
      if (
        !descriptor ||
        descriptor.packageVersion !== activation.packageVersion ||
        !descriptor.packageDir ||
        relative(descriptor.packageDir, activation.packageDir) !== '' ||
        relative(activation.packageDir, descriptor.packageDir) !== ''
      ) return
      try {
        frontendPluginManager.removeInstalledPlugin(activation.pluginId, { restoreBuiltin: false })
        applyPluginActivationChange({ pluginId: activation.pluginId })
      } catch (error) {
        console.warn(
          `[main] revoked plugin descriptor could not be quarantined: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    })
}

async function preflightCandidateFrontend(
  descriptor: Parameters<typeof frontendPluginManager.preflightPackageFrontend>[0],
): Promise<void> {
  const hostWindow = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      webviewTag: false,
    },
  })
  try {
    await frontendPluginManager.preflightPackageFrontend(descriptor, hostWindow)
  } finally {
    if (!hostWindow.isDestroyed()) hostWindow.destroy()
  }
}

async function preflightCandidateBackend(
  activation: PluginActivationCatalogEntry,
): Promise<void> {
  const backend = activation.backend
  if (!backend) return
  if (!isFirstPartyBackendPlugin(activation.pluginId)) {
    // A third-party candidate runs only with the admission a real launch
    // needs (switch, consent for this content, sandbox, breaker), never with
    // a prompt, and under the same watchdog and cleanup. Otherwise installing
    // only stages it; its first launch asks through the full admission.
    const spec = thirdPartyBackendActivation(activation)
    if (!spec || !isThirdPartyLaunchSpec(spec)) return
    const admission = await thirdPartyBackends.preflightAdmission(spec)
    if (!admission) return
    const supervisor = new PluginBackendSupervisor(spec, {
      environment: createPluginBackendChildEnvironment(),
      spawnProcess: admission.spawnProcess,
      bridgeDispatcher: admission.bridgeDispatcher,
      beforeSpawn: async () => {
        verifyCurrentInstalledBackendTrust(spec)
        await admission.beforeSpawn()
      },
    })
    try {
      await supervisor.start()
    } finally {
      await supervisor.close()
    }
    return
  }
  const launch: BackendPluginLaunchSpec = {
    pluginId: activation.pluginId,
    packageVersion: activation.packageVersion,
    packageDir: activation.packageDir,
    entryFile: backend.entryFile,
    protocolVersion: backend.protocolVersion,
    activation: backend.activation,
    approvedMethods: [],
    approvedEvents: [],
    approvedBridgePorts: [],
  }
  const supervisor = new PluginBackendSupervisor(launch, {
    environment: createPluginBackendChildEnvironment(),
    beforeSpawn: () => verifyCurrentInstalledBackendTrust(launch),
  })
  try {
    await supervisor.start()
  } finally {
    await supervisor.close()
  }
}

const pluginCapabilityGrants = new PluginCapabilityGrantStore(pluginsRoot())
const executionPolicySourceStore = new ExecutionPolicySourceStore(app.getPath('userData'))
const pluginFactoryOptOuts = new PluginFactoryOptOutStore(pluginsRoot())
// Installed before the first load: a package the user disabled is still
// verified, but its views and backend are never registered.
const pluginDisabledSwitch = new PluginDisabledStore(pluginsRoot())
frontendPluginManager.setDisabledPluginResolver((pluginId) => pluginDisabledSwitch.has(pluginId))
// Every backend start learns the disabled built-ins from its spawn env, so it
// refuses Plans work even before this Host session registers.
setBackendDisabledBuiltinsProvider(() => frontendPluginManager.listDisabledBuiltinPlugins())
// Built-ins can no longer be removed, only disabled. A Git or Mini-IDE removal
// an earlier version recorded becomes Disabled here, before anything loads: the
// bundled package comes back, off, with Enable one click away. That removal
// already deleted its stored data, which the Extensions row discloses.
const builtinRemovedEarlier = new BuiltinRemovedEarlierStore(pluginsRoot())
migrateBuiltinRemovalsToDisabled(
  { optOuts: pluginFactoryOptOuts, disabled: pluginDisabledSwitch, removedEarlier: builtinRemovedEarlier },
  ['navide.git', MINI_IDE_PLUGIN_ID],
  (message) => warnMain(`[main] ${message}`),
)

/** A disabled built-in is off, not broken: refuse and say so where the user
 *  acted. Returns false when the plugin is enabled. */
function refuseDisabledBuiltin(pluginId: string, target?: BrowserWindow | null, notify = true): boolean {
  if (!frontendPluginManager.isBuiltinPluginDisabled(pluginId)) return false
  if (notify) {
    const text = builtinPluginDisabledDialog(currentUiLocale(), BUILTIN_PLUGIN_NAMES.get(pluginId) ?? pluginId)
    const options: Electron.MessageBoxOptions = { type: 'info', title: text.title, message: text.message }
    const parent = target && !target.isDestroyed() ? target : mainWindow
    void (parent && !parent.isDestroyed()
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options))
  }
  return true
}
const installedPluginLoad = frontendPluginManager.loadInstalledPlugins(pluginsRoot(), {
  provenance: 'official-registry',
  trust: installedPluginTrust,
})
// Project the recovered durable package/storage selection before any factory
// or renderer activation can mount a plugin instance. Invalid selectors remain
// fail-closed in the loader and never become a guessed storage fallback.
frontendPluginManager.projectPluginStorageSnapshotSelections(pluginsRoot())
// Only a package that passed install verification and produced a usable
// descriptor suppresses the bundled factory copy. A corrupt/quarantined
// directory named navide.git is not an authoritative installation.
const installedGitDescriptorPresent = frontendPluginManager.getDescriptor('navide.git') !== undefined
const miniIdeSource = {
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  artifactVersion: app.getVersion(),
}
const installedMiniIdeDescriptorPresent = frontendPluginManager.getDescriptor(MINI_IDE_PLUGIN_ID) !== undefined
frontendPluginManager.setContributionIconResolver(contributionIcon)
// Windows hosting embedded AI panels end them on close, but not while the app
// quits: those panels restore next launch. Cmd+Q without the prompt sets only
// quittingWindowsPrepared; a confirmed quit or an update install sets
// dockQuitInProgress, which a vetoed quit clears again. An abandoned install
// clears both, and so does a quit cancelled while the windows close.
frontendPluginManager.setAppQuittingProbe(() => dockQuitInProgress || quittingWindowsPrepared)
frontendPluginManager.setCapabilityGrantResolver((pluginId, packageVersion) =>
  pluginCapabilityGrants.get(pluginId, packageVersion)
)
frontendPluginManager.setBackendSpawnTrustVerifier((activation) => {
  try {
    verifyCurrentInstalledBackendTrust(activation)
  } catch (error) {
    // The supervisor invokes this hook while its generation is still in the
    // start path. Drain asynchronously so the trust failure remains fail
    // closed without waiting on a re-entrant Host teardown. The completion
    // path removes only the still-selected matching descriptor and catalog
    // entry; a newer activation cannot be removed by this stale denial.
    scheduleDeniedBackendRuntimeQuarantine(activation)
    throw error
  }
})
// Third-party package backends are someone else's native code. They run only
// under the OS sandbox, with the user's consent for the exact binary and
// permission set (installing is the first one), behind a global switch that
// is on by default for a new profile.
const nativeBackendRoot = join(app.getPath('userData'), 'plugin-native-backends')
const nativeBackendStore = new NativeBackendStore(nativeBackendRoot)
// Plan B1-b: the third-party agent-tool catalog. Created once the installed
// activation catalog exists (below); until then nothing can change it.
let agentToolsHost: PluginAgentToolsHost | null = null
const thirdPartyBackends = new ThirdPartyBackendController({
  store: nativeBackendStore,
  // Card K4: a developer folder's consent is bound to the folder and its
  // declared permissions and backend, not to content that changes as the
  // developer works; every other package binds to its exact content.
  digestBackend: (spec) =>
    Promise.resolve(developerFolderBackendDigest(pluginDeveloperModeStore.folders(), spec))
      .then((digest) => digest ?? packageContentDigest(spec.packageDir)),
  dataRoot: join(nativeBackendRoot, 'data'),
  filesystemPort: () => frontendPluginManager.createWorkspaceFilesystemPort(),
  shellPort: () => frontendPluginManager.createThirdPartyShellPort(),
  agentsPort: () => frontendPluginManager.createThirdPartyAgentsPort(),
  stopBackends: (pluginId) => frontendPluginManager.stopThirdPartyBackends(pluginId),
  promptConsent: promptNativeBackendConsent,
  promptWorkspaceWrite: promptNativeBackendWorkspaceWrite,
  onConsentGranted: () => {
    void agentToolsHost?.refresh().catch(() => undefined)
  },
  promptAgentToolWrite: promptAgentToolWorkspaceWrite,
  agentToolCall: (initiatorId) => frontendPluginManager.agentToolCallFor(initiatorId),
  // Watchdog option C (contract 5.2): rows for the backend's audit, and a
  // nudge so every main window reads the unanswered notices again.
  recordResourceDecision: (row) => frontendPluginManager.recordResourceDecision(row),
  // Review M2 on #375: stdout waiting for a newline is noticed like the rest.
  stdoutPendingBytes: (pluginId, instanceId) =>
    stdoutPendingOf(frontendPluginManager.backendResourceUsage(), pluginId, instanceId),
  onResourceNoticesChanged: () => {
    for (const hostWindow of mainWindows) {
      if (hostWindow.isDestroyed()) continue
      hostWindow.webContents.send('plugins:nativeBackends:resourceNoticesChanged')
    }
  },
})
frontendPluginManager.setThirdPartyBackendAdmitter((activation, workspacePath, instanceId) =>
  isThirdPartyLaunchSpec(activation)
    ? thirdPartyBackends.admit(activation, workspacePath, { instanceId })
    : Promise.reject(new BackendPluginError('BACKEND_UNAVAILABLE', 'not a third-party backend')),
)

/** A first-party backend other than Plans (pluginFirstPartyBackends.ts):
 *  launched like Plans, outside the third-party admission gate. */
function firstPartyBackendActivation(activation: PluginActivationCatalogEntry): BackendPluginLaunchSpec | null {
  try {
    return firstPartyBackendLaunchSpec(activation)
  } catch (error) {
    console.warn(
      `[main] first-party backend for ${activation.pluginId} is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

function thirdPartyBackendActivation(activation: PluginActivationCatalogEntry): BackendPluginLaunchSpec | null {
  try {
    return thirdPartyBackendLaunchSpec(activation)
  } catch (error) {
    console.warn(
      `[main] third-party backend for ${activation.pluginId} is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return null
  }
}

function nativeBackendDialogParent(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && mainWindows.has(focused) && !focused.isDestroyed()) return focused
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

async function promptNativeBackendConsent(prompt: NativeBackendConsentPrompt): Promise<boolean> {
  // Plan B D-g: in the user's language, with the methods it serves. Card K3:
  // an unreviewed package's source leads the text (nativeBackendConsentDialog).
  const { title, message, detail, buttons } = nativeBackendConsentDialog(
    prompt,
    currentUiLocale(),
    installedPackageSource(frontendPluginManager.listInstalledPackages().find((pkg) => pkg.id === prompt.pluginId)),
  )
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title,
    message,
    detail,
    buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const parent = nativeBackendDialogParent()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return result.response === 1
}

// Decision d5: a local install whose `.vsix` Navide blocked since, told once.
async function promptDigestBlock(prompt: DigestBlockPrompt): Promise<DigestBlockChoice> {
  const { title, message, detail, buttons, choices } = digestBlockDialogText(prompt, currentUiLocale())
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title,
    message,
    detail,
    buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const parent = nativeBackendDialogParent()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return choices[result.response] ?? 'keep'
}

async function promptNativeBackendWorkspaceWrite(prompt: NativeBackendWritePrompt): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Allow file changes',
    message: `Allow ${prompt.name} to change files in this workspace?`,
    detail: `${prompt.workspacePath}\n\nYou can revoke this in Settings → Navide Plugins.`,
    buttons: ['Don\'t allow', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const parent = nativeBackendDialogParent()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return result.response === 1
}

// DB3: an agent asked for a write-risk tool. Its own question, naming the
// agent and the tool, separate from the view's "allow file changes".
async function promptAgentToolWorkspaceWrite(prompt: AgentToolWritePrompt): Promise<boolean> {
  // Navide Browser's write tools drive web pages; asking about files would mislead.
  if (prompt.pluginId === 'navide.browser') return promptWebAgentToolWrite(prompt)
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Agent wants to change files',
    message: [
      // Card K3: the source first, then package text with nothing hidden in it.
      agentApprovalSourceNote(
        installedPackageSource(frontendPluginManager.listInstalledPackages().find((pkg) => pkg.id === prompt.pluginId)),
      ),
      `An agent asked to use "${revealUnsafeLineText(prompt.tool.title)}" (${revealUnsafeLineText(prompt.tool.name)}) of ${revealUnsafeLineText(prompt.name)} ${revealUnsafeLineText(prompt.packageVersion)}, which changes files. Allow agents to do this in this workspace?`,
    ].filter(Boolean).join('\n'),
    detail: [
      // Card K3: an unreviewed package's tool says where it came from.
      agentApprovalSourceNote(
        installedPackageSource(frontendPluginManager.listInstalledPackages().find((pkg) => pkg.id === prompt.pluginId)),
      ),
      prompt.workspacePath,
      'The agent, not you, started this. You are asked again after an update or a new permission.',
    ].filter(Boolean).join('\n\n'),
    buttons: ['Don\'t allow', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const parent = nativeBackendDialogParent()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return result.response === 1
}

async function promptWebAgentToolWrite(prompt: AgentToolWritePrompt): Promise<boolean> {
  const tool = `"${revealUnsafeLineText(prompt.tool.title)}" (${revealUnsafeLineText(prompt.tool.name)})`
  const text = webAgentWritePrompt(
    currentUiLocale(),
    tool,
    revealUnsafeLineText(prompt.name),
    revealUnsafeLineText(prompt.packageVersion),
  )
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: text.title,
    message: text.message,
    detail: [prompt.workspacePath, text.origin].join('\n\n'),
    buttons: text.buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
  const parent = nativeBackendDialogParent()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return result.response === 1
}

// Installed package backends from the previous session: first-party ones
// outside the third-party gate, every other one through it. Plans registers
// through its own bundled/installed selection path.
for (const activation of installedPluginLoad.activationCatalog) {
  if (!activation.backend || activation.pluginId === 'navide.plans') continue
  const spec = isFirstPartyBackendPlugin(activation.pluginId)
    ? firstPartyBackendActivation(activation)
    : thirdPartyBackendActivation(activation)
  if (!spec || frontendPluginManager.hasBackendActivation(activation.pluginId, activation.packageVersion)) continue
  try {
    frontendPluginManager.registerBackendActivation(spec)
  } catch (error) {
    console.warn(
      `[main] third-party backend for ${activation.pluginId} was not registered: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
// 0.2.32, once per profile: the third-party backends installed before 0.2.31
// (no install recorded its consent then) count as consented, as the
// installs of 0.2.31 and later do. Developer Mode folders keep their own
// folder-bound consent.
try {
  const granted = nativeBackendStore.migratePreInstallConsent(preInstallConsentCandidates(
    installedPluginLoad.activationCatalog,
    new Set(pluginDeveloperModeStore.folders().map((folder) => folder.pluginId)),
  ))
  if (granted.length > 0) console.info(`[main] native backends installed before 0.2.31 allowed: ${granted.join(', ')}`)
} catch (error) {
  console.warn(`[main] pre-0.2.31 native backend consent not recorded: ${error instanceof Error ? error.message : String(error)}`)
}

frontendPluginManager.setUiLocaleResolver(() => currentUiLocale())
frontendPluginManager.setExecutionPolicyResolver((workspacePath?: string): ExecutionPolicySnapshot => {
  try {
    if (!workspacePath) return executionPolicySourceStore.getGlobalEffectivePolicy()
    const snapshot = executionPolicySourceStore.getEffectivePolicy(workspacePath)
    return {
      policy: snapshot.policy,
      revision: snapshot.revision,
      state:
        snapshot.status === 'active'
          ? snapshot.activeSource === 'default'
            ? 'default'
            : 'user'
          : 'corrupt',
    }
  } catch {
    return { policy: FAIL_CLOSED_EXECUTION_POLICY, revision: 0, state: 'corrupt' }
  }
})
const factoryGitActivations = installedPluginLoad.activationCatalog.slice(0, 0)
const factoryGitDir = (): string => officialPluginArtifactPackageDir(
  miniIdeSource,
  'navide.git',
  UNIVERSAL_PLUGIN_TARGET,
)
function loadFactoryGitPackage() {
  const factoryGit = frontendPluginManager.loadFactoryPlugin(factoryGitDir(), 'navide.git')
  if (!factoryGit.loaded) return factoryGit
  const descriptor = frontendPluginManager.getDescriptor(factoryGit.pluginId)
  const policy = descriptor?.capabilityPolicy
  if (policy?.kind !== 'manifest-v2') {
    frontendPluginManager.removeInstalledPlugin(factoryGit.pluginId, { restoreBuiltin: false })
    return { loaded: false as const, reason: 'factory package has no Manifest v2 policy' }
  }
  pluginCapabilityGrants.set(factoryGit.pluginId, {
    packageVersion: factoryGit.packageVersion,
    system: [...policy.system],
    ...(policy.shell ? { shell: policy.shell } : {}),
    storage: true,
  })
  return factoryGit
}
function hasValidMiniIdeV2Descriptor(
  descriptor = frontendPluginManager.getDescriptor(MINI_IDE_PLUGIN_ID),
): boolean {
  return Boolean(
    descriptor?.capabilityPolicy?.kind === 'manifest-v2' &&
      descriptor.packageVersion &&
      descriptor.views?.some((view) =>
        view.contributionKey === MINI_IDE_CONTRIBUTION &&
        view.location === 'window' &&
        existsSync(view.entryFile)
      )
  )
}
function loadFactoryMiniIdePackage() {
  const factoryMiniIde = frontendPluginManager.loadFactoryPlugin(
    bundledMiniIdeV2Dir(miniIdeSource),
    MINI_IDE_PLUGIN_ID,
  )
  if (!factoryMiniIde.loaded) return factoryMiniIde
  const descriptor = frontendPluginManager.getDescriptor(factoryMiniIde.pluginId)
  const policy = descriptor?.capabilityPolicy
  if (policy?.kind !== 'manifest-v2' || !hasValidMiniIdeV2Descriptor(descriptor)) {
    frontendPluginManager.removeInstalledPlugin(factoryMiniIde.pluginId, { restoreBuiltin: false })
    return { loaded: false as const, reason: 'factory package has no valid Mini-IDE window contribution' }
  }
  pluginCapabilityGrants.set(factoryMiniIde.pluginId, {
    packageVersion: factoryMiniIde.packageVersion,
    system: [...policy.system],
    ...(policy.shell ? { shell: policy.shell } : {}),
    storage: true,
  })
  return factoryMiniIde
}
const factoryMiniIdeActivations = installedPluginLoad.activationCatalog.slice(0, 0)
if (!installedMiniIdeDescriptorPresent && !pluginFactoryOptOuts.has(MINI_IDE_PLUGIN_ID)) {
  const factoryMiniIde = loadFactoryMiniIdePackage()
  if (factoryMiniIde.loaded) factoryMiniIdeActivations.push(factoryMiniIde.activation)
  else warnMain(`[main] bundled Mini-IDE v2 unavailable: ${factoryMiniIde.reason}`)
}
if (shouldAttemptFactoryGit({
  forcedLegacy: gitRecoveryEnabled,
  installedPackagePresent: installedGitDescriptorPresent,
  optedOut: pluginFactoryOptOuts.has('navide.git'),
})) {
  const selection = activateFactoryGitWithLegacyFallback({
    loadFactory: loadFactoryGitPackage,
    activateLegacy: () => registerLegacyBundledGit(frontendPluginManager, {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      artifactVersion: app.getVersion(),
    }),
  })
  if (selection.mode === 'v2') factoryGitActivations.push(selection.activation)
  else if (selection.mode === 'legacy') {
    gitRecoveryEnabled = true
    warnMain(`[main] bundled navide.git v2 failed; using legacy recovery: ${selection.v2Reason}`)
  } else {
    warnMain(
      `[main] bundled navide.git is unavailable: ${selection.v2Reason}; ${selection.legacyReason}`
    )
  }
}
let miniIdeRecoveryEnabled = false
frontendPluginManager.setActivationFailureHandler((failure) => {
  const recovered = recoverFailedGitV2Activation(failure, {
    selectedDescriptor: () => frontendPluginManager.getDescriptor('navide.git') ?? null,
    hasExactGrant: (pluginId, packageVersion) =>
      pluginCapabilityGrants.get(pluginId, packageVersion) !== null,
    activateLegacy: () => registerLegacyBundledGit(frontendPluginManager, {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      artifactVersion: app.getVersion(),
    }),
    onActivated: () => {
      // The only record of *why* the session downgraded. Without it a user
      // reporting the "Legacy recovery" panel left nothing to diagnose from.
      warnMain(
        `[main] navide.git v2 activation failed (${failure.reason}); switched to legacy recovery`
      )
      gitRecoveryEnabled = true
      for (const [key, hostWindow] of contributionWindows) {
        if (key.startsWith('navide.git.') && !hostWindow.isDestroyed()) hostWindow.close()
      }
      for (const hostWindow of mainWindows) {
        if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
        hostWindow.webContents.send('plugins:contributionsChanged')
        hostWindow.webContents.send('git:recoveryChanged', { legacy: true })
      }
    },
  })
  if (!recovered && failure.pluginId === 'navide.git') {
    warnMain(
      `[main] failed navide.git v2 activation could not switch to legacy recovery: ${failure.reason}`
    )
  }
  if (
    failure.pluginId === MINI_IDE_PLUGIN_ID &&
    !pluginFactoryOptOuts.has(MINI_IDE_PLUGIN_ID) &&
    hasValidMiniIdeV2Descriptor() &&
    pluginCapabilityGrants.get(MINI_IDE_PLUGIN_ID, failure.packageVersion) !== null
  ) {
    const overlayReady = installMiniIdeLegacyPreferenceOverlay(failure.packageVersion)
    const recovery = overlayReady
      ? activateInstalledMiniIdeRecovery(frontendPluginManager, miniIdeSource)
      : { registered: false, reason: 'no trusted Mini-IDE storage snapshot is available' }
    if (recovery.registered) {
      miniIdeRecoveryEnabled = true
      for (const [key, hostWindow] of contributionWindows) {
        if (key === MINI_IDE_CONTRIBUTION && !hostWindow.isDestroyed()) hostWindow.close()
      }
      for (const hostWindow of mainWindows) {
        if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
        hostWindow.webContents.send('plugins:contributionsChanged')
      }
      warnMain(`[main] Mini-IDE v2 activation failed (${failure.reason}); switched to installed recovery`)
    } else {
      warnMain(`[main] Mini-IDE v2 activation failed; recovery unavailable: ${recovery.reason}`)
    }
  }
})
frontendPluginManager.setPlansBackendFailureHandler((failure) => {
  // This covers both an initial bind failure and a later renderer/child
  // failure. The left contribution is recovered in-place by App/ControlPane;
  // the standalone window is handed to the existing legacy adapter.
  const isLeftContribution = failure.contributionKey === 'navide.plans.left'
  plansRecoveryPackageVersion = failure.packageVersion
  enterPlansRecovery(failure.reason)
  frontendPluginManager.destroyInstance(failure.instanceId)
  const query = failure.query.startsWith('?') ? failure.query.slice(1) : failure.query
  const relPath = new URLSearchParams(query).get('rel_path') ?? undefined
  warnMain(`[main] navide.plans v2 failed (${failure.reason}); switched to legacy recovery`)
  if (!isLeftContribution) {
    void openLegacyPlanWindow(failure.workspacePath, relPath).then((opened) => {
      if (opened === false) showPlansRecoveryUnavailable(failure.workspacePath)
    })
  }
})
// With no main window open, or one still loading, the notice waits for the
// next main window to finish loading (createWindow flushes it).
const plansBackendStoppedRelay = createPlansBackendStoppedRelay({
  find: (workspacePath) => findMainWindowForWorkspace(workspacePath),
  fallback: () => mainWindow,
})
// An agent disabled or enabled a Navide plugin (B2-c): the main window names
// the caller and offers the undo; held until one has loaded.
const pluginAgentActionRelay = createPluginAgentActionRelay({ window: () => mainWindow })
// A plugin installed without Restart that the launch could not activate: the
// main window says why and where Restart and Discard are; held until one has loaded.
const pluginStagedCandidateRelay = createPluginStagedCandidateRelay({ window: () => mainWindow })
frontendPluginManager.setPlansBackendStoppedHandler(({ workspacePath }) => {
  // A headless (agent) Plans child failed too often to be restarted. Nothing
  // on screen shows it, so the workspace's window tells the user how to bring
  // it back; the renderer owns the localized text.
  warnMain('[main] navide.plans agent backend stopped after repeated failures')
  plansBackendStoppedRelay.notify(workspacePath)
})
let approvedInstalledPluginActivations = [
  ...installedPluginLoad.activationCatalog,
  ...factoryGitActivations,
  ...factoryMiniIdeActivations,
]
for (const error of installedPluginLoad.errors) {
  console.warn(`[main] installed plugin quarantined: ${error}`)
}
// Manifest v2 storage is Host-owned durable state. Resolve the path lazily so
// the development userData override below is applied before the first request;
// the plugin request never supplies any part of it or of the partition identity.
const pluginStorageStore = new PluginStorageStore(
  () => join(app.getPath('userData'), 'plugin-storage-v2')
)
const terminalStorageOwnerService = new TerminalStorageOwnerService({
  preloadPath: join(__dirname, '../preload/terminal-owner-preload.js'),
  entry: (origin) => {
    if (origin === 'legacy-mini-ide') {
      return {
        filePath: join(
          bundledMiniIdeDir({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            artifactVersion: app.getVersion(),
          }),
          'index.html',
        ),
      }
    }
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    return rendererUrl
      ? { url: rendererUrl }
      : { filePath: join(__dirname, '../renderer/index.html') }
  },
})
frontendPluginManager.setTerminalStorageHandler((origin, request, canDispatch) =>
  terminalStorageOwnerService.execute(origin, request, canDispatch)
)
const filePickerHostService = new FilePickerHostService({
  preloadPath: join(__dirname, '../preload/file-picker-preload.js'),
  entry: process.env['ELECTRON_RENDERER_URL']
    ? { url: process.env['ELECTRON_RENDERER_URL'] }
    : { filePath: join(__dirname, '../renderer/index.html') },
  openPreview: ({ workspacePath, canonicalPath, canDispatch }) => {
    if (!canDispatch()) return Promise.resolve(false)
    if (refuseDisabledBuiltin('navide.plans', findMainWindowForWorkspace(workspacePath))) {
      return Promise.resolve(false)
    }
    const workspaceRoot = normalizeWorkspacePath(workspacePath)
    if (!workspaceRoot || !isAbsolute(canonicalPath)) return Promise.resolve(false)
    const relPath = relative(workspaceRoot, canonicalPath)
    if (
      !relPath ||
      isAbsolute(relPath) ||
      relPath === '..' ||
      relPath.startsWith(`..${sep}`)
    ) return Promise.resolve(false)
    return openCatalogContributionWindow(
      'navide.plans.window',
      workspacePath,
      { filepath: canonicalPath },
      {
        path: canonicalPath,
        expectedCanonicalPath: canonicalPath,
        workspaceOnly: true,
      },
      canDispatch,
    ).then((result) => {
      if (!result.ok && canDispatch()) {
        const reason = result.error ?? 'unknown error'
        warnMain(`[main] navide.plans.window preview unavailable: ${reason}`)
        showPlansPreviewUnavailable(workspacePath)
      }
      return result.ok
    })
  },
  openSelected: ({ workspacePath, canonicalPath, line, canDispatch }) => {
    if (!canDispatch()) return Promise.resolve(false)
    const workspaceRoot = normalizeWorkspacePath(workspacePath)
    const targetPath = canonicalPath
    if (!workspaceRoot || !targetPath || !isAbsolute(targetPath)) return Promise.resolve(false)
    const relPath = relative(workspaceRoot, targetPath)
    const inWorkspace = relPath &&
      !isAbsolute(relPath) &&
      relPath !== '..' &&
      !relPath.startsWith(`..${sep}`)
    return openMiniIdeEditor(null, {
      workspace_path: workspacePath,
      ...(inWorkspace
        ? { filepath: relPath }
        : { filepath: basename(targetPath), file_ws: dirname(targetPath) }),
      ...(line !== undefined ? { line: String(line) } : {}),
    }, canDispatch, {
      path: targetPath,
      expectedCanonicalPath: targetPath,
    })
  },
})
frontendPluginManager.setFilePickerHost(filePickerHostService)
const gitStorageLifecycle = new GitStorageLifecycleSelector(
  join(app.getPath('userData'), 'plugin-storage-v2', 'lifecycle.json'),
)
const plansStorageLifecycle = new PlansStorageLifecycleSelector(
  join(app.getPath('userData'), 'plugin-storage-v2', 'plans-lifecycle.json'),
)
const miniIdeStorageLifecycle = new MiniIdeStorageLifecycleSelector(
  join(app.getPath('userData'), 'plugin-storage-v2', 'mini-ide-lifecycle.json'),
)
const applyPluginActivationChange = ({
  pluginId,
  activation,
}: {
  pluginId: string
  activation?: (typeof approvedInstalledPluginActivations)[number]
}): void => {
  if (activation?.backend) {
    // Every package backend not on the first-party list is third-party native
    // code: its allowlists come from its manifest and it is launched only
    // through the sandboxed third-party admission gate. Plans retains its
    // explicit allowlist; the other first-party backends (the browser) take
    // theirs from the manifest and the first-party list, outside the gate.
    const backend: BackendPluginLaunchSpec | null = activation.pluginId === 'navide.plans'
      ? plansBackendActivation(activation)
      : isFirstPartyBackendPlugin(activation.pluginId)
        ? firstPartyBackendActivation(activation)
        : thirdPartyBackendActivation(activation)
    if (backend && !frontendPluginManager.hasBackendActivation(pluginId, activation.packageVersion)) {
      frontendPluginManager.registerBackendActivation(backend)
    }
  }
  approvedInstalledPluginActivations = approvedInstalledPluginActivations.filter(
    (entry) => entry.pluginId !== pluginId
  )
  if (activation) approvedInstalledPluginActivations.push(activation)
  // Removed, disabled or quarantined: its DB3 answers do not carry over.
  if (!activation) {
    try {
      nativeBackendStore.forgetAgentToolWrites(pluginId)
    } catch (error) {
      console.warn(`[main] agent write grants for ${pluginId} could not be cleared: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  void agentToolsHost?.refresh().catch(() => undefined)
  for (const win of mainWindows) {
    if (!win.isDestroyed() && !detachedWindowIds.has(win.id)) {
      win.webContents.send('plugins:contributionsChanged')
    }
  }
}
/** Re-activate the App-bundled v2 package, from a cold start or from legacy
 *  recovery. Recovery keeps the package registered, so the plain factory load
 *  refuses to run again and needs the recovery-specific seam. */
function activateFactoryGitPackage():
  | { loaded: true; activation: (typeof approvedInstalledPluginActivations)[number] }
  | { loaded: false; reason: string } {
  if (!gitRecoveryEnabled) return loadFactoryGitPackage()
  const restored = frontendPluginManager.restoreFactoryAfterRecovery(factoryGitDir(), 'navide.git')
  return restored.restored
    ? { loaded: true, activation: restored.activation }
    : { loaded: false, reason: restored.reason }
}

// A failed v2 activation is usually transient: a readiness handshake that
// missed its budget under load, or a guest torn down before it reported ready.
// The downgrade used to last the whole session, with no way back but a
// restart. Opening the Git tab is the user's natural retry, so spend a small
// budget of v2 attempts there before the session settles on legacy Git.
const GIT_V2_RECOVERY_RETRIES = 2
let gitV2RetriesLeft = GIT_V2_RECOVERY_RETRIES
function retryGitV2AfterRecovery(): { ok: boolean; reason?: string } {
  if (!gitRecoveryEnabled) return { ok: true }
  if (gitRecoveryForced) return { ok: false, reason: 'NAVIDE_GIT_RECOVERY=legacy is forcing legacy recovery' }
  if (pluginFactoryOptOuts.has('navide.git')) return { ok: false, reason: 'factory package is opted out' }
  if (gitV2RetriesLeft <= 0) return { ok: false, reason: 'no v2 attempt left this session' }
  const restored = activateFactoryGitPackage()
  if (!restored.loaded) {
    // Only an attempt that actually failed costs budget. Spending it up front
    // meant a restore that worked still burned one, so two downgrades — even
    // two spurious ones — stranded the session on legacy until a restart.
    gitV2RetriesLeft -= 1
    warnMain(`[main] navide.git v2 retry failed: ${restored.reason}; ${gitV2RetriesLeft} retry left`)
    return { ok: false, reason: restored.reason }
  }
  gitRecoveryEnabled = false
  // v2 is running again, so the budget has served its purpose. A later,
  // unrelated downgrade starts from a full budget rather than inheriting the
  // cost of one that was already recovered from.
  gitV2RetriesLeft = GIT_V2_RECOVERY_RETRIES
  applyPluginActivationChange({ pluginId: 'navide.git', activation: restored.activation })
  for (const hostWindow of mainWindows) {
    if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
    hostWindow.webContents.send('git:recoveryChanged', { legacy: false })
  }
  warnMain(
    `[main] navide.git v2 restored after legacy recovery; retry budget reset to ${gitV2RetriesLeft}`
  )
  return { ok: true }
}
ipcMain.handle('git:retryV2', (event) => {
  if (!isTrustedPluginManagementSender(event, mainWindows)) return { ok: false, reason: 'untrusted sender' }
  if (refuseDisabledBuiltin('navide.git', null, false)) return { ok: false, reason: builtinPluginDisabledMessage('navide.git') }
  return retryGitV2AfterRecovery()
})

const registeredThirdPartySpecs = (): ThirdPartyLaunchSpec[] =>
  approvedInstalledPluginActivations.flatMap((activation) => {
    if (!activation.backend || isFirstPartyBackendPlugin(activation.pluginId)) return []
    const spec = frontendPluginManager.getBackendActivation(activation.pluginId, activation.packageVersion)
    return spec && isThirdPartyLaunchSpec(spec) ? [spec] : []
  })
// First-party backends with agent tools (navide.browser): the catalog entry
// of each registered first-party activation. Their tools follow the master
// switch but need no per-version consent (PluginAgentToolsHost).
const registeredFirstPartyAgentToolSpecs = (): ThirdPartyLaunchSpec[] =>
  approvedInstalledPluginActivations.flatMap((activation) => {
    if (!activation.backend || !isFirstPartyAgentToolPlugin(activation.pluginId)) return []
    const registered = frontendPluginManager.getBackendActivation(activation.pluginId, activation.packageVersion)
    if (!registered || isThirdPartyLaunchSpec(registered)) return []
    try {
      const spec = firstPartyAgentToolSpec({ ...activation, packageDir: registered.packageDir })
      return spec ? [spec] : []
    } catch (error) {
      console.warn(
        `[main] agent tools of ${activation.pluginId} are unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return []
    }
  })
agentToolsHost = new PluginAgentToolsHost({
  switches: () => nativeBackendStore.agentToolSwitches(),
  setSwitches: (change) => nativeBackendStore.setAgentToolSwitches(change),
  listPackages: registeredThirdPartySpecs,
  listFirstPartyPackages: registeredFirstPartyAgentToolSpecs,
  // Native backends turned off globally or for the package count as disabled.
  // A first-party package is not a third-party native backend: only its own
  // Disabled switch applies (the installed-package one: it is a Marketplace
  // package).
  isDisabled: (pluginId) =>
    isFirstPartyAgentToolPlugin(pluginId)
      ? frontendPluginManager.isPluginDisabled(pluginId)
      : !nativeBackendStore.isEnabled() ||
        frontendPluginManager.isPluginDisabled(pluginId) ||
        nativeBackendStore.record(pluginId).disabled === true,
  hasConsent: (spec) => thirdPartyBackends.hasAgentToolsConsent(spec),
  // DB1 collision order, per name (B1-a): when a consented version first
  // declared this name, else when the package first declared tools.
  agentToolSince: (pluginId, name) => {
    const record = nativeBackendStore.record(pluginId)
    return record.agentToolNamesSince?.[name] ?? record.agentToolsSince ?? null
  },
  setAgentMethods: (pluginId, packageVersion, methods) =>
    frontendPluginManager.setThirdPartyAgentMethods(pluginId, packageVersion, methods),
  confirmWrite: (spec, tool, workspaceRoot) =>
    isFirstPartyAgentToolPlugin(spec.pluginId)
      ? thirdPartyBackends.confirmFirstPartyAgentToolWrite(spec, workspaceRoot, tool)
      : thirdPartyBackends.confirmAgentToolWrite(spec, workspaceRoot, tool),
  send: (payload) => frontendPluginManager.sendAgentToolsSync(payload),
})
frontendPluginManager.setAgentToolsHost(agentToolsHost)
// An agent tool may target only a workspace open in a Navide window.
frontendPluginManager.setAgentToolWorkspaceResolver((root) => {
  const open = [
    ...[...mainWindowWorkspaces].filter(([win]) => !win.isDestroyed()).map(([, path]) => path),
    ...[...adoptedWorkspaces].filter(([win]) => !win.isDestroyed()).flatMap(([, paths]) => paths),
  ]
  return open.some((path) => canonicalExistingDirectory(path) === root)
})
const agentToolsControls = agentToolsHost
registerNativeBackendIpc(
  (channel, listener) => ipcMain.handle(channel, listener),
  (event) => isTrustedPluginManagementSender(event, mainWindows),
  thirdPartyBackends,
  registeredThirdPartySpecs,
  () => nativeBackendStore.isEnabled(),
  {
    switches: () => agentToolsControls.switches(),
    setSwitches: (change) => agentToolsControls.setSwitches(change),
    refresh: () => agentToolsControls.refresh(),
  },
)

const pluginTrustRefresh = registerPluginIpc(
  frontendPluginManager,
  pluginsRoot(),
  (event) => isTrustedPluginManagementSender(event, mainWindows),
  undefined,
  undefined,
  {
    resolveContributionIcon: contributionIcon,
    onActivationChange: applyPluginActivationChange,
    onPluginAgentAction: (notice) => pluginAgentActionRelay.notify(notice),
    onPackageSwitched: (notice) => pluginStagedCandidateRelay.notifySwitched(notice),
    onPackageSwitchFailed: (failure) => {
      console.warn(`[main] switching ${failure.pluginId} to ${failure.stagedVersion} failed: ${failure.reason}`)
      pluginStagedCandidateRelay.notifyStagedUpdates([failure])
    },
    promptDigestBlock,
    preflightCandidateFrontend,
    preflightCandidateBackend,
    // Card K3: the only source of a local package path is this dialog, opened
    // over the main window that asked (never a detached or plugin window).
    pickLocalPackageFile: async (event) => {
      const parent = BrowserWindow.fromWebContents(event.sender)
      if (!parent || parent.isDestroyed() || !mainWindows.has(parent) || detachedWindowIds.has(parent.id)) return null
      const picked = await dialog.showOpenDialog(parent, {
        properties: ['openFile'],
        filters: [{ name: 'Navide plugin package', extensions: ['vsix'] }],
      })
      return picked.canceled ? null : picked.filePaths[0] ?? null
    },
    // DESIGN-A2 G1: an automatic reload of a developer folder; the main
    // windows refresh the Developer Mode list and say when consent is needed.
    onDeveloperFolderEvent: (folderEvent) => {
      for (const hostWindow of mainWindows) {
        if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
        hostWindow.webContents.send('plugins:developerFolderEvent', folderEvent)
      }
    },
    developerModeIntegrity: pluginDeveloperModeIntegrity,
    pickDeveloperFolder: async (event) => {
      const parent = BrowserWindow.fromWebContents(event.sender)
      if (!parent || parent.isDestroyed() || !mainWindows.has(parent) || detachedWindowIds.has(parent.id)) return null
      const picked = await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
      return picked.canceled ? null : picked.filePaths[0] ?? null
    },
    // W1: the static scan shown in the consent dialog of a local install,
    // run in a worker thread (the scanner's budget is up to 30 s).
    scanLocalPackage: scanLocalPackageInWorker,
    forgetBackendConsent: (pluginId, keepInstallConsentFor) => nativeBackendStore.forgetGrants(pluginId, keepInstallConsentFor),
    noteInstallConsent: (pluginId, packageVersion) => nativeBackendStore.noteInstallConsent(pluginId, packageVersion),
    nativeBackendDataRoot: join(nativeBackendRoot, 'data'),
    pluginStorageRoot: join(app.getPath('userData'), 'plugin-storage-v2'),
    cleanupPluginStorage: async (pluginId) => {
      await pluginStorageStore.cleanupPlugin(pluginId)
      nativeBackendStore.forget(pluginId)
      if (pluginId === 'navide.plans') plansStorageLifecycle.clear()
      if (pluginId === MINI_IDE_PLUGIN_ID) {
        miniIdeStorageLifecycle.clear()
        miniIdeStorageAvailability = null
        miniIdeStoragePackageVersion = null
        clearMiniIdeLegacyPreferenceOverlay()
        frontendPluginManager.setMiniIdeStorageSnapshotContext('', null)
      }
    },
    factoryPackageIds: ['navide.git', MINI_IDE_PLUGIN_ID],
    // loadFactoryPackage refuses the same way, but only after the open Git
    // views were drained; asking first keeps the button hidden instead.
    factoryRollbackRefusal: (pluginId) => {
      if (pluginId !== 'navide.git') return undefined
      try {
        assertFactoryGitRestoreAllowed({ forcedLegacy: gitRecoveryForced })
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    backendCallConcurrency: () => frontendPluginManager.backendCallConcurrency(),
    backendResourceUsage: () => frontendPluginManager.backendResourceUsage(),
    listFactoryPackages: () => {
      const descriptor = frontendPluginManager.getDescriptor('navide.git')
      const factoryActive = frontendPluginManager
        .listInstalledPackages()
        .some((pkg) => pkg.id === 'navide.git' && pkg.provenance === 'factory-bundled') &&
        descriptor?.capabilityPolicy?.kind === 'manifest-v2' &&
        !gitRecoveryEnabled
      const miniDescriptor = frontendPluginManager.getDescriptor(MINI_IDE_PLUGIN_ID)
      const miniFactoryActive = frontendPluginManager
        .listInstalledPackages()
        .some((pkg) => pkg.id === MINI_IDE_PLUGIN_ID && pkg.provenance === 'factory-bundled') &&
        hasValidMiniIdeV2Descriptor(miniDescriptor) &&
        !miniIdeRecoveryEnabled
      const builtinSwitch = (pluginId: string) => ({
        disabled: frontendPluginManager.isBuiltinPluginDisabled(pluginId),
        ...(builtinRemovedEarlier.has(pluginId) ? { dataDeletedByEarlierRemoval: true } : {}),
      })
      return [{
        id: 'navide.git',
        version: factoryActive ? descriptor?.packageVersion ?? null : null,
        active: factoryActive,
        optedOut: pluginFactoryOptOuts.has('navide.git'),
        ...builtinSwitch('navide.git'),
      }, {
        id: MINI_IDE_PLUGIN_ID,
        version: miniFactoryActive ? miniDescriptor?.packageVersion ?? null : null,
        active: miniFactoryActive,
        optedOut: pluginFactoryOptOuts.has(MINI_IDE_PLUGIN_ID),
        ...builtinSwitch(MINI_IDE_PLUGIN_ID),
      }, {
        ...plansFactoryPackageSummary(frontendPluginManager, plansRecoveryEnabled),
        ...builtinSwitch('navide.plans'),
      }]
    },
    restoreFactoryPackage: (pluginId) => {
      if (pluginId === MINI_IDE_PLUGIN_ID) {
        if (existsSync(join(pluginsRoot(), pluginId))) {
          throw new Error('an installed package already owns this plugin id')
        }
        const restored = miniIdeRecoveryEnabled
          ? frontendPluginManager.restoreFactoryAfterRecovery(
              bundledMiniIdeV2Dir(miniIdeSource),
              MINI_IDE_PLUGIN_ID,
            )
          : loadFactoryMiniIdePackage()
        const restoredOk = 'loaded' in restored ? restored.loaded : restored.restored
        if (!restoredOk) {
          throw new Error('reason' in restored ? restored.reason : 'factory Mini-IDE restore failed')
        }
        pluginFactoryOptOuts.remove(pluginId)
        miniIdeRecoveryEnabled = false
        clearMiniIdeLegacyPreferenceOverlay()
        const activation = 'activation' in restored ? restored.activation : undefined
        applyPluginActivationChange({ pluginId, activation })
        return
      }
      if (pluginId !== 'navide.git') throw new Error('unknown factory package')
      assertFactoryGitRestoreAllowed({ forcedLegacy: gitRecoveryForced })
      if (existsSync(join(pluginsRoot(), pluginId))) {
        throw new Error('an installed package already owns this plugin id')
      }
      const restored = activateFactoryGitPackage()
      if (!restored.loaded) throw new Error(restored.reason)
      pluginFactoryOptOuts.remove(pluginId)
      gitRecoveryEnabled = false
      applyPluginActivationChange({ pluginId, activation: restored.activation })
      for (const hostWindow of mainWindows) {
        if (!hostWindow.isDestroyed() && !detachedWindowIds.has(hostWindow.id)) {
          hostWindow.webContents.send('git:recoveryChanged', { legacy: false })
        }
      }
    },
    // Rollback hands an id back to the same bundled bytes restoreFactoryPackage
    // serves, so it owes the same guard and the same recovery-state reset. It
    // cannot reuse that function: the displaced package is still on disk as the
    // next candidate, which its "already owns this plugin id" guard refuses.
    loadFactoryPackage: (pluginId) => {
      if (pluginId === MINI_IDE_PLUGIN_ID) {
        if (miniIdeRecoveryEnabled) {
          const recovered = frontendPluginManager.restoreFactoryAfterRecovery(
            bundledMiniIdeV2Dir(miniIdeSource),
            MINI_IDE_PLUGIN_ID,
          )
          if (!recovered.restored) return { loaded: false as const, reason: recovered.reason }
          miniIdeRecoveryEnabled = false
          clearMiniIdeLegacyPreferenceOverlay()
          pluginFactoryOptOuts.remove(pluginId)
          const descriptor = frontendPluginManager.getDescriptor(pluginId)
          return {
            loaded: true as const,
            pluginId,
            packageVersion: recovered.activation.packageVersion,
            activation: recovered.activation,
            ...(descriptor ? { descriptor } : {}),
          }
        }
        const loaded = loadFactoryMiniIdePackage()
        if (loaded.loaded) {
          clearMiniIdeLegacyPreferenceOverlay()
          pluginFactoryOptOuts.remove(pluginId)
        }
        return loaded
      }
      if (pluginId === 'navide.git') {
        // Refuses while Git is pinned to legacy, the same way a restore does.
        assertFactoryGitRestoreAllowed({ forcedLegacy: gitRecoveryForced })
        const loaded = loadFactoryGitPackage()
        if (!loaded.loaded) return loaded
        gitRecoveryEnabled = false
        pluginFactoryOptOuts.remove(pluginId)
        for (const hostWindow of mainWindows) {
          if (!hostWindow.isDestroyed() && !detachedWindowIds.has(hostWindow.id)) {
            hostWindow.webContents.send('git:recoveryChanged', { legacy: false })
          }
        }
        return loaded
      }
      return { loaded: false, reason: 'unknown factory package' }
    },
    onFactoryPackageRemoved: (pluginId) => {
      if (pluginId === MINI_IDE_PLUGIN_ID) {
        pluginFactoryOptOuts.add(pluginId)
        miniIdeRecoveryEnabled = false
        clearMiniIdeLegacyPreferenceOverlay()
        for (const [key, hostWindow] of contributionWindows) {
          if (key === MINI_IDE_CONTRIBUTION && !hostWindow.isDestroyed()) hostWindow.close()
        }
        for (const hostWindow of mainWindows) {
          if (!hostWindow.isDestroyed() && !detachedWindowIds.has(hostWindow.id)) {
            hostWindow.webContents.send('plugins:contributionsChanged')
          }
        }
        return
      }
      pluginFactoryOptOuts.add(pluginId)
      gitRecoveryEnabled = gitRecoveryForced
      for (const hostWindow of mainWindows) {
        if (!hostWindow.isDestroyed() && !detachedWindowIds.has(hostWindow.id)) {
          hostWindow.webContents.send('git:recoveryChanged', { legacy: gitRecoveryEnabled })
        }
      }
    },
    onPackageInstalled: (pluginId) => {
      if (pluginId === 'navide.git') pluginFactoryOptOuts.remove(pluginId)
      if (pluginId === MINI_IDE_PLUGIN_ID) pluginFactoryOptOuts.remove(pluginId)
    },
    onBuiltinSwitchReset: (resumed) => {
      for (const pluginId of resumed) completeBuiltinEnable(pluginId)
      builtinSwitchReconciler.sync()
      for (const hostWindow of mainWindows) {
        if (!hostWindow.isDestroyed() && !detachedWindowIds.has(hostWindow.id)) {
          hostWindow.webContents.send('plugins:contributionsChanged')
        }
      }
    },
    setBuiltinDisabled: async (pluginId, disabled) => {
      await applyBuiltinSwitch(pluginId, disabled)
      // Enabled once, it starts from the empty storage the old removal left.
      if (!disabled) builtinRemovedEarlier.remove(pluginId)
      builtinSwitchReconciler.sync()
    },
    holdBuiltinSwitch: (task) => builtinSwitchReconciler.hold(task),
  }
)
// Card K4: the developer folders the user consented to, when Developer Mode is on.
// A2-5: once the app is ready, so the consent signatures can be checked.
void app.whenReady().then(() => pluginTrustRefresh.loadDeveloperFolders())
// A first install the user did not restart is activated now, as Restart would
// have done it; one that cannot be stays staged and the main window says why.
// A package staged beside an active one is not applied for the user: the main
// window says which version waits and which runs, and offers to apply it.
void pluginTrustRefresh.activateStagedFirstInstalls().then((failures) => {
  for (const failure of failures) {
    console.warn(`[main] plugin ${failure.pluginId} ${failure.version} installed without Restart was not activated: ${failure.reason}`)
    pluginStagedCandidateRelay.notify(failure)
  }
}, (error) => {
  console.warn(`[main] staged plugin activation failed: ${error instanceof Error ? error.message : String(error)}`)
}).finally(() => {
  const staged = pluginTrustRefresh.stagedUpdates()
  if (staged.length > 0) pluginStagedCandidateRelay.notifyStagedUpdates(staged)
})

// Navide Marketplace developer (W3): sign-in, publish, yank and the developer
// application. Tokens and the signing key are safeStorage ciphertext in their
// own file, never the CLI account credentials; see developerVault.ts.
const developerAccount = new DeveloperAccount({
  vault: new DeveloperVault(join(app.getPath('userData'), 'marketplace-developer.json'), {
    get available(): boolean {
      // A Linux basic_text store is not encryption: Navide keeps no developer secret in it.
      return !linuxKeyringDowngraded && safeStorage.isEncryptionAvailable() &&
        (!isLinux() || safeStorage.getSelectedStorageBackend() !== 'basic_text')
    },
    encrypt: (plain: string): string => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (enc: string): string => safeStorage.decryptString(Buffer.from(enc, 'base64')),
  }),
  registryUrl: () => resolveConfiguredMarketplace().registryUrl,
  openExternal: (url) => shell.openExternal(url),
})
setDeveloperAccount(developerAccount)
const developerIpc = registerDeveloperIpc({
  handle: (channel, listener) => ipcMain.handle(channel, listener),
  stagingRoot: join(app.getPath('userData'), 'plugin-staging', 'publish'),
  authorize: (event) => isTrustedPluginManagementSender(event, mainWindows),
  account: developerAccount,
  inspectPackage: (bytes) => {
    const marketplace = resolveConfiguredMarketplace()
    const pkg = prepareLocalInstall(bytes, {
      pinnedRegistryRootKey: marketplace.trust.pinnedRegistryRootKey,
      trustSnapshot: readRegistryTrustSnapshot(pluginsRoot()),
      expectedTarget: marketplace.trust.expectedTarget,
    })
    return { id: pkg.id, version: pkg.version, publisher: pkg.publisherId, digest: pkg.digest, manifest: pkg.manifest }
  },
  pickPackageFile: async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (!parent || parent.isDestroyed() || !mainWindows.has(parent) || detachedWindowIds.has(parent.id)) return null
    const picked = await dialog.showOpenDialog(parent, {
      properties: ['openFile'],
      filters: [{ name: 'Navide plugin package', extensions: ['vsix'] }],
    })
    return picked.canceled ? null : picked.filePaths[0] ?? null
  },
  hostTarget: currentPluginHostTarget,
})
frontendPluginManager.setDeveloperQueryHandler(createDeveloperQueryHandler(
  developerAccount,
  developerIpc.publishFromPath,
  // O3: only a Registry on this computer publishes without the user's Submit.
  () => resolveConfiguredMarketplace().registryUrl,
))
/** The Host side of a built-in's Disabled switch: drain and close it, or bring
 *  it back. Used by the Extensions switch and by a store change the switch did
 *  not make (see builtinSwitchReconciler). */
async function applyBuiltinSwitch(pluginId: string, disabled: boolean): Promise<void> {
  if (disabled) {
    for (const [key, hostWindow] of contributionWindows) {
      if (key.startsWith(`${pluginId}.`) && !hostWindow.isDestroyed()) hostWindow.close()
    }
    if (pluginId === 'navide.plans') {
      for (const hostWindow of BrowserWindow.getAllWindows()) {
        if (!hostWindow.isDestroyed() && planWindows.hasWindow(hostWindow)) hostWindow.close()
      }
    }
    await frontendPluginManager.suspendBuiltinPlugin(pluginId)
  } else {
    frontendPluginManager.resumeBuiltinPlugin(pluginId)
    completeBuiltinEnable(pluginId)
  }
  for (const hostWindow of mainWindows) {
    if (!hostWindow.isDestroyed() && !detachedWindowIds.has(hostWindow.id)) {
      hostWindow.webContents.send('plugins:contributionsChanged')
    }
  }
}
/** What enabling a built-in needs after `resumeBuiltinPlugin`, shared by the
 *  Enable switch and the reset of an unreadable store: a forced legacy Git
 *  recovery session registers the legacy Git it would have at startup. */
function completeBuiltinEnable(pluginId: string): void {
  if (pluginId === 'navide.git' && gitRecoveryForced && !legacyGitRegisteredForForcedRecovery) {
    registerForcedLegacyGit()
  }
}
// A store that turns unreadable while the app runs fails closed for the
// built-ins; apply that at once (drain the views, re-register the Host so the
// backend refuses Plans work) instead of at the next registration.
const builtinSwitchReconciler = createBuiltinSwitchReconciler({
  list: () => frontendPluginManager.listDisabledBuiltinPlugins(),
  apply: applyBuiltinSwitch,
  warn: (message) => warnMain(`[main] ${message}`),
})
setInterval(() => { void builtinSwitchReconciler.check() }, 15_000).unref()
registerExecutionPolicyIpc(
  executionPolicySourceStore,
  (event) => isTrustedPluginManagementSender(event, mainWindows),
  {
    resolveWorkspace: (event, requestedWorkspace) => {
      const hostWindow = BrowserWindow.fromWebContents(event.sender)
      if (!hostWindow || !mainWindows.has(hostWindow) || detachedWindowIds.has(hostWindow.id)) {
        return undefined
      }
      const registeredWorkspace = mainWindowWorkspaces.get(hostWindow)
      if (!registeredWorkspace) return undefined
      if (requestedWorkspace === undefined) return registeredWorkspace
      return registeredGitLeftWorkspace(
        hostWindow,
        requestedWorkspace,
        mainWindowWorkspaces,
        normalizeWorkspacePath,
      ) ?? undefined
    },
    onChanged: () => {
      for (const hostWindow of mainWindows) {
        if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
        hostWindow.webContents.send('execution-policy:changed')
      }
    },
  },
)
async function refreshInstalledPluginTrust(): Promise<void> {
  try {
    const refreshed = await pluginTrustRefresh.refreshRegistryTrust()
    const { decisions } = refreshed
    if (refreshed.activationCatalog.length > 0) {
      const restoredIds = new Set(
        refreshed.activationCatalog.map((entry) => entry.pluginId)
      )
      approvedInstalledPluginActivations = [
        ...approvedInstalledPluginActivations.filter(
          (entry) => !restoredIds.has(entry.pluginId)
        ),
        ...refreshed.activationCatalog,
      ]
      // Re-verified by the trust refresh: an earlier quarantine or revocation ends.
      for (const pluginId of restoredIds) agentToolsHost?.clearMark(pluginId)
    }
    const quarantined = new Set(
      decisions
        .filter((decision) => decision.action === 'quarantine')
        .map((decision) => decision.pluginId)
    )
    if (quarantined.size > 0) {
      approvedInstalledPluginActivations = approvedInstalledPluginActivations.filter(
        (entry) => !quarantined.has(entry.pluginId)
      )
      for (const decision of decisions) {
        if (decision.action === 'quarantine') {
          agentToolsHost?.mark(decision.pluginId, 'quarantined')
          console.warn(
            `[main] installed plugin quarantined after trust refresh: ${decision.pluginId}: ${decision.reason ?? 'trust verification failed'}`
          )
        }
      }
      void agentToolsHost?.refresh().catch(() => undefined)
    }
  } catch (error) {
    // The refresh controller re-evaluates cached trust before surfacing a
    // network/HTTP failure. Keep the backend activation catalog aligned with
    // any packages it quarantined during that fail-closed pass.
    const stillInstalled = new Set(
      frontendPluginManager.listInstalledPackages().map((pkg) => pkg.id)
    )
    approvedInstalledPluginActivations = approvedInstalledPluginActivations.filter((entry) =>
      stillInstalled.has(entry.pluginId)
    )
    console.warn(
      `[main] Registry trust refresh failed closed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
// Decision d5: after each Registry trust refresh, local installs are checked
// against the refreshed blocked digests; a security block leaves the backend
// catalog the way a takedown does.
async function revalidateLocalInstalls(): Promise<void> {
  try {
    const { quarantined } = await pluginTrustRefresh.revalidateLocalInstalls()
    if (quarantined.length === 0) return
    const ids = new Set(quarantined)
    approvedInstalledPluginActivations = approvedInstalledPluginActivations.filter((entry) => !ids.has(entry.pluginId))
    for (const pluginId of ids) {
      agentToolsHost?.mark(pluginId, 'quarantined')
      console.warn(`[main] local plugin quarantined: its file was taken down by Navide for a security reason: ${pluginId}`)
    }
    void agentToolsHost?.refresh().catch(() => undefined)
  } catch (error) {
    console.warn(`[main] local install revalidation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
// Update reminder: runs after each trust refresh settles, never inside it, so
// a failed check cannot touch trust state or quarantine decisions. Detection
// only — installing an update still goes through the consent dialogs.
const refreshInstalledPluginTrustAndUpdates = (): void => {
  void refreshTrustThenUpdates({
    refreshTrust: async () => {
      await refreshInstalledPluginTrust()
      await revalidateLocalInstalls()
    },
    checkUpdates: () => pluginTrustRefresh.checkUpdates(),
    publish: (updates) => {
      for (const hostWindow of mainWindows) {
        if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
        hostWindow.webContents.send('plugins:updatesChanged', updates)
      }
      // D-f: rescans that found new items, from the same check; notice only.
      publishRescanNotices({
        take: () => pluginTrustRefresh.takeRescanNotices(),
        restore: (notices) => pluginTrustRefresh.restoreRescanNotices(notices),
        send: (notices) => {
          let received = 0
          for (const hostWindow of mainWindows) {
            if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
            hostWindow.webContents.send('plugins:rescanNotices', notices)
            received += 1
          }
          return received
        },
      })
    },
    warn: (message) => console.warn(message),
  })
}
app.whenReady().then(() => {
  refreshInstalledPluginTrustAndUpdates()
  const timer = setInterval(refreshInstalledPluginTrustAndUpdates, 15 * 60 * 1000)
  timer.unref()
})
const approvedBackendPluginCatalog = () =>
  writeBackendPluginActivationCatalog(
    join(pluginsRoot(), '.navide-backend-activation.json'),
    projectBackendPluginActivationCatalog(approvedInstalledPluginActivations)
  )

// Storage usage & cleanup: clears only Electron-owned caches (Chromium HTTP/
// code/GPU caches, electron-updater downloads). Never user state.
registerStorageIpc()

// Keep the old bundle only as a fallback for a selected, verified v2 package.
// A missing factory package or a durable opt-out therefore leaves the editor
// unavailable and cannot silently re-enable the removed legacy surface.
const selectedMiniIdeV2 = hasValidMiniIdeV2Descriptor()
if (selectedMiniIdeV2) {
  const bundledMiniIde = registerBundledMiniIde(frontendPluginManager, miniIdeSource)
  if (!bundledMiniIde.registered) {
    console.warn(`[main] Mini-IDE recovery bundle unavailable: ${bundledMiniIde.reason}`)
  }
} else {
  console.warn('[main] Mini-IDE v2 contribution is unavailable')
}

const bundledPlans = registerBundledPlans(frontendPluginManager, {
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  artifactVersion: app.getVersion(),
  installedActivation: installedPluginLoad.activationCatalog.find(
    (entry) => entry.pluginId === 'navide.plans'
  ),
})
if (!bundledPlans.registered) {
  console.warn(`[main] bundled Plans unavailable: ${bundledPlans.reason}`)
}
const bundledPlansDescriptor = frontendPluginManager.getDescriptor('navide.plans')

/** Development-only evidence for the exact package selected by the Host.
 * The renderer has no authority to choose a package or report this identity. */
function logPlansDevProvenance(reason: 'startup' | 'open'): void {
  if (!plansDevProfile) return
  frontendPluginManager.setPlansDiagnosticsEnabled(true)
  const provenance = frontendPluginManager.getPlansProvenance()
  warnMain(
    `[main] navide.plans dev provenance (${reason}): ${JSON.stringify({ profile: plansDevProfile, ...provenance })}`,
  )
}

if (
  bundledPlansDescriptor?.capabilityPolicy?.kind === 'manifest-v2' &&
  bundledPlansDescriptor.packageVersion
) {
  plansRecoveryPackageVersion = bundledPlansDescriptor.packageVersion
}
const plansHasCompleteV2Package = Boolean(
  bundledPlans.registered &&
  hasCompletePlansContributions(bundledPlansDescriptor) &&
  bundledPlansDescriptor?.packageVersion &&
  bundledPlansDescriptor?.packageDir
)
/** Re-read on every retry: an installed Plans package can arrive or change
 *  after startup, so the startup snapshot above cannot decide a later retry. */
function plansHasCompleteV2PackageNow(): boolean {
  const descriptor = frontendPluginManager.getDescriptor('navide.plans')
  return Boolean(
    hasCompletePlansContributions(descriptor) &&
    descriptor?.packageVersion &&
    descriptor?.packageDir
  )
}
if (!plansHasCompleteV2Package) {
  plansRecoveryEnabled = true
  plansRecoveryReason ??= 'package-incomplete'
}
if (
  bundledPlansDescriptor?.capabilityPolicy?.kind === 'manifest-v2' &&
  bundledPlansDescriptor.packageVersion
) {
  // The grant store writes synchronously to userData; a read-only, full or
  // EPERM directory throws here. Left unguarded this aborts module evaluation
  // before any IPC handler below registers, so the whole App comes up dead.
  // Same precedent as the factory Git grant write (factoryGitStartup.ts): an
  // unpersistable grant leaves v2 unusable, so fall back to legacy recovery
  // and log it rather than taking startup down with it.
  try {
    pluginCapabilityGrants.set('navide.plans', {
      packageVersion: bundledPlansDescriptor.packageVersion,
      system: [...bundledPlansDescriptor.capabilityPolicy.system],
      ...(bundledPlansDescriptor.capabilityPolicy.shell
        ? { shell: bundledPlansDescriptor.capabilityPolicy.shell }
        : {}),
      storage: true,
    })
  } catch (error) {
    plansRecoveryEnabled = true
    plansRecoveryReason ??= 'grant-persist-failure'
    warnMain(
      `[main] navide.plans capability grant could not be persisted; using legacy recovery: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (plansRecoveryEnabled) {
    frontendPluginManager.markPlansBackendUnavailable('package-recovery')
    warnMain(
      `[main] Plans v2 package is unavailable; using legacy recovery${
        plansRecoveryForced ? ' (NAVIDE_PLANS_RECOVERY=legacy)' : ''
      }`,
    )
  }
}
logPlansDevProvenance('startup')

// Plans used to stay in recovery for the rest of the session with no way back
// but a restart: nothing ever sent `legacy: false`. Opening the Plans tab is
// the user's natural retry, and the panel offers it explicitly, so spend a
// small budget of v2 attempts before the session settles on the legacy pane.
const PLANS_V2_RECOVERY_RETRIES = 2
let plansV2RetriesLeft = PLANS_V2_RECOVERY_RETRIES
function retryPlansV2AfterRecovery(): { ok: boolean; reason?: string } {
  const decision = decidePlansV2Retry({
    recoveryEnabled: plansRecoveryEnabled,
    forced: plansRecoveryForced,
    hasCompleteV2Package: plansHasCompleteV2PackageNow(),
    retriesLeft: plansV2RetriesLeft,
  })
  if (decision.outcome === 'not-in-recovery') return { ok: true }
  if (decision.outcome === 'refused') return { ok: false, reason: decision.reason }
  // Unlike Git there is nothing to re-activate here: the package stayed
  // registered, only its availability bit was withdrawn. Re-arming it lets the
  // next Plans open spawn the child again — which is also why the attempt
  // costs budget up front, since success is not knowable at this point.
  frontendPluginManager.clearPlansBackendUnavailable()
  plansV2RetriesLeft -= 1
  plansRecoveryEnabled = false
  plansRecoveryReason = null
  for (const hostWindow of mainWindows) {
    if (hostWindow.isDestroyed() || detachedWindowIds.has(hostWindow.id)) continue
    hostWindow.webContents.send('plugins:contributionsChanged')
    hostWindow.webContents.send('plans:recoveryChanged', { legacy: false })
  }
  warnMain(`[main] navide.plans v2 re-armed after legacy recovery; ${plansV2RetriesLeft} retry left`)
  return { ok: true }
}
ipcMain.handle('plans:retryV2', (event) => {
  if (!isTrustedPluginManagementSender(event, mainWindows)) return { ok: false, reason: 'untrusted sender' }
  if (refuseDisabledBuiltin('navide.plans', null, false)) return { ok: false, reason: builtinPluginDisabledMessage('navide.plans') }
  return retryPlansV2AfterRecovery()
})

// Full info (wsUrl carries the ws token) for Navide windows only; a plugin
// frame or view, a webview or any other window learns just the status.
ipcMain.handle('backend:info', (event) =>
  backendInfoFor(event, [mainWindows, navideAuxWindows], backendInfoPayload())
)
// Signs one ws connection's window challenge, for a main window only.
ipcMain.handle('backend:proveWindow', (event, nonce: unknown) =>
  answerWindowChallenge(event, nonce, mainWindows, backend?.hostSessionToken ?? null)
)

// A backend that dies after a successful start must not keep reporting
// 'ready' with a dead port: watch its exit and, if it is still the active
// handle (deliberate stop/restart/quit paths clear `backend` BEFORE killing
// the process, so those exits are ignored), respawn it within a bounded
// budget. Only once that budget is spent does the terminal 'error' state and
// the existing Retry UI take over, so an unrecoverable backend is still
// visible rather than respawning forever.
function watchBackendCrash(b: BackendHandle): void {
  watchBackendExit(b.proc, () => backend === b, (message) => {
    errorMain(`[main] ${message}`)
    recordMainFault('backend.crash', message, backendDataDir(process.env))
    backend = null
    const attempt = backendAutoRestart.onCrash()
    if (attempt === null) {
      backendRestartPending = null
      backendLastError = message
    } else {
      const max = backendAutoRestart.maxAttempts()
      backendRestartPending = { attempt, max, reason: message }
      infoMain(`[main] backend auto-restart scheduled (attempt ${attempt}/${max})`)
    }
    broadcastBackendChanged()
  })
}

/** A renderer that died, for the on-disk error ledger the backend owns. */
function recordRendererGone(line: string): void {
  recordMainFault('renderer.gone', line, backendDataDir(process.env))
}

setMainLedgerDataDir(backendDataDir(process.env))

// An exception main never caught reached only stderr, which a packaged launch
// discards. The monitor records it without changing what happens next:
// Electron's own handling still runs.
process.on('uncaughtExceptionMonitor', (err, origin) => {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  logMain(`[main] uncaught exception (${origin}): ${text}`)
  recordMainFault('main.uncaught', `${origin}: ${text}`, backendDataDir(process.env))
})

// Serialize lifecycle ops so a double-click can't spawn two backends or race a
// stop against a start.
let backendBusy = false

// Set once the bounded respawn budget below is spent: this run really did fail
// to keep a backend alive, so nothing about it may vindicate the workspaces it
// restored. Read by markCleanExitAndSettleRestores().
let backendGaveUp = false

// Bounded respawn of a crashed backend (see backend-autorestart.ts for why it
// is bounded and why a stability window guards the reset).
const backendAutoRestart = createBackendAutoRestart({
  restart: () => { void autoRestartBackend() },
  onGiveUp: (attempts) => {
    backendGaveUp = true
    errorMain(`[main] backend auto-restart gave up after ${attempts} attempts`)
    recordMainFault('backend.gave_up', `auto-restart gave up after ${attempts} attempts`, backendDataDir(process.env))
  },
  // A backend that survived the stability window vindicates whatever
  // workspaces this launch restored — pay back their attempt charges.
  onStable: () => { windowRegistry.clearRestoreFailures() },
})

/** Mark a clean exit and, with it, pay back whatever restore attempts this run
 *  charged.
 *
 *  beginRestore() charges every restored workspace up front and only the 60s
 *  stability window pays it back, so three sessions that ended before that
 *  window elapsed — an update test, a quick relaunch, a glance at the app and
 *  a quit — burned a workspace's whole budget and got it silently skipped from
 *  then on, without a single one of them being a restore that broke anything.
 *
 *  Reaching a clean exit proves the same thing surviving the stability window
 *  proves: the app came up and it was the user who ended it. The one exception
 *  is a run where the auto-restart budget ran out — that run genuinely failed
 *  to hold a backend, so its charges stand. */
function markCleanExitAndSettleRestores(): void {
  windowRegistry.markCleanExit()
  if (!backendGaveUp) windowRegistry.clearRestoreFailures()
}

/** One scheduled respawn attempt. A deliberate restart/stop already in flight
 *  wins: it either brings a backend up itself or intends none to be running. */
async function autoRestartBackend(): Promise<void> {
  if (backend || backendBusy) {
    // Something else owns the lifecycle right now — it either already brought a
    // backend up or is about to. Either way no respawn is due, so drop the
    // pending marker: leaving it set would report `starting` forever, with no
    // backend, no timer and no terminal error to escape it.
    backendRestartPending = null
    broadcastBackendChanged()
    return
  }
  const epoch = backendLifecycleEpoch
  backendBusy = true
  // Publish the in-flight spawn so the quit path can see it. Without this,
  // `backend` and `backendStarting` are both null while this awaits, so
  // before-quit takes its early return and the child we are spawning is
  // orphaned — reparented, still holding the port and the shared app-data
  // state for the next launch to fight over.
  let settle = (): void => {}
  const inFlight = new Promise<void>((resolve) => { settle = resolve })
  backendStarting = inFlight
  try {
    // Pass the approved catalog like every other spawn: without it startBackend
    // overwrites the on-disk catalog with an empty one.
    const started = await startBackend(
      readHealthCheckTimeoutSec(healthTimeoutPath()) * 1000,
      approvedBackendPluginCatalog()
    )
    if (epoch !== backendLifecycleEpoch) {
      // A stop/restart/quit landed while this was spawning. What the user asked
      // for wins; this process must not become the live backend, and must not
      // be left running either.
      backendRestartPending = null
      infoMain('[main] discarding auto-restarted backend: superseded by a deliberate lifecycle op')
      await started.stop()
      return
    }
    backend = started
    frontendPluginManager.setTerminalShell(started.shell)
    backendLastError = null
    backendRestartPending = null
    watchBackendCrash(backend)
    backendAutoRestart.onHealthy()
    infoMain(`[main] backend auto-restarted at ${backend.host}:${backend.port}`)
  } catch (err) {
    // A failed attempt spends budget the same way a crash does; when the
    // budget is gone the error becomes terminal.
    errorMain('[main] backend auto-restart failed', err)
    backend = null
    if (epoch !== backendLifecycleEpoch) {
      backendRestartPending = null
    } else {
      const attempt = backendAutoRestart.onCrash()
      if (attempt === null) {
        backendRestartPending = null
        backendLastError = String(err)
      } else {
        backendRestartPending = { attempt, max: backendAutoRestart.maxAttempts(), reason: String(err) }
      }
    }
  } finally {
    backendBusy = false
    settle()
    // Only clear our own marker: the quit path may have already replaced it.
    if (backendStarting === inFlight) backendStarting = null
    broadcastBackendChanged()
  }
}

// Same payload as backend:info, so the same scoping: full only for Navide windows.
ipcMain.handle('backend:restart', async (event) =>
  backendInfoFor(event, [mainWindows, navideAuxWindows], await restartBackendNow())
)

/** A deliberate restart: the Settings button, and a quit cancelled after its
 *  teardown stopped the backend. */
async function restartBackendNow(): Promise<ReturnType<typeof backendInfoPayload>> {
  // Supersede the automatic budget BEFORE the busy guard. An auto-restart can
  // hold `backendBusy` for a full health-check timeout (45 s by default), and
  // bailing out first would leave its schedule armed and its in-flight spawn
  // free to become the live backend — the user's intent silently discarded.
  backendLifecycleEpoch++
  backendAutoRestart.cancel()
  backendRestartPending = null
  if (backendBusy) return backendInfoPayload()
  backendBusy = true
  try {
    // A restart during the initial spawn must not double-spawn: wait for the
    // in-flight start to settle first (its promise never rejects) so the
    // handle it produces lands in `backend` and is stopped below instead of
    // being orphaned when overwritten.
    if (backendStarting) {
      await backendStarting
      backendStarting = null
    }
    if (backend) {
      const b = backend
      backend = null
      await b.stop()
    }
    try {
      backend = await startBackend(
        readHealthCheckTimeoutSec(healthTimeoutPath()) * 1000,
        approvedBackendPluginCatalog()
      )
      frontendPluginManager.setTerminalShell(backend.shell)
      backendLastError = null
      watchBackendCrash(backend)
      infoMain(`[main] backend restarted at ${backend.host}:${backend.port}`)
    } catch (err) {
      errorMain('[main] backend restart failed', err)
      backend = null
      backendLastError = String(err)
    }
    broadcastBackendChanged()
    return backendInfoPayload()
  } finally {
    backendBusy = false
    // A crash can land inside the awaits above (the pre-restart handle dying),
    // re-arming the automatic budget behind the user's back. Clearing again on
    // the way out keeps "manual intervention wins" true for the whole handler,
    // not just its first statement — otherwise a failed manual restart reports
    // `starting` with a phantom attempt badge instead of a terminal error.
    backendAutoRestart.cancel()
    backendRestartPending = null
  }
}

ipcMain.handle('backend:stop', async () => {
  // Cancel BEFORE the busy guard, for the reason spelled out in backend:restart:
  // an auto-restart holding the lock would otherwise outlive the very stop that
  // was meant to end it, and hand the user a running backend they just asked to
  // shut down. Bumping the epoch also disowns its in-flight spawn, which stops
  // itself on arrival.
  backendLifecycleEpoch++
  backendAutoRestart.cancel()
  backendRestartPending = null
  if (backendBusy) return { ok: false }
  backendBusy = true
  try {
    if (backend) {
      const b = backend
      backend = null
      await b.stop()
    }
    broadcastBackendChanged()
    return { ok: true }
  } finally {
    backendBusy = false
  }
})

async function pickWorkspacePath(defaultPath?: string): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = {
    title: menuStringsFor(currentUiLocale()).pickWorkspace,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: menuStringsFor(currentUiLocale()).useFolder
  }
  if (defaultPath && typeof defaultPath === 'string') opts.defaultPath = defaultPath

  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts)

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

ipcMain.handle('workspace:pick', (_event, defaultPath?: string) => pickWorkspacePath(defaultPath))

ipcMain.handle('workspace:new', async (): Promise<NewWorkspaceResult> => {
  // A save dialog rather than a directory picker: it is the one native dialog
  // that asks for a location and a name at once, so the user names the
  // workspace in the same step that places it. `defaultPath` seeds both — the
  // home directory and an editable placeholder name.
  const opts: Electron.SaveDialogOptions = {
    title: menuStringsFor(currentUiLocale()).createWorkspace,
    defaultPath: join(app.getPath('home'), 'navide-workspace'),
    nameFieldLabel: menuStringsFor(currentUiLocale()).workspaceName,
    buttonLabel: menuStringsFor(currentUiLocale()).create,
    // `showOverwriteConfirmation` is Linux-only and deliberately left off:
    // nothing here overwrites, so asking "replace it?" would promise something
    // the mkdir below refuses to do. macOS and Windows ask anyway and cannot
    // be talked out of it — their panel returns the path without deleting
    // anything, mkdir then fails EEXIST, so that message stays worded for an
    // "item" rather than a folder: what the name is taken by may be a file.
    properties: ['createDirectory']
  }

  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, opts)
    : await dialog.showSaveDialog(opts)

  if (result.canceled || !result.filePath) return { ok: false, reason: 'canceled' }

  const created = await createWorkspaceFolder(result.filePath)
  if (!created.ok) console.error('[workspace:new] failed to create', created.path, created.detail)
  return created
})

ipcMain.handle('app:home-dir', () => app.getPath('home'))

/**
 * Read the current UI theme id from the backend-owned ui_settings.json ('' when
 * unset/unreadable). Store values are JSON-encoded strings (lib/settings keeps
 * the legacy localStorage encoding), so the raw value needs a second parse.
 */
function readUiSettings(): Record<string, unknown> {
  try {
    const dataDir = resolveBackendDataDir({
      envOverride: process.env.AGENT_TEAM_DATA_DIR,
      isPackaged: app.isPackaged,
      appDataPath: app.getPath('appData'),
      platform: process.platform,
      homeDir: app.getPath('home'),
      xdgDataHome: process.env.XDG_DATA_HOME,
      appData: process.env.APPDATA
    })
    return JSON.parse(readUiSettingsText(join(dataDir, UI_SETTINGS_FILE))) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** One ui_settings value, decoded. Returns null when absent or malformed. */
function uiSetting<T>(settings: Record<string, unknown>, key: string): T | null {
  const raw = settings[key]
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

const hostLocaleManager = new HostLocaleManager(
  () => readPersistedLocaleFromSettings(readUiSettings()),
  () => {
    try {
      return app.getLocale()
    } catch {
      return process.env.LANG ?? null
    }
  },
)

function currentUiTheme(): string {
  const theme = uiSetting<string>(readUiSettings(), 'agent-team:theme')
  return typeof theme === 'string' ? theme : ''
}

// Returns the narrow union, not `string`: the native menu indexes its string
// table by it. Every other caller takes a string and is unaffected.
function currentUiLocale(): SupportedLocale {
  return hostLocaleManager.getLocale()
}

// Interface scale. Created lazily because readUiSettings() needs app paths,
// which are only valid after 'ready' — the first WebContents (and therefore the
// first read) always happens later than that.
let uiZoomStoreRef: UiZoomStore | null = null
function uiZoomStore(): UiZoomStore {
  if (!uiZoomStoreRef) {
    uiZoomStoreRef = createUiZoomStore(initialUiScaleFrom(readUiSettings()))
  }
  return uiZoomStoreRef
}

/** Read-only Host values bootstrapped into each Git v2 view's entry query.
 *  They are deliberately encoded in the same shapes the settings facade uses:
 *  yolo/analyzer are plain strings, while theme customizations remain JSON. */
function currentGitReadOnlyQuery(): Record<string, string> {
  const settings = readUiSettings()
  const yolo = uiSetting<string>(settings, 'agentTeam.yolo')
  const analyzerModel = uiSetting<string>(settings, 'agentTeam.analyzerModel')
  const themeCustom = uiSetting<Record<string, string>>(settings, 'agent-team:theme-custom')
  return {
    git_yolo: yolo === '0' ? '0' : '1',
    git_analyzer_model: typeof analyzerModel === 'string' ? analyzerModel : '',
    git_theme_custom: JSON.stringify(themeCustom ?? {}),
  }
}

let gitStorageMigrationInFlight: { packageVersion: string; promise: Promise<void> } | null = null
let miniIdeStorageAvailability: MiniIdeStorageAvailability | null = null
let miniIdeStoragePackageVersion: string | null = null
function clearMiniIdeLegacyPreferenceOverlay(): void {
  frontendPluginManager.setMiniIdeLegacyPreferences(null)
}
function installMiniIdeLegacyPreferenceOverlay(packageVersion: string): boolean {
  const snapshot = miniIdeStorageAvailability?.status === 'ready' && miniIdeStoragePackageVersion === packageVersion
    ? { pluginId: MINI_IDE_PLUGIN_ID, packageVersion, tier: 'active' as const }
    : miniIdeStorageAvailability?.status === 'recovery' && miniIdeStoragePackageVersion === packageVersion
      ? miniIdeStorageLifecycle.sourceFor(packageVersion)
      : null
  if (!snapshot) return false
  frontendPluginManager.setMiniIdeLegacyPreferences(
    createMiniIdeLegacyPreferences(pluginStorageStore, snapshot),
  )
  return true
}
const ensureMiniIdeStorage = createMiniIdeStorageMigrationGate({
  store: pluginStorageStore,
  lifecycle: miniIdeStorageLifecycle,
  readLegacySettings: readUiSettings,
  onReady: (packageVersion, previousPackageVersion) => {
    miniIdeStoragePackageVersion = packageVersion
    frontendPluginManager.setMiniIdeStorageSnapshotContext(packageVersion, previousPackageVersion)
    clearMiniIdeLegacyPreferenceOverlay()
  },
})

async function migrateGitStorage(): Promise<void> {
  const descriptor = frontendPluginManager.getDescriptor('navide.git')
  const packageVersion = descriptor?.packageVersion
  if (!packageVersion) return
  if (gitStorageMigrationInFlight?.packageVersion === packageVersion) {
    return gitStorageMigrationInFlight.promise
  }
  const promise = (async () => {
    const migration = await migrateBundledGitPreferences(pluginStorageStore, {
      packageVersion,
      sourceSnapshot: gitStorageLifecycle.sourceFor(packageVersion),
      legacySettings: readUiSettings(),
    })
    if (migration.completed) gitStorageLifecycle.rememberActive(packageVersion)
  })()
  gitStorageMigrationInFlight = { packageVersion, promise }
  try {
    await promise
  } finally {
    if (gitStorageMigrationInFlight?.promise === promise) gitStorageMigrationInFlight = null
  }
}

let plansStorageAvailability: PlansStorageAvailability | null = null
const ensurePlansStorage = createPlansStorageMigrationGate({
  store: pluginStorageStore,
  lifecycle: plansStorageLifecycle,
  onReady: (packageVersion, previousPackageVersion) => {
    frontendPluginManager.setPlansStorageSnapshotContext(packageVersion, previousPackageVersion)
  },
  onFailure: (packageVersion, reason, availability) => {
    plansStorageAvailability = availability
    plansRecoveryPackageVersion = packageVersion
    warnMain(`[plans] storage unavailable: ${reason}`)
    enterPlansRecovery('storage-migration-failure')
  },
})
const plansLegacyRecoveryCache = new Map<string, PlansLegacyRecoveryBootstrap | null>()
const plansLegacyRecoveryInFlight = new Map<
  string,
  Promise<PlansLegacyRecoveryBootstrap | null>
>()

/** Bind the actual retained legacy Plans adapter to the lifecycle-selected
 * previous snapshot. The returned projection is cached by Host workspace and
 * package identity; no renderer-supplied identity participates in selection. */
async function getPlansLegacyRecoveryBootstrap(
  workspacePath: string,
): Promise<PlansLegacyRecoveryBootstrap | null> {
  const packageVersion = plansRecoveryPackageVersion
  if (!plansRecoveryEnabled || !packageVersion || !workspacePath) return null
  const storageWorkspacePath = resolvePlansRootPath(workspacePath)
  const workspaceId = frontendPluginManager.workspaceIdForPath(storageWorkspacePath)
  if (!workspaceId) return null
  const cacheKey = `${packageVersion}\u0000${workspaceId}`
  if (plansLegacyRecoveryCache.has(cacheKey)) {
    return plansLegacyRecoveryCache.get(cacheKey) ?? null
  }
  const existing = plansLegacyRecoveryInFlight.get(cacheKey)
  if (existing) return existing

  const promise = runPlansLegacyRecovery(pluginStorageStore, plansStorageLifecycle, {
    currentPackageVersion: packageVersion,
    workspaceId,
    adapter: retainedPlansLegacyAdapter,
  })
    .then((recovered) => recovered?.result ?? null)
    .catch((error: unknown) => {
      warnMain(
        `[main] retained Plans recovery adapter unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      return null
    })
  const cachedPromise = promise.then((result) => {
    plansLegacyRecoveryCache.set(cacheKey, result)
    return result
  })
  plansLegacyRecoveryInFlight.set(cacheKey, cachedPromise)
  try {
    return await cachedPromise
  } finally {
    if (plansLegacyRecoveryInFlight.get(cacheKey) === cachedPromise) {
      plansLegacyRecoveryInFlight.delete(cacheKey)
    }
  }
}

async function migratePlansStorageState(): Promise<PlansStorageAvailability> {
  if (plansRecoveryEnabled) return plansStorageAvailability ?? { status: 'recovery' }
  const descriptor = frontendPluginManager.getDescriptor('navide.plans')
  const packageVersion = descriptor?.packageVersion
  if (descriptor?.capabilityPolicy?.kind !== 'manifest-v2' || !packageVersion) return { status: 'unavailable' }
  const availability = await ensurePlansStorage(packageVersion)
  return plansRecoveryEnabled && availability.status === 'ready' ? { status: 'recovery' } : availability
}

/** Operator entry point for a Plans lifecycle record the Host refuses to read.
 * Legacy recovery is where the user already meets a broken Plans install, so
 * the recovery panel offers the repair there; it is never run for them, because
 * discarding the record gives up the upgrade source. The session stays in
 * recovery afterwards — nothing here can re-bind the withdrawn v2 backend — so
 * the panel tells the user to restart. */
async function runPlansStorageRecordRepair(): Promise<PlansStorageRepairResult> {
  const descriptor = frontendPluginManager.getDescriptor('navide.plans')
  const packageVersion = descriptor?.capabilityPolicy?.kind === 'manifest-v2'
    ? descriptor.packageVersion ?? null
    : null
  const result = await repairPlansStorageRecord({
    lifecycle: plansStorageLifecycle,
    packageVersion,
    // Drive the gate directly: migratePlansStorageState() short-circuits while
    // the session sits in recovery, and the repair has to rebuild the durable
    // record now rather than at the next launch.
    ensureStorage: async (version) => {
      const availability = await ensurePlansStorage(version)
      plansStorageAvailability = availability
      return availability
    },
  })
  if (result.repaired) {
    warnMain(`[plans] unreadable lifecycle record discarded on request; storage ok=${result.ok}`)
  }
  return result
}
ipcMain.handle('plans:repairStorageRecord', (event): Promise<PlansStorageRepairResult> | PlansStorageRepairResult => {
  if (!isTrustedPluginManagementSender(event, mainWindows)) {
    return { ok: false, repaired: false, reason: 'untrusted sender' }
  }
  return runPlansStorageRecordRepair()
})

/**
 * The legacy Plans renderer is the only trusted process that can see the old
 * renderer-origin localStorage. It sends only the fixed projection; the Host
 * validates and writes the workspace partition here.
 */
async function projectPlansLegacyPreferences(
  workspacePath: string,
  values: LegacyPlansPreferenceProjection,
): Promise<{ ok: boolean; error?: string }> {
  const descriptor = frontendPluginManager.getDescriptor('navide.plans')
  const packageVersion = descriptor?.packageVersion
  // The v2 view's storage partition is runtimeBinding.workspaceId, which
  // plansCapabilityContext derives from the registered workspace as-is - not
  // from the repository root its documents live under. Hash the same string,
  // or the preferences land in a partition nothing reads.
  const workspaceId = frontendPluginManager.workspaceIdForPath(workspacePath)
  if (
    descriptor?.capabilityPolicy?.kind !== 'manifest-v2' ||
    !packageVersion ||
    !workspaceId
  ) return { ok: false, error: 'Plans v2 storage is unavailable.' }

  const availability = await migratePlansStorageState()
  if (availability.status !== 'ready' || !frontendPluginManager.isPlansBackendAvailable()) {
    return { ok: false, error: 'Plans v2 storage is unavailable.' }
  }
  const result = await projectLegacyPlansPreferences(pluginStorageStore, {
    packageVersion,
    workspaceId,
    values,
  })
  return result.completed
    ? { ok: true }
    : { ok: false, error: 'Plans preferences could not be migrated.' }
}

async function prepareCatalogContribution(contributionKey: string): Promise<boolean> {
  if (contributionKey.startsWith('navide.plans.')) {
    return (await migratePlansStorageState()).status === 'ready'
  }
  if (contributionKey === MINI_IDE_CONTRIBUTION) {
    const descriptor = frontendPluginManager.getDescriptor(MINI_IDE_PLUGIN_ID)
    const packageVersion = descriptor?.packageVersion
    if (!hasValidMiniIdeV2Descriptor(descriptor) || !packageVersion) {
      miniIdeStorageAvailability = { status: 'unavailable' }
      miniIdeStoragePackageVersion = packageVersion ?? null
      return false
    }
    miniIdeStorageAvailability = await ensureMiniIdeStorage(packageVersion)
    miniIdeStoragePackageVersion = packageVersion
    return miniIdeStorageAvailability.status === 'ready'
  }
  if (!contributionKey.startsWith('navide.git.')) return true
  const descriptor = frontendPluginManager.getDescriptor('navide.git')
  if (
    descriptor?.packageVersion &&
    pluginCapabilityGrants.get(descriptor.id, descriptor.packageVersion)
  ) {
    await migrateGitStorage()
  }
  return true
}

// Warm the candidate/active boundary at startup. Opening Plans awaits the
// same promise through migratePlansStorageState, so a first click cannot race
// snapshot promotion.
frontendPluginManager.setPlansStorageReadinessHandler(async (packageVersion) => {
  if (frontendPluginManager.getDescriptor('navide.plans')?.packageVersion !== packageVersion) return false
  return (await migratePlansStorageState()).status === 'ready'
})
/** Run that warm-up. Deferred out of module scope to the app-ready block below
 * (after the backend start has settled): it clones, re-reads and fsyncs one
 * storage partition per workspace Plans has ever been opened in, and at module
 * scope that filesystem burst ran on the libuv threadpool alongside
 * startBackend's login-shell PATH probe — the contention shape behind spurious
 * "Backend failed to start" timeouts. Nothing reads Plans storage without
 * awaiting the same gate through migratePlansStorageState(), so deferring only
 * removes the head start, not the guarantee. */
function warmPlansStorage(): void {
  void migratePlansStorageState().catch((error: unknown) => {
    plansStorageAvailability = { status: 'unavailable' }
    enterPlansRecovery('storage-migration-failure')
    warnMain(`[plans] storage initialization failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

const DEFAULT_EDITOR_SETTING_KEY = 'agentTeam.defaultEditor'
const DEFAULT_EDITOR_COMMAND_KEY = 'agentTeam.defaultEditor.customCommand'

/** The user's default-editor preference, read fresh per open. Settings changes
 *  reach main through the backend's ui_settings.json mirror (written on every
 *  set), so there is no cache to invalidate and no IPC to keep in sync. */
function currentEditorPreference(): EditorPreference {
  const settings = readUiSettings()
  const rawCommand = uiSetting<unknown>(settings, DEFAULT_EDITOR_COMMAND_KEY)
  const customCommand = Array.isArray(rawCommand)
    ? rawCommand.filter((part): part is string => typeof part === 'string')
    : []
  const editorId = normalizeEditorId(
    uiSetting<string>(settings, DEFAULT_EDITOR_SETTING_KEY),
    customCommand
  )
  return { editorId, customCommand }
}

// Editor detection is filesystem work over every PATH entry; cache it and let
// Settings force a rescan after the user installs something.
let detectedEditorsCache: DetectedEditor[] | null = null

function currentDetectedEditors(refresh = false): DetectedEditor[] {
  if (refresh || !detectedEditorsCache) {
    detectedEditorsCache = detectEditors(getResolvedUserPath())
  }
  return detectedEditorsCache
}

// An external editor that cannot be launched falls back to the mini-IDE, which
// on its own looks like the setting was ignored. Warn once per editor id per
// session: enough to explain it, not so much that every click nags.
const warnedEditorIds = new Set<string>()

function warnEditorUnavailable(target: BrowserWindow | null, editorId: string): void {
  if (warnedEditorIds.has(editorId)) return
  warnedEditorIds.add(editorId)
  const win = target && !target.isDestroyed() ? target : mainWindow
  if (!win || win.isDestroyed()) return
  void dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Editor unavailable',
    message: `Could not open your default editor (${editorId})`,
    detail:
      'Navide opened the file in the Mini-IDE instead. Check Settings → General → Default editor: ' +
      'the editor may not be installed, or its command may have moved.',
  })
}

/**
 * Spawn an external editor. Resolves false when the process could not start or
 * died with a non-zero status right away — the caller then falls back.
 *
 * argv is passed as an array and never through a shell, so a path containing
 * spaces or shell metacharacters stays a single argument. The one exception
 * is a `.cmd`/`.bat` on Windows — the shape `code` and `cursor` take there —
 * which Node will only start through cmd.exe; each element is then quoted
 * for that command line first. PATH is the login-shell one the backend
 * resolved: the PATH Electron inherits when launched from Finder omits
 * Homebrew and friends.
 */
function launchExternalEditor(argv: string[], cwd?: string): Promise<boolean> {
  const [command, ...args] = argv
  if (!command) return Promise.resolve(false)
  const viaShell = needsWindowsShell(command)
  return launchEditorProcess(() =>
    spawn(viaShell ? quoteForCmd(command) : command, viaShell ? args.map(quoteForCmd) : args, {
      ...(cwd ? { cwd } : {}),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: getResolvedUserPath() },
      // windowsHide keeps the intermediate cmd.exe from flashing a console;
      // the editor window it starts is not affected.
      ...(viaShell ? { shell: true, windowsHide: true } : {})
    })
  )
}

/**
 * Route one editor-open request: the mini-IDE (default, and the only surface
 * that can serve diff/sidebar/bare opens), the OS default application, or the
 * external editor the user chose. Any failure past the decision point falls
 * back to the mini-IDE, so an open never silently does nothing.
 */
async function routeEditorOpen(
  host: BrowserWindow | null,
  params: Record<string, string>
): Promise<boolean> {
  if (classifyEditorOpen(params) === 'diff') return openGitDiffRequest(host, params)
  const preference = currentEditorPreference()
  const route = classifyOpenRequest(params, preference)
  if (route.via === 'mini-ide') return openMiniIdeEditor(host, params)

  const workspacePath = params.workspace_path ?? ''
  // `file_ws` (an out-of-workspace file's own root) is what `filepath` is
  // relative to when present — the same containment rule as the fallback path.
  const abs = resolveExternalOpenTarget(params.file_ws || workspacePath, params.filepath ?? '')
  if (!abs) return openMiniIdeEditor(host, params)

  if (route.via === 'system') {
    // shell.openPath returns '' on success, or an error message.
    const err = await shell.openPath(abs)
    if (!err) return true
    return openMiniIdeEditor(host, params)
  }

  const parsedLine = Number.parseInt(params.line ?? '', 10)
  const argv = buildEditorArgv(route.editorId, currentDetectedEditors(), preference.customCommand, {
    file: abs,
    line: Number.isFinite(parsedLine) ? parsedLine : undefined,
    workspace: workspacePath
  })
  if (argv && (await launchExternalEditor(argv))) return true
  warnEditorUnavailable(host, route.editorId)
  return openMiniIdeEditor(host, params)
}

/**
 * Open a folder in an editor: the id the caller asked for ("Open with…"), or
 * the user's default. `mini-ide` reopens the mini-IDE against that folder as
 * its workspace root; everything else hands the directory to the editor.
 */
async function openFolderInEditor(
  host: BrowserWindow | null,
  dir: string,
  editorId?: string
): Promise<boolean> {
  if (!dir || !existsSync(dir)) return false
  const preference = currentEditorPreference()
  const id = editorId
    ? normalizeEditorId(editorId, preference.customCommand)
    : preference.editorId
  if (id === DEFAULT_EDITOR_ID) return openMiniIdeEditor(host, { workspace_path: dir })
  if (id === 'system') {
    const err = await shell.openPath(dir)
    if (!err) return true
    warnEditorUnavailable(host, id)
    return false
  }
  const argv = buildEditorArgv(id, currentDetectedEditors(), preference.customCommand, {
    dir,
    workspace: dir
  })
  if (argv && (await launchExternalEditor(argv, dir))) return true
  warnEditorUnavailable(host, id)
  return false
}

/**
 * Open the declared Mini-IDE v2 window contribution in its dedicated window,
 * forwarding editor open params (`filepath`/`file_ws`/`line`/`sidebar`/`diff_*`/
 * `branch_diff_*`) as the entry query EditorWindowApp reads from
 * `window.location.search`; the Host keeps all extra targets intact and mints
 * a trusted external-file grant when one is needed.
 */
type TrustedEditorFileTarget = {
  path: string
  expectedCanonicalPath?: string
  workspaceOnly?: boolean
}

function isTrustedEditorFileTargetCurrent(target: TrustedEditorFileTarget): boolean {
  if (target.expectedCanonicalPath === undefined) return true
  try {
    return statSync(target.path).isFile() && realpathSync(target.path) === target.expectedCanonicalPath
  } catch {
    return false
  }
}

async function openMiniIdeEditor(
  host: BrowserWindow | null,
  params: Record<string, string>,
  canDispatch: () => boolean = () => true,
  trustedEditorFileTarget?: TrustedEditorFileTarget,
): Promise<boolean> {
  if (!canDispatch()) return false
  if (trustedEditorFileTarget && !isTrustedEditorFileTargetCurrent(trustedEditorFileTarget)) return false
  if (refuseDisabledBuiltin(MINI_IDE_PLUGIN_ID, host)) return false
  const { workspace_path: workspacePath = '', ...extraParams } = params
  if (miniIdeRecoveryEnabled) {
    const httpUrl = backend ? `http://${backend.host}:${backend.port}` : ''
    if (await openMiniIdePluginView(workspacePath, httpUrl, extraParams, currentUiTheme(), {
      canDispatch,
      trustedEditorFileTarget,
      workspaceDisplayName: await frontendPluginManager.peekWorkspaceDisplayName(workspacePath),
    })) return true
  }
  const targetPath = extraParams.filepath
    ? resolveExternalOpenTarget(extraParams.file_ws || workspacePath, extraParams.filepath)
    : null
  const result = await openCatalogContributionWindow(
    MINI_IDE_CONTRIBUTION,
    workspacePath,
    extraParams,
    trustedEditorFileTarget ?? (targetPath ? { path: targetPath } : undefined),
    canDispatch,
  )
  if (result.ok) return true
  if (!canDispatch()) return false
  if (trustedEditorFileTarget && !isTrustedEditorFileTargetCurrent(trustedEditorFileTarget)) return false

  // An installed v2 package may have failed after selection. Its legacy copy
  // is a guarded recovery path; it is never used for a missing or opted-out
  // IDE, and storage migration failures remain unavailable until repaired.
  if (
    result.error !== 'mini-ide storage unavailable' &&
    !pluginFactoryOptOuts.has(MINI_IDE_PLUGIN_ID) &&
    hasValidMiniIdeV2Descriptor() &&
    frontendPluginManager.listInstalledPackages().some((pkg) => pkg.id === MINI_IDE_PLUGIN_ID) &&
    pluginCapabilityGrants.get(
      MINI_IDE_PLUGIN_ID,
      frontendPluginManager.getDescriptor(MINI_IDE_PLUGIN_ID)?.packageVersion ?? '',
    ) !== null
  ) {
    const packageVersion = frontendPluginManager.getDescriptor(MINI_IDE_PLUGIN_ID)?.packageVersion
    const overlayReady = Boolean(packageVersion && installMiniIdeLegacyPreferenceOverlay(packageVersion))
    const recovery = overlayReady
      ? activateInstalledMiniIdeRecovery(frontendPluginManager, miniIdeSource)
      : { registered: false, reason: 'no trusted Mini-IDE storage snapshot is available' }
    if (recovery.registered) {
      miniIdeRecoveryEnabled = true
      const httpUrl = backend ? `http://${backend.host}:${backend.port}` : ''
      if (await openMiniIdePluginView(workspacePath, httpUrl, extraParams, currentUiTheme(), {
        canDispatch,
        trustedEditorFileTarget,
        workspaceDisplayName: await frontendPluginManager.peekWorkspaceDisplayName(workspacePath),
      })) return true
    }
  }

  if (!canDispatch()) return false
  const target = host && !host.isDestroyed() ? host : mainWindow
  void handleMiniIdeUnavailable(target, extraParams)
  return false
}

// The `ui.open_in_editor` host capability is the plugin semantic editor route:
// a contribution asks for the IDE surface, regardless of the user's explicit
// external-editor preference. Direct user actions continue through
// routeEditorOpen and retain that preference.
frontendPluginManager.setOpenInEditorHandler((params) => openMiniIdeEditor(null, params))
frontendPluginManager.setOpenPlansWindowHandler((workspacePath, relPath) =>
  openPlanWindow(workspacePath, relPath)
)

// Manifest v2 plans are executed by the Host-owned adapters. In particular,
// Git's public fs/ui/aiCli calls resolve their workspace and executable/profile
// identities here; the package never receives a backend socket or raw shell.
frontendPluginManager.setPublicCapabilityHandler((plan) =>
  frontendPluginManager.executePublicCapability(plan)
)

// Native editor capability handlers run only after FrontendPluginManager has
// authorized the exact plugin instance and workspace binding. Reuse the same
// native picker, editor routing, window routing, and keybinding persistence
// helpers used by the Host IPC handlers above.
frontendPluginManager.setEditorNativeHandlers({
  pickFile: (title) => pickFilePath({ title }),
  pickWorkspace: (defaultPath) => pickWorkspacePath(defaultPath),
  revealPath: (target) => {
    const result = revealShellPath(target)
    if (!result.ok) throw new Error(result.error ?? 'reveal failed')
  },
  openPath: async (target) => {
    const result = await openShellPath(target)
    if (!result.ok) throw new Error(result.error ?? 'open failed')
  },
  openTempFile: async (name, content) => {
    const result = await openTempFilePath(name, content)
    if (!result.ok) throw new Error(result.error ?? 'open temp file failed')
  },
  listEditors: async (refresh) => currentDetectedEditors(refresh).map((editor) => ({
    id: editor.id,
    label: editor.id === 'vscode' ? 'Visual Studio Code' : editor.id === 'cursor' ? 'Cursor' : editor.id,
    available: editor.available,
  })),
  openFolderInEditor: async (dir, editorId) => {
    if (!(await openFolderInEditor(null, dir, editorId))) {
      throw new Error('editor unavailable')
    }
  },
  openEditorWindow: async (args) => {
    const ok = await openMiniIdeEditor(null, {
      workspace_path: args.workspace_path,
      ...(args.filepath !== undefined ? { filepath: args.filepath } : {}),
      ...(args.file_ws !== undefined ? { file_ws: args.file_ws } : {}),
      ...(args.line !== undefined ? { line: String(args.line) } : {}),
      ...(args.sidebar !== undefined ? { sidebar: args.sidebar } : {}),
    })
    if (!ok) throw new Error('editor open failed')
  },
  openPluginWindow: async ({ contributionKey, workspacePath, filePath, line }) => {
    const disabledBuiltin = frontendPluginManager.listDisabledBuiltinPlugins()
      .find((pluginId) => contributionKey.startsWith(`${pluginId}.`))
    if (disabledBuiltin) {
      return {
        ok: false,
        error: 'PLUGIN_UNAVAILABLE' as const,
        message: builtinPluginDisabledMessage(disabledBuiltin),
      }
    }
    const extraParams: Record<string, string> = {}
    const trustedEditorFileTarget = filePath
      ? { path: filePath, expectedCanonicalPath: filePath }
      : undefined
    if (filePath) {
      const workspaceRoot = normalizeWorkspacePath(workspacePath)
      const targetPath = normalizeWorkspacePath(filePath)
      const relPath = workspaceRoot ? relative(workspaceRoot, targetPath) : ''
      if (
        relPath &&
        !isAbsolute(relPath) &&
        relPath !== '..' &&
        !relPath.startsWith(`..${sep}`)
      ) {
        extraParams.filepath = relPath
      } else {
        extraParams.filepath = basename(targetPath)
        extraParams.file_ws = dirname(targetPath)
      }
    }
    if (line !== undefined) extraParams.line = String(line)

    const result = await openCatalogContributionWindow(
      contributionKey,
      workspacePath,
      extraParams,
      trustedEditorFileTarget,
    )
    if (result.ok) return { ok: true }

    // A Mini-IDE contribution can be in guarded legacy recovery after its v2
    // window failed. Reuse the semantic editor route so that recovery keeps
    // the same exact file target and Host grant; it does not recurse through
    // this native handler.
    if (contributionKey === MINI_IDE_CONTRIBUTION) {
      if (await openMiniIdeEditor(null, { workspace_path: workspacePath, ...extraParams }, () => true, trustedEditorFileTarget)) {
        return { ok: true }
      }
    }

    // Catalog ownership is authoritative. Contribution keys may contain
    // dots, so deriving a plugin id from the last separator can misclassify a
    // missing target as an installed package.
    const catalogEntry = frontendPluginManager.listContributionCatalog().find(
      (entry) => entry.contributionKey === contributionKey,
    )
    const miniIdeInstalled = contributionKey === MINI_IDE_CONTRIBUTION && Boolean(
      frontendPluginManager.getDescriptor(MINI_IDE_PLUGIN_ID) ||
      frontendPluginManager.listInstalledPackages().some((pkg) => pkg.id === MINI_IDE_PLUGIN_ID),
    )
    return catalogEntry || miniIdeInstalled
      ? {
          ok: false,
          error: 'PLUGIN_UNAVAILABLE' as const,
          message: 'The requested plugin contribution is installed but unavailable right now.',
        }
      : {
          ok: false,
          error: 'PLUGIN_NOT_INSTALLED' as const,
          message: 'The requested plugin contribution is not installed.',
        }
  },
  openMainWindow: (workspacePath) => openMainWindow(workspacePath),
  openBranchDiffWindow: (workspacePath, base) => openBranchDiffWindow(null, {
    workspace_path: workspacePath,
    branch_diff_base: base,
  }),
  openGitWindow: async (args) => {
    if (!(await openGitWindow(args.workspace_path, gitWindowExtraParams(args)))) {
      throw new Error('Git window unavailable')
    }
  },
  openGitHistoryWindow: async (workspacePath) => {
    if (!(await openGitWindow(workspacePath))) throw new Error('Git window unavailable')
  },
  readKeybindings: () => readKeybindingsFile(),
  writeKeybindings: (content) => writeKeybindingsFile(content),
  setUiScale: (scale) => uiZoomStore().set(scale),
})

// Plans v2 keeps all workspace reads and mutations on the existing backend
// filesystem service. The package child only receives the Host-private bridge
// adapter; it never gets a Node filesystem handle or a second path resolver.
frontendPluginManager.configurePlansFilesystemService()

frontendPluginManager.setPublicStorageHandler((execution) => pluginStorageStore.execute(execution))

// Shell-level host capabilities (plugin broker): the Git window's remote/
// worktree cards need the same shell actions GitPane reaches via
// window.agentTeam — browser open, Finder reveal, open-workspace-window
// (mirrors the window:openMain handler), and a native directory picker.
frontendPluginManager.setHostShellHandlers({
  openExternal: async (url) => {
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  },
  revealPath: (target) => {
    try {
      shell.showItemInFolder(target)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  },
  openWorkspace: (ws) => {
    const existing = findMainWindowForWorkspace(ws)
    if (existing) {
      revealMainWindow(existing)
      return { ok: true }
    }
    // duplicate=1: same semantics as window:openMain — skip pane restore for a
    // window cloned while its source's CLI sessions are still running.
    void createWindow({ workspace_path: ws, duplicate: '1' })
    return { ok: true }
  },
  pickFolder: async (defaultPath) => {
    const opts = {
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
      ...(defaultPath ? { defaultPath } : {}),
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]!
  },
})

/**
 * Surface a clear failure when the mini-IDE plugin view could not be opened.
 * There is no implicit OS-editor fallback: the selected editor route is owned
 * by routeEditorOpen, and this handler only reports the unavailable Mini-IDE.
 */
async function handleMiniIdeUnavailable(
  target: BrowserWindow | null,
  params: Record<string, string>
): Promise<void> {
  const kind = classifyEditorOpen(params)
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'Mini-IDE unavailable',
    message: kind === 'diff'
      ? 'Unable to open the diff because the Mini-IDE is unavailable.'
      : kind === 'file'
        ? 'Unable to open the file because the Mini-IDE is unavailable.'
        : 'The Mini-IDE is unavailable.',
    detail:
      (kind === 'diff'
        ? 'Diff views require the Mini-IDE. '
        : kind === 'file'
          ? 'This file can only be opened through the Mini-IDE in the current configuration. '
          : '') +
      'The Navide plugin Mini-IDE is not installed or could not be loaded. Open Settings → Navide Plugins to inspect its status.',
  }
  void (target && !target.isDestroyed()
    ? dialog.showMessageBox(target, options)
    : dialog.showMessageBox(options))
}

/** The v2 Plans window was closed on a failure and the legacy window could not
 *  take its place (its storage is unreadable); say so instead of leaving the
 *  user with a window that just vanished. */
function showPlansRecoveryUnavailable(workspacePath: string): void {
  const target = findMainWindowForWorkspace(workspacePath) ?? mainWindow
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'Plans unavailable',
    message: 'Plans could not be opened because its data could not be read.',
    detail: 'Open Settings → Navide Plugins to inspect the Navide plugin Plans, or restart Navide.',
  }
  void (target && !target.isDestroyed()
    ? dialog.showMessageBox(target, options)
    : dialog.showMessageBox(options))
}

function showPlansPreviewUnavailable(workspacePath: string): void {
  const plansInstalled = Boolean(
    frontendPluginManager.getDescriptor('navide.plans') ||
    frontendPluginManager.listInstalledPackages().some((pkg) => pkg.id === 'navide.plans'),
  )
  const missing = !plansInstalled
  const target = findMainWindowForWorkspace(workspacePath) ?? mainWindow
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'Plans unavailable',
    message: missing
      ? 'Unable to preview this HTML file because Plans is not installed.'
      : 'Unable to preview this HTML file because Plans is unavailable.',
    detail: missing
      ? 'The Navide plugin Plans is not installed. Open Settings → Navide Plugins to inspect its status.'
      : 'The installed Navide plugin Plans could not be loaded. Open Settings → Navide Plugins to inspect its status.',
  }
  void (target && !target.isDestroyed()
    ? dialog.showMessageBox(target, options)
    : dialog.showMessageBox(options))
}

function openDiffWindow(host: BrowserWindow | null, params: Record<string, string>): void {
  // Diff surfaces belong to the Git extension: the request is forwarded to its
  // window, which selects the file there. The IDE never renders a diff.
  void openGitWindow(params.workspace_path ?? '', gitWindowExtraParams({
    filepath: params.filepath,
    ...(params.name === undefined ? {} : { name: params.name }),
    ...(params.staged === undefined ? {} : { staged: params.staged }),
    ...(params.commit === undefined ? {} : { commit: params.commit }),
  }))
}

/** Route a diff-shaped editor request to the Git extension's own window. The
 *  request is the one the editor window used to receive (`diff_filepath`,
 *  `branch_diff_base`, …), so callers keep passing the same params. */
async function openGitDiffRequest(host: BrowserWindow | null, params: Record<string, string>): Promise<boolean> {
  if (refuseDisabledBuiltin('navide.git', host)) return false
  const workspacePath = params.workspace_path ?? ''
  const extraParams = params.branch_diff_base
    ? {
        git_diff_base: params.branch_diff_base,
        git_diff_compare: params.branch_diff_compare ?? '',
      }
    : gitWindowExtraParams({
        filepath: params.diff_filepath,
        ...(params.diff_name === undefined ? {} : { name: params.diff_name }),
        ...(params.diff_staged === undefined ? {} : { staged: params.diff_staged }),
        ...(params.diff_commit === undefined ? {} : { commit: params.diff_commit }),
      })
  if (await openGitWindow(workspacePath, extraParams)) return true
  await showGitViewUnavailable(host)
  return false
}

/** The Git extension owns diffs; say so when it is missing instead of opening
 *  an editor window that cannot show them. */
async function showGitViewUnavailable(target: BrowserWindow | null): Promise<void> {
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: 'Git view unavailable',
    message: 'Unable to open the diff because the Git extension is unavailable.',
    detail: 'The Navide plugin Git is not installed or could not be loaded. Open Settings → Navide Plugins to inspect its status.',
  }
  await (target && !target.isDestroyed()
    ? dialog.showMessageBox(target, options)
    : dialog.showMessageBox(options))
}

function openMainWindow(workspacePath = '', background = false): void {
  const params: Record<string, string> = {}
  const ws = workspacePath?.trim() ?? ''
  if (ws) {
    // Already open in some window → focus it instead of duplicating.
    const existing = findMainWindowForWorkspace(ws)
    if (existing) {
      revealMainWindow(existing)
      return
    }
    params.workspace_path = ws
    // duplicate=1 marks a window cloned from a live one (its source's CLI
    // sessions are still running), so the renderer skips pane restore once.
    // Externally-opened workspaces (openWorkspaceFromPath) must NOT carry
    // this — their previous sessions are dead and restore should run.
    params.duplicate = '1'
  }
  void createWindow(params, background ? { background: true } : undefined)
}

ipcMain.handle('window:openMain', (_event, args?: { workspace_path?: string; background?: boolean }) => {
  openMainWindow(args?.workspace_path, args?.background === true)
  return { ok: true }
})

// Pages push their terminal selection as it changes so Edit > Copy can read it
// without asking (see terminal-selection-cache.ts). Cleanup is bound once per
// WebContents: ids are reused, and a stale entry would answer Copy for whatever
// page inherits the id.
const selectionCleanupBound = new Set<number>()
ipcMain.on('terminal:selection-changed', (event, selection: unknown) => {
  const contents = event.sender
  const id = contents.id
  setTerminalSelection(id, typeof selection === 'string' ? selection : '')
  if (selectionCleanupBound.has(id)) return
  selectionCleanupBound.add(id)
  contents.once('destroyed', () => {
    forgetTerminalSelection(id)
    selectionCleanupBound.delete(id)
  })
})

// The renderer switches workspaces at runtime (Welcome picker / back-to-Welcome)
// without reloading, so main's per-window workspace map — and the crash-restore
// registry — must be told. Empty path = the window returned to Welcome.
ipcMain.on('window:reportWorkspace', (event, workspacePath: string) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !mainWindows.has(win)) return
  if (detachedWindowIds.has(win.id)) return // detached child — never registry-tracked
  const ws = String(workspacePath ?? '').trim()
  if (ws) mainWindowWorkspaces.set(win, ws)
  else mainWindowWorkspaces.delete(win)
  windowRegistry.setWorkspace(win.id, ws)
  broadcastOpenWorkspacesChanged()
})

ipcMain.on('git:contribution-state', (event, state: unknown) => {
  const hostWindow = BrowserWindow.fromWebContents(event.sender)
  if (!isTrustedPluginManagementSender(event, mainWindows) ||
    !hostWindow || typeof state !== 'object' || state === null || Array.isArray(state)) return
  frontendPluginManager.setGitContributionState(hostWindow, state as Parameters<typeof frontendPluginManager.setGitContributionState>[1])
})

ipcMain.on('git:contribution-state-clear', (event) => {
  const hostWindow = BrowserWindow.fromWebContents(event.sender)
  if (isTrustedPluginManagementSender(event, mainWindows) && hostWindow) {
    frontendPluginManager.clearGitContributionState(hostWindow)
  }
})

// The sidebar can take on workspaces beyond the one the window was opened
// with. Main needs the list so a second window does not open the same folder —
// two sets of PTY and git operations on one checkout is what this prevents.
ipcMain.on('window:reportAdoptedWorkspaces', (event, paths: string[]) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !mainWindows.has(win)) return
  if (detachedWindowIds.has(win.id)) return // detached child — never registry-tracked
  const list = (Array.isArray(paths) ? paths : [])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
  if (list.length) adoptedWorkspaces.set(win, list)
  else adoptedWorkspaces.delete(win)
  windowRegistry.setAdoptedWorkspaces(win.id, list)
  broadcastOpenWorkspacesChanged()
})

// A restored window asks once, on mount, for the list it had when the app was
// last running. Taken rather than read: a reload must not resurrect a list the
// user has since emptied.
ipcMain.handle('window:takeRestoredAdopted', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return []
  const list = pendingAdoptedWorkspaces.get(win.id) ?? []
  pendingAdoptedWorkspaces.delete(win.id)
  return list
})

// Renderers push the latest recent-workspaces list so the native File > Open
// Recent submenu stays in sync. Every window pushes on each change, so skip the
// rebuild when the list is unchanged.
ipcMain.on('menu:setRecents', (_e, recents: RecentMenuEntry[]) => {
  const next = Array.isArray(recents) ? recents : []
  if (JSON.stringify(next) === JSON.stringify(lastRecents)) return
  lastRecents = next
  rebuildAppMenu()
})

// Welcome screens badge already-open workspaces and focus the existing window
// instead of opening a duplicate (same-folder double-open causes PTY/git
// conflicts). listOpen feeds the badges; focusExisting is the click path —
// it returns false when the workspace is only open in the asking window
// itself, so re-selecting your own workspace stays a normal no-op open.
ipcMain.handle('workspace:listOpen', () => {
  const open: string[] = []
  for (const [win, wp] of mainWindowWorkspaces) {
    if (!win.isDestroyed()) open.push(wp)
  }
  for (const [win, list] of adoptedWorkspaces) {
    if (!win.isDestroyed()) open.push(...list)
  }
  return uniqueOpenWorkspaces(open)
})

// Which OTHER window holds a workspace, by title, or '' when none does (or only
// the asking window). cli_open_agent's "current" window choice refuses a
// project another window already holds and names that window.
ipcMain.handle('workspace:holder', (event, workspacePath: string) => {
  const self = BrowserWindow.fromWebContents(event.sender)
  const existing = findMainWindowForWorkspace(String(workspacePath ?? ''))
  if (!existing || existing === self) return ''
  return existing.getTitle() || 'another Navide window'
})

ipcMain.handle('workspace:focusExisting', (event, workspacePath: string) => {
  const self = BrowserWindow.fromWebContents(event.sender)
  const existing = findMainWindowForWorkspace(String(workspacePath ?? ''))
  if (!existing || existing === self) return false
  revealMainWindow(existing)
  return true
})

// ── Crash-restore prompt (see window-registry.ts) ────────────────────────────
// The first window to ask claims the banner; apply/dismiss both clear it.
ipcMain.handle('restore:getPending', () => {
  if (!pendingRestore || pendingRestoreClaimed) return null
  pendingRestoreClaimed = true
  return pendingRestore.map((w) => w.workspace_path)
})

ipcMain.handle('restore:apply', () => {
  const entries = pendingRestore ?? []
  pendingRestore = null
  // An explicit Apply is consent: it overrides the failure breaker and resets
  // the tally of every workspace it names, so a workspace that once wedged the
  // backend can never become permanently unopenable. The attempt is still
  // charged, so an unattended relaunch afterwards is protected again.
  const plan = windowRegistry.beginRestore(entries, { userInitiated: true })
  for (const entry of plan.restore) {
    // A detached group comes back detached. Its window is not a workspace
    // window, so the dedup lookup below would wrongly match the main window
    // for the same workspace and skip reopening it entirely.
    if (entry.detached_group) {
      void reopenDetachedGroup(entry.workspace_path, entry.detached_group, entry.bounds)
      continue
    }
    // Already reopened manually → focus, don't duplicate.
    const existing = findMainWindowForWorkspace(entry.workspace_path)
    if (existing) {
      revealMainWindow(existing)
    } else {
      // No duplicate=1 flag: a crash-restore boot's sessions are dead, so the
      // renderer runs pane restore (restore=1 is informational only).
      void createWindow(
        { workspace_path: entry.workspace_path, restore: '1' },
        entry.bounds ? { bounds: entry.bounds } : undefined
      ).then((win) => {
        if (entry.adopted_workspaces?.length) {
          pendingAdoptedWorkspaces.set(win.id, entry.adopted_workspaces)
        }
      })
    }
  }
  return { ok: true, opened: plan.restore.length }
})

ipcMain.handle('restore:dismiss', () => {
  pendingRestore = null
  return { ok: true }
})

// Workspaces left unrestored by the failure breaker, for a renderer notice.
// Claimed by the first window to ask, like restore:getPending above — every
// restored window boots and asks, and the notice must appear only once.
ipcMain.handle('restore:getSkipped', () => {
  const claimed = skippedRestores
  skippedRestores = []
  return claimed
})

ipcMain.handle('restore:getAutoRestore', () => windowRegistry.getRestoreOnLaunch())

ipcMain.handle('restore:setAutoRestore', (_e, value: boolean) => {
  windowRegistry.setRestoreOnLaunch(value === true)
  return { ok: true }
})

// ── Detached run-group windows ───────────────────────────────────────────────
// Open a run group of a workspace in its own scoped child window. The main
// window(s) of that workspace are told to hand the group off (group:detached);
// when the child closes, they are told to take it back (group:reattached).
ipcMain.handle(
  'window:detachGroup',
  async (_e, arg: { groupId?: string; workspacePath?: string; bounds?: WindowBounds }) => {
    const groupId = String(arg?.groupId ?? '')
    const workspacePath = String(arg?.workspacePath ?? '')
    if (!groupId || !workspacePath) return { ok: false }
    const existing = detachedGroups.get(groupId)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return { ok: true }
    }
    const child = await createWindow(
      { window: 'main', workspace_path: workspacePath, detached_group: groupId },
      arg.bounds ? { bounds: arg.bounds } : undefined
    )
    detachedGroups.set(groupId, child)
    detachedGroupWorkspace.set(groupId, workspacePath)
    broadcastToWorkspace(workspacePath, 'group:detached', { groupId })
    child.on('closed', () => {
      detachedGroups.delete(groupId)
      detachedGroupWorkspace.delete(groupId)
      broadcastToWorkspace(workspacePath, 'group:reattached', { groupId })
    })
    return { ok: true }
  }
)

// Pull a workspace out of the window that adopted it and give it its own main
// window. Its panes are alive in the backend and belong to the workspace, not
// to the window, so the new window restores them the ordinary way — which is
// why this does NOT set `duplicate`, the flag window:openMain uses to skip
// restore for a cloned window whose sessions are still shown elsewhere.
ipcMain.handle(
  'window:detachWorkspace',
  async (e, arg: { workspacePath?: string; bounds?: WindowBounds }) => {
    const workspacePath = String(arg?.workspacePath ?? '').trim()
    if (!workspacePath) return { ok: false }
    // The caller drops it from its adopted list before invoking this, but that
    // report travels on a send rather than this invoke, so skip the caller
    // outright: adopted workspaces count as held, and finding the source window
    // here would turn the drag into a focus of the window it came from.
    const source = BrowserWindow.fromWebContents(e.sender)
    const found = findMainWindowForWorkspace(workspacePath)
    const existing = found && found !== source ? found : null
    if (existing) {
      revealMainWindow(existing)
      return { ok: true }
    }
    await createWindow(
      { window: 'main', workspace_path: workspacePath },
      arg.bounds ? { bounds: arg.bounds } : undefined
    )
    return { ok: true }
  }
)

/** Merge a detached group back into the window it came from.
 *
 *  Until now the only way back was closing the child window, which meant the
 *  reattach was indistinguishable from "I am done with these panes". Closing
 *  the window here reuses that exact path — the 'closed' handler above already
 *  broadcasts group:reattached and the origin window restores the group — so
 *  there is one reattach implementation, not two.
 */
/** Reopen a detached group's window on launch, wiring up the same bookkeeping
 *  window:detachGroup does — including the 'closed' handler that broadcasts
 *  group:reattached, so a restored detached window can still be merged back. */
async function reopenDetachedGroup(
  workspacePath: string,
  groupId: string,
  bounds?: WindowBounds
): Promise<void> {
  const already = detachedGroups.get(groupId)
  if (already && !already.isDestroyed()) return
  const child = await createWindow(
    { window: 'main', workspace_path: workspacePath, detached_group: groupId, restore: '1' },
    bounds ? { bounds } : undefined
  )
  detachedGroups.set(groupId, child)
  detachedGroupWorkspace.set(groupId, workspacePath)
  child.on('closed', () => {
    detachedGroups.delete(groupId)
    detachedGroupWorkspace.delete(groupId)
    broadcastToWorkspace(workspacePath, 'group:reattached', { groupId })
  })
}

ipcMain.handle('window:reattachGroup', (event, arg: { groupId?: string } | undefined) => {
  const requested = String(arg?.groupId ?? '')
  // A child window knows which group it is without being told; asking the
  // sender keeps the caller honest when the id is omitted.
  const sender = BrowserWindow.fromWebContents(event.sender)
  let groupId = requested
  if (!groupId && sender) {
    for (const [id, win] of detachedGroups) {
      if (win === sender) {
        groupId = id
        break
      }
    }
  }
  if (!groupId) return { ok: false }
  const child = detachedGroups.get(groupId)
  if (!child || child.isDestroyed()) return { ok: false }
  child.close()
  return { ok: true }
})

// MCP window_focus (DESIGN-C S3): a window brings ITSELF to the front. The
// window is the sender's, never an argument, so a renderer cannot focus (or
// name) any other window through this.
ipcMain.handle('window:focusSelf', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed() || !mainWindows.has(win)) return { ok: false }
  revealMainWindow(win)
  return { ok: true }
})

// MCP window_close (DESIGN-C S4a): a window closes ITSELF, the same close its
// own title-bar button makes (so the last-window guard still applies). The
// window is the sender's, never an argument.
// Off macOS the last main window cannot be closed this way: that would quit
// Navide and end every CLI. Asked before the window lets go of anything
// (window:canCloseSelf), and again at the close itself.
function agentCloseRefusal(win: BrowserWindow | null): string | null {
  if (!win || win.isDestroyed() || !mainWindows.has(win)) return 'not-a-main-window'
  const others = [...mainWindows].filter((w) => w !== win && !w.isDestroyed() && !detachedWindowIds.has(w.id))
  if (!isMac() && !detachedWindowIds.has(win.id) && others.length === 0) return 'last-window'
  return null
}
ipcMain.handle('window:canCloseSelf', (event) => {
  const refusal = agentCloseRefusal(BrowserWindow.fromWebContents(event.sender))
  return refusal ? { ok: false, error: refusal } : { ok: true }
})
ipcMain.handle('window:closeSelf', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const refusal = agentCloseRefusal(win)
  if (refusal || !win) return { ok: false, error: refusal ?? 'not-a-main-window' }
  win.close()
  return { ok: true }
})

ipcMain.handle('window:getDetachedGroups', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const ws = win ? mainWindowWorkspaces.get(win) : undefined
  if (!ws) return [] as string[]
  const result: string[] = []
  for (const [gid, child] of detachedGroups) {
    if (!child.isDestroyed() && detachedGroupWorkspace.get(gid) === ws) result.push(gid)
  }
  return result
})

ipcMain.handle('window:openDiff', (event, args: Record<string, string>) => {
  openDiffWindow(BrowserWindow.fromWebContents(event.sender), args ?? {})
  return { ok: true }
})

// The contribution windows worth restoring, by the key that opens them. Both
// of the restorable per-workspace kinds come through this one host, so the
// mapping lives here rather than in each caller — and a contribution absent
// from it (a future one-shot viewer) is simply not tracked.
const AUX_KIND_BY_CONTRIBUTION: Record<string, AuxWindowKind> = {
  [`${PLANS_PLUGIN_ID}.window`]: 'plans',
  'navide.git.window': 'git',
}

// The standalone Git client plugin view — its own dedicated window (mini-IDE
// parity), opened from the main window's "open standalone Git" entry. Resolves
// the backend HTTP base + current theme like openMiniIdeEditor.
async function openCatalogContributionWindow(
  contributionKey: string,
  workspacePath: string,
  extraParams: Record<string, string> = {},
  trustedEditorFileTarget?: TrustedEditorFileTarget,
  canDispatch: () => boolean = () => true,
): Promise<{ ok: boolean; error?: string; backendUnavailable?: string }> {
  if (!canDispatch()) return { ok: false, error: 'request is no longer active' }
  if (!(await prepareCatalogContribution(contributionKey))) {
    return {
      ok: false,
      error: contributionKey === MINI_IDE_CONTRIBUTION
        ? 'mini-ide storage unavailable'
        : 'Plans v2 storage is unavailable',
    }
  }
  if (!canDispatch()) return { ok: false, error: 'request is no longer active' }
  const contribution = frontendPluginManager.listContributionCatalog().find(
    (entry) => entry.contributionKey === contributionKey && entry.location === 'window'
  )
  if (!contribution) return { ok: false, error: 'window contribution is not installed' }

  // Best-effort and bounded (see peekWorkspaceDisplayName): a wedged backend
  // costs a short delay, then the window opens titled with the folder name.
  const workspaceDisplayName = await frontendPluginManager.peekWorkspaceDisplayName(workspacePath)

  const windowKey = getContributionWindowKey(contributionKey, workspacePath, normalizeWorkspacePath)
  let hostWindow = contributionWindows.get(windowKey)
  let created = false
  if (!hostWindow || hostWindow.isDestroyed()) {
    const ownedWindow = new BrowserWindow(
      getContributionWindowConfig(contributionKey, contribution.title)
    )
    hostWindow = ownedWindow
    created = true
    windowCloseCoordinator.watch(ownedWindow)
    contributionWindows.set(windowKey, ownedWindow)
    ownedWindow.once('closed', () => {
      // Identity-guarded: 'closed' arrives after close(), and a reopen in that
      // gap has already registered a different window under the same key. An
      // unguarded delete would evict that live window and let the next open
      // create a duplicate instead of focusing it.
      if (contributionWindows.get(windowKey) === ownedWindow) {
        contributionWindows.delete(windowKey)
      }
      try {
        frontendPluginManager.closeContribution(ownedWindow, contributionKey)
      } catch {
        // The host has already torn down its WebContentsView.
      }
    })
  }

  if (!canDispatch()) {
    if (created && !hostWindow.isDestroyed()) hostWindow.close()
    return { ok: false, error: 'request is no longer active' }
  }
  const result = await frontendPluginManager.openContributionWindow(hostWindow, contributionKey, {
    workspacePath,
    query: catalogContributionQuery(
      contributionKey,
      workspacePath,
      extraParams,
      '',
      workspaceDisplayName,
    ),
    ...(trustedEditorFileTarget ? { trustedEditorFileTarget } : {}),
    canDispatch,
  })
  if (!canDispatch()) {
    if (created && !hostWindow.isDestroyed()) hostWindow.close()
    return { ok: false, error: 'request is no longer active' }
  }
  if (!result.ok) {
    if (created && !hostWindow.isDestroyed()) {
      if (contributionWindows.get(windowKey) === hostWindow) contributionWindows.delete(windowKey)
      hostWindow.close()
    }
    return result
  }
  // A reused window only had its query updated and was focused; whether the
  // file then showed is the guest's business, so leave a trace for main.log.
  if (!created && contributionKey === MINI_IDE_CONTRIBUTION) {
    warnMain(`[main] mini-ide window reused; workspace=${workspacePath} filepath=${extraParams.filepath ?? ''}`)
  }
  // Only a window this call created is tracked: the reopen path above focuses
  // an already-tracked window, and it is only now, past the failure branch,
  // that the window is one the user will actually see.
  const auxKind = AUX_KIND_BY_CONTRIBUTION[contributionKey]
  if (auxKind && !hostWindow.isDestroyed()) {
    if (created) {
      trackAuxWindow(hostWindow, { kind: auxKind, workspace_path: workspacePath })
    } else {
      // Reused window. Git is keyed by contribution alone (getContributionWindowKey
      // only scopes Plans per workspace), so this call has just re-targeted the
      // one Git window at another project — the tracked workspace follows it,
      // or the restore reopens Git on whichever workspace first created it.
      windowRegistry.setAuxWorkspace(hostWindow.id, workspacePath)
    }
  }
  if (!hostWindow.isDestroyed()) {
    if (hostWindow.isMinimized()) hostWindow.restore()
    hostWindow.show()
    hostWindow.focus()
  }
  // The window opened without its native backend: the main window says why.
  return result.backendUnavailable ? { ok: true, backendUnavailable: result.backendUnavailable } : { ok: true }
}

const plansWindowRouter = createPlansWindowRouter({
  frontendPluginManager,
  openCatalogContributionWindow,
  migratePlansStorageState,
  isPlansRecoveryEnabled: () => plansRecoveryEnabled,
  enterPlansRecovery,
  openLegacyPlanWindow,
  warnMain,
})

function catalogContributionQuery(
  contributionKey: string,
  workspacePath: string,
  extraParams: Record<string, string> = {},
  // The requesting window's rendered theme, when it has one. It beats
  // currentUiTheme() because the settings mirror can lag the window that is
  // actually painting, which left an in-window contribution booting on the
  // wrong theme until the next theme change.
  renderedTheme = '',
  // The workspace's user-set alias, resolved by the caller (only the window
  // openers do, since an in-window contribution region has no title of its
  // own). Blank leaves the param out and the view falls back to the folder
  // name.
  workspaceDisplayName = '',
): string {
  const isGit = contributionKey.startsWith('navide.git.')
  return composePluginContributionQuery({
    contributionKey,
    workspacePath,
    theme: renderedTheme || currentUiTheme(),
    locale: currentUiLocale(),
    ...(isGit && backend ? { httpUrl: `http://${backend.host}:${backend.port}` } : {}),
    ...(isGit ? { gitReadOnly: currentGitReadOnlyQuery() } : {}),
    extraParams,
    workspaceDisplayName,
  })
}

async function openGitWindow(workspacePath: string, extraParams: Record<string, string> = {}): Promise<boolean> {
  if (refuseDisabledBuiltin('navide.git', findMainWindowForWorkspace(workspacePath))) return false
  const httpUrl = backend ? `http://${backend.host}:${backend.port}` : ''
  const generic = await openCatalogContributionWindow('navide.git.window', workspacePath, extraParams)
  if (generic.ok) return true
  if (!gitRecoveryEnabled) return false
  await migrateGitStorage()
  return openGitPluginView(workspacePath, httpUrl, currentUiTheme(), {
    ...currentGitReadOnlyQuery(),
    ...extraParams,
  })
}

function gitWindowExtraParams(args: {
  filepath?: string
  name?: string
  staged?: boolean | string
  commit?: string
  base?: string
  compare?: string
}): Record<string, string> {
  const extraParams: Record<string, string> = {}
  if (args.filepath) {
    extraParams.git_diff_filepath = args.filepath
    extraParams.git_diff_name = args.name ?? ''
    extraParams.git_diff_staged = typeof args.staged === 'boolean' ? String(args.staged) : (args.staged ?? '')
    extraParams.git_diff_commit = args.commit ?? ''
  }
  if (args.base) extraParams.git_diff_base = args.base
  if (args.compare) extraParams.git_diff_compare = args.compare
  return extraParams
}

ipcMain.handle('window:openGit', async (_event, args: Record<string, string>) => {
  const workspacePath = (args?.workspace_path ?? '').trim()
  if (!workspacePath) return { ok: false }
  // Optional diff target: focus the Git window on a file's diff (shown in its
  // own panel, not the mini-IDE). GitWindowApp reads these git_diff_* keys on
  // load and via the incremental openTarget delivery when already open.
  const ok = await openGitWindow(workspacePath, gitWindowExtraParams(args))
  return { ok }
})

function pluginBoundsFrom(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const values = [record.x, record.y, record.width, record.height]
  if (!values.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null
  if (Number(record.width) <= 0 || Number(record.height) <= 0) return null
  return {
    x: Math.round(Number(record.x)),
    y: Math.round(Number(record.y)),
    width: Math.round(Number(record.width)),
    height: Math.round(Number(record.height)),
  }
}

// The renderer supplies layout geometry and a workspace assertion. The main
// process resolves the registered workspace and actual left contribution;
// neither the workspace authority nor the opaque instance handle comes from
// renderer input.
ipcMain.handle('window:openGitLeft', async (event, args: Record<string, unknown>) => {
  if (!gitRecoveryEnabled || frontendPluginManager.isBuiltinPluginDisabled('navide.git')) return { ok: false }
  const hostWindow = trustedGitLeftWindow(event, mainWindows, detachedWindowIds)
  const requestedWorkspace = typeof args?.workspace_path === 'string' ? args.workspace_path : ''
  const registeredWorkspace = hostWindow
    ? registeredGitLeftWorkspace(hostWindow, requestedWorkspace, mainWindowWorkspaces, normalizeWorkspacePath)
    : null
  const bounds = pluginBoundsFrom(args?.bounds)
  if (!hostWindow || !registeredWorkspace || !bounds) return { ok: false }
  const workspacePath = normalizeWorkspacePath(registeredWorkspace)
  if (!workspacePath) return { ok: false }
  await migrateGitStorage()
  const httpUrl = backend ? `http://${backend.host}:${backend.port}` : ''
  return openGitLeftPluginView(
    hostWindow,
    workspacePath,
    bounds,
    httpUrl,
    currentUiTheme(),
    currentGitReadOnlyQuery(),
  )
})

ipcMain.handle('window:updateGitLeft', (event, args: Record<string, unknown>) => {
  if (!gitRecoveryEnabled || frontendPluginManager.isBuiltinPluginDisabled('navide.git')) return { ok: false }
  const hostWindow = trustedGitLeftWindow(event, mainWindows, detachedWindowIds)
  const bounds = pluginBoundsFrom(args?.bounds)
  if (!hostWindow || !bounds) return { ok: false }
  return updateGitLeftPluginView(hostWindow, bounds, args?.visible === true)
})

ipcMain.handle('window:closeGitLeft', (event) => {
  if (!gitRecoveryEnabled) return { ok: false }
  const hostWindow = trustedGitLeftWindow(event, mainWindows, detachedWindowIds)
  return hostWindow ? closeGitLeftPluginView(hostWindow) : { ok: false }
})

function trustedPluginRegionHost(event: IpcMainInvokeEvent): BrowserWindow | null {
  return trustedGitLeftWindow(event, mainWindows, detachedWindowIds)
}

/** Generic Manifest view-region lifecycle. The renderer supplies only the
 * stable contribution key and layout geometry; FrontendPluginManager keeps
 * the opaque instance handle in main. */
/** Theme ids the app ships (mirrors useTheme's VALID_IDS). */
const HOST_THEME_IDS = new Set([
  'dark-github',
  'dark-midnight',
  'dark-forest',
  'light',
  'high-contrast',
])

// The window that is painting is the only reliable source for its own theme:
// the settings mirror can lag it, and adopting a stored theme at boot is not a
// change, so it produces no backend broadcast. Let the host re-assert it.
ipcMain.on('plugins:hostThemeChanged', (event, theme: unknown) => {
  if (!trustedPluginRegionHost(event)) return
  // Only the theme ids the app ships: this value reaches every plugin as
  // Host-owned metadata, so it should not be free-form text.
  if (typeof theme !== 'string' || !HOST_THEME_IDS.has(theme)) return
  frontendPluginManager.dispatchHostSettingsChanged({
    settings: { 'agent-team:theme': JSON.stringify(theme) },
  })
})

ipcMain.handle('plugins:prepareContribution', async (event, args: Record<string, unknown>) => {
  const hostWindow = trustedPluginRegionHost(event)
  const contributionKey = typeof args?.contributionKey === 'string' ? args.contributionKey : ''
  const workspacePath = hostWindow
    ? registeredGitLeftWorkspace(
        hostWindow,
        args?.workspace_path,
        mainWindowWorkspaces,
        normalizeWorkspacePath,
      )
    : null
  if (!hostWindow || !contributionKey || !workspacePath) return { ok: false }
  // A stale renderer may still ask for a just-disabled built-in's view; refuse
  // before any storage migration or recovery path runs for it.
  const disabledBuiltin = frontendPluginManager.listDisabledBuiltinPlugins()
    .find((pluginId) => contributionKey.startsWith(`${pluginId}.`))
  if (disabledBuiltin) return { ok: false, error: builtinPluginDisabledMessage(disabledBuiltin) }
  if (contributionKey.startsWith('navide.plans.') && plansRecoveryEnabled) {
    return { ok: false, error: 'Plans legacy recovery is active' }
  }
  if (!(await prepareCatalogContribution(contributionKey))) {
    return {
      ok: false,
      error: contributionKey === MINI_IDE_CONTRIBUTION
        ? 'Mini-IDE storage is unavailable'
        : 'Plans v2 storage is unavailable',
    }
  }
  const renderedTheme = typeof args?.theme === 'string' ? args.theme : ''
  const result = await frontendPluginManager.prepareGuestContribution(hostWindow, contributionKey, {
    workspacePath,
    query: catalogContributionQuery(contributionKey, workspacePath, {}, renderedTheme),
  })
  if (
    !result.ok &&
    contributionKey.startsWith('navide.plans.') &&
    frontendPluginManager.plansBackendFallbackAllowed()
  ) {
    enterPlansRecovery('guest-prepare-failure')
  }
  return result
})

/** Open a catalog window contribution in a dedicated BrowserWindow. Only the
 * trusted main renderer may request this; the opaque plugin instance remains
 * entirely in the main process. */
ipcMain.handle('plugins:openContributionWindow', async (event, args: Record<string, unknown>) => {
  const requestingWindow = trustedPluginRegionHost(event)
  if (!requestingWindow) return { ok: false }
  const contributionKey = typeof args?.contributionKey === 'string' ? args.contributionKey : ''
  const workspacePath = registeredGitLeftWorkspace(
    requestingWindow,
    args?.workspace_path,
    mainWindowWorkspaces,
    normalizeWorkspacePath,
  )
  if (!contributionKey || !workspacePath) return { ok: false }
  return openCatalogContributionWindow(contributionKey, workspacePath)
})

// Whether a restored AI panel still has a plugin behind its surface; one
// without retires its record instead of resuming (see dockSurfaceProvider).
ipcMain.handle('plugins:dockSurfaceProvided', (_event, surface: unknown) =>
  dockSurfaceProvided(
    typeof surface === 'string' ? surface : '',
    (pluginId) =>
      frontendPluginManager.getDescriptor(pluginId) !== undefined &&
      !frontendPluginManager.isBuiltinPluginDisabled(pluginId),
  ))

ipcMain.handle('plugins:closeContribution', (event, args: Record<string, unknown>) => {
  const hostWindow = trustedPluginRegionHost(event)
  const contributionKey = typeof args?.contributionKey === 'string' ? args.contributionKey : ''
  if (!hostWindow || !contributionKey) return { ok: false }
  return frontendPluginManager.closeContribution(hostWindow, contributionKey)
})

ipcMain.handle('window:getZoomFactor', (event) => {
  const hostWindow = trustedGitLeftWindow(event, mainWindows, detachedWindowIds)
  if (!hostWindow) return 1
  const factor = hostWindow.webContents.getZoomFactor()
  return Number.isFinite(factor) && factor > 0 ? factor : 1
})

// Interface scale, applied to every window at once. Accepted only from a
// top-level app frame: plugin content runs in a child frame or a
// WebContentsView whose preload does not expose this bridge at all, so it can
// never resize the host's chrome.
ipcMain.handle('window:setUiScale', (event, next: unknown) => {
  const hostWindow = BrowserWindow.fromWebContents(event.sender)
  if (!hostWindow || !event.senderFrame || event.senderFrame.parent) {
    return uiZoomStore().get()
  }
  return uiZoomStore().set(next)
})

function openBranchDiffWindow(host: BrowserWindow | null, params: Record<string, string>): void {
  void openGitWindow(params.workspace_path ?? '', {
    git_diff_base: params.branch_diff_base ?? 'main',
    git_diff_compare: params.branch_diff_compare ?? '',
  })
}

ipcMain.handle('window:openBranchDiff', (event, args: Record<string, string>) => {
  openBranchDiffWindow(BrowserWindow.fromWebContents(event.sender), args ?? {})
  return { ok: true }
})

// Reject only what git itself forbids in ref names (git-check-ref-format), so
// non-ASCII (e.g. CJK) branch names are allowed — matching the Python backend's
// _INVALID_REF_RE. An ASCII allowlist here wrongly rejected branches like
// "AI修改". Not the security boundary: execFile is exec-not-shell and the
// leading-'-' check below blocks flag smuggling.
const INVALID_GIT_REF_RE = /(\.\.|\x00|@\{|\\|[ ~^:?*[\]]|\/$|\.lock$|\.lock\/)/

function validateRef(value: string, label: string): string | null {
  if (!value) return null // empty is OK (means "omit")
  if (value.startsWith('-')) return `invalid ${label}: must not start with '-'`
  if (INVALID_GIT_REF_RE.test(value))
    return `invalid ${label}: contains characters git disallows in ref names`
  return null
}

// Run git diff directly in main process — no Python backend needed, always up-to-date.
ipcMain.handle('git:diff-head', async (_event, args: { workspace_path: string; base?: string; compare?: string }) => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const cwd = (args.workspace_path ?? '').trim()
  if (!cwd) return { ok: false, diff: '', error: 'workspace_path required' }
  const compare = (args.compare ?? '').trim()
  const base = (args.base ?? '').trim()
  const refErr = validateRef(base, 'base') ?? validateRef(compare, 'compare')
  if (refErr) return { ok: false, diff: '', error: refErr }
  // A compare target needs an explicit base — align with the backend, which
  // errors here rather than silently diffing HEAD and ignoring compare.
  if (compare && !base) return { ok: false, diff: '', error: 'base branch is required to compare' }
  try {
    const gitArgs: string[] = ['-c', 'core.quotePath=false', 'diff']
    if (compare && base) {
      gitArgs.push(`${base}...${compare}`)
    } else {
      gitArgs.push('HEAD')
    }
    // timeout+SIGKILL so a hung git (stale mount, wedged filter) can't spin the
    // diff pane forever; generous maxBuffer since we only keep the first 100 K.
    const { stdout } = await execFileAsync('git', gitArgs, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      killSignal: 'SIGKILL'
    })
    const truncated = stdout.length > 100_000
    return { ok: true, diff: stdout.slice(0, 100_000), truncated }
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string; killed?: boolean; code?: string }
    if (e.killed) return { ok: false, diff: '', error: 'git diff timed out' }
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      return { ok: false, diff: '', error: 'diff too large to display' }
    return { ok: false, diff: '', error: e.stderr?.trim() || e.message || 'git error' }
  }
})

// Reviewable plan doc: top-level, non-infrastructure `.agent-team/plans/*.html`
// (mirrors PlanWindowApp's isHtmlPlanDoc). Such opens route to the Plan window,
// which renders them; the mini-IDE would only show their raw HTML source.
function isHtmlPlanDocPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/') // tolerate Windows separators
  if (!normalized.startsWith('.agent-team/plans/')) return false
  const name = normalized.slice('.agent-team/plans/'.length)
  return name.endsWith('.html') && !name.startsWith('_') && !name.includes('/')
}

ipcMain.handle('window:openEditor', async (event, args: Record<string, string>) => {
  const params = args ?? {}
  const workspacePath = params.workspace_path ?? ''
  const filepath = params.filepath ?? ''
  // With `file_ws` the path is relative to that root, not to the workspace —
  // it can never name this workspace's plan doc, so keep it out of the route.
  if (workspacePath && !params.file_ws && isHtmlPlanDocPath(filepath)) {
    void openPlanWindow(workspacePath, filepath)
    return { ok: true }
  }
  const ok = await routeEditorOpen(BrowserWindow.fromWebContents(event.sender), params)
  if (!ok) {
    warnMain(`[main] window:openEditor failed workspace=${workspacePath} filepath=${filepath} file_ws=${params.file_ws ?? ''}`)
  }
  return { ok }
})

// Default-editor surface for Settings and the "Open with…" menus: the built-in
// editors plus whether each one was found on this machine.
ipcMain.handle('editors:list', (_event, args?: { refresh?: boolean }) =>
  currentDetectedEditors(args?.refresh === true)
)

ipcMain.handle(
  'editor:openFolder',
  async (event, args: { dir?: string; editorId?: string }) => {
    const ok = await openFolderInEditor(
      BrowserWindow.fromWebContents(event.sender),
      args?.dir ?? '',
      args?.editorId
    )
    return { ok }
  }
)

// Plan review windows: one per workspace; reopening focuses the existing one.
const planWindows = new PlanWindowRegistry<BrowserWindow>()
// Plan windows whose renderer has not yet subscribed to plan:open-doc. Maps the
// window to the most recently requested plan; flushed on did-finish-load so a
// click made during load (before the subscription exists) is never lost.
const planWindowPending = new Map<BrowserWindow, string>()

function trustedPlansPreferenceHost(event: IpcMainInvokeEvent): BrowserWindow | null {
  const hostWindow = BrowserWindow.fromWebContents(event.sender)
  if (
    !hostWindow ||
    hostWindow.isDestroyed() ||
    !event.senderFrame ||
    event.senderFrame.parent ||
    hostWindow.webContents !== event.sender
  ) return null
  if (isTrustedPluginManagementSender(event, mainWindows)) return hostWindow
  return planWindows.hasWindow(hostWindow) ? hostWindow : null
}

function trustedPlansRecoveryWorkspace(event: IpcMainInvokeEvent): string | null {
  const hostWindow = BrowserWindow.fromWebContents(event.sender)
  if (
    !hostWindow ||
    hostWindow.isDestroyed() ||
    !event.senderFrame ||
    event.senderFrame.parent ||
    hostWindow.webContents !== event.sender
  ) return null
  const planWindowWorkspace = planWindows.workspaceForWindow(hostWindow)
  if (planWindowWorkspace) return planWindowWorkspace
  if (mainWindows.has(hostWindow) && !detachedWindowIds.has(hostWindow.id)) {
    return mainWindowWorkspaces.get(hostWindow) ?? null
  }
  return null
}

async function openPlanWindow(workspacePath: string, relPath?: string): Promise<boolean> {
  if (refuseDisabledBuiltin('navide.plans', findMainWindowForWorkspace(workspacePath))) return false
  logPlansDevProvenance('open')
  return plansWindowRouter.openPlanWindow(workspacePath, relPath)
}

async function openLegacyPlanWindow(workspacePath: string, relPath?: string): Promise<boolean | void> {
  if (plansStorageAvailability?.status === 'unavailable') return false
  if (plansStorageAvailability?.status === 'recovery' && !frontendPluginManager.plansBackendFallbackAllowed()) return false
  const recoveryBootstrap = await getPlansLegacyRecoveryBootstrap(workspacePath)
  if (plansStorageAvailability?.status === 'recovery' && !recoveryBootstrap) return false
  // Already open for this workspace: focus it and, when a plan was clicked,
  // ask the live window to switch to it instead of reopening a new window.
  const focusExisting = (existing: BrowserWindow): void => {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    existing.webContents.send('settings:language-changed', currentUiLocale())
    if (recoveryBootstrap) {
      existing.webContents.send('plans:legacyRecoveryPreferences', recoveryBootstrap.preferences)
    }
    if (relPath) {
      if (planWindowPending.has(existing)) {
        // Renderer still loading and not yet subscribed: remember the latest
        // request; did-finish-load flushes the final choice.
        planWindowPending.set(existing, relPath)
      } else {
        existing.webContents.send('plan:open-doc', relPath)
      }
    }
  }
  const existing = planWindows.get(workspacePath)
  if (existing) {
    focusExisting(existing)
    return
  }
  // Resolved by the Host even though this window runs the core renderer over a
  // real WebSocket: one param spelling means PlanWindowApp needs a single
  // title path, shared with the packaged Plans window that cannot query at
  // all. Blank leaves the param out and it falls back to the folder name.
  // Before the window exists, so a slow answer delays the window rather than
  // showing an empty one (see peekWorkspaceDisplayName for the bound).
  const legacyPlansDisplayName = await frontendPluginManager.peekWorkspaceDisplayName(workspacePath)
  // Checked AGAIN after the await: two window:openPlans for the same workspace
  // (a double-click on the sidebar row while the backend is slow) both pass
  // the check above before either registers a window, since registration
  // happens below the await. Whichever resumes first creates and registers
  // its window synchronously; the second then sees it here and focuses it
  // instead of opening a duplicate that the registry would never know about.
  const raced = planWindows.get(workspacePath)
  if (raced) {
    focusExisting(raced)
    return
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Plans',
    // The only Host window that still took the system's frame. On Windows and
    // Linux that made it the odd one out — every other window in the app draws
    // its own bar there — so it hides the bar and PlanWindowApp draws the
    // replacement. macOS keeps the system frame it has always had: hiding it
    // there would change a window that is not in the fix's scope, and the
    // traffic lights it would then need are the thing that already works.
    ...drawnFrameWhereNeeded(),
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Hosts an AiCliDock terminal — see the main window for why throttling
      // must stay off.
      backgroundThrottling: false
    }
  })
  planWindows.set(workspacePath, win)
  navideAuxWindows.add(win)
  win.once('closed', () => navideAuxWindows.delete(win))
  watchRendererCrashes(win, { kind: 'plans', log: warnMain, fault: recordRendererGone })
  // Restored as a plain Plans window: which of the two implementations serves
  // it next launch is decided then, by the router, exactly as it is here.
  trackAuxWindow(win, { kind: 'plans', workspace_path: workspacePath })
  // Registered before the renderer subscribes to plan:open-doc. Track the plan
  // this window was launched for; a click on a different plan during load
  // overwrites it, and did-finish-load re-sends the final choice if it differs.
  const initialRelPath = relPath ?? ''
  planWindowPending.set(win, initialRelPath)
  win.webContents.once('did-finish-load', () => {
    const pending = planWindowPending.get(win)
    planWindowPending.delete(win)
    if (pending && pending !== initialRelPath) {
      win.webContents.send('plan:open-doc', pending)
    }
  })
  win.on('closed', () => {
    planWindowPending.delete(win)
    planWindows.remove(workspacePath, win)
    // Its embedded AI panel ends with the window (not on app quit).
    frontendPluginManager.endDockSurface('plans', workspacePath)
  })
  loadWindow(win, {
    window: 'plans',
    workspace_path: workspacePath,
    locale: currentUiLocale(),
    ...(legacyPlansDisplayName ? { workspace_display_name: legacyPlansDisplayName } : {}),
    ...(plansRecoveryEnabled ? { legacy_plans_recovery: '1' } : {}),
    ...(relPath ? { rel_path: relPath } : {})
  })
}

ipcMain.handle('window:openPlans', async (_event, args: { workspace_path?: string; rel_path?: string }) => {
  const workspacePath = (args?.workspace_path ?? '').trim()
  if (!workspacePath) return { ok: false }
  const relPath = (args?.rel_path ?? '').trim()
  return { ok: await openPlanWindow(workspacePath, relPath || undefined) }
})

ipcMain.handle(
  'plans:projectLegacyPreferences',
  async (event, args: { workspace_path?: unknown; values?: unknown }) => {
    const hostWindow = trustedPlansPreferenceHost(event)
    const requestedWorkspace = typeof args?.workspace_path === 'string'
      ? args.workspace_path
      : ''
    const registeredWorkspace = hostWindow
      ? isTrustedPluginManagementSender(event, mainWindows)
        ? registeredGitLeftWorkspace(
            hostWindow,
            requestedWorkspace,
            mainWindowWorkspaces,
            normalizeWorkspacePath,
          )
        : planWindows.workspaceForWindow(hostWindow)
      : null
    const workspacePath = registeredWorkspace &&
      normalizeWorkspacePath(registeredWorkspace) === normalizeWorkspacePath(requestedWorkspace)
      ? registeredWorkspace
      : null
    if (
      !workspacePath ||
      args?.values === null ||
      typeof args?.values !== 'object' ||
      Array.isArray(args.values)
    ) {
      return { ok: false, error: 'untrusted or invalid Plans preference projection' }
    }
    const values = args.values as Record<string, unknown>
    const projection: LegacyPlansPreferenceProjection = {}
    for (const key of Object.keys(values)) {
      if (
        key === 'plans.filter' ||
        key === 'plans.sort' ||
        key === 'plans.sortdir' ||
        key === 'plans.group' ||
        key === 'plans.collapsed' ||
        key === 'plans.recent' ||
        key === 'plans.pinned'
      ) {
        const value = values[key]
        if (typeof value === 'string') projection[key] = value
      }
    }
    return projectPlansLegacyPreferences(workspacePath, projection)
  },
)

ipcMain.handle(
  'plans:getLegacyRecoveryPreferences',
  async (event): Promise<LegacyPlansPreferenceProjection | null> => {
    const workspacePath = trustedPlansRecoveryWorkspace(event)
    if (!workspacePath) return null
    const recovery = await getPlansLegacyRecoveryBootstrap(workspacePath)
    return recovery?.preferences ?? null
  },
)

// Git History: routes to the unified Git plugin window (its History view). The
// dedicated `?window=githistory` renderer it used to open is gone.
ipcMain.handle('window:openGitHistory', async (_event, args: { workspace_path?: string }) => {
  const workspacePath = (args?.workspace_path ?? '').trim()
  if (!workspacePath) return { ok: false }
  const ok = await openGitWindow(workspacePath)
  return { ok }
})

// Plan execute dispatch: the plan window hands an approved plan to a CLI
// agent. Focus the main window bound to the plan's workspace and forward the
// payload; that renderer creates/reuses the agent pane and injects the
// execution prompt. delivered:false when no main window is open for the
// workspace (the renderer-side handler re-validates the workspace anyway).
function dispatchPlanExecution(args: { workspace_path?: string; rel_path?: string; agent_key?: string }): { delivered: boolean } {
  const workspacePath = String(args?.workspace_path ?? '').trim()
  const relPath = String(args?.rel_path ?? '').trim()
  const agentKey = String(args?.agent_key ?? '').trim()
  if (!workspacePath || !relPath || !agentKey) return { delivered: false }
  if (refuseDisabledBuiltin('navide.plans', null, false)) return { delivered: false }
  const win = findMainWindowForWorkspace(workspacePath)
  if (!win || win.isDestroyed()) return { delivered: false }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('plans:execute-dispatch', {
    workspace_path: workspacePath,
    rel_path: relPath,
    agent_key: agentKey
  })
  return { delivered: true }
}

ipcMain.handle('plans:dispatch-execution', (_event, args) => dispatchPlanExecution(args))
frontendPluginManager.setPlansShellHandlers({ dispatchExecution: dispatchPlanExecution, openPath: openShellPath })

// Dispatch outcome from the main window, forwarded to the workspace's plan
// window so it can confirm (toast) or roll back the execution record. Silently
// dropped when the plan window is gone — the plan window's dispatch timeout
// covers that case.
ipcMain.on(
  'plans:execution-result',
  (event, args: { workspace_path?: string; rel_path?: string; ok?: boolean; reason?: string }) => {
    const workspacePath = String(args?.workspace_path ?? '').trim()
    const relPath = String(args?.rel_path ?? '').trim()
    if (!workspacePath || !relPath) return
    // Only the workspace's main renderer can acknowledge a dispatch. Plugin
    // views receive the result through their sender-bound private event port.
    const main = findMainWindowForWorkspace(workspacePath)
    if (!main || main.webContents.id !== event.sender.id) return
    frontendPluginManager.forwardPlansExecutionResult({
      workspace_path: workspacePath,
      rel_path: relPath,
      ok: args?.ok === true,
      ...(args?.reason ? { reason: String(args.reason) } : {}),
    })
    const win = planWindows.get(workspacePath)
    if (!win) return
    win.webContents.send('plans:execution-result', {
      workspace_path: workspacePath,
      rel_path: relPath,
      ok: args?.ok === true,
      ...(args?.reason ? { reason: String(args.reason) } : {})
    })
  }
)

// Editor-window AI Chat fetches a CLI pane's cleaned scrollback. Panes live in
// the main window(s), so relay the request there and await the matching reply
// (correlation id + timeout; see cli-buffer-relay.ts).
const cliBufferRelay = new CliBufferRelay()

ipcMain.on(CLI_BUFFER_REPLY_CHANNEL, (_event, requestId: string, result: CliPaneBufferResult) => {
  cliBufferRelay.handleReply(requestId, result)
})

ipcMain.handle('cli:get-pane-buffer', (_event, paneId: string): Promise<CliPaneBufferResult> => {
  const targets = [...mainWindows].filter((w) => !w.isDestroyed()).map((w) => w.webContents)
  return cliBufferRelay.request(targets, String(paneId ?? ''))
})

// Resource Manager row actions. The window is machine-wide, so the pane it
// names may belong to any main window; the relay asks them all and takes the
// answer from whichever one owns it (see pane-action-relay.ts).
const paneActionRelay = new PaneActionRelay()

ipcMain.on(PANE_ACTION_REPLY_CHANNEL, (event, requestId: string, result: PaneActionResult) => {
  // A jump only reveals the pane inside its window; bringing that window to the
  // front is main's job, and the sender is the window that claimed the pane.
  if (result?.focused) {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner && !owner.isDestroyed()) {
      if (owner.isMinimized()) owner.restore()
      owner.show()
      owner.focus()
    }
  }
  paneActionRelay.handleReply(requestId, result)
})

ipcMain.handle(
  'pane:action',
  (_event, args: { paneId?: string; action?: PaneActionKind }): Promise<PaneActionResult> => {
    const paneId = String(args?.paneId ?? '')
    if (!paneId) return Promise.resolve({ error: 'not-found' })
    const action: PaneActionKind = args?.action === 'reclaim' ? 'reclaim' : 'focus'
    const targets = [...mainWindows].filter((w) => !w.isDestroyed()).map((w) => w.webContents)
    return paneActionRelay.request(targets, paneId, action)
  }
)

// Cross-window pane drop fallback. Same-app cross-window drops that land on
// an accepting drop target are delivered directly by Chromium and handled
// there; this path covers a release that NO drop target consumed (the source
// sees dropEffect 'none' in its dragend and reports the release point), and
// we hand it to the window under that point. Valid targets: the editor window
// plus every main window (other workspaces and detached group windows). Every
// OTHER app window still participates in the hit-test as an occluder, so a
// release on e.g. the Plans window never falls through to a main window
// covered underneath it.
ipcMain.on(
  PANE_DRAG_END_CHANNEL,
  (event, args: { paneId?: string; paneIds?: string[]; screenX?: number; screenY?: number }) => {
    const paneId = String(args?.paneId ?? '')
    if (!paneId) return
    // A multi-select drag reports every pane it carried; older senders report
    // only paneId, so the batch falls back to that single pane.
    const paneIds = Array.isArray(args?.paneIds)
      ? args.paneIds.map((id) => String(id)).filter(Boolean)
      : []
    const point = { x: Number(args?.screenX ?? 0), y: Number(args?.screenY ?? 0) }
    const sender = BrowserWindow.fromWebContents(event.sender)
    // A release inside the source window's own bounds means the user let go
    // over their own window (a non-drop area, or an Esc cancel) — the drag
    // keeps that window foreground, so never route to whatever sits beneath.
    if (sender && !sender.isDestroyed()) {
      const b = sender.getBounds()
      if (point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height) {
        return
      }
    }
    const validTargets = new Set<BrowserWindow>(mainWindows)
    const windows: CandidateWindow<BrowserWindow>[] = []
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      windows.push({
        id: win.id,
        bounds: win.getBounds(),
        visible: win.isVisible(),
        minimized: win.isMinimized(),
        window: win
      })
    }
    const candidates = selectDropCandidates(
      windows,
      sender?.id ?? null,
      (id) => windowFocusSeq.get(id) ?? 0
    )
    const win = hitTestWindows(point, candidates)
    if (!win || !validTargets.has(win)) return
    win.webContents.send(EXTERNAL_PANE_DROP_CHANNEL, {
      paneId,
      paneIds: paneIds.length > 1 ? paneIds : [paneId],
      screenX: point.x,
      screenY: point.y
    })
  }
)

// Native OS notification for CLI state changes (turn done / needs input). The
// renderer decides WHEN to call this (background-only, deduped) and supplies the
// already-localized title/body; main stays i18n-agnostic. Clicking the
// notification restores+focuses the most-recent main window and tells its
// renderer which pane to switch to via `notify:focusPane`.
ipcMain.handle(
  'window:notify',
  (event, args: { paneId?: string; title?: string; body?: string; silent?: boolean }): { ok: boolean } => {
    if (!Notification.isSupported()) return { ok: false }
    const title = String(args?.title ?? '').trim()
    if (!title) return { ok: false }
    const notification = new Notification({
      title,
      body: String(args?.body ?? ''),
      // The renderer's sound toggle covers the OS notification sound too;
      // otherwise "sound off" still dings through macOS.
      silent: args?.silent === true,
    })
    const paneId = String(args?.paneId ?? '')
    notification.on('click', () => {
      const win =
        BrowserWindow.fromWebContents(event.sender) ??
        (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
      if (!win) return
      revealMainWindow(win)
      if (paneId) win.webContents.send('notify:focusPane', paneId)
    })
    notification.show()
    return { ok: true }
  }
)

// Dock badge (macOS-only, Terminal.app-style): a number for how many panes have
// unseen done/attention activity. The renderer tracks WHEN to update it
// (useSystemNotify's pendingCount); main just reflects the count.
ipcMain.on('window:setBadgeCount', (event, count: number) => {
  if (!isMac()) return
  app.dock?.setBadge(count > 0 ? String(count) : '')
  // Mirror the count onto the sender window's own Dock tile (Terminal.app-style):
  // the system red badge shows on its thumbnail while the window is minimized.
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    setWindowDockTileBadge(win, count > 0 ? String(count) : '')
  }
})

ipcMain.handle(
  'dialog:saveJson',
  async (
    _event,
    args: { defaultName?: string; content: string; title?: string }
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> => {
    const defaultName = args?.defaultName ?? 'export.json'
    const ext = defaultName.includes('.') ? defaultName.slice(defaultName.lastIndexOf('.') + 1) : 'json'
    const extFilters: Record<string, { name: string; extensions: string[] }> = {
      md:   { name: 'Markdown', extensions: ['md'] },
      json: { name: 'JSON',     extensions: ['json'] },
      txt:  { name: 'Text',     extensions: ['txt'] },
    }
    const primaryFilter = extFilters[ext] ?? { name: ext.toUpperCase(), extensions: [ext] }
    const opts: Electron.SaveDialogOptions = {
      title: args?.title ?? 'Export',
      defaultPath: defaultName,
      filters: [
        primaryFilter,
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      const fs = await import('node:fs/promises')
      await fs.writeFile(result.filePath, args.content, 'utf-8')
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  }
)

ipcMain.handle(
  'dialog:openJson',
  async (
    _event,
    args?: { title?: string }
  ): Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }> => {
    const opts: Electron.OpenDialogOptions = {
      title: args?.title ?? 'Import JSON',
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    }
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    try {
      const fs = await import('node:fs/promises')
      const content = await fs.readFile(result.filePaths[0], 'utf-8')
      return { ok: true, path: result.filePaths[0], content }
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  }
)

async function pickFilePath(args?: {
  title?: string
  filters?: Electron.FileFilter[]
  defaultPath?: string
}): Promise<string | null> {
  const opts: Electron.OpenDialogOptions = {
    title: args?.title ?? 'Select File',
    properties: ['openFile'],
    filters: args?.filters ?? [{ name: 'All Files', extensions: ['*'] }],
  }
  if (args?.defaultPath) opts.defaultPath = args.defaultPath
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

ipcMain.handle(
  'dialog:pickFile',
  async (
    _event,
    args?: { title?: string; filters?: Electron.FileFilter[]; defaultPath?: string }
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean }> => {
    const path = await pickFilePath(args)
    return path ? { ok: true, path } : { ok: false, canceled: true }
  }
)

ipcMain.handle(
  'dialog:pickFiles',
  async (
    _event,
    args?: { title?: string; filters?: Electron.FileFilter[]; defaultPath?: string }
  ): Promise<{ ok: boolean; paths?: string[]; canceled?: boolean }> => {
    const opts: Electron.OpenDialogOptions = {
      title: args?.title ?? 'Select Files',
      properties: ['openFile', 'multiSelections'],
      filters: args?.filters ?? [{ name: 'All Files', extensions: ['*'] }],
    }
    if (args?.defaultPath) opts.defaultPath = args.defaultPath
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    return { ok: true, paths: result.filePaths }
  }
)

/** Where copies of temp-backed drops live; see dropped-file-store.ts. */
const droppedFilesDir = (): string => join(app.getPath('userData'), 'dropped-files')

ipcMain.handle(
  'drop:stabilize',
  async (_event, paths: string[]): Promise<{ ok: boolean; paths: string[] }> => {
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
      return { ok: false, paths: [] }
    }
    return { ok: true, paths: await stabilizeDroppedPaths(paths, droppedFilesDir()) }
  }
)

ipcMain.handle(
  'clipboard:saveImage',
  async (
    _event,
    args: { bytes: Uint8Array; mediaType: string }
  ): Promise<{ ok: boolean; path?: string }> => {
    const bytes = args?.bytes
    if (!(bytes instanceof Uint8Array) || typeof args?.mediaType !== 'string') {
      return { ok: false }
    }
    const path = await saveClipboardImage(bytes, args.mediaType, droppedFilesDir())
    return path ? { ok: true, path } : { ok: false }
  }
)

// Sweep stale copies once per launch. Deliberately not awaited: startup must
// not wait on it, and a failed prune only costs disk.
app.whenReady().then(() => void pruneDroppedFiles(droppedFilesDir()))

ipcMain.handle('shell:openTerminal', async (event, command: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  if (!command || typeof command !== 'string') return { ok: false, error: 'invalid command' }
  // Run the install command in a visible terminal (sudo / OAuth prompts need
  // a real TTY). Which terminal is the platform's business — see
  // external-terminal.ts; this used to be AppleScript only. The login-shell
  // PATH, not this process's: a Linux .desktop launch has no nvm on PATH,
  // and `npm install -g` in the terminal has to find npm.
  return await openInExternalTerminal(command, getResolvedUserPath())
})

// macOS TCC permissions (onboarding wizard). Requests are user-initiated only —
// a request may raise a system prompt, status never does.
ipcMain.handle('permissions:status', async (event) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  return await getPermissionStatuses()
})

ipcMain.handle(
  'permissions:request',
  async (event, key: PermissionKey, payload?: { title?: string; body?: string }) => {
    if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
    return await requestPermission(key, payload)
  }
)

// Voice input: ask macOS for microphone access right before the first capture.
// Only the voice feature calls this, and only once the user turned it on and
// pressed the hotkey — nothing prompts at startup. Elsewhere there is no OS
// gate beyond getUserMedia itself, so this answers granted.
ipcMain.handle('media:ask-microphone', async () => {
  if (!isMac()) return { granted: true, status: 'not-applicable', prompted: false }
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return { granted: true, status, prompted: false }
  // 'denied'/'restricted' never prompt again; askForMediaAccess answers false.
  // 'not-determined' shows the system dialog: `prompted` lets the caller know
  // the user spent this press answering it rather than speaking.
  const granted = await systemPreferences.askForMediaAccess('microphone')
  return { granted, status: granted ? 'granted' : status, prompted: status === 'not-determined' }
})

ipcMain.handle('permissions:open-settings', async (event, key: PermissionKey) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    await openPermissionSettings(key)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

function revealShellPath(target: string): { ok: boolean; error?: string } {
  if (!target || typeof target !== 'string') return { ok: false, error: 'invalid path' }
  try {
    shell.showItemInFolder(target)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

async function openShellPath(target: string): Promise<{ ok: boolean; error?: string; revealed?: boolean }> {
  if (!target || typeof target !== 'string') return { ok: false, error: 'invalid path' }
  // shell.openPath returns an empty string on success, or an error message.
  const err = await shell.openPath(target)
  if (err) {
    // If openPath failed (e.g. file doesn't exist), try revealing the parent
    // directory in Finder so the user can navigate from there.
    if (revealShellPath(target).ok) {
      return { ok: true, revealed: true }
    }
    return { ok: false, error: err }
  }
  return { ok: true }
}

ipcMain.handle('shell:openPath', async (event, target: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  return openShellPath(target)
})

ipcMain.handle('shell:revealPath', async (event, target: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  return revealShellPath(target)
})

// A one-time confirmation for one trust-changing action, minted here because
// the key that signs it never leaves the main process. Only a window can reach
// this — MCP and the plugin broker talk to the backend directly and have no
// path to it, which is exactly the difference the backend is checking for.
//
// The action list is closed: a caller naming anything else gets nothing, so a
// compromised renderer cannot mint a confirmation for a message type this was
// never meant to cover.
const TRUST_CONFIRM_ACTIONS = new Set([
  'p2p.policy.set',
  'p2p.trust.device.unpair',
  'p2p.trust.device.defer',
  'p2p.trust.block',
  'p2p.trust.unblock',
  'p2p.pair.start',
  'p2p.pair.confirm',
  // Writes an allow rule for a remote sender: a policy edit by another name.
  'p2p.access_requests.approve',
  // Destroys every pairing on this machine, so it is exactly the kind of act
  // this list exists for: only a window can ask for it.
  'p2p.trust.rebuild',
  // Writes an agent-requested skill into the shared library.
  'skills.install_approval.decide',
  // Decides an agent's request to install, update, roll back or remove a
  // Navide plugin; the subject is the approval_id.
  'plugins.agent_request.decide',
  // Reports that the window carried out an approved request (B2-c); the
  // subject is the approval_id, so an agent cannot report a change itself.
  'plugins.agent_request.finish',
  // Loosening terminal command protection (switching a category off, adding
  // an allow prefix, removing a block pattern) — the backend demands a token
  // only for those, so tightening needs no prompt.
  'guard.terminal.set_category',
  'guard.terminal.add_pattern',
  'guard.terminal.remove_pattern',
  // Loosening Navide Guard's grading (lowering a built-in rule, adding an
  // allow pattern, removing a deny pattern or a protected branch).
  'guard.builtin.set_level',
  'guard.rules.add',
  'guard.rules.remove',
  'guard.branches.remove',
])
ipcMain.handle('trust:confirm', async (event, action: unknown, deviceId: unknown, subject: unknown) => {
  // Minting is the one thing this list exists to keep away from anything
  // that is not a person's window — a webview guest or an iframe gets null.
  if (!isAppWindowSender(event)) return null
  if (typeof action !== 'string' || !TRUST_CONFIRM_ACTIONS.has(action)) return null
  return mintTrustConfirmation(
    action,
    typeof deviceId === 'string' ? deviceId : '',
    typeof subject === 'string' ? subject : '',
  )
})

// The legal pages by route name, so the renderer never assembles the URL.
// A route outside the table is refused rather than guessed at.
ipcMain.handle('legal:open', async (_event, route: unknown) => {
  if (!isLegalRoute(route)) return { ok: false, error: 'unknown legal route' }
  try {
    await shell.openExternal(LEGAL_LINKS[route])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('shell:openExternal', async (event, url: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  if (!url || typeof url !== 'string') return { ok: false, error: 'invalid url' }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http/https allowed' }
  try {
    await shell.openExternal(url)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// Write read-only content (e.g. a file's HEAD version) to a temp file and open
// it with the OS default app — the equivalent of Cursor's "Open File (HEAD)".
async function openTempFilePath(
  filename: string,
  content: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!filename || typeof filename !== 'string') return { ok: false, error: 'invalid filename' }
  try {
    const artifact = await writeTempTextArtifact(tmpdir(), filename, content ?? '')
    const err = await shell.openPath(artifact.path)
    return err ? { ok: false, error: err } : { ok: true, ...artifact }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

ipcMain.handle('shell:openTempFile', async (event, filename: string, content: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  return openTempFilePath(filename, content)
})

async function readKeybindingsFile(): Promise<{ ok: boolean; content?: string; error?: string }> {
  const filePath = join(app.getPath('userData'), 'keybindings.json')
  try {
    const content = await readFile(filePath, 'utf-8')
    return { ok: true, content }
  } catch (e) {
    // "No file yet" is the normal first-run case and means no customisations.
    // Anything else — a corrupt file, a permissions problem — must not be
    // reported the same way: the renderer would fall back to defaults, the user
    // would see their bindings silently revert, and the next write would
    // overwrite the file they still had.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, content: '[]' }
    return { ok: false, error: String(e) }
  }
}

async function writeKeybindingsFile(
  content: string,
  writerId?: number,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof content !== 'string') return { ok: false, error: 'invalid content' }
  const filePath = join(app.getPath('userData'), 'keybindings.json')
  try {
    await writeFile(filePath, content, 'utf-8')
    // Each renderer keeps its own key resolver, so the Mini IDE / Git / Plan
    // windows would otherwise run the shipped defaults until reopened.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      // Skip the writer: it already applied these rules, and echoing them back
      // rebuilds its resolver a second time for nothing.
      if (writerId !== undefined && win.webContents.id === writerId) continue
      win.webContents.send('keybindings:changed', content)
    }
    frontendPluginManager.notifyEditorKeybindingsChanged(content)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// Read bytes from a file starting at a given offset. Used by the stage watcher
// to scan the outputLogFile for sentinel strings — more reliable than cleanBuffer
// which can be truncated or have scanFrom issues from Q&A injections.
ipcMain.handle('keybindings:read', () => readKeybindingsFile())

ipcMain.handle('keybindings:write', async (event, content: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  return writeKeybindingsFile(content, event.sender.id)
})

ipcMain.handle('fs:readFrom', async (event, filePath: string, fromByte: number) => {
  if (!isAppWindowSender(event)) return { ok: false, content: '' }
  if (!filePath || typeof filePath !== 'string') return { ok: false, content: '' }
  try {
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(filePath)
    // Report the real size even when there is nothing new: a tailing caller
    // detects log rotation (the file shrank below its cursor) by seeing
    // newOffset < the offset it asked for. Echoing fromByte back would hide
    // the truncation and the tail would stall forever.
    if (stat.size <= fromByte) return { ok: true, content: '', newOffset: stat.size }
    const fh = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(stat.size - fromByte)
    await fh.read(buf, 0, buf.length, fromByte)
    await fh.close()
    return { ok: true, content: buf.toString('utf-8'), newOffset: stat.size }
  } catch (e) {
    return { ok: false, content: '', newOffset: fromByte, error: String((e as Error)?.message ?? e) }
  }
})

// Canonical form of a path, over the same normalizer the main process uses for
// workspaces. The renderer has no fs access, but it needs this to tell whether
// two spellings — /tmp/wt/proj from a URL param vs /private/tmp/wt/proj from the
// OS file picker — name the same folder. Never rejects: an unresolvable path
// degrades to the trimmed input, and an empty answer simply leaves the caller
// comparing literals.
ipcMain.handle('fs:realpath', async (_event, target: string) => {
  if (typeof target !== 'string' || !target) return ''
  return normalizeWorkspacePath(target)
})

// Legacy spawnHistory fallback: find a manual-session log by filename when
// outputLogFile wasn't recorded at spawn time (see manual-log-search.ts).
ipcMain.handle('logs:findManualLog', async (_event, workspacePath: string, filename: string) => {
  if (!workspacePath || typeof workspacePath !== 'string') return { ok: false, path: null }
  try {
    const path = await findManualLogFile(workspacePath, filename)
    return { ok: true, path }
  } catch (e) {
    return { ok: false, path: null, error: String((e as Error)?.message ?? e) }
  }
})

// Agent History content search: scans each resolved log path for `query`
// (case-insensitive, ANSI-stripped) and returns the ids of files that
// matched. See log-content-search.ts for the chunked-read implementation.
ipcMain.handle(
  'logs:searchContent',
  async (_event, args: { query: string; files: Array<{ id: string; path: string }> }) => {
    if (!args || typeof args.query !== 'string' || !Array.isArray(args.files)) return { matchedIds: [] }
    const matchedIds = await searchLogFiles(args.query, args.files)
    return { matchedIds }
  }
)

ipcMain.on('app:setQuitConfirm', (_event, cfg: Partial<typeof quitConfirm>) => {
  if (cfg && typeof cfg === 'object') quitConfirm = { ...quitConfirm, ...cfg }
})

ipcMain.on('settings:language-changed', (_event, locale: string) => {
  const normalizedLocale = hostLocaleManager.setRuntimeLocale(locale)
  if (normalizedLocale) {
    frontendPluginManager.dispatchHostSettingsChanged({
      settings: { 'agent-team:language': normalizedLocale },
    })
    // The native menu is built once at startup; Electron has no API to
    // re-label it in place, so a language change has to install a new one.
    rebuildAppMenu()
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('settings:language-changed', locale)
    }
  }
})

// Zero-flash startup settings: synchronously hand the backend-owned
// ui_settings.json to the renderer before first paint. This is the app's only
// sendSync IPC; the file is a few KB so the block is microseconds. Any error
// yields '{}' — the renderer falls back to defaults and reconciles over ws
// (see ui-settings-bootstrap.ts for the path-resolution contract).
ipcMain.on('settings:bootstrap', (event) => {
  const dataDir = resolveBackendDataDir({
    envOverride: process.env.AGENT_TEAM_DATA_DIR,
    isPackaged: app.isPackaged,
    appDataPath: app.getPath('appData'),
    platform: process.platform,
    homeDir: app.getPath('home'),
    xdgDataHome: process.env.XDG_DATA_HOME,
    appData: process.env.APPDATA
  })
  event.returnValue = readUiSettingsText(join(dataDir, UI_SETTINGS_FILE))
})

ipcMain.handle('settings:health-timeout-read', () => {
  return { ok: true, timeoutSec: readHealthCheckTimeoutSec(healthTimeoutPath()) }
})

ipcMain.handle('settings:health-timeout-write', (event, timeoutSec: number) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    writeHealthCheckTimeoutSec(healthTimeoutPath(), timeoutSec)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// CDP debug toggle read/write. The port/address switches themselves are
// applied at pre-ready startup (above) — a write here only takes effect after
// the app is restarted.
ipcMain.handle('settings:cdp-debug-read', () => {
  return { ok: true, config: readCdpDebugConfig(cdpDebugPath()) }
})

ipcMain.handle('settings:cdp-debug-write', (event, config: CdpDebugConfig) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    writeCdpDebugConfig(cdpDebugPath(), config)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// Git account registry IPC. CRUD + per-workspace binding live in main because
// safeStorage (token encryption) is a main-process API; the renderer only sees
// masked accounts and, at git-op time, the decrypted credential for the bound
// account. Handlers never throw across the IPC boundary — always { ok, ... }.
ipcMain.handle('git-accounts:available', (event) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    return { ok: true, available: getGitAccountsStore().available }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:list', (event) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    return { ok: true, accounts: getGitAccountsStore().list() }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:add', (event, input: GitAccountInput) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    return { ok: true, account: getGitAccountsStore().add(input) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:update', (event, id: string, patch: Partial<GitAccountInput>) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    getGitAccountsStore().update(id, patch)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:remove', (event, id: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    getGitAccountsStore().remove(id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:bind', (event, workspacePath: string, accountId: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    getGitAccountsStore().bind(workspacePath, accountId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:unbind', (event, workspacePath: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    getGitAccountsStore().unbind(workspacePath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:getBinding', (event, workspacePath: string) => {
  if (!isAppWindowSender(event)) return UNTRUSTED_SENDER
  try {
    return { ok: true, accountId: getGitAccountsStore().getBinding(workspacePath) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

ipcMain.handle('git-accounts:getCredential', (event, workspacePath: string) => {
  // Sensitive: returns a decrypted PAT. Restrict to the top frame of a known
  // app window so a sub-frame/iframe injected into rendered content can't call
  // this to exfiltrate a token.
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || !mainWindows.has(win) || event.senderFrame?.parent) {
    return { ok: false, error: 'unauthorized' }
  }
  try {
    return { ok: true, credential: getGitAccountsStore().getCredentialForWorkspace(workspacePath) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
})

// Disable hardware-accelerated rendering entirely.
// --disable-gpu eliminates the GPU subprocess without running GPU code in-process.
// Previously we used --in-process-gpu to prevent a separate GPU process from
// crashing (SIGTERM/exit_code=15), but on macOS 26.5 + Electron 33 the
// Chrome_InProcGpuThread crashes on shutdown inside fontations_ffi teardown
// (SIGSEGV at 0x18).  --disable-gpu avoids both problems.
// WebSocket stability is now handled by the 50ms batch + 64KB cap in terminals.py.
//
// The unavoidable cost is that xterm's WebGL renderer can never initialise, so
// every terminal falls back to the DOM renderer — which rewrites a row of DOM
// nodes per write and is the dominant cost of typing latency with many panes.
// NAVIDE_ENABLE_GPU=1 opts back in so the shutdown crash can be re-tested on a
// newer macOS/Electron without shipping the risk to everyone: the failure mode
// is a crash on quit, so the default stays off until it is proven fixed.
// Re-tested 2026-08-09 on macOS 27.0 + Electron 33.4.11: four launch/quit
// cycles with the GPU enabled produced no crash reports, no surviving
// processes, and none of the `ContextResult::kFatalFailure: Failed to create
// context` errors that used to appear ~15 times per 30 s while --disable-gpu
// was in force. The macOS 26.5 premise no longer holds, so acceleration is on
// by default and the DOM-renderer fallback is no longer forced on every pane.
// Caveat on that evidence: the quits were driven by SIGTERM, not a user Cmd+Q.
// NAVIDE_DISABLE_GPU=1 restores the old behaviour if the shutdown crash ever
// resurfaces.
// Verified 2026-08-24 (Apple M4, Electron from this tree): under this default
// configuration an offscreen probe created a hardware webgl2 context (ANGLE
// Metal, gpu_compositing enabled), so terminals get the WebGL renderer unless
// NAVIDE_DISABLE_GPU=1 is set.
const gpuDisabled = process.env.NAVIDE_DISABLE_GPU === '1'
if (gpuDisabled) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  console.warn(
    '[main] NAVIDE_DISABLE_GPU=1 — hardware acceleration disabled; ' +
      'terminals fall back to the DOM renderer.'
  )
}

// Chrome DevTools Protocol (CDP) debug toggle (Settings > MCP > External
// access). Must be applied before the app is ready — Electron only honors
// --remote-debugging-port set at this point. readCdpDebugConfig resolves any
// read/parse failure to disabled, so a bad file can never turn this on.
const cdpDebugConfig = readCdpDebugConfig(cdpDebugPath())
if (cdpDebugConfig.enabled) {
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpDebugConfig.port))
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
}

// Linux keyring preflight: falls back to --password-store=basic when no
// unlocked Secret Service keyring exists, so Chromium never raises a blocking
// keyring dialog. Must run before the app is ready; a no-op off Linux.
linuxKeyringDowngraded = applyLinuxKeyringPreflight(app.commandLine)

// Voice readback on Linux needs speech-dispatcher; a no-op off Linux.
applyLinuxSpeechDispatcher(app.commandLine)

// Folder paths handed to the app from outside (Finder "Open With", a macOS
// Quick Action, or CLI args) open as workspaces. Paths that arrive via the
// `open-file` event before the app is ready (cold launch) are queued here and
// drained in whenReady once a window can be created.
const pendingOpenPaths: string[] = []

// Resolve an incoming path to a workspace folder (a file resolves to its parent)
// and open it in a new main window. Returns false if the path doesn't exist.
function openWorkspaceFromPath(p: string): boolean {
  const target = (p ?? '').trim()
  if (!target) return false
  let dir: string
  try {
    dir = statSync(target).isDirectory() ? target : dirname(target)
  } catch {
    return false
  }
  if (app.isReady()) {
    console.log('[main] open workspace from external path:', dir)
    // If a window already has this workspace open, focus it instead of duplicating.
    const existing = findMainWindowForWorkspace(dir)
    if (existing) {
      revealMainWindow(existing)
      return true
    }
    // The app is usually backgrounded when a Quick Action / "Open With" fires,
    // so bring it to the front and focus the new window — otherwise the window
    // opens behind Finder and looks like nothing happened.
    void createWindow({ workspace_path: dir }).then((win) => {
      app.focus({ steal: true })
      win.focus()
    })
  } else {
    console.log('[main] queue workspace from external path (pre-ready):', dir)
    pendingOpenPaths.push(dir)
  }
  return true
}

// Pull workspace folder paths out of a process argv array (cold-start CLI args
// or a relaunch's second-instance argv). Skips flags and the executable itself.
function workspacePathsFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => a && !a.startsWith('-') && existsSync(a))
}

// macOS delivers folders/files opened via Finder, "Open With", or a Quick Action
// (`open -b <bundleid> <path>`) through this event — the canonical way to receive
// an external path. Register it as early as possible so launch-time events queue.
app.on('open-file', (event, p) => {
  event.preventDefault()
  openWorkspaceFromPath(p)
})

// navide://extension/<id> links (see deep-link.ts). A link that arrives before
// a main window can show it waits in the router's queue; windows are only
// created for it once startup has opened (or skipped) its own.
let startupWindowsSettled = false
const deepLinks = createDeepLinkRouter({
  pickTarget: (ready) => {
    if (mainWindow && !mainWindow.isDestroyed() && ready.has(mainWindow.webContents.id)) {
      return mainWindow.webContents
    }
    const win = [...mainWindows].find((w) => !w.isDestroyed() && ready.has(w.webContents.id))
    return win ? win.webContents : null
  },
  reveal: (contents) => {
    const win = BrowserWindow.fromWebContents(contents)
    if (win) revealMainWindow(win)
  },
  ensureWindow: () => {
    if (startupWindowsSettled) focusOrCreateMainWindow()
  },
  log: (message) => console.log(message),
})
// macOS delivers the scheme through this event, on a cold start too (before
// ready), so it is registered at the top level like open-file.
app.on('open-url', (event, url) => {
  event.preventDefault()
  deepLinks.handle(url)
})

// Single-instance lock: a second launch must NOT spawn a parallel backend.
// On macOS, closing the window leaves the app alive (see window-all-closed
// below), so relaunching from Finder/Dock would otherwise start a second main
// process — each spawning its own backend that fights over the shared
// ~/.agent-team state, while the orphaned backend is never reaped.
//
// Packaged builds only. In dev, electron-vite owns the process lifecycle and
// restarts often; an instance that didn't exit cleanly (Ctrl+C not reaping the
// Electron child, or macOS keeping the app alive after the window closed) would
// hold the lock and make the next `npm run dev` silently quit at launch.
const gotSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // Packaged builds only: a dev run would register the bare Electron binary as
  // the system-wide handler. The packaged app also declares the scheme in its
  // Info.plist / installer (package.json build.protocols).
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  app.on('second-instance', (_event, argv) => {
    // Windows/Linux hand a clicked navide:// link to the running instance as
    // an argv entry of the relaunch.
    const link = deepLinkFromArgv(argv)
    if (link) {
      deepLinks.handle(link)
      return
    }
    // A relaunch carrying folder paths (e.g. a Quick Action that still uses
    // `open -n`) lands here because we hold the single-instance lock. Open the
    // folders as workspaces instead of dropping them.
    const paths = workspacePathsFromArgv(argv)
    if (paths.length) {
      for (const dir of paths) openWorkspaceFromPath(dir)
      return
    }
    // Plain relaunch with no path: focus the existing window (or create one) and
    // reuse the running backend instead of booting another.
    focusOrCreateMainWindow()
  })
}

// Lock down top-level navigation. By default, dropping a file onto a window (or
// any stray location change) navigates the whole window to that URL, replacing
// the app with e.g. a raw .js file's source. This app is a single index.html
// SPA — it never legitimately navigates away — so allow only the dev-server
// origin (HMR/reloads) and our own index.html, and deny every window.open
// except external http(s) links routed to the OS browser.
const DEV_ORIGIN = process.env['ELECTRON_RENDERER_URL']
  ? new URL(process.env['ELECTRON_RENDERER_URL']).origin
  : null
function isAppNavigation(url: string): boolean {
  try {
    const u = new URL(url)
    if (DEV_ORIGIN && u.origin === DEV_ORIGIN) return true
    if (u.protocol === 'file:') return u.pathname.endsWith('/renderer/index.html')
  } catch {
    // Malformed URL — treat as not-app and block.
  }
  return false
}
app.on('web-contents-created', (_e, contents) => {
  // Page zoom is owned by the app's interface-scale setting, not by Chromium's
  // retained per-origin zoom or a pinch gesture. Tracking every WebContents
  // here is what lets one Settings change scale all windows at once — including
  // the plugin bundles, which have their own documents and no host preload.
  //
  // A <webview> guest is laid out inside an already-scaled host document and
  // shares its embedder's zoom, so scaling it again would compound. A native
  // WebContentsView composites outside the DOM and does need its own factor.
  const zoom = uiZoomStore()
  const scalable = contents.getType() !== 'webview'
  if (scalable) {
    zoom.track(contents)
    contents.once('destroyed', () => zoom.untrack(contents))
  }
  lockPageZoom(
    contents,
    () => {
      if (!contents.isDestroyed()) contents.send('window:zoom-changed')
    },
    () => (scalable ? zoom.get() : 1)
  )
  // Electron has no default right-click menu; without this one, right-click is
  // inert everywhere and there is no fallback path for copy/paste.
  installContextMenu(contents)
  // Every window's console warnings and errors reach renderer-console.log (a
  // black window on Windows left no trace before); only Navide's own pages.
  // The chat-attachment print window loads that attachment from file:; its
  // console (cancelled requests and their URLs) is the attachment's, not ours.
  watchConsoleMessages(contents, {
    log: logRendererConsole,
    appOrigin: DEV_ORIGIN,
    skip: () => contents.session === session.fromPartition(PDF_PARTITION),
  })
  contents.on('will-navigate', (e, url) => {
    // A plugin web view enforces its own http(s) allowlist (pluginWebViews.ts).
    if (isPluginWebGuest(contents)) return
    if (!isAppNavigation(url)) e.preventDefault()
  })
  guardPlanFrameNavigation(contents, () => isPluginWebGuest(contents))
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
})
// A renderer of a window without its own crash watch, and a GPU or utility
// process, going away was logged nowhere.
watchProcessGone(app, { log: warnMain, alreadyWatched: isRendererCrashWatched })
registerTerminalContextMenu()

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return
  protocol.handle(PLUGIN_FRAME_SCHEME, handlePluginFrameAssetRequest)
  // Keeps every permission on Electron's default (allow) except `media`, which
  // only a main window's own renderer gets, audio only. See media-permissions.ts.
  installMediaPermissionHandlers(session.defaultSession, (wc) =>
    wc !== null && [...mainWindows].some((w) => !w.isDestroyed() && w.webContents.id === wc.id)
  )
  // The fn (🌐) key helper for voice input; spawned only on a renderer's request.
  const fnKey = registerFnKeyIpc((wc) =>
    [...mainWindows].some((w) => !w.isDestroyed() && w.webContents.id === wc.id)
  )
  app.on('will-quit', () => fnKey.dispose())
  // Settings → Resource limits: Spotlight's privacy settings, opened on request.
  registerSpotlightSettingsIpc(ipcMain, {
    openExternal: (url) => shell.openExternal(url),
    isTrusted: (event) => isAppWindowSender(event),
    isMac,
  })
  // Settings → Voice → Read aloud: Spoken Content, to download a better voice.
  registerSpokenContentSettingsIpc(ipcMain, {
    openExternal: (url) => shell.openExternal(url),
    isTrusted: (event) => isAppWindowSender(event),
    isMac,
  })
  registerDeepLinkIpc(deepLinks, (wc) =>
    [...mainWindows].some((w) => !w.isDestroyed() && w.webContents.id === wc.id)
  )
  // Windows/Linux cold start: the link is a launch argument.
  const launchLink = app.isPackaged ? deepLinkFromArgv(process.argv) : null
  if (launchLink) deepLinks.handle(launchLink)
  // A disabled Git gets no legacy view either; Enable registers it then.
  if (gitRecoveryEnabled && !frontendPluginManager.isBuiltinPluginDisabled('navide.git')) {
    registerForcedLegacyGit()
  }
  // The plugin-view dev entry is opt-in via AGENT_TEAM_PLUGIN_DEV=1 so the
  // default menu / UI is unchanged for every normal launch (dev or packaged).
  // This mode keeps the fixed first-party dist-plugins bundles available for
  // local app development. An optional explicit package path is a separate
  // Host-owned seam; it never scans an arbitrary parent directory or carries
  // Registry provenance. Packaged builds never enter Developer Mode.
  const pluginDevEnabled = pluginDeveloperModeEnabled(process.env, app.isPackaged)
  if (pluginDevEnabled) {
    // Dev-only: prefer the local Manifest v2 bundle. The old descriptor is a
    // recovery artifact and must not be the normal developer override.
    const devMiniIde = loadPluginDir(bundledMiniIdeV2Dir(miniIdeSource))
    const devDescriptor = devMiniIde.descriptor
    if (devDescriptor && hasValidMiniIdeV2Descriptor(devDescriptor)) {
      frontendPluginManager.registerDeveloperDescriptor(devDescriptor)
    } else {
      console.warn(
        `[main] AGENT_TEAM_PLUGIN_DEV=1 but Mini-IDE v2 dev bundle is unavailable: ${devMiniIde.error ?? 'invalid contribution'}`
      )
    }
    // Dev-only: keep the already selected combined Plans package when startup
    // has loaded one. A second backend for the same plugin id cannot be
    // registered safely, so the legacy bundle is considered only when no v2
    // package/backend pair is active.
    const devPlansV2Package = devPlansV2PluginBundle(app.getVersion())
    const activePlansDescriptor = frontendPluginManager.getDescriptor('navide.plans')
    let devPlansV2Registered = Boolean(
      activePlansDescriptor?.capabilityPolicy?.kind === 'manifest-v2' &&
        activePlansDescriptor.packageVersion &&
        activePlansDescriptor.packageDir &&
        hasCompletePlansContributions(activePlansDescriptor) &&
        frontendPluginManager.hasBackendActivation(
          'navide.plans',
          activePlansDescriptor.packageVersion,
        )
    )
    if (devPlansV2Package && !devPlansV2Registered) {
      try {
        frontendPluginManager.registerDeveloperDescriptor(devPlansV2Package.descriptor)
        frontendPluginManager.registerBackendActivation(devPlansV2Package.activation)
        devPlansV2Registered = true
      } catch (error) {
        console.warn(
          `[main] AGENT_TEAM_PLUGIN_DEV=1 but Plans v2 backend activation was rejected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    if (!devPlansV2Registered) {
      const devPlansDescriptor = devPlansPluginDescriptor()
      if (existsSync(devPlansDescriptor.entryFile)) {
        frontendPluginManager.registerDeveloperDescriptor(devPlansDescriptor)
      } else {
        console.warn(
          '[main] AGENT_TEAM_PLUGIN_DEV=1 but Plans dev bundle is missing — run `pnpm run build:plans`'
        )
      }
    }
    const explicitPackageDir = process.env['AGENT_TEAM_PLUGIN_DEV_PATH']
    // Review MED-1 on #428: the root-signed takedown list applies here too.
    const explicitTakedown = explicitPackageDir === undefined ? null : developerFolderTakedown(explicitPackageDir)
    if (explicitTakedown) {
      console.warn(`[main] AGENT_TEAM_PLUGIN_DEV_PATH was not loaded: ${explicitTakedown}`)
    } else if (explicitPackageDir !== undefined) {
      const explicitResult = frontendPluginManager.loadExplicitDeveloperPlugin(explicitPackageDir)
      if (!explicitResult.loaded) {
        console.warn(
          `[main] AGENT_TEAM_PLUGIN_DEV_PATH was not loaded: ${explicitResult.error}`
        )
      }
    }
  }
  appMenuHooks = {
    onOpenSettings: () => sendMenuAction('open-settings'),
    onCheckUpdates: () => sendMenuAction('check-updates'),
    onOpenWorkspace: () => sendMenuAction('open-workspace'),
    onOpenRecent: (path: string) => sendMenuAction('open-recent:' + path),
    onNewWindow: () => void createWindow(),
    onOpenPipelineManager: () => requestPipelineManager(),
    onOpenResourceManager: () => requestResourceManager(),
    onOpenTurnStats: () => requestTurnStats(),
    onOpenTokenMonitor: () => requestTokenMonitor(),
    onOpenAccount: () => sendMenuAction('open-account'),
    onOpenRepo: () => void shell.openExternal('https://github.com/Navide-dev/Navide'),
    onReportIssue: () => void shell.openExternal('https://github.com/Navide-dev/Navide/issues'),
    onShowShortcuts: () => sendMenuAction('show-shortcuts'),
    onShowWhatsNew: () => sendMenuAction('show-whats-new'),
    onShowWelcomeTour: () => sendMenuAction('show-welcome-tour'),
    onOpenLegal: (route) => void shell.openExternal(LEGAL_LINKS[route]),
    onReloadWindow: (target) => {
      void windowCloseCoordinator.prepareAndReload(target)
      // Handled synchronously from the menu's point of view whenever the target
      // belongs to a window with close participants; the coordinator reloads it
      // after preparation (or leaves it alone on refusal).
      const window = BrowserWindow.fromWebContents(target)
      return Boolean(window && frontendPluginManager.hasWindowCloseParticipants(window))
    },
    ...(pluginDevEnabled
      ? {
          onOpenNoopPlugin: () => {
            const host = BrowserWindow.getFocusedWindow() ?? mainWindow
            if (host) openNoopPluginView(host)
          },
          onOpenFsProbePlugin: () => {
            const host = BrowserWindow.getFocusedWindow() ?? mainWindow
            if (host) openFsProbePluginView(host)
          },
          onOpenMiniIdePlugin: () => {
            // Dev-only: workspace via AGENT_TEAM_PLUGIN_WORKSPACE, else empty.
            // Open the declared v2 contribution through the same Host route.
            void openMiniIdeEditor(null, {
              workspace_path: process.env['AGENT_TEAM_PLUGIN_WORKSPACE'] ?? '',
            })
          },
          onOpenPlansPlugin: () => {
            const host = BrowserWindow.getFocusedWindow() ?? mainWindow
            // Dev-only: workspace via AGENT_TEAM_PLUGIN_WORKSPACE, else empty.
            if (host) {
              const httpUrl = backend ? `http://${backend.host}:${backend.port}` : ''
              void openPlansPluginView(host, process.env['AGENT_TEAM_PLUGIN_WORKSPACE'] ?? '', httpUrl, '', currentUiTheme(), currentUiLocale())
            }
          }
        }
      : {})
  }
  rebuildAppMenu()
  // Fill the native About panel (⌘ About Navide) with Navide branding.
  app.setAboutPanelOptions({
    applicationName: 'Navide',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 NT IT | 恩梯科技股份有限公司',
    credits: 'Navide Team'
  })
  // Register updater IPC before any renderer can request its state. Packaged
  // builds automatically check GitHub Releases after a short delay.
  initUpdater({
    // Packaged builds only; which install shapes can update themselves in
    // place (Squirrel.Mac, NSIS, AppImage — not .deb) is inAppUpdateSupported's
    // call. Windows updates go unverified until the build is code-signed.
    enabled: app.isPackaged && inAppUpdateSupported(),
    currentVersion: app.getVersion(),
    // Installing quits the app by design, and the user already agreed to that
    // when they asked for the install. Without this they get a second "Quit?"
    // dialog on top of the one they just answered — and cancelling it leaves
    // the update staged anyway, so the question is not even truthful.
    // Freeze the restore snapshot here, not in before-quit: a quit started by
    // autoUpdater.quitAndInstall() emits before-quit AFTER closing every
    // window, so by then each window's 'closed' has already remove()d its
    // entry and the snapshot would be frozen empty. This is the only hook the
    // update path offers that still runs while the windows are open.
    onInstallStarting: () => { quitConfirmed = true; dockQuitInProgress = true; markCleanExitAndSettleRestores() },
    // The install did not take the app down (bad precondition, error, or
    // timeout) — restore the confirmation gate the waiver above disabled.
    // ...and the snapshot freeze above goes back with it: the app is still
    // running, so this run is not a clean exit after all.
    // quitAndInstall's before-quit marked the windows prepared; the app is
    // still running, so un-mark that too or windows stop ending their panels.
    onInstallAbandoned: () => { warnMain('[main] update install abandoned; the app keeps running'); quitConfirmed = false; dockQuitInProgress = false; quittingWindowsPrepared = false; windowRegistry.clearCleanExit() },
  })
  // Detect an unclean previous exit and stash its windows for the restore
  // banner. Always reset the file (start tracking this run) — but only OFFER
  // restore in packaged builds: dev restarts (electron-vite) always look like
  // crashes. AGENT_TEAM_FORCE_RESTORE=1 enables the offer in dev for testing.
  {
    const pending = windowRegistry.readPendingAndReset()
    const restoreEnabled = app.isPackaged || process.env['AGENT_TEAM_FORCE_RESTORE'] === '1'
    pendingRestore = restoreEnabled ? pending : null
    if (pendingRestore) infoMain(`[main] unclean exit detected; ${pendingRestore.length} workspace(s) restorable`)
  }
  // In dev mode, inject the per-session random token into every renderer →
  // dev-server request so browsers without the token get 403.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    try {
      const devToken = readFileSync(join(tmpdir(), 'agent-team-dev-token'), 'utf-8').trim()
      const origin = new URL(rendererUrl).origin
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: [`${origin}/*`] },
        (details, callback) => {
          callback({ requestHeaders: { ...details.requestHeaders, 'x-electron-token': devToken } })
        }
      )
    } catch {
      // Token file missing — dev server may not be running yet, proceed anyway.
    }
  }

  // Start the backend in PARALLEL with window creation, not before it. Awaiting
  // here meant the first window (and its renderer's first paint) didn't even
  // begin loading until the backend had fully spawned. The renderer shows its
  // boot overlay and connects once the backend is ready (broadcastBackendChanged);
  // it already tolerates a not-yet-ready backend (same path as a restart).
  backendStarting = startBackend(
    readHealthCheckTimeoutSec(healthTimeoutPath()) * 1000,
    approvedBackendPluginCatalog()
  )
    .then((b) => {
      backend = b
      frontendPluginManager.setTerminalShell(b.shell)
      backendLastError = null
      watchBackendCrash(b)
      // Starts the stability window whose completion clears the restore
      // failure ledger (onStable, above); a no-op for the restart budget here.
      backendAutoRestart.onHealthy()
      infoMain(`[main] backend ready at ${b.host}:${b.port}`)
      broadcastBackendChanged()
    })
    .catch((err) => {
      errorMain('[main] backend failed to start', err)
      backendLastError = String(err)
      broadcastBackendChanged()
    })
  // Warm Plans storage only once that start has settled: its per-workspace
  // partition clone must not compete for the libuv threadpool with the spawn's
  // login-shell PATH probe.
  void backendStarting.then(warmPlansStorage)

  // Open any folders requested at launch: queued open-file events (macOS cold
  // launch from a Quick Action) plus CLI path args on a packaged build. Dev runs
  // skip argv parsing — electron-vite's argv contains paths that aren't workspaces.
  const queued = [...pendingOpenPaths]
  pendingOpenPaths.length = 0
  const cli = app.isPackaged ? workspacePathsFromArgv(process.argv) : []
  const launchPaths = [...new Set([...queued, ...cli])]
  let openedAny = false
  for (const p of launchPaths) {
    if (openWorkspaceFromPath(p)) openedAny = true
  }
  // Workspaces whose main window this launch actually put back, normalized so
  // a snapshot's spelling can be compared against it. Gates the per-workspace
  // auxiliary windows below.
  const restoredWorkspaces = new Set<string>()
  // Clean-exit auto-restore: when nothing was launched explicitly (no Quick
  // Action / CLI path), reopen the windows that were open at the last clean
  // quit — each in its workspace with its saved bounds. Gated by the
  // restoreOnLaunch setting inside cleanExitRestore(); empty after a crash
  // (that path uses the restore banner instead).
  if (!openedAny) {
    const autoRestore = windowRegistry.cleanExitRestore()
    if (autoRestore.length) {
      // Charge each workspace an attempt before opening anything, and drop the
      // ones that already spent their budget: a workspace whose filesystem
      // wedges the backend must not be restored into the same wedge forever
      // (issue #24). The charge is paid back once the backend proves stable.
      const plan = windowRegistry.beginRestore(autoRestore)
      skippedRestores = plan.skipped.map((w) => w.workspace_path)
      for (const path of skippedRestores) {
        warnMain(`[main] restore skipped: ${path} failed to restore ${MAX_RESTORE_ATTEMPTS} times in a row`)
      }
      if (plan.restore.length) {
        infoMain(`[main] clean-exit restore; ${plan.restore.length} workspace window(s)`)
      }
      // Main windows first: a detached child broadcasts to its origin window,
      // which has to exist by then for the hand-off bookkeeping to land.
      const [detachedEntries, mainEntries] = [
        plan.restore.filter((e) => e.detached_group),
        plan.restore.filter((e) => !e.detached_group)
      ]
      for (const entry of [...mainEntries, ...detachedEntries]) {
        if (entry.detached_group) {
          await reopenDetachedGroup(entry.workspace_path, entry.detached_group, entry.bounds)
          restoredWorkspaces.add(normalizeWorkspacePath(entry.workspace_path))
          openedAny = true
          continue
        }
        const restored = await createWindow(
          { workspace_path: entry.workspace_path, restore: '1' },
          entry.bounds ? { bounds: entry.bounds } : undefined
        )
        if (entry.adopted_workspaces?.length) {
          pendingAdoptedWorkspaces.set(restored.id, entry.adopted_workspaces)
        }
        restoredWorkspaces.add(normalizeWorkspacePath(entry.workspace_path))
        // Only a window that actually opened counts — when every workspace is
        // skipped this stays false and the empty Welcome window below runs, so
        // the app is never left with no window at all.
        openedAny = true
      }
    }
  }
  // Auxiliary windows (Plans, Git, Token Monitor) from the same clean exit.
  // Runs after the main windows on purpose: a Plans or Git window only comes
  // back when its workspace's main window did. That keeps a workspace the
  // failure breaker skipped from being let in through a side door — reopening
  // its Git window would load the very backend the breaker is protecting the
  // app from — and it keeps an orphan Plans window, whose workspace has no
  // window to hand anything to, from appearing on its own. The machine-wide
  // Token Monitor belongs to no workspace, so nothing gates it.
  //
  // None of this touches openedAny: three auxiliary windows and no main window
  // still needs the Welcome window below.
  const auxRestore = windowRegistry.cleanExitAuxRestore()
  for (const entry of auxRestore) {
    const ownerPath = entry.workspace_path ?? ''
    if (entry.kind !== 'token-monitor') {
      const owner = normalizeWorkspacePath(ownerPath)
      if (!owner || !restoredWorkspaces.has(owner)) continue
    }
    // The openers answer with a boolean, so the window itself arrives through
    // this hook — set only for the one call, and only when there are bounds to
    // put back (the openers' own defaults are right for a first-time window).
    const bounds = entry.bounds
    auxWindowCreatedHook = bounds
      ? (win) => { if (!win.isDestroyed()) win.setBounds(bounds) }
      : null
    try {
      // A window of a plugin the user disabled is not brought back.
      if (entry.kind === 'token-monitor') requestTokenMonitor()
      else if (entry.kind === 'plans') {
        if (!frontendPluginManager.isBuiltinPluginDisabled('navide.plans')) await openPlanWindow(ownerPath)
      } else if (!frontendPluginManager.isBuiltinPluginDisabled('navide.git')) await openGitWindow(ownerPath)
    } finally {
      auxWindowCreatedHook = null
    }
  }
  if (!openedAny) await createWindow()
  startupWindowsSettled = true

  app.on('activate', focusOrCreateMainWindow)
})

app.on('window-all-closed', () => {
  if (!isMac()) app.quit()
})

// Off macOS, closing the last window quits the app (above), so the quit
// confirmation has to run from that window's own close event, while a Cancel
// can still keep it (see last-window-close.ts). Every window counts as "last"
// — a Plans or Git window left open after the main window is the one whose
// close would quit — so the guard goes on each window as Electron creates it,
// whichever factory made it. A confirmed quit re-enters before-quit like
// Cmd+Q, so the close participants get their say before anything is torn
// down; `quitConfirmed` skips the prompt there and lets the windows close.
app.on('browser-window-created', (_event, win) => {
  win.on('close', (e) => {
    guardLastWindowClose(e, {
      liveWindows: () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
      confirmEnabled: () => quitConfirm.enabled,
      quitConfirmed: () => quitConfirmed,
      promptOpen: () => quitPromptOpen,
      ask: () => askQuitConfirm(win),
      quit: () => {
        quitConfirmed = true
        dockQuitInProgress = true
        app.quit()
      },
    })
  })
})

// Shutdown budgets. They are deliberately SEPARATE: a single shared deadline
// let a slow spawn eat the stop budget, and stopping must keep its full window
// — it has to outlast backend.stop()'s own 5s SIGTERM grace, or the cap
// SIGKILLs the backend mid-shutdown-sweep and orphans every PTY child.
//
// The spawn budget stays short on purpose. A start that is seconds away is not
// worth making every quit feel slow, and a real start is often far longer than
// any budget worth waiting (the macOS login-shell PATH probe alone has been
// measured at 13s+ before the child even spawns). What makes the short budget
// safe is abandonPendingBackends() below: ending the wait no longer means
// leaving the process behind, so the number only decides how often a
// still-starting backend is killed outright rather than stopped cleanly.
const BACKEND_SPAWN_WAIT_MS = 3000
const BACKEND_STOP_WAIT_MS = 6000
const PLUGIN_BACKEND_STOP_WAIT_MS = 6000
// What the renderers get to put their queued settings writes on the socket
// after the 'saving' broadcast. Sized for an IPC hop plus a WebSocket send, not
// a round trip: nobody awaits the ack. Without it the broadcast has not even
// been delivered by the time the backend that receives those writes is stopped,
// so any preference changed within the renderer's 500ms write debounce of
// quitting is lost.
const SETTINGS_FLUSH_GRACE_MS = 250

async function teardownBackendAndQuit(): Promise<void> {
  quitTeardownRan = true
  // Put the shutdown screen up before anything below can block: the waits here
  // run into seconds, and the windows stay on screen for all of it.
  broadcastQuitStage('saving')
  // The renderers flush their queued settings writes when they see 'saving'.
  // That flush travels renderer → backend over the WebSocket, so it has to land
  // while the backend below is still up.
  await new Promise<void>((resolve) => setTimeout(resolve, SETTINGS_FLUSH_GRACE_MS))
  // A user-initiated quit is a clean exit — nothing to restore next launch.
  windowRegistry.markCleanExit()
  // Drop any scheduled respawn: quitting must not race a backend back to life.
  // The epoch bump also disowns an auto-restart that is mid-spawn, so the
  // handle it produces is stopped rather than adopted on the way out.
  backendLifecycleEpoch++
  backendAutoRestart.cancel()
  backendRestartPending = null
  // Everything from here is the slow part: waiting out a starting backend, then
  // stopping the running one while it sweeps its PTY children.
  broadcastQuitStage('stopping')
  // If the backend is still spawning (quit mid-startup), wait for it (capped) so
  // we can stop it rather than orphan the process.
  if (!backend && backendStarting) await withDeadline(backendStarting, BACKEND_SPAWN_WAIT_MS)
  const b = backend
  backend = null
  backendStarting = null
  // Giving up on the WAIT must not mean giving up on the PROCESS. Whatever is
  // still starting — the wait above that ran out, or a restart's start, which
  // `backendStarting` no longer tracks — has a spawned child that Electron
  // exiting would leave running, reparented and still holding the port and the
  // shared app-data state for the next launch to fight over. A finished start
  // is not in that set: its handle owns the process, and `stop()` below is what
  // takes that one down.
  abandonPendingBackends()
  if (b) await withDeadline(b.stop(), BACKEND_STOP_WAIT_MS)
  await withDeadline(
    frontendPluginManager.closeBackendPlugins(),
    PLUGIN_BACKEND_STOP_WAIT_MS,
  )
  broadcastQuitStage('closing')
  app.quit()
}

// Not on will-quit: a will-quit listener can still prevent the quit, and only
// 'quit' follows when none did. Disposing takes the services' IPC listeners
// down for good, so it waits for the same signal.
app.on('quit', () => {
  quitCancelWatch.disarm()
  terminalStorageOwnerService.dispose()
  filePickerHostService.dispose()
})

// The "confirm before quit" dialog. Resolves true when the user chose Quit;
// the "don't show again" checkbox is applied here so both callers agree.
async function askQuitConfirm(win: BrowserWindow | undefined): Promise<boolean> {
  const opts = {
    type: 'question' as const,
    title: QUIT_DIALOG_TITLE,
    buttons: [quitConfirm.quitLabel, quitConfirm.cancelLabel],
    defaultId: 0,
    cancelId: 1,
    message: quitConfirm.message,
    detail: quitConfirm.detail,
    checkboxLabel: quitConfirm.dontShowLabel,
    checkboxChecked: false,
  }
  quitPromptOpen = true
  let res: Electron.MessageBoxReturnValue
  try {
    res = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  } finally {
    quitPromptOpen = false
  }
  if (res.response === 1) return false
  if (res.checkboxChecked) {
    quitConfirm.enabled = false
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('app:quitConfirmDisabled')
    }
  }
  return true
}

app.on('before-quit', async (e) => {
  // Confirmation gate — shared "confirm before close" setting, driven by renderer.
  if (quitConfirm.enabled && !quitConfirmed) {
    e.preventDefault()
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!(await askQuitConfirm(win))) return // cancelled — stay open (default already prevented)
    quitConfirmed = true
    dockQuitInProgress = true
    // Re-enter through the normal path so receiver/provider preparation runs
    // before any backend shutdown.
    app.quit()
    return
  }
  // Prepare every receiver/editor/provider participant before any window or
  // backend is committed. A refusal aborts the quit with every window alive.
  if (!quittingWindowsPrepared) {
    if (quittingWindowsPreparation) {
      e.preventDefault()
      return
    }
    const windows = BrowserWindow.getAllWindows()
    if (windows.some((window) => frontendPluginManager.hasWindowCloseParticipants(window))) {
      e.preventDefault()
      quittingWindowsPreparation = windowCloseCoordinator.prepareForQuit(windows).finally(() => {
        quittingWindowsPreparation = null
      })
      const prepared = await quittingWindowsPreparation
      if (!prepared) {
        // Vetoed: the app stays open, so closing a window ends its AI panels
        // again. quitConfirmed is left as it was, and the refusal has already
        // told the user why.
        void resetCancelledQuit()
        return
      }
      quittingWindowsPrepared = true
      app.quit()
      return
    }
    quittingWindowsPrepared = true
  }
  // Non-dialog path (disabled, or re-entrant after quitConfirmed).
  // A user-initiated quit is a clean exit — nothing to restore next launch.
  // Must run before the early return below (backend may already be gone).
  markCleanExitAndSettleRestores()
  // Nothing to tear down means the native quit can proceed. hasBackendActivity()
  // now reports live plugin backends only - bound views, headless MCP instances
  // and in-flight calls - so a packaged launch that merely registered the bundled
  // Plans backend as metadata no longer keeps this guard permanently false.
  if (!backend && !backendStarting && !frontendPluginManager.hasBackendActivity()) {
    quitCancelWatch.arm()
    return
  }
  e.preventDefault()
  void teardownBackendAndQuit()
})
