<script setup lang="ts">
// The publisher-trust / capability-risk confirmation shown between a verified
// prepareInstall and its commit. Presentation only: usePluginInstallFlow owns
// the pending package and decides which step is showing.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PendingInstall } from '../composables/usePluginInstallFlow'
import { useDialogFocus } from '../composables/useDialogFocus'
import { revealInvisibleValue as reveal } from '../../../shared/pluginAgentTools'
import PluginDisclosureCard from './PluginDisclosureCard.vue'
import PluginDisclosureDiff from './PluginDisclosureDiff.vue'
import PluginAgentToolsList from './PluginAgentToolsList.vue'
import PluginSourceBadge from './PluginSourceBadge.vue'

defineProps<{ pending: PendingInstall; step: 'publisher' | 'risk' | null }>()
const emit = defineEmits<{ confirmPublisher: []; confirmRisk: []; cancel: [] }>()
const { t, te } = useI18n()

// Esc cancels this confirmation only; it must not reach the settings modal,
// which closes on any Escape nobody handled (this capture listener runs first).
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  emit('cancel')
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

// Focus starts on Cancel: the safe answer to a security question.
const card = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
useDialogFocus(card, () => cancelButton.value)

/** K5: SemVer pre-release suffix (build metadata is not one); pre-releases are reviewed too. */
function isPrerelease(version: string): boolean {
  return version.split('+', 1)[0].includes('-')
}

/** One line on what a sensitive capability lets the extension do. */
function capabilityHint(cap: string): string {
  const key = `settings.extensions.trust.capability.${cap}`
  return te(key) ? t(key) : ''
}
</script>

<template>
  <div class="ext-trust-dialog nv-dialog-scrim">
    <div
      ref="card"
      class="ext-trust-body nv-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ext-trust-title"
      aria-describedby="ext-trust-desc"
      tabindex="-1"
    >
      <div class="nv-dialog-head">
        <span
          class="nv-dialog-icon"
          :class="step === 'publisher' || pending.prepared.containsBackendExecutable || pending.prepared.sensitive.length ? 'nv-dialog-icon--risk' : 'nv-dialog-icon--ok'"
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">
            <path d="M8 1.8 13 3.7v4c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5v-4L8 1.8Z" />
            <path v-if="step === 'publisher'" d="M8 5.2v3.2M8 10.6v.1" />
            <path v-else d="m5.7 8.1 1.6 1.6 3-3.2" />
          </svg>
        </span>
        <div class="nv-dialog-heading">
          <h4 v-if="step === 'publisher'" id="ext-trust-title" class="nv-dialog-title">{{ $t('settings.extensions.trust.publisherTitle') }}</h4>
          <h4 v-else id="ext-trust-title" class="nv-dialog-title">{{ $t('settings.extensions.trust.permissionsTitle') }}</h4>
          <p class="nv-dialog-subtitle"><code>{{ reveal(pending.prepared.id) }}</code> · {{ reveal(pending.prepared.version) }}</p>
        </div>
      </div>
      <div id="ext-trust-desc" class="nv-dialog-body">
        <!-- An unsigned package cannot lean on the Registry signature the
             signed wording mentions, so it gets its own sentence. -->
        <p v-if="step === 'publisher'" class="ext-publisher-risk">
          {{
            $t(
              pending.prepared.trustTier === 'signed-verified'
                ? 'settings.extensions.trust.publisherRisk'
                : 'settings.extensions.trust.publisherRiskUnsigned',
              { publisher: reveal(pending.prepared.publisherId), id: reveal(pending.prepared.id) }
            )
          }}
        </p>
        <!-- Plan B D2: an update also shows what it changes (the Host's diff of
             the installed and the downloaded manifests); the full card folds.
             The confirmation itself is asked exactly as before (option B). -->
        <PluginDisclosureDiff v-if="step === 'risk' && pending.prepared.disclosureDiff" :diff="pending.prepared.disclosureDiff" />
        <p v-if="step === 'risk' && pending.prepared.containsBackendExecutable" class="ext-backend-risk ext-risk-callout">
          {{ $t('settings.extensions.trust.backendRisk', { name: reveal(pending.label) }) }}
        </p>
        <template v-if="step === 'risk' && pending.prepared.sensitive.length">
          <h5 class="ext-cap-heading">{{ $t('settings.extensions.trust.sensitiveHeading') }}</h5>
          <ul class="ext-cap-list" :aria-label="$t('settings.extensions.trust.sensitiveRisk', { name: pending.label, capabilities: pending.prepared.sensitive.join(', ') })">
            <li v-for="cap in pending.prepared.sensitive" :key="cap">
              <code class="ext-cap-name">{{ cap }}</code>
              <span v-if="capabilityHint(cap)" class="ext-cap-hint">{{ capabilityHint(cap) }}</span>
            </li>
          </ul>
        </template>
        <!-- Plan B D1: the verified disclosure of exactly this package. -->
        <details
          v-if="step === 'risk' && pending.prepared.disclosureDiff && pending.prepared.disclosure !== undefined"
          class="ext-trust-full-card"
        >
          <summary>{{ $t('pluginDisclosure.diff.fullCard') }}</summary>
          <PluginDisclosureCard
            class="ext-trust-disclosure"
            :disclosure="pending.prepared.disclosure"
            :scan="pending.prepared.scan ?? null"
            :registry="pending.prepared.registry ?? null"
            :verified="true"
          />
        </details>
        <PluginDisclosureCard
          v-else-if="step === 'risk' && pending.prepared.disclosure !== undefined"
          class="ext-trust-disclosure"
          :disclosure="pending.prepared.disclosure"
          :scan="pending.prepared.scan ?? null"
          :registry="pending.prepared.registry ?? null"
          :verified="true"
        />
        <PluginAgentToolsList
          v-if="step === 'risk' && pending.prepared.agentTools?.length"
          :tools="pending.prepared.agentTools"
        />
        <!-- K2: only a Registry-signed package reads as reviewed; an unsigned
             one keeps the unsigned badge below and no source row. -->
        <PluginSourceBadge
          v-if="pending.prepared.trustTier === 'signed-verified'"
          row
          class="ext-trust-source"
          :source="isPrerelease(pending.prepared.version) ? 'prerelease' : 'marketplace'"
          :publisher="pending.prepared.publisherId"
        />
        <p class="ext-trust-tier">
          <span
            v-if="pending.prepared.trustTier === 'signed-verified'"
            class="ext-trust-badge ext-verified"
          >
            {{ $t('settings.extensions.trust.signed') }}
          </span>
          <span v-else class="ext-trust-badge ext-unsigned">
            {{ $t('settings.extensions.trust.unsigned') }}
          </span>
        </p>
      </div>
      <div class="ext-trust-actions nv-dialog-actions">
        <button ref="cancelButton" class="ext-cancel nv-btn" @click="$emit('cancel')">
          {{ $t('settings.extensions.trust.cancel') }}
        </button>
        <button
          v-if="step === 'publisher'"
          class="ext-confirm-publisher nv-btn nv-btn--primary"
          @click="$emit('confirmPublisher')"
        >
          {{ $t('settings.extensions.trust.confirmPublisher') }}
        </button>
        <button v-else class="ext-confirm-risk nv-btn nv-btn--primary" @click="$emit('confirmRisk')">
          {{ $t('settings.extensions.trust.confirmInstall') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ext-trust-dialog {
  position: fixed;
  inset: 0;
  /* Above the settings modal chrome (.s-close is z-index 30 in the same
     stacking context), so Settings cannot be closed behind the dialog. */
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ext-risk-callout {
  padding: 8px 10px 8px 12px;
  border-left: 3px solid var(--risk-fg);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--risk-subtle);
  color: var(--risk-fg);
}
.ext-cap-heading {
  margin: 0 0 var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.ext-cap-list {
  list-style: none;
  margin: 0 0 var(--space-3);
  padding: 0;
  display: grid;
  gap: 6px;
}
.ext-cap-list li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: var(--space-2);
}
.ext-cap-name {
  padding: 1px 7px;
  border-radius: var(--radius-xs);
  background: var(--risk-subtle);
  color: var(--risk-fg);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.ext-cap-hint {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.ext-trust-tier {
  margin: 0;
}
.ext-trust-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.ext-trust-badge.ext-verified {
  color: var(--trust-signed-fg);
  background: var(--trust-signed-subtle);
}
.ext-trust-badge.ext-unsigned {
  color: var(--trust-unsigned-fg);
  background: var(--trust-unsigned-subtle);
}
.ext-trust-badge.ext-unsigned::before {
  content: '⚠';
  margin-right: 4px;
}
.nv-dialog-subtitle code {
  font-family: var(--font-mono);
}
</style>
