<script setup lang="ts">
// Third-party native backends: the global switch (off by default), and per
// plugin the current state, consent, disable, and workspace write grants.
// The Host owns every decision; this panel only shows it and forwards the
// user's choices. First-time and changed-binary consent is asked by the Host
// in a native dialog when the plugin's backend is first needed.
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ipcErrorMessage } from '../composables/usePluginInstallFlow'
import { usePluginInventory } from '../composables/usePluginInventory'
import MarketplaceIcon from './MarketplaceIcon.vue'
import PluginAgentToolsList from './PluginAgentToolsList.vue'

const { t } = useI18n()
const overview = ref<NativeBackendOverview | null>(null)
const busy = ref(false)
const error = ref('')

function api() {
  return window.agentTeam?.plugins?.nativeBackends
}

async function run(action: () => Promise<NativeBackendOverview>): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    overview.value = await action()
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
}

onMounted(refresh)
// An install or removal on either plugin page changes which rows exist.
const { installed } = usePluginInventory()
watch(installed, refresh)
</script>

<template>
  <section v-if="overview" class="ext-section native-backends" aria-labelledby="native-backends-title">
    <h3 id="native-backends-title" class="native-backends-title">{{ $t('settings.extensions.nativeBackends.title') }}</h3>
    <div class="native-backends-callout">
      <svg class="native-backends-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M7.1 2.6 1.9 12a1 1 0 0 0 .9 1.5h10.4a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z" />
        <path d="M8 6.2v3M8 11.3v.1" />
      </svg>
      <p class="native-backends-description">{{ $t('settings.extensions.nativeBackends.description') }}</p>
    </div>
    <p v-if="error" class="ext-error" role="alert">{{ error }}</p>
    <label class="native-backends-switch">
      <input
        type="checkbox"
        class="nv-check"
        :checked="overview.enabled"
        :disabled="busy"
        @change="run(() => api()!.setEnabled(($event.target as HTMLInputElement).checked))"
      />
      {{ $t('settings.extensions.nativeBackends.enable') }}
    </label>
    <p v-if="overview.plugins.length === 0" class="native-backends-empty">
      {{ $t('settings.extensions.nativeBackends.empty') }}
    </p>
    <ul v-else class="ext-list">
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
          <span v-if="row.changedSinceConsent">{{ $t('settings.extensions.nativeBackends.changed') }}</span>
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
.native-backends-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-3);
  color: var(--text-bright);
  font-size: var(--font-md);
  font-weight: 650;
}
/* This panel lets third-party code run natively: the warning leads. */
.native-backends-title::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 1.5px;
  background: var(--risk-fg);
  transform: rotate(45deg);
}
.native-backends-callout {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--risk-muted);
  border-left: 3px solid var(--risk-fg);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  background: var(--risk-subtle);
  color: var(--text-primary);
}
.native-backends-icon {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  color: var(--risk-fg);
}
.native-backends-description {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-base);
}
.native-backends-switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-3) 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text-bright);
  font-weight: 600;
  cursor: pointer;
}
.native-backends-empty {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
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
</style>
