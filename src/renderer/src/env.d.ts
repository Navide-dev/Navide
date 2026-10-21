/// <reference types="vite/client" />

type UpdateActionResult = import('../../shared/updater').UpdateActionResult
type UpdateSettingsResult = import('../../shared/updater').UpdateSettingsResult
type UpdaterSettings = import('../../shared/updater').UpdaterSettings
type UpdateState = import('../../shared/updater').UpdateState
type ExecutionPolicyApi = import('../../shared/executionPolicy').ExecutionPolicyApi
type FnKeyApi = import('../../shared/fnKey').FnKeyApi
type DeepLinkApi = import('../../shared/deepLink').DeepLinkApi
type DeveloperApi = import('../../shared/marketplaceDeveloper').DeveloperApi
type ManifestPermissionsSummary = import('../../shared/executionPolicy').ManifestPermissionsSummary
type PackageVersionGrantSummary = import('../../shared/executionPolicy').PackageVersionGrantSummary
type LegacyPlansPreferenceProjection = import('../../shared/plansPreferences').LegacyPlansPreferenceProjection
type PluginSource = import('../../shared/pluginSource').PluginSource
type LocalInstallDetails = import('../../shared/pluginSource').LocalInstallDetails
type PluginManifestDisclosure = import('../../shared/pluginDisclosure').ManifestDisclosure
type PluginDisclosureDiff = import('../../shared/pluginDisclosure').DisclosureDiff
type PluginRegistryDisclosureFacts = import('../../shared/pluginDisclosure').RegistryDisclosureFacts
type PluginScanReport = import('../../shared/pluginDisclosureScan').ScanReport
type PluginActivityReport = import('../../shared/pluginActivity').PluginActivityReport
type LegalRoute = import('../../shared/legalLinks').LegalRoute
type NewWorkspaceResult = import('../../shared/workspaceCreate').NewWorkspaceResult

interface BackendInfo {
  status: 'starting' | 'ready' | 'error'
  host?: string
  port?: number
  pid?: number
  shell?: string
  httpUrl?: string
  wsUrl?: string
  error?: string
}

interface GitAccountPublic {
  id: string
  label: string
  host: string
  username: string
  tokenLast4: string
}

interface GitAccountInput {
  label: string
  host: string
  username: string
  token: string
}

interface GitCredential {
  username: string
  token: string
  expectedHost: string
}

interface GitRecoveryChanged {
  legacy: boolean
}

interface PlansRecoveryChanged {
  legacy: boolean
  /** Host-side reason for the downgrade. Absent when leaving recovery. */
  reason?: string
}

declare global {
  // Build tag injected by electron.vite.config.ts (git short-hash + dirty + time).
  const __APP_BUILD__: string
  // Prefixed: the DOM lib already owns the `PermissionStatus` global.
  type TccPermissionKey = 'automation' | 'notifications' | 'folders' | 'fullDisk'
  type TccPermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-applicable'
  interface Window {
    /** Set by useTerminal; read by the Edit > Copy menu item (see menu.ts). */
    __navideTerminalSelection?: () => string
    agentTeam?: {
      appName: string
      version: string
      /** 'darwin' | 'win32' | 'linux'; read through shared/osplat, not directly. */
      platform: string
      /** Present on every platform; only drawn where the system will not. */
      windowControls: {
        minimize: () => Promise<{ ok: boolean }>
        toggleMaximize: () => Promise<{ ok: boolean; maximized: boolean }>
        close: () => Promise<{ ok: boolean }>
        isMaximized: () => Promise<{ maximized: boolean }>
        onMaximizeChanged: (cb: (maximized: boolean) => void) => () => void
      }
      getBackendInfo: () => Promise<BackendInfo>
      proveWindow?: (nonce: string) => Promise<string | null>
      restartBackend: () => Promise<BackendInfo>
      stopBackend: () => Promise<{ ok: boolean }>
      onBackendChanged: (cb: (info: BackendInfo) => void) => void
      retryGitV2: () => Promise<{ ok: boolean; reason?: string }>
      retryPlansV2: () => Promise<{ ok: boolean; reason?: string }>
      repairPlansStorageRecord: () => Promise<{ ok: boolean; repaired: boolean; reason?: string }>
      onGitRecoveryChanged: (cb: (change: GitRecoveryChanged) => void) => () => void
      onPlansRecoveryChanged: (cb: (change: PlansRecoveryChanged) => void) => () => void
      onPlansBackendStopped: (cb: (stopped: { workspacePath: string }) => void) => () => void
      onPluginAgentAction?: (cb: (notice: {
        action: 'disable' | 'enable' | 'update'
        pluginId: string
        pluginVersion: string
        /** `update` only: the version it was updated from. */
        fromVersion?: string
        requester: { paneId: string | null; paneName: string | null; workspace: string | null; callerKind: 'pane' | 'external' | 'host' }
      }) => void) => () => void
      onPluginStagedCandidateNotActivated?: (cb: (notice: { pluginId: string; version: string; reason: string }) => void) => () => void
      onPluginStagedUpdates?: (cb: (updates: { pluginId: string; activeVersion: string; stagedVersion: string; reason?: string }[]) => void) => () => void
      onPluginSwitched?: (cb: (notice: { pluginId: string; fromVersion: string; toVersion: string; source: 'marketplace' | 'local-unsigned'; at: number; agent?: { paneId: string | null; paneName: string | null; workspace: string | null; callerKind: 'pane' | 'external' | 'host'; tainted?: true } }) => void) => () => void
      onMenuAction: (cb: (action: string) => void) => void
      onSystemResumed: (cb: () => void) => () => void
      setRecentWorkspaces: (list: { path: string; name: string; exists: boolean }[]) => void
      openMainWindow: (args?: { workspace_path?: string; background?: boolean }) => Promise<{ ok: boolean }>
      pickWorkspace: (defaultPath?: string) => Promise<string | null>
      newWorkspace: () => Promise<NewWorkspaceResult>
      getHomeDir: () => Promise<string>
      dockSurfaceProvided?: (surface: string) => Promise<boolean>
      listOpenWorkspaces: () => Promise<string[]>
      focusWorkspaceWindow: (workspacePath: string) => Promise<boolean>
      /** Title of ANOTHER window holding the workspace, or '' (none, or only this one). */
      workspaceHolder?: (workspacePath: string) => Promise<string>
      reportAdoptedWorkspaces: (paths: string[]) => void
      takeRestoredAdoptedWorkspaces: () => Promise<string[]>
      onOpenWorkspacesChanged: (cb: () => void) => () => void
      openPath: (target: string) => Promise<{ ok: boolean; revealed?: boolean; error?: string }>
      revealPath: (target: string) => Promise<{ ok: boolean; error?: string }>
      /** Optional: absent on main processes built before the Storage tab.
       *  `freedBytes` is real even when `ok` is false (e.g. the updater cache
       *  was skipped because an update is downloading). */
      storage?: {
        clearElectronCaches: (opts: {
          chromium: boolean
          updater: boolean
        }) => Promise<{ ok: boolean; freedBytes: number; error: string | null }>
      }
      openTerminal: (command: string) => Promise<{ ok: boolean; error?: string }>
      openTempFile: (filename: string, content: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      detachGroup: (args: { groupId: string; workspacePath: string; bounds?: { x: number; y: number; width: number; height: number } }) => Promise<{ ok: boolean }>
      detachWorkspace: (args: { workspacePath: string; bounds?: { x: number; y: number; width: number; height: number } }) => Promise<{ ok: boolean }>
      getDetachedGroups: () => Promise<string[]>
      focusSelf?: () => Promise<{ ok: boolean }>
      closeSelf?: () => Promise<{ ok: boolean; error?: string }>
      canCloseSelf?: () => Promise<{ ok: boolean; error?: string }>
      reattachGroup: (args?: { groupId?: string }) => Promise<{ ok: boolean }>
      onGroupDetached: (cb: (groupId: string) => void) => void
      onGroupReattached: (cb: (groupId: string) => void) => void
      onOpenPipelineManager: (handler: (payload: { pipelineId?: string }) => void) => () => void
      openPlansWindow: (args: { workspace_path: string; rel_path?: string }) => Promise<{ ok: boolean }>
      projectLegacyPlansPreferences: (args: {
        workspace_path: string
        values: LegacyPlansPreferenceProjection
      }) => Promise<{ ok: boolean; error?: string }>
      getPlansLegacyRecoveryPreferences: () => Promise<LegacyPlansPreferenceProjection | null>
      onPlansLegacyRecoveryPreferences: (
        cb: (values: LegacyPlansPreferenceProjection) => void,
      ) => () => void
      onOpenResourceManager: (handler: () => void) => () => void
      onOpenTurnStats: (handler: () => void) => () => void
      requestPaneAction: (args: {
        paneId: string
        action: 'focus' | 'reclaim'
      }) => Promise<{ ok?: boolean; error?: string }>
      onPaneActionRequest: (
        handler: (
          paneId: string,
          action: 'focus' | 'reclaim'
        ) => Promise<{ ok?: boolean; error?: string }> | { ok?: boolean; error?: string }
      ) => void
      openGitHistoryWindow: (args: { workspace_path: string }) => Promise<{ ok: boolean }>
      openGitWindow: (args: {
        workspace_path: string
        filepath?: string
        staged?: boolean
        commit?: string
        base?: string
        compare?: string
      }) => Promise<{ ok: boolean }>
      openBranchDiffWindow?: (args: { workspace_path: string; base: string }) => Promise<{ ok: boolean }>
      openGitLeftView: (args: {
        workspace_path: string
        bounds: { x: number; y: number; width: number; height: number }
      }) => Promise<{ ok: boolean; fallback?: 'legacy' }>
      updateGitLeftView: (args: {
        bounds: { x: number; y: number; width: number; height: number }
        visible: boolean
      }) => Promise<{ ok: boolean; fallback?: 'legacy' }>
      closeGitLeftView: () => Promise<{ ok: boolean }>
      getZoomFactor?: () => Promise<number>
      setUiScale?: (scale: number) => Promise<number>
      onZoomChanged?: (cb: () => void) => () => void
      onPlanOpenDoc: (handler: (relPath: string) => void) => () => void
      openDiffWindow: (args: {
        workspace_path: string
        filepath: string
        staged: boolean
        name?: string
        commit?: string
      }) => Promise<{ ok: boolean }>
      openEditorWindow: (args: {
        workspace_path: string
        filepath?: string
        /** Root the file itself belongs to when it lives outside `workspace_path`. */
        file_ws?: string
        name?: string
        line?: number
        sidebar?: 'explorer' | 'search' | 'git'
      }) => Promise<{ ok: boolean }>
      /** Editors Navide can drive here; `available` is false when not found. */
      listEditors: (
        refresh?: boolean
      ) => Promise<{ id: string; command: string; available: boolean }[]>
      /** Open a folder in `editorId`, or the user's default editor when omitted. */
      openFolderInEditor: (dir: string, editorId?: string) => Promise<{ ok: boolean }>
      onOpenEditorFile: (cb: (params: Record<string, string>) => void) => void
      saveJson: (args: {
        defaultName?: string
        content: string
        title?: string
      }) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
      openJson: (args?: {
        title?: string
      }) => Promise<{ ok: boolean; path?: string; content?: string; canceled?: boolean; error?: string }>
      readFileFrom: (filePath: string, fromByte: number) => Promise<{ ok: boolean; content: string; newOffset: number; error?: string }>
      realpath: (target: string) => Promise<string>
      findManualLog: (workspacePath: string, filename: string) => Promise<{ ok: boolean; path: string | null; error?: string }>
      searchHistoryLogs: (args: { query: string; files: Array<{ id: string; path: string }> }) => Promise<{ matchedIds: string[] }>
      pickFile: (args?: {
        title?: string
        filters?: Array<{ name: string; extensions: string[] }>
        defaultPath?: string
      }) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
      getPathForFile: (file: File) => string
      stabilizeDroppedPaths: (paths: string[]) => Promise<{ ok: boolean; paths: string[] }>
      saveClipboardImage: (args: { bytes: Uint8Array; mediaType: string }) => Promise<{ ok: boolean; path?: string }>
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>
      legalLinks: Readonly<Record<LegalRoute, string>>
      trustConfirm: (
        action: string,
        deviceId: string,
        subject?: string,
      ) => Promise<{ nonce: string; expires: string; mac: string } | null>
      openLegal: (route: LegalRoute) => Promise<{ ok: boolean; error?: string }>
      openSpotlightSettings: () => Promise<{ ok: boolean; error?: string }>
      openSpokenContentSettings: () => Promise<{ ok: boolean; error?: string }>
      onSwitchEditorSidebar: (cb: (sidebar: string) => void) => void
      onOpenEditorDiff: (cb: (params: Record<string, string>) => void) => void
      readKeybindings: () => Promise<{ ok: boolean; content?: string; error?: string }>
      writeKeybindings: (content: string) => Promise<{ ok: boolean; error?: string }>
      onKeybindingsChanged: (cb: (content: string) => void) => void
      getBootstrapSettings: () => string
      broadcastLanguageChange: (locale: string) => void
      onLanguageChanged: (cb: (locale: string) => void) => void
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
      }) => void
      onQuitConfirmDisabled: (cb: () => void) => () => void
      onQuitProgress: (cb: (stage: 'saving' | 'stopping' | 'closing' | 'cancelled') => void) => () => void
      onWindowVisibility: (cb: (visible: boolean) => void) => () => void
      readHealthCheckTimeout: () => Promise<{ ok: boolean; timeoutSec?: number }>
      writeHealthCheckTimeout: (timeoutSec: number) => Promise<{ ok: boolean; error?: string }>
      readCdpDebugConfig: () => Promise<{ ok: boolean; config?: { enabled: boolean; port: number } }>
      writeCdpDebugConfig: (config: { enabled: boolean; port: number }) => Promise<{ ok: boolean; error?: string }>
      notify: (args: { paneId?: string; title: string; body?: string; silent?: boolean }) => Promise<{ ok: boolean }>
      onFocusPane: (cb: (paneId: string) => void) => void
      dispatchPlanExecution: (args: {
        workspace_path: string
        rel_path: string
        agent_key: string
      }) => Promise<{ delivered: boolean }>
      onPlanExecutionDispatch: (
        handler: (args: { workspace_path: string; rel_path: string; agent_key: string }) => void
      ) => () => void
      reportPlanExecutionResult: (args: {
        workspace_path: string
        rel_path: string
        ok: boolean
        reason?: string
      }) => void
      onPlanExecutionResult: (
        handler: (args: { workspace_path: string; rel_path: string; ok: boolean; reason?: string }) => void
      ) => () => void
      getCliPaneBuffer: (
        paneId: string
      ) => Promise<{
        label?: string
        agentKey?: string
        sessionId?: string | null
        sessionHomeId?: string
        workspacePath?: string
        conversationLogPath?: string
        buffer?: string
        error?: string
      }>
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
      ) => void
      cliPaneDragEnd: (
        paneId: string,
        screenX: number,
        screenY: number,
        paneIds?: string[]
      ) => void
      onExternalPaneDrop: (
        handler: (args: {
          paneId: string
          paneIds?: string[]
          screenX: number
          screenY: number
        }) => void
      ) => () => void
      showTerminalContextMenu: (selection: string) => void
      reportTerminalSelection?: (selection: string) => void
      /** Edit > Copy produced an unchanged clipboard; `branch` is 'timeout' or
       *  'no-selection'. Absent on an older preload and in plugin views. */
      onTerminalCopyEmpty?: (cb: (branch: string) => void) => void
      setBadgeCount: (count: number) => void
      reportWorkspace: (workspacePath: string) => void
      setGitContributionState?: (state: {
        workspacePath: string
        analyzerModel: string
        dispatchTargets: { id: string; label: string }[]
        availableAgents: { key: string; label: string }[]
        issueHandoffs: Record<string, { paneId: string; mode: string; state: string }>
      }) => void
      clearGitContributionState?: () => void
      onGitContributionAction?: (handler: (action: {
        operation: string
        payload?: Record<string, unknown>
      }) => void) => () => void
      restore?: {
        getPending: () => Promise<string[] | null>
        /** Workspaces the restore failure breaker refused to reopen this
         *  launch. Not one-shot on the main side — see App.vue's notice. */
        getSkipped: () => Promise<string[]>
        apply: () => Promise<{ ok: boolean; opened: number }>
        dismiss: () => Promise<{ ok: boolean }>
        getAutoRestore: () => Promise<boolean>
        setAutoRestore: (value: boolean) => Promise<{ ok: boolean }>
      }
      updater?: {
        getState: () => Promise<UpdateState>
        check: () => Promise<UpdateActionResult>
        download: () => Promise<UpdateActionResult>
        install: () => Promise<UpdateActionResult>
        onStateChanged: (cb: (state: UpdateState) => void) => () => void
        getSettings: () => Promise<UpdaterSettings>
        setSettings: (patch: Partial<UpdaterSettings>) => Promise<UpdateSettingsResult>
      }
      gitAccounts?: {
        isAvailable: () => Promise<{ ok: boolean; available?: boolean; error?: string }>
        list: () => Promise<{ ok: boolean; accounts?: GitAccountPublic[]; error?: string }>
        add: (input: GitAccountInput) => Promise<{ ok: boolean; account?: GitAccountPublic; error?: string }>
        update: (id: string, patch: Partial<GitAccountInput>) => Promise<{ ok: boolean; error?: string }>
        remove: (id: string) => Promise<{ ok: boolean; error?: string }>
        bind: (workspacePath: string, accountId: string) => Promise<{ ok: boolean; error?: string }>
        unbind: (workspacePath: string) => Promise<{ ok: boolean; error?: string }>
        getBinding: (workspacePath: string) => Promise<{ ok: boolean; accountId?: string | null; error?: string }>
        getCredential: (
          workspacePath: string
        ) => Promise<{ ok: boolean; credential?: GitCredential | null; error?: string }>
      }
      permissions?: {
        status: () => Promise<Record<TccPermissionKey, TccPermissionStatus>>
        request: (
          key: TccPermissionKey,
          payload?: { title?: string; body?: string }
        ) => Promise<TccPermissionStatus>
        openSettings: (key: TccPermissionKey) => Promise<{ ok: boolean; error?: string }>
      }
      media?: {
        askMicrophone: () => Promise<{ granted: boolean; status: string; prompted?: boolean }>
      }
      fnKey?: FnKeyApi
      deepLink?: DeepLinkApi
      developer?: DeveloperApi
      executionPolicy?: ExecutionPolicyApi
      plugins?: {
        listInstalled: () => Promise<InstalledPluginSummary[]>
        listFactoryPackages: () => Promise<FactoryPluginSummary[]>
        /** Current and peak in-flight backend calls per plugin (never capped) and dropped Host event notifications. */
        backendCallConcurrency?: () => Promise<Array<{ pluginId: string; current: number; peak: number; droppedNotifications: number }>>
        /** D-f: one installed plugin's activity report (read only). */
        activityReport?: (id: string) => Promise<{ ok: true; report: PluginActivityReport } | { ok: false; error: string }>
        /** D-f: installed Registry packages' disclosures and install-time scans. */
        installedDisclosures?: () => Promise<Array<{
          id: string
          version: string
          disclosure: PluginManifestDisclosure | null
          scan: PluginScanReport | null
          /** Source and review state; see `shared/pluginSource.ts`. */
          source?: PluginSource
          /** Test build expiry (ISO-8601), from the signed envelope; testplace only. */
          expiresAt?: string
          /** Whether the active package declares views (R2 MED-6 on #436). */
          hasViews?: boolean
        }>>
        /** Backend children, subscriptions, Bridge requests and queue backlog, now and at the most (never capped). */
        backendResourceUsage?: () => Promise<{
          backend?: { resultHelper: { state: 'idle' | 'ready' | 'unavailable'; lastError: string; since: number } }
          children: { current: number; peak: number; retained: number }
          views: Array<{
            pluginId: string
            instanceId: string
            subscriptions: { current: number; peak: number }
            child: {
              subscriptions: { current: number; peak: number }
              bridgeRequests: { current: number; peak: number }
              outputQueue: Record<'requests' | 'notifications', { frames: number; bytes: number; peakFrames: number; peakBytes: number }>
              droppedNotifications: number
              droppedResultPieces: number
              stdoutPending: { bytes: number; peakBytes: number }
            } | null
          }>
          plugins: Array<{ pluginId: string; current: number; peak: number; droppedNotifications: number }>
        }>
        disabledBuiltins?: () => Promise<string[]>
        disabledStoreStatus?: () => Promise<{ status: 'ok' | 'restored' | 'unreadable' }>
        resetDisabledStore?: () => Promise<{ status: 'ok' | 'restored' | 'unreadable' }>
        listContributions: () => Promise<Array<{
          pluginId: string
          packageVersion: string | null
          contributionKey: string
          title: string
          icon: string | null
          iconMonochrome: boolean
          kind: 'custom'
          location: 'top' | 'bottom' | 'right' | 'left' | 'main' | 'window'
          manifestOrder: number
          /** Source and review state of the package that contributes this view. */
          source?: PluginSource
          /** A test build: its signed expiry and how the user joined the test. */
          expiresAt?: string
          testplaceVia?: 'invite' | 'code'
          /** DX 9.4 A1, a local file only: its SHA-256 and install time. */
          localInstall?: LocalInstallDetails
        }>>
        hostThemeChanged: (theme: string) => void
        prepareContribution: (args: {
          contributionKey: string
          workspace_path: string
          theme?: string
        }) => Promise<{ ok: boolean; url?: string; error?: string }>
        openContributionWindow: (args: {
          contributionKey: string
          workspace_path: string
        }) => Promise<{ ok: boolean; error?: string }>
        closeContribution: (args: { contributionKey: string }) => Promise<{ ok: boolean }>
        onContributionsChanged: (handler: () => void) => () => void
        marketplaceSearch: (
          query?: string,
          sort?: 'updated' | 'downloads' | 'rating',
          options?: {
            category?: string
            offset?: number
            limit?: number
            hideIncompatible?: boolean
          }
        ) => Promise<MarketplaceListResponse>
        marketplaceCategories: () => Promise<MarketplaceCategory[]>
        marketplaceIcon: (args: {
          namespace: string
          name: string
          version: string
          path: string
        }) => Promise<string | null>
        marketplaceChangelog: (args: { namespace: string; name: string }) => Promise<string | null>
        marketplaceDetail: (args: {
          namespace: string
          name: string
        }) => Promise<MarketplaceExtensionDetail>
        checkUpdates: () => Promise<PluginUpdateInfo[]>
        pendingUpdates: () => Promise<PluginUpdateInfo[]>
        onUpdatesChanged: (handler: (updates: PluginUpdateInfo[]) => void) => () => void
        onRescanNotices?: (handler: (notices: PluginRescanNotice[]) => void) => () => void
        onResultHelperState?: (
          handler: (state: { state: 'idle' | 'ready' | 'unavailable'; lastError: string; since: number }) => void,
        ) => () => void
        prepareInstall: (args: {
          namespace: string
          name: string
          version?: string
          testplace?: boolean
        }) => Promise<PreparedInstallSummary>
        commitInstall: (
          id: string,
          approval?: { publisherConfirmed?: boolean; riskConfirmed?: boolean; replaceConfirmed?: boolean; reattachBackendData?: boolean }
        ) => Promise<{ id: string; requires: string[]; restartRequired: boolean; activatedVersion?: string; activationError?: string }>
        installFromFile?: () => Promise<PreparedInstallSummary | null>
        commitLocalInstall?: (
          id: string,
          approval: { riskConfirmed: boolean; replaceConfirmed?: boolean; reattachBackendData?: boolean; expectedDigest?: string }
        ) => Promise<{ id: string; requires: string[]; restartRequired: boolean; activatedVersion?: string; activationError?: string }>
        prepareAgentFileInstall?: (stagingId: string) => Promise<PreparedInstallSummary>
        prepareLocalRollback?: (id: string) => Promise<PreparedInstallSummary & { rollbackFrom: string }>
        discardAgentStaged?: (stagingId: string) => Promise<void>
        developerMode?: () => Promise<DeveloperModeState>
        setDeveloperMode?: (enabled: boolean) => Promise<DeveloperModeState>
        loadFromFolder?: () => Promise<PreparedInstallSummary | null>
        commitFolderLoad?: (id: string, approval: { riskConfirmed: boolean; expectedFolder?: string }) => Promise<DeveloperModeState>
        reloadDeveloperPlugin?: (id: string) => Promise<
          | { reloaded: true; requiresConsent: false }
          | { reloaded: false; requiresConsent: true; prepared: PreparedInstallSummary }
        >
        removeDeveloperFolder?: (id: string) => Promise<DeveloperModeState>
        selfHostedQuarantine?: () => Promise<Array<{ id: string; version: string | null }>>
        testplaceList?: () => Promise<TestplaceListing[]>
        testplaceJoin?: (code: string) => Promise<{ id: string }>
        testplaceLeave?: (id: string) => Promise<{ ok: true }>
        testplaceInvite?: (id: string, labels: string[]) => Promise<import('../../shared/marketplaceDeveloper').DeveloperCallResult>
        expiredTestplace?: () => Promise<ExpiredTestplaceBuild[]>
        keepExpiredTestplace?: (id: string) => Promise<{ ok: true }>
        adoptTestplaceRelease?: (id: string) => Promise<{ adopted: boolean }>
        restart: (id: string) => Promise<{
          id: string
          packageVersion: string
          restoredInstances: number
          skippedDestroyedHostWindows: number
        }>
        rollback: (id: string, options?: { consentConfirmed?: boolean }) => Promise<{
          id: string
          packageVersion: string
          restoredInstances: number
          skippedDestroyedHostWindows: number
        }>
        discardCandidate?: (id: string) => Promise<{ ok: boolean }>
        remove: (id: string, nativeBackendData?: 'keep' | 'delete') => Promise<{ ok: boolean }>
        nativeBackendData: (id: string) => Promise<{ exists: boolean; bytes: number; path: string }>
        /** The installed version's disclosure (Manifest v2), or null. */
        installedDisclosure?: (id: string) => Promise<import('../../shared/pluginDisclosure').ManifestDisclosure | null>
        restoreFactoryPackage: (id: string) => Promise<{ ok: boolean }>
        setPrerelease: (id: string, enabled: boolean) => Promise<{ id: string; enabled: boolean }>
        setDisabled: (id: string, disabled: boolean) => Promise<{ id: string; disabled: boolean }>
        marketplacePackMembers: (members: string[]) => Promise<PackMemberSummary[]>
        preparePack: (args: { namespace: string; name: string }) => Promise<PreparedPackSummary>
        finishPack: (id: string) => Promise<{ recorded: boolean; pack?: InstalledPackRecord }>
        listPacks: () => Promise<InstalledPackRecord[]>
        removePack: (id: string, members: string[]) => Promise<{ removed: boolean }>
        nativeBackends?: {
          list: () => Promise<NativeBackendOverview>
          setEnabled: (enabled: boolean) => Promise<NativeBackendOverview>
          allow: (id: string) => Promise<NativeBackendOverview>
          setDisabled: (id: string, disabled: boolean) => Promise<NativeBackendOverview>
          revokeWorkspaceWrite: (id: string, workspacePath: string) => Promise<NativeBackendOverview>
          setAgentTools?: (change: { enabled: boolean } | { externalCallers: boolean }) => Promise<NativeBackendOverview>
          /** Watchdog option C: unanswered resource notices (contract 5.2). */
          resourceNotices?: () => Promise<BackendResourceNoticeView[]>
          resourceStatus?: () => Promise<BackendResourceStatusView[]>
          answerResourceNotice?: (id: string, choice: 'terminate' | 'continue') => Promise<boolean>
          onResourceNoticesChanged?: (handler: () => void) => () => void
        }
      }
    }
  }

  interface BackendResourceStatusView {
    pluginId: string
    name: string
    packageVersion: string
    usage: Record<'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending', number>
    thresholds: Record<'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending', number>
    levels: Record<'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending', number>
    waiting: Array<'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending'>
  }

  interface BackendResourceNoticeView {
    id: string
    pluginId: string
    name: string
    packageVersion: string
    item: 'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending'
    usage: number
    threshold: number
    at: number
  }

  interface InstalledPluginSummary {
    id: string
    requires: string[]
    sensitive: string[]
    packageVersion?: string
    manifestPermissions?: ManifestPermissionsSummary
    packageVersionGrant?: PackageVersionGrantSummary | null
    provenance?: 'official-registry' | 'developer-local-unpacked' | 'factory-bundled'
    /** Source and review state; see `shared/pluginSource.ts`. */
    source?: PluginSource
    /** Test build expiry (ISO-8601), from the signed envelope; testplace only. */
    expiresAt?: string
    /** How the user joined that test, when recorded; testplace only. */
    testplaceVia?: 'invite' | 'code'
    /** A3: a local file a vetted publisher signed, and whether that key is
     *  still active (`verified`) or revoked since (`revoked`). */
    localSignature?: 'verified' | 'revoked'
    /** Decision d5: Navide blocked the `.vsix` this local install came from;
     *  `reason` null when its list names none. */
    digestBlock?: { reason: 'security' | 'admin' | 'qualification-revoked' | 'developer-withdrawn' | null }
    /** DX 9.4 A1, a local file only: its SHA-256 and install time. */
    localInstall?: LocalInstallDetails
    warning?: string
    pendingCandidateVersion?: string
    rollbackKind?: 'factory' | 'previous'
    rollbackToVersion?: string
    /** L4: the rollback target is a kept file version; going back asks again. */
    rollbackNeedsConsent?: true
    /** Lowest Navide release the installed version needs (label only). */
    minNavideVersion?: string
    /** False when this Navide release is older; the Host still runs it. */
    engineCompatible?: boolean
    /** Per-extension "Get pre-releases" switch (Registry installs only). */
    getsPrereleases?: boolean
    /** The user's "Disabled" switch; absent on rows it does not apply to. */
    disabled?: boolean
  }

  interface FactoryPluginSummary {
    id: string
    version: string | null
    active: boolean
    optedOut: boolean
    /** The user's Disabled switch for this built-in. */
    disabled?: boolean
    /** An earlier version removed it and deleted its data; now Disabled. */
    dataDeletedByEarlierRemoval?: boolean
  }

  interface MarketplaceExtension {
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
    /** Newest pre-release newer than `latest_version` (Registry's view). */
    latest_prerelease_version?: string | null
    /** Plan B D1 list card: the latest version's manifest disclosure and scan
     *  report as the Registry listed them, kept by the main process only when
     *  well formed and naming this item; unverified display data. */
    disclosure?: PluginManifestDisclosure | null
    scan?: PluginScanReport | null
    /** D-f: the highest risk level across the latest version's platforms. */
    listRisk?: { level: 'low' | 'medium' | 'high' | 'highest'; variesByPlatform: boolean } | null
  }

  interface PackMemberSummary {
    id: string
    status: 'ready' | 'installed' | 'missing' | 'nested' | 'unavailable' | 'incompatible' | 'error'
    display_name: string | null
    version: string | null
    capabilities: string[]
    sensitive_capabilities: string[]
    min_navide_version: string | null
  }

  interface PreparedPackSummary {
    id: string
    version: string
    display_name: string | null
    trustTier: 'signed-verified' | 'unsigned'
    publisherId: string
    members: PackMemberSummary[]
  }

  /** Third-party native backend state for the Extensions page. */
  interface NativeBackendStatusRow {
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

  interface NativeBackendOverview {
    enabled: boolean
    plugins: NativeBackendStatusRow[]
    /** Plan B: agent-tool switches (DB8, DB4); absent on an older Host. */
    agentTools?: { enabled: boolean; externalCallers: boolean }
  }

  interface InstalledPackRecord {
    id: string
    displayName?: string
    version: string
    members: string[]
    /** Members installed only because of this pack (still installed, and not
     *  listed by any other installed pack). */
    installedByPack: string[]
  }

  interface MarketplaceCategory {
    slug: string
    label: string
    count: number
  }

  interface MarketplaceVersionInfo {
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

  interface MarketplaceExtensionDetail extends MarketplaceExtension {
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

  interface PluginRescanNotice {
    id: string
    version: string
    added: Array<{ kind: string; key: string }>
  }

  interface PluginUpdateInfo {
    id: string
    namespace: string
    name: string
    installedVersion: string
    latestVersion: string
    /** Plan B D2 badge, from the Registry's unverified listing. */
    permissionChange?: 'more' | 'same'
  }

  interface MarketplaceListResponse {
    items: MarketplaceExtension[]
    total: number
    offset: number
    limit: number
  }

  interface PreparedInstallSummary {
    id: string
    version: string
    trustTier: 'signed-verified' | 'unsigned'
    sensitive: string[]
    containsBackendExecutable: boolean
    /** R2 MED-6 on #436: the manifest declares views (`contributes.views`). */
    hasViews?: boolean
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
    /** Source and review state, when the Host sends one; see `shared/pluginSource.ts`. */
    source?: PluginSource
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
    /** A Testplace build: its signed expiry and how the user joined the test. */
    expiresAt?: string
    testplaceVia?: 'invite' | 'code'
    /** Card K3: sha256 of the picked file, shown in the consent dialog. */
    digest?: string
    /** Card K3 (D7): the installed package of the same id a file install replaces. */
    replaces?: { version: string | null; source: 'marketplace' | 'local-unsigned' }
    /** Card K3 (D7): the local file install a Marketplace install replaces. */
    replacesLocal?: { version: string | null }
    /** D7: the replaced package's native backend data will be set aside. */
    backendDataSetAside?: boolean
    /** D7: data set aside earlier from the incoming source, which the user may take back. */
    reattachableBackendData?: true
    /** MED-1 on #425: false when the takedown list could not be checked. */
    takedownChecked?: boolean
    /** A3: what the `<file>.sig` beside a local file shows against the
     *  Navide-vetted publisher keys; `none` when there is no signature. */
    localSignature?: { state: 'none' } | { state: 'verified' | 'revoked' | 'unverifiable'; publisherId: string; keyId?: string }
    /** Card K4: the developer folder this summary was read from. */
    folder?: string
    /** W1: whether the shared static scan ran on a local file (`scan` holds it). */
    localScan?: 'ran' | 'unavailable'
  }

  /** One test the user joined (Testplace, W5b). */
  interface TestplaceListing {
    id: string
    namespace: string
    name: string
    displayName: string | null
    description: string | null
    publisher: string
    via: 'invite' | 'code' | null
    versions: Array<{ version: string; target: string; expiresAt: string | null; installable: boolean; compatible: boolean | null }>
  }

  /** D3: an installed Testplace build stopped because it expired; its data is kept. */
  interface ExpiredTestplaceBuild {
    id: string
    version: string | null
    expiresAt: string | null
    artifactDigest?: string
    /** False when it was taken down or fails for another reason: no "keep using". */
    canKeep: boolean
    /** Its developer or Navide took it back (S8 T-MED-1). */
    withdrawn?: true
    keepRefusal?: 'withdrawn' | 'signed-out' | 'not-a-tester' | 'registry-outdated' | 'unreachable'
  }

  /** Card K4: the Developer Mode switch and the developer folders consented to. */
  interface DeveloperModeState {
    enabled: boolean
    folders: Array<{ pluginId: string; path: string; consentedAt: string; loaded: boolean; unavailable?: string }>
  }
}

export {}
