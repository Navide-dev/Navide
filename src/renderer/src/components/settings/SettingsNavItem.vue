<script setup lang="ts">
import { vTruncate } from '@navide/plugin-ui/foundation'
/**
 * Sidebar nav item. Clickable full-width row with an optional `icon` slot and
 * a text label; emits `select` on activation. Keyboard-accessible via button.
 */
defineProps<{
  label: string
  active?: boolean
  /** Numeric badge after the label (e.g. pending updates); hidden at 0. */
  badge?: number
  /** State of pages folded under this row (a warning, or "On"), named by `label`. */
  marker?: { text: string; tone: 'risk' | 'on'; label: string } | null
}>()

const emit = defineEmits<{
  select: []
}>()
</script>

<template>
  <button
    type="button"
    class="settings-nav-item"
    :class="{ active }"
    :title="label"
    :aria-current="active ? 'page' : undefined"
    @click="emit('select')"
  >
    <span class="settings-nav-item-icon">
      <slot name="icon"></slot>
    </span>
    <span class="settings-nav-item-label" v-truncate>{{ label }}</span>
    <span v-if="badge" class="settings-nav-item-badge">{{ badge }}</span>
    <span
      v-if="marker"
      class="settings-nav-item-marker"
      :class="`settings-nav-item-marker--${marker.tone}`"
      role="img"
      :aria-label="marker.label"
      :title="marker.label"
    >{{ marker.text }}</span>
  </button>
</template>

<style scoped>
.settings-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px var(--space-row-x);
  border: none;
  background: transparent;
  border-radius: var(--radius-control);
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
  font-size: var(--font-row-title);
  transition: background-color 120ms ease, color 120ms ease;
}
.settings-nav-item:hover {
  background: var(--bg-hover);
}
.settings-nav-item:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: -1px;
}
.settings-nav-item.active {
  background: var(--bg-selected);
  /* accent-bright: the selected label stays >= 4.5:1 on its tinted row. */
  color: var(--accent-bright);
  font-weight: 600;
}
/* Left indicator bar on the active row (Cursor-style). */
.settings-nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  border-radius: 0 2px 2px 0;
  background: var(--accent-emphasis);
}
.settings-nav-item-badge {
  margin-left: auto;
  flex-shrink: 0;
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: var(--font-2xs);
  font-weight: 600;
  line-height: 18px;
  text-align: center;
}
.settings-nav-item-marker {
  margin-left: auto;
  flex: none;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  font-weight: 600;
  line-height: 18px;
}
.settings-nav-item-badge + .settings-nav-item-marker {
  margin-left: 4px;
}
.settings-nav-item-marker--risk {
  background: var(--risk-subtle);
  color: var(--risk-fg);
}
.settings-nav-item-marker--on {
  background: var(--bg-muted);
  color: var(--text-primary);
}
.settings-nav-item-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
/* A long label wraps onto a second line instead of being cut off: some
   languages cannot shorten a name the glossary fixes (es-ES "Complementos de
   Navide" is 14px wider than the sidebar). */
.settings-nav-item-label {
  min-width: 0;
  white-space: normal;
  overflow-wrap: break-word;
  line-height: 1.3;
}

/* Narrow modal: collapse to an icon-only rail. The label stays in the
   accessibility tree (visually hidden, not display:none) and the button's
   title attribute provides a hover tooltip. */
@media (max-width: 720px) {
  .settings-nav-item {
    justify-content: center;
    gap: 0;
    padding: 8px 0;
  }
  .settings-nav-item-label {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    overflow: hidden;
    white-space: nowrap;
  }
  .settings-nav-item-marker {
    display: none;
  }
}
</style>
