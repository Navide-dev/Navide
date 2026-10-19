<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { isMacPlatform } from '@navide/plugin-ui/shared'
import type { useBackend } from '../../composables/useBackend'
import {
  DEFAULT_ACCOUNT,
  newAccountId,
  useChannels,
  type ChannelAccountState,
  type ChannelLinkInvite,
  type ChannelManagedCreatedEvent,
  type ChannelOverviewChat,
  type ChannelPlatform,
} from '../../composables/useChannels'
import {
  CHANNEL_PLATFORM_SPECS,
  channelPlatform,
  clipboardTokenField,
  type RegisteredChannelPlatform,
} from '../../platform/channels'
import { channelBotLabel } from '../../lib/channelIdentity'
import ChannelLinkGuide from '../ChannelLinkGuide.vue'
import ChannelChatBindings from './ChannelChatBindings.vue'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'

/**
 * Settings → Channels: connect chat platforms, watch their connection state,
 * approve pairing requests and manage who may talk to panes. A platform can run
 * several bots, each with its own credential, connection and linked chats.
 * Secrets go to the backend once and are never shown again — a stored secret
 * only shows as masked. A new bot is added with "quick add": the backend keeps it
 * only once the platform accepted its credential, then the bot's link guide opens
 * the chat app with a fresh code. A Telegram bot in Bot Management Mode can also
 * create a new bot: Telegram opens a prefilled creation screen, and the bot it makes
 * arrives through the backend's quick add, then goes to its link guide the same way.
 * Under each bot are the chats it knows and the panes bound to each (from
 * channels.overview): jump to one, unbind one or several, clear orphans. The bot's
 * less used actions sit in its ⋯ menu.
 */
const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send' | 'on' | 'status'>
}>()

const { t, te } = useI18n()
const store = useChannels(props.backend)

// Configured platforms first; otherwise the declared display order.
const specs = computed<RegisteredChannelPlatform[]>(() => {
  const visible = CHANNEL_PLATFORM_SPECS.filter((s) => !s.macOnly || isMacPlatform())
  return [
    ...visible.filter((s) => isConfigured(s.id)),
    ...visible.filter((s) => !isConfigured(s.id)),
  ]
})

/** A bot row: a configured bot, the not-yet-set-up default slot, or one being added. */
interface BotRow extends ChannelAccountState {
  key: string
  isNew: boolean
}

// The bot being added, per platform: its form is open under the platform's bots.
const adding = reactive<Partial<Record<ChannelPlatform, string>>>({})
const expanded = ref<string | null>(null)
const busy = ref(false)
const errorByBot = reactive<Record<string, string>>({})
const drafts = reactive<Record<string, Record<string, string>>>({})
const listError = ref('')
// Rename and remove each ask on the row itself first.
const renaming = ref<string | null>(null)
const renameDraft = ref('')
const confirmingRemove = ref<string | null>(null)
// Quick add progress per bot; the invite it got is handed to the bot's link guide.
type QuickStep = 'verifying' | 'opening' | 'waiting' | 'done'
const quickStep = reactive<Record<string, QuickStep>>({})
const quickInvite = reactive<Record<string, ChannelLinkInvite>>({})
// Whether the link guide got the code command onto the clipboard.
const quickCopied = reactive<Record<string, boolean>>({})
// Added, but no invite reached the link guide: the row says to link from the guide.
const quickAdded = reactive<Record<string, boolean>>({})
const QUICK_STEPS: readonly QuickStep[] = ['verifying', 'opening', 'waiting', 'done']
// Creating a bot through a managing Telegram bot: the row asking for the disclosure to be
// confirmed, the request each manager row waits on, and why the last one failed.
const BOTFATHER_APP_URL = 'https://t.me/Botfather?startapp'
const managedAsk = ref<string | null>(null)
const managedWaiting = reactive<Record<string, string>>({})
const managedError = reactive<Record<string, string>>({})

function botKey(platform: string, account: string): string {
  return `${platform}:${account}`
}

function isConfigured(platform: ChannelPlatform): boolean {
  return !!store.platformState(platform)?.configured
}

function emptyBot(platform: ChannelPlatform, account: string, isNew: boolean): BotRow {
  return {
    key: botKey(platform, account), account, name: '', configured: false, enabled: false, isNew,
    status: { lifecycle: 'stopped', connected: false, reconnect_attempts: 0, last_error: '', last_connected_at: null, last_inbound_at: null, identity: '' },
    config: {}, capabilities: null,
  }
}

function botsOf(platform: ChannelPlatform): BotRow[] {
  const configured = store.platformState(platform)?.accounts ?? []
  const rows: BotRow[] = configured.map((a) => ({ ...a, key: botKey(platform, a.account), isNew: false }))
  if (!rows.length) rows.push(emptyBot(platform, DEFAULT_ACCOUNT, false))
  const added = adding[platform]
  if (added) rows.push(emptyBot(platform, added, true))
  return rows
}

function botLabel(bot: BotRow | ChannelAccountState): string {
  return channelBotLabel(bot, bot.account, t)
}

/** Which bot a pairing request or allowed sender belongs to, named only when
 *  its platform runs several bots (one bot reads exactly as before). */
function entryBot(platform: ChannelPlatform, account: string | undefined): string {
  const bots = store.platformState(platform)?.accounts ?? []
  if (bots.length < 2) return ''
  const id = account ?? DEFAULT_ACCOUNT
  return channelBotLabel(bots.find((b) => b.account === id), id, t)
}

function badgeOf(platform: string): string {
  return channelPlatform(platform)?.badge ?? platform.slice(0, 2).toUpperCase()
}

function platformName(platform: string): string {
  return t(`channels.platform.${platform}`)
}

function statusText(bot: BotRow): string {
  if (!bot.configured) return t('channels.status.not-configured')
  if (!bot.enabled) return t('channels.status.disabled')
  const label = t(`channels.lifecycle.${bot.status.lifecycle}`)
  return bot.status.lifecycle === 'ready' && bot.status.identity ? `${label} ${bot.status.identity}` : label
}

function pendingCount(platform: ChannelPlatform): number {
  return store.pairing.value.filter((r) => r.platform === platform).length
}

function needsText(spec: RegisteredChannelPlatform): string {
  if (!spec.fields.length && spec.configNoteKey) return t(spec.configNoteKey)
  const fields = spec.fields.filter((f) => !f.optional).map((f) => t(`channels.field.${f.key}`))
  return t('channels.needs', { fields: fields.join(' + ') })
}

function statusTone(bot: BotRow): string {
  if (!bot.configured || !bot.enabled) return 'muted'
  switch (bot.status.lifecycle) {
    case 'ready':
      return 'ok'
    case 'blocked':
      return 'bad'
    case 'recovering':
    case 'starting':
      return 'warn'
    default:
      return 'muted'
  }
}

function openForm(spec: RegisteredChannelPlatform, bot: BotRow): void {
  const draft: Record<string, string> = {}
  for (const f of spec.fields) {
    const v = f.secret ? '' : bot.config[f.key]
    draft[f.key] = typeof v === 'string' ? v : (f.options?.[0] ?? '')
  }
  if (bot.isNew) draft.name = ''
  drafts[bot.key] = draft
  errorByBot[bot.key] = ''
  expanded.value = bot.key
}

function toggleExpanded(spec: RegisteredChannelPlatform, bot: BotRow): void {
  if (expanded.value === bot.key) {
    expanded.value = null
    return
  }
  openForm(spec, bot)
  if (usesQuickAdd(spec, bot)) void prefillFromClipboard(spec, bot.key)
}

function startAdding(spec: RegisteredChannelPlatform): void {
  const account = newAccountId()
  adding[spec.id] = account
  const bot = emptyBot(spec.id, account, true)
  openForm(spec, bot)
  if (usesQuickAdd(spec, bot)) void prefillFromClipboard(spec, bot.key)
}

/** A bot not set up yet, on a platform with a credential to verify (not iMessage). */
function usesQuickAdd(spec: RegisteredChannelPlatform, bot: BotRow): boolean {
  return !bot.configured && spec.fields.some((f) => f.secret)
}

/** Read the clipboard only on a button press, and keep it only when it has the
 *  shape of one of the platform's empty credential fields; anything else is dropped unseen. */
async function prefillFromClipboard(spec: RegisteredChannelPlatform, key: string): Promise<void> {
  if (!spec.fields.some((f) => f.clipboardPattern)) return
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    return
  }
  const field = clipboardTokenField(spec.fields, text)
  const draft = drafts[key]
  if (field && draft && !draft[field]) draft[field] = text.trim()
}

function closeForm(spec: RegisteredChannelPlatform, bot: BotRow): void {
  expanded.value = null
  if (bot.isNew) delete adding[spec.id]
}

async function run(key: string | null, op: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
  busy.value = true
  try {
    const res = await op()
    const msg = res.ok ? '' : (res.error ?? t('channels.error.generic'))
    if (key) errorByBot[key] = msg
    else listError.value = msg
    return res.ok
  } finally {
    busy.value = false
  }
}

/** The form as a configure request; null (with the error shown) when a required field is empty. */
function formRequest(spec: RegisteredChannelPlatform, bot: BotRow): { config: Record<string, unknown>; secret: Record<string, string> | undefined } | null {
  const draft = drafts[bot.key] ?? {}
  const config: Record<string, unknown> = { ...bot.config }
  // The permission relay is always on (Navide Guard screens every chat approval).
  delete config.permission_relay
  delete config.secret_hint
  const secret: Record<string, string> = {}
  for (const f of spec.fields) {
    const v = (draft[f.key] ?? '').trim()
    if (f.secret) {
      if (v) secret[f.key] = v
    } else if (v || !f.optional) {
      config[f.key] = v
    } else {
      delete config[f.key]
    }
  }
  const name = (draft.name ?? '').trim()
  if (bot.isNew && name) config.name = name
  const missing = spec.fields.filter((f) =>
    f.optional ? false : f.secret ? !bot.configured && !secret[f.key] : !(config[f.key] as string)
  )
  if (missing.length) {
    errorByBot[bot.key] = t('channels.error.missing', { fields: missing.map((f) => t(`channels.field.${f.key}`)).join(', ') })
    return null
  }
  // A platform without credentials (iMessage) still sends an empty secret.
  const sendSecret = Object.keys(secret).length > 0 || !spec.fields.some((f) => f.secret)
  return { config, secret: sendSecret ? secret : undefined }
}

async function save(spec: RegisteredChannelPlatform, bot: BotRow): Promise<void> {
  const req = formRequest(spec, bot)
  if (!req) return
  const ok = await run(bot.key, () => store.configure(spec.id, req.config, req.secret, bot.account))
  if (ok) closeForm(spec, bot)
}

async function quickAdd(spec: RegisteredChannelPlatform, bot: BotRow): Promise<void> {
  // Busy before the clipboard read: a second press meanwhile would add the same bot twice.
  if (busy.value) return
  busy.value = true
  try {
    if (spec.fields.some((f) => f.secret && !(drafts[bot.key]?.[f.key] ?? '').trim())) {
      await prefillFromClipboard(spec, bot.key)
    }
    const req = formRequest(spec, bot)
    if (!req) return
    // Only a platform whose primary link button opens a link gets an invite right away;
    // the others show their link guide once the bot is connected.
    const primary = spec.link.targets[0]
    const linkTarget = primary?.opensLink ? primary.target : undefined
    errorByBot[bot.key] = ''
    delete quickAdded[bot.key]
    quickStep[bot.key] = 'verifying'
    const res = await store.quickAdd(spec.id, req.config, req.secret ?? {}, bot.account, linkTarget)
    if (!res.ok || !res.data) {
      delete quickStep[bot.key]
      const error = res.error ?? t('channels.error.generic')
      errorByBot[bot.key] = res.reason === 'rejected' || res.reason === 'timeout'
        ? t(`channels.quick.${res.reason}`, { platform: platformName(spec.id), error })
        : error
      return
    }
    closeForm(spec, bot)
    // The link guide only shows on a connected bot: hand it the invite only then.
    const added = botsOf(spec.id).find((b) => b.account === bot.account)
    if (res.data.link && added && isConnected(added)) {
      quickStep[bot.key] = 'opening'
      quickInvite[bot.key] = res.data.link
    } else {
      endQuickSteps(bot.key)
    }
  } finally {
    busy.value = false
  }
}

/** Stop the steps where the link guide cannot go on: the row says to link from the guide. */
function endQuickSteps(key: string): void {
  delete quickStep[key]
  delete quickInvite[key]
  quickAdded[key] = true
}

function quickOpened(key: string, copied: boolean): void {
  delete quickInvite[key]
  quickCopied[key] = copied
  if (quickStep[key] === 'opening') quickStep[key] = 'waiting'
}

function botLinked(key: string): void {
  delete quickAdded[key]
  if (quickStep[key]) quickStep[key] = 'done'
  loadOverview()
}

function stepState(key: string, step: QuickStep): string {
  const at = QUICK_STEPS.indexOf(quickStep[key] ?? 'verifying')
  const i = QUICK_STEPS.indexOf(step)
  return i === at ? 'current' : i < at ? 'past' : ''
}

function quickStepText(spec: RegisteredChannelPlatform, step: QuickStep): string {
  if (step === 'waiting') {
    return t(spec.link.urlCarriesCode ? 'channels.quick.step.waiting-start' : 'channels.quick.step.waiting-paste')
  }
  return t(`channels.quick.step.${step}`, { platform: platformName(spec.id) })
}

function openSetupLink(url: string): void {
  void window.agentTeam?.openExternal?.(url)
}

/** Make the t.me/newbot link (only after the disclosure was confirmed) and open it. */
async function createManaged(bot: BotRow): Promise<void> {
  if (busy.value) return
  managedAsk.value = null
  delete managedError[bot.key]
  busy.value = true
  try {
    const res = await store.managedCreate(bot.account)
    if (!res.ok || !res.data) {
      managedError[bot.key] = res.reason === 'manager_not_linked'
        ? t('channels.managed.manager-not-linked')
        : res.error ?? t('channels.error.generic')
      return
    }
    managedWaiting[bot.key] = res.data.request_id
    openSetupLink(res.data.url)
  } finally {
    busy.value = false
  }
}

function managedFailureText(ev: ChannelManagedCreatedEvent): string {
  // Only a request that ran out has no bot in Telegram; a quick add can time out too.
  if (ev.reason === 'timeout' && !ev.created) return t('channels.managed.timeout')
  if (ev.reason === 'token_unavailable') return t('channels.managed.token-unavailable')
  if (ev.reason === 'creator_not_linked') return t('channels.managed.creator-not-linked')
  const error = ev.error || t('channels.error.generic')
  const text = ev.reason === 'rejected' || ev.reason === 'timeout'
    ? t(`channels.quick.${ev.reason}`, { platform: platformName('telegram'), error })
    : error
  // The bot exists in Telegram even though it was not added: a blind retry makes a second one.
  return ev.created ? `${text} ${t('channels.managed.created-note')}` : text
}

/** The created bot is added (or failed): hand its invite to its link guide, as quick add does. */
async function managedCreated(ev: ChannelManagedCreatedEvent): Promise<void> {
  const managerKey = Object.keys(managedWaiting).find((k) => managedWaiting[k] === ev.request_id)
  if (!managerKey) return
  delete managedWaiting[managerKey]
  if (!ev.ok || !ev.account) {
    managedError[managerKey] = managedFailureText(ev)
    return
  }
  await store.refresh()
  const key = botKey('telegram', ev.account)
  const added = botsOf('telegram').find((b) => b.account === ev.account)
  if (ev.link && added && isConnected(added)) {
    quickStep[key] = 'opening'
    quickInvite[key] = ev.link
  } else {
    endQuickSteps(key)
  }
}

watch(() => store.lastManagedCreated.value, (ev) => {
  if (ev) void managedCreated(ev)
})
// The backend keeps open requests in memory only: after a dropped connection none may be left.
watch(() => store.linkEpoch.value, () => {
  for (const key of Object.keys(managedWaiting)) delete managedWaiting[key]
})

/** Panes connected through this bot: removing it disconnects them. */
function boundCount(platform: ChannelPlatform, account: string): number {
  return store.bindings.value.filter((b) => b.platform === platform && (b.account || DEFAULT_ACCOUNT) === account).length
}

async function removeBot(spec: RegisteredChannelPlatform, bot: BotRow): Promise<void> {
  // The last bot takes the platform with it (allowlist and pairing requests too),
  // exactly as removing a platform always has.
  const last = (store.platformState(spec.id)?.accounts.length ?? 0) <= 1
  const ok = await run(bot.key, () => (last ? store.remove(spec.id) : store.remove(spec.id, bot.account)))
  confirmingRemove.value = null
  if (ok) expanded.value = null
}

function startRename(bot: BotRow): void {
  renaming.value = bot.key
  renameDraft.value = bot.name
}

async function saveRename(spec: RegisteredChannelPlatform, bot: BotRow): Promise<void> {
  const ok = await run(bot.key, () => store.renameAccount(spec.id, bot.account, renameDraft.value.trim()))
  if (ok) renaming.value = null
}

function isConnected(bot: BotRow): boolean {
  return bot.configured && bot.enabled && bot.status.connected && store.enabled.value
}

// The chats each bot knows and who is bound to each (channels.overview). A connected
// bot with none shows the linking guide as the next step; otherwise its chats.
const linkOpen = ref<string | null>(null)
const connectedBots = computed(() =>
  specs.value.flatMap((s) => botsOf(s.id).filter(isConnected).map((b) => ({ platform: s.id, bot: b })))
)
const connectedKey = computed(() => connectedBots.value.map((c) => c.bot.key).join(','))

function chatsOf(platform: ChannelPlatform, bot: BotRow): ChannelOverviewChat[] {
  return store.overviewFor(platform, bot.account)?.chats ?? []
}

function loadOverview(): void {
  void store.loadOverview()
}

// Pane names and states change without channels.changed: fetch afresh whenever the page shows.
onMounted(loadOverview)
onMounted(() => void store.loadShareOpenNotify())
onBeforeUnmount(() => store.releaseShareOpenNotify())
watch(() => [store.lastLinked.value, connectedKey.value], loadOverview)

// An invite waiting for the link guide, on a bot whose guide will not show
// (its chats failed to load, or it is no longer connected), must not hold the steps at "opening".
watch(
  () => Object.keys(quickStep).filter((k) => quickStep[k] === 'opening'
    && (!!store.overviewError.value || !connectedBots.value.some((c) => c.bot.key === k))),
  (stuck) => stuck.forEach(endQuickSteps)
)

/** "3 bots · 4 chats · 3 panes bound" for a configured platform. */
function platformSummary(platform: ChannelPlatform): string {
  const bots = store.platformState(platform)?.accounts.length ?? 0
  const known = store.overview.value.filter((b) => b.platform === platform)
  const chats = known.reduce((n, b) => n + b.chats.length, 0)
  const panes = known.reduce((n, b) => n + b.chats.reduce((m, c) => m + c.bindings.filter((x) => x.pane.exists).length, 0), 0)
  return t('channels.platform-summary', { bots, chats, panes })
}

// The ⋯ menu of one bot at a time; it closes on a pick, a click elsewhere, or Esc.
const menuOpen = ref<string | null>(null)

function closeMenu(e?: Event): void {
  if (e instanceof KeyboardEvent && e.key !== 'Escape') return
  if (e instanceof MouseEvent && (e.target as Element | null)?.closest?.('.ch-menu-wrap')) return
  menuOpen.value = null
}

onMounted(() => {
  document.addEventListener('mousedown', closeMenu)
  document.addEventListener('keydown', closeMenu)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', closeMenu)
  document.removeEventListener('keydown', closeMenu)
})

function menuPick(action: () => void): void {
  menuOpen.value = null
  action()
}

function askRemove(spec: RegisteredChannelPlatform, bot: BotRow): void {
  if (expanded.value !== bot.key) openForm(spec, bot)
  confirmingRemove.value = bot.key
}

// Bot Management Mode: one hint per platform for the connected bots that lack it,
// until the user dismisses it on this machine.
const MANAGED_HINT_KEY = 'navide.channels.managedHintDismissed'
function readHintDismissed(): boolean {
  try {
    return localStorage.getItem(MANAGED_HINT_KEY) === '1'
  } catch {
    return false
  }
}
const managedHintDismissed = ref(readHintDismissed())

function dismissManagedHint(): void {
  managedHintDismissed.value = true
  try {
    localStorage.setItem(MANAGED_HINT_KEY, '1')
  } catch {
    // Not remembered: it hides for this session only.
  }
}

function botsWithoutManageMode(platform: ChannelPlatform): number {
  if (platform !== 'telegram') return 0
  return botsOf(platform).filter((b) => isConnected(b) && !b.status.can_manage_bots).length
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  return new Date(ms).toLocaleString()
}
</script>

<template>
  <section class="channels-pane" data-settings-section="channels">
    <SettingsCard>
      <SettingRow :title="t('channels.global.title')" :description="t('channels.global.desc')">
        <template #control>
          <ToggleSwitch
            data-testid="channels-global-toggle"
            :model-value="store.enabled.value"
            :disabled="busy"
            :aria-label="t('channels.global.title')"
            @update:model-value="(v: boolean) => run(null, () => store.setGlobalEnabled(v))"
          />
        </template>
      </SettingRow>
      <SettingRow
        v-if="store.shareOpenNotify.value !== null"
        :title="t('channels.shareOpenNotify.title')"
        :description="t('channels.shareOpenNotify.desc')"
      >
        <template #control>
          <ToggleSwitch
            data-testid="channels-share-open-notify-toggle"
            :model-value="store.shareOpenNotify.value"
            :disabled="busy"
            :aria-label="t('channels.shareOpenNotify.title')"
            @update:model-value="(v: boolean) => run(null, () => store.setShareOpenNotify(v))"
          />
        </template>
      </SettingRow>
    </SettingsCard>
    <p v-if="listError || store.error.value" class="ch-error ch-list-error" role="alert">{{ listError || store.error.value }}</p>

    <SettingsSection :label="t('channels.section.platforms')">
      <SettingsCard>
        <div
          v-for="spec in specs"
          :key="spec.id"
          class="ch-row"
          :class="{ open: !!expanded?.startsWith(`${spec.id}:`) }"
          :data-platform="spec.id"
        >
          <div class="ch-row-head">
            <span class="ch-mark" :class="{ on: isConfigured(spec.id) }" aria-hidden="true">{{ spec.badge }}</span>
            <div class="ch-row-text">
              <div class="ch-row-title">
                <span class="ch-row-name">{{ platformName(spec.id) }}</span>
                <span
                  v-if="pendingCount(spec.id)"
                  class="ch-pill pending"
                  data-testid="channel-pending"
                >{{ t('channels.pending-count', { n: pendingCount(spec.id) }) }}</span>
              </div>
              <div class="ch-row-desc">{{ t(`channels.desc.${spec.id}`) }}</div>
              <div v-if="isConfigured(spec.id) && store.overviewLoaded.value" class="ch-row-summary" data-testid="channel-platform-summary">{{ platformSummary(spec.id) }}</div>
            </div>
            <div class="ch-row-actions">
              <button
                v-if="isConfigured(spec.id) && !adding[spec.id]"
                type="button"
                class="ch-btn ghost sm"
                :disabled="busy"
                data-testid="channel-add-bot"
                @click="startAdding(spec)"
              >{{ t('channels.bot.add') }}</button>
            </div>
          </div>

          <p v-if="botsWithoutManageMode(spec.id) && !managedHintDismissed" class="ch-platform-hint" data-testid="channel-managed-enable">
            <span aria-hidden="true">ⓘ</span>
            <span>{{ t('channels.managed.enable-hint', { n: botsWithoutManageMode(spec.id) }) }}</span>
            <a
              class="ch-setup-link"
              :href="BOTFATHER_APP_URL"
              data-testid="channel-managed-botfather"
              @click.prevent="openSetupLink(BOTFATHER_APP_URL)"
            >{{ t('channels.managed.open-botfather') }}</a>
            <button type="button" class="ch-link-btn" data-testid="channel-managed-dismiss" @click="dismissManagedHint">{{ t('channels.managed.dismiss') }}</button>
          </p>

          <div v-for="bot in botsOf(spec.id)" :key="bot.key" class="ch-bot" :data-account="bot.account" data-testid="channel-bot">
            <div class="ch-bot-head">
              <div class="ch-row-text">
                <div class="ch-row-title">
                  <template v-if="bot.configured">
                    <form v-if="renaming === bot.key" class="ch-rename" @submit.prevent="saveRename(spec, bot)">
                      <input
                        v-model="renameDraft"
                        class="ch-input"
                        name="bot-name"
                        :placeholder="botLabel(bot)"
                        :aria-label="t('channels.bot.name')"
                        autocomplete="off"
                        spellcheck="false"
                      />
                      <button type="submit" class="ch-btn primary sm" :disabled="busy" data-testid="channel-rename-save">{{ t('channels.save') }}</button>
                      <button type="button" class="ch-btn ghost sm" :disabled="busy" @click="renaming = null">{{ t('channels.cancel') }}</button>
                    </form>
                    <span v-else class="ch-bot-name" data-testid="channel-bot-name">{{ botLabel(bot) }}</span>
                  </template>
                  <span v-else-if="bot.isNew" class="ch-bot-name">{{ t('channels.bot.new') }}</span>
                  <span class="ch-pill" :class="statusTone(bot)" data-testid="channel-status">{{ statusText(bot) }}</span>
                </div>
                <div
                  v-if="bot.status.last_error"
                  class="ch-row-error"
                  v-truncate
                  :class="statusTone(bot)"
                  data-testid="channel-last-error"
                >{{ bot.status.last_error }}</div>
              </div>
              <div class="ch-row-actions">
                <ToggleSwitch
                  v-if="bot.configured"
                  :model-value="bot.enabled"
                  :disabled="busy || !store.enabled.value"
                  :aria-label="t('channels.enable-platform', { platform: `${platformName(spec.id)} ${botLabel(bot)}` })"
                  @update:model-value="(v: boolean) => run(bot.key, () => store.setEnabled(spec.id, v, bot.account))"
                />
                <button v-if="!bot.isNew && !bot.configured" type="button" class="ch-btn ghost sm" data-testid="channel-manage" @click="toggleExpanded(spec, bot)">
                  {{ t('channels.connect') }}
                </button>
                <div v-if="bot.configured" class="ch-menu-wrap">
                  <button
                    type="button"
                    class="ch-btn ghost sm ch-menu-btn"
                    data-testid="channel-bot-menu"
                    aria-haspopup="menu"
                    :aria-expanded="menuOpen === bot.key"
                    :aria-label="t('channels.menu.label', { bot: botLabel(bot) })"
                    @click="menuOpen = menuOpen === bot.key ? null : bot.key"
                  >⋯</button>
                  <div v-show="menuOpen === bot.key" class="ch-menu" role="menu" data-testid="channel-bot-menu-list">
                    <button type="button" role="menuitem" :disabled="busy" data-testid="channel-rename" @click="menuPick(() => startRename(bot))">{{ t('channels.bot.rename') }}</button>
                    <button type="button" role="menuitem" data-testid="channel-manage" @click="menuPick(() => toggleExpanded(spec, bot))">{{ t('channels.menu.connection') }}</button>
                    <button
                      v-if="spec.id === 'telegram' && isConnected(bot) && !managedWaiting[bot.key]"
                      type="button"
                      role="menuitem"
                      :disabled="busy || !bot.status.can_manage_bots"
                      data-testid="channel-managed-create"
                      @click="menuPick(() => { managedAsk = bot.key })"
                    >{{ t('channels.managed.create') }}<small v-if="!bot.status.can_manage_bots" class="ch-menu-note">{{ t('channels.menu.create-off') }}</small></button>
                    <button
                      v-if="isConnected(bot)"
                      type="button"
                      role="menuitem"
                      data-testid="channel-link-account"
                      :aria-expanded="linkOpen === bot.key"
                      @click="menuPick(() => { linkOpen = linkOpen === bot.key ? null : bot.key })"
                    >{{ t('channels.link.link-account') }}</button>
                    <button type="button" role="menuitem" class="danger" :disabled="busy" data-testid="channel-remove-bot" @click="menuPick(() => askRemove(spec, bot))">{{ t('channels.menu.remove') }}</button>
                  </div>
                </div>
              </div>
            </div>

            <template v-if="quickStep[bot.key]">
              <ol class="ch-quick-steps" data-testid="channel-quick-steps" :data-step="quickStep[bot.key]">
                <li v-for="step in QUICK_STEPS" :key="step" :class="stepState(bot.key, step)">{{ quickStepText(spec, step) }}</li>
              </ol>
              <p
                v-if="quickStep[bot.key] === 'waiting' && !spec.link.urlCarriesCode && quickCopied[bot.key]"
                class="ch-form-hint"
                data-testid="channel-quick-copied"
              >{{ t('channels.quick.copied-code', { platform: platformName(spec.id) }) }}</p>
            </template>
            <p v-else-if="quickAdded[bot.key]" class="ch-form-hint" data-testid="channel-quick-added">{{ t('channels.quick.added') }}</p>

            <div
              v-if="spec.id === 'telegram' && isConnected(bot) && (managedWaiting[bot.key] || managedAsk === bot.key || managedError[bot.key])"
              class="ch-managed"
            >
              <p v-if="managedWaiting[bot.key]" class="ch-form-hint" data-testid="channel-managed-waiting">{{ t('channels.managed.waiting') }}</p>
              <template v-else-if="managedAsk === bot.key && bot.status.can_manage_bots">
                <p class="ch-managed-title" data-testid="channel-managed-title">{{ t('channels.managed.title', { manager: bot.status.identity }) }}</p>
                <p class="ch-managed-warn" role="note" data-testid="channel-managed-disclose">{{ t('channels.managed.disclose', { manager: bot.status.identity }) }}</p>
                <div class="ch-form-actions">
                  <button type="button" class="ch-btn ghost sm" data-testid="channel-managed-cancel" @click="managedAsk = null">{{ t('channels.cancel') }}</button>
                  <button type="button" class="ch-btn primary sm" :disabled="busy" data-testid="channel-managed-confirm" @click="createManaged(bot)">{{ t('channels.managed.confirm') }}</button>
                </div>
              </template>
              <p v-if="managedError[bot.key]" class="ch-error" role="alert" data-testid="channel-managed-error">{{ managedError[bot.key] }}</p>
            </div>

            <div v-if="isConnected(bot) && store.overviewError.value" class="ch-link" data-testid="channel-link-block">
              <div class="ch-link-summary">
                <span class="ch-link-error" role="alert">{{ t('channels.link.count-failed', { error: store.overviewError.value }) }}</span>
                <button type="button" class="ch-btn ghost sm" data-testid="channel-link-retry" @click="loadOverview">{{ t('action.retry') }}</button>
              </div>
            </div>
            <div
              v-else-if="isConnected(bot) && store.overviewLoaded.value
                && (!chatsOf(spec.id, bot).length || (quickStep[bot.key] && quickStep[bot.key] !== 'done'))"
              class="ch-link next"
              data-testid="channel-link-block"
            >
              <div class="ch-link-title" data-testid="channel-next-step">{{ t('channels.link.next-step') }}</div>
              <p class="ch-link-desc">{{ t('channels.link.next-step-desc', { platform: platformName(spec.id) }) }}</p>
              <ChannelLinkGuide
                :store="store"
                :platform="spec.id"
                :account="bot.account"
                :initial-invite="quickInvite[bot.key] ?? null"
                @opened="(copied) => quickOpened(bot.key, copied)"
                @linked="botLinked(bot.key)"
              />
            </div>
            <div v-else-if="chatsOf(spec.id, bot).length" class="ch-link" data-testid="channel-link-block">
              <ChannelChatBindings :store="store" :chats="chatsOf(spec.id, bot)" :busy="busy" />
              <ChannelLinkGuide v-if="linkOpen === bot.key && isConnected(bot)" :store="store" :platform="spec.id" :account="bot.account" @linked="loadOverview" />
            </div>

            <form v-if="expanded === bot.key" class="ch-form" @submit.prevent="usesQuickAdd(spec, bot) ? quickAdd(spec, bot) : save(spec, bot)">
              <div class="ch-form-notes">
                <p class="ch-form-needs" data-testid="channel-needs">{{ needsText(spec) }}</p>
                <template v-if="spec.setupLink && !bot.configured">
                  <a
                    class="ch-setup-link"
                    :href="spec.setupLink.url"
                    data-testid="channel-setup-link"
                    @click.prevent="openSetupLink(spec.setupLink.url)"
                  >{{ t(spec.setupLink.label) }}</a>
                  <p class="ch-form-hint">{{ t(spec.setupLink.hint) }}</p>
                </template>
                <p v-if="te(`channels.hint.${spec.id}`)" class="ch-form-hint" data-testid="channel-hint">{{ t(`channels.hint.${spec.id}`) }}</p>
                <p v-if="spec.singleReceiver" class="ch-form-hint" data-testid="channel-single-receiver">{{ t('channels.single-receiver-hint') }}</p>
              </div>
              <label v-if="bot.isNew && !usesQuickAdd(spec, bot)" class="ch-field">
                <span class="ch-field-label">{{ t('channels.bot.name') }} {{ t('channels.optional') }}</span>
                <input v-model="drafts[bot.key]!.name" class="ch-input" name="name" autocomplete="off" spellcheck="false" />
              </label>
              <label v-for="f in spec.fields" :key="f.key" class="ch-field">
                <span class="ch-field-label">{{ t(`channels.field.${f.key}`) }}<template v-if="f.optional"> {{ t('channels.optional') }}</template></span>
                <select v-if="f.options" v-model="drafts[bot.key]![f.key]" class="ch-input" :name="f.key">
                  <option v-for="o in f.options" :key="o" :value="o">{{ t(`channels.option.${o}`) }}</option>
                </select>
                <input
                  v-else
                  v-model="drafts[bot.key]![f.key]"
                  class="ch-input"
                  :type="f.secret ? 'password' : 'text'"
                  :name="f.key"
                  autocomplete="off"
                  spellcheck="false"
                  :placeholder="f.secret && bot.configured ? t('channels.secret-stored') : ''"
                />
              </label>
              <details v-if="bot.isNew && usesQuickAdd(spec, bot)" class="ch-advanced" data-testid="channel-advanced">
                <summary>{{ t('channels.quick.advanced') }}</summary>
                <label class="ch-field">
                  <span class="ch-field-label">{{ t('channels.bot.name') }} {{ t('channels.optional') }}</span>
                  <input v-model="drafts[bot.key]!.name" class="ch-input" name="name" autocomplete="off" spellcheck="false" />
                </label>
              </details>
              <p v-if="errorByBot[bot.key]" class="ch-error" role="alert">{{ errorByBot[bot.key] }}</p>
              <p v-if="confirmingRemove === bot.key" class="ch-form-hint ch-remove-ask" data-testid="channel-remove-ask">
                {{ t('channels.bot.remove-ask', { n: boundCount(spec.id, bot.account) }) }}
              </p>
              <div class="ch-form-actions">
                <template v-if="bot.configured">
                  <button
                    v-if="confirmingRemove !== bot.key"
                    type="button"
                    class="ch-btn danger-ghost sm"
                    :disabled="busy"
                    data-testid="channel-remove"
                    @click="confirmingRemove = bot.key"
                  >{{ t('channels.remove') }}</button>
                  <template v-else>
                    <button type="button" class="ch-btn ghost sm" :disabled="busy" data-testid="channel-remove-cancel" @click="confirmingRemove = null">{{ t('channels.cancel') }}</button>
                    <button type="button" class="ch-btn danger-ghost sm" :disabled="busy" data-testid="channel-remove-confirm" @click="removeBot(spec, bot)">{{ t('channels.remove') }}</button>
                  </template>
                </template>
                <span class="ch-spacer"></span>
                <button type="button" class="ch-btn ghost sm" :disabled="busy" @click="closeForm(spec, bot)">{{ t('channels.cancel') }}</button>
                <button v-if="usesQuickAdd(spec, bot)" type="submit" class="ch-btn primary sm" :disabled="busy" data-testid="channel-quick-add">
                  {{ quickStep[bot.key] === 'verifying' ? t('channels.quick.verifying') : t('channels.quick.add') }}
                </button>
                <button v-else type="submit" class="ch-btn primary sm" :disabled="busy" data-testid="channel-save">{{ t('channels.save') }}</button>
              </div>
            </form>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection v-if="store.pairing.value.length" :label="t('channels.pairing.title')">
      <p class="ch-section-hint">{{ t('channels.pairing.hint') }}</p>
      <SettingsCard>
        <div v-for="req in store.pairing.value" :key="`${req.platform}:${req.code}`" class="ch-item" data-testid="pairing-row">
          <span class="ch-mark sm" aria-hidden="true">{{ badgeOf(req.platform) }}</span>
          <div class="ch-item-text">
            <span class="ch-item-name" v-truncate>{{ req.sender_name || req.sender_id }}</span>
            <span class="ch-item-meta" v-truncate>{{ platformName(req.platform) }}<template v-if="entryBot(req.platform, req.account)"> · <span data-testid="pairing-bot">{{ entryBot(req.platform, req.account) }}</span></template> · {{ formatTime(req.created_at) }}</span>
          </div>
          <code class="ch-code">{{ req.code }}</code>
          <div class="ch-row-actions">
            <button type="button" class="ch-btn ghost sm" :disabled="busy" data-testid="pairing-reject" @click="run(null, () => store.rejectPairing(req.platform, req.code))">{{ t('channels.pairing.reject') }}</button>
            <button type="button" class="ch-btn primary sm" :disabled="busy" data-testid="pairing-approve" @click="run(null, () => store.approvePairing(req.platform, req.code))">{{ t('channels.pairing.approve') }}</button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection v-if="store.allow.value.length" :label="t('channels.allow.title')">
      <SettingsCard>
        <div v-for="entry in store.allow.value" :key="`${entry.platform}:${entry.account}:${entry.sender_id}`" class="ch-item" data-testid="allow-row">
          <span class="ch-mark sm" aria-hidden="true">{{ badgeOf(entry.platform) }}</span>
          <div class="ch-item-text">
            <span class="ch-item-name" v-truncate>{{ entry.sender_name || entry.sender_id }}</span>
            <span class="ch-item-meta" v-truncate>{{ platformName(entry.platform) }}<template v-if="entryBot(entry.platform, entry.account)"> · <span data-testid="allow-bot">{{ entryBot(entry.platform, entry.account) }}</span></template> · {{ entry.sender_id }}</span>
          </div>
          <div class="ch-row-actions">
            <button type="button" class="ch-btn ghost sm" :disabled="busy" data-testid="allow-remove" @click="run(null, () => store.removeAllow(entry.platform, entry.sender_id, entry.account))">{{ t('channels.allow.remove') }}</button>
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  </section>
</template>

<style scoped>
.channels-pane { display: flex; flex-direction: column; }
.ch-list-error { margin-top: 8px; }
.ch-error { margin: 0; font-size: var(--font-2xs); color: var(--danger-fg); word-break: break-word; }

/* Platform rows: same inset and type scale as SettingRow. */
.ch-row { padding: var(--space-row-y) var(--space-row-x); }
.ch-row.open { background: var(--bg-base); }
.ch-row-head { display: flex; align-items: center; gap: 12px; }
.ch-mark {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.02em;
}
.ch-mark.on { color: var(--accent-fg); border-color: var(--accent-muted); background: var(--accent-subtle); }
.ch-mark.sm { width: 22px; height: 22px; }
.ch-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ch-row-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ch-row-name { font-size: var(--font-row-title); font-weight: 600; color: var(--text-bright); }
.ch-row-desc { font-size: var(--font-row-desc); color: var(--text-secondary); }
.ch-row-summary { font-size: var(--font-2xs); color: var(--text-muted); }
.ch-platform-hint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 0 40px;
  padding: 6px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-muted);
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.ch-platform-hint .ch-setup-link { align-self: auto; }

/* A bot's ⋯ menu: the actions used less often than its switch. */
.ch-menu-wrap { position: relative; }
.ch-menu-btn { min-width: 28px; font-weight: 700; letter-spacing: 0.08em; }
.ch-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-overlay, var(--bg-base));
  box-shadow: var(--shadow-popover);
}
.ch-menu > button {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  font: inherit;
  font-size: var(--font-xs);
  text-align: left;
  color: var(--text-primary);
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 6px 8px;
  cursor: pointer;
}
.ch-menu > button:hover:not(:disabled) { background: var(--bg-muted); }
.ch-menu > button:disabled { opacity: 0.55; cursor: not-allowed; }
.ch-menu > button.danger { color: var(--danger-fg); }
.ch-menu-note { font-size: var(--font-3xs); color: var(--text-secondary); }
.ch-row-error {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.ch-row-error.warn { color: var(--attention-fg); }
.ch-row-error.bad { color: var(--danger-fg); }
.ch-row-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* Bots under a platform, aligned with the platform's text. */
.ch-bot { margin: 8px 0 0 40px; }
.ch-bot + .ch-bot { padding-top: 8px; border-top: 1px solid var(--border-muted); }
.ch-bot-head { display: flex; align-items: center; gap: 12px; }
.ch-bot-name { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); }
.ch-link-btn { font: inherit; font-size: var(--font-2xs); color: var(--accent-fg); background: transparent; border: none; padding: 0; cursor: pointer; }
.ch-link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ch-rename { display: flex; align-items: center; gap: 6px; }
.ch-remove-ask { color: var(--danger-fg); }

/* Status pill: same shape as the account badges on the Accounts page. */
.ch-pill {
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--text-secondary);
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  white-space: nowrap;
}
.ch-pill.ok { color: var(--success-fg); background: var(--success-subtle); border-color: var(--success-muted); }
.ch-pill.warn { color: var(--attention-fg); background: var(--attention-subtle); border-color: var(--attention-muted); }
.ch-pill.bad { color: var(--danger-fg); background: var(--danger-subtle); border-color: var(--danger-muted); }
.ch-pill.pending { color: var(--accent-fg); background: var(--accent-subtle); border-color: var(--accent-muted); }

/* Connect / manage form, revealed under its row. */
.ch-form { display: flex; flex-direction: column; gap: 10px; margin: 12px 0 2px; }
.ch-form-notes { display: flex; flex-direction: column; gap: 4px; }
.ch-form-needs { margin: 0; font-size: var(--font-row-desc); font-weight: 600; color: var(--text-primary); }
.ch-form-hint { margin: 0; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.4; }
.ch-field { display: flex; flex-direction: column; gap: 4px; }
.ch-field-label { font-size: var(--font-2xs); color: var(--text-secondary); }
.ch-input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 5px 8px;
}
.ch-input:hover { border-color: var(--border-strong); }
.ch-input:focus { outline: none; border-color: var(--accent-focus); }
.ch-form-actions { display: flex; align-items: center; gap: 8px; }
.ch-setup-link { align-self: flex-start; font-size: var(--font-row-desc); color: var(--accent-fg); }
.ch-advanced > summary { cursor: pointer; font-size: var(--font-2xs); color: var(--text-secondary); }
.ch-advanced > .ch-field { margin-top: 6px; }

/* Quick add progress: verifying → opening → waiting → done. */
.ch-quick-steps { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 0; padding: 0; list-style: none; font-size: var(--font-2xs); color: var(--text-secondary); }
.ch-quick-steps li.past { color: var(--success-fg); }
.ch-quick-steps li.current { color: var(--text-bright); font-weight: 600; }
.ch-spacer { flex: 1; }

/* Creating a bot through a managing Telegram bot. */
.ch-managed { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin: 8px 0 0; }
.ch-managed-title { margin: 0; font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); }
.ch-managed-warn {
  margin: 0;
  padding: 6px 10px;
  font-size: var(--font-row-desc);
  line-height: 1.4;
  color: var(--text-primary);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: var(--radius-sm);
}

/* Buttons: the Accounts page's button set. */
.ch-btn {
  border-radius: 5px;
  font-size: var(--font-xs);
  padding: 5px 10px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
  white-space: nowrap;
}
.ch-btn.sm { font-size: var(--font-2xs); padding: 3px 8px; }
.ch-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ch-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ch-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.ch-btn.ghost { color: var(--text-secondary); }
.ch-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
.ch-btn.danger-ghost { color: var(--danger-fg); border-color: var(--danger-muted); }
.ch-btn.danger-ghost:hover:not(:disabled) { border-color: var(--danger-fg); }

/* Linking guide under a connected platform, aligned with the row text. */
.ch-link { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 2px; }
.ch-link.next { padding: 10px 12px; border: 1px solid var(--accent-muted); border-radius: var(--radius-sm); background: var(--accent-subtle); }
.ch-link-title { font-size: var(--font-row-desc); font-weight: 600; color: var(--text-bright); }
.ch-link-desc { margin: 0; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.4; }
.ch-link-summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--font-row-desc); color: var(--text-secondary); }
.ch-link-error { color: var(--danger-fg); word-break: break-word; }

/* Pairing / allowlist rows. */
.ch-section-hint { margin: 0 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); }
.ch-item { display: flex; align-items: center; gap: 10px; padding: 8px var(--space-row-x); }
.ch-item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ch-item-name { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-item-meta { font-size: var(--font-2xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-code { font-family: var(--font-mono, monospace); font-size: var(--font-xs); letter-spacing: 0.08em; color: var(--text-bright); }
</style>
