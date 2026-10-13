<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import RebuildIcon from './RebuildIcon.vue'
import { tabRunStatePaneStatus, type TabRunState } from '../lib/tabStatus'
import { statusBadgeStyle } from '../composables/useStatusBadgePrefs'

export interface TabItem {
  key: string
  label: string
  count: number
  /** Panes in this tab that are not waiting placeholders — shown as
   *  "live / count", the same tally as the sidebar's workspace heading. */
  live: number
  type: 'stage' | 'manual'
  /** Rolled-up state of the panes in this tab, shown as the leading dot.
   *  Required rather than optional so the compiler points at every caller
   *  that builds a TabItem when the vocabulary changes. */
  status: TabRunState
}

const props = withDefaults(defineProps<{
  tabs: TabItem[]
  modelValue: string
  canRebuildAll?: boolean
  rebuildingAll?: boolean
  rebuildAllTitle?: string
  allFamiliesCollapsed?: boolean
  familyToggleDisabledReason?: 'grid' | 'empty'
}>(), {
  canRebuildAll: false,
  rebuildingAll: false,
  rebuildAllTitle: 'Rebuild CLI panes in this tab'
})
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'add'): void
  (e: 'rename', key: string, name: string): void
  (e: 'delete', key: string): void
  (e: 'close-group', key: string): void
  (e: 'move-pane', paneId: string, targetKey: string): void
  (e: 'reorder-tab', fromKey: string, toKey: string): void
  (e: 'detach', key: string, x: number, y: number): void
  (e: 'rebuild-all'): void
  (e: 'toggleFamilies'): void
  (e: 'context-menu', key: string, ev: MouseEvent): void
}>()

const { t } = useI18n()
const familyToggleTitle = computed(() => {
  if (props.familyToggleDisabledReason) return t(`stageTab.family-toggle-${props.familyToggleDisabledReason}`)
  return t(props.allFamiliesCollapsed ? 'stageTab.expand-families' : 'stageTab.collapse-families')
})

/** Hover text for the status dot. Kept on the dot rather than the whole tab so
 *  it does not shadow the ✕ button's own title. */
function statusTitle(status: TabRunState): string {
  return t(`stageTab.status-${status}`)
}

/** The user's colour for the status this dot stands in for, when they have
 *  customized it. Undefined otherwise, which leaves the CSS default in place —
 *  the same contract statusBadgeStyle has everywhere else. */
function dotStyle(status: TabRunState): Record<string, string> | undefined {
  const paneStatus = tabRunStatePaneStatus(status)
  return paneStatus ? statusBadgeStyle(paneStatus) : undefined
}

const actionMenu = ref<{ show: boolean; key: string; x: number; y: number }>({ show: false, key: '', x: 0, y: 0 })

function onCloseClick(e: MouseEvent, key: string): void {
  const tab = props.tabs.find((t) => t.key === key)
  if (tab && tab.count <= 0) {
    emit('delete', key)
    actionMenu.value.show = false
    return
  }
  actionMenu.value = { show: true, key, x: e.clientX, y: e.clientY }
}

// The right-click menu itself lives in App.vue (RunGroupContextMenu), shared
// with the sidebar's group headings. While a tab is being renamed the native
// menu stays, so Paste still works in the input.
function onTabContextMenu(e: MouseEvent, key: string): void {
  if (editingKey.value === key) return
  e.preventDefault()
  emit('context-menu', key, e)
}
function chooseMove(): void {
  emit('delete', actionMenu.value.key)
  actionMenu.value.show = false
}
function chooseClose(): void {
  emit('close-group', actionMenu.value.key)
  actionMenu.value.show = false
}

// The ✕ shows when there are at least 2 visible tabs. Actual deletion rules
// live in App.vue because "手動" is a synthetic tab, not a persisted RunGroup.

// Drag-to-move: a pane dropped onto a tab reassigns it to that tab's run group.
// Drag-to-reorder: a tab dropped onto another tab swaps positions in the bar.
// The two flows are distinguished by dataTransfer type ('application/x-pane-id'
// vs 'application/x-tab-key'), so they never collide.
const dragOverKey = ref<string | null>(null)
const draggingTabKey = ref<string | null>(null)
function onTabDrop(e: DragEvent, key: string): void {
  dragOverKey.value = null
  const tabKey = e.dataTransfer?.getData('application/x-tab-key') || ''
  if (tabKey) {
    if (tabKey !== key) emit('reorder-tab', tabKey, key)
    return
  }
  const paneId = e.dataTransfer?.getData('application/x-pane-id') || ''
  if (paneId) emit('move-pane', paneId, key)
}
function onTabDragEnter(key: string): void {
  // No highlight on the tab being dragged itself — self-drops are no-ops.
  if (key !== draggingTabKey.value) dragOverKey.value = key
}

// Drag-out: dragging a stage tab and releasing OUTSIDE this window's viewport
// detaches that run group into its own child window. Uses a distinct data type
// so it never collides with the pane-drop-onto-tab flow above.
function onTabDragStart(e: DragEvent, tab: TabItem): void {
  if (tab.type !== 'stage') { e.preventDefault(); return }
  e.dataTransfer?.setData('application/x-tab-key', tab.key)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  draggingTabKey.value = tab.key
}
function onTabDragEnd(e: DragEvent, tab: TabItem): void {
  draggingTabKey.value = null
  if (tab.type !== 'stage') return
  const outside =
    e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight
  if (outside) emit('detach', tab.key, e.screenX, e.screenY)
}

const editingKey = ref<string | null>(null)
const editingName = ref('')
// A ref inside v-for collects into an ARRAY, so this is not a bare element.
const inputRef = ref<HTMLInputElement | HTMLInputElement[] | null>(null)
let _cancelledRename = false

async function startRename(tab: TabItem): Promise<void> {
  if (tab.type === 'manual') return
  _cancelledRename = false
  editingKey.value = tab.key
  editingName.value = tab.label
  await nextTick()
  const input = Array.isArray(inputRef.value) ? inputRef.value[0] : inputRef.value
  input?.select()
}

function commitRename(key: string): void {
  if (_cancelledRename) return
  const name = editingName.value.trim()
  if (name) emit('rename', key, name)
  editingKey.value = null
}

/** Opens the inline rename for a tab by key — how the shared right-click menu,
 *  which App.vue owns, starts a rename on this bar. */
function renameTab(key: string): void {
  const tab = props.tabs.find((t) => t.key === key)
  if (tab) void startRename(tab)
}
defineExpose({ renameTab })

function onRenameKeydown(e: KeyboardEvent, key: string): void {
  if (e.key === 'Enter') { e.preventDefault(); commitRename(key) }
  if (e.key === 'Escape') { e.preventDefault(); _cancelledRename = true; editingKey.value = null }
}
</script>

<template>
  <div class="stage-tab-bar">
    <div class="stage-tab-scroll" role="tablist">
    <template v-for="tab in tabs" :key="tab.key">
      <button
        role="tab"
        :aria-selected="tab.key === modelValue"
        :class="['tab-btn', `tab-type-${tab.type}`, { active: tab.key === modelValue, 'drag-over': dragOverKey === tab.key }]"
        :draggable="tab.type === 'stage' && editingKey !== tab.key"
        @click="emit('update:modelValue', tab.key)"
        @dblclick.prevent="startRename(tab)"
        @contextmenu="onTabContextMenu($event, tab.key)"
        @dragstart="onTabDragStart($event, tab)"
        @dragend="onTabDragEnd($event, tab)"
        @dragover.prevent
        @dragenter.prevent="onTabDragEnter(tab.key)"
        @dragleave="dragOverKey = (dragOverKey === tab.key ? null : dragOverKey)"
        @drop.prevent="onTabDrop($event, tab.key)"
      >
        <span
          class="tab-dot"
          :data-state="tab.status"
          :style="dotStyle(tab.status)"
          :title="statusTitle(tab.status)"
          :aria-label="statusTitle(tab.status)"
        />
        <template v-if="editingKey === tab.key">
          <input
            ref="inputRef"
            class="tab-rename-input"
            v-model="editingName"
            @keydown="onRenameKeydown($event, tab.key)"
            @blur="commitRename(tab.key)"
            @click.stop
          />
        </template>
        <template v-else>
          <span class="tab-label">{{ tab.label }}</span>
          <span class="tab-count">{{ tab.live }} / {{ tab.count }}</span>
          <span
            v-if="tab.type !== 'manual' || tabs.length > 1"
            class="tab-close"
            :title="$t('stageTab.delete-tab')"
            @click.stop="onCloseClick($event, tab.key)"
          >✕</span>
        </template>
      </button>
    </template>
    <button class="tab-add-btn" :title="$t('stageTab.add-group')" @click="emit('add')">+</button>
    <button
      class="tab-rebuild-all-btn"
      :class="{ busy: rebuildingAll }"
      :disabled="!canRebuildAll || rebuildingAll"
      :title="rebuildAllTitle"
      :aria-label="rebuildAllTitle"
      @click="emit('rebuild-all')"
    >
      <RebuildIcon />
    </button>
    <button
      type="button"
      class="tab-family-toggle-btn"
      :disabled="!!familyToggleDisabledReason"
      :title="familyToggleTitle"
      :aria-label="familyToggleTitle"
      :aria-expanded="!allFamiliesCollapsed"
      @click="emit('toggleFamilies')"
    >{{ allFamiliesCollapsed ? '▸' : '▾' }}</button>
    </div>
    <div class="stage-tab-actions"><slot name="actions" /></div>
  </div>

  <Teleport to="body">
    <div v-if="actionMenu.show" class="tab-action-backdrop" @click="actionMenu.show = false" />
    <div v-if="actionMenu.show" class="tab-action-menu nv-popover" :style="{ top: actionMenu.y + 'px', left: actionMenu.x + 'px' }">
      <button class="tab-action-item" @click="chooseMove()">{{ $t('stageTab.move-to-group') }}</button>
      <button class="tab-action-item danger" @click="chooseClose()">{{ $t('stageTab.close-all-panes') }}</button>
    </div>
  </Teleport>
</template>

<style scoped>
.stage-tab-bar {
  display: flex;
  align-items: center;
  height: 36px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  padding: 0 8px;
  flex-shrink: 0;
}
/* Tabs scroll; the action slot stays pinned to the right edge. */
.stage-tab-scroll {
  display: flex;
  align-items: center;
  align-self: stretch;
  flex: 1 1 auto;
  min-width: 0;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
}
.stage-tab-scroll::-webkit-scrollbar { display: none; }
.stage-tab-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  margin-left: 8px;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 100%;
  padding: 0 10px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  margin-bottom: -1px; /* overlap the bar's bottom border */
}
.tab-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.tab-btn.active {
  background: var(--bg-base);
  color: var(--accent-bright);
  border-bottom-color: var(--accent-focus);
}
.tab-btn.drag-over {
  background: var(--accent-subtle);
  border-bottom-color: var(--accent-focus);
}

/* Three colours plus grey, no animation: a pulsing dot per tab is exactly the
   pattern that cost measurable WindowServer time before. Colours are the same
   tokens the pane badges use, so awaiting and idle mean the same thing
   everywhere. */
/* Geometry matches .ws-grp-key in ControlPane, deliberately: this dot and the
   sidebar's group key are two views of ONE value — both read the same
   rollupTabStatus() for the same group — so they should not look like two
   different kinds of indicator. (The pane row's .status-dot stays a circle;
   that one is a different signal with eight states of its own.) */
.tab-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--border-default);
}
/* Defaults, with the user's Settings override in front of each: this dot
   stands in for a pane status, so recolouring that status has to move it too
   — the same `var(--status-badge-fg, <default>)` shape every other dot uses. */
.tab-dot[data-state='awaiting'] { background: var(--status-badge-fg, var(--warning-fg)); }
.tab-dot[data-state='active'] { background: var(--status-badge-fg, var(--success-fg)); }
.tab-dot[data-state='idle'] { background: var(--status-badge-fg, var(--status-idle-emphasis)); }

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 2px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-size: var(--font-3xs);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.tab-btn:hover .tab-close { opacity: 0.7; }
.tab-close:hover {
  opacity: 1;
  color: var(--text-primary);
  background: var(--bg-muted);
}

.tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  font-variant-numeric: tabular-nums;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.tab-btn.active .tab-count {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}

.tab-rename-input {
  width: 80px;
  background: var(--bg-base);
  border: 1px solid var(--accent-focus);
  border-radius: var(--radius-xs);
  color: var(--text-primary);
  font-size: var(--font-xs);
  font-family: inherit;
  padding: 0 4px;
  height: 18px;
  outline: none;
}

.tab-add-btn,
.tab-rebuild-all-btn,
.tab-family-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn-sm);
  height: var(--icon-btn-sm);
  padding: 0;
  margin-left: 4px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-lg);
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
  transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.tab-add-btn:hover,
.tab-rebuild-all-btn:hover:not(:disabled),
.tab-family-toggle-btn:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--accent-focus);
  background: var(--bg-hover);
}

.tab-rebuild-all-btn,
.tab-family-toggle-btn {
  margin-left: 2px;
}
.tab-family-toggle-btn {
  font-size: 11px;
}
.tab-rebuild-all-btn svg {
  width: 14px;
  height: 14px;
}
.tab-rebuild-all-btn:disabled,
.tab-family-toggle-btn:disabled {
  cursor: default;
  opacity: 0.4;
}
.tab-rebuild-all-btn.busy svg {
  animation: tab-rebuild-spin 0.8s linear infinite;
}
@keyframes tab-rebuild-spin {
  to { transform: rotate(360deg); }
}

.tab-action-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1999;
}
.tab-action-menu {
  position: fixed;
  z-index: 2000;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-popover);
  box-shadow: var(--shadow-popover);
  padding: 4px;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  transform: translateX(-50%);
}
.tab-action-item {
  width: 100%;
  padding: 7px 12px;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-xs);
  font-family: inherit;
  cursor: pointer;
}
.tab-action-item:hover { background: var(--bg-hover); }
.tab-action-item.danger { color: var(--danger-bright, #f85149); }
.tab-action-item.danger:hover { background: var(--danger-subtle, rgba(248,81,73,0.1)); }
</style>
