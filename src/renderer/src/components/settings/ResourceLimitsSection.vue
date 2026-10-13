<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { isMacPlatform } from '@navide/plugin-ui/shared'
import type { useBackend } from '../../composables/useBackend'
import {
  EVOLVE_RECLAIM_DEFAULT_MINUTES,
  EVOLVE_RECLAIM_MAX_MINUTES,
  EVOLVE_RECLAIM_MIN_MINUTES,
  FOCUSED_RECLAIM_MAX_HOURS,
  FOCUSED_RECLAIM_MIN_HOURS,
  FOCUSED_RECLAIM_ON_DEFAULT,
  setFocusedReclaimHours,
  setEvolveReclaimMinutes,
  setTestMaxWorkers,
  setTrackDetached,
  TEST_MAX_WORKERS_MAX,
  TEST_MAX_WORKERS_MIN,
  TEST_MAX_WORKERS_ON_DEFAULT,
  useResourceLimits,
} from '../../composables/useResourceLimits'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'

/**
 * Settings → General → Resource limits. Every row is off (or at the behavior
 * Navide had before it) by default, and the backend fails open on anything it
 * cannot read — see composables/useResourceLimits.ts.
 */
const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send'>
}>()

const { t } = useI18n()
const { testMaxWorkers, evolveReclaimMinutes, focusedReclaimHours, trackDetached } = useResourceLimits()

function onTestWorkersToggle(on: boolean): void {
  setTestMaxWorkers(on ? TEST_MAX_WORKERS_ON_DEFAULT : 0)
}

function onTestWorkersValue(event: Event): void {
  const input = event.target as HTMLInputElement
  // An out-of-range entry is not stored; put the field back to what is.
  if (!setTestMaxWorkers(Number(input.value))) input.value = String(testMaxWorkers.value)
}

// ── servers left behind by closed panes ─────────────────────────────────────
// Listed only when asked (the scan reads every orphaned process's environment)
// and stopped only by a click; the backend re-checks identity before signalling.
interface Leftover { pid: number; started_at: number; command: string; cwd: string; rss: number }
const leftovers = ref<Leftover[]>([])
const searched = ref(false)
const detachedBusy = ref(false)
const detachedError = ref('')

async function request<T>(type: string, payload: Record<string, unknown>): Promise<(T & { ok?: boolean; error?: string }) | null> {
  try {
    const res = await props.backend.send<T & { ok?: boolean; error?: string }>(type, payload)
    if (!res.ok) {
      detachedError.value = res.error?.message ?? t('settings.limits.detached-failed')
      return null
    }
    return res.payload ?? null
  } catch (err) {
    detachedError.value = err instanceof Error ? err.message : String(err)
    return null
  }
}

async function findLeftovers(): Promise<void> {
  detachedBusy.value = true
  detachedError.value = ''
  const body = await request<{ items: Leftover[] }>('limits.detached.list', {})
  detachedBusy.value = false
  leftovers.value = body?.items ?? []
  searched.value = body !== null
}

async function stopLeftover(item: Leftover): Promise<void> {
  detachedBusy.value = true
  detachedError.value = ''
  const body = await request<object>('limits.detached.stop', { pid: item.pid, started_at: item.started_at })
  detachedBusy.value = false
  if (body?.ok) leftovers.value = leftovers.value.filter((x) => x.pid !== item.pid)
  else if (body) detachedError.value = body.error ?? t('settings.limits.detached-failed')
}

function leftoverMeta(item: Leftover): string {
  return t('settings.limits.detached-meta', {
    cwd: item.cwd || '—',
    size: `${Math.round(item.rss / (1024 * 1024))} MB`,
    since: new Date(item.started_at * 1000).toLocaleString(),
  })
}

function onFocusedReclaimToggle(on: boolean): void {
  setFocusedReclaimHours(on ? FOCUSED_RECLAIM_ON_DEFAULT : 0)
}

function onFocusedReclaimValue(event: Event): void {
  const input = event.target as HTMLInputElement
  const next = Number(input.value)
  // 0 means never, which the switch expresses; the field only takes hours.
  if (next < FOCUSED_RECLAIM_MIN_HOURS || !setFocusedReclaimHours(next)) {
    input.value = String(focusedReclaimHours.value)
  }
}

// Spotlight: an opt-in hand-off, never a change Navide makes to the system.
const onMac = isMacPlatform()
const spotlightError = ref('')

async function openSpotlightSettings(): Promise<void> {
  spotlightError.value = ''
  const res = await window.agentTeam?.openSpotlightSettings?.()
  if (res && !res.ok) spotlightError.value = res.error ?? t('settings.limits.detached-failed')
}

function onEvolveReclaimToggle(on: boolean): void {
  setEvolveReclaimMinutes(on ? EVOLVE_RECLAIM_DEFAULT_MINUTES : 0)
}

function onEvolveReclaimValue(event: Event): void {
  const input = event.target as HTMLInputElement
  const next = Number(input.value)
  // 0 means never, which the switch expresses; the field only takes a grace.
  if (next < EVOLVE_RECLAIM_MIN_MINUTES || !setEvolveReclaimMinutes(next)) {
    input.value = String(evolveReclaimMinutes.value)
  }
}
</script>

<template>
  <SettingsSection :label="t('settings.section.resource-limits')" data-testid="resource-limits">
    <p class="rl-hint">{{ t('settings.limits.hint') }}</p>
    <SettingsCard>
      <SettingRow
        data-settings-section="limits-test-workers"
        :title="t('settings.limits.test-workers')"
        :description="t('settings.limits.test-workers-hint')"
      >
        <template #control>
          <ToggleSwitch
            :model-value="testMaxWorkers > 0"
            :aria-label="t('settings.limits.test-workers')"
            data-testid="limit-test-workers-toggle"
            @update:model-value="onTestWorkersToggle"
          />
        </template>
      </SettingRow>
      <SettingRow
        v-if="testMaxWorkers > 0"
        data-settings-section="limits-test-workers-value"
        :title="t('settings.limits.test-workers-value')"
      >
        <template #control>
          <input
            type="number"
            :min="TEST_MAX_WORKERS_MIN"
            :max="TEST_MAX_WORKERS_MAX"
            :value="testMaxWorkers"
            data-testid="limit-test-workers-value"
            @change="onTestWorkersValue"
          />
        </template>
      </SettingRow>
      <SettingRow
        data-settings-section="limits-focused-reclaim"
        :title="t('settings.limits.focused-reclaim')"
        :description="t('settings.limits.focused-reclaim-hint')"
      >
        <template #control>
          <ToggleSwitch
            :model-value="focusedReclaimHours > 0"
            :aria-label="t('settings.limits.focused-reclaim')"
            data-testid="limit-focused-reclaim-toggle"
            @update:model-value="onFocusedReclaimToggle"
          />
        </template>
      </SettingRow>
      <SettingRow
        v-if="focusedReclaimHours > 0"
        data-settings-section="limits-focused-reclaim-value"
        :title="t('settings.limits.focused-reclaim-value')"
      >
        <template #control>
          <input
            type="number"
            :min="FOCUSED_RECLAIM_MIN_HOURS"
            :max="FOCUSED_RECLAIM_MAX_HOURS"
            :value="focusedReclaimHours"
            data-testid="limit-focused-reclaim-value"
            @change="onFocusedReclaimValue"
          />
        </template>
      </SettingRow>
      <SettingRow
        data-settings-section="limits-evolve-reclaim"
        :title="t('settings.limits.evolve-reclaim')"
        :description="t('settings.limits.evolve-reclaim-hint')"
      >
        <template #control>
          <ToggleSwitch
            :model-value="evolveReclaimMinutes > 0"
            :aria-label="t('settings.limits.evolve-reclaim')"
            data-testid="limit-evolve-reclaim-toggle"
            @update:model-value="onEvolveReclaimToggle"
          />
        </template>
      </SettingRow>
      <SettingRow
        v-if="evolveReclaimMinutes > 0"
        data-settings-section="limits-evolve-reclaim-value"
        :title="t('settings.limits.evolve-reclaim-value')"
      >
        <template #control>
          <input
            type="number"
            :min="EVOLVE_RECLAIM_MIN_MINUTES"
            :max="EVOLVE_RECLAIM_MAX_MINUTES"
            :value="evolveReclaimMinutes"
            data-testid="limit-evolve-reclaim-value"
            @change="onEvolveReclaimValue"
          />
        </template>
      </SettingRow>
      <SettingRow
        v-if="onMac"
        data-settings-section="limits-spotlight"
        :title="t('settings.limits.spotlight')"
        :description="t('settings.limits.spotlight-hint')"
      >
        <template #control>
          <button type="button" data-testid="limit-spotlight-open" @click="openSpotlightSettings">
            {{ t('settings.limits.spotlight-open') }}
          </button>
        </template>
      </SettingRow>
      <p v-if="spotlightError" class="rl-error" role="alert">{{ spotlightError }}</p>
      <SettingRow
        data-settings-section="limits-detached"
        :title="t('settings.limits.detached')"
        :description="t('settings.limits.detached-hint')"
      >
        <template #control>
          <ToggleSwitch
            :model-value="trackDetached"
            :aria-label="t('settings.limits.detached')"
            data-testid="limit-detached-toggle"
            @update:model-value="setTrackDetached"
          />
        </template>
      </SettingRow>
      <div v-if="trackDetached" class="rl-detached">
        <button type="button" :disabled="detachedBusy" data-testid="limit-detached-find" @click="findLeftovers">
          {{ t('settings.limits.detached-find') }}
        </button>
        <p v-if="detachedError" class="rl-error" role="alert" data-testid="limit-detached-error">{{ detachedError }}</p>
        <p v-if="searched && leftovers.length === 0" class="rl-hint" data-testid="limit-detached-empty">
          {{ t('settings.limits.detached-empty') }}
        </p>
        <div v-for="item in leftovers" :key="item.pid" class="rl-row" data-testid="limit-detached-row">
          <div class="rl-row-text">
            <code v-truncate class="rl-cmd">{{ item.command }}</code>
            <span class="rl-meta">PID {{ item.pid }} · {{ leftoverMeta(item) }}</span>
          </div>
          <button type="button" :disabled="detachedBusy" data-testid="limit-detached-stop" @click="stopLeftover(item)">
            {{ t('settings.limits.detached-stop') }}
          </button>
        </div>
      </div>
    </SettingsCard>
  </SettingsSection>
</template>

<style scoped>
.rl-hint { margin: 0 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.4; }
.rl-error { margin: 8px 0; font-size: var(--font-row-desc); color: var(--danger-fg); }
.rl-detached { padding: 8px 12px 12px; }
.rl-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid var(--border-muted); }
.rl-row-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.rl-cmd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-row-desc); }
.rl-meta { font-size: var(--font-row-desc); color: var(--text-secondary); }
</style>
