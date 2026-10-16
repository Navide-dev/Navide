<script setup lang="ts">
import { computed, inject } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { channelsKey } from '../composables/useChannels'
import { formatChannelIdentity } from '../lib/channelIdentity'

/** Sidebar-row marker for a pane bound to a chat channel. */
const props = defineProps<{ paneId: string }>()

// Global instance, as TerminalPane does: headers mount in tests without the plugin.
const t = i18n.global.t
const store = inject(channelsKey, null)
const binding = computed(() => store?.bindingFor(props.paneId) ?? null)
const tip = computed(() => {
  const b = binding.value
  return b ? formatChannelIdentity(b, { t, state: store?.accountState(b.platform, b.account) }, 'short') : ''
})
</script>

<template>
  <span
    v-if="binding"
    class="channel-tag"
    data-testid="channel-sidebar-icon"
    :title="tip"
  ><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 3.4h10.8v7.2H7l-3 2.4v-2.4H2.6Z" /><path d="M5.4 6.2h5.2M5.4 8.2h3.2" /></svg></span>
</template>

<style scoped>
/* Same shape as the sidebar row's muted marker, in the accent colour so a bound pane stands out. */
.channel-tag { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--accent-fg); }
</style>
