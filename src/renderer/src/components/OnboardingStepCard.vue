<script setup lang="ts">
/**
 * OnboardingStepCard — one step of a sequential guided flow.
 *
 * Three visual states, mirroring the guided-setup pattern:
 *   done      → collapses to title + filled checkmark badge
 *   expanded  → title, description and the action slot
 *   upcoming  → title only, dimmed, click to expand
 */
defineProps<{
  title: string
  description?: string
  done?: boolean
  expanded?: boolean
  optional?: boolean
  meta?: string
  warning?: string
  /** Neutral information ahead of the action. Nothing has gone wrong. */
  notice?: string
  /** What keeps this step from running, readable while the card is collapsed. */
  blockedTag?: string
  /** A failure for this step. Shown in the card because the wizard's
   *  log pane sits below the fold and dies with the modal — a fast failure that
   *  only reached the log made the action button look like it did nothing. */
  error?: string
}>()

defineEmits<{ (e: 'toggle'): void }>()
</script>

<template>
  <div class="oc-card" :class="{ done, expanded }">
    <button type="button" class="oc-head" @click="$emit('toggle')">
      <span class="oc-title">
        {{ title }}
        <span v-if="optional" class="oc-tag">{{ $t('label.optional') }}</span>
        <span v-if="blockedTag" class="oc-tag oc-tag-blocked">{{ blockedTag }}</span>
        <span v-if="meta" class="oc-meta">{{ meta }}</span>
      </span>
      <span v-if="done" class="oc-check" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="13" height="13">
          <path
            d="M3.5 8.5l3 3 6-7"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <!-- A collapsed card would otherwise hide its own failure entirely. -->
      <span v-else-if="error && !expanded" class="oc-alert" aria-hidden="true">!</span>
    </button>

    <!-- A done card still opens on click: its actions include Re-detect, and a
         dead click was the only feedback when a user re-checked a green step. -->
    <div v-if="expanded" class="oc-body">
      <p v-if="description" class="oc-desc">{{ description }}</p>
      <p v-if="notice" class="oc-notice">{{ notice }}</p>
      <p v-if="warning" class="oc-warn" :class="{ 'oc-warn-box': blockedTag }">{{ warning }}</p>
      <p v-if="error" class="oc-error" role="alert">{{ error }}</p>
      <div class="oc-actions">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.oc-card {
  border-radius: 14px;
  background: var(--bg-subtle);
  border: 1px solid transparent;
  margin-bottom: 12px;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.oc-card.expanded {
  border-color: var(--border-default);
}
.oc-card.done {
  background: var(--bg-subtle);
}

.oc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 20px 22px;
  background: none;
  border: 0;
  text-align: left;
  cursor: pointer;
}
.oc-card.expanded .oc-head {
  padding-bottom: 8px;
}

.oc-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 17px;
  font-weight: 650;
  line-height: 1.35;
  color: var(--text-bright);
}
.oc-card:not(.expanded):not(.done) .oc-title {
  color: var(--text-secondary);
}

.oc-tag {
  font-size: var(--font-3xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 1px 5px;
}
.oc-tag-blocked {
  color: var(--attention-fg);
  border-color: currentColor;
}
.oc-meta {
  font: 11px/1 ui-monospace, Menlo, monospace;
  color: var(--text-muted);
}

.oc-check {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--success-emphasis);
  color: var(--text-on-emphasis);
}

.oc-body {
  padding: 0 22px 20px;
}
.oc-desc {
  margin: 0 0 16px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text-secondary);
}
.oc-warn {
  margin: -6px 0 14px;
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  color: var(--attention-fg);
}
.oc-warn-box {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--attention-emphasis);
  background: var(--attention-subtle);
}
.oc-notice {
  margin: -6px 0 14px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-muted);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}
.oc-error {
  margin: -6px 0 14px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--danger-emphasis);
  background: var(--danger-subtle);
  color: var(--danger-fg);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  /* brew prints its whole recipe on failure; keep the card a card. */
  max-height: 9em;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.oc-alert {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  background: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.oc-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
