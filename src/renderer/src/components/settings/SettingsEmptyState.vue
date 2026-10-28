<script setup lang="ts">
/**
 * The one empty state for Settings lists: an optional icon, one sentence that
 * says what is missing, and an optional action (default slot). Every page uses
 * this instead of its own dashed box, bar or illustration.
 */
defineProps<{
  message: string
}>()
</script>

<template>
  <div class="settings-empty">
    <span v-if="$slots.icon" class="settings-empty-icon" aria-hidden="true"><slot name="icon" /></span>
    <p class="settings-empty-message">{{ message }}</p>
    <div v-if="$slots.default" class="settings-empty-actions"><slot /></div>
  </div>
</template>

<style scoped>
.settings-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2, 8px);
  padding: var(--space-4, 16px);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: var(--font-sm);
  line-height: var(--lh-base);
  text-align: center;
}
.settings-empty-icon {
  display: inline-flex;
  color: var(--text-muted);
}
.settings-empty-icon :deep(svg) {
  width: 20px;
  height: 20px;
}
.settings-empty-message {
  margin: 0;
  max-width: 48ch;
  text-wrap: pretty;
}
.settings-empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2, 8px);
}
</style>
