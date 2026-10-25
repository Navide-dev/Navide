<script setup lang="ts">
import { canonicalJson } from '../../../shared/canonicalJson'
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { disabledReasonKey } from '../lib/linkStatus'
import type { LegalRoute } from '../../../shared/legalLinks'
import type { useBackend } from '../composables/useBackend'
import type { useRoles } from '../composables/useRoles'
import type { useStages } from '../composables/useStages'
import type { useAnalyzer } from '../composables/useAnalyzer'
import type { usePipelines } from '../composables/usePipelines'
import { MCP_CATALOG, isMcpInstalled, type McpCatalogEntry } from '../data/mcpCatalog'
import { AVAILABLE_UI_LOCALES, isBetaUiLocale, useTheme, vTruncate } from '@navide/plugin-ui/foundation'
import { useSettings } from '../composables/useSettings'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  cliPermissionKey,
  parseCliPermissionMode,
  type CliPermissionMode
} from '@navide/plugin-shell'
import {
  USAGE_ENABLED_KEY,
  USAGE_REFRESH_OPTIONS,
  setUsageEnabled,
  setUsageRefreshSec,
  usageRefreshSec,
} from '../composables/useUsage'
import { setSystemNotifyEnabled } from '../composables/useSystemNotify'
import { setNotifySoundEnabled } from '../composables/useSoundNotify'
import { notifySoundOn, systemNotifyOn } from '../composables/useNotifyPrefs'
import { usePermissions } from '../composables/usePermissions'
import {
  AUTO_RESUME_ON_RECONNECT_SETTING_KEY,
  RESUME_BEHAVIOR_SETTING_KEY,
  RESTORE_SCOPE_SETTING_KEY,
  RESUME_INTERRUPTED_ON_LAUNCH_SETTING_KEY,
  normalizeAutoResumeOnReconnect,
  normalizeResumeInterruptedOnLaunch,
  normalizeResumeBehavior,
  normalizeRestoreScope,
  type ResumeBehavior,
  type RestoreScope,
} from '../lib/resumeBehavior'
import {
  RESUME_CONCURRENCY_SETTING_KEY,
  DEFAULT_RESUME_CONCURRENCY,
  MIN_RESUME_CONCURRENCY,
  MAX_RESUME_CONCURRENCY,
  clampResumeConcurrency,
} from '@navide/terminal'
import {
  DEFAULT_EDITOR_SETTING_KEY,
  DEFAULT_EDITOR_COMMAND_KEY,
  DEFAULT_EDITOR_ID,
  DETECTABLE_EDITOR_IDS,
  CUSTOM_COMMAND_PRESETS,
  normalizeDefaultEditor,
  parseCustomCommand,
  formatCustomCommand,
  type DetectedEditor,
} from '../lib/defaultEditor'
import { useDisabledBuiltins } from '../composables/useDisabledBuiltins'
import { useCliAgentPrefs } from '../composables/useCliAgentPrefs'
import { useOnboarding } from '../composables/useOnboarding'
import {
  pushChannelEnabled,
  togglePushChannel,
  usePushChannelPrefs,
} from '../composables/usePushChannelPrefs'
import { cliAgentRowChips } from '../lib/cliAgentRow'
import { modelRefusalMessage } from '../lib/agentSpawnGate'
import {
  SPAWN_ENV_RESERVED_KEYS,
  cliCommandKey,
  cliEnvKey,
  cliModelKey,
  isReservedSpawnEnvKey,
  isValidEnvName,
  modelArgsFor,
  parseCliEnvOverride,
  parseCliModelDefault,
  serializeCliEnvOverride,
  serializeCliModelDefault,
  type CliEnvEntry,
  type CliModelDefault,
} from '@navide/plugin-shell'
import {
  ANY as POLICY_ANY,
  addRule as addPolicyRuleTo,
  allowsOwnDevices,
  makeRule as makePolicyRule,
  readPolicy,
  removeRuleAt as removePolicyRuleAt,
  withOwnDevices,
  type PolicyDocument,
} from '../lib/panePolicy'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { useQuotaFailover, type FailoverMode } from '../composables/useQuotaFailover'
import { LOOP_FAILOVER_RESUME_SETTING_KEY } from '../lib/loopFailoverResume'
import { setAccountFollowSwitch, useAccountFollowSwitchFlag } from '../lib/accountFollowSwitch'
import { platformId } from '../../../shared/osplat'
import { useUpdater } from '../composables/useUpdater'
import { updateStages } from '../lib/updaterStages'
import type { UpdateChannel } from '../../../shared/updater'
import {
  CHECK_FAILURE_THRESHOLD_RANGE,
  DOWNLOAD_RETRY_COUNT_RANGE,
  INSTALL_TIMEOUT_SECONDS_RANGE,
} from '../../../shared/updater'
import { useGitAccounts } from '../composables/useGitAccounts'
import GitAccountsPane from './GitAccountsPane.vue'
import CliAccountsPane from './CliAccountsPane.vue'
import CliManagementPanel from './CliManagementPanel.vue'
import CliRiskRangesPane from './CliRiskRangesPane.vue'
import CliExtensionsPane from './CliExtensionsPane.vue'
import type { useCliProfiles } from '../composables/useCliProfiles'
import KeyboardShortcutsEditor from './KeyboardShortcutsEditor.vue'
import CliMessagingHelp from './CliMessagingHelp.vue'
import McpHelp from './McpHelp.vue'
import WorkspacePanesHelp from './WorkspacePanesHelp.vue'
import CliAgentsHelp from './CliAgentsHelp.vue'
import CodeWorkflowHelp from './CodeWorkflowHelp.vue'
import SettingsSystemHelp from './SettingsSystemHelp.vue'
import IconReferenceHelp from './IconReferenceHelp.vue'
import CrossPlatformHelp from './CrossPlatformHelp.vue'
import ExtensionsPane from './ExtensionsPane.vue'
import ExecutionPolicyPane from './ExecutionPolicyPane.vue'
import MarketplacePane from './MarketplacePane.vue'
import MarketplaceDeveloperPanel from './MarketplaceDeveloperPanel.vue'
import TestplacePane from './TestplacePane.vue'
import { marketplaceView, setMarketplaceView } from '../composables/useMarketplaceForms'
import PluginDisclosureOverview from './PluginDisclosureOverview.vue'
import { usePluginUpdates } from '../composables/usePluginUpdates'
import LayoutSettingsPane from '../layout/LayoutSettingsPane.vue'
import McpPane from './McpPane.vue'
import SkillsPane from './SkillsPane.vue'
import CredentialsPane from './CredentialsPane.vue'
import PromptSkillsPane from './PromptSkillsPane.vue'
import SyncSettings from './SyncSettings.vue'
import CloudSubtabs, { type CloudSubtab } from './cloud/CloudSubtabs.vue'
import CloudInventorySection from './cloud/CloudInventorySection.vue'
import CloudDevicesSection from './cloud/CloudDevicesSection.vue'
import ShareLinksPane from './cloud/ShareLinksPane.vue'
import { useShareLinks } from '../composables/useShareLinks'
import { forgetSyncInventory } from '../composables/useSyncInventory'
import MemoryPane from './MemoryPane.vue'
import StatusBadgeSettingsPane from './StatusBadgeSettingsPane.vue'
import ChannelsPane from './settings/ChannelsPane.vue'
import SecurityPane from './settings/SecurityPane.vue'
import NavideCloudMark from './NavideCloudMark.vue'
import SettingsNavItem from './settings/SettingsNavItem.vue'
import SettingsNavSubItem from './settings/SettingsNavSubItem.vue'
import SettingsSection from './settings/SettingsSection.vue'
import SettingsCard from './settings/SettingsCard.vue'
import SettingRow from './settings/SettingRow.vue'
import ToggleSwitch from './settings/ToggleSwitch.vue'
import RecentWorkspacesLimitRow from './settings/RecentWorkspacesLimitRow.vue'
import ResourceLimitsSection from './settings/ResourceLimitsSection.vue'
import VoiceSettingsSection from './settings/VoiceSettingsSection.vue'
import { formatBytes } from '../lib/formatBytes'
import { UI_SCALE_STEPS, formatUiScale, getUiScale, setUiScale } from '../lib/uiScale'
import {
  RevisionedMcpSaveQueue,
  shouldReloadMcpAfterBundleImport,
  type McpAgent,
  type McpTransport,
  type NativeMcpServer,
  type RevisionedMcpSaveOutcome,
} from '../lib/mcp-settings-editor'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  rolesApi: ReturnType<typeof useRoles>
  cliProfilesApi: ReturnType<typeof useCliProfiles>
  /** True when a workspace is open — CLI account sign-in needs one to spawn
   *  the login pane. */
  workspaceOpen?: boolean
  /** The workspace currently open, empty when none is. The Memory tab edits
   *  this project's instruction files. */
  workspacePath?: string
  stagesApi: ReturnType<typeof useStages>
  analyzerApi: ReturnType<typeof useAnalyzer>
  pipelinesApi?: ReturnType<typeof usePipelines>
  initialTab?: Tab
  /** Bumped by the caller to re-assert initialTab even when its value is unchanged. */
  tabRequest?: number
  confirmBeforeClose?: boolean
  confirmBeforeClosePane?: boolean
  confirmBeforeCloseWorkspace?: boolean
  /** Global permission-bypass toggle. Owned by App.vue; ControlPane edits the
   *  same ref, so this page mirrors it rather than owning a second copy. */
  yoloEnabled?: boolean
  idleReclaimEnabled?: boolean
  idleReclaimMinutes?: string
  /** Panes that could be reclaimed right now, ignoring the idle threshold. */
  reclaimableNowCount?: number
  /** Rough bytes those panes are holding. Estimated, not measured. */
  reclaimableNowBytes?: number
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'reopen-onboarding'): void
  (e: 'cli-login', agentKey: string, loginProfileId?: string): void
  (e: 'update:confirmBeforeClose', v: boolean): void
  (e: 'update:yoloEnabled', v: boolean): void
  (e: 'update:confirmBeforeClosePane', v: boolean): void
  (e: 'update:confirmBeforeCloseWorkspace', v: boolean): void
  (e: 'update:idleReclaimEnabled', v: boolean): void
  (e: 'update:idleReclaimMinutes', v: string): void
  (e: 'reclaim-now'): void
  (e: 'open-resource-manager'): void
}>()
const confirmBeforeCloseModel = computed({
  get: () => props.confirmBeforeClose ?? true,
  set: (v: boolean) => emit('update:confirmBeforeClose', v),
})
// The same toggle the ⌘W dialog's "don't show again" flips — this row is how a
// user who ticked it gets the prompt back.
const confirmBeforeClosePaneModel = computed({
  get: () => props.confirmBeforeClosePane ?? true,
  set: (v: boolean) => emit('update:confirmBeforeClosePane', v),
})
// Likewise for the sidebar's close-workspace dialog. Its own row, because the
// two dialogs guard different losses: a pane's scrollback, and every pane
// record in a project.
const confirmBeforeCloseWorkspaceModel = computed({
  get: () => props.confirmBeforeCloseWorkspace ?? true,
  set: (v: boolean) => emit('update:confirmBeforeCloseWorkspace', v),
})
// Reclaiming an idle CLI frees the memory it is sitting on and leaves the
// click-to-resume placeholder behind, so the row reads as a memory setting
// rather than as a way of closing panes.
const idleReclaimEnabledModel = computed({
  get: () => props.idleReclaimEnabled ?? true,
  set: (v: boolean) => emit('update:idleReclaimEnabled', v),
})
const idleReclaimMinutesModel = computed(() => props.idleReclaimMinutes ?? '30')
function onIdleReclaimMinutesChange(v: string): void {
  emit('update:idleReclaimMinutes', v)
}
// The button says what it is about to do — a count and a size — because
// "reclaim" alone does not tell you whether pressing it costs you one pane or
// a dozen. Zero disables it and the row says so rather than hiding, so the
// control does not appear and disappear as panes go idle.
const reclaimNowCount = computed(() => props.reclaimableNowCount ?? 0)
const reclaimNowSize = computed(() => formatBytes(props.reclaimableNowBytes ?? 0))

// ── Tab ───────────────────────────────────────────────────────────────────────
/** Active high-risk credential findings, shown as the nav badge. */
const credentialsHighCount = ref(0)

type Tab = 'mcp' | 'skills' | 'credentials' | 'prompts' | 'memory' | 'analyzer' | 'cliAgents' | 'cliExtensions' | 'general' | 'cross-device' | 'updates' | 'appearance' | 'language' | 'statusBadges' | 'layout' | 'notifications' | 'voice' | 'accounts' | 'extensions' | 'marketplace' | 'disclosureOverview' | 'keybindings' | 'channels' | 'security' | 'help'

/** Topics inside the Help tab — read-only reference material, no settings. */
type HelpTopic =
  | 'workspace'
  | 'cliAgents'
  | 'messaging'
  | 'mcp'
  | 'codeWorkflow'
  | 'settingsSystem'
  | 'crossPlatform'
  | 'icons'
const helpTopic = ref<HelpTopic>('workspace')
// Navide Cloud page sub-tab; every deep link into the page targets Sync.
const cloudSubtab = ref<CloudSubtab>('sync')
// Topic order is the reading order: what the main window is made of, then the
// agents in it, then how they talk, then the code surfaces, then settings.
const helpTopicComponents: Record<HelpTopic, Component> = {
  workspace: WorkspacePanesHelp,
  cliAgents: CliAgentsHelp,
  messaging: CliMessagingHelp,
  mcp: McpHelp,
  codeWorkflow: CodeWorkflowHelp,
  settingsSystem: SettingsSystemHelp,
  crossPlatform: CrossPlatformHelp,
  icons: IconReferenceHelp,
}
const helpTopicOrder: HelpTopic[] = [
  'workspace',
  'cliAgents',
  'messaging',
  'mcp',
  'codeWorkflow',
  'settingsSystem',
  'crossPlatform',
  'icons',
]
const activeTab = ref<Tab>(props.initialTab ?? 'general')
// The CLI Extensions page scans every CLI's files, so it mounts on first visit
// and stays mounted after that.
const visitedCliExtensions = ref(activeTab.value === 'cliExtensions')
// Navide Plugins is four pages under its sidebar entry: the plugins, the
// execution policy, developer and native settings, and the disclosure records.
type PluginsPage = 'plugins' | 'policy' | 'developer' | 'disclosure'
const pluginsPages = [
  { id: 'plugins', label: 'settings.extensions.listTitle' },
  { id: 'policy', label: 'settings.nav.executionPolicy' },
  { id: 'developer', label: 'settings.extensions.developerNative' },
  { id: 'disclosure', label: 'settings.nav.disclosureOverview' },
] as const satisfies ReadonlyArray<{ id: PluginsPage; label: string }>
const pluginsPage = ref<PluginsPage>('plugins')
const pluginsPageLabel = computed(() => pluginsPages.find((page) => page.id === pluginsPage.value)!.label)
/** The page each section of the former single Navide Plugins page lives on. */
const PLUGINS_SECTION_PAGE: Readonly<Record<string, PluginsPage>> = {
  'extensions-bundled': 'plugins',
  'extensions-install-from-file': 'plugins',
  'execution-policy': 'policy',
  'extensions-developer-mode': 'developer',
  'extensions-native-backends': 'developer',
  disclosureOverview: 'disclosure',
}
function openPluginsPage(page: PluginsPage): void {
  activeTab.value = 'extensions'
  pluginsPage.value = page
}
// Coming to Navide Plugins from another tab starts on its plugins page. The old
// `disclosureOverview` tab id stays accepted (initialTab, setTab, setSection,
// links) and opens the Disclosure page. Synchronous, so a caller that sets the
// tab and then a page in one go keeps its page.
watch(activeTab, (tab, previous) => {
  if (tab === 'disclosureOverview') {
    pluginsPage.value = 'disclosure'
    activeTab.value = 'extensions'
    return
  }
  if (tab === 'extensions' && previous !== 'extensions' && previous !== 'disclosureOverview') pluginsPage.value = 'plugins'
}, { immediate: true, flush: 'sync' })
watch(activeTab, (tab) => { if (tab === 'cliExtensions') visitedCliExtensions.value = true })
// D-f: the disclosure overview reads every plugin's activity, so it mounts the
// first time its page is shown (opening Settings, or another page, reads
// nothing), and it polls only while that page is shown.
const disclosurePageShown = computed(() => activeTab.value === 'extensions' && pluginsPage.value === 'disclosure')
const visitedDisclosureOverview = ref(false)
watch(disclosurePageShown, (shown) => { if (shown) visitedDisclosureOverview.value = true }, { immediate: true })
// A plugin card's link: the Disclosure page, then that plugin's entry once the
// overview (loaded on first view) has rendered it.
function openDisclosureOverview(id?: string): void {
  openPluginsPage('disclosure')
  if (!id) return
  let tries = 0
  const seek = (): void => {
    const entry = document.querySelector<HTMLElement>(
      `[data-settings-section="disclosureOverview"] [data-id="${CSS.escape(id)}"]`,
    )
    if (entry) {
      entry.querySelector<HTMLDetailsElement>('details.nv-overview-record')?.setAttribute('open', '')
      entry.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    else if (++tries < 20) setTimeout(seek, 100)
  }
  setTimeout(seek, 50)
}
// initialTab is only read once at mount by the ref initializer above; when the
// modal is already open and a new tab is requested (e.g. the ui.settings.open
// action), react to the prop changing too.
watch(() => props.initialTab, (tab) => {
  if (tab) activeTab.value = tab
  if (tab === 'cross-device') cloudSubtab.value = 'sync'
})
// A repeated request for the tab already named in initialTab does not change
// the prop, so watch the counter too — otherwise pressing Cmd+K Cmd+S while
// Settings sits on another tab does nothing at all.
watch(() => props.tabRequest, () => {
  if (props.initialTab) activeTab.value = props.initialTab
  if (props.initialTab === 'cross-device') cloudSubtab.value = 'sync'
})
// Watching the prop is not enough on its own: re-issuing the same request (⌘K ⌘S
// twice, with a manual tab switch in between) leaves initialTab unchanged, so the
// watcher never fires and the shortcut looks dead. Callers that need to switch an
// already-open modal go through here instead.
defineExpose({
  setTab: (tab: Tab): void => {
    activeTab.value = tab
  },
  // Same two steps the search results take, for a caller outside this window
  // that knows which section it means — the account view pointing at the rules,
  // for one, which it used to do in prose and with nowhere to click.
  setSection: async (tab: Tab, section: string): Promise<void> => {
    activeTab.value = tab
    if (tab === 'cross-device') cloudSubtab.value = 'sync'
    if (tab === 'extensions' && PLUGINS_SECTION_PAGE[section]) pluginsPage.value = PLUGINS_SECTION_PAGE[section]
    if (tab === 'cliAgents') await openCliSection(section)
    await nextTick()
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-settings-section="${section}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  },
})

// Search the Shortcuts tab opens with when another page links to one command
// (Voice Input → Open Shortcuts); dropped once the tab is left, so a later
// visit starts unfiltered.
const shortcutsQuery = ref('')
function openShortcutsFor(command: string): void {
  shortcutsQuery.value = command
  activeTab.value = 'keybindings'
}
watch(activeTab, (tab) => {
  if (tab !== 'keybindings') shortcutsQuery.value = ''
})

// ── CLI Agents (enable/disable + reorder for the manual spawn dropdown) ────────
const { order: cliOrder, disabled: cliDisabled } = useCliAgentPrefs()

// The single onboarding instance for this window. It used to be created inside
// CliManagementPanel; the list rows above it need the same probe, and a second
// useOnboarding() would be a second `onboarding.status` round trip — which
// shells out once per dep — rather than a second reader of this one.
const onboarding = useOnboarding(props.backend)

/** vue-i18n's `t` is overloaded, and neither overload alone accepts the
 *  "params or nothing" shape the chip builder is written against. */
const translateChip = (key: string, params?: Record<string, unknown>): string =>
  params ? t(key, params) : t(key)

// ── Per-vendor launch overrides: model, effort, command line, environment ────
// All four are global-scope keys (`agentTeam.cliModel.*`, `.cliCommand.*`,
// `.cliEnv.*`), snapshotted when the tab opens: they are plain settings
// reads, not reactive stores.
// The drawer edits one vendor at a time; drafts never cross agent boundaries.
const expandedLaunchKey = ref('')
const launchModels = ref<Record<string, CliModelDefault>>({})
const launchCommands = ref<Record<string, string>>({})
const launchEnvs = ref<Record<string, CliEnvEntry[]>>({})
/** The refusal text for a vendor whose typed model/effort cannot be honoured,
 *  keyed by agent key. Present = the value was NOT written. */
const launchModelErrors = ref<Record<string, string>>({})

function refreshLaunchOverrides(): void {
  launchModels.value = Object.fromEntries(
    CLI_AGENT_SPECS.map((s) => [
      s.agentKey,
      parseCliModelDefault(settingsGet<unknown>(cliModelKey(s.agentKey), null)),
    ])
  )
  launchCommands.value = Object.fromEntries(
    CLI_AGENT_SPECS.map((s) => [s.agentKey, settingsGet(cliCommandKey(s.agentKey), '')])
  )
  launchEnvs.value = Object.fromEntries(
    CLI_AGENT_SPECS.map((s) => [
      s.agentKey,
      parseCliEnvOverride(settingsGet<unknown>(cliEnvKey(s.agentKey), null)),
    ])
  )
  launchModelErrors.value = {}
}

function launchModelFor(k: string): CliModelDefault {
  return launchModels.value[k] ?? { model: '', effort: '' }
}

/** Write a model/effort pair only if the vendor can actually be told it. The
 *  check and the wording both come from the spawn path's own modules, so the
 *  sentence here is the one the spawn card gives. A refused pair stays on
 *  screen with its reason rather than being silently discarded. */
function applyLaunchModel(k: string, next: CliModelDefault): void {
  const spec = CLI_AGENT_SPECS.find((s) => s.agentKey === k)
  const chosen = modelArgsFor({ spec, request: next })
  if (!chosen.ok) {
    // The refused value is NOT kept in launchModels: that map is also what the
    // list above reads its "model x" chip from, and a chip for a pick the spawn
    // would never make is worse than the field snapping back with a reason.
    const refusal = modelRefusalMessage(k, chosen.refusal, next.effort)
    launchModelErrors.value = {
      ...launchModelErrors.value,
      [k]: t(refusal.key, refusal.params),
    }
    return
  }
  const { [k]: _dropped, ...rest } = launchModelErrors.value
  launchModelErrors.value = rest
  launchModels.value = { ...launchModels.value, [k]: next }
  settingsSet(cliModelKey(k), serializeCliModelDefault(next))
}

function onLaunchModelInput(k: string, e: Event): void {
  applyLaunchModel(k, { ...launchModelFor(k), model: (e.target as HTMLInputElement).value.trim() })
}
function onLaunchEffortSelect(k: string, e: Event): void {
  applyLaunchModel(k, { ...launchModelFor(k), effort: (e.target as HTMLSelectElement).value })
}

function onLaunchCommandInput(k: string, e: Event): void {
  const value = (e.target as HTMLInputElement).value
  launchCommands.value = { ...launchCommands.value, [k]: value }
  // An empty override is the absence of one, so it clears the key rather than
  // storing '' — which resolveCommand would read the same way anyway.
  settingsSet(cliCommandKey(k), value.trim() || null)
}

function commitLaunchEnv(k: string, entries: CliEnvEntry[]): void {
  launchEnvs.value = { ...launchEnvs.value, [k]: entries }
  settingsSet(cliEnvKey(k), serializeCliEnvOverride(entries))
}
function onLaunchEnvValueInput(k: string, index: number, e: Event): void {
  const entries = [...(launchEnvs.value[k] ?? [])]
  if (!entries[index]) return
  entries[index] = { ...entries[index], value: (e.target as HTMLInputElement).value }
  commitLaunchEnv(k, entries)
}
function removeLaunchEnv(k: string, index: number): void {
  commitLaunchEnv(k, (launchEnvs.value[k] ?? []).filter((_, i) => i !== index))
}

// One draft pair, not one per vendor: only the open row can be typed into.
const envDraftName = ref('')
const envDraftValue = ref('')
/** Blocked while the name is unusable or already in the table — adding a second
 *  row for the same name would silently discard the first on save. */
const envDraftBlocked = computed(() => {
  const name = envDraftName.value.trim()
  if (!isValidEnvName(name)) return true
  return (launchEnvs.value[expandedLaunchKey.value] ?? []).some((e) => e.name === name)
})
function addLaunchEnv(k: string): void {
  if (envDraftBlocked.value) return
  commitLaunchEnv(k, [
    ...(launchEnvs.value[k] ?? []),
    { name: envDraftName.value.trim(), value: envDraftValue.value },
  ])
  envDraftName.value = ''
  envDraftValue.value = ''
}

const cliAgentRows = computed(() => {
  const rank = (k: string) => {
    const i = cliOrder.value.indexOf(k)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  const deps = new Map(onboarding.cliDeps.value.map((dep) => [dep.id, dep]))
  return [...CLI_AGENT_SPECS]
    .sort((a, b) => rank(a.agentKey) - rank(b.agentKey))
    .map((spec) => {
      const dep = deps.get(spec.agentKey)
      const identity = props.cliProfilesApi.identityFor(spec.agentKey, null)
      return {
        agentKey: spec.agentKey,
        label: spec.label,
        hint: spec.hint ?? '',
        version: dep?.version ?? '',
        needsAttention: dep?.status === 'missing' || dep?.status === 'outdated'
          || identity?.signedIn === false
          || !!onboarding.cliHealth.value?.findings.some((finding) => finding.agent_key === spec.agentKey),
        chips: cliAgentRowChips(
          {
            install: dep ? { status: dep.status, version: dep.version } : null,
            hasPermissionFlag: !!spec.skipPermissionFlag,
            permissionMode: cliPermissionMode(spec.agentKey),
            pushKind: spec.pushChannel?.kind ?? '',
            pushEnabled: pushChannelEnabled(spec.agentKey),
            supportsModel: !!spec.modelArgs,
            modelDefault: launchModelFor(spec.agentKey),
            signedIn: identity ? identity.signedIn : null,
            // The built-in Default slot is an account too, so a vendor with no
            // extra profile still has one.
            accountCount: props.cliProfilesApi.profilesForAgent(spec.agentKey).length + 1,
            binaryOverride: !!dep?.binary_override,
            commandOverride: !!(launchCommands.value[spec.agentKey] ?? '').trim(),
            envOverrideCount: (launchEnvs.value[spec.agentKey] ?? []).length,
          },
          translateChip
        ),
      }
    })
})
/** The launch-override editor's rows, in the list's own order so the two
 *  sections read the same way down the page. What each vendor may be told is
 *  taken from its spec — declaring `modelArgs` is what puts a Model field on a
 *  row, and there is no model list anywhere: ids change every release, so the
 *  field is free text and `modelArgsFor` judges it. */
const launchRows = computed(() =>
  cliAgentRows.value.map((row) => {
    const spec = CLI_AGENT_SPECS.find((s) => s.agentKey === row.agentKey)
    return {
      agentKey: row.agentKey,
      label: row.label,
      supportsModel: !!spec?.modelArgs,
      supportsEffort: !!spec?.effortArgs,
      knownEfforts: spec?.knownEfforts ?? [],
    }
  })
)
/** Named in the section's footnote so a marked row points at a list rather
 *  than leaving the rule implicit. */
const reservedEnvKeyList = SPAWN_ENV_RESERVED_KEYS.join(', ')

const cliEnabledCount = computed(
  () => CLI_AGENT_SPECS.filter((s) => !cliDisabled.value.includes(s.agentKey)).length
)
function cliAgentEnabled(k: string): boolean {
  return !cliDisabled.value.includes(k)
}
function toggleCliAgent(k: string): void {
  const set = new Set(cliDisabled.value)
  if (set.has(k)) {
    set.delete(k)
  } else {
    if (cliEnabledCount.value <= 1) return // keep at least one enabled — else nothing can spawn
    set.add(k)
  }
  cliDisabled.value = [...set]
}
// ── Push channels (which CLIs may be handed a message without typing) ────────
// The list itself lives in usePushChannelPrefs — a module-scoped ref, so a
// second window editing this page repaints this one instead of leaving it on a
// stale copy until reload.
const { pushDisabled } = usePushChannelPrefs()
const pushChannelRows = computed(() =>
  CLI_AGENT_SPECS.filter((s) => s.pushChannel)
)
/** Every channel off is allowed, but it costs something the page has to say. */
const allPushChannelsOff = computed(() =>
  pushChannelRows.value.length > 0
  && pushChannelRows.value.every((s) => pushDisabled.value.includes(s.agentKey))
)

// ── Permission bypass (global toggle + per-vendor override) ──────────────────
// The global flag is owned by App.vue (ControlPane edits the same ref), so it
// travels as a model prop rather than being written here — two writers on one
// settings key would leave App's ref stale until reload.
const yoloModel = computed({
  get: () => props.yoloEnabled ?? true,
  set: (v: boolean) => emit('update:yoloEnabled', v),
})
/** CLIs that declare a bypass flag. The rest (grok / opencode / pi) have no
 *  permission gate to skip, so an override row for them would be a no-op. */
const permissionRows = computed(() => CLI_AGENT_SPECS.filter((s) => s.skipPermissionFlag))
const permissionModes = ref<Record<string, CliPermissionMode>>(
  Object.fromEntries(
    CLI_AGENT_SPECS.filter((s) => s.skipPermissionFlag).map((s) => [
      s.agentKey,
      parseCliPermissionMode(settingsGet<string | null>(cliPermissionKey(s.agentKey), null)),
    ])
  )
)
function cliPermissionMode(k: string): CliPermissionMode {
  return permissionModes.value[k] ?? 'inherit'
}
function setCliPermissionMode(k: string, mode: CliPermissionMode): void {
  permissionModes.value = { ...permissionModes.value, [k]: mode }
  // 'inherit' is the absence of an override, so it clears the key instead of
  // storing a value the resolver would read the same way anyway.
  settingsSet(cliPermissionKey(k), mode === 'inherit' ? null : mode)
}
function onPermissionSelect(k: string, e: Event): void {
  setCliPermissionMode(k, parseCliPermissionMode((e.target as HTMLSelectElement).value))
}
const cliFilter = ref<'all' | 'enabled' | 'attention'>('all')
const cliFilterQuery = ref('')
const selectedCliKey = ref('')
const lastManagedCliKey = ref('')
const cliDrawerRef = ref<HTMLElement | null>(null)
const cliGridRef = ref<HTMLElement | null>(null)
const cliPanelRef = ref<InstanceType<typeof CliManagementPanel> | null>(null)
const cliInstallOpen = ref(false)
let cliDrawerTrigger: HTMLElement | null = null
const selectedCli = computed(() => cliAgentRows.value.find((row) => row.agentKey === selectedCliKey.value))
const selectedLaunchRows = computed(() => launchRows.value.filter((row) => row.agentKey === selectedCliKey.value))
const selectedPermissionRows = computed(() => permissionRows.value.filter((row) => row.agentKey === selectedCliKey.value))
const selectedPushRows = computed(() => pushChannelRows.value.filter((row) => row.agentKey === selectedCliKey.value))
const cliCanReorder = computed(() => cliFilter.value === 'all' && !cliFilterQuery.value.trim())
const filteredCliRows = computed(() => {
  const query = cliFilterQuery.value.trim().toLowerCase()
  return cliAgentRows.value.filter((row) =>
    (!query || `${row.label} ${row.agentKey}`.toLowerCase().includes(query))
    && (cliFilter.value !== 'enabled' || cliAgentEnabled(row.agentKey))
    && (cliFilter.value !== 'attention' || row.needsAttention)
  )
})

async function openCliDrawer(key: string, trigger?: EventTarget | null): Promise<void> {
  if (!CLI_AGENT_SPECS.some((spec) => spec.agentKey === key)) return
  cliDrawerTrigger = trigger instanceof HTMLElement
    ? trigger.closest('.cli-agent-card')?.querySelector<HTMLElement>('.cli-agent-manage') ?? trigger
    : document.activeElement as HTMLElement | null
  selectedCliKey.value = key
  lastManagedCliKey.value = key
  expandedLaunchKey.value = key
  envDraftName.value = ''
  envDraftValue.value = ''
  await nextTick()
  // The drawer is still at translateX(100%) here; without preventScroll the
  // clipped container scrolls to the off-screen button and snaps back.
  cliDrawerRef.value?.querySelector<HTMLButtonElement>('.cli-drawer-close')?.focus({ preventScroll: true })
}

async function closeCliDrawer(restoreFocus = true): Promise<void> {
  if (cliInstallOpen.value) return
  const key = selectedCliKey.value
  selectedCliKey.value = ''
  expandedLaunchKey.value = ''
  envDraftName.value = ''
  envDraftValue.value = ''
  await nextTick()
  if (restoreFocus && activeTab.value === 'cliAgents') {
    if (cliDrawerTrigger?.isConnected) cliDrawerTrigger.focus()
    else {
      const card = [...(cliGridRef.value?.querySelectorAll<HTMLElement>('.cli-agent-card') ?? [])]
        .find((element) => element.dataset.agentKey === key)
      const target = card?.querySelector<HTMLElement>('.cli-agent-manage')
        ?? cliGridRef.value?.querySelector<HTMLInputElement>('.cli-agent-filter-search')
      target?.focus()
    }
  }
  cliDrawerTrigger = null
}

function closeSettingsLayer(): void {
  if (cliInstallOpen.value) { cliPanelRef.value?.closeInstallDialog(); return }
  if (selectedCliKey.value) { void closeCliDrawer(); return }
  emit('close')
}

async function openCliSection(section: string, query = ''): Promise<void> {
  if (!['cli-agents-launch', 'cli-agents-permissions', 'cli-agents-push', 'cli-agents-maintenance'].includes(section)) {
    await closeCliDrawer(false)
    return
  }
  const candidates = cliAgentRows.value.filter((row) =>
    section === 'cli-agents-permissions' ? permissionRows.value.some((spec) => spec.agentKey === row.agentKey)
      : section === 'cli-agents-push' ? pushChannelRows.value.some((spec) => spec.agentKey === row.agentKey) : true)
  const text = ` ${query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
  // Match whole names before choosing a supported default: "Copilot" must not
  // select Pi, and explicitly requesting Codex Push must explain its absence.
  const namedAgent = [...cliAgentRows.value]
    .sort((a, b) => b.label.length - a.label.length)
    .find((row) => [row.agentKey, row.label].some((name) =>
      text.includes(` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `)))
  const agent = namedAgent
    ?? candidates.find((row) => row.agentKey === lastManagedCliKey.value) ?? candidates[0]
  if (agent) await openCliDrawer(agent.agentKey)
}

function trapCliDrawerFocus(event: KeyboardEvent): void {
  const root = cliInstallOpen.value
    ? cliDrawerRef.value?.querySelector<HTMLElement>('.ci-dialog')
    : cliDrawerRef.value
  if (!root) return
  const controls = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')]
    .filter((element) => {
      for (let parent: HTMLElement | null = element; parent && parent !== root; parent = parent.parentElement) {
        if (parent.hidden || parent.hasAttribute('inert') || getComputedStyle(parent).display === 'none') return false
      }
      return true
    })
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (!first) { event.preventDefault(); root.focus(); return }
  if (!root.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

const cliDragKey = ref('')
const cliDragOverKey = ref('')
function onCliDragStart(e: DragEvent, k: string): void {
  if (!cliCanReorder.value) { e.preventDefault(); return }
  cliDragKey.value = k
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', k)
  }
}
function onCliDragOver(e: DragEvent, k: string): void {
  if (!cliDragKey.value || cliDragKey.value === k) return
  e.preventDefault()
  cliDragOverKey.value = k
}
function onCliDragLeave(k: string): void {
  if (cliDragOverKey.value === k) cliDragOverKey.value = ''
}
function onCliDrop(k: string): void {
  const from = cliDragKey.value
  cliDragOverKey.value = ''
  cliDragKey.value = ''
  if (!cliCanReorder.value || !from || from === k) return
  const keys = cliAgentRows.value.map((s) => s.agentKey)
  const fi = keys.indexOf(from)
  const ti = keys.indexOf(k)
  if (fi < 0 || ti < 0) return
  keys.splice(ti, 0, keys.splice(fi, 1)[0])
  cliOrder.value = keys
}

const { t } = useI18n()

interface SettingsSearchItem {
  id: string
  tab: Tab
  section: string
  title: string
  group: string
  summary: string
  keywords: string
  mcpView?: MView
  helpTopic?: HelpTopic
  /** A result that is a door out of Settings rather than a place in it. */
  opens?: 'resource-manager'
}

const settingsSearchQuery = ref('')
const settingsSearchItems = computed<SettingsSearchItem[]>(() => [
  {
    id: 'cli-extensions',
    tab: 'cliExtensions',
    section: 'cli-extensions',
    title: t('settings.search.item.cliExtensions.title'),
    group: t('settings.nav.group.integration'),
    summary: t('settings.search.item.cliExtensions.summary'),
    keywords: 'cli extension extensions plugin plugins mod mods hook hooks marketplace claude codex copilot droid muse opencode kilo pi cursor grok kimi qwen inventory capability CLI 擴充 外掛 插件 擴展 hook 能力 盤點 CLI 拡張 プラグイン フック',
  },
  {
    id: 'cli-agents-list',
    tab: 'cliAgents',
    section: 'cli-agents-list',
    title: t('settings.search.item.cli-agents-list.title'),
    group: t('settings.nav.cliAgents'),
    summary: t('settings.search.item.cli-agents-list.summary'),
    keywords: 'cli agent agents enable disable reorder order spawn dropdown install version permission account binary claude codex cursor aider 啟用 停用 排序 安裝 權限 帳號 執行檔',
  },
  {
    id: 'cli-agents-launch',
    tab: 'cliAgents',
    section: 'cli-agents-launch',
    title: t('settings.search.item.cli-agents-launch.title'),
    group: t('settings.nav.cliAgents'),
    summary: t('settings.search.item.cli-agents-launch.summary'),
    keywords: 'model effort launch command override env environment variable proxy opus sonnet gpt reasoning 模型 強度 啟動指令 覆寫 環境變數 代理',
  },
  {
    id: 'cli-agents-permissions',
    tab: 'cliAgents',
    section: 'cli-agents-permissions',
    title: t('settings.search.item.cli-agents-permissions.title'),
    group: t('settings.nav.cliAgents'),
    summary: t('settings.search.item.cli-agents-permissions.summary'),
    keywords: 'permission bypass yolo skip prompt dangerously-skip-permissions unattended per-vendor override 權限 略過 免詢問 覆寫',
  },
  {
    id: 'cli-agents-push',
    tab: 'cliAgents',
    section: 'cli-agents-push',
    title: t('settings.search.item.cli-agents-push.title'),
    group: t('settings.nav.cliAgents'),
    summary: t('settings.search.item.cli-agents-push.summary'),
    keywords: 'push channel channels rewake tui-http input-file message delivery idle typed 推送 通道 喚醒 訊息 送達',
  },
  {
    id: 'cli-agents-maintenance',
    tab: 'cliAgents',
    section: 'cli-agents-maintenance',
    title: t('settings.search.item.cli-agents-maintenance.title'),
    group: t('settings.nav.cliAgents'),
    summary: t('settings.search.item.cli-agents-maintenance.summary'),
    keywords: 'install update detect version binary path duplicate which npm homebrew doctor 安裝 更新 偵測 版本 執行檔 路徑 重複',
  },
  {
    id: 'mcp-installed',
    tab: 'mcp',
    section: 'mcp-installed',
    title: t('settings.search.item.mcp-installed.title'),
    group: t('settings.nav.mcp'),
    summary: t('settings.search.item.mcp-installed.summary'),
    keywords: 'mcp server servers tools command args env context7 enable disable config refresh 已安裝 工具 環境變數 設定檔',
  },
  {
    id: 'mcp-catalog',
    tab: 'mcp',
    section: 'mcp-catalog',
    title: t('settings.search.item.mcp-catalog.title'),
    group: t('settings.nav.mcp'),
    summary: t('settings.search.item.mcp-catalog.summary'),
    keywords: 'mcp catalog add install search context reading 新增 安裝 搜尋 目錄',
    mcpView: 'catalog',
  },
  {
    id: 'mcp-agents',
    tab: 'mcp',
    section: 'mcp-agents',
    mcpView: 'list',
    title: t('settings.search.item.mcp-agents.title'),
    group: t('settings.nav.mcp'),
    summary: t('settings.search.item.mcp-agents.summary'),
    keywords: 'mcp native cli claude codex copilot cursor kimi grok reflect compare matrix 原生 對照 各家 設定檔 唯讀',
  },
  {
    id: 'skills',
    tab: 'skills',
    section: 'skills',
    title: t('settings.search.item.skills.title'),
    group: t('settings.nav.group.integration'),
    summary: t('settings.search.item.skills.summary'),
    keywords: 'skills skill agent instructions markdown enable disable attachments 技能 指令 啟用 停用 附件',
  },
  {
    id: 'credentials',
    tab: 'credentials',
    section: 'credentials',
    title: t('settings.search.item.credentials.title'),
    group: t('settings.nav.group.integration'),
    summary: t('settings.search.item.credentials.summary'),
    keywords: 'credentials keys secrets token ssh keychain keyring git helper scan risk reminder 憑證 金鑰 密鑰 鑰匙圈 掃描 風險 提醒',
  },
  {
    id: 'prompts',
    tab: 'prompts',
    section: 'prompts',
    title: t('settings.search.item.prompts.title'),
    group: t('settings.nav.group.integration'),
    summary: t('settings.search.item.prompts.summary'),
    keywords: 'prompt skills loop 技能 提示詞 迴圈 循環 按鈕 預設 preset resume 續跑 輪次 max turns',
  },
  {
    id: 'memory',
    tab: 'memory',
    section: 'memory',
    title: t('settings.search.item.memory.title'),
    group: t('settings.nav.group.integration'),
    summary: t('settings.search.item.memory.summary'),
    keywords: 'memory instructions claude.md agents.md qwen.md cursor rules mdc context 指示檔 記憶 規則 說明檔',
  },
  {
    id: 'analyzer-backend',
    tab: 'analyzer',
    section: 'analyzer-backend',
    title: t('settings.search.item.analyzer-backend.title'),
    group: t('settings.nav.analyzer'),
    summary: t('settings.search.item.analyzer-backend.summary'),
    keywords: 'analyzer inference backend 推論 分析器 ollama llama llama.cpp llama-cli gguf url base url health',
  },
  {
    id: 'analyzer-models',
    tab: 'analyzer',
    section: 'analyzer-models',
    title: t('settings.search.item.analyzer-models.title'),
    group: t('settings.nav.analyzer'),
    summary: t('settings.search.item.analyzer-models.summary'),
    keywords: 'model models benchmark download delete pull ollama 模型 基準測試 下載 刪除',
  },
  {
    id: 'appearance-theme',
    tab: 'appearance',
    section: 'appearance-theme',
    title: t('settings.search.item.appearance-theme.title'),
    group: t('settings.nav.appearance'),
    summary: t('settings.search.item.appearance-theme.summary'),
    keywords: 'appearance theme custom colors color 外觀 主題 自訂顏色 背景 文字 邊框 accent high contrast',
  },
  {
    id: 'general-default-editor',
    tab: 'general',
    section: 'general-default-editor',
    title: t('settings.search.item.general-default-editor.title'),
    group: t('settings.nav.group.general'),
    summary: t('settings.search.item.general-default-editor.summary'),
    keywords: 'default editor open with mini-ide system vscode visual studio code cursor sublime custom command placeholder 預設編輯器 開啟 外部編輯器 自訂命令 偵測',
  },
  {
    id: 'settings-management',
    tab: 'general',
    section: 'settings-management',
    title: t('settings.search.item.settings-management.title'),
    group: t('settings.nav.group.general'),
    summary: t('settings.search.item.settings-management.summary'),
    keywords: 'settings management export import bundle config path location scope user workspace 設定管理 匯出 匯入 全集 位置 路徑 層級',
  },
  {
    id: 'general-p2p',
    tab: 'cross-device',
    section: 'general-p2p',
    title: t('settings.search.item.general-p2p.title'),
    group: t('settings.nav.group.navidePlugins'),
    summary: t('settings.search.item.general-p2p.summary'),
    keywords: 'navide cloud p2p cross device remote server url access token navide-server connect link relay 雲端 跨裝置 遠端 伺服器 網址 權杖 連線 傳訊',
  },
  {
    id: 'general-p2p-policy',
    tab: 'cross-device',
    section: 'general-p2p-policy',
    title: t('settings.search.item.general-p2p-policy.title'),
    group: t('settings.nav.group.navidePlugins'),
    summary: t('settings.search.item.general-p2p-policy.summary'),
    keywords: 'navide cloud policy permission authorization allow rule deny default pane cross device remote rejected 雲端 政策 權限 授權 允許 規則 拒絕 跨裝置 被擋',
  },
  {
    id: 'appearance-language',
    tab: 'language',
    section: 'appearance-language',
    title: t('settings.search.item.appearance-language.title'),
    group: t('settings.nav.language'),
    summary: t('settings.search.item.appearance-language.summary'),
    keywords: 'language locale 語言 繁體中文 english 日本語 japanese en-us zh-tw ja-jp 简体中文 한국어 español français deutsch português русский tiếng việt zh-cn ko-kr es-es fr-fr de-de pt-br ru-ru vi-vn',
  },
  {
    id: 'appearance-ui-scale',
    tab: 'appearance',
    section: 'appearance-ui-scale',
    title: t('settings.search.item.appearance-ui-scale.title'),
    group: t('settings.nav.appearance'),
    summary: t('settings.search.item.appearance-ui-scale.summary'),
    keywords: 'ui scale zoom interface magnify enlarge shrink bigger smaller font size percent dpi 介面 縮放 放大 縮小 字級 字體 大小 百分比 老花',
  },
  {
    id: 'appearance-runtime',
    tab: 'appearance',
    section: 'appearance-runtime',
    title: t('settings.search.item.appearance-runtime.title'),
    group: t('settings.nav.appearance'),
    summary: t('settings.search.item.appearance-runtime.summary'),
    keywords: 'restore windows 還原視窗 startup 啟動',
  },
  {
    id: 'status-badges',
    tab: 'statusBadges',
    section: 'statusBadges',
    title: t('settings.search.item.status-badges.title'),
    group: t('settings.nav.appearance'),
    summary: t('settings.search.item.status-badges.summary'),
    keywords: 'status badge badges colour color rename label idle running awaiting starting stopped exited error 狀態 徽章 顏色 名稱 重新命名 閒置 執行中 等待回應 啟動中 已停止 已結束 錯誤',
  },
  {
    id: 'voice-input',
    tab: 'voice',
    section: 'voice-input',
    title: t('settings.search.item.voice-input.title'),
    group: t('settings.nav.voice'),
    summary: t('settings.search.item.voice-input.summary'),
    keywords: 'voice input speech dictation microphone mic hold to talk push to talk whisper transcribe model download read aloud readback tts speech synthesis 語音 語音輸入 麥克風 按住說話 聽寫 轉文字 模型 下載 朗讀 音声入力 マイク 読み上げ',
  },
  {
    id: 'general-environment',
    tab: 'general',
    section: 'general-environment',
    title: t('settings.search.item.general-environment.title'),
    group: t('settings.nav.group.general'),
    summary: t('settings.search.item.general-environment.summary'),
    keywords: 'environment onboarding env check rerun 環境檢測 重新檢測',
  },
  {
    id: 'general-backend-timeout',
    tab: 'general',
    section: 'general-backend-timeout',
    title: t('settings.search.item.general-backend-timeout.title'),
    group: t('settings.nav.group.general'),
    summary: t('settings.search.item.general-backend-timeout.summary'),
    keywords: 'backend timeout health check startup 啟動逾時 後端',
  },
  {
    id: 'updates',
    tab: 'updates',
    section: 'updates',
    title: t('settings.search.item.updates.title'),
    group: t('settings.nav.updates'),
    summary: t('settings.search.item.updates.summary'),
    keywords: 'update updates version check auto download channel stable beta release notes 更新 版本 檢查 自動下載 頻道 穩定版 測試版',
  },
  {
    id: 'general-resume-behavior',
    tab: 'general',
    section: 'general-resume-behavior',
    title: t('settings.search.item.general-resume-behavior.title'),
    group: t('settings.nav.group.general'),
    summary: t('settings.search.item.general-resume-behavior.summary'),
    keywords: 'resume restore start fresh ask workspace open session conversation 恢復 還原 開新對話 詢問 開啟 工作區 對話 續接',
  },
  {
    id: 'general-usage-badge',
    tab: 'general',
    section: 'general-usage-badge',
    title: t('settings.search.item.general-usage-badge.title'),
    group: t('settings.nav.group.general'),
    summary: t('settings.search.item.general-usage-badge.summary'),
    keywords: 'usage quota badge remaining limit rate window reset 額度 剩餘 用量 徽章 刷新 間隔 claude codex kimi grok',
  },
  {
    id: 'general-quota-failover',
    tab: 'general',
    section: 'general-quota-failover',
    title: t('settings.search.item.general-quota-failover.title'),
    group: t('settings.nav.group.general'),
    summary: t('settings.search.item.general-quota-failover.summary'),
    keywords: 'quota exhausted account switch failover auto notify off hot restart resume 額度 耗盡 切換 帳號 自動 通知 關閉 熱切 重啟 接續',
  },
  {
    id: 'general-quota-failover-loop',
    tab: 'general',
    section: 'general-quota-failover-loop',
    title: t('settings.search.item.general-quota-failover-loop.title'),
    group: t('settings.nav.group.general'),
    summary: t('settings.search.item.general-quota-failover-loop.summary'),
    keywords: 'loop quota exhausted account switch failover auto resume continue 迴圈 額度 耗盡 切換 帳號 自動 繼續 接續',
  },
  {
    id: 'general-account-follow-switch',
    tab: 'general',
    section: 'general-account-follow-switch',
    title: t('settings.search.item.general-account-follow-switch.title'),
    group: t('settings.nav.group.general'),
    summary: t('settings.search.item.general-account-follow-switch.summary'),
    keywords: 'pinned pane account switch claude quota resume folder 固定 帳號 切換 額度 接回 資料夾',
  },
  {
    id: 'accounts',
    tab: 'accounts',
    section: 'accounts',
    title: t('settings.search.item.accounts.title'),
    group: t('settings.nav.accounts'),
    summary: t('settings.search.item.accounts.summary'),
    keywords: 'git account accounts credential credentials token github safeStorage 帳號 憑證 金鑰 加密',
  },
  {
    id: 'cli-accounts',
    tab: 'accounts',
    section: 'cli-accounts',
    title: t('settings.search.item.cli-accounts.title'),
    group: t('settings.nav.accounts'),
    summary: t('settings.search.item.cli-accounts.summary'),
    keywords: 'cli account accounts profile profiles login claude codex kimi grok agent 帳號 登入 切換帳號 profile',
  },
  {
    id: 'shortcuts',
    tab: 'keybindings',
    section: 'keybindings',
    title: t('settings.search.item.shortcuts.title'),
    group: t('settings.nav.group.system'),
    summary: t('settings.search.item.shortcuts.summary'),
    keywords: 'keyboard shortcuts keys keybinding hotkey 快捷鍵 鍵盤 按鍵 workbench editor terminal cli ctrl cmd shift option',
  },
  {
    id: 'keybindings',
    tab: 'keybindings',
    section: 'keybindings',
    title: t('settings.search.item.keybindings.title'),
    group: t('settings.nav.group.system'),
    summary: t('settings.search.item.keybindings.summary'),
    keywords: 'keybinding keybindings customize rebind remap shortcut shortcuts hotkey chord conflict reset 自訂 快捷鍵 改鍵 重新綁定 衝突 還原 keybindings.json',
  },
  {
    // Storage lives in the Resource Manager now; the entry stays so "disk" and
    // "cleanup" still find it from here. `tab` and `section` are never read
    // for an `opens` item — openSettingsSearchResult leaves before using them.
    id: 'storage',
    tab: 'general',
    section: 'storage',
    opens: 'resource-manager',
    title: t('settings.search.item.storage.title'),
    group: t('settings.nav.group.system'),
    summary: t('settings.search.item.storage.summary'),
    keywords: 'storage disk space usage cache caches cleanup clean logs node_modules stale free resource manager 儲存 空間 磁碟 快取 清理 清除 日誌 佔用 釋出 資源',
  },
  {
    // The policy editor is a block on the Navide Plugins page now, so the hit opens
    // that page and scrolls to the block; the section id is unchanged.
    id: 'execution-policy',
    tab: 'extensions',
    section: 'execution-policy',
    title: t('settings.search.item.execution-policy.title'),
    group: t('settings.nav.group.navidePlugins'),
    summary: t('settings.search.item.execution-policy.summary'),
    keywords: 'execution policy permission permissions allowlist denylist full shell executable system namespace source repository recommendation untrusted recovery rebuild security 執行政策 權限 允許清單 拒絕清單 完整模式 shell 可執行檔 系統命名空間 來源 repository 建議 不受信任 修復 重建 安全性 extension extensions plugin plugins 擴充 擴充功能 外掛 Navide 外掛 拡張機能 プラグイン',
  },
  {
    id: 'marketplace',
    tab: 'marketplace',
    section: 'marketplace',
    title: t('settings.search.item.marketplace.title'),
    group: t('settings.nav.group.navidePlugins'),
    summary: t('settings.search.item.marketplace.summary'),
    keywords: 'marketplace extension extensions plugin plugins registry search browse install publisher signed unsigned trust 市集 擴充 擴充功能 外掛 搜尋 瀏覽 安裝 發佈者 簽章 信任 Navide 市集 拡張機能 プラグイン マーケットプレイス',
  },
  {
    id: 'disclosure-overview',
    tab: 'extensions',
    section: 'disclosureOverview',
    title: t('settings.search.item.disclosureOverview.title'),
    group: t('settings.nav.group.navidePlugins'),
    summary: t('settings.search.item.disclosureOverview.summary'),
    keywords: 'disclosure overview activity risk permission permissions undeclared anomaly audit plugin plugins 揭露 總覽 活動 風險 權限 沒宣告 異常 稽核 外掛 Navide 外掛 開示 一覧 アクティビティ リスク 権限 プラグイン',
  },
  {
    id: 'help-mcp',
    tab: 'help',
    section: 'help',
    helpTopic: 'mcp',
    title: t('settings.search.item.help-mcp.title'),
    group: t('settings.nav.help'),
    summary: t('settings.search.item.help-mcp.summary'),
    keywords: 'mcp model context protocol tool tools plan cli agent server client context7 github filesystem 說明 介紹 工具 計畫 外部 文件 注入 怎麼用 為什麼用不到',
  },
  {
    id: 'help-cli-messaging',
    tab: 'help',
    section: 'help',
    helpTopic: 'messaging',
    title: t('settings.help.topic.messaging'),
    group: t('settings.nav.help'),
    summary: t('settings.search.item.help-cli-messaging.summary'),
    keywords: 'help guide messaging message send cli agent pane cross workspace address broadcast queue rate limit troubleshooting 說明 教學 訊息 傳訊 互傳 傳送 指令 位址 跨工作區 廣播 佇列 頻率 疑難排解 怎麼用',
  },
  {
    id: 'help-workspace',
    tab: 'help',
    section: 'help',
    helpTopic: 'workspace',
    title: t('settings.help.topic.workspace'),
    group: t('settings.nav.help'),
    summary: t('settings.search.item.help-workspace.summary'),
    keywords: 'help guide workspace pane run group sidebar layout grid spotlight fullscreen slot status bar placeholder idle reclaim lineage 說明 教學 工作區 專案 面板 群組 側欄 版面 排列 佔位卡 閒置 回收 血緣 狀態列 多選 拖曳 快捷鍵',
  },
  {
    id: 'help-cli-agents',
    tab: 'help',
    section: 'help',
    helpTopic: 'cliAgents',
    title: t('settings.help.topic.cliAgents'),
    group: t('settings.nav.help'),
    summary: t('settings.search.item.help-cli-agents.summary'),
    keywords: 'help guide cli agent vendor install detect role account switch login usage quota badge permission skip 說明 教學 安裝 偵測 角色 帳號 切換 登入 額度 用量 徽章 權限 多帳號 疑難排解',
  },
  {
    id: 'help-code-workflow',
    tab: 'help',
    section: 'help',
    helpTopic: 'codeWorkflow',
    title: t('settings.help.topic.codeWorkflow'),
    group: t('settings.nav.help'),
    summary: t('settings.search.item.help-code-workflow.summary'),
    keywords: 'help guide git stage commit branch remote conflict diff stash plan review approve todo editor monaco preview record track 說明 教學 暫存 提交 分支 遠端 衝突 差異 草稿 計畫 審閱 核准 編輯器 預覽 變更記錄',
  },
  {
    id: 'help-settings-system',
    tab: 'help',
    section: 'help',
    helpTopic: 'settingsSystem',
    title: t('settings.help.topic.settingsSystem'),
    group: t('settings.nav.help'),
    summary: t('settings.search.item.help-settings-system.summary'),
    keywords: 'help guide settings overview skills prompts memory storage shortcuts updates analyzer extensions navide cloud pairing device schedule resource 說明 教學 設定 總覽 技能 提示 記憶 儲存 快捷鍵 更新 跨裝置 配對 裝置 排程 資源',
  },
  {
    id: 'help-cross-platform',
    tab: 'help',
    section: 'help',
    helpTopic: 'crossPlatform',
    title: t('settings.help.topic.crossPlatform'),
    group: t('settings.nav.help'),
    summary: t('settings.search.item.help-cross-platform.summary'),
    keywords: 'help guide windows linux macos platform install installer nsis appimage deb arm64 mirror download update shortcut modifier ctrl titlebar conpty dpapi keyring 說明 教學 跨平台 視窗 安裝 安裝檔 鏡像 下載 更新 修飾鍵 標題列 憑證 金鑰庫 多台 機器',
  },
  {
    id: 'help-icons',
    tab: 'help',
    section: 'help',
    helpTopic: 'icons',
    title: t('settings.help.topic.icons'),
    group: t('settings.nav.help'),
    summary: t('settings.search.item.help-icons.summary'),
    keywords: 'help guide icon button symbol glyph legend reference sidebar pane stage status bar git plan rail 說明 教學 圖示 按鈕 符號 對照 對照表 圖例 這是什麼 狀態色 色點',
  },
])

const settingsSearchResults = computed(() => {
  const q = settingsSearchQuery.value.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter(Boolean)
  return settingsSearchItems.value
    .map((item) => {
      const haystack = `${item.title} ${item.group} ${item.summary} ${item.keywords}`.toLowerCase()
      const score = terms.reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0)
      return { item, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, 8)
    .map(({ item }) => item)
})

async function openSettingsSearchResult(item: SettingsSearchItem): Promise<void> {
  if (item.opens === 'resource-manager') {
    settingsSearchQuery.value = ''
    emit('open-resource-manager')
    return
  }
  activeTab.value = item.tab
  if (item.tab === 'cliAgents') await openCliSection(item.section, settingsSearchQuery.value)
  if (item.tab === 'mcp' && item.mcpView) mView.value = item.mcpView
  if (item.tab === 'help' && item.helpTopic) helpTopic.value = item.helpTopic
  if (item.tab === 'cross-device') cloudSubtab.value = 'sync'
  if (item.tab === 'extensions' && PLUGINS_SECTION_PAGE[item.section]) pluginsPage.value = PLUGINS_SECTION_PAGE[item.section]
  settingsSearchQuery.value = ''
  await nextTick()
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`[data-settings-section="${item.section}"]`)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
}

// Git account manager (safeStorage-backed). Lazy-loaded on tab entry.
const accountsApi = useGitAccounts()

// ── Antigravity credential provisioning (dev/maintainer only) ────────────────
// Writes ~/navide-signing/usage_secrets.py so the next release build bundles
// Antigravity's public installed-app OAuth constants. Gated to dev builds via
// import.meta.env.DEV, so packaged end-user builds never show it.
const isDev = import.meta.env.DEV
const signingClientId = ref('')
const signingClientSecret = ref('')
const signingSaveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
function saveSigningSecrets(): void {
  if (!signingClientId.value.trim() || !signingClientSecret.value.trim()) {
    signingSaveStatus.value = 'error'
    return
  }
  signingSaveStatus.value = 'saving'
  props.backend.send<{ ok: boolean }>('usage.secrets.write', {
    client_id: signingClientId.value.trim(),
    client_secret: signingClientSecret.value.trim(),
  })
    .then(r => { signingSaveStatus.value = r?.ok ? 'saved' : 'error' })
    .catch(() => { signingSaveStatus.value = 'error' })
}

// ── Appearance (theme) ────────────────────────────────────────────────────────
const {
  theme: currentTheme,
  customOverrides,
  BUILTIN_THEMES,
  CUSTOMIZABLE_TOKENS,
  setTheme,
  setCustomOverride,
  setCustomOverrides,
  resetCustom,
} = useTheme()

// ── Language ──────────────────────────────────────────────────────────────────
const { language: currentLanguage, setLanguage, healthCheckTimeoutSec, setHealthCheckTimeoutSec } = useSettings()

// Auto-restore workspace windows on next launch (main-process setting, stored in
// the window registry). Loaded lazily when the appearance tab is opened.
const autoRestoreWindows = ref(true)
async function loadAutoRestore(): Promise<void> {
  try {
    const v = await window.agentTeam?.restore?.getAutoRestore?.()
    if (typeof v === 'boolean') autoRestoreWindows.value = v
  } catch { /* ignore — keep the default */ }
}
async function onAutoRestoreChange(): Promise<void> {
  try { await window.agentTeam?.restore?.setAutoRestore?.(autoRestoreWindows.value) } catch { /* ignore */ }
}

// Interface scale (Electron page zoom, applied by the main process to every
// window). setUiScale returns the clamped value that was actually stored.
const uiScaleModel = ref(getUiScale())
function onUiScaleChange(value: string): void {
  uiScaleModel.value = setUiScale(value)
}

// Locale catalogs keep language names in their native form, so the labels
// come from those keys rather than a second hardcoded copy. Every language
// with a registered catalog is listed, in registration order; a language added
// later appears here (with a Beta tag while it is machine-translated) without
// touching this file.
const SUPPORTED_LANGUAGES = AVAILABLE_UI_LOCALES.map((value) => ({
  value,
  labelKey: `settings.appearance.language-${value}`,
  beta: isBetaUiLocale(value),
}))

function onHealthTimeoutChange(raw: string): void {
  const n = Number(raw)
  if (Number.isFinite(n)) setHealthCheckTimeoutSec(n)
}

// Per-CLI quota badge (pane headers): on/off + backend poll interval.
const usageEnabledModel = ref(settingsGet<boolean>(USAGE_ENABLED_KEY, true) !== false)
function onUsageEnabledChange(): void {
  setUsageEnabled(usageEnabledModel.value)
}
const usageRefreshModel = ref(usageRefreshSec())
function onUsageRefreshChange(raw: string): void {
  const n = Number(raw)
  if ((USAGE_REFRESH_OPTIONS as readonly number[]).includes(n)) {
    usageRefreshModel.value = n
    setUsageRefreshSec(n)
  }
}

// Quota-exhaustion account switching: the policy the backend persists
// (off / notify / auto) and what each CLI can do about it, both read from
// the switch authority itself (quota_failover.get_state, mirrored by the
// singleton) so this page cannot disagree with the switch it describes.
// Evidence and platform are shown as facts; only the backend decides what a
// vendor may do automatically.
const quotaFailover = useQuotaFailover()
const FAILOVER_MODES: readonly FailoverMode[] = ['off', 'notify', 'auto']
const failoverMode = computed<FailoverMode>(() => quotaFailover.state.value?.policy.mode ?? 'notify')
const failoverBusy = ref(false)
async function onFailoverModeChange(raw: string): Promise<void> {
  if (!(FAILOVER_MODES as readonly string[]).includes(raw) || failoverBusy.value) return
  failoverBusy.value = true
  try {
    await quotaFailover.setPolicy(raw as FailoverMode)
  } finally {
    failoverBusy.value = false
  }
}
// Opt-in on top of the "auto" policy: a looping pane resumes its loop right
// after the automatic switch instead of offering the Continue button.
const loopFailoverResumeModel = ref(settingsGet<boolean>(LOOP_FAILOVER_RESUME_SETTING_KEY, false) === true)
function onLoopFailoverResumeChange(): void {
  settingsSet(LOOP_FAILOVER_RESUME_SETTING_KEY, loopFailoverResumeModel.value)
}
// Opt-in: a claude switch offers to move the panes pinned to another account's
// own config dir, and an out-of-quota pane offers "switch account and resume".
const accountFollowSwitchModel = ref(useAccountFollowSwitchFlag().value)
function onAccountFollowSwitchChange(): void {
  setAccountFollowSwitch(accountFollowSwitchModel.value)
}
interface FailoverCapabilityRow {
  agentKey: string
  label: string
  switchMode: 'hot' | 'restart' | 'manual' | 'unsupported'
  resume: 'native' | 'lossy' | 'none'
  /** Not exercised on a real account on any build ("source" / "docs"). */
  unverified: boolean
  /** Declared for other platforms only. */
  platformUnsupported: boolean
  todo: string
}
const failoverRows = computed<FailoverCapabilityRow[]>(() => {
  const caps = quotaFailover.state.value?.capabilities
  if (!caps) return []
  const here = platformId()
  return CLI_AGENT_SPECS.map((spec) => {
    const cap = caps[spec.agentKey]
    return {
      agentKey: spec.agentKey,
      label: spec.label,
      switchMode: cap?.supported ? cap.switchMode : 'unsupported',
      resume: cap?.resume ?? 'none',
      unverified: !!cap?.supported && cap.evidence !== 'live',
      platformUnsupported: !!cap?.supported && Array.isArray(cap.platforms) && cap.platforms.length > 0 && !cap.platforms.includes(here),
      todo: cap?.todo ?? '',
    }
  })
})

// Whether opening a workspace resumes its previous CLI panes, starts them
// fresh, or asks. Read at restore time in App.vue.
const resumeBehaviorModel = ref<ResumeBehavior>(
  normalizeResumeBehavior(settingsGet(RESUME_BEHAVIOR_SETTING_KEY, 'always'))
)
function onResumeBehaviorChange(value: string): void {
  resumeBehaviorModel.value = normalizeResumeBehavior(value)
  settingsSet(RESUME_BEHAVIOR_SETTING_KEY, resumeBehaviorModel.value)
}
const restoreScopeModel = ref<RestoreScope>(
  normalizeRestoreScope(settingsGet(RESTORE_SCOPE_SETTING_KEY, 'single'))
)
function onRestoreScopeChange(value: string): void {
  restoreScopeModel.value = normalizeRestoreScope(value)
  settingsSet(RESTORE_SCOPE_SETTING_KEY, restoreScopeModel.value)
}

// Whether a pane whose PTY died with the backend is resumed automatically once
// the backend is back. Separate from resumeBehavior above: that one is about
// opening a workspace, this one about a crash interrupting work in progress.
const autoResumeOnReconnectModel = ref(
  normalizeAutoResumeOnReconnect(settingsGet(AUTO_RESUME_ON_RECONNECT_SETTING_KEY, true))
)
function onAutoResumeOnReconnectChange(): void {
  settingsSet(AUTO_RESUME_ON_RECONNECT_SETTING_KEY, autoResumeOnReconnectModel.value)
}

// Whether relaunching Navide brings back, by itself, the panes that were
// working when it closed. Separate from both settings above: neither the
// workspace-open scope nor the crash reconnect answers a relaunch.
const resumeInterruptedOnLaunchModel = ref(
  normalizeResumeInterruptedOnLaunch(settingsGet(RESUME_INTERRUPTED_ON_LAUNCH_SETTING_KEY, true))
)
function onResumeInterruptedOnLaunchChange(): void {
  settingsSet(RESUME_INTERRUPTED_ON_LAUNCH_SETTING_KEY, resumeInterruptedOnLaunchModel.value)
}

// Background notifications for CLI done / needs-input: the OS notification and
// the sound are separate toggles so either can be muted on its own. The models
// are the shared refs the status-bar bell also shows, so both stay in step.
const systemNotifyEnabledModel = systemNotifyOn
function onSystemNotifyEnabledChange(): void {
  setSystemNotifyEnabled(systemNotifyEnabledModel.value)
}
const notifySoundEnabledModel = notifySoundOn
function onNotifySoundEnabledChange(): void {
  setNotifySoundEnabled(notifySoundEnabledModel.value)
}

// macOS notification permission. Electron cannot read the real TCC state (see
// main/permissions.ts), so what we show is the last test result; the test
// button fires a real notification so the user sees for themselves.
const perms = usePermissions()
const notifyPermissionStatus = computed(() => perms.statuses.value.notifications)
const notifyPermissionApplicable = computed(() => notifyPermissionStatus.value !== 'not-applicable')
function sendTestNotification(): void {
  void perms.request('notifications', {
    title: t('onboard.notif-test-title'),
    body: t('onboard.notif-test-body'),
  })
}

// Max resume spawns that run terminal.create concurrently (the rest queue).
// Read live by useTerminal at spawn time; heavy resume bursts otherwise stack
// on the backend and time out ("request terminal.create timeout").
const resumeConcurrencyModel = ref(
  clampResumeConcurrency(settingsGet(RESUME_CONCURRENCY_SETTING_KEY, DEFAULT_RESUME_CONCURRENCY))
)
function onResumeConcurrencyChange(value: string): void {
  resumeConcurrencyModel.value = clampResumeConcurrency(value)
  settingsSet(RESUME_CONCURRENCY_SETTING_KEY, resumeConcurrencyModel.value)
}

// ── Default editor ──────────────────────────────────────────────────────────
// Which editor file/folder opens are routed to. The detected list (absolute
// paths + availability) comes from the main process, which owns the lookup.
const customEditorCommand = ref<string[]>(
  settingsGet<string[]>(DEFAULT_EDITOR_COMMAND_KEY, [])
)
const customEditorCommandText = ref(formatCustomCommand(customEditorCommand.value))
const defaultEditorModel = ref(
  normalizeDefaultEditor(
    settingsGet(DEFAULT_EDITOR_SETTING_KEY, DEFAULT_EDITOR_ID),
    customEditorCommand.value
  )
)
const detectedEditors = ref<DetectedEditor[]>([])
const detectingEditors = ref(false)

async function loadDetectedEditors(refresh = false): Promise<void> {
  detectingEditors.value = true
  try {
    detectedEditors.value = (await window.agentTeam?.listEditors?.(refresh)) ?? []
  } catch {
    detectedEditors.value = []
  } finally {
    detectingEditors.value = false
  }
}

// A disabled Mini-IDE cannot be the default editor; the option says why.
const disabledBuiltins = useDisabledBuiltins()
const miniIdeDisabled = computed(() => disabledBuiltins.disabled.value.has('navide.mini-ide'))

function isEditorAvailable(id: string): boolean {
  return detectedEditors.value.some((editor) => editor.id === id && editor.available)
}

/** Absolute path the selected editor resolved to, when there is one to show. */
const selectedEditorCommand = computed(() => {
  const hit = detectedEditors.value.find((editor) => editor.id === defaultEditorModel.value)
  return hit?.available ? hit.command : ''
})

function onDefaultEditorChange(value: string): void {
  // Not normalized here: picking `custom` before typing a command must stick so
  // the command field can appear. Main normalizes again when it reads.
  defaultEditorModel.value = value
  settingsSet(DEFAULT_EDITOR_SETTING_KEY, value)
}

function onCustomEditorCommandChange(text: string): void {
  customEditorCommandText.value = text
  customEditorCommand.value = parseCustomCommand(text)
  settingsSet(DEFAULT_EDITOR_COMMAND_KEY, customEditorCommand.value)
}

function onCustomEditorPresetChange(select: HTMLSelectElement): void {
  const preset = CUSTOM_COMMAND_PRESETS.find((entry) => entry.id === select.value)
  // Snap back to the placeholder so the same preset can be picked again.
  select.value = ''
  if (!preset) return
  onCustomEditorCommandChange(formatCustomCommand(preset.command))
}

// ── Updates (auto-update UX) ────────────────────────────────────────────────
const {
  state: updateState,
  settings: updSettings,
  isBusy: updIsBusy,
  checkForUpdates,
  startDownload,
  installUpdate,
  updateSettings: updUpdateSettings,
} = useUpdater()
// checkedAt only moves when a check succeeds, so it reads as "last known good"
// next to a run of failures.
const updLastSuccessfulCheck = computed(() =>
  updateState.value.checkedAt ? new Date(updateState.value.checkedAt).toLocaleString(currentLanguage.value) : ''
)
// check → download → install, so the panel shows where the update actually is
// rather than leaving the user to infer it from one status line.
const updStages = computed(() => updateStages(updateState.value))

// ── Settings management / metadata ──────────────────────────────────────────
interface SettingsPaths {
  app_data_dir?: string
  mcp?: string
  skills?: string
  analyzer?: string
  ai_chat?: string
  backend_log?: string
}
const settingsPaths = ref<SettingsPaths>({})
const settingsBundleBusy = ref(false)
const settingsBundleSummary = ref('')
const settingsBundleError = ref('')

/** Tabs that actually hold settings. `help` is read-only reference material, so
 *  it has no scope badge and no settings file to reveal. `disclosureOverview`
 *  is only an alias that lands on the Navide Plugins page. */
type SettingsTab = Exclude<Tab, 'help' | 'disclosureOverview'>

// The scope is stored as a key, not as prose: the badge is resolved through
// `scopeLabel()` at render time so it follows a language switch.
type SettingsScope = 'user' | 'userWorkspace' | 'accountServer' | 'userWorkspaceBindings' | ''

const settingsScopeNotes: Record<SettingsTab, { scope: SettingsScope; storage: keyof SettingsPaths | 'localStorage' | 'mainProcess' | 'safeStorage' | 'cliFiles' }> = {
  mcp: { scope: 'user', storage: 'mcp' },
  skills: { scope: 'user', storage: 'skills' },
  credentials: { scope: 'user', storage: 'mainProcess' },
  prompts: { scope: 'user', storage: 'localStorage' },
  // The CLIs' own instruction files: each one lives where its CLI looks for
  // it, so the pane shows per-file paths and this tab has none of its own.
  memory: { scope: 'userWorkspace', storage: 'cliFiles' },
  analyzer: { scope: 'user', storage: 'analyzer' },
  // Order and the disabled list are persisted per workspace (project.json),
  // with the global KV as the fallback default — so this page is both.
  cliAgents: { scope: 'userWorkspace', storage: 'localStorage' },
  // Each CLI's own files, read in place; the cards show their paths.
  cliExtensions: { scope: 'user', storage: 'cliFiles' },
  general: { scope: 'user', storage: 'localStorage' },
  // Neither half of this page is a local setting: the access token is in
  // the credential vault and the authorization rules live on the server,
  // which is why the cards say so themselves rather than showing a path.
  'cross-device': { scope: 'accountServer', storage: 'safeStorage' },
  updates: { scope: 'user', storage: 'mainProcess' },
  appearance: { scope: 'user', storage: 'localStorage' },
  language: { scope: 'user', storage: 'localStorage' },
  // The user's own names and colours for the pane status badges.
  statusBadges: { scope: 'user', storage: 'localStorage' },
  // One arrangement for every workspace, shared live across windows.
  layout: { scope: 'user', storage: 'localStorage' },
  // The two notification toggles are localStorage flags like General's.
  notifications: { scope: 'user', storage: 'localStorage' },
  // Both switches are localStorage flags; the model file is the backend's.
  voice: { scope: 'user', storage: 'localStorage' },
  accounts: { scope: 'userWorkspaceBindings', storage: 'safeStorage' },
  extensions: { scope: 'user', storage: 'mainProcess' },
  // Browsing the registry reads nothing of the user's, so this page has no
  // scope badge; the entry exists because the map covers every nav page.
  marketplace: { scope: '', storage: 'mainProcess' },
  keybindings: { scope: 'user', storage: 'mainProcess' },
  // Platform config is in navide.db; tokens are in the credential vault.
  channels: { scope: 'user', storage: 'safeStorage' },
  // Guard's switch, rules, audit and taint marks are tables in navide.db.
  security: { scope: 'user', storage: 'app_data_dir' },
}

// Two letters per CLI card: the first letter and the first consonant after
// it, so names that share a prefix (Kimi, Kilo) still read apart.
function cardInitials(label: string): string {
  const second = label.slice(1).match(/[b-df-hj-np-tv-z]/i)?.[0] ?? label.slice(1, 2)
  return (label.slice(0, 1) + second).toUpperCase()
}

function scopeLabel(scope: SettingsScope): string {
  return scope ? t(`settings.scope.${scope}`) : ''
}

// The execution policy block sits inside the Extensions page but carries its
// own scope: the policy is per user and per workspace, the plugin inventory
// next to it is not. It is a block, not a nav page, so it stays out of
// `settingsScopeNotes` — that map is one entry per page.
const executionPolicyScopeNote = { scope: 'userWorkspace', storage: 'mainProcess' } as const

async function loadSettingsPaths(): Promise<void> {
  try {
    const resp = await props.backend.send<{ paths: SettingsPaths }>('settings.paths', {})
    if (resp.ok && resp.payload?.paths) settingsPaths.value = resp.payload.paths
  } catch { /* non-fatal */ }
}

type SettingsStorage = (typeof settingsScopeNotes)[SettingsTab]['storage']

function pathForStorage(storage: SettingsStorage): string {
  if (storage === 'localStorage') return t('settings.storage.localStorage')
  if (storage === 'mainProcess') return t('settings.storage.mainProcess')
  if (storage === 'safeStorage') return t('settings.storage.safeStorage')
  if (storage === 'cliFiles') return t('settings.storage.cliFiles')
  return settingsPaths.value[storage] ?? ''
}

function pathForTab(tab: SettingsTab): string {
  return pathForStorage(settingsScopeNotes[tab].storage)
}

async function openSettingsPath(path?: string): Promise<void> {
  if (!path) return
  await window.agentTeam?.openPath?.(path)
}

function stampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

async function exportSettingsBundle(): Promise<void> {
  if (!window.agentTeam?.saveJson) return
  settingsBundleBusy.value = true
  settingsBundleError.value = ''
  try {
    const resp = await props.backend.send<{ bundle: Record<string, unknown> }>('settings.bundle.export', {})
    if (!resp.ok || !resp.payload?.bundle) {
      settingsBundleError.value = resp.error?.message ?? t('settings.management.export-failed')
      return
    }
    const bundle = {
      ...resp.payload.bundle,
      appearance: {
        theme: currentTheme.value,
        theme_custom: customOverrides.value,
        language: currentLanguage.value,
        health_check_timeout_sec: healthCheckTimeoutSec.value,
        auto_restore_windows: autoRestoreWindows.value,
      },
    }
    const result = await window.agentTeam.saveJson({
      title: t('settings.management.export-dialog-title'),
      defaultName: `agent-team-settings-${stampForFile()}.json`,
      content: JSON.stringify(bundle, null, 2),
    })
    if (result.ok) settingsBundleSummary.value = t('settings.management.exported')
  } catch (err) {
    settingsBundleError.value = err instanceof Error ? err.message : t('settings.management.export-failed')
  } finally {
    settingsBundleBusy.value = false
  }
}

async function importSettingsBundle(): Promise<void> {
  if (!window.agentTeam?.openJson) return
  settingsBundleBusy.value = true
  settingsBundleError.value = ''
  try {
    const result = await window.agentTeam.openJson({ title: t('settings.management.import-dialog-title') })
    if (!result.ok || !result.content) return
    const bundle = JSON.parse(result.content) as Record<string, unknown>
    const resp = await props.backend.send<{ applied: string[]; paths: SettingsPaths }>('settings.bundle.import', { bundle })
    if (!resp.ok) {
      settingsBundleError.value = resp.error?.message ?? t('settings.management.import-failed')
      return
    }
    const appearance = bundle.appearance as Record<string, unknown> | undefined
    if (appearance) {
      if (typeof appearance.theme === 'string') setTheme(appearance.theme)
      if (appearance.theme_custom && typeof appearance.theme_custom === 'object') {
        setCustomOverrides(appearance.theme_custom as Record<string, string>)
      }
      if (typeof appearance.language === 'string') setLanguage(appearance.language)
      if (typeof appearance.health_check_timeout_sec === 'number') setHealthCheckTimeoutSec(appearance.health_check_timeout_sec)
      if (typeof appearance.auto_restore_windows === 'boolean') {
        autoRestoreWindows.value = appearance.auto_restore_windows
        await onAutoRestoreChange()
      }
    }
    if (resp.payload?.paths) settingsPaths.value = resp.payload.paths
    await Promise.all([
      props.rolesApi.refresh(),
      props.stagesApi.refresh(),
      props.pipelinesApi?.refresh() ?? Promise.resolve(),
      props.analyzerApi.refreshSettings(),
    ])
    const applied = resp.payload?.applied ?? []
    if (shouldReloadMcpAfterBundleImport(applied)) await mLoad(true)
    settingsBundleSummary.value = t('settings.management.imported', { items: applied.join(', ') || 'appearance' })
  } catch (err) {
    settingsBundleError.value = err instanceof Error ? err.message : t('settings.management.import-failed')
  } finally {
    settingsBundleBusy.value = false
  }
}

// Live value bound to each color picker. Seeded from the override map; when an
// override is absent we fall back to the resolved computed token value so the
// picker shows the current built-in theme's color.
function resolvedTokenValue(token: string): string {
  if (customOverrides.value[token]) return customOverrides.value[token]
  if (typeof document === 'undefined') return '#000000'
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return normalizeHex(v) || '#000000'
}

// <input type="color"> only accepts #rrggbb. Coerce common forms; bail to '' if
// the value can't be represented (e.g. a var() reference or rgba()).
function normalizeHex(v: string): string {
  const s = v.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toLowerCase()
  }
  return ''
}

// Debounced live preview: apply the override 300ms after the last picker input
// so dragging the color wheel doesn't thrash the DOM / localStorage.
let previewTimer: ReturnType<typeof setTimeout> | null = null
function onPickColor(token: string, value: string): void {
  if (previewTimer) clearTimeout(previewTimer)
  const hex = normalizeHex(value)
  previewTimer = setTimeout(() => setCustomOverride(token, hex || null), 300)
}

const hasCustomOverrides = computed(() => Object.keys(customOverrides.value).length > 0)

// Preview-only representative colors per theme [bg, surface, accent, success].
// Used to render the theme cards without having to apply each theme.
const THEME_SWATCHES: Record<string, string[]> = {
  'dark-github': ['#0d1117', '#161b22', '#58a6ff', '#3fb950'],
  'dark-midnight': ['#0a0e14', '#11161f', '#6cb0ff', '#4ad07a'],
  'dark-forest': ['#0c130d', '#121a13', '#6fc28a', '#56d364'],
  light: ['#ffffff', '#f6f8fa', '#0969da', '#1a7f37'],
  'high-contrast': ['#0a0c10', '#14171c', '#71b7ff', '#4ae168'],
}

// ── Cross-device link (Navide-Server) ─────────────────────────────────────────
// The server URL lives in ui_settings and the access token in the credential
// vault, but both go out through one backend call so the link reconnects once,
// with the final pair, instead of dialling on a half-edited configuration.
interface P2pLinkStatus {
  state:
    | 'unconfigured'
    | 'connecting'
    | 'waiting-for-keychain'
    | 'connected'
    | 'unreachable'
    | 'unauthorized'
  serverUrl: string
  hasToken: boolean
  detail: string
  deviceId: string
  memberId: string
  /** Which account this machine is signed in as. Empty when the credential was
   *  pasted in by hand rather than obtained by signing in — both are valid, so
   *  this decides which face the card shows, not whether it works. */
  accountEmail?: string
  displayName?: string
  /** Why the last dial failed, verbatim from the socket. */
  lastError?: string
}
/** "Connecting" has to resolve on its own, so the section re-asks while it is
 *  on screen rather than freezing on whatever the save call answered. */
const P2P_POLL_MS = 3000
const p2pStatus = ref<P2pLinkStatus | null>(null)
// False from leaving the Navide Cloud page until the next status reply, so a
// status read before the link dropped elsewhere never opens the cloud views.
const p2pStatusFresh = ref(false)
let p2pTimer: ReturnType<typeof setInterval> | null = null

async function loadP2pStatus(): Promise<void> {
  try {
    const resp = await props.backend.send<{ status: P2pLinkStatus }>('p2p.link.status', {})
    if (!resp.ok || !resp.payload?.status) return
    p2pStatus.value = resp.payload.status
    p2pStatusFresh.value = true
  } catch { /* non-fatal — the status line keeps its last value */ }
}

const p2pState = computed(() => p2pStatus.value?.state ?? 'unconfigured')
const p2pDotClass = computed(() => {
  if (p2pState.value === 'connected') return 'ok'
  if (p2pState.value === 'unauthorized') return 'err'
  if (p2pState.value === 'unreachable') return 'warn'
  return 'idle'
})

// ── Cross-device authorization (receiver-side pane policy) ───────────────────
// Who, on another device, may drive a pane on *this* machine. Deny by default
// with allow-only rules, stored on the server and cached here — so the list is
// readable while the link is down and writable only while it is up. Panes on
// one machine never consult it, which is why the whole block only appears once
// a server is configured.
interface P2pPolicyDevice { deviceId: string; deviceName: string; paneCount: number }
interface P2pPolicyState {
  state: string
  editable: boolean
  policy: unknown
  revision: number | null
  deviceId: string
  memberId: string
  devices: P2pPolicyDevice[]
}
const p2pPolicy = ref<P2pPolicyState | null>(null)
const p2pPolicyBusy = ref(false)
const p2pPolicyError = ref('')
const newRuleMemberScope = ref<'mine' | 'any'>('mine')
const newRuleDeviceId = ref('')
const newRuleWorkspace = ref('')
const newRulePaneName = ref('')

const policyDoc = computed<PolicyDocument>(() => readPolicy(p2pPolicy.value?.policy))
const policyMemberId = computed(() => p2pPolicy.value?.memberId ?? '')
const policyDevices = computed<P2pPolicyDevice[]>(() => p2pPolicy.value?.devices ?? [])
/**
 * Whether an action that needs the server can be attempted at all.
 *
 * Everything in this section goes to the relay, and a link that is still
 * dialling answers with "configured but not connected right now, retry
 * shortly" — a sentence that arrives *after* the click, so the button looks
 * broken rather than unavailable.
 */
const p2pLinkReady = computed(() => p2pState.value === 'connected')
// The Navide Cloud page grows sub-tabs only while the Cloud link is up and
// its server does share links. Otherwise — not connected, or connected to a
// server without them — it is exactly the page it was before them: no bar,
// no inventory, no share list; an old server is asked share.caps once (F7-2).
const cloudLinkUp = computed(() => p2pLinkReady.value && p2pStatusFresh.value)
const shareProbe = useShareLinks(props.backend)
const cloudSubtabsShown = computed(() => cloudLinkUp.value && shareProbe.supported.value)
const cloudTabs = computed<CloudSubtab[]>(() =>
  shareProbe.supported.value ? ['sync', 'share', 'devices'] : ['sync', 'devices']
)
watch(cloudLinkUp, (up) => {
  if (up) {
    void shareProbe.probe()
  } else {
    forgetSyncInventory()
    shareProbe.reset()
  }
})
// The inventory is module-wide; the next Settings window must not open on this one's.
onBeforeUnmount(forgetSyncInventory)
/** The socket's own words. "Not connected" is the half already on screen;
 *  which kind it is decides whether waiting is the right thing to do. */
const p2pLinkError = computed(() =>
  p2pLinkReady.value ? '' : (p2pStatus.value?.lastError ?? '')
)
/**
 * Why a control on this page is off, in the order somebody can act on.
 *
 * Three different reasons wore one sentence: the link is not up, a save is in
 * flight, or the policy is not ours to edit. Telling all three "not connected"
 * sends two of them to check the network.
 */
const p2pDisabledReason = computed(() => {
  // Decided by a pure function in lib/linkStatus so it can be tested by what it
  // returns: inline, the only available check was "the key is mentioned
  // somewhere", which a condition wired to `false` still passes.
  const reason = disabledReasonKey({
    linkReason: p2pWaitReason.value,
    busy: p2pPolicyBusy.value,
    editable: p2pPolicy.value?.editable === true,
  })
  if (!reason) return ''
  return reason.startsWith('policy.') ? t(`settings.p2p.${reason}`) : reason
})
const p2pWaitReason = computed(() =>
  p2pLinkReady.value
    ? ''
    : p2pState.value === 'waiting-for-keychain'
      ? t('settings.p2p.link-waiting-keychain')
      : p2pState.value === 'connecting'
        ? t('settings.p2p.link-connecting')
        : t('settings.p2p.link-not-connected'),
)
const policyEditable = computed(
  () => p2pPolicy.value?.editable === true && !p2pPolicyBusy.value && p2pLinkReady.value
)
const policyAllowsOwnDevices = computed(() =>
  allowsOwnDevices(policyDoc.value, policyMemberId.value)
)

async function loadP2pPolicy(): Promise<void> {
  // A save owns the state while it is in flight; a poll landing after it would
  // put the pre-save rules back on screen for one tick.
  if (p2pPolicyBusy.value) return
  try {
    const resp = await props.backend.send<P2pPolicyState>('p2p.policy.get', {})
    if (!resp.ok || !resp.payload) return
    p2pPolicy.value = resp.payload
  } catch { /* non-fatal — the list keeps its last value */ }
}

async function saveP2pPolicy(next: PolicyDocument): Promise<boolean> {
  p2pPolicyBusy.value = true
  p2pPolicyError.value = ''
  try {
    // The backend refuses this without a one-time confirmation from main. Only
    // a window can obtain one — MCP and the plugin broker hold the same socket
    // and have no path to the key — which is what separates a person editing
    // the rules from an agent being talked into it by a remote peer.
    // Bound to this exact document (canonical spelling), so the token cannot
    // be lifted and spent on a different rule set.
    const confirm = await window.agentTeam?.trustConfirm('p2p.policy.set', '', canonicalJson(next))
    const resp = await props.backend.send<P2pPolicyState>('p2p.policy.set', {
      policy: next,
      confirm,
    })
    if (!resp.ok) {
      p2pPolicyError.value = resp.error?.message ?? 'Failed to save the authorization rules'
      return false
    }
    if (resp.payload) p2pPolicy.value = resp.payload
    return true
  } catch (err) {
    p2pPolicyError.value = err instanceof Error ? err.message : String(err)
    return false
  } finally {
    p2pPolicyBusy.value = false
  }
}

/** Open one of the published legal pages. The addresses live in the shared
 *  table and are resolved in main, so nothing here builds a URL. */
function openLegal(route: LegalRoute): void {
  void window.agentTeam?.openLegal(route)
}

/** Whether the last re-sign succeeded, so the button can say it did. */
const p2pPolicyResigned = ref(false)

/**
 * Write the rules back unchanged, which signs them again.
 *
 * The signature covers the document and a counter this machine keeps, so the
 * same rules produce a new signature and an older one stops verifying. That is
 * the whole repair for "your rules could not be verified", and until this
 * existed the only way to perform it was to add a rule and remove it again.
 */
async function resignP2pPolicy(): Promise<void> {
  p2pPolicyResigned.value = await saveP2pPolicy(policyDoc.value)
}

async function toggleOwnDevices(input: HTMLInputElement): Promise<void> {
  if (!policyMemberId.value) return
  await saveP2pPolicy(withOwnDevices(policyDoc.value, policyMemberId.value, input.checked))
  // A refused save leaves the computed exactly as it was, and an unchanged
  // binding re-renders nothing — so the box would keep the click and show a
  // permission that was never granted.
  input.checked = policyAllowsOwnDevices.value
}

async function addP2pPolicyRule(): Promise<void> {
  const rule = makePolicyRule({
    memberId: newRuleMemberScope.value === 'mine' ? policyMemberId.value : POLICY_ANY,
    deviceId: newRuleDeviceId.value || POLICY_ANY,
    workspace: newRuleWorkspace.value,
    paneName: newRulePaneName.value,
  })
  if (await saveP2pPolicy(addPolicyRuleTo(policyDoc.value, rule))) {
    newRuleDeviceId.value = ''
    newRuleWorkspace.value = ''
    newRulePaneName.value = ''
  }
}

async function removeP2pPolicyRule(index: number): Promise<void> {
  await saveP2pPolicy(removePolicyRuleAt(policyDoc.value, index))
}

/** Rule fields as the list renders them: `*` becomes the localized "any". */
function policyFieldLabel(value: string): string {
  return value === POLICY_ANY ? t('settings.p2p.policy.any') : value
}

/** Whether a rule field is the wildcard. "Any" is the absence of a constraint,
 *  and printing it at the same weight as a real name makes a broad rule look
 *  as specific as a narrow one. */
function isAnyField(value: string): boolean {
  return value === POLICY_ANY
}

function policyMemberLabel(memberId: string): string {
  if (memberId === POLICY_ANY) return t('settings.p2p.policy.any-member')
  if (memberId === policyMemberId.value) return t('settings.p2p.policy.my-account')
  return memberId
}

function policyDeviceLabel(deviceId: string): string {
  if (deviceId === POLICY_ANY) return t('settings.p2p.policy.any-device')
  const known = policyDevices.value.find((device) => device.deviceId === deviceId)
  return known?.deviceName || deviceId
}

watch([activeTab, cloudSubtab], ([tab, sub]) => {
  if (p2pTimer) { clearInterval(p2pTimer); p2pTimer = null }
  // Follows the cards, not the page they used to be on: polling the link while
  // General is open would keep asking for something nobody is looking at, and
  // stop the moment somebody actually opened it.
  if (tab !== 'cross-device') p2pStatusFresh.value = false
  if (tab !== 'cross-device') return
  // The link is watched on every sub-tab, since it decides whether there are
  // sub-tabs at all; the rules only on Sync, the one sub-tab that shows them.
  const rules = sub === 'sync'
  void loadP2pStatus()
  if (rules) void loadP2pPolicy()
  p2pTimer = setInterval(() => {
    void loadP2pStatus()
    if (rules) void loadP2pPolicy()
  }, P2P_POLL_MS)
}, { immediate: true })

// Close on ESC.
function onKeyDown(e: KeyboardEvent) {
  if (selectedCliKey.value && activeTab.value === 'cliAgents') {
    if (e.key === 'Tab') { trapCliDrawerFocus(e); return }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (cliInstallOpen.value) cliPanelRef.value?.closeInstallDialog()
      else void closeCliDrawer()
      return
    }
  }
  if (e.key !== 'Escape') return
  if (e.defaultPrevented) return
  emit('close')
}
// Pending Registry plugin updates (pushed by the main process's periodic
// check) badge the Extensions nav item.
const pluginUpdates = usePluginUpdates()
let stopPluginUpdates: (() => void) | null = null
// A synced MCP change lands in the store behind this pane; re-read the list
// the way a reopen would (mLoad leaves an unsaved edit alone).
let offMcpChanged: (() => void) | null = null
onMounted(() => {
  offMcpChanged = props.backend.on('mcp.servers_changed', () => { void mLoad() })
  window.addEventListener('keydown', onKeyDown)
  stopPluginUpdates = pluginUpdates.subscribe()
  refreshLaunchOverrides()
  if (activeTab.value === 'cliAgents') void onboarding.refresh()
  void loadSettingsPaths()
  void loadDetectedEditors()
  void perms.refresh()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  offMcpChanged?.()
  stopPluginUpdates?.()
  // The onboarding instance is this component's now, so its timers are too:
  // an install watched from the CLI management panel keeps a poll and an
  // elapsed-seconds ticker running, and closing Settings has to stop them.
  onboarding.dispose()
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
  if (p2pTimer) { clearInterval(p2pTimer); p2pTimer = null }
})

// ── Analyzer tab local state ──────────────────────────────────────────────────
const azPullName = ref('')
const azRechecking = ref(false)
const azDetecting = ref(false)
async function azDetectCli() {
  azDetecting.value = true
  try {
    const result = await props.analyzerApi.detectLlamaCli()
    if (result.recommended) {
      await props.analyzerApi.saveSettings({ llama_cli: result.recommended })
    }
  } finally {
    azDetecting.value = false
  }
}
async function azPickCli() {
  const result = await window.agentTeam?.pickFile?.({
    title: t('settings.analyzer.select-llama-cli'),
    filters: [{ name: t('settings.analyzer.filter-executable'), extensions: ['*'] }],
    defaultPath: '/opt/homebrew/bin',
  })
  if (result?.ok && result.path) {
    await props.analyzerApi.saveSettings({ llama_cli: result.path })
  }
}
async function azPickGguf() {
  const result = await window.agentTeam?.pickFile?.({
    title: t('settings.analyzer.select-gguf-model'),
    filters: [{ name: t('settings.analyzer.filter-gguf'), extensions: ['gguf'] }, { name: t('settings.analyzer.filter-all-files'), extensions: ['*'] }],
  })
  if (result?.ok && result.path) {
    await props.analyzerApi.saveSettings({ gguf_path: result.path })
  }
}
async function azRecheck() {
  azRechecking.value = true
  try {
    await Promise.all([
      props.analyzerApi.refreshHealth(),
      props.analyzerApi.refreshOllamaHealth(),
      props.analyzerApi.refreshModels(),
    ])
  } finally {
    azRechecking.value = false
  }
}
async function azDoPull() {
  const name = azPullName.value.trim()
  if (!name) return
  azPullName.value = ''
  await props.analyzerApi.pullModel(name)
}
async function azDoDelete(name: string) {
  await props.analyzerApi.deleteModel(name)
}

// ══════════════════════════════════════════════════════════════════════════════
// MCP TAB
// ══════════════════════════════════════════════════════════════════════════════

interface McpTool { name: string; description: string }
interface McpServer {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  // Live fields (returned by backend, not saved):
  status?: 'starting' | 'connected' | 'error' | 'disabled' | 'unknown'
  tool_count?: number; tools?: McpTool[]
}
// CatalogEntry type alias (re-exported from mcpCatalog.ts)
type CatalogEntry = McpCatalogEntry

type MView = 'list' | 'catalog' | 'custom'
const mView = ref<MView>('list')
const mSearch = ref('')
const mServers = ref<McpServer[]>([])
const mLoading = ref(false)
const mSaving = ref(false)
const mError = ref('')
const mSummary = ref('')
const mConfigPath = ref('')
const mRevision = ref<string | null>(null)
const mConflict = ref(false)
const mCustomName = ref('')
const mCustomTransport = ref<McpTransport>('stdio')
const mCustomCommand = ref('')
const mCustomUrl = ref('')
const mDirty = ref(false)
let mEditVersion = 0

const mFilteredCatalog = computed(() => {
  const q = mSearch.value.trim().toLowerCase()
  return q ? MCP_CATALOG.filter(c => c.name.includes(q) || c.label.toLowerCase().includes(q) || t(c.descriptionKey).toLowerCase().includes(q))
           : MCP_CATALOG
})

function mIsInstalled(name: string) {
  return isMcpInstalled(mServers.value.map(s => s.name), name)
}

function mNormalizeServer(server: Partial<McpServer> & { name: string; enabled: boolean }): McpServer {
  const transport: McpTransport = server.transport === 'http' || server.transport === 'sse'
    ? server.transport
    : 'stdio'
  if (transport === 'stdio') {
    return {
      ...server,
      transport,
      command: server.command ?? '',
      args: Array.isArray(server.args) ? server.args : [],
      env: server.env ?? {},
    }
  }
  return {
    ...server,
    transport,
    url: server.url ?? '',
    headers: server.headers ?? {},
  }
}

function mSerializedServer(server: McpServer): Record<string, unknown> {
  const common = { name: server.name, transport: server.transport, enabled: server.enabled }
  if (server.transport === 'stdio') {
    return {
      ...common,
      command: server.command ?? '',
      args: [...(server.args ?? [])],
      env: { ...(server.env ?? {}) },
    }
  }
  return { ...common, url: server.url ?? '', headers: { ...(server.headers ?? {}) } }
}

function mServerForTransport(name: string, transport: McpTransport, endpoint: string): McpServer {
  return transport === 'stdio'
    ? { name, transport, command: endpoint, args: [], env: {}, enabled: true }
    : { name, transport, url: endpoint, headers: {}, enabled: true }
}

interface McpListResponse {
  servers: McpServer[]
  path?: string
  revision: string
  /** Reflection of every CLI's own config; read-only, added alongside. */
  native?: NativeMcpServer[]
  agents?: McpAgent[]
}

interface McpQueuedDraft {
  servers: Record<string, unknown>[]
  silent: boolean
  editVersion: number
}

function mMarkDirty(): void {
  mDirty.value = true
  mEditVersion += 1
}

/** Read-only reflection of what each CLI configures for itself, and what
 *  Navide can do with each vendor's MCP. Loaded by the same call that loads
 *  Navide's own servers, so the pane below never issues a second request. */
const mNative = ref<NativeMcpServer[]>([])
const mAgents = ref<McpAgent[]>([])
/** A just-added server the pane should open its editor on. */
const mSelectName = ref('')

async function mLoad(force = false) {
  if (!force && (mDirty.value || mAutosaveQueue.pending > 0)) return
  if (force) mDirty.value = false
  mLoading.value = true; mError.value = ''; mConflict.value = false
  try {
    const resp = await props.backend.send<McpListResponse>('mcp.list_servers', {})
    if (resp.ok && resp.payload) {
      mServers.value = resp.payload.servers.map(mNormalizeServer)
      mConfigPath.value = resp.payload.path ?? ''
      mRevision.value = resp.payload.revision
      mNative.value = Array.isArray(resp.payload.native) ? resp.payload.native : []
      mAgents.value = Array.isArray(resp.payload.agents) ? resp.payload.agents : []
    } else { mError.value = resp.error?.message ?? 'Load failed' }
  } catch (err) { mError.value = String((err as Error).message ?? err) }
  finally { mLoading.value = false }
}

async function mRefreshLive(): Promise<void> {
  try {
    const resp = await props.backend.send<McpListResponse>('mcp.list_servers', {})
    if (!resp.ok || !resp.payload) {
      mError.value = resp.error?.message ?? 'Load failed'
      return
    }
    const liveByName = new Map(resp.payload.servers.map((server) => [server.name, server]))
    for (const server of mServers.value) {
      const live = liveByName.get(server.name)
      server.status = live?.status ?? 'unknown'
      server.tool_count = live?.tool_count
      server.tools = live?.tools
    }
    mConfigPath.value = resp.payload.path ?? mConfigPath.value
    mRevision.value = resp.payload.revision
  } catch (err) {
    mError.value = String((err as Error).message ?? err)
  }
}

const mAutosaveQueue = new RevisionedMcpSaveQueue<McpQueuedDraft>(
  (snapshot, expectedRevision) => mSaveNow(snapshot, expectedRevision),
  async (lastSnapshot) => {
    if (mEditVersion === lastSnapshot.editVersion) mDirty.value = false
    await mRefreshLive()
  }
)

function mSave(silent = false): Promise<boolean> {
  mMarkDirty()
  return mAutosaveQueue.enqueue(
    {
      servers: mServers.value.map(mSerializedServer),
      silent,
      editVersion: mEditVersion,
    },
    mRevision.value
  )
}

async function mSaveNow(
  snapshot: McpQueuedDraft,
  expectedRevision: string | null
): Promise<RevisionedMcpSaveOutcome> {
  mSaving.value = true; mError.value = ''; mSummary.value = ''; mConflict.value = false
  try {
    const resp = await props.backend.send<{ ok?: boolean; revision?: string; conflict?: boolean; error?: string }>(
      'mcp.save_servers',
      { servers: snapshot.servers, expected_revision: expectedRevision }
    )
    if (resp.ok && resp.payload?.ok !== false) {
      mRevision.value = resp.payload?.revision ?? mRevision.value
      if (!snapshot.silent) mSummary.value = 'Saved — MCP Manager restarting…'
      return { ok: true, revision: mRevision.value }
    }
    mConflict.value = resp.payload?.conflict === true || resp.error?.code === 'MCP_SETTINGS_CONFLICT'
    mError.value = resp.payload?.error
      ?? resp.error?.message
      ?? (mConflict.value ? 'The MCP settings changed on disk. Reload before saving.' : 'Save failed')
    return { ok: false }
  } catch (err) { mError.value = String((err as Error).message ?? err) }
  finally { mSaving.value = false }
  return { ok: false }
}

async function mAddFromCatalog(entry: CatalogEntry) {
  if (mIsInstalled(entry.name)) return
  const server: McpServer = { name: entry.name, transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, enabled: true }
  mServers.value.push(server)
  if (await mSave(true)) {
    mView.value = 'list'
    mSummary.value = `Added ${entry.label}`
  } else {
    mServers.value = mServers.value.filter((item) => item !== server)
  }
  // An entry that needs credentials opens straight into the pane's editor.
  if (entry.requiresEnv?.length) mSelectName.value = entry.name
}

async function mCreateCustom() {
  const name = mCustomName.value.trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    mError.value = 'Server name must use lowercase letters, digits, dashes, or underscores.'
    return
  }
  if (mIsInstalled(name)) {
    mError.value = `A server named "${name}" already exists.`
    return
  }
  const endpoint = mCustomTransport.value === 'stdio' ? mCustomCommand.value.trim() : mCustomUrl.value.trim()
  if (!endpoint) {
    mError.value = mCustomTransport.value === 'stdio' ? 'Command is required.' : 'URL is required.'
    return
  }
  const server = mServerForTransport(name, mCustomTransport.value, endpoint)
  mServers.value.push(server)
  if (await mSave(true)) {
    mCustomName.value = ''
    mCustomTransport.value = 'stdio'
    mCustomCommand.value = ''
    mCustomUrl.value = ''
    mSelectName.value = name
    mView.value = 'list'
  } else {
    mServers.value = mServers.value.filter((item) => item !== server)
  }
}

/** Apply an edited copy from the pane, then hand it to the same save queue
 *  the catalog and custom views use — one writer, one revision. */
async function mReplaceServer(next: McpServer) {
  const idx = mServers.value.findIndex((server) => server.name === next.name)
  if (idx === -1) return
  mServers.value[idx] = mNormalizeServer(next)
  await mSave(true)
}

async function mRemoveByName(name: string) {
  const idx = mServers.value.findIndex((server) => server.name === name)
  if (idx >= 0) await mRemoveServer(idx)
}

async function mRemoveServer(idx: number) {
  if (mServers.value[idx]?.name === mSelectName.value) mSelectName.value = ''
  mServers.value.splice(idx, 1)
  await mSave(true)
}


async function mOpenConfig() {
  if (mConfigPath.value) await (window as any).agentTeam.openPath(mConfigPath.value)
}

// ══════════════════════════════════════════════════════════════════════════════
// EXTERNAL ACCESS (MCP tab): external MCP client access + CDP debug toggle.
// ══════════════════════════════════════════════════════════════════════════════

interface ExternalAccessState { enabled: boolean; token: string; port: number }
const eaEnabled = ref(false)
const eaToken = ref('')
const eaPort = ref(0)
const eaLoading = ref(false)
const eaError = ref('')
const eaCopied = ref(false)

const eaUrl = computed(() => (
  eaEnabled.value && eaPort.value
    ? `http://127.0.0.1:${eaPort.value}/plan-mcp?client=external&t=${eaToken.value}`
    : ''
))

async function eaLoad(): Promise<void> {
  eaLoading.value = true; eaError.value = ''
  try {
    const resp = await props.backend.send<ExternalAccessState>('external_access.get', {})
    if (resp.ok && resp.payload) {
      eaEnabled.value = resp.payload.enabled
      eaToken.value = resp.payload.token
      eaPort.value = resp.payload.port
    } else {
      eaError.value = resp.error?.message ?? 'Load failed'
    }
  } catch (err) { eaError.value = String((err as Error).message ?? err) }
  finally { eaLoading.value = false }
}

async function eaSetEnabled(enabled: boolean): Promise<void> {
  const prev = eaEnabled.value
  eaEnabled.value = enabled
  eaError.value = ''
  try {
    const resp = await props.backend.send<ExternalAccessState>('external_access.set', { enabled })
    if (resp.ok && resp.payload) {
      eaEnabled.value = resp.payload.enabled
      eaToken.value = resp.payload.token
      eaPort.value = resp.payload.port
    } else {
      eaEnabled.value = prev
      eaError.value = resp.error?.message ?? 'Save failed'
    }
  } catch (err) {
    eaEnabled.value = prev
    eaError.value = String((err as Error).message ?? err)
  }
}

async function eaRegenerateToken(): Promise<void> {
  eaError.value = ''
  try {
    const resp = await props.backend.send<ExternalAccessState>('external_access.regenerate', {})
    if (resp.ok && resp.payload) {
      eaToken.value = resp.payload.token
    } else {
      eaError.value = resp.error?.message ?? 'Regenerate failed'
    }
  } catch (err) { eaError.value = String((err as Error).message ?? err) }
}

async function eaCopyUrl(): Promise<void> {
  if (!eaUrl.value) return
  try {
    await navigator.clipboard.writeText(eaUrl.value)
    eaCopied.value = true
    setTimeout(() => { eaCopied.value = false }, 1500)
  } catch { /* clipboard unavailable — no-op */ }
}

// CDP (Chrome DevTools Protocol) debug toggle. Takes effect on next app
// restart — the switch is applied at pre-ready startup in main (cdp-debug.ts).
const cdpEnabled = ref(false)
const cdpPort = ref(9223)
const cdpSaving = ref(false)

async function cdpLoad(): Promise<void> {
  const resp = await window.agentTeam?.readCdpDebugConfig?.()
  if (resp?.ok && resp.config) {
    cdpEnabled.value = resp.config.enabled
    cdpPort.value = resp.config.port
  }
}

async function cdpSetEnabled(enabled: boolean): Promise<void> {
  cdpEnabled.value = enabled
  cdpSaving.value = true
  try {
    await window.agentTeam?.writeCdpDebugConfig?.({ enabled, port: cdpPort.value })
  } finally { cdpSaving.value = false }
}

watch(activeTab, (tab) => {
  if (tab === 'mcp' && mServers.value.length === 0) mLoad()
  if (tab === 'mcp') { void eaLoad(); void cdpLoad() }
  if (tab === 'appearance') void loadAutoRestore()
  if (tab === 'accounts') void accountsApi.refresh()
  if (tab === 'cliAgents') {
    refreshLaunchOverrides()
    void onboarding.refresh()
  } else {
    cliInstallOpen.value = false
    void closeCliDrawer(false)
  }
})

</script>

<template>
  <Teleport to="body">
    <!-- Overlay -->
    <div class="s-overlay nv-modal-overlay" @click.self="closeSettingsLayer()">
      <!-- lang lets CJK line breaking and glyph choice follow the UI locale. -->
      <div class="s-modal nv-modal-shell nv-modal-shell--wide" :lang="$i18n.locale">

        <!-- ── Sidebar (title + search + grouped nav) ────────────────────── -->
        <aside class="s-sidebar" :inert="!!selectedCliKey">
          <div class="s-ws-header">
            <div class="s-ws-avatar" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"/></svg>
            </div>
            <div class="s-ws-meta">
              <span class="s-ws-name" v-truncate>{{ $t('settings.nav.title') }}</span>
            </div>
          </div>

          <div class="s-search-box">
            <input
              v-model="settingsSearchQuery"
              class="s-search-input"
              type="search"
              :placeholder="$t('settings.search.placeholder')"
              spellcheck="false"
              @keydown.escape="settingsSearchQuery = ''"
            />
            <div v-if="settingsSearchQuery.trim()" class="s-search-results">
              <button
                v-for="item in settingsSearchResults"
                :key="item.id"
                class="s-search-result"
                @click="openSettingsSearchResult(item)"
              >
                <span class="s-search-result-main">
                  <span class="s-search-result-title" v-truncate>{{ item.title }}</span>
                  <span class="s-search-result-group">{{ item.group }}</span>
                </span>
                <span class="s-search-result-summary">{{ item.summary }}</span>
              </button>
              <div v-if="settingsSearchResults.length === 0" class="s-search-empty">
                {{ $t('settings.search.no-results') }}
              </div>
            </div>
          </div>

          <nav class="s-nav" :aria-label="$t('settings.nav.sections-label')">
            <div class="s-nav-group">
              <div class="s-nav-group-title">{{ $t('settings.nav.group.general') }}</div>
              <SettingsNavItem :label="$t('settings.nav.general')" :active="activeTab === 'general'" @select="activeTab = 'general'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.appearance')" :active="activeTab === 'appearance'" @select="activeTab = 'appearance'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5 13.5 5.5 6.5 12.5 3.5 12.5 3.5 9.5 10.5 2.5Z"/><path d="M9 4l3 3"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.language')" :active="activeTab === 'language'" @select="activeTab = 'language'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="2.7" ry="6.5"/><path d="M1.5 8h13"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.statusBadges')" :active="activeTab === 'statusBadges'" @select="activeTab = 'statusBadges'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="4.5" width="13" height="7" rx="3.5"/><circle cx="5.5" cy="8" r="1.5"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.layout')" :active="activeTab === 'layout'" @select="activeTab = 'layout'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M5.5 2.5v11M14.5 6h-9"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.notifications')" :active="activeTab === 'notifications'" @select="activeTab = 'notifications'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.4L3 10.4v.8h10v-.8l-1.4-2.2V5.8A3.6 3.6 0 0 0 8 2.2Z"/><path d="M6.6 13a1.4 1.4 0 0 0 2.8 0"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.voice')" :active="activeTab === 'voice'" @select="activeTab = 'voice'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5.8" y="1.8" width="4.4" height="7.6" rx="2.2"/><path d="M3.5 7.6a4.5 4.5 0 0 0 9 0M8 12.1v2.1"/></svg>
                </template>
              </SettingsNavItem>
            </div>

            <div class="s-nav-group">
              <div class="s-nav-group-title">{{ $t('settings.nav.group.accountsAgents') }}</div>
              <SettingsNavItem :label="$t('settings.nav.accounts')" :active="activeTab === 'accounts'" @select="activeTab = 'accounts'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5.2" r="2.6"/><path d="M3.3 13c0-2.5 2.1-4 4.7-4s4.7 1.5 4.7 4"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.cliAgents')" :active="activeTab === 'cliAgents'" @select="activeTab = 'cliAgents'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.3" y="5" width="9.4" height="7" rx="1.6"/><path d="M8 2.3V5"/><circle cx="8" cy="2.1" r="0.6"/><path d="M6 8.3v0.01M10 8.3v0.01"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.analyzer')" :active="activeTab === 'analyzer'" @select="activeTab = 'analyzer'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.2C6.6 2.2 4.2 2.8 4.2 4.8 2.7 5.1 2.7 7.3 4.2 7.8c0 2 1.9 2.6 3.8 2.1"/><path d="M8 3.2c1.4-1 3.8-.4 3.8 1.6 1.5.3 1.5 2.5 0 3 0 2-1.9 2.6-3.8 2.1"/><path d="M8 3.2v9.6"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('guard.nav')" :active="activeTab === 'security'" @select="activeTab = 'security'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4Z"/><path d="M5.8 8l1.6 1.6 2.9-3"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('channels.nav')" :active="activeTab === 'channels'" @select="activeTab = 'channels'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 3.4h10.8v7.2H7l-3 2.4v-2.4H2.6Z"/><path d="M5.4 6.2h5.2M5.4 8.2h3.2"/></svg>
                </template>
              </SettingsNavItem>
            </div>

            <div class="s-nav-group">
              <div class="s-nav-group-title">{{ $t('settings.nav.group.integration') }}</div>
              <SettingsNavItem :label="$t('settings.nav.mcp')" :active="activeTab === 'mcp'" @select="activeTab = 'mcp'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2.3v3M10.5 2.3v3"/><path d="M4 5.3h8v2.2a4 4 0 0 1-8 0V5.3Z"/><path d="M8 11.5v2.2"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.skills')" :active="activeTab === 'skills'" @select="activeTab = 'skills'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3.2h4.2v4.2H3zM8.8 3.2H13v4.2H8.8zM3 9H7.2v3.8H3z"/><path d="M10.9 9v3.8M9 10.9h3.8"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.prompts')" :active="activeTab === 'prompts'" @select="activeTab = 'prompts'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6"/><path d="M4.6 6.2 6.8 8.2l-2.2 2"/><path d="M8.6 10.4h3"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.memory')" :active="activeTab === 'memory'" @select="activeTab = 'memory'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 2.6h6.1l3.5 3.5v7.3H3.2Z"/><path d="M9.1 2.7v3.5h3.5"/><path d="M5.4 8.4h5.2M5.4 10.7h3.4"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.credentials')" :active="activeTab === 'credentials'" :badge="credentialsHighCount" @select="activeTab = 'credentials'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.2" cy="10.8" r="2.6"/><path d="M7.1 9 13 3.1M10.9 5.2l1.7 1.7M9 7.1l1.4 1.4"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.cliExtensions')" :active="activeTab === 'cliExtensions'" @select="activeTab = 'cliExtensions'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="5.2" width="7.2" height="7.2" rx="1.4"/><path d="M9.8 7.4h1.6a1.2 1.2 0 0 0 0-2.4h-.2V3.6M12.6 8.8v2.4a1.2 1.2 0 0 1-1.2 1.2H9.8"/></svg>
                </template>
              </SettingsNavItem>
            </div>

            <div class="s-nav-group">
              <div class="s-nav-group-title">{{ $t('settings.nav.group.navidePlugins') }}</div>
              <SettingsNavItem :label="$t('settings.nav.crossDevice')" :active="activeTab === 'cross-device'" @select="activeTab = 'cross-device'">
                <template #icon>
                  <!-- The same mark as the titlebar and the page header: this
                       row is how most people will first reach Navide Cloud. -->
                  <NavideCloudMark variant="solid" class="nvc-nav-mark" />
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.extensions')" :active="activeTab === 'extensions'" :badge="pluginUpdates.count.value" @select="activeTab = 'extensions'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 2.6h3.2v1.5a1.3 1.3 0 0 0 2.4 0V2.6h1.4v3.2h-1.5a1.3 1.3 0 0 0 0 2.4h1.5v3.2H6.4v-1.5a1.3 1.3 0 0 0-2.4 0v1.5H2.6V8.2h1.5a1.3 1.3 0 0 0 0-2.4H2.6V2.6h3.8Z"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavSubItem
                v-for="page in pluginsPages"
                :key="page.id"
                :label="$t(page.label)"
                :active="activeTab === 'extensions' && pluginsPage === page.id"
                @select="openPluginsPage(page.id)"
              />
              <SettingsNavItem :label="$t('settings.nav.marketplace')" :active="activeTab === 'marketplace'" @select="activeTab = 'marketplace'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 5.4h10.8l-.8 7.1a1.2 1.2 0 0 1-1.2 1.1H4.6a1.2 1.2 0 0 1-1.2-1.1L2.6 5.4Z"/><path d="M5.8 7.2V4.6a2.2 2.2 0 0 1 4.4 0v2.6"/></svg>
                </template>
              </SettingsNavItem>
            </div>

            <div class="s-nav-group">
              <div class="s-nav-group-title">{{ $t('settings.nav.group.system') }}</div>
              <SettingsNavItem :label="$t('settings.nav.keybindings')" :active="activeTab === 'keybindings'" @select="activeTab = 'keybindings'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.3" y="3.8" width="13.4" height="8.4" rx="1.4"/><path d="M4 6.4h0.01M6.4 6.4h0.01M8.8 6.4h0.01M11.2 6.4h0.01M4 8.8h0.01M11.2 8.8h0.01M6 10.6h4"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.updates')" :active="activeTab === 'updates'" @select="activeTab = 'updates'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.3V2.8M8 2.8 5.3 5.5M8 2.8l2.7 2.7"/><path d="M3.3 10.5v1.6a1.2 1.2 0 0 0 1.2 1.2h7a1.2 1.2 0 0 0 1.2-1.2v-1.6"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.help')" :active="activeTab === 'help'" @select="activeTab = 'help'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.2a1.85 1.85 0 1 1 2.6 1.7c-.5.25-.8.7-.8 1.25v.3"/><path d="M8 11.9v0.01"/></svg>
                </template>
              </SettingsNavItem>
            </div>
          </nav>
        </aside>

        <!-- ── Content (close button + all tab bodies) ───────────────────── -->
        <div class="s-content">
          <button class="s-close" :inert="!!selectedCliKey" @click="emit('close')" :title="$t('action.close-esc')">✕</button>

        <!-- ── MCP TAB ───────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'mcp'" class="s-body s-body--bleed mcp-body">
          <h1 class="s-page-title">{{ $t('settings.nav.mcp') }}</h1>

          <!-- ── LIST VIEW ──────────────────────────────────────────────── -->
          <template v-if="mView === 'list'">
            <div class="mcp-topbar" data-settings-section="mcp-installed">
              <span class="mcp-page-title">{{ $t('settings.mcp.all-title') }}</span>
              <div class="mcp-topbar-actions">
                <button class="mcp-action-btn" @click="mView = 'catalog'">{{ $t('action.add-mcp') }}</button>
                <button class="mcp-action-btn" @click="mView = 'custom'">{{ $t('settings.mcp.add-custom') }}</button>
                <button class="mcp-action-btn" @click="mLoad()" :disabled="mLoading">{{ $t('action.refresh') }}</button>
                <button class="mcp-action-btn" @click="mOpenConfig" :disabled="!mConfigPath">{{ $t('action.open-mcp-config') }}</button>
              </div>
            </div>
            <div class="settings-meta-row">
              <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
              <span class="scope-badge">{{ scopeLabel(settingsScopeNotes.mcp.scope) }}</span>
              <span class="settings-path" v-truncate>{{ pathForTab('mcp') }}</span>
              <button class="settings-path-btn" :disabled="!settingsPaths.mcp" @click="openSettingsPath(settingsPaths.mcp)">{{ $t('action.open') }}</button>
            </div>
            <p v-if="mError" class="err-msg" style="margin:6px 22px 0">{{ mError }}</p>
            <div v-if="mConflict" class="mcp-conflict">
              <span>{{ $t('settings.mcp.conflict') }}</span>
              <button class="mcp-action-btn" @click="mLoad(true)">{{ $t('settings.mcp.reload') }}</button>
            </div>
            <span v-if="mSummary" class="mcp-summary-ok">{{ mSummary }}</span>

            <McpPane
              class="mcp-agent-pane"
              data-settings-section="mcp-agents"
              :servers="mServers"
              :native="mNative"
              :agents="mAgents"
              :loading="mLoading"
              :select-name="mSelectName"
              @save="mReplaceServer"
              @remove="mRemoveByName"
              @refresh="mLoad(true)"
              @select-consumed="mSelectName = ''"
            />

            <!-- ── EXTERNAL ACCESS ──────────────────────────────────────── -->
            <div class="ea-section-wrap">
            <SettingsSection :label="$t('settings.mcp.external-access-title')" data-settings-section="mcp-external-access">
              <SettingsCard>
                <SettingRow
                  :title="$t('settings.mcp.allow-external')"
                  :description="$t('settings.mcp.external-access-hint')"
                >
                  <template #control>
                    <ToggleSwitch
                      :model-value="eaEnabled"
                      :disabled="eaLoading"
                      :aria-label="$t('settings.mcp.allow-external')"
                      @update:model-value="eaSetEnabled"
                    />
                  </template>
                </SettingRow>
                <p class="ea-warning">{{ $t('settings.mcp.allow-external-warning') }}</p>
                <p v-if="eaError" class="err-msg">{{ eaError }}</p>
                <div v-if="eaEnabled" class="ea-connection">
                  <div class="field">
                    <label class="lbl">{{ $t('settings.mcp.connection-url') }}</label>
                    <div class="row-g gap">
                      <input :value="eaUrl" type="text" readonly spellcheck="false" />
                      <button class="mcp-action-btn" @click="eaCopyUrl">
                        {{ eaCopied ? $t('settings.mcp.token-copied') : $t('action.copy') }}
                      </button>
                      <button class="mcp-action-btn" @click="eaRegenerateToken">{{ $t('settings.mcp.regenerate-token') }}</button>
                    </div>
                  </div>
                </div>

                <SettingRow
                  :title="$t('settings.mcp.cdp-title')"
                  :description="$t('settings.mcp.cdp-hint')"
                >
                  <template #control>
                    <ToggleSwitch
                      :model-value="cdpEnabled"
                      :disabled="cdpSaving"
                      :aria-label="$t('settings.mcp.cdp-title')"
                      @update:model-value="cdpSetEnabled"
                    />
                  </template>
                </SettingRow>
                <p class="ea-warning">{{ $t('settings.mcp.cdp-warning') }}</p>
              </SettingsCard>
            </SettingsSection>
            </div>
          </template>

          <!-- ── CATALOG VIEW ────────────────────────────────────────────── -->
          <template v-else-if="mView === 'catalog'">
            <div class="mcp-topbar" data-settings-section="mcp-catalog">
              <button class="mcp-back-btn nv-btn" @click="mView = 'list'">← {{ $t('action.back') }}</button>
              <span class="mcp-page-title">{{ $t('settings.mcp.catalog-title') }}</span>
            </div>

            <div class="mcp-search-wrap">
              <input v-model="mSearch" type="text" :placeholder="$t('settings.mcp.catalog-search')" class="mcp-search" spellcheck="false" />
              <span class="mcp-search-icon">🔍</span>
            </div>

            <div class="mcp-catalog-hint">
              💡 <span v-html="$t('settings.mcp.catalog-hint')"></span>
            </div>

            <div class="mcp-catalog-list">
              <div v-for="item in mFilteredCatalog" :key="item.name" class="mcp-catalog-card">
                <div class="mcp-catalog-info">
                  <div class="mcp-catalog-name">{{ item.label }}</div>
                  <div class="mcp-catalog-desc">{{ t(item.descriptionKey) }}</div>
                  <div v-if="item.requiresEnv?.length" class="mcp-catalog-note">
                    ⚠ {{ $t('settings.mcp.catalog-requires-env', { vars: item.requiresEnv.join(', ') }) }}
                  </div>
                </div>
                <button v-if="mIsInstalled(item.name)" class="mcp-installed-badge" disabled>{{ $t('label.installed') }}</button>
                <button v-else class="mcp-add-btn nv-btn nv-btn--primary" @click="mAddFromCatalog(item)" :disabled="mSaving">+ {{ $t('action.add') }}</button>
              </div>
              <div v-if="mFilteredCatalog.length === 0" class="mcp-empty">{{ $t('settings.mcp.catalog-empty') }}</div>
            </div>
          </template>

          <template v-else>
            <div class="mcp-topbar" data-settings-section="mcp-custom">
              <button class="mcp-back-btn nv-btn" @click="mView = 'list'">← {{ $t('action.back') }}</button>
              <span class="mcp-page-title">{{ $t('settings.mcp.custom-title') }}</span>
            </div>
            <form class="mcp-custom-form" @submit.prevent="mCreateCustom">
              <p>{{ $t('settings.mcp.custom-hint') }}</p>
              <div class="field">
                <label class="lbl">{{ $t('settings.mcp.server-name') }}</label>
                <input v-model="mCustomName" required pattern="[a-z0-9][a-z0-9_-]{0,63}" maxlength="64" spellcheck="false" autocomplete="off" placeholder="my-server" />
              </div>
              <div class="field">
                <label class="lbl">{{ $t('settings.mcp.transport') }}</label>
                <select v-model="mCustomTransport">
                  <option value="stdio">stdio</option>
                  <option value="http">HTTP</option>
                  <option value="sse">SSE</option>
                </select>
              </div>
              <div v-if="mCustomTransport === 'stdio'" class="field">
                <label class="lbl">{{ $t('label.mcp-command') }}</label>
                <input v-model="mCustomCommand" required spellcheck="false" placeholder="npx" />
              </div>
              <div v-else class="field">
                <label class="lbl">{{ $t('label.url') }}</label>
                <input v-model="mCustomUrl" required type="url" spellcheck="false" placeholder="https://example.com/mcp" />
              </div>
              <div class="mcp-custom-actions">
                <button type="button" class="mcp-action-btn" @click="mView = 'list'">{{ $t('action.cancel') }}</button>
                <button
                  type="submit"
                  class="mcp-add-btn nv-btn nv-btn--primary"
                  :disabled="mSaving || !mCustomName.trim() || (mCustomTransport === 'stdio' ? !mCustomCommand.trim() : !mCustomUrl.trim())"
                >{{ $t('settings.mcp.create-server') }}</button>
              </div>
            </form>
          </template>

        </div>

        <!-- ── SKILLS TAB ───────────────────────────────────────────────── -->
        <div v-show="activeTab === 'skills'" class="s-body s-body--bleed" data-settings-section="skills">
          <h1 class="s-page-title">{{ $t('settings.nav.skills') }}</h1>
          <div class="settings-meta-row">
            <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
            <span class="scope-badge">{{ scopeLabel(settingsScopeNotes.skills.scope) }}</span>
            <span class="settings-path" v-truncate>{{ pathForTab('skills') }}</span>
            <button class="settings-path-btn" :disabled="!settingsPaths.skills" @click="openSettingsPath(settingsPaths.skills)">{{ $t('action.open') }}</button>
          </div>
          <SkillsPane :backend="props.backend" />
        </div>

        <!-- ── CREDENTIALS TAB ──────────────────────────────────────────── -->
        <div v-show="activeTab === 'credentials'" class="s-body s-body--bleed" data-settings-section="credentials">
          <h1 class="s-page-title">{{ $t('settings.nav.credentials') }}</h1>
          <div class="settings-meta-row">
            <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
            <span class="scope-badge">{{ scopeLabel(settingsScopeNotes.credentials.scope) }}</span>
          </div>
          <CredentialsPane :backend="props.backend" :active="activeTab === 'credentials'" @high-count="credentialsHighCount = $event" />
        </div>

        <!-- ── PROMPTS TAB ──────────────────────────────────────────────── -->
        <div v-show="activeTab === 'prompts'" class="s-body s-body--bleed" data-settings-section="prompts">
          <h1 class="s-page-title">{{ $t('settings.nav.prompts') }}</h1>
          <div class="settings-meta-row">
            <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
            <span class="scope-badge">{{ scopeLabel(settingsScopeNotes.prompts.scope) }}</span>
          </div>
          <PromptSkillsPane />
        </div>

        <!-- ── MEMORY TAB ───────────────────────────────────────────────── -->
        <div v-show="activeTab === 'memory'" class="s-body s-body--bleed" data-settings-section="memory">
          <h1 class="s-page-title">{{ $t('settings.nav.memory') }}</h1>
          <div class="settings-meta-row">
            <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
            <span class="scope-badge">{{ scopeLabel(settingsScopeNotes.memory.scope) }}</span>
          </div>
          <!-- Project files belong to the folder that is actually open; the
               first known workspace is the current one whenever there is one. -->
          <MemoryPane
            :backend="props.backend"
            :workspace-path="props.workspacePath ?? ''"
          />
        </div>

        <!-- ── ANALYZER TAB ─────────────────────────────────────────────── -->
        <div v-show="activeTab === 'analyzer'" class="s-body s-body--bleed analyzer-body">
          <h1 class="s-page-title">{{ $t('settings.nav.analyzer') }}</h1>
          <div class="settings-meta-row">
            <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
            <span class="scope-badge">{{ scopeLabel(settingsScopeNotes.analyzer.scope) }}</span>
            <span class="settings-path" v-truncate>{{ settingsPaths.analyzer }}</span>
            <button class="settings-path-btn" :disabled="!settingsPaths.analyzer" @click="openSettingsPath(settingsPaths.analyzer)">{{ $t('action.open') }}</button>
            <span class="settings-path-divider">·</span>
            <span class="settings-path" v-truncate>{{ $t('settings.analyzer.ai-keys-label') }} {{ settingsPaths.ai_chat }}</span>
            <button class="settings-path-btn" :disabled="!settingsPaths.ai_chat" @click="openSettingsPath(settingsPaths.ai_chat)">{{ $t('action.open') }}</button>
          </div>

          <!-- ① Inference backend -->
          <div class="az-section" data-settings-section="analyzer-backend">
            <div class="az-section-title">{{ $t('settings.analyzer.inference-backend') }}</div>
            <div class="az-backend-toggle">
              <button
                :class="['az-backend-btn', { active: props.analyzerApi.analyzerSettings.value.backend === 'ollama' }]"
                @click="props.analyzerApi.saveSettings({ backend: 'ollama' })"
              >Ollama REST</button>
              <button
                :class="['az-backend-btn', { active: props.analyzerApi.analyzerSettings.value.backend === 'llama_cpp' }]"
                @click="props.analyzerApi.saveSettings({ backend: 'llama_cpp' })"
              >llama.cpp</button>
            </div>

            <!-- llama.cpp-specific settings -->
            <template v-if="props.analyzerApi.analyzerSettings.value.backend === 'llama_cpp'">
              <div class="az-subsection">
                <label class="az-label">{{ $t('settings.analyzer.llama-cli-path') }}
                  <span class="az-hint-inline">{{ $t('settings.analyzer.llama-cli-path-hint') }}</span>
                </label>
                <div class="az-url-row">
                  <input
                    class="az-input"
                    type="text"
                    :placeholder="$t('settings.analyzer.llama-cli-placeholder')"
                    :value="props.analyzerApi.analyzerSettings.value.llama_cli"
                    @change="props.analyzerApi.saveSettings({ llama_cli: ($event.target as HTMLInputElement).value })"
                  />
                  <button
                    class="az-detect-btn"
                    :disabled="azDetecting"
                    @click="azDetectCli"
                    :title="$t('settings.analyzer.auto-detect-title')"
                  >{{ azDetecting ? '…' : $t('settings.analyzer.auto-detect') }}</button>
                  <button class="az-browse-btn" @click="azPickCli" :title="$t('action.browse')">…</button>
                </div>
                <div class="az-status-row">
                  <span class="az-status-dot" :class="props.analyzerApi.health.value?.ok ? 'ok' : 'err'"></span>
                  <span class="az-version" v-if="props.analyzerApi.health.value?.ok">
                    llama-cli {{ props.analyzerApi.health.value?.version }}
                  </span>
                  <span class="az-version offline" v-else>{{ $t('settings.analyzer.llama-not-detected') }}</span>
                </div>
              </div>

              <div class="az-subsection">
                <label class="az-label">{{ $t('settings.analyzer.gguf-path') }}
                  <span class="az-hint-inline">{{ $t('settings.analyzer.gguf-path-hint') }}</span>
                </label>
                <div class="az-url-row">
                  <input
                    class="az-input"
                    type="text"
                    :placeholder="$t('settings.analyzer.gguf-path-placeholder')"
                    :value="props.analyzerApi.analyzerSettings.value.gguf_path"
                    @change="props.analyzerApi.saveSettings({ gguf_path: ($event.target as HTMLInputElement).value })"
                  />
                  <button
                    class="az-recheck-btn nv-btn"
                    :disabled="azRechecking"
                    @click="azRecheck"
                    :title="$t('action.recheck-file-exists')"
                  >{{ azRechecking ? '…' : '↻' }}</button>
                  <button class="az-browse-btn" @click="azPickGguf" :title="$t('action.browse')">…</button>
                </div>
                <template v-if="props.analyzerApi.analyzerSettings.value.gguf_path">
                  <div class="az-status-row">
                    <span class="az-status-dot" :class="props.analyzerApi.health.value?.gguf_warning ? 'err' : 'ok'"></span>
                    <span class="az-version" v-if="props.analyzerApi.health.value?.ok && !props.analyzerApi.health.value?.gguf_warning">
                      {{ $t('settings.analyzer.gguf-file-found') }} · {{ props.analyzerApi.health.value?.gguf_size ? ((props.analyzerApi.health.value.gguf_size as number) / 1e9).toFixed(1) + ' GB' : '' }}
                    </span>
                    <span class="az-version offline" v-else>{{ (props.analyzerApi.health.value as any)?.gguf_warning ?? $t('settings.analyzer.gguf-not-detected') }}</span>
                  </div>
                </template>
                <div class="az-gguf-hint" v-html="$t('settings.analyzer.gguf-hint')"></div>
              </div>
            </template>

            <!-- Ollama REST-specific settings -->
            <template v-if="props.analyzerApi.analyzerSettings.value.backend === 'ollama'">
              <div class="az-subsection">
                <label class="az-label">{{ $t('settings.analyzer.inference-url') }}</label>
                <div class="az-url-row">
                  <input
                    class="az-input"
                    type="text"
                    placeholder="http://localhost:11434"
                    :value="props.analyzerApi.analyzerSettings.value.ollama_base_url"
                    @change="props.analyzerApi.saveSettings({ ollama_base_url: ($event.target as HTMLInputElement).value })"
                  />
                  <button
                    class="az-recheck-btn nv-btn"
                    :disabled="azRechecking"
                    @click="azRecheck"
                    :title="$t('settings.analyzer.recheck-title')"
                  >{{ azRechecking ? '…' : '↻' }}</button>
                </div>
                <div class="az-status-row">
                  <span class="az-status-dot" :class="props.analyzerApi.health.value?.ok ? 'ok' : 'err'"></span>
                  <span class="az-version" v-if="props.analyzerApi.health.value?.ok">
                    {{ $t('settings.analyzer.ollama-connected', { version: props.analyzerApi.health.value?.version }) }}
                  </span>
                  <span class="az-version offline" v-else>
                    {{ $t('settings.analyzer.not-connected') }} <code class="az-code">ollama serve</code>
                  </span>
                </div>
              </div>
            </template>
          </div>

          <!-- ② Model manager (Ollama mode only) -->
          <div v-if="props.analyzerApi.analyzerSettings.value.backend === 'ollama'" class="az-section az-models-section" data-settings-section="analyzer-models">
            <div class="az-section-header">
              <div class="az-section-title">{{ $t('settings.analyzer.model-manager') }}</div>
              <span class="az-section-note">{{ $t('settings.analyzer.model-manager-note') }}</span>
            </div>

            <!-- Pull a new model -->
            <div class="az-pull-row">
              <input
                class="az-input az-pull-input"
                type="text"
                :placeholder="$t('settings.analyzer.model-placeholder')"
                v-model="azPullName"
                @keydown.enter="azDoPull"
              />
              <button
                class="az-pull-btn nv-btn"
                :disabled="props.analyzerApi.pulling.value || !azPullName.trim()"
                @click="azDoPull"
              >
                {{ props.analyzerApi.pulling.value ? $t('settings.analyzer.downloading') : $t('settings.analyzer.download') }}
              </button>
            </div>

            <!-- Download progress -->
            <div v-if="props.analyzerApi.pulling.value" class="az-progress-wrap">
              <div class="az-progress-label">
                <span class="az-spin" aria-hidden="true"></span>
                <span>{{ props.analyzerApi.pullProgress.value?.status ?? $t('settings.analyzer.connecting') }}</span>
                <template v-if="props.analyzerApi.pullProgress.value?.total">
                  <span class="az-pct">
                    {{ Math.round((props.analyzerApi.pullProgress.value.completed ?? 0) / props.analyzerApi.pullProgress.value.total * 100) }}%
                  </span>
                  <span class="az-size-info">
                    {{ ((props.analyzerApi.pullProgress.value.completed ?? 0) / 1e9).toFixed(1) }}
                    / {{ (props.analyzerApi.pullProgress.value.total / 1e9).toFixed(1) }} GB
                  </span>
                </template>
              </div>
              <div v-if="props.analyzerApi.pullProgress.value?.total" class="az-progress-bar-wrap">
                <div
                  class="az-progress-bar"
                  :style="{ width: Math.round((props.analyzerApi.pullProgress.value.completed ?? 0) / props.analyzerApi.pullProgress.value.total * 100) + '%' }"
                ></div>
              </div>
            </div>
            <div v-if="props.analyzerApi.pullError.value" class="az-pull-error">
              ⚠ {{ props.analyzerApi.pullError.value }}
            </div>

            <!-- Installed models list -->
            <div class="az-model-list">
              <div v-if="props.analyzerApi.models.value.length === 0" class="az-no-models">
                {{ $t('settings.analyzer.no-local-models') }}
              </div>
              <div
                v-for="m in props.analyzerApi.models.value"
                :key="m.name"
                class="az-model-row"
              >
                <div class="az-model-info">
                  <span class="az-model-name">{{ m.name }}</span>
                  <span class="az-model-meta">
                    {{ m.parameter_size || m.family }}
                    <template v-if="m.size > 0"> · {{ (m.size / 1e9).toFixed(1) }} GB</template>
                  </span>
                </div>
                <button class="az-del-btn nv-btn nv-btn--danger" @click="azDoDelete(m.name)" :title="$t('settings.analyzer.delete-local-title')">✕</button>
              </div>
            </div>
          </div>

          <!-- ③ Model benchmark -->
          <div class="az-section az-benchmark-section" data-settings-section="analyzer-models">
            <div class="az-section-header">
              <div class="az-section-title">{{ $t('settings.analyzer.model-benchmark') }}</div>
              <button
                class="az-run-btn nv-btn nv-btn--primary"
                :disabled="props.analyzerApi.benchmarking.value || !props.analyzerApi.health.value?.ok"
                @click="props.analyzerApi.benchmark()"
              >
                {{ props.analyzerApi.benchmarking.value ? $t('settings.analyzer.running') : $t('settings.analyzer.run-benchmark') }}
              </button>
            </div>

            <div v-if="props.analyzerApi.benchmarking.value" class="az-progress-wrap">
              <div v-if="props.analyzerApi.benchmarkProgress.value" class="az-progress-label">
                <span class="az-spin" aria-hidden="true"></span>
                {{ $t('settings.analyzer.testing') }} <strong>{{ props.analyzerApi.benchmarkProgress.value.model }}</strong>
                · {{ props.analyzerApi.benchmarkProgress.value.task_id }}
              </div>
              <div v-else class="az-progress-label">{{ $t('settings.analyzer.preparing') }}</div>
            </div>

            <div v-if="!props.analyzerApi.benchmarking.value && props.analyzerApi.benchmarkResults.value.length === 0" class="az-hint">
              <p>{{ $t('settings.analyzer.benchmark-hint') }}</p>
              <ul>
                <li><strong>T1</strong> {{ $t('settings.analyzer.task-t1') }} <code>{libraries, doc_query}</code></li>
                <li><strong>T2</strong> {{ $t('settings.analyzer.task-t2') }}</li>
                <li><strong>T3</strong> {{ $t('settings.analyzer.task-t3') }}</li>
                <li><strong>T4</strong> {{ $t('settings.analyzer.task-t4') }}</li>
              </ul>
              <p class="az-pass-rule">{{ $t('settings.analyzer.pass-threshold') }}</p>
            </div>

            <div v-if="props.analyzerApi.benchmarkResults.value.length > 0" class="az-results">
              <div class="az-results-summary">
                {{ $t('settings.analyzer.passed') }}
                <strong>{{ props.analyzerApi.benchmarkResults.value.filter(r => r.passed).length }}</strong>
                /
                {{ props.analyzerApi.benchmarkResults.value.length }}
                {{ $t('settings.analyzer.models', props.analyzerApi.benchmarkResults.value.length) }}
              </div>
              <table class="az-table">
                <thead>
                  <tr>
                    <th class="az-th-model">{{ $t('settings.analyzer.col-model') }}</th>
                    <th v-for="t in ['T1','T2','T3','T4']" :key="t" class="az-th-task">{{ t }}</th>
                    <th class="az-th-score">{{ $t('settings.analyzer.col-score') }}</th>
                    <th class="az-th-verdict">{{ $t('settings.analyzer.col-verdict') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="r in props.analyzerApi.benchmarkResults.value"
                    :key="r.name"
                    :class="{ 'az-row-fail': !r.passed }"
                  >
                    <td class="az-td-model" v-truncate>{{ r.name }}</td>
                    <td v-for="tid in ['T1','T2','T3','T4']" :key="tid" class="az-td-task">
                      <template v-if="r.tasks.find(t => t.task_id === tid)">
                        <span
                          :class="r.tasks.find(t => t.task_id === tid)!.passed ? 'az-pass' : 'az-fail'"
                          :aria-label="r.tasks.find(t => t.task_id === tid)!.passed ? $t('settings.analyzer.badge-pass') : $t('settings.analyzer.badge-excluded')"
                        >
                          <svg v-if="r.tasks.find(t => t.task_id === tid)!.passed" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>
                          <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>
                        </span>
                        <span class="az-elapsed">{{ r.tasks.find(t => t.task_id === tid)!.elapsed_s }}s</span>
                      </template>
                      <span v-else class="az-na">—</span>
                    </td>
                    <td class="az-td-score">{{ r.score }}/{{ r.tasks.length }}</td>
                    <td class="az-td-verdict">
                      <span v-if="r.passed" class="az-badge-pass">{{ $t('settings.analyzer.badge-pass') }}</span>
                      <span v-else class="az-badge-fail">{{ $t('settings.analyzer.badge-excluded') }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

        </div>

        <!-- ══ CLI EXTENSIONS TAB ══ -->
        <div v-show="activeTab === 'cliExtensions'" class="s-body s-body--bleed" data-settings-section="cli-extensions">
          <h1 class="s-page-title">{{ $t('settings.nav.cliExtensions') }}</h1>
          <div class="settings-meta-row">
            <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
            <span class="scope-badge">{{ scopeLabel(settingsScopeNotes.cliExtensions.scope) }}</span>
          </div>
          <!-- Mounted on first visit only: the scan reads every CLI's files. -->
          <CliExtensionsPane v-if="visitedCliExtensions" :backend="props.backend" />
        </div>

        <!-- ══ CLI AGENTS TAB ══ -->
        <div v-show="activeTab === 'cliAgents'" class="s-body cli-agents-body">
          <div ref="cliGridRef" class="cli-agent-roster" :inert="!!selectedCliKey">
          <h1 class="s-page-title">{{ $t('settings.nav.cliAgents') }}</h1>
          <section class="ap-section" data-settings-section="cli-agents-list">
            <p class="ap-hint">{{ $t('settings.cliAgents.hint') }}</p>
            <div class="cli-agent-toolbar">
              <input v-model="cliFilterQuery" type="search" class="cli-agent-filter-search" :placeholder="$t('settings.cliAgents.search')" :aria-label="$t('settings.cliAgents.search')" />
              <div class="cli-agent-filters" :aria-label="$t('settings.cliAgents.filter-label')">
                <button v-for="filter in (['all', 'enabled', 'attention'] as const)" :key="filter" type="button" :data-cli-filter="filter" :aria-pressed="cliFilter === filter" @click="cliFilter = filter">{{ $t(`settings.cliAgents.filter-${filter}`) }}</button>
              </div>
              <button type="button" :disabled="onboarding.loading.value" @click="onboarding.refresh({ fresh: true })">{{ $t('cli-manage.redetect') }}</button>
            </div>
            <p class="ap-hint cli-agent-count">{{ $t('settings.cliAgents.count', { visible: filteredCliRows.length, total: cliAgentRows.length, enabled: cliEnabledCount }) }} · {{ $t(cliCanReorder ? 'settings.cliAgents.drag-hint' : 'settings.cliAgents.reorder-filtered') }}</p>
            <ul class="cli-agent-grid">
              <li
                v-for="row in filteredCliRows"
                :key="row.agentKey"
                class="cli-agent-card"
                :data-agent-key="row.agentKey"
                :class="{ 'drag-over': cliDragOverKey === row.agentKey, 'is-disabled': !cliAgentEnabled(row.agentKey) }"
                :draggable="cliCanReorder"
                @dragstart="onCliDragStart($event, row.agentKey)"
                @dragover="onCliDragOver($event, row.agentKey)"
                @dragenter="onCliDragOver($event, row.agentKey)"
                @dragleave="onCliDragLeave(row.agentKey)"
                @drop.prevent="onCliDrop(row.agentKey)"
                @dragend="cliDragKey = ''; cliDragOverKey = ''"
                @click="openCliDrawer(row.agentKey, $event.currentTarget)"
              >
                <div class="cli-card-heading">
                  <span class="cli-agent-grip" :title="$t('settings.cliAgents.drag-hint')" aria-hidden="true">⠿</span>
                  <span class="cli-card-icon" aria-hidden="true">{{ cardInitials(row.label) }}</span>
                  <span class="cli-agent-label">{{ row.label }}</span>
                  <span v-if="row.needsAttention" class="cli-card-attention" :title="$t('settings.cliAgents.filter-attention')" :aria-label="$t('settings.cliAgents.filter-attention')">!</span>
                </div>
                <div class="cli-card-status">
                  <span v-for="chip in row.chips.filter((chip) => chip.id === 'install' || chip.id === 'account' || chip.id === 'push')" :key="chip.id" v-truncate class="cli-chip" :class="`cli-chip--${chip.tone}`">{{ chip.label }}</span>
                  <span v-if="!row.chips.some((chip) => chip.id === 'install')" class="cli-agent-hint">{{ $t('settings.cliAgents.not-detected') }}</span>
                </div>
                <div class="cli-card-footer">
                  <label class="cli-agent-toggle" @click.stop>
                    <input type="checkbox" :checked="cliAgentEnabled(row.agentKey)" :disabled="cliAgentEnabled(row.agentKey) && cliEnabledCount <= 1" :aria-label="$t('settings.cliAgents.enable-agent', { agent: row.label })" @change="toggleCliAgent(row.agentKey)" />
                    <span>{{ $t('settings.cliAgents.enabled') }}</span>
                  </label>
                  <button type="button" class="cli-agent-manage" :aria-label="$t('settings.cliAgents.manage-agent', { agent: row.label })" @click.stop="openCliDrawer(row.agentKey, $event.currentTarget)">{{ $t('settings.cliAgents.manage') }} ›</button>
                </div>
              </li>
            </ul>
            <p v-if="!filteredCliRows.length" class="cli-agent-empty">{{ $t('settings.cliAgents.no-results') }}</p>
          </section>
          <CliRiskRangesPane v-if="activeTab === 'cliAgents'" :backend="props.backend" />
          </div>
          <Transition name="cli-drawer">
          <div v-if="selectedCli" class="cli-drawer-layer">
            <div class="cli-drawer-scrim" @click="closeCliDrawer()"></div>
            <section ref="cliDrawerRef" class="cli-agent-drawer" role="dialog" aria-modal="true" aria-labelledby="cli-drawer-title" :data-agent-key="selectedCli.agentKey" tabindex="-1">
              <header class="cli-drawer-header" :inert="cliInstallOpen">
                <div><h2 id="cli-drawer-title">{{ selectedCli.label }}</h2><p class="cli-agent-hint">{{ selectedCli.version }}</p></div>
                <button type="button" class="cli-drawer-close" :aria-label="$t('settings.cliAgents.close-drawer')" @click="closeCliDrawer()">✕</button>
              </header>
              <div class="cli-drawer-content">
              <section id="cli-panel-overview" class="ap-section cli-overview">
                <h3 class="ap-title">{{ $t('settings.cliAgents.tab-overview') }}</h3>
                <p v-if="selectedCli.hint" class="ap-hint">{{ selectedCli.hint }}</p>
                <div class="cli-agent-chips"><span v-for="chip in selectedCli.chips" :key="chip.id" v-truncate class="cli-chip" :class="`cli-chip--${chip.tone}`">{{ chip.label }}</span></div>
                <label class="cli-agent-toggle"><input type="checkbox" :checked="cliAgentEnabled(selectedCli.agentKey)" :disabled="cliAgentEnabled(selectedCli.agentKey) && cliEnabledCount <= 1" @change="toggleCliAgent(selectedCli.agentKey)" />{{ $t('settings.cliAgents.enabled') }}</label>
              </section>
          <section id="cli-panel-launch" class="ap-section" data-settings-section="cli-agents-launch">
            <h3 class="ap-title">{{ $t('settings.cliLaunch.title') }}</h3>
            <p class="ap-hint">{{ $t('settings.cliLaunch.hint') }}</p>
            <ul class="cli-agent-list">
              <li
                v-for="row in selectedLaunchRows"
                :key="row.agentKey"
                class="cli-agent-row launch-row"
                :class="{ 'launch-open': expandedLaunchKey === row.agentKey }"
              >
                <div v-if="expandedLaunchKey === row.agentKey" class="launch-body">
                  <div v-if="row.supportsModel" class="launch-field">
                    <span class="launch-field-label">{{ $t('settings.cliLaunch.model-label') }}</span>
                    <input
                      type="text"
                      class="launch-input"
                      :value="launchModelFor(row.agentKey).model"
                      :placeholder="$t('settings.cliLaunch.model-placeholder')"
                      :aria-label="$t('settings.cliLaunch.model-label')"
                      @change="onLaunchModelInput(row.agentKey, $event)"
                    />
                  </div>
                  <div v-if="row.supportsEffort" class="launch-field">
                    <span class="launch-field-label">{{ $t('settings.cliLaunch.effort-label') }}</span>
                    <select
                      v-if="row.knownEfforts.length"
                      class="launch-input"
                      :value="launchModelFor(row.agentKey).effort"
                      :aria-label="$t('settings.cliLaunch.effort-label')"
                      @change="onLaunchEffortSelect(row.agentKey, $event)"
                    >
                      <option value="">{{ $t('settings.cliLaunch.effort-vendor-default') }}</option>
                      <option v-for="level in row.knownEfforts" :key="level" :value="level">{{ level }}</option>
                    </select>
                    <!-- A vendor may declare effortArgs with no vocabulary, in
                         which case there is nothing to list and the value goes
                         through as typed. -->
                    <input
                      v-else
                      type="text"
                      class="launch-input"
                      :value="launchModelFor(row.agentKey).effort"
                      :aria-label="$t('settings.cliLaunch.effort-label')"
                      @change="onLaunchEffortSelect(row.agentKey, $event)"
                    />
                  </div>
                  <p v-if="!row.supportsModel && !row.supportsEffort" class="ap-hint launch-note">
                    {{ $t('settings.cliLaunch.no-model-args') }}
                  </p>
                  <p v-if="launchModelErrors[row.agentKey]" class="launch-error">
                    {{ launchModelErrors[row.agentKey] }}
                  </p>

                  <div class="launch-field">
                    <span class="launch-field-label">{{ $t('settings.cliLaunch.command-label') }}</span>
                    <input
                      type="text"
                      class="launch-input"
                      :value="launchCommands[row.agentKey] ?? ''"
                      :placeholder="$t('settings.cliLaunch.command-placeholder')"
                      :aria-label="$t('settings.cliLaunch.command-label')"
                      @change="onLaunchCommandInput(row.agentKey, $event)"
                    />
                  </div>
                  <div v-if="(launchCommands[row.agentKey] ?? '').trim()" class="launch-warn">
                    <p>{{ $t('settings.cliLaunch.command-shadows-model') }}</p>
                    <p>{{ $t('settings.cliLaunch.command-shadows-resume') }}</p>
                  </div>

                  <div class="launch-env-title">{{ $t('settings.cliLaunch.env-title') }}</div>
                  <table class="launch-env-table">
                    <thead>
                      <tr>
                        <th>{{ $t('settings.cliLaunch.env-col-name') }}</th>
                        <th>{{ $t('settings.cliLaunch.env-col-value') }}</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(entry, index) in (launchEnvs[row.agentKey] ?? [])" :key="entry.name">
                        <td class="env-name">
                          <code>{{ entry.name }}</code>
                          <span
                            v-if="isReservedSpawnEnvKey(entry.name, { foldCase: platformId() === 'win32' })"
                            v-truncate
                            class="cli-chip cli-chip--bad"
                          >{{ $t('settings.cliLaunch.env-reserved-chip') }}</span>
                        </td>
                        <td>
                          <input
                            type="text"
                            class="launch-input"
                            :value="entry.value"
                            :aria-label="entry.name"
                            @change="onLaunchEnvValueInput(row.agentKey, index, $event)"
                          />
                        </td>
                        <td>
                          <button type="button" class="env-remove" @click="removeLaunchEnv(row.agentKey, index)">
                            {{ $t('settings.cliLaunch.env-remove') }}
                          </button>
                        </td>
                      </tr>
                      <tr>
                        <td>
                          <input
                            v-model="envDraftName"
                            type="text"
                            class="launch-input"
                            :placeholder="$t('settings.cliLaunch.env-name-placeholder')"
                            :aria-label="$t('settings.cliLaunch.env-col-name')"
                          />
                        </td>
                        <td>
                          <input
                            v-model="envDraftValue"
                            type="text"
                            class="launch-input"
                            :placeholder="$t('settings.cliLaunch.env-value-placeholder')"
                            :aria-label="$t('settings.cliLaunch.env-col-value')"
                            @keyup.enter="addLaunchEnv(row.agentKey)"
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            class="env-add"
                            :disabled="envDraftBlocked"
                            @click="addLaunchEnv(row.agentKey)"
                          >{{ $t('settings.cliLaunch.env-add') }}</button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <p v-if="isReservedSpawnEnvKey(envDraftName, { foldCase: platformId() === 'win32' })" class="launch-warn">
                    {{ $t('settings.cliLaunch.env-reserved-warn') }}
                  </p>
                </div>
              </li>
            </ul>
            <p class="ap-hint">{{ $t('settings.cliLaunch.reserved-note', { list: reservedEnvKeyList }) }}</p>
            <p class="ap-hint">{{ $t('settings.cliLaunch.restart-note') }}</p>
          </section>
          <section id="cli-panel-permissions" class="ap-section" data-settings-section="cli-agents-permissions">
            <h3 class="ap-title">{{ $t('settings.cliPermission.title') }}</h3>
            <p class="ap-hint">{{ $t('settings.cliPermission.hint') }}</p>
            <label class="cli-agent-toggle perm-global">
              <input type="checkbox" v-model="yoloModel" />
              <span class="cli-agent-label">{{ $t('settings.cliPermission.global-label') }}</span>
            </label>
            <ul class="cli-agent-list">
              <li
                v-for="spec in selectedPermissionRows"
                :key="spec.agentKey"
                class="cli-agent-row perm-row"
                :class="{ 'perm-overridden': cliPermissionMode(spec.agentKey) !== 'inherit' }"
              >
                <span class="cli-agent-label perm-name">{{ spec.label }}</span>
                <code class="perm-flag">{{ spec.skipPermissionFlag }}</code>
                <select
                  class="perm-select"
                  :value="cliPermissionMode(spec.agentKey)"
                  :aria-label="spec.label"
                  @change="onPermissionSelect(spec.agentKey, $event)"
                >
                  <option value="inherit">{{ $t('settings.cliPermission.mode-inherit') }}</option>
                  <option value="force-on">{{ $t('settings.cliPermission.mode-force-on') }}</option>
                  <option value="force-off">{{ $t('settings.cliPermission.mode-force-off') }}</option>
                </select>
              </li>
            </ul>
            <p v-if="!selectedPermissionRows.length" class="ap-hint">{{ $t('settings.cliPermission.flagless-note', { list: selectedCli.label }) }}</p>
            <p class="ap-hint">{{ $t('settings.cliPermission.restart-note') }}</p>
          </section>
          <section id="cli-panel-push" class="ap-section" data-settings-section="cli-agents-push">
            <h3 class="ap-title">{{ $t('settings.pushChannels.title') }}</h3>
            <p class="ap-hint">{{ $t('settings.pushChannels.hint') }}</p>
            <ul class="cli-agent-list">
              <li v-for="spec in selectedPushRows" :key="spec.agentKey" class="cli-agent-row">
                <label class="cli-agent-toggle">
                  <input
                    type="checkbox"
                    :checked="pushChannelEnabled(spec.agentKey)"
                    @change="togglePushChannel(spec.agentKey)"
                  />
                  <span class="cli-agent-label">{{ spec.label }}</span>
                </label>
                <span class="cli-agent-hint">{{ $t(`settings.pushChannels.cost-${spec.agentKey}`) }}</span>
              </li>
            </ul>
            <p v-if="!selectedPushRows.length" class="ap-hint">{{ $t('settings.cliAgents.no-push-channel') }}</p>
            <div v-if="allPushChannelsOff" class="push-all-off">
              <div class="push-all-off-title">{{ $t('settings.pushChannels.all-off-title') }}</div>
              <ul class="push-all-off-list">
                <li>{{ $t('settings.pushChannels.all-off-delivery') }}</li>
                <li>{{ $t('settings.pushChannels.all-off-rewake') }}</li>
                <li>{{ $t('settings.pushChannels.all-off-restart') }}</li>
              </ul>
            </div>
            <p class="ap-hint">{{ $t('settings.pushChannels.restart-note') }}</p>
          </section>
          <section id="cli-panel-install" class="ap-section" data-settings-section="cli-agents-maintenance">
            <CliManagementPanel
              v-if="activeTab === 'cliAgents'"
              ref="cliPanelRef"
              :agent-key="selectedCli.agentKey"
              :backend="props.backend"
              :onboarding="onboarding"
              :cli-profiles="cliProfilesApi"
              @login="(agentKey: string) => emit('cli-login', agentKey)"
              @install-open-change="cliInstallOpen = $event"
            />
          </section>
              </div>
            </section>
          </div>
          </Transition>
        </div>

        <!-- ══ GENERAL TAB ══ -->
        <div v-show="activeTab === 'general'" class="s-body appearance-body">
          <h1 class="s-page-title">{{ $t('settings.nav.general') }}</h1>

          <SettingsSection :label="$t('settings.section.general-behavior')">
            <SettingsCard>
              <SettingRow
                data-settings-section="general-confirm-close"
                :title="$t('confirm-close.setting-title')"
                :description="$t('confirm-close.setting-hint')"
              >
                <template #control>
                  <ToggleSwitch v-model="confirmBeforeCloseModel" :aria-label="$t('confirm-close.setting-label')" />
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-confirm-close-pane"
                :title="$t('settings.general.confirm-close-pane')"
                :description="$t('settings.general.confirm-close-pane-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="confirmBeforeClosePaneModel"
                    :aria-label="$t('settings.general.confirm-close-pane')"
                  />
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-confirm-close-workspace"
                :title="$t('settings.general.confirm-close-workspace')"
                :description="$t('settings.general.confirm-close-workspace-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="confirmBeforeCloseWorkspaceModel"
                    :aria-label="$t('settings.general.confirm-close-workspace')"
                  />
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-idle-reclaim"
                :title="$t('settings.general.idle-reclaim')"
                :description="$t('settings.general.idle-reclaim-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="idleReclaimEnabledModel"
                    :aria-label="$t('settings.general.idle-reclaim')"
                  />
                </template>
              </SettingRow>

              <SettingRow
                v-if="idleReclaimEnabledModel"
                data-settings-section="general-idle-reclaim-after"
                :title="$t('settings.general.idle-reclaim-after')"
                :description="$t('settings.general.idle-reclaim-after-hint')"
              >
                <template #control>
                  <select
                    :value="idleReclaimMinutesModel"
                    @change="onIdleReclaimMinutesChange(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="15">{{ $t('settings.general.idle-reclaim-15m') }}</option>
                    <option value="30">{{ $t('settings.general.idle-reclaim-30m') }}</option>
                    <option value="60">{{ $t('settings.general.idle-reclaim-1h') }}</option>
                    <option value="180">{{ $t('settings.general.idle-reclaim-3h') }}</option>
                    <option value="480">{{ $t('settings.general.idle-reclaim-8h') }}</option>
                    <option value="never">{{ $t('settings.general.idle-reclaim-never') }}</option>
                  </select>
                </template>
              </SettingRow>

              <SettingRow
                v-if="idleReclaimEnabledModel"
                data-settings-section="general-idle-reclaim-now"
                :title="$t('settings.general.idle-reclaim-now')"
                :description="reclaimNowCount > 0
                  ? $t('settings.general.idle-reclaim-now-hint', { count: reclaimNowCount, size: reclaimNowSize })
                  : $t('settings.general.idle-reclaim-now-empty')"
              >
                <template #control>
                  <button
                    class="reclaim-now-btn"
                    :disabled="reclaimNowCount === 0"
                    @click="emit('reclaim-now')"
                  >
                    {{ reclaimNowCount > 0
                      ? $t('settings.general.idle-reclaim-now-action', { count: reclaimNowCount })
                      : $t('settings.general.idle-reclaim-now-action-empty') }}
                  </button>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-resume-behavior"
                :title="$t('settings.appearance.resume-behavior')"
                :description="$t('settings.appearance.resume-behavior-hint')"
              >
                <template #control>
                  <select :value="resumeBehaviorModel" @change="onResumeBehaviorChange(($event.target as HTMLSelectElement).value)">
                    <option value="always">{{ $t('settings.appearance.resume-behavior-always') }}</option>
                    <option value="never">{{ $t('settings.appearance.resume-behavior-never') }}</option>
                    <option value="ask">{{ $t('settings.appearance.resume-behavior-ask') }}</option>
                  </select>
                </template>
              </SettingRow>

              <SettingRow
                v-if="resumeBehaviorModel === 'always'"
                data-settings-section="general-restore-scope"
                :title="$t('settings.appearance.restore-scope')"
                :description="$t('settings.appearance.restore-scope-hint')"
              >
                <template #control>
                  <select :value="restoreScopeModel" @change="onRestoreScopeChange(($event.target as HTMLSelectElement).value)">
                    <option value="single">{{ $t('settings.appearance.restore-scope-single') }}</option>
                    <option value="page">{{ $t('settings.appearance.restore-scope-page') }}</option>
                    <option value="tab">{{ $t('settings.appearance.restore-scope-tab') }}</option>
                    <option value="all">{{ $t('settings.appearance.restore-scope-all') }}</option>
                    <option value="auto">{{ $t('settings.appearance.restore-scope-auto') }}</option>
                  </select>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-auto-resume-reconnect"
                :title="$t('settings.general.auto-resume-reconnect')"
                :description="$t('settings.general.auto-resume-reconnect-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="autoResumeOnReconnectModel"
                    :aria-label="$t('settings.general.auto-resume-reconnect')"
                    @update:modelValue="onAutoResumeOnReconnectChange"
                  />
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-resume-interrupted-launch"
                :title="$t('settings.general.resume-interrupted-on-launch')"
                :description="$t('settings.general.resume-interrupted-on-launch-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="resumeInterruptedOnLaunchModel"
                    :aria-label="$t('settings.general.resume-interrupted-on-launch')"
                    @update:modelValue="onResumeInterruptedOnLaunchChange"
                  />
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-resume-concurrency"
                :title="$t('settings.appearance.resume-concurrency')"
                :description="$t('settings.appearance.resume-concurrency-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    :min="MIN_RESUME_CONCURRENCY"
                    :max="MAX_RESUME_CONCURRENCY"
                    :value="resumeConcurrencyModel"
                    @change="onResumeConcurrencyChange(($event.target as HTMLInputElement).value)"
                  />
                </template>
              </SettingRow>

              <RecentWorkspacesLimitRow :backend="props.backend" />

              <SettingRow
                data-settings-section="general-default-editor"
                :title="$t('settings.general.default-editor')"
                :description="$t('settings.general.default-editor-hint')"
              >
                <template #control>
                  <div class="row-g gap">
                    <span v-if="selectedEditorCommand" class="s-ctrl-label">{{ selectedEditorCommand }}</span>
                    <select :value="defaultEditorModel" @change="onDefaultEditorChange(($event.target as HTMLSelectElement).value)">
                      <option
                        value="mini-ide"
                        :disabled="miniIdeDisabled"
                        :title="miniIdeDisabled ? $t('settings.extensions.builtinDisabledTooltip', { name: 'Mini-IDE' }) : undefined"
                      >{{ $t('label.editor-mini-ide') }}</option>
                      <option value="system">{{ $t('label.editor-system') }}</option>
                      <option
                        v-for="id in DETECTABLE_EDITOR_IDS"
                        :key="id"
                        :value="id"
                        :disabled="!isEditorAvailable(id)"
                      >
                        {{ $t('label.editor-' + id) + (isEditorAvailable(id) ? '' : '（' + $t('settings.general.default-editor-not-installed') + '）') }}
                      </option>
                      <option value="custom">{{ $t('label.editor-custom') }}</option>
                    </select>
                    <button class="ap-reset" :disabled="detectingEditors" @click="loadDetectedEditors(true)">
                      {{ $t('settings.general.default-editor-redetect') }}
                    </button>
                  </div>
                </template>
              </SettingRow>

              <div v-if="defaultEditorModel === 'custom'" class="s-fullrow">
                <div class="row-g gap">
                  <span class="s-ctrl-label">{{ $t('settings.general.default-editor-custom-command') }}</span>
                  <input
                    type="text"
                    spellcheck="false"
                    :value="customEditorCommandText"
                    @change="onCustomEditorCommandChange(($event.target as HTMLInputElement).value)"
                  />
                  <select @change="onCustomEditorPresetChange($event.target as HTMLSelectElement)">
                    <option value="">{{ $t('settings.general.default-editor-preset') }}</option>
                    <option v-for="preset in CUSTOM_COMMAND_PRESETS" :key="preset.id" :value="preset.id">
                      {{ formatCustomCommand(preset.command) }}
                    </option>
                  </select>
                </div>
                <p class="ap-hint">{{ $t('settings.general.default-editor-custom-command-hint') }}</p>
                <!-- An empty template resolves back to the Mini-IDE at open
                     time, which would otherwise look like the setting was
                     ignored. -->
                <p v-if="customEditorCommand.length === 0" class="ap-hint ap-hint-warn">
                  {{ $t('settings.general.default-editor-custom-command-empty') }}
                </p>
              </div>

              <SettingRow
                data-settings-section="general-usage-badge"
                :title="$t('usage.settings-title')"
                :description="$t('usage.settings-hint')"
              >
                <template #control>
                  <div class="row-g gap">
                    <ToggleSwitch v-model="usageEnabledModel" @update:modelValue="onUsageEnabledChange" :aria-label="$t('usage.settings-enabled')" />
                    <span class="s-ctrl-label">{{ $t('usage.settings-refresh') }}</span>
                    <select
                      :value="usageRefreshModel"
                      @change="onUsageRefreshChange(($event.target as HTMLSelectElement).value)"
                    >
                      <option v-for="sec in USAGE_REFRESH_OPTIONS" :key="sec" :value="sec">
                        {{ `${sec / 60} min` }}
                      </option>
                    </select>
                  </div>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-quota-failover"
                :title="$t('usage.failover-title')"
                :description="$t('usage.failover-hint')"
              >
                <template #control>
                  <select
                    data-testid="quota-failover-mode"
                    :value="failoverMode"
                    :disabled="failoverBusy || !quotaFailover.state.value"
                    @change="onFailoverModeChange(($event.target as HTMLSelectElement).value)"
                  >
                    <option v-for="mode in FAILOVER_MODES" :key="mode" :value="mode">
                      {{ $t(`usage.failover-mode-${mode}`) }}
                    </option>
                  </select>
                </template>
              </SettingRow>
              <SettingRow
                data-settings-section="general-quota-failover-loop"
                :title="$t('usage.failover-loop-title')"
                :description="$t('usage.failover-loop-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="loopFailoverResumeModel"
                    data-testid="quota-failover-loop"
                    :disabled="failoverMode !== 'auto'"
                    :aria-label="$t('usage.failover-loop-title')"
                    @update:modelValue="onLoopFailoverResumeChange"
                  />
                </template>
              </SettingRow>
              <SettingRow
                data-settings-section="general-account-follow-switch"
                :title="$t('usage.follow-switch-title')"
                :description="$t('usage.follow-switch-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="accountFollowSwitchModel"
                    data-testid="account-follow-switch"
                    :aria-label="$t('usage.follow-switch-title')"
                    @update:modelValue="onAccountFollowSwitchChange"
                  />
                </template>
              </SettingRow>
              <div v-if="quotaFailover.state.value" class="failover-caps" data-settings-section="general-quota-failover-caps">
                <p v-if="quotaFailover.state.value.auditDegraded" class="failover-warn">
                  {{ $t('usage.failover-audit-degraded') }}
                </p>
                <table class="az-table failover-table">
                  <thead>
                    <tr>
                      <th>{{ $t('usage.failover-col-cli') }}</th>
                      <th>{{ $t('usage.failover-col-switch') }}</th>
                      <th>{{ $t('usage.failover-col-resume') }}</th>
                      <th>{{ $t('usage.failover-col-notes') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in failoverRows" :key="row.agentKey" :data-failover-agent="row.agentKey">
                      <td>{{ row.label }}</td>
                      <td>{{ $t(`usage.failover-switch-${row.switchMode}`) }}</td>
                      <td>{{ $t(`usage.failover-resume-${row.resume}`) }}</td>
                      <td class="failover-notes">
                        <span v-if="row.platformUnsupported" class="failover-tag">{{ $t('usage.failover-platform-unsupported') }}</span>
                        <span v-if="row.unverified" class="failover-tag">{{ $t('usage.failover-unverified') }}</span>
                        <span v-if="row.switchMode === 'unsupported' && row.todo" class="failover-todo">{{ row.todo }}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <SettingRow
                v-if="isDev"
                data-settings-section="general-antigravity-secrets"
                :title="$t('usage.settings-signing-title')"
                :description="$t('usage.settings-signing-hint')"
              >
                <template #control>
                  <div class="row-g gap">
                    <input
                      v-model="signingClientId"
                      type="text"
                      :placeholder="$t('usage.settings-signing-id')"
                      spellcheck="false"
                    />
                    <input
                      v-model="signingClientSecret"
                      type="password"
                      :placeholder="$t('usage.settings-signing-secret')"
                      spellcheck="false"
                    />
                    <button class="ap-reset" @click="saveSigningSecrets">
                      {{ $t('usage.settings-signing-save') }}
                    </button>
                    <span v-if="signingSaveStatus === 'saved'" class="s-ctrl-label">
                      {{ $t('usage.settings-signing-saved') }}
                    </span>
                    <span v-else-if="signingSaveStatus === 'error'" class="s-ctrl-label">
                      {{ $t('usage.settings-signing-error') }}
                    </span>
                  </div>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-environment"
                :title="$t('settings.appearance.environment')"
                :description="$t('settings.appearance.environment-hint')"
              >
                <template #control>
                  <button class="ap-reset" @click="emit('reopen-onboarding')">{{ $t('settings.appearance.rerun-env-check') }}</button>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-backend-timeout"
                :title="$t('settings.appearance.backend-timeout')"
                :description="$t('settings.appearance.backend-timeout-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    min="15"
                    max="120"
                    :value="healthCheckTimeoutSec"
                    @change="onHealthTimeoutChange(($event.target as HTMLInputElement).value)"
                  />
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>

          <ResourceLimitsSection :backend="backend" />

          <SettingsSection :label="$t('settings.section.settings-management')">
            <SettingsCard data-settings-section="settings-management">
              <SettingRow
                :title="$t('settings.management.title')"
                :description="$t('settings.management.bundle-hint')"
              >
                <template #control>
                  <div class="row-g gap">
                    <button class="ap-reset" :disabled="settingsBundleBusy" @click="exportSettingsBundle">{{ $t('settings.management.export-bundle') }}</button>
                    <button class="ap-reset" :disabled="settingsBundleBusy" @click="importSettingsBundle">{{ $t('settings.management.import-bundle') }}</button>
                  </div>
                </template>
              </SettingRow>
              <div class="s-fullrow">
                <div class="settings-meta-row inline">
                  <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
                  <span class="scope-badge">{{ scopeLabel(settingsScopeNotes.general.scope) }}</span>
                  <span class="settings-path" v-truncate>{{ pathForTab('general') }}</span>
                </div>
                <p v-if="settingsBundleSummary" class="summary-ok">{{ settingsBundleSummary }}</p>
                <p v-if="settingsBundleError" class="err-msg">{{ settingsBundleError }}</p>
              </div>
            </SettingsCard>
          </SettingsSection>
        </div>

        <!-- ══ CROSS-DEVICE TAB ══ -->
        <!-- Lifted out of General unchanged. It was two cards at the bottom
             of the longest page in this window, which is where somebody
             told "open the rules" went looking and did not find them. -->
        <div v-show="activeTab === 'cross-device'" class="s-body cross-device-body">
          <h1 class="s-page-title nvc-page-title">
            <span class="nvc-page-mark" aria-hidden="true"><NavideCloudMark /></span>
            {{ $t('settings.nav.crossDevice') }}
          </h1>
          <CloudSubtabs v-model="cloudSubtab" :enabled="cloudSubtabsShown" :tabs="cloudTabs">
          <template #sync>
          <SyncSettings v-show="cloudSubtab === 'sync'" :backend="props.backend" />
          <CloudInventorySection
            v-if="activeTab === 'cross-device' && cloudSubtabsShown"
            v-show="cloudSubtab === 'sync'"
            :backend="props.backend"
          />
          <SettingsSection v-show="cloudSubtab === 'sync'" :label="$t('settings.p2p.title')">
            <SettingsCard>
              <div class="s-fullrow" data-settings-section="general-p2p">
                <p class="ap-hint">{{ $t('settings.p2p.hint') }}</p>

                <!-- Read-only: signing in, pasting a token and signing out all
                     live in the titlebar's account modal, so the form is
                     maintained once. -->
                <p class="p2p-status">
                  <span class="p2p-dot" :class="p2pDotClass"></span>
                  <span>{{ $t('settings.p2p.state-' + p2pState) }}</span>
                </p>
                <!-- One line and a door. The four rows that used to be here —
                     email, address, detail, device id — are all shown in the
                     account window, which is where they can also be acted on. A
                     second read-only copy is a second thing to keep in sync and
                     a second place for the two to disagree. -->
                <p v-if="p2pStatus?.accountEmail" class="p2p-detail">
                  {{ $t('settings.p2p.account.email') }}: {{ p2pStatus.accountEmail }}
                </p>
                <p class="ap-hint p2p-titlebar-hint">{{ $t('settings.p2p.account.hint-titlebar') }}</p>
              </div>
            </SettingsCard>

            <!-- Only meaningful once a server is configured: with no server no
                 message can arrive from another device, and messages between
                 panes on this machine never consult this policy. -->
            <SettingsCard v-if="p2pState !== 'unconfigured'">
              <div class="s-fullrow" data-settings-section="general-p2p-policy">
                <h3 class="policy-title">{{ $t('settings.p2p.policy.title') }}</h3>
                <!-- Said once, above everything it disables: the state belongs
                     to the section rather than to any one button. -->
                <p v-if="p2pWaitReason" class="policy-readonly">
                  {{ p2pWaitReason }}
                  <span v-if="p2pLinkError" class="link-detail">{{ p2pLinkError }}</span>
                </p>
                <p class="ap-hint">{{ $t('settings.p2p.policy.hint') }}</p>
                <!-- Only when there are rules to qualify. With none, this and
                     the "no rules yet" line below said the same thing twice. -->
                <p v-if="policyDoc.rules.length" class="policy-deny">
                  {{ $t('settings.p2p.policy.default-deny') }}
                </p>
                <!-- One line, not two. "These rules live on the server" and
                     "the link is not connected" are the same fact told from two
                     sides, and stacked they read as two separate problems. -->
                <p v-if="!p2pPolicy?.editable && !p2pWaitReason" class="policy-readonly">
                  {{ $t('settings.p2p.policy.readonly') }}
                </p>

                <label class="policy-switch">
                  <input
                    type="checkbox"
                    :checked="policyAllowsOwnDevices"
                    :disabled="!policyEditable || !policyMemberId"
                    :title="p2pDisabledReason || undefined"
                    @change="toggleOwnDevices($event.target as HTMLInputElement)"
                  />
                  <span>
                    <span class="policy-switch-label">{{ $t('settings.p2p.policy.own-devices') }}</span>
                    <span class="ap-hint">{{ $t('settings.p2p.policy.own-devices-hint') }}</span>
                  </span>
                </label>

                <p class="policy-section-label">{{ $t('settings.p2p.policy.rules') }}</p>
                <p v-if="!policyDoc.rules.length" class="policy-empty">{{ $t('settings.p2p.policy.empty') }}</p>
                <!-- Two columns with a header. As one run of text separated by
                     a middle dot and an arrow, "who" and "what they may reach"
                     had to be parsed apart on every line. -->
                <ul v-else class="policy-rules">
                  <li class="policy-rule policy-rule-head">
                    <span class="policy-rule-from">{{ $t('settings.p2p.policy.col-source') }}</span>
                    <span class="policy-rule-to">{{ $t('settings.p2p.policy.col-target') }}</span>
                  </li>
                  <li v-for="(rule, index) in policyDoc.rules" :key="index" class="policy-rule">
                    <span class="policy-rule-from">
                      {{ policyMemberLabel(rule.from.memberId) }} · {{ policyDeviceLabel(rule.from.deviceId) }}
                    </span>
                    <span class="policy-rule-to">
                      <span :class="{ 'policy-any': isAnyField(rule.to.workspace) }">
                        {{ policyFieldLabel(rule.to.workspace) }}
                      </span>
                      /
                      <span :class="{ 'policy-any': isAnyField(rule.to.paneName) }">
                        {{ policyFieldLabel(rule.to.paneName) }}
                      </span>
                    </span>
                    <button class="ap-reset" :disabled="!policyEditable"
                    :title="p2pDisabledReason || undefined" @click="removeP2pPolicyRule(index)">
                      {{ $t('settings.p2p.policy.remove') }}
                    </button>
                  </li>
                </ul>

                <p class="policy-section-label">{{ $t('settings.p2p.policy.add-title') }}</p>
                <div class="policy-add">
                  <div class="field">
                    <label class="lbl" for="policy-member">{{ $t('settings.p2p.policy.source-member') }}</label>
                    <select id="policy-member" v-model="newRuleMemberScope" :disabled="!policyEditable || !policyMemberId"
                    :title="p2pDisabledReason || undefined">
                      <option value="mine">{{ $t('settings.p2p.policy.my-account') }}</option>
                      <option value="any">{{ $t('settings.p2p.policy.any-member') }}</option>
                    </select>
                  </div>
                  <div class="field">
                    <label class="lbl" for="policy-device">{{ $t('settings.p2p.policy.source-device') }}</label>
                    <select id="policy-device" v-model="newRuleDeviceId" :disabled="!policyEditable"
                    :title="p2pDisabledReason || undefined">
                      <option value="">{{ $t('settings.p2p.policy.any-device') }}</option>
                      <option v-for="device in policyDevices" :key="device.deviceId" :value="device.deviceId">
                        {{ device.deviceName || device.deviceId }}
                      </option>
                    </select>
                  </div>
                  <div class="field">
                    <label class="lbl" for="policy-workspace">{{ $t('settings.p2p.policy.target-workspace') }}</label>
                    <input
                      id="policy-workspace"
                      v-model="newRuleWorkspace"
                      type="text"
                      spellcheck="false"
                      autocomplete="off"
                      :disabled="!policyEditable"
                    :title="p2pDisabledReason || undefined"
                      :placeholder="$t('settings.p2p.policy.blank-is-any')"
                    />
                  </div>
                  <div class="field">
                    <label class="lbl" for="policy-pane">{{ $t('settings.p2p.policy.target-pane') }}</label>
                    <input
                      id="policy-pane"
                      v-model="newRulePaneName"
                      type="text"
                      spellcheck="false"
                      autocomplete="off"
                      :disabled="!policyEditable"
                    :title="p2pDisabledReason || undefined"
                      :placeholder="$t('settings.p2p.policy.blank-is-any')"
                    />
                  </div>
                </div>
                <div class="row-g gap p2p-actions">
                  <button class="ap-reset" :disabled="!policyEditable"
                    :title="p2pDisabledReason || undefined" @click="addP2pPolicyRule">
                    {{ $t('settings.p2p.policy.add') }}
                  </button>
                  <!-- There is no save button here — every change above writes
                       as you make it — so a warning that says "open the rules
                       and save" described an act this section does not have.
                       This is that act, on its own: the same document, a new
                       signature. -->
                  <!-- Secondary: this repairs a warning that appears rarely,
                       and sitting at the same weight as "add rule" made it look
                       like part of editing the rules. -->
                  <button class="policy-secondary" :disabled="!policyEditable"
                    :title="p2pDisabledReason || undefined" @click="resignP2pPolicy">
                    {{ $t('settings.p2p.policy.resign') }}
                  </button>
                </div>
                <p class="ap-hint">{{ $t('settings.p2p.policy.resign-hint') }}</p>
                <p v-if="p2pPolicyResigned" class="ap-hint">{{ $t('settings.p2p.policy.resigned') }}</p>
                <p v-if="p2pPolicyError" class="err-msg">{{ p2pPolicyError }}</p>
                <!-- What this page is actually agreeing to, on the page that
                     does it. The addresses come from the shared table through
                     preload; nothing here assembles a URL. -->
                <p class="legal-row">
                  <button class="legal-link" @click="openLegal('privacy')">{{ $t('settings.p2p.legal-privacy') }}</button>
                  <span aria-hidden="true">·</span>
                  <button class="legal-link" @click="openLegal('boundaries')">{{ $t('settings.p2p.legal-boundaries') }}</button>
                </p>
              </div>
            </SettingsCard>
          </SettingsSection>
          </template>
          <template #share>
            <ShareLinksPane :backend="props.backend" :source="shareProbe" />
          </template>
          <template #devices>
            <CloudDevicesSection :backend="props.backend" />
          </template>
          </CloudSubtabs>
        </div>

        <!-- ══ UPDATES TAB ══ -->
        <div v-show="activeTab === 'updates'" class="s-body updates-body">
          <h1 class="s-page-title">{{ $t('settings.nav.updates') }}</h1>

          <SettingsSection :label="$t('settings.section.updates')">
            <SettingsCard data-settings-section="updates">
              <SettingRow :title="$t('updater.section-title')" :description="$t('updater.section-hint')">
                <template #control>
                  <button class="ap-reset" :disabled="updIsBusy || updateState.status === 'unsupported'" @click="checkForUpdates">{{ $t('updater.check') }}</button>
                </template>
              </SettingRow>
              <div class="s-fullrow">
                <div class="settings-meta-row inline">
                  <span class="scope-badge">{{ $t('updater.current-version') }}</span>
                  <span class="settings-path" v-truncate>v{{ updateState.currentVersion }}</span>
                </div>

                <!-- Where the update actually is. Each stage below owns the
                     settings group of the same name. -->
                <ol v-if="updStages.length" class="upd-rail">
                  <li
                    v-for="(stage, stageIndex) in updStages"
                    :key="stage.id"
                    :class="['upd-stage', stage.state]"
                  >
                    <span class="upd-stage-mark" aria-hidden="true">
                      {{ stage.state === 'done' ? '✓' : stage.state === 'failed' ? '!' : stageIndex + 1 }}
                    </span>
                    <span class="upd-stage-label">{{ $t(`updater.stage.${stage.id}`) }}</span>
                    <span v-if="stage.percent !== undefined" class="upd-stage-pct">{{ stage.percent }}%</span>
                  </li>
                </ol>

                <p v-if="updateState.status === 'checking'" class="ap-hint">{{ $t('updater.checking') }}</p>
                <p v-else-if="updateState.status === 'not-available'" class="summary-ok">{{ $t('updater.up-to-date') }}</p>
                <p v-else-if="updateState.status === 'error'" class="err-msg">{{ $t('updater.error', { message: updateState.message }) }}</p>
                <p v-else-if="updateState.status === 'unsupported'" class="ap-hint">{{ $t('updater.unsupported') }}</p>

                <!-- Diagnostics: a run of failed background checks always shows
                     here. notifyOnCheckFailure only gates the status bar. -->
                <p v-if="updateState.lastCheckFailure" class="err-msg">
                  {{ $t('updater.check-failure', {
                    count: updateState.lastCheckFailure.count,
                    message: updateState.lastCheckFailure.message,
                  }) }}
                  {{ updateState.checkedAt
                    ? $t('updater.last-successful-check', { at: updLastSuccessfulCheck })
                    : $t('updater.last-successful-check-never') }}
                </p>

                <div v-if="['available', 'downloading', 'downloaded', 'installing'].includes(updateState.status)" class="upd-available">
                  <p class="summary-ok">{{ $t('updater.available', { version: updateState.availableVersion }) }}</p>
                  <p v-if="updateState.status === 'downloading'" class="ap-hint">{{ $t('updater.downloading', { percent: updateState.percent ?? 0 }) }}</p>
                  <p v-else-if="updateState.status === 'downloaded'" class="ap-hint">
                    {{ updateState.quitInstallArmed ? $t('updater.downloaded-on-quit') : $t('updater.downloaded') }}
                  </p>
                  <p v-else-if="updateState.status === 'installing'" class="ap-hint">{{ $t('updater.restarting') }}</p>
                  <div v-if="updateState.releaseNotes" class="upd-notes">
                    <div class="ap-hint">{{ $t('updater.release-notes') }}</div>
                    <pre class="upd-notes-body">{{ updateState.releaseNotes }}</pre>
                  </div>
                  <div class="row-g gap">
                    <button v-if="updateState.status === 'available'" class="ap-reset" @click="startDownload">{{ $t('updater.download') }}</button>
                    <button v-else-if="updateState.status === 'downloaded'" class="ap-reset" @click="installUpdate">{{ $t('updater.install') }}</button>
                  </div>
                </div>
              </div>
            </SettingsCard>
          </SettingsSection>

          <!-- One group per stage of the rail above: every setting sits under
               the step of the update it actually governs, instead of nine
               switches in one undifferentiated list. -->
          <SettingsSection :label="$t('updater.group.check')">
            <SettingsCard>
              <SettingRow :title="$t('updater.auto-check')" :description="$t('updater.auto-check-hint')">
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.autoCheck"
                    :aria-label="$t('updater.auto-check')"
                    @update:model-value="(v) => updUpdateSettings({ autoCheck: v })"
                  />
                </template>
              </SettingRow>
              <SettingRow :title="$t('updater.channel')" :description="$t('updater.channel-hint')">
                <template #control>
                  <select :value="updSettings.channel" @change="updUpdateSettings({ channel: ($event.target as HTMLSelectElement).value as UpdateChannel })">
                    <option value="stable">{{ $t('updater.channel-stable') }}</option>
                    <option value="beta" disabled>{{ $t('updater.channel-beta') }} — {{ $t('updater.channel-beta-unavailable') }}</option>
                  </select>
                </template>
              </SettingRow>
              <div v-if="updSettings.channel === 'beta'" class="s-fullrow">
                <p class="ap-hint">{{ $t('updater.beta-warning') }}</p>
              </div>
              <SettingRow
                :title="$t('updater.notify-check-failure')"
                :description="$t('updater.notify-check-failure-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.notifyOnCheckFailure"
                    :aria-label="$t('updater.notify-check-failure')"
                    @update:model-value="(v) => updUpdateSettings({ notifyOnCheckFailure: v })"
                  />
                </template>
              </SettingRow>
              <SettingRow
                v-if="updSettings.notifyOnCheckFailure"
                :title="$t('updater.check-failure-threshold')"
                :description="$t('updater.check-failure-threshold-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    :min="CHECK_FAILURE_THRESHOLD_RANGE.min"
                    :max="CHECK_FAILURE_THRESHOLD_RANGE.max"
                    :value="updSettings.checkFailureThreshold"
                    :aria-label="$t('updater.check-failure-threshold')"
                    @change="updUpdateSettings({ checkFailureThreshold: Number(($event.target as HTMLInputElement).value) })"
                  />
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection :label="$t('updater.group.download')">
            <SettingsCard>
              <SettingRow :title="$t('updater.auto-download')" :description="$t('updater.auto-download-hint')">
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.autoDownload"
                    :aria-label="$t('updater.auto-download')"
                    @update:model-value="(v) => updUpdateSettings({ autoDownload: v })"
                  />
                </template>
              </SettingRow>
              <SettingRow
                :title="$t('updater.retry-download')"
                :description="$t('updater.retry-download-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.retryDownload"
                    :aria-label="$t('updater.retry-download')"
                    @update:model-value="(v) => updUpdateSettings({ retryDownload: v })"
                  />
                </template>
              </SettingRow>
              <SettingRow
                v-if="updSettings.retryDownload"
                :title="$t('updater.download-retry-count')"
                :description="$t('updater.download-retry-count-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    :min="DOWNLOAD_RETRY_COUNT_RANGE.min"
                    :max="DOWNLOAD_RETRY_COUNT_RANGE.max"
                    :value="updSettings.downloadRetryCount"
                    :aria-label="$t('updater.download-retry-count')"
                    @change="updUpdateSettings({ downloadRetryCount: Number(($event.target as HTMLInputElement).value) })"
                  />
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection :label="$t('updater.group.install')">
            <SettingsCard>
              <SettingRow
                :title="$t('updater.auto-install')"
                :description="$t('updater.auto-install-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.autoInstallOnQuit"
                    :aria-label="$t('updater.auto-install')"
                    @update:model-value="(v) => updUpdateSettings({ autoInstallOnQuit: v })"
                  />
                </template>
              </SettingRow>
              <!-- Switching off cannot un-stage a payload the OS updater already
                   took, so say so rather than implying it was cancelled. -->
              <div v-if="!updSettings.autoInstallOnQuit && updateState.quitInstallArmed" class="s-fullrow">
                <p class="ap-hint">{{ $t('updater.auto-install-already-armed') }}</p>
              </div>
              <SettingRow
                :title="$t('updater.install-timeout')"
                :description="$t('updater.install-timeout-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    :min="INSTALL_TIMEOUT_SECONDS_RANGE.min"
                    :max="INSTALL_TIMEOUT_SECONDS_RANGE.max"
                    :value="updSettings.installTimeoutSeconds"
                    :aria-label="$t('updater.install-timeout')"
                    @change="updUpdateSettings({ installTimeoutSeconds: Number(($event.target as HTMLInputElement).value) })"
                  />
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>
        </div>

        <!-- ══ APPEARANCE TAB ══ -->
        <div v-show="activeTab === 'appearance'" class="s-body appearance-body">
          <h1 class="s-page-title">{{ $t('settings.nav.appearance') }}</h1>

          <SettingsSection :label="$t('settings.section.theme')">
            <div class="ap-section" data-settings-section="appearance-theme">
              <p class="ap-hint">{{ $t('settings.appearance.theme-hint') }}</p>
              <div class="ap-theme-grid">
                <button
                  v-for="t in BUILTIN_THEMES"
                  :key="t.id"
                  :class="['ap-theme-card', { active: currentTheme === t.id }]"
                  @click="setTheme(t.id)"
                >
                  <div class="ap-swatches">
                    <span
                      v-for="(c, i) in (THEME_SWATCHES[t.id] || [])"
                      :key="i"
                      class="ap-swatch"
                      :style="{ background: c }"
                    />
                  </div>
                  <span class="ap-theme-label">{{ t.label }}</span>
                  <span v-if="currentTheme === t.id" class="ap-check">✓</span>
                </button>
              </div>
            </div>

            <div class="ap-section" data-settings-section="appearance-theme">
              <div class="ap-section-head">
                <h3 class="ap-title">{{ $t('settings.appearance.custom-colors') }}</h3>
                <button
                  v-if="hasCustomOverrides"
                  class="ap-reset"
                  @click="resetCustom"
                  :title="$t('settings.appearance.reset-colors-hint')"
                >
                  {{ $t('settings.appearance.reset-to-defaults') }}
                </button>
              </div>
              <p class="ap-hint">{{ $t('settings.appearance.tweaks-hint') }}</p>
              <div class="ap-color-list">
                <label
                  v-for="tok in CUSTOMIZABLE_TOKENS"
                  :key="tok.id"
                  class="ap-color-row"
                >
                  <input
                    type="color"
                    class="ap-color-input"
                    :value="resolvedTokenValue(tok.id)"
                    @input="onPickColor(tok.id, ($event.target as HTMLInputElement).value)"
                  />
                  <span class="ap-color-name">{{ $t('settings.color.' + tok.id.slice(2)) }}</span>
                  <span class="ap-color-token">{{ tok.id }}</span>
                  <button
                    v-if="customOverrides[tok.id]"
                    class="ap-color-clear"
                    @click.prevent="setCustomOverride(tok.id, null)"
                    :title="$t('action.clear-color-override')"
                  >✕</button>
                </label>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection :label="$t('settings.section.other')">
            <SettingsCard>
              <SettingRow
                data-settings-section="appearance-ui-scale"
                :title="$t('settings.appearance.ui-scale')"
                :description="$t('settings.appearance.ui-scale-hint')"
              >
                <template #control>
                  <select :value="uiScaleModel" @change="onUiScaleChange(($event.target as HTMLSelectElement).value)">
                    <option v-for="step in UI_SCALE_STEPS" :key="step" :value="step">{{ formatUiScale(step) }}</option>
                  </select>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="appearance-runtime"
                :title="$t('settings.appearance.restore-windows')"
                :description="$t('settings.appearance.restore-windows-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="autoRestoreWindows"
                    :aria-label="$t('settings.appearance.restore-windows-label')"
                    @update:modelValue="onAutoRestoreChange"
                  />
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>

        </div>

        <!-- ══ LANGUAGE TAB ══ -->
        <div v-show="activeTab === 'language'" class="s-body appearance-body">
          <h1 class="s-page-title">{{ $t('settings.nav.language') }}</h1>

          <SettingsSection :label="$t('settings.section.language')">
            <SettingsCard>
              <SettingRow
                data-settings-section="appearance-language"
                :title="$t('settings.appearance.language')"
                :description="$t('settings.appearance.language-hint')"
              >
                <template #control>
                  <div class="ap-lang-row">
                    <button
                      v-for="lang in SUPPORTED_LANGUAGES"
                      :key="lang.value"
                      :class="['ap-lang-btn', { active: currentLanguage === lang.value }]"
                      @click="setLanguage(lang.value)"
                    >
                      {{ $t(lang.labelKey) }}
                      <span
                        v-if="lang.beta"
                        class="scope-badge"
                        :title="$t('settings.appearance.language-beta-hint')"
                      >{{ $t('settings.appearance.language-beta') }}</span>
                      <span v-if="currentLanguage === lang.value" class="ap-check">✓</span>
                    </button>
                  </div>
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>
        </div>

        <div v-show="activeTab === 'accounts'" class="s-body s-body--bleed accounts-body" data-settings-section="accounts">
          <h1 class="s-page-title">{{ $t('settings.nav.accounts') }}</h1>
          <div class="settings-meta-row">
            <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
            <span class="scope-badge">{{ scopeLabel(settingsScopeNotes.accounts.scope) }}</span>
            <span class="settings-path" v-truncate>{{ pathForTab('accounts') }}</span>
          </div>
          <GitAccountsPane :api="accountsApi" />
          <div data-settings-section="cli-accounts" style="margin: 4px 22px 22px; padding-top: 22px; border-top: 1px solid var(--border-default);">
            <CliAccountsPane :api="cliProfilesApi" :workspace-open="workspaceOpen ?? false" @login="(agentKey: string, loginProfileId?: string) => emit('cli-login', agentKey, loginProfileId)" />
          </div>
        </div>

        <!-- ── KEYBOARD SHORTCUTS TAB ────────────────────────────────────── -->
        <!-- ── HELP TAB (read-only reference: messaging + shortcuts) ─────── -->
        <!-- ── KEYBINDINGS TAB (editable; the Help tab keeps the read-only
             reference, which also covers xterm and native-menu keys that the
             central rule table does not own) ─────────────────────────────── -->
        <div v-show="activeTab === 'keybindings'" class="s-body keybindings-body" data-settings-section="keybindings">
          <h1 class="s-page-title">{{ $t('settings.nav.keybindings') }}</h1>
          <KeyboardShortcutsEditor v-if="activeTab === 'keybindings'" :initial-query="shortcutsQuery" />
        </div>

        <div v-show="activeTab === 'help'" class="s-body help-body" data-settings-section="help">
          <h1 class="s-page-title">{{ $t('settings.nav.help') }}</h1>
          <div class="help-topics" role="tablist">
            <button
              v-for="topic in helpTopicOrder"
              :key="topic"
              class="help-topic"
              :class="{ active: helpTopic === topic }"
              role="tab"
              :aria-selected="helpTopic === topic"
              @click="helpTopic = topic"
            >{{ $t(`settings.help.topic.${topic}`) }}</button>
          </div>
          <component :is="helpTopicComponents[helpTopic]" v-if="activeTab === 'help'" />
        </div>

        <!-- ── NAVIDE PLUGINS TAB ────────────────────────────────────────── -->
        <!-- Four pages under one sidebar entry: the plugins, the policy that
             decides what they may execute, developer and native settings, and
             the disclosure records. The scope badge sits on the policy page,
             because the policy is the part that is per user and per workspace. -->
        <div v-show="activeTab === 'extensions'" class="s-body s-body--bleed extensions-body" data-settings-section="extensions">
          <h1 class="s-page-title">{{ $t(pluginsPageLabel) }}</h1>
          <!-- In the icon-only sidebar the pages have no rows of their own there. -->
          <div class="ext-pages" role="tablist" :aria-label="$t('settings.nav.extensions')">
            <button
              v-for="page in pluginsPages"
              :key="page.id"
              type="button"
              role="tab"
              class="ext-pages-tab"
              :aria-selected="pluginsPage === page.id"
              @click="pluginsPage = page.id"
            >{{ $t(page.label) }}</button>
          </div>
          <div class="extensions-scroll">
            <section v-show="pluginsPage === 'policy'" class="ext-policy-block" data-settings-section="execution-policy">
              <div class="settings-meta-row inline">
                <span class="settings-meta-label">{{ $t('settings.scope.label') }}</span>
                <span class="scope-badge">{{ scopeLabel(executionPolicyScopeNote.scope) }}</span>
                <span class="settings-path" v-truncate>{{ pathForStorage(executionPolicyScopeNote.storage) }}</span>
              </div>
              <ExecutionPolicyPane :workspace-path="props.workspacePath" />
            </section>
            <ExtensionsPane
              v-show="pluginsPage === 'plugins' || pluginsPage === 'developer'"
              :page="pluginsPage === 'developer' ? 'developer' : 'plugins'"
              @open-disclosure-overview="openDisclosureOverview"
            />
            <!-- Plan B D5, D-f: records only, it changes nothing a Navide plugin may do. -->
            <section v-show="pluginsPage === 'disclosure'" class="ext-policy-block" data-settings-section="disclosureOverview">
              <PluginDisclosureOverview v-if="visitedDisclosureOverview" :paused="!disclosurePageShown" />
            </section>
          </div>
        </div>

        <!-- ── MARKETPLACE TAB ───────────────────────────────────────────── -->
        <div v-show="activeTab === 'marketplace'" class="s-body s-body--bleed marketplace-body" data-settings-section="marketplace">
          <h1 class="s-page-title">{{ $t('settings.nav.marketplace') }}</h1>
          <div class="marketplace-view-switch" role="tablist" :aria-label="$t('marketplace-developer.view.label')">
            <button
              role="tab"
              class="marketplace-view-tab"
              :class="{ 'marketplace-view-tab--active': marketplaceView === 'browse' }"
              :aria-selected="marketplaceView === 'browse'"
              @click="setMarketplaceView('browse')"
            >{{ $t('marketplace-developer.view.browse') }}</button>
            <button
              role="tab"
              class="marketplace-view-tab"
              :class="{ 'marketplace-view-tab--active': marketplaceView === 'developer' }"
              :aria-selected="marketplaceView === 'developer'"
              @click="setMarketplaceView('developer')"
            >{{ $t('marketplace-developer.view.developer') }}</button>
            <button
              role="tab"
              class="marketplace-view-tab"
              :class="{ 'marketplace-view-tab--active': marketplaceView === 'testplace' }"
              :aria-selected="marketplaceView === 'testplace'"
              @click="setMarketplaceView('testplace')"
            >{{ $t('testplace.view') }}</button>
          </div>
          <div class="marketplace-scroll">
            <MarketplacePane v-show="marketplaceView === 'browse'" />
            <MarketplaceDeveloperPanel v-if="marketplaceView === 'developer'" :backend="backend" />
            <TestplacePane v-if="marketplaceView === 'testplace'" />
          </div>
        </div>

        <!-- ── STATUS BADGES TAB ─────────────────────────────────────────── -->
        <div v-show="activeTab === 'statusBadges'" class="s-body status-badges-body" data-settings-section="statusBadges">
          <h1 class="s-page-title">{{ $t('settings.nav.statusBadges') }}</h1>
          <StatusBadgeSettingsPane />
        </div>

        <!-- ── LAYOUT TAB ────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'layout'" class="s-body layout-body" data-settings-section="layout">
          <h1 class="s-page-title">{{ $t('settings.nav.layout') }}</h1>
          <LayoutSettingsPane />
        </div>

        <div v-show="activeTab === 'channels'" class="s-body channels-body" data-settings-section="channels">
          <h1 class="s-page-title">{{ $t('channels.nav') }}</h1>
          <ChannelsPane v-if="activeTab === 'channels'" :backend="props.backend" />
        </div>

        <div v-show="activeTab === 'security'" class="s-body security-body" data-settings-section="security">
          <h1 class="s-page-title">{{ $t('guard.nav') }}</h1>
          <SecurityPane v-if="activeTab === 'security'" :backend="props.backend" />
        </div>

        <!-- ── VOICE TAB ─────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'voice'" class="s-body voice-body" data-settings-section="voice">
          <h1 class="s-page-title">{{ $t('settings.nav.voice') }}</h1>
          <VoiceSettingsSection :backend="backend" @open-shortcuts="openShortcutsFor" />
        </div>

        <!-- ── NOTIFICATIONS TAB ─────────────────────────────────────────── -->
        <div v-show="activeTab === 'notifications'" class="s-body notifications-body" data-settings-section="notifications">
          <h1 class="s-page-title">{{ $t('settings.nav.notifications') }}</h1>

          <SettingsSection :label="$t('settings.section.notifications')">
            <SettingsCard>
              <SettingRow
                data-settings-section="general-system-notify"
                :title="$t('settings.general.system-notify')"
                :description="$t('settings.general.system-notify-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="systemNotifyEnabledModel"
                    :aria-label="$t('settings.general.system-notify')"
                    @update:modelValue="onSystemNotifyEnabledChange"
                  />
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-notify-sound"
                :title="$t('settings.general.notify-sound')"
                :description="$t('settings.general.notify-sound-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="notifySoundEnabledModel"
                    :aria-label="$t('settings.general.notify-sound')"
                    @update:modelValue="onNotifySoundEnabledChange"
                  />
                </template>
              </SettingRow>

              <SettingRow
                v-if="notifyPermissionApplicable"
                data-settings-section="general-notify-permission"
                :title="$t('settings.general.notify-permission')"
                :description="$t(`settings.general.notify-permission-status.${notifyPermissionStatus}`) + ' ' + $t('settings.general.notify-permission-hint')"
              >
                <template #control>
                  <button
                    class="ap-reset"
                    :disabled="!!perms.requesting.value"
                    @click="sendTestNotification"
                  >{{ perms.requesting.value === 'notifications' ? $t('onboard.requesting') : $t('settings.general.notify-permission-test') }}</button>
                  <button class="ap-reset" @click="perms.openSettings('notifications')">{{ $t('onboard.open-settings') }}</button>
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>
        </div>

        </div>
        <!-- /.s-content -->

      </div>
    </div>

    <!-- Confirm dialogs -->
    <div v-if="false" class="s-overlay confirm">
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Overlay & modal shell ─────────────────────────────────────────────────── */
.s-overlay {
  position: fixed;
  inset: 0;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  z-index: calc(var(--z-modal) + 120);
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}
.s-overlay.confirm { z-index: calc(var(--z-modal) + 130); }

.s-modal {
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-lg);
  width: min(var(--modal-w-wide), 92vw);
  max-width: 1100px;
  height: 88vh;
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  overflow: hidden;
  box-shadow: var(--shadow-modal);
}

/* ── Sidebar ─────────────────────────────────────────────────────────────────  */
.s-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-inset);
  border-right: 1px solid var(--border-default);
  padding: var(--space-3, 12px) var(--space-2, 8px);
  gap: var(--space-2, 8px);
}
.s-ws-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px var(--space-row-x);
  min-width: 0;
}
.s-ws-avatar {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-selected);
  color: var(--accent-fg);
}
.s-ws-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
.s-ws-name {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Grouped nav ─────────────────────────────────────────────────────────────  */
.s-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
}
.s-nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 0;
}
.s-nav-group + .s-nav-group {
  border-top: 1px solid var(--border-muted);
}
.s-nav-group-title {
  padding: 4px var(--space-row-x) 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

/* ── Content pane ────────────────────────────────────────────────────────────  */
.s-content {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.s-search-box {
  position: relative;
  width: 100%;
}

/* Narrow viewport: collapse the sidebar to an icon-only rail so the content
   pane keeps its width. Labels stay accessible (visually hidden inside each
   nav item, with a title tooltip); grouping is preserved by the dividers. */
@media (max-width: 720px) {
  .s-modal {
    grid-template-columns: 56px minmax(0, 1fr);
  }
  .s-sidebar {
    padding: var(--space-2, 8px) 4px;
  }
  .s-ws-header {
    justify-content: center;
    padding: 4px 0;
  }
  .s-ws-meta { display: none; }
  .s-search-box { display: none; }
  .s-nav-group-title { display: none; }
}
.s-search-input {
  width: 100%;
  height: 30px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 0 10px;
}
.s-search-input:focus {
  outline: none;
  border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 2px var(--accent-focus);
}
.s-search-results {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: calc(var(--z-modal) + 131);
  width: min(420px, 78vw);
  max-height: min(420px, 64vh);
  overflow-y: auto;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: 0 16px 36px rgba(0,0,0,0.45);
  padding: 6px;
}
.s-search-result {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  border-radius: var(--radius-sm);
  padding: 8px 9px;
  cursor: pointer;
}
.s-search-result:hover,
.s-search-result:focus-visible {
  background: var(--bg-muted);
  outline: none;
}
/* The background above is the same one hover paints, so keyboard focus was
   indistinguishable from a mouse-over. Inset so the list's overflow cannot
   clip it. */
.s-search-result:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.s-search-result-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.s-search-result-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-search-result-group {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-muted);
}
.s-search-result-summary {
  display: block;
  margin-top: 3px;
  font-size: var(--font-2xs);
  line-height: 1.35;
  color: var(--text-secondary);
}
.s-search-empty {
  padding: 10px;
  font-size: 11.5px;
  color: var(--text-muted);
}

/* ── Appearance tab ─────────────────────────────────────────────────────────── */
.appearance-body { overflow-y: auto; padding: 18px 22px; }
.ap-section { margin-bottom: 26px; }
.ap-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ap-title { margin: 0 0 4px; font-size: var(--font-sm); font-weight: 600; color: var(--text-bright); }
.ap-hint { margin: 0 0 14px; font-size: 11.5px; color: var(--text-secondary); text-wrap: pretty; }
.ap-hint-warn { color: var(--danger-fg); }

/* ── Two-column settings layout (page title / full-width rows / control labels) ── */
.s-page-title {
  margin: 0 0 var(--space-group);
  font-size: var(--font-page-title);
  font-weight: 700;
  color: var(--text-bright);
}
/* The title already reserves --space-group below it; the section's own top
   margin would double the gap on the tabs that open with a SettingsSection. */
.s-page-title + .settings-section { margin-top: 0; }
.s-fullrow {
  padding: var(--space-row-y) var(--space-row-x);
}
.s-fullrow > :last-child { margin-bottom: 0; }
.s-ctrl-label { font-size: 11.5px; color: var(--text-secondary); }
/* Controls placed in a SettingRow #control slot: keep them compact and
   right-aligned instead of the full-width default used inside cards/fields. */
.setting-row-control select { width: auto; min-width: 120px; }
.setting-row-control input[type='number'] { width: 96px; }

/* CLI Agents cards and the selected agent's contained drawer. */
.cli-agent-roster { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 22px; }
.cli-agent-toolbar, .cli-agent-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.cli-agent-toolbar input { flex: 1; min-width: 130px; }
.cli-agent-toolbar button, .cli-agent-manage {
  border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  background: var(--bg-elevated); color: var(--text-primary); padding: 5px 9px; font: inherit; font-size: var(--font-xs); cursor: pointer;
}
.cli-agent-toolbar button[aria-pressed='true'] { color: var(--accent-fg); background: var(--accent-subtle); border-color: var(--accent-focus); }
.cli-agent-toolbar button:disabled { opacity: .4; cursor: default; }
.cli-agent-count { margin: 10px 0 14px; }
.cli-agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(210px, 100%), 1fr)); gap: 12px; list-style: none; padding: 0; margin: 0; }
.cli-agent-card { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 14px; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-elevated); cursor: pointer; }
.cli-agent-card:hover { border-color: var(--border-strong); }
.cli-agent-card.drag-over { box-shadow: inset 0 0 0 2px var(--accent-focus); }
.cli-agent-card.is-disabled { background: var(--bg-muted); }
.cli-agent-card.is-disabled .cli-card-heading { opacity: .6; }
/* Two lines tall either way, so a wrapped name does not push its card's
   status rows below the neighbours'. */
.cli-card-heading { display: flex; align-items: center; gap: 9px; min-width: 0; min-height: 38px; }
.cli-card-heading .cli-agent-label { overflow-wrap: anywhere; }
.cli-card-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 30px; border-radius: 8px; background: var(--bg-muted); color: var(--text-secondary); font-size: var(--font-xs); font-weight: 700; }
.cli-card-attention { margin-left: auto; color: var(--warning-fg, #c77400); font-weight: 700; }
.cli-card-status { display: flex; align-items: flex-start; flex-direction: column; gap: 4px; min-height: 42px; }
.cli-card-status .cli-chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; }
.cli-card-footer { display: flex; align-items: center; gap: 8px; margin-top: auto; font-size: var(--font-xs); }
.cli-agent-empty { color: var(--text-secondary); text-align: center; padding: 30px 10px; }
.cli-drawer-layer { position: absolute; inset: 0; z-index: 20; }
.cli-drawer-scrim { position: absolute; inset: 0; background: rgb(0 0 0 / .25); }
.cli-agent-drawer { position: absolute; inset: 0 0 0 auto; width: min(600px, 100%); display: flex; flex-direction: column; background: var(--bg-base); border-left: 1px solid var(--border-default); box-shadow: var(--shadow-modal); min-width: 0; }
.cli-drawer-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 20px 12px; }
.cli-drawer-header h2 { margin: 0; font-size: var(--font-lg); }
.cli-drawer-header p { margin: 3px 0 0; }
.cli-drawer-close { border: 0; background: none; color: var(--text-secondary); cursor: pointer; font-size: var(--font-md); padding: 4px 8px; }
.cli-drawer-content { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 20px; }
.cli-drawer-content .ap-section { margin: 0; }
.cli-drawer-content .ap-section + .ap-section { margin-top: 22px; padding-top: 22px; border-top: 1px solid var(--border-default); }
.cli-overview > .cli-agent-toggle { margin: 18px 0; }
.cli-agent-drawer .launch-body { padding: 12px; border-top: 0; }
.cli-agent-drawer .launch-field { align-items: flex-start; flex-direction: column; gap: 4px; }
.cli-agent-drawer .launch-field-label { flex: none; }
.cli-agent-drawer .launch-field .launch-input { width: 100%; box-sizing: border-box; }
.cli-agent-drawer .perm-row { flex-wrap: wrap; }
.cli-agent-drawer .perm-name { display: none; }
.cli-agent-drawer .perm-flag { flex-basis: 100%; }
.cli-agent-drawer .launch-env-table { table-layout: fixed; }
.cli-agent-drawer .launch-env-table td:last-child, .cli-agent-drawer .launch-env-table th:last-child { width: 62px; }
.cli-agent-drawer .launch-env-table .launch-input { width: 100%; box-sizing: border-box; }
.cli-agent-drawer .env-name { display: table-cell; overflow-wrap: anywhere; }
.cli-drawer-enter-active .cli-agent-drawer, .cli-drawer-leave-active .cli-agent-drawer { transition: transform .18s ease; }
.cli-drawer-enter-from .cli-agent-drawer, .cli-drawer-leave-to .cli-agent-drawer { transform: translateX(100%); }
@media (max-width: 960px) {
  .cli-agent-drawer { width: 100%; border-left: 0; }
  .cli-agent-roster { padding: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .cli-drawer-enter-active .cli-agent-drawer, .cli-drawer-leave-active .cli-agent-drawer { transition: none; }
}
.cli-agent-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.cli-agent-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-md);
  background: var(--bg-elevated);
}
.cli-agent-grip { color: var(--text-secondary); cursor: grab; user-select: none; font-size: var(--font-md); }
.cli-agent-toggle { display: flex; align-items: center; gap: 8px; flex: 1; cursor: pointer; margin: 0; }
.cli-agent-label { font-size: var(--font-sm); font-weight: 600; }
.cli-agent-hint { font-size: var(--font-2xs); color: var(--text-secondary); }
.cli-agent-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.cli-chip {
  font-size: var(--font-2xs); font-weight: 600; line-height: 1.6;
  padding: 0 8px; border-radius: 99px; white-space: nowrap;
  border: 1px solid var(--border-default); background: var(--bg-muted); color: var(--text-secondary);
}
.cli-chip--ok { color: var(--success-fg, #2b8a3e); border-color: transparent; }
.cli-chip--warn { color: var(--attention-fg, #c77400); border-color: transparent; }
.cli-chip--bad { color: var(--danger-fg, #c0392b); border-color: transparent; }
.cli-chip--info { color: var(--accent-fg, #3b5bdb); border-color: transparent; }
/* Launch overrides for the selected agent. */
.launch-row { flex-direction: column; align-items: stretch; padding: 0; }
.launch-row.launch-open { border-color: var(--accent-focus); }
.launch-body {
  display: flex; flex-direction: column; gap: 8px;
  padding: 4px 12px 12px 32px; border-top: 1px solid var(--border-default);
}
.launch-field { display: flex; align-items: center; gap: 10px; }
.launch-field-label { flex: 0 0 96px; font-size: var(--font-2xs); color: var(--text-secondary); }
.launch-input { flex: 1; min-width: 0; font-size: var(--font-2xs); }
.launch-note { margin: 0; }
.launch-error { margin: 0; font-size: var(--font-2xs); color: var(--danger-fg); }
.launch-warn {
  padding: 6px 10px; border-radius: var(--radius-md);
  border: 1px solid var(--border-default); border-left: 3px solid #c77400;
  background: var(--bg-muted); font-size: var(--font-2xs); color: var(--text-secondary);
}
.launch-warn p { margin: 0; }
.launch-warn p + p { margin-top: 5px; }
.launch-env-title { margin-top: 4px; font-size: var(--font-2xs); font-weight: 700; }
.launch-env-table { width: 100%; border-collapse: collapse; }
.launch-env-table th {
  font-size: var(--font-2xs); font-weight: 600; color: var(--text-secondary);
  text-align: left; padding: 0 6px 2px 0;
}
.launch-env-table td { padding: 2px 6px 2px 0; vertical-align: middle; }
.launch-env-table td:last-child, .launch-env-table th:last-child { width: 1%; padding-right: 0; }
.env-name { display: flex; align-items: center; gap: 6px; font-size: var(--font-2xs); }
.env-remove, .env-add {
  font-size: var(--font-2xs); padding: 2px 8px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-default); background: var(--bg-elevated);
  color: var(--text-secondary); cursor: pointer; white-space: nowrap;
}
.env-add:disabled { opacity: 0.45; cursor: default; }
/* Push channels: what switching every one of them off actually costs. */
.push-all-off {
  margin-top: 10px; padding: 10px 14px; border-radius: var(--radius-md);
  border: 1px solid var(--border-default); border-left: 3px solid #c77400;
  background: var(--bg-muted);
}
.push-all-off-title { font-size: var(--font-xs); font-weight: 700; margin-bottom: 4px; }
.push-all-off-list { margin: 0; padding-left: 1.2em; font-size: var(--font-2xs); color: var(--text-secondary); }
.push-all-off-list li { margin-bottom: 2px; }
/* Permission overrides: name | flag | mode picker, the flag column taking the
   slack so the pickers line up down the list. */
.perm-global { margin: 4px 0 10px; }
.perm-row { gap: 10px; }
.perm-name { flex: 0 0 96px; }
.perm-flag { flex: 1; min-width: 0; font-size: var(--font-2xs); color: var(--text-secondary); overflow-x: auto; white-space: nowrap; }
.perm-select { flex: 0 0 auto; font-size: var(--font-2xs); }
.perm-row.perm-overridden { border-color: var(--accent-focus); }
.ap-theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.ap-theme-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  text-align: left;
}
.ap-theme-card:hover { border-color: var(--border-strong); background: var(--bg-muted); }
.ap-theme-card.active { border-color: var(--accent-emphasis); box-shadow: 0 0 0 1px var(--accent-emphasis); }
.ap-swatches { display: flex; gap: 4px; }
.ap-swatch { width: 24px; height: 24px; border-radius: var(--radius-sm); border: 1px solid var(--border-muted); }
.ap-theme-label { font-size: var(--font-xs); font-weight: 500; color: var(--text-primary); }
.ap-check { position: absolute; top: 10px; right: 11px; font-size: var(--font-xs); color: var(--accent-fg); }
.ap-lang-row { display: flex; gap: 10px; flex-wrap: wrap; }
.ap-toggle-row { display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--text-primary); font-size: var(--font-sm); }
.ap-toggle-row input { cursor: pointer; }
.ap-lang-btn {
  position: relative;
  padding: 8px 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-size: var(--font-sm);
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.ap-lang-btn:hover { border-color: var(--border-strong); background: var(--bg-muted); }
.ap-lang-btn.active { border-color: var(--accent-emphasis); box-shadow: 0 0 0 1px var(--accent-emphasis); }
.ap-timeout-field { max-width: 140px; }
.ap-reset {
  font-size: var(--font-2xs);
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ap-reset:hover { color: var(--danger-fg); border-color: var(--danger-fg); }
.ap-color-list { display: flex; flex-direction: column; gap: 8px; }
.ap-color-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}
.ap-color-input {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}
.ap-color-name { font-size: var(--font-xs); color: var(--text-primary); min-width: 92px; }
.ap-color-token { font-size: 10.5px; color: var(--text-muted); font-family: var(--font-mono); flex: 1; }
.ap-color-clear {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-2xs);
}
.ap-color-clear:hover { color: var(--danger-fg); background: var(--bg-muted); }
.s-close {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 30;
  border: none;
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: var(--font-lg);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  line-height: 1;
}
.s-close:hover { background: var(--bg-muted); color: var(--text-bright); }

/* ── Tab body ─────────────────────────────────────────────────────────────── */
.s-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.cli-agents-body { position: relative; }
.updates-body { overflow-y: auto; padding: 18px 22px; }
/* Accounts tab stacks two tall blocks (git + CLI accounts); scroll the tab so
   neither squeezes the other to zero height inside the overflow-hidden s-body. */
.accounts-body { display: block; overflow-y: auto; }
/* A stack of region cards needs the gutter and its own scroll, which the bare
   .s-body (overflow:hidden, no padding) does not give. */
.layout-body { overflow-y: auto; padding: 18px 22px; }
.notifications-body { overflow-y: auto; padding: 18px 22px; }
.voice-body { overflow-y: auto; padding: 18px 22px; }
.channels-body { overflow-y: auto; padding: 18px 22px; }
.security-body { overflow-y: auto; padding: 18px 22px; }
/* Same reason: a scrolling list of status rows needs the gutter and its own
   scroll, which the bare .s-body does not give. */
.status-badges-body { overflow-y: auto; padding: 18px 22px; }
/* Same as the other padded tabs: without a modifier the bare .s-body is
   overflow:hidden with no gutter, which clips the shortcut list instead of
   scrolling it. */
.keybindings-body { overflow-y: auto; padding: 18px 22px; }
/* Full-bleed tabs (roles/pipelines/mcp/skills/analyzer/accounts/extensions) keep
   edge-to-edge bars and split panes, so their body cannot carry the page gutter.
   The page title carries it instead, matching the 18px/22px inset the padded tab
   bodies above apply to their whole content. */
.s-body--bleed > .s-page-title { padding: 18px 22px 0; flex-shrink: 0; }
/* The Extensions page stacks the execution-policy editor on top of the plugin
   inventory, so the page owns the one scrollbar and both panes inside it are
   plain blocks. Marketplace matches it so the two plugin pages scroll alike. */
.extensions-scroll,
.marketplace-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.marketplace-view-switch {
  display: flex;
  gap: var(--space-2);
  padding: 0 var(--space-5) var(--space-2);
}
.marketplace-view-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: var(--space-1, 4px) var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
}
.marketplace-view-tab--active {
  color: var(--text-bright);
  border-bottom-color: var(--accent-fg);
}
/* The Navide Plugins pages as a tab row, only where the sidebar is the
   icon-only rail and has no rows for them. */
.ext-pages {
  display: none;
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
  gap: 2px;
  padding: var(--space-2) 22px 0;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
@media (max-width: 720px) {
  .ext-pages { display: flex; }
}
.ext-pages-tab {
  flex: 0 0 auto;
  min-height: var(--control-h-lg);
  padding: 0 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  cursor: pointer;
}
.ext-pages-tab[aria-selected='true'] {
  border-bottom-color: var(--accent-emphasis);
  color: var(--text-bright);
  font-weight: 600;
}
.ext-pages-tab:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: -2px;
}
.extensions-scroll { padding-top: var(--space-4); }
.ext-policy-block > .settings-meta-row.inline { margin: 0 22px 14px; background: var(--bg-subtle); }
.settings-meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 22px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  min-width: 0;
  flex-shrink: 0;
}
.settings-meta-row.inline {
  padding: 7px 9px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  margin-top: 10px;
}
.settings-meta-label { flex-shrink: 0; color: var(--text-secondary); }
.scope-badge {
  flex-shrink: 0;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  padding: 2px 7px;
  color: var(--accent-fg);
  background: var(--bg-muted);
  font-weight: 600;
}
.settings-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
.settings-path-divider { color: var(--text-muted); }
.settings-path-btn {
  flex-shrink: 0;
  border: 1px solid var(--border-default);
  background: var(--bg-subtle);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 3px 7px;
  font-size: 10.5px;
  cursor: pointer;
}
.settings-path-btn:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--bg-muted);
}
/* Disabled drops the fill instead of fading, so the label stays readable. */
.settings-path-btn:disabled { opacity: 1; background: transparent; border-color: var(--border-muted); color: var(--text-secondary); cursor: not-allowed; }

button.tiny {
  padding: 3px 7px;
  font-size: 10.5px;
  line-height: 1.2;
}
.summary-ok { font-size: var(--font-2xs); color: var(--success-fg); margin-left: 6px; }

/* Update pipeline rail: check → download → install. The connector is drawn on
   each step except the first, so the row stays a plain flex list. */
.upd-rail {
  display: flex;
  align-items: center;
  gap: 0;
  list-style: none;
  margin: 12px 0 10px;
  padding: 0;
  flex-wrap: wrap;
}
.upd-stage {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-muted);
}
.upd-stage + .upd-stage::before {
  content: "";
  width: 26px;
  height: 1px;
  margin: 0 10px;
  background: var(--border-default);
}
.upd-stage-mark {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border-default);
  border-radius: 50%;
  font-size: var(--font-3xs);
  line-height: 1;
}
.upd-stage.active { color: var(--text-bright); }
.upd-stage.active .upd-stage-mark { border-color: var(--accent-emphasis); color: var(--accent-bright); }
.upd-stage.done .upd-stage-mark {
  border-color: var(--success-emphasis);
  background: var(--success-emphasis);
  color: var(--text-on-emphasis);
}
.upd-stage.failed { color: var(--danger-fg); }
.upd-stage.failed .upd-stage-mark { border-color: var(--danger-fg); color: var(--danger-fg); }
.upd-stage-pct { color: var(--text-bright); font-variant-numeric: tabular-nums; }

.upd-notes-body {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow: auto;
  margin: 4px 0 10px;
  padding: 8px 10px;
  font-size: 11.5px;
  font-family: inherit;
  background: var(--bg-subtle);
  border-radius: var(--radius-sm);
}

/* ── Fields ───────────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 4px; }
.lbl { font-size: var(--font-3xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
input[type='text'], input[type='email'], input[type='number'], input[type='password'], textarea, select {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 7px 9px;
  border-radius: var(--radius-xs);
  font-family: inherit;
  font-size: var(--font-xs);
  box-sizing: border-box;
  width: 100%;
}
textarea { font-family: var(--font-mono); resize: vertical; line-height: var(--lh-base); }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent-emphasis); }
input:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── List items ───────────────────────────────────────────────────────────── */
.row-g { display: flex; align-items: center; gap: 6px; }
.row-g.gap { gap: 8px; }
.badge { background: var(--bg-muted); color: var(--text-secondary); font-size: 9px; padding: 1px 5px; border-radius: var(--radius-xs); }

/* ── Buttons ──────────────────────────────────────────────────────────────── */
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 6px 12px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    opacity var(--motion-fast) var(--ease-out);
}
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: var(--success-emphasis); border-color: var(--success-strong); color: var(--text-on-emphasis); font-weight: 600; }
button.primary:not(:disabled):hover { background: var(--success-strong); }
button.danger { background: var(--danger-deep); border-color: var(--danger-muted); color: var(--text-on-emphasis); }
button.danger:hover { background: var(--danger-muted); }
button.ghost { background: transparent; }
button.ghost:hover:not(:disabled) { background: var(--bg-muted); }
/* The label carries a count, which must not wrap inside the row's control slot. */
.reclaim-now-btn { white-space: nowrap; }
/* The only button in this panel with no feedback of its own: the base rule
   above supplies its box, this supplies hover and press. */
.reclaim-now-btn:hover:not(:disabled) {
  background: var(--bg-hover-strong);
  border-color: var(--border-strong);
}
.reclaim-now-btn:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}

/* ── Messages ─────────────────────────────────────────────────────────────── */
.err-msg { color: var(--danger-fg); font-size: var(--font-2xs); margin: 0; }

/* Cross-device link */
/* Sign-in tabs. No width/box-sizing here on purpose: these panels have no
   border-box, so a width:100% would push the card past its grid track. */
.p2p-tab {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 6px 12px; font-size: var(--font-xs); color: var(--text-secondary); cursor: pointer;
}
.p2p-tab:hover:not(:disabled) { color: var(--text-bright); }
.p2p-tab.on { color: var(--text-bright); border-bottom-color: var(--accent-focus); font-weight: 500; }
.p2p-tab:disabled { opacity: 0.5; cursor: default; }
.p2p-actions { margin-top: 12px; }
.p2p-titlebar-hint { margin: 10px 0 0; }
.p2p-status { display: flex; align-items: center; margin: 12px 0 0; font-size: 11.5px; color: var(--text-bright); }
.p2p-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; flex-shrink: 0; }
.p2p-dot.ok { background: var(--success-fg); }
.p2p-dot.err { background: var(--danger-fg); }
.p2p-dot.warn { background: var(--attention-fg); }
.p2p-dot.idle { background: var(--text-secondary); }
.p2p-detail { margin: 4px 0 0; font-size: var(--font-2xs); color: var(--text-secondary); word-break: break-all; }

/* Cross-device authorization (pane policy) */
/* Same shape as the account window's footer: one muted row, no underline until
   hover. Two stacked lines with an underlined link read as a web page. */
/* The transport's own words, quieter than the sentence explaining them. */
.link-detail { display: block; margin-top: 2px; color: var(--text-secondary); word-break: break-word; }
/* Its own container class, with the same box the other tab bodies have. It
   borrowed the appearance tab's, which is a name that says nothing about this
   page and a rule anybody editing that tab would reasonably assume they
   owned. */
.cross-device-body { overflow-y: auto; padding: 18px 22px; }
/* Navide Cloud is the one settings page that names a product rather than a
   group of controls, so it is the one page title that carries the mark. */
.nvc-page-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.nvc-page-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  --nv-cloud-node-fill: var(--accent-subtle);
}
.nvc-page-mark :deep(.nv-cloud-mark) { width: 21px; height: 16px; }
.nvc-nav-mark { width: 17px; height: 13px; }
.legal-row {
  display: flex; align-items: center; gap: 6px;
  margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-muted);
  font-size: 12.5px; color: var(--text-secondary);
}
.legal-link {
  background: none; border: 0; padding: 0; cursor: pointer;
  font: inherit; color: var(--text-secondary); text-decoration: none;
}
.legal-link:hover { color: var(--text-primary); text-decoration: underline; }
.legal-link:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.policy-title { margin: 0 0 6px; font-size: 12.5px; color: var(--text-bright); }
.policy-deny { margin: 8px 0 0; font-size: var(--font-2xs); color: var(--attention-fg); }
.policy-readonly { margin: 6px 0 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.policy-switch { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; cursor: pointer; }
.policy-switch input { margin-top: 2px; flex-shrink: 0; }
.policy-switch-label { display: block; font-size: var(--font-xs); color: var(--text-bright); }
.policy-switch .ap-hint { margin: 2px 0 0; }
.policy-section-label { margin: 14px 0 6px; font-size: var(--font-2xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); }
.policy-empty { margin: 0; font-size: 11.5px; color: var(--text-secondary); }
.policy-rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.policy-rule { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-muted); }
.policy-rule-from, .policy-rule-to {
  flex: 1; min-width: 0; font-size: 11.5px; color: var(--text-bright);
  word-break: break-all;
}
/* The header is a row without the box: it labels the columns rather than
   claiming to be a rule. */
.policy-rule-head {
  border: 0; background: none; padding: 2px 8px;
  font-size: var(--font-3xs); text-transform: uppercase; letter-spacing: 0.06em;
}
.policy-rule-head span { color: var(--text-secondary); }
.policy-any { color: var(--text-secondary); }
/* Secondary: this repairs a rare warning, and at the same weight as "add rule"
   it looked like part of editing. */
.policy-secondary {
  background: none; border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: 11.5px; padding: 4px 10px; border-radius: var(--radius-control, 6px);
  cursor: pointer;
}
.policy-secondary:hover:not(:disabled) { color: var(--text-primary); }
.policy-secondary:disabled { opacity: 0.5; cursor: default; }
.policy-add { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.hint-msg { color: var(--text-secondary); font-size: var(--font-2xs); margin: 0; }

/* ── Appearance tab ─────────────────────────────────────────────────────────── */
.appearance-body { overflow-y: auto; }
.help-body { overflow-y: auto; padding: 18px 22px; }
.help-topics {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 18px;
  padding: 3px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  align-self: flex-start;
}
.help-topic {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 600;
  padding: 5px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.help-topic:hover { color: var(--text-primary); }
.help-topic.active {
  background: var(--bg-base);
  color: var(--text-bright);
  box-shadow: 0 1px 2px var(--shadow-overlay);
}

/* ── MCP tab ──────────────────────────────────────────────────────────────── */
/* Sits between the server list and External access inside the scrolling
   column, so it must not be squeezed the way a flexible item would be. The
   gutter lines it up with the <h1> and the scope band above it. */
.mcp-agent-pane { flex-shrink: 0; padding: 18px 22px 4px; }
.mcp-body { overflow-y: auto; display: flex; flex-direction: column; }

/* Top bar */
.mcp-topbar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 22px; border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0; background: var(--bg-inset);
}
.mcp-page-title { font-size: var(--font-sm); font-weight: 700; color: var(--text-bright); flex: 1; min-width: 0; }
.mcp-topbar-actions { display: flex; gap: 8px; }
.mcp-action-btn {
  font-size: var(--font-2xs); padding: 5px 11px; border-radius: var(--radius-sm);
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-bright); cursor: pointer;
}
.mcp-action-btn:hover:not(:disabled) { background: var(--border-default); }
.mcp-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.mcp-back-btn {
  font-size: var(--font-xs); padding: 4px 10px; border-radius: var(--radius-sm);
  background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary); cursor: pointer;
}
.mcp-back-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.mcp-summary-ok { font-size: var(--font-2xs); color: var(--success-fg); padding: 4px 22px; }
.mcp-conflict {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin: 8px 22px 0; padding: 7px 9px; border-left: 3px solid var(--attention-fg);
  background: color-mix(in srgb, var(--attention-fg) 8%, var(--bg-subtle));
  color: var(--attention-fg); font-size: var(--font-2xs);
}

.mcp-empty { color: var(--text-muted); font-size: var(--font-xs); padding: 24px 0; text-align: center; }

/* Server card */

/* Main row: dot + name + trash + toggle */

/* Status dot */

/* Delete button */

/* Tools row */

/* Tool list */

.mcp-custom-form select {
  padding: 6px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  background: var(--bg-base); color: var(--text-primary);
}

/* Env vars editor */

/* Catalog view */
.mcp-search-wrap {
  position: relative; padding: 12px 16px; border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.mcp-search {
  width: 100%; padding: 8px 36px 8px 12px; border-radius: var(--radius-md);
  background: var(--bg-subtle); border: 1px solid var(--border-default); color: var(--text-bright);
  font-size: var(--font-xs); box-sizing: border-box;
}
.mcp-search:focus { outline: none; border-color: var(--accent-emphasis); }
.mcp-search-icon {
  position: absolute; right: 28px; top: 50%; transform: translateY(-50%);
  font-size: var(--font-sm); color: var(--text-muted); pointer-events: none;
}

.mcp-catalog-hint {
  padding: 8px 16px; font-size: var(--font-2xs); color: var(--text-secondary); line-height: 1.6;
  background: var(--bg-base); border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.mcp-catalog-hint strong { color: var(--text-bright); }
.mcp-catalog-list {
  padding: 10px 16px; display: flex; flex-direction: column; gap: 1px; overflow-y: auto; flex: 1;
}
.mcp-catalog-card {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 2px; border-bottom: 1px solid var(--border-muted);
}
.mcp-catalog-card:last-child { border-bottom: none; }
.mcp-catalog-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.mcp-catalog-name { font-size: var(--font-sm); font-weight: 700; color: var(--text-bright); }
.mcp-catalog-desc { font-size: var(--font-2xs); color: var(--text-secondary); line-height: var(--lh-base); }
.mcp-catalog-note { font-size: var(--font-3xs); color: var(--attention-fg); margin-top: 2px; }
.mcp-add-btn {
  font-size: var(--font-2xs); padding: 6px 14px; border-radius: var(--radius-sm); white-space: nowrap; flex-shrink: 0;
  background: var(--accent-emphasis); border: 1px solid var(--accent-focus); color: var(--text-on-emphasis); font-weight: 600; cursor: pointer;
}
.mcp-add-btn:hover:not(:disabled) { background: var(--accent-focus); }
.mcp-add-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mcp-installed-badge {
  font-size: var(--font-2xs); padding: 6px 14px; border-radius: var(--radius-sm); white-space: nowrap; flex-shrink: 0;
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-muted); cursor: not-allowed;
}
.mcp-custom-form {
  width: min(520px, calc(100% - 32px)); margin: 16px; padding: 14px;
  display: flex; flex-direction: column; gap: 12px;
  border: 1px solid var(--border-default); border-radius: var(--radius-card); background: var(--bg-subtle);
}
.mcp-custom-form > p { margin: 0; color: var(--text-secondary); font-size: var(--font-2xs); line-height: var(--lh-base); }
.mcp-custom-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* External access / CDP debug section */
.ea-section-wrap { flex-shrink: 0; padding: 0 22px 18px; }
.ea-warning { margin: 0; padding: 0 var(--space-row-x) 10px; font-size: var(--font-2xs); color: var(--attention-fg); }
.ea-section-wrap .err-msg { padding: 0 var(--space-row-x) 10px; }
.ea-connection { padding: 0 var(--space-row-x) 12px; }
.ea-connection input[readonly] { width: 100%; font-size: var(--font-2xs); }

/* ── Analyzer tab ─────────────────────────────────────────────────────────── */
.analyzer-body { display: flex; flex-direction: column; gap: 0; overflow-y: auto; padding: 0; }

.az-section {
  padding: 14px 22px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.az-section-title { font-size: var(--font-2xs); font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
.az-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.az-section-header .az-section-title { margin-bottom: 0; }
.az-section-note { font-size: var(--font-3xs); color: var(--text-muted); }
.az-subsection { margin-top: 12px; }
.az-status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
.az-status-dot.ok { background: var(--success-fg); }
.az-status-dot.err { background: var(--danger-fg); }
.az-pct { font-weight: 600; color: var(--text-bright); margin-left: 6px; }
.az-size-info { color: var(--text-muted); font-size: var(--font-2xs); margin-left: 4px; }
.az-gguf-hint { font-size: var(--font-2xs); color: var(--text-muted); margin-top: 6px; line-height: var(--lh-base); }
.az-gguf-hint :deep(code) { background: var(--bg-subtle); padding: 1px 4px; border-radius: var(--radius-xs); color: var(--text-bright); }
.az-gguf-hint :deep(.az-link) { color: var(--accent-fg); text-decoration: none; }
.az-gguf-hint :deep(.az-link:hover) { text-decoration: underline; }
.az-code { background: var(--bg-subtle); padding: 1px 5px; border-radius: var(--radius-xs); font-size: var(--font-2xs); color: var(--text-bright); font-family: var(--font-mono); }
.az-url-row { display: flex; gap: 6px; align-items: center; }
.az-url-row .az-input { flex: 1; }
.az-recheck-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: var(--font-md); padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer;
  flex-shrink: 0; transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.az-recheck-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.az-recheck-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.az-detect-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: var(--font-2xs); font-weight: 500; padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer;
  flex-shrink: 0; white-space: nowrap; transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.az-detect-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.az-detect-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.az-browse-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: var(--font-sm); padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer;
  flex-shrink: 0; transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.az-browse-btn:hover { background: var(--border-default); color: var(--text-bright); }

.az-backend-toggle { display: flex; gap: 0; border: 1px solid var(--border-default); border-radius: var(--radius-sm); overflow: hidden; width: fit-content; }
.az-backend-btn {
  background: var(--bg-subtle); border: none; color: var(--text-secondary); font-size: var(--font-xs);
  padding: 6px 16px; cursor: pointer; transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.az-backend-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.az-backend-btn.active { background: var(--accent-emphasis); color: var(--text-on-emphasis); font-weight: 600; }

.az-label { display: block; font-size: var(--font-2xs); color: var(--text-secondary); margin-bottom: 5px; }
.az-hint-inline { color: var(--text-muted); font-style: italic; }
.az-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-base); border: 1px solid var(--border-default); color: var(--text-bright);
  font-size: var(--font-xs); padding: 7px 10px; border-radius: var(--radius-sm);
  outline: none; transition: border-color var(--motion-fast) var(--ease-out);
}
.az-input:focus { border-color: var(--accent-focus); }
.az-status-row { margin-top: 8px; }

.az-pull-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.az-pull-input { flex: 1; margin-bottom: 0; }
/* Secondary on purpose: "run benchmark" is the page's one primary action. */
.az-pull-btn { font-size: var(--font-xs); font-weight: 600; padding: 7px 16px; }
.az-pull-error { font-size: var(--font-2xs); color: var(--danger-fg); margin-top: 6px; }

.az-progress-bar-wrap {
  height: 4px; background: var(--bg-muted); border-radius: var(--radius-xs); margin-top: 6px; overflow: hidden;
}
.az-progress-bar { height: 100%; background: var(--accent-emphasis); border-radius: var(--radius-xs); transition: width var(--motion-base) var(--ease-out); }

.az-model-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.az-no-models { font-size: var(--font-xs); color: var(--text-muted); padding: 8px 0; }
.az-model-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px; background: var(--bg-base); border: 1px solid var(--border-muted); border-radius: var(--radius-sm);
}
.az-model-info { display: flex; flex-direction: column; gap: 2px; }
.az-model-name { font-size: var(--font-xs); color: var(--text-bright); font-family: var(--font-mono); }
.az-model-meta { font-size: var(--font-3xs); color: var(--text-secondary); }
.az-del-btn {
  background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: var(--font-xs);
  padding: 2px 6px; border-radius: var(--radius-xs); transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.az-del-btn:hover { color: var(--danger-fg); background: var(--bg-muted); }

.az-benchmark-section { flex-shrink: 0; display: flex; flex-direction: column; gap: 0; }

.az-version { font-size: var(--font-2xs); color: var(--text-secondary); }
.az-version.offline { color: var(--danger-fg); }
.az-run-btn {
  background: var(--accent-emphasis);
  border: 1px solid var(--accent-focus);
  color: var(--text-on-emphasis);
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out);
}
.az-run-btn:hover:not(:disabled) { background: var(--accent-focus); }
.az-run-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.az-progress-wrap {
  padding: 10px 20px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-base);
  flex-shrink: 0;
}
.az-progress-label { font-size: var(--font-xs); color: var(--text-secondary); display: flex; align-items: center; gap: 8px; }
.az-spin {
  display: inline-block;
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border: 1.5px solid var(--border-default);
  border-top-color: var(--accent-fg);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@media (prefers-reduced-motion: reduce) { .az-spin { animation: none; } }
@keyframes spin { to { transform: rotate(360deg); } }

/* No side padding: the hint lines up with its section title above it. */
.az-hint {
  padding: 8px 0 4px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.7;
}
.az-hint p { margin: 0 0 10px; }
.az-hint ul { margin: 0 0 10px; padding-left: 18px; }
.az-hint li { margin-bottom: 4px; }
.az-hint code { background: var(--bg-subtle); padding: 1px 5px; border-radius: var(--radius-xs); font-size: var(--font-2xs); color: var(--text-bright); }
.az-pass-rule { color: var(--text-secondary); font-size: var(--font-2xs); }

.az-results { padding: 16px 20px; flex: 1; overflow-y: auto; min-height: 0; }
.az-results-summary {
  font-size: var(--font-xs);
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.az-results-summary strong { color: var(--success-fg); }

.az-table { width: 100%; border-collapse: collapse; font-size: var(--font-xs); }
.az-table th {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-muted);
  color: var(--text-secondary);
  font-weight: 500;
  white-space: nowrap;
}
.az-th-task, .az-th-score, .az-th-verdict { text-align: center; }
.az-table td { padding: 8px 10px; border-bottom: 1px solid var(--bg-subtle); vertical-align: middle; }
.az-td-model { font-family: var(--font-mono); font-size: var(--font-2xs); color: var(--text-bright); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.az-td-task { text-align: center; white-space: nowrap; }
.az-td-score { text-align: center; color: var(--text-secondary); }
.az-td-verdict { text-align: center; }
.az-elapsed { font-size: var(--font-3xs); color: var(--text-secondary); margin-left: 3px; }
.az-pass,
.az-fail { display: inline-flex; vertical-align: -2px; }
.az-pass { color: var(--success-fg); }
.az-fail { color: var(--danger-fg); }
.az-na { color: var(--text-disabled); }
.failover-caps { padding: 0 var(--space-row-x) var(--space-row-y); }
.failover-table td { font-size: var(--font-2xs); }
.failover-notes { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.failover-tag {
  font-size: var(--font-3xs);
  border-radius: 99px;
  padding: 0 6px;
  background: var(--bg-hover);
  color: var(--text-muted);
  white-space: nowrap;
}
.failover-todo { font-size: var(--font-3xs); color: var(--text-muted); }
.failover-warn { margin: 0 0 6px; font-size: var(--font-2xs); color: var(--attention-fg); }
.az-row-fail td { color: var(--text-secondary); }
.az-row-fail .az-td-model { color: var(--text-muted); }
.az-badge-pass {
  background: color-mix(in srgb, var(--success-fg) 15%, transparent);
  color: var(--success-fg);
  border: 1px solid color-mix(in srgb, var(--success-fg) 30%, transparent);
  padding: 2px 8px;
  border-radius: var(--radius-md);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.az-badge-fail {
  background: color-mix(in srgb, var(--danger-fg) 10%, transparent);
  color: var(--text-muted);
  border: 1px solid var(--border-muted);
  padding: 2px 8px;
  border-radius: var(--radius-md);
  font-size: var(--font-2xs);
}

/* ── Convergence layer ──────────────────────────────────────────────────────
   Appended last on purpose: these rules carry the same specificity as the
   individual declarations above, so source order decides the tie in their
   favour. Only colour / type / border are unified here — every rule above
   keeps its own margins, padding and layout. */

/* Helper text under a control: one spec, many legacy names. */
.ap-hint,
.az-hint,
.az-hint-inline,
.az-gguf-hint,
.az-section-note,
.cli-agent-hint,
.help-topic,
.hint-msg,
.mcp-catalog-desc,
.mcp-catalog-hint,
.mcp-catalog-note,
.upd-notes {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}

/* Native form controls inside the settings body get the house skin. Scoped to
   .s-body so the sidebar search field and anything outside the tab bodies is
   untouched; more specific existing rules still win on width/padding. */
.s-body input[type='text'],
.s-body input[type='number'],
.s-body input[type='password'],
.s-body input[type='search'],
.s-body select {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--font-sm);
  line-height: var(--lh-base);
  padding: 5px 8px;
  transition: border-color var(--motion-fast) var(--ease-out);
}
.s-body input[type='text']:hover:not(:disabled),
.s-body input[type='number']:hover:not(:disabled),
.s-body input[type='password']:hover:not(:disabled),
.s-body input[type='search']:hover:not(:disabled),
.s-body select:hover:not(:disabled) {
  border-color: var(--border-strong);
}
.s-body input[type='text']:focus,
.s-body input[type='number']:focus,
.s-body input[type='password']:focus,
.s-body input[type='search']:focus,
.s-body select:focus {
  outline: none;
  border-color: var(--accent-focus);
}
.s-body input[type='text']:disabled,
.s-body input[type='number']:disabled,
.s-body input[type='password']:disabled,
.s-body input[type='search']:disabled,
.s-body select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.s-body select {
  cursor: pointer;
}

/* Final visual pass: keep the dense settings surface calm while making every
   interactive control reveal its state consistently. These rules only skin
   existing controls; they do not alter their layout or behavior. */
.s-modal {
  border-color: var(--border-default);
  background: var(--bg-base);
}
.s-sidebar {
  background: var(--bg-inset);
}
.s-nav-group-title { color: var(--text-secondary); }
.s-search-input:hover:not(:disabled) { border-color: var(--border-strong); }
.s-search-input:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 1px; }
.s-search-result:active { background: var(--accent-subtle); }
.s-close:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.s-body button:focus-visible,
.s-body a:focus-visible,
.s-body input:focus-visible,
.s-body textarea:focus-visible,
.s-body select:focus-visible {
  outline: 2px solid var(--accent-fg);
  outline-offset: 2px;
}
.ap-theme-card:focus-visible,
.ap-lang-btn:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.ap-theme-card.active,
.ap-lang-btn.active { background: var(--accent-subtle); }
.settings-meta-row { color: var(--text-secondary); }
</style>
