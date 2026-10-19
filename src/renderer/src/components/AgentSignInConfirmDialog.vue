<script setup lang="ts">
// The user's yes before an agent's cli_account_sign_in opens a sign-in pane
// (review #433 LOW-3). Presentation only: lib/agentSignIn's createSignInConfirm
// holds the request and closes it at its deadline.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AgentSignInConfirmRequest } from '../lib/agentSignIn'
import { useDialogFocus } from '../composables/useDialogFocus'
import { revealInvisibleText } from '../../../shared/pluginAgentTools'

const props = defineProps<{ request: AgentSignInConfirmRequest }>()
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
  <div class="signin-confirm nv-dialog-scrim">
    <div
      ref="card"
      class="nv-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="signin-confirm-title"
      aria-describedby="signin-confirm-desc"
      tabindex="-1"
    >
      <div class="nv-dialog-head">
        <div class="nv-dialog-heading">
          <h4 id="signin-confirm-title" class="nv-dialog-title">{{ $t('settings.accounts.cli.agent-login-confirm-title') }}</h4>
        </div>
      </div>
      <div id="signin-confirm-desc" class="nv-dialog-body">
        <p>{{ $t('settings.accounts.cli.agent-login-confirm-body') }}</p>
        <dl class="signin-confirm-facts">
          <dt>{{ $t('settings.accounts.cli.agent-login-confirm-vendor') }}</dt>
          <dd><code>{{ request.agentKey }}</code></dd>
          <dt>{{ $t('settings.accounts.cli.agent-login-confirm-account') }}</dt>
          <dd>{{ request.accountLabel }}</dd>
          <dt>{{ $t('settings.accounts.cli.agent-login-confirm-caller') }}</dt>
          <dd>{{ caller }}</dd>
          <dt>{{ $t('settings.accounts.cli.agent-login-confirm-workspace') }}</dt>
          <dd><code>{{ request.workspacePath }}</code></dd>
        </dl>
        <div class="signin-confirm-reason">
          <div class="signin-confirm-label">{{ $t('settings.accounts.cli.agent-login-confirm-reason') }}</div>
          <p data-testid="signin-confirm-reason">{{ reason }}</p>
          <p v-if="request.reasonTruncated" class="signin-confirm-truncated" data-testid="signin-confirm-truncated">{{ $t('settings.accounts.cli.agent-login-confirm-reason-truncated') }}</p>
        </div>
      </div>
      <div class="nv-dialog-actions">
        <button ref="cancelButton" class="signin-confirm-cancel nv-btn" @click="emit('answer', false)">
          {{ $t('settings.accounts.cli.agent-login-confirm-cancel') }}
        </button>
        <button class="signin-confirm-ok nv-btn nv-btn--primary" @click="emit('answer', true)">
          {{ $t('settings.accounts.cli.agent-login-confirm-ok') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.signin-confirm-facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 10px 0;
}
.signin-confirm-facts dt {
  color: var(--text-muted);
}
.signin-confirm-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.signin-confirm-reason {
  border-left: 2px solid var(--border-default);
  padding-left: 8px;
}
.signin-confirm-label {
  color: var(--text-muted);
  font-size: 0.9em;
}
.signin-confirm-reason p.signin-confirm-truncated {
  color: var(--text-muted);
  font-size: 0.9em;
}
.signin-confirm-reason p {
  margin: 2px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
