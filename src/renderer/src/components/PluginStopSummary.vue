<script setup lang="ts">
// Plan P2: what a stopped plugin was doing when it was stopped, and where the
// stop came from. Shown before the plugin is enabled again. Host names come
// from the plugin's own traffic: plain text only.
import { useI18n } from 'vue-i18n'
import type { PluginStopRecord } from '../../../shared/pluginStop'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'
import { disclosureList } from '../lib/disclosureText'

const props = defineProps<{ record: PluginStopRecord }>()
const { t, locale } = useI18n()

function count(value: number | null): string {
  return value === null ? t('pluginStop.summary.notRead') : String(value)
}
</script>

<template>
  <div class="nv-stop-summary">
    <p class="nv-stop-summary-head">
      {{ t('pluginStop.summary.heading', { date: new Date(props.record.at).toLocaleString(locale), via: t(`pluginStop.via.${props.record.via}`) }) }}
    </p>
    <p v-if="props.record.rule" class="nv-stop-summary-rule">
      {{ t('pluginStop.autoPause.because', { rule: props.record.rule, reason: t(`pluginStop.rule.${props.record.rule}`) }) }}
    </p>
    <ul>
      <li>{{ t('pluginStop.summary.inFlight', { count: props.record.summary.inFlightCalls }) }}</li>
      <li>{{ t('pluginStop.summary.toolCalls', { count: count(props.record.summary.toolCallsLastMinute) }) }}</li>
      <li>{{ t('pluginStop.summary.capabilityCalls', { count: count(props.record.summary.capabilityCallsLastMinute) }) }}</li>
      <li>{{ t('pluginStop.summary.failures', { count: count(props.record.summary.consecutiveFailures) }) }}</li>
      <li :class="{ 'nv-stop-summary-flagged': props.record.summary.undeclaredHosts.length > 0 }">
        {{ props.record.summary.undeclaredHosts.length
          ? t('pluginStop.summary.hosts', { hosts: disclosureList(locale, props.record.summary.undeclaredHosts.map((host) => reveal(host))) })
          : t('pluginStop.summary.noHosts') }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.nv-stop-summary {
  font-size: var(--font-xs);
}
.nv-stop-summary p {
  margin: 0;
}
.nv-stop-summary-head {
  font-weight: 600;
  color: var(--text-bright);
}
.nv-stop-summary-rule {
  color: var(--attention-fg);
  font-weight: 600;
}
.nv-stop-summary ul {
  margin: var(--space-1) 0 0;
  padding-left: 1.2em;
  overflow-wrap: anywhere;
}
.nv-stop-summary-flagged {
  color: var(--danger-fg);
  font-weight: 600;
}
</style>
