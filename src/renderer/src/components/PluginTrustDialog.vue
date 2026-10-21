<script setup lang="ts">
// The publisher-trust / capability-risk confirmation shown between a verified
// prepareInstall and its commit. Presentation only: usePluginInstallFlow owns
// the pending package and decides which step is showing.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InstallStep, PendingInstall } from '../composables/usePluginInstallFlow'
import { useDialogFocus } from '../composables/useDialogFocus'
import { revealInvisibleValue as reveal } from '../../../shared/pluginAgentTools'
import PluginDisclosureCard from './PluginDisclosureCard.vue'
import PluginDisclosureDiff from './PluginDisclosureDiff.vue'
import PluginAgentToolsList from './PluginAgentToolsList.vue'
import PluginSourceBadge from './PluginSourceBadge.vue'

const props = defineProps<{ pending: PendingInstall; step: InstallStep | null }>()
const emit = defineEmits<{ confirmReplace: [reattach: boolean]; confirmPublisher: []; confirmRisk: []; cancel: [] }>()

// Card K3: a package picked from a file has no Registry review or signature.
// Its warning is fixed text, and consent takes an explicit acknowledgement so
// it cannot be clicked through like a Marketplace install.
// Card K4: a developer folder is unreviewed too, and its content may change
// at any time; it gets the same safeguards with its own warning.
const local = computed(() =>
  props.pending.prepared.source === 'local-unsigned' || props.pending.prepared.source === 'developer-unpacked'
)
const folder = computed(() => props.pending.prepared.source === 'developer-unpacked')
// L3: approving an update (or a replacement) switches versions at once, so
// what that does to open views is said before the user approves it.
const switchesNow = computed(() =>
  !folder.value &&
  Boolean(props.pending.prepared.disclosureDiff || props.pending.prepared.replaces || props.pending.prepared.replacesLocal)
)
// A3: what the signature beside a local file shows. Only `verified` (the
// active key of a Navide-vetted publisher signed exactly these bytes) changes
// the warning; any other signature reads as one that cannot be trusted.
const signature = computed(() => props.pending.prepared.localSignature ?? { state: 'none' as const })
// The source row names the signer, not the publisher the manifest claims.
const rowSignature = computed(() =>
  signature.value.state === 'verified' || signature.value.state === 'revoked' ? signature.value.state : undefined
)
const signerId = computed(() => ('publisherId' in signature.value ? signature.value.publisherId : ''))
const signaturePublisher = computed(() => reveal(signerId.value))
const localWarningKey = computed(() => {
  if (folder.value) return 'settings.extensions.developerMode.folderWarning'
  if (signature.value.state === 'verified') return 'settings.extensions.localInstall.signatureState.warningVerified'
  if (signature.value.state === 'revoked') return 'settings.extensions.localInstall.signatureState.warningRevoked'
  return 'settings.extensions.localInstall.warning'
})
const signatureText = computed(() =>
  signature.value.state === 'none'
    ? t('settings.extensions.localInstall.signature')
    : t(`settings.extensions.localInstall.signatureState.${signature.value.state}`, { publisher: signaturePublisher.value })
)
const acknowledged = ref(false)
// D7: taking back data set aside earlier is the user's choice, off by default.
const reattach = ref(false)
watch(() => [props.pending.prepared.id, props.step], () => {
  acknowledged.value = false
  reattach.value = false
})
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
          <h4 v-if="step === 'replace'" id="ext-trust-title" class="nv-dialog-title">{{ $t('settings.extensions.localInstall.replaceTitle') }}</h4>
          <h4 v-else-if="step === 'publisher'" id="ext-trust-title" class="nv-dialog-title">{{ $t('settings.extensions.trust.publisherTitle') }}</h4>
          <h4 v-else id="ext-trust-title" class="nv-dialog-title">{{ $t('settings.extensions.trust.permissionsTitle') }}</h4>
          <p class="nv-dialog-subtitle"><code>{{ reveal(pending.prepared.id) }}</code> · {{ reveal(pending.prepared.version) }}</p>
        </div>
      </div>
      <div id="ext-trust-desc" class="nv-dialog-body">
        <!-- W1 (S2): an agent asked for this install; the user still decides here. -->
        <p v-if="pending.agentRequest" class="ext-agent-request ext-risk-callout" role="note" data-testid="ext-trust-agent-request">
          {{ $t('settings.extensions.localInstall.agentRequest', { requester: pending.agentRequest.requester }) }}
        </p>
        <!-- L3: an approved update takes effect at once. -->
        <p v-if="switchesNow" class="ext-switch-now ext-risk-callout" role="note" data-testid="ext-trust-switch-now">
          {{ $t('settings.extensions.switchNow', { id: reveal(pending.prepared.id), version: reveal(pending.prepared.version) }) }}
        </p>
        <!-- D7: replacing an installed package of the same id is asked first. -->
        <template v-if="step === 'replace'">
          <p v-if="pending.prepared.replaces?.source === 'marketplace'" class="ext-replace-question">
            {{ $t('settings.extensions.localInstall.replaceMarketplace', { id: reveal(pending.prepared.id), version: reveal(pending.prepared.replaces.version ?? '') }) }}
          </p>
          <p v-else-if="pending.prepared.replaces" class="ext-replace-question">
            {{ $t('settings.extensions.localInstall.replaceLocal', { id: reveal(pending.prepared.id), version: reveal(pending.prepared.replaces.version ?? '') }) }}
          </p>
          <p v-else-if="pending.prepared.replacesLocal" class="ext-replace-question">
            {{ $t('settings.extensions.localInstall.replaceWithMarketplace', { id: reveal(pending.prepared.id), version: reveal(pending.prepared.version) }) }}
          </p>
          <p class="ext-replace-reset">{{ $t('settings.extensions.localInstall.replaceResets') }}</p>
          <p v-if="pending.prepared.backendDataSetAside" class="ext-replace-data">
            {{ $t('settings.extensions.localInstall.replaceDataSetAside') }}
          </p>
          <label v-if="pending.prepared.reattachableBackendData" class="ext-local-ack ext-replace-reattach">
            <input v-model="reattach" type="checkbox" class="ext-replace-reattach-input" />
            {{ $t('settings.extensions.localInstall.reattachData') }}
          </label>
        </template>
        <!-- Card K3: what a file install is, always above everything else. -->
        <template v-if="step === 'risk' && local">
          <p class="ext-local-warning ext-risk-callout" role="note">
            {{ $t(localWarningKey, { publisher: signaturePublisher }) }}
          </p>
          <p v-if="pending.prepared.takedownChecked === false" class="ext-local-takedown ext-risk-callout" role="note">
            {{ $t('settings.extensions.localInstall.takedownUnknown') }}
          </p>
          <!-- HIGH-3: data a removal kept from another source is not handed over. -->
          <p v-if="pending.prepared.backendDataSetAside && !pending.prepared.replaces" class="ext-replace-data">
            {{ $t('settings.extensions.localInstall.replaceDataSetAside') }}
          </p>
          <dl class="ext-local-facts">
            <dt>{{ $t('settings.extensions.localInstall.signatureLabel') }}</dt>
            <dd class="ext-local-signature" :data-signature="signature.state">{{ signatureText }}</dd>
            <template v-if="pending.prepared.folder">
              <dt>{{ $t('settings.extensions.developerMode.folderLabel') }}</dt>
              <dd><code class="ext-local-digest">{{ reveal(pending.prepared.folder) }}</code></dd>
            </template>
            <template v-if="pending.prepared.digest">
              <dt>{{ $t('settings.extensions.localInstall.digestLabel') }}</dt>
              <dd><code class="ext-local-digest">{{ pending.prepared.digest }}</code></dd>
            </template>
          </dl>
        </template>
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
            :verified="!local"
            :local-source="local"
            :has-views="pending.prepared.hasViews"
          />
        </details>
        <PluginDisclosureCard
          v-else-if="step === 'risk' && pending.prepared.disclosure !== undefined"
          class="ext-trust-disclosure"
          :disclosure="pending.prepared.disclosure"
          :scan="pending.prepared.scan ?? null"
          :registry="pending.prepared.registry ?? null"
          :verified="!local"
          :local-source="local"
          :has-views="pending.prepared.hasViews"
        />
        <PluginAgentToolsList
          v-if="step === 'risk' && pending.prepared.agentTools?.length"
          :tools="pending.prepared.agentTools"
        />
        <!-- K2: only the source the Host names, from the signed channel; none
             shows no row and is never guessed from the version. A file
             install (K3) names its own source, the claimed publisher and
             "not scanned". -->
        <PluginSourceBadge
          v-if="step !== 'replace' && pending.prepared.source"
          row
          class="ext-trust-source"
          :source="pending.prepared.source"
          :publisher="rowSignature ? signerId : pending.prepared.publisherId"
          :signature="rowSignature"
          :expires-at="pending.prepared.expiresAt"
          :via="pending.prepared.testplaceVia"
        />
        <label v-if="step === 'risk' && local" class="ext-local-ack">
          <input v-model="acknowledged" type="checkbox" class="ext-local-ack-input" />
          {{ $t('settings.extensions.localInstall.acknowledge') }}
        </label>
        <p v-if="step !== 'replace'" class="ext-trust-tier">
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
          v-if="step === 'replace'"
          class="ext-confirm-replace nv-btn nv-btn--primary"
          @click="$emit('confirmReplace', reattach)"
        >
          {{ $t('settings.extensions.localInstall.confirmReplace') }}
        </button>
        <button
          v-else-if="step === 'publisher'"
          class="ext-confirm-publisher nv-btn nv-btn--primary"
          @click="$emit('confirmPublisher')"
        >
          {{ $t('settings.extensions.trust.confirmPublisher') }}
        </button>
        <button
          v-else
          class="ext-confirm-risk nv-btn nv-btn--primary"
          :disabled="local && !acknowledged"
          @click="$emit('confirmRisk')"
        >
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
.ext-local-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 4px var(--space-3);
  margin: 0 0 var(--space-3);
  font-size: var(--font-xs);
}
.ext-local-facts dt {
  color: var(--text-secondary);
}
.ext-local-facts dd {
  margin: 0;
}
.ext-local-digest {
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
  overflow-wrap: anywhere;
}
.ext-local-ack {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-3) 0;
  font-size: var(--font-xs);
}
.nv-dialog-subtitle code {
  font-family: var(--font-mono);
}
</style>
