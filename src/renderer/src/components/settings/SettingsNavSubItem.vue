<script setup lang="ts">
import { vTruncate } from '@navide/plugin-ui/foundation'
/**
 * A page inside one sidebar entry (Navide Plugins → Execution Policy, …):
 * an indented text row under its parent SettingsNavItem; emits `select`.
 * Hidden in the icon-only rail, where the page itself shows its pages.
 * `marker` puts the page's state on its row (a warning, or "On"), with
 * `label` naming what it stands for.
 */
defineProps<{
  label: string
  active?: boolean
  marker?: { text: string; tone: 'risk' | 'on'; label: string } | null
}>()

const emit = defineEmits<{
  select: []
}>()
</script>

<template>
  <button
    type="button"
    class="settings-nav-subitem"
    :class="{ active }"
    :title="label"
    :aria-current="active ? 'page' : undefined"
    @click="emit('select')"
  >
    <span class="settings-nav-subitem-label" v-truncate>{{ label }}</span>
    <span
      v-if="marker"
      class="settings-nav-subitem-marker"
      :class="`settings-nav-subitem-marker--${marker.tone}`"
      role="img"
      :aria-label="marker.label"
      :title="marker.label"
    >{{ marker.text }}</span>
  </button>
</template>

<style scoped>
.settings-nav-subitem {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 32px;
  padding: 4px var(--space-row-x) 4px calc(var(--space-row-x) + 16px);
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-row-title);
  text-align: left;
  cursor: pointer;
}
/* A guide line ties the pages to the entry they belong to. */
.settings-nav-subitem::before {
  content: '';
  position: absolute;
  left: calc(var(--space-row-x) + 7px);
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-default);
}
.settings-nav-subitem.active::before {
  width: 2px;
  background: var(--accent-emphasis);
}
/* Only the hover eases in; losing the selection clears at once. */
.settings-nav-subitem:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  transition: background-color 120ms ease, color 120ms ease;
}
.settings-nav-subitem:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: -1px;
}
.settings-nav-subitem.active {
  background: var(--bg-selected);
  color: var(--accent-bright);
  font-weight: 600;
}
.settings-nav-subitem-marker {
  flex: none;
  margin-left: auto;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  font-weight: 600;
  line-height: 18px;
}
.settings-nav-subitem-marker--risk {
  background: var(--risk-subtle);
  color: var(--risk-fg);
}
.settings-nav-subitem-marker--on {
  background: var(--bg-muted);
  color: var(--text-primary);
}
/* Up to two lines per row: a long page name ("Developer and native code",
   de-DE "Entwickler und nativer Code") wraps under its own first letter;
   only a third line ends in an ellipsis, with the full name in the tooltip.
   The marker after it keeps its own width at the row's right edge. */
.settings-nav-subitem-label {
  flex: 1 1 auto;
  min-width: 0;
  margin-right: 6px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow-wrap: break-word;
  line-height: 1.3;
}
@media (max-width: 720px) {
  .settings-nav-subitem {
    display: none;
  }
}
</style>
