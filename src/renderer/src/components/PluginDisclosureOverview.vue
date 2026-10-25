<script setup lang="ts">
// Plan B D5 / D-f: Settings → Navide Plugins → Disclosure overview. Every
// installed Registry package on one page: its disclosure card (from the
// installed manifest and the scan verified at install), recent activity,
// undeclared uses and unusual items. Records only: nothing on this page
// changes what a plugin may do. Mounted only when the section is first shown;
// `paused` stops the queue sampling while it is out of view.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PluginActivityReport } from '../../../shared/pluginActivity'
import type { ManifestDisclosure } from '../../../shared/pluginDisclosure'
import type { ScanReport } from '../../../shared/pluginDisclosureScan'
import type { PluginSource } from '../../../shared/pluginSource'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'
import PluginDisclosureCard from './PluginDisclosureCard.vue'
import PluginSourceBadge from './PluginSourceBadge.vue'
import { cardRiskLevel, declaredVsScanned } from '../../../shared/pluginDisclosureScan'
import PluginActivityPanel from './PluginActivityPanel.vue'
import { createQueueTrend, pluginBackendUsage } from '../lib/backendQueueTrend'

interface Entry {
  id: string
  version: string
  disclosure: ManifestDisclosure | null
  scan: ScanReport | null
  /** The Host's source; absent (unknown channel) shows no source row, never a guess. */
  source?: PluginSource
  expiresAt?: string
  /** Whether the package declares views; absent when unknown. */
  hasViews?: boolean
  report: PluginActivityReport | null
  reportError: string
}

const props = withDefaults(defineProps<{ pollMs?: number; paused?: boolean }>(), { pollMs: 5000, paused: false })
const entries = ref<Entry[]>([])
const loading = ref(true)
const growing = ref(new Set<string>())
const open = ref(new Set<string>())
const trend = createQueueTrend()
let timer: ReturnType<typeof setInterval> | null = null
let loaded = false

function api() {
  return window.agentTeam?.plugins
}

async function load(): Promise<void> {
  try {
    const installed = (await api()?.installedDisclosures?.()) ?? []
    entries.value = await Promise.all(installed.map(async (pkg): Promise<Entry> => {
      try {
        const answer = await api()?.activityReport?.(pkg.id)
        return { ...pkg, report: answer?.ok ? answer.report : null, reportError: answer && !answer.ok ? answer.error : '' }
      } catch (error) {
        return { ...pkg, report: null, reportError: error instanceof Error ? error.message : String(error) }
      }
    }))
  } finally {
    loading.value = false
  }
}

async function sampleQueues(): Promise<void> {
  try {
    const usage = await api()?.backendResourceUsage?.()
    if (!usage) return
    const next = new Set<string>()
    for (const entry of entries.value) {
      const mine = pluginBackendUsage(usage, entry.id)
      if (mine && trend.add(entry.id, mine.requests.bytes + mine.events.bytes)) next.add(entry.id)
    }
    growing.value = next
  } catch {
    // Advisory only.
  }
}

// The summary row of each record: its risk level, and whether the scan found
// anything it does not declare. Both stay visible with the record closed.
function riskLevel(entry: Entry) {
  return entry.disclosure ? cardRiskLevel(entry.disclosure, entry.scan) : null
}
function scanFoundUndeclared(entry: Entry): boolean {
  return !!entry.disclosure && !!entry.scan && declaredVsScanned(entry.disclosure, entry.scan).undeclared.length > 0
}

function onToggle(id: string, event: Event): void {
  const next = new Set(open.value)
  if ((event.target as HTMLDetailsElement).open) next.add(id)
  else next.delete(id)
  open.value = next
}

function startPolling(): void {
  if (timer || props.paused || !loaded) return
  void sampleQueues()
  timer = setInterval(() => void sampleQueues(), props.pollMs)
}

function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

watch(() => props.paused, (paused) => { if (paused) stopPolling(); else startPolling() })
onMounted(async () => {
  await load()
  loaded = true
  startPolling()
})
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="nv-overview">
    <p class="nv-overview-intro">{{ $t('pluginActivity.overview.intro') }}</p>
    <p v-if="loading" class="nv-overview-muted">{{ $t('pluginActivity.loading') }}</p>
    <p v-else-if="entries.length === 0" class="nv-overview-muted">{{ $t('pluginActivity.overview.empty') }}</p>
    <article v-for="entry in entries" :key="entry.id" class="nv-overview-entry" :data-id="entry.id">
      <!-- Always visible: who it is, how risky, and any warning. The full
           record opens below it; nothing in it is shortened. -->
      <div class="nv-overview-head">
        <h3 class="nv-overview-name">{{ reveal(entry.id) }} <span class="nv-overview-muted">{{ reveal(entry.version) }}</span></h3>
        <div class="nv-overview-flags">
          <span v-if="riskLevel(entry)" class="nv-overview-risk" :class="`nv-overview-risk--${riskLevel(entry)}`">
            {{ $t('pluginDisclosure.riskLabel', { level: $t(`pluginDisclosure.risk.${riskLevel(entry)}`) }) }}
          </span>
          <PluginSourceBadge v-if="entry.source" :source="entry.source" :publisher="entry.id.split('.')[0]" :expires-at="entry.expiresAt" />
          <span v-if="scanFoundUndeclared(entry)" class="nv-overview-flag" role="alert">{{ $t('pluginDisclosure.undeclaredHeading') }}</span>
        </div>
      </div>
      <p v-if="!entry.scan" class="nv-overview-muted">{{ $t('pluginActivity.overview.noScanRecord') }}</p>
      <p v-if="growing.has(entry.id)" class="nv-overview-growing" role="status">{{ $t('pluginActivity.live.queueGrowing') }}</p>
      <div class="nv-overview-activity">
        <h4>{{ $t('pluginActivity.overview.activity') }}</h4>
        <template v-if="entry.report">
          <p class="nv-overview-totals">{{ $t('pluginActivity.totals', entry.report.totals) }}</p>
          <p v-if="entry.report.undeclared.length" class="nv-overview-undeclared">
            {{ $t('pluginActivity.overview.undeclaredCount', { count: entry.report.undeclared.reduce((sum, u) => sum + u.count, 0) }) }}
          </p>
          <p v-if="entry.report.anomalies.length" class="nv-overview-anomalies">{{ $t('pluginActivity.overview.anomalyCount', { count: entry.report.anomalies.length }) }}</p>
        </template>
        <p v-else-if="entry.reportError" class="nv-overview-muted">{{ $t('pluginActivity.unavailable', { error: entry.reportError }) }}</p>
      </div>
      <!-- Both expanders share one footer row; an opened one takes the full width. -->
      <div class="nv-overview-footer">
        <details class="nv-overview-details" @toggle="onToggle(entry.id, $event)">
          <summary>{{ $t('pluginActivity.tab') }}</summary>
          <PluginActivityPanel v-if="open.has(entry.id)" :plugin-id="entry.id" :poll-ms="props.pollMs" :paused="props.paused" />
        </details>
        <details class="nv-overview-record">
          <summary>{{ $t('pluginDisclosure.title') }}</summary>
          <PluginDisclosureCard
            :disclosure="entry.disclosure"
            :scan="entry.scan"
            :registry="null"
            :verified="true"
            :source="entry.source"
            :expires-at="entry.expiresAt"
            :publisher="entry.id.split('.')[0]"
            :has-views="entry.hasViews"
            summary-as-list
          />
        </details>
      </div>
    </article>
  </div>
</template>

<style scoped>
.nv-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  container: ledger / inline-size;
  /* Same 22px gutter as the settings blocks above it on the page. */
  padding: var(--space-1) 22px var(--space-6);
  font-size: var(--font-sm);
}
.nv-overview p,
.nv-overview h3,
.nv-overview h4 {
  margin: 0;
}
.nv-overview-intro {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}
.nv-overview-entry {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
/* Wide enough, the records read as a ledger: one row per Navide plugin with
   its name, its risk / review / scan flags and its recent activity in aligned
   columns, and the expanders (full record, activity panel) under the row. */
@container ledger (min-width: 680px) {
  .nv-overview-entry {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr) minmax(0, 1.4fr);
    column-gap: var(--space-4);
    row-gap: var(--space-2);
    align-items: start;
  }
  .nv-overview-entry > .nv-overview-head {
    display: contents;
  }
  .nv-overview-entry .nv-overview-name {
    grid-column: 1;
    grid-row: 1;
    flex-wrap: wrap;
  }
  .nv-overview-entry .nv-overview-flags {
    grid-column: 2;
    grid-row: 1;
  }
  .nv-overview-entry > .nv-overview-activity {
    grid-column: 3;
    grid-row: 1;
  }
  .nv-overview-entry > :not(.nv-overview-head):not(.nv-overview-activity) {
    grid-column: 1 / -1;
  }
  /* The two expanders sit under the name, so a closed record stays one row high. */
  .nv-overview-entry > .nv-overview-footer {
    grid-column: 1;
    grid-row: 2;
    margin-top: calc(-1 * var(--space-2));
  }
}
.nv-overview-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
}
.nv-overview-flags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
/* Risk level on one severity scale with the plugin list: Low and Medium
   tinted, High a solid warning tone, Highest solid danger. */
.nv-overview-risk,
.nv-overview-flag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  font-weight: 600;
  white-space: nowrap;
}
.nv-overview-risk--low { background: var(--success-subtle); color: var(--success-fg); }
.nv-overview-risk--medium { background: var(--attention-subtle); color: var(--attention-fg); }
.nv-overview-risk--high { background: var(--warning-fg); color: var(--bg-base); }
.nv-overview-risk--highest { background: var(--danger-emphasis); color: var(--text-on-emphasis); }
.nv-overview-flag {
  background: var(--danger-subtle);
  color: var(--danger-fg);
}
.nv-overview-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--space-5);
}
.nv-overview-footer > details {
  flex-basis: auto;
}
.nv-overview-footer > details[open] {
  flex-basis: 100%;
}
.nv-overview-record[open] > summary {
  margin-bottom: var(--space-2);
}
.nv-overview-name {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--text-bright);
  font-size: var(--font-md);
  font-weight: 600;
}
.nv-overview-name .nv-overview-muted {
  font-size: var(--font-xs);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
/* The shared disclosure card bolds its whole summary for the install dialog;
   in a list of several plugins that becomes a wall, so it is regular weight here. */
.nv-overview-entry :deep(.nv-disclosure-summary) {
  font-weight: 500;
  color: var(--text-bright);
  line-height: var(--lh-base);
}
.nv-overview-entry :deep(.nv-disclosure-provenance) {
  font-size: var(--font-xs);
}
/* The risk level leads the card, right under the name. High and Highest are
   solid pills, a step above the tinted advisory badges on the page, so their
   severity reads before any of the text. */
.nv-overview-entry :deep(.nv-disclosure-level) {
  order: -1;
  border: 1px solid currentColor;
}
.nv-overview-entry :deep(.nv-disclosure-level--high) {
  border-color: var(--warning-fg);
  background: var(--warning-fg);
  color: var(--bg-base);
}
.nv-overview-entry :deep(.nv-disclosure-level--highest) {
  border-color: var(--danger-emphasis);
  background: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.nv-overview-entry :deep(.nv-disclosure-summary--list) {
  font-weight: 400;
  color: var(--text-primary);
}
/* The undeclared-use box keeps its red frame and title; its body is set in the
   neutral foreground, which stays legible on the red tint in dark themes. */
.nv-overview-entry :deep(.nv-disclosure-undeclared-intro),
.nv-overview-entry :deep(.nv-disclosure-undeclared li) {
  color: var(--text-primary);
}
/* Recent activity: an inset strip, its counts on one line and the two kinds of
   trouble as tagged lines rather than loose coloured text. */
.nv-overview-activity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  font-size: var(--font-xs);
}
.nv-overview-activity h4 {
  margin: 0;
}
.nv-overview-activity .nv-overview-details {
  flex-basis: auto;
}
.nv-overview-totals {
  font-variant-numeric: tabular-nums;
}
.nv-overview-undeclared,
.nv-overview-anomalies {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
}
.nv-overview-undeclared::before,
.nv-overview-anomalies::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.nv-overview-anomalies {
  background: var(--attention-subtle);
  color: var(--attention-fg);
  font-weight: 600;
}
.nv-overview-details {
  flex-basis: 100%;
}
.nv-overview-entry h4 {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 600;
}
.nv-overview-muted {
  color: var(--text-secondary);
}
/* Empty and loading states sit in a dashed well, like the empty installed list. */
.nv-overview > .nv-overview-muted {
  padding: var(--space-4);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  font-size: var(--font-xs);
  text-align: center;
}
.nv-overview-undeclared {
  background: var(--danger-subtle);
  color: var(--danger-fg);
  font-weight: 600;
}
.nv-overview-growing {
  color: var(--attention-fg);
  font-weight: 600;
}
/* Sub-headings inside the shared card read as headings here, not captions. */
.nv-overview-entry :deep(.nv-disclosure h5) {
  margin-top: var(--space-2);
  color: var(--text-bright);
  font-size: var(--font-xs);
  font-weight: 600;
}
/* The scanner and network notes repeat on every card; they stay in full but
   step down a tier under a hairline so the findings above them lead. */
.nv-overview-entry :deep(.nv-disclosure-limits),
.nv-overview-entry :deep(.nv-disclosure-view-network) {
  margin: 0;
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-muted);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}
.nv-overview-entry :deep(.nv-disclosure-limits + .nv-disclosure-view-network) {
  padding-top: 0;
  border-top: 0;
}
/* One disclosure control for the whole page: the same chevron and a 32px row
   as "Permissions and grants" in the list above. */
.nv-overview-details > summary,
.nv-overview-record > summary,
.nv-overview-entry :deep(.nv-disclosure-declared > summary) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: max-content;
  min-height: var(--control-h-lg);
  list-style: none;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-weight: 500;
  cursor: pointer;
  border-radius: var(--radius-xs);
}
.nv-overview-details > summary::-webkit-details-marker,
.nv-overview-record > summary::-webkit-details-marker,
.nv-overview-entry :deep(.nv-disclosure-declared > summary::-webkit-details-marker) {
  display: none;
}
.nv-overview-details > summary::before,
.nv-overview-record > summary::before,
.nv-overview-entry :deep(.nv-disclosure-declared > summary::before) {
  content: '';
  width: 5px;
  height: 5px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform var(--motion-base) var(--ease-out);
}
.nv-overview-details[open] > summary::before,
.nv-overview-record[open] > summary::before,
.nv-overview-entry :deep(.nv-disclosure-declared[open] > summary::before) {
  transform: rotate(45deg);
}
.nv-overview-details > summary:hover,
.nv-overview-record > summary:hover,
.nv-overview-entry :deep(.nv-disclosure-declared > summary:hover) {
  color: var(--text-primary);
}
.nv-overview-details > summary:focus-visible,
.nv-overview-record > summary:focus-visible,
.nv-overview-entry :deep(.nv-disclosure-declared > summary:focus-visible) {
  outline: 2px solid var(--accent-focus);
  outline-offset: 2px;
}
</style>
