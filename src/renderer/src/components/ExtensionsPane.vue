<script setup lang="ts">
// Extensions inventory: the bundled packages and the installed plugins, with
// their trust/capability badges. Browsing and installing live on the separate
// Marketplace page; the execution policy that governs what any of them may run
// is the editable block above this pane on the same settings page.
//
// All privileged work is brokered through the main process via
// `window.agentTeam.plugins`; this component holds no secrets and never touches
// package bytes.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  ManifestPermissionsSummary,
  PackageVersionGrantSummary,
} from '../../../shared/executionPolicy'
import { usePluginInventory } from '../composables/usePluginInventory'
import { usePluginUpdates } from '../composables/usePluginUpdates'
import { confirmUninstall, ipcErrorMessage, usePluginInstallFlow } from '../composables/usePluginInstallFlow'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import PluginTrustDialog from './PluginTrustDialog.vue'
import PackUninstallDialog from './PackUninstallDialog.vue'
import NativeBackendPanel from './NativeBackendPanel.vue'
import MarketplaceIcon from './MarketplaceIcon.vue'

const { t } = useI18n()

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
const busy = ref(false)
const error = ref('')
// Updates for installed Registry packages; the Update button reuses the
// Marketplace's verified install flow (and its trust dialog).
const pluginUpdates = usePluginUpdates()
const updatesById = computed(
  () => new Map(pluginUpdates.updates.value.map((update) => [update.id, update]))
)
const updateFlow = usePluginInstallFlow()
const notify = useNotify()

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
  const fs = permissions.scopes?.fs
  const read = fs?.read ?? []
  const write = fs?.write ?? []
  const groups: Array<[string, string[]]> = [
    ['scopeReadWrite', write.filter((pattern) => read.includes(pattern))],
    ['scopeReadOnly', read.filter((pattern) => !write.includes(pattern))],
    ['scopeWriteOnly', write.filter((pattern) => !read.includes(pattern))],
  ]
  return groups
    .filter(([, patterns]) => patterns.length > 0)
    .map(([key, patterns]) => `${t(`settings.extensionsPolicy.${key}`)} ${patterns.join(', ')}`)
    .join('; ')
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
  return message
}

async function remove(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  if (!(await confirmUninstall(t, notify, id))) return
  await api.remove(id)
  await refreshInstalled()
}

// Returning an installed package to what it displaced: the previous version, or
// the App-bundled factory package for the ids that ship with Navide. The Host
// decides which of the two applies; the row only offers the button when the Host
// says a rollback is available.
async function rollback(id: string, kind: 'factory' | 'previous', version?: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  const confirmed = await notify.confirm(
    kind === 'factory'
      ? t('settings.extensions.rollback.confirmFactory', { id })
      : t('settings.extensions.rollback.confirmPrevious', {
          id,
          version: version ?? t('settings.extensions.rollback.previousVersion'),
        }),
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
    await refreshInstalled().catch((refreshErr: unknown) => {
      console.warn('[extensions] inventory refresh after a failed rollback failed:', refreshErr)
    })
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

onMounted(() => {
  void refreshInstalled()
  void pluginUpdates.refresh()
  void refreshPacks()
})
// A pack installed from the Marketplace page shows up here without a remount.
watch(installed, () => void refreshPacks())
</script>

<template>
  <div class="extensions-pane">
    <p v-if="error" class="ext-error" role="alert">{{ error }}</p>
    <p v-if="updateFlow.error.value" class="ext-error" role="alert">{{ updateFlow.error.value }}</p>

    <section class="ext-section">
      <h3 class="ext-section-title">
        {{ $t('settings.extensions.bundled') }}
        <span class="ext-section-count">{{ factoryRows.length }}</span>
      </h3>
      <ul class="ext-list ext-bundled-list">
        <li
          v-for="p in factoryRows"
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
            <span class="ext-badge ext-state" :class="p.active ? 'ext-active' : 'ext-removed'">
              {{
                p.active
                  ? $t('settings.extensions.state.active')
                  : p.optedOut
                    ? $t('settings.extensions.state.removed')
                    : $t('settings.extensions.state.unavailable')
              }}
            </span>
          </div>
          <span v-if="p.installed?.pendingCandidateVersion" class="ext-badge ext-candidate">
            {{ $t('settings.extensions.candidateReady', { version: p.installed.pendingCandidateVersion }) }}
          </span>
          <!-- First-party code with no sandbox: say so plainly. The third-party
               sandbox wording does not apply to it. -->
          <p v-if="p.id === 'navide.plans'" class="ext-risk-note">
            {{ $t('settings.extensions.plansRiskNote') }}
          </p>
          <details v-if="p.installed?.manifestPermissions || p.installed?.packageVersion" class="ext-permission-details">
            <summary>{{ $t('settings.extensions.permissionDetails') }}</summary>
            <span v-if="p.installed?.manifestPermissions" class="ext-manifest-permissions">
              {{ $t('settings.extensionsPolicy.labeledValue', { label: $t('settings.extensionsPolicy.manifestPermissions'), value: formatManifestPermissions(p.installed.manifestPermissions) }) }}
            </span>
            <span v-if="p.installed?.manifestPermissions?.scopes" class="ext-manifest-scopes">
              {{ $t('settings.extensionsPolicy.labeledValue', { label: manifestScopesLabel(p.installed.manifestPermissions), value: formatManifestScopes(p.installed.manifestPermissions) }) }}
            </span>
            <span
              v-if="p.installed?.packageVersion"
              class="ext-package-grant"
              :class="{ 'ext-package-grant-none': !p.installed.packageVersionGrant }"
            >
              {{ $t('settings.extensionsPolicy.labeledValue', { label: $t('settings.extensionsPolicy.packageVersionGrant'), value: formatPackageGrant(p.installed.packageVersionGrant) }) }}
            </span>
          </details>
          <div v-if="p.optedOut || p.installed?.pendingCandidateVersion" class="ext-actions">
            <button
              v-if="p.optedOut"
              class="ext-restore nv-btn nv-btn--sm"
              :disabled="busy"
              @click="restoreFactoryPackage(p.id)"
            >
              {{ $t('settings.extensions.restore') }}
            </button>
            <!-- A rollback leaves the displaced package staged over the bundled
                 one, and this row is the only place it is still listed. -->
            <button
              v-else-if="p.installed?.pendingCandidateVersion"
              class="ext-restart nv-btn nv-btn--primary nv-btn--sm"
              :disabled="busy || updateFlow.busy.value"
              @click="restartPlugin(p.id)"
            >
              {{ $t('settings.extensions.restartPlugin') }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section class="ext-section">
      <h3 class="ext-section-title">
        {{ $t('settings.extensions.installed') }}
        <span class="ext-section-count">{{ packs.length + nonFactoryInstalled.length }}</span>
      </h3>
      <!-- Updates are for installed packages; with none installed the line
           would contradict the empty list below it. -->
      <p v-if="pluginUpdates.count.value && nonFactoryInstalled.length" class="ext-updates-summary" role="status">
        {{ $t('settings.extensions.marketplace.updatesCount', { count: pluginUpdates.count.value }) }}
      </p>
      <ul class="ext-list">
        <li v-for="pack in packs" :key="`pack:${pack.id}`" class="ext-installed ext-pack ext-card" :data-pack-id="pack.id">
          <MarketplaceIcon v-bind="idParts(pack.id)" :label="pack.displayName || idParts(pack.id).name" :size="36" />
          <div class="ext-card-main">
            <div class="ext-card-title">
              <span class="ext-id" v-truncate>{{ pack.displayName || pack.id }}</span>
              <span class="ext-requires">{{ $t('settings.extensions.marketplace.versionLabel', { version: pack.version }) }}</span>
              <span class="ext-badge ext-pack-badge">{{ $t('settings.extensions.pack.membersBadge', { count: pack.members.length }) }}</span>
            </div>
            <div class="ext-card-sub">
              <span v-if="pack.displayName" class="ext-requires ext-pack-id">{{ pack.id }}</span>
              <span class="ext-pack-includes">{{ $t('settings.extensions.pack.includes', { members: pack.members.join(' · ') }) }}</span>
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
        <li v-for="p in nonFactoryInstalled" :key="p.id" class="ext-installed ext-card" :data-id="p.id">
          <MarketplaceIcon v-bind="idParts(p.id)" :label="idParts(p.id).name" :size="36" />
          <div class="ext-card-main">
            <div class="ext-card-title">
              <span class="ext-id" v-truncate>{{ p.id }}</span>
              <span v-if="p.packageVersion" class="ext-requires">{{ $t('settings.extensions.marketplace.versionLabel', { version: p.packageVersion }) }}</span>
              <span v-if="p.pendingCandidateVersion" class="ext-badge ext-candidate">
                {{ $t('settings.extensions.candidateReady', { version: p.pendingCandidateVersion }) }}
              </span>
              <span v-else-if="updatesById.get(p.id)" class="ext-badge ext-update-badge">
                {{ $t('settings.extensions.marketplace.updateAvailableVersion', { version: updatesById.get(p.id)?.latestVersion ?? '' }) }}
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
            <p v-if="p.engineCompatible === false" class="ext-incompatible-reason">
              {{ $t('settings.extensions.incompatibleReason', { version: p.minNavideVersion ?? '' }) }}
            </p>
            <details v-if="p.manifestPermissions || p.packageVersion" class="ext-permission-details">
              <summary>{{ $t('settings.extensions.permissionDetails') }}</summary>
              <span v-if="p.manifestPermissions" class="ext-manifest-permissions">
                {{ $t('settings.extensionsPolicy.labeledValue', { label: $t('settings.extensionsPolicy.manifestPermissions'), value: formatManifestPermissions(p.manifestPermissions) }) }}
              </span>
              <span v-if="p.manifestPermissions?.scopes" class="ext-manifest-scopes">
                {{ $t('settings.extensionsPolicy.labeledValue', { label: manifestScopesLabel(p.manifestPermissions), value: formatManifestScopes(p.manifestPermissions) }) }}
              </span>
              <span
                v-if="p.packageVersion"
                class="ext-package-grant"
                :class="{ 'ext-package-grant-none': !p.packageVersionGrant }"
              >
                {{ $t('settings.extensionsPolicy.labeledValue', { label: $t('settings.extensionsPolicy.packageVersionGrant'), value: formatPackageGrant(p.packageVersionGrant) }) }}
              </span>
            </details>
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
          </div>
          <!-- Actions sit at the row's right edge; details stay in the middle. -->
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
            <button
              v-if="p.rollbackKind"
              class="ext-rollback nv-btn nv-btn--sm"
              :disabled="busy || updateFlow.busy.value"
              @click="rollback(p.id, p.rollbackKind, p.rollbackToVersion)"
            >
              {{
                p.rollbackKind === 'factory'
                  ? $t('settings.extensions.rollback.toBundled')
                  : $t('settings.extensions.rollback.toVersion', { version: p.rollbackToVersion })
              }}
            </button>
            <button class="ext-remove nv-btn nv-btn--sm ext-btn-danger" :disabled="busy || updateFlow.busy.value" @click="remove(p.id)">
              {{ $t('settings.extensions.marketplace.uninstall') }}
            </button>
          </div>
        </li>
        <li v-if="!nonFactoryInstalled.length" class="ext-empty nv-empty">{{ $t('settings.extensions.empty') }}</li>
      </ul>
    </section>

    <NativeBackendPanel />

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
      @confirm-publisher="updateFlow.confirmPublisher"
      @confirm-risk="updateFlow.confirmRisk"
      @cancel="updateFlow.cancel"
    />
  </div>
</template>

<style scoped>
.extensions-pane {
  /* Native controls (checkboxes, scrollbars) follow the theme. */
  color-scheme: var(--nv-color-scheme);
  /* Horizontal gutter matches the settings page gutter so the pane lines up with
     the block above it on the same page; the page body owns the scroll, so this
     pane is a plain block. */
  padding: 0 22px var(--space-6);
  font-size: var(--font-sm);
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
.ext-section-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  color: var(--text-bright);
  font-size: var(--font-md);
  font-weight: 650;
}
.ext-section-title::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 1.5px;
  background: var(--accent-fg);
  transform: rotate(45deg);
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
/* Bundled packages: compact tiles side by side, all one height, their
   actions on the bottom edge. */
.ext-bundled-list {
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr));
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
.ext-factory {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.ext-factory .ext-actions {
  margin-top: auto;
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
.ext-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: var(--space-3);
}
.ext-card-main {
  min-width: 0;
  display: grid;
  gap: 4px;
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
.ext-cap--sensitive {
  background: var(--risk-subtle);
  color: var(--risk-fg);
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  list-style: none;
  width: max-content;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: var(--font-xs);
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
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--bg-inset);
}
.ext-permission-details[open] summary {
  margin-bottom: 4px;
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
  height: 18px;
  padding: 0 7px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
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
  margin: -4px 0 var(--space-3);
  color: var(--accent-fg);
  font-size: var(--font-xs);
}
.ext-manifest-scopes {
  overflow-wrap: anywhere;
}
.ext-risk-note {
  margin: 0;
  color: var(--risk-fg);
  font-size: var(--font-xs);
}
.ext-incompatible-reason {
  margin: 0;
  color: var(--danger-bright);
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
</style>
