<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { executeCommand } from '@navide/plugin-ui/shared'
import {
  DEFAULT_ACCOUNT,
  channelsKey,
  type ChannelAccountState,
  type ChannelLocation,
  type ChannelPlatform,
  type ChannelVerbosity,
  type ChannelsStore,
} from '../composables/useChannels'
import { guardKey, type GuardStore } from '../composables/useGuard'
import { vendorRunsYolo } from '../lib/guardYolo'
import { channelBotLabel, channelBotName, formatChannelIdentity } from '../lib/channelIdentity'
import { useAgentMessaging } from '../composables/useAgentMessaging'
import ChannelLinkGuide from './ChannelLinkGuide.vue'

/**
 * Pane-header entry to chat channels. Unbound: a small button that opens a
 * popover listing every chat the configured, connected bots know, grouped by
 * bot (one group per platform unless it runs several bots); picking one opens a confirmation step that asks what the chat
 * receives, and only Connect binds (or Settings → Channels opens when no
 * platform is configured). Bound: a chip naming the platform and bot, with ✕
 * to unbind. The chip never names the pane: `binding.title` is the pane's own
 * name (or its topic's), already on the header the chip sits in.
 */
const props = defineProps<{
  paneId: string
  paneName: string
  /** The pane's CLI vendor, for the Guard warning in the popover. */
  agentKey?: string
  /** Test seam; the app provides the store through `channelsKey`. */
  store?: ChannelsStore
  /** Test seam; the app provides the store through `guardKey`. */
  guardStore?: GuardStore
}>()

// Global instance, as TerminalPane does: headers mount in tests without the plugin.
const t = i18n.global.t
const store = props.store ?? inject(channelsKey, null)
const guard = props.guardStore ?? inject(guardKey, null)

const binding = computed(() => store?.bindingFor(props.paneId) ?? null)
const open = ref(false)
const busy = ref(false)
// Step 2 of the popover: the chat picked in step 1, awaiting its level and Connect.
interface PendingBind {
  platform: ChannelPlatform
  /** The bot the chat is reached through. */
  account: string
  loc: ChannelLocation
  mode: 'new' | 'existing'
}
const pending = ref<PendingBind | null>(null)
// The mirror level the pending bind asks for.
const bindLevel = ref<ChannelVerbosity>('replies')
const error = ref('')
interface PlatformGroup {
  platform: ChannelPlatform
  account: string
  /** The bot's name, shown only when its platform runs several bots. */
  bot: string
  identity: string
  /** Status text when the platform cannot be bound to right now; empty when connected. */
  unavailable: string
  loading: boolean
  error: string
  locations: ChannelLocation[]
}
const groups = ref<PlatformGroup[]>([])
// Bumped per open, so a slow `channels.locations` reply from an earlier open is dropped.
let loadSeq = 0
const btnRef = ref<HTMLElement | null>(null)
const popRef = ref<HTMLElement | null>(null)
const popStyle = ref<Record<string, string>>({})

// A vendor Guard cannot block, running with its permission prompts off: a chat
// room would drive it with nothing between the message and the shell. Read
// when the popover opens, so a settings change since mount is picked up.
const unguardedYolo = ref(false)

function platformName(platform: string): string {
  return t(`channels.platform.${platform}`)
}

function canCreate(platform: ChannelPlatform, account: string): boolean {
  return store?.accountState(platform, account)?.capabilities?.create_location === true
}

function botLabel(platform: ChannelPlatform, account: string): string {
  const bots = store?.platformState(platform)?.accounts ?? []
  if (bots.length < 2) return ''
  return channelBotLabel(bots.find((b) => b.account === account), account, t)
}

// Platforms name one-to-one chats differently: Telegram `private`, Slack `im`,
// Discord `dm`, Mattermost `D`, the rest `direct`.
const DIRECT_KINDS = new Set(['direct', 'dm', 'private', 'im', 'D'])
function kindLabel(loc: ChannelLocation): string {
  return t(DIRECT_KINDS.has(loc.kind) ? 'channels.pane.kind-direct' : 'channels.pane.kind-group')
}

function unavailableText(p: ChannelAccountState): string {
  if (!p.enabled || !store?.enabled.value) return t('channels.status.disabled')
  if (p.status.connected) return ''
  return t(`channels.lifecycle.${p.status.lifecycle}`)
}

const messaging = useAgentMessaging()

// A refresh (channels.changed: a new chat seen, a platform reconnecting) replaces
// the platform list; reload an open picker so it never shows a stale "no chats".
watch(
  () => store?.platforms.value,
  () => {
    if (open.value) void loadGroups()
  }
)

/** Name of another live pane already connected to this chat, or '' when it is free.
 *  A chat serves one pane at a time; unbinding there frees it here. A holder
 *  this window does not know is named by the backend's overview when it is a
 *  live pane in another window; one that closed without its unbind landing
 *  stays free, left to the backend, which refuses a live one. */
function holderOf(platform: ChannelPlatform, account: string, chatId: string): string {
  const held = store?.bindings.value.find(
    (b) => b.platform === platform && (b.account || DEFAULT_ACCOUNT) === account && b.chat_id === chatId &&
      !b.thread_id && b.pane_id !== props.paneId
  )
  if (!held) return ''
  const local = messaging.nameOf(held.pane_id)
  if (local !== null) return local
  const other = store?.overviewFor(platform, account)?.chats.find((c) => c.chat_id === chatId)
    ?.bindings.find((b) => !b.thread_id && b.pane_id !== props.paneId)
  return other?.pane.exists ? other.pane.name : ''
}

/** Fetch the overview once a holder this window cannot name shows up; a window
 *  that knows every holder never asks. Kept fresh by the store afterwards. */
function loadHolderNames(): void {
  if (!store || (store.overviewLoaded.value && !store.overviewError.value)) return
  const unnamed = store.bindings.value.some(
    (b) => !b.thread_id && b.pane_id !== props.paneId && messaging.nameOf(b.pane_id) === null
  )
  if (unnamed) void store.loadOverview()
}

async function loadGroups(): Promise<void> {
  if (!store) return
  const seq = ++loadSeq
  groups.value = store.configuredPlatforms.value.flatMap((p) =>
    p.accounts.map((a) => {
      const unavailable = unavailableText(a)
      return {
        platform: p.platform, account: a.account, bot: botLabel(p.platform, a.account),
        identity: a.status.identity, unavailable, loading: !unavailable, error: '', locations: [],
      }
    })
  )
  await Promise.all(
    groups.value
      .filter((g) => !g.unavailable)
      .map(async (g) => {
        const res = await store.locations(g.platform, g.account)
        if (seq !== loadSeq) return
        const group = groups.value.find((x) => x.platform === g.platform && x.account === g.account)
        if (!group) return
        group.loading = false
        if (res.ok) group.locations = res.data?.locations ?? []
        else group.error = res.error ?? t('channels.error.generic')
      })
  )
  if (seq !== loadSeq || !open.value) return
  await nextTick()
  position()
}

function position(): void {
  const rect = btnRef.value?.getBoundingClientRect()
  const pop = popRef.value
  if (!rect || !pop) return
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))
  const below = rect.bottom + 6
  const top = below + pop.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - 6 - pop.offsetHeight) : below
  popStyle.value = { top: `${top}px`, left: `${left}px` }
}

async function toggle(): Promise<void> {
  if (!store) return
  if (open.value) {
    close()
    return
  }
  if (!store.configuredPlatforms.value.length) {
    executeCommand('workbench.action.openSettingsChannels')
    return
  }
  error.value = ''
  pending.value = null
  unguardedYolo.value =
    !!props.agentKey && guard?.hookSupportFor(props.agentKey) === 'none' && vendorRunsYolo(props.agentKey)
  open.value = true
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeydown, true)
  await nextTick()
  position()
  loadHolderNames()
  await loadGroups()
}

function close(): void {
  open.value = false
  pending.value = null
  loadSeq++
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKeydown, true)
}

function onPointerDown(event: Event): void {
  const target = event.target as Node | null
  if (target && (popRef.value?.contains(target) || btnRef.value?.contains(target))) return
  close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  if (pending.value) back()
  else close()
}

onBeforeUnmount(close)

/** Level this pane last used for this very chat; a binding to any other chat,
 *  bot or platform never lends its level. A new binding starts at replies-only. */
function previousLevel(platform: ChannelPlatform, account: string, chatId: string): ChannelVerbosity {
  const prev = store?.bindings.value.find((b) => b.pane_id === props.paneId && b.platform === platform &&
    (b.account || DEFAULT_ACCOUNT) === account && b.chat_id === chatId)
  return prev?.verbosity ?? 'replies'
}

async function choose(platform: ChannelPlatform, account: string, loc: ChannelLocation, mode: 'new' | 'existing'): Promise<void> {
  error.value = ''
  bindLevel.value = previousLevel(platform, account, loc.chat_id)
  pending.value = { platform, account, loc, mode }
  await nextTick()
  focusBindLevel()
  position()
}

async function back(): Promise<void> {
  const chatId = pending.value?.loc.chat_id
  pending.value = null
  error.value = ''
  await nextTick()
  popRef.value?.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(chatId ?? '')}"]`)?.focus()
  position()
}

function focusBindLevel(): void {
  popRef.value?.querySelector<HTMLElement>(`[data-testid="channel-bind-level-${bindLevel.value}"]`)?.focus()
}

async function confirmBind(): Promise<void> {
  if (!pending.value || busy.value) return
  const { platform, account, loc, mode } = pending.value
  await bind(platform, account, loc, mode)
}

async function bind(platform: ChannelPlatform, account: string, loc: ChannelLocation, mode: 'new' | 'existing'): Promise<void> {
  if (!store) return
  busy.value = true
  error.value = ''
  const res = await store.bind({
    pane_id: props.paneId,
    pane_name: props.paneName,
    platform,
    mode,
    chat_id: loc.chat_id,
    ...(mode === 'new' ? { title: props.paneName } : {}),
    verbosity: bindLevel.value,
    account,
  })
  busy.value = false
  if (!res.ok) {
    error.value = res.error ?? t('channels.error.generic')
    return
  }
  close()
  // Connected, but the chat's messages will be refused: say so where the chip now stands.
  if (res.data?.needs_approval === true) {
    needsApproval.value = true
    await nextTick()
    await toggleMenu()
  }
}

// The bound chat's title, from the chats the bot knows; '' until known.
const chatTitle = ref('')
let chatSeq = 0
async function loadChatTitle(): Promise<void> {
  const b = binding.value
  const seq = ++chatSeq
  if (!b || !store) {
    chatTitle.value = ''
    return
  }
  const res = await store.locations(b.platform, b.account || DEFAULT_ACCOUNT)
  if (seq !== chatSeq) return
  chatTitle.value = (res.ok && res.data?.locations?.find((l) => l.chat_id === b.chat_id)?.title) || ''
}
// A refresh (channels.changed: a chat renamed or first seen) may bring the title.
watch(() => [binding.value, store?.platforms.value], () => void loadChatTitle(), { immediate: true })

/** The bot a binding talks through, named as every channel label names it. */
function botName(platform: ChannelPlatform, account: string): string {
  return channelBotName(store?.accountState(platform, account || DEFAULT_ACCOUNT))
}

// The bot, else the chat, after the platform; the tooltip adds the chat and the level.
function chipIdentity(mode: 'short' | 'full'): string {
  const b = binding.value
  if (!b) return ''
  return formatChannelIdentity(b, {
    t,
    state: store?.accountState(b.platform, b.account || DEFAULT_ACCOUNT),
    chat: chatTitle.value || (mode === 'full' ? b.chat_id : ''),
    extra: [t(`channels.pane.verbosity-${verbosity.value}`)],
  }, mode)
}
const chipLabel = computed(() => chipIdentity('short'))
const chipTip = computed(() => chipIdentity('full'))

const VERBOSITIES: ChannelVerbosity[] = ['replies', 'minimal', 'standard', 'full']
const menuOpen = ref(false)
// Shown in the menu the bind that needs approval opened, until that menu closes.
const needsApproval = ref(false)
const chipRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})
const verbosity = computed<ChannelVerbosity>(() => binding.value?.verbosity ?? 'replies')
const children = computed(() => store?.childrenOf(props.paneId) ?? [])

async function toggleMenu(): Promise<void> {
  if (menuOpen.value) {
    closeMenu()
    return
  }
  menuOpen.value = true
  document.addEventListener('pointerdown', onMenuPointerDown, true)
  document.addEventListener('keydown', onMenuKeydown, true)
  await nextTick()
  const rect = chipRef.value?.getBoundingClientRect()
  const menu = menuRef.value
  if (!rect || !menu) return
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))
  const below = rect.bottom + 6
  const top = below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - 6 - menu.offsetHeight) : below
  menuStyle.value = { top: `${top}px`, left: `${left}px` }
}

function closeMenu(): void {
  menuOpen.value = false
  needsApproval.value = false
  document.removeEventListener('pointerdown', onMenuPointerDown, true)
  document.removeEventListener('keydown', onMenuKeydown, true)
}

function onMenuPointerDown(event: Event): void {
  const target = event.target as Node | null
  if (target && (menuRef.value?.contains(target) || chipRef.value?.contains(target))) return
  closeMenu()
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closeMenu()
}

onBeforeUnmount(closeMenu)

// Radiogroup arrow keys move the selection and the focus together, wrapping at
// the ends; Enter connects with the selected level.
function onBindLevelKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    void confirmBind()
    return
  }
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  e.preventDefault()
  const i = VERBOSITIES.indexOf(bindLevel.value)
  bindLevel.value = VERBOSITIES[(i + step + VERBOSITIES.length) % VERBOSITIES.length]
  void nextTick(focusBindLevel)
}

async function pickVerbosity(v: ChannelVerbosity): Promise<void> {
  if (!store || v === verbosity.value) return
  busy.value = true
  error.value = ''
  const res = await store.setBindingOptions(props.paneId, v)
  busy.value = false
  if (!res.ok) error.value = res.error ?? t('channels.error.generic')
}

async function unbind(): Promise<void> {
  if (!store) return
  busy.value = true
  await store.unbind(props.paneId, props.paneName)
  busy.value = false
}

function openSettings(): void {
  close()
  executeCommand('workbench.action.openSettingsChannels')
}
</script>

<template>
  <span v-if="store" class="pane-channel">
    <span v-if="binding" ref="chipRef" class="pch-chip" data-testid="channel-chip" :title="chipTip">
      <button
        type="button"
        class="pch-chip-main"
        data-testid="channel-chip-menu"
        :aria-expanded="menuOpen"
        :aria-label="t('channels.pane.verbosity-label')"
        @click.stop="toggleMenu"
        @mousedown.stop
        @dblclick.stop
      >
        <svg class="pch-icon pch-chip-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 3.4h10.8v7.2H7l-3 2.4v-2.4H2.6Z" /><path d="M5.4 6.2h5.2M5.4 8.2h3.2" /></svg>
        <span class="pch-chip-label" v-truncate data-testid="channel-chip-label">{{ chipLabel }}</span>
        <span class="pch-chip-level" data-testid="channel-chip-level">{{ t(`channels.pane.verbosity-${verbosity}`) }}</span>
      </button>
      <button
        type="button"
        class="pch-chip-x"
        data-testid="channel-unbind"
        :disabled="busy"
        :aria-label="t('channels.pane.unbind')"
        :title="t('channels.pane.unbind')"
        @click.stop="unbind"
        @mousedown.stop
        @dblclick.stop
      >✕</button>
    </span>
    <button
      v-else
      ref="btnRef"
      type="button"
      class="pch-btn"
      data-testid="channel-connect"
      :title="t('channels.pane.connect')"
      :aria-label="t('channels.pane.connect')"
      :aria-expanded="open"
      @click.stop="toggle"
      @mousedown.stop
      @dblclick.stop
    ><svg class="pch-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 3.4h10.8v7.2H7l-3 2.4v-2.4H2.6Z" /><path d="M5.4 6.2h5.2M5.4 8.2h3.2" /></svg></button>
    <Teleport to="body">
      <div
        v-if="menuOpen && binding"
        ref="menuRef"
        class="pch-pop pch-menu"
        :style="menuStyle"
        role="dialog"
        :aria-label="t('channels.pane.verbosity-label')"
        data-testid="channel-menu"
        @click.stop
        @mousedown.stop
      >
        <p v-if="needsApproval" class="pch-warn" role="note" data-testid="channel-approval-note">{{ t('channels.pane.needs-approval') }}</p>
        <div class="pch-pop-head">{{ t('channels.pane.verbosity-label') }}</div>
        <button
          v-for="v in VERBOSITIES"
          :key="v"
          type="button"
          class="pch-level"
          :class="{ 'pch-level-selected': v === verbosity }"
          role="menuitemradio"
          :aria-checked="v === verbosity"
          :data-testid="`channel-verbosity-${v}`"
          :disabled="busy"
          :title="t(`channels.pane.verbosity-${v}-hint`)"
          @click="pickVerbosity(v)"
        >
          <span class="pch-level-dot" aria-hidden="true"></span>
          <span class="pch-level-name">{{ t(`channels.pane.verbosity-${v}`) }}</span>
          <span class="pch-level-hint">{{ t(`channels.pane.verbosity-${v}-hint`) }}</span>
        </button>
        <p class="pch-sub pch-note" data-testid="channel-redact-note">{{ t('channels.pane.redact-note') }}</p>
        <template v-if="children.length">
          <div class="pch-pop-head pch-children-head">{{ t('channels.pane.children') }}</div>
          <div v-for="c in children" :key="c.pane_id" class="pch-sub pch-ellipsis" v-truncate data-testid="channel-child">↳ {{ c.title || c.pane_id }}</div>
        </template>
        <p v-if="error" class="pch-error" role="alert">{{ error }}</p>
      </div>
      <div
        v-if="open"
        ref="popRef"
        class="pch-pop"
        :style="popStyle"
        role="dialog"
        :aria-label="t('channels.pane.where')"
        data-testid="channel-popover"
        @click.stop
        @mousedown.stop
      >
        <template v-if="!pending">
          <div class="pch-pop-head">{{ t('channels.pane.where') }}</div>
          <p v-if="unguardedYolo" class="pch-warn" role="note" data-testid="channel-guard-warning">{{ t('guard.pane.no-hook-warning') }}</p>
          <section v-for="g in groups" :key="`${g.platform}:${g.account}`" class="pch-group" :data-account="g.account" data-testid="channel-group">
            <div class="pch-group-head">
              <span class="pch-mark" aria-hidden="true">{{ platformName(g.platform).charAt(0) }}</span>
              <span class="pch-group-name">{{ platformName(g.platform) }}</span>
              <span v-if="g.bot" class="pch-group-bot pch-ellipsis" v-truncate data-testid="channel-group-bot">{{ g.bot }}</span>
              <span v-if="g.identity" class="pch-sub pch-ellipsis" v-truncate>{{ g.identity }}</span>
            </div>
            <div v-if="g.unavailable" class="pch-row pch-row-off" data-testid="channel-platform-off" aria-disabled="true">{{ g.unavailable }}</div>
            <div v-else-if="g.loading" class="pch-sub">{{ t('channels.pane.loading') }}</div>
            <p v-else-if="g.error" class="pch-error" role="alert">{{ g.error }}</p>
            <div v-else-if="!g.locations.length" class="pch-empty" data-testid="channel-no-chats">
              <span class="pch-next">{{ t('channels.link.next-step') }}</span>
              <ChannelLinkGuide :store="store" :platform="g.platform" :account="g.account" />
            </div>
            <div v-for="loc in g.locations" :key="loc.chat_id" class="pch-loc" data-testid="channel-location">
              <button
                type="button"
                class="pch-row"
                :class="{ 'pch-row-taken': holderOf(g.platform, g.account, loc.chat_id) }"
                data-testid="channel-bind-existing"
                :data-chat-id="loc.chat_id"
                :disabled="busy || !!holderOf(g.platform, g.account, loc.chat_id)"
                :title="holderOf(g.platform, g.account, loc.chat_id) ? t('channels.pane.taken-hint') : t('channels.pane.use-existing')"
                @click="choose(g.platform, g.account, loc, 'existing')"
              >
                <span class="pch-loc-title pch-ellipsis" v-truncate>{{ loc.title || loc.chat_id }}</span>
                <span v-if="holderOf(g.platform, g.account, loc.chat_id)" class="pch-kind pch-taken pch-ellipsis" v-truncate data-testid="channel-taken">{{ t('channels.pane.taken-by', { pane: holderOf(g.platform, g.account, loc.chat_id) }) }}</span>
                <span v-else class="pch-kind">{{ kindLabel(loc) }}</span>
              </button>
              <button
                v-if="loc.supports_topics && canCreate(g.platform, g.account)"
                type="button"
                class="pch-new"
                data-testid="channel-bind-new"
                :disabled="busy"
                :title="t('channels.pane.new-topic', { name: paneName })"
                @click="choose(g.platform, g.account, loc, 'new')"
              >{{ t('channels.pane.new-topic-short') }}</button>
            </div>
          </section>
        </template>
        <template v-else>
          <div class="pch-step-head">
            <button type="button" class="pch-link pch-back" data-testid="channel-bind-back" :disabled="busy" @click="back">‹ {{ t('channels.pane.back') }}</button>
          </div>
          <div class="pch-chosen" data-testid="channel-bind-chosen">
            <span class="pch-mark" aria-hidden="true">{{ platformName(pending.platform).charAt(0) }}</span>
            <span class="pch-chosen-text">
              <span class="pch-loc-title pch-ellipsis" v-truncate>{{ pending.loc.title || pending.loc.chat_id }}</span>
              <span class="pch-sub pch-ellipsis" v-truncate>{{ platformName(pending.platform) }}<template v-if="botLabel(pending.platform, pending.account)"> · {{ botLabel(pending.platform, pending.account) }}</template> · {{ pending.mode === 'new' ? t('channels.pane.new-topic', { name: paneName }) : kindLabel(pending.loc) }}</span>
            </span>
          </div>
          <div class="pch-levels-head">{{ t('channels.pane.bind-level-label') }}</div>
          <div class="pch-levels" role="radiogroup" :aria-label="t('channels.pane.bind-level-label')" data-testid="channel-bind-levels">
            <button
              v-for="v in VERBOSITIES"
              :key="v"
              type="button"
              class="pch-level"
              :class="{ 'pch-level-selected': v === bindLevel }"
              role="radio"
              :aria-checked="v === bindLevel"
              :tabindex="v === bindLevel ? 0 : -1"
              :data-testid="`channel-bind-level-${v}`"
              :disabled="busy"
              @click="bindLevel = v"
              @keydown="onBindLevelKey"
            >
              <span class="pch-level-dot" aria-hidden="true"></span>
              <span class="pch-level-name">{{ t(`channels.pane.verbosity-${v}`) }}</span>
              <span class="pch-level-hint">{{ t(`channels.pane.verbosity-${v}-hint`) }}</span>
            </button>
          </div>
          <p class="pch-sub pch-note" data-testid="channel-redact-note">{{ t('channels.pane.redact-note') }}</p>
          <div class="pch-actions">
            <button type="button" class="pch-cancel" data-testid="channel-bind-cancel" :disabled="busy" @click="close">{{ t('channels.pane.cancel') }}</button>
            <button type="button" class="pch-confirm" data-testid="channel-bind-confirm" :disabled="busy" @click="confirmBind">{{ t('channels.pane.confirm') }}</button>
          </div>
        </template>
        <p v-if="error" class="pch-error" role="alert">{{ error }}</p>
        <button v-if="!pending" type="button" class="pch-link pch-foot" data-testid="channel-manage" @click="openSettings">{{ t('channels.pane.manage-chats') }}</button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.pane-channel { display: inline-flex; align-items: center; min-width: 0; }
/* .pch-btn has no skin of its own: the pane header styles it as one of its
   icon buttons (TerminalPane.vue, next to .rebuild-btn / .minimize-btn). */
.pch-icon { display: block; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
/* Same height and type as the header's status badge. */
.pch-chip { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 1; max-width: 260px; font-size: var(--font-3xs); color: var(--accent-fg); background: var(--accent-subtle); border: 1px solid var(--accent-muted); border-radius: 999px; padding: 1px 2px 1px 7px; }
.pch-chip-main { display: inline-flex; align-items: center; gap: 4px; min-width: 0; font: inherit; color: inherit; background: transparent; border: none; padding: 0; cursor: pointer; }
.pch-children-head { margin-top: 4px; }
.pch-chip-icon { width: 11px; height: 11px; flex-shrink: 0; }
.pch-chip-level { flex-shrink: 0; opacity: 0.75; }
.pch-chip-level::before { content: '·'; margin-right: 4px; }
.pch-chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pch-chip-x { font: inherit; line-height: 1; color: inherit; background: transparent; border: none; padding: 0 3px; cursor: pointer; opacity: 0.8; }
.pch-chip-x:hover { opacity: 1; }
.pch-pop { position: fixed; z-index: 300; box-sizing: border-box; width: 300px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; display: flex; flex-direction: column; gap: 4px; background: var(--bg-overlay); border: 1px solid var(--border-default); border-radius: 8px; padding: 10px 12px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45); font-size: var(--font-2xs); color: var(--text-secondary); }
.pch-pop-head { font-weight: 600; color: var(--text-bright); margin-bottom: 2px; }
.pch-sub { color: var(--text-secondary); }
.pch-note { margin: 0; font-size: var(--font-3xs); }
.pch-levels { display: flex; flex-direction: column; gap: 3px; }
.pch-levels-head { margin-top: 4px; font-size: var(--font-3xs); color: var(--text-secondary); }
.pch-step-head { display: flex; }
.pch-back { padding: 0; }
.pch-back:disabled, .pch-cancel:disabled, .pch-confirm:disabled { opacity: 0.5; cursor: default; }
.pch-chosen { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 8px; background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: var(--radius-xs); }
.pch-chosen-text { display: flex; flex-direction: column; min-width: 0; }
.pch-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--border-muted); }
.pch-cancel, .pch-confirm { font: inherit; border-radius: var(--radius-xs); padding: 3px 12px; cursor: pointer; }
.pch-cancel { color: var(--text-primary); background: transparent; border: 1px solid var(--border-default); }
.pch-confirm { font-weight: 600; color: var(--text-on-emphasis); background: var(--accent-emphasis); border: 1px solid var(--accent-emphasis); }
.pch-cancel:focus-visible, .pch-confirm:focus-visible, .pch-back:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
/* Dot in the first column, name over hint in the second. */
.pch-level { display: grid; grid-template-columns: auto 1fr; column-gap: 7px; row-gap: 1px; align-items: center; width: 100%; font: inherit; text-align: left; color: var(--text-primary); background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: var(--radius-xs); padding: 4px 8px; cursor: pointer; }
.pch-level:hover:not(:disabled) { border-color: var(--border-default); }
.pch-level:disabled { opacity: 0.5; cursor: default; }
.pch-level:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.pch-level-dot { grid-row: 1 / span 2; box-sizing: border-box; width: 12px; height: 12px; border: 1.5px solid var(--border-default); border-radius: 50%; }
.pch-level-name, .pch-level-hint { grid-column: 2; }
.pch-level-hint { font-size: var(--font-3xs); color: var(--text-secondary); line-height: 1.35; }
/* Declared after .pch-level so the selected skin wins at equal specificity. */
.pch-level-selected, .pch-level-selected:hover:not(:disabled) { border-color: var(--accent-emphasis); background: var(--accent-subtle); }
.pch-level-selected .pch-level-name { font-weight: 600; color: var(--accent-fg); }
.pch-level-selected .pch-level-dot { border-color: var(--accent-emphasis); background: radial-gradient(circle, var(--accent-emphasis) 0 3px, transparent 3.5px); }
.pch-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pch-link { font: inherit; text-align: left; color: var(--accent-fg); background: transparent; border: none; padding: 2px 0; cursor: pointer; }
.pch-foot { margin-top: 2px; padding-top: 6px; border-top: 1px solid var(--border-muted); }
.pch-group { display: flex; flex-direction: column; gap: 3px; padding: 4px 0; }
.pch-group + .pch-group { border-top: 1px solid var(--border-muted); }
.pch-group-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pch-group-name { font-weight: 600; color: var(--text-primary); flex-shrink: 0; }
.pch-group-bot { color: var(--text-primary); }
.pch-mark { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; flex-shrink: 0; font-size: 9px; font-weight: 700; color: var(--accent-fg); background: var(--accent-subtle); border: 1px solid var(--accent-muted); border-radius: 3px; }
.pch-loc { display: flex; align-items: stretch; gap: 4px; }
.pch-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 1; min-width: 0; font: inherit; text-align: left; color: var(--text-primary); background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: var(--radius-xs); padding: 4px 8px; cursor: pointer; }
.pch-row:hover:not(:disabled) { border-color: var(--border-default); }
.pch-row:disabled { opacity: 0.5; cursor: default; }
.pch-row-off { color: var(--text-secondary); opacity: 0.6; cursor: default; }
.pch-loc-title { color: var(--text-bright); }
.pch-kind { flex-shrink: 0; color: var(--text-secondary); font-size: var(--font-3xs); }
/* Taken by another pane: shown, not selectable, until that pane unbinds. */
.pch-row-taken:disabled { opacity: 0.7; }
.pch-taken { flex-shrink: 1; min-width: 0; max-width: 60%; color: var(--attention-fg); }
.pch-new { flex-shrink: 0; font: inherit; font-size: var(--font-3xs); color: var(--accent-fg); background: transparent; border: 1px solid var(--accent-muted); border-radius: var(--radius-xs); padding: 0 6px; cursor: pointer; }
.pch-new:hover:not(:disabled) { background: var(--accent-subtle); }
.pch-new:disabled { opacity: 0.5; cursor: default; }
.pch-error { margin: 0; color: var(--danger-fg); }
.pch-empty { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px; border: 1px solid var(--accent-muted); border-radius: var(--radius-xs); background: var(--accent-subtle); }
.pch-next { font-weight: 600; color: var(--text-bright); }
.pch-warn { margin: 0 0 2px; color: var(--attention-fg); line-height: 1.4; }
</style>
