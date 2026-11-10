<script setup lang="ts">
// Plan P1 (plugin-comms-security): every installed Navide plugin on one table
// at the top of Settings → Navide Plugins: agent tool calls and capability
// calls in the last minute, the hosts its views reached, the trailing run of
// failed tool calls and its backend's resources. Records only: nothing on
// this table changes what a plugin may do. A row opens that plugin's existing
// Activity panel. Every string a plugin supplied is shown as plain text.
// Plan P2: a running third-party plugin's row has Stop (asked once more in
// place): the Disabled switch, recorded as a stop with what it was doing.
// `paused` stops the polling while the table is out of view.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PluginActivityOverviewHost, PluginActivityOverviewRow } from '../../../shared/pluginActivity'
import type { PluginGlobalStopRecord } from '../../../shared/pluginStop'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'
import { formatBytes } from '../lib/formatBytes'
import PluginActivityPanel from './PluginActivityPanel.vue'

const props = withDefaults(defineProps<{ pollMs?: number; paused?: boolean }>(), { pollMs: 5000, paused: false })
const { t, locale } = useI18n()

interface Row {
  id: string
  version: string
  builtin: boolean
  disabled: boolean
  /** A third-party package with the Disabled switch: it can be stopped here. */
  stoppable: boolean
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
/** The row whose Stop was pressed once and waits for the second press. */
const confirming = ref<string | null>(null)
const stopping = ref<string | null>(null)
const stopError = ref('')
// Plan P3: the global stop in effect, and the two-step Stop all / Resume all.
const globalStop = ref<PluginGlobalStopRecord | null>(null)
const confirmingAll = ref<'stop' | 'resume' | null>(null)
const busyAll = ref(false)
// Plan P5: the automatic-pause switch and the fixed thresholds it discloses.
const autoPause = ref<{ enabled: boolean; thresholds: Record<string, number> } | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

function api() {
  return window.agentTeam?.plugins
}

async function load(): Promise<void> {
  try {
    autoPause.value = (await api()?.autoPauseState?.()) ?? null
    const [list, builtins, answer, statuses, global] = await Promise.all([
      api()?.listInstalled?.() ?? [],
      api()?.disabledBuiltins?.() ?? [],
      api()?.activityOverview?.(),
      api()?.nativeBackends?.resourceStatus?.() ?? [],
      api()?.globalStopState?.() ?? null,
    ])
    installed.value = list
    disabledBuiltins.value = builtins
    resources.value = statuses
    globalStop.value = global
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
  stoppable: pkg.disabled !== undefined && pkg.provenance !== 'factory-bundled',
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

async function stop(id: string): Promise<void> {
  if (confirming.value !== id) {
    confirming.value = id
    return
  }
  confirming.value = null
  stopping.value = id
  stopError.value = ''
  try {
    await api()?.stop?.(id, 'settings')
  } catch (err) {
    stopError.value = t('pluginStop.failed', { id: reveal(id), error: err instanceof Error ? err.message : String(err) })
  } finally {
    stopping.value = null
    await load()
  }
}

const runningStoppable = computed(() => rows.value.filter((row) => row.stoppable && !row.disabled).length)

/** Stop all or Resume all, each asked once more in place. */
async function all(action: 'stop' | 'resume'): Promise<void> {
  if (confirmingAll.value !== action) {
    confirmingAll.value = action
    return
  }
  confirmingAll.value = null
  busyAll.value = true
  stopError.value = ''
  try {
    const result = action === 'stop' ? await api()?.stopAll?.('settings') : await api()?.resumeAll?.()
    const failed = (result?.failed ?? []).map((entry) => entry.id).filter((id) => id !== '')
    if (failed.length) stopError.value = t(`pluginStop.all.${action}Failed`, { ids: failed.map((id) => reveal(id)).join(', ') })
  } catch (err) {
    stopError.value = t(`pluginStop.all.${action}Failed`, { ids: err instanceof Error ? err.message : String(err) })
  } finally {
    busyAll.value = false
    await load()
  }
}

async function setAutoPause(enabled: boolean): Promise<void> {
  try {
    autoPause.value = (await api()?.setAutoPause?.(enabled)) ?? autoPause.value
  } catch (err) {
    stopError.value = err instanceof Error ? err.message : String(err)
  }
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
    <div class="nv-monitor-head">
      <p class="nv-monitor-muted">{{ $t('pluginActivity.monitor.intro') }}</p>
      <div v-if="!globalStop && runningStoppable > 0" class="nv-monitor-head-actions">
        <button
          type="button"
          class="nv-btn nv-btn--sm nv-monitor-stop-all"
          :class="{ 'nv-monitor-stop--confirm': confirmingAll === 'stop' }"
          :disabled="busyAll"
          :title="$t('pluginStop.all.note')"
          @click="all('stop')"
        >{{ busyAll ? $t('pluginStop.stopping') : confirmingAll === 'stop' ? $t('pluginStop.all.confirm') : $t('pluginStop.all.stop') }}</button>
        <button v-if="confirmingAll === 'stop'" type="button" class="nv-btn nv-btn--sm" @click="confirmingAll = null">{{ $t('pluginStop.cancel') }}</button>
      </div>
    </div>
    <div v-if="autoPause" class="nv-monitor-auto">
      <label class="nv-monitor-auto-switch">
        <input type="checkbox" :checked="autoPause.enabled" @change="setAutoPause(($event.target as HTMLInputElement).checked)" />
        {{ $t('pluginStop.autoPause.label') }}
      </label>
      <p class="nv-monitor-muted">{{ $t('pluginStop.autoPause.thresholds', autoPause.thresholds) }}</p>
    </div>
    <div v-if="globalStop" class="nv-monitor-global" role="status">
      <p>
        <strong>{{ $t('pluginStop.all.heading') }}</strong>
        {{ $t('pluginStop.all.banner', { date: new Date(globalStop.at).toLocaleString(locale), via: $t(`pluginStop.via.${globalStop.via}`), count: globalStop.stopped.length }) }}
      </p>
      <div class="nv-monitor-head-actions">
        <button
          type="button"
          class="nv-btn nv-btn--sm nv-btn--primary nv-monitor-resume-all"
          :disabled="busyAll"
          :title="$t('pluginStop.all.resumeNote')"
          @click="all('resume')"
        >{{ confirmingAll === 'resume' ? $t('pluginStop.all.resumeConfirm') : $t('pluginStop.all.resume') }}</button>
        <button v-if="confirmingAll === 'resume'" type="button" class="nv-btn nv-btn--sm" @click="confirmingAll = null">{{ $t('pluginStop.cancel') }}</button>
      </div>
    </div>
    <p v-if="loading" class="nv-monitor-muted">{{ $t('pluginActivity.loading') }}</p>
    <template v-else>
      <p v-if="error" class="nv-monitor-muted nv-monitor-error" role="status">{{ error }}</p>
      <p v-if="stopError" class="nv-monitor-error" role="alert">{{ stopError }}</p>
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
              <th scope="col"><span class="nv-monitor-sr">{{ $t('pluginStop.column') }}</span></th>
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
                  <span v-if="row.activity?.headlessViews" class="nv-monitor-chip nv-monitor-headless">
                    {{ $t('pluginActivity.monitor.headless', { count: row.activity.headlessViews }) }}
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
                <td class="nv-monitor-actions">
                  <template v-if="row.stoppable && !row.disabled">
                    <button
                      type="button"
                      class="nv-btn nv-btn--sm nv-monitor-stop"
                      :class="{ 'nv-monitor-stop--confirm': confirming === row.id }"
                      :disabled="stopping !== null"
                      :title="$t('pluginStop.note', { id: reveal(row.id) })"
                      @click="stop(row.id)"
                    >{{ stopping === row.id ? $t('pluginStop.stopping') : confirming === row.id ? $t('pluginStop.confirm') : $t('pluginStop.stop') }}</button>
                    <button
                      v-if="confirming === row.id"
                      type="button"
                      class="nv-btn nv-btn--sm nv-monitor-cancel"
                      @click="confirming = null"
                    >{{ $t('pluginStop.cancel') }}</button>
                  </template>
                </td>
              </tr>
              <tr v-if="open === row.id" class="nv-monitor-detail">
                <td colspan="8">
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
.nv-monitor-auto {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--font-xs);
}
.nv-monitor-auto-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-weight: 600;
  color: var(--text-primary);
}
.nv-monitor-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
}
.nv-monitor-head > p {
  flex: 1 1 24em;
}
.nv-monitor-head-actions {
  display: flex;
  gap: var(--space-1);
  flex: none;
}
/* Plan P3: every third-party plugin is stopped. */
.nv-monitor-global {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--danger-fg);
  border-radius: var(--radius-sm);
  background: var(--danger-subtle);
  color: var(--danger-fg);
}
.nv-monitor-global p {
  flex: 1 1 24em;
}
.nv-monitor-actions {
  white-space: nowrap;
}
.nv-monitor-actions .nv-btn + .nv-btn {
  margin-left: var(--space-1);
}
.nv-monitor-stop.nv-monitor-stop--confirm,
.nv-monitor-stop-all.nv-monitor-stop--confirm {
  background: var(--danger-emphasis);
  border-color: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.nv-monitor-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.nv-monitor-detail > td {
  background: var(--bg-subtle);
}
</style>
