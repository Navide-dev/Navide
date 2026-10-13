<script setup lang="ts">
// Marketplace view: browses the registry, shows an extension's detail page and
// installs / updates / uninstalls it. Split out of ExtensionsPane so the
// Extensions page can carry the execution policy and the local inventory,
// while browsing and installing lives on its own page.
//
// Sensitive capabilities, an unknown publisher and native backend executables
// trigger the confirmation dialog after verification but before the package is
// written (usePluginInstallFlow). All privileged work is brokered through the
// main process via `window.agentTeam.plugins`; this component holds no secrets
// and never touches package bytes. README text is rendered as Vue text nodes
// (no v-html), so a package cannot inject markup into the settings window.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { InlineText, renderLines } from '../editor/markdownRender'
import { usePluginInventory } from '../composables/usePluginInventory'
import { usePluginUpdates } from '../composables/usePluginUpdates'
import { ipcErrorMessage, usePluginInstallFlow } from '../composables/usePluginInstallFlow'
import PluginTrustDialog from './PluginTrustDialog.vue'
import MarketplaceIcon from './MarketplaceIcon.vue'
import PackInstallDialog from './PackInstallDialog.vue'
import { usePackInstallFlow } from '../composables/usePackInstallFlow'
import { useConfirmedExternalLink } from '../composables/useConfirmedExternalLink'
import { marketplaceDetailRequest, takeMarketplaceDetailRequest } from '../marketplaceDeepLink'

type Sort = 'downloads' | 'updated' | 'rating'

// Installing writes to the inventory the Extensions page renders, so it goes
// through the shared store rather than a list of this pane's own.
const inventory = usePluginInventory()
const pluginUpdates = usePluginUpdates()
const flow = usePluginInstallFlow()
const packFlow = usePackInstallFlow()
const { locale, t, te } = useI18n()
const openLink = useConfirmedExternalLink()
const numberFormat = computed(() => new Intl.NumberFormat(locale.value))
function formatCount(value: number): string {
  return numberFormat.value.format(value)
}

function pluginsApi() {
  return window.agentTeam?.plugins
}

const PAGE_SIZE = 20

const results = ref<MarketplaceExtension[]>([])
const total = ref(0)
const query = ref('')
const sort = ref<Sort>('downloads')
const listState = ref<'loading' | 'ready' | 'error'>('loading')
const listError = ref('')
const loadingMore = ref(false)
const loadMoreError = ref('')
// The Registry's closed category list; empty (no chips) when it has none.
const categories = ref<MarketplaceCategory[]>([])
const category = ref('')
const hideIncompatible = ref(false)

const selected = ref<MarketplaceExtension | null>(null)
const detail = ref<MarketplaceExtensionDetail | null>(null)
const detailState = ref<'loading' | 'ready' | 'error'>('loading')
const detailError = ref('')

const installedById = computed(
  () => new Map(inventory.installed.value.map((plugin) => [plugin.id, plugin]))
)
const updatesById = computed(
  () => new Map(pluginUpdates.updates.value.map((update) => [update.id, update]))
)

function idOf(ext: { namespace: string; name: string }): string {
  return `${ext.namespace}.${ext.name}`
}

function searchOptions(offset: number) {
  return {
    ...(category.value ? { category: category.value } : {}),
    offset,
    limit: PAGE_SIZE,
    hideIncompatible: hideIncompatible.value,
  }
}

// Typing searches on its own once the user pauses; Enter and the Search
// button search at once and drop the pending one, so a query never fires
// twice. v-model only updates after IME composition ends, so a half-typed
// CJK word does not search either.
const SEARCH_DEBOUNCE_MS = 250
let searchTimer: ReturnType<typeof setTimeout> | null = null
function cancelPendingSearch(): void {
  if (searchTimer !== null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
}
watch(query, () => {
  cancelPendingSearch()
  searchTimer = setTimeout(() => {
    searchTimer = null
    void search()
  }, SEARCH_DEBOUNCE_MS)
})
onBeforeUnmount(cancelPendingSearch)

function clearQuery(): void {
  query.value = ''
  void search()
}

// A failed search shows the error, never the previous page's results: the
// listing (and its compatibility verdicts) may be stale.
async function search(): Promise<void> {
  cancelPendingSearch()
  const api = pluginsApi()
  if (!api) return
  listState.value = 'loading'
  listError.value = ''
  loadMoreError.value = ''
  try {
    const res = await api.marketplaceSearch(query.value || undefined, sort.value, searchOptions(0))
    results.value = res.items
    total.value = res.total
    listState.value = 'ready'
  } catch (err) {
    results.value = []
    total.value = 0
    listError.value = ipcErrorMessage(err)
    listState.value = 'error'
  }
}

async function loadMore(): Promise<void> {
  const api = pluginsApi()
  if (!api || loadingMore.value) return
  loadingMore.value = true
  loadMoreError.value = ''
  try {
    const res = await api.marketplaceSearch(
      query.value || undefined,
      sort.value,
      searchOptions(results.value.length)
    )
    // Skip rows already shown: the ranking may shift between pages.
    const seen = new Set(results.value.map((ext) => ext.identity))
    results.value = [...results.value, ...res.items.filter((ext) => !seen.has(ext.identity))]
    total.value = res.total
  } catch (err) {
    loadMoreError.value = ipcErrorMessage(err)
  } finally {
    loadingMore.value = false
  }
}

async function loadCategories(): Promise<void> {
  const api = pluginsApi()
  if (!api?.marketplaceCategories) return
  try {
    categories.value = await api.marketplaceCategories()
  } catch {
    categories.value = []
  }
}

function selectCategory(slug: string): void {
  if (category.value === slug) return
  category.value = slug
  void search()
}

function categoryLabel(item: Pick<MarketplaceCategory, 'slug' | 'label'>): string {
  const key = `settings.extensions.marketplace.category.${item.slug}`
  return te(key) ? t(key) : item.label
}

// The Registry's own featured flag, shown as a shelf above the list when the
// user is browsing everything (not while searching or filtering).
const featured = computed(() =>
  !query.value && !category.value && listState.value === 'ready'
    ? results.value.filter((ext) => ext.featured).slice(0, 3)
    : []
)

// The list under the shelf leaves out what the shelf already shows.
const listResults = computed(() => {
  if (!featured.value.length) return results.value
  const shelved = new Set(featured.value.map((ext) => ext.identity))
  return results.value.filter((ext) => !shelved.has(ext.identity))
})

// Install progress: which row's Install was pressed, so that row (and only
// that row) shows it is working.
const installingId = ref<string | null>(null)
async function installFrom(namespace: string, name: string, version?: string): Promise<void> {
  installingId.value = `${namespace}.${name}`
  try {
    await flow.install(namespace, name, version)
  } finally {
    installingId.value = null
  }
}
function isInstalling(id: string): boolean {
  return installingId.value === id && flow.busy.value
}

function isIncompatible(ext: { compatible?: boolean | null }): boolean {
  return ext.compatible === false
}

async function openDetail(ext: MarketplaceExtension): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  selected.value = ext
  detail.value = null
  detailState.value = 'loading'
  detailError.value = ''
  showCompatibleOnly.value = false
  changelog.value = null
  changelogState.value = 'idle'
  detailTab.value = 'readme'
  try {
    detail.value = await api.marketplaceDetail({ namespace: ext.namespace, name: ext.name })
    detailState.value = 'ready'
  } catch (err) {
    detailError.value = ipcErrorMessage(err)
    detailState.value = 'error'
  }
}

function closeDetail(): void {
  selected.value = null
  detail.value = null
}

// The row install would pick: the main process names the newest version with
// an artifact for this Host and marks which rows it can install, so the
// renderer never chooses among per-target rows itself.
const installableVersionInfo = computed(() => {
  const d = detail.value
  if (!d?.latest_installable_version) return null
  return (
    d.versions.find(
      (v) => v.version === d.latest_installable_version && v.installable && !v.yanked
    ) ?? null
  )
})
// What the header shows: the installable row, else (nothing for this Host) the
// Registry's latest row, for display only.
const latestVersionInfo = computed(() => {
  const d = detail.value
  if (!d) return null
  return (
    installableVersionInfo.value ??
    d.versions.find((v) => v.version === d.latest_version && !v.yanked) ??
    null
  )
})
// The Registry's latest version has no artifact for this Host. A different
// install candidate alone does not mean that: with "Get pre-releases" on, the
// candidate is a newer pre-release while the latest stable is still installable.
const latestUnavailable = computed(() => {
  const d = detail.value
  if (!d?.latest_version) return false
  return !d.versions.some((v) => v.version === d.latest_version && v.installable && !v.yanked)
})
const latestTargets = computed(() => {
  const d = detail.value
  if (!d) return ''
  return d.versions
    .filter((v) => v.version === d.latest_version && !v.yanked)
    .map((v) => v.target)
    .join(', ')
})

// D1: an incompatible latest version is shown with Install disabled; the
// banner offers the older versions this Navide release can run.
const latestIncompatible = computed(() => installableVersionInfo.value?.compatible === false)
const showCompatibleOnly = ref(false)
const shownVersions = computed(() => {
  const rows = detail.value?.versions ?? []
  return showCompatibleOnly.value
    ? rows.filter((v) => v.installable && !v.yanked && v.compatible !== false)
    : rows
})
// "Works with" describes one version: the one Install would install, else the
// Registry's latest. Its platforms and its minimum Navide version, so neither
// mixes in what only an older version supports.
const worksWithVersion = computed(() => installableVersionInfo.value?.version ?? detail.value?.latest_version ?? null)
const worksWithRows = computed(() =>
  (detail.value?.versions ?? []).filter((v) => v.version === worksWithVersion.value && !v.yanked)
)
const worksWithTargets = computed(() => [...new Set(worksWithRows.value.map((v) => v.target))].sort())
const worksWithMinNavide = computed(() => worksWithRows.value.find((v) => v.min_navide_version)?.min_navide_version ?? null)

// D2 header note: with the switch on and a newer pre-release as the install
// candidate, say so next to the stable version the header keeps showing.
const prereleaseCandidate = computed(() => {
  const info = installableVersionInfo.value
  return detail.value?.gets_prereleases && info?.channel === 'pre-release' ? info.version : null
})

const changelog = ref<string | null>(null)
const changelogState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const changelogLines = computed(() => (changelog.value ? renderLines(changelog.value) : []))
// D2: the "Get pre-releases" switch for this extension. The main process
// answers the detail with its install candidates already honouring it, so the
// detail is re-read after a change.
const hasPrereleases = computed(() => (detail.value?.versions ?? []).some((v) => v.channel === 'pre-release'))
const prereleaseBusy = ref(false)
async function setPrerelease(enabled: boolean): Promise<void> {
  const api = pluginsApi()
  const current = selected.value
  const d = detail.value
  if (!api?.setPrerelease || !current || !d) return
  prereleaseBusy.value = true
  try {
    await api.setPrerelease(idOf(d), enabled)
    const next = await api.marketplaceDetail({ namespace: d.namespace, name: d.name })
    if (selected.value === current) detail.value = next
    void inventory.refresh()
    void pluginUpdates.refresh()
  } catch (err) {
    detailError.value = ipcErrorMessage(err)
  } finally {
    prereleaseBusy.value = false
  }
}

// Extension Pack detail: each member's name, version and permissions, shown
// before anything is installed (display only; each member is verified on its
// own when the pack is installed).
// One label for a permission chip everywhere (pack detail, permissions, the
// pack install dialog): "fs · sensitive" for a sensitive one, else "ui".
function capLabel(cap: string, sensitive: boolean): string {
  return sensitive ? `${cap} · ${t('settings.extensions.sensitive')}` : cap
}

function isPack(ext: { extension_pack?: string[] | null }): boolean {
  return Array.isArray(ext.extension_pack) && ext.extension_pack.length > 0
}
const packMembers = ref<PackMemberSummary[]>([])
// One count for every place a pack's size shows: the members it declares,
// those that will be reviewed and installed, those already installed, and
// those skipped (missing, nested, unavailable, incompatible, unreadable).
const packCounts = computed(() => {
  const members = packMembers.value
  const ready = members.filter((m) => m.status === 'ready').length
  const installed = members.filter((m) => m.status === 'installed').length
  return { total: members.length, ready, installed, skipped: members.length - ready - installed }
})
watch(detail, async (d) => {
  packMembers.value = []
  const api = pluginsApi()
  if (!d || !isPack(d) || !api?.marketplacePackMembers) return
  try {
    const members = await api.marketplacePackMembers(d.extension_pack ?? [])
    if (detail.value === d) packMembers.value = members
  } catch {
    packMembers.value = []
  }
})

// Detail tabs: README, Changelog (when the package has one) and Versions.
// Every panel stays rendered (v-show) so switching never refetches; the
// changelog is fetched the first time its tab opens.
type DetailTab = 'readme' | 'changelog' | 'versions'
const detailTab = ref<DetailTab>('readme')
const detailTabs = computed<DetailTab[]>(() =>
  detail.value?.has_changelog ? ['readme', 'changelog', 'versions'] : ['readme', 'versions']
)
function tabLabel(tab: DetailTab): string {
  return t(`settings.extensions.marketplace.${tab === 'readme' ? 'readme' : tab}`)
}
function selectTab(tab: DetailTab): void {
  detailTab.value = tab
  if (tab === 'changelog') void loadChangelog()
}
const tabButtons = ref<HTMLButtonElement[]>([])
// One underline that slides to the selected tab.
const tabIndicator = ref({ left: 0, width: 0 })
function measureTab(): void {
  const index = detailTabs.value.indexOf(detailTab.value)
  const button = tabButtons.value[index]
  if (button) tabIndicator.value = { left: button.offsetLeft, width: button.offsetWidth }
}
watch([detailTab, detailState, detailTabs], () => void nextTick(measureTab))
// Arrow keys move between tabs (WAI-ARIA tabs pattern, automatic activation).
function onTabKeydown(event: KeyboardEvent): void {
  const tabs = detailTabs.value
  const index = tabs.indexOf(detailTab.value)
  const next =
    event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
            : -1
  if (next < 0) return
  event.preventDefault()
  selectTab(tabs[next])
  void nextTick(() => tabButtons.value[next]?.focus())
}

async function loadChangelog(): Promise<void> {
  const api = pluginsApi()
  const d = detail.value
  if (!api?.marketplaceChangelog || !d) return
  if (changelogState.value === 'loading' || changelogState.value === 'ready') return
  changelogState.value = 'loading'
  try {
    changelog.value = await api.marketplaceChangelog({ namespace: d.namespace, name: d.name })
    changelogState.value = 'ready'
  } catch {
    changelogState.value = 'error'
  }
}

const readmeLines = computed(() => {
  const d = detail.value
  if (!d?.readme) return []
  const lines = renderLines(d.readme)
  const first = lines[0]
  const title = (d.display_name || d.name).trim().toLowerCase()
  // The hero already shows the name; a README that opens with it again is skipped.
  return first?.kind === 'heading' && first.text.trim().toLowerCase() === title ? lines.slice(1) : lines
})

function formatDate(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

onMounted(() => {
  void inventory.refresh()
  void pluginUpdates.refresh()
  void loadCategories()
  void search()
})

// A navide://extension/<id> link (App.vue) names an extension to show. It only
// opens the ordinary detail page: Install stays the user's own press (D4).
watch(
  marketplaceDetailRequest,
  (request) => {
    if (!request) return
    const target = takeMarketplaceDetailRequest()
    if (target) void openDetail(target as MarketplaceExtension)
  },
  { immediate: true }
)
</script>

<template>
  <div class="marketplace-pane">
    <p v-if="flow.error.value" class="ext-error" role="alert">{{ flow.error.value }}</p>
    <p v-if="packFlow.error.value" class="ext-error mkt-pack-error" role="alert">{{ packFlow.error.value }}</p>

    <!-- Detail view -->
    <section v-if="selected" class="mkt-detail" :data-detail-id="idOf(selected)">
      <button class="mkt-back nv-btn nv-btn--ghost nv-btn--sm" @click="closeDetail">
        ← {{ $t('settings.extensions.marketplace.back') }}
      </button>

      <div v-if="detailState === 'loading'" class="mkt-detail-skeleton" aria-hidden="true">
        <span class="mkt-sk mkt-sk--tile-lg"></span>
        <span class="mkt-sk-lines">
          <span class="mkt-sk mkt-sk--title"></span>
          <span class="mkt-sk mkt-sk--line"></span>
          <span class="mkt-sk mkt-sk--line mkt-sk--short"></span>
        </span>
      </div>
      <p v-if="detailState === 'loading'" class="mkt-loading mkt-sr-status" role="status">
        {{ $t('settings.extensions.marketplace.loadingDetail') }}
      </p>
      <div v-else-if="detailState === 'error'" class="ext-error mkt-detail-error mkt-state" role="alert">
        <span class="mkt-sigil mkt-sigil--danger" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="M8 4.2v4.6M8 11.3v.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        </span>
        <span class="mkt-state-body">{{ $t('settings.extensions.marketplace.detailFailed', { error: detailError }) }}</span>
        <button class="mkt-retry nv-btn nv-btn--primary nv-btn--sm" @click="openDetail(selected)">
          {{ $t('settings.extensions.marketplace.retry') }}
        </button>
      </div>

      <template v-else-if="detail">
        <header class="mkt-detail-head">
          <div class="mkt-hero">
            <MarketplaceIcon
              :namespace="detail.namespace"
              :name="detail.name"
              :label="detail.display_name || detail.name"
              :version="detail.latest_version"
              :path="detail.icon_path"
              :size="64"
            />
            <div class="mkt-hero-text">
              <div class="mkt-detail-title">
                <h3>{{ detail.display_name || detail.name }}</h3>
                <span v-if="isPack(detail)" class="mkt-badge mkt-badge--accent mkt-pack-badge">
                  {{ $t('settings.extensions.pack.badge') }}
                </span>
              </div>
              <div class="mkt-detail-id">
                <span class="mkt-muted">{{ idOf(detail) }}</span>
              </div>
              <div class="mkt-meta">
                <i18n-t keypath="settings.extensionsPolicy.labeledValue" tag="span" scope="global">
                  <template #label>{{ $t('settings.extensions.marketplace.publisher') }}</template>
                  <template #value><strong>{{ detail.publisher }}</strong></template>
                </i18n-t>
                <span v-if="detail.latest_version">{{ $t('settings.extensions.marketplace.versionLabel', { version: detail.latest_version }) }}</span>
                <span v-if="prereleaseCandidate" class="mkt-badge mkt-badge--warn mkt-prerelease-note">
                  {{ $t('settings.extensions.marketplace.prereleaseAvailable', { version: prereleaseCandidate }) }}
                </span>
                <span>{{ $t('settings.extensions.marketplace.downloads', { count: formatCount(detail.download_count) }) }}</span>
                <span v-if="detail.rating_count > 0" class="mkt-rating">
                  {{
                    $t('settings.extensions.marketplace.rating', {
                      average: detail.rating_average.toFixed(1),
                      count: detail.rating_count,
                    })
                  }}
                </span>
                <span v-else class="mkt-rating">{{ $t('settings.extensions.marketplace.noRating') }}</span>
                <span
                  v-if="latestVersionInfo"
                  class="mkt-badge mkt-trust"
                  :class="latestVersionInfo.trust_tier === 'signed-verified' ? 'mkt-badge--ok' : 'mkt-badge--warn mkt-badge--unsigned'"
                >
                  {{
                    latestVersionInfo.trust_tier === 'signed-verified'
                      ? $t('settings.extensions.trust.signed')
                      : $t('settings.extensions.trust.unsigned')
                  }}
                </span>
              </div>
            </div>
          </div>
          <p v-if="detail.description" class="mkt-desc">{{ detail.description }}</p>
          <div class="mkt-actions">
            <button
              v-if="isPack(detail)"
              class="mkt-pack-install nv-btn nv-btn--primary"
              :disabled="packFlow.busy.value || flow.busy.value"
              @click="packFlow.start(detail.namespace, detail.name)"
            >
              {{ $t('settings.extensions.pack.install', { count: detail.extension_pack?.length ?? 0 }) }}
            </button>
            <template v-else-if="installedById.get(idOf(detail))">
              <button
                v-if="updatesById.get(idOf(detail))"
                class="ext-update nv-btn nv-btn--primary"
                :disabled="flow.busy.value"
                @click="flow.install(detail.namespace, detail.name, updatesById.get(idOf(detail))?.latestVersion)"
              >
                {{
                  $t('settings.extensions.marketplace.updateTo', {
                    version: updatesById.get(idOf(detail))?.latestVersion ?? '',
                  })
                }}
              </button>
              <span class="mkt-badge mkt-badge--ok mkt-installed">
                {{
                  $t('settings.extensions.marketplace.installedVersion', {
                    version: installedById.get(idOf(detail))?.packageVersion ?? '',
                  })
                }}
              </span>
              <button
                class="ext-uninstall nv-btn nv-btn--ghost mkt-btn-danger-ghost"
                :disabled="flow.busy.value"
                @click="flow.uninstall(idOf(detail))"
              >
                {{ $t('settings.extensions.marketplace.uninstall') }}
              </button>
            </template>
            <button
              v-else-if="installableVersionInfo"
              class="ext-install nv-btn nv-btn--primary"
              :class="{ 'is-working': isInstalling(idOf(detail)) }"
              :disabled="flow.busy.value || latestIncompatible"
              :aria-busy="isInstalling(idOf(detail))"
              @click="installFrom(detail.namespace, detail.name, installableVersionInfo.version)"
            >
              <span v-if="isInstalling(idOf(detail))" class="mkt-spinner" aria-hidden="true"></span>
              <!-- Name the version when it is not the one the header shows, and
                   say so when it is a pre-release. -->
              <template v-if="isInstalling(idOf(detail))">{{ $t('settings.extensions.marketplace.installing') }}</template>
              <template v-else>{{
                installableVersionInfo.channel === 'pre-release'
                  ? $t('settings.extensions.marketplace.installPrerelease', { version: installableVersionInfo.version })
                  : installableVersionInfo.version === detail.latest_version
                    ? $t('settings.extensions.install')
                    : $t('settings.extensions.marketplace.installVersion', { version: installableVersionInfo.version })
              }}</template>
            </button>
            <label v-if="hasPrereleases" class="mkt-prerelease-toggle">
              <input
                type="checkbox"
                class="nv-check"
                :checked="detail.gets_prereleases === true"
                :disabled="prereleaseBusy || flow.busy.value"
                @change="setPrerelease(($event.target as HTMLInputElement).checked)"
              />
              {{ $t('settings.extensions.getPrereleases') }}
            </label>
          </div>
          <p
            v-if="latestUnavailable"
            class="mkt-unavailable mkt-callout mkt-callout--risk"
          >
            {{
              $t('settings.extensions.marketplace.unavailableDetail', {
                version: detail.latest_version,
                host: detail.host_target,
                targets: latestTargets,
              })
            }}
          </p>
          <div v-if="latestIncompatible && installableVersionInfo" class="mkt-incompatible-banner mkt-callout mkt-callout--risk" role="alert">
            <span>
              <!-- Installed already: there is no Install to disable, so say what
                   the installed version needs instead. -->
              {{
                installedById.get(idOf(detail))
                  ? $t('settings.extensions.marketplace.incompatibleInstalledDetail', {
                    version: installedById.get(idOf(detail))?.packageVersion ?? installableVersionInfo.version,
                    min: installableVersionInfo.min_navide_version ?? '',
                    current: detail.app_version ?? '',
                  })
                  : $t('settings.extensions.marketplace.incompatibleDetail', {
                    version: installableVersionInfo.version,
                    min: installableVersionInfo.min_navide_version ?? '',
                    current: detail.app_version ?? '',
                  })
              }}
              <template v-if="detail.latest_compatible_version">
                {{ $t('settings.extensions.marketplace.olderCompatible', { version: detail.latest_compatible_version }) }}
              </template>
            </span>
            <button
              v-if="detail.latest_compatible_version && !showCompatibleOnly"
              class="mkt-show-compatible nv-btn nv-btn--sm"
              @click="showCompatibleOnly = true; selectTab('versions')"
            >
              {{ $t('settings.extensions.marketplace.showCompatible') }}
            </button>
          </div>
        </header>

        <section v-if="isPack(detail)" class="mkt-block mkt-pack-members">
          <h4>{{ $t('settings.extensions.pack.membersTitle') }}</h4>
          <p v-if="packMembers.length" class="mkt-pack-counts">
            {{ $t('settings.extensions.pack.countsLine', packCounts) }}
          </p>
          <ul class="mkt-pack-list">
            <li
              v-for="m in packMembers"
              :key="m.id"
              class="mkt-pack-member"
              :class="{ 'mkt-pack-member--skipped': m.status !== 'ready' && m.status !== 'installed' }"
              :data-member="m.id"
            >
              <MarketplaceIcon
                :namespace="m.id.slice(0, m.id.indexOf('.'))"
                :name="m.id.slice(m.id.indexOf('.') + 1)"
                :label="m.display_name || m.id"
                :size="32"
              />
              <div class="mkt-pack-member-main">
                <span class="mkt-pack-member-name" v-truncate>{{ m.display_name || m.id }}</span>
                <span class="mkt-muted mkt-pack-member-id" v-truncate>
                  {{ m.version ? `${m.id} · ${m.version}` : m.id }}
                </span>
              </div>
              <div class="mkt-pack-member-caps">
                <span
                  v-for="cap in m.capabilities"
                  :key="cap"
                  class="mkt-pack-cap"
                  :class="{ 'mkt-pack-cap--sensitive': m.sensitive_capabilities.includes(cap) }"
                >
                  {{ capLabel(cap, m.sensitive_capabilities.includes(cap)) }}
                </span>
              </div>
              <span
                v-if="m.status !== 'ready'"
                class="mkt-badge mkt-pack-status"
                :class="m.status === 'installed' ? 'mkt-badge--muted' : 'mkt-badge--warn'"
              >
                {{ $t(`settings.extensions.pack.status.${m.status}`, { version: m.min_navide_version ?? '' }) }}
              </span>
            </li>
          </ul>
          <p class="nv-hint">{{ $t('settings.extensions.pack.membersNote') }}</p>
        </section>
        <div class="mkt-detail-body">
          <div class="mkt-detail-main">
            <div class="mkt-tabs" role="tablist" :aria-label="$t('settings.extensions.marketplace.detailTabs')" @keydown="onTabKeydown">
              <button
                v-for="tab in detailTabs"
                :id="`mkt-tab-${tab}`"
                :key="tab"
                ref="tabButtons"
                class="mkt-tab"
                :class="{ 'mkt-tab--active': detailTab === tab, 'mkt-changelog-toggle': tab === 'changelog' }"
                role="tab"
                :aria-selected="detailTab === tab"
                :aria-controls="`mkt-panel-${tab}`"
                :tabindex="detailTab === tab ? 0 : -1"
                @click="selectTab(tab)"
              >
                {{ tabLabel(tab) }}
              </button>
              <span
                class="mkt-tab-indicator"
                aria-hidden="true"
                :style="{ width: `${tabIndicator.width}px`, transform: `translateX(${tabIndicator.left}px)` }"
              ></span>
            </div>

            <section
              id="mkt-panel-readme"
              v-show="detailTab === 'readme'"
              class="mkt-panel mkt-block"
              role="tabpanel"
              aria-labelledby="mkt-tab-readme"
            >
              <div v-if="readmeLines.length" class="mkt-readme">
                <template v-for="(line, i) in readmeLines" :key="i">
                  <pre v-if="line.kind === 'codeblock'" class="mkt-code"><code>{{ line.text }}</code></pre>
                  <component :is="line.level <= 2 ? 'h3' : 'h4'" v-else-if="line.kind === 'heading'" class="mkt-md-h">
                    <InlineText :text="line.text" />
                  </component>
                  <div v-else-if="line.kind === 'bullet'" class="mkt-md-li mkt-md-li--bullet"><InlineText :text="line.text" /></div>
                  <div v-else-if="line.kind === 'ordered'" class="mkt-md-li"><span class="mkt-md-marker">{{ line.marker }}</span> <InlineText :text="line.text" /></div>
                  <blockquote v-else-if="line.kind === 'quote'" class="mkt-md-quote"><InlineText :text="line.text" /></blockquote>
                  <p v-else-if="line.kind === 'paragraph'" class="mkt-md-p"><InlineText :text="line.text" /></p>
                </template>
              </div>
              <p v-else class="nv-hint mkt-no-readme">{{ $t('settings.extensions.marketplace.noReadme') }}</p>
            </section>

            <section
              v-if="detail.has_changelog"
              id="mkt-panel-changelog"
              v-show="detailTab === 'changelog'"
              class="mkt-panel mkt-block mkt-changelog"
              role="tabpanel"
              aria-labelledby="mkt-tab-changelog"
            >
              <p v-if="changelogState === 'loading' || changelogState === 'idle'" class="nv-loading">{{ $t('settings.extensions.marketplace.loadingDetail') }}</p>
              <p v-else-if="changelogState === 'error'" class="ext-error">{{ $t('settings.extensions.marketplace.changelogFailed') }}</p>
              <div v-else-if="changelogLines.length" class="mkt-readme">
                <template v-for="(line, i) in changelogLines" :key="i">
                  <pre v-if="line.kind === 'codeblock'" class="mkt-code"><code>{{ line.text }}</code></pre>
                  <component :is="line.level <= 2 ? 'h3' : 'h4'" v-else-if="line.kind === 'heading'" class="mkt-md-h">
                    <InlineText :text="line.text" />
                  </component>
                  <div v-else-if="line.kind === 'bullet'" class="mkt-md-li mkt-md-li--bullet"><InlineText :text="line.text" /></div>
                  <div v-else-if="line.kind === 'ordered'" class="mkt-md-li"><span class="mkt-md-marker">{{ line.marker }}</span> <InlineText :text="line.text" /></div>
                  <blockquote v-else-if="line.kind === 'quote'" class="mkt-md-quote"><InlineText :text="line.text" /></blockquote>
                  <p v-else-if="line.kind === 'paragraph'" class="mkt-md-p"><InlineText :text="line.text" /></p>
                </template>
              </div>
              <p v-else class="nv-hint">{{ $t('settings.extensions.marketplace.noChangelog') }}</p>
            </section>

            <section
              id="mkt-panel-versions"
              v-show="detailTab === 'versions'"
              class="mkt-panel mkt-block"
              role="tabpanel"
              aria-labelledby="mkt-tab-versions"
            >
              <button
                v-if="showCompatibleOnly"
                class="mkt-show-all nv-btn nv-btn--ghost nv-btn--sm"
                @click="showCompatibleOnly = false"
              >
                {{ $t('settings.extensions.marketplace.showAllVersions') }}
              </button>
              <div class="mkt-table-wrap">
                <table class="mkt-versions">
                  <thead>
                    <tr>
                      <th>{{ $t('settings.extensions.marketplace.column.version') }}</th>
                      <th>{{ $t('settings.extensions.marketplace.column.published') }}</th>
                      <th>{{ $t('settings.extensions.marketplace.column.target') }}</th>
                      <th>{{ $t('settings.extensions.marketplace.column.channel') }}</th>
                      <th class="mkt-num">{{ $t('settings.extensions.marketplace.column.downloads') }}</th>
                      <th>{{ $t('settings.extensions.marketplace.column.status') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="v in shownVersions"
                      :key="`${v.version}-${v.target}`"
                      :class="{ 'mkt-yanked': v.yanked, 'mkt-other-target': !v.installable || v.compatible === false }"
                    >
                      <td><code>{{ v.version }}</code></td>
                      <td class="mkt-muted">{{ formatDate(v.published_at) }}</td>
                      <td class="mkt-muted">{{ v.target }}</td>
                      <td>
                        <span v-if="v.channel === 'pre-release'" class="mkt-badge mkt-badge--warn mkt-channel-pre">
                          {{ $t('settings.extensions.marketplace.channelPrerelease') }}
                        </span>
                        <span v-else class="mkt-muted mkt-channel-stable">
                          {{ $t('settings.extensions.marketplace.channelStable') }}
                        </span>
                      </td>
                      <td class="mkt-muted mkt-num">{{ formatCount(v.download_count) }}</td>
                      <td>
                        <span v-if="v.yanked" class="mkt-badge mkt-badge--warn">
                          {{ $t('settings.extensions.marketplace.yanked') }}
                        </span>
                        <span v-else-if="!v.installable" class="mkt-other-target-reason">
                          {{ $t('settings.extensions.marketplace.otherTarget', { target: v.target }) }}
                        </span>
                        <span v-else-if="v.compatible === false" class="mkt-other-target-reason mkt-row-incompatible">
                          {{ $t('settings.extensions.marketplace.requiresNavide', { version: v.min_navide_version ?? '' }) }}
                        </span>
                        <button
                          v-else-if="showCompatibleOnly && !installedById.get(idOf(detail))"
                          class="mkt-row-install nv-btn nv-btn--sm"
                          :disabled="flow.busy.value"
                          @click="flow.install(detail.namespace, detail.name, v.version)"
                        >
                          {{ $t('settings.extensions.marketplace.installVersion', { version: v.version }) }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <aside class="mkt-detail-side">
            <section class="mkt-side-card mkt-works-with">
              <h4>
                {{ $t('settings.extensions.marketplace.worksWith') }}
                <span v-if="worksWithVersion" class="mkt-muted mkt-works-with-version">
                  {{ $t('settings.extensions.marketplace.versionLabel', { version: worksWithVersion }) }}
                </span>
              </h4>
              <div class="mkt-tags">
                <span v-for="target in worksWithTargets" :key="target" class="mkt-tag mkt-platform">
                  {{ target === 'universal' ? $t('settings.extensions.marketplace.allPlatforms') : target }}
                </span>
                <span v-if="worksWithMinNavide" class="mkt-tag mkt-min-navide">
                  {{ $t('settings.extensions.marketplace.navideAtLeast', { version: worksWithMinNavide }) }}
                </span>
              </div>
            </section>

            <section class="mkt-side-card mkt-permissions">
              <h4>{{ $t('settings.extensions.marketplace.permissions') }}</h4>
              <ul v-if="latestVersionInfo?.capabilities.length" class="mkt-caps">
                <li
                  v-for="cap in latestVersionInfo.capabilities"
                  :key="cap"
                  class="mkt-cap mkt-pack-cap"
                  :class="{
                    'mkt-cap--sensitive mkt-pack-cap--sensitive': latestVersionInfo.sensitive_capabilities.includes(cap),
                  }"
                >
                  {{ capLabel(cap, latestVersionInfo.sensitive_capabilities.includes(cap)) }}
                </li>
              </ul>
              <p v-else class="nv-hint mkt-no-permissions">
                {{
                  isPack(detail)
                    ? $t('settings.extensions.pack.noPermissionsOfItsOwn')
                    : $t('settings.extensions.marketplace.noPermissions')
                }}
              </p>
            </section>

            <section
              v-if="detail.repository || detail.homepage || detail.license || detail.categories.length"
              class="mkt-side-card"
            >
              <h4>{{ $t('settings.extensions.marketplace.info') }}</h4>
              <div v-if="detail.repository || detail.homepage || detail.license" class="mkt-links">
                <a v-if="detail.repository" href="#" class="mkt-link" @click.prevent="openLink(detail.repository)">
                  {{ $t('settings.extensions.marketplace.repository') }} ↗
                </a>
                <a v-if="detail.homepage" href="#" class="mkt-link" @click.prevent="openLink(detail.homepage)">
                  {{ $t('settings.extensions.marketplace.homepage') }} ↗
                </a>
                <span v-if="detail.license" class="mkt-muted mkt-license">
                  {{ $t('settings.extensions.marketplace.license', { license: detail.license }) }}
                </span>
              </div>
              <div v-if="detail.categories.length" class="mkt-tags mkt-categories">
                <span v-for="c in detail.categories" :key="c" class="mkt-tag">{{ categoryLabel({ slug: c, label: c }) }}</span>
              </div>
            </section>
          </aside>
        </div>

      </template>
    </section>

    <!-- List view -->
    <section v-else class="ext-section" data-section="marketplace">
      <div class="mkt-toolbar">
        <div class="ext-search">
          <span class="mkt-search-field">
            <svg class="mkt-search-icon" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" />
              <path d="m10.6 10.6 3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
            <input
              v-model="query"
              class="nv-input mkt-search-input"
              :placeholder="$t('settings.extensions.searchPlaceholder')"
              :aria-label="$t('settings.extensions.searchPlaceholder')"
              @keyup.enter="search"
            />
          </span>
          <button class="nv-btn mkt-search-btn" :disabled="listState === 'loading'" @click="search">
            {{ $t('settings.extensions.search') }}
          </button>
        </div>
        <select
          v-model="sort"
          class="nv-select mkt-sort"
          :aria-label="$t('settings.extensions.marketplace.sortLabel')"
          @change="search"
        >
          <option value="downloads">{{ $t('settings.extensions.marketplace.sort.downloads') }}</option>
          <option value="updated">{{ $t('settings.extensions.marketplace.sort.updated') }}</option>
          <option value="rating">{{ $t('settings.extensions.marketplace.sort.rating') }}</option>
        </select>
      </div>
      <div class="mkt-filters">
        <div v-if="categories.length" class="mkt-chips" role="group" :aria-label="$t('settings.extensions.marketplace.categoryLabel')">
          <button
            class="mkt-chip"
            :class="{ 'mkt-chip--active': category === '' }"
            :aria-pressed="category === ''"
            @click="selectCategory('')"
          >
            {{ $t('settings.extensions.marketplace.category.all') }}
          </button>
          <button
            v-for="c in categories"
            :key="c.slug"
            class="mkt-chip"
            :class="{ 'mkt-chip--active': category === c.slug }"
            :aria-pressed="category === c.slug"
            :data-category="c.slug"
            @click="selectCategory(c.slug)"
          >
            {{ categoryLabel(c) }}
          </button>
        </div>
        <label class="mkt-hide-incompatible">
          <input v-model="hideIncompatible" type="checkbox" class="nv-check" @change="search" />
          {{ $t('settings.extensions.marketplace.hideIncompatible') }}
        </label>
      </div>

      <template v-if="listState === 'loading'">
        <p class="mkt-loading mkt-sr-status" role="status">
          {{ $t('settings.extensions.marketplace.loading') }}
        </p>
        <ul class="mkt-skeleton-list" aria-hidden="true">
          <li v-for="n in 5" :key="n" class="mkt-skeleton-card">
            <span class="mkt-sk mkt-sk--tile"></span>
            <span class="mkt-sk-lines">
              <span class="mkt-sk mkt-sk--title"></span>
              <span class="mkt-sk mkt-sk--line"></span>
              <span class="mkt-sk mkt-sk--line mkt-sk--short"></span>
            </span>
          </li>
        </ul>
      </template>
      <div v-else-if="listState === 'error'" class="ext-error mkt-list-error mkt-state" role="alert">
        <!-- The signature mark: a tile turned into the Navide diamond. -->
        <span class="mkt-sigil mkt-sigil--danger" aria-hidden="true">
          <svg viewBox="0 0 16 16"><path d="m5.2 5.2 5.6 5.6m0-5.6-5.6 5.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        </span>
        <strong class="mkt-state-title">{{ $t('settings.extensions.marketplace.loadFailedTitle') }}</strong>
        <span class="mkt-state-body">{{ $t('settings.extensions.marketplace.loadFailedHint') }}</span>
        <button class="mkt-retry nv-btn nv-btn--primary nv-btn--sm" @click="search">
          {{ $t('settings.extensions.marketplace.retry') }}
        </button>
        <details class="mkt-error-details">
          <summary>{{ $t('settings.extensions.marketplace.errorDetails') }}</summary>
          <code>{{ $t('settings.extensions.marketplace.loadFailed', { error: listError }) }}</code>
        </details>
      </div>
      <div v-else-if="!results.length" class="mkt-empty nv-empty mkt-state">
        <span class="mkt-sigil" aria-hidden="true">
          <svg v-if="query" viewBox="0 0 16 16"><circle cx="7.2" cy="7.2" r="3.4" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="m9.8 9.8 2.6 2.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
          <svg v-else viewBox="0 0 16 16"><path d="M5 8h6M8 5v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
        </span>
        <strong class="mkt-state-title">
          {{
            query
              ? $t('settings.extensions.marketplace.noResults', { query })
              : $t('settings.extensions.marketplace.noExtensions')
          }}
        </strong>
        <span class="mkt-state-body">
          {{
            query || category
              ? $t('settings.extensions.marketplace.noResultsHint')
              : $t('settings.extensions.marketplace.noExtensionsHint')
          }}
        </span>
        <span v-if="query || category" class="mkt-state-actions">
          <button v-if="query" class="nv-btn nv-btn--sm" @click="clearQuery">
            {{ $t('settings.extensions.marketplace.clearSearch') }}
          </button>
          <button v-if="category" class="nv-btn nv-btn--ghost nv-btn--sm" @click="selectCategory('')">
            {{ $t('settings.extensions.marketplace.showAllCategories') }}
          </button>
        </span>
      </div>
      <template v-else>
        <section v-if="featured.length" class="mkt-featured" :aria-label="$t('settings.extensions.marketplace.featured')">
          <h2 class="mkt-section-label">{{ $t('settings.extensions.marketplace.featured') }}</h2>
          <ul class="mkt-featured-list" :class="`mkt-featured-list--${featured.length}`">
            <li
              v-for="(ext, index) in featured"
              :key="`featured:${ext.identity}`"
              :class="index === 0 ? 'mkt-featured-item--hero' : 'mkt-featured-item'"
            >
              <button
                class="mkt-featured-card"
                :class="{ 'mkt-featured-card--hero': index === 0 }"
                :data-featured-id="ext.identity"
                @click="openDetail(ext)"
              >
                <MarketplaceIcon
                  :namespace="ext.namespace"
                  :name="ext.name"
                  :label="ext.display_name || ext.name"
                  :version="ext.latest_version"
                  :path="ext.icon_path"
                  :size="index === 0 ? 56 : 40"
                />
                <span class="mkt-featured-name" v-truncate>{{ ext.display_name || ext.name }}</span>
                <span class="mkt-featured-desc" v-truncate>{{ ext.description }}</span>
                <span v-if="index === 0" class="mkt-featured-tags">
                  <span v-if="ext.trust_tier === 'signed-verified'" class="mkt-quiet mkt-quiet--ok">✓ {{ $t('settings.extensions.marketplace.signedShort') }}</span>
                  <span v-if="ext.compatible === true" class="mkt-quiet">{{ $t('settings.extensions.marketplace.compatibleWith', { version: ext.app_version ?? '' }) }}</span>
                  <span v-for="c in ext.categories" :key="c" class="mkt-tag">{{ categoryLabel({ slug: c, label: c }) }}</span>
                </span>
                <span class="mkt-featured-meta">
                  {{ $t('settings.extensions.marketplace.downloads', { count: formatCount(ext.download_count) }) }}
                  <template v-if="ext.rating_average > 0"> · ★ {{ ext.rating_average.toFixed(1) }}</template>
                </span>
              </button>
            </li>
          </ul>
        </section>
        <ul class="ext-list">
          <li
            v-for="ext in listResults"
            :key="ext.identity"
            class="ext-result"
            :class="{ 'ext-result--incompatible': isIncompatible(ext) }"
            :data-id="ext.identity"
            tabindex="0"
            @click="openDetail(ext)"
            @keydown.enter.self="openDetail(ext)"
          >
            <MarketplaceIcon
              :namespace="ext.namespace"
              :name="ext.name"
              :label="ext.display_name || ext.name"
              :version="ext.latest_version"
              :path="ext.icon_path"
              :size="40"
            />
            <div class="mkt-card-main">
              <div class="mkt-card-title">
                <span class="ext-id">{{ ext.display_name || ext.name }}</span>
                <span v-if="ext.latest_version" class="mkt-muted mkt-card-version">{{ ext.latest_version }}</span>
                <span
                  v-if="updatesById.get(ext.identity)"
                  class="mkt-badge mkt-badge--accent ext-update-badge"
                >
                  {{ $t('settings.extensions.marketplace.updateAvailable') }}
                </span>
                <span v-else-if="installedById.get(ext.identity)" class="mkt-badge mkt-badge--ok ext-installed-badge">
                  {{ $t('settings.extensions.marketplace.installedBadge') }}
                </span>
                <span v-else-if="ext.installable === false" class="mkt-badge mkt-badge--warn ext-unavailable-badge">
                  {{ $t('settings.extensions.marketplace.unavailable') }}
                </span>
                <span v-if="isPack(ext)" class="mkt-badge mkt-badge--accent mkt-pack-badge">
                  {{ $t('settings.extensions.pack.badge') }}
                </span>
                <span v-if="isIncompatible(ext)" class="mkt-badge mkt-badge--danger ext-incompatible-badge">
                  {{ $t('settings.extensions.marketplace.requiresNavide', { version: ext.min_navide_version ?? '' }) }}
                </span>
              </div>
              <p v-if="ext.description" class="mkt-card-desc" v-truncate>{{ ext.description }}</p>
              <p v-if="isIncompatible(ext)" class="mkt-card-incompatible">
                {{ $t('settings.extensions.marketplace.updateNavideToInstall', { current: ext.app_version ?? '' }) }}
              </p>
              <div class="mkt-card-sub">
                <span class="ext-ns">{{ ext.namespace }}.{{ ext.name }}</span>
                <span class="mkt-muted">{{ $t('settings.extensions.marketplace.downloads', { count: formatCount(ext.download_count) }) }}</span>
                <span v-if="ext.rating_average > 0" class="mkt-muted mkt-card-rating">★ {{ ext.rating_average.toFixed(1) }}</span>
                <span v-if="ext.trust_tier === 'signed-verified'" class="mkt-quiet mkt-quiet--ok ext-signed-badge">
                  ✓ {{ $t('settings.extensions.marketplace.signedShort') }}
                </span>
                <span
                  v-if="!isIncompatible(ext) && ext.compatible === true && ext.installable !== false"
                  class="mkt-quiet ext-compatible-badge"
                >
                  {{ $t('settings.extensions.marketplace.compatibleWith', { version: ext.app_version ?? '' }) }}
                </span>
                <span v-if="ext.repository || ext.license" class="mkt-card-links">
                  <a v-if="ext.repository" href="#" class="mkt-link" @click.stop.prevent="openLink(ext.repository)">
                    {{ $t('settings.extensions.marketplace.repository') }} ↗
                  </a>
                  <span v-if="ext.license" class="mkt-muted">{{ ext.license }}</span>
                </span>
              </div>
            </div>
            <button
              v-if="updatesById.get(ext.identity)"
              class="ext-update nv-btn nv-btn--primary nv-btn--sm"
              :disabled="flow.busy.value"
              @click.stop="flow.install(ext.namespace, ext.name, updatesById.get(ext.identity)?.latestVersion)"
            >
              {{ $t('settings.extensions.marketplace.update') }}
            </button>
            <button
              v-else-if="isPack(ext)"
              class="mkt-pack-install nv-btn nv-btn--primary nv-btn--sm"
              :disabled="packFlow.busy.value || flow.busy.value || isIncompatible(ext)"
              @click.stop="packFlow.start(ext.namespace, ext.name)"
            >
              {{ $t('settings.extensions.pack.install', { count: ext.extension_pack?.length ?? 0 }) }}
            </button>
            <button
              v-else-if="!installedById.get(ext.identity) && ext.installable !== false"
              class="ext-install nv-btn nv-btn--primary nv-btn--sm"
              :class="{ 'is-working': isInstalling(ext.identity) }"
              :disabled="flow.busy.value || isIncompatible(ext)"
              :aria-busy="isInstalling(ext.identity)"
              @click.stop="installFrom(ext.namespace, ext.name)"
            >
              <span v-if="isInstalling(ext.identity)" class="mkt-spinner" aria-hidden="true"></span>
              {{ isInstalling(ext.identity) ? $t('settings.extensions.marketplace.installing') : $t('settings.extensions.install') }}
            </button>
          </li>
        </ul>
      </template>
      <div v-if="listState === 'ready' && results.length" class="mkt-load-more">
        <button
          v-if="results.length < total"
          class="mkt-load-more-btn nv-btn nv-btn--sm"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ $t('settings.extensions.marketplace.loadMore') }}
        </button>
        <span class="mkt-muted mkt-showing">
          {{ $t('settings.extensions.marketplace.showing', { shown: results.length, total }) }}
        </span>
        <span v-if="loadMoreError" class="ext-error mkt-load-more-error" role="alert">
          {{ $t('settings.extensions.marketplace.loadFailed', { error: loadMoreError }) }}
        </span>
      </div>
    </section>

    <PluginTrustDialog
      v-if="flow.pendingConfirm.value"
      :pending="flow.pendingConfirm.value"
      :step="flow.pendingStep.value"
      @confirm-publisher="flow.confirmPublisher"
      @confirm-risk="flow.confirmRisk"
      @cancel="flow.cancel"
    />
    <PackInstallDialog :flow="packFlow" />
  </div>
</template>

<style scoped>
.marketplace-pane {
  /* Horizontal gutter matches the settings page gutter so the pane lines up with
     the <h1> the settings modal renders above it; the modal already reserves the
     gap below that title, so no top padding here. */
  padding: 0 22px var(--space-6);
  font-size: var(--font-sm);
  color: var(--text-primary);
  container-type: inline-size;
  /* Native controls (checkboxes, scrollbars) follow the theme. */
  color-scheme: var(--nv-color-scheme);
}
.ext-error {
  display: flex;
  align-items: center;
  gap: 10px;
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
.ext-error > span {
  flex: 1;
  min-width: 0;
}
.mkt-retry {
  flex-shrink: 0;
}
.ext-section {
  margin-bottom: var(--space-5);
}
/* Switching between the list and a detail page, and between detail tabs,
   eases in instead of cutting. Durations are the motion tokens, which are
   0ms under prefers-reduced-motion. */
.mkt-detail,
.ext-section[data-section='marketplace'],
.mkt-panel {
  animation: mkt-enter var(--motion-base) var(--ease-out);
}
@keyframes mkt-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
/* The Navide diamond marks section labels, as on the Marketplace website. */
.mkt-section-label::before,
.mkt-side-card h4::before {
  content: '';
  flex: none;
  align-self: center;
  width: 5px;
  height: 5px;
  margin-right: 2px;
  border-radius: 1px;
  background: var(--accent-fg);
  transform: rotate(45deg);
}

/* Screen-reader status line: the skeleton is what sighted users see. */
.mkt-sr-status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ── Toolbar ───────────────────────────────────────────────── */
.mkt-toolbar {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
.ext-search {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: var(--space-2);
}
.mkt-search-field {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
}
.mkt-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  width: 15px;
  height: 15px;
  transform: translateY(-50%);
  color: var(--text-secondary);
  pointer-events: none;
}
.ext-search .mkt-search-input {
  flex: 1;
  min-width: 0;
  /* Inputs are content-box here (no global reset): match the button height. */
  box-sizing: border-box;
  height: var(--control-h-lg);
  padding-left: 32px;
}
.mkt-search-btn,
.mkt-sort {
  height: var(--control-h-lg);
}
.mkt-sort {
  flex: none;
  width: auto;
}
.mkt-filters {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}
.mkt-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.mkt-chip {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 500;
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}
.mkt-chip:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}
.mkt-chip--active,
.mkt-chip--active:hover {
  border-color: var(--accent-fg);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-weight: 600;
}
.mkt-chip:focus-visible,
.mkt-tab:focus-visible,
.mkt-featured-card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent-focus);
}
.mkt-hide-incompatible,
.mkt-prerelease-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
}

/* ── Skeleton ──────────────────────────────────────────────── */
.mkt-skeleton-list {
  list-style: none;
  padding: 0;
  margin: var(--space-4) 0 0;
  display: grid;
  gap: var(--space-2);
}
.mkt-skeleton-card,
.mkt-detail-skeleton {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.mkt-detail-skeleton {
  border: 0;
  padding: var(--space-2) 0;
}
.mkt-sk-lines {
  flex: 1;
  display: grid;
  gap: 7px;
}
.mkt-sk {
  display: block;
  border-radius: var(--radius-xs);
  background: linear-gradient(90deg, var(--bg-muted) 0%, var(--bg-hover-strong) 50%, var(--bg-muted) 100%);
  background-size: 200% 100%;
  animation: mkt-shimmer 1.4s var(--ease-in-out) infinite;
}
.mkt-sk--tile { width: 40px; height: 40px; border-radius: var(--radius-tile); flex: none; }
.mkt-sk--tile-lg { width: 64px; height: 64px; border-radius: 14px; flex: none; }
/* A faint diamond inside each placeholder tile: the signature, even while loading. */
.mkt-sk--tile,
.mkt-sk--tile-lg {
  position: relative;
}
.mkt-sk--tile::after,
.mkt-sk--tile-lg::after {
  content: '';
  position: absolute;
  inset: 32%;
  border: 1.5px solid color-mix(in srgb, var(--accent-fg) 35%, transparent);
  border-radius: 3px;
  transform: rotate(45deg);
}
.mkt-sk--title { width: 32%; height: 12px; }
.mkt-sk--line { width: 74%; height: 9px; }
.mkt-sk--short { width: 44%; }
@keyframes mkt-shimmer {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .mkt-sk { animation: none; }
}

/* ── Empty / error states ──────────────────────────────────── */
.mkt-state {
  display: grid;
  justify-items: center;
  gap: 6px;
  margin: var(--space-4) 0 0;
  padding: var(--space-8) var(--space-6);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-sm);
  text-align: center;
  white-space: normal;
}
/* An outage is not the user's fault: a calm surface, only the icon is red. */
.mkt-state.ext-error {
  border-style: solid;
  border-color: var(--border-default);
  background: var(--bg-subtle);
}
/* The signature mark on every state page: a rounded tile turned 45 degrees
   (the Navide diamond), in the letter tiles' gradient, the glyph upright. */
.mkt-sigil {
  position: relative;
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: var(--space-2);
  color: #fff;
}
.mkt-sigil::before {
  content: '';
  position: absolute;
  inset: 8px;
  border-radius: 10px;
  transform: rotate(45deg);
  background: linear-gradient(150deg, var(--accent-fg), color-mix(in srgb, var(--accent-fg) 55%, #000));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16), var(--shadow-floating);
}
.mkt-sigil--danger::before {
  background: linear-gradient(150deg, var(--danger-bright), color-mix(in srgb, var(--danger-fg) 60%, #000));
}
.mkt-sigil svg {
  position: relative;
  width: 18px;
  height: 18px;
}
.mkt-state-title {
  color: var(--text-bright);
  font-size: var(--font-md);
  font-weight: 600;
}
.mkt-state-body {
  max-width: 36em;
}
.mkt-state-actions {
  display: inline-flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.mkt-state .mkt-retry {
  margin-top: var(--space-2);
}
.mkt-error-details {
  margin-top: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.mkt-error-details summary {
  cursor: pointer;
}
.mkt-error-details code {
  display: block;
  margin-top: 6px;
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

/* ── Featured shelf ────────────────────────────────────────── */
.mkt-featured {
  margin-top: var(--space-5);
}
.mkt-section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
/* Editorial shelf: one lead card, up to two secondary ones stacked beside it.
   No rotation, nothing moves on its own. */
.mkt-featured-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
}
@container (min-width: 600px) {
  .mkt-featured-list--2,
  .mkt-featured-list--3 {
    grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
  }
  .mkt-featured-list--3 .mkt-featured-item--hero {
    grid-row: span 2;
  }
}
.mkt-featured-list > li {
  display: flex;
  min-width: 0;
}
/* Narrow: the lead card on its own row, the two others side by side, so the
   list still starts on the first screen. */
@container (max-width: 599px) {
  .mkt-featured-list--3 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .mkt-featured-list--3 .mkt-featured-item--hero {
    grid-column: 1 / -1;
  }
  .mkt-featured-card--hero .mkt-featured-desc {
    -webkit-line-clamp: 2;
  }
  .mkt-featured-card:not(.mkt-featured-card--hero) .mkt-featured-desc {
    display: none;
  }
}
.mkt-featured-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas:
    'icon name'
    'icon meta'
    'desc desc';
  align-items: center;
  column-gap: var(--space-3);
  row-gap: 2px;
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
  padding: var(--space-4);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(120% 100% at 0% 0%, var(--accent-subtle) 0%, transparent 62%),
    var(--bg-subtle);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--motion-base) var(--ease-out),
    box-shadow var(--motion-base) var(--ease-out),
    transform var(--motion-base) var(--ease-out);
}
.mkt-featured-card :deep(.mkt-icon) {
  grid-area: icon;
}
.mkt-featured-card--hero {
  grid-template-areas:
    'icon name'
    'icon meta'
    'desc desc'
    'tags tags';
  grid-template-rows: auto auto auto 1fr;
  align-content: stretch;
  padding: var(--space-5) var(--space-5) var(--space-6);
  border-color: var(--border-default);
  background:
    radial-gradient(130% 120% at 0% 0%, var(--accent-subtle) 0%, transparent 60%),
    radial-gradient(80% 90% at 100% 100%, color-mix(in srgb, var(--accent-fg) 8%, transparent) 0%, transparent 70%),
    var(--bg-subtle);
}
.mkt-featured-card--hero .mkt-featured-name {
  font-size: var(--font-title);
  font-weight: 700;
  letter-spacing: -0.01em;
}
.mkt-featured-card--hero .mkt-featured-meta {
  font-size: var(--font-xs);
}
.mkt-featured-card--hero .mkt-featured-desc {
  margin-top: var(--space-4);
  max-width: 46ch;
  color: var(--text-primary);
  font-size: var(--font-md);
  -webkit-line-clamp: 3;
}
.mkt-featured-tags {
  grid-area: tags;
  align-self: end;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--space-4);
}
.mkt-featured-card--hero::after {
  /* The Navide diamond, large and faint, as on the website hero; whole,
     inside the card. */
  content: '';
  position: absolute;
  right: 22px;
  bottom: 22px;
  width: 40px;
  height: 40px;
  border: 1px solid color-mix(in srgb, var(--accent-fg) 30%, transparent);
  border-radius: 10px;
  transform: rotate(45deg);
  pointer-events: none;
}
.mkt-featured-card:hover {
  border-color: var(--border-default);
  box-shadow: var(--shadow-floating);
  transform: translateY(-1px);
}
.mkt-featured-name {
  grid-area: name;
  align-self: end;
  color: var(--text-bright);
  font-size: var(--font-md);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mkt-featured-meta {
  grid-area: meta;
  align-self: start;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-variant-numeric: tabular-nums;
}
.mkt-featured-desc {
  grid-area: desc;
  margin-top: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── Result cards ──────────────────────────────────────────── */
.ext-list {
  list-style: none;
  padding: 0;
  margin: var(--space-4) 0 0;
  display: grid;
  /* minmax(0, …): a nowrap description must truncate, not widen the track
     and push the Install button out of the page. */
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
}
.mkt-featured + .ext-list {
  margin-top: var(--space-5);
}
.ext-result {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-base) var(--ease-out),
    transform var(--motion-base) var(--ease-out);
}
.ext-result:hover {
  border-color: var(--border-default);
  box-shadow: var(--shadow-floating);
  transform: translateY(-1px);
}
@media (prefers-reduced-motion: reduce) {
  .ext-result:hover,
  .mkt-featured-card:hover {
    transform: none;
  }
}
.ext-result:focus-visible {
  outline: none;
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px var(--accent-focus);
}
.mkt-card-main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 3px;
}
.mkt-card-title,
.mkt-card-sub {
  display: flex;
  align-items: center;
  gap: 6px 8px;
  flex-wrap: wrap;
}
/* Two lines at most, so every card keeps one rhythm; the full text is in the
   tooltip and on the detail page. */
.mkt-card-desc {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.mkt-card-sub {
  font-size: var(--font-2xs);
  font-variant-numeric: tabular-nums;
}
/* Middle dots between meta items, drawn in the gap and clipped at the
   container edge: an item that wraps to a new line never starts with one. */
.mkt-card-sub {
  overflow: hidden;
  column-gap: 16px;
}
.mkt-card-sub > * {
  position: relative;
}
.mkt-card-sub > * + *::before {
  content: '';
  position: absolute;
  left: -10px;
  top: 50%;
  width: 3px;
  height: 3px;
  margin-top: -1.5px;
  border-radius: 50%;
  background: var(--text-secondary);
  opacity: 0.7;
}
.ext-id {
  font-weight: 600;
  font-size: var(--font-md);
  color: var(--text-bright);
}
.mkt-card-version {
  font-variant-numeric: tabular-nums;
}
.ext-ns,
.mkt-muted {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.mkt-card-sub .ext-ns,
.mkt-card-sub .mkt-muted {
  font-size: inherit;
}
.mkt-card-links {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.mkt-quiet {
  color: var(--text-secondary);
  font-weight: 500;
}
.mkt-quiet--ok {
  color: var(--trust-signed-fg);
}
/* Not installable here: the tile goes grey, the text stays readable. */
.ext-result--incompatible :deep(.mkt-icon) {
  filter: grayscale(1);
  opacity: 0.7;
}
.mkt-card-incompatible {
  margin: 0;
  color: var(--danger-bright);
  font-size: var(--font-xs);
}

/* ── Badges, tags, links ───────────────────────────────────── */
.mkt-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.mkt-badge--ok {
  color: var(--trust-signed-fg);
  background: var(--trust-signed-subtle);
}
.mkt-badge--neutral {
  color: var(--trust-unsigned-fg);
  background: var(--trust-unsigned-subtle);
}
.mkt-badge--warn {
  color: var(--risk-fg);
  background: var(--risk-subtle);
}
/* Unsigned is a risk, said in colour and with a glyph, not colour alone. */
.mkt-badge--unsigned::before {
  content: '⚠';
  margin-right: 4px;
}
/* A state change (installed, update available) arrives, it does not blink in. */
.mkt-badge {
  animation: mkt-badge-in var(--motion-base) var(--ease-out);
}
@keyframes mkt-badge-in {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: none; }
}
.mkt-badge--accent {
  color: var(--accent-fg);
  background: var(--accent-subtle);
}
.mkt-badge--danger {
  color: var(--danger-bright);
  background: var(--danger-subtle);
}
.mkt-badge--muted {
  color: var(--text-secondary);
  background: var(--bg-muted);
}
.mkt-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.mkt-tag {
  padding: 1px 9px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}
.mkt-link {
  color: var(--accent-fg);
  text-decoration: none;
}
.mkt-link:hover {
  text-decoration: underline;
}
.mkt-link:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: 2px;
  border-radius: 2px;
}

/* ── Load more ─────────────────────────────────────────────── */
.mkt-load-more {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-4);
}

/* ── Detail ────────────────────────────────────────────────── */
.mkt-back {
  margin: 0 0 var(--space-3) -8px;
}
.mkt-detail-head {
  position: relative;
  padding: var(--space-5);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(90% 140% at 0% 0%, var(--accent-subtle) 0%, transparent 58%),
    var(--bg-subtle);
}
.mkt-hero {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.mkt-hero-text {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.mkt-detail-title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.mkt-detail-title h3 {
  margin: 0;
  color: var(--text-bright);
  font-size: var(--font-title);
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.mkt-detail-id .mkt-muted {
  font-family: var(--font-mono);
  font-size: var(--font-xs);
}
.mkt-meta {
  display: flex;
  align-items: center;
  gap: 4px 14px;
  flex-wrap: wrap;
  margin-top: 4px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
.mkt-meta strong {
  color: var(--text-primary);
  font-weight: 600;
}
.mkt-desc {
  margin: var(--space-4) 0 0;
  max-width: 68ch;
  color: var(--text-primary);
  font-size: var(--font-md);
  line-height: var(--lh-base);
}
.mkt-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-4);
}
.mkt-actions .nv-btn:not(.nv-btn--sm) {
  height: var(--control-h-lg);
  padding: 0 16px;
}
/* Removing an extension is a quiet secondary action until hovered. */
.mkt-btn-danger-ghost {
  color: var(--danger-bright);
}
.mkt-btn-danger-ghost:hover:not(:disabled) {
  background: var(--danger-subtle);
  color: var(--danger-bright);
}
.mkt-callout {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-3) 0 0;
  padding: 10px 12px 10px 14px;
  border: 1px solid var(--border-muted);
  border-left: 3px solid currentColor;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}
.mkt-callout > span {
  flex: 1;
  min-width: 0;
}
.mkt-callout--risk {
  color: var(--risk-fg);
  background: var(--risk-subtle);
  border-color: var(--risk-muted);
  border-left-color: var(--risk-fg);
}

.mkt-detail-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-5);
  margin-top: var(--space-5);
}
@container (min-width: 720px) {
  .mkt-detail-body {
    grid-template-columns: minmax(0, 1fr) 232px;
    gap: var(--space-7);
  }
  .mkt-detail-side {
    position: sticky;
    top: var(--space-4);
    /* A stretched grid item has no room to stick. */
    align-self: start;
  }
}
.mkt-detail-main {
  min-width: 0;
}
.mkt-detail-side {
  display: grid;
  gap: var(--space-3);
  align-content: start;
}
.mkt-side-card {
  padding: var(--space-3) var(--space-4) var(--space-4);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.mkt-side-card h4 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.mkt-works-with-version {
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
}
.mkt-links {
  display: flex;
  align-items: center;
  gap: 6px 12px;
  flex-wrap: wrap;
  margin-bottom: var(--space-2);
  font-size: var(--font-xs);
}
.mkt-caps {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* Tabs */
.mkt-tabs {
  display: flex;
  gap: var(--space-5);
  border-bottom: 1px solid var(--border-muted);
}
.mkt-tab {
  position: relative;
  padding: 0 0 10px;
  border: 0;
  background: none;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-sm);
  font-weight: 600;
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out);
}
.mkt-tabs {
  position: relative;
}
/* One underline that slides between tabs. */
.mkt-tab-indicator {
  position: absolute;
  left: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent-fg);
  transition:
    transform var(--motion-base) var(--ease-out),
    width var(--motion-base) var(--ease-out);
}
.mkt-tab:hover {
  color: var(--text-primary);
}
.mkt-tab--active {
  color: var(--text-bright);
}

.mkt-panel {
  padding: var(--space-4) 0 0;
}
.mkt-block {
  border-bottom: 0;
}
.mkt-block h4 {
  margin: 0 0 var(--space-2);
  color: var(--text-bright);
  font-size: var(--font-md);
}

/* README */
.mkt-readme {
  max-width: 72ch;
  font-size: var(--font-md);
  line-height: var(--lh-loose);
  overflow-wrap: anywhere;
}
.mkt-md-h {
  margin: var(--space-5) 0 var(--space-2);
  color: var(--text-bright);
  line-height: 1.3;
}
.mkt-readme > .mkt-md-h:first-child {
  margin-top: 0;
}
.mkt-md-p {
  margin: var(--space-2) 0;
}
.mkt-md-li {
  margin: 3px 0 3px var(--space-2);
  padding-left: var(--space-4);
  position: relative;
}
.mkt-md-li--bullet::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0.72em;
  width: 5px;
  height: 5px;
  border-radius: 1px;
  transform: rotate(45deg);
  background: var(--accent-fg);
}
.mkt-md-marker {
  position: absolute;
  left: 0;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.mkt-md-quote {
  margin: var(--space-3) 0;
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--accent-fg);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--accent-subtle);
  color: var(--text-primary);
}
.mkt-readme :deep(a) {
  color: var(--accent-fg);
  text-decoration: none;
}
.mkt-readme :deep(a:hover) {
  text-decoration: underline;
}
.mkt-code,
.mkt-readme :deep(code),
.mkt-versions code {
  font-family: var(--font-mono);
  font-size: var(--font-xs);
}
.mkt-readme :deep(:not(pre) > code) {
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--bg-muted);
}
.mkt-code {
  margin: var(--space-3) 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  overflow-x: auto;
  line-height: var(--lh-base);
}

/* Versions table */
.mkt-table-wrap {
  overflow-x: auto;
}
.mkt-versions {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.mkt-versions th {
  padding: 6px 12px 6px 0;
  border-bottom: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
}
.mkt-versions td {
  padding: 8px 12px 8px 0;
  border-bottom: 1px solid var(--border-muted);
}
.mkt-versions tbody tr {
  transition: background var(--motion-fast) var(--ease-out);
}
.mkt-versions tbody tr:hover {
  background: var(--bg-hover-faint);
}
.mkt-versions .mkt-num {
  text-align: right;
  padding-right: var(--space-5);
}
.mkt-show-all {
  margin-bottom: var(--space-2);
}
.mkt-unavailable {
  color: var(--risk-fg);
}
.mkt-other-target td {
  opacity: 0.6;
}
.mkt-other-target-reason {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}
.mkt-yanked code {
  text-decoration: line-through;
  color: var(--text-secondary);
}

/* Pack members */
.mkt-pack-members {
  margin-top: var(--space-5);
}
.mkt-pack-counts {
  margin: -4px 0 var(--space-3);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
/* Install in progress: the pressed button says so. */
.nv-btn.is-working {
  cursor: progress;
}
.mkt-spinner {
  width: 11px;
  height: 11px;
  border: 1.6px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: mkt-spin 0.8s linear infinite;
}
@keyframes mkt-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .mkt-spinner {
    animation: none;
    border-right-color: currentColor;
    opacity: 0.6;
  }
}
/* Disclosures open smoothly where the engine supports it. */
.mkt-error-details {
  interpolate-size: allow-keywords;
}
.mkt-error-details::details-content {
  height: 0;
  overflow: clip;
  transition:
    height var(--motion-base) var(--ease-out),
    content-visibility var(--motion-base) allow-discrete;
}
.mkt-error-details[open]::details-content {
  height: auto;
}
.mkt-pack-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 6px;
}
.mkt-pack-member {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-3);
  padding: 10px var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.mkt-pack-member {
  transition: border-color var(--motion-fast) var(--ease-out);
}
.mkt-pack-member:hover {
  border-color: var(--border-default);
}
/* Skipped members look like an incompatible card in the list: grey tile. */
.mkt-pack-member--skipped :deep(.mkt-icon) {
  filter: grayscale(1);
  opacity: 0.7;
}
.mkt-pack-member-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.mkt-pack-member-name {
  font-weight: 600;
  color: var(--text-bright);
}
/* An id or version never breaks mid-token: one line, ellipsis, full value in
   the tooltip. */
.mkt-pack-member-name,
.mkt-pack-member-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mkt-pack-member-caps {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
/* Same chips as the pack install dialog: every permission is a chip, and only
   the sensitive ones are highlighted. */
.mkt-pack-cap {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  background: var(--bg-muted);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
}
.mkt-pack-cap--sensitive {
  color: var(--risk-fg);
  background: var(--risk-subtle);
  font-weight: 600;
}
</style>
