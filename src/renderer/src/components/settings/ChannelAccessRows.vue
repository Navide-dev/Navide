<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { ChannelAllowEntry, ChannelPairingRequest, ChannelPlatform } from '../../composables/useChannels'
import { channelPlatform } from '../../platform/channels'

/**
 * Who may talk to panes through a bot: pairing requests waiting for approval and
 * allowed senders, as rows with their actions. Under a bot its name and platform
 * are already on screen; `whereOf` names them for rows that have no bot.
 */
defineProps<{
  requests?: ChannelPairingRequest[]
  entries?: ChannelAllowEntry[]
  busy?: boolean
  whereOf?: (platform: ChannelPlatform, account: string | undefined) => string
}>()

const emit = defineEmits<{
  approve: [request: ChannelPairingRequest]
  reject: [request: ChannelPairingRequest]
  remove: [entry: ChannelAllowEntry]
}>()

const { t } = useI18n()

function badgeOf(platform: string): string {
  return channelPlatform(platform)?.badge ?? platform.slice(0, 2).toUpperCase()
}

/** How a pairing request or allowed sender came: "—" when the backend recorded nothing. */
function sourceLabel(source: string | null | undefined): string {
  if (source === 'pairing') return t('channels.allow.via-pairing')
  if (source === 'invite') return t('channels.allow.via-invite')
  return '—'
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  return new Date(ms).toLocaleString()
}
</script>

<template>
  <div class="ch-items">
    <div v-for="req in requests" :key="`${req.platform}:${req.code}`" class="ch-item pending" data-testid="pairing-row">
      <span class="ch-mark" aria-hidden="true">{{ badgeOf(req.platform) }}</span>
      <div class="ch-item-text">
        <span class="ch-item-name" v-truncate>{{ req.sender_name || req.sender_id }}</span>
        <span class="ch-item-meta" v-truncate><template v-if="whereOf">{{ t(`channels.platform.${req.platform}`) }} · <span data-testid="pairing-bot">{{ whereOf(req.platform, req.account) }}</span> · </template><span data-testid="pairing-source">{{ sourceLabel(req.source ?? 'pairing') }}</span> · {{ formatTime(req.created_at) }}</span>
      </div>
      <code class="ch-code">{{ req.code }}</code>
      <div class="ch-actions">
        <button type="button" class="ch-btn ghost" :disabled="busy" data-testid="pairing-reject" @click="emit('reject', req)">{{ t('channels.pairing.reject') }}</button>
        <button type="button" class="ch-btn primary" :disabled="busy" data-testid="pairing-approve" @click="emit('approve', req)">{{ t('channels.pairing.approve') }}</button>
      </div>
    </div>
    <div v-for="entry in entries" :key="`${entry.platform}:${entry.account}:${entry.sender_id}`" class="ch-item" data-testid="allow-row">
      <span class="ch-mark" aria-hidden="true">{{ badgeOf(entry.platform) }}</span>
      <div class="ch-item-text">
        <span class="ch-item-name" v-truncate>{{ entry.sender_name || entry.sender_id }}<span v-if="entry.shared" class="ch-item-badge" data-testid="allow-shared">{{ t('channels.allow.shared') }}</span></span>
        <span class="ch-item-meta" v-truncate><template v-if="whereOf">{{ t(`channels.platform.${entry.platform}`) }} · <span data-testid="allow-bot">{{ whereOf(entry.platform, entry.account) }}</span> · </template>{{ entry.sender_id }} · <span data-testid="allow-source">{{ sourceLabel(entry.source) }}</span> · <span data-testid="allow-added">{{ formatTime(entry.added_at) || '—' }}</span></span>
        <span v-if="entry.shared" class="ch-item-warn" data-testid="allow-shared-hint">{{ t('channels.allow.shared-hint') }}</span>
      </div>
      <div class="ch-actions">
        <button type="button" class="ch-btn ghost" :disabled="busy" data-testid="allow-remove" @click="emit('remove', entry)">{{ t('channels.allow.remove') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ch-items { display: flex; flex-direction: column; }
.ch-item { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
.ch-item + .ch-item { border-top: 1px solid var(--border-muted); }
/* A request waiting stands out from the people already allowed. */
.ch-item.pending {
  margin: 2px -8px;
  padding: 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--attention-subtle);
}
.ch-item.pending + .ch-item { border-top: none; }
.ch-mark {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.02em;
}
.ch-item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ch-item-name { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-item-meta { font-size: var(--font-2xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-item-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--attention-muted);
  background: var(--attention-subtle);
  color: var(--attention-on-subtle);
  font-size: var(--font-2xs);
  font-weight: 400;
}
.ch-item-warn { font-size: var(--font-2xs); color: var(--attention-fg); }
.ch-code { font-family: var(--font-mono, monospace); font-size: var(--font-xs); letter-spacing: 0.08em; color: var(--text-bright); }
.ch-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
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
