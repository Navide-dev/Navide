<script setup lang="ts">
// Node palette: every Role is a step you can place, plus the approval gate.
// Items drag onto either view, or are picked with click/Enter — the editor
// decides where a picked item lands (the slot the user pressed "+" on, or
// after the selected node). Used docked in the editor and as the quick-add
// popover, so search and keyboard behave the same in both.
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Role } from '../../composables/useRoles'
import { DND_PALETTE, type PaletteItem } from './pipelineEditorModel'
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{
  roles: Role[]
  locked?: boolean
  /** Popover mode: autofocus search, no section chrome. */
  compact?: boolean
}>()
const emit = defineEmits<{ (e: 'pick', item: PaletteItem): void }>()
const { t } = useI18n()

const query = ref('')
const searchEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const gate = computed<PaletteItem>(() => ({
  kind: 'gate',
  label: t('pipelineEditor.palette.gate'),
  description: t('pipelineEditor.palette.gate-desc'),
}))

function matches(text: string): boolean {
  const q = query.value.trim().toLowerCase()
  return !q || text.toLowerCase().includes(q)
}

const roleItems = computed<PaletteItem[]>(() =>
  [...props.roles]
    .sort((a, b) => a.label.localeCompare(b.label))
    .filter((r) => matches(`${r.label} ${r.key} ${r.one_line}`))
    .map((r) => ({ kind: 'role', roleKey: r.key, label: r.label, description: r.one_line }))
)
const flowItems = computed<PaletteItem[]>(() =>
  matches(`${gate.value.label} ${gate.value.description}`) ? [gate.value] : []
)
const empty = computed(() => !roleItems.value.length && !flowItems.value.length)

function onDragStart(e: DragEvent, item: PaletteItem): void {
  if (props.locked || !e.dataTransfer) return
  e.dataTransfer.setData(DND_PALETTE, JSON.stringify(item))
  e.dataTransfer.effectAllowed = 'copy'
}

function pick(item: PaletteItem): void {
  if (!props.locked) emit('pick', item)
}

/** ↑/↓ walk the items; the search box hands off to the first one. */
function onListKey(e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const items = Array.from(listEl.value?.querySelectorAll<HTMLElement>('.pp-item') ?? [])
  if (!items.length) return
  e.preventDefault()
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : at - 1
  if (next < 0) searchEl.value?.focus()
  else items[next].focus()
}
function onSearchEnter(): void {
  const first = roleItems.value[0] ?? flowItems.value[0]
  if (first) pick(first)
}

onMounted(() => {
  if (props.compact) void nextTick(() => searchEl.value?.focus())
})
</script>

<template>
  <div class="pp" :class="{ 'pp--compact': compact, 'is-locked': locked }" @keydown="onListKey">
    <label class="pp-search">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
      <input
        ref="searchEl" v-model="query" type="search" spellcheck="false"
        :placeholder="t('pipelineEditor.palette.search')" :aria-label="t('pipelineEditor.palette.search')"
        @keydown.enter.prevent="onSearchEnter"
      />
    </label>
    <div ref="listEl" class="pp-list" role="list">
      <template v-if="roleItems.length">
        <h3 class="pp-group">{{ t('pipelineEditor.palette.agents') }}</h3>
        <button
          v-for="item in roleItems" :key="item.kind === 'role' ? item.roleKey : ''"
          type="button" role="listitem" class="pp-item" :draggable="!locked" :disabled="locked"
          @dragstart="onDragStart($event, item)" @click="pick(item)"
        >
          <span class="pp-glyph pp-glyph--role" aria-hidden="true">{{ item.label.charAt(0).toUpperCase() }}</span>
          <span class="pp-text">
            <span class="pp-label" v-truncate>{{ item.label }}</span>
            <span v-if="item.description" class="pp-desc" v-truncate>{{ item.description }}</span>
          </span>
        </button>
      </template>
      <template v-if="flowItems.length">
        <h3 class="pp-group">{{ t('pipelineEditor.palette.flow') }}</h3>
        <button
          v-for="item in flowItems" :key="item.kind"
          type="button" role="listitem" class="pp-item" :draggable="!locked" :disabled="locked"
          @dragstart="onDragStart($event, item)" @click="pick(item)"
        >
          <span class="pp-glyph pp-glyph--gate" aria-hidden="true">
            <svg viewBox="0 0 16 16"><path d="M8 1.8 14.2 8 8 14.2 1.8 8z" /></svg>
          </span>
          <span class="pp-text">
            <span class="pp-label" v-truncate>{{ item.label }}</span>
            <span class="pp-desc" v-truncate>{{ item.description }}</span>
          </span>
        </button>
        <p v-if="!compact" class="pp-tip">{{ t('pipelineEditor.palette.branch-tip') }}</p>
      </template>
      <p v-if="empty" class="pp-empty">{{ t('pipelineEditor.palette.no-match', { q: query.trim() }) }}</p>
    </div>
  </div>
</template>

<style scoped>
.pp { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.pp-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-3);
  padding: 0 var(--space-3);
  height: var(--control-h-md);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-inset);
  color: var(--text-muted);
  transition: border-color var(--motion-fast) var(--ease-out);
}
.pp-search:focus-within { border-color: var(--accent-emphasis); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-emphasis) 18%, transparent); }
.pp-search svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; flex: none; }
.pp-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-sm);
  outline: none;
}
.pp-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--space-2) var(--space-3); }
.pp-group {
  margin: var(--space-3) var(--space-2) var(--space-1);
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-muted);
}
.pp-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: grab;
  transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
.pp-item:hover { background: var(--bg-hover); }
.pp-item:focus-visible { outline: none; border-color: var(--accent-emphasis); background: var(--bg-hover); }
.pp-item:active { cursor: grabbing; }
.pp-item:disabled { cursor: not-allowed; opacity: 0.5; }
.pp-glyph {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  font-weight: 600;
}
.pp-glyph--role { background: var(--bg-muted); color: var(--text-secondary); }
.pp-glyph--gate { background: color-mix(in srgb, var(--attention-emphasis) 18%, transparent); color: var(--attention-fg); }
.pp-glyph svg { width: 12px; height: 12px; fill: currentColor; }
.pp-text { display: grid; gap: 1px; min-width: 0; }
.pp-label { font-size: var(--font-sm); color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-desc { font-size: var(--font-2xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-tip, .pp-empty {
  margin: var(--space-3) var(--space-2) 0;
  font-size: var(--font-2xs);
  line-height: var(--lh-base);
  color: var(--text-muted);
}
.pp--compact .pp-list { max-height: 320px; }
@media (prefers-reduced-motion: reduce) { .pp-item, .pp-search { transition: none; } }
</style>
