<script setup lang="ts">
// Turn Stats: per-turn token usage of one CLI pane, in the Settings shell —
// pane list down the left, the turns table on the right. Hosted inside the
// main window like the Resource Manager, reached from the Window menu, the
// command palette (ui.window.openTurnStats) and the Token panel's ≡ button.
//
// It owns no pane state: the host passes its pane views in (which carry each
// pane's resume session id and last quota hit), and the quota figures are the
// usage badge's own snapshot (useUsage, per agent). Everything on the right
// is TurnStatsView; this file is the shell and the picker.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import type { useBackend } from '../composables/useBackend'
import type { useCliProfiles } from '../composables/useCliProfiles'
import {
  accountUsageFor,
  formatRemaining,
  isExhausted,
  remainingPercent,
  remainingTier,
  usageFor,
  type UsageSnapshot,
} from '../composables/useUsage'
import {
  DEFAULT_PROFILE_ID,
  UNKNOWN_PROFILE_ID,
  accountKey,
  accountLabel as resolveAccountLabel,
  normalizeProfileId,
} from '../lib/accountLabel'
import TurnStatsView, { type TurnStatsPane } from './TurnStatsView.vue'
import QuotaCycleView from './QuotaCycleView.vue'

const props = defineProps<{
  open: boolean
  backend: ReturnType<typeof useBackend>
  panes: TurnStatsPane[]
  /** The pane the user is looking at; preselected when the modal opens. */
  activePaneId?: string | null
  /** The accounts source the usage badge reads: names each pane's pinned
   *  account and lists the accounts the "Accounts" section offers. */
  cliProfiles?: ReturnType<typeof useCliProfiles>
}>()
const emit = defineEmits<{ close: []; openSettings: [] }>()

const { t } = useI18n()

// Vendors whose transcripts carry no token usage at all — greyed out in the
// list rather than hidden, so the user learns why rather than wondering
// where the pane went. Same set as TurnStatsView's.
const NO_TOKEN_VENDORS = new Set(['antigravity', 'cursor'])
const VENDOR_LABEL: Record<string, string> = Object.fromEntries(
  CLI_AGENT_SPECS.map((s) => [s.agentKey, s.label])
)
function vendorLabel(agentKey: string): string {
  return VENDOR_LABEL[agentKey] ?? agentKey
}
function vendorUnsupported(agentKey: string): boolean {
  return NO_TOKEN_VENDORS.has(agentKey)
}
function isPlaceholder(p: TurnStatsPane): boolean {
  return p.status === 'waiting'
}

// ── The list ────────────────────────────────────────────────────────────────
const cliPanes = computed(() => props.panes.filter((p) => p.agentKey !== 'terminal'))

function workspaceLabel(path: string | undefined): string {
  const trimmed = (path ?? '').replace(/[\\/]+$/, '')
  const base = trimmed.split(/[\\/]/).pop()
  return base || trimmed
}
/** Panes by workspace folder, in list order. */
const groups = computed(() => {
  const byLabel = new Map<string, TurnStatsPane[]>()
  for (const p of cliPanes.value) {
    const key = workspaceLabel(p.workspacePath)
    const list = byLabel.get(key)
    if (list) list.push(p)
    else byLabel.set(key, [p])
  }
  return [...byLabel.entries()].map(([label, panes]) => ({ label, panes }))
})

const selectedPaneId = ref('')
/** Key of the account picked in the Accounts section; '' = a pane is picked. */
const selectedAccountKey = ref('')
const selectedPane = computed(() => cliPanes.value.find((p) => p.id === selectedPaneId.value) ?? null)

/** A pane the scan can read: a supported vendor, and either running or a
 *  placeholder whose resume session id is known. */
function readable(p: TurnStatsPane): boolean {
  return !vendorUnsupported(p.agentKey) && (!isPlaceholder(p) || !!p.sessionId)
}
// Focused pane → first running supported pane → first placeholder with a
// session → nothing (the empty state; a never-started pane is still clickable
// and says why it has nothing to show).
function defaultPaneId(): string {
  const panes = cliPanes.value
  const active = panes.find((p) => p.id === props.activePaneId)
  if (active && readable(active)) return active.id
  return (
    panes.find((p) => !isPlaceholder(p) && !vendorUnsupported(p.agentKey))?.id ??
    panes.find((p) => isPlaceholder(p) && readable(p))?.id ??
    ''
  )
}

// Opening picks the pane the user is looking at; while open, a pick that
// disappears (pane closed) falls back to the default, but a pick that is
// still listed is left alone — the host rebuilds the list every 400ms.
// The view is handed the pick only while open: closing drops the table, so
// reopening on the same pane rescans (its turns moved on meanwhile), and a
// session id that changes on a closed modal starts no scan behind it.
const viewPane = computed(() => (props.open && !selectedAccount.value ? selectedPane.value : null))
watch(
  () => props.open,
  (open) => {
    if (open) {
      selectedPaneId.value = defaultPaneId()
      selectedAccountKey.value = ''
    }
  },
  { immediate: true }
)
watch(cliPanes, (panes) => {
  if (!props.open) return
  if (selectedPaneId.value && !panes.some((p) => p.id === selectedPaneId.value)) {
    selectedPaneId.value = defaultPaneId()
  }
})

// ── Quota per row (the usage badge's data, per agent) ───────────────────────
interface RowQuota {
  /** 'spent' fills solid; otherwise the remaining % in the badge's tier colour. */
  kind: 'spent' | 'remaining'
  text: string
  tier: 'ok' | 'warn' | 'crit'
}
/** The pane's own account's snapshot — the slot it is pinned to — falling
 *  back to the agent-level reading (the active account's) for a pane from
 *  before pinning existed. */
function paneSnapshot(agentKey: string, profileId: string | undefined): UsageSnapshot | undefined {
  if (!profileId) return usageFor(agentKey)
  return accountUsageFor(agentKey, profileId === DEFAULT_PROFILE_ID ? null : profileId)
    ?? (profileId === activeProfileId(agentKey) ? usageFor(agentKey) : undefined)
}
function quotaOf(snap: UsageSnapshot | undefined): RowQuota | null {
  if (isExhausted(snap)) return { kind: 'spent', text: t('usage.exhausted-short'), tier: 'crit' }
  const remaining = remainingPercent(snap)
  if (remaining === null) return null
  return { kind: 'remaining', text: formatRemaining(remaining), tier: remainingTier(remaining) }
}
function rowQuota(p: TurnStatsPane): RowQuota | null {
  return quotaOf(paneSnapshot(p.agentKey, p.profileId))
}
/** A reading the poller could not refresh: shown faded, with its own clock. */
function rowStale(p: TurnStatsPane): string {
  const snap = paneSnapshot(p.agentKey, p.profileId)
  if (!snap?.stale) return ''
  return t('turn-stats.quota-as-of-stale', { time: clock(Date.parse(snap.fetchedAt)) })
}
function activeProfileId(agentKey: string): string {
  return props.cliProfiles?.defaultProfileId(agentKey) ?? DEFAULT_PROFILE_ID
}
function accountLabel(agentKey: string, profileId: string | null | undefined): string {
  return resolveAccountLabel(props.cliProfiles, agentKey, profileId, t)
}
/** Second line of a pane row: vendor, then the account it runs on (a pane
 *  from before pinning has none to name). */
function paneSub(p: TurnStatsPane): string {
  const vendor = vendorLabel(p.agentKey)
  return p.profileId ? `${vendor} · ${accountLabel(p.agentKey, p.profileId)}` : vendor
}

// ── The accounts section ────────────────────────────────────────────────────
// Every (agent, account) pair this window can speak for: the built-in
// Default and each stored profile of every vendor that has a pane, any pin a
// pane still carries for a profile since removed, and the unknown bucket
// that holds records nobody can trace. Picking one swaps the right-hand
// side for that account's quota cycles.
interface AccountRow {
  key: string
  agentKey: string
  profileId: string
  label: string
  removed: boolean
}
const historicalAccounts = ref<Array<{ agent_key: string; profile_id: string }>>([])
const accountHistoryError = ref(false)
async function loadAccounts(): Promise<void> {
  accountHistoryError.value = false
  try {
    const result = await props.backend.send<{ ok: boolean; accounts?: Array<{ agent_key: string; profile_id: string }> }>('tokens.quota_accounts', {})
    if (!result.ok || !result.payload?.ok) throw new Error('history-unavailable')
    historicalAccounts.value = result.payload.accounts ?? []
    if (props.open && cliPanes.value.length === 0 && !selectedAccountKey.value) selectedAccountKey.value = accountRows.value[0]?.key ?? ''
  } catch {
    accountHistoryError.value = true
  }
}
watch(() => props.open, (open) => { if (open) void loadAccounts() }, { immediate: true })
const accountRows = computed<AccountRow[]>(() => {
  const rows: AccountRow[] = []
  const seen = new Set<string>()
  const push = (agentKey: string, profileId: string, removed = false): void => {
    const key = accountKey(agentKey, profileId)
    if (seen.has(key)) return
    seen.add(key)
    rows.push({ key, agentKey, profileId, label: accountLabel(agentKey, profileId), removed })
  }
  const agents = [...new Set([
    ...cliPanes.value.map((p) => p.agentKey),
    ...historicalAccounts.value.map((a) => a.agent_key),
    ...CLI_AGENT_SPECS.filter((s) => props.cliProfiles?.profilesForAgent(s.agentKey).length).map((s) => s.agentKey)
  ])]
  for (const agentKey of agents) {
    push(agentKey, DEFAULT_PROFILE_ID)
    for (const profile of props.cliProfiles?.profilesForAgent(agentKey) ?? []) push(agentKey, profile.id)
    for (const account of historicalAccounts.value) {
      if (account.agent_key !== agentKey) continue
      const id = normalizeProfileId(account.profile_id)
      push(agentKey, id, id !== DEFAULT_PROFILE_ID && id !== UNKNOWN_PROFILE_ID && !seen.has(accountKey(agentKey, id)))
    }
    for (const p of cliPanes.value) {
      if (p.agentKey !== agentKey || !p.profileId) continue
      const id = normalizeProfileId(p.profileId)
      if (id !== UNKNOWN_PROFILE_ID && !seen.has(accountKey(agentKey, id))) push(agentKey, id, true)
    }
    push(agentKey, UNKNOWN_PROFILE_ID)
  }
  return rows
})
const selectedAccount = computed(() => accountRows.value.find((a) => a.key === selectedAccountKey.value) ?? null)
function pickPane(id: string): void {
  selectedPaneId.value = id
  selectedAccountKey.value = ''
}
function pickAccount(key: string): void {
  selectedAccountKey.value = key
}
function accountQuota(a: AccountRow): RowQuota | null {
  if (a.profileId === UNKNOWN_PROFILE_ID) return null
  return quotaOf(paneSnapshot(a.agentKey, a.profileId))
}
const selectedAccountUsage = computed(() => {
  const a = selectedAccount.value
  return a ? paneSnapshot(a.agentKey, a.profileId) : undefined
})
/** "⛔ back HH:MM" while the pane's own limit hit has not lifted yet. */
function rowLimit(p: TurnStatsPane): string {
  const until = p.usageLimitUntil
  if (p.usageLimitAt == null || until == null || until <= Date.now()) return ''
  return t('turn-stats.limit-back', { time: clock(until) })
}
function clock(ms: number): string {
  const d = new Date(ms)
  const two = (v: number): string => String(v).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

const selectedUsage = computed(() => {
  const pane = selectedPane.value
  return pane ? usageFor(pane.agentKey) : undefined
})

// Close on ESC, the way Settings does.
function onKeyDown(e: KeyboardEvent): void {
  if (!props.open || e.key !== 'Escape') return
  emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <Teleport to="body">
    <div v-show="open" class="s-overlay nv-modal-overlay" @click.self="emit('close')">
      <div class="s-modal nv-modal-shell nv-modal-shell--wide" @click.stop>

        <!-- ── Sidebar: the panes, grouped by workspace ─────────────────── -->
        <aside class="s-sidebar">
          <div class="s-ws-header">
            <div class="s-ws-avatar" aria-hidden="true">≡</div>
            <div class="s-ws-meta">
              <span class="s-ws-name" v-truncate>{{ t('turn-stats.title') }}</span>
            </div>
          </div>

          <nav class="s-nav" :aria-label="t('turn-stats.pane')">
            <div class="s-nav-group-title" v-truncate>{{ t('quota-cycles.pane-usage') }}</div>
            <button v-if="accountHistoryError" type="button" class="ts-nav-item" data-act="retry-accounts" @click="loadAccounts">{{ t('quota-cycles.retry-history') }}</button>
            <p v-if="cliPanes.length === 0" class="ts-nav-empty" data-state="no-panes">{{ t('turn-stats.empty-panes') }}</p>
            <div v-for="g in groups" :key="g.label" class="s-nav-group" data-part="group" :data-workspace="g.label">
              <div class="s-nav-group-title" v-truncate>{{ g.label }}</div>
              <button
                v-for="p in g.panes"
                :key="p.id"
                type="button"
                class="ts-nav-item"
                data-act="pane"
                :data-pane-id="p.id"
                :data-vendor="p.agentKey"
                :class="{ active: p.id === selectedPaneId && !selectedAccount, unsupported: vendorUnsupported(p.agentKey), placeholder: isPlaceholder(p) }"
                :title="vendorUnsupported(p.agentKey) ? t('turn-stats.no-token-usage') : p.agentLabel"
                :aria-current="p.id === selectedPaneId && !selectedAccount ? 'true' : undefined"
                @click="pickPane(p.id)"
              >
                <span class="ts-nav-main">
                  <span class="ts-nav-label" v-truncate>{{ p.agentLabel }}</span>
                  <span class="ts-nav-sub" v-truncate data-part="pane-sub">
                    {{ paneSub(p) }}<template v-if="isPlaceholder(p)"> · {{ t('turn-stats.pane-placeholder') }}</template>
                  </span>
                </span>
                <span class="ts-nav-trail">
                  <span v-if="rowLimit(p)" class="ts-limit-pill" data-part="limit-pill">{{ rowLimit(p) }}</span>
                  <span
                    v-if="rowQuota(p)"
                    class="ts-quota-pill"
                    data-part="quota-pill"
                    :data-stale="rowStale(p) ? 'true' : 'false'"
                    :title="rowStale(p) || undefined"
                    :class="[rowQuota(p)!.tier, { exhausted: rowQuota(p)!.kind === 'spent', stale: !!rowStale(p) }]"
                  >{{ rowQuota(p)!.text }}</span>
                </span>
              </button>
            </div>

            <!-- Accounts: one row per (vendor, account); picking one shows its quota cycles. -->
            <div v-if="accountRows.length" class="s-nav-group" data-part="accounts">
              <div class="s-nav-group-title" v-truncate>{{ t('quota-cycles.account-quota') }}</div>
              <button
                v-for="a in accountRows"
                :key="a.key"
                type="button"
                class="ts-nav-item"
                data-act="account"
                :data-account-key="a.key"
                :data-vendor="a.agentKey"
                :data-profile-id="a.profileId"
                :class="{ active: a.key === selectedAccountKey, unknown: a.profileId === UNKNOWN_PROFILE_ID }"
                :title="a.profileId"
                :aria-current="a.key === selectedAccountKey ? 'true' : undefined"
                @click="pickAccount(a.key)"
              >
                <span class="ts-nav-main">
                  <span class="ts-nav-label" v-truncate>{{ a.label }}<template v-if="a.removed"> · {{ t('quota-cycles.removed') }}</template></span>
                  <span class="ts-nav-sub" v-truncate>
                    {{ vendorLabel(a.agentKey) }}<template v-if="a.profileId === activeProfileId(a.agentKey)"> · {{ t('account-dim.active') }}</template>
                  </span>
                </span>
                <span class="ts-nav-trail">
                  <span
                    v-if="accountQuota(a)"
                    class="ts-quota-pill"
                    data-part="account-quota-pill"
                    :class="[accountQuota(a)!.tier, { exhausted: accountQuota(a)!.kind === 'spent' }]"
                  >{{ accountQuota(a)!.text }}</span>
                </span>
              </button>
            </div>
          </nav>
        </aside>

        <!-- ── Content ─────────────────────────────────────────────────────── -->
        <div class="s-content">
          <button class="s-close" data-act="close" :title="t('turn-stats.close')" @click="emit('close')">✕</button>
          <div class="s-body">
            <h1 class="s-page-title">{{ t('turn-stats.title') }}</h1>
            <QuotaCycleView
              v-if="open && selectedAccount"
              :backend="backend"
              :agent-key="selectedAccount.agentKey"
              :profile-id="selectedAccount.profileId"
              :label="selectedAccount.label"
              :vendor-label="vendorLabel(selectedAccount.agentKey)"
              :active="selectedAccount.profileId === activeProfileId(selectedAccount.agentKey)"
              :usage="selectedAccountUsage"
              :cli-profiles="cliProfiles"
              @open-settings="emit('openSettings')"
            />
            <TurnStatsView v-else :backend="backend" :pane="viewPane" :usage="selectedUsage" :cli-profiles="cliProfiles" />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* The Settings shell, rule for rule (SettingsModal.vue is scoped, so the
 * classes are shared by name and the rules copied). `.nv-modal-overlay` only
 * skins the scrim — every modal positions its own overlay. */
.s-overlay {
  position: fixed;
  inset: 0;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  z-index: calc(var(--z-modal) + 120);
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}
.s-modal {
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-lg);
  width: min(var(--modal-w-wide), 92vw);
  max-width: 1100px;
  height: 88vh;
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  overflow: hidden;
  box-shadow: var(--shadow-modal);
}
.s-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-inset);
  border-right: 1px solid var(--border-default);
  padding: var(--space-3, 12px) var(--space-2, 8px);
  gap: var(--space-2, 8px);
}
.s-ws-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px var(--space-row-x);
  min-width: 0;
}
.s-ws-avatar {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-selected);
  color: var(--accent-fg);
  font-size: var(--font-md);
}
.s-ws-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
.s-ws-name {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
}
.s-nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 0;
}
.s-nav-group + .s-nav-group {
  border-top: 1px solid var(--border-muted);
}
.s-nav-group-title {
  padding: 4px var(--space-row-x) 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-content {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.s-close {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 30;
  border: none;
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: var(--font-lg);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  line-height: 1;
}
.s-close:hover { background: var(--bg-muted); color: var(--text-bright); }
.s-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.s-page-title {
  margin: 0;
  padding: 20px 24px 6px;
  font-size: var(--font-page-title);
  font-weight: 700;
  color: var(--text-bright);
  flex-shrink: 0;
}

/* ── Pane rows: SettingsNavItem's look, with a trailing quota pill ───────── */
.ts-nav-empty {
  margin: 0;
  padding: 8px var(--space-row-x);
  font-size: var(--font-2xs);
  color: var(--text-muted);
}
.ts-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px var(--space-row-x);
  border: none;
  background: transparent;
  border-radius: var(--radius-control);
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
  font-size: var(--font-row-title);
  transition: background-color 120ms ease, color 120ms ease;
}
.ts-nav-item:hover { background: var(--bg-hover); }
.ts-nav-item:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: -1px;
}
.ts-nav-item.active {
  background: var(--bg-selected);
  color: var(--accent-fg);
  font-weight: 600;
}
.ts-nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  border-radius: 0 2px 2px 0;
  background: var(--accent-emphasis);
}
.ts-nav-item.unsupported .ts-nav-main { color: var(--text-disabled); }
/* A not-yet-started pane reads quieter; its sub line already says why. */
.ts-nav-item.placeholder:not(.active) .ts-nav-label { color: var(--text-secondary); }
.ts-nav-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.3;
}
.ts-nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-nav-sub {
  font-size: var(--font-3xs);
  font-weight: 400;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-nav-trail {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}
/* The usage badge's pill and tiers (UsageBadge.vue), so a row reads the same
 * as the pane header it stands for. */
.ts-quota-pill {
  font-size: 9px;
  font-weight: 600;
  border-radius: 999px;
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  background: var(--bg-subtle);
}
.ts-quota-pill.warn {
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border-color: var(--attention-muted);
}
.ts-quota-pill.crit {
  color: var(--danger-fg);
  background: var(--danger-deep);
  border-color: var(--danger-fg);
}
.ts-quota-pill.exhausted {
  color: var(--text-on-emphasis);
  background: var(--danger-emphasis);
  border-color: var(--danger-emphasis);
}
.ts-quota-pill.stale {
  opacity: 0.6;
  border-style: dashed;
}
.ts-nav-item.unknown .ts-nav-label { color: var(--text-muted); }
.ts-limit-pill {
  font-size: 9px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--danger-fg);
}

</style>
