<script setup lang="ts">
// Notifications popover, anchored to the status-bar bell (same backdrop +
// fixed-card shape as ClockPanel). The two switches are the Settings →
// Notifications toggles; App.vue binds them to the shared prefs in
// useNotifyPrefs, so this component only renders and asks.
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import ToggleSwitch from './settings/ToggleSwitch.vue'

defineProps<{
  systemNotify: boolean
  notifySound: boolean
  /** usePermissions' notifications status; 'not-applicable' hides the row. */
  permissionStatus: string
}>()
const emit = defineEmits<{
  'update:systemNotify': [value: boolean]
  'update:notifySound': [value: boolean]
  'open-settings': []
  close: []
}>()

const { t } = useI18n()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="nt-backdrop" @click="emit('close')" />
  <div class="nt-pop nv-popover" @click.stop>
    <div class="nt-head">
      <span class="nt-head-title">{{ t('settings.nav.notifications') }}</span>
      <button class="nt-btn" data-act="close" :title="t('notifyBar.close')" @click="emit('close')">✕</button>
    </div>
    <div class="nt-rows">
      <div class="nt-row" data-row="system-notify">
        <span class="nt-k">{{ t('settings.general.system-notify') }}</span>
        <ToggleSwitch
          :model-value="systemNotify"
          :aria-label="t('settings.general.system-notify')"
          @update:model-value="emit('update:systemNotify', $event)"
        />
      </div>
      <div class="nt-row" data-row="notify-sound">
        <span class="nt-k">{{ t('settings.general.notify-sound') }}</span>
        <ToggleSwitch
          :model-value="notifySound"
          :aria-label="t('settings.general.notify-sound')"
          @update:model-value="emit('update:notifySound', $event)"
        />
      </div>
    </div>
    <div class="nt-foot">
      <span
        v-if="permissionStatus !== 'not-applicable'"
        class="nt-perm"
        :class="{ 'nt-denied': permissionStatus === 'denied' }"
        data-row="permission"
      >{{ t('notifyBar.permission-line', {
        label: t('settings.general.notify-permission'),
        status: t(`settings.general.notify-permission-status.${permissionStatus}`),
      }) }}</span>
      <button class="nt-link" data-act="open-settings" @click="emit('open-settings')">{{ t('notifyBar.open-settings') }} ›</button>
    </div>
  </div>
</template>

<style scoped>
.nt-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.nt-pop {
  position: fixed;
  right: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 300px;
  border-radius: var(--radius-popover);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  box-shadow: var(--shadow-popover);
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.nt-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.nt-head-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-bright);
}
.nt-btn {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
  font-size: var(--font-3xs);
  cursor: pointer;
}
.nt-btn:hover { color: var(--text-bright); }
.nt-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
}
.nt-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nt-k {
  flex: 1;
  min-width: 0;
}
.nt-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border-muted);
}
.nt-perm {
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--font-3xs);
}
.nt-perm.nt-denied { color: var(--attention-fg); }
.nt-link {
  flex: none;
  margin-left: auto;
  background: none;
  border: 0;
  padding: 0;
  color: var(--accent-fg);
  font-size: var(--font-3xs);
  cursor: pointer;
}
.nt-link:hover { text-decoration: underline; }
</style>
