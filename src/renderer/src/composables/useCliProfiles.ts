import { onScopeDispose, ref, type InjectionKey } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { AGENT_SPECS, paneCanRebuild } from '@navide/plugin-shell'
import type { useBackend } from './useBackend'

// A CLI account profile: a stored credential slot for one agent CLI so the
// user can keep several accounts per agent (claude/codex/kimi/grok). All
// accounts share the real home directory; switching swaps credentials in
// place. The object fields are camelCase (backend serializes them that way);
// the WS request payloads below are snake_case per the backend contract.
export interface CliProfile {
  id: string
  agentKey: string
  name: string
  createdAt: string
  /** True once the user renamed this slot. `name` also holds the generated
   *  "Account N", so the flag is what tells a user's alias from a placeholder
   *  — never the shape of the string. Absent = auto-named. */
  nameIsCustom?: boolean
  /** Provider entry this slot binds to, for a CLI whose credential store
   *  holds several providers (opencode, pi, …). Absent = the whole store. */
  scope?: string | null
}

/** What a vendor declares about switching accounts, as the backend reports it
 *  (`cli_profiles.list` → account_capabilities; the same object as
 *  quota_failover.get_state → capabilities). `supported` is not "automatic"
 *  and not "verified": `evidence` says whether a real account round-trip was
 *  ever recorded, `platforms` where the adapter is expected to work, `scopes`
 *  which providers a new slot must pick from. */
export interface CliAccountCapability {
  agentKey: string
  supported: boolean
  /** How a new sign-in reaches this vendor. "isolated": in a private home,
   *  the live credential untouched. "global": the CLI has one credential
   *  store, so signing in temporarily replaces the live one (restored when
   *  the sign-in completes; the new account is used only on switch). Read
   *  from the backend, never inferred from the vendor's env handling. */
  loginIsolation?: 'isolated' | 'global'
  authScope: string | null
  method: 'hot' | 'restart' | 'manual' | null
  store?: string | null
  evidence: 'live' | 'source' | 'docs' | null
  verifiedVersion?: string
  platforms: string[]
  scopes: string[]
  hasExpiry?: boolean
  hasIdentity?: boolean
  resume: 'native' | 'lossy' | 'none'
  todo: string
  loginCommand?: boolean
}

/** A switch or slot refusal the backend explains by code; each has a
 *  sentence of its own so the user never sees the raw code. */
export const PREFLIGHT_REASON_CODES = new Set([
  'UNKNOWN_SCOPE',
  'SCOPE_UNKNOWN',
  'SHADOWED_BY_ENV',
  'CREDENTIAL_OVERRIDE',
  'PLATFORM_UNSUPPORTED',
  'UNSUPPORTED',
  'IDENTITY_UNKNOWN',
  'SCOPE_MISMATCH',
  'UNRECONCILED_STATE',
  'LIVE_DRIFT',
  'LOGIN_BLOCKED_BY_LIVE_PANES',
  'CREDENTIAL_SOURCE_UNKNOWN',
])

/** Locale keys of the global-login batch are not in the catalog yet (frozen
 *  for a parity window); until they land, the English below is shown rather
 *  than the raw key. Same shape as useAnnouncements' fallback. */
export const LOGIN_I18N_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  'cli-account.login-in-progress': 'A {agent} sign-in is {state} — switch after it completes.',
  'cli-account.login-blocked-by-live-panes': '{count} running {agent} pane(s) block signing in — close or finish them first.',
  'cli-account.live-drift': 'The live {agent} credential is not the current account and the target slot is not empty — reconcile from the announcement first.',
  'cli-account.adopted-live-login': 'The live sign-in already was the selected account; it was adopted into its slot without a swap.',
  'settings.accounts.cli.global-login-title': 'Sign in on the live credential?',
  'settings.accounts.cli.global-login-body': '{agent} has no isolated sign-in. During sign-in its live credential is temporarily replaced by the new account; when the sign-in completes the current account ({current}) is restored, and the new account is used only when you switch to it. Running {agent} panes block this — close or finish them first.',
  'settings.accounts.cli.global-login-confirm': 'Sign in',
  'settings.accounts.cli.global-login-cancel': 'Cancel',
  'cli-account.plaintext-token-store': 'This Copilot installation stores its token in plain text (storeTokenPlaintext); Navide cannot switch its accounts safely, so nothing was changed.',
  'cli-account.live-drift-unverified': "{agent}'s live credential changed and its identity cannot be verified — nothing was switched.",
  'cli-account.live-drift-confirm-title': 'Is the live credential still the current account?',
  'cli-account.live-drift-confirm-body': "{agent}'s live credential changed since it was last saved, and this CLI stores no identity Navide could check it against. Continue only if you are certain it is still {current} (a normal token refresh, not another sign-in). If you continue, Navide keeps the live credential as {current} and switches to {target}.",
  'cli-account.live-drift-confirm-confirm': 'It is still {current} — continue',
  'cli-account.live-drift-confirm-cancel': 'Cancel',
  'cli-account.live-changed': 'The signed-in {agent} account changed after this notice, so nothing was switched. Check Settings → Accounts.',
})

export function tLogin(key: string, params: Record<string, string | number> = {}): string {
  if (i18n.global.te(key)) return i18n.global.t(key, params)
  const fallback = LOGIN_I18N_FALLBACK[key] ?? key
  return fallback.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
}

/** The user-facing sentence for a preflight refusal, or null for codes that
 *  are not one. `vars` are the environment variables the backend names for
 *  SHADOWED_BY_ENV / CREDENTIAL_OVERRIDE. */
/** A Copilot installed with `storeTokenPlaintext: true` keeps its token in
 *  clear text; the vault refuses to touch it (zero mutation) and says so in
 *  the error text. Shown as that fact, not as a generic failure. */
export function plaintextTokenStoreMessage(message: string | undefined): string | null {
  if (!message || !message.includes('storeTokenPlaintext')) return null
  return tLogin('cli-account.plaintext-token-store')
}

export function preflightMessage(
  code: string | undefined,
  details: Record<string, unknown> | undefined,
  agentLabel: string,
  message?: string,
): string | null {
  const plaintext = plaintextTokenStoreMessage(message)
  if (plaintext) return plaintext
  if (!code || !PREFLIGHT_REASON_CODES.has(code)) return null
  const t = i18n.global.t
  const vars = Array.isArray(details?.shadowedBy) ? (details!.shadowedBy as string[]).join(', ') : ''
  switch (code) {
    case 'UNKNOWN_SCOPE':
    case 'SCOPE_UNKNOWN':
      return t('cli-account.preflight-unknown-scope', { agent: agentLabel })
    case 'SCOPE_MISMATCH':
      return t('cli-account.preflight-scope-mismatch', { agent: agentLabel })
    case 'SHADOWED_BY_ENV':
    case 'CREDENTIAL_OVERRIDE':
      return t('cli-account.preflight-shadowed-by-env', { vars: vars || 'env' })
    case 'PLATFORM_UNSUPPORTED':
      return t('cli-account.preflight-platform-unsupported', { agent: agentLabel })
    case 'IDENTITY_UNKNOWN':
      return t('cli-account.preflight-identity-unknown', { agent: agentLabel })
    case 'UNRECONCILED_STATE':
      return t('cli-account.preflight-unreconciled', { agent: agentLabel })
    case 'LIVE_DRIFT':
      return details?.verified === false
        ? tLogin('cli-account.live-drift-unverified', { agent: agentLabel })
        : tLogin('cli-account.live-drift', { agent: agentLabel })
    case 'CREDENTIAL_SOURCE_UNKNOWN':
      return t('cli-account.preflight-credential-source-unknown', { agent: agentLabel })
    case 'LOGIN_BLOCKED_BY_LIVE_PANES':
      return tLogin('cli-account.login-blocked-by-live-panes', { agent: agentLabel, count: Number(details?.count ?? 0) })
    default:
      return t('cli-account.preflight-unsupported', { agent: agentLabel })
  }
}

// Outcome of `setDefault`. `count` is set for PANES_RUNNING refusals — the
// number of live non-login panes the backend saw for the agent. `needsLogin`
// marks a switch onto an account whose stored credentials cannot authenticate
// — the CLI is now signed out and the caller should start a sign-in.
// `needsLoginReason` says which kind, because they read very differently to
// the user: 'signed-out' (the slot holds nothing) versus 'expired' (a parked
// account's access token aged out, which is routine and not a lost login).
export type CliLoginReason = 'signed-out' | 'expired'

export type SetDefaultResult =
  | { ok: true; needsLogin?: boolean; needsLoginReason?: CliLoginReason; adoptedLiveLogin?: boolean }
  | {
      ok: false
      code?: string
      message?: string
      count?: number
      /** LIVE_DRIFT only. `verified: true` = the live credential is known to
       *  be another account (reconcile / manual only). `verified: false` =
       *  the live payload changed but the vendor stores no identity to tell
       *  a token refresh from another sign-in — a MANUAL switch may resend
       *  with `assumeLiveIsCurrent` after the user confirms it is still the
       *  current account. `currentSlotId` / `epoch` are what the backend saw
       *  when it refused; the resend hands them back as the expected state
       *  and the backend honours the assumption only while both still match
       *  under its lock (STALE_STATE / STALE_EPOCH otherwise — A→C→A is an
       *  epoch change too). `liveFingerprint` (an HMAC digest of the live
       *  credential, not a secret, never shown) goes back too and must still
       *  match — a CLI that rewrote its live credential during the dialog is
       *  not the account the user vouched for even with the epoch unchanged.
       *  Any of the three absent (older backend) = no resend possible. */
      liveDrift?: { verified: boolean; currentSlotId: string | null; epoch: number | null; liveFingerprint: string | null }
    }

// Map of agentKey -> default profile id, or null for the built-in Default
// (the user's real home directory).
export type CliProfileDefaults = Record<string, string | null>

// Map of agentKey -> the user's alias for that agent's built-in Default slot.
// The Default is not a profile record, so its alias lives beside the defaults
// rather than in a `name` field. Absent key = never named.
export type CliProfileDefaultNames = Record<string, string>

// Display-only identity of one account slot, resolved by the backend from the
// CLI's own credential files. `email` is null when the CLI stores no identity
// (kimi) or nobody is signed in.
export interface CliAccountIdentity {
  email: string | null
  signedIn: boolean
}

// agentKey -> slotId -> identity; the built-in Default row is keyed
// "__default__" (mirrors the backend's reserved slot id).
export type CliProfileIdentities = Record<string, Record<string, CliAccountIdentity>>

// One account row whose stored credentials name the same account as another
// row of the same agent. `email` is that account; `slotIds` lists every row
// holding it — this one included, the built-in Default keyed "__default__".
// The backend decides what counts as duplicate (row identities cannot be
// compared here: the active row shows the live account, not its own slot).
export interface CliAccountDuplicate {
  email: string
  slotIds: string[]
}

// agentKey -> slotId -> duplicate group. Rows that are unique are absent.
export type CliProfileDuplicates = Record<string, Record<string, CliAccountDuplicate>>

// A claude account's sign-in inside its own config dir (CLAUDE_CONFIG_DIR).
// `signedIn` = its panes can run there, apart from the live credential the
// account switch swaps. `email` is the identity Claude Code recorded there.
export interface CliAccountDir {
  signedIn: boolean
  email: string | null
}

// agentKey -> slotId -> account dir. Only claude has them; the built-in
// Default (the real ~/.claude) is never listed.
export type CliProfileAccountDirs = Record<string, Record<string, CliAccountDir>>

// agentKey -> the profile new panes start on, when chosen apart from the
// live credential's owner. Absent = new panes follow `defaults`.
export type CliProfilePaneDefaults = Record<string, string>

const DEFAULT_SLOT_ID = '__default__'

/**
 * Per-window cache of CLI account profiles. Loads from the backend on mount and
 * refreshes whenever any window broadcasts `cli_profiles.changed`. Reconnect-safe.
 * Mirrors the useRoles composable shape (WS CRUD + a `.changed` subscription).
 */
export function useCliProfiles(backend: ReturnType<typeof useBackend>) {
  const profiles = ref<CliProfile[]>([])
  const defaults = ref<CliProfileDefaults>({})
  const defaultNames = ref<CliProfileDefaultNames>({})
  const identities = ref<CliProfileIdentities>({})
  const duplicates = ref<CliProfileDuplicates>({})
  const accountDirs = ref<CliProfileAccountDirs>({})
  const paneDefaults = ref<CliProfilePaneDefaults>({})
  const supportedAgents = ref<string[]>([])
  const loaded = ref<boolean>(false)
  const loading = ref<boolean>(false)
  const error = ref<string>('')
  const accountCapabilities = ref<Record<string, CliAccountCapability>>({})

  let unsubChanged: (() => void) | null = null
  let unsubBackend: (() => void) | null = null

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const resp = await backend.send<{
        profiles: CliProfile[]
        defaults: CliProfileDefaults
        defaultNames?: CliProfileDefaultNames
        identities?: CliProfileIdentities
        duplicates?: CliProfileDuplicates
        accountDirs?: CliProfileAccountDirs
        paneDefaults?: CliProfilePaneDefaults
        supported_agents: string[]
        account_capabilities?: Record<string, CliAccountCapability>
      }>('cli_profiles.list', {})
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load CLI profiles'
        return
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      defaultNames.value = resp.payload.defaultNames ?? {}
      identities.value = resp.payload.identities ?? {}
      duplicates.value = resp.payload.duplicates ?? {}
      accountDirs.value = resp.payload.accountDirs ?? {}
      paneDefaults.value = resp.payload.paneDefaults ?? {}
      supportedAgents.value = resp.payload.supported_agents
      accountCapabilities.value = resp.payload.account_capabilities ?? {}
      loaded.value = true
    } catch (err) {
      error.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  /** Create an empty slot. `scope` names the provider entry for a vendor
   *  whose capability lists `scopes`; it is the caller's pick from that list
   *  — never guessed here, the backend refuses an unknown one. */
  async function create(agentKey: string, name: string, scope?: string | null): Promise<CliProfile | null> {
    try {
      const payload: Record<string, unknown> = { agent_key: agentKey, name }
      if (scope) payload.scope = scope
      const resp = await backend.send<{
        profile: CliProfile
        profiles: CliProfile[]
        defaults: CliProfileDefaults
      }>('cli_profiles.create', payload)
      if (!resp.ok || !resp.payload) {
        error.value =
          preflightMessage(resp.error?.code, resp.error?.details, agentLabelOf(agentKey), resp.error?.message) ??
          (resp.error?.message ?? 'create failed')
        return null
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      return resp.payload.profile
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'create failed'
      return null
    }
  }

  /** Rename one account slot. `id` "__default__" names the built-in Default,
   *  which has no profile record — the backend then needs `agentKey` to know
   *  whose Default it is, and returns a null profile. An empty `name` clears
   *  the alias. */
  async function rename(id: string, name: string, agentKey?: string): Promise<CliProfile | null> {
    try {
      const payload: Record<string, unknown> = { id, name }
      if (agentKey) payload.agentKey = agentKey
      const resp = await backend.send<{
        profile: CliProfile | null
        profiles: CliProfile[]
        defaults: CliProfileDefaults
        defaultNames?: CliProfileDefaultNames
      }>('cli_profiles.rename', payload)
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'rename failed'
        return null
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      if (resp.payload.defaultNames) defaultNames.value = resp.payload.defaultNames
      // A Default rename succeeds with a null profile, so callers read
      // failure from `error`; a stale one must not outlive this success.
      error.value = ''
      return resp.payload.profile
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'rename failed'
      return null
    }
  }

  async function remove(id: string | null, agentKey?: string): Promise<boolean> {
    try {
      const resp = await backend.send<{
        profiles: CliProfile[]
        defaults: CliProfileDefaults
      }>('cli_profiles.delete', { id, agent_key: agentKey })
      if (!resp.ok || !resp.payload) {
        const code = resp.error?.code
        error.value =
          code === 'PROFILE_ACTIVE'
            ? i18n.global.t('settings.accounts.cli.active-error')
            : code === 'LOGIN_IN_PROGRESS'
              ? i18n.global.t('settings.accounts.cli.login-in-progress-error')
              : code === 'ACCOUNT_DIR_IN_USE'
                ? i18n.global.t('settings.accounts.cli.account-dir-in-use-error', {
                    count: Number(resp.error?.details?.count ?? 1),
                  })
                : (resp.error?.message ?? 'delete failed')
        return false
      }
      profiles.value = resp.payload.profiles
      defaults.value = resp.payload.defaults
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'delete failed'
      return false
    }
  }

  async function setDefault(
    agentKey: string,
    profileId: string | null,
    opts?: {
      force?: boolean
      /** Only after the user confirmed an unverified live drift (see
       *  createCliAccountSwitchHandler); never on an automatic path. Carries
       *  the state the first refusal reported, which the backend checks
       *  under its lock before honouring the assumption. */
      assumeLiveIsCurrent?: { expectedCurrentSlotId: string; expectedEpoch: number; liveFingerprint: string }
      /** The account prompt's "switch back": when the account is already the
       *  active one, write its slot back to live instead of a no-op. Carries
       *  the prompt's live-login fingerprint; the backend refuses the switch
       *  (LIVE_CHANGED) once another login is live. */
      restoreLive?: { liveFingerprint: string }
    },
  ): Promise<SetDefaultResult> {
    try {
      const payload: Record<string, unknown> = {
        agent_key: agentKey,
        profile_id: profileId,
      }
      if (opts?.force) payload.force = true
      if (opts?.restoreLive) {
        payload.restore_live = true
        payload.restore_live_fingerprint = opts.restoreLive.liveFingerprint
      }
      if (opts?.assumeLiveIsCurrent) {
        payload.assume_live_is_current = true
        payload.expected_current_slot_id = opts.assumeLiveIsCurrent.expectedCurrentSlotId
        payload.expected_epoch = opts.assumeLiveIsCurrent.expectedEpoch
        payload.live_fingerprint = opts.assumeLiveIsCurrent.liveFingerprint
      }
      const resp = await backend.send<{
        defaults: CliProfileDefaults
        needsLogin?: boolean
        needsLoginReason?: CliLoginReason | null
        adoptedLiveLogin?: boolean
      }>('cli_profiles.set_default', payload, 30_000)
      if (!resp.ok || !resp.payload) {
        const code = resp.error?.code
        if (code === 'PANES_RUNNING') {
          // Quiescence refusal: live panes still use the current credentials.
          // Not a banner error — the caller either drives a confirm-and-force
          // flow (main window) or surfaces the message as an alert.
          const count = Number(resp.error?.details?.count ?? 0)
          return {
            ok: false,
            code,
            count,
            message: i18n.global.t('cli-account.panes-running', { count }),
          }
        }
        if (code === 'SWITCH_RATE_LIMITED') {
          // Policy guard rather than a fault: account switching is meant to
          // stay a manual action. Like PANES_RUNNING it sets no banner — there
          // is nothing to fix, and the limit clears on its own.
          const seconds = Math.ceil(Number(resp.error?.details?.retryAfter ?? 0))
          return {
            ok: false,
            code,
            message: i18n.global.t('cli-account.switch-rate-limited', { seconds }),
          }
        }
        const message =
          preflightMessage(code, resp.error?.details, agentLabelOf(agentKey), resp.error?.message) ??
          (code === 'PROFILE_SWAP_FAILED'
            ? i18n.global.t('cli-account.swap-failed')
            : code === 'LIVE_CHANGED'
              ? tLogin('cli-account.live-changed', { agent: agentLabelOf(agentKey) })
              : code === 'LOGIN_IN_PROGRESS'
              ? (resp.error?.details?.state
                  ? tLogin('cli-account.login-in-progress', { agent: agentLabelOf(agentKey), state: String(resp.error.details.state) })
                  : i18n.global.t('settings.accounts.cli.login-in-progress-error'))
              : (resp.error?.message ?? 'set default failed'))
        error.value = message
        if (code === 'LIVE_DRIFT') {
          const d = resp.error?.details ?? {}
          return {
            ok: false,
            code,
            message,
            liveDrift: {
              verified: d.verified !== false,
              currentSlotId: typeof d.currentSlotId === 'string' ? d.currentSlotId : null,
              epoch: typeof d.epoch === 'number' && Number.isFinite(d.epoch) ? d.epoch : null,
              liveFingerprint: typeof d.liveFingerprint === 'string' && d.liveFingerprint ? d.liveFingerprint : null,
            },
          }
        }
        return { ok: false, code, message }
      }
      defaults.value = resp.payload.defaults
      return {
        ok: true,
        needsLogin: resp.payload.needsLogin === true,
        // A backend that predates the reason field still says `needsLogin`;
        // fall back to the reading it used to imply.
        needsLoginReason: resp.payload.needsLoginReason ?? undefined,
        // The live sign-in already was this account: adopted, nothing swapped.
        ...(resp.payload.adoptedLiveLogin === true ? { adoptedLiveLogin: true } : {}),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'set default failed'
      error.value = message
      return { ok: false, message }
    }
  }

  /** Profiles belonging to one agent, in creation order. */
  function profilesForAgent(agentKey: string): CliProfile[] {
    return profiles.value.filter((p) => p.agentKey === agentKey)
  }

  /** True when the agent supports multiple accounts (has at least one profile). */
  function hasProfiles(agentKey: string): boolean {
    return profiles.value.some((p) => p.agentKey === agentKey)
  }

  /** The configured default profile id for an agent, or null (built-in Default). */
  function agentLabelOf(agentKey: string): string {
    return AGENT_SPECS.find((s) => s.agentKey === agentKey)?.label ?? agentKey
  }

  /** The vendor's switch capability as the backend last reported it. */
  function capabilityFor(agentKey: string): CliAccountCapability | undefined {
    return accountCapabilities.value[agentKey]
  }

  /** Provider scopes a new slot of this vendor must choose from ([] = the
   *  store is one credential; no choice to make). */
  function scopesFor(agentKey: string): string[] {
    return capabilityFor(agentKey)?.scopes ?? []
  }

  /** True when a sign-in for this vendor replaces the live credential while
   *  it runs (see CliAccountCapability.loginIsolation). Unknown = not global:
   *  the warning is only shown on the backend's word. */
  function loginIsGlobal(agentKey: string): boolean {
    return capabilityFor(agentKey)?.loginIsolation === 'global'
  }

  function defaultProfileId(agentKey: string): string | null {
    return defaults.value[agentKey] ?? null
  }

  function findProfile(id: string | null | undefined): CliProfile | undefined {
    if (!id) return undefined
    return profiles.value.find((p) => p.id === id)
  }

  /** The user's own name for one account row, or undefined when it only has
   *  the generated "Account N". `profileId` null (or "__default__") = the
   *  built-in Default, whose alias is kept per agent. */
  function aliasFor(agentKey: string, profileId: string | null | undefined): string | undefined {
    if (profileId && profileId !== DEFAULT_SLOT_ID) {
      const profile = findProfile(profileId)
      return profile?.nameIsCustom ? profile.name : undefined
    }
    return defaultNames.value[agentKey] || undefined
  }

  /** Display identity of one account row; `profileId` null = built-in Default. */
  function identityFor(agentKey: string, profileId: string | null): CliAccountIdentity | null {
    return identities.value[agentKey]?.[profileId ?? DEFAULT_SLOT_ID] ?? null
  }

  /** The account's sign-in inside its own config dir, or null when it has
   *  none (every non-claude row, and the built-in Default). */
  function accountDirFor(agentKey: string, profileId: string | null | undefined): CliAccountDir | null {
    if (!profileId || profileId === DEFAULT_SLOT_ID) return null
    return accountDirs.value[agentKey]?.[profileId] ?? null
  }

  /** The profile new panes of this agent start on: the pane default when one
   *  is chosen, else the live credential's owner (null = built-in Default). */
  function newPaneProfileId(agentKey: string): string | null {
    return paneDefaults.value[agentKey] || defaultProfileId(agentKey)
  }

  /** Start new panes on an account that signed in inside its own config dir,
   *  without swapping anything; null clears the choice. */
  async function setPaneDefault(
    agentKey: string,
    profileId: string | null,
  ): Promise<{ ok: boolean; code?: string; message?: string }> {
    const resp = await backend.send<{ paneDefaults: CliProfilePaneDefaults }>(
      'cli_profiles.set_pane_default',
      { agent_key: agentKey, profile_id: profileId },
    )
    if (!resp.ok || !resp.payload) {
      return { ok: false, code: resp.error?.code, message: resp.error?.message }
    }
    paneDefaults.value = resp.payload.paneDefaults
    return { ok: true }
  }

  /** A pane on `profileId`'s own config dir reported "Login expired". The
   *  backend stops counting that login until it changes (a new sign-in), so
   *  new panes go back to the live credential. True when it was marked. */
  async function reportAccountDirExpired(profileId: string): Promise<boolean> {
    const resp = await backend.send<{ marked?: boolean }>(
      'cli_profiles.account_dir_expired',
      { profile_id: profileId },
    )
    return !!(resp.ok && resp.payload?.marked)
  }

  /** Duplicate group one account row belongs to, or null when it is unique.
   *  `profileId` null = built-in Default. */
  function duplicateFor(agentKey: string, profileId: string | null): CliAccountDuplicate | null {
    return duplicates.value[agentKey]?.[profileId ?? DEFAULT_SLOT_ID] ?? null
  }

  // Keep every window's cache in sync: any mutation broadcasts `cli_profiles.changed`.
  unsubChanged = backend.on('cli_profiles.changed', (raw) => {
    const payload = raw as {
      profiles?: CliProfile[]
      defaults?: CliProfileDefaults
      defaultNames?: CliProfileDefaultNames
      identities?: CliProfileIdentities
      duplicates?: CliProfileDuplicates
      accountDirs?: CliProfileAccountDirs
      paneDefaults?: CliProfilePaneDefaults
    }
    if (payload?.profiles) profiles.value = payload.profiles
    if (payload?.defaults) defaults.value = payload.defaults
    // Assigned on presence, not truthiness: clearing the last alias broadcasts
    // an empty map, and skipping it would keep the removed name on screen.
    if (payload?.defaultNames !== undefined) defaultNames.value = payload.defaultNames
    if (payload?.identities) identities.value = payload.identities
    // Assigned unconditionally: the last duplicate clearing (a row deleted)
    // broadcasts an empty map, and skipping falsy payloads would keep the
    // stale warning on screen.
    if (payload?.duplicates !== undefined) duplicates.value = payload.duplicates
    if (payload?.accountDirs !== undefined) accountDirs.value = payload.accountDirs
    // Presence, not truthiness: clearing the last choice broadcasts {}.
    if (payload?.paneDefaults !== undefined) paneDefaults.value = payload.paneDefaults
  })

  // The first load, shared: a pane restore can ask for the list while the
  // initial refresh is still in flight, and must not send a second one. A
  // failed attempt is waited on once per connection — later restores go on
  // without it rather than each re-sending the list and waiting out its
  // timeout again. A reconnect starts a new attempt.
  let firstLoad: Promise<void> | null = null
  let firstLoadFailed = false
  function ensureLoaded(): Promise<void> {
    if (loaded.value || firstLoadFailed) return Promise.resolve()
    firstLoad ??= refresh().finally(() => {
      firstLoad = null
      firstLoadFailed = !loaded.value
    })
    return firstLoad
  }

  // Initial load once connected; re-fetch on reconnect (mirrors useRoles).
  let lastStatus = backend.status.value
  function maybeLoad(): void {
    if (backend.status.value !== 'connected') return
    firstLoadFailed = false
    void (loaded.value ? refresh() : ensureLoaded())
  }
  maybeLoad()
  unsubBackend = (() => {
    const id = window.setInterval(() => {
      if (backend.status.value !== lastStatus) {
        lastStatus = backend.status.value
        maybeLoad()
      }
    }, 500)
    return () => window.clearInterval(id)
  })()

  onScopeDispose(() => {
    unsubChanged?.()
    unsubBackend?.()
  })

  return {
    accountCapabilities,
    capabilityFor,
    scopesFor,
    loginIsGlobal,
    profiles,
    defaults,
    defaultNames,
    identities,
    duplicates,
    supportedAgents,
    loaded,
    loading,
    error,
    refresh,
    ensureLoaded,
    create,
    rename,
    remove,
    setDefault,
    profilesForAgent,
    hasProfiles,
    defaultProfileId,
    findProfile,
    aliasFor,
    identityFor,
    duplicateFor,
    accountDirs,
    paneDefaults,
    accountDirFor,
    newPaneProfileId,
    setPaneDefault,
    reportAccountDirExpired,
  }
}

// ── Quiescence-aware account switch ─────────────────────────────────────────

/** Switches an agent's default account like `setDefault`, but resolves the
 *  PANES_RUNNING refusal (confirm with the user, force the switch, restart
 *  the agent's live panes). Provided by the main window, which owns the pane
 *  roster; windows without it fall back to plain `setDefault`. */
export type CliAccountSwitchHandler = (
  agentKey: string,
  profileId: string | null,
  opts?: { restoreLive?: { liveFingerprint: string } },
) => Promise<SetDefaultResult>

export const cliAccountSwitchKey: InjectionKey<CliAccountSwitchHandler> =
  Symbol('cli-account-switch')

/** Per-pane account actions for claude accounts with their own config dir.
 *  Provided by the main window, which owns the panes and the login flow. */
export interface CliAccountDirActions {
  /** Reopen `paneId` on `profileId`'s own config dir and resume its
   *  conversation (asks first: the turn in progress stops). */
  continueWith: (paneId: string, profileId: string) => Promise<void>
  /** Sign `profileId` in inside its own config dir. */
  signIn: (agentKey: string, profileId: string) => void
}

export const cliAccountDirActionsKey: InjectionKey<CliAccountDirActions> =
  Symbol('cli-account-dir-actions')

/** App-shell capabilities the switch flow needs but a component cannot own. */
export interface CliAccountSwitchCaps {
  /** Modal confirm — resolves true when the user accepts the restart. */
  confirm: (
    message: string,
    opts: { title: string; confirmText: string; cancelText: string },
  ) => Promise<boolean>
  /** Display label for the agent in the confirm copy. */
  agentLabel: (agentKey: string) => string
  /** Display label of an account slot (null = built-in Default), for the
   *  live-drift confirm which names the account the user vouches for. */
  accountLabel?: (agentKey: string, profileId: string | null) => string
  /** Start a live sign-in for the agent — used when the switch landed on an
   *  account whose stored credentials cannot authenticate. The account is
   *  already active by then, so this is a LIVE login (not an isolated one).
   *  `reason` is what the pane's own explanation should say. */
  startLogin: (agentKey: string, reason?: CliLoginReason) => void
}

/**
 * Build the main window's account-switch handler: try the plain switch; when
 * the backend refuses with PANES_RUNNING, ask the user, then force the switch.
 * The pane restart is NOT driven here: the backend broadcasts the forced
 * switch via `cli_profiles.changed` and every main window (this one included)
 * restarts its own panes from that event — see `forcedRestartAgentKey`.
 * A declined confirm returns a message-less failure so callers stay silent.
 */
export function createCliAccountSwitchHandler(
  api: Pick<ReturnType<typeof useCliProfiles>, 'setDefault'>,
  caps: CliAccountSwitchCaps,
): CliAccountSwitchHandler {
  // The switched-to account has no usable credentials: the CLI is signed out
  // right now, so start the sign-in for the user instead of leaving them at a
  // login prompt to resolve by hand.
  function afterSwitch(agentKey: string, res: SetDefaultResult): SetDefaultResult {
    if (res.ok && res.needsLogin) caps.startLogin(agentKey, res.needsLoginReason)
    return res
  }

  return async (agentKey, profileId, opts) => {
    const restoreLive = opts?.restoreLive
    const first = restoreLive
      ? await api.setDefault(agentKey, profileId, { restoreLive })
      : await api.setDefault(agentKey, profileId)
    if (!first.ok && first.code === 'LIVE_DRIFT' && first.liveDrift?.verified === false) {
      // The live credential changed and the vendor stores no identity to
      // check it against: only the user can say whether it is still the
      // current account (a token refresh) or someone else's sign-in. A
      // verified drift never reaches here — that one is reconcile-only — and
      // the automatic path never calls this handler.
      //
      // The account the user vouches for is the one the BACKEND reported as
      // current in its refusal, not a value read here (a delayed broadcast
      // could show something else). That slot and epoch go back with the
      // resend as the expected state, with the live credential's fingerprint
      // exactly as the refusal reported it (never re-read after the dialog),
      // and the backend honours the assumption only while all three still
      // match under its lock — a switch by another window in the meantime,
      // even A→C→A, is STALE_STATE / STALE_EPOCH, and a credential the CLI
      // rewrote during the dialog is LIVE_DRIFT once more. A refusal missing
      // any of the three (older backend) gives no such proof: nothing is
      // resent and the refusal stands.
      const drift = first.liveDrift
      if (drift.currentSlotId === null || drift.epoch === null || drift.liveFingerprint === null) return first
      const label = (id: string | null): string => caps.accountLabel?.(agentKey, id) ?? (id ?? 'Default')
      const currentId = drift.currentSlotId === DEFAULT_SLOT_ID ? null : drift.currentSlotId
      const agent = caps.agentLabel(agentKey)
      const confirmed = await caps.confirm(
        tLogin('cli-account.live-drift-confirm-body', { agent, current: label(currentId), target: label(profileId) }),
        {
          title: tLogin('cli-account.live-drift-confirm-title'),
          confirmText: tLogin('cli-account.live-drift-confirm-confirm', { current: label(currentId) }),
          cancelText: tLogin('cli-account.live-drift-confirm-cancel'),
        },
      )
      if (!confirmed) return first
      return afterSwitch(
        agentKey,
        await api.setDefault(agentKey, profileId, {
          assumeLiveIsCurrent: { expectedCurrentSlotId: drift.currentSlotId, expectedEpoch: drift.epoch, liveFingerprint: drift.liveFingerprint },
        }),
      )
    }
    if (first.ok || first.code !== 'PANES_RUNNING') return afterSwitch(agentKey, first)
    const t = i18n.global.t
    const confirmed = await caps.confirm(
      t('cli-account.switch-restart-confirm-body', {
        count: first.count ?? 0,
        agent: caps.agentLabel(agentKey),
      }),
      {
        title: t('cli-account.switch-restart-confirm-title'),
        confirmText: t('cli-account.switch-restart-confirm-confirm'),
        cancelText: t('cli-account.switch-restart-confirm-cancel'),
      },
    )
    if (!confirmed) return { ok: false, code: 'PANES_RUNNING' }
    return afterSwitch(agentKey, await api.setDefault(agentKey, profileId, { force: true, ...(restoreLive ? { restoreLive } : {}) }))
  }
}

// ── Broadcast-driven pane restart (forced account switch) ───────────────────

/** Subset of the `cli_profiles.changed` payload relevant to forced switches. */
export interface CliProfilesChangedEvent {
  reason?: string
  agent_key?: string
  forced?: boolean
}

/**
 * The agent whose panes must restart after this `cli_profiles.changed`
 * broadcast, or null. Only a forced set_default (credentials swapped under
 * live panes) triggers a restart; a quiet switch never touches panes.
 */
export function forcedRestartAgentKey(
  ev: CliProfilesChangedEvent | null | undefined,
): string | null {
  if (!ev || ev.reason !== 'set_default') return null
  if (!ev.forced || !ev.agent_key) return null
  return ev.agent_key
}

/**
 * True when a pane belongs in the post-switch restart batch: a realized,
 * non-login pane of the switched agent whose terminal has not died AND which
 * can actually be rebuilt. `status` is the pane's display/terminal status
 * ('exited'/'error' = dead); undefined (terminal ref not mounted yet) keeps
 * the pane in the batch — it may be starting on the old credentials, and
 * skipping it would leave the stale account live.
 *
 * The rebuild is a resume, so it needs the same preconditions as the manual
 * Rebuild button (paneCanRebuild): a pinned session id, its transcript on
 * disk, and an agent with a resume command. A pane missing any of them — a
 * freshly opened one that has no session yet, typically — cannot be resumed
 * however hard the batch tries, and counting its guaranteed failure in the
 * partial-restart toast reports a problem that is not one. It stays on the
 * outgoing account until the user restarts it by hand.
 */
export function paneNeedsAccountRestart(
  pane: {
    realized?: boolean
    agentKey?: string
    isLogin?: boolean
    pinnedSessionId?: string
    sessionOnDisk?: boolean
  },
  agentKey: string,
  status: string | undefined,
): boolean {
  if (!pane.realized || pane.agentKey !== agentKey || pane.isLogin) return false
  if (status === 'exited' || status === 'error') return false
  return paneCanRebuild({ ...pane, agentKey })
}

/**
 * Run the post-switch restart batch and aggregate failures: `rebuild` resolves
 * undefined on success and a failure token otherwise (and may throw). Each
 * failure is logged; one summary toast is emitted when any pane could not be
 * restarted, none when all succeeded.
 */
export async function runAccountRestartBatch(
  ids: string[],
  rebuild: (id: string) => Promise<string | undefined>,
  log: (line: string) => void,
  toastPartial: (failed: number, total: number) => void,
): Promise<void> {
  const failures: Array<{ id: string; reason: string }> = []
  for (const id of ids) {
    try {
      const outcome = await rebuild(id)
      if (outcome !== undefined) failures.push({ id, reason: outcome })
    } catch (error) {
      failures.push({ id, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const f of failures) {
    log(`⚠ account-switch rebuild pane ${f.id.slice(0, 8)} failed: ${f.reason}`)
  }
  if (failures.length > 0) toastPartial(failures.length, ids.length)
}
