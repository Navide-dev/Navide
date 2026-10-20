<script setup lang="ts">
// Card K4: while Developer Mode is on, every launch says so (as Chrome does
// for developer-mode extensions), so it is not left on and forgotten. The
// notice can be closed for this launch only; the switch itself is changed in
// Settings → Navide Plugins.
import { onMounted, ref } from 'vue'

const enabled = ref(false)
const dismissed = ref(false)
// A2-5 (G5): Developer Mode settings another program wrote, said on every
// launch until the user turns the switch on or consents to the folders again.
const externalChange = ref<string | null>(null)
const reasonKey = ref('settings.extensions.developerMode.externalChange')

onMounted(async () => {
  try {
    const state = await window.agentTeam?.plugins?.developerMode?.()
    enabled.value = state?.enabled === true
    externalChange.value = state?.externalChange?.detectedAt ?? null
    const reason = state?.externalChange?.reason
    reasonKey.value = reason === 'signing-unavailable'
      ? 'settings.extensions.developerMode.externalChangeUnsigned'
      : reason === 'signature-missing' ? 'settings.extensions.developerMode.externalChangeMissing' : 'settings.extensions.developerMode.externalChange'
  } catch {
    // No answer, no notice; the Settings banner still shows the state.
  }
})
</script>

<template>
  <div v-if="(enabled || externalChange) && !dismissed" class="nv-devmode-reminder" role="status">
    <div class="nv-devmode-reminder-text">
      <p v-if="enabled">{{ $t('settings.extensions.developerMode.reminder') }}</p>
      <p v-if="externalChange" class="nv-devmode-reminder-external">
        {{ $t(reasonKey, { time: new Date(externalChange).toLocaleString() }) }}
      </p>
    </div>
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
