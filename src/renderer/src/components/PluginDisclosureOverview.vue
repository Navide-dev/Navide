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
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'
import PluginDisclosureCard from './PluginDisclosureCard.vue'
import PluginActivityPanel from './PluginActivityPanel.vue'
import { createQueueTrend, pluginBackendUsage } from '../lib/backendQueueTrend'

interface Entry {
  id: string
  version: string
  disclosure: ManifestDisclosure | null
  scan: ScanReport | null
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
      <h3 class="nv-overview-name">{{ reveal(entry.id) }} <span class="nv-overview-muted">{{ reveal(entry.version) }}</span></h3>
      <p v-if="growing.has(entry.id)" class="nv-overview-growing" role="status">{{ $t('pluginActivity.live.queueGrowing') }}</p>
      <PluginDisclosureCard :disclosure="entry.disclosure" :scan="entry.scan" :registry="null" :verified="true" />
      <p v-if="!entry.scan" class="nv-overview-muted">{{ $t('pluginActivity.overview.noScanRecord') }}</p>
      <h4>{{ $t('pluginActivity.overview.activity') }}</h4>
      <template v-if="entry.report">
        <p>{{ $t('pluginActivity.totals', entry.report.totals) }}</p>
        <p v-if="entry.report.undeclared.length" class="nv-overview-undeclared">
          {{ $t('pluginActivity.overview.undeclaredCount', { count: entry.report.undeclared.reduce((sum, u) => sum + u.count, 0) }) }}
        </p>
        <p v-if="entry.report.anomalies.length">{{ $t('pluginActivity.overview.anomalyCount', { count: entry.report.anomalies.length }) }}</p>
      </template>
      <p v-else-if="entry.reportError" class="nv-overview-muted">{{ $t('pluginActivity.unavailable', { error: entry.reportError }) }}</p>
      <details class="nv-overview-details" @toggle="onToggle(entry.id, $event)">
        <summary>{{ $t('pluginActivity.tab') }}</summary>
        <PluginActivityPanel v-if="open.has(entry.id)" :plugin-id="entry.id" :poll-ms="props.pollMs" />
      </details>
    </article>
  </div>
</template>

<style scoped>
.nv-overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-4);
  font-size: var(--font-sm);
}
.nv-overview p,
.nv-overview h3,
.nv-overview h4 {
  margin: 0;
}
.nv-overview-entry {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.nv-overview-muted {
  color: var(--text-secondary);
}
.nv-overview-undeclared {
  color: var(--danger-fg);
  font-weight: 600;
}
.nv-overview-growing {
  color: var(--attention-fg);
  font-weight: 600;
}
</style>
