<script setup lang="ts">
// Shown in the Git tab when the bundled navide.git v2 package failed to
// activate. It explains why and offers the same factory restore the
// Settings → Navide Plugins bundled row uses; on success the Host leaves
// recovery and the v2 panel replaces this one.
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ipcErrorMessage } from '../composables/usePluginInstallFlow'

defineProps<{ reason?: string }>()

const { t } = useI18n()
const reinstalling = ref(false)
const reinstallError = ref('')

async function reinstall(): Promise<void> {
  const restore = window.agentTeam?.plugins?.restoreFactoryPackage
  if (!restore || reinstalling.value) return
  reinstalling.value = true
  reinstallError.value = ''
  try {
    await restore('navide.git')
  } catch (err) {
    reinstallError.value = ipcErrorMessage(err)
  } finally {
    reinstalling.value = false
  }
}
</script>

<template>
  <div class="git-recovery-panel" role="alert" data-git-recovery-panel>
    <strong class="git-recovery-panel__title">{{ t('git.recovery-title') }}</strong>
    <p v-if="reason" class="git-recovery-panel__reason" data-git-recovery-reason>
      {{ t('git.recovery-reason', { reason }) }}
    </p>
    <button
      type="button"
      class="ghost"
      data-git-recovery-reinstall
      :disabled="reinstalling"
      @click="reinstall"
    >
      {{ t(reinstalling ? 'git.recovery-reinstalling' : 'git.recovery-reinstall') }}
    </button>
    <p v-if="reinstallError" class="git-recovery-panel__error" data-git-recovery-error>
      {{ t('git.recovery-reinstall-failed', { reason: reinstallError }) }}
    </p>
  </div>
</template>

<style scoped>
.git-recovery-panel {
  align-items: flex-start;
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  font-size: 12px;
  gap: 8px;
  padding: 16px;
}

.git-recovery-panel__title {
  color: var(--text-primary);
}

.git-recovery-panel__reason,
.git-recovery-panel__error {
  margin: 0;
  overflow-wrap: anywhere;
}

.git-recovery-panel__error {
  color: var(--danger-fg);
}
</style>
