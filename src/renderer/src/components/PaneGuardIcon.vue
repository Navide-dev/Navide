<script setup lang="ts">
import { computed, inject } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { guardKey } from '../composables/useGuard'

/** Sidebar-row marker for a pane Navide Guard marks as externally influenced. */
const props = defineProps<{ paneId: string }>()

// Global instance, as TerminalPane does: rows mount in tests without the plugin.
const t = i18n.global.t
const store = inject(guardKey, null)
const tainted = computed(() => !!store?.available.value && !!store.taintFor(props.paneId))
// With the Guard switch off the mark is kept, but nothing is asked for.
const title = computed(() =>
  store?.enabled.value === false ? `${t('guard.pane.badge')} — ${t('guard.pane.explain-off')}` : t('guard.pane.badge')
)
</script>

<template>
  <span
    v-if="tainted"
    class="guard-tag"
    data-testid="guard-sidebar-icon"
    :title="title"
  ><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4Z" /><path d="M8 5.2v3.2M8 10.6v0.01" /></svg></span>
</template>

<style scoped>
/* Same shape as the sidebar's channel marker, in the attention colour. */
.guard-tag { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--attention-fg); }
</style>
