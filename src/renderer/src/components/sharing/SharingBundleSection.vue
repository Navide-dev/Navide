<script setup lang="ts">
/**
 * Packing the four INTEGRATIONS scopes into a file, and unpacking one.
 *
 * Works with no account and no link — that is the point of it, and the cloud
 * section below points here when there is no connection.
 *
 * The import is deliberately two-step. `share.import_preview` writes nothing,
 * so the list of "this would be created / this would overwrite / this cannot
 * be taken and here is why" is shown first and every row starts unticked.
 * Overwriting somebody's prompt because they opened a file is the one failure
 * this surface exists to prevent, so there is no single-click import path at
 * all, not even for a bundle whose rows are all creates.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import { formatBytes } from '../../lib/formatBytes'
import SyncRecordSummary from '../SyncRecordSummary.vue'
import { visible } from '../../lib/syncVisible'
import {
  SHARE_SCOPES,
  bundleItemCount,
  readApplyRows,
  readPreviewRows,
  readShareInventory,
  redactedFields,
  redactedKeys,
  rowKey,
  type ImportPreviewRow,
  type ImportResultRow,
  type ShareItem,
  type ShareScope,
} from '../../lib/sharing'

type Backend = ReturnType<typeof useBackend>

const props = defineProps<{ backend: Backend }>()
const { t } = useI18n()

const items = ref<Record<ShareScope, ShareItem[]>>({
  prompts: [],
  mcp: [],
  skills: [],
  memory: [],
})
const picked = ref<Set<string>>(new Set())
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')

const bundleName = ref('')
const bundleDescription = ref('')

/** The document being imported, held only between preview and apply. */
const incoming = ref<Record<string, unknown> | null>(null)
const previewRows = ref<ImportPreviewRow[]>([])

/** What an MCP overwrite would replace here: url, command and args (JSON). */
function localLine(local: Record<string, unknown>): string {
  return ['url', 'command', 'args']
    .filter((key) => local[key] !== undefined)
    .map((key) => key + ' ' + visible(typeof local[key] === 'string' ? local[key] : JSON.stringify(local[key])))
    .join(' · ')
}
const previewPicked = ref<Set<string>>(new Set())
const resultRows = ref<ImportResultRow[]>([])
const stripped = ref<Set<string>>(new Set())

const eligibleCount = computed(() =>
  SHARE_SCOPES.reduce(
    (n, scope) => n + items.value[scope].filter((i) => i.eligible && !i.mayLeakInArgsOrUrl).length,
    0,
  ),
)
const pickedCount = computed(() => picked.value.size)
const importable = computed(() => previewRows.value.filter((row) => row.action !== 'skip'))

function keyOf(scope: string, id: string): string {
  return rowKey(scope, id)
}

function isPicked(scope: string, id: string): boolean {
  return picked.value.has(keyOf(scope, id))
}

function togglePick(scope: string, id: string, on: boolean): void {
  const next = new Set(picked.value)
  if (on) next.add(keyOf(scope, id))
  else next.delete(keyOf(scope, id))
  picked.value = next
}

function pickAll(on: boolean): void {
  if (!on) {
    picked.value = new Set()
    return
  }
  const next = new Set<string>()
  for (const scope of SHARE_SCOPES) {
    for (const item of items.value[scope]) {
      // Never swept in: an item whose args/url may carry a token goes out
      // unstripped, so it is only packed when ticked by hand.
      if (item.eligible && !item.mayLeakInArgsOrUrl) next.add(keyOf(scope, item.id))
    }
  }
  picked.value = next
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const resp = await props.backend.send('share.inventory', {})
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sharing.bundle.error-load')
      return
    }
    items.value = readShareInventory(resp.payload)
    // Drop ticks for items that are no longer there, so a stale selection
    // cannot make the export ask for something the backend will refuse.
    const live = new Set<string>()
    for (const scope of SHARE_SCOPES) {
      for (const item of items.value[scope]) live.add(keyOf(scope, item.id))
    }
    picked.value = new Set([...picked.value].filter((key) => live.has(key)))
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function selectionPayload(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const scope of SHARE_SCOPES) {
    const ids = items.value[scope]
      .filter((item) => item.eligible && picked.value.has(keyOf(scope, item.id)))
      .map((item) => item.id)
    if (ids.length) out[scope] = ids
  }
  return out
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

async function exportBundle(): Promise<void> {
  const selection = selectionPayload()
  if (Object.keys(selection).length === 0) {
    error.value = t('settings.sharing.bundle.export-empty')
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const resp = await props.backend.send<{ bundle?: unknown }>('share.export', {
      selection,
      name: bundleName.value,
      description: bundleDescription.value,
    })
    if (!resp.ok || !resp.payload?.bundle) {
      error.value = resp.error?.message ?? t('settings.sharing.bundle.error-export')
      return
    }
    const saved = await window.agentTeam?.saveJson?.({
      title: t('settings.sharing.bundle.dialog-export'),
      defaultName: `${bundleName.value.trim() || 'navide-settings'}-${stamp()}.navidebundle`,
      content: JSON.stringify(resp.payload.bundle, null, 2),
    })
    if (saved?.ok) notice.value = t('settings.sharing.bundle.exported', { path: saved.path ?? '' })
    else if (saved && !saved.canceled) error.value = saved.error ?? t('settings.sharing.bundle.error-export')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function chooseBundleFile(): Promise<string | null> {
  const chosen = await window.agentTeam?.pickFile?.({
    title: t('settings.sharing.bundle.dialog-import'),
    filters: [
      { name: t('settings.sharing.bundle.file-kind'), extensions: ['navidebundle', 'json'] },
      { name: t('settings.sharing.bundle.file-any'), extensions: ['*'] },
    ],
  })
  if (!chosen?.ok || !chosen.path) return null
  const read = await window.agentTeam?.readFileFrom?.(chosen.path, 0)
  if (!read?.ok) {
    error.value = read?.error ?? t('settings.sharing.bundle.error-read-file')
    return null
  }
  return read.content
}

async function startImport(): Promise<void> {
  busy.value = true
  error.value = ''
  notice.value = ''
  resultRows.value = []
  try {
    const raw = await chooseBundleFile()
    if (raw === null) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      error.value = t('settings.sharing.bundle.error-not-a-bundle')
      return
    }
    const resp = await props.backend.send('share.import_preview', { bundle: parsed })
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sharing.bundle.error-preview')
      return
    }
    incoming.value = parsed as Record<string, unknown>
    previewRows.value = readPreviewRows(resp.payload)
    stripped.value = redactedKeys(parsed)
    // Nothing is pre-ticked: the preview is a decision, not a confirmation.
    previewPicked.value = new Set()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function isPreviewPicked(row: ImportPreviewRow): boolean {
  return previewPicked.value.has(keyOf(row.scope, row.id))
}

function togglePreview(row: ImportPreviewRow, on: boolean): void {
  if (row.action === 'skip') return
  const next = new Set(previewPicked.value)
  if (on) next.add(keyOf(row.scope, row.id))
  else next.delete(keyOf(row.scope, row.id))
  previewPicked.value = next
}

function pickAllPreview(on: boolean): void {
  previewPicked.value = on
    ? new Set(importable.value.map((row) => keyOf(row.scope, row.id)))
    : new Set()
}

function cancelImport(): void {
  incoming.value = null
  previewRows.value = []
  previewPicked.value = new Set()
  stripped.value = new Set()
}

async function applyImport(): Promise<void> {
  if (!incoming.value || previewPicked.value.size === 0) return
  const selection: Record<string, string[]> = {}
  for (const row of importable.value) {
    if (!previewPicked.value.has(keyOf(row.scope, row.id))) continue
    ;(selection[row.scope] ??= []).push(row.id)
  }
  busy.value = true
  error.value = ''
  try {
    const resp = await props.backend.send('share.import_apply', {
      bundle: incoming.value,
      selection,
    })
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('settings.sharing.bundle.error-apply')
      return
    }
    resultRows.value = readApplyRows(resp.payload)
    const applied = resultRows.value.filter((row) => row.ok && row.action !== 'skip').length
    notice.value = t('settings.sharing.bundle.applied', {
      count: applied,
      total: resultRows.value.length,
    })
    resultStripped.value = new Set(stripped.value)
    cancelImport()
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function needsCredentials(row: { scope: string; id: string }): boolean {
  return stripped.value.has(keyOf(row.scope, row.id))
}

function missingFields(row: { scope: string; id: string }): string {
  return redactedFields(incoming.value, row.scope, row.id).join(', ')
}

/** The redaction list belongs to the bundle, which is cleared once applied —
 *  so the result rows keep their own copy of the answer. */
const resultStripped = ref<Set<string>>(new Set())

function resultNeedsCredentials(row: ImportResultRow): boolean {
  return resultStripped.value.has(keyOf(row.scope, row.id))
}

onMounted(load)
</script>

<template>
  <section class="sh-section" data-settings-section="sharing-bundle">
    <header class="sh-head">
      <h2 class="sh-title">{{ t('settings.sharing.bundle.title') }}</h2>
      <button type="button" class="sh-btn" :disabled="loading || busy" @click="load">
        {{ t('action.refresh') }}
      </button>
    </header>
    <p class="sh-hint">{{ t('settings.sharing.bundle.intro') }}</p>

    <div class="sh-toolbar">
      <span class="sh-count">
        {{ t('settings.sharing.bundle.selected', { count: pickedCount, total: eligibleCount }) }}
      </span>
      <button type="button" class="sh-btn" :disabled="!eligibleCount" @click="pickAll(true)">
        {{ t('settings.sharing.bundle.select-all') }}
      </button>
      <button type="button" class="sh-btn" :disabled="!pickedCount" @click="pickAll(false)">
        {{ t('settings.sharing.bundle.select-none') }}
      </button>
    </div>

    <div v-for="scope in SHARE_SCOPES" :key="scope" class="sh-scope">
      <div class="sh-scope-head">{{ t('settings.sync.scope-' + scope) }}</div>
      <p v-if="!items[scope].length" class="sh-empty">
        {{ t('settings.sharing.bundle.scope-empty') }}
      </p>
      <ul v-else class="sh-list">
        <li
          v-for="item in items[scope]"
          :key="item.id"
          class="sh-item"
          :class="{ 'sh-item--blocked': !item.eligible }"
        >
          <input
            :id="'sh-' + scope + '-' + item.id"
            type="checkbox"
            class="sh-check"
            :checked="isPicked(scope, item.id)"
            :disabled="!item.eligible"
            @change="togglePick(scope, item.id, ($event.target as HTMLInputElement).checked)"
          />
          <label class="sh-item-body" :for="'sh-' + scope + '-' + item.id">
            <span class="sh-item-line">
              <span class="sh-item-label" v-truncate>{{ item.label }}</span>
              <span class="sh-item-size">{{ formatBytes(item.size) }}</span>
              <span v-if="item.hasSecrets" class="sh-tag sh-tag--secret">
                {{ t('settings.sharing.bundle.has-secrets') }}
              </span>
              <span v-if="item.mayLeakInArgsOrUrl" class="sh-tag sh-tag--leak">
                {{ t('settings.sharing.bundle.may-leak') }}
              </span>
              <span v-if="!item.eligible" class="sh-tag sh-tag--blocked">
                {{ t('settings.sharing.bundle.not-eligible') }}
              </span>
            </span>
            <span v-if="!item.eligible && item.reason" class="sh-item-reason">{{ item.reason }}</span>
            <span v-else-if="item.hasSecrets" class="sh-item-reason">
              {{ t('settings.sharing.bundle.secrets-hint') }}
            </span>
            <!-- Not neutral: this one is NOT stripped and goes out as it is. -->
            <span v-if="item.eligible && item.mayLeakInArgsOrUrl" class="sh-item-warn">
              {{ t('settings.sharing.bundle.may-leak-hint') }}
            </span>
          </label>
        </li>
      </ul>
    </div>

    <div class="sh-fields">
      <label class="sh-field">
        <span class="sh-field-label">{{ t('settings.sharing.bundle.name-label') }}</span>
        <input v-model="bundleName" type="text" :placeholder="t('settings.sharing.bundle.name-placeholder')" />
      </label>
      <label class="sh-field">
        <span class="sh-field-label">{{ t('settings.sharing.bundle.description-label') }}</span>
        <input
          v-model="bundleDescription"
          type="text"
          :placeholder="t('settings.sharing.bundle.description-placeholder')"
        />
      </label>
    </div>

    <div class="sh-actions">
      <button type="button" class="sh-btn sh-btn--primary" :disabled="busy" @click="exportBundle">
        {{ t('settings.sharing.bundle.export') }}
      </button>
      <button type="button" class="sh-btn" :disabled="busy" @click="startImport">
        {{ t('settings.sharing.bundle.import') }}
      </button>
    </div>

    <!-- ── Import preview: nothing has been written at this point ────────── -->
    <div v-if="incoming" class="sh-preview" data-settings-section="sharing-import-preview">
      <h3 class="sh-sub">{{ t('settings.sharing.bundle.preview-title') }}</h3>
      <p class="sh-hint">
        {{ t('settings.sharing.bundle.preview-intro', { count: bundleItemCount(incoming) }) }}
      </p>
      <div class="sh-toolbar">
        <button type="button" class="sh-btn" :disabled="!importable.length" @click="pickAllPreview(true)">
          {{ t('settings.sharing.bundle.select-all') }}
        </button>
        <button
          type="button"
          class="sh-btn"
          :disabled="!previewPicked.size"
          @click="pickAllPreview(false)"
        >
          {{ t('settings.sharing.bundle.select-none') }}
        </button>
      </div>
      <ul class="sh-list">
        <li
          v-for="row in previewRows"
          :key="row.scope + '/' + row.id"
          class="sh-item"
          :class="{ 'sh-item--blocked': row.action === 'skip' }"
        >
          <input
            :id="'shp-' + row.scope + '-' + row.id"
            type="checkbox"
            class="sh-check"
            :checked="isPreviewPicked(row)"
            :disabled="row.action === 'skip'"
            @change="togglePreview(row, ($event.target as HTMLInputElement).checked)"
          />
          <label class="sh-item-body" :for="'shp-' + row.scope + '-' + row.id">
            <span class="sh-item-line">
              <span class="sh-item-scope">{{ t('settings.sync.scope-' + row.scope) }}</span>
              <span class="sh-item-label" v-truncate>{{ row.id }}</span>
              <span class="sh-tag" :class="'sh-tag--' + row.action">
                {{ t('settings.sharing.bundle.action-' + row.action) }}
              </span>
              <span v-if="needsCredentials(row)" class="sh-tag sh-tag--secret">
                {{ t('settings.sharing.bundle.needs-credentials') }}
              </span>
            </span>
            <span v-if="row.reason" class="sh-item-reason">{{ row.reason }}</span>
            <span v-if="needsCredentials(row)" class="sh-item-reason">
              {{ t('settings.sharing.bundle.needs-credentials-hint', { fields: missingFields(row) }) }}
            </span>
            <!-- What this row would write, whole: the same view a sync
                 approval gives, so ticking it is a decision about it. -->
            <span v-if="row.local" class="sh-item-reason sh-item-local">
              {{ t('settings.sharing.bundle.replaces-here', { what: localLine(row.local) }) }}
            </span>
            <SyncRecordSummary v-if="row.summary" :summary="row.summary" />
          </label>
        </li>
      </ul>
      <div class="sh-actions">
        <button
          type="button"
          class="sh-btn sh-btn--primary"
          :disabled="busy || previewPicked.size === 0"
          @click="applyImport"
        >
          {{ t('settings.sharing.bundle.apply', { count: previewPicked.size }) }}
        </button>
        <button type="button" class="sh-btn" :disabled="busy" @click="cancelImport">
          {{ t('action.cancel') }}
        </button>
      </div>
    </div>

    <!-- ── What the apply actually left behind ───────────────────────────── -->
    <div v-if="resultRows.length" class="sh-results">
      <h3 class="sh-sub">{{ t('settings.sharing.bundle.results-title') }}</h3>
      <ul class="sh-list">
        <li v-for="row in resultRows" :key="'r-' + row.scope + '/' + row.id" class="sh-item">
          <span class="sh-result-mark" :class="row.ok ? 'sh-result-mark--ok' : 'sh-result-mark--bad'">
            {{ row.ok ? '✓' : '✕' }}
          </span>
          <span class="sh-item-body">
            <span class="sh-item-line">
              <span class="sh-item-scope">{{ t('settings.sync.scope-' + row.scope) }}</span>
              <span class="sh-item-label" v-truncate>{{ row.id }}</span>
              <span class="sh-tag" :class="'sh-tag--' + row.action">
                {{ t('settings.sharing.bundle.action-' + row.action) }}
              </span>
              <span v-if="resultNeedsCredentials(row)" class="sh-tag sh-tag--secret">
                {{ t('settings.sharing.bundle.needs-credentials') }}
              </span>
            </span>
            <span v-if="row.reason" class="sh-item-reason">{{ row.reason }}</span>
          </span>
        </li>
      </ul>
    </div>

    <p v-if="notice" class="sh-notice">{{ notice }}</p>
    <p v-if="error" class="err-msg">{{ error }}</p>
  </section>
</template>

<style scoped>
.sh-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.sh-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.sh-title {
  font-size: var(--font-row-title);
  font-weight: 600;
  margin: 0;
}
.sh-sub {
  font-size: var(--font-row-title);
  font-weight: 600;
  margin: 0 0 4px;
}
.sh-hint {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0;
}
.sh-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.sh-count {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.sh-scope {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  overflow: hidden;
  min-width: 0;
}
.sh-scope-head {
  padding: 6px 12px;
  font-size: var(--font-row-desc);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  background: var(--bg-inset);
  border-bottom: 1px solid var(--border-muted);
}
.sh-empty {
  margin: 0;
  padding: 8px 12px;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.sh-list {
  list-style: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.sh-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 12px;
  min-width: 0;
}
.sh-item + .sh-item {
  border-top: 1px solid var(--border-muted);
}
.sh-item--blocked {
  opacity: 0.68;
}
.sh-check {
  margin-top: 2px;
  flex: none;
}
.sh-item-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.sh-item-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.sh-item-label {
  font-size: var(--font-row-title);
  overflow: hidden;
  text-overflow: ellipsis;
}
.sh-item-scope {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.sh-item-size {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.sh-item-reason {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.sh-tag {
  flex: none;
  font-size: var(--font-2xs);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 0 6px;
  color: var(--text-secondary);
}
.sh-tag--secret {
  border-color: var(--border-warning, #b58a2b);
  color: var(--text-warning, #d8a63d);
}
.sh-tag--leak {
  border-color: var(--border-danger, #a8533f);
  color: var(--text-danger, #e07060);
  font-weight: 600;
}
.sh-item-warn {
  font-size: var(--font-row-desc);
  color: var(--text-danger, #e07060);
}
.sh-tag--overwrite {
  border-color: var(--border-warning, #b58a2b);
  color: var(--text-warning, #d8a63d);
}
.sh-tag--create {
  border-color: var(--border-success, #3f8f5c);
  color: var(--text-success, #5fbd80);
}
.sh-tag--blocked,
.sh-tag--skip {
  border-color: var(--border-muted);
}
.sh-fields {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.sh-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 200px;
  min-width: 0;
}
.sh-field-label {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
}
.sh-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
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
.sh-btn--primary {
  border-color: var(--border-accent, var(--border-default));
  color: var(--text-bright, var(--text-primary));
}
.sh-preview,
.sh-results {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-inset);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.sh-result-mark {
  flex: none;
  width: 1.2em;
  text-align: center;
}
.sh-result-mark--ok {
  color: var(--text-success, #5fbd80);
}
.sh-result-mark--bad {
  color: var(--text-danger, #e07060);
}
.sh-notice {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  margin: 0;
}
.err-msg {
  color: var(--text-danger, #e07060);
  font-size: var(--font-row-desc);
  margin: 0;
}
</style>
