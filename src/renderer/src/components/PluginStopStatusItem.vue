<script setup lang="ts">
// Plan P2: the status bar's Navide plugins item. Shown while a third-party
// Navide plugin is installed; its popover lists them and stops one at once
// (asked once more in place), the same stop as Settings → Navide Plugins.
// It never starts a plugin: enabling stays in Settings, which shows what the
// plugin was doing when it was stopped. Plugin ids are shown as plain text.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'

const props = withDefaults(defineProps<{ open: boolean; pollMs?: number }>(), { pollMs: 30_000 })
const emit = defineEmits<{ toggle: []; close: []; 'open-settings': [] }>()
const { t } = useI18n()

const rows = ref<InstalledPluginSummary[]>([])
const confirming = ref<string | null>(null)
const stopping = ref<string | null>(null)
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null

/** Third-party packages with the Disabled switch: the ones a stop applies to. */
const stoppable = computed(() => rows.value.filter((row) => row.disabled !== undefined && row.provenance !== 'factory-bundled'))
const running = computed(() => stoppable.value.filter((row) => row.disabled === false))

async function load(): Promise<void> {
  try {
    rows.value = (await window.agentTeam?.plugins?.listInstalled?.()) ?? []
  } catch {
    // Advisory: the item hides until the list can be read.
  }
}

async function stop(id: string): Promise<void> {
  if (confirming.value !== id) {
    confirming.value = id
    return
  }
  confirming.value = null
  stopping.value = id
  error.value = ''
  try {
    await window.agentTeam?.plugins?.stop?.(id, 'status-bar')
  } catch (err) {
    error.value = t('pluginStop.failed', { id: reveal(id), error: err instanceof Error ? err.message : String(err) })
  } finally {
    stopping.value = null
    await load()
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) emit('close')
}

watch(() => props.open, (open) => {
  confirming.value = null
  error.value = ''
  if (open) void load()
})
onMounted(() => {
  void load()
  timer = setInterval(() => void load(), props.pollMs)
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <span
    v-if="stoppable.length > 0"
    class="sb-item sb-clickable nv-sb-plugins"
    role="button"
    tabindex="0"
    :title="t('pluginStop.statusBar.title')"
    :aria-label="t('pluginStop.statusBar.title')"
    @click="emit('toggle')"
    @keydown.enter="emit('toggle')"
  >
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 2v4M15 2v4M6 6h12v5a6 6 0 0 1-12 0z M12 17v5" />
    </svg>
    {{ t('pluginStop.statusBar.label', { running: running.length }) }}
  </span>
  <template v-if="props.open && stoppable.length > 0">
    <div class="nv-sbp-backdrop" @click="emit('close')" />
    <div class="nv-sbp-pop nv-popover" role="dialog" :aria-label="t('pluginStop.statusBar.heading')" @click.stop>
      <div class="nv-sbp-head">
        <span class="nv-sbp-title">{{ t('pluginStop.statusBar.heading') }}</span>
        <button class="nv-sbp-btn" data-act="close" :title="t('pluginStop.cancel')" @click="emit('close')">✕</button>
      </div>
      <p v-if="error" class="nv-sbp-error" role="alert">{{ error }}</p>
      <ul class="nv-sbp-rows">
        <li v-for="row in stoppable" :key="row.id" class="nv-sbp-row" :data-id="row.id">
          <span class="nv-sbp-id">{{ reveal(row.id) }}</span>
          <span v-if="row.disabled" class="nv-sbp-muted">{{ t('pluginActivity.monitor.status.disabled') }}</span>
          <template v-else>
            <button
              class="nv-sbp-stop nv-btn nv-btn--sm"
              :class="{ 'nv-sbp-stop--confirm': confirming === row.id }"
              :disabled="stopping !== null"
              :title="t('pluginStop.note', { id: reveal(row.id) })"
              @click="stop(row.id)"
            >{{ stopping === row.id ? t('pluginStop.stopping') : confirming === row.id ? t('pluginStop.confirm') : t('pluginStop.stop') }}</button>
          </template>
        </li>
      </ul>
      <div class="nv-sbp-foot">
        <button class="nv-sbp-link" data-act="open-settings" @click="emit('open-settings')">{{ t('pluginStop.statusBar.openSettings') }} ›</button>
      </div>
    </div>
  </template>
</template>

<style scoped>
/* The status bar's item look (App.vue's .sb-item is scoped to App). */
.nv-sb-plugins {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  height: 22px;
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}
.nv-sb-plugins:hover {
  background: var(--bg-hover);
  color: var(--text-bright);
}
.nv-sbp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.nv-sbp-pop {
  position: fixed;
  right: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 320px;
  max-height: 60vh;
  overflow-y: auto;
  border-radius: var(--radius-popover);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  box-shadow: var(--shadow-popover);
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.nv-sbp-head,
.nv-sbp-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
}
.nv-sbp-head {
  border-bottom: 1px solid var(--border-muted);
}
.nv-sbp-foot {
  justify-content: flex-end;
  border-top: 1px solid var(--border-muted);
}
.nv-sbp-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-bright);
}
.nv-sbp-btn {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
  font-size: var(--font-3xs);
  cursor: pointer;
}
.nv-sbp-error {
  margin: 0;
  padding: 6px 10px 0;
  color: var(--danger-fg);
}
.nv-sbp-rows {
  margin: 0;
  padding: 6px 10px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nv-sbp-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nv-sbp-id {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.nv-sbp-muted {
  color: var(--text-muted);
}
.nv-sbp-stop.nv-sbp-stop--confirm {
  background: var(--danger-emphasis);
  border-color: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.nv-sbp-link {
  background: none;
  border: 0;
  padding: 0;
  color: var(--accent-fg);
  font: inherit;
  cursor: pointer;
}
</style>
