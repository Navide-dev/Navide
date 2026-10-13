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
  <SettingRow
    data-settings-section="general-recent-workspaces-limit"
    :title="$t('recentWorkspaces.limit-title')"
    :description="$t('recentWorkspaces.limit-hint')"
  >
    <template #control>
      <div v-if="loaded" class="row-g gap">
        <template v-if="bounded">
          <span class="s-ctrl-label">{{ $t('recentWorkspaces.limit-on') }}</span>
          <input
            type="number"
            min="1"
            :value="limit"
            @change="onChange(($event.target as HTMLInputElement).value)"
          />
        </template>
        <span v-else class="s-ctrl-label">{{ $t('recentWorkspaces.limit-off') }}</span>
        <ToggleSwitch
          :model-value="bounded"
          :aria-label="$t('recentWorkspaces.limit-title')"
          @update:model-value="onToggle"
        />
      </div>
    </template>
  </SettingRow>
</template>
