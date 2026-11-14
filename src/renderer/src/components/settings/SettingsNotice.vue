<script setup lang="ts">
/**
 * The one notice for Settings pages: a 2px edge and an icon in the tone's
 * colour over a quiet surface, one sentence (`message` or the default slot)
 * and an optional `action` slot on the right. Every page uses this instead of
 * its own filled box or callout.
 */
withDefaults(defineProps<{
  tone?: 'info' | 'warning' | 'danger'
  message?: string
}>(), {
  tone: 'warning',
  message: undefined,
})
</script>

<template>
  <div class="settings-notice" :class="`settings-notice--${tone}`">
    <svg class="settings-notice-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <template v-if="tone === 'info'">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 7.2v3.6M8 5.1v.1" />
      </template>
      <template v-else>
        <path d="M7.1 2.6 1.9 12a1 1 0 0 0 .9 1.5h10.4a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z" />
        <path d="M8 6.2v3M8 11.3v.1" />
      </template>
    </svg>
    <div class="settings-notice-body">
      <p v-if="message" class="settings-notice-message">{{ message }}</p>
      <slot></slot>
    </div>
    <div v-if="$slots.action" class="settings-notice-action"><slot name="action"></slot></div>
  </div>
</template>

<style scoped>
.settings-notice {
  --notice-tone: var(--risk-fg);
  display: flex;
  align-items: flex-start;
  gap: var(--space-3, 12px);
  box-sizing: border-box;
  max-width: 100%;
  margin: 0 0 var(--space-3, 12px);
  padding: var(--space-2, 8px) var(--space-row-x, 12px);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  box-shadow: inset 2px 0 0 var(--notice-tone);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}
.settings-notice--info { --notice-tone: var(--accent-fg); }
.settings-notice--danger { --notice-tone: var(--danger-fg); }
.settings-notice-icon {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  color: var(--notice-tone);
}
.settings-notice-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  max-width: 72ch;
}
.settings-notice-body :deep(p) { margin: 0; }
.settings-notice-action {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  align-self: center;
}
</style>
