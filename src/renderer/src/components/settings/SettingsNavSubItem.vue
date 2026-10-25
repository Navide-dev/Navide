<script setup lang="ts">
import { vTruncate } from '@navide/plugin-ui/foundation'
/**
 * A page inside one sidebar entry (Navide Plugins → Execution Policy, …):
 * an indented text row under its parent SettingsNavItem; emits `select`.
 * Hidden in the icon-only rail, where the page itself shows its pages.
 */
defineProps<{
  label: string
  active?: boolean
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
    :aria-current="active ? 'page' : undefined"
    @click="emit('select')"
  >
    <span class="settings-nav-subitem-label" v-truncate>{{ label }}</span>
  </button>
</template>

<style scoped>
.settings-nav-subitem {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 32px;
  padding: 4px var(--space-row-x) 4px calc(var(--space-row-x) + 16px);
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.settings-nav-subitem:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
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
.settings-nav-subitem-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 720px) {
  .settings-nav-subitem {
    display: none;
  }
}
</style>
