<script setup lang="ts">
// Extensions inventory: the bundled packages and the installed plugins, with
// their trust/capability badges. Browsing and installing live on the separate
// Marketplace page; the execution policy that governs what any of them may run
// is the editable block above this pane on the same settings page.
//
// All privileged work is brokered through the main process via
// `window.agentTeam.plugins`; this component holds no secrets and never touches
// package bytes.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { revealInvisibleValue as reveal } from '../../../shared/pluginAgentTools'
import type {
  ManifestPermissionsSummary,
  PackageVersionGrantSummary,
} from '../../../shared/executionPolicy'
import { usePluginInventory } from '../composables/usePluginInventory'
import { usePluginUpdates } from '../composables/usePluginUpdates'
import { askUninstall, ipcErrorMessage, removeWithAnswer, usePluginInstallFlow } from '../composables/usePluginInstallFlow'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import PluginTrustDialog from './PluginTrustDialog.vue'
import PluginActivityPanel from './PluginActivityPanel.vue'
import PluginBackgroundAiSessions from './PluginBackgroundAiSessions.vue'
import PackUninstallDialog from './PackUninstallDialog.vue'
import NativeBackendPanel from './NativeBackendPanel.vue'
import SettingsCard from './settings/SettingsCard.vue'
import SettingRow from './settings/SettingRow.vue'
import ToggleSwitch from './settings/ToggleSwitch.vue'
import MarketplaceIcon from './MarketplaceIcon.vue'
import { localizeDeveloperModeError } from '../lib/developerModeErrors'
import PluginSourceBadge from './PluginSourceBadge.vue'
import DeveloperFolderInfoCard from './DeveloperFolderInfoCard.vue'
import { chromeSourceMark, isTestplaceExpired, pluginSourceLabel, testplaceDaysLeft } from '../lib/pluginSourceMark'
import { cardRiskLevel } from '../../../shared/pluginDisclosureScan'
import { disclosureClauses } from '../lib/disclosureText'
import { leadSentence } from '../lib/leadSentence'
import type { ManifestDisclosure } from '../../../shared/pluginDisclosure'
import type { DisclosureRiskLevel } from '../../../shared/pluginDisclosure'

const { t, locale } = useI18n()

function pluginsApi() {
  return window.agentTeam?.plugins
}

// One inventory for both plugin pages: an install committed on Marketplace has
// to show up in the list below without this pane being remounted.
const { installed, factoryPackages, refresh: refreshInstalled } = usePluginInventory()
const factoryRows = computed(() => factoryPackages.value.map((factoryPackage) => ({
  ...factoryPackage,
  installed: installed.value.find((plugin) => plugin.id === factoryPackage.id) ?? null,
})))
const nonFactoryInstalled = computed(() =>
  installed.value.filter((plugin) => plugin.provenance !== 'factory-bundled')
)
// The package whose card the detail side shows: the user's pick while it is
// still listed, otherwise the first installed package, then the first bundled.
const selectedChoice = ref<string | null>(null)
const selectableIds = computed(() => [
  ...packs.value.map((pack) => `pack:${pack.id}`),
  ...nonFactoryInstalled.value.map((plugin) => plugin.id),
  ...factoryRows.value.map((row) => row.id),
])
const selectedId = computed(() =>
  selectedChoice.value && selectableIds.value.includes(selectedChoice.value)
    ? selectedChoice.value
    : selectableIds.value[0] ?? null
)
// Each Registry package's risk level from its installed disclosure, for the
// list row; the full disclosure is in the selected card and the overview below.
// The Plans risk note leads with its first sentence in bold; every word stays.
const plansRiskNote = computed(() => leadSentence(t('settings.extensions.plansRiskNote')))
const riskById = ref(new Map<string, DisclosureRiskLevel>())
// What it declares, in the disclosure's own clauses: the card's one-line reason
// for its risk level. The full record is on the Disclosure page.
const disclosureById = ref(new Map<string, ManifestDisclosure>())
async function refreshRiskLevels(): Promise<void> {
  try {
    const records = (await pluginsApi()?.installedDisclosures?.()) ?? []
    riskById.value = new Map(records.flatMap((record) =>
      record.disclosure ? [[record.id, cardRiskLevel(record.disclosure, record.scan)] as const] : []
    ))
    disclosureById.value = new Map(records.flatMap((record) => (record.disclosure ? [[record.id, record.disclosure] as const] : [])))
  } catch {
    riskById.value = new Map()
    disclosureById.value = new Map()
  }
}
function riskClauses(id: string): string[] {
  const disclosure = disclosureById.value.get(id)
  return disclosure ? disclosureClauses(t, locale.value, disclosure) : []
}
function riskReason(id: string): string {
  return riskClauses(id).join(' · ')
}
// The warnings a package's card carries, in the card's own words, for the
// list row's "⚠ N" marker: what the card discloses is visible without a click.
type InstalledRow = (typeof nonFactoryInstalled.value)[number]
function installedWarnings(p: InstalledRow): string[] {
  const out: string[] = []
  if (p.digestBlock) out.push(t(`settings.extensions.digestBlock.${digestBlockKey(p.digestBlock.reason)}`))
  if (p.sensitive.length) {
    out.push(t('settings.extensionsPolicy.labeledValue', { label: t('settings.extensions.sensitive'), value: p.sensitive.join(', ') }))
  }
  if (!p.pendingCandidateVersion && updatesById.value.get(p.id)?.permissionChange === 'more') out.push(t('pluginDisclosure.diff.badgeMore'))
  if (p.engineCompatible === false) out.push(t('settings.extensions.incompatibleInstalled', { version: p.minNavideVersion ?? '' }))
  if (p.source === 'testplace' && isTestplaceExpired(p.expiresAt)) out.push(t('testplace.expired.kept'))
  else if (p.source === 'testplace' && testplaceDaysLeft(p.expiresAt) !== null) {
    out.push(t('testplace.expiring', { days: testplaceDaysLeft(p.expiresAt), date: (p.expiresAt ?? '').slice(0, 10) }))
  }
  if (p.source === 'local-unsigned' && p.localSignature !== 'verified') out.push(t('pluginDisclosure.source.local-unsigned'))
  if (p.warning) out.push(p.provenance === 'developer-local-unpacked' ? t('settings.extensions.devUnpacked') : p.warning)
  const folder = p.provenance === 'developer-local-unpacked' ? developerFolder(p.id) : undefined
  // Who loaded a developer folder is a warning when it cannot be vouched for:
  // an unknown loader, an unverified or changed record, or an unsigned one.
  if (folder && (folder.loadedBy?.kind === 'unknown' || folder.loadedByUnverified || folder.loadedByUnsigned)) {
    out.push(folderLoadedByText(p.id))
  }
  if (folder?.reloadError) out.push(t('settings.extensions.developerMode.reloadFailed', { error: reveal(folder.reloadError) }))
  return out
}
// Where a package came from when that is not the Navide Marketplace: an icon
// in the row, the card's full source wording as its label.
function rowSource(p: InstalledRow): { kind: 'test' | 'folder' | 'file'; label: string; byAgent: boolean } | null {
  const mark = chromeSourceMark(p.source)
  if (!mark) return null
  const shown = mark === 'local-unsigned' && p.localSignature === 'verified' ? 'local-signed' : mark
  const kind = mark === 'developer-unpacked' ? 'folder' : mark === 'local-signed' || mark === 'local-unsigned' ? 'file' : 'test'
  const label = pluginSourceLabel(t, shown, p.expiresAt, p.testplaceVia)
  // A developer folder an agent had loaded (with the user's approval) says so in
  // the row too, in the card's words: who loaded it is part of where it came from.
  const byAgent = kind === 'folder' && developerFolder(p.id)?.loadedBy?.kind === 'agent'
  return { kind, label: byAgent ? `${label} · ${folderLoadedByText(p.id)}` : label, byAgent }
}
type FactoryRow = (typeof factoryRows.value)[number]
function factoryWarnings(p: FactoryRow): string[] {
  const out: string[] = []
  if (p.installed?.sensitive.length) {
    out.push(t('settings.extensionsPolicy.labeledValue', { label: t('settings.extensions.sensitive'), value: p.installed.sensitive.join(', ') }))
  }
  if (p.id === 'navide.plans') out.push(t('settings.extensions.plansRiskNote'))
  return out
}
const busy = ref(false)
const error = ref('')
// A failed inventory read, shown apart from the action error it may follow.
const inventoryError = ref('')

async function reloadInventory(): Promise<void> {
  try {
    await refreshInstalled()
    inventoryError.value = ''
  } catch (err) {
    inventoryError.value = t('settings.extensions.inventoryRefreshFailed', { error: ipcErrorMessage(err) })
  }
}
// Updates for installed Registry packages; the Update button reuses the
// Marketplace's verified install flow (and its trust dialog).
const pluginUpdates = usePluginUpdates()
const updatesById = computed(
  () => new Map(pluginUpdates.updates.value.map((update) => [update.id, update]))
)
const updateFlow = usePluginInstallFlow()
const notify = useNotify()
// D-f: rows whose permissions section is open; the activity panel (and its
// reads) exists only then.
const emit = defineEmits<{ openDisclosureOverview: [id?: string]; developerOn: [switches: string[]] }>()
// Settings shows this pane on two of the Navide Plugins pages: the plugins
// themselves, and Developer Mode with native backends. Everything stays
// mounted; the page only decides what is shown.
const props = withDefaults(defineProps<{ page?: 'plugins' | 'developer' }>(), { page: 'plugins' })
const activityOpen = ref(new Set<string>())
function onActivityToggle(id: string, event: Event): void {
  const next = new Set(activityOpen.value)
  if ((event.target as HTMLDetailsElement).open) next.add(id)
  else next.delete(id)
  activityOpen.value = next
}

/** The reserved first-party namespace: such a package can be disabled, not removed. */
function isFirstPartyId(id: string): boolean {
  return id.startsWith('navide.')
}

/** `namespace.name` split for the icon tile, which colours itself from the id. */
function idParts(id: string): { namespace: string; name: string } {
  const dot = id.indexOf('.')
  return dot < 0 ? { namespace: '', name: id } : { namespace: id.slice(0, dot), name: id.slice(dot + 1) }
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : t('settings.extensionsPolicy.none')
}

function formatManifestPermissions(permissions: ManifestPermissionsSummary): string {
  const parts = [`${t('settings.extensionsPolicy.system')}: ${formatList(permissions.system)}`]
  if (permissions.shell) parts.push(`${t('settings.extensionsPolicy.shell')}: ${permissions.shell}`)
  return parts.join('; ')
}

// A declared scope is what the package says it reaches, shown as written; the
// Host neither grants nor enforces it.
function formatManifestScopes(permissions: ManifestPermissionsSummary): string {
  return manifestScopeGroups(permissions)
    .map(([key, patterns]) => `${t(`settings.extensionsPolicy.${key}`)} ${patterns.join(', ')}`)
    .join('; ')
}

/** The declared scopes by access, non-empty groups only; rendered as chips. */
function manifestScopeGroups(permissions: ManifestPermissionsSummary): Array<[string, string[]]> {
  const fs = permissions.scopes?.fs
  const read = fs?.read ?? []
  const write = fs?.write ?? []
  const groups: Array<[string, string[]]> = [
    ['scopeReadWrite', write.filter((pattern) => read.includes(pattern))],
    ['scopeReadOnly', read.filter((pattern) => !write.includes(pattern))],
    ['scopeWriteOnly', write.filter((pattern) => !read.includes(pattern))],
  ]
  return groups.filter(([, patterns]) => patterns.length > 0)
}

function manifestScopesLabel(permissions: ManifestPermissionsSummary): string {
  return permissions.scopes?.fs.root === 'repository'
    ? t('settings.extensionsPolicy.fileScopesRepository')
    : t('settings.extensionsPolicy.fileScopes')
}

function formatPackageGrant(grant: PackageVersionGrantSummary | null | undefined): string {
  if (!grant) return t('settings.extensionsPolicy.noMatchingGrant')
  const parts = [
    `${t('settings.extensionsPolicy.version')} ${grant.packageVersion}`,
    `${t('settings.extensionsPolicy.system')}: ${formatList(grant.system)}`,
  ]
  if (grant.shell) parts.push(`${t('settings.extensionsPolicy.shell')}: ${grant.shell}`)
  if (grant.highRiskShellConfirmed !== undefined) {
    parts.push(`${t('settings.extensionsPolicy.highRiskShellConfirmed')}: ${grant.highRiskShellConfirmed ? t('settings.extensionsPolicy.yes') : t('settings.extensionsPolicy.no')}`)
  }
  if (grant.storage !== undefined) {
    parts.push(`${t('settings.extensionsPolicy.storage')}: ${grant.storage ? t('settings.extensionsPolicy.yes') : t('settings.extensionsPolicy.no')}`)
  }
  return parts.join('; ')
}

// The main process keeps its refusals in English for its logs; the known ones
// are shown translated, matched by their stable wording. Anything else is shown
// as the Host wrote it.
const HOST_REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^plugin transaction already in progress for (?<id>.+)$/, 'transactionInProgress'],
  [/^plugin (?<id>\S+) has no completed activation to roll back$/, 'noCompletedActivation'],
  [/^previous package is unavailable for rollback(?:: (?<detail>.+))?$/s, 'previousUnavailable'],
  [/^previous package artifact identity changed before rollback$/, 'previousChanged'],
  [/^active package grant is unavailable for (?<id>.+)$/, 'grantUnavailable'],
  [/^factory package rollback is unavailable$/, 'factoryUnavailable'],
  [/^Bundled Git cannot be restored while NAVIDE_GIT_RECOVERY=legacy is forcing legacy recovery$/, 'gitLegacyRecovery'],
  [/^Factory package restoration failed: (?<detail>.+)$/s, 'factoryRestoreFailed'],
]

function pluginErrorMessage(err: unknown): string {
  const message = ipcErrorMessage(err)
  for (const [pattern, key] of HOST_REFUSALS) {
    const match = pattern.exec(message)
    if (!match) continue
    const groups = match.groups
    const text = t(`settings.extensions.rollback.errors.${key}`, { id: groups?.id ?? '' })
    return groups?.detail ? `${text} (${groups.detail})` : text
  }
  return localizeDeveloperModeError(message, t)
}

async function remove(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  const answer = await askUninstall(t, notify, id)
  if (!answer) return
  busy.value = true
  error.value = ''
  try {
    await removeWithAnswer(api, id, answer)
    await refreshInstalled()
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
}

// Returning an installed package to what it displaced: the previous version, or
// the App-bundled factory package for the ids that ship with Navide. The Host
// decides which of the two applies; the row only offers the button when the Host
// says a rollback is available.
async function rollback(id: string, kind: 'factory' | 'previous', version?: string, needsConsent = false): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  // L4 (review M3): a kept file version is consented to again with its own
  // disclosure, in the install consent dialog.
  if (needsConsent) {
    await updateFlow.rollbackWithConsent(id)
    return
  }
  const previousText = t('settings.extensions.rollback.confirmPrevious', {
    id,
    version: version ?? t('settings.extensions.rollback.previousVersion'),
  })
  const confirmed = await notify.confirm(
    kind === 'factory'
      ? t('settings.extensions.rollback.confirmFactory', { id })
      : previousText,
    {
      title: t('settings.extensions.rollback.title'),
      confirmText: t('settings.extensions.rollback.confirm'),
      danger: true,
    },
  )
  if (!confirmed) return
  busy.value = true
  error.value = ''
  try {
    await api.rollback(id)
    await refreshInstalled()
    void pluginUpdates.refresh()
  } catch (err) {
    error.value = pluginErrorMessage(err)
    // A rollback can fail after the Host already switched packages, so the
    // row is redrawn from the Host rather than left offering a stale action.
    await reloadInventory()
  } finally {
    busy.value = false
  }
}

async function restartPlugin(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    await api.restart(id)
    await refreshInstalled()
    void pluginUpdates.refresh()
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
}

// D2: the per-extension "Get pre-releases" switch. It only changes which
// versions the update check offers; updating still goes through the normal
// verified install flow and its trust dialog.
async function setPrerelease(id: string, enabled: boolean): Promise<void> {
  const api = pluginsApi()
  if (!api?.setPrerelease) return
  busy.value = true
  error.value = ''
  try {
    await api.setPrerelease(id, enabled)
    await refreshInstalled()
    await pluginUpdates.refresh()
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
}

// Installed Extension Packs. A pack is a record over its members, which are
// listed (and removable) as ordinary extensions below.
const packs = ref<InstalledPackRecord[]>([])
const uninstallingPack = ref<InstalledPackRecord | null>(null)

async function refreshPacks(): Promise<void> {
  const api = pluginsApi()
  if (!api?.listPacks) return
  try {
    packs.value = await api.listPacks()
  } catch {
    packs.value = []
  }
}

// D8: remove the pack and only the members the user ticked; the Host removes
// those members and refuses one another installed pack still uses.
async function uninstallPack(members: string[]): Promise<void> {
  const api = pluginsApi()
  const pack = uninstallingPack.value
  if (!api?.removePack || !pack) return
  busy.value = true
  error.value = ''
  try {
    await api.removePack(pack.id, members)
    uninstallingPack.value = null
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
    await refreshInstalled()
    await refreshPacks()
  }
}

// d5: the label for a local install whose file Navide blocked since; no
// reason (or one this release does not know) reads as a plain block. A
// withdrawn Testplace build (0.2.28) is labelled the same way.
function digestBlockKey(reason: 'security' | 'admin' | 'qualification-revoked' | 'developer-withdrawn' | 'testplace-withdrawn' | null): string {
  if (reason === 'security') return 'security'
  if (reason === 'qualification-revoked') return 'qualificationRevoked'
  if (reason === 'developer-withdrawn') return 'developerWithdrawn'
  if (reason === 'testplace-withdrawn') return 'testplaceWithdrawn'
  return 'blocked'
}

// The user's "Disabled" switch. A disabled package keeps its files, grant and
// stored data; the Host only stops loading its views and backend. The row says
// so with a badge and an Enable button, never silently.
// Which switch (a plugin id, or 'reset') the Host is still applying. A
// built-in waits for a store check in progress and then drains (Plans can
// take about half a minute), so the row says it is working.
const switching = ref<string | null>(null)
async function setDisabled(id: string, disabled: boolean): Promise<void> {
  const api = pluginsApi()
  if (!api?.setDisabled) return
  busy.value = true
  switching.value = id
  error.value = ''
  try {
    await api.setDisabled(id, disabled)
    await refreshInstalled()
  } catch (err) {
    error.value = pluginErrorMessage(err)
    await reloadInventory()
  } finally {
    busy.value = false
    switching.value = null
  }
}

// The Disabled store itself: rebuilt from its backup this session, or
// unreadable (the built-ins then count as disabled until the user resets it).
const disabledStoreStatus = ref<'ok' | 'restored' | 'unreadable'>('ok')
async function refreshDisabledStoreStatus(): Promise<void> {
  try {
    disabledStoreStatus.value = (await pluginsApi()?.disabledStoreStatus?.())?.status ?? 'ok'
  } catch {
    disabledStoreStatus.value = 'ok'
  }
}
async function resetDisabledStore(): Promise<void> {
  const api = pluginsApi()
  if (!api?.resetDisabledStore) return
  busy.value = true
  switching.value = 'reset'
  error.value = ''
  try {
    disabledStoreStatus.value = (await api.resetDisabledStore()).status
    await refreshInstalled()
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
    switching.value = null
  }
}

async function restoreFactoryPackage(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    await api.restoreFactoryPackage(id)
    await refreshInstalled()
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
}

// Card K4: the Developer Mode switch (owned by the main process) and its
// developer folders; D6: packages from a self-hosted Registry it quarantines.
const developerMode = ref<DeveloperModeState>({ enabled: false, folders: [] })
// A2-3: the "Local folder" info card opened from a developer folder's badge.
const folderCardFor = ref<string | null>(null)
const developerFolderOf = (pluginId: string) => developerMode.value.folders.find((folder) => folder.pluginId === pluginId)
async function toggleFolderCard(pluginId: string): Promise<void> {
  if (folderCardFor.value === pluginId) {
    folderCardFor.value = null
    return
  }
  folderCardFor.value = pluginId
  // The fingerprint of the last load is taken after it; read it fresh.
  await refreshDeveloperMode()
}
const selfHostedQuarantine = ref<Array<{ id: string; version: string | null }>>([])
// Developer Mode and the native-backend switches that are on, by their titles:
// Settings marks the "Developer and native code" page with them.
const nativeSwitchesOn = ref<string[]>([])
const developerSwitchesOn = computed(() => [
  ...(developerMode.value.enabled ? [t('settings.extensions.developerMode.switch')] : []),
  ...nativeSwitchesOn.value,
])
watch(developerSwitchesOn, (switches) => emit('developerOn', switches), { immediate: true })
const unloadedFolders = computed(() => developerMode.value.folders.filter((folder) => !folder.loaded))
/** DESIGN-A2 G1: the developer folder record of a loaded package. */
function developerFolder(pluginId: string): DeveloperModeState['folders'][number] | undefined {
  return developerMode.value.folders.find((folder) => folder.pluginId === pluginId)
}
function lastLoadText(pluginId: string): string {
  const lastLoad = developerFolder(pluginId)?.lastLoad
  if (!lastLoad) return ''
  return t('settings.extensions.developerMode.lastLoad', {
    at: new Date(lastLoad.at).toLocaleString(),
    trigger: t(`settings.extensions.developerMode.loadTrigger.${lastLoad.trigger}`),
  })
}
async function setFolderAutoReload(pluginId: string, enabled: boolean): Promise<void> {
  const api = pluginsApi()
  if (!api?.setDeveloperFolderAutoReload) return
  try {
    developerMode.value = await api.setDeveloperFolderAutoReload(pluginId, enabled)
  } catch (err) {
    error.value = pluginErrorMessage(err)
  }
}
/** DESIGN-A2 G3: who had a loaded developer folder loaded, in the wording of agent request cards. */
function folderLoadedByText(pluginId: string): string {
  const folder = developerMode.value.folders.find((entry) => entry.pluginId === pluginId)
  const loadedBy = folder?.loadedBy
  if (!loadedBy) return ''
  if (folder.loadedByUnverified === 'key-changed') return t('settings.extensions.developerMode.loadedByKeyChanged')
  if (folder.loadedByUnverified) return t('settings.extensions.developerMode.loadedByUnverified')
  if (loadedBy.kind === 'user') {
    const text = t('settings.extensions.developerMode.loadedByUser')
    return folder.loadedByUnsigned ? `${text} ${t('settings.extensions.developerMode.loadedByUnsigned')}` : text
  }
  if (loadedBy.kind === 'unknown') return t('settings.extensions.developerMode.loadedByUnknown')
  const requester = loadedBy.callerKind === 'pane'
    ? (loadedBy.paneName ? t('plugin-agent.caller.pane', { pane: reveal(loadedBy.paneName) }) : t('plugin-agent.caller.pane-unknown'))
    : loadedBy.callerKind === 'external' ? t('plugin-agent.caller.external')
      : loadedBy.callerKind === 'host' ? t('plugin-agent.caller.host')
        : t('plugin-request.caller-unknown')
  const text = t('settings.extensions.developerMode.loadedByAgent', { requester, at: new Date(loadedBy.approvedAt).toLocaleString() })
  return folder.loadedByUnsigned ? `${text} ${t('settings.extensions.developerMode.loadedByUnsigned')}` : text
}

async function refreshDeveloperMode(): Promise<void> {
  const api = pluginsApi()
  try {
    developerMode.value = (await api?.developerMode?.()) ?? { enabled: false, folders: [] }
    selfHostedQuarantine.value = (await api?.selfHostedQuarantine?.()) ?? []
  } catch (err) {
    error.value = pluginErrorMessage(err)
  }
}

async function setDeveloperMode(enabled: boolean): Promise<void> {
  const api = pluginsApi()
  if (!api?.setDeveloperMode) return
  if (enabled) {
    const confirmed = await notify.confirm(t('settings.extensions.developerMode.confirmBody'), {
      title: t('settings.extensions.developerMode.confirmTitle'),
      confirmText: t('settings.extensions.developerMode.confirmOn'),
      cancelText: t('settings.extensions.trust.cancel'),
      danger: true,
    })
    if (!confirmed) {
      await refreshDeveloperMode()
      return
    }
  }
  busy.value = true
  error.value = ''
  try {
    developerMode.value = await api.setDeveloperMode(enabled)
    await refreshInstalled()
    selfHostedQuarantine.value = (await api.selfHostedQuarantine?.()) ?? []
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
}

async function removeDeveloperFolder(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api?.removeDeveloperFolder) return
  busy.value = true
  error.value = ''
  try {
    developerMode.value = await api.removeDeveloperFolder(id)
    await refreshInstalled()
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
}

// D3: expired Testplace builds, stopped with their data kept. Each is listed
// with three choices and never removed without the user: the Navide
// Marketplace version (the normal verified install), keep using it marked
// expired (only when it failed on its expiry alone), or remove it.
const expiredTestplace = ref<ExpiredTestplaceBuild[]>([])
// S8 LOW-R3-2: each reason "keep using" is refused has its own advice.
const KEEP_REFUSAL_KEYS: Record<NonNullable<ExpiredTestplaceBuild['keepRefusal']>, string> = {
  withdrawn: 'cannotKeepWithdrawn',
  'signed-out': 'cannotKeepSignedOut',
  'not-a-tester': 'cannotKeepNotTester',
  'registry-outdated': 'cannotKeepRegistryOutdated',
  unreachable: 'cannotKeepUnreachable',
}
// Disclose, don't restrict: packages stopped because their trust data fails
// against this computer's clock, with the way the clock looks off.
const clockQuarantine = ref<Array<{ id: string; version: string | null; clock: 'behind' | 'ahead' }>>([])
async function refreshClockQuarantine(): Promise<void> {
  try {
    clockQuarantine.value = (await pluginsApi()?.clockQuarantine?.()) ?? []
  } catch {
    clockQuarantine.value = []
  }
}
async function refreshExpiredTestplace(): Promise<void> {
  try {
    expiredTestplace.value = (await pluginsApi()?.expiredTestplace?.()) ?? []
  } catch {
    expiredTestplace.value = []
  }
}
async function keepExpiredTestplace(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api?.keepExpiredTestplace) return
  const confirmed = await notify.confirm(t('testplace.expired.keepConfirm', { id: reveal(id) }), {
    title: t('testplace.expired.keepTitle'),
    confirmText: t('testplace.expired.keep'),
  })
  if (!confirmed) return
  busy.value = true
  error.value = ''
  try {
    await api.keepExpiredTestplace(id)
    await refreshInstalled()
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
    await refreshExpiredTestplace()
  }
}
// "Install the Navide Marketplace version": a promoted build of the same digest
// only takes its new receipt (nothing downloaded, nothing to consent to again);
// otherwise the normal verified install runs.
async function expiredToMarketplace(id: string): Promise<void> {
  const api = pluginsApi()
  busy.value = true
  error.value = ''
  let adopted = false
  try {
    adopted = (await api?.adoptTestplaceRelease?.(id))?.adopted === true
  } catch (err) {
    error.value = pluginErrorMessage(err)
  } finally {
    busy.value = false
  }
  if (adopted) {
    await refreshInstalled()
    await refreshExpiredTestplace()
    return
  }
  if (!error.value) await updateFlow.install(idParts(id).namespace, idParts(id).name)
}
async function removeExpiredTestplace(id: string): Promise<void> {
  await remove(id)
  await refreshExpiredTestplace()
}

// A developer folder consented to or reloaded changes the inventory.
watch(() => updateFlow.pendingConfirm.value, (pending) => {
  if (!pending) void refreshDeveloperMode()
})

// G1: an automatic reload refreshes the list; changed permissions stop it and say so.
let stopDeveloperFolderEvents: (() => void) | undefined
onBeforeUnmount(() => stopDeveloperFolderEvents?.())

onMounted(() => {
  stopDeveloperFolderEvents = pluginsApi()?.onDeveloperFolderEvent?.((folderEvent) => {
    void refreshDeveloperMode()
    if (folderEvent.kind === 'needs-consent') {
      notify.toast(t('settings.extensions.developerMode.autoReloadNeedsConsent', { id: reveal(folderEvent.pluginId) }), { type: 'info' })
    }
  })
  void reloadInventory()
  void refreshDisabledStoreStatus()
  void pluginUpdates.refresh()
  void refreshPacks()
  void refreshDeveloperMode()
  void refreshExpiredTestplace()
  void refreshClockQuarantine()
  void refreshRiskLevels()
})
// A pack installed from the Marketplace page shows up here without a remount.
watch(installed, () => {
  void refreshPacks()
  void refreshExpiredTestplace()
  void refreshClockQuarantine()
  void refreshRiskLevels()
})
</script>

<template>
  <div class="extensions-pane">
    <p v-if="error" class="ext-error" role="alert">{{ error }}</p>
    <p v-if="inventoryError" class="ext-error" role="alert">{{ inventoryError }}</p>
    <p v-if="updateFlow.error.value" class="ext-error" role="alert">{{ updateFlow.error.value }}</p>
    <!-- Card K4: shown above the lists for as long as Developer Mode is on. -->
    <p v-if="developerMode.enabled" class="ext-devmode-banner ext-risk-banner" role="status">
      {{ $t('settings.extensions.developerMode.banner') }}
    </p>
    <!-- A2-5 (G5): settings another program wrote are disclosed, never applied. -->
    <p v-if="developerMode.externalChange" class="ext-devmode-external ext-risk-banner" role="alert">
      {{ $t(developerMode.externalChange.reason === 'signing-unavailable' ? 'settings.extensions.developerMode.externalChangeUnsigned' : developerMode.externalChange.reason === 'signature-missing' ? 'settings.extensions.developerMode.externalChangeMissing' : 'settings.extensions.developerMode.externalChange', { time: new Date(developerMode.externalChange.detectedAt).toLocaleString() }) }}
    </p>
    <!-- D6: never let a self-hosted Registry package disappear silently. -->
    <p v-for="item in selfHostedQuarantine" v-show="props.page === 'plugins'" :key="`selfhosted:${item.id}`" class="ext-selfhosted-quarantine ext-risk-banner" role="alert">
      {{ $t('settings.extensions.developerMode.selfHostedQuarantine', { id: reveal(item.id), version: reveal(item.version ?? '') }) }}
    </p>
    <p v-for="item in clockQuarantine" v-show="props.page === 'plugins'" :key="`clock:${item.id}`" class="ext-clock-quarantine ext-risk-banner" role="alert" :data-clock-id="item.id">
      {{ $t(`settings.extensions.registryTrust.clockQuarantine.${item.clock}`, { id: reveal(item.id), version: reveal(item.version ?? '') }) }}
    </p>
    <!-- D3: an expired test build is stopped, never silently dropped. -->
    <div v-for="item in expiredTestplace" v-show="props.page === 'plugins'" :key="`expired:${item.id}`" class="ext-testplace-expired ext-risk-banner" role="alert" :data-expired-id="item.id">
      <p v-if="item.withdrawn">{{ $t('testplace.expired.withdrawnBanner', { id: reveal(item.id), version: reveal(item.version ?? '') }) }}</p>
      <p v-else>{{ $t('testplace.expired.banner', { id: reveal(item.id), version: reveal(item.version ?? ''), date: (item.expiresAt ?? '').slice(0, 10) }) }}</p>
      <!-- S8 T-MED-1: say why "keep using" is not offered. -->
      <p v-if="!item.canKeep" class="ext-testplace-cannot-keep">
        {{ $t(item.keepRefusal ? `testplace.expired.${KEEP_REFUSAL_KEYS[item.keepRefusal]}` : 'testplace.expired.cannotKeep') }}
      </p>
      <div class="ext-actions">
        <button
          class="ext-testplace-marketplace nv-btn nv-btn--primary nv-btn--sm"
          :disabled="busy || updateFlow.busy.value"
          @click="expiredToMarketplace(item.id)"
        >{{ $t('testplace.expired.toMarketplace') }}</button>
        <button
          v-if="item.canKeep"
          class="ext-testplace-keep nv-btn nv-btn--sm"
          :disabled="busy || updateFlow.busy.value"
          @click="keepExpiredTestplace(item.id)"
        >{{ $t('testplace.expired.keep') }}</button>
        <button
          class="ext-testplace-remove nv-btn nv-btn--sm ext-btn-danger"
          :disabled="busy || updateFlow.busy.value"
          @click="removeExpiredTestplace(item.id)"
        >{{ $t('testplace.expired.remove') }}</button>
      </div>
    </div>

    <!-- Every package in one list on the left; the selected one's full card,
         with its permissions and disclosure, on the right. All cards stay in
         the page (only the selected one is shown), so nothing a card offers
         depends on the selection. -->
    <div v-show="props.page === 'plugins'" class="ext-md-toolbar">
      <!-- Updates are for installed packages; with none installed the line
           would contradict the empty list. -->
      <span v-if="pluginUpdates.count.value && nonFactoryInstalled.length" class="ext-updates-summary" role="status">
        {{ $t('settings.extensions.marketplace.updatesCount', { count: pluginUpdates.count.value }) }}
      </span>
      <!-- Card K3: the user's own action in this window; the main process
           opens the file dialog, so no path ever comes from here. -->
      <button
        class="ext-install-file nv-btn nv-btn--sm"
        :disabled="busy || updateFlow.busy.value"
        @click="updateFlow.installFromFile()"
      >
        {{ $t('settings.extensions.localInstall.button') }}
      </button>
    </div>
    <div v-show="props.page === 'plugins'" class="ext-md">
      <div class="ext-md-list">
        <section class="ext-section" data-settings-section="extensions-bundled">
          <h3 class="ext-section-title">
            {{ $t('settings.extensions.bundled') }}
            <span class="ext-section-count">{{ factoryRows.length }}</span>
          </h3>
          <ul class="ext-md-rows">
            <li v-for="p in factoryRows" :key="p.id">
              <button
                type="button"
                class="ext-md-row"
                :data-select-id="p.id"
                :aria-current="selectedId === p.id ? 'true' : undefined"
                @click="selectedChoice = p.id"
              >
                <MarketplaceIcon v-bind="idParts(p.id)" :label="idParts(p.id).name" :size="28" />
                <span class="ext-md-row-text">
                  <span class="ext-md-row-name" v-truncate>{{ p.id === 'navide.git' ? $t('settings.extensions.bundledGit') : p.id }}</span>
                  <span class="ext-md-row-sub">{{ p.installed?.packageVersion ?? p.version }}</span>
                </span>
                <span class="ext-md-row-end">
                  <span
                    v-if="factoryWarnings(p).length"
                    class="ext-md-warn"
                    role="img"
                    :aria-label="factoryWarnings(p).join('\n')"
                    :title="factoryWarnings(p).join('\n')"
                  >⚠ {{ factoryWarnings(p).length }}</span>
                  <span v-if="p.disabled" class="ext-badge ext-disabled-badge">{{ $t('settings.extensions.disabledBadge') }}</span>
                  <span
                    v-else
                    class="ext-md-dot"
                    :class="p.active ? 'ext-md-dot--active' : 'ext-md-dot--off'"
                    role="img"
                    :aria-label="p.active ? $t('settings.extensions.state.active') : $t('settings.extensions.state.unavailable')"
                    :title="p.active ? $t('settings.extensions.state.active') : $t('settings.extensions.state.unavailable')"
                  ></span>
                </span>
              </button>
            </li>
          </ul>
        </section>
        <section class="ext-section" data-settings-section="extensions-install-from-file">
          <h3 class="ext-section-title">
            {{ $t('settings.extensions.installed') }}
            <span class="ext-section-count">{{ packs.length + nonFactoryInstalled.length }}</span>
          </h3>
          <ul class="ext-md-rows">
            <li v-for="pack in packs" :key="`pack:${pack.id}`">
              <button
                type="button"
                class="ext-md-row"
                :data-select-id="`pack:${pack.id}`"
                :aria-current="selectedId === `pack:${pack.id}` ? 'true' : undefined"
                @click="selectedChoice = `pack:${pack.id}`"
              >
                <MarketplaceIcon v-bind="idParts(pack.id)" :label="pack.displayName || idParts(pack.id).name" :size="28" />
                <span class="ext-md-row-text">
                  <span class="ext-md-row-name" v-truncate>{{ reveal(pack.displayName || pack.id) }}</span>
                  <span class="ext-md-row-sub">{{ pack.version }}</span>
                </span>
                <span class="ext-badge ext-pack-badge">{{ $t('settings.extensions.pack.membersBadge', { count: pack.members.length }) }}</span>
              </button>
            </li>
            <li v-for="p in nonFactoryInstalled" :key="p.id">
              <button
                type="button"
                class="ext-md-row"
                :data-select-id="p.id"
                :aria-current="selectedId === p.id ? 'true' : undefined"
                @click="selectedChoice = p.id"
              >
                <MarketplaceIcon v-bind="idParts(p.id)" :label="idParts(p.id).name" :size="28" />
                <span class="ext-md-row-text">
                  <span class="ext-md-row-name" v-truncate>{{ reveal(p.id) }}</span>
                  <span class="ext-md-row-sub">
                    {{ p.packageVersion }}
                    <span
                      v-if="!p.pendingCandidateVersion && updatesById.get(p.id)"
                      class="ext-md-row-update"
                      :title="$t('settings.extensions.marketplace.updateAvailableVersion', { version: updatesById.get(p.id)?.latestVersion ?? '' })"
                    >→ {{ updatesById.get(p.id)?.latestVersion }}</span>
                    <span
                      v-if="rowSource(p)"
                      class="ext-md-source"
                      :data-source-kind="rowSource(p)!.kind"
                      :data-loaded-by-agent="rowSource(p)!.byAgent ? 'true' : undefined"
                      role="img"
                      :aria-label="rowSource(p)!.label"
                      :title="rowSource(p)!.label"
                    >
                      <svg v-if="rowSource(p)!.kind === 'folder'" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.2c0-.6.4-1 1-1h3.3l1.4 1.5h5.7c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" /></svg>
                      <svg v-else-if="rowSource(p)!.kind === 'file'" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.8h5.6l3.4 3.4v8c0 .6-.4 1-1 1h-8c-.6 0-1-.4-1-1v-10.4c0-.6.4-1 1-1Z" /><path d="M9 1.8v3.5h3.5" /></svg>
                      <svg v-else viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.8h4M6.6 1.8v4.4L2.9 12.4c-.5.8.1 1.8 1 1.8h8.2c.9 0 1.5-1 1-1.8L9.4 6.2V1.8" /></svg>
                    </span>
                    <span v-if="p.disabled" class="ext-badge ext-disabled-badge">{{ $t('settings.extensions.disabledBadge') }}</span>
                  </span>
                </span>
                <!-- The one severity mark of the row: its risk level, and how
                     many warnings its card carries. -->
                <span class="ext-md-row-end">
                  <span
                    v-if="riskById.get(p.id) && riskById.get(p.id) !== 'low'"
                    class="ext-badge ext-md-risk"
                    :class="`ext-md-risk--${riskById.get(p.id)}`"
                    :title="$t('pluginDisclosure.riskLabel', { level: $t(`pluginDisclosure.risk.${riskById.get(p.id)}`) })"
                  >{{ $t(`pluginDisclosure.risk.${riskById.get(p.id)}`) }}</span>
                  <span
                    v-if="installedWarnings(p).length"
                    class="ext-md-warn"
                    role="img"
                    :aria-label="installedWarnings(p).join('\n')"
                    :title="installedWarnings(p).join('\n')"
                  >⚠ {{ installedWarnings(p).length }}</span>
                </span>
              </button>
            </li>
          </ul>
          <p v-if="!nonFactoryInstalled.length" class="ext-empty nv-empty">{{ $t('settings.extensions.empty') }}</p>
        </section>
      </div>
      <div class="ext-md-detail">
        <p v-if="disabledStoreStatus === 'restored'" class="ext-store-restored" role="status">
          {{ $t('settings.extensions.disabledStoreRestored') }}
        </p>
        <div v-else-if="disabledStoreStatus === 'unreadable'" class="ext-store-unreadable" role="alert">
          <p>{{ $t('settings.extensions.disabledStoreUnreadable') }}</p>
          <button class="ext-store-reset nv-btn nv-btn--primary nv-btn--sm" :disabled="busy" @click="resetDisabledStore()">
            {{ $t('settings.extensions.disabledStoreReset') }}
          </button>
          <span v-if="switching === 'reset'" class="ext-switch-busy" role="status">
            <span class="ext-switch-spinner" aria-hidden="true"></span>{{ $t('settings.extensions.builtinSwitchBusy') }}
          </span>
        </div>
        <ul class="ext-list ext-bundled-list">
          <li
            v-for="p in factoryRows"
            v-show="selectedId === p.id"
            :key="p.id"
            class="ext-installed ext-factory"
            :data-factory-id="p.id"
          >
            <div class="ext-row-head">
              <MarketplaceIcon v-bind="idParts(p.id)" :label="idParts(p.id).name" :size="32" />
              <div class="ext-row-title">
                <span class="ext-id" v-truncate>{{ p.id === 'navide.git' ? $t('settings.extensions.bundledGit') : p.id }}</span>
                <span v-if="p.installed?.packageVersion ?? p.version" class="ext-requires">
                  {{ p.installed?.packageVersion ?? p.version }}
                </span>
              </div>
              <!-- Built-ins are never removed, only disabled; the state says which. -->
              <span v-if="p.disabled" class="ext-badge ext-disabled-badge" :title="$t('settings.extensions.builtinDisabledNote')">
                {{ $t('settings.extensions.disabledBadge') }}
              </span>
              <span v-else class="ext-badge ext-state" :class="p.active ? 'ext-active' : 'ext-removed'">
                {{ p.active ? $t('settings.extensions.state.active') : $t('settings.extensions.state.unavailable') }}
              </span>
            </div>
            <p v-if="p.disabled" class="ext-disabled-note">{{ $t('settings.extensions.builtinDisabledNote') }}</p>
            <p v-if="p.dataDeletedByEarlierRemoval" class="ext-disabled-note ext-data-deleted-note">
              {{ $t('settings.extensions.builtinDataDeletedEarlier') }}
            </p>
            <span v-if="p.installed?.pendingCandidateVersion" class="ext-badge ext-candidate">
              {{ $t('settings.extensions.candidateReady', { version: p.installed.pendingCandidateVersion }) }}
            </span>
            <!-- First-party code with no sandbox: say so plainly. The third-party
                 sandbox wording does not apply to it. -->
            <p v-if="p.id === 'navide.plans'" class="ext-risk-note">
            <strong class="ext-lead">{{ plansRiskNote.lead }}</strong>{{ plansRiskNote.separator }}{{ plansRiskNote.rest }}
            </p>
            <div v-if="p.disabled !== undefined || p.installed?.pendingCandidateVersion" class="ext-actions">
              <button
                v-if="p.disabled"
                class="ext-enable nv-btn nv-btn--primary nv-btn--sm"
                :disabled="busy || updateFlow.busy.value"
                @click="setDisabled(p.id, false)"
              >
                {{ $t('settings.extensions.enable') }}
              </button>
              <button
                v-else-if="p.disabled === false"
                class="ext-disable nv-btn nv-btn--sm"
                :disabled="busy || updateFlow.busy.value"
                @click="setDisabled(p.id, true)"
              >
                {{ $t('settings.extensions.disable') }}
              </button>
              <!-- A rollback leaves the displaced package staged over the bundled
                   one, and this row is the only place it is still listed. -->
              <button
                v-if="p.installed?.pendingCandidateVersion"
                class="ext-restart nv-btn nv-btn--primary nv-btn--sm"
                :disabled="busy || updateFlow.busy.value"
                @click="restartPlugin(p.id)"
              >
                {{ $t('settings.extensions.restartPlugin') }}
              </button>
              <span v-if="switching === p.id" class="ext-switch-busy" role="status">
                <span class="ext-switch-spinner" aria-hidden="true"></span>{{ $t('settings.extensions.builtinSwitchBusy') }}
              </span>
            </div>
            <details v-if="p.installed?.manifestPermissions || p.installed?.packageVersion" class="ext-permission-details">
              <summary>{{ $t('settings.extensions.permissionDetails') }}</summary>
              <span v-if="p.installed?.manifestPermissions" class="ext-manifest-permissions">
                <span class="ext-perm-label">{{ $t('settings.extensionsPolicy.manifestPermissions') }}</span><span class="ext-perm-value">{{ formatManifestPermissions(p.installed.manifestPermissions) }}</span>
              </span>
              <span v-if="p.installed?.manifestPermissions?.scopes" class="ext-manifest-scopes" :title="formatManifestScopes(p.installed.manifestPermissions)">
                <span class="ext-perm-label">{{ manifestScopesLabel(p.installed.manifestPermissions) }}</span>
                <span
                  v-for="[key, patterns] in manifestScopeGroups(p.installed.manifestPermissions)"
                  :key="key"
                  class="ext-scope-group"
                  :data-access="key"
                >
                  <span class="ext-scope-kind">{{ $t(`settings.extensionsPolicy.${key}`) }}</span>
                  <span class="ext-globs"><code v-for="pattern in patterns" :key="pattern" class="ext-glob">{{ pattern }}</code></span>
                </span>
              </span>
              <span
                v-if="p.installed?.packageVersion"
                class="ext-package-grant"
                :class="{ 'ext-package-grant-none': !p.installed.packageVersionGrant }"
              >
                <span class="ext-perm-label">{{ $t('settings.extensionsPolicy.packageVersionGrant') }}</span><span class="ext-perm-value">{{ formatPackageGrant(p.installed.packageVersionGrant) }}</span>
              </span>
            </details>
          </li>
        </ul>
        <ul class="ext-list">
          <li v-for="pack in packs" v-show="selectedId === `pack:${pack.id}`" :key="`pack:${pack.id}`" class="ext-installed ext-pack ext-card" :data-pack-id="pack.id">
            <MarketplaceIcon v-bind="idParts(pack.id)" :label="pack.displayName || idParts(pack.id).name" :size="36" />
            <div class="ext-card-main">
              <div class="ext-card-title">
                <span class="ext-id" v-truncate>{{ reveal(pack.displayName || pack.id) }}</span>
                <span class="ext-requires">{{ $t('settings.extensions.marketplace.versionLabel', { version: pack.version }) }}</span>
                <span class="ext-badge ext-pack-badge">{{ $t('settings.extensions.pack.membersBadge', { count: pack.members.length }) }}</span>
              </div>
              <div class="ext-card-sub">
                <span v-if="pack.displayName" class="ext-requires ext-pack-id">{{ reveal(pack.id) }}</span>
                <span class="ext-pack-includes">{{ $t('settings.extensions.pack.includes', { members: reveal(pack.members.join(' · ')) }) }}</span>
              </div>
            </div>
            <div class="ext-actions">
              <button
                class="ext-pack-remove nv-btn nv-btn--sm ext-btn-danger"
                :disabled="busy || updateFlow.busy.value"
                @click="uninstallingPack = pack"
              >
                {{ $t('settings.extensions.marketplace.uninstall') }}
              </button>
            </div>
          </li>
          <li v-for="p in nonFactoryInstalled" v-show="selectedId === p.id" :key="p.id" class="ext-installed ext-card" :data-id="p.id">
            <MarketplaceIcon v-bind="idParts(p.id)" :label="idParts(p.id).name" :size="36" />
            <div class="ext-card-main">
              <div class="ext-card-title">
                <span class="ext-id" v-truncate>{{ reveal(p.id) }}</span>
                <span v-if="p.packageVersion" class="ext-requires">{{ $t('settings.extensions.marketplace.versionLabel', { version: p.packageVersion }) }}</span>
              </div>
              <!-- One status line: risk, source and review, then any update, what
                 it adds, disabled and incompatible. -->
              <div class="ext-card-sub ext-card-status">
                <!-- The risk level from its disclosure leads the badges. -->
                <span
                  v-if="riskById.get(p.id)"
                  class="ext-badge ext-md-risk"
                  :class="`ext-md-risk--${riskById.get(p.id)}`"
                >{{ $t('pluginDisclosure.riskLabel', { level: $t(`pluginDisclosure.risk.${riskById.get(p.id)}`) }) }}</span>
                  <!-- K2: the Host's source only; none (an unknown channel) shows no badge.
                       A3: a signed local file names the publisher its id names, the one whose key signed it. -->
                  <!-- A2-3: a developer folder's badge opens its "Local folder" info card. -->
                  <button
                    v-if="p.source === 'developer-unpacked' && developerFolderOf(p.id)"
                    type="button"
                    class="ext-folder-info-toggle"
                    :aria-expanded="folderCardFor === p.id"
                    @click="toggleFolderCard(p.id)"
                  >
                    <PluginSourceBadge :source="p.source" />
                  </button>
                  <PluginSourceBadge
                    v-else-if="p.source"
                    :source="p.source"
                    :expires-at="p.expiresAt"
                    :via="p.testplaceVia"
                    :signature="p.localSignature"
                    :publisher="p.localSignature ? p.id.split('.')[0] : undefined"
                    :local-install="p.localInstall"
                  />
                  <!-- d5: Navide blocked the file this local install came from; the label stays.
                       0.2.28: a withdrawn Testplace build keeps its label the same way. -->
                  <span
                    v-if="p.digestBlock"
                    class="ext-badge ext-digest-blocked-badge"
                    :data-reason="p.digestBlock.reason ?? 'none'"
                    :title="$t(p.digestBlock.reason === 'testplace-withdrawn' ? 'settings.extensions.digestBlock.testplaceWithdrawnNote' : 'settings.extensions.digestBlock.note')"
                  >
                    {{ $t(`settings.extensions.digestBlock.${digestBlockKey(p.digestBlock.reason)}`) }}
                  </span>
                <span v-if="p.pendingCandidateVersion" class="ext-badge ext-candidate">
                  {{ $t('settings.extensions.candidateReady', { version: p.pendingCandidateVersion }) }}
                </span>
                <span v-else-if="updatesById.get(p.id)" class="ext-badge ext-update-badge">
                  {{ $t('settings.extensions.marketplace.updateAvailableVersion', { version: updatesById.get(p.id)?.latestVersion ?? '' }) }}
                </span>
                <!-- Plan B D2: from the Registry's listing, so labelled unverified;
                     the update itself asks only when the package adds permissions. -->
                <span
                  v-if="!p.pendingCandidateVersion && updatesById.get(p.id)?.permissionChange"
                  class="ext-badge ext-permission-change"
                  :class="`ext-permission-change--${updatesById.get(p.id)?.permissionChange}`"
                  :title="$t('pluginDisclosure.diff.badgeTitle')"
                >
                  {{ $t(updatesById.get(p.id)?.permissionChange === 'more' ? 'pluginDisclosure.diff.badgeMore' : 'pluginDisclosure.diff.badgeSame') }}
                </span>
                <span v-if="p.disabled" class="ext-badge ext-disabled-badge" :title="$t('settings.extensions.disabledNote')">
                  {{ $t('settings.extensions.disabledBadge') }}
                </span>
                <!-- Label only: the Host keeps running the package (no silent disable). -->
                <span
                  v-if="p.engineCompatible === false"
                  class="ext-badge ext-incompatible"
                  :title="$t('settings.extensions.incompatibleReason', { version: p.minNavideVersion ?? '' })"
                >
                  {{ $t('settings.extensions.incompatibleInstalled', { version: p.minNavideVersion ?? '' }) }}
                </span>
              </div>
              <ul v-if="riskReason(p.id)" class="ext-risk-reason">
                <li v-for="clause in riskClauses(p.id)" :key="clause">{{ clause }}</li>
              </ul>
              <!-- What it may use, next to why it is rated so: facts before actions. -->
              <div class="ext-card-sub">
                <span v-if="p.requires.length" class="ext-requires ext-caps">
                  <span
                    v-for="cap in p.requires"
                    :key="cap"
                    class="ext-cap"
                    :class="{ 'ext-cap--sensitive': p.sensitive.includes(cap) }"
                  >{{ cap }}</span>
                </span>
                <span v-if="p.sensitive.length" class="ext-badge ext-sensitive">
                  {{ $t('settings.extensionsPolicy.labeledValue', { label: $t('settings.extensions.sensitive'), value: p.sensitive.join(', ') }) }}
                </span>
                <!-- The Host's warning is English for its logs; the developer-mode
                     case is known and shown translated. -->
                <span v-if="p.warning" class="ext-badge ext-dev-warning">
                  {{ p.provenance === 'developer-local-unpacked' ? $t('settings.extensions.devUnpacked') : p.warning }}
                </span>
              </div>
              <!-- The actions right under the header, before the details. -->
              <div class="ext-actions">
                <button
                  v-if="!p.pendingCandidateVersion && updatesById.get(p.id)"
                  class="ext-update nv-btn nv-btn--primary nv-btn--sm"
                  :disabled="updateFlow.busy.value || busy"
                  @click="updateFlow.install(updatesById.get(p.id)!.namespace, updatesById.get(p.id)!.name, updatesById.get(p.id)!.latestVersion)"
                >
                  {{ $t('settings.extensions.marketplace.update') }}
                </button>
                <button
                  v-if="p.pendingCandidateVersion"
                  class="ext-restart nv-btn nv-btn--primary nv-btn--sm"
                  :disabled="busy || updateFlow.busy.value"
                  @click="restartPlugin(p.id)"
                >
                  {{ $t('settings.extensions.restartPlugin') }}
                </button>
                <!-- Card K4: reload a developer folder; changed permissions ask again. -->
                <button
                  v-if="p.provenance === 'developer-local-unpacked' && developerMode.folders.some((folder) => folder.pluginId === p.id)"
                  class="ext-devmode-reload nv-btn nv-btn--sm"
                  :disabled="busy || updateFlow.busy.value"
                  @click="updateFlow.reloadDeveloperPlugin(p.id)"
                >
                  {{ $t('settings.extensions.developerMode.reload') }}
                </button>
                <!-- D7: back to the Marketplace version; the install flow asks first. -->
                <button
                  v-if="p.source === 'local-unsigned' && !p.pendingCandidateVersion"
                  class="ext-back-to-marketplace nv-btn nv-btn--sm"
                  :disabled="busy || updateFlow.busy.value"
                  @click="updateFlow.install(idParts(p.id).namespace, idParts(p.id).name)"
                >
                  {{ $t('settings.extensions.localInstall.backToMarketplace') }}
                </button>
                <button
                  v-if="p.rollbackKind"
                  class="ext-rollback nv-btn nv-btn--sm"
                  :disabled="busy || updateFlow.busy.value"
                  @click="rollback(p.id, p.rollbackKind, p.rollbackToVersion, p.rollbackNeedsConsent === true)"
                >
                  {{
                    p.rollbackKind === 'factory'
                      ? $t('settings.extensions.rollback.toBundled')
                      : $t('settings.extensions.rollback.toVersion', { version: p.rollbackToVersion })
                  }}
                </button>
                <button
                  v-if="p.disabled === false"
                  class="ext-disable nv-btn nv-btn--sm"
                  :disabled="busy || updateFlow.busy.value"
                  @click="setDisabled(p.id, true)"
                >
                  {{ $t('settings.extensions.disable') }}
                </button>
                <button
                  v-else-if="p.disabled"
                  class="ext-enable nv-btn nv-btn--primary nv-btn--sm"
                  :disabled="busy || updateFlow.busy.value"
                  @click="setDisabled(p.id, false)"
                >
                  {{ $t('settings.extensions.enable') }}
                </button>
                <!-- `navide.` packages ship with Navide: they are disabled, never removed.
                     A Marketplace first-party package (navide.browser) is the
                     exception: the Host offers its Disabled switch, and it is
                     removed like any Marketplace package. -->
                <button
                  v-if="!isFirstPartyId(p.id) || p.disabled !== undefined"
                  class="ext-remove nv-btn nv-btn--sm ext-btn-danger"
                  :disabled="busy || updateFlow.busy.value"
                  @click="developerMode.folders.some((folder) => folder.pluginId === p.id) ? removeDeveloperFolder(p.id) : remove(p.id)"
                >
                  {{ $t('settings.extensions.marketplace.uninstall') }}
                </button>
              </div>
              <p v-if="p.disabled" class="ext-disabled-note">{{ $t('settings.extensions.disabledNote') }}</p>
              <p v-if="p.provenance === 'developer-local-unpacked' && folderLoadedByText(p.id)" class="ext-disabled-note ext-devmode-loaded-by">
                {{ folderLoadedByText(p.id) }}
              </p>
              <!-- G1: reload on file change (on by default), the last load, and a change that could not be read. -->
              <div v-if="p.provenance === 'developer-local-unpacked' && developerFolder(p.id)" class="ext-card-sub ext-devmode-auto">
                <label class="ext-devmode-auto-reload">
                  <input
                    type="checkbox"
                    :checked="developerFolder(p.id)?.autoReload !== false"
                    :disabled="busy"
                    @change="setFolderAutoReload(p.id, ($event.target as HTMLInputElement).checked)"
                  />
                  {{ $t('settings.extensions.developerMode.autoReload') }}
                </label>
                <span class="ext-requires ext-devmode-mixed-hint">{{ $t('settings.extensions.developerMode.autoReloadMixedHint') }}</span>
                <span v-if="lastLoadText(p.id)" class="ext-requires ext-devmode-last-load">{{ lastLoadText(p.id) }}</span>
                <span v-if="developerFolder(p.id)?.reloadError" class="ext-badge ext-dev-warning ext-devmode-reload-error">
                  {{ $t('settings.extensions.developerMode.reloadFailed', { error: reveal(developerFolder(p.id)?.reloadError ?? '') }) }}
                </span>
              </div>
              <DeveloperFolderInfoCard
                v-if="folderCardFor === p.id && developerFolderOf(p.id)"
                :folder="developerFolderOf(p.id)!"
                @close="folderCardFor = null"
              />
              <!-- D3: remind from 7 days before a test build expires; once kept past it, say so. -->
              <p v-if="p.source === 'testplace' && testplaceDaysLeft(p.expiresAt) !== null" class="ext-disabled-note ext-testplace-expiring" role="status">
                {{ $t('testplace.expiring', { days: testplaceDaysLeft(p.expiresAt), date: (p.expiresAt ?? '').slice(0, 10) }) }}
              </p>
              <p v-if="p.source === 'testplace' && isTestplaceExpired(p.expiresAt)" class="ext-disabled-note ext-testplace-kept">
                {{ $t('testplace.expired.kept') }}
              </p>
              <p v-if="p.engineCompatible === false" class="ext-incompatible-reason">
                {{ $t('settings.extensions.incompatibleReason', { version: p.minNavideVersion ?? '' }) }}
              </p>
              <!-- AI CLI sessions it keeps running after its window closed,
                   each with an End button; only for a plugin that declares aiCli. -->
              <PluginBackgroundAiSessions
                v-if="p.manifestPermissions?.system.includes('aiCli')"
                :plugin-id="p.id"
                :paused="selectedId !== p.id"
              />
              <details
                v-if="p.manifestPermissions || p.packageVersion"
                class="ext-permission-details"
                @toggle="onActivityToggle(p.id, $event)"
              >
                <summary>{{ p.provenance === 'official-registry' ? $t('settings.extensions.permissionDetailsWithActivity') : $t('settings.extensions.permissionDetails') }}</summary>
                <span v-if="p.manifestPermissions" class="ext-manifest-permissions">
                  <span class="ext-perm-label">{{ $t('settings.extensionsPolicy.manifestPermissions') }}</span><span class="ext-perm-value">{{ formatManifestPermissions(p.manifestPermissions) }}</span>
                </span>
                <span v-if="p.manifestPermissions?.scopes" class="ext-manifest-scopes" :title="formatManifestScopes(p.manifestPermissions)">
                  <span class="ext-perm-label">{{ manifestScopesLabel(p.manifestPermissions) }}</span>
                  <span
                    v-for="[key, patterns] in manifestScopeGroups(p.manifestPermissions)"
                    :key="key"
                    class="ext-scope-group"
                    :data-access="key"
                  >
                    <span class="ext-scope-kind">{{ $t(`settings.extensionsPolicy.${key}`) }}</span>
                    <span class="ext-globs"><code v-for="pattern in patterns" :key="pattern" class="ext-glob">{{ pattern }}</code></span>
                  </span>
                </span>
                <span
                  v-if="p.packageVersion"
                  class="ext-package-grant"
                  :class="{ 'ext-package-grant-none': !p.packageVersionGrant }"
                >
                  <span class="ext-perm-label">{{ $t('settings.extensionsPolicy.packageVersionGrant') }}</span><span class="ext-perm-value">{{ formatPackageGrant(p.packageVersionGrant) }}</span>
                </span>
                <!-- Plan B D-f: the plugin's activity, mounted (and read) only
                     while this section is open, so the page gains no element. -->
                <template v-if="p.provenance === 'official-registry' && activityOpen.has(p.id)">
                  <PluginActivityPanel :plugin-id="p.id" />
                  <button type="button" class="ext-activity-overview-link nv-btn nv-btn--sm" @click="emit('openDisclosureOverview')">
                    {{ $t('pluginActivity.openOverview') }}
                  </button>
                </template>
              </details>
            </div>
            <!-- A per-package update setting: under the actions, apart from them. -->
            <label v-if="p.getsPrereleases !== undefined" class="ext-prerelease-toggle">
              <input
                type="checkbox"
                class="nv-check"
                :checked="p.getsPrereleases"
                :disabled="busy || updateFlow.busy.value"
                @change="setPrerelease(p.id, ($event.target as HTMLInputElement).checked)"
              />
              {{ $t('settings.extensions.getPrereleases') }}
            </label>
            <!-- Its full disclosure record lives in the Disclosure overview;
                 this goes straight to its entry there. -->
            <button
              v-if="riskById.has(p.id)"
              type="button"
              class="ext-disclosure-link nv-btn nv-btn--ghost nv-btn--sm"
              @click="emit('openDisclosureOverview', p.id)"
            >
              {{ $t('pluginActivity.openOverview') }}
            </button>
          </li>
        </ul>
      </div>
    </div>

    <section v-show="props.page === 'developer'" class="ext-section ext-devmode" data-settings-section="extensions-developer-mode">
      <h3 class="ext-section-title">{{ $t('settings.extensions.developerMode.title') }}</h3>
      <!-- The same row as every other setting: what it does on the left, the switch on the right. -->
      <SettingsCard>
        <SettingRow :title="$t('settings.extensions.developerMode.switch')" :description="$t('settings.extensions.developerMode.hint')">
          <template #control>
            <ToggleSwitch
              class="ext-devmode-toggle"
              :model-value="developerMode.enabled"
              :disabled="busy"
              :aria-label="$t('settings.extensions.developerMode.switch')"
              @update:model-value="setDeveloperMode"
            />
          </template>
        </SettingRow>
      </SettingsCard>
      <button
        v-if="developerMode.enabled"
        class="ext-load-folder nv-btn nv-btn--sm"
        :disabled="busy || updateFlow.busy.value"
        @click="updateFlow.loadFromFolder()"
      >
        {{ $t('settings.extensions.developerMode.loadFolder') }}
      </button>
      <ul v-if="developerMode.enabled && unloadedFolders.length" class="ext-list ext-devmode-folders">
        <li v-for="folder in unloadedFolders" :key="folder.pluginId" class="ext-devmode-folder ext-card">
          <span class="ext-id" v-truncate>{{ reveal(folder.pluginId) }}</span>
          <code class="ext-devmode-path">{{ reveal(folder.path) }}</code>
          <span v-if="folder.unavailable" class="ext-badge ext-dev-warning ext-devmode-unavailable">{{ localizeDeveloperModeError(folder.unavailable, t) }}</span>
          <span v-else-if="folder.externallyChanged" class="ext-badge ext-dev-warning ext-devmode-external-folder">{{ $t('settings.extensions.developerMode.externallyChanged') }}</span>
          <!-- Review MED-3 on #543: a reload that unloaded the old version and could not load the new one. -->
          <span v-else-if="folder.reloadError" class="ext-badge ext-dev-warning ext-devmode-reload-error">
            {{ $t('settings.extensions.developerMode.reloadFailedNothingRunning', { error: reveal(folder.reloadError) }) }}
          </span>
          <span v-else class="ext-badge ext-dev-warning">{{ $t('settings.extensions.developerMode.needsConsent') }}</span>
          <button class="ext-devmode-reload nv-btn nv-btn--sm" :disabled="busy || updateFlow.busy.value" @click="updateFlow.reloadDeveloperPlugin(folder.pluginId)">
            {{ $t('settings.extensions.developerMode.reload') }}
          </button>
          <button class="ext-remove nv-btn nv-btn--sm ext-btn-danger" :disabled="busy" @click="removeDeveloperFolder(folder.pluginId)">
            {{ $t('settings.extensions.developerMode.removeFolder') }}
          </button>
        </li>
      </ul>
    </section>

    <div v-show="props.page === 'developer'">
      <NativeBackendPanel @on="(switches) => (nativeSwitchesOn = switches)" />
    </div>

    <PackUninstallDialog
      v-if="uninstallingPack"
      :pack="uninstallingPack"
      :busy="busy"
      @confirm="uninstallPack"
      @cancel="uninstallingPack = null"
    />
    <PluginTrustDialog
      v-if="updateFlow.pendingConfirm.value"
      :pending="updateFlow.pendingConfirm.value"
      :step="updateFlow.pendingStep.value"
      @confirm-replace="updateFlow.confirmReplace"
      @confirm-publisher="updateFlow.confirmPublisher"
      @confirm-risk="updateFlow.confirmRisk"
      @cancel="updateFlow.cancel"
    />
  </div>
</template>

<style scoped>
.ext-folder-info-toggle {
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
}
.extensions-pane {
  /* Native controls (checkboxes, scrollbars) follow the theme. */
  color-scheme: var(--nv-color-scheme);
  /* Horizontal gutter matches the settings page gutter so the pane lines up with
     the block above it on the same page; the page body owns the scroll, so this
     pane is a plain block. */
  padding: 0 22px var(--space-6);
  font-size: var(--font-sm);
}
/* ── List and detail ─────────────────────────────────────────────────────── */
.extensions-pane {
  container: ext-pane / inline-size;
}
.ext-md-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.ext-md-toolbar .ext-install-file {
  margin-left: auto;
}
.ext-md {
  display: grid;
  grid-template-columns: minmax(220px, 290px) minmax(0, 1fr);
  align-items: stretch;
  margin-bottom: var(--space-6);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-base);
}
/* The list stays in view while a long card scrolls past it. */
.ext-md-list {
  position: sticky;
  top: 0;
  padding: var(--space-3) var(--space-2);
  border-radius: var(--radius-md) 0 0 var(--radius-md);
  background: var(--bg-subtle);
}
.ext-md-list .ext-section {
  margin-bottom: var(--space-3);
}
.ext-md-list .ext-section:last-child {
  margin-bottom: 0;
}
/* In the list the group names are labels, a tier below the page blocks. */
.ext-md-list .ext-section-title {
  margin: 0 var(--space-2) var(--space-1);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0;
}
.ext-md-rows {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ext-md-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
.ext-md-row:hover {
  background: var(--bg-hover);
}
/* Selected is a filled row; keyboard focus keeps the outline, so the two never look alike. */
.ext-md-row[aria-current] {
  background: var(--bg-selected);
  box-shadow: inset 3px 0 0 var(--accent-emphasis);
}
.ext-md-row[aria-current] .ext-md-row-name {
  color: var(--accent-fg);
}
.ext-md-row:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: 1px;
}
.ext-md-row-text {
  display: grid;
  min-width: 0;
}
.ext-md-row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ext-md-row-name {
  color: var(--text-bright);
  font-weight: 600;
}
.ext-md-row-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
/* In the row, Disabled is a word in the status line, not a second badge. */
.ext-md-row-sub .ext-badge.ext-disabled-badge {
  height: auto;
  padding: 0;
  background: none;
  color: var(--risk-fg);
  font-weight: 600;
}
.ext-md-row-update {
  color: var(--accent-fg);
  white-space: nowrap;
}
.ext-md-row-end {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ext-md-source {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
}
/* Loaded by an agent: the folder mark carries the accent so it reads apart. */
.ext-md-source[data-loaded-by-agent] {
  border-color: var(--accent-emphasis);
  color: var(--accent-fg);
}
.ext-md-source svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}
/* "⚠ N": how many warnings the row's card carries; the label lists them. */
.ext-md-warn {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--risk-subtle);
  color: var(--risk-fg);
  font-size: var(--font-xs);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ext-md-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.ext-md-dot--active {
  background: var(--success-fg);
}
.ext-md-dot--off {
  background: var(--risk-fg);
}
/* One severity scale for the risk badges: low and caution tinted, High and Highest solid. */
.ext-badge.ext-md-risk {
  height: 20px;
  padding: 0 8px;
  font-size: var(--font-xs);
}
.ext-badge.ext-md-risk--low {
  background: var(--success-subtle);
  color: var(--success-fg);
}
.ext-badge.ext-md-risk--medium {
  background: var(--attention-subtle);
  color: var(--attention-fg);
}
.ext-badge.ext-md-risk--high {
  background: var(--warning-fg);
  color: var(--bg-base);
}
.ext-badge.ext-md-risk--highest {
  background: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.ext-md-list .ext-empty {
  margin: 0 var(--space-2);
  padding: var(--space-3);
  font-size: var(--font-xs);
  text-align: center;
}
.ext-md-detail {
  align-self: stretch;
  min-width: 0;
  padding: var(--space-4) var(--space-5);
  border-left: 1px solid var(--border-muted);
}
/* The detail side is the frame; the card inside it needs none of its own. */
.ext-md-detail .ext-installed,
.ext-md-detail .ext-installed:hover {
  padding: 0;
  border: 0;
  background: transparent;
}
@container ext-pane (max-width: 640px) {
  .ext-md {
    grid-template-columns: minmax(190px, 210px) minmax(0, 1fr);
  }
  .ext-md-detail .ext-actions > .nv-btn {
    padding-inline: 9px;
  }
  /* The list beside it already shows the icon; the card gives that column to
     its content so the action row fits on one line. */
  .ext-md-detail .ext-card {
    grid-template-columns: minmax(0, 1fr);
  }
  .ext-md-detail .ext-card > :first-child {
    display: none;
  }
  .ext-md-detail .ext-card.ext-installed > * {
    grid-column: 1;
  }
  .ext-md-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  /* The name keeps the whole first line; the version and the risk and warning
     marks share the second. */
  .ext-md-row {
    grid-template-columns: 22px minmax(0, 1fr) auto;
    grid-template-areas: 'icon name name' 'icon sub end';
    column-gap: 8px;
    row-gap: 2px;
  }
  .ext-md-row > :first-child {
    grid-area: icon;
    align-self: start;
    width: 22px;
    height: 22px;
  }
  .ext-md-row-text {
    display: contents;
  }
  .ext-md-row-name {
    grid-area: name;
  }
  .ext-md-row-sub {
    grid-area: sub;
  }
  .ext-md-row-end {
    grid-area: end;
  }
  .ext-md-detail {
    padding: var(--space-4);
  }
}
@container ext-pane (max-width: 480px) {
  .ext-md {
    grid-template-columns: minmax(0, 1fr);
  }
  .ext-md-list {
    position: static;
    border-bottom: 1px solid var(--border-muted);
    border-radius: var(--radius-md) var(--radius-md) 0 0;
  }
  .ext-md-detail {
    border-left: 0;
  }
}
.ext-error {
  margin: 0 0 10px;
  padding: 8px 10px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-sm);
  background: var(--danger-subtle);
  color: var(--danger-bright);
  font-size: var(--font-xs);
  white-space: pre-wrap;
  word-break: break-word;
}
.ext-section {
  margin-bottom: var(--space-6);
}
/* Bundled, Installed and Developer Mode are parts of the page in their own
   right (the jump links list them beside Execution Policy), so they share the
   page-block title size rather than the policy's sub-section size. */
.ext-section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  color: var(--text-bright);
  font-size: var(--font-lg);
  font-weight: 650;
  letter-spacing: -0.01em;
}
/* Row actions get the regular control height: they are the main targets here. */
.extensions-pane .nv-btn {
  min-height: var(--control-h-lg);
  padding-inline: 12px;
}
/* The house ring is an inset shadow in the accent colour, which disappears on
   the filled primary button; an offset outline shows on every variant. */
.extensions-pane .nv-btn:focus-visible,
.extensions-pane .nv-check:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: 2px;
}
.ext-install-file {
  margin-left: auto;
}
.ext-risk-banner {
  margin: 0 0 var(--space-3);
  padding: 8px 10px 8px 12px;
  border-left: 3px solid var(--risk-fg);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--risk-subtle);
  color: var(--risk-fg);
}
.ext-devmode .ext-load-folder {
  margin-top: var(--space-3);
}
.ext-devmode-folder {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.ext-devmode-path {
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  overflow-wrap: anywhere;
}
.ext-section-count {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.ext-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: var(--space-2);
}
.ext-installed {
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  transition: border-color var(--motion-fast) var(--ease-out);
}
.ext-installed:hover {
  border-color: var(--border-default);
}
/* A bundled row: name and state with its actions on one line, notes and the
   permissions table underneath at full width. */
.ext-factory {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  container: ext-row / inline-size;
}
.ext-factory > * {
  grid-column: 1 / -1;
}
.ext-factory > .ext-row-head {
  grid-column: 1;
  grid-row: 1;
}
.ext-factory > .ext-actions {
  grid-column: 1 / -1;
}
.ext-row-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
.ext-row-title {
  flex: 1;
  min-width: 0;
  display: grid;
}
.ext-row-title .ext-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Icon on the left; the name, badges and details beside it; the actions on
   their own row under the details, so a long action list never squeezes the
   name. The destructive action is pushed to the far end of that row. */
.ext-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: var(--space-2) var(--space-3);
}
.ext-card-main > .ext-actions {
  justify-content: flex-start;
  margin: var(--space-1) 0 var(--space-2);
}
.ext-card > .ext-prerelease-toggle {
  grid-column: 2;
}
.ext-card > .ext-disclosure-link {
  grid-column: 2;
  justify-self: start;
  color: var(--accent-fg);
}
/* A text link in the column's line, not an indented button. */
.extensions-pane .ext-disclosure-link.nv-btn {
  padding-inline: 0;
}
.ext-card-main > .ext-actions > .ext-btn-danger {
  margin-left: auto;
}
.ext-card-main {
  min-width: 0;
  display: grid;
  gap: 4px;
  container: ext-row / inline-size;
}
.ext-card-status {
  column-gap: 6px;
}
/* Three roles: the risk level is the one filled badge; states and warnings are
   outlined in their colour; capabilities are grey mono tokens. */
.ext-card-status > .ext-badge:not(.ext-md-risk),
.ext-card-status :deep(.nv-source-badge),
.ext-card-sub > .ext-badge.ext-sensitive,
.ext-card-sub > .ext-badge.ext-dev-warning {
  background: transparent;
  box-shadow: inset 0 0 0 1px currentColor;
}
/* Why the risk level: the disclosure's clauses, one per line, under the status. */
/* What it declares, neutral: colour is kept for the warnings themselves. */
.ext-risk-reason {
  display: grid;
  gap: 2px;
  margin: var(--space-1) 0 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  list-style: none;
  color: var(--text-primary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}
.ext-risk-reason > li::before {
  content: '•';
  margin-right: 6px;
  color: var(--text-secondary);
}
.ext-card-status:not(:has(> *)) {
  display: none;
}
.ext-card-title,
.ext-card-sub {
  display: flex;
  align-items: center;
  gap: 6px 8px;
  flex-wrap: wrap;
}
.ext-id {
  font-weight: 600;
  color: var(--text-bright);
  font-size: var(--font-md);
}
.ext-requires {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
.ext-caps {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ext-cap {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
}
/* A sensitive capability is the same grey token in bold; the "sensitive"
   badge beside it carries the warning colour. */
.ext-cap--sensitive {
  color: var(--text-bright);
  font-weight: 600;
}
.ext-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
.ext-factory .ext-actions {
  justify-content: flex-start;
}
/* Secondary actions share one outlined style; Uninstall only differs in
   its text colour. Update is the one filled button on a row. */
.ext-btn-danger {
  color: var(--danger-bright);
}
.ext-btn-danger:hover:not(:disabled) {
  border-color: var(--danger-muted);
  background: var(--danger-subtle);
  color: var(--danger-bright);
}
.ext-permission-details {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  line-height: 1.5;
}
.ext-permission-details summary {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: var(--control-h-lg);
  list-style: none;
  width: 100%;
  cursor: pointer;
  color: var(--text-primary);
  font-size: var(--font-sm);
  font-weight: 500;
  border-radius: var(--radius-xs);
}
.ext-permission-details summary::-webkit-details-marker {
  display: none;
}
/* The arrow turns as the section opens. */
.ext-permission-details summary::before {
  content: '';
  width: 5px;
  height: 5px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform var(--motion-base) var(--ease-out);
}
.ext-permission-details[open] summary::before {
  transform: rotate(45deg);
}
/* Opened content eases in on any engine (the ::details-content height
   transition above adds the slide where it is supported). */
.ext-permission-details[open] > :not(summary) {
  animation: ext-disclose var(--motion-base) var(--ease-out);
}
@keyframes ext-disclose {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: none; }
}
.ext-permission-details summary:hover {
  color: var(--text-primary);
}
.ext-permission-details summary:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: 2px;
}
.ext-permission-details {
  interpolate-size: allow-keywords;
}
.ext-permission-details::details-content {
  height: 0;
  overflow: clip;
  transition:
    height var(--motion-base) var(--ease-out),
    content-visibility var(--motion-base) allow-discrete;
}
.ext-permission-details[open]::details-content {
  height: auto;
}
.ext-permission-details[open] {
  display: grid;
  padding: var(--space-2) var(--space-3) var(--space-1);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  font-size: var(--font-xs);
}
.ext-permission-details[open] summary {
  margin-bottom: var(--space-1);
}
/* No grant is the common case for a version nobody has granted anything yet;
   keep it readable but quieter than an actual grant. */
.ext-package-grant-none {
  color: var(--text-secondary);
  font-style: italic;
}
.ext-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  font-weight: 600;
  white-space: nowrap;
}
.ext-badge.ext-sensitive,
.ext-badge.ext-dev-warning {
  color: var(--risk-fg);
  background: var(--risk-subtle);
}
.ext-badge.ext-candidate,
.ext-badge.ext-update-badge,
.ext-badge.ext-pack-badge {
  color: var(--accent-fg);
  background: var(--accent-subtle);
}
.ext-badge.ext-permission-change--more {
  color: var(--risk-fg);
  background: var(--risk-subtle);
}
.ext-badge.ext-permission-change--same {
  color: var(--text-secondary);
  background: var(--bg-subtle);
}
.ext-badge.ext-incompatible {
  color: var(--danger-bright);
  background: var(--danger-subtle);
}
/* Bundled state: a dot and a word, not a coloured pill. */
.ext-badge.ext-state {
  gap: 6px;
  padding: 0;
  color: var(--text-secondary);
  font-weight: 500;
}
.ext-badge.ext-state::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.ext-badge.ext-active {
  color: var(--success-fg);
}
.ext-badge.ext-removed {
  color: var(--risk-fg);
}
.ext-updates-summary {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: var(--font-2xs);
  font-weight: 600;
}
/* Opened permissions read as a two-column table: what is declared or granted
   on the left, the value on the right. Below 520px the label stacks on top. */
.ext-manifest-permissions,
.ext-manifest-scopes,
.ext-package-grant {
  display: grid;
  grid-template-columns: minmax(110px, 190px) minmax(0, 1fr);
  gap: 6px var(--space-3);
  align-items: baseline;
  padding: 6px 0;
  border-top: 1px solid var(--border-muted);
}
.ext-permission-details summary + * {
  border-top: 0;
}
.ext-perm-label {
  color: var(--text-secondary);
  font-weight: 500;
}
.ext-perm-value {
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.ext-scope-group {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  min-width: 0;
}
.ext-scope-group + .ext-scope-group {
  margin-top: 2px;
}
/* The access level leads each group; write access is in the bright text
   colour so it stands out from read-only reach without reading as a warning. */
.ext-scope-kind {
  flex: 0 0 auto;
  min-width: 92px;
  color: var(--text-secondary);
  font-weight: 600;
}
.ext-scope-group[data-access='scopeReadWrite'] .ext-scope-kind,
.ext-scope-group[data-access='scopeWriteOnly'] .ext-scope-kind {
  color: var(--text-bright);
}
.ext-globs {
  display: flex;
  flex: 1 1 0;
  flex-wrap: wrap;
  gap: 4px;
  min-width: min(100%, 160px);
}
.ext-glob {
  max-width: 100%;
  padding: 1px 6px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
@container ext-row (max-width: 640px) {
  .ext-manifest-permissions,
  .ext-manifest-scopes,
  .ext-package-grant {
    grid-template-columns: minmax(96px, 150px) minmax(0, 1fr);
  }
  .ext-scope-kind {
    flex-basis: 100%;
  }
}
@container ext-row (max-width: 520px) {
  .ext-manifest-permissions,
  .ext-manifest-scopes,
  .ext-package-grant {
    grid-template-columns: minmax(0, 1fr);
  }
  .ext-scope-group {
    grid-column: 1;
  }
}
/* The same warning triangle the Native backends callout uses, drawn from a mask
   so it takes the risk colour of the theme. */
.ext-risk-note::before {
  content: '';
  position: absolute;
  left: var(--space-3);
  top: calc(var(--space-2) + 2px);
  width: 14px;
  height: 14px;
  background: var(--risk-fg);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7.1 2.6 1.9 12a1 1 0 0 0 .9 1.5h10.4a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z'/%3E%3Cpath d='M8 6.2v3M8 11.3v.1'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7.1 2.6 1.9 12a1 1 0 0 0 .9 1.5h10.4a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z'/%3E%3Cpath d='M8 6.2v3M8 11.3v.1'/%3E%3C/svg%3E") center / contain no-repeat;
}
/* A first-party package's plain-language risk disclosure: a quiet callout,
   readable at body size, rather than a block of coloured text. */
.ext-lead {
  color: var(--text-bright);
  font-weight: 600;
}
.ext-risk-note {
  position: relative;
  margin: 0;
  padding: var(--space-2) var(--space-3) var(--space-2) calc(var(--space-3) + 22px);
  border-left: 2px solid var(--risk-fg);
  border-radius: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-sm);
  line-height: var(--lh-base);
}
.ext-incompatible-reason {
  margin: 0;
  color: var(--danger-bright);
  font-size: var(--font-xs);
}
.ext-badge.ext-disabled-badge {
  color: var(--risk-fg);
  background: var(--risk-subtle);
}
.ext-badge.ext-digest-blocked-badge {
  color: var(--danger-bright);
  background: var(--danger-subtle, var(--risk-subtle));
}
.ext-store-restored {
  margin: 0 0 var(--space-2, 8px);
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.ext-store-unreadable {
  margin: 0 0 var(--space-2, 8px);
  padding: 8px 10px;
  border: 1px solid var(--danger-bright);
  border-radius: 6px;
  color: var(--danger-bright);
  font-size: var(--font-xs);
}
.ext-store-unreadable p {
  margin: 0 0 6px;
}
.ext-switch-busy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.ext-switch-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ext-switch-spin 0.8s linear infinite;
}
@keyframes ext-switch-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .ext-switch-spinner { animation: none; }
}
.ext-disabled-note {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.ext-pack-includes {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.ext-prerelease-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: max-content;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
}
.ext-empty {
  color: var(--text-secondary);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
}
/* Long setting descriptions keep a readable line length. */
:deep(.setting-row-desc) {
  max-width: 72ch;
  line-height: var(--lh-base);
}
</style>
