<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { NEW_WORKSPACE_ERROR_KEYS } from '../../../shared/workspaceCreate'
import type { useBackend } from '../composables/useBackend'
import { useEditorTargets } from '../composables/useEditorTargets'
import { useRecentWorkspaces, type RecentWorkspace } from '../composables/useRecentWorkspaces'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  /** Opened from the sidebar rather than shown at startup: gets a close
   *  button, Escape and a backdrop click. Off by default — there is nothing
   *  behind the startup screen to dismiss it to. */
  dismissible?: boolean
}>()
const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'open-settings'): void
  (e: 'close'): void
}>()

function dismiss(): void {
  if (props.dismissible) emit('close')
}
function onDismissKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') dismiss()
}
onMounted(() => {
  if (props.dismissible) document.addEventListener('keydown', onDismissKey)
})
onBeforeUnmount(() => document.removeEventListener('keydown', onDismissKey))

const { recent, loaded, error, trimmed, touch, pin, unpin, remove } = useRecentWorkspaces(props.backend)

const { t } = useI18n()

const picking = ref(false)
const creating = ref(false)
/** Why the last "New…" attempt made no folder; '' once it succeeds or is retried. */
const createError = ref('')

// Workspaces open in other windows (this window shows Welcome, so it has
// none itself). Fed by main's registry; refreshed on workspace:openChanged.
const openWorkspaces = ref<string[]>([])
let disposeOpenChanged: (() => void) | null = null

async function refreshOpenWorkspaces(): Promise<void> {
  openWorkspaces.value = (await window.agentTeam?.listOpenWorkspaces?.()) ?? []
}

onMounted(() => {
  void refreshOpenWorkspaces()
  disposeOpenChanged = window.agentTeam?.onOpenWorkspacesChanged?.(() => {
    void refreshOpenWorkspaces()
  }) ?? null
})

onBeforeUnmount(() => {
  disposeOpenChanged?.()
  disposeOpenChanged = null
  window.removeEventListener('keydown', onCtxKeydown)
})

function isOpenElsewhere(path: string): boolean {
  const norm = (p: string): string => p.replace(/\/+$/, '')
  const target = norm(path)
  return openWorkspaces.value.some((ws) => norm(ws) === target)
}

// Recent keeps every workspace ever opened, so the list is long: pinned and
// open workspaces sit in their own group on top, the rest page in PAGE_SIZE at
// a time. The search runs over the whole list, loaded page or not.
const PAGE_SIZE = 10
const query = ref('')
const shown = ref(PAGE_SIZE)
watch(query, () => { shown.value = PAGE_SIZE })

const matches = computed<RecentWorkspace[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return recent.value
  return recent.value.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q))
})
// Pinned first, then open; each most-recent-first (the backend's order).
const headItems = computed<RecentWorkspace[]>(() => [
  ...matches.value.filter((r) => r.pinned),
  ...matches.value.filter((r) => !r.pinned && isOpenElsewhere(r.path)),
])
const restItems = computed<RecentWorkspace[]>(() =>
  matches.value.filter((r) => !r.pinned && !isOpenElsewhere(r.path))
)
const remaining = computed(() => Math.max(0, restItems.value.length - shown.value))
const groups = computed(() => [
  { key: 'open', label: t('recentWorkspaces.group-open'), items: headItems.value },
  {
    key: 'recent',
    // Only worth a heading when there is a group above it to tell apart from.
    label: headItems.value.length ? t('recentWorkspaces.group-recent') : '',
    items: restItems.value.slice(0, shown.value),
  },
].filter((g) => g.items.length))

function showMore(): void {
  shown.value += PAGE_SIZE
}

// How the workspace's last pipeline run ended, mirrored onto the recent entry
// by the backend's pipeline handlers. Folders that never ran one ('' from older
// entries, 'idle' from a project that was only ever used to spawn CLI panes)
// get no badge — a row of identical placeholders is noise, not information.
function stateBadge(state: string): { icon: string; label: string; cls: string } | null {
  switch (state) {
    case 'completed':
      return { icon: '✓', label: 'completed', cls: 'completed' }
    case 'running':
      return { icon: '▶', label: 'running', cls: 'running' }
    case 'aborted':
      return { icon: '⏸', label: 'aborted', cls: 'aborted' }
    default:
      return null
  }
}

function timeAgo(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

async function openWorkspace(path: string): Promise<void> {
  // Already open in another window → focus that window instead of opening a
  // duplicate (two windows on one folder means conflicting PTY/git operations).
  if (await window.agentTeam?.focusWorkspaceWindow?.(path)) return
  await touch(path, '', '', openWorkspaces.value)
  emit('select', path)
}

async function browse(): Promise<void> {
  if (!window.agentTeam) return
  picking.value = true
  try {
    const picked = await window.agentTeam.pickWorkspace()
    if (picked) await openWorkspace(picked)
  } finally {
    picking.value = false
  }
}

async function newWorkspace(): Promise<void> {
  if (!window.agentTeam) return
  creating.value = true
  createError.value = ''
  try {
    const result = await window.agentTeam.newWorkspace()
    if (result.ok) {
      await openWorkspace(result.path)
      return
    }
    // A cancelled dialog is the user's own doing and needs no message. The
    // rest used to fail silently, back when main named the folder itself and
    // could always find a free name.
    if (result.reason === 'canceled') return
    const path = result.path ?? ''
    createError.value = t(NEW_WORKSPACE_ERROR_KEYS[result.reason], {
      path,
      name: path.split(/[\\/]/).pop() || path
    })
  } finally {
    creating.value = false
  }
}

async function openHome(): Promise<void> {
  if (!window.agentTeam) return
  const home = await window.agentTeam.getHomeDir()
  if (home) await openWorkspace(home)
}

async function togglePin(item: RecentWorkspace, ev: Event): Promise<void> {
  ev.stopPropagation()
  if (item.pinned) await unpin(item.path)
  else await pin(item.path)
}

async function removeItem(item: RecentWorkspace, ev: Event): Promise<void> {
  ev.stopPropagation()
  await remove(item.path)
}

// ── Context menu ─────────────────────────────────────────────────────────────
// Backdrop + fixed menu, following the PlansPane convention.
const { editorTargets, loadEditorTargets } = useEditorTargets()
const ctxMenu = ref<{ show: boolean; x: number; y: number; path: string }>({
  show: false,
  x: 0,
  y: 0,
  path: '',
})
const ctxMenuEl = ref<HTMLElement | null>(null)

// Keep the menu inside the viewport: clamp with a rough size first so it never
// spawns off-screen, then re-clamp once the real element is measured.
function clampMenu(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

async function openCtxMenu(e: MouseEvent, item: RecentWorkspace): Promise<void> {
  e.preventDefault()
  const first = clampMenu(e.clientX, e.clientY, 200, 180)
  ctxMenu.value = { show: true, x: first.x, y: first.y, path: item.path }
  window.addEventListener('keydown', onCtxKeydown)
  void loadEditorTargets()
  await nextTick()
  const el = ctxMenuEl.value
  if (!el || !ctxMenu.value.show) return
  const rect = el.getBoundingClientRect()
  if (!rect.width && !rect.height) return
  const fit = clampMenu(e.clientX, e.clientY, rect.width, rect.height)
  if (fit.x !== ctxMenu.value.x || fit.y !== ctxMenu.value.y) {
    ctxMenu.value = { ...ctxMenu.value, x: fit.x, y: fit.y }
  }
}

function closeCtxMenu(): void {
  window.removeEventListener('keydown', onCtxKeydown)
  ctxMenu.value = { ...ctxMenu.value, show: false, path: '' }
}

function onCtxKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeCtxMenu()
}

function ctxOpenInEditor(editorId?: string): void {
  void window.agentTeam?.openFolderInEditor(ctxMenu.value.path, editorId)
  closeCtxMenu()
}

function ctxReveal(): void {
  void window.agentTeam?.revealPath(ctxMenu.value.path)
  closeCtxMenu()
}

function ctxCopyPath(): void {
  void navigator.clipboard?.writeText(ctxMenu.value.path)
  closeCtxMenu()
}
</script>

<template>
  <div class="welcome-overlay" :class="{ 'welcome-overlay--modal': dismissible }" @click.self="dismiss">
    <div class="welcome-card">
      <header class="w-head">
        <button v-if="dismissible" class="w-close" :aria-label="$t('action.close')" @click="dismiss">✕</button>
        <h1>Navide</h1>
        <p class="tagline">{{ $t('label.tagline') }}</p>
      </header>

      <section class="w-open">
        <h2>{{ $t('label.open-workspace') }}</h2>
        <div class="w-open-btns" data-tour="welcome-open-buttons">
          <button class="primary" :disabled="picking" @click="browse">
            {{ picking ? '…' : $t('action.browse') }}
          </button>
          <button class="ghost" :disabled="creating" @click="newWorkspace">
            {{ creating ? '…' : $t('action.new-workspace') }}
          </button>
          <button class="ghost" @click="openHome">
            {{ $t('action.open-home') }}
          </button>
        </div>
        <p v-if="createError" class="w-error" role="alert">{{ createError }}</p>
      </section>

      <section class="w-recent">
        <h2>{{ $t('label.recent') }}</h2>

        <p v-if="error" class="w-error">{{ error }}</p>
        <p v-if="trimmed > 0" class="r-trimmed">{{ $t('recentWorkspaces.trimmed', { count: trimmed }) }}</p>

        <input
          v-if="recent.length"
          v-model="query"
          class="r-search"
          type="search"
          :placeholder="$t('recentWorkspaces.search-placeholder')"
          :aria-label="$t('recentWorkspaces.search-placeholder')"
        />

        <div v-for="group in groups" :key="group.key" class="recent-group" :class="`recent-group--${group.key}`">
          <h3 v-if="group.label" class="r-group-label">{{ group.label }}</h3>
          <ul class="recent-list">
            <li
              v-for="item in group.items"
              :key="item.path"
              class="recent-item"
              :class="{ stale: !item.exists }"
              tabindex="0"
              @click="openWorkspace(item.path)"
              @keydown.enter.self="openWorkspace(item.path)"
              @contextmenu="openCtxMenu($event, item)"
            >
              <button
                class="pin"
                :class="{ on: item.pinned }"
                :title="item.pinned ? $t('label.unpin') : $t('label.pin')"
                @click="togglePin(item, $event)"
              >
                {{ item.pinned ? '★' : '☆' }}
              </button>
              <div class="r-body">
                <div class="r-top">
                  <span class="r-name">{{ item.name }}</span>
                  <span v-if="isOpenElsewhere(item.path)" class="r-open" :title="$t('label.already-open')">{{ $t('label.already-open') }}</span>
                  <span
                    v-if="stateBadge(item.last_known_state)"
                    class="r-badge"
                    :class="stateBadge(item.last_known_state)?.cls"
                  >
                    {{ stateBadge(item.last_known_state)?.icon }}
                    {{ stateBadge(item.last_known_state)?.label }}
                  </span>
                  <span v-if="!item.exists" class="r-missing" title="Folder not found">{{ $t('label.missing') }}</span>
                  <span class="r-time">{{ timeAgo(item.last_opened_at) }}</span>
                </div>
                <div class="r-path" v-truncate>{{ item.path }}</div>
                <div v-if="item.last_known_task" class="r-task">"{{ item.last_known_task }}"</div>
              </div>
              <button
                class="r-delete"
                :title="$t('action.remove-from-history')"
                :aria-label="$t('action.remove-from-history')"
                @click="removeItem(item, $event)"
              >✕</button>
            </li>
          </ul>
        </div>

        <button v-if="remaining > 0" class="r-more" @click="showMore">
          {{ $t('recentWorkspaces.show-more', { count: remaining }) }}
        </button>
        <p v-if="query && recent.length && !matches.length" class="r-nomatch">
          {{ $t('recentWorkspaces.no-match', { query: query.trim() }) }}
        </p>
        <p v-else-if="loaded && !recent.length" class="w-empty" v-html="$t('label.no-recent-workspaces')"></p>
      </section>

      <footer class="w-foot">
        <button class="link" @click="emit('open-settings')">⚙ {{ $t('action.settings') }}</button>
      </footer>
    </div>

    <template v-if="ctxMenu.show">
      <div class="ctx-backdrop" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
      <div ref="ctxMenuEl" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button class="menu-item" @click="ctxOpenInEditor()">{{ $t('action.open-in-default-editor') }}</button>
        <div class="menu-item has-sub">
          <span>{{ $t('action.open-with') }}</span><span class="sub-caret">▸</span>
          <div class="ctx-submenu">
            <button
              v-for="target in editorTargets"
              :key="target.id"
              class="menu-item"
              @click="ctxOpenInEditor(target.id)"
            >{{ $t(target.labelKey) }}</button>
          </div>
        </div>
        <div class="menu-sep" />
        <button class="menu-item" @click="ctxReveal">{{ $t('action.reveal-in-finder') }}</button>
        <button class="menu-item" @click="ctxCopyPath">{{ $t('action.copy-path') }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.welcome-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-inset);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: calc(var(--z-modal) + 110);
}
/* Windows and Linux draw their window controls into the app's own 38px
   `.titlebar` (macOS gets OS-drawn traffic lights painted over the window
   instead). This opaque, full-viewport overlay used to start at `inset: 0` and
   cover that bar, so the first-launch / Home screen on those platforms had no
   reachable minimise or close — only Alt+F4. Start below the bar so the drawn
   controls, and the bar's draggable region, stay reachable; the titlebar keeps
   its own z-index (below real modals), it is simply no longer covered here.
   Gated on `data-window-controls="drawn"`, which `main.ts` sets only when
   `needsDrawnWindowControls()` is true — macOS never gets it, so its overlay is
   unchanged (its controls are drawn by the OS above everything regardless). */
html[data-window-controls='drawn'] .welcome-overlay {
  top: var(--titlebar-height, 38px);
}
/* Opened over a working window, so the app stays visible behind it — the
   startup screen's opaque inset would read as "the workspace closed". */
.welcome-overlay--modal { background: rgb(0 0 0 / 52%); }
.w-head { position: relative; }
.w-close {
  position: absolute;
  top: 0;
  right: 0;
  border: none;
  background: none;
  padding: 2px 4px;
  cursor: pointer;
  font-size: var(--font-sm);
  line-height: 1;
  color: var(--text-muted);
  border-radius: var(--radius-sm);
}
.w-close:hover { color: var(--text-bright); background: var(--bg-muted); }
.w-close:focus-visible,
button.primary:focus-visible,
button.ghost:focus-visible,
button.link:focus-visible,
.pin:focus-visible,
.r-delete:focus-visible {
  outline: 2px solid var(--accent-emphasis);
  outline-offset: 2px;
}
.welcome-card {
  width: 560px;
  max-height: 86vh;
  overflow-y: auto;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 28px 32px;
  color: var(--text-bright);
  box-shadow: var(--shadow-modal);
}
.w-head h1 {
  margin: 0;
  font-size: 26px;
  letter-spacing: 0.5px;
  line-height: 1.2;
}
.tagline {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.w-open,
.w-recent {
  margin-top: 24px;
}
.w-open h2,
.w-recent h2 {
  font-size: var(--font-sm);
  color: var(--text-secondary);
  font-weight: 600;
  margin: 0 0 10px;
}
.w-open-btns {
  display: flex;
  gap: 10px;
}
/* Only the message under the buttons; the one in Recent sits in its own flow. */
.w-open .w-error {
  margin: 10px 0 0;
}
button.primary {
  background: var(--success-emphasis);
  border: 1px solid var(--success-strong);
  color: var(--text-on-emphasis);
  padding: 8px 16px;
  border-radius: var(--radius-control);
  cursor: pointer;
  font-size: var(--font-sm);
}
button.primary:hover:not(:disabled) {
  background: var(--success-strong);
}
button.ghost {
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  padding: 8px 16px;
  border-radius: var(--radius-control);
  cursor: pointer;
  font-size: var(--font-sm);
}
button.ghost:hover:not(:disabled) {
  background: var(--bg-subtle);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
/* The card scrolls once the list grows; macOS hides overlay scrollbars until
   you scroll, which made the rows below the fold look like they did not exist. */
.welcome-card::-webkit-scrollbar { width: 8px; }
.welcome-card::-webkit-scrollbar-thumb {
  background: var(--border-default);
  border-radius: 4px;
}
.r-search {
  width: 100%;
  box-sizing: border-box;
  margin: 0 0 10px;
  padding: 6px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-size: var(--font-sm);
}
.recent-group + .recent-group { margin-top: 12px; }
.r-group-label {
  margin: 0 0 6px;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-muted);
}
.r-more {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 6px 10px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-sm);
}
.r-more:hover { background: var(--bg-subtle); }
.r-more:focus-visible {
  outline: 2px solid var(--accent-emphasis);
  outline-offset: 2px;
}
.r-trimmed,
.r-nomatch {
  margin: 0 0 10px;
  font-size: var(--font-xs);
  color: var(--text-muted);
}
.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.recent-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
}
.recent-item:hover {
  background: var(--bg-subtle);
  border-color: var(--border-default);
}
.recent-item:focus-visible {
  outline: 2px solid var(--accent-emphasis);
  outline-offset: -1px;
}
.recent-item.stale {
  opacity: 0.55;
}
.pin {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 15px;
  line-height: 1.4;
  padding: 0;
}
.pin.on {
  color: var(--attention-fg);
}
.r-body {
  flex: 1;
  min-width: 0;
}
.r-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.r-name {
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-sm);
}
.r-badge {
  font-size: var(--font-3xs);
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.r-badge.completed {
  color: var(--success-fg);
  background: var(--success-subtle);
}
.r-badge.running {
  color: var(--accent-fg);
  background: var(--accent-subtle);
}
.r-badge.aborted {
  color: var(--attention-fg);
  background: var(--attention-subtle);
}
.r-missing {
  font-size: var(--font-3xs);
  color: var(--danger-fg);
}
.r-open {
  font-size: var(--font-3xs);
  padding: 1px 6px;
  border-radius: 10px;
  color: var(--success-fg);
  background: var(--success-subtle);
}
.r-time {
  margin-left: auto;
  font-size: var(--font-2xs);
  color: var(--text-muted);
}
.r-path {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.r-task {
  font-size: var(--font-xs);
  color: var(--text-primary);
  margin-top: 2px;
}
.r-delete {
  background: transparent;
  border: none;
  color: transparent;
  cursor: pointer;
  font-size: var(--font-xs);
  padding: 2px 4px;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
  align-self: center;
}
.recent-item:hover .r-delete {
  color: var(--text-muted);
}
.r-delete:hover {
  color: var(--danger-fg) !important;
  background: var(--bg-muted);
}
.w-empty {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.6;
}
.w-error {
  color: var(--danger-fg);
  font-size: var(--font-xs);
}
.w-foot {
  margin-top: 24px;
  border-top: 1px solid var(--border-muted);
  padding-top: 14px;
}
button.link {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-xs);
  padding: 0;
}
button.link:hover {
  color: var(--text-bright);
}
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.ctx-menu {
  position: fixed;
  z-index: 41;
  min-width: 180px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px var(--shadow-overlay);
  padding: 4px;
}
.ctx-menu .menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}
.ctx-menu .menu-item:hover {
  background: var(--bg-active);
}
.ctx-menu .menu-sep {
  height: 1px;
  background: var(--border-muted);
  margin: 4px 0;
}
/* Hover submenu (Open with ▸) */
.ctx-menu .menu-item.has-sub {
  position: relative;
  justify-content: space-between;
  gap: 12px;
}
.ctx-menu .sub-caret {
  color: var(--text-muted);
  font-size: var(--font-3xs);
}
.ctx-menu .ctx-submenu {
  position: absolute;
  top: -5px;
  left: 100%;
  margin-left: 2px;
  display: none;
  min-width: 180px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 4px;
  box-shadow: 0 8px 24px var(--shadow-overlay);
}
.ctx-menu .menu-item.has-sub:hover .ctx-submenu {
  display: block;
}
</style>
