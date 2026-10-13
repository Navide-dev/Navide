<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { createPluginCapabilityClient } from '@navide/plugin-sdk'
import { SafeAiCliPanel, createAiCliSessionController, createAiCliTerminalView, createAiCliTerminalResources, type SafeAiCliPanelHandle } from '@navide/plugin-ui'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { useBackend } from '../composables/useBackend'
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = withDefaults(defineProps<{
  widthKey: string
  workspacePath: string
  paneId: string
  origin: string
  defaultWidth?: number
  buildContext?: () => string | Promise<string>
}>(), { defaultWidth: 320 })
const { t } = useI18n()
const open = defineModel<boolean>('open', { default: false })
const client = createPluginCapabilityClient()
const controller = createAiCliSessionController(client, { persistView: true })
const terminalView = createAiCliTerminalView(client, controller)
const terminalResources = createAiCliTerminalResources(client, controller)
const profilePreference = {
  async read() { return (await client.capabilities.invoke('aiCli.getEditorProfile', {})).profileId },
  async write(profileId: string) { await client.capabilities.invoke('aiCli.setEditorProfile', { profileId }) },
}
const panel = ref<SafeAiCliPanelHandle | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const backend = useBackend()
let cancelResumeWait: (() => void) | undefined
function beforeResume(): Promise<void> {
  if (backend.status.value === 'connected') return Promise.resolve()
  return new Promise(resolve => {
    const stop = watch(backend.status, value => {
      if (value === 'connected') { stop(); cancelResumeWait = undefined; resolve() }
    })
    cancelResumeWait = () => { stop(); resolve() }
  })
}
const width = ref(Math.max(280, Math.min(600, Number(settingsGet(props.widthKey, String(props.defaultWidth))))))
const status = computed(() => panel.value?.status ?? 'idle')
const active = computed(() => status.value === 'starting' || status.value === 'running')
const workspaceName = computed(() => props.workspacePath.split('/').filter(Boolean).pop() ?? '')
const profileLabel = computed(() => panel.value?.profiles.find(profile => profile.id === panel.value?.profileId)?.label ?? panel.value?.profileId ?? '')
let resizeAnchorX = 0
function resize(event: MouseEvent): void { width.value = Math.max(280, Math.min(600, resizeAnchorX - event.clientX)) }
function finishResize(): void {
  settingsSet(props.widthKey, String(width.value))
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', finishResize)
}
function beginResize(): void {
  resizeAnchorX = panelRef.value?.getBoundingClientRect().right || window.innerWidth
  document.addEventListener('mousemove', resize)
  document.addEventListener('mouseup', finishResize)
}
onUnmounted(() => {
  cancelResumeWait?.()
  document.removeEventListener('mousemove', resize)
  document.removeEventListener('mouseup', finishResize)
})
function toggle(): void { open.value = !open.value }
defineExpose({
  get terminal() { return panel.value },
  start: () => panel.value?.start(),
  stop: () => panel.value?.stop(),
  interrupt: () => panel.value?.interrupt(),
  pasteText: (text: string) => panel.value?.pasteText(text),
  injectNow: () => panel.value?.injectNow(),
  toggle,
})
</script>

<template>
  <div class="ai-dock-rail">
    <button class="ai-dock-rail-btn" :class="{ active: open }" :title="t('pane.ai-terminal.title')" @click="toggle">
      <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z" /></svg>
    </button>
  </div>
  <div v-show="open" class="ai-dock-resize-handle" @mousedown.prevent="beginResize" />
  <div v-show="open" ref="panelRef" class="ai-dock-panel" :style="{ width: width + 'px' }">
    <div class="ai-cli-head">
      <span class="ai-cli-title">{{ t('pane.ai-terminal.title') }}</span>
      <span v-if="workspacePath" class="ai-cli-ws" v-truncate :title="workspacePath">{{ workspaceName }}</span>
    </div>
    <div v-if="!active" class="ai-cli-controls">
      <select class="ai-cli-agent-select" :value="panel?.profileId" @change="panel?.selectProfile(($event.target as HTMLSelectElement).value)">
        <option v-for="profile in panel?.profiles ?? []" :key="profile.id" :value="profile.id">{{ profile.label }}</option>
      </select>
      <button class="ai-cli-btn primary" :disabled="!workspacePath || !panel || panel.initializing || backend.status.value !== 'connected'" @click="panel?.start()">{{ panel?.initializing ? 'Reattaching…' : 'Start' }}</button>
    </div>
    <div v-else class="ai-cli-controls">
      <span class="ai-cli-running-label" v-truncate>{{ profileLabel }}</span>
      <button class="ai-cli-btn ghost" title="Send Ctrl+C to the CLI" @click="panel?.interrupt()">Interrupt</button>
      <button class="ai-cli-btn danger" title="Kill the CLI process" @click="panel?.stop()">Stop</button>
    </div>
    <p v-if="!workspacePath" class="ai-cli-empty">No workspace available</p>
    <SafeAiCliPanel v-if="workspacePath" :key="paneId" ref="panel" v-model:open="open" embedded allow-cancel-start wait-for-startup-output :inject-quiet-ms="2000" :inject-timeout-ms="12000" :controller="controller" :terminal-view="terminalView" :terminal-resources="terminalResources" :workspace-path="workspacePath" :before-resume="beforeResume" :profile-preference="profilePreference" :width-key="widthKey" :default-width="defaultWidth" :build-context="buildContext" class="ai-cli-term" />
  </div>
</template>

<style scoped>
.ai-dock-rail {
  align-items: center;
  background: var(--bg-subtle);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding-top: 8px;
  width: 34px;
}

.ai-dock-rail-btn {
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 5px;
}

.ai-dock-rail-btn:hover {
  color: var(--text-bright);
}

.ai-dock-rail-btn.active {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}

.ai-dock-resize-handle {
  background: transparent;
  border-left: 1px solid var(--border-muted);
  cursor: col-resize;
  flex-shrink: 0;
  transition: background 0.15s;
  width: 4px;
}

.ai-dock-resize-handle:hover {
  background: var(--accent-emphasis);
}

.ai-dock-panel {
  background: var(--bg-base);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  max-width: 600px;
  min-width: 280px;
  overflow: hidden;
}

.ai-cli-head {
  align-items: center;
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  padding: 8px 10px 4px;
}

.ai-cli-title {
  font-size: var(--font-xs);
  font-weight: 600;
}

.ai-cli-ws {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-cli-controls {
  align-items: center;
  border-bottom: 1px solid var(--border-muted);
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  padding: 4px 10px 8px;
}

.ai-cli-agent-select {
  flex: 1;
  font-size: var(--font-xs);
  min-width: 0;
  padding: 5px 8px;
}

/* Self-contained button styling: host windows style bare <button> elements in
   their own scoped CSS, which does not reach into this component. */
.ai-cli-btn {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-bright);
  cursor: pointer;
  flex-shrink: 0;
  font-size: var(--font-2xs);
  padding: 5px 10px;
}

.ai-cli-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ai-cli-btn.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}

.ai-cli-btn.primary:not(:disabled):hover {
  background: var(--success-strong);
}

.ai-cli-btn.ghost {
  background: transparent;
}

.ai-cli-btn.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}

.ai-cli-btn.danger {
  background: var(--danger-deep);
  border-color: var(--danger-muted);
  color: var(--text-on-emphasis);
}

.ai-cli-btn.danger:hover {
  background: var(--danger-muted);
}

.ai-cli-running-label {
  flex: 1;
  font-size: var(--font-xs);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-cli-empty {
  color: var(--text-muted);
  flex-shrink: 0;
  font-size: var(--font-xs);
  margin: 0;
  padding: 12px;
}

.ai-cli-term {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
</style>
