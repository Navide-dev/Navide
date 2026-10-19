<script setup lang="ts">
// The user's yes before an agent's cli_account_switch switches a CLI account
// (plan mcp_614482 P3). Presentation only: lib/agentSignIn's
// createSignInConfirm holds the request and closes it at its deadline.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AgentAccountSwitchConfirmRequest } from '../lib/agentAccountSwitch'
import { useDialogFocus } from '../composables/useDialogFocus'
import { revealInvisibleText } from '../../../shared/pluginAgentTools'

const props = defineProps<{ request: AgentAccountSwitchConfirmRequest }>()
const emit = defineEmits<{ answer: [confirmed: boolean] }>()

// The agent wrote the reason, and the pane name can be set by one: invisible
// and direction-changing characters are shown, not applied.
const reason = computed(() => revealInvisibleText(props.request.reason))
const caller = computed(() => revealInvisibleText(props.request.callerName || props.request.callerPaneId))

// Esc is a no, and must not reach anything behind the dialog.
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  emit('answer', false)
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

// Focus starts on Cancel: the safe answer to a security question.
const card = ref<HTMLElement | null>(null)
const cancelButton = ref<HTMLButtonElement | null>(null)
useDialogFocus(card, () => cancelButton.value)
</script>

<template>
  <div class="switch-confirm nv-dialog-scrim">
    <div
      ref="card"
      class="nv-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="switch-confirm-title"
      aria-describedby="switch-confirm-desc"
      tabindex="-1"
    >
      <div class="nv-dialog-head">
        <div class="nv-dialog-heading">
          <h4 id="switch-confirm-title" class="nv-dialog-title">{{ $t('settings.accounts.cli.agent-switch-confirm-title') }}</h4>
        </div>
      </div>
      <div id="switch-confirm-desc" class="nv-dialog-body">
        <p>{{ $t('settings.accounts.cli.agent-switch-confirm-body') }}</p>
        <p>{{ $t('settings.accounts.cli.agent-switch-confirm-late') }}</p>
        <dl class="switch-confirm-facts">
          <dt>{{ $t('settings.accounts.cli.agent-switch-confirm-vendor') }}</dt>
          <dd><code>{{ request.agentKey }}</code></dd>
          <dt>{{ $t('settings.accounts.cli.agent-switch-confirm-from') }}</dt>
          <dd>{{ request.fromLabel }}</dd>
          <dt>{{ $t('settings.accounts.cli.agent-switch-confirm-to') }}</dt>
          <dd>{{ request.toLabel }}</dd>
          <dt>{{ $t('settings.accounts.cli.agent-switch-confirm-caller') }}</dt>
          <dd>{{ caller }}</dd>
          <dt>{{ $t('settings.accounts.cli.agent-switch-confirm-workspace') }}</dt>
          <dd><code>{{ request.workspacePath }}</code></dd>
        </dl>
        <div class="switch-confirm-reason">
          <div class="switch-confirm-label">{{ $t('settings.accounts.cli.agent-switch-confirm-reason') }}</div>
          <p data-testid="switch-confirm-reason">{{ reason }}</p>
          <p v-if="request.reasonTruncated" class="switch-confirm-truncated" data-testid="switch-confirm-truncated">{{ $t('settings.accounts.cli.agent-switch-confirm-reason-truncated') }}</p>
        </div>
      </div>
      <div class="nv-dialog-actions">
        <button ref="cancelButton" class="switch-confirm-cancel nv-btn" @click="emit('answer', false)">
          {{ $t('settings.accounts.cli.agent-switch-confirm-cancel') }}
        </button>
        <button class="switch-confirm-ok nv-btn nv-btn--primary" @click="emit('answer', true)">
          {{ $t('settings.accounts.cli.agent-switch-confirm-ok') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.switch-confirm-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 10px 0;
}
.switch-confirm-facts dt {
  color: var(--text-muted);
}
.switch-confirm-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.switch-confirm-reason {
  border-left: 2px solid var(--border-default);
  padding-left: 8px;
}
.switch-confirm-label {
  color: var(--text-muted);
  font-size: 0.9em;
}
.switch-confirm-reason p.switch-confirm-truncated {
  color: var(--text-muted);
  font-size: 0.9em;
}
.switch-confirm-reason p {
  margin: 2px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
