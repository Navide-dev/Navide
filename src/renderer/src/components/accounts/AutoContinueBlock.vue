<script setup lang="ts">
/**
 * Settings ▸ Accounts, above the account list: what happens when an account's
 * quota runs out (plan 0-2-42_eb5049, placement A). The mode is the same
 * quota_failover.policy General writes; next to it the account an automatic
 * switch would pick, how it picks, the switch log and any switch still
 * waiting for busy panes. Nothing below it on the page changes.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { useQuotaFailover, type FailoverMode } from '../../composables/useQuotaFailover'
import { useQueuedAccountSwitches } from '../../composables/useQueuedAccountSwitches'
import { accountLabel, DEFAULT_PROFILE_ID, type AccountLabelSource } from '../../lib/accountLabel'
import type { useBackend } from '../../composables/useBackend'

const props = defineProps<{
  /** The CLI whose account is selected below; its next account is shown. */
  agentKey: string
  accounts: AccountLabelSource
  backend?: ReturnType<typeof useBackend>
}>()

const t = i18n.global.t
const quotaFailover = useQuotaFailover()
const { queued, cancel } = useQueuedAccountSwitches()

const MODES: readonly FailoverMode[] = ['off', 'notify', 'auto']
const mode = computed<FailoverMode | null>(() => quotaFailover.state.value?.policy.mode ?? null)
const busy = ref(false)

async function onModeChange(raw: string): Promise<void> {
  if (!(MODES as readonly string[]).includes(raw) || busy.value) return
  busy.value = true
  try {
    await quotaFailover.setPolicy(raw as FailoverMode)
  } finally {
    busy.value = false
  }
}

const supported = computed(() => {
  const cap = quotaFailover.capabilityFor(props.agentKey)
  return !!(cap?.supported && cap.hasSlots)
})

// The account an automatic switch would pick, read when the CLI or the mode
// changes (the backend ranks the slots; cached for a minute).
const next = ref<{ name: string; headroom: number | null } | null>(null)
const nextLoaded = ref(false)
async function loadNext(): Promise<void> {
  nextLoaded.value = false
  if (!supported.value || !mode.value || mode.value === 'off') return
  const agentKey = props.agentKey
  const list = await quotaFailover.previewCandidates(agentKey)
  if (agentKey !== props.agentKey) return
  const pick = list?.find((c) => c.excluded === null)
  next.value = pick
    ? {
        name: accountLabel(props.accounts, agentKey, pick.slotId || DEFAULT_PROFILE_ID, t),
        headroom: pick.headroom,
      }
    : null
  nextLoaded.value = list !== null
}
watch([() => props.agentKey, mode, supported], () => void loadNext(), { immediate: true })

const left = computed(() => {
  const b = quotaFailover.budgetFor(props.agentKey)
  return b ? Math.max(0, b.limit - b.used) : null
})

// The switch log sits at the bottom of the page (account-switch-log).
const logCount = ref<number | null>(null)
onMounted(async () => {
  if (!props.backend) return
  try {
    const resp = await props.backend.send<{ entries?: unknown[] }>('account_switch_log.list', { limit: 200 })
    logCount.value = resp.payload?.entries?.length ?? 0
  } catch {
    logCount.value = null
  }
})
function openLog(): void {
  document.querySelector<HTMLElement>('[data-settings-section="account-switch-log"]')?.scrollIntoView({ block: 'start' })
}

function queuedText(job: { to: string; paneName?: string; waiting: number }): string {
  return job.paneName
    ? t('usage.auto-switch-queued-pane', { to: job.to, pane: job.paneName })
    : t('usage.auto-switch-queued', { to: job.to, n: Math.max(1, job.waiting) })
}
</script>

<template>
  <section class="ac-block" data-settings-section="accounts-auto-continue" data-testid="auto-continue-block">
    <div class="ac-head">
      <div class="ac-head-text">
        <h4 class="ac-title">{{ t('usage.auto-switch-pop-title') }}</h4>
        <p class="ac-hint">{{ t('usage.auto-switch-block-hint') }}</p>
      </div>
      <select
        class="ac-mode"
        data-testid="auto-continue-mode"
        :value="mode ?? 'notify'"
        :disabled="busy || !mode"
        :aria-label="t('usage.failover-title')"
        @change="onModeChange(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="m in MODES" :key="m" :value="m">{{ t(`usage.failover-mode-${m}`) }}</option>
      </select>
    </div>
    <div class="ac-facts">
      <span v-if="mode !== 'off' && nextLoaded" class="ac-next" data-testid="auto-continue-next">
        {{ next
          ? (next.headroom !== null
            ? t('usage.auto-switch-next-headroom', { name: next.name, pct: Math.round(next.headroom) })
            : t('usage.auto-switch-next', { name: next.name }))
          : t('usage.auto-switch-next-none') }}
      </span>
      <span v-if="mode === 'notify'" class="ac-note warn" data-testid="auto-continue-note">{{ t('usage.auto-switch-notify-only') }}</span>
      <span v-else-if="mode === 'off'" class="ac-note" data-testid="auto-continue-note">{{ t('usage.auto-switch-off-only') }}</span>
      <span v-else-if="mode === 'auto' && left !== null" class="ac-note" data-testid="auto-continue-left">{{ t('usage.auto-switch-left', { n: left }) }}</span>
      <span v-if="mode !== 'off'" class="ac-note">{{ t('usage.auto-switch-order') }}</span>
      <button v-if="logCount !== null" type="button" class="ac-link" data-testid="auto-continue-log" @click="openLog">
        {{ t('usage.auto-switch-log', { n: logCount }) }}
      </button>
    </div>
    <div v-for="job in queued" :key="job.key" class="ac-queued" data-testid="auto-continue-queued">
      <span class="ac-spin" aria-hidden="true"></span>
      <span class="ac-queued-text">{{ queuedText(job) }}</span>
      <button type="button" class="ac-cancel" data-testid="auto-continue-cancel" @click="cancel(job.key)">
        {{ t('usage.auto-switch-cancel') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.ac-block {
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-subtle);
}
.ac-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 6px 12px; }
.ac-head-text { flex: 1 1 16em; min-width: 0; }
.ac-title { margin: 0; font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); }
.ac-hint { margin: 2px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--text-secondary); max-width: 72ch; text-wrap: pretty; }
.ac-mode {
  flex: none;
  min-height: var(--control-h-md);
  padding: 3px 8px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-size: var(--font-2xs);
}
.ac-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; margin-top: 8px; font-size: var(--font-2xs); }
.ac-next { color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.ac-note { color: var(--text-secondary); }
.ac-note.warn { color: var(--attention-fg); }
.ac-link { margin-left: auto; padding: 0; border: 0; background: none; color: var(--accent-fg); font-size: inherit; cursor: pointer; }
.ac-link:hover { text-decoration: underline; }
.ac-queued {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 5px 8px;
  border: 1px solid var(--attention-muted, var(--attention-fg));
  border-radius: 6px;
  background: var(--attention-subtle, transparent);
  color: var(--attention-fg);
  font-size: var(--font-2xs);
}
.ac-queued-text { flex: 1; min-width: 0; }
.ac-spin {
  flex: none;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: ac-spin 1s linear infinite;
}
@keyframes ac-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ac-spin { animation: none; } }
.ac-cancel {
  flex: none;
  padding: 2px 8px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: transparent;
  color: var(--text-primary);
  font-size: inherit;
  cursor: pointer;
}
.ac-cancel:hover { border-color: var(--border-strong); }
</style>
