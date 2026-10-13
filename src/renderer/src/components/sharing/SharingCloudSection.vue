<script setup lang="ts">
/**
 * What this machine holds, what the account holds, and which device wrote the
 * cloud copy — read-only until somebody ticks rows and names a direction.
 *
 * Three things this surface must not do, each of which it has been asked for
 * in exactly one way:
 *
 *  - Say "no data". An empty list has five different causes (no link, no key,
 *    a scope whose sync is off, a scope this build does not know, and a
 *    genuinely empty one) and they call for five different answers.
 *  - Colour-code alone. Every state carries its own word and its own mark.
 *  - Fold an unreadable cloud record into `diverged`. A record written under
 *    another device's key can never be reconciled by pushing or pulling, so it
 *    is labelled for what it is and offers no button that would pretend
 *    otherwise.
 *
 * When the link is down the backend deliberately omits the local half as well
 * (building the adapters means building the link), so this section says so and
 * sends the reader to the bundle above, which works offline in full.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import {
  CLOUD_SCOPES,
  deviceLabel,
  displayState,
  isActionable,
  readSyncInventory,
  rowKey,
  scopeNotice,
  type DisplayState,
  type SyncInventoryView,
  type SyncRow,
} from '../../lib/sharing'

type Backend = ReturnType<typeof useBackend>

const props = defineProps<{ backend: Backend }>()
const emit = defineEmits<{ (e: 'go-to-bundle'): void }>()
const { t } = useI18n()

const view = ref<SyncInventoryView | null>(null)
const loading = ref(false)
const busy = ref('')
const error = ref('')
const moved = ref<Array<{ scope: string; itemId: string; result: string }>>([])
const picked = ref<Set<string>>(new Set())

/** One mark per state, so the badge reads the same with colour switched off. */
const STATE_MARKS: Record<DisplayState, string> = {
  'in-sync': '=',
  'local-only': '↑',
  'remote-only': '↓',
  diverged: '≠',
  conflict: '!',
  unreadable: '🔒',
}

const connected = computed(() => view.value?.status === 'ok')
const devices = computed(() => view.value?.devices ?? [])

function scopeView(scope: string) {
  return (
    view.value?.scopes[scope] ?? { scope, status: 'not-connected' as const, error: '', items: [] }
  )
}

function noticeFor(scope: string): string {
  const enabled = Boolean(view.value?.scopeEnabled[scope])
  return scopeNotice(scopeView(scope), enabled) ?? ''
}

function rowsFor(scope: string): SyncRow[] {
  return scopeView(scope).items
}

function shownState(row: SyncRow): DisplayState {
  return displayState(row)
}

function deviceFor(row: SyncRow): string {
  if (!row.deviceId) return ''
  const known = devices.value.find((d) => d.deviceId === row.deviceId)
  return deviceLabel(row.deviceId, known?.deviceName ?? '')
}

/** What deviceFor() would say without cutting the id short, for its hover. */
function deviceFullFor(row: SyncRow): string | undefined {
  if (!row.deviceId) return undefined
  const known = devices.value.find((d) => d.deviceId === row.deviceId)
  return known?.deviceName?.trim() || row.deviceId
}

function isPicked(scope: string, itemId: string): boolean {
  return picked.value.has(rowKey(scope, itemId))
}

function togglePick(scope: string, itemId: string, on: boolean): void {
  const next = new Set(picked.value)
  if (on) next.add(rowKey(scope, itemId))
  else next.delete(rowKey(scope, itemId))
  picked.value = next
}

function pickedIds(scope: string): string[] {
  return rowsFor(scope)
    .filter((row) => isActionable(row) && picked.value.has(rowKey(scope, row.itemId)))
    .map((row) => row.itemId)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const resp = await props.backend.send('sync.inventory', {})
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sharing.cloud.error-load')
      view.value = null
      return
    }
    view.value = readSyncInventory(resp.payload)
    const live = new Set<string>()
    for (const scope of CLOUD_SCOPES) {
      for (const row of rowsFor(scope)) live.add(rowKey(scope, row.itemId))
    }
    picked.value = new Set([...picked.value].filter((key) => live.has(key)))
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    view.value = null
  } finally {
    loading.value = false
  }
}

async function move(scope: string, direction: 'push' | 'pull'): Promise<void> {
  const itemIds = pickedIds(scope)
  if (itemIds.length === 0) return
  busy.value = `${scope}:${direction}`
  error.value = ''
  moved.value = []
  try {
    const resp = await props.backend.send<{ results?: unknown }>(
      direction === 'push' ? 'sync.push_items' : 'sync.pull_items',
      { scope, itemIds },
    )
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sharing.cloud.error-move')
      return
    }
    const rows = Array.isArray(resp.payload?.results) ? resp.payload.results : []
    moved.value = rows
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map((row) => ({
        scope,
        itemId: String(row.itemId ?? ''),
        result: String(row.result ?? ''),
      }))
      .filter((row) => row.itemId !== '')
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<template>
  <section class="sc-section" data-settings-section="sharing-cloud">
    <header class="sc-head">
      <h2 class="sc-title">{{ t('settings.sharing.cloud.title') }}</h2>
      <button type="button" class="sh-btn" :disabled="loading || !!busy" @click="load">
        {{ t('action.refresh') }}
      </button>
    </header>
    <p class="sc-hint">{{ t('settings.sharing.cloud.intro') }}</p>

    <!-- Not connected: the backend leaves out the local half too, so there is
         nothing worth drawing a table for. Point at the surface that works. -->
    <div v-if="view && !connected" class="sc-state" data-testid="cloud-offline">
      <p class="sc-state-text">{{ t('settings.sharing.cloud.notice-' + view.status) }}</p>
      <p class="sc-state-text">{{ t('settings.sharing.cloud.offline-pointer') }}</p>
      <button type="button" class="sh-btn" @click="emit('go-to-bundle')">
        {{ t('settings.sharing.cloud.go-to-bundle') }}
      </button>
    </div>

    <template v-else-if="view">
      <div v-for="scope in CLOUD_SCOPES" :key="scope" class="sc-scope">
        <div class="sc-scope-head">
          <span class="sc-scope-name">{{ t('settings.sync.scope-' + scope) }}</span>
          <span v-if="!view.scopeEnabled[scope]" class="sc-off-tag">
            {{ t('settings.sharing.cloud.sync-off') }}
          </span>
        </div>

        <p v-if="noticeFor(scope)" class="sc-notice" :data-notice="noticeFor(scope)">
          {{ t('settings.sharing.cloud.notice-' + noticeFor(scope)) }}
          <span v-if="noticeFor(scope) === 'error' && scopeView(scope).error" class="sc-notice-detail">
            {{ scopeView(scope).error }}
          </span>
        </p>

        <div v-if="rowsFor(scope).length" class="sc-table" role="table">
          <div class="sc-row sc-row--head" role="row">
            <span class="sc-cell sc-cell--check" role="columnheader"></span>
            <span class="sc-cell" v-truncate role="columnheader">{{ t('settings.sharing.cloud.col-item') }}</span>
            <span class="sc-cell" v-truncate role="columnheader">{{ t('settings.sharing.cloud.col-local') }}</span>
            <span class="sc-cell" v-truncate role="columnheader">{{ t('settings.sharing.cloud.col-remote') }}</span>
            <span class="sc-cell" v-truncate role="columnheader">{{ t('settings.sharing.cloud.col-device') }}</span>
            <span class="sc-cell" v-truncate role="columnheader">{{ t('settings.sharing.cloud.col-state') }}</span>
          </div>
          <div v-for="row in rowsFor(scope)" :key="row.itemId" class="sc-row" role="row">
            <span class="sc-cell sc-cell--check" role="cell">
              <input
                type="checkbox"
                :checked="isPicked(scope, row.itemId)"
                :disabled="!isActionable(row)"
                :aria-label="row.itemId"
                @change="togglePick(scope, row.itemId, ($event.target as HTMLInputElement).checked)"
              />
            </span>
            <span class="sc-cell sc-cell--item" v-truncate role="cell">{{ row.itemId }}</span>
            <span class="sc-cell" v-truncate role="cell">
              {{ row.localPresent ? t('settings.sharing.cloud.here') : t('settings.sharing.cloud.absent') }}
            </span>
            <span class="sc-cell" v-truncate role="cell">
              {{ row.remotePresent ? t('settings.sharing.cloud.here') : t('settings.sharing.cloud.absent') }}
            </span>
            <span class="sc-cell sc-cell--device" v-truncate="deviceFullFor(row)" role="cell">
              {{ deviceFor(row) || t('settings.sharing.cloud.no-device') }}
            </span>
            <span class="sc-cell" v-truncate role="cell">
              <!-- Mark + word together: the colour is the third signal, never
                   the only one. -->
              <span class="sc-badge" :class="'sc-badge--' + shownState(row)">
                <span class="sc-badge-mark" aria-hidden="true">{{ STATE_MARKS[shownState(row)] }}</span>
                {{ t('settings.sharing.cloud.state-' + shownState(row)) }}
              </span>
            </span>
          </div>
        </div>

        <p
          v-if="rowsFor(scope).some((r) => shownState(r) === 'unreadable')"
          class="sc-notice"
        >
          {{ t('settings.sharing.cloud.unreadable-hint') }}
        </p>

        <div v-if="rowsFor(scope).length" class="sc-actions">
          <button
            type="button"
            class="sh-btn"
            :disabled="!!busy || pickedIds(scope).length === 0"
            @click="move(scope, 'push')"
          >
            {{ t('settings.sharing.cloud.push-selected', { count: pickedIds(scope).length }) }}
          </button>
          <button
            type="button"
            class="sh-btn"
            :disabled="!!busy || pickedIds(scope).length === 0"
            @click="move(scope, 'pull')"
          >
            {{ t('settings.sharing.cloud.pull-selected', { count: pickedIds(scope).length }) }}
          </button>
        </div>
      </div>

      <!-- Devices, named by id until the server starts naming them. -->
      <div class="sc-devices">
        <h3 class="sc-sub">{{ t('settings.sharing.cloud.devices-title') }}</h3>
        <p class="sc-hint">{{ t('settings.sharing.cloud.devices-hint') }}</p>
        <p v-if="!devices.length" class="sc-notice">{{ t('settings.sharing.cloud.no-devices') }}</p>
        <ul v-else class="sc-device-list">
          <li v-for="device in devices" :key="device.deviceId" class="sc-device">
            <span class="sc-device-name" v-truncate="device.deviceName?.trim() || device.deviceId">{{ deviceLabel(device.deviceId, device.deviceName) }}</span>
            <span class="sc-device-when">
              {{ t('settings.sharing.cloud.last-write', { when: device.lastWriteAt || '—' }) }}
            </span>
            <span class="sc-device-when">
              {{ t('settings.sharing.cloud.last-seen', { when: device.lastSeenAt || '—' }) }}
            </span>
          </li>
        </ul>
      </div>
    </template>

    <p v-if="moved.length" class="sc-notice">
      {{ t('settings.sharing.cloud.moved-title') }}
      <span v-for="row in moved" :key="row.scope + '/' + row.itemId" class="sc-moved">
        {{ row.itemId }} — {{ t('settings.sharing.cloud.result-' + row.result) }}
      </span>
    </p>
    <p v-if="error" class="err-msg">{{ error }}</p>
  </section>
</template>

<style scoped>
.sc-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.sc-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.sc-title,
.sc-sub {
  font-size: var(--font-row-title);
  font-weight: 600;
  margin: 0;
}
.sc-hint {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0;
}
.sc-state {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-inset);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  min-width: 0;
}
.sc-state-text {
  margin: 0;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.sc-scope {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.sc-scope-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--font-row-desc);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.sc-off-tag {
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
  font-size: var(--font-2xs);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 0 6px;
}
.sc-notice {
  margin: 0;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.sc-notice-detail {
  color: var(--text-danger, #e07060);
}
.sc-table {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sc-row {
  display: grid;
  /* minmax(0, …) on the flexible tracks: this card has no border-box, and a
     percentage width here is what bursts the column instead of wrapping. */
  grid-template-columns: auto minmax(0, 1fr) 5em 5em minmax(0, 8em) auto;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  min-width: 0;
}
.sc-row + .sc-row {
  border-top: 1px solid var(--border-muted);
}
.sc-row--head {
  font-size: var(--font-2xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-muted);
}
.sc-cell {
  min-width: 0;
  font-size: var(--font-row-desc);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-cell--check {
  display: flex;
  align-items: center;
}
.sc-cell--item {
  font-size: var(--font-row-title);
}
.sc-cell--device {
  font-family: ui-monospace, Menlo, monospace;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.sc-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 0 6px;
  font-size: var(--font-2xs);
  white-space: nowrap;
}
.sc-badge-mark {
  font-family: ui-monospace, Menlo, monospace;
}
.sc-badge--in-sync {
  border-color: var(--border-success, #3f8f5c);
  color: var(--text-success, #5fbd80);
}
.sc-badge--local-only,
.sc-badge--remote-only {
  border-color: var(--border-default);
  color: var(--text-secondary);
}
.sc-badge--diverged {
  border-color: var(--border-warning, #b58a2b);
  color: var(--text-warning, #d8a63d);
}
.sc-badge--conflict,
.sc-badge--unreadable {
  border-color: var(--border-danger, #a8533f);
  color: var(--text-danger, #e07060);
}
.sc-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.sc-devices {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-inset);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.sc-device-list {
  list-style: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.sc-device {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 3px 0;
  font-size: var(--font-row-desc);
  min-width: 0;
}
.sc-device-name {
  font-family: ui-monospace, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sc-device-when {
  color: var(--text-secondary);
  flex: none;
}
.sc-moved {
  display: block;
  color: var(--text-secondary);
}
.sh-btn {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-primary);
  border-radius: var(--radius-control);
  padding: 4px 10px;
  font-size: var(--font-row-desc);
  cursor: pointer;
}
.sh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.err-msg {
  color: var(--text-danger, #e07060);
  font-size: var(--font-row-desc);
  margin: 0;
}
</style>
