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
import { pluginSourceLabel } from '../lib/pluginSourceMark'

const props = defineProps<{
  source: PluginSource
  /** Publisher id; the row shows it only for local sources. */
  publisher?: string
  /** Test build expiry (ISO-8601); printed as YYYY-MM-DD, or "unknown" when absent. */
  expiresAt?: string | null
  /** How the user joined a test build: decides which review the row names. */
  via?: 'invite' | 'code' | null
  /** Render the disclosure card row instead of the badge. */
  row?: boolean
  /** A3: a local file a Navide-vetted publisher signed (`verified`), or whose
   *  key or publisher the Registry has revoked since (`revoked`). */
  signature?: 'verified' | 'revoked'
}>()
const { t } = useI18n()

const LOCAL: readonly PluginSource[] = ['local-signed', 'local-unsigned', 'developer-unpacked']
const UNSIGNED: readonly PluginSource[] = ['local-unsigned', 'developer-unpacked']

// A3: the Host stores a signed local file as `local-unsigned` and reports the
// signature beside it; only an active vetted key makes it read as signed.
const shown = computed<PluginSource>(() =>
  props.source === 'local-unsigned' && props.signature === 'verified' ? 'local-signed' : props.source
)
const revoked = computed(() => props.source === 'local-unsigned' && props.signature === 'revoked')
const label = computed(() => {
  if (revoked.value) return t('pluginDisclosure.source.signatureRevoked')
  if (shown.value === 'local-signed' && props.signature === 'verified' && props.publisher) {
    return t('pluginDisclosure.source.localSignedBy', { publisher: reveal(props.publisher) })
  }
  return pluginSourceLabel(t, shown.value, props.expiresAt, props.via)
})
const local = computed(() => LOCAL.includes(props.source))
const badgeClass = computed(() => (revoked.value ? 'nv-source-badge--signature-revoked' : `nv-source-badge--${shown.value}`))
const publisherText = computed(() => {
  if (!local.value || !props.publisher) return ''
  const name = reveal(props.publisher)
  return UNSIGNED.includes(shown.value) ? t('pluginDisclosure.source.selfDeclared', { publisher: name }) : name
})
</script>

<template>
  <div v-if="row" class="nv-source-row" :data-source="shown" :data-signature="signature">
    <span class="nv-source-row-label">{{ $t('pluginDisclosure.source.heading') }}</span> <span class="nv-source-badge" :class="badgeClass">{{ label }}</span>
    <p v-if="local" class="nv-source-scan">{{ $t('pluginDisclosure.source.notScanned') }}</p>
    <p v-if="publisherText" class="nv-source-publisher">{{ $t('pluginDisclosure.source.publisher', { publisher: publisherText }) }}</p>
  </div>
  <span v-else class="nv-source-badge" :class="badgeClass" :data-source="shown" :data-signature="signature">{{ label }}</span>
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
.nv-source-badge--signature-revoked {
  color: var(--danger-fg, var(--trust-unsigned-fg));
  background: var(--danger-subtle, var(--trust-unsigned-subtle));
}
.nv-source-badge--factory-bundled {
  color: var(--text-secondary);
  background: var(--bg-subtle);
}
</style>
