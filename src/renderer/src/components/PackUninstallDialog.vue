<script setup lang="ts">
// D8: uninstalling an Extension Pack removes only the pack by default. The
// members that were installed only because of this pack are listed, each
// unchecked, so the user chooses whether any of them go too.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useDialogFocus } from '../composables/useDialogFocus'
import { revealInvisibleValue as reveal } from '../../../shared/pluginAgentTools'

const props = defineProps<{ pack: InstalledPackRecord; busy: boolean }>()
const emit = defineEmits<{ confirm: [members: string[]]; cancel: [] }>()

const chosen = ref<string[]>([])

// Esc cancels this dialog only; it must not reach the settings modal, which
// closes on any Escape nobody handled (capture phase runs first).
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  if (!props.busy) emit('cancel')
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

// Focus starts on Cancel, the non-destructive answer.
const card = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
useDialogFocus(card, () => cancelButton.value)

function confirm(): void {
  emit('confirm', chosen.value.filter((id) => props.pack.installedByPack.includes(id)))
}
</script>

<template>
  <div class="pack-uninstall-dialog nv-dialog-scrim">
    <div
      ref="card"
      class="pack-uninstall-body nv-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="pack-uninstall-title"
      aria-describedby="pack-uninstall-desc"
      tabindex="-1"
    >
      <div class="nv-dialog-head">
        <span class="nv-dialog-icon nv-dialog-icon--danger" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg>
        </span>
        <div class="nv-dialog-heading">
          <h4 id="pack-uninstall-title" class="nv-dialog-title">{{ $t('settings.extensions.pack.uninstallTitle', { name: reveal(pack.displayName || pack.id) }) }}</h4>
          <p v-if="pack.displayName" class="pack-uninstall-id nv-dialog-subtitle"><code>{{ reveal(pack.id) }}</code></p>
        </div>
      </div>
      <div id="pack-uninstall-desc" class="nv-dialog-body">
        <p>{{ $t('settings.extensions.pack.uninstallBody') }}</p>
        <template v-if="pack.installedByPack.length">
          <p class="pack-uninstall-hint">{{ $t('settings.extensions.pack.uninstallMembersHint') }}</p>
          <div class="pack-uninstall-members">
            <label v-for="id in pack.installedByPack" :key="id" class="pack-uninstall-member" :data-member="id">
              <input v-model="chosen" type="checkbox" class="nv-check" :value="id" />
              <code>{{ reveal(id) }}</code>
            </label>
          </div>
        </template>
      </div>
      <div class="pack-uninstall-actions nv-dialog-actions">
        <button ref="cancelButton" class="pack-uninstall-cancel nv-btn" :disabled="busy" @click="$emit('cancel')">
          {{ $t('settings.extensions.trust.cancel') }}
        </button>
        <button class="pack-uninstall-confirm nv-btn nv-btn--danger" :disabled="busy" @click="confirm">
          {{
            chosen.length
              ? $t('settings.extensions.pack.uninstallWithMembers', { count: chosen.length })
              : $t('settings.extensions.pack.uninstallOnly')
          }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pack-uninstall-dialog {
  position: fixed;
  inset: 0;
  /* Above the settings modal chrome (.s-close is z-index 30 in the same
     stacking context), so nothing behind the dialog can be clicked. */
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pack-uninstall-id code {
  font-family: var(--font-mono);
}
.pack-uninstall-hint {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.pack-uninstall-members {
  display: grid;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.pack-uninstall-member {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 12px;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out);
}
.pack-uninstall-member + .pack-uninstall-member {
  border-top: 1px solid var(--border-muted);
}
.pack-uninstall-member:hover {
  background: var(--bg-hover-faint);
}
.pack-uninstall-member code {
  font-family: var(--font-mono);
  font-size: var(--font-xs);
}
</style>
