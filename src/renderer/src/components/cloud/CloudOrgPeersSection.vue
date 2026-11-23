<script setup lang="ts">
/**
 * Settings → Navide Cloud → Organizations: the machines other organizations
 * share with yours, grouped organization → machine, each with a Pair button.
 *
 * Pairing is the existing six-digit exchange (p2p.pair.start / confirm); the
 * card for it is drawn here too, so nobody has to switch windows to compare
 * digits. Pairing only confirms who the other side is: which panes it may
 * reach is still the pane rules, which deny by default.
 *
 * Read from `p2p.network.snapshot`'s `org` block. A server without
 * organisations (or a link that is down) reads as "not in an organization"
 * and nothing else on the page changes.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import SettingsCard from '../settings/SettingsCard.vue'
import SettingsEmptyState from '../settings/SettingsEmptyState.vue'
import SettingsSection from '../settings/SettingsSection.vue'

export interface OrgPeerRow {
  deviceId: string
  deviceName: string
  ownerName: string
  online: boolean
  listed: boolean
  trustState: string
  canTrust: boolean
  signFingerprint: string
  pairedAt: number | null
  revoked: { reason: string; at: number } | null
}

export interface OrgGrant {
  grantId: string
  expiresAt?: number
  localOrg?: { orgId: string; name: string }
  peerOrg: { orgId: string; name: string }
  /** Both sides are one organization: members of your own, not a linked one. */
  sameOrg?: boolean
  revoked?: { reason: string; at: number }
  peers: OrgPeerRow[]
}

export interface OrgSnapshot {
  status: 'unknown' | 'ok' | 'unsupported' | 'error'
  grants: OrgGrant[]
  revokedGrants: OrgGrant[]
}

interface OrgPairing {
  deviceId: string
  deviceName: string
  role: string
  state: string
  code: string
  fingerprint: string
  org?: { grantId: string; orgName: string; ownerName: string }
}

const POLL_MS = 3000

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t, locale } = useI18n()

const org = ref<OrgSnapshot | null>(null)
const pairings = ref<OrgPairing[]>([])
const loaded = ref(false)
const pending = ref('')
const error = ref('')
/** Which row the last failed act was on, so its reason sits beside it. */
const errorDevice = ref('')
let timer: number | undefined

async function load(): Promise<void> {
  try {
    const resp = await props.backend.send<{ org?: OrgSnapshot; pairings?: OrgPairing[] }>(
      'p2p.network.snapshot',
      {},
    )
    org.value = resp.ok ? resp.payload?.org ?? null : null
    pairings.value = resp.ok ? (resp.payload?.pairings ?? []).filter((row) => !!row.org) : []
  } catch {
    org.value = null
  } finally {
    loaded.value = true
  }
}

onMounted(() => {
  void load()
  timer = window.setInterval(() => void load(), POLL_MS)
})
onBeforeUnmount(() => window.clearInterval(timer))

const joined = computed(() => org.value?.status === 'ok')
const allGrants = computed(() => (joined.value ? org.value?.grants ?? [] : []))
/** Your own organization's members first, then the linked organizations. */
const grants = computed(() => [
  ...allGrants.value.filter((g) => g.sameOrg),
  ...allGrants.value.filter((g) => !g.sameOrg),
])
const revokedGrants = computed(() => org.value?.revokedGrants ?? [])
/** Which empty state applies, or '' when there is something to list. */
const emptyNotice = computed(() => {
  if (!loaded.value) return ''
  if (!joined.value) return 'not-joined'
  return grants.value.length || revokedGrants.value.length ? '' : 'not-exposed'
})
const localOrgName = computed(() => grants.value.find((g) => g.localOrg?.name)?.localOrg?.name ?? '')

/** The same confirmation the account window uses for trust-changing acts. */
async function withConfirmation(action: string, deviceId: string, payload: Record<string, unknown>) {
  const confirm = await window.agentTeam?.trustConfirm(action, deviceId, '')
  return { ...payload, confirm }
}

async function act(deviceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  if (pending.value) return
  pending.value = deviceId
  error.value = ''
  errorDevice.value = deviceId
  try {
    const resp = await props.backend.send(type, await withConfirmation(type, deviceId, payload))
    if (!resp.ok) error.value = resp.error?.message || resp.error?.code || ''
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    pending.value = ''
  }
}

const pair = (row: OrgPeerRow) => act(row.deviceId, 'p2p.pair.start', { deviceId: row.deviceId })
const unpair = (row: OrgPeerRow) => act(row.deviceId, 'p2p.trust.device.unpair', { deviceId: row.deviceId })
const answer = (row: OrgPairing, accept: boolean) =>
  act(row.deviceId, 'p2p.pair.confirm', { deviceId: row.deviceId, accept })

const manageError = ref('')
const opening = ref(false)
/** Failures main can name get a sentence in the reader's language; anything
 *  else is passed through as main said it. */
const MANAGE_HINTS: Record<string, string> = {
  ASSERTION_UNAVAILABLE: 'settings.cloud.org.manage-hint-signin',
  EXCHANGE_FAILED: 'settings.cloud.org.manage-hint-unreachable',
}
async function manage(): Promise<void> {
  if (opening.value) return
  manageError.value = ''
  opening.value = true
  try {
    const result = await window.agentTeam?.openOrgSite?.()
    if (result && !result.ok) {
      const hint = MANAGE_HINTS[result.code ?? '']
      manageError.value = t('settings.cloud.org.manage-failed', { reason: hint ? t(hint) : result.message ?? result.code ?? '' })
    }
  } finally {
    opening.value = false
  }
}

function pairingFor(deviceId: string): OrgPairing | undefined {
  return pairings.value.find((row) => row.deviceId === deviceId)
}

function when(at: number | null | undefined): string {
  if (!at) return ''
  // Revocations carry milliseconds, pins seconds.
  const ms = at > 10_000_000_000 ? at : at * 1000
  return new Date(ms).toLocaleString(locale.value, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function reasonLabel(reason: string | undefined): string {
  const known = ['link-revoked', 'member-removed', 'exposure-withdrawn', 'org-deleted', 'lapsed']
  return t('settings.cloud.org.reason-' + (known.includes(reason ?? '') ? reason : 'lapsed'))
}

function stateLabel(row: OrgPeerRow): string {
  if (row.trustState === 'revoked') return reasonLabel(row.revoked?.reason)
  if (row.trustState !== 'trusted' && pairingFor(row.deviceId)) return t('settings.cloud.org.state-pairing')
  if (row.trustState === 'trusted') return t('settings.cloud.org.state-trusted')
  if (row.trustState === 'blocked') return t('settings.cloud.org.state-blocked')
  return t('settings.cloud.org.state-pending')
}

function stateTone(row: OrgPeerRow): string {
  if (row.trustState === 'trusted') return 'ok'
  if (pairingFor(row.deviceId)) return 'accent'
  if (row.trustState === 'revoked') return row.revoked?.reason === 'exposure-withdrawn' ? 'warn' : 'danger'
  return 'muted'
}

function subline(row: OrgPeerRow): string {
  const owner = row.ownerName ? t('settings.cloud.org.owner', { name: row.ownerName }) : ''
  // The badge beside the row already names the reason; this line says when.
  const extra = row.revoked
    ? t('settings.cloud.org.revoked-since', { when: when(row.revoked.at) })
    : row.pairedAt && row.trustState !== 'trusted'
      ? t('settings.cloud.org.paired-on', { when: when(row.pairedAt) })
      : ''
  return [owner, extra].filter(Boolean).join(' · ')
}

/** How this row can be paired again: re-sharing and re-joining are the other
 *  side's to do; only a lapsed link is fixed by linking again. */
function repairHint(row: OrgPeerRow): string {
  if (row.revoked?.reason === 'exposure-withdrawn') return t('settings.cloud.org.reshare-hint')
  if (row.revoked?.reason === 'member-removed') return t('settings.cloud.org.rejoin-hint')
  return t('settings.cloud.org.repair-hint')
}

/** Offline, and otherwise ready to pair: the one case the row has to explain. */
function offlineHint(row: OrgPeerRow): boolean {
  return !row.online && row.canTrust && row.trustState !== 'trusted' && !pairingFor(row.deviceId)
}

/** The last failure belongs to this listed row, so it is shown there. */
function rowError(deviceId: string): boolean {
  return !!error.value && errorDevice.value === deviceId && grants.value.some((g) => g.peers.some((p) => p.deviceId === deviceId))
}

function grouped(value: string | undefined): string {
  const raw = (value ?? '').replace(/\s+/g, '')
  return raw.match(/.{1,4}/g)?.join(' ') ?? raw
}

function initial(name: string): string {
  return Array.from(name.trim())[0] ?? '?'
}
</script>

<template>
  <SettingsSection :label="t('settings.cloud.org.title')">
    <!-- Nothing to list: one empty state with the way to set it up inside it,
         rather than a sentence that contradicts the page around it. -->
    <SettingsEmptyState
      v-if="emptyNotice"
      class="org-empty"
      :data-notice="emptyNotice"
      :message="t('settings.cloud.org.' + emptyNotice)"
    >
      <button type="button" class="org-manage" data-action="manage" :disabled="opening" :aria-busy="opening" @click="manage">
        {{ opening ? t('settings.cloud.org.manage-opening') : t('settings.cloud.org.manage') + ' ↗' }}
      </button>
    </SettingsEmptyState>
    <div v-else class="org-head">
      <p v-if="!loaded" class="org-hint">{{ t('settings.cloud.org.loading') }}</p>
      <p v-else class="org-hint">
        {{ localOrgName ? t('settings.cloud.org.intro', { org: localOrgName }) : t('settings.cloud.org.intro-generic') }}
      </p>
      <button type="button" class="org-manage" data-action="manage" :disabled="opening" :aria-busy="opening" @click="manage">
        {{ opening ? t('settings.cloud.org.manage-opening') : t('settings.cloud.org.manage') + ' ↗' }}
      </button>
    </div>
    <p v-if="manageError" class="org-note danger" data-notice="manage-failed" role="alert">{{ manageError }}</p>

    <p v-if="error && !rowError(errorDevice)" class="org-note danger" data-notice="error">{{ error }}</p>

    <SettingsCard v-for="grant in grants" :key="grant.grantId" class="org-card" :data-grant-id="grant.grantId">
      <div class="org-card-head">
        <span class="org-avatar" aria-hidden="true">{{ initial(grant.peerOrg.name) }}</span>
        <span class="org-title">
          <span class="org-name" v-truncate>
            {{ grant.sameOrg ? t('settings.cloud.org.same-org-title', { org: grant.peerOrg.name }) : grant.peerOrg.name }}
          </span>
          <span class="org-sub">{{ t('settings.cloud.org.machines', { count: grant.peers.filter((p) => p.listed).length }) }}</span>
        </span>
        <span class="org-badge ok" :data-same-org="grant.sameOrg ? '' : undefined">
          {{ grant.sameOrg ? t('settings.cloud.org.same-org-badge') : t('settings.cloud.org.linked') }}
        </span>
      </div>
      <p v-if="grant.sameOrg" class="org-hint org-card-hint">{{ t('settings.cloud.org.same-org-hint') }}</p>
      <ul class="org-list">
        <li v-for="row in grant.peers" :key="row.deviceId" class="org-row" :data-device-id="row.deviceId">
          <!-- Not colour alone: the dot carries its word for screen readers
               and on hover. -->
          <span
            class="org-dot"
            :class="{ on: row.online }"
            role="img"
            :aria-label="t(row.online ? 'settings.p2p.network.device-online' : 'settings.p2p.network.device-offline')"
            :title="t(row.online ? 'settings.p2p.network.device-online' : 'settings.p2p.network.device-offline')"
          ></span>
          <span class="org-device">
            <span class="org-device-name" v-truncate>{{ row.deviceName || row.deviceId }}</span>
            <span class="org-device-sub">{{ subline(row) }}</span>
            <!-- Said on the row, not only in a tooltip: pairing needs both
                 machines, and the button stays pressable either way. -->
            <span v-if="offlineHint(row)" :id="'org-offline-' + row.deviceId" class="org-device-sub org-offline" data-notice="offline">
              {{ t('settings.cloud.org.offline-note') }}
            </span>
            <span v-if="rowError(row.deviceId)" class="org-device-sub org-row-error" data-notice="error" role="alert">
              {{ t('settings.cloud.org.act-failed', { reason: error }) }}
            </span>
          </span>
          <span class="org-badge" :class="stateTone(row)" :data-state="row.trustState">{{ stateLabel(row) }}</span>
          <button
            v-if="row.trustState === 'trusted'"
            type="button"
            class="org-btn ghost"
            data-action="unpair"
            :disabled="!!pending"
            @click="unpair(row)"
          >
            {{ t('settings.cloud.org.unpair') }}
          </button>
          <button
            v-else
            type="button"
            class="org-btn"
            :class="{ ghost: offlineHint(row) }"
            :aria-describedby="offlineHint(row) ? 'org-offline-' + row.deviceId : undefined"
            data-action="pair"
            :disabled="!!pending || !row.canTrust || !!pairingFor(row.deviceId)"
            :title="!row.listed ? repairHint(row) : !row.online ? t('settings.cloud.org.offline-title') : undefined"
            @click="pair(row)"
          >
            {{ t('settings.cloud.org.pair') }}
          </button>
          <div v-if="pairingFor(row.deviceId)" class="org-pairing" data-pairing>
            <template v-if="pairingFor(row.deviceId)!.code">
              <p class="org-label">{{ t('settings.p2p.pair.code-label') }}</p>
              <p class="org-code">{{ pairingFor(row.deviceId)!.code }}</p>
              <p class="org-label">{{ t('settings.p2p.pair.fingerprint-label') }}</p>
              <p class="org-fp"><code>{{ grouped(pairingFor(row.deviceId)!.fingerprint) }}</code></p>
              <p class="org-device-sub">
                {{ t('settings.p2p.pair.compare', { device: row.deviceName || row.deviceId }) }}
              </p>
              <div v-if="pairingFor(row.deviceId)!.state !== 'awaiting-remote'" class="org-acts">
                <button type="button" class="org-btn" data-action="match" :disabled="!!pending" @click="answer(pairingFor(row.deviceId)!, true)">
                  {{ t('settings.p2p.pair.match') }}
                </button>
                <button type="button" class="org-btn ghost danger" data-action="mismatch" :disabled="!!pending" @click="answer(pairingFor(row.deviceId)!, false)">
                  {{ t('settings.p2p.pair.mismatch') }}
                </button>
              </div>
              <p v-else class="org-device-sub">{{ t('settings.p2p.pair.waiting-remote') }}</p>
            </template>
            <template v-else>
              <p class="org-device-sub">{{ t('settings.p2p.pair.waiting-response') }}</p>
              <div class="org-acts">
                <button type="button" class="org-btn ghost" data-action="cancel" :disabled="!!pending" @click="answer(pairingFor(row.deviceId)!, false)">
                  {{ t('settings.p2p.pair.cancel-request') }}
                </button>
              </div>
            </template>
          </div>
        </li>
      </ul>
    </SettingsCard>

    <SettingsCard v-for="grant in revokedGrants" :key="'gone:' + grant.grantId" class="org-card" :data-revoked-grant-id="grant.grantId">
      <div class="org-card-head">
        <span class="org-avatar muted" aria-hidden="true">{{ initial(grant.peerOrg.name) }}</span>
        <span class="org-name" v-truncate>
          {{ grant.sameOrg ? t('settings.cloud.org.same-org-title', { org: grant.peerOrg.name }) : grant.peerOrg.name }}
        </span>
        <span class="org-badge danger">{{ reasonLabel(grant.revoked?.reason) }}</span>
      </div>
      <div class="org-revoked" data-notice="revoked">
        <p class="org-revoked-title">
          {{ reasonLabel(grant.revoked?.reason) }}
          <span v-if="grant.revoked?.at" class="org-revoked-when">{{ t('settings.cloud.org.revoked-since', { when: when(grant.revoked.at) }) }}</span>
        </p>
        <p class="org-device-sub">{{ t('settings.cloud.org.revoked-body') }}</p>
      </div>
      <ul class="org-list">
        <li v-for="row in grant.peers" :key="row.deviceId" class="org-row" :data-device-id="row.deviceId">
          <span class="org-dot" aria-hidden="true"></span>
          <span class="org-device">
            <span class="org-device-name" v-truncate>{{ row.deviceName || row.deviceId }}</span>
            <span class="org-device-sub">{{ [row.ownerName ? t('settings.cloud.org.owner', { name: row.ownerName }) : '', row.pairedAt ? t('settings.cloud.org.paired-on', { when: when(row.pairedAt) }) : ''].filter(Boolean).join(' · ') }}</span>
          </span>
          <span class="org-badge" data-state="revoked">{{ t('settings.cloud.org.state-ended') }}</span>
          <button type="button" class="org-btn" data-action="pair" disabled :title="t('settings.cloud.org.repair-hint')">
            {{ t('settings.cloud.org.pair') }}
          </button>
        </li>
      </ul>
    </SettingsCard>

    <p v-if="grants.length || revokedGrants.length" class="org-note">{{ t('settings.cloud.org.footer') }}</p>
  </SettingsSection>
</template>

<style scoped>
.org-head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 8px;
}
.org-head > .org-hint {
  flex: 1 1 320px;
}
.org-empty {
  margin-bottom: 10px;
}
.org-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.org-hint,
.org-note {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0 0 8px;
}
.org-note.danger {
  color: var(--danger-fg, var(--text-secondary));
}
.org-manage {
  font: inherit;
  font-size: var(--font-sm);
  white-space: nowrap;
  background: none;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 4px 10px;
  cursor: pointer;
}
.org-card {
  margin-bottom: 10px;
}
.org-card-hint {
  padding: 6px var(--space-row-x) 0;
}
.org-card-head > .org-badge {
  grid-column: 3;
  justify-self: end;
}
.org-card-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: var(--space-row-y) var(--space-row-x);
  border-bottom: 1px solid var(--border-muted);
}
.org-avatar {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  background: var(--accent-emphasis, var(--border-muted));
  color: var(--text-bright);
}
.org-avatar.muted {
  background: var(--border-muted);
}
.org-name {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.org-sub,
.org-device-sub {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.org-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.org-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: 10px;
  align-items: center;
  padding: var(--space-row-y) var(--space-row-x);
}
.org-row + .org-row {
  border-top: 1px solid var(--border-muted);
}
.org-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-secondary);
  opacity: 0.6;
}
.org-dot.on {
  background: var(--success-fg, #3fb950);
  opacity: 1;
}
.org-device {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.org-device-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.org-badge {
  font-size: var(--font-row-desc);
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  color: var(--text-secondary);
  white-space: nowrap;
}
.org-badge.ok {
  color: var(--success-fg, #3fb950);
  border-color: currentColor;
}
.org-offline {
  color: var(--attention-fg, var(--warning-fg, #d29922));
}
.org-row-error {
  color: var(--danger-fg, #f85149);
}
.org-badge.accent {
  color: var(--accent-fg, var(--text-primary));
  border-color: currentColor;
}
.org-badge.warn {
  color: var(--warning-fg, #d29922);
  border-color: currentColor;
}
.org-badge.danger {
  color: var(--danger-fg, #f85149);
  border-color: currentColor;
}
.org-btn {
  font: inherit;
  font-size: var(--font-sm);
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--accent-emphasis, var(--border-muted));
  background: var(--accent-emphasis, transparent);
  color: var(--text-bright);
  cursor: pointer;
  white-space: nowrap;
}
.org-btn.ghost {
  background: none;
  border-color: var(--border-muted);
  color: var(--text-primary);
}
.org-btn.danger {
  color: var(--danger-fg, #f85149);
}
.org-btn:not(:disabled):hover,
.org-manage:hover {
  filter: brightness(1.12);
}
.org-btn.ghost:not(:disabled):hover,
.org-manage:hover {
  border-color: var(--border-strong, var(--border-default));
  background: var(--bg-muted, transparent);
}
.org-btn:focus-visible,
.org-manage:focus-visible {
  outline: 2px solid var(--accent-fg);
  outline-offset: 1px;
}
.org-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.org-pairing {
  grid-column: 2 / -1;
  padding: 8px 0 4px;
}
.org-label {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 4px 0 0;
}
.org-code {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.15em;
  margin: 2px 0;
}
.org-fp {
  margin: 2px 0 6px;
}
.org-acts {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.org-revoked {
  margin: 8px var(--space-row-x);
  padding: 8px 10px;
  border: 1px solid var(--danger-fg, #f85149);
  border-radius: 6px;
}
.org-revoked-title {
  font-weight: 600;
  color: var(--danger-fg, #f85149);
  margin: 0 0 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: baseline;
}
.org-revoked-when {
  font-weight: 400;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
</style>
