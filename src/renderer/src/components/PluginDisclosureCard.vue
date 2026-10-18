<script setup lang="ts">
// The disclosure card (plan B D1/D5, contract 3.4, 3.8, 3.9). One component for
// every surface: the Marketplace detail page and the install/update consent
// dialog. Presentation only: every sentence comes from the contract's pure
// functions and an i18n template, never from text the publisher wrote.
//
// Order (D6): the one-line summary, risk level, then what the scan found that
// the package does not declare (red, the only red on the card), the scan
// sentences, what the package declares (collapsed), what was declared but
// not seen (grey), the fixed scan-coverage and honest-limits text, and last
// the Registry's facts.
//
// Provenance (review I1 on #354): listing and detail data is raw Registry
// output that nothing has verified yet; only a prepareInstall result has had
// its disclosure envelope and scanDigest checked. `verified` says which one
// this is, and the card never calls unverified data signed. The `registry`
// facts are unsigned everywhere: they are stated as the Registry's records
// and never feed a "verified" sentence (review F2 on #360).
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ManifestDisclosure, RegistryDisclosureFacts } from '../../../shared/pluginDisclosure'
import {
  declaredVsScanned,
  scanSentences,
  type ScanReport,
  type ScanSentence,
} from '../../../shared/pluginDisclosureScan'
import { disclosureClauses, disclosureList } from '../lib/disclosureText'
import { revealInvisibleText } from '../../../shared/pluginAgentTools'
import PluginDisclosureSummary from './PluginDisclosureSummary.vue'
import PluginSourceBadge from './PluginSourceBadge.vue'
import type { PluginSource } from '../../../shared/pluginSource'

const props = defineProps<{
  disclosure: ManifestDisclosure | null | undefined
  scan?: ScanReport | null
  registry?: RegistryDisclosureFacts | null
  /** True only for a prepareInstall result (signature and digests checked). */
  verified?: boolean
  /** K2: adds the fixed "Source and review" row; absent renders as before. */
  source?: PluginSource
  publisher?: string
  expiresAt?: string | null
}>()
const { t, te, locale } = useI18n()

const scan = computed(() => (props.disclosure ? props.scan ?? null : null))
const comparison = computed(() =>
  props.disclosure && scan.value ? declaredVsScanned(props.disclosure, scan.value) : null
)
const sentences = computed<ScanSentence[]>(() => (scan.value ? scanSentences(scan.value) : []))
const bodySentences = computed(() => sentences.value.filter((s) => s.key !== 'coverage'))
const coverageSentence = computed(() => sentences.value.find((s) => s.key === 'coverage') ?? null)

function list(values: unknown): string {
  return disclosureList(locale.value, values)
}

/** `coverage` is both a sentence and the prefix of `coverage.incomplete`, so
 * the plain one reads `scan.coverage.base` (nested i18n keys cannot be both). */
function scanKey(key: string): string {
  return key === 'coverage' ? 'pluginDisclosure.scan.coverage.base' : `pluginDisclosure.scan.${key}`
}

/** Third-party text with every invisible character spelled out, so a scanned
 *  string or a Registry fact cannot reorder or hide the card (L3 on #360). */
function reveal(value: unknown): unknown {
  if (typeof value === 'string') return revealInvisibleText(value)
  return Array.isArray(value) ? value.map(reveal) : value
}

function scanText(sentence: ScanSentence): string {
  const p = Object.fromEntries(Object.entries(sentence.params).map(([name, value]) => [name, reveal(value)]))
  const params: Record<string, unknown> = { ...p }
  for (const field of ['commands', 'paths', 'hosts', 'libraries', 'signals']) {
    if (field in p) params[field] = list(p[field])
  }
  if ('reasons' in p) {
    params.reasons = list((p.reasons as string[]).map((r) => t(`pluginDisclosure.incompleteReason.${r}`)))
  }
  if (sentence.key === 'native.unscannable') {
    params.reason = t(`pluginDisclosure.unscannableReason.${String(p.reason)}`, { detail: String(p.detail ?? '') })
  }
  if (sentence.key === 'coverage') params.scannedAt = date(String(p.scannedAt))
  const key = scanKey(sentence.key)
  return te(key) ? t(key, params) : sentence.key
}

const clauses = computed(() => (props.disclosure ? disclosureClauses(t, locale.value, props.disclosure) : []))

/** F1 on #360: "verified" names only what prepareInstall checked; without a
 *  scan report there is no scan signature to speak of. */
const provenance = computed(() =>
  !props.verified
    ? 'pluginDisclosure.provenance.unverified'
    : scan.value
      ? 'pluginDisclosure.provenance.verified'
      : 'pluginDisclosure.provenance.verifiedNoScan'
)

function itemText(prefix: 'undeclared' | 'notSeen', item: { kind: string; key: string }): string {
  const key = `pluginDisclosure.${prefix}.${item.kind}`
  const shown = revealInvisibleText(item.key)
  return te(key) ? t(key, { key: shown }) : `${item.kind}: ${shown}`
}

function date(value: string | null | undefined): string {
  if (!value) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(locale.value)
}

/** Facts in the Registry's own words: stated, never styled as warnings. */
const facts = computed(() => {
  const r = props.registry
  if (!r) return []
  const out: string[] = []
  out.push(
    r.publisher.verifiedDomain
      ? t('pluginDisclosure.registry.domainVerified', { domain: revealInvisibleText(r.publisher.verifiedDomain), date: date(r.publisher.domainVerifiedAt) })
      : t('pluginDisclosure.registry.domainNotVerified')
  )
  // A record of the Registry's, whatever prepareInstall verified (F2 on #360).
  out.push(
    r.signature.signed
      ? t('pluginDisclosure.registry.signedClaim', { keyId: revealInvisibleText(r.signature.keyId ?? '') })
      : t('pluginDisclosure.registry.unsigned')
  )
  const review = r.review.status
  out.push(
    review === 'approved'
      ? t('pluginDisclosure.registry.reviewApproved', { date: date(r.review.reviewedAt) })
      : t(`pluginDisclosure.registry.review.${review}`)
  )
  if (r.review.nativeCodeInspected === true) out.push(t('pluginDisclosure.registry.nativeInspected'))
  else if (r.review.nativeCodeInspected === false) out.push(t('pluginDisclosure.registry.nativeNotInspected'))
  out.push(
    r.scan.secretScan === 'findings'
      ? t('pluginDisclosure.registry.secretFindings', { count: r.scan.secretFindings })
      : t(`pluginDisclosure.registry.secret.${r.scan.secretScan}`)
  )
  if (r.scan.similarityWarning) out.push(t('pluginDisclosure.registry.similar'))
  return out
})
</script>

<template>
  <section class="nv-disclosure" :aria-label="$t('pluginDisclosure.title')">
    <PluginSourceBadge v-if="source" row :source="source" :publisher="publisher" :expires-at="expiresAt" />
    <p v-if="!disclosure" class="nv-disclosure-none">{{ $t('pluginDisclosure.noDisclosure') }}</p>
    <template v-else>
      <p class="nv-disclosure-provenance" :class="verified ? 'nv-disclosure-provenance--verified' : 'nv-disclosure-provenance--unverified'">
        {{ $t(provenance) }}
      </p>
      <PluginDisclosureSummary :disclosure="disclosure" :scan="scan" />

      <div v-if="comparison?.undeclared.length" class="nv-disclosure-undeclared" role="alert">
        <h5>{{ $t('pluginDisclosure.undeclaredHeading') }}</h5>
        <p class="nv-disclosure-undeclared-intro">{{ $t('pluginDisclosure.undeclaredIntro') }}</p>
        <ul>
          <li v-for="item in comparison.undeclared" :key="`${item.kind}:${item.key}`">{{ itemText('undeclared', item) }}</li>
        </ul>
      </div>

      <h5 class="nv-disclosure-heading">{{ $t('pluginDisclosure.scanHeading') }}</h5>
      <ul v-if="scan" class="nv-disclosure-sentences">
        <li
          v-for="sentence in bodySentences"
          :key="sentence.key + JSON.stringify(sentence.params)"
          :class="{ 'nv-disclosure-notfound': sentence.key.startsWith('notFound.'), 'nv-disclosure-incomplete': sentence.key === 'coverage.incomplete' }"
        >
          {{ scanText(sentence) }}
        </li>
      </ul>
      <p v-else class="nv-disclosure-noscan">{{ $t('pluginDisclosure.scan.noScan') }}</p>

      <details class="nv-disclosure-declared">
        <summary>{{ $t('pluginDisclosure.declaredHeading') }}</summary>
        <ul>
          <li v-for="(clause, index) in clauses" :key="index">{{ clause }}</li>
        </ul>
        <template v-if="comparison?.declaredNotSeen.length">
          <h6>{{ $t('pluginDisclosure.notSeenHeading') }}</h6>
          <ul class="nv-disclosure-notseen">
            <li v-for="item in comparison.declaredNotSeen" :key="`${item.kind}:${item.key}`">{{ itemText('notSeen', item) }}</li>
          </ul>
        </template>
      </details>


      <p class="nv-disclosure-limits">
        <template v-if="coverageSentence">
          {{ scanText(coverageSentence) }}
          {{ verified ? $t('pluginDisclosure.signedByRegistry') : $t('pluginDisclosure.scannedByRegistry') }}
        </template>
        <template v-else>{{ $t('pluginDisclosure.limitsWithoutScan') }}</template>
      </p>

      <template v-if="facts.length">
        <h5 class="nv-disclosure-heading">{{ $t('pluginDisclosure.registryHeading') }}</h5>
        <ul class="nv-disclosure-facts">
          <li v-for="fact in facts" :key="fact">{{ fact }}</li>
        </ul>
      </template>
    </template>
  </section>
</template>

<style scoped>
.nv-disclosure {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: var(--font-xs);
}
.nv-disclosure ul {
  margin: 0;
  padding-left: 1.2em;
}
.nv-disclosure h5,
.nv-disclosure h6 {
  margin: var(--space-2) 0 0;
}
.nv-disclosure-undeclared {
  border-left: 3px solid var(--danger-fg);
  background: var(--danger-subtle);
  color: var(--danger-fg);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
}
.nv-disclosure-undeclared h5 {
  margin: 0;
}
.nv-disclosure-undeclared-intro {
  margin: 2px 0 4px;
}
.nv-disclosure-notfound,
.nv-disclosure-notseen,
.nv-disclosure-facts,
.nv-disclosure-limits,
.nv-disclosure-noscan,
.nv-disclosure-none {
  color: var(--text-secondary);
}
.nv-disclosure-provenance {
  margin: 0;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.nv-disclosure-provenance--verified {
  color: var(--success-fg);
}
.nv-disclosure-incomplete {
  font-weight: 600;
}
.nv-disclosure-limits {
  margin: var(--space-2) 0 0;
  font-size: var(--font-2xs);
}
</style>
