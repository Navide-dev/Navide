<script setup lang="ts">
// Toolbar entry for an encrypted, read-only share link to the open plan. The
// parent mounts this only after `ui.shareCaps` answered `{ ok: true }`; the
// Host resolves `path` inside the plans root and answers `ui.shareCreate`
// with `{ ok: true, link }` or `{ ok: false, code, message, reason? }`.
// Sending to a chat is opt-in and names one bound direct-message chat that
// `ui.shareChatTargets` listed; with none bound, nothing can be sent.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotify } from '@navide/plugin-ui/foundation'
import { callCapability } from './backend'

interface MaskedFinding { line: number; category: string; action: string }
interface ChatTarget { chatId: string; platform: string; name: string }
interface CreatedLink { linkId: string; url: string; expiresAt: string; masked: MaskedFinding[] }
type CreateResult =
  | { ok: true; link: CreatedLink }
  | { ok: false; code: string; message?: string; reason?: string }

const props = defineProps<{ relPath: string }>()
const { t, te } = useI18n()
const { toast } = useNotify()

const TTL_DAYS = [1, 3, 7, 30] as const

const open = ref(false)
const ttlDays = ref('7')
const requireLogin = ref(false)
const sendToChat = ref(false)
const chats = ref<ChatTarget[] | null>(null)
const chatId = ref('')
const creating = ref(false)
const link = ref<CreatedLink | null>(null)
const errorText = ref('')

function openDialog(): void {
  ttlDays.value = '7'
  requireLogin.value = false
  sendToChat.value = false
  chats.value = null
  chatId.value = ''
  link.value = null
  errorText.value = ''
  open.value = true
}

function closeDialog(): void {
  if (!creating.value) open.value = false
}

function translated(key: string, fallback: string): string {
  return te(key) ? t(key) : fallback
}

function describeFailure(result: { code: string; message?: string; reason?: string }): string {
  const message = result.message ?? ''
  if (result.code === 'SHARE_REFUSED') {
    const reason = result.reason ? translated(`plans.share.reason.${result.reason}`, message) : message
    return t('plans.share.refused', { reason })
  }
  return t('plans.share.failed', { code: result.code, message })
}

const canCreate = computed(() =>
  !creating.value && (!sendToChat.value || (chats.value ?? []).some(chat => chat.chatId === chatId.value)))

watch(sendToChat, (checked) => {
  if (checked && chats.value === null) void loadChats()
})

async function loadChats(): Promise<void> {
  try {
    const result = await callCapability('ui', 'shareChatTargets', {}) as
      | { ok: true; chats: ChatTarget[] }
      | { ok: false; code: string; message?: string }
      | null
    if (result?.ok === true) {
      chats.value = result.chats
      return
    }
    chats.value = []
    errorText.value = t('plans.share.chat-targets-failed', { code: result?.code ?? 'INTERNAL_ERROR', message: result?.message ?? '' })
  } catch (cause) {
    chats.value = []
    errorText.value = t('plans.share.chat-targets-failed', {
      code: 'INTERNAL_ERROR',
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

async function create(): Promise<void> {
  if (!canCreate.value) return
  creating.value = true
  errorText.value = ''
  try {
    const result = await callCapability('ui', 'shareCreate', {
      path: props.relPath,
      ttlSeconds: Number(ttlDays.value) * 86400,
      requireLogin: requireLogin.value,
      sendToChat: sendToChat.value,
      ...(sendToChat.value ? { chatId: chatId.value } : {}),
    }) as CreateResult | null
    if (result?.ok === true) link.value = result.link
    else errorText.value = describeFailure(result ?? { code: 'INTERNAL_ERROR' })
  } catch (cause) {
    const code = (cause as { code?: unknown })?.code
    errorText.value = describeFailure({
      code: typeof code === 'string' ? code : 'INTERNAL_ERROR',
      message: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    creating.value = false
  }
}

async function copyLink(): Promise<void> {
  if (!link.value) return
  try {
    await navigator.clipboard.writeText(link.value.url)
    toast(t('plans.share.copied'), { type: 'success' })
  } catch {
    toast(link.value.url, { type: 'error' })
  }
}

function findingText(finding: MaskedFinding): string {
  const category = translated(`plans.share.category.${finding.category}`, finding.category)
  const key = finding.action === 'masked' ? 'plans.share.masked-line' : 'plans.share.warned-line'
  return t(key, { line: finding.line, category })
}

function expiryText(value: string): string {
  const date = new Date(value)
  return t('plans.share.expires-at', { date: Number.isNaN(date.getTime()) ? value : date.toLocaleString() })
}
</script>

<template>
  <button
    class="psb-btn"
    data-test="plan-share-btn"
    type="button"
    :title="t('plans.share.button')"
    :aria-label="t('plans.share.button')"
    @click="openDialog"
  >🔗</button>
  <Teleport v-if="open" to="body">
    <div class="psb-modal" @click.self="closeDialog">
      <div class="psb-card" role="dialog" aria-modal="true" :aria-label="t('plans.share.title')" data-test="plan-share-dialog">
        <header class="psb-header">{{ t('plans.share.title') }}</header>
        <div class="psb-body">
          <template v-if="!link">
            <label class="psb-row">
              <span>{{ t('plans.share.expiry') }}</span>
              <select v-model="ttlDays" data-test="plan-share-ttl" :disabled="creating">
                <option v-for="days in TTL_DAYS" :key="days" :value="String(days)">
                  {{ t('plans.share.days', { count: days }, days) }}
                </option>
              </select>
            </label>
            <label class="psb-row psb-check">
              <input v-model="requireLogin" type="checkbox" data-test="plan-share-login" :disabled="creating">
              <span>{{ t('plans.share.require-login') }}</span>
            </label>
            <label class="psb-row psb-check">
              <input v-model="sendToChat" type="checkbox" data-test="plan-share-chat" :disabled="creating">
              <span>{{ t('plans.share.send-to-chat') }}</span>
            </label>
            <p class="psb-muted psb-note" data-test="plan-share-chat-note">{{ t('plans.share.send-to-chat-note') }}</p>
            <template v-if="sendToChat">
              <p v-if="chats === null" class="psb-muted">{{ t('plans.share.chat-loading') }}</p>
              <p v-else-if="!chats.length" class="psb-muted" data-test="plan-share-chat-empty">{{ t('plans.share.chat-none') }}</p>
              <label v-else class="psb-row">
                <span>{{ t('plans.share.chat-target') }}</span>
                <select v-model="chatId" data-test="plan-share-chat-target" :disabled="creating">
                  <option value="" disabled>{{ t('plans.share.chat-pick') }}</option>
                  <option v-for="chat in chats" :key="chat.chatId" :value="chat.chatId">{{ chat.platform }} · {{ chat.name }}</option>
                </select>
              </label>
            </template>
          </template>
          <template v-else>
            <div class="psb-row psb-link">
              <input class="psb-url" data-test="plan-share-url" type="text" readonly :value="link.url" @focus="($event.target as HTMLInputElement).select()">
              <button type="button" data-test="plan-share-copy" @click="void copyLink()">{{ t('plans.share.copy') }}</button>
            </div>
            <p class="psb-muted">{{ expiryText(link.expiresAt) }}</p>
            <div v-if="link.masked.length" class="psb-masked" data-test="plan-share-masked">
              <p class="psb-masked-title">{{ t('plans.share.masked-title') }}</p>
              <ul>
                <li v-for="finding in link.masked" :key="`${finding.line}:${finding.category}:${finding.action}`">
                  {{ findingText(finding) }}
                </li>
              </ul>
            </div>
          </template>
          <p v-if="errorText" class="psb-error" data-test="plan-share-error" role="alert">{{ errorText }}</p>
        </div>
        <footer class="psb-footer">
          <button type="button" :disabled="creating" @click="closeDialog">{{ t('plans.share.close') }}</button>
          <button
            v-if="!link"
            class="psb-primary"
            type="button"
            data-test="plan-share-create"
            :disabled="!canCreate"
            @click="void create()"
          >{{ creating ? t('plans.share.creating') : t('plans.share.create') }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.psb-btn {
  align-items: center;
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  flex-shrink: 0;
  font-size: var(--font-2xs);
  height: 22px;
  justify-content: center;
  min-width: 26px;
  padding: 0 6px;
}
.psb-btn:hover {
  background: var(--bg-hover-strong);
}
.psb-modal {
  align-items: center;
  background: var(--shadow-overlay);
  display: flex;
  inset: 0;
  justify-content: center;
  position: fixed;
  z-index: 10100;
}
.psb-card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 12px 48px var(--shadow-overlay);
  color: var(--text-primary);
  max-width: min(520px, calc(100vw - 32px));
  width: 100%;
}
.psb-header {
  border-bottom: 1px solid var(--border-muted);
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 12px 16px;
}
.psb-body {
  display: flex;
  flex-direction: column;
  font-size: var(--font-xs);
  gap: 10px;
  padding: 14px 16px;
}
.psb-row {
  align-items: center;
  display: flex;
  gap: 8px;
}
.psb-url {
  flex: 1;
  font-family: var(--font-mono, monospace);
  min-width: 0;
}
.psb-muted {
  color: var(--text-secondary);
  margin: 0;
}
.psb-note {
  font-size: var(--font-2xs);
  margin-top: -6px;
}
.psb-masked-title {
  font-weight: 600;
  margin: 0 0 4px;
}
.psb-masked ul {
  margin: 0;
  padding-left: 18px;
}
.psb-error {
  color: var(--danger-fg);
  margin: 0;
}
.psb-footer {
  border-top: 1px solid var(--border-muted);
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 10px 16px;
}
.psb-primary {
  border-color: var(--accent-fg);
}
</style>
