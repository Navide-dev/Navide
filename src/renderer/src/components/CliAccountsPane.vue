<script setup lang="ts">
import { inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import {
  cliAccountDirActionsKey,
  cliAccountSwitchKey,
  tLogin,
  type useCliProfiles,
  type CliProfile,
} from '../composables/useCliProfiles'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import {
  accountUsageFor,
  formatRemaining,
  formatResetAbsolute,
  formatResetCountdown,
  refreshUsage,
  remainingTier,
  TRANSLATED_REFRESH_STATUSES,
  usageBackendConnected,
  usageFor,
  usageVersion,
  type UsageSnapshot,
  type UsageWindow,
} from '../composables/useUsage'
import { i18n } from '@navide/plugin-ui/foundation'
import SettingsNotice from './settings/SettingsNotice.vue'

const props = defineProps<{
  api: ReturnType<typeof useCliProfiles>
  /** True when a workspace is open. Sign-in spawns a login pane inside the
   *  workspace, so without one the flow dead-ends — block it up front
   *  (before the profile row is created) instead of leaving an orphan row. */
  workspaceOpen?: boolean
}>()

// Asks the app shell to open a terminal pane running the agent's CLI so the
// user can complete the CLI's own sign-in flow (it opens the browser itself).
// With `loginProfileId` set, the pane runs in that profile's isolated login
// home: the credentials land in the profile's slot without switching the
// active account or touching running panes. Without it, the login runs live
// (active account / built-in Default).
const emit = defineEmits<{ (e: 'login', agentKey: string, loginProfileId?: string): void }>()

const { error } = props.api

function supported(agentKey: string): boolean {
  return props.api.supportedAgents.value.includes(agentKey)
}

// ── Card identity (cards are named by who is signed in, not a custom label) ──
function rowIdentity(agentKey: string, profileId: string | null) {
  return props.api.identityFor(agentKey, profileId)
}

function rowName(agentKey: string, profile: CliProfile | null): string {
  const identity = rowIdentity(agentKey, profile?.id ?? null)
  if (identity?.email) return identity.email
  // Signed in but the CLI stores no identity (kimi): fall back to the label.
  if (identity?.signedIn) return profile?.name ?? t('cli-account.default')
  return profile ? t('settings.accounts.cli.not-signed-in') : t('cli-account.default')
}

// The card's headline: the user's own name for the account when they gave it
// one, the signed-in identity otherwise. With an alias the identity moves to
// the line below rather than disappearing — for the vendors that expose an
// email it is still how the account is recognised elsewhere.
function cardAlias(agentKey: string, profile: CliProfile | null): string {
  return props.api.aliasFor(agentKey, profile?.id ?? null) ?? ''
}

function cardTitle(agentKey: string, profile: CliProfile | null): string {
  return cardAlias(agentKey, profile) || rowName(agentKey, profile)
}

function cardSubtitle(agentKey: string, profile: CliProfile | null): string {
  return cardAlias(agentKey, profile) ? rowName(agentKey, profile) : ''
}

// A signed-out card (the same test that disables Refresh Quota) says so once
// ("Not signed in") and offers Sign In: no quota placeholder, no "can't
// refresh" line and no Refresh Quota beside it.
function cardSignedOut(agentKey: string, profile: CliProfile | null): boolean {
  const profileId = profile?.id ?? null
  return rowIdentity(agentKey, profileId)?.signedIn === false || cardUsage(agentKey, profileId)?.cantRefresh === true
}

// The title, subtitle or Default's meta line already reads "Not signed in".
function cardSaysSignedOut(agentKey: string, profile: CliProfile | null): boolean {
  if (!profile) return rowIdentity(agentKey, null)?.signedIn !== true
  return rowName(agentKey, profile) === t('settings.accounts.cli.not-signed-in')
}

// ── Renaming a card ──────────────────────────────────────────────────────────
// One row at a time, keyed by agent + slot because slot ids are unique but the
// built-in Default's "__default__" repeats across vendors. The field holds the
// ALIAS only: empty clears it and the card falls back to the identity.
const renamingKey = ref<string | null>(null)
const renameDraft = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
// Esc must not be undone by the blur it causes.
let renameAborted = false

function slotKey(agentKey: string, profile: CliProfile | null): string {
  return `${agentKey}/${profile?.id ?? '__default__'}`
}

function setRenameInput(el: unknown): void {
  renameInput.value = (el as HTMLInputElement | null) ?? null
}

function startRename(agentKey: string, profile: CliProfile | null): void {
  renamingKey.value = slotKey(agentKey, profile)
  renameDraft.value = cardAlias(agentKey, profile)
  renameAborted = false
  void nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

function cancelRename(): void {
  renameAborted = true
  renamingKey.value = null
}

async function commitRename(agentKey: string, profile: CliProfile | null): Promise<void> {
  if (renameAborted || renamingKey.value !== slotKey(agentKey, profile)) return
  const name = renameDraft.value.trim()
  renamingKey.value = null
  await props.api.rename(profile?.id ?? '__default__', name, agentKey)
}

// ── Duplicate accounts (two rows storing the same login) ─────────────────────
// Which rows duplicate which comes from the backend: the active row's identity
// is the LIVE account rather than its own snapshot, so comparing the identities
// the cards display would both invent pairs and miss real ones.
function rowDuplicate(agentKey: string, profileId: string | null) {
  return props.api.duplicateFor(agentKey, profileId)
}

// Duplicate cards all display the same email, so the warning names the rows by
// their internal label — the only thing that tells them apart.
function rowLabel(profile: CliProfile | null): string {
  return profile?.name ?? t('cli-account.default')
}

/** The other rows holding this row's account, labeled and comma-joined. */
function duplicateOthers(agentKey: string, profileId: string | null): string {
  const dup = rowDuplicate(agentKey, profileId)
  if (!dup) return ''
  const self = profileId ?? '__default__'
  return dup.slotIds
    .filter((id) => id !== self)
    .map((id) =>
      id === '__default__' ? t('cli-account.default') : (props.api.findProfile(id)?.name ?? id),
    )
    .join(', ')
}

// Sign-in spawns a login pane inside the current workspace; without one the
// flow dead-ends in the app shell. Block early — BEFORE creating a profile
// row — so a click can't leave an orphan "Not signed in" row behind.
function requireWorkspace(): boolean {
  if (props.workspaceOpen) return true
  toast(t('settings.accounts.cli.login-no-workspace'), { type: 'error' })
  return false
}

// ── Add account: create an empty slot, then start its isolated CLI login ────
const saving = ref(false)
/** Provider picked per multi-scope vendor (opencode, pi, …); empty = not yet
 *  chosen. The list comes from the backend's capability — never typed here. */
const newAccountScope = ref<Record<string, string>>({})

function scopeChoices(agentKey: string): string[] {
  return props.api.scopesFor(agentKey)
}

/** A vendor whose sign-in replaces the live credential while it runs asks
 *  first: the user is told what moves (the live credential, temporarily),
 *  what comes back (the current account, when the sign-in completes) and
 *  what does not happen (no switch until they switch). Isolated sign-ins
 *  ask nothing. The backend still refuses while panes of the CLI run or a
 *  sign-in is already going; nothing here forces past that. */
async function confirmGlobalLogin(agentKey: string): Promise<boolean> {
  if (!props.api.loginIsGlobal(agentKey)) return true
  const agent = CLI_AGENT_SPECS.find((s) => s.agentKey === agentKey)?.label ?? agentKey
  const activeId = props.api.defaultProfileId(agentKey)
  const current = rowName(agentKey, activeId ? (props.api.findProfile(activeId) ?? null) : null)
  return confirm(tLogin('settings.accounts.cli.global-login-body', { agent, current }), {
    title: tLogin('settings.accounts.cli.global-login-title'),
    confirmText: tLogin('settings.accounts.cli.global-login-confirm'),
    cancelText: tLogin('settings.accounts.cli.global-login-cancel'),
  })
}

/** Switching to an empty built-in Default restores nothing, so the live login
 *  is cleared (the outgoing account stays in its own slot). Ask before a
 *  Sign In on that row takes that switch. */
async function confirmEmptyDefaultSignIn(agentKey: string): Promise<boolean> {
  if (rowIdentity(agentKey, null)?.signedIn) return true
  const agent = CLI_AGENT_SPECS.find((s) => s.agentKey === agentKey)?.label ?? agentKey
  const activeId = props.api.defaultProfileId(agentKey)
  const current = rowName(agentKey, activeId ? (props.api.findProfile(activeId) ?? null) : null)
  return confirm(t('settings.accounts.cli.default-sign-in-body', { agent, current }), {
    title: t('settings.accounts.cli.default-sign-in-title'),
    confirmText: t('settings.accounts.cli.default-sign-in-confirm'),
    cancelText: t('settings.accounts.cli.cancel'),
  })
}

/** The built-in Default shrinks to one line while it holds no login and is
 *  not the active account. Active and empty (a fresh install) it stays a full
 *  card: that is where the first sign-in happens. */
function defaultCollapsed(agentKey: string): boolean {
  return props.api.defaultProfileId(agentKey) !== null && !rowIdentity(agentKey, null)?.signedIn
}

async function addAccount(agentKey: string): Promise<void> {
  if (saving.value) return
  if (!requireWorkspace()) return
  // Before the row exists: a declined warning must leave no orphan slot.
  if (!(await confirmGlobalLogin(agentKey))) return
  const scopes = scopeChoices(agentKey)
  const scope = scopes.length > 0 ? (newAccountScope.value[agentKey] || scopes[0]) : null
  if (scopes.length > 0 && !scopes.includes(scope ?? '')) {
    toast(t('cli-account.preflight-unknown-scope', { agent: agentKey }), { type: 'error' })
    return
  }
  saving.value = true
  try {
    // Auto-named — rows display the signed-in identity, names are internal.
    // Unique against EXISTING auto names (max N + 1, "Account 1" being the
    // built-in Default): deletions leave gaps, so length-based numbering
    // could mint a duplicate label — indistinguishable rows for agents whose
    // credentials carry no identity (kimi falls back to the name).
    const nums = props.api
      .profilesForAgent(agentKey)
      .map((p) => /^Account (\d+)$/.exec(p.name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
    const name = `Account ${nums.length ? Math.max(...nums) + 1 : 2}`
    const created = await props.api.create(agentKey, name, scope)
    if (!created) return
    emit('login', agentKey, created.id)
  } finally {
    saving.value = false
  }
}

// ── Sign in on an existing row (fresh Default, or retry an abandoned login) ──
async function signIn(agentKey: string, profileId: string | null): Promise<void> {
  if (!requireWorkspace()) return
  const activeId = props.api.defaultProfileId(agentKey)
  if (profileId !== null && profileId !== activeId) {
    // Non-active profile: no account switch. For an isolated vendor the
    // sign-in runs in a private home and running panes keep their
    // credentials; for a global one the live credential is replaced for the
    // duration, which the user is asked about first.
    if (!(await confirmGlobalLogin(agentKey))) return
    emit('login', agentKey, profileId)
    return
  }
  // Active profile or built-in Default: live login (harvested into the slot
  // by the usage poller). Signing in on a non-active Default row still
  // switches to it first, as before.
  if (activeId !== profileId) {
    if (!(await confirmEmptyDefaultSignIn(agentKey))) return
    if (!(await requestSetDefault(agentKey, profileId))) return
  }
  emit('login', agentKey)
}

// ── Sign in inside the account's own folder (Claude) ────────────────────────
// Claude Code reports quota only for the account it runs as, so a parked
// account has no live figure — unless it is also signed in inside its own
// config dir, which the poller reads on its own. The main window owns that
// sign-in flow (it spawns the login pane); this pane only offers it.
const dirActions = inject(cliAccountDirActionsKey, null)

function accountDirSignedIn(agentKey: string, profileId: string | null): boolean {
  return !!props.api.accountDirFor?.(agentKey, profileId)?.signedIn
}

function canSignInDir(agentKey: string, profileId: string | null): boolean {
  return (
    !!dirActions &&
    agentKey === 'claude' &&
    profileId !== null &&
    !!rowIdentity(agentKey, profileId)?.signedIn &&
    !accountDirSignedIn(agentKey, profileId)
  )
}

// Once the folder is signed in, the card shows the folder's login. The email
// the card showed before is remembered at the click so a sign-in with another
// account can be pointed out (a warning only — nothing is blocked). Settings
// closes when the login pane opens, so this has to outlive the component.
const DIR_EXPECTED_EMAIL_KEY = 'navide.cliAccountDirExpectedEmail'

function readExpectedEmails(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DIR_EXPECTED_EMAIL_KEY) ?? '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function signInDir(agentKey: string, profileId: string): void {
  if (!dirActions || !requireWorkspace()) return
  const email = rowIdentity(agentKey, profileId)?.email
  if (email) {
    try {
      localStorage.setItem(
        DIR_EXPECTED_EMAIL_KEY,
        JSON.stringify({ ...readExpectedEmails(), [profileId]: email }),
      )
    } catch {
      // No storage: the sign-in still works, only the mismatch check is lost.
    }
  }
  dirActions.signIn(agentKey, profileId)
}

function dirEmailMismatch(
  agentKey: string,
  profileId: string | null,
): { dirEmail: string; expected: string } | null {
  if (profileId === null || !accountDirSignedIn(agentKey, profileId)) return null
  const dirEmail = props.api.accountDirFor?.(agentKey, profileId)?.email
  const expected = readExpectedEmails()[profileId]
  if (!dirEmail || !expected || dirEmail.toLowerCase() === expected.toLowerCase()) return null
  return { dirEmail, expected }
}

// ── Set default ──────────────────────────────────────────────────────────────
const { toast, confirm } = useNotify()
const t = i18n.global.t

// Main window provides the quiescence-aware switch (confirm + force + pane
// restart); without it fall back to plain setDefault.
const switchAccount = inject(cliAccountSwitchKey, null)

// The swap round-trips to the backend (30s timeout) and may stop for a confirm
// dialog. Hold the target row so its button reads as busy and a second click
// can't start a competing switch — `signIn` routes through here too.
const switching = ref<string | null>(null)

function switchRowKey(agentKey: string, profileId: string | null): string {
  return `${agentKey}:${profileId ?? '__default__'}`
}

async function requestSetDefault(agentKey: string, profileId: string | null): Promise<boolean> {
  if (switching.value !== null) return false
  switching.value = switchRowKey(agentKey, profileId)
  try {
    const res = switchAccount
      ? await switchAccount(agentKey, profileId)
      : await props.api.setDefault(agentKey, profileId)
    if (res.ok) {
      // Re-poll so the card's quota reflects the newly active account.
      refreshUsage()
      return true
    }
    // Every refusal with a message gets toasted — including ones the
    // composable also mirrors into its banner (PROFILE_SWAP_FAILED and other
    // faults). The banner sits above the per-agent sections and scrolls out
    // of view once you're looking at a specific agent's row, so relying on it
    // alone left the click looking like it did nothing (2026-09-17). A
    // declined confirm has no message (stay silent).
    if (res.message) {
      toast(res.message, { type: 'error' })
    }
    return false
  } finally {
    switching.value = null
  }
}

// ── Delete confirm ───────────────────────────────────────────────────────────
const confirmRemoveId = ref<string | null>(null)

async function remove(id: string | null, agentKey: string): Promise<void> {
  const ok = await props.api.remove(id, agentKey)
  if (ok) confirmRemoveId.value = null
}

function windowRemaining(w: UsageWindow): number {
  return Math.max(0, Math.min(100, 100 - w.usedPercent))
}

/** General account windows (not per-model buckets) — same headline pick as
 *  UsageBadge so both surfaces agree on the big number. */
const HEADLINE_KINDS = new Set(['session', 'weekly', 'monthly'])

function headlineWindow(snap: UsageSnapshot): UsageWindow | undefined {
  return snap.windows.find((w) => HEADLINE_KINDS.has(w.kind)) ?? snap.windows[0]
}

interface CardUsage {
  expired: boolean
  noData: boolean
  cached: boolean
  pending: boolean
  resetExpired: boolean
  big: string
  tier: 'ok' | 'warn' | 'crit'
  headLabel: string
  windows: UsageWindow[]
  foot: string
  lastSuccess: string
  updated: string
  refreshStatus: string
  /** The whole refresh line: a status label after "Refresh:", or a sentence
   *  of its own when the status alone would read as jargon. */
  refreshLine: string
  /** The refresh line says the account is not signed in, so a refresh
   *  cannot read anything: the card's Refresh Quota is shown disabled. */
  cantRefresh: boolean
  refreshError: string
  notMeasuredHint: boolean
}

/** Display model for a card's quota area; undefined hides the area. */
function cardUsage(agentKey: string, profileId: string | null): CardUsage | undefined {
  const accountSnap = accountUsageFor(agentKey, profileId)
  const isActive = props.api.defaultProfileId(agentKey) === profileId
  const snap = accountSnap ?? (isActive ? usageFor(agentKey) : undefined)
  if (!snap) return undefined
  const cached = snap.stale === true
  const windows = snap.windows.filter((w) => !w.expired)
  const currentSnap = { ...snap, windows }
  const head = headlineWindow(currentSnap)
  const refreshStatus = refreshStatusLabel(snap.refreshStatus ?? snap.status)
  const cantRefresh = (snap.refreshStatus ?? snap.status) === 'no-credentials'
  const refreshLine = cantRefresh
    ? t('usage.refresh-not-signed-in')
    : t('usage.refresh-status', { status: refreshStatus })
  const base = {
    expired: snap.status === 'expired' || snap.refreshStatus === 'expired',
    cached,
    // A read is in flight for this account (it just became active). Whatever
    // the card shows below is an earlier reading until that lands. With the
    // backend gone that answer can no longer arrive, so stop promising it.
    pending: snap.refreshPending === true && usageBackendConnected(),
    resetExpired: cached && windows.length === 0 && snap.windows.length > 0,
    lastSuccess: formatResetAbsolute(snap.lastSuccessAt ?? snap.fetchedAt),
    // When a current figure was read; a cached one says so on its own line.
    updated: !cached && snap.status === 'ok' ? formatResetAbsolute(snap.fetchedAt) : '',
    refreshStatus,
    refreshLine,
    cantRefresh,
    notMeasuredHint:
      (snap.refreshStatus ?? snap.status) === 'not-measured' && canSignInDir(agentKey, profileId),
    // The backend's sentence for why the last read failed. `refreshStatus`
    // collapses a timeout, a dead token and an outdated CLI into the same
    // "unavailable"; this is the part that says which one it was.
    refreshError: snap.refreshPending === true ? '' : (snap.error ?? ''),
  }
  if (!head)
    return {
      ...base,
      noData: !base.resetExpired,
      big: '',
      tier: 'ok',
      headLabel: '',
      windows: [],
      foot: '',
    }
  const rem = windowRemaining(head)
  return {
    ...base,
    noData: false,
    big: formatRemaining(rem),
    tier: remainingTier(rem),
    headLabel: t('usage.window-left', { label: windowLabel(head) }),
    windows,
    foot: cardFoot(currentSnap, head),
  }
}

function refreshStatusLabel(status: string): string {
  return TRANSLATED_REFRESH_STATUSES.has(status) ? t(`usage.refresh-status-${status}`) : status
}

/** Window label in the UI language. The backend names Claude's windows after
 *  the CLI's own English panel; any other label is shown as sent. */
function windowLabel(w: UsageWindow): string {
  if (w.label === 'Session (5h)') return t('usage.window-claude-session')
  if (w.label === 'Weekly (all models)') return t('usage.window-claude-weekly')
  const model = w.kind === 'weekly-model' ? /^Weekly \((.+)\)$/.exec(w.label) : null
  if (model) return t('usage.window-claude-weekly-model', { scope: model[1] })
  return w.label
}

/** Card footer: the non-headline windows plus the headline reset countdown.
 *  Every figure on the card is what is LEFT — the CLI's own panel prints
 *  what is used, so the word is spelled out rather than implied. */
function cardFoot(snap: UsageSnapshot, head: UsageWindow): string {
  const parts = snap.windows
    .filter((w) => w !== head)
    .map((w) =>
      t('usage.window-left-pct', { label: windowLabel(w), pct: formatRemaining(windowRemaining(w)) }),
    )
  const countdown = formatResetCountdown(head.resetsAt)
  if (countdown) parts.push(t('usage.resets-in', { time: countdown }))
  return parts.join(' · ')
}

function barTitle(w: UsageWindow): string {
  const base = t('usage.window-left-used', {
    label: windowLabel(w),
    pct: formatRemaining(windowRemaining(w)),
    used: `${Math.round(w.usedPercent)}%`,
  })
  const countdown = formatResetCountdown(w.resetsAt)
  return countdown ? `${base} · ${t('usage.resets-in', { time: countdown })}` : base
}

// Per-account avatar: first character over a deterministic color picked from
// the profile id, so the same account always gets the same tint (same
// palette as UsageBadge's account switcher).
const AVATAR_COLORS = ['#1f6feb', '#8957e5', '#2da44e', '#bc4c00', '#bf3989', '#1b7c83', '#9e6a03']

function avatarColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function avatarInitial(label: string): string {
  const s = label.trim()
  return s ? s.charAt(0).toUpperCase() : '?'
}

// ── Manual quota refresh ─────────────────────────────────────────────────────
// A card reading "unavailable" is a read that failed, and the poller then sits
// out a 15-minute cooldown before trying again (reading Claude boots a whole
// CLI, so a failed read is priced like a successful one). `usage.refresh`
// clears that cooldown, which is the only way back to a number without waiting
// — hence a button. The header button clears every cooldown; each account card
// carries its own that clears only that CLI's, so one stale number can be
// re-read without booting every other CLI along with it.
//
// Only an account that can actually be read gets a card button: the one a CLI
// is signed in as, or a Claude account signed in inside its own folder. Any
// other parked account has nothing to ask for (its card says "Not measured").
// Busy is tracked per scope — the header's key is ALL_SCOPE, a card's is its
// `switchRowKey`.
const ALL_SCOPE = '__all__'
// Maps a busy scope to the agent whose read it waits on (null = every agent).
const refreshing = ref(new Map<string, string | null>())
// Safety net only. The poller broadcasts when its cycle ends and that is what
// normally clears a flag; this stops a button latching when no broadcast ever
// comes (poller disabled, backend gone). One Claude read may take up to 180s.
const REFRESH_BUSY_TIMEOUT_MS = 200_000
const refreshBusyTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearRefreshBusy(scope: string): void {
  refreshing.value.delete(scope)
  const timer = refreshBusyTimers.get(scope)
  if (timer !== undefined) {
    clearTimeout(timer)
    refreshBusyTimers.delete(scope)
  }
}

function startRefresh(scope: string, agentKey?: string, profileId?: string | null): void {
  if (refreshing.value.has(scope)) return
  // Nothing was asked (backend not connected) — going busy would promise an
  // answer that can never arrive.
  if (!refreshUsage(agentKey, profileId)) return
  refreshing.value.set(scope, agentKey ?? null)
  refreshBusyTimers.set(scope, setTimeout(() => clearRefreshBusy(scope), REFRESH_BUSY_TIMEOUT_MS))
}

function refreshQuota(): void {
  startRefresh(ALL_SCOPE)
}

function refreshCardQuota(agentKey: string, profileId: string | null): void {
  startRefresh(switchRowKey(agentKey, profileId), agentKey, profileId)
}

/** A card's own refresh, shown only where a read can actually happen: the
 *  active account of a CLI that reports quota at all, or a Claude account
 *  signed in inside its own folder. */
function canRefreshCard(agentKey: string, profileId: string | null): boolean {
  return (
    (props.api.defaultProfileId(agentKey) === profileId ||
      (agentKey === 'claude' && accountDirSignedIn(agentKey, profileId))) &&
    cardUsage(agentKey, profileId) !== undefined
  )
}

/** True while the backend says a quota read is running — for one agent, or
 *  for any of them when `agentKey` is null (the header's scope). */
function readInFlight(agentKey: string | null): boolean {
  if (agentKey !== null) return usageFor(agentKey)?.refreshPending === true
  return CLI_AGENT_SPECS.some(
    (spec) => usageFor(spec.agentKey)?.refreshPending === true
  )
}

watch(usageVersion, () => {
  // Every payload used to mean "the cycle finished". An account switch now
  // broadcasts one straight away to announce the wait, so clearing on that
  // would put an idle Refresh button above a card reading "reading its quota".
  // The busy timeout still bounds this if no completing payload ever lands.
  for (const [scope, agentKey] of [...refreshing.value]) {
    if (!readInFlight(agentKey)) clearRefreshBusy(scope)
  }
})

onUnmounted(() => {
  for (const timer of refreshBusyTimers.values()) clearTimeout(timer)
  refreshBusyTimers.clear()
})

// Fresh numbers when the pane opens (same nudge UsageBadge sends on switch).
onMounted(() => refreshUsage())
</script>

<template>
  <div class="cli-pane">
    <div class="cli-head">
      <div class="cli-head-text">
        <h3 class="cli-title">{{ $t('settings.accounts.cli.title') }}</h3>
        <p class="cli-hint">{{ $t('settings.accounts.cli.hint') }}</p>
        <details class="cli-more settings-more">
          <summary>{{ $t('settings.accounts.cli.hint-more') }}</summary>
          <p>{{ $t('settings.accounts.cli.hint-detail') }}</p>
        </details>
      </div>
      <button
        class="cli-btn ghost sm cli-refresh"
        :disabled="refreshing.has(ALL_SCOPE)"
        :title="$t('settings.accounts.cli.refresh-quota-hint')"
        @click="refreshQuota"
      >
        {{
          refreshing.has(ALL_SCOPE)
            ? $t('settings.accounts.cli.refreshing-quota')
            : $t('settings.accounts.cli.refresh-quota-all')
        }}
      </button>
    </div>

    <SettingsNotice v-if="error" class="cli-banner danger" tone="danger" role="alert" :message="error" />

    <!-- Multi-account CLIs first; the rest share one line at the end
         instead of repeating the same sentence under each name. -->
    <section v-for="spec in CLI_AGENT_SPECS.filter((s) => supported(s.agentKey))" :key="spec.agentKey" class="cli-agent">
      <div class="cli-agent-head">
        <span class="cli-agent-name cli-group-label">{{ spec.label }}</span>
        <select
          v-if="supported(spec.agentKey) && scopeChoices(spec.agentKey).length > 0"
          class="cli-scope-select"
          :data-scope-for="spec.agentKey"
          :aria-label="$t('settings.accounts.cli.new-account-scope')"
          :value="newAccountScope[spec.agentKey] || scopeChoices(spec.agentKey)[0]"
          @change="newAccountScope[spec.agentKey] = ($event.target as HTMLSelectElement).value"
        >
          <option v-for="scope in scopeChoices(spec.agentKey)" :key="scope" :value="scope">{{ scope }}</option>
        </select>
        <button
          v-if="supported(spec.agentKey)"
          class="cli-btn ghost sm"
          :disabled="saving"
          @click="addAccount(spec.agentKey)"
        >
          {{ $t('settings.accounts.cli.new-account') }}
        </button>
      </div>

      <div class="cli-card-grid">
        <!-- First card is the built-in Default (the user's real home). -->
        <template v-for="p in [null, ...api.profilesForAgent(spec.agentKey)]" :key="p?.id ?? '__default__'">
        <div v-if="!p && defaultCollapsed(spec.agentKey)" class="cli-card cli-card-collapsed">
          <span class="cli-card-collapsed-text" v-truncate>{{
            $t('settings.accounts.cli.default-collapsed')
          }}</span>
          <button
            class="cli-btn ghost sm"
            :disabled="switching !== null"
            @click="signIn(spec.agentKey, null)"
          >
            {{ $t('settings.accounts.cli.sign-in') }}
          </button>
        </div>
        <div
          v-else
          class="cli-card"
          :class="{ active: api.defaultProfileId(spec.agentKey) === (p?.id ?? null) }"
        >
          <div class="cli-card-head">
            <span
              class="cli-card-av"
              :class="{ default: !p, pending: !rowIdentity(spec.agentKey, p?.id ?? null)?.signedIn }"
              :style="p && rowIdentity(spec.agentKey, p.id)?.signedIn ? { background: avatarColor(p.id) } : undefined"
            >
              {{ rowIdentity(spec.agentKey, p?.id ?? null)?.signedIn ? avatarInitial(cardTitle(spec.agentKey, p)) : '' }}
            </span>
            <input
              v-if="renamingKey === slotKey(spec.agentKey, p)"
              :ref="setRenameInput"
              v-model="renameDraft"
              class="cli-card-rename"
              :placeholder="rowName(spec.agentKey, p)"
              :aria-label="$t('settings.accounts.cli.rename')"
              maxlength="64"
              @keydown.enter.prevent="commitRename(spec.agentKey, p)"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename(spec.agentKey, p)"
            />
            <span
              v-else
              class="cli-card-id"
              v-truncate
              :class="{ dim: p && !rowIdentity(spec.agentKey, p.id)?.signedIn }"
            >
              {{ cardTitle(spec.agentKey, p) }}
            </span>
            <!-- The built-in Default is renamable too: it is a real account
                 like any other, and for a vendor with no email it is the
                 only way to tell it apart. -->
            <button
              v-if="renamingKey !== slotKey(spec.agentKey, p)"
              class="cli-card-rename-btn"
              :title="$t('settings.accounts.cli.rename')"
              :aria-label="$t('settings.accounts.cli.rename')"
              @click="startRename(spec.agentKey, p)"
            >
              ✎
            </button>
            <!-- "Active" beside "Not signed in" reads as a contradiction, so a
                 signed-out card carries no pill at all. -->
            <span
              v-if="api.defaultProfileId(spec.agentKey) === (p?.id ?? null) && rowIdentity(spec.agentKey, p?.id ?? null)?.signedIn"
              class="cli-badge"
            >
              {{ $t('settings.accounts.cli.is-default') }}
            </span>
          </div>
          <!-- With an alias on top, the signed-in identity moves here. -->
          <span v-if="cardSubtitle(spec.agentKey, p)" class="cli-card-meta">{{
            cardSubtitle(spec.agentKey, p)
          }}</span>
          <span v-if="!p" class="cli-card-meta">{{
            rowIdentity(spec.agentKey, null)?.signedIn
              ? $t('settings.accounts.cli.default-hint')
              : $t('settings.accounts.cli.not-signed-in')
          }}</span>

          <!-- Another card stores this same account; the user picks which to
               delete (Delete below), we only point it out. -->
          <template
            v-for="d in [rowDuplicate(spec.agentKey, p?.id ?? null)]"
            :key="'dup'"
          >
            <div v-if="d" class="cli-card-dup">
              <span class="cli-card-dup-flag">{{
                $t('settings.accounts.cli.duplicate-flag')
              }}</span>
              <span>{{
                $t('settings.accounts.cli.duplicate-hint', {
                  self: rowLabel(p),
                  others: duplicateOthers(spec.agentKey, p?.id ?? null),
                  email: d.email,
                })
              }}</span>
            </div>
          </template>

          <!-- Quota area (single-element v-for = local display-model alias). -->
          <template
            v-for="u in [cardUsage(spec.agentKey, p?.id ?? null)]"
            :key="'usage'"
          >
            <template v-if="u && !u.noData">
              <div v-if="u.resetExpired" class="cli-card-none">
                <span class="cli-card-foot">{{ $t('usage.cached-reset-expired') }}</span>
              </div>
              <template v-else>
                <div class="cli-card-big" :class="u.tier">
                  {{ u.big }}
                  <small>{{ u.headLabel }}</small>
                </div>
                <div class="cli-card-bars">
                  <div
                    v-for="w in u.windows"
                    :key="w.kind + w.label"
                    class="cli-mini-bar"
                    :title="barTitle(w)"
                  >
                    <div
                      class="cli-mini-fill"
                      :class="remainingTier(windowRemaining(w))"
                      :style="{ width: windowRemaining(w) + '%' }"
                    ></div>
                  </div>
                </div>
                <div v-if="u.foot" class="cli-card-foot">{{ u.foot }}</div>
              </template>
              <div v-if="u.cached" class="cli-card-cache">
                {{ $t('usage.cached-at', { time: u.lastSuccess }) }}
              </div>
              <div v-if="u.pending" class="cli-card-refresh pending">
                {{ $t('usage.reading-now') }}
              </div>
              <div v-else-if="u.cached && !u.cantRefresh" class="cli-card-refresh">
                {{ u.refreshLine }}
              </div>
              <div v-else-if="u.updated" class="cli-card-refresh cli-card-updated">
                {{ $t('usage.updated', { time: u.updated }) }}
              </div>
              <div v-if="u.notMeasuredHint" class="cli-card-reason cli-card-dir-hint">
                {{ $t('usage.parked-not-measured-hint') }}
              </div>
              <div v-if="u.refreshError" class="cli-card-reason">
                {{ $t('usage.refresh-error', { reason: u.refreshError }) }}
              </div>
            </template>
            <div
              v-else-if="cardSignedOut(spec.agentKey, p) && !cardSaysSignedOut(spec.agentKey, p)"
              class="cli-card-none"
            >
              <span class="cli-card-foot">{{ $t('settings.accounts.cli.not-signed-in') }}</span>
            </div>
            <div
              v-else-if="(u || rowIdentity(spec.agentKey, p?.id ?? null)?.signedIn) && !cardSignedOut(spec.agentKey, p)"
              class="cli-card-none"
            >
              <span class="cli-card-foot">{{ $t('usage.no-data') }}</span>
              <span v-if="u?.expired" class="cli-card-expired">
                ⚠ {{ $t('usage.expired-tooltip') }}
              </span>
              <span v-if="u?.pending" class="cli-card-refresh pending">
                {{ $t('usage.reading-now') }}
              </span>
              <span v-else-if="u?.refreshStatus" class="cli-card-refresh">
                {{ u.refreshLine }}
              </span>
              <span v-if="u?.notMeasuredHint" class="cli-card-reason cli-card-dir-hint">
                {{ $t('usage.parked-not-measured-hint') }}
              </span>
              <span v-if="u?.refreshError" class="cli-card-reason">
                {{ $t('usage.refresh-error', { reason: u.refreshError }) }}
              </span>
            </div>
          </template>

          <!-- The folder was signed in with another account than this card
               showed: point it out, block nothing. -->
          <template
            v-for="m in [dirEmailMismatch(spec.agentKey, p?.id ?? null)]"
            :key="'dir-mismatch'"
          >
            <div v-if="m" class="cli-card-dup cli-card-dir-mismatch">
              <span>⚠ {{ $t('settings.accounts.cli.dir-email-mismatch', m) }}</span>
            </div>
          </template>

          <div class="cli-card-actions">
            <template v-if="confirmRemoveId === (p?.id ?? '__default__')">
              <span class="cli-confirm-text">{{ $t('settings.accounts.cli.delete-confirm') }}</span>
              <button class="cli-btn danger sm" @click="remove(p?.id ?? null, spec.agentKey)">
                {{ $t('settings.accounts.cli.delete') }}
              </button>
              <button class="cli-btn ghost sm" @click="confirmRemoveId = null">
                {{ $t('settings.accounts.cli.cancel') }}
              </button>
            </template>
            <template v-else>
              <button
                v-if="canRefreshCard(spec.agentKey, p?.id ?? null) && !cardSignedOut(spec.agentKey, p)"
                class="cli-btn ghost sm cli-card-refresh-btn"
                :disabled="refreshing.has(switchRowKey(spec.agentKey, p?.id ?? null)) || rowIdentity(spec.agentKey, p?.id ?? null)?.signedIn === false || cardUsage(spec.agentKey, p?.id ?? null)?.cantRefresh === true"
                :title="$t('settings.accounts.cli.refresh-quota-card-hint')"
                @click="refreshCardQuota(spec.agentKey, p?.id ?? null)"
              >
                {{
                  refreshing.has(switchRowKey(spec.agentKey, p?.id ?? null))
                    ? $t('settings.accounts.cli.refreshing-quota')
                    : $t('settings.accounts.cli.refresh-quota')
                }}
              </button>
              <!-- An empty Default has nothing to switch to: switching would
                   only clear the live login. Its Sign In asks first. -->
              <button
                v-if="
                  api.defaultProfileId(spec.agentKey) !== (p?.id ?? null) &&
                  (p || rowIdentity(spec.agentKey, null)?.signedIn)
                "
                class="cli-btn ghost sm"
                :disabled="switching !== null"
                @click="requestSetDefault(spec.agentKey, p?.id ?? null)"
              >
                {{
                  switching === switchRowKey(spec.agentKey, p?.id ?? null)
                    ? $t('settings.accounts.cli.switching')
                    : $t('settings.accounts.cli.set-default')
                }}
              </button>
              <button
                v-if="!rowIdentity(spec.agentKey, p?.id ?? null)?.signedIn || cardUsage(spec.agentKey, p?.id ?? null)?.expired"
                class="cli-btn ghost sm"
                :disabled="switching !== null"
                @click="signIn(spec.agentKey, p?.id ?? null)"
              >
                {{ $t('settings.accounts.cli.sign-in') }}
              </button>
              <button
                v-if="p && canSignInDir(spec.agentKey, p.id)"
                class="cli-btn ghost sm cli-card-dir-btn"
                :title="$t('settings.accounts.cli.dir-sign-in-hint')"
                @click="signInDir(spec.agentKey, p.id)"
              >
                {{ $t('settings.accounts.cli.dir-sign-in') }}
              </button>
              <button
                v-if="p || rowIdentity(spec.agentKey, null)?.signedIn"
                class="cli-btn ghost sm"
                @click="confirmRemoveId = (p?.id ?? '__default__')"
              >
                {{ $t('settings.accounts.cli.delete') }}
              </button>
            </template>
          </div>
        </div>
        </template>

      </div>
    </section>

    <!-- Agents that declare no credential slot layout (no multi-account). -->
    <section v-if="CLI_AGENT_SPECS.some((s) => !supported(s.agentKey))" class="cli-agent cli-unsupported-group">
      <p class="cli-unsupported">{{ $t('settings.accounts.cli.unsupported') }}</p>
      <ul class="cli-unsupported-list">
        <li v-for="spec in CLI_AGENT_SPECS.filter((s) => !supported(s.agentKey))" :key="spec.agentKey" :data-agent="spec.agentKey">{{ spec.label }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.cli-pane { display: flex; flex-direction: column; }
.cli-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
  margin-bottom: 14px;
}
.cli-head-text { flex: 1 1 16em; min-width: 0; }
.cli-refresh { flex: none; }
/* Edge cases fold away under the one-sentence summary. */
.cli-more { margin: 4px 0 0; font-size: 11.5px; color: var(--text-secondary); line-height: 1.5; }
.cli-more summary { width: fit-content; cursor: pointer; color: var(--accent-fg); }
.cli-more p { margin: 4px 0 0; max-width: 72ch; text-wrap: pretty; word-break: auto-phrase; }
/* Section headings share SettingsSection's small uppercase label. */
.cli-title { margin: 0 0 4px; font-size: var(--font-row-desc); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
.cli-hint { margin: 0; font-size: 11.5px; color: var(--text-secondary); max-width: 72ch; line-height: 1.5; text-wrap: pretty; word-break: auto-phrase; }


.cli-agent { margin-bottom: 18px; }
.cli-agent-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  margin-bottom: 8px;
}
/* A provider names a group of account cards: the page's one section-label
   style (SettingsSection), not a third heading size. */
.cli-agent-name { font-size: var(--font-row-desc); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
.cli-unsupported-group { padding-top: 12px; border-top: 1px solid var(--border-muted); }
.cli-unsupported { margin: 0 0 6px; font-size: var(--font-2xs); color: var(--text-secondary); }
.cli-unsupported-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.cli-unsupported-list li {
  font-size: var(--font-2xs);
  color: var(--text-primary);
  padding: 2px 8px;
  border: 1px solid var(--border-muted);
  border-radius: 999px;
  background: var(--bg-subtle);
}

.cli-card-grid {
  display: grid;
  /* One account per row, across the page's width: half-width cards left an
     empty column beside every vendor with a single account. */
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
}
.cli-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-subtle);
}
/* The account in use is marked by its neutral "Default" pill, not a blue
   ring: blue is reserved for selection, focus and the primary action. */
.cli-card.active {
  border-color: var(--border-strong);
}
/* The empty, inactive built-in Default: one line across the grid. */
.cli-card.cli-card-collapsed {
  grid-column: 1 / -1;
  flex-direction: row;
  align-items: center;
  padding: 6px 12px;
  border-style: dashed;
  background: transparent;
}
.cli-card-collapsed-text {
  flex: 1;
  min-width: 0;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.cli-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cli-card-av {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-2xs);
  font-weight: 700;
  color: #fff;
}
.cli-card-av.default { background: var(--border-strong); }
/* Nobody signed in yet: an empty outlined slot, not a letter from the status text. */
.cli-card-av.pending { background: transparent; border: 1px dashed var(--border-strong); }
.cli-card-id {
  flex: 1;
  min-width: 0;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-primary);
  /* Long localized names ("Ursprüngliche Anmeldung …") wrap to a second line
     instead of losing their ending to an ellipsis. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.cli-card-id.dim { font-weight: 400; color: var(--text-muted); }
.cli-card-rename-btn {
  flex-shrink: 0;
  visibility: hidden;
  padding: 1px 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
}
.cli-card:hover .cli-card-rename-btn,
.cli-card-rename-btn:focus-visible {
  visibility: visible;
}
.cli-card-rename-btn:hover {
  color: var(--accent-fg);
  background: var(--bg-hover);
}
.cli-card-rename {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  border: 1px solid var(--accent-fg);
  border-radius: 5px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: var(--font-xs);
  font-family: inherit;
}
.cli-card-meta { font-size: var(--font-xs); color: var(--text-secondary); }
.cli-card-dup {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 6px;
  font-size: var(--font-xs);
  line-height: 1.4;
  color: var(--attention-fg);
}
.cli-card-dup-flag {
  flex: none;
  font-size: var(--font-2xs);
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 999px;
  color: var(--attention-fg);
  background: var(--attention-subtle, var(--bg-muted));
  border: 1px solid var(--attention-muted, var(--border-default));
}

.cli-card-big {
  font-size: var(--font-xl);
  font-weight: 700;
  line-height: 1.1;
  color: var(--text-primary);
}
.cli-card-big small {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-secondary);
  margin-left: 4px;
}
.cli-card-big.warn { color: var(--attention-fg); }
.cli-card-big.crit { color: var(--danger-fg); }
.cli-card-bars { display: flex; flex-direction: column; gap: 3px; }
.cli-mini-bar {
  height: 3px;
  border-radius: 999px;
  background: var(--bg-muted);
  overflow: hidden;
}
.cli-mini-fill { height: 100%; border-radius: 999px; background: var(--success-fg); }
.cli-mini-fill.warn { background: var(--attention-fg); }
.cli-mini-fill.crit { background: var(--danger-fg); }
.cli-card-foot { font-size: var(--font-xs); color: var(--text-muted); }
.cli-card-cache { font-size: var(--font-xs); font-weight: 600; color: var(--attention-fg); }
.cli-card-refresh { font-size: var(--font-xs); color: var(--text-muted); }
/* A read is in flight — the only line on the card that is about right now,
   so it must not read as quietly as the historical ones around it. */
.cli-card-refresh.pending { color: var(--accent-fg); font-weight: 600; }
/* The backend's own sentence; cards are narrow, so let it wrap instead of
   clipping the half that names the failure. */
.cli-card-reason {
  font-size: var(--font-xs);
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.cli-card-expired { font-size: var(--font-2xs); font-weight: 600; color: var(--danger-fg); }
.cli-card-none { display: flex; flex-direction: column; gap: 2px; }

.cli-card-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
}
.cli-confirm-text { font-size: var(--font-2xs); color: var(--text-secondary); }
.cli-badge {
  flex-shrink: 0;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 999px;
  padding: 1px 8px;
}

.cli-btn {
  white-space: nowrap;
  border-radius: 5px;
  font-size: var(--font-xs);
  padding: 5px 10px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
}
/* Small in type, not in reach: Refresh Quota, Sign In and the rest keep a
   28px target. */
.cli-btn.sm { display: inline-flex; align-items: center; justify-content: center; min-height: var(--control-h-md); font-size: var(--font-2xs); padding: 3px 8px; }
.cli-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cli-btn.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.cli-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.cli-btn.ghost { background: transparent; color: var(--text-secondary); }
.cli-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
.cli-btn.danger {
  background: var(--danger-emphasis, var(--danger-fg));
  border-color: var(--danger-emphasis, var(--danger-fg));
  color: var(--text-on-emphasis);
}
</style>
