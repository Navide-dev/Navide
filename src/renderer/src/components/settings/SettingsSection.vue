<script setup lang="ts">
/**
 * A titled sub-section: a small uppercase label above its default slot.
 * Without a label (the page title already names it) only the spacing stays.
 */
defineProps<{
  label?: string
}>()
</script>

<template>
  <section class="settings-section">
    <div v-if="label" class="settings-section-label">{{ label }}</div>
    <slot></slot>
  </section>
</template>

<style scoped>
.settings-section {
  margin-top: var(--space-group);
}
.settings-section-label {
  font-size: var(--font-row-desc);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
</style>
