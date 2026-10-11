<script setup lang="ts">
/**
 * The Navide Cloud page's sub-tab bar — Sync, Share, Devices — and the three
 * slots it switches between. Sync is always mounted (it holds the page's
 * existing content, which listens for sync events from the moment Settings
 * opens); Share and Devices mount on first visit and stay, so leaving and
 * coming back keeps what they loaded.
 */
import { reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

export type CloudSubtab = 'sync' | 'share' | 'devices'

const model = defineModel<CloudSubtab>({ default: 'sync' })
const { t } = useI18n()

const order: CloudSubtab[] = ['sync', 'share', 'devices']
const visited = reactive(new Set<CloudSubtab>(['sync']))
watch(model, (tab) => visited.add(tab), { immediate: true })
</script>

<template>
  <div class="nvc-subtabs" role="tablist" :aria-label="t('settings.cloud.subtab.aria')">
    <button
      v-for="tab in order"
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
  <div v-show="model === 'sync'" role="tabpanel" data-subtab-panel="sync">
    <slot name="sync"></slot>
  </div>
  <div v-if="visited.has('share')" v-show="model === 'share'" role="tabpanel" data-subtab-panel="share">
    <slot name="share"></slot>
  </div>
  <div v-if="visited.has('devices')" v-show="model === 'devices'" role="tabpanel" data-subtab-panel="devices">
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
