<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { createPluginViewState } from '@navide/plugin-sdk'
import {
  defaults as navideKeybindings,
  gridPageCount,
  gridPageSlice,
  gridPresetDims,
  KeyResolver,
  planPaneCycle,
} from '@navide/plugin-ui/shared'
import { errorCode, onWebChanged, openBrowserWindow, web, type WebRect } from './backend'
import {
  activeTabId,
  cycleDirection,
  groupSpaces,
  keptPages,
  MAX_TILES,
  mayDiscard,
  normalizeAddress,
  parseLayoutMode,
  pendingCount,
  showsAgentScriptWarning,
  spaceUploads,
  stateLabelKey,
  tileGrid,
  type BrowserSpace,
  type DiscardedTab,
  type LayoutMode,
  type WebViewInfo,
} from './spaces'

const THUMBNAIL_WIDTH = 480
const DISCARD_SWEEP_MS = 60_000

const { t } = useI18n()
const isLeft = new URLSearchParams(window.location.search).get('contribution') === 'left'

const views = ref<WebViewInfo[]>([])
const discarded = ref<DiscardedTab[]>([])
const thumbnails = ref<Record<string, string>>({})
/** The tab each Space shows, by Space key (a viewId or a discarded tab id). */
const activeTabs = ref<Record<string, string>>({})
const focusedKey = ref<string | null>(null)
const mode = ref<LayoutMode>('tiled')
const page = ref(0)
const error = ref('')
const showSettings = ref(false)
const confirmClear = ref(false)
const notice = ref('')
const stage = ref<HTMLElement | null>(null)
/** Pages the user chose to keep despite the agent-script warning. */
const kept = ref<Set<string>>(new Set())

const layoutState = createPluginViewState<string>('browser-layout-mode', 'tiled')

const spaces = computed(() => groupSpaces(views.value, discarded.value))
const pending = computed(() => pendingCount(views.value))
const preset = computed(() => (spaces.value.length > MAX_TILES ? '3x3' : 'auto'))
const pageCount = computed(() => gridPageCount(spaces.value.length, preset.value))
const focusedSpace = computed(() => spaces.value.find((space) => space.key === focusedKey.value) ?? spaces.value[0] ?? null)
const visibleSpaces = computed<BrowserSpace[]>(() => {
  if (mode.value === 'switch') return focusedSpace.value ? [focusedSpace.value] : []
  return gridPageSlice(spaces.value, preset.value, page.value)
})
const gridStyle = computed(() => {
  if (mode.value === 'switch') return {}
  const { cols, rows } = tileGrid(visibleSpaces.value.length)
  return {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
  }
})

function activeId(space: BrowserSpace): string | null {
  return activeTabId(space, activeTabs.value[space.key])
}

function activeView(space: BrowserSpace): WebViewInfo | null {
  const id = activeId(space)
  return space.tabs.find((tab) => tab.viewId === id) ?? null
}

function activeDiscarded(space: BrowserSpace): DiscardedTab | null {
  const id = activeId(space)
  return space.discarded.find((tab) => tab.id === id) ?? null
}

function tabLabel(tab: { title: string; url: string }): string {
  return tab.title || tab.url || t('browser.tab.untitled')
}

function spaceDialog(space: BrowserSpace): WebViewInfo | null {
  return space.tabs.find((tab) => tab.dialog) ?? null
}

function hasSensitiveUpload(space: BrowserSpace): boolean {
  return spaceUploads(space).some((upload) => upload.sensitive)
}

function uploadTime(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString()
}

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
  const previous = new Set(views.value.map((view) => view.viewId))
  views.value = next
  kept.value = keptPages(next, kept.value)
  const live = new Set(next.map((view) => view.viewId))
  for (const id of Object.keys(thumbnails.value)) {
    if (!live.has(id)) delete thumbnails.value[id]
  }
  for (const id of [...attached]) {
    if (!live.has(id)) forgetAttachment(id)
  }
  // A page a tab opened shows next to it, and in front when its opener is showing.
  for (const view of next) {
    if (previous.size === 0 || previous.has(view.viewId) || !view.openerViewId) continue
    const space = spaces.value.find((item) => item.tabs.some((tab) => tab.viewId === view.viewId))
    if (space && activeId(space) === view.openerViewId) activeTabs.value = { ...activeTabs.value, [space.key]: view.viewId }
  }
  scheduleSync()
}

async function refresh(): Promise<void> {
  await run(async () => applyViews(await web.list()))
}

// ---------------------------------------------------------------------------
// Spaces and tabs
// ---------------------------------------------------------------------------

async function createSpace(): Promise<void> {
  await run(async () => {
    const mine = spaces.value.filter((space) => space.owner === 'user').length
    const name = t('browser.space.default-name', { n: mine + 1 })
    const viewId = await web.create(name)
    applyViews(await web.list())
    const space = spaces.value.find((item) => item.tabs.some((tab) => tab.viewId === viewId))
    if (space) focusSpace(space)
  })
}

function focusSpace(space: BrowserSpace): void {
  focusedKey.value = space.key
}

async function selectTab(space: BrowserSpace, id: string): Promise<void> {
  focusSpace(space)
  activeTabs.value = { ...activeTabs.value, [space.key]: id }
  const gone = space.discarded.find((tab) => tab.id === id)
  if (gone) await restoreTab(space, gone)
}

async function newTab(space: BrowserSpace): Promise<void> {
  await run(async () => {
    const viewId = await web.create(space.name)
    activeTabs.value = { ...activeTabs.value, [space.key]: viewId }
    applyViews(await web.list())
  })
}

async function closeTab(space: BrowserSpace, id: string): Promise<void> {
  const gone = space.discarded.find((tab) => tab.id === id)
  if (gone) {
    discarded.value = discarded.value.filter((tab) => tab.id !== id)
    return
  }
  await run(() => web.close(id))
}

async function closeSpace(space: BrowserSpace): Promise<void> {
  discarded.value = discarded.value.filter((tab) => !space.discarded.includes(tab))
  await run(async () => {
    for (const tab of space.tabs) await web.close(tab.viewId)
  })
}

/** Load a discarded tab again from its URL: a new Host view in its Space. */
async function restoreTab(space: BrowserSpace, tab: DiscardedTab): Promise<void> {
  await run(async () => {
    const viewId = await web.create(space.name || tab.space, /^https?:\/\//i.test(tab.url) ? tab.url : undefined)
    discarded.value = discarded.value.filter((item) => item.id !== tab.id)
    activeTabs.value = { ...activeTabs.value, [space.key]: viewId }
    applyViews(await web.list())
  })
}

// ---------------------------------------------------------------------------
// Per-tab actions (the Space's active tab)
// ---------------------------------------------------------------------------

async function go(view: WebViewInfo, event: Event): Promise<void> {
  const form = event.target as HTMLFormElement
  const input = form.elements.namedItem('address') as HTMLInputElement | null
  const url = normalizeAddress(input?.value ?? '')
  if (!url) {
    error.value = t('browser.errors.invalid-address')
    return
  }
  await run(() => web.navigate(view.viewId, { url }))
}

function navigate(view: WebViewInfo, action: 'back' | 'forward' | 'reload' | 'stop'): void {
  void run(() => web.navigate(view.viewId, { action }))
}

function keepPage(view: WebViewInfo): void {
  kept.value = new Set([...kept.value, view.viewId])
}

function takeOver(view: WebViewInfo): void {
  void run(() => web.takeControl(view.viewId))
}

function handBack(view: WebViewInfo): void {
  void run(() => web.returnControl(view.viewId))
}

function setOwner(view: WebViewInfo, owner: 'agent' | 'user'): void {
  void run(() => web.setOwner(view.viewId, owner))
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

// ---------------------------------------------------------------------------
// Layout: tiled (MAIN) and one at a time (SWITCH)
// ---------------------------------------------------------------------------

function setMode(next: LayoutMode): void {
  mode.value = next
  layoutState.save(next)
}

function setPage(next: number): void {
  page.value = Math.min(Math.max(0, next), pageCount.value - 1)
  const first = visibleSpaces.value[0]
  if (first && !visibleSpaces.value.some((space) => space.key === focusedKey.value)) focusSpace(first)
}

// The plugin view gets no Host keybinding service, so it reads Navide's own
// default chords for pane cycling (Ctrl+Tab / Ctrl+Shift+Tab) through the
// shared KeyResolver. User rebinds of those commands are not visible here,
// and keys typed while a page has focus go to the page, not to this view.
const cycleKeys = new KeyResolver(navideKeybindings.filter((rule) => cycleDirection(rule.command) !== 0))

function onKeydown(event: KeyboardEvent): void {
  const direction = cycleDirection(cycleKeys.resolve(event, { paneStage: true, modalOpen: false })?.command)
  if (direction === 0 || spaces.value.length === 0) return
  event.preventDefault()
  const plan = planPaneCycle({
    orderedIds: spaces.value.map((space) => space.key),
    currentId: focusedSpace.value?.key ?? null,
    direction,
    gridDims: mode.value === 'tiled' ? gridPresetDims(preset.value) : null,
    currentPage: page.value,
  })
  if (!plan) return
  focusedKey.value = plan.targetId
  if (plan.page !== null) page.value = plan.page
}

// ---------------------------------------------------------------------------
// Host views over the tiles. Native views paint over the DOM, so each one
// sits exactly on its tile's viewport, with DOM gaps between tiles.
// ---------------------------------------------------------------------------

const viewports = new Map<string, HTMLElement>()
const attached = new Set<string>()
const attachedRects = new Map<string, string>()
/** When each tab was last on screen; a tab out of sight long enough is discarded. */
const lastShown = new Map<string, number>()
let resizeObserver: ResizeObserver | null = null

function setViewport(key: string, element: Element | null): void {
  const previous = viewports.get(key)
  if (previous === element) return
  if (previous) resizeObserver?.unobserve(previous)
  if (element instanceof HTMLElement) {
    viewports.set(key, element)
    resizeObserver?.observe(element)
  } else {
    viewports.delete(key)
  }
  scheduleSync()
}

function forgetAttachment(id: string): void {
  attached.delete(id)
  attachedRects.delete(id)
}

function rectOf(element: HTMLElement): WebRect {
  const box = element.getBoundingClientRect()
  return {
    x: Math.max(0, Math.round(box.left)),
    y: Math.max(0, Math.round(box.top)),
    width: Math.max(0, Math.round(box.width)),
    height: Math.max(0, Math.round(box.height)),
  }
}

async function captureThumbnail(id: string): Promise<void> {
  try {
    const dataUrl = await web.capture(id, THUMBNAIL_WIDTH)
    if (dataUrl) thumbnails.value[id] = dataUrl
  } catch {
    // A view that is loading or just closed keeps its last thumbnail.
  }
}

let syncing = false
let syncAgain = false

/** Detach what left the screen, then attach every visible tile's active tab
 *  at its own rect: detaching first keeps the plugin under the Host's cap. */
async function syncAttachments(): Promise<void> {
  if (isLeft) return
  if (syncing) {
    syncAgain = true
    return
  }
  syncing = true
  try {
    do {
      syncAgain = false
      await nextTick()
      const desired = new Map<string, WebRect>()
      for (const space of visibleSpaces.value) {
        const view = activeView(space)
        const element = viewports.get(space.key)
        if (!view || !element) continue
        const rect = rectOf(element)
        if (rect.width >= 1 && rect.height >= 1) desired.set(view.viewId, rect)
      }
      const now = Date.now()
      for (const id of desired.keys()) lastShown.set(id, now)
      for (const id of [...attached]) {
        if (desired.has(id)) continue
        forgetAttachment(id)
        lastShown.set(id, now)
        await captureThumbnail(id)
        await web.detach(id).catch(() => undefined)
      }
      for (const [id, rect] of desired) {
        const signature = `${rect.x},${rect.y},${rect.width},${rect.height}`
        if (attachedRects.get(id) === signature) continue
        try {
          await web.attach(id, rect)
          attached.add(id)
          attachedRects.set(id, signature)
        } catch (cause) {
          fail(cause)
        }
      }
    } while (syncAgain)
  } finally {
    syncing = false
  }
}

function scheduleSync(): void {
  void syncAttachments()
}

// ---------------------------------------------------------------------------
// Resource release: a tab out of sight for 10 minutes is closed, remembered
// by URL, title and its last thumbnail, and loaded again when it is shown.
// ---------------------------------------------------------------------------

const discarding = new Set<string>()

async function discard(view: WebViewInfo): Promise<void> {
  if (discarding.has(view.viewId)) return
  discarding.add(view.viewId)
  try {
    await discardNow(view)
  } finally {
    discarding.delete(view.viewId)
  }
}

async function discardNow(view: WebViewInfo): Promise<void> {
  await captureThumbnail(view.viewId)
  const space = spaces.value.find((item) => item.tabs.some((tab) => tab.viewId === view.viewId))
  const tab: DiscardedTab = {
    id: `discarded:${view.viewId}`,
    space: view.space,
    owner: view.owner,
    url: view.url,
    title: view.title,
    thumbnail: thumbnails.value[view.viewId] ?? null,
  }
  try {
    await web.close(view.viewId)
  } catch {
    return
  }
  discarded.value = [...discarded.value, tab]
  lastShown.delete(view.viewId)
  if (space && activeId(space) === view.viewId) activeTabs.value = { ...activeTabs.value, [space.key]: tab.id }
}

function sweep(): void {
  const now = Date.now()
  for (const view of views.value) {
    const visible = attached.has(view.viewId)
    if (visible || !lastShown.has(view.viewId)) {
      lastShown.set(view.viewId, now)
      continue
    }
    if (mayDiscard(view, lastShown.get(view.viewId), now, visible)) void discard(view)
  }
}

watch(
  () => [
    mode.value,
    page.value,
    showSettings.value,
    error.value,
    visibleSpaces.value.map((space) => `${space.key}=${activeId(space)}`).join('|'),
  ],
  () => scheduleSync(),
)

watch(pageCount, (count) => {
  if (page.value > count - 1) page.value = Math.max(0, count - 1)
})

let unsubscribe: (() => void) | null = null
let sweepTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  unsubscribe = onWebChanged(applyViews)
  void refresh()
  if (isLeft) return
  resizeObserver = new ResizeObserver(() => scheduleSync())
  if (stage.value) resizeObserver.observe(stage.value)
  for (const element of viewports.values()) resizeObserver.observe(element)
  window.addEventListener('resize', scheduleSync)
  window.addEventListener('scroll', scheduleSync, true)
  window.addEventListener('keydown', onKeydown)
  sweepTimer = setInterval(sweep, DISCARD_SWEEP_MS)
  void layoutState.restore().then((value) => {
    mode.value = parseLayoutMode(value)
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
  resizeObserver?.disconnect()
  window.removeEventListener('resize', scheduleSync)
  window.removeEventListener('scroll', scheduleSync, true)
  window.removeEventListener('keydown', onKeydown)
  if (sweepTimer) clearInterval(sweepTimer)
  for (const id of attached) void web.detach(id).catch(() => undefined)
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
      <li v-for="space in spaces" :key="space.key" :class="{ agent: space.owner === 'agent' }" @click="run(openBrowserWindow)">
        <span v-if="space.owner === 'user'" class="pin" :title="t('browser.space.yours')">📌</span>
        <span class="name">{{ space.name || (space.tabs[0] ? tabLabel(space.tabs[0]) : '') }}</span>
        <span v-if="hasSensitiveUpload(space)" class="warn-mark" :title="t('browser.uploads.sensitive-note')">⚠</span>
        <span class="chip" :class="`state-${space.state}`">{{ t(stateLabelKey(space.state)) }}</span>
      </li>
    </ul>
    <p v-if="error" class="error">{{ error }}</p>
  </div>

  <div v-else ref="stage" class="browser-window">
    <header class="window-header">
      <h1>{{ t('browser.overview.title') }}</h1>
      <span v-if="pending > 0" class="pending-badge">{{ t('browser.overview.pending', { count: pending }) }}</span>
      <span v-if="views.length > 0" class="open-count">{{ t('browser.overview.open-count', { count: views.length }) }}</span>
      <span class="spacer" />
      <div class="segmented" role="group" :aria-label="t('browser.layout.label')">
        <button type="button" :class="{ selected: mode === 'tiled' }" :aria-pressed="mode === 'tiled'" @click="setMode('tiled')">{{ t('browser.layout.tiled') }}</button>
        <button type="button" :class="{ selected: mode === 'switch' }" :aria-pressed="mode === 'switch'" @click="setMode('switch')">{{ t('browser.layout.switch') }}</button>
      </div>
      <template v-if="mode === 'tiled' && pageCount > 1">
        <button type="button" class="icon" :title="t('browser.page.previous')" :disabled="page === 0" @click="setPage(page - 1)">‹</button>
        <span class="open-count">{{ t('browser.page.status', { page: page + 1, count: pageCount }) }}</span>
        <button type="button" class="icon" :title="t('browser.page.next')" :disabled="page >= pageCount - 1" @click="setPage(page + 1)">›</button>
      </template>
      <button type="button" @click="createSpace">＋ {{ t('browser.overview.new') }}</button>
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
    <p v-if="spaces.length === 0" class="muted empty">{{ t('browser.overview.empty') }}</p>

    <div v-else class="body" :class="`mode-${mode}`">
      <nav v-if="mode === 'switch'" class="space-list" :aria-label="t('browser.space.all')">
        <button
          v-for="space in spaces"
          :key="space.key"
          type="button"
          class="space-row"
          :class="{ selected: space.key === focusedSpace?.key, 'need-action': space.state === 'need-action' }"
          :aria-current="space.key === focusedSpace?.key"
          @click="focusSpace(space)"
        >
          <span v-if="space.owner === 'user'" class="pin" :title="t('browser.space.yours')">📌</span>
          <span class="name">{{ space.name || (space.tabs[0] ? tabLabel(space.tabs[0]) : '') }}</span>
          <span v-if="hasSensitiveUpload(space)" class="warn-mark" :title="t('browser.uploads.sensitive-note')">⚠</span>
          <span class="chip" :class="`state-${space.state}`">{{ t(stateLabelKey(space.state)) }}</span>
        </button>
      </nav>

      <div class="tiles" :style="gridStyle">
        <section
          v-for="space in visibleSpaces"
          :key="space.key"
          class="tile"
          :class="{
            'agent-frame': space.owner === 'agent',
            'need-action': space.state === 'need-action',
            focused: mode === 'tiled' && space.key === focusedSpace?.key,
          }"
          @mousedown="focusSpace(space)"
        >
          <header class="tile-header">
            <span v-if="space.owner === 'user'" class="pin" :title="t('browser.space.yours')">📌</span>
            <span class="name">{{ space.name || (space.tabs[0] ? tabLabel(space.tabs[0]) : '') }}</span>
            <span class="chip owner">{{ space.owner === 'agent' ? t('browser.owner.agent') : t('browser.owner.user') }}</span>
            <template v-if="activeView(space)">
              <span class="control-text">
                {{ activeView(space)!.owner === 'user' ? t('browser.control.yours') : activeView(space)!.control === 'agent' ? t('browser.control.agent') : t('browser.control.user') }}
              </span>
              <span class="chip" :class="`state-${activeView(space)!.state}`">{{ t(stateLabelKey(activeView(space)!.state)) }}</span>
              <span v-if="activeView(space)!.note" class="note" :title="activeView(space)!.note">{{ activeView(space)!.note }}</span>
            </template>
            <span class="spacer" />
            <template v-if="activeView(space)">
              <button v-if="activeView(space)!.owner === 'agent' && activeView(space)!.control === 'agent'" type="button" @click="takeOver(activeView(space)!)">{{ t('browser.action.take-over') }}</button>
              <button v-if="activeView(space)!.owner === 'agent' && activeView(space)!.control === 'user'" type="button" class="primary" @click="handBack(activeView(space)!)">{{ t('browser.action.hand-back') }}</button>
              <button v-if="activeView(space)!.owner === 'user'" type="button" :title="t('browser.action.delegate-note')" @click="setOwner(activeView(space)!, 'agent')">{{ t('browser.action.delegate') }}</button>
              <button v-else type="button" class="ghost" @click="setOwner(activeView(space)!, 'user')">{{ t('browser.action.reclaim') }}</button>
            </template>
            <button type="button" class="ghost" @click="closeSpace(space)">{{ t('browser.action.close') }}</button>
          </header>

          <div v-if="spaceDialog(space)" class="disclosure dialog-open" role="status">
            <span aria-hidden="true">💬</span>
            {{ t('browser.dialog.open', { type: t(`browser.dialog.type.${spaceDialog(space)!.dialog!.type}`), message: spaceDialog(space)!.dialog!.message }) }}
          </div>
          <details v-if="spaceUploads(space).length > 0" class="disclosure uploads" :open="hasSensitiveUpload(space)">
            <summary>
              {{ t('browser.uploads.title') }}
              <span v-if="hasSensitiveUpload(space)" class="sensitive-note"><span aria-hidden="true">⚠</span> {{ t('browser.uploads.sensitive-note') }}</span>
            </summary>
            <ul>
              <li v-for="upload in spaceUploads(space)" :key="`${upload.viewId}:${upload.at}:${upload.file}`" :class="{ sensitive: upload.sensitive }">
                <span v-if="upload.sensitive" class="sensitive-label"><span aria-hidden="true">⚠</span> {{ t('browser.uploads.sensitive') }}</span>
                {{ t('browser.uploads.item', { file: upload.file, origin: upload.origin, time: uploadTime(upload.at) }) }}
              </li>
            </ul>
          </details>

          <div class="tab-strip" role="tablist">
            <template v-for="tab in space.tabs" :key="tab.viewId">
              <div class="tab" :class="{ active: activeId(space) === tab.viewId, popup: !!tab.openerViewId }" role="tab" :aria-selected="activeId(space) === tab.viewId">
                <button type="button" class="tab-label" :title="tab.url" @click="selectTab(space, tab.viewId)">
                  <span v-if="tab.dialog" aria-hidden="true">💬</span>
                  <span class="chip" :class="`state-${tab.state}`" v-if="tab.state === 'need-action'">{{ t(stateLabelKey(tab.state)) }}</span>
                  {{ tabLabel(tab) }}
                </button>
                <button type="button" class="tab-close" :title="t('browser.tab.close')" :aria-label="t('browser.tab.close')" @click="closeTab(space, tab.viewId)">×</button>
              </div>
            </template>
            <div v-for="tab in space.discarded" :key="tab.id" class="tab discarded" :class="{ active: activeId(space) === tab.id }" role="tab" :aria-selected="activeId(space) === tab.id">
              <button type="button" class="tab-label" :title="t('browser.tab.discarded')" @click="selectTab(space, tab.id)">{{ tabLabel(tab) }}</button>
              <button type="button" class="tab-close" :title="t('browser.tab.close')" :aria-label="t('browser.tab.close')" @click="closeTab(space, tab.id)">×</button>
            </div>
            <button v-if="space.owner === 'user'" type="button" class="icon tab-new" :title="t('browser.tab.new')" :aria-label="t('browser.tab.new')" @click="newTab(space)">＋</button>
          </div>

          <template v-if="activeView(space)">
            <form class="toolbar" @submit.prevent="go(activeView(space)!, $event)">
              <button type="button" class="icon" :title="t('browser.nav.back')" @click="navigate(activeView(space)!, 'back')">←</button>
              <button type="button" class="icon" :title="t('browser.nav.forward')" @click="navigate(activeView(space)!, 'forward')">→</button>
              <button
                type="button"
                class="icon"
                :title="activeView(space)!.loading ? t('browser.nav.stop') : t('browser.nav.reload')"
                @click="navigate(activeView(space)!, activeView(space)!.loading ? 'stop' : 'reload')"
              >{{ activeView(space)!.loading ? '✕' : '↻' }}</button>
              <input name="address" class="address" :value="activeView(space)!.url" :placeholder="t('browser.nav.address')" spellcheck="false" autocomplete="off" />
            </form>
            <div v-if="showsAgentScriptWarning(activeView(space), kept)" class="script-warning" role="alert">
              <span class="script-warning-text">{{ t('browser.agent-script.warning') }}</span>
              <button type="button" class="primary" @click="navigate(activeView(space)!, 'reload')">{{ t('browser.agent-script.reload') }}</button>
              <button type="button" class="ghost" @click="keepPage(activeView(space)!)">{{ t('browser.agent-script.keep') }}</button>
            </div>
            <div :ref="(element) => setViewport(space.key, element as Element | null)" class="viewport" />
          </template>
          <div v-else-if="activeDiscarded(space)" class="viewport discarded-view">
            <img v-if="activeDiscarded(space)!.thumbnail" :src="activeDiscarded(space)!.thumbnail!" alt="" />
            <div class="discarded-card">
              <p>{{ t('browser.tab.discarded-note') }}</p>
              <button type="button" class="primary" @click="restoreTab(space, activeDiscarded(space)!)">{{ t('browser.tab.restore') }}</button>
            </div>
          </div>
        </section>
      </div>
    </div>
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
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: #fff; }
button.ghost { background: transparent; border-color: transparent; color: var(--text-secondary); }
button.danger { color: var(--danger-fg); border-color: var(--danger-fg); background: transparent; }
button.icon { width: 28px; padding: 4px 0; }
.spacer { flex: 1; }
.muted { color: var(--text-muted); font-size: var(--font-xs); }
.error { color: var(--danger-fg); font-size: var(--font-xs); margin: 4px 12px; }
.chip {
  font-size: var(--font-2xs);
  border-radius: 999px;
  padding: 1px 8px;
  background: var(--bg-muted);
  color: var(--text-secondary);
  white-space: nowrap;
}
.chip.state-running { background: var(--accent-emphasis); color: #fff; }
.chip.state-need-action { background: var(--attention-subtle); color: var(--attention-bright); }
.chip.state-done { background: var(--bg-muted); color: var(--success-fg); }
.agent-frame { box-shadow: 0 0 0 2px var(--accent-fg), 0 0 12px var(--accent-fg); }
.open-count { color: var(--text-muted); font-size: var(--font-xs); }
.pending-badge {
  background: var(--attention-subtle);
  color: var(--attention-bright);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: var(--font-2xs);
}
.warn-mark { color: var(--attention-bright); }

.browser-window { display: flex; flex-direction: column; height: 100%; overflow: hidden; box-sizing: border-box; }
.window-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border-muted); }
.window-header h1 { font-size: var(--font-sm); margin: 0; }
.segmented { display: inline-flex; }
.segmented button { border-radius: 0; }
.segmented button:first-child { border-radius: 6px 0 0 6px; }
.segmented button:last-child { border-radius: 0 6px 6px 0; border-left: none; }
.segmented button.selected { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: #fff; }
.settings { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border-muted); }
.settings .muted { flex-basis: 100%; margin: 0; }
.empty { padding: 16px; }

.body { flex: 1; min-height: 0; display: flex; }
.space-list { width: 220px; flex-shrink: 0; overflow: auto; display: flex; flex-direction: column; gap: 4px; padding: 8px; border-right: 1px solid var(--border-muted); }
.space-row { display: flex; align-items: center; gap: 6px; text-align: left; background: transparent; border-color: transparent; }
.space-row.selected { background: var(--bg-muted); border-color: var(--border-default); }
.space-row.need-action { border-color: var(--attention-bright); }
.space-row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* The gap and borders between tiles are DOM: a native view never covers them. */
.tiles { flex: 1; min-width: 0; min-height: 0; display: grid; gap: 10px; padding: 10px; box-sizing: border-box; }
.mode-switch .tiles { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
.tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 10px;
}
.tile.focused { border-color: var(--accent-focus); }
.tile.need-action { border-color: var(--attention-bright); }
.tile-header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; font-size: var(--font-xs); border-bottom: 1px solid var(--border-muted); }
.tile-header .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.tile-header .control-text { color: var(--text-secondary); }
.tile-header .note { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 30%; }

.disclosure { padding: 4px 8px; font-size: var(--font-2xs); border-bottom: 1px solid var(--border-muted); }
.dialog-open { color: var(--attention-bright); background: var(--attention-subtle); }
.uploads summary { cursor: pointer; color: var(--text-secondary); }
.uploads ul { margin: 4px 0 0; padding-left: 16px; max-height: 96px; overflow: auto; }
.uploads li { color: var(--text-secondary); }
.uploads li.sensitive { color: var(--attention-bright); font-weight: 600; }
.sensitive-note, .sensitive-label { color: var(--attention-bright); font-weight: 600; margin-left: 6px; }
.sensitive-label { margin: 0 4px 0 0; }

.tab-strip { display: flex; align-items: center; gap: 4px; padding: 4px 6px; overflow-x: auto; border-bottom: 1px solid var(--border-muted); }
.tab { display: flex; align-items: center; max-width: 200px; border: 1px solid var(--border-muted); border-radius: 6px; background: var(--bg-base); }
.tab.active { border-color: var(--accent-focus); background: var(--bg-muted); }
.tab.popup { margin-left: 6px; }
.tab.discarded .tab-label { color: var(--text-muted); font-style: italic; }
.tab-label { border: none; background: transparent; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 6px; display: flex; gap: 4px; align-items: center; }
.tab-close { border: none; background: transparent; padding: 2px 6px; color: var(--text-muted); }
.tab-new { flex-shrink: 0; }

.toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 6px; }
.address {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: var(--font-xs);
  color: var(--text-primary);
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 4px 8px;
}
.address:focus { outline: none; border-color: var(--accent-focus); }
.script-warning { display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: var(--font-xs); font-weight: 600; color: var(--danger-fg); border-bottom: 2px solid var(--danger-fg); background: var(--bg-subtle); }
.script-warning-text { flex: 1; }
.viewport { flex: 1; min-height: 0; margin: 0 6px 6px; border-radius: 6px; background: var(--bg-base); }
.discarded-view { position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.discarded-view img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: top; opacity: 0.35; }
.discarded-card { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px; border-radius: 8px; background: var(--bg-subtle); max-width: 80%; text-align: center; font-size: var(--font-xs); }

.browser-left { display: flex; flex-direction: column; gap: 8px; padding: 10px; height: 100%; box-sizing: border-box; overflow: auto; }
.left-header { display: flex; align-items: center; gap: 8px; }
.left-header .title { font-weight: 600; font-size: var(--font-xs); flex: 1; }
.left-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.left-list li { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; cursor: pointer; font-size: var(--font-xs); }
.left-list li:hover { background: var(--bg-hover); }
.left-list li.agent .name { color: var(--text-secondary); }
.left-list .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
