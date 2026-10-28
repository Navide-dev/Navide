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
  /**
   * Its pages are unfolded under it: the selected page row carries the
   * selection, so this row shows only an expanded state (except in the
   * icon-only rail, where the pages are hidden and it is the selection again).
   */
  expanded?: boolean
}>()

const emit = defineEmits<{
  select: []
}>()
</script>

<template>
  <button
    type="button"
    class="settings-nav-item"
    :class="{ active, expanded }"
    :title="label"
    :aria-current="active && !expanded ? 'page' : undefined"
    :aria-expanded="expanded || undefined"
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
}
/* Only the hover eases in. A row that loses the selection (or the pointer)
   clears at once, so it never shows a fading fill next to the new active row. */
.settings-nav-item:hover {
  background: var(--bg-hover);
  transition: background-color 120ms ease, color 120ms ease;
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
  padding: 0 5px;
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
/* An "on" state is a short labelled pill after the label ("Dev"), with the
   full meaning in its tooltip and accessible label. */
.settings-nav-item-marker--on {
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  white-space: nowrap;
}
.settings-nav-item-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
/* A badge or marker takes only its own width at the right edge: the row's
   right padding shrinks to make room for it and the gap before it halves,
   so the label keeps the rest of the width ("Плагины Navide", "Navide
   プラグイン" stay on one line beside their marker at 1280). */
@media (min-width: 721px) {
  .settings-nav-item:has(.settings-nav-item-badge, .settings-nav-item-marker) {
    padding-right: 6px;
    gap: 4px;
  }
  .settings-nav-item:has(.settings-nav-item-badge, .settings-nav-item-marker) .settings-nav-item-label {
    margin-left: 4px;
  }
}
/* Up to two lines per row: a label too long for the sidebar (ja-JP "Navide
   マーケットプレイス", es-ES "Complementos de Navide") wraps under its own
   first letter (not under the icon), and only a third line ends in an
   ellipsis, with the full name in the tooltip. A badge or marker after it
   keeps its own width at the row's right edge. */
.settings-nav-item-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow-wrap: break-word;
  line-height: 1.3;
}

/* Expanded parent: a heading for the page rows under it, not a second
   selection. It marks that it contains the selection with accent text and
   icon only: normal weight, no fill, no indicator bar. The page row under it
   carries the only fill. */
@media (min-width: 721px) {
  .settings-nav-item.active.expanded {
    background: transparent;
    color: var(--accent-fg);
    font-weight: 400;
  }
  .settings-nav-item.active.expanded:hover {
    background: var(--bg-hover);
  }
  .settings-nav-item.active.expanded::before {
    display: none;
  }
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
