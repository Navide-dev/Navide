<script setup lang="ts">
/**
 * The devices that have written to this account's cloud, newest write first,
 * from the same `sync.inventory` read the Sync sub-tab uses.
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import { useSyncInventory } from '../../composables/useSyncInventory'
import { deviceLabel } from '../../lib/sharing'
import SettingsCard from '../settings/SettingsCard.vue'
import SettingsSection from '../settings/SettingsSection.vue'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()
const { view, error, loading, refresh } = useSyncInventory(props.backend)

onMounted(() => {
  if (!view.value) void refresh()
})

const when = (at: string): string => (at ? new Date(at).toLocaleString() : '—')
const devices = computed(() => view.value?.devices ?? [])
</script>

<template>
  <SettingsSection :label="t('settings.cloud.devices.title')">
    <p class="dev-hint">{{ t('settings.cloud.devices.hint') }}</p>
    <p v-if="error" class="dev-note" data-notice="error">{{ t('settings.cloud.inventory.notice-error') }}</p>
    <p v-else-if="view?.status === 'not-connected'" class="dev-note" data-notice="not-connected">
      {{ t('settings.cloud.inventory.notice-not-connected') }}
    </p>
    <p v-else-if="view && !devices.length" class="dev-note">{{ t('settings.cloud.devices.none') }}</p>
    <SettingsCard v-else-if="devices.length">
      <ul class="dev-list">
        <li v-for="device in devices" :key="device.deviceId" class="dev-row" :data-device-id="device.deviceId">
          <span v-truncate="device.deviceName?.trim() || device.deviceId" class="dev-name">
            {{ deviceLabel(device.deviceId, device.deviceName) }}
          </span>
          <span class="dev-when">{{ t('settings.cloud.devices.last-write', { when: when(device.lastWriteAt) }) }}</span>
          <span class="dev-when">{{ t('settings.cloud.devices.last-seen', { when: when(device.lastSeenAt) }) }}</span>
        </li>
      </ul>
    </SettingsCard>
    <div class="dev-actions">
      <button type="button" :disabled="loading" @click="refresh">{{ t('settings.cloud.devices.refresh') }}</button>
    </div>
  </SettingsSection>
</template>

<style scoped>
.dev-hint,
.dev-note {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0 0 8px;
}
.dev-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.dev-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: center;
  padding: var(--space-row-y) var(--space-row-x);
}
.dev-row + .dev-row {
  border-top: 1px solid var(--border-muted);
}
.dev-name {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dev-when {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  white-space: nowrap;
}
.dev-actions {
  margin-top: 8px;
}
</style>
