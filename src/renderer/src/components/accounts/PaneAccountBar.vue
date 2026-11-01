<script setup lang="ts">
/**
 * What to do next, on the pane that stopped. Out-of-quota state comes from the
 * pane as it always has; this only reads it. It floats over the terminal so the
 * PTY is not resized, and Navide never starts paying on its own: every way
 * forward here is the user's click.
 *
 * A pane can run on an API key, so the title names no kind of account. A key's
 * "credit used up" or "rejected" states have no signal yet, so they do not show
 * here.
 */
import { ref, watch } from 'vue'
import { i18n, vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{
  /** Formatted reset time, or null when the CLI did not say. */
  backAt: string | null
  switchOffered: boolean
}>()
defineEmits<{ (e: 'switch-account'): void }>()
const { t } = i18n.global

const dismissed = ref(false)
// A new reset time is a new event: the bar comes back.
watch(
  () => props.backAt,
  () => {
    dismissed.value = false
  },
)
</script>

<template>
  <div v-if="!dismissed" class="pane-account-bar" role="status" data-testid="pane-account-bar">
    <b>{{ t('settings.accounts.api-keys.pane.title') }}</b>
    <span class="pab-when" v-truncate>{{
      backAt ? t('settings.accounts.api-keys.pane.back-at', { time: backAt }) : t('settings.accounts.api-keys.pane.back-unknown')
    }}</span>
    <button v-if="switchOffered" type="button" class="pab-btn primary" data-testid="pane-account-bar-switch" @click.stop="$emit('switch-account')">
      {{ t('account-follow.quota-button') }}
    </button>
    <button type="button" class="pab-btn" @click.stop="dismissed = true">{{ t('settings.accounts.api-keys.pane.wait') }}</button>
  </div>
</template>

<style scoped>
.pane-account-bar {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 52px;
  z-index: 9;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 5px 6px 5px 10px;
  border: 1px solid var(--danger-fg);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  font-size: 11.5px;
  color: var(--text-secondary);
}
.pane-account-bar b { flex: none; font-weight: 650; color: var(--text-primary); }
.pab-when { flex: 1 1 8em; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pab-btn { flex: none; padding: 2px 8px; border: 1px solid var(--border-default); border-radius: 5px; background: transparent; color: var(--text-primary); font-size: 11px; white-space: nowrap; cursor: pointer; }
.pab-btn:hover { background: var(--bg-hover); }
.pab-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); font-weight: 600; }
/* The disconnected banner sits in this spot, and nothing here works until the backend is back. */
:global(.pane:has(.disconnected-banner) .pane-account-bar) {
  display: none;
}
</style>
