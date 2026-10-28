<script setup lang="ts">
/**
 * A toolbar's secondary actions. They sit inline while the toolbar is wide;
 * below 720px of the nearest container (the toolbar or pane that declares
 * `container-type: inline-size`) they fold into one "⋯" menu so no lone
 * button wraps onto a row of its own. The page's primary action stays
 * outside this component and therefore always visible.
 *
 * The slot renders in both places and CSS shows exactly one of them, so
 * every action keeps its own handler, disabled state and tooltip.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

withDefaults(defineProps<{
  /** Which edge of the "⋯" button the menu lines up with. */
  align?: 'start' | 'end'
}>(), { align: 'end' })

const { t } = useI18n()
const menu = ref<HTMLDetailsElement | null>(null)

function close(): void {
  if (menu.value) menu.value.open = false
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (!next || !menu.value?.contains(next)) close()
}
</script>

<template>
  <span class="settings-overflow">
    <span class="settings-overflow-inline"><slot /></span>
    <details ref="menu" class="settings-overflow-more" @keydown.esc.stop="close" @focusout="onFocusOut">
      <summary :aria-label="t('action.more-options')" :title="t('action.more-options')">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>
      </summary>
      <div class="settings-overflow-menu" :class="`settings-overflow-menu--${align}`" @click="close"><slot /></div>
    </details>
  </span>
</template>

<style scoped>
.settings-overflow,
.settings-overflow-inline {
  display: contents;
}
.settings-overflow-more {
  display: none;
  position: relative;
}
.settings-overflow-more > summary {
  display: inline-grid;
  place-items: center;
  width: var(--control-h-md, 28px);
  height: var(--control-h-md, 28px);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-muted);
  color: var(--text-primary);
  cursor: pointer;
  list-style: none;
}
.settings-overflow-more > summary::-webkit-details-marker {
  display: none;
}
.settings-overflow-more > summary:hover {
  background: var(--bg-elevated);
}
.settings-overflow-more > summary:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: 2px;
}
.settings-overflow-menu {
  position: absolute;
  top: calc(100% + 4px);
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 200px;
  padding: 4px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-elevated);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.settings-overflow-menu--start { left: 0; }
.settings-overflow-menu--end { right: 0; }
.settings-overflow-menu > :slotted(button) {
  justify-content: flex-start;
  width: 100%;
  margin: 0;
  border-color: transparent;
  background: transparent;
  text-align: left;
  white-space: nowrap;
}
.settings-overflow-menu > :slotted(button:hover:not(:disabled)) {
  background: var(--bg-hover);
}
@container (max-width: 720px) {
  .settings-overflow-inline {
    display: none;
  }
  .settings-overflow-more {
    display: inline-block;
  }
}
</style>
