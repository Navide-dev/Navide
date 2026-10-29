<script setup lang="ts">
/**
 * Settings → General: the Recent list's storage safety bound. Recent keeps
 * every opened workspace until the user removes it; this only caps storage,
 * and the switch turns it off entirely.
 */
import { computed } from 'vue'
import type { useBackend } from '../../composables/useBackend'
import { useRecentWorkspaces } from '../../composables/useRecentWorkspaces'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'

const DEFAULT_LIMIT = 1000

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { limit, loaded, setLimit } = useRecentWorkspaces(props.backend)

const bounded = computed(() => limit.value !== null)

function onToggle(on: boolean): void {
  void setLimit(on ? DEFAULT_LIMIT : null)
}

function onChange(raw: string): void {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n === limit.value) return
  void setLimit(n)
}
</script>

<template>
  <!-- One row per control: the switch, then (while on) the bound itself. -->
  <SettingRow
    data-settings-section="general-recent-workspaces-limit"
    :title="$t('recentWorkspaces.limit-title')"
    :description="$t('recentWorkspaces.limit-hint')"
  >
    <template #control>
      <ToggleSwitch
        v-if="loaded"
        :model-value="bounded"
        :aria-label="$t('recentWorkspaces.limit-title')"
        @update:model-value="onToggle"
      />
    </template>
  </SettingRow>
  <SettingRow v-if="loaded && bounded" :title="$t('recentWorkspaces.limit-count')">
    <template #control>
      <input
        class="nv-input recent-limit-input"
        type="number"
        min="1"
        :value="limit"
        :aria-label="$t('recentWorkspaces.limit-count')"
        @change="onChange(($event.target as HTMLInputElement).value)"
      />
    </template>
  </SettingRow>
</template>

<style scoped>
.recent-limit-input {
  width: 96px;
  box-sizing: border-box;
}
</style>
