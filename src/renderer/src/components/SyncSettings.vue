<script setup lang="ts">
/**
 * Cross-device sync for the four INTEGRATIONS sections.
 *
 * Deliberately one list rather than a switch inside each section's own pane:
 * "what leaves this machine" is a question people ask once, about everything,
 * and answering it in four places is how a switch gets missed.
 *
 * Three states share this surface and must stay distinguishable — off (the
 * default), on but not connected, and on with an unresolved conflict. A pane
 * that collapses them into one is a pane that makes someone re-enter a
 * credential that was never wrong.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import { maskMcpRecord } from '../lib/syncMask'
import { visible } from '../lib/syncVisible'
import SyncRecordSummary from './SyncRecordSummary.vue'
import SyncVersionHistory from './SyncVersionHistory.vue'
import SettingRow from './settings/SettingRow.vue'
import SettingsCard from './settings/SettingsCard.vue'
import SettingsSection from './settings/SettingsSection.vue'
import ToggleSwitch from './settings/ToggleSwitch.vue'

type Backend = ReturnType<typeof useBackend>

interface Conflict {
  scope: string
  itemId: string
  local: unknown
  remote: unknown
  remoteRev: number
  remoteDevice: string
  seenAt: number
  /** True for a scope whose payloads never reach the renderer: `local` and
   *  `remote` are then metadata (or a placeholder), not the item. */
  sealed?: boolean
  /** The cloud never held this item (a rev-0 synthetic tombstone): keeping
   *  "theirs" would only delete the local copy, and the backend refuses it. */
  remoteAbsent?: boolean
  /** MCP only: per env/header name, how the two hidden values compare
   *  ('same' | 'differs' | 'local-only' | 'remote-only'), as the backend saw
   *  them. The values themselves never reach the renderer. */
  masked?: Record<string, Record<string, string>>
}

/** One scope's outcome of a sync round, as sync.now returns it. */
interface ScopeResult {
  scope: string
  ok?: boolean
  error?: string
  skipped?: string
  pulled?: number
  pushed?: number
  conflicts?: number
  held?: string[]
  /** The part of held deferred for long (5+ rounds or 30+ minutes); the
   *  backend keeps retrying it. */
  gaveUp?: string[]
  refused?: string[]
  tooLarge?: string[]
  /** The server asked for a second start-over within an hour and the backend
   *  refused it: nothing was pulled, pushed or cleared this round. */
  resetThrottled?: boolean
  /** ISO-8601 UTC. */
  at?: string
}

/** A synced skill or MCP server held until the user approves it (D1). The
 *  summary says what would run; it never carries an env or header value. */
interface Approval {
  scope: string
  itemId: string
  /** Digest of the exact held payload; handed back with the decision so
   *  what is approved is what was shown. */
  digest: string
  status: string
  kind: string
  summary: Record<string, unknown>
  /** False when the summary cannot show the whole record: no Approve. */
  displayable?: boolean
  /** True when the listing sent only the small fields; the card loads the
   *  record whole (sync.approval.detail) before it offers Approve. */
  collapsed?: boolean
}

/** An item that reads like it carries a secret (D2): where, never what. */
interface SecretWarning {
  scope: string
  itemId: string
  label: string
  fields: string[]
  lines?: number[]
}

interface ResultLine {
  text: string
  error?: boolean
}

const props = defineProps<{ backend: Backend }>()
const { t } = useI18n()

const available = ref<string[]>([])
const scopes = ref<Record<string, boolean>>({})
const hasKey = ref(false)
const keyId = ref('')
const legacyRingPending = ref(false)
const rotateArmed = ref(false)
const linkState = ref('')
/** Whose cloud these sections go to, when the backend says. */
const accountEmail = ref('')
const conflicts = ref<Conflict[]>([])
const busy = ref('')
const error = ref('')
const approvals = ref<Approval[]>([])
/** Scopes whose approval queue is full: new records there are refused. */
const approvalsFull = ref<string[]>([])
const secretWarnings = ref<SecretWarning[]>([])
/** Held records still asking; a rejected one is not asked about again. */
const waiting = computed(() => approvals.value.filter((a) => a.status !== 'rejected'))
/** The latest outcome per scope ('all' when the round never reached one). */
const results = ref<Record<string, ScopeResult>>({})

/** Scopes whose adapter is not shipped yet still list, but cannot be turned on.
 *  Skill *content* is a later phase; what ships here is the decision layer. */
const READY: ReadonlySet<string> = new Set(['prompts', 'mcp', 'skills'])

/** Scopes sync no longer offers (2026-10-09: memory — sync covers assets and
 *  extensions only). A switch an older build left on stays reachable so it
 *  can be switched off; the backend never runs them either way. */
const RETIRED: ReadonlySet<string> = new Set(['memory'])

/** The rows to list: one per Agent Assets page, in the sidebar's order and
 *  under the sidebar's names. Rows outside READY show greyed out.
 *
 *  No 'credentials' row: credentials and keys are only ever stored on this
 *  machine (2026-10-21), so there is nothing to sync and nothing to offer.
 *  A switch an older build left on is treated as off by the backend
 *  (sync_scopes.NEVER_SYNCED), and no engine takes the scope at all
 *  (sync_engine.LOCAL_ONLY_SCOPES). */
const listed = ['mcp', 'skills', 'prompts', 'memory', 'cliExtensions'] as const

const connected = computed(() => linkState.value === 'connected')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const SKIP_REASONS: ReadonlySet<string> = new Set(['not-connected', 'no-key', 'unsupported'])

function itemIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function toResult(value: unknown): ScopeResult | null {
  if (!isRecord(value) || typeof value.scope !== 'string' || !value.scope) return null
  return {
    scope: value.scope,
    ok: typeof value.ok === 'boolean' ? value.ok : undefined,
    error: typeof value.error === 'string' && value.error ? value.error : undefined,
    skipped: typeof value.skipped === 'string' && value.skipped ? value.skipped : undefined,
    pulled: Number(value.pulled ?? 0) || 0,
    pushed: Number(value.pushed ?? 0) || 0,
    conflicts: Number(value.conflicts ?? 0) || 0,
    held: itemIds(value.held),
    gaveUp: itemIds(value.gaveUp),
    refused: itemIds(value.refused),
    tooLarge: itemIds(value.tooLarge),
    resetThrottled: value.resetThrottled === true,
    at: typeof value.at === 'string' ? value.at : undefined,
  }
}

/** Record one scope's outcome. A switched-off scope's "skipped" is dropped
 *  rather than shown: off is the default, not something to report. */
function noteResult(value: unknown): void {
  const result = toResult(value)
  if (!result) return
  const next = { ...results.value }
  if (result.skipped === 'disabled') delete next[result.scope]
  else next[result.scope] = result
  results.value = next
}

function resultLines(r: ScopeResult): ResultLine[] {
  if (r.error) return [{ text: t('settings.sync.result-error', { error: r.error }), error: true }]
  if (r.skipped) {
    return [
      {
        text: SKIP_REASONS.has(r.skipped)
          ? t('settings.sync.skipped-' + r.skipped)
          : t('settings.sync.skipped-other', { reason: r.skipped }),
      },
    ]
  }
  if (r.resetThrottled) return [{ text: t('settings.sync.result-reset-throttled'), error: true }]
  const lines: ResultLine[] = [
    { text: t('settings.sync.result-ok', { pulled: r.pulled ?? 0, pushed: r.pushed ?? 0 }) },
  ]
  if (r.conflicts) lines.push({ text: t('settings.sync.result-conflicts', { count: r.conflicts }) })
  const stuck = new Set(r.gaveUp ?? [])
  const waiting = (r.held ?? []).filter((id) => !stuck.has(id))
  if (waiting.length) lines.push({ text: t('settings.sync.result-held', { items: waiting.join(', ') }) })
  if (stuck.size) {
    lines.push({ text: t('settings.sync.result-gave-up', { items: [...stuck].join(', ') }), error: true })
  }
  if (r.refused?.length) {
    lines.push({ text: t('settings.sync.result-refused', { items: r.refused.join(', ') }), error: true })
  }
  if (r.tooLarge?.length) {
    lines.push({ text: t('settings.sync.result-too-large', { items: r.tooLarge.join(', ') }), error: true })
  }
  return lines
}

/** Results in the order the scopes are listed, the catch-all row first. */
const resultRows = computed(() => {
  const order = ['all', ...available.value, 'skill-files']
  return Object.values(results.value).sort(
    (a, b) => (order.indexOf(a.scope) + 1 || 999) - (order.indexOf(b.scope) + 1 || 999),
  )
})

function scopeLabel(scope: string): string {
  return t('settings.sync.scope-' + scope)
}

function toScopes(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Boolean(v)]))
}

async function load(): Promise<void> {
  error.value = ''
  try {
    const resp = await props.backend.send<{
      available?: unknown
      scopes?: unknown
      hasKey?: unknown
      keyId?: unknown
      legacyRingPending?: unknown
      link?: unknown
      last?: unknown
      account?: unknown
    }>('sync.status', {})
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sync.error-load')
      return
    }
    const payload = resp.payload
    available.value = Array.isArray(payload?.available) ? payload.available.map(String) : []
    scopes.value = toScopes(payload?.scopes)
    hasKey.value = Boolean(payload?.hasKey)
    keyId.value = typeof payload?.keyId === 'string' ? payload.keyId : ''
    legacyRingPending.value = Boolean(payload?.legacyRingPending)
    linkState.value = isRecord(payload?.link) ? String(payload.link.state ?? '') : ''
    const email = isRecord(payload?.account) ? payload.account.email : undefined
    accountEmail.value = typeof email === 'string' ? email : ''
    if (isRecord(payload?.last)) {
      // The backend keeps the last outcome per scope; it is the whole truth.
      results.value = {}
      for (const [scope, last] of Object.entries(payload.last)) {
        if (isRecord(last)) noteResult({ scope, ...last })
      }
    }
    await loadConflicts()
    await loadApprovals()
  } catch (err) {
    error.value = String(err)
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

async function loadApprovals(): Promise<void> {
  const [held, warned] = await Promise.all([
    props.backend.send<{ approvals?: unknown }>('sync.approvals', {}),
    props.backend.send<{ warnings?: unknown }>('sync.secret_warnings', {}),
  ])
  const rows = held?.ok ? held.payload?.approvals : null
  approvals.value = Array.isArray(rows) ? (rows as Approval[]) : []
  approvalsFull.value = held?.ok ? strings((held.payload as { full?: unknown } | undefined)?.full) : []
  const found = warned?.ok ? warned.payload?.warnings : null
  secretWarnings.value = Array.isArray(found) ? (found as SecretWarning[]) : []
}

/** An MCP server's install-only record travels as `i:<name>`; the card
 *  names the server. */
function shownId(scope: string, itemId: string): string {
  return scope === 'mcp' && itemId.startsWith('i:') ? itemId.slice(2) : itemId
}

function approvalKind(a: Approval): string {
  if (a.status === 'approved') return t('settings.sync.approval-downloading')
  return a.kind === 'changed' ? t('settings.sync.approval-changed') : t('settings.sync.approval-new')
}

async function expand(a: Approval): Promise<void> {
  busy.value = a.scope + '/' + a.itemId
  error.value = ''
  try {
    const resp = await props.backend.send<{ approval?: unknown }>('sync.approval.detail', {
      scope: a.scope,
      itemId: a.itemId,
    })
    const whole = resp?.ok ? resp.payload?.approval : null
    if (!isRecord(whole)) {
      error.value = resp?.error?.message ?? t('settings.sync.error-load')
      return
    }
    approvals.value = approvals.value.map((row) =>
      row.scope === a.scope && row.itemId === a.itemId ? (whole as unknown as Approval) : row,
    )
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

async function decide(a: Approval, approve: boolean): Promise<void> {
  busy.value = a.scope + '/' + a.itemId
  error.value = ''
  try {
    const resp = await props.backend.send<{ approvals?: unknown }>('sync.approval.decide', {
      scope: a.scope,
      itemId: a.itemId,
      approve,
      digest: a.digest,
    })
    if (!resp?.ok) {
      error.value = resp?.error?.message ?? t('settings.sync.error-load')
      return
    }
    const rows = resp.payload?.approvals
    approvals.value = Array.isArray(rows) ? (rows as Approval[]) : []
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

function warningDetail(w: SecretWarning): string {
  const parts = [t('settings.sync.secret-warning-fields', { fields: strings(w.fields).join(', ') })]
  if (w.lines?.length) parts.push(t('settings.sync.secret-warning-lines', { lines: w.lines.join(', ') }))
  return parts.join(' · ')
}

async function dismissWarning(w: SecretWarning): Promise<void> {
  try {
    const resp = await props.backend.send<{ warnings?: unknown }>('sync.secret_warning.dismiss', {
      scope: w.scope,
      itemId: w.itemId,
    })
    const rows = resp?.ok ? resp.payload?.warnings : null
    secretWarnings.value = Array.isArray(rows) ? (rows as SecretWarning[]) : []
  } catch (err) {
    error.value = String(err)
  }
}

async function loadConflicts(): Promise<void> {
  const resp = await props.backend.send<{ conflicts?: unknown }>('sync.conflicts', {})
  const rows = resp.ok ? resp.payload?.conflicts : null
  conflicts.value = Array.isArray(rows) ? (rows as Conflict[]) : []
}

/** A scope outside READY may still be on (left on by an older build). Its
 *  switch then only goes one way: off is always allowed, on never is. */
function canToggle(scope: string): boolean {
  return READY.has(scope) || Boolean(scopes.value[scope])
}

async function setScope(scope: string, enabled: boolean): Promise<void> {
  if (enabled && !READY.has(scope)) return
  busy.value = scope
  error.value = ''
  try {
    const resp = await props.backend.send<{ scopes?: unknown }>('sync.set_scope', {
      scope,
      enabled,
    })
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sync.error-load')
      return
    }
    scopes.value = toScopes(resp.payload?.scopes)
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

async function syncNow(): Promise<void> {
  busy.value = 'all'
  error.value = ''
  try {
    const resp = await props.backend.send<{ results?: unknown }>('sync.now', {})
    if (!resp.ok) error.value = resp.error?.message ?? t('settings.sync.error-load')
    else if (Array.isArray(resp.payload?.results)) resp.payload.results.forEach(noteResult)
    await loadConflicts()
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

/** Adopt the sync key from before accounts were bound as this account's.
 *  Explicit and once: the backend cannot tell whose it was, and minting a
 *  fresh key instead would leave everything that key wrote unreadable. */
async function adoptLegacyKey(): Promise<void> {
  busy.value = 'key'
  error.value = ''
  try {
    const resp = await props.backend.send('sync.adopt_legacy_key', {}, 30_000)
    if (!resp.ok) error.value = resp.error?.message ?? t('settings.sync.error-load')
    await load()
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

/** Retire the active key: every record is re-sealed under a new one on the
 *  next rounds; paired devices receive the new key over the paired channel.
 *  Two clicks, because this is the stop-the-bleeding move and not a refresh. */
async function rotateKey(): Promise<void> {
  if (!rotateArmed.value) {
    rotateArmed.value = true
    return
  }
  rotateArmed.value = false
  busy.value = 'key'
  error.value = ''
  try {
    const resp = await props.backend.send<{ keyId?: unknown }>('sync.rotate_key', {}, 60_000)
    if (!resp.ok) error.value = resp.error?.message ?? t('settings.sync.error-load')
    await load()
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

async function resolve(conflict: Conflict, keep: 'local' | 'remote'): Promise<void> {
  busy.value = `${conflict.scope}/${conflict.itemId}`
  error.value = ''
  try {
    const resp = await props.backend.send<{ conflicts?: unknown }>('sync.resolve', {
      scope: conflict.scope,
      itemId: conflict.itemId,
      keep,
    })
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sync.error-load')
      return
    }
    const rows = resp.payload?.conflicts
    if (Array.isArray(rows)) conflicts.value = rows as Conflict[]
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

const SECRET_STATES: ReadonlySet<string> = new Set(['same', 'differs', 'local-only', 'remote-only'])

interface SecretState {
  key: string
  name: string
  state: string
}

/** The hidden-value comparison of an MCP conflict, env before headers. An
 *  unknown state reads as "differs": the safe assumption about a secret. */
function secretStates(c: Conflict): SecretState[] {
  if (!isRecord(c.masked)) return []
  const out: SecretState[] = []
  for (const field of ['env', 'headers']) {
    const entries = c.masked[field]
    if (!isRecord(entries)) continue
    for (const [name, raw] of Object.entries(entries)) {
      const state = typeof raw === 'string' && SECRET_STATES.has(raw) ? raw : 'differs'
      out.push({ key: `${field}/${name}`, name, state })
    }
  }
  return out
}

/** One side of a conflict as it may be shown: an MCP record loses its
 *  secrets (see maskMcpRecord); every other scope is shown as it is. */
function shown(scope: string, value: unknown): unknown {
  return scope === 'mcp' ? maskMcpRecord(value) : value
}

function preview(value: unknown, sealed = false): string {
  if (value === null || value === undefined) return t('settings.sync.deleted')
  if (sealed) {
    // The backend already redacted this half; what is left is which slot it
    // is, and that is all a person needs to pick a side.
    if (isRecord(value) && typeof value.agentKey === 'string' && typeof value.slotId === 'string') {
      return `${value.agentKey} / ${value.slotId}`
    }
    return t('settings.sync.sealed')
  }
  const text = JSON.stringify(value)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/** The whole value behind a preview cut at 160 characters, for its hover. */
function previewFull(value: unknown, sealed = false): string | undefined {
  return sealed || value === null || value === undefined ? undefined : JSON.stringify(value)
}

/** A round the backend ran on its own (after a local save, on reconnect)
 *  reports here, so the pane does not wait to be reopened. */
function onSyncResult(payload: unknown): void {
  noteResult(payload)
  void loadConflicts().catch((err) => {
    error.value = String(err)
  })
  void loadApprovals().catch((err) => {
    error.value = String(err)
  })
}

let offResult: (() => void) | undefined

onMounted(() => {
  offResult = props.backend.on('sync.result', onSyncResult)
  void load()
})

onBeforeUnmount(() => offResult?.())
</script>

<template>
  <SettingsSection :label="t('settings.sync.title')">
    <p v-if="accountEmail" class="sync-account">
      {{ t('settings.sync.account', { email: accountEmail }) }}
    </p>
    <SettingsCard>
      <SettingRow
        v-for="scope in listed"
        :key="scope"
        :class="{ 'sync-row-off': !canToggle(scope) }"
        :title="t('settings.nav.' + scope)"
        :description="
          READY.has(scope)
            ? t('settings.sync.scope-hint-' + scope)
            : RETIRED.has(scope) && scopes[scope]
              ? t('settings.sync.retired-' + scope)
              : t('settings.sync.not-yet')
        "
      >
        <template #control>
          <ToggleSwitch
            :model-value="Boolean(scopes[scope])"
            :disabled="busy === scope || !canToggle(scope)"
            :aria-label="t('settings.nav.' + scope)"
            @update:model-value="(v: boolean) => setScope(scope, v)"
          />
        </template>
      </SettingRow>
    </SettingsCard>

    <p class="sync-hint">{{ t('settings.sync.hint') }}</p>

    <!-- The three states kept apart: off is the absence of a toggle, so only
         the other two need saying out loud. -->
    <p v-if="!connected" class="sync-note">{{ t('settings.sync.not-connected') }}</p>
    <p v-else-if="!hasKey" class="sync-note">{{ t('settings.sync.no-key') }}</p>

    <div class="sync-actions">
      <button class="nv-btn nv-btn--sm" type="button" :disabled="busy === 'all' || !connected" @click="syncNow">
        {{ t('settings.sync.now') }}
      </button>
    </div>

    <ul v-if="resultRows.length" class="sync-results">
      <li v-for="r in resultRows" :key="r.scope" class="sync-result">
        <strong>{{ scopeLabel(r.scope) }}</strong>
        <span
          v-for="(line, i) in resultLines(r)"
          :key="i"
          :class="['sync-result-line', { 'sync-result-error': line.error }]"
          >{{ line.text }}</span
        >
      </li>
    </ul>

    <!-- The account key: which one is active (by id, never the key), the
         one-time adoption of a key from before accounts were bound, and
         rotation. -->
    <div v-if="connected" class="sync-key">
      <p v-if="legacyRingPending && !hasKey" class="sync-note sync-key-legacy">
        {{ t('settings.sync.legacy-key') }}
        <button class="nv-btn nv-btn--sm" type="button" :disabled="busy === 'key'" @click="adoptLegacyKey">
          {{ t('settings.sync.legacy-key-adopt') }}
        </button>
      </p>
      <p v-if="hasKey" class="sync-note sync-key-row">
        <span>{{ t('settings.sync.key-id', { id: keyId.slice(0, 8) || '—' }) }}</span>
        <button class="nv-btn nv-btn--sm" type="button" :disabled="busy === 'key'" @click="rotateKey">
          {{ rotateArmed ? t('settings.sync.rotate-confirm') : t('settings.sync.rotate') }}
        </button>
        <button class="nv-btn nv-btn--sm" v-if="rotateArmed" type="button" @click="rotateArmed = false">
          {{ t('settings.sync.rotate-cancel') }}
        </button>
      </p>
      <p v-if="hasKey" class="sync-hint">{{ t('settings.sync.rotate-hint') }}</p>
    </div>

    <p v-if="approvalsFull.length" class="sync-note sync-result-error sync-approvals-full">
      {{ t('settings.sync.approvals-full', { scopes: approvalsFull.map(scopeLabel).join(', ') }) }}
    </p>
    <div v-if="waiting.length" class="sync-conflicts">
      <h3>{{ t('settings.sync.approvals-title', { count: waiting.length }) }}</h3>
      <p class="sync-hint">{{ t('settings.sync.approvals-hint') }}</p>
      <div v-for="a in waiting" :key="a.scope + '/' + a.itemId" class="sync-conflict sync-approval">
        <div class="sync-conflict-head">
          <strong>{{ t('settings.sync.scope-' + a.scope) }}</strong>
          <code>{{ visible(shownId(a.scope, a.itemId)) }}</code>
          <span class="sync-hint">{{ approvalKind(a) }}</span>
        </div>
        <p v-if="a.displayable === false" class="sync-note sync-result-error sync-approval-undisplayable">
          {{ t('settings.sync.approval-undisplayable') }}
          <template v-if="typeof a.summary.unavailable === 'string'"> {{ visible(a.summary.unavailable) }}</template>
        </p>
        <SyncRecordSummary v-else :summary="a.summary" />
        <div v-if="a.status !== 'approved'" class="sync-approval-actions">
          <button
            v-if="a.collapsed && a.displayable !== false"
            type="button"
            class="sync-expand"
            :disabled="busy === a.scope + '/' + a.itemId"
            @click="expand(a)"
          >
            {{ t('settings.sync.approval-expand') }}
          </button>
          <button
            v-if="a.displayable !== false && !a.collapsed"
            type="button"
            class="sync-approve"
            :disabled="busy === a.scope + '/' + a.itemId"
            @click="decide(a, true)"
          >
            {{ t('settings.sync.approve') }}
          </button>
          <button
            type="button"
            class="sync-reject"
            :disabled="busy === a.scope + '/' + a.itemId"
            @click="decide(a, false)"
          >
            {{ t('settings.sync.reject') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="secretWarnings.length" class="sync-conflicts">
      <h3>{{ t('settings.sync.secret-warnings-title', { count: secretWarnings.length }) }}</h3>
      <p class="sync-hint">{{ t('settings.sync.secret-warnings-hint') }}</p>
      <ul class="sync-results">
        <li v-for="w in secretWarnings" :key="w.scope + '/' + w.itemId" class="sync-result sync-secret-warning">
          <strong>{{ t('settings.sync.scope-' + w.scope) }}</strong>
          <span class="sync-result-line">{{ w.label }}</span>
          <span class="sync-result-line">{{ warningDetail(w) }}</span>
          <button type="button" @click="dismissWarning(w)">{{ t('settings.sync.secret-dismiss') }}</button>
        </li>
      </ul>
    </div>

    <div v-if="conflicts.length" class="sync-conflicts">
      <h3>{{ t('settings.sync.conflicts-title', { count: conflicts.length }) }}</h3>
      <p class="sync-hint">{{ t('settings.sync.conflicts-hint') }}</p>
      <div v-for="c in conflicts" :key="c.scope + '/' + c.itemId" class="sync-conflict">
        <div class="sync-conflict-head">
          <strong>{{ t('settings.sync.scope-' + c.scope) }}</strong>
          <code>{{ shownId(c.scope, c.itemId) }}</code>
        </div>
        <div v-if="secretStates(c).length" class="sync-secrets">
          <span class="sync-hint">{{ t('settings.sync.secrets-title') }}</span>
          <span
            v-for="s in secretStates(c)"
            :key="s.key"
            :class="['sync-secret-state', { 'is-differs': s.state !== 'same' }]"
            >{{ s.name }}: {{ t('settings.sync.secret-' + s.state) }}</span
          >
        </div>
        <div class="sync-conflict-side">
          <span class="sync-side-label">{{ t('settings.sync.this-device') }}</span>
          <code class="sync-side-body" v-truncate="previewFull(shown(c.scope, c.local), c.sealed)">{{ preview(shown(c.scope, c.local), c.sealed) }}</code>
          <button
            type="button"
            :disabled="busy === c.scope + '/' + c.itemId"
            @click="resolve(c, 'local')"
          >
            {{ t('settings.sync.keep-this') }}
          </button>
        </div>
        <div class="sync-conflict-side">
          <span class="sync-side-label">{{ c.remoteDevice || t('settings.sync.other-device') }}</span>
          <code class="sync-side-body" v-truncate="previewFull(shown(c.scope, c.remote), c.sealed)">{{ preview(shown(c.scope, c.remote), c.sealed) }}</code>
          <button
            v-if="!c.remoteAbsent"
            type="button"
            :disabled="busy === c.scope + '/' + c.itemId"
            @click="resolve(c, 'remote')"
          >
            {{ t('settings.sync.keep-other') }}
          </button>
        </div>
      </div>
    </div>

    <SyncVersionHistory v-if="connected" :backend="props.backend" />

    <p v-if="error" class="err-msg">{{ error }}</p>
  </SettingsSection>
</template>

<style scoped>
.sync-row-off :deep(.setting-row-title) {
  color: var(--text-secondary);
  font-weight: 500;
}
.sync-hint {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 8px 0 0;
}
.sync-note {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 6px 0 0;
}
.sync-account {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
.sync-actions {
  margin-top: 10px;
}
/* Small in type, not in reach: every Settings button keeps a 28px target. */
.nv-btn--sm {
  min-height: var(--control-h-md);
}
.sync-results {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.sync-result {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  padding: 2px 0;
  min-width: 0;
}
.sync-result strong {
  color: var(--text-primary);
  font-weight: 600;
}
.sync-result-line {
  overflow-wrap: anywhere;
}
.sync-result-error {
  color: var(--text-danger, #e07060);
}
.sync-key {
  margin-top: 12px;
}
.sync-key-row,
.sync-key-legacy {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.sync-conflicts {
  margin-top: 16px;
}
.sync-conflicts h3 {
  font-size: var(--font-row-title);
  font-weight: 600;
  margin: 0 0 4px;
}
.sync-conflict {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  padding: 10px 12px;
  margin-top: 10px;
  background: var(--bg-subtle);
}
.sync-conflict-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-bottom: 6px;
}
.sync-secrets {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin-bottom: 4px;
}
.sync-secrets .sync-hint {
  margin: 0;
}
.sync-secret-state {
  overflow-wrap: anywhere;
}
.sync-secret-state.is-differs {
  color: var(--text-danger, #e07060);
}
.sync-approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.sync-conflict-side {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 0;
  min-width: 0;
}
.sync-side-label {
  flex: none;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  min-width: 7em;
}
.sync-side-body {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.err-msg {
  color: var(--text-danger, #e07060);
  font-size: var(--font-row-desc);
  margin-top: 8px;
}
</style>
