<script setup lang="ts">
// A button that opens a short list of actions, each with an optional one-line
// description and, when it cannot run, the reason why. The editor uses it for
// the pipeline's secondary actions (⋯) and for the run-recovery actions, so a
// crowded toolbar or inspector footer holds one button instead of five.
//
// The list is teleported and fixed-positioned from the trigger's box: the
// inspector and the modal clip overflow, and a menu cut in half is worse than
// none.
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

export interface ActionMenuItem {
  id: string
  label: string
  /** What the action does, under its label. */
  desc?: string
  /** Why it cannot run now; a non-empty reason disables the item. */
  blocked?: string
  danger?: boolean
}

const props = withDefaults(defineProps<{
  label: string
  items: ActionMenuItem[]
  /** Shown as the trigger's tooltip and accessible name when `label` is a glyph. */
  title?: string
  /** Opens above the trigger (a footer) instead of below it (a toolbar). */
  up?: boolean
  disabled?: boolean
}>(), { title: '', up: false, disabled: false })
const emit = defineEmits<{ (e: 'select', id: string): void }>()

const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const list = ref<HTMLElement | null>(null)
const pos = ref<Record<string, string>>({})

function place(): void {
  const r = trigger.value?.getBoundingClientRect()
  if (!r) return
  const right = `${Math.max(8, window.innerWidth - r.right)}px`
  pos.value = props.up
    ? { right, bottom: `${Math.max(8, window.innerHeight - r.top + 4)}px` }
    : { right, top: `${r.bottom + 4}px` }
}
async function toggle(): Promise<void> {
  if (open.value) { close(); return }
  place()
  open.value = true
  await nextTick()
  list.value?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
}
function close(): void {
  open.value = false
}
function pick(item: ActionMenuItem): void {
  if (item.blocked) return
  close()
  emit('select', item.id)
}
function onDocPointer(e: PointerEvent): void {
  const t = e.target as Node
  if (list.value?.contains(t) || trigger.value?.contains(t)) return
  close()
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); close(); trigger.value?.focus() }
}
onMounted(() => document.addEventListener('pointerdown', onDocPointer, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer, true))
</script>

<template>
  <span class="pam">
    <button
      ref="trigger" type="button" class="pam-trigger" aria-haspopup="menu" :aria-expanded="open"
      :aria-label="title || label" :title="title || undefined" :disabled="disabled" @click="toggle"
    >{{ label }}</button>
    <Teleport to="body">
      <div v-if="open" ref="list" class="pam-list" role="menu" :aria-label="title || label" :style="pos" @keydown="onKey">
        <button
          v-for="item in items" :key="item.id" type="button" role="menuitem" class="pam-item"
          :class="{ 'is-danger': item.danger }" :data-action="item.id" :disabled="!!item.blocked"
          :title="item.blocked || undefined" @click="pick(item)"
        >
          <span class="pam-label">{{ item.label }}</span>
          <span v-if="item.blocked" class="pam-desc pam-desc--blocked">{{ item.blocked }}</span>
          <span v-else-if="item.desc" class="pam-desc">{{ item.desc }}</span>
        </button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.pam { display: inline-flex; }
.pam-trigger {
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-elevated);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
  white-space: nowrap;
  cursor: pointer;
}
.pam-trigger:hover:not(:disabled) { background: var(--bg-hover); }
.pam-trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.pam-trigger:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.pam-list {
  position: fixed;
  z-index: calc(var(--z-modal) + 200);
  display: flex;
  flex-direction: column;
  width: max-content;
  min-width: 220px;
  max-width: 340px;
  padding: var(--space-1);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-popover);
  background: var(--bg-overlay);
  box-shadow: var(--shadow-overlay);
}
.pam-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}
.pam-item:hover:not(:disabled), .pam-item:focus-visible { background: var(--bg-hover); outline: none; }
.pam-item:disabled { cursor: not-allowed; }
.pam-item:disabled .pam-label { color: var(--text-muted); }
.pam-item.is-danger .pam-label { color: var(--danger-fg); }
.pam-label { font-weight: 600; }
.pam-desc { color: var(--text-secondary); line-height: var(--lh-base); }
.pam-desc--blocked { color: var(--text-muted); }
</style>
