import { computed, ref, watch, type InjectionKey } from 'vue'
import type { useBackend } from './useBackend'
import type { ChannelPlatform } from '../platform/channels'

/**
 * Chat channels (Telegram, Discord, Slack, …) as seen from the renderer. The
 * backend owns every connection; this is a per-window mirror of its state plus
 * thin wrappers around the `channels.*` WS requests. It re-fetches on
 * `channels.changed` and on reconnect, and patches one platform's status in
 * place on `channels.status`.
 */

// The platform union is derived from the registry (platform/channels/index.ts).
export type { ChannelPlatform }

export type ChannelLifecycle = 'stopped' | 'starting' | 'ready' | 'recovering' | 'blocked'

export interface ChannelStatus {
  lifecycle: ChannelLifecycle
  connected: boolean
  reconnect_attempts: number
  last_error: string
  last_connected_at: number | null
  last_inbound_at: number | null
  identity: string
  /** The bot's own display name, where the platform reports one (Telegram getMe
   *  first_name, Discord global_name, Feishu app_name); absent on older backends. */
  display_name?: string
  /** Telegram only: Bot Management Mode is on, so this bot can create bots (getMe). */
  can_manage_bots?: boolean
}

export interface ChannelCapabilities {
  threads: boolean
  create_location: boolean
  edit: boolean
  typing: boolean
  buttons: boolean
  text_limit: number
}

/** One bot on a platform. A platform may run several; `default` is the one every
 *  platform had before that, and added bots get a generated id (see newAccountId). */
export interface ChannelAccountState {
  account: string
  /** Display name the user gave the bot; '' when unnamed. */
  name: string
  configured: boolean
  enabled: boolean
  status: ChannelStatus
  /** Non-secret config only; the backend never sends a secret back. */
  config: Record<string, unknown>
  capabilities: ChannelCapabilities | null
}

export interface ChannelPlatformState {
  platform: ChannelPlatform
  /** True when any bot is configured. */
  configured: boolean
  /** True when any bot is enabled. */
  enabled: boolean
  /** The first bot's status, config and capabilities, as before several bots. */
  status: ChannelStatus
  /** Non-secret config only; the backend never sends a secret back. */
  config: Record<string, unknown>
  capabilities: ChannelCapabilities | null
  /** Every configured bot, `default` first. */
  accounts: ChannelAccountState[]
}

export const DEFAULT_ACCOUNT = 'default'

// The backend's worst case, each step bounded on its side: storing the credential
// (a Keychain write, up to 10 s), waiting for the platform to accept it (10 s,
// QUICK_ADD_TIMEOUT_S), then undoing a failure (a Keychain delete, up to 10 s).
// The whole call, the channels lock included, gives up at 30 s (QUICK_ADD_DEADLINE_S)
// and answers "timeout", so this only covers a backend that cannot answer at all.
const QUICK_ADD_TIMEOUT_MS = 45_000

/** A fresh id for a bot being added: stable for its life, whatever it is renamed to. */
export function newAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  return `bot-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** `account` for a request payload: left out for the default bot, so requests for
 *  it stay exactly what they were before several bots per platform. */
function acct(account: string | undefined): { account?: string } {
  return account && account !== DEFAULT_ACCOUNT ? { account } : {}
}

export interface ChannelPairingRequest {
  platform: ChannelPlatform
  /** The bot the sender wrote to; absent from older backends (= default). */
  account?: string
  code: string
  sender_id: string
  sender_name: string
  created_at: number
}

export interface ChannelAllowEntry {
  platform: ChannelPlatform
  /** The bot this sender may talk to; absent from older backends (= default). */
  account?: string
  sender_id: string
  sender_name: string
  added_at: number
}

export interface ChannelBinding {
  pane_id: string
  platform: ChannelPlatform
  account: string
  chat_id: string
  thread_id: string
  title: string
  /** How much of the pane's activity the chat mirrors; absent on older backends (= full). */
  verbosity?: ChannelVerbosity
  /** Set on an auto-created child topic: the pane it reports into. */
  parent_pane_id?: string
  /** True for a topic the backend created itself (a child pane's), false for a manual binding. */
  auto?: boolean
}

export type ChannelVerbosity = 'replies' | 'minimal' | 'standard' | 'full'

export interface ChannelLocation {
  chat_id: string
  title: string
  kind: string
  supports_topics: boolean
}

/** The pane a binding drives, as the backend's pane registry has it now. */
export interface ChannelOverviewPane {
  /** False for an orphan: the pane closed without its binding being released. */
  exists: boolean
  /** The pane's current name; for an orphan, the title it was bound under. */
  name: string
  qualified_name: string
  workspace_path: string
  display_status: string
  agent_key: string
}

export interface ChannelOverviewBinding extends ChannelBinding {
  created_at: number
  pane: ChannelOverviewPane
}

export interface ChannelOverviewChat extends ChannelLocation {
  bindings: ChannelOverviewBinding[]
}

/** `channels.overview`: one bot with the chats it knows and who is bound to each. */
export interface ChannelOverviewBot {
  platform: ChannelPlatform
  account: string
  chats: ChannelOverviewChat[]
  /** Pane ids of this bot's orphan bindings. */
  orphans: string[]
}

export interface ChannelUnbindResult {
  pane_id: string
  ok: boolean
  removed?: boolean
  error?: string
}

/** A binding row in a chat, with the auto child topics that follow it. */
export interface ChannelBindingRow {
  binding: ChannelOverviewBinding
  orphan: boolean
  children: ChannelOverviewBinding[]
}

/** A chat's bindings as rows: auto child topics sit under the pane they report into
 *  (when that pane is bound in the same chat), everything else is its own row. */
export function chatRows(chat: ChannelOverviewChat): ChannelBindingRow[] {
  const here = new Set(chat.bindings.map((b) => b.pane_id))
  const isChild = (b: ChannelOverviewBinding) => !!b.auto && !!b.parent_pane_id && here.has(b.parent_pane_id)
  return chat.bindings
    .filter((b) => !isChild(b))
    .map((b) => ({
      binding: b,
      orphan: !b.pane.exists,
      children: chat.bindings.filter((c) => isChild(c) && c.parent_pane_id === b.pane_id),
    }))
}

/** A one-time code from `channels.link.create`: whoever sends it to the bot is linked once approved. */
export interface ChannelLinkInvite {
  code: string
  target: 'direct' | 'group'
  expires_at: number
  /** Platform deep link that sends the code (Telegram) or opens the bot (Discord install, Slack DM). */
  url: string | null
}

/** `channels.quick_add`: the new bot, verified, named and (when asked) with a live invite. */
export interface ChannelQuickAddResult {
  account: string
  /** The stored display name: the one given, else the identity the platform reported. */
  name: string
  identity: string
  link: ChannelLinkInvite | null
}

/** `channels.managed_created`: the bot a `channels.managed_create` link was for, added
 *  through quick add, or why not. `created` is set once the bot exists in Telegram. */
export interface ChannelManagedCreatedEvent {
  request_id: string
  ok: boolean
  account?: string
  name?: string
  link?: ChannelLinkInvite | null
  /** "timeout" (no bot within the request's life), "token_unavailable", "creator_not_linked", or quick add's reason. */
  reason?: string
  error?: string
  created?: boolean
}

/** `channels.linked`: a chat was linked by an invite code. */
export interface ChannelLinkedEvent {
  platform: ChannelPlatform
  /** The invite it redeemed, so only the guide that issued it reacts. */
  code: string
  chat_id: string
  title: string
  kind: 'direct' | 'group'
  /** False when the bot could not post its confirmation in the chat. */
  confirmed: boolean
}

/** `channels.link_failed`: a sent invite code was spent but the link did not complete. */
export interface ChannelLinkFailedEvent {
  platform: ChannelPlatform
  code: string
  error: string
}

export interface ChannelResult<T = Record<string, unknown>> {
  ok: boolean
  error?: string
  /** The backend's machine-readable why, when a refusal carries one. */
  reason?: string
  data?: T
}

export interface BindRequest {
  pane_id: string
  pane_name: string
  platform: ChannelPlatform
  mode: 'new' | 'existing'
  chat_id: string
  thread_id?: string
  title?: string
  /** Mirror level the user chose; the backend uses replies when it is missing. */
  verbosity?: ChannelVerbosity
  /** The bot the chat is reached through; the default bot when missing. */
  account?: string
}

type Backend = Pick<ReturnType<typeof useBackend>, 'send' | 'on' | 'status'>

function emptyStatus(): ChannelStatus {
  return {
    lifecycle: 'stopped',
    connected: false,
    reconnect_attempts: 0,
    last_error: '',
    last_connected_at: null,
    last_inbound_at: null,
    identity: '',
  }
}

function createChannelsStore(backend: Backend) {
  const enabled = ref(true)
  // Tell bound chats when a new device opens a share link. Null (no switch shown) unless
  // Navide Cloud is connected and the backend has the setting.
  const shareOpenNotify = ref<boolean | null>(null)
  // Listening for link changes only while Settings → Channels shows the switch.
  let shareOpenNotifyOff: (() => void) | null = null
  const platforms = ref<ChannelPlatformState[]>([])
  const bindings = ref<ChannelBinding[]>([])
  const pairing = ref<ChannelPairingRequest[]>([])
  const allow = ref<ChannelAllowEntry[]>([])
  const loaded = ref(false)
  const error = ref('')
  const lastLinked = ref<ChannelLinkedEvent | null>(null)
  const lastLinkFailed = ref<ChannelLinkFailedEvent | null>(null)
  const lastManagedCreated = ref<ChannelManagedCreatedEvent | null>(null)
  // Settings → Channels: fetched once the page asks for it, then on every refresh.
  const overview = ref<ChannelOverviewBot[]>([])
  const overviewLoaded = ref(false)
  const overviewError = ref('')
  let overviewWanted = false
  let overviewLoad = 0
  // Bumped whenever the backend connection drops: invites live only in the
  // backend's memory, so a code handed out before may be gone.
  const linkEpoch = ref(0)

  async function call<T = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<ChannelResult<T>> {
    try {
      const resp = await backend.send<T & { ok?: boolean; error?: string; reason?: string }>(type, payload)
      const body = resp.payload
      if (!resp.ok || !body) return { ok: false, error: resp.error?.message ?? `${type} failed` }
      if (body.ok === false) {
        const error = body.error ?? `${type} failed`
        return typeof body.reason === 'string' ? { ok: false, error, reason: body.reason } : { ok: false, error }
      }
      return { ok: true, data: body }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function fetchOverview(): Promise<void> {
    const load = ++overviewLoad
    const res = await call<{ bots: ChannelOverviewBot[] }>('channels.overview')
    if (load !== overviewLoad) return
    if (res.ok && res.data) {
      overview.value = res.data.bots ?? []
      overviewError.value = ''
    } else {
      overviewError.value = res.error ?? 'channels.overview failed'
    }
    overviewLoaded.value = true
  }

  async function refresh(): Promise<void> {
    if (overviewWanted) void fetchOverview()
    const [list, binds, reqs, allowed] = await Promise.all([
      call<{ enabled: boolean; platforms: ChannelPlatformState[] }>('channels.list'),
      call<{ bindings: ChannelBinding[] }>('channels.bindings'),
      call<{ requests: ChannelPairingRequest[] }>('channels.pairing.list'),
      call<{ entries: ChannelAllowEntry[] }>('channels.allow.list'),
    ])
    if (list.ok && list.data) {
      enabled.value = list.data.enabled !== false
      platforms.value = (list.data.platforms ?? []).map((p) => {
        const status = { ...emptyStatus(), ...(p.status ?? {}) }
        const config = p.config ?? {}
        const capabilities = p.capabilities ?? null
        // An older backend lists no bots: its one configured bot is the default.
        const accounts = p.accounts ?? (p.configured
          ? [{ account: DEFAULT_ACCOUNT, name: '', configured: true, enabled: p.enabled, status, config, capabilities }]
          : [])
        return {
          ...p,
          status,
          config,
          capabilities,
          accounts: accounts.map((a) => ({
            ...a,
            name: a.name ?? '',
            status: { ...emptyStatus(), ...(a.status ?? {}) },
            config: a.config ?? {},
            capabilities: a.capabilities ?? null,
          })),
        }
      })
    }
    if (binds.ok && binds.data) bindings.value = binds.data.bindings ?? []
    if (reqs.ok && reqs.data) pairing.value = reqs.data.requests ?? []
    if (allowed.ok && allowed.data) allow.value = allowed.data.entries ?? []
    error.value = [list, binds, reqs, allowed].find((r) => !r.ok)?.error ?? ''
    loaded.value = true
  }

  /** Run a mutation; the backend broadcasts `channels.changed`, but refresh
   *  here too so this window does not depend on the broadcast round-trip. */
  async function mutate(type: string, payload: Record<string, unknown>): Promise<ChannelResult> {
    const res = await call(type, payload)
    if (res.ok) await refresh()
    return res
  }

  type ShareOpenNotifyReply = { enabled: boolean; cloudConnected?: boolean; shareSupported?: boolean }

  /** The backend says along with the switch whether Navide Cloud is connected and whether
   *  its server does share links; the switch shows only when both are true. */
  function takeShareOpenNotify(res: ChannelResult<ShareOpenNotifyReply>): void {
    const usable = res.ok && res.data?.cloudConnected === true && res.data.shareSupported === true
    shareOpenNotify.value = usable && res.data ? res.data.enabled !== false : null
  }

  async function fetchShareOpenNotify(): Promise<void> {
    takeShareOpenNotify(await call<ShareOpenNotifyReply>('channels.get_share_open_notify'))
  }

  backend.on('channels.changed', () => {
    void refresh()
  })
  backend.on('channels.pairing_request', () => {
    void refresh()
  })
  backend.on('channels.linked', (raw) => {
    const msg = raw as ChannelLinkedEvent | null
    if (msg?.platform) lastLinked.value = msg
  })
  backend.on('channels.link_failed', (raw) => {
    const msg = raw as ChannelLinkFailedEvent | null
    if (msg?.platform) lastLinkFailed.value = msg
  })
  backend.on('channels.managed_created', (raw) => {
    const msg = raw as ChannelManagedCreatedEvent | null
    if (msg?.request_id) lastManagedCreated.value = msg
  })
  backend.on('channels.status', (raw) => {
    const msg = raw as { platform?: string; account?: string; status?: Partial<ChannelStatus> } | null
    if (!msg?.platform) return
    const entry = platforms.value.find((p) => p.platform === msg.platform)
    if (!entry) {
      void refresh()
      return
    }
    const status = { ...emptyStatus(), ...(msg.status ?? {}) }
    const account = msg.account ?? DEFAULT_ACCOUNT
    const bot = entry.accounts.find((a) => a.account === account)
    if (bot) bot.status = status
    // The platform shows its first bot (or the default slot while none is set up).
    if ((entry.accounts[0]?.account ?? DEFAULT_ACCOUNT) === account) entry.status = status
  })
  watch(
    () => backend.status.value,
    (s, prev) => {
      if (s === 'connected') void refresh()
      else if (prev === 'connected') linkEpoch.value += 1
    },
    { immediate: true }
  )

  const configuredPlatforms = computed(() => platforms.value.filter((p) => p.configured))
  const bindingByPane = computed(() => new Map(bindings.value.map((b) => [b.pane_id, b])))

  return {
    enabled,
    shareOpenNotify,
    platforms,
    bindings,
    pairing,
    allow,
    loaded,
    error,
    lastLinked,
    lastLinkFailed,
    lastManagedCreated,
    linkEpoch,
    configuredPlatforms,
    refresh,
    overview,
    overviewLoaded,
    overviewError,
    /** Start keeping the overview (Settings → Channels shows it) and fetch it now. */
    loadOverview: (): Promise<void> => {
      overviewWanted = true
      return fetchOverview()
    },
    overviewFor: (platform: ChannelPlatform, account: string = DEFAULT_ACCOUNT): ChannelOverviewBot | null =>
      overview.value.find((b) => b.platform === platform && b.account === account) ?? null,
    /** Unbind several panes at once; each chat is told, and a failure is per pane. */
    unbindMany: async (paneIds: string[]): Promise<ChannelResult<{ results: ChannelUnbindResult[] }>> => {
      const res = await call<{ results: ChannelUnbindResult[] }>('channels.unbind_many', { pane_ids: paneIds })
      await refresh()
      return res
    },
    /** Raise a bound pane: the backend names its current id, then main finds the
     *  window that owns it (any workspace) and brings it to the front. */
    focusPane: async (paneId: string): Promise<{ ok: boolean; error?: string }> => {
      const res = await call<{ pane_id: string }>('channels.focus_pane', { pane_id: paneId })
      if (!res.ok || !res.data) return { ok: false, error: res.error ?? 'pane not found' }
      const action = window.agentTeam?.requestPaneAction
      if (!action) return { ok: false, error: 'not-found' }
      const out = await action({ paneId: res.data.pane_id || paneId, action: 'focus' })
      return out?.error ? { ok: false, error: out.error } : { ok: true }
    },
    platformState: (platform: ChannelPlatform) => platforms.value.find((p) => p.platform === platform) ?? null,
    accountState: (platform: ChannelPlatform, account: string = DEFAULT_ACCOUNT): ChannelAccountState | null =>
      platforms.value.find((p) => p.platform === platform)?.accounts.find((a) => a.account === account) ?? null,
    bindingFor: (paneId: string): ChannelBinding | null => bindingByPane.value.get(paneId) ?? null,
    configure: (platform: ChannelPlatform, config: Record<string, unknown>, secret?: Record<string, string>,
      account?: string) =>
      mutate('channels.configure', secret ? { platform, ...acct(account), config, secret } : { platform, ...acct(account), config }),
    /** Add a new bot in one step: the backend stores it only once the platform accepted
     *  the credential, and with `linkTarget` answers with a link invite too. A failure
     *  carries `reason` ("rejected" | "timeout" | "invalid") and leaves nothing stored. */
    quickAdd: async (platform: ChannelPlatform, config: Record<string, unknown>, secret: Record<string, string>,
      account: string, linkTarget?: 'direct' | 'group'): Promise<ChannelResult<ChannelQuickAddResult> & { reason?: string }> => {
      const type = 'channels.quick_add'
      try {
        const resp = await backend.send<ChannelQuickAddResult & { ok?: boolean; error?: string; reason?: string }>(type, {
          platform, ...acct(account), config, secret, ...(linkTarget ? { link_target: linkTarget } : {}),
        }, QUICK_ADD_TIMEOUT_MS)
        const body = resp.payload
        if (!resp.ok || !body) return { ok: false, error: resp.error?.message ?? `${type} failed` }
        if (body.ok === false) return { ok: false, error: body.error ?? `${type} failed`, reason: body.reason }
        await refresh()
        return { ok: true, data: body }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    /** A t.me/newbot link for a bot `managerAccount` (Telegram) will manage; the bot it
     *  creates arrives as `channels.managed_created` with the returned `request_id`. */
    managedCreate: (managerAccount: string) =>
      call<{ request_id: string; url: string }>('channels.managed_create', { manager_account: managerAccount }),
    setEnabled: (platform: ChannelPlatform, on: boolean, account?: string) =>
      mutate('channels.set_enabled', { platform, ...acct(account), enabled: on }),
    renameAccount: (platform: ChannelPlatform, account: string, name: string) =>
      mutate('channels.rename_account', { platform, account, name }),
    setGlobalEnabled: (on: boolean) => mutate('channels.set_global_enabled', { enabled: on }),
    /** Start keeping the switch (Settings → Channels shows it) and fetch it now. */
    loadShareOpenNotify: (): Promise<void> => {
      shareOpenNotifyOff ??= backend.on('p2p.link.changed', () => void fetchShareOpenNotify())
      return fetchShareOpenNotify()
    },
    /** The page is gone: stop following link changes for the switch. */
    releaseShareOpenNotify: (): void => {
      shareOpenNotifyOff?.()
      shareOpenNotifyOff = null
    },
    setShareOpenNotify: async (on: boolean): Promise<ChannelResult> => {
      const res = await call<ShareOpenNotifyReply>('channels.set_share_open_notify', { enabled: on })
      if (res.ok) takeShareOpenNotify(res)
      return res
    },
    /** One bot when `account` is given (always sent, even "default"); without it
     *  the whole platform: every bot, its allowlist and pairing requests. */
    remove: (platform: ChannelPlatform, account?: string) =>
      mutate('channels.remove', account ? { platform, account } : { platform }),
    approvePairing: (platform: ChannelPlatform, code: string) => mutate('channels.pairing.approve', { platform, code }),
    rejectPairing: (platform: ChannelPlatform, code: string) => mutate('channels.pairing.reject', { platform, code }),
    removeAllow: (platform: ChannelPlatform, senderId: string, account?: string) =>
      mutate('channels.allow.remove', { platform, sender_id: senderId, ...acct(account) }),
    createLink: (platform: ChannelPlatform, target: 'direct' | 'group', account?: string) =>
      call<ChannelLinkInvite>('channels.link.create', { platform, target, ...acct(account) }),
    locations: async (platform: ChannelPlatform, account?: string): Promise<ChannelResult<{ locations: ChannelLocation[] }>> =>
      call<{ locations: ChannelLocation[] }>('channels.locations', { platform, ...acct(account) }),
    bind: ({ account, ...req }: BindRequest) => mutate('channels.bind', { ...req, ...acct(account) }),
    /** Child topics the backend auto-bound under a parent pane's binding. */
    childrenOf: (paneId: string): ChannelBinding[] => bindings.value.filter((b) => b.parent_pane_id === paneId),
    setBindingOptions: (paneId: string, verbosity: ChannelVerbosity) =>
      mutate('channels.set_binding_options', { pane_id: paneId, verbosity }),
    unbind: (paneId: string, paneName = '') => mutate('channels.unbind', { pane_id: paneId, pane_name: paneName }),
    rebind: (fromPaneId: string, toPaneId: string) =>
      mutate('channels.rebind', { from_pane_id: fromPaneId, to_pane_id: toPaneId }),
    /** A pane really closed. The backend no longer unbinds on unregister (a
     *  workspace switch or detach unregisters too), so this is the only path
     *  that releases the binding. Skipped for panes known to be unbound. */
    paneClosed(paneId: string): void {
      if (loaded.value && !bindingByPane.value.has(paneId)) return
      void call('channels.unbind', { pane_id: paneId, reason: 'closed' })
    },
    /** A rebuild replaced a pane under a new id: carry its binding over. */
    paneReplaced(fromPaneId: string, toPaneId: string): void {
      if (loaded.value && !bindingByPane.value.has(fromPaneId)) return
      void call('channels.rebind', { from_pane_id: fromPaneId, to_pane_id: toPaneId })
    },
  }
}

export type ChannelsStore = ReturnType<typeof createChannelsStore>

// One store per backend connection: the Settings pane, every pane header and
// every sidebar row share it, so N panes do not mean N fetches per change.
const stores = new WeakMap<object, ChannelsStore>()

export function useChannels(backend: Backend): ChannelsStore {
  let store = stores.get(backend)
  if (!store) {
    store = createChannelsStore(backend)
    stores.set(backend, store)
  }
  return store
}

export const channelsKey: InjectionKey<ChannelsStore> = Symbol('channels')
