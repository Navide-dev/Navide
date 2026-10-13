<script setup lang="ts">
// The Extension Pack install dialog (D5): a whole-pack summary, then one
// confirmation per member behind a step bar, with "Skip this one" and
// "Cancel pack" and no "accept all". Presentation only: usePackInstallFlow
// owns the state and every IPC call.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { PackInstallFlow } from '../composables/usePackInstallFlow'
import { useDialogFocus } from '../composables/useDialogFocus'

const props = defineProps<{ flow: PackInstallFlow }>()

const pack = computed(() => props.flow.pack.value)
const prepared = computed(() => props.flow.memberPrepared.value)
const member = computed(() => props.flow.currentMember.value)
const label = computed(() => pack.value?.display_name || pack.value?.id || '')

// Esc never bypasses the flow: it must not reach the settings modal (which
// closes on any Escape nobody handled; this capture listener runs first).
// At the summary it cancels the pack, on the result it closes; mid-review it
// does nothing, since leaving then is an explicit Skip or Cancel pack.
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.flow.stage.value) return
  event.preventDefault()
  event.stopPropagation()
  if (props.flow.busy.value) return
  if (props.flow.stage.value === 'summary') void props.flow.cancelPack()
  else if (props.flow.stage.value === 'done') props.flow.close()
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

// Focus follows the stage: the main action at the summary and the result,
// "Skip this one" while a member is under review (no accidental install).
const card = ref<HTMLElement | null>(null)
const { refocus } = useDialogFocus(card, () =>
  card.value?.querySelector<HTMLElement>(
    props.flow.stage.value === 'member' ? '.pack-skip' : '.pack-review, .pack-close'
  )
)
watch(
  () => [props.flow.stage.value, props.flow.currentMember.value?.id, props.flow.memberStep.value],
  () => refocus()
)

function resultTone(result: string | undefined): 'success' | 'muted' | 'danger' {
  if (result === 'installed') return 'success'
  if (result === 'failed') return 'danger'
  return 'muted'
}

function memberLabel(m: PackMemberSummary): string {
  return m.display_name ? `${m.display_name} (${m.id})` : m.id
}

// Step bar: done (installed/skipped/failed), current, or still to come.
function stepState(m: PackMemberSummary): 'current' | 'done' | 'skipped' | 'failed' | 'pending' {
  if (member.value?.id === m.id) return 'current'
  const result = props.flow.results.value[m.id]?.result
  if (result === 'installed') return 'done'
  if (result === 'skipped' || result === 'cancelled') return 'skipped'
  if (result === 'failed') return 'failed'
  return 'pending'
}
</script>

<template>
  <div v-if="pack && flow.stage.value" class="pack-dialog nv-dialog-scrim">
    <div
      ref="card"
      class="pack-body nv-dialog nv-dialog--standard"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pack-dialog-title"
      tabindex="-1"
    >
      <!-- Whole-pack summary -->
      <template v-if="flow.stage.value === 'summary'">
        <div class="nv-dialog-head">
          <span class="nv-dialog-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2.5 5 8 2.2 13.5 5 8 7.8 2.5 5Z" /><path d="M2.5 8 8 10.8 13.5 8M2.5 11 8 13.8 13.5 11" /></svg>
          </span>
          <div class="nv-dialog-heading">
            <h4 id="pack-dialog-title" class="nv-dialog-title">{{ $t('settings.extensions.pack.summaryTitle', { name: label, total: pack.members.length, count: flow.readyMembers.value.length }) }}</h4>
            <p class="nv-dialog-subtitle pack-note">{{ $t('settings.extensions.pack.summaryNote') }}</p>
          </div>
        </div>
        <div class="nv-dialog-body pack-dialog-body">
          <ul class="pack-members">
            <li
              v-for="m in pack.members"
              :key="m.id"
              class="pack-member pack-member--summary"
              :data-member="m.id"
              :data-status="m.status"
            >
              <div class="pack-member-main">
                <span class="pack-member-name" v-truncate>{{ m.display_name || m.id }}</span>
                <span class="pack-muted pack-member-id" v-truncate>
                  {{ m.version ? `${m.id} · ${m.version}` : m.id }}
                </span>
              </div>
              <div class="pack-member-caps">
                <span
                  v-for="cap in m.capabilities"
                  :key="cap"
                  class="pack-cap"
                  :class="{ 'pack-cap--sensitive': m.sensitive_capabilities.includes(cap) }"
                >{{ m.sensitive_capabilities.includes(cap) ? `${cap} · ${$t('settings.extensions.sensitive')}` : cap }}</span>
              </div>
              <span class="pack-status" :class="{ 'pack-status--ready': m.status === 'ready', 'pack-status--installed': m.status === 'installed' }">
                {{ $t(`settings.extensions.pack.status.${m.status}`, { version: m.min_navide_version ?? '' }) }}
              </span>
            </li>
          </ul>
        </div>
        <div class="pack-actions nv-dialog-actions">
          <button class="pack-cancel nv-btn" :disabled="flow.busy.value" @click="flow.cancelPack">
            {{ $t('settings.extensions.pack.cancelPack') }}
          </button>
          <button class="pack-review nv-btn nv-btn--primary" :disabled="flow.busy.value" @click="flow.beginReview">
            {{
              flow.readyMembers.value.length
                ? $t('settings.extensions.pack.review', { count: flow.readyMembers.value.length })
                : $t('settings.extensions.pack.finish')
            }}
          </button>
        </div>
      </template>

      <!-- One member at a time -->
      <template v-else-if="flow.stage.value === 'member'">
        <div class="nv-dialog-head">
          <span class="nv-dialog-icon" :class="prepared && (prepared.sensitive.length || prepared.containsBackendExecutable || flow.memberStep.value === 'publisher') ? 'nv-dialog-icon--risk' : 'nv-dialog-icon--ok'" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M8 1.8 13 3.7v4c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5v-4L8 1.8Z" /><path d="m5.7 8.1 1.6 1.6 3-3.2" /></svg>
          </span>
          <div class="nv-dialog-heading">
            <h4 id="pack-dialog-title" class="nv-dialog-title">{{ $t('settings.extensions.pack.reviewTitle', { name: label, count: flow.readyMembers.value.length }) }}</h4>
          </div>
        </div>
        <div class="nv-dialog-body pack-dialog-body">
          <ol class="pack-steps">
            <li
              v-for="(m, index) in flow.readyMembers.value"
              :key="m.id"
              class="pack-step"
              :class="`pack-step--${stepState(m)}`"
              :aria-current="stepState(m) === 'current' ? 'step' : undefined"
              :title="m.id"
            >
              <span class="pack-step-mark">{{ stepState(m) === 'done' ? '✓' : index + 1 }}</span>
              <span class="pack-step-label" v-truncate>{{ m.id }}</span>
            </li>
          </ol>
          <p v-if="!prepared" class="nv-loading">{{ $t('settings.extensions.pack.verifying') }}</p>
          <template v-else-if="member">
            <p class="pack-member-title">
              <strong>{{ memberLabel(member) }}</strong> <span class="pack-muted">{{ prepared.version }}</span>
            </p>
            <p v-if="flow.memberStep.value === 'publisher'" class="pack-publisher-risk pack-callout">
              {{ $t('settings.extensions.trust.publisherRisk', { publisher: prepared.publisherId, id: prepared.id }) }}
            </p>
            <template v-else>
              <p v-if="prepared.containsBackendExecutable" class="pack-backend-risk pack-callout">
                {{ $t('settings.extensions.trust.backendRisk', { name: prepared.id }) }}
              </p>
              <p v-if="prepared.sensitive.length" class="pack-sensitive">
                {{ $t('settings.extensions.trust.sensitiveRisk', { name: prepared.id, capabilities: prepared.sensitive.join(', ') }) }}
              </p>
              <p v-if="prepared.sensitive.length" class="pack-sensitive-caps">
                <span v-for="cap in prepared.sensitive" :key="cap" class="pack-cap pack-cap--sensitive">
                  {{ cap }} · {{ $t('settings.extensions.sensitive') }}
                </span>
              </p>
              <p v-if="!prepared.containsBackendExecutable && !prepared.sensitive.length" class="pack-plain">
                {{ $t('settings.extensions.pack.noSensitive', { name: prepared.id }) }}
              </p>
            </template>
            <p class="pack-trust">
              <span v-if="prepared.trustTier === 'signed-verified'" class="pack-badge pack-badge--ok">
                {{ $t('settings.extensions.trust.signed') }}
              </span>
              <span v-else class="pack-badge pack-badge--neutral">{{ $t('settings.extensions.trust.unsigned') }}</span>
              <span class="pack-muted">{{ $t('settings.extensions.marketplace.publisher') }}: {{ prepared.publisherId }}</span>
            </p>
          </template>
          <p class="pack-note">{{ $t('settings.extensions.pack.partialNote') }}</p>
        </div>
        <div class="pack-actions nv-dialog-actions">
          <button class="pack-cancel nv-btn nv-btn--ghost nv-dialog-actions-start pack-cancel--danger" :disabled="flow.busy.value" @click="flow.cancelPack">
            {{ $t('settings.extensions.pack.cancelPack') }}
          </button>
          <button class="pack-skip nv-btn" :disabled="flow.busy.value" @click="flow.skipMember">
            {{ $t('settings.extensions.pack.skip') }}
          </button>
          <button
            v-if="flow.memberStep.value === 'publisher'"
            class="pack-confirm-publisher nv-btn nv-btn--primary"
            :disabled="flow.busy.value || !prepared"
            @click="flow.confirmPublisher"
          >
            {{ $t('settings.extensions.trust.confirmPublisher') }}
          </button>
          <button
            v-else
            class="pack-confirm nv-btn nv-btn--primary"
            :disabled="flow.busy.value || !prepared"
            @click="flow.confirmMember"
          >
            {{ $t('settings.extensions.pack.confirmMember') }}
          </button>
        </div>
      </template>

      <!-- Result -->
      <template v-else-if="flow.stage.value === 'done'">
        <div class="nv-dialog-head">
          <span class="nv-dialog-icon nv-dialog-icon--ok" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.4 2.9 2.9 6.1-6.4" /></svg>
          </span>
          <div class="nv-dialog-heading">
            <h4 id="pack-dialog-title" class="nv-dialog-title">{{ $t('settings.extensions.pack.doneTitle', { name: label }) }}</h4>
          </div>
        </div>
        <div class="nv-dialog-body pack-dialog-body">
          <ul class="pack-members">
            <li v-for="m in pack.members" :key="m.id" class="pack-member pack-member--result" :data-member="m.id">
              <span class="pack-member-main">
                <span class="pack-member-name" v-truncate>{{ m.display_name || m.id }}</span>
                <span v-if="m.display_name" class="pack-muted pack-member-id" v-truncate>{{ m.id }}</span>
              </span>
              <span
                class="pack-result"
                :class="`pack-result--${resultTone(flow.results.value[m.id]?.result)}`"
              >
                {{ flow.results.value[m.id]?.result === 'installed' ? '✓' : flow.results.value[m.id]?.result === 'failed' ? '✕' : '–' }}
                {{
                  flow.results.value[m.id]
                    ? $t(`settings.extensions.pack.result.${flow.results.value[m.id].result}`)
                    : $t(`settings.extensions.pack.status.${m.status}`, { version: m.min_navide_version ?? '' })
                }}
              </span>
              <span v-if="flow.results.value[m.id]?.error" class="pack-error">{{ flow.results.value[m.id].error }}</span>
            </li>
          </ul>
          <p v-if="Object.values(flow.results.value).some((r) => r.result === 'installed')" class="pack-note">
            {{ $t('settings.extensions.pack.restartNote') }}
          </p>
        </div>
        <div class="pack-actions nv-dialog-actions">
          <button class="pack-close nv-btn nv-btn--primary" @click="flow.close">
            {{ $t('settings.extensions.pack.close') }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pack-dialog {
  position: fixed;
  inset: 0;
  /* Above the settings modal chrome (.s-close is z-index 30 in the same
     stacking context), so the modal cannot be closed mid-flow. */
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
}
/* Member rows are wide: give the body the full card width. */
.pack-dialog-body {
  padding-left: var(--space-5);
}
.pack-members {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
.pack-member {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-muted);
}
.pack-member:last-child {
  border-bottom: 0;
}
.pack-member-name {
  font-weight: 600;
  color: var(--text-bright);
}
.pack-muted,
.pack-note {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.pack-note {
  margin: var(--space-3) 0 0;
}
.pack-status {
  justify-self: end;
  color: var(--risk-fg);
  font-size: var(--font-xs);
  text-align: right;
  /* A status that still has to wrap splits evenly, never leaving one word. */
  text-wrap: balance;
}
.pack-status--ready,
.pack-status--installed {
  color: var(--text-secondary);
}
/* Summary rows share one grid (name | permissions | state), like the pack
   detail page, so no member's state wraps under its name. */
.pack-member--summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(9rem, max-content);
  gap: var(--space-3);
}
.pack-member--result {
  justify-content: space-between;
}
.pack-member-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
/* An id or version never breaks mid-token: one line, ellipsis, full value in
   the tooltip. */
.pack-member--summary .pack-member-name,
.pack-member-id {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-member-caps {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.pack-result {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.pack-result--success {
  color: var(--trust-signed-fg);
  background: var(--trust-signed-subtle);
}
.pack-result--muted {
  color: var(--text-secondary);
  background: var(--bg-muted);
}
.pack-result--danger {
  color: var(--danger-bright);
  background: var(--danger-subtle);
}
.pack-cap {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  background: var(--bg-muted);
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
}
.pack-cap--sensitive {
  color: var(--risk-fg);
  background: var(--risk-subtle);
  font-weight: 600;
}
.pack-sensitive-caps {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.pack-error {
  flex: 1 1 100%;
  color: var(--danger-bright);
  font-size: var(--font-xs);
}
.pack-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.pack-badge--ok {
  color: var(--trust-signed-fg);
  background: var(--trust-signed-subtle);
}
.pack-badge--neutral {
  color: var(--trust-unsigned-fg);
  background: var(--trust-unsigned-subtle);
}
.pack-callout {
  padding: 8px 10px 8px 12px;
  border-left: 3px solid var(--risk-fg);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  background: var(--risk-subtle);
  color: var(--risk-fg);
}
/* Step bar: one segment per member under review, filling as they are done. */
.pack-steps {
  display: flex;
  gap: 6px;
  list-style: none;
  margin: 0 0 var(--space-4);
  padding: 0;
  font-size: var(--font-2xs);
}
.pack-step {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 8px;
  border-top: 3px solid var(--border-default);
  color: var(--text-secondary);
  transition:
    border-color var(--motion-base) var(--ease-out),
    color var(--motion-base) var(--ease-out);
}
.pack-step-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-step-mark {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-size: var(--font-3xs);
  font-variant-numeric: tabular-nums;
}
.pack-step--current {
  border-top-color: var(--accent-fg);
  color: var(--accent-fg);
  font-weight: 600;
}
.pack-step--done {
  border-top-color: var(--trust-signed-fg);
  color: var(--trust-signed-fg);
}
.pack-step--skipped,
.pack-step--failed {
  border-top-style: dashed;
}
.pack-step--skipped .pack-step-label,
.pack-step--failed .pack-step-label {
  text-decoration: line-through;
}
.pack-member-title {
  margin: 0 0 var(--space-2);
}
.pack-trust {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pack-cancel--danger {
  color: var(--danger-bright);
}
.pack-cancel--danger:hover:not(:disabled) {
  background: var(--danger-subtle);
  color: var(--danger-bright);
}
</style>
