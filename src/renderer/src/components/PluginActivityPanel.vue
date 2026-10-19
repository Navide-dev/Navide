<script setup lang="ts">
// Plan B D3 / D-f: one installed plugin's activity. Everything here is a
// record; nothing is blocked or capped from this page. Every string is shown
// as plain text (no links, no HTML): paths and commands come from the plugin,
// so invisible characters in them are shown as \u{...} like on the card.
//
// Two sources, kept apart (contract 5.1): the backend's report (the last 7
// days of recorded calls, the 30-day undeclared list, the daily trend) and the
// Host's live numbers (calls in flight now, bound views, queue backlog), read
// from plugins:backendCallConcurrency and, once #367 lands,
// plugins:backendResourceUsage. Sizes of -1 are unknown: shown as such and
// never added up.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  sumKnownBytes,
  UNKNOWN_BYTES,
  type PluginActivityReport,
  type PluginActivityToolCall,
} from '../../../shared/pluginActivity'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'
import { formatBytes } from '../lib/formatBytes'
import { createQueueTrend, pluginBackendUsage, type PluginBackendUsage } from '../lib/backendQueueTrend'

// `paused` stops the live polling while the panel is out of view.
const props = withDefaults(defineProps<{ pluginId: string; pollMs?: number; paused?: boolean }>(), { pollMs: 5000, paused: false })
const { t, te, locale } = useI18n()

const report = ref<PluginActivityReport | null>(null)
const error = ref('')
const loading = ref(true)
const live = ref<{ current: number; peak: number; droppedNotifications: number } | null>(null)
const backend = ref<PluginBackendUsage | null>(null)
const queueGrowing = ref(false)
// Watchdog option C: this backend's usage against its thresholds (live).
const resources = ref<BackendResourceStatusView | null>(null)
const RESOURCE_ITEMS = ['memory', 'cpu', 'processes', 'disk', 'stdoutPending'] as const
const trend = createQueueTrend()
let timer: ReturnType<typeof setInterval> | null = null

function api() {
  return window.agentTeam?.plugins
}

async function loadReport(): Promise<void> {
  loading.value = true
  try {
    const answer = await api()?.activityReport?.(props.pluginId)
    if (!answer) error.value = t('pluginActivity.unavailable', { error: t('pluginActivity.notSupported') })
    else if (answer.ok) report.value = answer.report
    else error.value = t('pluginActivity.unavailable', { error: answer.error })
  } catch (err) {
    error.value = t('pluginActivity.unavailable', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    loading.value = false
  }
}

async function loadLive(): Promise<void> {
  try {
    const rows = (await api()?.backendCallConcurrency?.()) ?? []
    live.value = rows.find((row) => row.pluginId === props.pluginId) ?? null
    const usage = await api()?.backendResourceUsage?.()
    backend.value = usage ? pluginBackendUsage(usage, props.pluginId) : null
    queueGrowing.value = backend.value
      ? trend.add(props.pluginId, backend.value.requests.bytes + backend.value.events.bytes)
      : false
    const statuses = (await api()?.nativeBackends?.resourceStatus?.()) ?? []
    resources.value = statuses.find((row) => row.pluginId === props.pluginId) ?? null
  } catch {
    // Live numbers are advisory; the report below still shows.
  }
}

function startPolling(): void {
  if (timer || props.paused) return
  void loadLive()
  timer = setInterval(() => void loadLive(), props.pollMs)
}

function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

watch(() => props.paused, (paused) => { if (paused) stopPolling(); else startPolling() })
onMounted(() => {
  void loadReport()
  startPolling()
})
onBeforeUnmount(stopPolling)

function date(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleString(locale.value)
}

function size(bytes: number): string {
  return bytes === UNKNOWN_BYTES ? t('pluginActivity.unknownSize') : formatBytes(bytes)
}

function outcome(value: string): string {
  const key = `pluginActivity.outcome.${value}`
  return te(key) ? t(key) : reveal(value)
}

/** The fixed values recorded in place of text a plugin wrote (contract 5),
 *  each only with the outcome it is recorded for: shown as what it means,
 *  styled apart from a real path, command or address. With any other outcome
 *  the same spelling is the plugin's own text and is shown as it is. */
const MARKERS: Readonly<Record<string, { key: string; outcome: (value: string) => boolean }>> = {
  '<denied>': { key: 'denied', outcome: (value) => value === 'denied' },
  '<failed>': { key: 'failed', outcome: (value) => value === 'error' },
  '<missing>': { key: 'missing', outcome: (value) => value === 'allowed' },
  '<unknown>': { key: 'unknown', outcome: (value) => value !== 'allowed' },
}

function isMarker(value: string, outcome: string): boolean {
  return Object.hasOwn(MARKERS, value) && MARKERS[value].outcome(outcome)
}

function shown(value: string, outcome: string): string {
  return isMarker(value, outcome) ? t(`pluginActivity.marker.${MARKERS[value].key}`) : reveal(value)
}

/** A source, kind or refusal reason in words; anything unknown stays as given (L5 on #371). */
function word(group: 'source' | 'kind' | 'reason', value: string): string {
  const key = `pluginActivity.${group}.${value}`
  return te(key) ? t(key) : reveal(value)
}

function resourceAmount(item: (typeof RESOURCE_ITEMS)[number], value: number): string {
  if (item === 'memory' || item === 'disk' || item === 'stdoutPending') return formatBytes(value)
  if (item === 'cpu') return t('backendResource.cores', { count: Number(value.toFixed(2)).toLocaleString(locale.value) })
  return String(value)
}

function caller(call: PluginActivityToolCall): string {
  return call.callerKind === 'pane'
    ? t('pluginActivity.caller.pane', { name: call.paneName || call.paneId })
    : t(`pluginActivity.caller.${call.callerKind}`)
}

function list(values: string[]): string {
  return values.join(locale.value.startsWith('en') ? ', ' : '、')
}

const sizes = computed(() => {
  const calls = report.value?.toolCalls ?? []
  return {
    args: sumKnownBytes(calls.map((call) => call.argsBytes)),
    result: sumKnownBytes(calls.map((call) => call.resultBytes)),
  }
})
const maxDaily = computed(() => Math.max(1, ...(report.value?.daily ?? []).map((day) => day.calls)))
</script>

<template>
  <section class="nv-activity" :aria-label="$t('pluginActivity.title')">
    <div class="nv-activity-live">
      <h5>{{ $t('pluginActivity.live.heading') }}</h5>
      <p v-if="live" class="nv-activity-inflight">
        {{ $t('pluginActivity.live.inFlight', { current: live.current, peak: live.peak }) }}
      </p>
      <p v-if="live && live.droppedNotifications > 0">{{ $t('pluginActivity.live.dropped', { count: live.droppedNotifications }) }}</p>
      <template v-if="backend">
        <p class="nv-activity-bound">{{ $t('pluginActivity.live.boundViews', { count: backend.boundViews }) }}</p>
        <p class="nv-activity-queue">
          {{ $t('pluginActivity.live.queue', {
            requestFrames: backend.requests.frames, requestBytes: formatBytes(backend.requests.bytes),
            eventFrames: backend.events.frames, eventBytes: formatBytes(backend.events.bytes),
          }) }}
        </p>
        <p v-if="queueGrowing" class="nv-activity-queue-growing" role="status">{{ $t('pluginActivity.live.queueGrowing') }}</p>
      </template>
      <div v-if="resources" class="nv-activity-resources">
        <h5>{{ $t('pluginActivity.resources.heading') }}</h5>
        <ul>
          <li v-for="item in RESOURCE_ITEMS" :key="item" :class="{ 'nv-activity-resource-over': resources.usage[item] > resources.thresholds[item] }">
            {{ $t('pluginActivity.resources.row', { item: $t(`pluginActivity.resources.item.${item}`), usage: resourceAmount(item, resources.usage[item]), threshold: resourceAmount(item, resources.thresholds[item]) }) }}
            <template v-if="resources.usage[item] > resources.thresholds[item]"> · {{ $t('pluginActivity.resources.over') }}</template>
            <template v-if="resources.waiting.includes(item)"> · {{ $t('pluginActivity.resources.waiting') }}</template>
            <template v-if="resources.levels[item] > resources.thresholds[item]"> · {{ $t('pluginActivity.resources.kept', { level: resourceAmount(item, resources.levels[item]) }) }}</template>
          </li>
        </ul>
      </div>
    </div>

    <p v-if="loading" class="nv-activity-muted">{{ $t('pluginActivity.loading') }}</p>
    <p v-else-if="error" class="nv-activity-muted nv-activity-error">{{ error }}</p>
    <template v-else-if="report">
      <p class="nv-activity-muted">{{ $t('pluginActivity.window') }}</p>
      <p class="nv-activity-totals">{{ $t('pluginActivity.totals', report.totals) }}</p>
      <p>{{ $t('pluginActivity.live.historicalPeak', { count: report.historicalPeakConcurrency }) }}</p>

      <div v-if="report.undeclared.length" class="nv-activity-undeclared">
        <h5>{{ $t('pluginActivity.undeclared.heading') }}</h5>
        <ul>
          <li
            v-for="entry in report.undeclared"
            :key="`${entry.source}:${entry.address}:${entry.workspace}`"
            :class="{ 'nv-activity-marker': isMarker(entry.address, 'denied') }"
          >
            {{ $t('pluginActivity.undeclared.item', { address: shown(entry.address, 'denied'), source: word('source', entry.source), workspace: reveal(entry.workspace), count: entry.count, date: date(entry.lastAt) }) }}
            <span class="nv-activity-muted">{{ $t('pluginActivity.undeclared.reasons', { reasons: list(entry.reasons.map((r) => `${word('reason', r.reason)} × ${r.count}`)) }) }}</span>
          </li>
        </ul>
      </div>

      <div v-if="report.anomalies.length" class="nv-activity-anomalies">
        <h5>{{ $t('pluginActivity.anomalies.heading') }}</h5>
        <ul>
          <li v-for="(entry, index) in report.anomalies" :key="index">
            {{ $t(`pluginActivity.anomaly.${entry.kind}`, { date: date(entry.at), workspace: reveal(entry.workspace), tool: reveal(entry.tool ?? ''), count: entry.count ?? 0, baseline: entry.baseline ?? 0 }) }}
          </li>
        </ul>
      </div>

      <div v-if="report.declaredUnused.length" class="nv-activity-unused">
        <h5>{{ $t('pluginActivity.unused.heading') }}</h5>
        <ul>
          <li v-for="entry in report.declaredUnused" :key="`${entry.kind}:${entry.key}`">
            {{ word('kind', entry.kind) }}: {{ reveal(entry.key) }} ·
            {{ entry.lastUsedAt === null ? $t('pluginActivity.unused.never') : $t('pluginActivity.unused.last', { date: date(entry.lastUsedAt) }) }}
          </li>
        </ul>
      </div>

      <h5>{{ $t('pluginActivity.tools.heading') }}</h5>
      <ul v-if="report.toolCalls.length" class="nv-activity-tools">
        <li v-for="call in report.toolCalls" :key="call.id">
          {{ $t('pluginActivity.tools.row', {
            date: date(call.at), caller: caller(call), tool: reveal(call.tool), risk: $t(`pluginActivity.risk.${call.risk}`),
            outcome: call.outcome === 'ok' ? $t('pluginActivity.tools.ok') : $t('pluginActivity.tools.failed', { code: reveal(call.errorCode) }),
            duration: call.durationMs, args: size(call.argsBytes), result: size(call.resultBytes),
          }) }}
          <span v-if="call.crossWorkspace" class="nv-activity-muted">{{ $t('pluginActivity.tools.crossWorkspace', { from: reveal(call.callerWorkspace), to: reveal(call.targetWorkspace) }) }}</span>
        </li>
      </ul>
      <p v-else class="nv-activity-muted">{{ $t('pluginActivity.empty') }}</p>
      <p v-if="report.toolCalls.length" class="nv-activity-muted nv-activity-sizes">
        {{ $t('pluginActivity.tools.totalSize', { args: formatBytes(sizes.args.bytes), result: formatBytes(sizes.result.bytes), unknown: sizes.args.unknown + sizes.result.unknown }) }}
      </p>

      <h5>{{ $t('pluginActivity.files.heading') }}</h5>
      <ul v-if="report.files.length" class="nv-activity-files">
        <li
          v-for="entry in report.files"
          :key="`${entry.address}:${entry.path}`"
          :class="{ 'nv-activity-marker': isMarker(entry.path, entry.outcome) || isMarker(entry.address, entry.outcome) }"
        >
          {{ $t('pluginActivity.files.item', { path: shown(entry.path, entry.outcome), address: shown(entry.address, entry.outcome), count: entry.count, outcome: outcome(entry.outcome), date: date(entry.lastAt) }) }}
        </li>
      </ul>
      <p v-else class="nv-activity-muted">{{ $t('pluginActivity.empty') }}</p>

      <h5>{{ $t('pluginActivity.commands.heading') }}</h5>
      <ul v-if="report.commands.length" class="nv-activity-commands">
        <li
          v-for="entry in report.commands"
          :key="`${entry.command}:${entry.outcome}`"
          :class="{ 'nv-activity-marker': isMarker(entry.command, entry.outcome) }"
        >
          {{ $t('pluginActivity.commands.item', { command: shown(entry.command, entry.outcome), count: entry.count, outcome: outcome(entry.outcome), date: date(entry.lastAt) }) }}
        </li>
      </ul>
      <p v-else class="nv-activity-muted">{{ $t('pluginActivity.empty') }}</p>

      <h5>{{ $t('pluginActivity.trend.heading') }}</h5>
      <ul v-if="report.daily.length" class="nv-activity-trend">
        <li v-for="day in report.daily" :key="day.day">
          <span class="nv-activity-trend-day">{{ day.day }}</span>
          <span class="nv-activity-trend-bar" :style="{ width: `${(day.calls / maxDaily) * 100}%` }" aria-hidden="true" />
          <span>{{ day.calls }}</span>
        </li>
      </ul>
      <p v-else class="nv-activity-muted">{{ $t('pluginActivity.empty') }}</p>

      <h5>{{ $t('pluginActivity.agentActions.heading') }}</h5>
      <p v-if="report.agentActions === null" class="nv-activity-muted">{{ $t('pluginActivity.agentActions.notRecorded') }}</p>
      <ul v-else-if="report.agentActions.length" class="nv-activity-actions">
        <li v-for="(entry, index) in report.agentActions" :key="index">
          {{ $t('pluginActivity.agentActions.item', { date: date(entry.at), caller: entry.paneName || entry.paneId || entry.callerKind, action: reveal(entry.action), version: reveal(entry.version) }) }}
        </li>
      </ul>
      <p v-else class="nv-activity-muted">{{ $t('pluginActivity.empty') }}</p>
    </template>
  </section>
</template>

<style scoped>
.nv-activity {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-xs);
}
.nv-activity p,
.nv-activity h5 {
  margin: 0;
}
.nv-activity h5 {
  margin-top: var(--space-2);
}
.nv-activity ul {
  margin: 0;
  padding-left: 1.2em;
  overflow-wrap: anywhere;
}
.nv-activity-muted {
  color: var(--text-secondary);
}
/* A fixed value recorded in place of a plugin's text, not a real path or command. */
.nv-activity-marker {
  color: var(--text-secondary);
  font-style: italic;
}
.nv-activity-undeclared {
  border-left: 3px solid var(--danger-fg);
  background: var(--danger-subtle);
  color: var(--danger-fg);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
}
.nv-activity-undeclared h5 {
  margin: 0;
}
.nv-activity-resource-over {
  font-weight: 600;
  color: var(--attention-fg);
}
.nv-activity-queue-growing {
  font-weight: 600;
  color: var(--attention-fg);
}
.nv-activity-trend {
  list-style: none;
  padding: 0;
}
.nv-activity-trend li {
  display: grid;
  grid-template-columns: 6.5em 1fr 3em;
  align-items: center;
  gap: var(--space-2);
}
.nv-activity-trend-bar {
  display: block;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--accent-subtle);
  min-width: 2px;
}
</style>
