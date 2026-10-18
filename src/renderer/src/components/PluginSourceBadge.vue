<script setup lang="ts">
// Card K2 (DX report F0-b): where a Navide plugin came from and what review it
// passed. One component for every surface: a short badge in lists and title
// rows, and with `row` the fixed "Source and review" line of a disclosure card.
//
// The wording must not mislead: only the Registry-signed sources (marketplace,
// prerelease) may read as reviewed, and no source is ever called "verified" or
// "safe" here. A local source says it was not scanned instead of leaving the
// scan field blank, and an unsigned local publisher is only self-declared.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PluginSource } from '../../../shared/pluginSource'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'

const props = defineProps<{
  source: PluginSource
  /** Publisher id; the row shows it only for local sources. */
  publisher?: string
  /** Test build expiry (ISO-8601); printed as YYYY-MM-DD. */
  expiresAt?: string | null
  /** Render the disclosure card row instead of the badge. */
  row?: boolean
}>()
const { t } = useI18n()

const LOCAL: readonly PluginSource[] = ['local-signed', 'local-unsigned', 'developer-unpacked']
const UNSIGNED: readonly PluginSource[] = ['local-unsigned', 'developer-unpacked']

const label = computed(() => t(`pluginDisclosure.source.${props.source}`, { date: (props.expiresAt ?? '').slice(0, 10) }))
const local = computed(() => LOCAL.includes(props.source))
const publisherText = computed(() => {
  if (!local.value || !props.publisher) return ''
  const name = reveal(props.publisher)
  return UNSIGNED.includes(props.source) ? t('pluginDisclosure.source.selfDeclared', { publisher: name }) : name
})
</script>

<template>
  <div v-if="row" class="nv-source-row" :data-source="source">
    <span class="nv-source-row-label">{{ $t('pluginDisclosure.source.heading') }}</span> <span class="nv-source-badge" :class="`nv-source-badge--${source}`">{{ label }}</span>
    <p v-if="local" class="nv-source-scan">{{ $t('pluginDisclosure.source.notScanned') }}</p>
    <p v-if="publisherText" class="nv-source-publisher">{{ $t('pluginDisclosure.source.publisher', { publisher: publisherText }) }}</p>
  </div>
  <span v-else class="nv-source-badge" :class="`nv-source-badge--${source}`" :data-source="source">{{ label }}</span>
</template>

<style scoped>
.nv-source-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px var(--space-2);
  font-size: var(--font-xs);
}
.nv-source-row p {
  flex-basis: 100%;
  margin: 0;
  color: var(--text-secondary);
}
.nv-source-row-label {
  color: var(--text-secondary);
  font-weight: 600;
}
.nv-source-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
  font-weight: 600;
  white-space: nowrap;
  color: var(--trust-unsigned-fg);
  background: var(--trust-unsigned-subtle);
}
.nv-source-badge--marketplace,
.nv-source-badge--prerelease {
  color: var(--trust-signed-fg);
  background: var(--trust-signed-subtle);
}
.nv-source-badge--factory-bundled {
  color: var(--text-secondary);
  background: var(--bg-subtle);
}
</style>
