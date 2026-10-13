<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { i18n, vTruncate } from '@navide/plugin-ui/foundation'
import { DEFAULT_ACCOUNT, type ChannelLinkInvite, type ChannelPlatform, type ChannelsStore } from '../composables/useChannels'
import { channelPlatform, type ChannelLinkTarget } from '../platform/channels'

/**
 * "Link my chat account" for one connected platform: asks the backend for a
 * one-time code, opens the platform's deep link when there is one, and waits
 * for `channels.linked`. Whoever sends the code is allowlisted and their chat
 * remembered, so no pairing approval is needed. Pending pairing requests for
 * the platform are approvable here too. Used by the pane picker's empty state
 * and by the Settings → Channels card. Quick add hands it the invite it already
 * got (`initialInvite`): the guide opens and waits on it as if a button made it.
 */
const props = defineProps<{
  store: ChannelsStore
  platform: ChannelPlatform
  /** The bot to link with; the platform's default bot when missing. */
  account?: string
  /** An invite created elsewhere (quick add): opened once, with the code command
   *  copied first when the platform's link does not carry the code. */
  initialInvite?: ChannelLinkInvite | null
}>()
const emit = defineEmits<{ linked: [title: string]; opened: [copied: boolean] }>()

// Global instance: the pane header mounts without the i18n plugin in tests.
const t = i18n.global.t

// Each platform declares its own buttons and code command (platform/channels/<id>.ts).
const FALLBACK_TARGETS: readonly ChannelLinkTarget[] = [{ target: 'direct', label: 'channels.link.get-code' }]
const spec = computed(() => channelPlatform(props.platform))
const actions = computed(() => spec.value?.link.targets ?? FALLBACK_TARGETS)

const invite = ref<ChannelLinkInvite | null>(null)
const busy = ref(false)
const error = ref('')
const copied = ref(false)
const linkedTitle = ref('')
const linkedConfirmed = ref(true)
// A platform link was expected but the backend had none (e.g. Slack's bots.info failed).
const noDeepLink = ref(false)
let expiryTimer: ReturnType<typeof setTimeout> | null = null

function clearExpiry(): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer)
  expiryTimer = null
}

/** Stop waiting on the current code, with the reason shown in its place. */
function dropInvite(reason: string): void {
  clearExpiry()
  invite.value = null
  error.value = reason
}
onBeforeUnmount(clearExpiry)

const platformName = computed(() => t(`channels.platform.${props.platform}`))
const command = computed(() => (invite.value ? `${spec.value?.link.codeCommand ?? 'link'} ${invite.value.code}` : ''))
const sendHint = computed(() => t(spec.value?.link.sendCodeKey(invite.value?.target ?? 'direct') ?? 'channels.link.send-code'))
const waitingText = computed(() => t(spec.value?.link.waitingKey ?? 'channels.link.waiting', { platform: platformName.value }))
const pending = computed(() =>
  props.store.pairing.value.filter(
    (r) => r.platform === props.platform && (r.account ?? DEFAULT_ACCOUNT) === (props.account ?? DEFAULT_ACCOUNT)
  )
)

async function start(action: ChannelLinkTarget): Promise<void> {
  busy.value = true
  error.value = ''
  copied.value = false
  linkedTitle.value = ''
  noDeepLink.value = false
  clearExpiry()
  try {
    const res = await props.store.createLink(props.platform, action.target, props.account)
    if (!res.ok || !res.data) {
      error.value = res.error ?? t('channels.error.generic')
      return
    }
    await adopt(res.data, action)
  } finally {
    busy.value = false
  }
}

/** Wait on `data` and open its platform link. With `copyFirst` the code command goes
 *  to the clipboard before the link takes focus away from this window. */
async function adopt(data: ChannelLinkInvite, action: ChannelLinkTarget, copyFirst = false): Promise<void> {
  invite.value = data
  const code = data.code
  expiryTimer = setTimeout(() => {
    if (invite.value?.code === code) dropInvite(t('channels.link.expired'))
  }, Math.max(0, data.expires_at * 1000 - Date.now()))
  if (copyFirst) await copy()
  if (!data.url) noDeepLink.value = !!action.opensLink
  else {
    // Main-process opener: http(s) only, app windows only.
    const opened = await window.agentTeam?.openExternal?.(data.url)
    if (opened && !opened.ok) error.value = t('channels.link.open-failed', { error: opened.error ?? '' })
  }
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(command.value)
    copied.value = true
  } catch {
    copied.value = false
    error.value = t('channels.link.copy-failed')
  }
}

async function approve(code: string): Promise<void> {
  busy.value = true
  const res = await props.store.approvePairing(props.platform, code)
  busy.value = false
  if (!res.ok) error.value = res.error ?? t('channels.error.generic')
}

watch(
  () => props.initialInvite,
  async (data) => {
    if (!data || data.code === invite.value?.code) return
    error.value = ''
    linkedTitle.value = ''
    noDeepLink.value = false
    clearExpiry()
    const action = actions.value.find((a) => a.target === data.target) ?? FALLBACK_TARGETS[0]
    await adopt(data, action, !spec.value?.link.urlCarriesCode)
    emit('opened', copied.value)
  },
  { immediate: true }
)

watch(
  () => props.store.lastLinked.value,
  (ev) => {
    if (!ev || ev.platform !== props.platform || ev.code !== invite.value?.code) return
    clearExpiry()
    invite.value = null
    linkedTitle.value = ev.title || ev.chat_id
    linkedConfirmed.value = ev.confirmed !== false
    emit('linked', linkedTitle.value)
  }
)

watch(
  () => props.store.lastLinkFailed.value,
  (ev) => {
    if (!ev || ev.platform !== props.platform || ev.code !== invite.value?.code) return
    dropInvite(t('channels.link.failed', { error: ev.error }))
  }
)

watch(
  () => props.store.linkEpoch.value,
  () => {
    if (invite.value) dropInvite(t('channels.link.reconnected'))
  }
)
</script>

<template>
  <div class="clg" data-testid="channel-link-guide" :data-platform="platform">
    <div class="clg-actions">
      <button
        v-for="a in actions"
        :key="a.target + a.label"
        type="button"
        class="clg-btn"
        :class="{ primary: a === actions[0] }"
        :disabled="busy"
        data-testid="channel-link-action"
        :data-target="a.target"
        @click="start(a)"
      >{{ t(a.label, { platform: platformName }) }}</button>
    </div>
    <p v-if="linkedTitle" class="clg-ok" role="status" data-testid="channel-link-done">{{ t(linkedConfirmed ? 'channels.link.linked' : 'channels.link.linked-unconfirmed', { title: linkedTitle }) }}</p>
    <div v-if="invite" class="clg-wait" data-testid="channel-link-waiting">
      <span class="clg-wait-text"><span class="clg-dot" aria-hidden="true"></span>{{ waitingText }}</span>
      <span v-if="noDeepLink" class="clg-hint">{{ t('channels.link.no-deep-link', { platform: platformName }) }}</span>
      <span class="clg-hint">{{ sendHint }}</span>
      <span class="clg-code-row">
        <code class="clg-code" v-truncate data-testid="channel-link-code">{{ command }}</code>
        <button type="button" class="clg-btn sm" data-testid="channel-link-copy" @click="copy">{{ copied ? t('channels.link.copied') : t('channels.link.copy') }}</button>
      </span>
      <span class="clg-hint">{{ t('channels.link.expires') }}</span>
    </div>
    <div v-for="req in pending" :key="req.code" class="clg-pair" data-testid="channel-link-pairing">
      <span class="clg-pair-name" v-truncate>{{ t('channels.link.pairing', { name: req.sender_name || req.sender_id }) }}</span>
      <button type="button" class="clg-btn sm primary" :disabled="busy" data-testid="channel-link-approve" @click="approve(req.code)">{{ t('channels.pairing.approve') }}</button>
    </div>
    <p v-if="error" class="clg-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.clg { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.clg-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.clg-btn { font: inherit; border-radius: 5px; padding: 3px 9px; cursor: pointer; border: 1px solid var(--border-default); background: transparent; color: var(--text-primary); white-space: nowrap; }
.clg-btn:hover:not(:disabled) { border-color: var(--border-strong); }
.clg-btn:disabled { opacity: 0.5; cursor: default; }
.clg-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.clg-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.clg-btn.sm { padding: 1px 7px; font-size: var(--font-3xs); }
.clg-wait { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border: 1px dashed var(--accent-muted); border-radius: var(--radius-xs); background: var(--bg-subtle); }
.clg-wait-text { display: inline-flex; align-items: center; gap: 6px; color: var(--text-primary); }
.clg-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-fg); animation: clg-pulse 1.2s ease-in-out infinite; }
@keyframes clg-pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .clg-dot { animation: none; } }
.clg-hint { line-height: 1.4; }
.clg-code-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.clg-code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, monospace); letter-spacing: 0.04em; color: var(--text-bright); user-select: all; }
.clg-pair { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.clg-pair-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
.clg-ok { margin: 0; color: var(--success-fg); }
.clg-error { margin: 0; color: var(--danger-fg); word-break: break-word; }
</style>
