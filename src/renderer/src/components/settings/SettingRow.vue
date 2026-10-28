<script setup lang="ts">
/**
 * A single settings row: title (+ optional description) on the left, a
 * right-aligned `control` slot on the right.
 */
defineProps<{
  /** Left out when the page title already names the row. */
  title?: string
  description?: string
}>()
</script>

<template>
  <div class="setting-row">
    <div class="setting-row-text">
      <div v-if="title" class="setting-row-title">{{ title }}</div>
      <div v-if="description" class="setting-row-desc">{{ description }}</div>
    </div>
    <div class="setting-row-control">
      <slot name="control"></slot>
    </div>
  </div>
</template>

<style scoped>
.setting-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px var(--space-row-x);
  padding: var(--space-row-y) var(--space-row-x);
}
/* The text keeps a readable basis; a control too wide to sit beside it wraps
   onto its own line instead of squeezing the text to one word per line. */
.setting-row-text {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.setting-row-title {
  font-size: var(--font-row-title);
  font-weight: 600;
  color: var(--text-bright);
}
.setting-row-desc {
  /* A readable measure: wide windows otherwise run a hint to 130+ characters. */
  max-width: 75ch;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.setting-row-control {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  /* Two buttons side by side never touch. */
  gap: 8px;
  flex-shrink: 0;
  max-width: 100%;
}
</style>
