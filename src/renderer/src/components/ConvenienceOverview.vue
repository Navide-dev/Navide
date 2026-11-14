<script setup lang="ts">
import { nextTick, onMounted, ref, watch, type DeepReadonly } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import {
  convenienceHistory,
  refreshConvenience,
  setConvenienceAllowed,
  useConvenienceState,
  type ConvenienceFeature,
  type ConvenienceLogEntry,
} from '../composables/useConvenience'
import { convenienceText } from '../lib/convenienceText'

// Settings → Extensions → 「便利功能與 Navide 對你電腦的修改」: one card per
// convenience feature (docs/en-US/convenience-features.md). Turning one off
// asks first and names what Navide will remove; allowing needs no confirm.

const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send'>
  /** Feature id whose card to bring into view (a CLI Extensions row's link). */
  focus?: string
}>()

const { t } = useI18n()
const { features, loadError } = useConvenienceState()
const loading = ref(false)
/** The feature whose turn-off confirm is open. */
const confirming = ref<string | null>(null)
const busy = ref<string | null>(null)
const setError = ref<Record<string, string>>({})
const history = ref<Record<string, { loading: boolean; error: string; entries: ConvenienceLogEntry[] }>>({})

const HISTORY_LIMIT = 50

/** The shared state hands features out read-only. */
type Feature = DeepReadonly<ConvenienceFeature>

async function load(): Promise<void> {
  loading.value = true
  try {
    await refreshConvenience(props.backend)
  } finally {
    loading.value = false
  }
}

/** Paths a turn-off would remove: what Navide wrote that is still there. */
function removable(feature: Feature): string[] {
  return feature.targets.filter((target) => target.present).map((target) => target.path)
}

async function apply(feature: Feature, allowed: boolean): Promise<void> {
  confirming.value = null
  busy.value = feature.id
  setError.value = { ...setError.value, [feature.id]: '' }
  const res = await setConvenienceAllowed(props.backend, feature.id, allowed)
  busy.value = null
  if (!res.ok) setError.value = { ...setError.value, [feature.id]: res.error }
  else if (history.value[feature.id]) void loadHistory(feature.id)
}

function onSwitch(feature: Feature): void {
  if (feature.state === 'off') void apply(feature, true)
  else confirming.value = feature.id
}

async function loadHistory(id: string): Promise<void> {
  history.value = { ...history.value, [id]: { loading: true, error: '', entries: history.value[id]?.entries ?? [] } }
  const res = await convenienceHistory(props.backend, { feature: id, limit: HISTORY_LIMIT })
  history.value = {
    ...history.value,
    [id]: res.ok ? { loading: false, error: '', entries: res.data } : { loading: false, error: res.error, entries: [] },
  }
}

function onHistoryToggle(id: string, event: Event): void {
  if ((event.target as HTMLDetailsElement).open) void loadHistory(id)
}

function cliLabel(cli: string): string {
  return cli === 'all' ? t('convenience.overview.allClis') : cli
}

function fmtTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString()
}

const root = ref<HTMLElement | null>(null)
watch(
  () => [props.focus, features.value.length] as const,
  async ([id]) => {
    if (!id) return
    await nextTick()
    const cards = root.value?.querySelectorAll<HTMLElement>('.conv-card') ?? []
    const card = [...cards].find((el) => el.dataset.feature === id)
    card?.scrollIntoView?.({ block: 'nearest' })
  },
  { immediate: true }
)

onMounted(() => { void load() })
</script>

<template>
  <section ref="root" class="conv" data-settings-section="convenience-features">
    <h2 class="conv-title">{{ t('convenience.overview.title') }}</h2>
    <p class="conv-intro">{{ t('convenience.overview.intro') }}</p>
    <p v-if="loadError" role="alert" class="conv-error">{{ t('convenience.overview.loadFailed', { error: loadError }) }}</p>
    <p v-else-if="loading && !features.length" class="conv-empty">{{ t('convenience.overview.loading') }}</p>

    <ul class="conv-list">
      <li
        v-for="feature in features"
        :key="feature.id"
        class="conv-card"
        :class="{ focused: focus === feature.id }"
        :data-feature="feature.id"
        :data-state="feature.toggleable ? feature.state : 'required'"
      >
        <div class="conv-head">
          <span class="conv-name">{{ convenienceText(feature.id, 'name') }}</span>
          <span class="conv-cli">{{ cliLabel(feature.cli) }}</span>
          <span v-if="!feature.toggleable" class="conv-required" :title="t('convenience.overview.requiredHint')">
            {{ t('convenience.overview.required') }}
          </span>
          <button
            v-else
            type="button"
            role="switch"
            class="conv-switch"
            :class="{ on: feature.state === 'allowed' }"
            :aria-checked="feature.state === 'allowed'"
            :disabled="busy === feature.id"
            @click="onSwitch(feature)"
          >
            {{ feature.state === 'allowed' ? t('convenience.overview.allowed') : t('convenience.overview.off') }}
          </button>
        </div>
        <p class="conv-benefit">{{ convenienceText(feature.id, 'benefit') }}</p>
        <p v-if="feature.state === 'off' && feature.reason === 'removed'" class="conv-reason">
          {{ t('convenience.overview.reasonRemoved') }}
        </p>

        <div class="conv-field">
          <span class="conv-label">{{ t('convenience.overview.writes') }}</span>
          <span>{{ convenienceText(feature.id, 'writes') }}</span>
        </div>
        <ul v-if="feature.targets.length" class="conv-targets">
          <li v-for="target in feature.targets" :key="target.path" class="conv-target" :data-present="target.present">
            <code v-truncate class="conv-path">{{ target.path }}</code>
            <span class="conv-presence" :class="{ absent: !target.present }">
              {{ target.present ? t('convenience.overview.present') : t('convenience.overview.absent') }}
            </span>
          </li>
        </ul>
        <p v-else class="conv-empty">{{ t('convenience.overview.noTargets') }}</p>
        <div v-if="feature.toggleable" class="conv-field">
          <span class="conv-label">{{ t('convenience.overview.cost') }}</span>
          <span>{{ convenienceText(feature.id, 'cost') }}</span>
        </div>

        <div v-if="confirming === feature.id" class="conv-confirm" role="alertdialog">
          <p class="conv-confirm-title">{{ t('convenience.overview.confirmTitle', { feature: convenienceText(feature.id, 'name') }) }}</p>
          <template v-if="removable(feature).length">
            <p>{{ t('convenience.overview.confirmBody') }}</p>
            <ul class="conv-confirm-list">
              <li v-for="path in removable(feature)" :key="path"><code>{{ path }}</code></li>
            </ul>
          </template>
          <p v-else>{{ t('convenience.overview.confirmBodyNone') }}</p>
          <div class="conv-confirm-acts">
            <button type="button" class="conv-btn conv-btn-danger" data-act="confirm-off" @click="apply(feature, false)">
              {{ t('convenience.overview.confirmOff') }}
            </button>
            <button type="button" class="conv-btn" data-act="cancel-off" @click="confirming = null">
              {{ t('convenience.overview.cancel') }}
            </button>
          </div>
        </div>
        <p v-if="setError[feature.id]" role="alert" class="conv-error">
          {{ t('convenience.overview.setFailed', { error: setError[feature.id] }) }}
        </p>

        <details class="conv-history" @toggle="onHistoryToggle(feature.id, $event)">
          <summary>{{ t('convenience.overview.history') }}</summary>
          <p v-if="history[feature.id]?.loading && !history[feature.id]?.entries.length" class="conv-empty">
            {{ t('convenience.overview.loading') }}
          </p>
          <p v-else-if="history[feature.id]?.error" role="alert" class="conv-error">
            {{ t('convenience.overview.loadFailed', { error: history[feature.id].error }) }}
          </p>
          <p v-else-if="history[feature.id] && !history[feature.id].entries.length" class="conv-empty">
            {{ t('convenience.overview.historyEmpty') }}
          </p>
          <ul v-else-if="history[feature.id]" class="conv-log">
            <li v-for="entry in history[feature.id].entries" :key="entry.id" class="conv-log-row" :data-action="entry.action">
              <span class="conv-log-time">{{ fmtTime(entry.at) }}</span>
              <span class="conv-log-action">{{ t(`convenience.action.${entry.action}`) }}</span>
              <code v-if="entry.target" v-truncate class="conv-path">{{ entry.target }}</code>
              <span v-if="entry.backup" class="conv-log-backup">{{ t('convenience.overview.backup', { path: entry.backup }) }}</span>
            </li>
          </ul>
        </details>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.conv { display: flex; flex-direction: column; gap: 10px; }
.conv-title { margin: 0; font-size: var(--font-sm); font-weight: 600; color: var(--text-bright); }
.conv-intro, .conv-empty, .conv-reason { margin: 0; font-size: var(--font-xs); color: var(--text-secondary); }
.conv-reason { color: var(--warning-fg, var(--text-primary)); }
.conv-error { margin: 0; font-size: var(--font-2xs); color: var(--danger-fg); }
.conv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.conv-card { border: 1px solid var(--border-muted); border-radius: var(--radius-xs); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.conv-card.focused { border-color: var(--accent-fg, var(--border-default)); }
.conv-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.conv-name { font-weight: 600; color: var(--text-bright); font-size: var(--font-xs); overflow-wrap: anywhere; flex: 1 1 auto; min-width: 0; }
.conv-cli, .conv-required, .conv-presence { font-size: var(--font-xs); border-radius: 99px; padding: 0 7px; border: 1px solid var(--border-default); color: var(--text-secondary); white-space: nowrap; }
.conv-presence.absent { border-style: dashed; }
.conv-switch { font: inherit; font-size: var(--font-2xs); border-radius: 99px; padding: 1px 10px; border: 1px solid var(--border-default); background: var(--bg-subtle); color: var(--text-secondary); cursor: pointer; }
.conv-switch.on { color: var(--accent-fg, var(--text-primary)); border-color: var(--accent-fg, var(--border-default)); }
.conv-switch:disabled { opacity: 0.5; cursor: default; }
.conv-benefit { margin: 0; font-size: var(--font-xs); color: var(--text-primary); }
.conv-field { display: flex; gap: 6px; font-size: var(--font-2xs); color: var(--text-primary); min-width: 0; }
.conv-label { flex: none; color: var(--text-secondary); }
.conv-targets, .conv-confirm-list, .conv-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.conv-target, .conv-log-row { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--font-2xs); }
.conv-path { font-size: var(--font-xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.conv-confirm { border: 1px solid var(--danger-fg); border-radius: var(--radius-xs); padding: 6px 8px; font-size: var(--font-2xs); display: flex; flex-direction: column; gap: 4px; }
.conv-confirm p { margin: 0; }
.conv-confirm-title { font-weight: 600; color: var(--text-bright); }
.conv-confirm-list code { font-size: var(--font-xs); overflow-wrap: anywhere; }
.conv-confirm-acts { display: flex; gap: 6px; }
.conv-btn { font: inherit; font-size: var(--font-2xs); color: var(--text-primary); background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-xs); padding: 3px 8px; cursor: pointer; }
.conv-btn-danger { color: var(--danger-fg); border-color: var(--danger-fg); }
.conv-history > summary { cursor: pointer; font-size: var(--font-2xs); color: var(--text-secondary); }
.conv-log { margin-top: 4px; }
.conv-log-time, .conv-log-backup { color: var(--text-secondary); white-space: nowrap; }
.conv-log-action { color: var(--text-primary); white-space: nowrap; }
</style>
