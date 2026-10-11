<script setup lang="ts">
/**
 * Per synced section, how many items this machine and the cloud hold, how
 * many match or conflict, and who wrote last. Counts only — the items
 * themselves stay on their own tabs. Memory is not synced, so it is not here.
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../../composables/useBackend'
import { scopeCounts, useSyncInventory } from '../../composables/useSyncInventory'
import { CLOUD_SCOPES, deviceLabel } from '../../lib/sharing'
import SettingRow from '../settings/SettingRow.vue'
import SettingsCard from '../settings/SettingsCard.vue'
import SettingsSection from '../settings/SettingsSection.vue'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()
const { view, error, loading, refresh } = useSyncInventory(props.backend)

onMounted(() => {
  void refresh()
})

const when = (at: string): string => (at ? new Date(at).toLocaleString() : '—')

/** One notice for the whole section when nothing per-scope can be said. */
const notice = computed<'not-connected' | 'no-key' | 'error' | null>(() => {
  if (error.value) return 'error'
  if (!view.value) return null
  if (view.value.status === 'not-connected') return 'not-connected'
  if (CLOUD_SCOPES.some((scope) => view.value?.scopes[scope]?.status === 'no-key')) return 'no-key'
  return null
})

const rows = computed(() =>
  CLOUD_SCOPES.map((scope) => {
    const scoped = view.value?.scopes[scope]
    const enabled = Boolean(view.value?.scopeEnabled[scope])
    const counts = scoped?.status === 'ok' ? scopeCounts(scoped.items) : null
    const writer = counts?.lastWrite
      ? view.value?.devices.find((d) => d.deviceId === counts.lastWrite?.deviceId)
      : undefined
    return { scope, enabled, counts, writer }
  }),
)
</script>

<template>
  <SettingsSection :label="t('settings.cloud.inventory.title')">
    <p class="inv-hint">{{ t('settings.cloud.inventory.hint') }}</p>
    <p v-if="notice" class="inv-notice" :data-notice="notice">
      {{ t('settings.cloud.inventory.notice-' + notice) }}
    </p>
    <SettingsCard v-else-if="view">
      <SettingRow
        v-for="row in rows"
        :key="row.scope"
        :title="t('settings.sync.scope-' + row.scope)"
        :description="
          !row.enabled
            ? t('settings.cloud.inventory.sync-off')
            : row.counts?.lastWrite
              ? t('settings.cloud.inventory.last-write', {
                  device: deviceLabel(row.counts.lastWrite.deviceId, row.writer?.deviceName),
                  when: when(row.counts.lastWrite.at),
                })
              : t('settings.cloud.inventory.no-writes')
        "
        :data-inventory-scope="row.scope"
      >
        <template #control>
          <span v-if="row.counts" class="inv-counts">
            {{ t('settings.cloud.inventory.counts', { local: row.counts.local, cloud: row.counts.cloud, inSync: row.counts.inSync, conflict: row.counts.conflict }) }}
          </span>
        </template>
      </SettingRow>
    </SettingsCard>
    <div class="inv-actions">
      <button type="button" :disabled="loading" @click="refresh">
        {{ t('settings.cloud.inventory.refresh') }}
      </button>
    </div>
  </SettingsSection>
</template>

<style scoped>
.inv-hint,
.inv-notice {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0 0 8px;
}
.inv-counts {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.inv-actions {
  margin-top: 8px;
}
</style>
