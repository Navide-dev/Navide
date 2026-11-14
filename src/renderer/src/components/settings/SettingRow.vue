<script setup lang="ts">
import { computed } from 'vue'
import { leadSentence } from '../../lib/leadSentence'
/**
 * A single settings row: title (+ optional description) on the left, a
 * right-aligned `control` slot on the right.
 */
const props = defineProps<{
  /** Left out when the page title already names the row. */
  title?: string
  description?: string
  /**
   * Show only the description's first sentence; the rest folds into the
   * shared "Learn more" disclosure under it (for descriptions that would run
   * past two lines).
   */
  foldDescription?: boolean
  /** Marks a setting a CLI reads once at start: panes already open keep the
   *  old value until they are rebuilt. */
  newPanesOnly?: boolean
}>()
const folded = computed(() => (props.foldDescription && props.description ? leadSentence(props.description) : null))
</script>

<template>
  <div class="setting-row">
    <div class="setting-row-text">
      <div v-if="title" class="setting-row-title">
        {{ title }}<span
          v-if="newPanesOnly"
          class="setting-row-applies"
          data-testid="setting-row-new-panes-only"
          :title="$t('settings.applies.new-panes-only-tooltip')"
        >{{ $t('settings.applies.new-panes-only') }}</span>
      </div>
      <div v-if="description" class="setting-row-desc"><slot name="description">{{ folded ? folded.lead : description }}</slot></div>
      <details v-if="folded?.rest" class="settings-more">
        <summary>{{ $t('action.learn-more') }}</summary>
        <p>{{ folded.rest }}</p>
      </details>
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
.setting-row-applies {
  margin-left: 8px;
  padding: 0 6px;
  border-radius: 99px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-row-desc);
  font-weight: 500;
  white-space: nowrap;
}
.setting-row-desc {
  /* A readable measure: wide windows otherwise run a hint to 130+ characters. */
  max-width: 75ch;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.settings-more { margin-top: 2px; }
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
