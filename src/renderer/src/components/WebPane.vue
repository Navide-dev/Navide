<script setup lang="ts">
// A web pane: an agent's official website in a pane frame (src/shared/
// webPaneSites.ts). The page runs in a <webview> on the site's own persistent
// partition; main (webPaneGuests.ts) sandboxes it, keeps its window.open
// in-pane for the site's own domains, and sends everything else to the system
// browser. The user signs in on the page themselves — Navide types nothing
// into it, reads nothing out of it, and leaves its user agent alone.
//
// App.vue decides whether the <webview> is loaded (lib/webPaneHost.ts); an
// unloaded pane keeps its frame and asks to be clicked back.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { vTruncate, i18n } from '@navide/plugin-ui/foundation'
import { writeCliPaneDragPayload } from '@navide/terminal'
import { isWebPaneSameSite, webPanePartition, type WebPaneSite } from '../../../shared/webPaneSites'
import { isCloudflareChallenge, isGoogleSignInUrl, webPaneLoginState } from '../lib/webPaneHost'
import { setBatchDragImage } from '../lib/batchDragImage'

interface Props {
  paneId: string
  title: string
  site: WebPaneSite
  loaded: boolean
  isFocus?: boolean
  workspacePath?: string
  selectionBatchIds?: string[]
}
const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'set-focus', ev?: MouseEvent): void
  (e: 'context-menu', ev: MouseEvent): void
  (e: 'activate'): void
  (e: 'reorder-drop', draggedId: string): void
}>()

type WebviewEl = HTMLElement & {
  reload(): void
  loadURL(url: string): Promise<void>
  getWebContentsId(): number
}

const view = ref<WebviewEl | null>(null)
const url = ref(props.site.url)
const pageTitle = ref('')
const memoryMb = ref<number | null>(null)
const confirmClear = ref(false)

// Reloaded on the page it was on, when that page is still on the site.
const src = ref(props.site.url)
watch(() => props.loaded, (loaded) => {
  if (loaded) src.value = isWebPaneSameSite(props.site, url.value) ? url.value : props.site.url
  else memoryMb.value = null
})

const loginState = computed(() => webPaneLoginState(props.site, url.value))
const stateLabel = computed(() => {
  if (!props.loaded) return i18n.global.t('pane.web.unloaded')
  return loginState.value === 'signed-in' ? i18n.global.t('pane.web.signed-in') : i18n.global.t('pane.web.signed-out')
})
const host = computed(() => {
  try {
    const u = new URL(url.value)
    return u.hostname + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return url.value
  }
})
const googleHint = computed(() => props.loaded && isGoogleSignInUrl(url.value))
const cloudflareHint = computed(() => props.loaded && isCloudflareChallenge(pageTitle.value, url.value))

function onNavigate(ev: Event): void {
  const next = (ev as Event & { url?: string }).url
  if (next) url.value = next
}
function onTitle(ev: Event): void {
  pageTitle.value = (ev as Event & { title?: string }).title ?? ''
}

// The guest's renderer memory, refreshed while loaded.
let memoryTimer: ReturnType<typeof setInterval> | null = null
async function readMemory(): Promise<void> {
  const el = view.value
  const api = window.agentTeam?.webPane
  if (!el || !api) return
  try {
    const id = el.getWebContentsId()
    const out = await api.memory([id])
    memoryMb.value = out[String(id)] ?? null
  } catch {
    memoryMb.value = null
  }
}
function onDomReady(): void {
  void readMemory()
  if (!memoryTimer) memoryTimer = setInterval(() => void readMemory(), 5000)
}
watch(() => props.loaded, (loaded) => {
  if (!loaded && memoryTimer) {
    clearInterval(memoryTimer)
    memoryTimer = null
  }
})
onBeforeUnmount(() => {
  if (memoryTimer) clearInterval(memoryTimer)
})

function reload(): void {
  if (props.loaded) view.value?.reload()
  else emit('activate')
}
function openInBrowser(): void {
  void window.agentTeam?.openExternal?.(url.value)
}
async function clearSite(): Promise<void> {
  if (!confirmClear.value) {
    confirmClear.value = true
    setTimeout(() => { confirmClear.value = false }, 4000)
    return
  }
  confirmClear.value = false
  await window.agentTeam?.webPane?.clearData(props.site.id)
  url.value = props.site.url
  if (props.loaded) void view.value?.loadURL(props.site.url)
}

// Header drag: the same pane-id payload a CLI pane's header carries, so tabs
// and other headers treat it as any pane; dropping a header here reorders.
const dragOver = ref(false)
let draggingSelf = false
function batch(): string[] {
  const ids = props.selectionBatchIds ?? []
  return ids.includes(props.paneId) ? ids : [props.paneId]
}
function onDragStart(e: DragEvent): void {
  if (!e.dataTransfer) return
  const ids = batch()
  writeCliPaneDragPayload(e.dataTransfer, {
    paneId: props.paneId,
    agentKey: '',
    label: props.title,
    sessionId: null,
    sessionHomeId: '',
    workspacePath: props.workspacePath ?? '',
    conversationLogPath: '',
  }, ids)
  setBatchDragImage(e.dataTransfer, ids.length, i18n.global.t('action.dragging-panes', { count: ids.length }))
  e.dataTransfer.effectAllowed = 'move'
  draggingSelf = true
}
function onDragEnd(): void {
  draggingSelf = false
  dragOver.value = false
}
function onDragOver(e: DragEvent): void {
  if (draggingSelf || !e.dataTransfer?.types.includes('application/x-pane-id')) return
  e.preventDefault()
  dragOver.value = true
}
function onDrop(e: DragEvent): void {
  dragOver.value = false
  const draggedId = e.dataTransfer?.getData('application/x-pane-id') || ''
  if (draggedId && draggedId !== props.paneId) emit('reorder-drop', draggedId)
}
</script>

<template>
  <div
    class="web-pane"
    :class="{ focused: isFocus }"
    data-testid="web-pane"
    @mousedown.left="emit('set-focus', $event)"
    @contextmenu.prevent="emit('context-menu', $event)"
  >
    <header
      class="web-header"
      :class="{ 'drag-over': dragOver }"
      draggable="true"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
      @dragover="onDragOver"
      @dragenter="onDragOver"
      @dragleave="dragOver = false"
      @drop="onDrop"
    >
      <span v-truncate class="web-title">{{ title }}</span>
      <span v-truncate class="web-url" :title="url">{{ host }}</span>
      <span class="web-state" :data-state="loaded ? loginState : 'unloaded'" data-testid="web-pane-state">{{ stateLabel }}</span>
      <span v-if="loaded && memoryMb !== null" class="web-mem" data-testid="web-pane-memory">{{ $t('pane.web.memory', { mb: memoryMb }) }}</span>
      <button type="button" class="web-btn" :title="$t('pane.web.reload')" @mousedown.stop @click="reload">↻</button>
      <button type="button" class="web-btn" :title="$t('pane.web.open-browser')" @mousedown.stop @click="openInBrowser">↗</button>
      <button
        type="button"
        class="web-btn"
        :class="{ armed: confirmClear }"
        data-testid="web-pane-clear"
        :title="confirmClear ? $t('pane.web.clear-confirm') : $t('pane.web.clear')"
        @mousedown.stop
        @click="clearSite"
      >{{ confirmClear ? $t('pane.web.clear-confirm-short') : '⎋' }}</button>
    </header>
    <div v-if="googleHint" class="web-hint" data-testid="web-pane-google-hint">
      <span>{{ $t('pane.web.google-hint') }}</span>
      <button type="button" class="web-hint-btn" @mousedown.stop @click="openInBrowser">{{ $t('pane.web.open-browser') }}</button>
    </div>
    <div v-else-if="cloudflareHint" class="web-hint" data-testid="web-pane-cloudflare-hint">
      <span>{{ $t('pane.web.cloudflare-hint') }}</span>
    </div>
    <div class="web-body">
      <webview
        v-if="loaded"
        ref="view"
        class="web-view"
        :src="src"
        :partition="webPanePartition(site.id)"
        allowpopups
        @did-navigate="onNavigate"
        @did-navigate-in-page="onNavigate"
        @page-title-updated="onTitle"
        @dom-ready="onDomReady"
        @focus="emit('set-focus')"
      />
      <button v-else type="button" class="web-unloaded" data-testid="web-pane-unloaded" @click="emit('activate')">
        <strong>{{ $t('pane.web.unloaded-title') }}</strong>
        <span>{{ $t('pane.web.unloaded-hint') }}</span>
      </button>
    </div>
    <footer v-if="loaded && loginState === 'signed-out'" class="web-foot">{{ $t('pane.web.privacy') }}</footer>
  </div>
</template>

<style scoped>
.web-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  overflow: hidden;
}
.web-pane.focused { border-color: var(--accent-focus); }
.web-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-elevated);
  font-size: var(--font-xs);
  cursor: grab;
}
.web-header.drag-over { outline: 1px dashed var(--accent-focus); outline-offset: -2px; }
.web-title { flex: 0 1 auto; min-width: 0; font-weight: 600; color: var(--text-primary); }
.web-url { flex: 1; min-width: 0; color: var(--text-muted); font-family: var(--font-mono); }
.web-state, .web-mem {
  padding: 0 5px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  white-space: nowrap;
}
.web-state[data-state='signed-in'] { color: var(--success-fg); }
.web-btn {
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}
.web-btn:hover { border-color: var(--border-default); color: var(--text-primary); }
.web-btn.armed { border-color: var(--danger-fg); color: var(--danger-fg); }
.web-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.web-hint span { flex: 1; min-width: 0; }
.web-hint-btn {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.web-body { position: relative; flex: 1; min-height: 0; display: flex; }
.web-view { flex: 1; width: 100%; height: 100%; display: flex; }
.web-unloaded {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  background: var(--bg-base);
  color: var(--text-muted);
  font-size: var(--font-sm);
  cursor: pointer;
}
.web-unloaded strong { color: var(--text-secondary); }
.web-foot {
  padding: 3px 8px;
  border-top: 1px solid var(--border-muted);
  color: var(--text-muted);
  font-size: var(--font-xs);
}
</style>
