<script setup lang="ts">
// Third-party native backends: the global switch (on by default), and per
// plugin the current state, consent, disable, and workspace write grants.
// The Host owns every decision; this panel only shows it and forwards the
// user's choices. Installing is the first consent; changed-binary consent is
// asked by the Host in a native dialog when the plugin's backend is next needed.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ipcErrorMessage } from '../composables/usePluginInstallFlow'
import { usePluginInventory } from '../composables/usePluginInventory'
import MarketplaceIcon from './MarketplaceIcon.vue'
import PluginAgentToolsList from './PluginAgentToolsList.vue'
import SettingsCard from './settings/SettingsCard.vue'
import SettingRow from './settings/SettingRow.vue'
import SettingsNotice from './settings/SettingsNotice.vue'
import SettingsEmptyState from './settings/SettingsEmptyState.vue'
import ToggleSwitch from './settings/ToggleSwitch.vue'
import { leadSentence } from '../lib/leadSentence'

const { t } = useI18n()
// The warning leads with its first sentence in bold; every word stays.
const nativeWarning = computed(() => leadSentence(t('settings.extensions.nativeBackends.description')))
const overview = ref<NativeBackendOverview | null>(null)
// The switches that are on, by their titles, for the Settings sidebar's "On" mark.
const emit = defineEmits<{ on: [switches: string[]] }>()
const switchesOn = computed<string[]>(() => {
  const o = overview.value
  if (!o) return []
  const out: string[] = []
  if (o.enabled) out.push(t('settings.extensions.nativeBackends.enable'))
  if (o.agentTools && o.agentTools.firstParty !== false) out.push(t('settings.extensions.nativeBackends.agentTools.firstParty'))
  if (o.agentTools?.enabled) out.push(t('settings.extensions.nativeBackends.agentTools.enable'))
  if (o.agentTools?.enabled && o.agentTools.externalCallers) out.push(t('settings.extensions.nativeBackends.agentTools.externalCallers'))
  return out
})
watch(switchesOn, (switches) => emit('on', switches), { immediate: true })
const busy = ref(false)
const error = ref('')
const noAnswer = ref(false)

function api() {
  return window.agentTeam?.plugins?.nativeBackends
}

/** #642 review L2: a failed "off" save still holds "off" for this run, so
 *  the page reloads the real state, which carries the unsaved notice. */
async function setMasterSwitch(on: boolean): Promise<void> {
  await run(() => api()!.setEnabled(on))
  if (!error.value || on) return
  const failure = error.value
  await run(() => api()!.list())
  error.value ||= failure
}

async function run(action: () => Promise<NativeBackendOverview>): Promise<void> {
  busy.value = true
  error.value = ''
  noAnswer.value = false
  try {
    const next = await action()
    // No answer is a failed read: keep the last state the page showed.
    if (next && Array.isArray(next.plugins)) overview.value = next
    else noAnswer.value = true
  } catch (err) {
    error.value = ipcErrorMessage(err)
  } finally {
    busy.value = false
  }
}

const STATUS_KEYS: Record<NativeBackendStatusRow['status'], string> = {
  ready: 'ready',
  'disabled-globally': 'disabledGlobally',
  disabled: 'disabled',
  'needs-consent': 'needsConsent',
  'sandbox-unavailable': 'sandboxUnavailable',
  'shell-not-allowed': 'shellNotAllowed',
  'stopped-after-crashes': 'stoppedAfterCrashes',
  unavailable: 'unavailable',
}

function statusText(row: NativeBackendStatusRow): string {
  return t(`settings.extensions.nativeBackends.status.${STATUS_KEYS[row.status]}`)
}

function refresh(): void {
  const backends = api()
  if (backends) void run(() => backends.list())
  else noAnswer.value = true
}

onMounted(refresh)
// An install or removal on either plugin page changes which rows exist.
const { installed } = usePluginInventory()
watch(installed, refresh)
</script>

<template>
  <!-- Before the first answer the section says it is loading, or why it is
       not there, with Retry: never an empty page. -->
  <section v-if="!overview" class="ext-section native-backends" aria-labelledby="native-backends-title" data-settings-section="extensions-native-backends">
    <h3 id="native-backends-title" class="native-backends-title">{{ $t('settings.extensions.nativeBackends.title') }}</h3>
    <p v-if="!error && !noAnswer" class="native-backends-state nv-loading" role="status">{{ $t('label.loading') }}</p>
    <div v-else class="native-backends-state nv-empty" role="alert">
      <p class="native-backends-state-text">{{ $t('settings.extensions.nativeBackends.loadFailed') }}</p>
      <code v-if="error" class="native-backends-state-detail">{{ error }}</code>
      <button type="button" class="native-backends-retry nv-btn nv-btn--sm" :disabled="busy" @click="refresh">
        {{ $t('settings.extensions.marketplace.retry') }}
      </button>
    </div>
  </section>
  <section v-else class="ext-section native-backends" aria-labelledby="native-backends-title" data-settings-section="extensions-native-backends">
    <h3 id="native-backends-title" class="native-backends-title">{{ $t('settings.extensions.nativeBackends.title') }}</h3>
    <p v-if="error" class="ext-error" role="alert">{{ error }}</p>
    <!-- One card: the warning about native code sits right above the switch it
         governs, and the external-callers switch is indented under the switch
         it depends on. -->
    <SettingsCard class="native-backends-card">
      <SettingsNotice class="native-backends-callout" tone="warning">
        <!-- The risk in one sentence; the whole account folds under Learn more. -->
        <p class="native-backends-description"><strong class="native-backends-lead">{{ $t('settings.extensions.nativeBackends.summary') }}</strong></p>
        <details class="native-backends-more settings-more">
          <summary>{{ $t('action.learn-more') }}</summary>
          <p>{{ nativeWarning.lead }}{{ nativeWarning.separator }}{{ nativeWarning.rest }}</p>
        </details>
      </SettingsNotice>
      <SettingRow :title="$t('settings.extensions.nativeBackends.enable')">
        <template #control>
          <ToggleSwitch
            data-native-backends-switch="enabled"
            :model-value="overview.enabled"
            :disabled="busy"
            :aria-label="$t('settings.extensions.nativeBackends.enable')"
            @update:model-value="setMasterSwitch"
          />
        </template>
      </SettingRow>
      <div v-if="overview.offUnsaved" class="native-backends-unsaved" role="status">
        <p>{{ $t('settings.extensions.nativeBackends.offUnsaved') }}</p>
        <button
          type="button"
          class="native-backends-unsaved-retry nv-btn nv-btn--sm"
          :disabled="busy"
          @click="setMasterSwitch(false)"
        >
          {{ $t('settings.extensions.nativeBackends.offUnsavedRetry') }}
        </button>
      </div>
      <template v-if="overview.agentTools && api()?.setAgentTools">
        <SettingRow
          :title="$t('settings.extensions.nativeBackends.agentTools.firstParty')"
          :description="$t('settings.extensions.nativeBackends.agentTools.firstPartyDescription')"
        >
          <template #control>
            <ToggleSwitch
              data-agent-tools-switch="firstParty"
              :model-value="overview.agentTools.firstParty !== false"
              :disabled="busy"
              :aria-label="$t('settings.extensions.nativeBackends.agentTools.firstParty')"
              @update:model-value="(on: boolean) => run(() => api()!.setAgentTools!({ firstParty: on }))"
            />
          </template>
        </SettingRow>
        <SettingRow
          :title="$t('settings.extensions.nativeBackends.agentTools.enable')"
          :description="$t('settings.extensions.nativeBackends.agentTools.description')"
        >
          <template #control>
            <ToggleSwitch
              data-agent-tools-switch="enabled"
              :model-value="overview.agentTools.enabled"
              :disabled="busy"
              :aria-label="$t('settings.extensions.nativeBackends.agentTools.enable')"
              @update:model-value="(on: boolean) => run(() => api()!.setAgentTools!({ enabled: on }))"
            />
          </template>
        </SettingRow>
        <SettingRow
          class="native-backends-dependent"
          :title="$t('settings.extensions.nativeBackends.agentTools.externalCallers')"
          :description="$t('settings.extensions.nativeBackends.agentTools.externalCallersDisclosure')"
        >
          <template #control>
            <ToggleSwitch
              data-agent-tools-switch="externalCallers"
              :model-value="overview.agentTools.externalCallers"
              :disabled="busy || !overview.agentTools.enabled"
              :aria-label="$t('settings.extensions.nativeBackends.agentTools.externalCallers')"
              @update:model-value="(on: boolean) => run(() => api()!.setAgentTools!({ externalCallers: on }))"
            />
          </template>
        </SettingRow>
      </template>
    </SettingsCard>
    <!-- Below the switches: what they currently govern, not a precondition read before the warning. -->
    <SettingsEmptyState v-if="overview.plugins.length === 0" class="native-backends-empty" :message="$t('settings.extensions.nativeBackends.empty')" />
    <ul v-if="overview.plugins.length" class="ext-list">
      <li
        v-for="row in overview.plugins"
        :key="row.pluginId"
        class="ext-installed native-backend-row"
        :data-native-backend-id="row.pluginId"
      >
        <MarketplaceIcon
          :namespace="row.pluginId.slice(0, Math.max(0, row.pluginId.indexOf('.')))"
          :name="row.pluginId.slice(row.pluginId.indexOf('.') + 1)"
          :label="row.name"
          :size="32"
        />
        <span class="native-backend-name">
          <span class="ext-id">{{ row.name }}</span>
          <span class="ext-requires">{{ row.pluginId }} · {{ row.packageVersion }}</span>
        </span>
        <span class="ext-badge native-backend-status" :class="`native-backend-status--${row.status}`" role="status">{{ statusText(row) }}</span>
        <span
          v-if="row.shell === 'allowlist'"
          class="ext-badge native-backend-shell"
          :title="$t('settings.extensions.nativeBackends.shellRiskDetail')"
        >{{ $t('settings.extensions.nativeBackends.shellRisk') }}</span>
        <button
          v-if="row.status === 'needs-consent' || row.status === 'stopped-after-crashes'"
          class="nv-btn nv-btn--sm"
          :disabled="busy"
          @click="run(() => api()!.allow(row.pluginId))"
        >
          {{ $t('settings.extensions.nativeBackends.allow') }}
        </button>
        <button
          class="nv-btn nv-btn--sm"
          :disabled="busy"
          :aria-pressed="row.status === 'disabled'"
          @click="run(() => api()!.setDisabled(row.pluginId, row.status !== 'disabled'))"
        >
          {{
            row.status === 'disabled'
              ? $t('settings.extensions.nativeBackends.enable_plugin')
              : $t('settings.extensions.nativeBackends.disable')
          }}
        </button>
        <div class="ext-permission-details">
          <span v-if="row.shell === 'allowlist'" class="native-backend-shell-detail">
            {{ $t('settings.extensions.nativeBackends.shellRiskDetail') }}
          </span>
          <span v-if="row.changedSinceConsent">{{ $t('settings.extensions.nativeBackends.changed') }}</span>
          <span v-if="row.allowedBy === 'pre-0.2.31-install'" class="native-backend-pre-install">
            {{ $t('settings.extensions.nativeBackends.allowedPreInstall') }}
          </span>
          <span v-if="row.declined" class="native-backend-declined">
            {{ $t('settings.extensions.nativeBackends.declined') }}
          </span>
          <span v-if="row.reason && row.status !== 'needs-consent'">{{ row.reason }}</span>
          <span v-if="row.lastViolation">
            {{
              $t('settings.extensions.nativeBackends.violation', {
                kind: $t(`settings.extensions.nativeBackends.kinds.${row.lastViolation}`),
              })
            }}
          </span>
          <span v-for="path in row.workspaceWrite" :key="path" class="native-backend-write">
            {{ $t('settings.extensions.nativeBackends.writeAllowed', { path }) }}
            <button
              class="nv-btn nv-btn--sm"
              :disabled="busy"
              @click="run(() => api()!.revokeWorkspaceWrite(row.pluginId, path))"
            >
              {{ $t('settings.extensions.nativeBackends.revoke') }}
            </button>
          </span>
          <PluginAgentToolsList v-if="row.agentTools?.length" :tools="row.agentTools" />
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.native-backends {
  margin-bottom: var(--space-6);
  /* Native controls (checkboxes, scrollbars) follow the theme. */
  color-scheme: var(--nv-color-scheme);
}
/* The section heading is SettingsSection's label. */
.native-backends-title {
  margin: 0 0 8px;
  color: var(--text-secondary);
  font-size: var(--font-row-desc);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
/* The warning is the first row of the switch card: SettingsNotice, flush
   with the card's edges. */
.native-backends-callout {
  margin: 0;
  padding-block: var(--space-3);
  border-radius: 0;
  background: transparent;
}
.native-backends-description {
  margin: 0;
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}
.native-backends-more { margin-top: 4px; }
/* External callers only apply once agent tools are on: indented under that switch. */
.native-backends-dependent {
  padding-left: calc(var(--space-row-x) + 24px);
}
.native-backends-card {
  margin-bottom: var(--space-3);
}
/* Nothing installed has a native backend: said in a line, not a box. */
.native-backends-empty {
  margin: var(--space-2) 0 0;
}
.native-backends-unsaved {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  color: var(--warning-fg);
}
.native-backends-unsaved p {
  margin: 0;
  flex: 1;
}
.native-backends-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}
.native-backends-state-text {
  margin: 0;
}
.native-backends-state-detail {
  font-size: var(--font-2xs);
  overflow-wrap: anywhere;
}
.ext-error {
  margin: var(--space-3) 0;
  padding: 8px 10px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-sm);
  background: var(--danger-subtle);
  color: var(--danger-bright);
  font-size: var(--font-xs);
}
.ext-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-2);
}
.native-backend-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.native-backend-name {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 2px;
}
.ext-id {
  color: var(--text-bright);
  font-size: var(--font-md);
  font-weight: 600;
}
.ext-requires {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
}
.ext-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: var(--radius-pill);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  white-space: nowrap;
}
.native-backend-status--ready {
  background: var(--success-subtle);
  color: var(--success-fg);
}
.native-backend-status--needs-consent,
.native-backend-status--sandbox-unavailable,
.native-backend-shell {
  background: var(--risk-subtle);
  color: var(--risk-fg);
}
.native-backend-status--shell-not-allowed {
  background: var(--risk-subtle);
  color: var(--risk-fg);
}
.native-backend-status--stopped-after-crashes {
  background: var(--danger-subtle);
  color: var(--danger-bright);
}
.ext-permission-details {
  flex: 1 1 100%;
  display: grid;
  gap: 4px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.ext-permission-details:empty {
  display: none;
}
.native-backend-write {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}
/* Long setting descriptions keep a readable line length. */
:deep(.setting-row-desc) {
  max-width: 72ch;
  line-height: var(--lh-base);
}
/* A switch that waits on the one above stays legible while unavailable. */
:deep(.toggle-switch:disabled) {
  opacity: 0.6;
}
.native-backends-lead {
  color: var(--text-bright);
  font-weight: 600;
}
</style>
