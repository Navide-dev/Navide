<script setup lang="ts">
// Plan P1 (plugin-comms-security): every installed Navide plugin on one table
// at the top of Settings → Navide Plugins: agent tool calls and capability
// calls in the last minute, the hosts its views reached, the trailing run of
// failed tool calls and its backend's resources. Records only: nothing on
// this table changes what a plugin may do. A row opens that plugin's existing
// Activity panel. Every string a plugin supplied is shown as plain text.
// `paused` stops the polling while the table is out of view.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PluginActivityOverviewHost, PluginActivityOverviewRow } from '../../../shared/pluginActivity'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'
import { formatBytes } from '../lib/formatBytes'
import PluginActivityPanel from './PluginActivityPanel.vue'

const props = withDefaults(defineProps<{ pollMs?: number; paused?: boolean }>(), { pollMs: 5000, paused: false })
const { t } = useI18n()

interface Row {
  id: string
  version: string
  builtin: boolean
  disabled: boolean
  activity: PluginActivityOverviewRow | null
  resources: BackendResourceStatusView | null
}

const installed = ref<InstalledPluginSummary[]>([])
const disabledBuiltins = ref<string[]>([])
const activity = ref<Map<string, PluginActivityOverviewRow>>(new Map())
const resources = ref<BackendResourceStatusView[]>([])
const error = ref('')
const loading = ref(true)
const open = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

function api() {
  return window.agentTeam?.plugins
}

async function load(): Promise<void> {
  try {
    const [list, builtins, answer, statuses] = await Promise.all([
      api()?.listInstalled?.() ?? [],
      api()?.disabledBuiltins?.() ?? [],
      api()?.activityOverview?.(),
      api()?.nativeBackends?.resourceStatus?.() ?? [],
    ])
    installed.value = list
    disabledBuiltins.value = builtins
    resources.value = statuses
    if (!answer) error.value = t('pluginActivity.unavailable', { error: t('pluginActivity.notSupported') })
    else if (answer.ok) {
      activity.value = new Map(answer.overview.plugins.map((row) => [row.pluginId, row]))
      error.value = ''
    } else error.value = t('pluginActivity.unavailable', { error: answer.error })
  } catch (err) {
    error.value = t('pluginActivity.unavailable', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    loading.value = false
  }
}

const rows = computed<Row[]>(() => installed.value.map((pkg) => ({
  id: pkg.id,
  version: pkg.packageVersion ?? '',
  builtin: pkg.provenance === 'factory-bundled',
  disabled: pkg.disabled === true || disabledBuiltins.value.includes(pkg.id),
  activity: activity.value.get(pkg.id) ?? null,
  resources: resources.value.find((entry) => entry.pluginId === pkg.id) ?? null,
})))

/** Not declared, or refused: shown in red. A host with nothing to compare
 *  against (no Manifest v2 disclosure) is shown plainly. */
function hostFlagged(host: PluginActivityOverviewHost): boolean {
  return host.refused || host.declared === false
}

function hostText(host: PluginActivityOverviewHost): string {
  if (host.refused) return t('pluginActivity.monitor.hostRefused', { host: reveal(host.host) })
  if (host.declared === false) return t('pluginActivity.monitor.hostUndeclared', { host: reveal(host.host) })
  return reveal(host.host)
}

function resourcesOver(entry: BackendResourceStatusView): boolean {
  return (Object.keys(entry.usage) as Array<keyof BackendResourceStatusView['usage']>)
    .some((item) => entry.usage[item] > entry.thresholds[item])
}

function toggle(id: string): void {
  open.value = open.value === id ? null : id
}

function startPolling(): void {
  if (timer || props.paused) return
  void load()
  timer = setInterval(() => void load(), props.pollMs)
}

function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

watch(() => props.paused, (paused) => { if (paused) stopPolling(); else startPolling() })
onMounted(startPolling)
onBeforeUnmount(stopPolling)
</script>

<template>
  <section class="nv-monitor" data-settings-section="pluginActivityMonitor" :aria-label="$t('pluginActivity.monitor.title')">
    <h2 class="nv-monitor-title">{{ $t('pluginActivity.monitor.title') }}</h2>
    <p class="nv-monitor-muted">{{ $t('pluginActivity.monitor.intro') }}</p>
    <p v-if="loading" class="nv-monitor-muted">{{ $t('pluginActivity.loading') }}</p>
    <template v-else>
      <p v-if="error" class="nv-monitor-muted nv-monitor-error" role="status">{{ error }}</p>
      <p v-if="rows.length === 0" class="nv-monitor-muted">{{ $t('pluginActivity.monitor.empty') }}</p>
      <div v-else class="nv-monitor-scroll">
        <table class="nv-monitor-table">
          <thead>
            <tr>
              <th scope="col">{{ $t('pluginActivity.monitor.column.plugin') }}</th>
              <th scope="col">{{ $t('pluginActivity.monitor.column.status') }}</th>
              <th scope="col" class="nv-monitor-num">{{ $t('pluginActivity.monitor.column.toolCalls') }}</th>
              <th scope="col" class="nv-monitor-num">{{ $t('pluginActivity.monitor.column.capabilityCalls') }}</th>
              <th scope="col">{{ $t('pluginActivity.monitor.column.hosts') }}</th>
              <th scope="col" class="nv-monitor-num">{{ $t('pluginActivity.monitor.column.failures') }}</th>
              <th scope="col">{{ $t('pluginActivity.monitor.column.resources') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in rows" :key="row.id">
              <tr class="nv-monitor-row" :data-id="row.id">
                <th scope="row">
                  <button
                    type="button"
                    class="nv-monitor-open"
                    :aria-expanded="open === row.id"
                    :aria-label="$t('pluginActivity.monitor.open', { id: reveal(row.id) })"
                    @click="toggle(row.id)"
                  >{{ reveal(row.id) }}</button>
                  <span class="nv-monitor-muted nv-monitor-meta">{{ reveal(row.version) }}</span>
                  <span v-if="row.builtin" class="nv-monitor-muted nv-monitor-meta">· {{ $t('pluginActivity.monitor.builtin') }}</span>
                </th>
                <td>
                  <span class="nv-monitor-chip" :class="row.disabled ? 'nv-monitor-chip--off' : 'nv-monitor-chip--on'">
                    {{ row.disabled ? $t('pluginActivity.monitor.status.disabled') : $t('pluginActivity.monitor.status.running') }}
                  </span>
                </td>
                <td class="nv-monitor-num">{{ row.activity ? row.activity.toolCallsLastMinute : '—' }}</td>
                <td class="nv-monitor-num">{{ row.activity ? row.activity.capabilityCallsLastMinute : '—' }}</td>
                <td>
                  <div v-if="row.activity && row.activity.hosts.length" class="nv-monitor-hosts">
                    <span
                      v-for="host in row.activity.hosts"
                      :key="host.host"
                      class="nv-monitor-host"
                      :class="{ 'nv-monitor-host--flagged': hostFlagged(host) }"
                    >{{ hostText(host) }}</span>
                  </div>
                  <span v-else class="nv-monitor-muted">{{ $t('pluginActivity.monitor.noHosts') }}</span>
                </td>
                <td class="nv-monitor-num" :class="{ 'nv-monitor-attention': (row.activity?.consecutiveFailures ?? 0) > 0 }">
                  {{ row.activity ? row.activity.consecutiveFailures : '—' }}
                </td>
                <td>
                  <template v-if="row.resources">
                    {{ formatBytes(row.resources.usage.memory) }}
                    <span v-if="resourcesOver(row.resources)" class="nv-monitor-attention"> · {{ $t('pluginActivity.resources.over') }}</span>
                  </template>
                  <span v-else class="nv-monitor-muted">{{ $t('pluginActivity.monitor.noBackend') }}</span>
                </td>
              </tr>
              <tr v-if="open === row.id" class="nv-monitor-detail">
                <td colspan="7">
                  <PluginActivityPanel :plugin-id="row.id" :poll-ms="props.pollMs" :paused="props.paused" />
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.nv-monitor {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) 22px var(--space-4);
  font-size: var(--font-sm);
}
.nv-monitor p,
.nv-monitor-title {
  margin: 0;
}
.nv-monitor-title {
  color: var(--text-bright);
  font-size: var(--font-md);
  font-weight: 600;
}
.nv-monitor-muted {
  color: var(--text-secondary);
}
.nv-monitor-error {
  color: var(--danger-fg);
}
.nv-monitor-scroll {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.nv-monitor-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-xs);
}
.nv-monitor-table th,
.nv-monitor-table td {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.nv-monitor-table thead th {
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-weight: 600;
  white-space: nowrap;
}
.nv-monitor-table tbody tr:last-child > * {
  border-bottom: 0;
}
.nv-monitor-table tbody th {
  font-weight: 500;
}
.nv-monitor-table .nv-monitor-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.nv-monitor-open {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent-fg);
  font: inherit;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.nv-monitor-meta {
  margin-left: var(--space-1);
  font-weight: 400;
}
.nv-monitor-open:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: 2px;
}
.nv-monitor-chip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font-weight: 600;
  white-space: nowrap;
}
.nv-monitor-chip--on {
  background: var(--success-subtle);
  color: var(--success-fg);
}
.nv-monitor-chip--off {
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.nv-monitor-hosts {
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--space-2);
}
.nv-monitor-host--flagged {
  color: var(--danger-fg);
  font-weight: 600;
}
.nv-monitor-attention {
  color: var(--attention-fg);
  font-weight: 600;
}
.nv-monitor-detail > td {
  background: var(--bg-subtle);
}
</style>
