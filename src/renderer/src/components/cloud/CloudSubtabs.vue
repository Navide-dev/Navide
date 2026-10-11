<script setup lang="ts">
/**
 * The Navide Cloud page's sub-tab bar — Sync, Share, Devices — and the slots
 * it switches between. The Sync slot renders bare, with no wrapper, in the
 * same place whether or not the bar is shown, so its content (the page as it
 * was before sub-tabs) is never remounted by the link coming and going; the
 * host hides it with v-show while another sub-tab is chosen. Share and
 * Devices mount on first visit and stay, so leaving and coming back keeps
 * what they loaded.
 *
 * With `enabled` false (Navide Cloud not connected) only the Sync slot
 * renders, so the page is exactly the one it was before there were sub-tabs.
 * Turning it off also forgets which tabs were visited, so a reconnect starts
 * on Sync with nothing stale.
 */
import { reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

export type CloudSubtab = 'sync' | 'share' | 'devices'

const props = withDefaults(defineProps<{ enabled?: boolean; tabs?: CloudSubtab[] }>(), {
  enabled: true,
  tabs: () => ['sync', 'share', 'devices'],
})
const model = defineModel<CloudSubtab>({ default: 'sync' })
const { t } = useI18n()

const visited = reactive(new Set<CloudSubtab>(['sync']))
watch(model, (tab) => visited.add(tab), { immediate: true })
watch(
  () => [props.enabled, props.tabs] as const,
  ([enabled, tabs]) => {
    if (!enabled) {
      visited.clear()
      visited.add('sync')
    }
    if (!enabled || !tabs.includes(model.value)) model.value = 'sync'
  },
)
</script>

<template>
  <div v-if="enabled" class="nvc-subtabs" role="tablist" :aria-label="t('settings.cloud.subtab.aria')">
    <button
      v-for="tab in tabs"
      :key="tab"
      type="button"
      role="tab"
      class="nvc-subtab"
      :class="{ active: model === tab }"
      :aria-selected="model === tab"
      :data-subtab="tab"
      @click="model = tab"
    >
      {{ t('settings.cloud.subtab.' + tab) }}
    </button>
  </div>
  <slot name="sync"></slot>
  <div
    v-if="enabled && tabs.includes('share') && visited.has('share')"
    v-show="model === 'share'"
    role="tabpanel"
    data-subtab-panel="share"
  >
    <slot name="share"></slot>
  </div>
  <div
    v-if="enabled && tabs.includes('devices') && visited.has('devices')"
    v-show="model === 'devices'"
    role="tabpanel"
    data-subtab-panel="devices"
  >
    <slot name="devices"></slot>
  </div>
</template>

<style scoped>
/* Same segmented control as the Help tab's topics. */
.nvc-subtabs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
  padding: 3px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}
.nvc-subtab {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 600;
  padding: 5px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.nvc-subtab:hover {
  color: var(--text-primary);
}
.nvc-subtab.active {
  background: var(--bg-base);
  color: var(--text-bright);
  box-shadow: 0 1px 2px var(--shadow-overlay);
}
</style>
