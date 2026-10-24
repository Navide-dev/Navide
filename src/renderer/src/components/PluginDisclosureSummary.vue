<script setup lang="ts">
// The top of every disclosure surface (plan B D1/D5): the template's one-line
// summary and the risk level in colour, icon and text, with a distinct icon
// for each of the four levels. Used by the full card and the listing card.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DisclosureRiskLevel, ManifestDisclosure } from '../../../shared/pluginDisclosure'
import { cardRiskLevel, type ScanReport } from '../../../shared/pluginDisclosureScan'
import { disclosureClauses, disclosureSummaryLine } from '../lib/disclosureText'

const props = defineProps<{
  disclosure: ManifestDisclosure
  scan: ScanReport | null
  /** The list card's level (D-f): the highest across platforms, from the main process. */
  level?: DisclosureRiskLevel
  variesByPlatform?: boolean
  /** The same clauses, one per line instead of one joined sentence. */
  asList?: boolean
}>()
const { t, locale } = useI18n()

const level = computed(() => props.level ?? cardRiskLevel(props.disclosure, props.scan))
const summary = computed(() => disclosureSummaryLine(t, locale.value, props.disclosure))
const clauses = computed(() => disclosureClauses(t, locale.value, props.disclosure))
</script>

<template>
  <ul v-if="asList" class="nv-disclosure-summary nv-disclosure-summary--list">
    <li v-for="(clause, index) in clauses" :key="index">{{ clause }}</li>
  </ul>
  <p v-else class="nv-disclosure-summary">{{ summary }}</p>
  <p class="nv-disclosure-level" :class="`nv-disclosure-level--${level}`">
    <span class="nv-disclosure-level-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M8 1.8 13 3.7v4c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5v-4L8 1.8Z" />
        <path v-if="level === 'low'" d="m5.7 8.1 1.6 1.6 3-3.2" />
        <path v-else-if="level === 'medium'" d="M8 7.4v3.2M8 5.4v.1" />
        <path v-else-if="level === 'high'" d="M8 5.2v3.2M8 10.6v.1" />
        <path v-else d="m6.2 6.3 3.6 3.6M9.8 6.3 6.2 9.9" />
      </svg>
    </span>
    <span class="nv-disclosure-level-text">{{ $t('pluginDisclosure.riskLabel', { level: $t(`pluginDisclosure.risk.${level}`) }) }}</span>
    <span v-if="variesByPlatform" class="nv-disclosure-level-varies">{{ $t('pluginDisclosure.variesByPlatform') }}</span>
  </p>
</template>

<style scoped>
.nv-disclosure-summary {
  margin: 0;
  font-weight: 600;
}
.nv-disclosure-summary--list {
  display: grid;
  gap: 2px;
  padding-left: 1.2em;
}
.nv-disclosure-level {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-weight: 600;
  align-self: flex-start;
}
.nv-disclosure-level-icon svg {
  width: 14px;
  height: 14px;
  display: block;
}
.nv-disclosure-level--low { color: var(--success-fg); background: var(--success-subtle); }
.nv-disclosure-level--medium { color: var(--attention-fg); background: var(--attention-subtle); }
.nv-disclosure-level--high { color: var(--risk-fg); background: var(--risk-subtle); }
.nv-disclosure-level--highest { color: var(--danger-fg); background: var(--danger-subtle); }
</style>
