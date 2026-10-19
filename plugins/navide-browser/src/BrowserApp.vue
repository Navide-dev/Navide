<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { errorCode, onWebChanged, openBrowserWindow, web } from './backend'
import { normalizeAddress, pendingCount, sortSpaces, stateLabelKey, type WebViewInfo } from './spaces'

const THUMBNAIL_WIDTH = 480
const THUMBNAIL_REFRESH_MS = 5000

const { t } = useI18n()
const isLeft = new URLSearchParams(window.location.search).get('contribution') === 'left'

const views = ref<WebViewInfo[]>([])
const thumbnails = ref<Record<string, string>>({})
const selectedId = ref<string | null>(null)
const address = ref('')
const error = ref('')
const showSettings = ref(false)
const confirmClear = ref(false)
const notice = ref('')
const viewport = ref<HTMLElement | null>(null)

const spaces = computed(() => sortSpaces(views.value))
const pending = computed(() => pendingCount(views.value))
const selected = computed(() => views.value.find((view) => view.viewId === selectedId.value) ?? null)

function fail(cause: unknown): void {
  error.value = t('browser.errors.generic', { code: errorCode(cause) })
}

async function run(action: () => Promise<unknown>): Promise<void> {
  error.value = ''
  try {
    await action()
  } catch (cause) {
    fail(cause)
  }
}

function applyViews(next: WebViewInfo[]): void {
  views.value = next
  if (selectedId.value && !next.some((view) => view.viewId === selectedId.value)) selectedId.value = null
  for (const id of Object.keys(thumbnails.value)) {
    if (!next.some((view) => view.viewId === id)) delete thumbnails.value[id]
  }
}

async function refresh(): Promise<void> {
  await run(async () => applyViews(await web.list()))
}

async function refreshThumbnails(): Promise<void> {
  if (isLeft || selectedId.value) return
  for (const view of views.value) {
    try {
      const dataUrl = await web.capture(view.viewId, THUMBNAIL_WIDTH)
      if (dataUrl) thumbnails.value[view.viewId] = dataUrl
    } catch {
      // A view that is still loading or just closed keeps its last thumbnail.
    }
  }
}

async function createSpace(): Promise<void> {
  await run(async () => {
    const mine = views.value.filter((view) => view.owner === 'user').length
    const viewId = await web.create(t('browser.space.default-name', { n: mine + 1 }))
    applyViews(await web.list())
    selectedId.value = viewId
  })
}

function openSpace(view: WebViewInfo): void {
  selectedId.value = view.viewId
}

async function backToOverview(): Promise<void> {
  const id = selectedId.value
  selectedId.value = null
  if (id) await run(() => web.detach(id))
  void refreshThumbnails()
}

async function go(): Promise<void> {
  const view = selected.value
  if (!view) return
  const url = normalizeAddress(address.value)
  if (!url) {
    error.value = t('browser.errors.invalid-address')
    return
  }
  await run(() => web.navigate(view.viewId, { url }))
}

function navigate(action: 'back' | 'forward' | 'reload' | 'stop'): void {
  const view = selected.value
  if (view) void run(() => web.navigate(view.viewId, { action }))
}

function takeOver(): void {
  const view = selected.value
  if (view) void run(() => web.takeControl(view.viewId))
}

function handBack(): void {
  const view = selected.value
  if (view) void run(() => web.returnControl(view.viewId))
}

function setOwner(owner: 'agent' | 'user'): void {
  const view = selected.value
  if (view) void run(() => web.setOwner(view.viewId, owner))
}

function closeSpace(): void {
  const view = selected.value
  if (!view) return
  selectedId.value = null
  void run(() => web.close(view.viewId))
}

async function clearData(): Promise<void> {
  if (!confirmClear.value) {
    confirmClear.value = true
    return
  }
  confirmClear.value = false
  await run(async () => {
    await web.clearData()
    notice.value = t('browser.settings.clear-data-done')
  })
}

// Keep the Host view over the content rectangle while a Space is open.
let resizeObserver: ResizeObserver | null = null
let attachedId: string | null = null

function reportRect(): void {
  const element = viewport.value
  const view = selected.value
  if (!element || !view) return
  const box = element.getBoundingClientRect()
  attachedId = view.viewId
  void run(() => web.attach(view.viewId, {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.max(0, Math.round(box.width)),
    height: Math.max(0, Math.round(box.height)),
  }))
}

watch(selectedId, async (id, previous) => {
  resizeObserver?.disconnect()
  if (previous && previous === attachedId && previous !== id) {
    attachedId = null
    void run(() => web.detach(previous))
  }
  if (!id) return
  address.value = selected.value?.url ?? ''
  await nextTick()
  if (!viewport.value) return
  resizeObserver = new ResizeObserver(reportRect)
  resizeObserver.observe(viewport.value)
  reportRect()
})

watch(() => selected.value?.url, (url) => {
  if (url !== undefined && document.activeElement?.id !== 'browser-address') address.value = url
})

let unsubscribe: (() => void) | null = null
let thumbnailTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  unsubscribe = onWebChanged(applyViews)
  void refresh().then(refreshThumbnails)
  if (!isLeft) thumbnailTimer = setInterval(() => void refreshThumbnails(), THUMBNAIL_REFRESH_MS)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  resizeObserver?.disconnect()
  if (thumbnailTimer) clearInterval(thumbnailTimer)
  if (attachedId) void web.detach(attachedId).catch(() => undefined)
})
</script>

<template>
  <div v-if="isLeft" class="browser-left">
    <header class="left-header">
      <span class="title">{{ t('browser.app.title') }}</span>
      <span v-if="pending > 0" class="pending-badge" :title="t('browser.overview.pending', { count: pending })">{{ pending }}</span>
    </header>
    <button type="button" class="primary" @click="run(openBrowserWindow)">{{ t('browser.left.open') }}</button>
    <p v-if="spaces.length === 0" class="muted">{{ t('browser.left.empty') }}</p>
    <ul class="left-list">
      <li v-for="view in spaces" :key="view.viewId" :class="{ agent: view.owner === 'agent' }" @click="run(openBrowserWindow)">
        <span v-if="view.owner === 'user'" class="pin" :title="t('browser.space.yours')">📌</span>
        <span class="name">{{ view.space || view.title || view.url }}</span>
        <span class="chip" :class="`state-${view.state}`">{{ t(stateLabelKey(view.state)) }}</span>
      </li>
    </ul>
    <p v-if="error" class="error">{{ error }}</p>
  </div>

  <div v-else-if="selected" class="browser-space">
    <header class="toolbar">
      <button type="button" class="ghost" @click="backToOverview">‹ {{ t('browser.space.all') }}</button>
      <button type="button" class="icon" :title="t('browser.nav.back')" @click="navigate('back')">←</button>
      <button type="button" class="icon" :title="t('browser.nav.forward')" @click="navigate('forward')">→</button>
      <button
        type="button"
        class="icon"
        :title="selected.loading ? t('browser.nav.stop') : t('browser.nav.reload')"
        @click="navigate(selected.loading ? 'stop' : 'reload')"
      >{{ selected.loading ? '✕' : '↻' }}</button>
      <form class="address" @submit.prevent="go">
        <input id="browser-address" v-model="address" :placeholder="t('browser.nav.address')" spellcheck="false" autocomplete="off" />
      </form>
    </header>
    <div class="status" :class="selected.control === 'agent' ? 'is-agent' : 'is-user'">
      <span class="status-text">
        {{ selected.owner === 'user' ? t('browser.control.yours') : selected.control === 'agent' ? t('browser.control.agent') : t('browser.control.user') }}
      </span>
      <span class="chip" :class="`state-${selected.state}`">{{ t(stateLabelKey(selected.state)) }}</span>
      <span v-if="selected.note" class="note">{{ selected.note }}</span>
      <span class="spacer" />
      <button v-if="selected.owner === 'agent' && selected.control === 'agent'" type="button" @click="takeOver">{{ t('browser.action.take-over') }}</button>
      <button v-if="selected.owner === 'agent' && selected.control === 'user'" type="button" class="primary" @click="handBack">{{ t('browser.action.hand-back') }}</button>
      <button v-if="selected.owner === 'user'" type="button" @click="setOwner('agent')">{{ t('browser.action.delegate') }}</button>
      <button v-else type="button" class="ghost" @click="setOwner('user')">{{ t('browser.action.reclaim') }}</button>
      <button type="button" class="ghost" @click="closeSpace">{{ t('browser.action.close') }}</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <div ref="viewport" class="viewport" :class="{ 'agent-frame': selected.owner === 'agent' }" />
  </div>

  <div v-else class="browser-overview">
    <header class="overview-header">
      <h1>{{ t('browser.overview.title') }}</h1>
      <span v-if="pending > 0" class="pending-badge">{{ t('browser.overview.pending', { count: pending }) }}</span>
      <span class="spacer" />
      <button type="button" class="ghost" @click="showSettings = !showSettings">{{ t('browser.settings.title') }}</button>
    </header>
    <section v-if="showSettings" class="settings">
      <p class="muted">{{ t('browser.settings.shared-sign-in') }}</p>
      <button type="button" class="danger" @click="clearData">
        {{ confirmClear ? t('browser.settings.clear-data-confirm') : t('browser.settings.clear-data') }}
      </button>
      <button v-if="confirmClear" type="button" class="ghost" @click="confirmClear = false">{{ t('browser.settings.cancel') }}</button>
      <p v-if="notice" class="muted">{{ notice }}</p>
    </section>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="grid">
      <button
        v-for="view in spaces"
        :key="view.viewId"
        type="button"
        class="card"
        :class="{ 'agent-frame': view.owner === 'agent', 'need-action': view.state === 'need-action' }"
        @click="openSpace(view)"
      >
        <div class="thumb">
          <img v-if="thumbnails[view.viewId]" :src="thumbnails[view.viewId]" alt="" />
          <span v-else class="thumb-empty">{{ view.title || view.url || '…' }}</span>
          <span v-if="view.owner === 'user'" class="pin" :title="t('browser.space.yours')">📌</span>
        </div>
        <div class="card-body">
          <span class="chip" :class="`state-${view.state}`">{{ t(stateLabelKey(view.state)) }}</span>
          <span class="name">{{ view.space || view.title }}</span>
          <span class="owner">{{ view.owner === 'agent' ? t('browser.owner.agent') : t('browser.owner.user') }}</span>
          <span v-if="view.note" class="note">{{ view.note }}</span>
        </div>
      </button>
      <button type="button" class="card new-card" :title="t('browser.overview.new')" @click="createSpace">
        <span class="plus">＋</span>
        <span>{{ t('browser.overview.new') }}</span>
      </button>
    </div>
    <p v-if="spaces.length === 0" class="muted">{{ t('browser.overview.empty') }}</p>
  </div>
</template>

<style scoped>
button {
  font: inherit;
  font-size: var(--font-xs);
  color: var(--text-primary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
}
button:hover { background: var(--bg-hover); }
button.primary { background: var(--accent-color); border-color: var(--accent-color); color: #fff; }
button.ghost { background: transparent; border-color: transparent; color: var(--text-secondary); }
button.danger { color: var(--danger-fg); border-color: var(--danger-fg); background: transparent; }
button.icon { width: 28px; padding: 4px 0; }
.spacer { flex: 1; }
.muted { color: var(--text-muted); font-size: var(--font-xs); }
.error { color: var(--text-danger); font-size: var(--font-xs); margin: 4px 12px; }
.chip {
  font-size: var(--font-2xs);
  border-radius: 999px;
  padding: 1px 8px;
  background: var(--bg-muted);
  color: var(--text-secondary);
  white-space: nowrap;
}
.chip.state-running { background: var(--accent-color); color: #fff; }
.chip.state-need-action { background: var(--attention-subtle); color: var(--attention-bright); }
.chip.state-done { background: var(--bg-muted); color: var(--success-fg); }
.agent-frame { box-shadow: 0 0 0 2px var(--accent-color), 0 0 12px var(--accent-color); }
.pending-badge {
  background: var(--attention-subtle);
  color: var(--attention-bright);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: var(--font-2xs);
}

.browser-overview { height: 100%; overflow: auto; padding: 16px; box-sizing: border-box; }
.overview-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.overview-header h1 { font-size: var(--font-sm); margin: 0; }
.settings { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.settings .muted { flex-basis: 100%; margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.card {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  text-align: left;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
}
.card.need-action { border-color: var(--attention-bright); }
.thumb { position: relative; aspect-ratio: 16 / 10; background: var(--bg-base); display: flex; align-items: center; justify-content: center; }
.thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top; }
.thumb-empty { color: var(--text-muted); font-size: var(--font-2xs); padding: 8px; overflow: hidden; text-overflow: ellipsis; }
.thumb .pin { position: absolute; top: 6px; left: 6px; }
.card-body { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; }
.card-body .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.card-body .owner, .card-body .note { color: var(--text-muted); font-size: var(--font-2xs); }
.card-body .note { flex-basis: 100%; }
.new-card { align-items: center; justify-content: center; min-height: 160px; color: var(--text-muted); border-style: dashed; gap: 4px; }
.new-card .plus { font-size: 28px; }

.browser-space { display: flex; flex-direction: column; height: 100%; }
.toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); }
.address { flex: 1; display: flex; }
.address input {
  flex: 1;
  font: inherit;
  font-size: var(--font-xs);
  color: var(--text-primary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 5px 10px;
}
.address input:focus { outline: none; border-color: var(--accent-focus); }
.status { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: var(--font-xs); border-bottom: 1px solid var(--border-subtle); }
.status.is-agent { background: var(--bg-muted); }
.status.is-user { background: var(--bg-subtle); }
.status .note { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.viewport { flex: 1; min-height: 0; margin: 6px; border-radius: 6px; background: var(--bg-base); }

.browser-left { display: flex; flex-direction: column; gap: 8px; padding: 10px; height: 100%; box-sizing: border-box; overflow: auto; }
.left-header { display: flex; align-items: center; gap: 8px; }
.left-header .title { font-weight: 600; font-size: var(--font-xs); flex: 1; }
.left-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.left-list li { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-size: var(--font-xs); }
.left-list li:hover { background: var(--bg-hover); }
.left-list li.agent .name { color: var(--text-secondary); }
.left-list .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
