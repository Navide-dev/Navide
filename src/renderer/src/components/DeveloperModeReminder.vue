<script setup lang="ts">
// Card K4: while Developer Mode is on, every launch says so (as Chrome does
// for developer-mode extensions), so it is not left on and forgotten. The
// notice can be closed for this launch only; the switch itself is changed in
// Settings → Navide Plugins.
import { onMounted, ref } from 'vue'

const enabled = ref(false)
const dismissed = ref(false)

onMounted(async () => {
  try {
    enabled.value = (await window.agentTeam?.plugins?.developerMode?.())?.enabled === true
  } catch {
    // No answer, no notice; the Settings banner still shows the state.
  }
})
</script>

<template>
  <div v-if="enabled && !dismissed" class="nv-devmode-reminder" role="status">
    <p>{{ $t('settings.extensions.developerMode.reminder') }}</p>
    <button type="button" class="nv-devmode-reminder-close nv-btn nv-btn--sm" @click="dismissed = true">
      {{ $t('settings.extensions.developerMode.reminderClose') }}
    </button>
  </div>
</template>

<style scoped>
.nv-devmode-reminder {
  position: fixed;
  left: 50%;
  bottom: var(--space-6);
  z-index: 35;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  max-width: min(560px, calc(100vw - 32px));
  padding: 10px 12px 10px 14px;
  border-left: 3px solid var(--risk-fg);
  border-radius: var(--radius-sm);
  background: var(--risk-subtle);
  color: var(--risk-fg);
  font-size: var(--font-sm);
  transform: translateX(-50%);
  box-shadow: var(--shadow-md);
}
.nv-devmode-reminder p {
  margin: 0;
}
</style>
