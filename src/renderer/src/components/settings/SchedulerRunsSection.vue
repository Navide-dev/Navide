<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../../composables/useBackend'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'

/**
 * Settings → General → Scheduler: how many times scheduled jobs run a day.
 * The backend keeps the values (scheduler.settings.get / .set); null means
 * the user chose no cap. The defaults are what Navide always did.
 */
const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send'>
}>()

const { t } = useI18n()

type Key = 'max_runs_per_day' | 'agent_max_runs_per_day' | 'agent_runs_per_day'
type RunSettings = Record<Key, number | null>

const ROWS: Array<{ key: Key; label: string; max: number }> = [
  { key: 'max_runs_per_day', label: 'per-job', max: 1440 },
  { key: 'agent_max_runs_per_day', label: 'agent-job', max: 1440 },
  { key: 'agent_runs_per_day', label: 'agent-total', max: 100_000 },
]
const DEFAULTS: RunSettings = { max_runs_per_day: 24, agent_max_runs_per_day: 288, agent_runs_per_day: 300 }

const settings = ref<RunSettings | null>(null)
const busy = ref(false)
const error = ref('')

async function request(type: string, payload: Record<string, unknown>): Promise<RunSettings | null> {
  try {
    const res = await props.backend.send<{ ok?: boolean; settings?: RunSettings }>(type, payload)
    if (res.ok && res.payload?.settings) return res.payload.settings
    error.value = res.error?.message ?? t('settings.scheduler.save-failed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  return null
}

onMounted(async () => {
  settings.value = await request('scheduler.settings.get', {})
})

async function save(key: Key, value: number | null): Promise<void> {
  busy.value = true
  error.value = ''
  const next = await request('scheduler.settings.set', { settings: { [key]: value } })
  busy.value = false
  if (next) settings.value = next
}

function onValue(key: Key, max: number, event: Event): void {
  const input = event.target as HTMLInputElement
  const next = Number(input.value)
  // An out-of-range entry is not sent; put the field back to what is.
  if (!Number.isInteger(next) || next < 1 || next > max) {
    input.value = String(settings.value?.[key] ?? '')
    return
  }
  void save(key, next)
}

function onNoCap(key: Key, event: Event): void {
  const off = (event.target as HTMLInputElement).checked
  void save(key, off ? null : DEFAULTS[key])
}
</script>

<template>
  <SettingsSection :label="t('settings.section.scheduler')" data-testid="scheduler-runs">
    <p class="sr-hint">{{ t('settings.scheduler.hint') }}</p>
    <SettingsCard>
      <SettingRow
        v-for="row in ROWS"
        :key="row.key"
        :data-settings-section="`general-scheduler-${row.label}`"
        :title="t(`settings.scheduler.${row.label}`)"
        :description="t(`settings.scheduler.${row.label}-hint`)"
      >
        <template #control>
          <span class="sr-control">
            <input
              v-if="settings && settings[row.key] !== null"
              type="number"
              min="1"
              :max="row.max"
              :value="settings[row.key]"
              :disabled="busy"
              :aria-label="t(`settings.scheduler.${row.label}`)"
              :data-testid="`scheduler-${row.label}-value`"
              @change="onValue(row.key, row.max, $event)"
            />
            <label class="sr-no-cap">
              <input
                type="checkbox"
                :checked="settings?.[row.key] === null"
                :disabled="busy || !settings"
                :data-testid="`scheduler-${row.label}-no-cap`"
                @change="onNoCap(row.key, $event)"
              />
              {{ t('settings.scheduler.no-cap') }}
            </label>
          </span>
        </template>
      </SettingRow>
    </SettingsCard>
    <p v-if="error" class="sr-error" role="alert" data-testid="scheduler-runs-error">{{ error }}</p>
  </SettingsSection>
</template>

<style scoped>
.sr-hint { margin: 0 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.4; }
.sr-error { margin: 8px 0; font-size: var(--font-row-desc); color: var(--danger-fg); }
.sr-control { display: inline-flex; align-items: center; gap: 10px; }
.sr-no-cap { display: inline-flex; align-items: center; gap: 4px; font-size: var(--font-row-desc); white-space: nowrap; }
</style>
