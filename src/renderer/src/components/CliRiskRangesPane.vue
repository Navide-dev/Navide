<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { looksLikeCidr, type SharedRange } from '../lib/cliRisk'

const props = defineProps<{ backend: Pick<ReturnType<typeof useBackend>, 'send'> }>()

const { t } = useI18n()
const ranges = ref<SharedRange[]>([])
const cidr = ref('')
const label = ref('')
// A message keeps its i18n key and is translated when shown, so a language
// change never leaves it in the previous language; backend text is shown as given.
type PaneMessage = { key: string } | { text: string }
const error = ref<PaneMessage | null>(null)
const busy = ref(false)

async function run(type: string, payload: Record<string, unknown>, fallback: string): Promise<boolean> {
  busy.value = true
  error.value = null
  try {
    const resp = await props.backend.send<{ ranges: SharedRange[] }>(type, payload)
    if (resp.ok && resp.payload) {
      ranges.value = resp.payload.ranges
      return true
    }
    error.value = resp.error?.message ? { text: resp.error.message } : { key: fallback }
  } catch (err) {
    error.value = err instanceof Error ? { text: err.message } : { key: fallback }
  } finally {
    busy.value = false
  }
  return false
}

async function add(): Promise<void> {
  if (!looksLikeCidr(cidr.value)) {
    error.value = { key: 'cli-risk.ranges-invalid-cidr' }
    return
  }
  if (!label.value.trim()) {
    error.value = { key: 'cli-risk.ranges-label-required' }
    return
  }
  if (await run('cli_risk.ranges.add', { cidr: cidr.value.trim(), label: label.value.trim() }, 'cli-risk.ranges-save-failed')) {
    cidr.value = ''
    label.value = ''
  }
}

async function toggle(range: SharedRange, event: Event): Promise<void> {
  const box = event.target as HTMLInputElement
  // A refused save leaves `ranges` unchanged, so put the box back by hand.
  if (!await run('cli_risk.ranges.update', { cidr: range.cidr, enabled: !range.enabled }, 'cli-risk.ranges-save-failed')) {
    box.checked = range.enabled
  }
}

onMounted(() => { void run('cli_risk.ranges.list', {}, 'cli-risk.ranges-load-failed') })
</script>

<template>
  <section class="cli-risk-ranges" data-settings-section="cli-risk-ranges">
    <h3 class="ranges-title">{{ t('cli-risk.ranges-title') }}</h3>
    <p class="ranges-hint">{{ t('cli-risk.ranges-hint') }}</p>
    <form class="ranges-add" @submit.prevent="add">
      <input v-model="cidr" type="text" :placeholder="t('cli-risk.ranges-cidr-placeholder')" :aria-label="t('cli-risk.ranges-cidr')" spellcheck="false" />
      <input v-model="label" type="text" maxlength="64" :placeholder="t('cli-risk.ranges-label')" :aria-label="t('cli-risk.ranges-label')" />
      <button type="submit" :disabled="busy">{{ t('cli-risk.ranges-add') }}</button>
    </form>
    <p v-if="error" role="alert" class="ranges-error">{{ 'key' in error ? t(error.key) : error.text }}</p>
    <div class="ranges-table-wrap">
      <table class="ranges-table">
        <thead>
          <tr>
            <th>{{ t('cli-risk.ranges-cidr') }}</th>
            <th>{{ t('cli-risk.ranges-label') }}</th>
            <th>{{ t('cli-risk.ranges-source') }}</th>
            <th>{{ t('cli-risk.ranges-enabled') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="range in ranges" :key="range.cidr" :data-cidr="range.cidr" :class="{ off: !range.enabled }">
            <td><code>{{ range.cidr }}</code></td>
            <td>{{ range.label }}</td>
            <td>{{ t(`cli-risk.ranges-source-${range.source}`) }}</td>
            <td>
              <input
                type="checkbox"
                :checked="range.enabled"
                :disabled="busy"
                :aria-label="t('cli-risk.ranges-toggle', { cidr: range.cidr })"
                @change="toggle(range, $event)"
              />
            </td>
            <td>
              <button
                v-if="range.source === 'user'"
                type="button"
                class="ranges-delete"
                :disabled="busy"
                @click="run('cli_risk.ranges.delete', { cidr: range.cidr }, 'cli-risk.ranges-save-failed')"
              >{{ t('cli-risk.ranges-delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.cli-risk-ranges { margin-bottom: 26px; }
.ranges-title { margin: 0 0 4px; font-size: var(--font-sm); font-weight: 600; color: var(--text-bright); }
.ranges-hint { margin: 0 0 14px; font-size: 11.5px; color: var(--text-secondary); }
.ranges-add { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.ranges-add input { flex: 1 1 140px; min-width: 0; font: inherit; font-size: var(--font-2xs); color: var(--text-primary); background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-xs); padding: 4px 6px; }
.ranges-add button, .ranges-delete { font: inherit; font-size: var(--font-2xs); color: var(--text-primary); background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-xs); padding: 3px 8px; cursor: pointer; }
.ranges-add button:disabled, .ranges-delete:disabled { opacity: 0.5; cursor: default; }
.ranges-error { margin: 0 0 8px; font-size: var(--font-2xs); color: var(--danger-fg); }
.ranges-table-wrap { max-height: 280px; overflow: auto; border: 1px solid var(--border-muted); border-radius: var(--radius-xs); }
.ranges-table { width: 100%; border-collapse: collapse; font-size: var(--font-2xs); color: var(--text-primary); }
.ranges-table th { position: sticky; top: 0; text-align: left; font-weight: 600; color: var(--text-secondary); background: var(--bg-overlay); padding: 4px 8px; }
.ranges-table td { padding: 3px 8px; border-top: 1px solid var(--border-muted); }
.ranges-table tr.off td { color: var(--text-secondary); }
</style>
