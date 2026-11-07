<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ChannelAgentRequest, ChannelsStore } from '../../composables/useChannels'

/**
 * Requests agents filed through the channels_* MCP tools (letting a person in,
 * removing a bot, a bind the user must allow, a bot to add). An agent can only
 * ask; the press here is the user's. A bot to add opens its form (`fill`): the
 * credential is typed there and never reaches the agent.
 */
const props = defineProps<{ store: Pick<ChannelsStore, 'agentRequests' | 'decideAgentRequest'> }>()
const emit = defineEmits<{ fill: [request: ChannelAgentRequest] }>()
const { t } = useI18n()

const busy = ref<string | null>(null)
const errors = ref<Record<string, string>>({})

function botLabel(platform: string, account: string): string {
  return account && account !== 'default' ? `${platform}/${account}` : platform
}

function requester(req: ChannelAgentRequest): string {
  return req.requester.address || req.requester.pane_id || req.requester.kind || '?'
}

function summary(req: ChannelAgentRequest): string {
  const tg = req.target
  const bot = botLabel(tg.platform ?? '', tg.account ?? '')
  if (req.kind === 'bot-add') return t('channels.agent.kind-bot-add', { platform: tg.platform })
  if (req.kind === 'bot-remove') return t('channels.agent.kind-bot-remove', { bot })
  if (req.kind === 'bind') return t('channels.agent.kind-bind', { bot, chat: tg.chat_id, pane: tg.pane })
  return tg.bind_pane
    ? t('channels.agent.kind-pairing-bind', { bot, sender: tg.sender_name || tg.sender_id, pane: tg.bind_pane })
    : t('channels.agent.kind-pairing', { bot, sender: tg.sender_name || tg.sender_id })
}

async function decide(req: ChannelAgentRequest, approve: boolean): Promise<void> {
  busy.value = req.id
  try {
    const res = await props.store.decideAgentRequest(req.id, approve)
    errors.value = { ...errors.value, [req.id]: res.ok ? '' : (res.error ?? t('channels.error.generic')) }
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div v-if="props.store.agentRequests.value.length" class="ch-agent-requests" data-testid="channel-agent-requests">
    <h3 class="ch-agent-title">{{ t('channels.agent.title') }}</h3>
    <div
      v-for="req in props.store.agentRequests.value"
      :key="req.id"
      class="ch-agent-request"
      data-testid="channel-agent-request"
      :data-kind="req.kind"
    >
      <div class="ch-agent-summary">{{ summary(req) }}</div>
      <div class="ch-agent-meta">{{ t('channels.agent.from', { requester: requester(req) }) }}</div>
      <div v-if="req.target.why" class="ch-agent-meta">{{ req.target.why }}</div>
      <div v-if="req.reason" class="ch-agent-reason">{{ req.reason }}</div>
      <div v-if="req.target.workspace_path" class="ch-agent-meta">{{ req.target.workspace_path }}</div>
      <div v-if="errors[req.id]" class="ch-agent-error" role="alert">{{ errors[req.id] }}</div>
      <div class="ch-agent-actions">
        <button
          v-if="req.kind === 'bot-add'"
          type="button"
          class="ch-btn primary"
          data-testid="channel-agent-fill"
          @click="emit('fill', req)"
        >{{ t('channels.agent.fill') }}</button>
        <button
          v-else
          type="button"
          class="ch-btn primary"
          data-testid="channel-agent-approve"
          :disabled="busy !== null || req.status !== 'pending'"
          @click="decide(req, true)"
        >{{ t('channels.agent.approve') }}</button>
        <button
          type="button"
          class="ch-btn"
          data-testid="channel-agent-decline"
          :disabled="busy !== null || req.status !== 'pending'"
          @click="decide(req, false)"
        >{{ t('channels.agent.decline') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ch-agent-requests { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.ch-agent-title { font-size: 13px; font-weight: 600; margin: 0; }
.ch-agent-request {
  border: 1px solid var(--accent-emphasis);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ch-agent-summary { font-weight: 600; overflow-wrap: anywhere; }
.ch-agent-meta { font-size: 12px; opacity: 0.75; overflow-wrap: anywhere; }
.ch-agent-reason { font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ch-agent-error { font-size: 12px; color: var(--danger-fg); }
.ch-agent-actions { display: flex; gap: 8px; margin-top: 4px; }
.ch-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-height: var(--control-h-md);
  padding: 0 10px;
  border-radius: 5px;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-xs);
  white-space: nowrap;
  cursor: pointer;
}
.ch-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ch-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ch-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.ch-btn.ghost { color: var(--text-secondary); }
.ch-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
</style>
