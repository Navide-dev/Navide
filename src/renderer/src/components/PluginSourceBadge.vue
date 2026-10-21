<script setup lang="ts">
// Card K2 (DX report F0-b): where a Navide plugin came from and what review it
// passed. One component for every surface: a short badge in lists and title
// rows, and with `row` the fixed "Source and review" line of a disclosure card.
//
// The wording must not mislead: only the Registry-signed sources (marketplace,
// prerelease) may read as reviewed, and no source is ever called "verified" or
// "safe" here. A local source says it was not scanned instead of leaving the
// scan field blank, and an unsigned local publisher is only self-declared.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LocalInstallDetails, PluginSource } from '../../../shared/pluginSource'
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
  /** DX 9.4 A1: a local file's SHA-256 and install time; the badge then opens
   *  them on click. */
  localInstall?: LocalInstallDetails
}>()
const { t, locale } = useI18n()

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
// DX 9.4 A1: an unsigned local file says on its own line that its author cannot
// be confirmed, instead of leaving that to the word "unsigned" in the label.
const unsignedNote = computed(() => shown.value === 'local-unsigned' && !revoked.value)
const detailsOpen = ref(false)
const installedAt = computed(() => {
  const at = props.localInstall ? Date.parse(props.localInstall.installedAt) : NaN
  return Number.isFinite(at) ? new Date(at).toLocaleString(locale.value) : ''
})
const publisherText = computed(() => {
  if (!local.value || !props.publisher) return ''
  const name = reveal(props.publisher)
  return UNSIGNED.includes(shown.value) ? t('pluginDisclosure.source.selfDeclared', { publisher: name }) : name
})
</script>

<template>
  <div v-if="row" class="nv-source-row" :data-source="shown" :data-signature="signature">
    <span class="nv-source-row-label">{{ $t('pluginDisclosure.source.heading') }}</span> <span class="nv-source-badge" :class="badgeClass">{{ label }}</span>
    <p v-if="unsignedNote" class="nv-source-unsigned">{{ $t('pluginDisclosure.source.unsignedNote') }}</p>
    <p v-if="local" class="nv-source-scan">{{ $t('pluginDisclosure.source.notScanned') }}</p>
    <!-- S8: a withdrawal reaches an offline or signed-out tester only at the expiry. -->
    <p v-if="source === 'testplace'" class="nv-source-revoke">{{ $t('pluginDisclosure.source.testplaceRevokeNote') }}</p>
    <p v-if="publisherText" class="nv-source-publisher">{{ $t('pluginDisclosure.source.publisher', { publisher: publisherText }) }}</p>
  </div>
  <span v-else-if="local && localInstall" class="nv-source-badge-wrap">
    <button
      type="button"
      class="nv-source-badge nv-source-badge--button"
      :class="badgeClass"
      :data-source="shown"
      :data-signature="signature"
      :aria-expanded="detailsOpen"
      :title="$t('pluginDisclosure.source.showDetails')"
      @click.stop="detailsOpen = !detailsOpen"
    >{{ label }}</button>
    <span v-if="detailsOpen" class="nv-source-details" role="group" :aria-label="$t('pluginDisclosure.source.heading')">
      <span class="nv-source-details-line">{{ label }}</span>
      <span v-if="unsignedNote" class="nv-source-details-line nv-source-unsigned">{{ $t('pluginDisclosure.source.unsignedNote') }}</span>
      <span class="nv-source-details-line nv-source-digest">{{
        localInstall.fileDigest
          ? $t('pluginDisclosure.source.fileDigest', { digest: localInstall.fileDigest })
          : $t('pluginDisclosure.source.contentDigest', { digest: localInstall.contentDigest })
      }}</span>
      <span v-if="installedAt" class="nv-source-details-line">{{ $t('pluginDisclosure.source.installedAt', { time: installedAt }) }}</span>
    </span>
  </span>
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
.nv-source-badge--button {
  border: 0;
  cursor: pointer;
  font-family: inherit;
}
.nv-source-badge-wrap {
  position: relative;
  display: inline-flex;
}
.nv-source-details {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: max-content;
  max-width: 360px;
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-elevated, var(--bg-subtle));
  font-size: var(--font-xs);
  color: var(--text-secondary);
  white-space: normal;
}
.nv-source-digest {
  font-family: var(--font-mono, monospace);
  overflow-wrap: anywhere;
}
.nv-source-badge--factory-bundled {
  color: var(--text-secondary);
  background: var(--bg-subtle);
}
</style>
