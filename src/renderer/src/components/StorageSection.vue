<script setup lang="ts">
// The Resource Manager's Storage section: the collapsible block under the
// process table where disk usage is scanned and cleaned. It owns no state —
// the host creates the useStorageUsage instance so its Disk summary card can
// read the same report — and only decides how to draw it.
//
// Collapsed until the first scan starts: an unscanned section has nothing to
// show but the header, and expanding an empty body would just push the
// process table up for no reason.
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { STALE_DAY_OPTIONS, type StorageGroup, type StorageItem, type useStorageUsage } from '../composables/useStorageUsage'
import { formatBytes } from '../lib/formatBytes'

const props = defineProps<{
  storage: ReturnType<typeof useStorageUsage>
}>()

const { t, te } = useI18n()

const open = ref(false)
watch(
  () => props.storage.scanning.value && !props.storage.report.value,
  (firstScan) => {
    if (firstScan) open.value = true
  }
)
// The header's buttons work while the section is closed, so anything they
// produce — freed bytes, a failed pass, a scan error — opens it; otherwise a
// cleanup started from a closed section ends in silence.
watch(
  () => [
    props.storage.cleanupFreed.value,
    props.storage.cleanupError.value,
    props.storage.cleanupWarning.value,
    props.storage.scanError.value,
  ],
  ([freed, error, warning, scanError]) => {
    if (freed !== null || error || warning || scanError) open.value = true
  }
)

/** Item copy is keyed by backend id; unknown ids degrade to the raw id. */
function itemLabel(id: string): string {
  const key = `resource.storage.item.${id}.label`
  return te(key) ? t(key) : id
}
function itemDesc(id: string): string {
  const key = `resource.storage.item.${id}.desc`
  return te(key) ? t(key) : ''
}

function sortedItems(group: StorageGroup): StorageItem[] {
  return [...group.items].sort((a, b) => b.bytes - a.bytes)
}

function groupLabel(group: StorageGroup): string {
  return t(`resource.storage.group.${group.id}`)
}

/** Share of the scanned total per group, for the proportion bar. */
function groupShare(group: StorageGroup): string {
  const total = props.storage.report.value?.totalBytes ?? 0
  if (total <= 0) return '0%'
  return `${((group.totalBytes / total) * 100).toFixed(1)}%`
}
</script>

<template>
  <section class="su-section" data-part="storage" :data-open="open ? 'true' : 'false'">
    <div class="su-head">
      <button
        type="button"
        class="su-toggle"
        data-act="toggle-storage"
        :aria-expanded="open"
        @click="open = !open"
      >
        <span class="su-caret" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
        <span class="su-title">{{ t('resource.storage.title') }}</span>
      </button>
      <span class="su-sub" v-truncate data-part="storage-summary" :class="{ 'su-sub-error': !storage.scanning.value && storage.scanError.value }">
        {{ storage.scanning.value
          ? t('resource.storage.scanning')
          : storage.scanError.value
            ? t('resource.storage.scan-failed', { message: storage.scanError.value })
            : storage.report.value
              ? t('resource.storage.summary', {
                  used: formatBytes(storage.report.value.totalBytes),
                  safe: formatBytes(storage.safeCleanableBytes.value),
                })
              : t('resource.storage.unscanned') }}
      </span>
      <span class="su-spacer" />
      <label class="su-stale">
        <span>{{ t('resource.storage.stale-days') }}</span>
        <select
          class="su-stale-select"
          data-act="stale-days"
          :value="storage.staleDays.value"
          :disabled="storage.scanning.value || storage.cleaning.value"
          :title="t('resource.storage.stale-days-desc')"
          @change="storage.setStaleDays(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="d in STALE_DAY_OPTIONS" :key="d" :value="d">
            {{ t('resource.storage.stale-days-option', { days: d }) }}
          </option>
        </select>
      </label>
      <button
        type="button"
        class="su-btn su-clean-safe"
        data-act="clean-safe"
        :disabled="storage.cleaning.value || storage.scanning.value || !storage.safeCleanableItems.value.length"
        @click="storage.requestCleanSafe()"
      >
        {{ storage.cleaning.value ? t('resource.storage.cleaning') : t('resource.storage.clean-safe') }}
      </button>
      <button
        type="button"
        class="su-btn su-clean-selected"
        data-act="clean-selected"
        :disabled="storage.cleaning.value || storage.scanning.value || !storage.canCleanSelected.value"
        @click="storage.requestCleanSelected()"
      >
        {{ t('resource.storage.clean-selected') }}
      </button>
      <button
        type="button"
        class="su-btn su-rescan"
        data-act="rescan"
        :disabled="storage.scanning.value || storage.cleaning.value || !storage.connected.value"
        @click="void storage.scan()"
      >
        {{ storage.report.value ? t('resource.storage.rescan') : t('resource.storage.scan') }}
      </button>
    </div>

    <div v-if="open" class="su-body" data-part="storage-body">
      <p v-if="storage.scanError.value" class="su-error" role="alert">
        {{ t('resource.storage.scan-failed', { message: storage.scanError.value }) }}
      </p>
      <p v-if="storage.cleanupFreed.value !== null" class="su-result">
        {{ t('resource.storage.freed', { size: formatBytes(storage.cleanupFreed.value) }) }}
        <span v-if="storage.cleanupFailures.value.length" class="su-result-failed">
          {{ t('resource.storage.failed-items', { count: storage.cleanupFailures.value.length }) }}
        </span>
      </p>
      <ul v-if="storage.cleanupFailures.value.length" class="su-failures">
        <li v-for="f in storage.cleanupFailures.value" :key="f.itemId">
          {{ itemLabel(f.itemId) }} — {{ f.error }}
        </li>
      </ul>
      <p v-if="storage.cleanupWarning.value" class="su-cleanup-warning">{{ storage.cleanupWarning.value }}</p>
      <p v-if="storage.cleanupError.value" class="su-error" role="alert">{{ storage.cleanupError.value }}</p>

      <div v-if="storage.scanning.value && !storage.report.value" class="su-skeleton" aria-hidden="true">
        <div class="su-skeleton-row"></div>
        <div class="su-skeleton-row"></div>
        <div class="su-skeleton-row"></div>
      </div>

      <template v-if="storage.report.value">
        <div class="su-bar" data-part="storage-bar" aria-hidden="true">
          <span
            v-for="group in storage.report.value.groups"
            :key="group.id"
            class="su-bar-seg"
            :data-group="group.id"
            :style="{ width: groupShare(group) }"
          />
        </div>
        <div class="su-legend">
          <span v-for="group in storage.report.value.groups" :key="group.id" class="su-legend-item" :data-group="group.id">
            <i class="su-swatch" aria-hidden="true" />{{ groupLabel(group) }} {{ formatBytes(group.totalBytes) }}
          </span>
        </div>

        <div v-for="group in storage.report.value.groups" :key="group.id" class="su-group" :data-group="group.id">
          <div class="su-group-head">
            <span>{{ groupLabel(group) }}</span>
            <span class="su-group-size">{{ formatBytes(group.totalBytes) }}</span>
          </div>
          <div
            v-for="item in sortedItems(group)"
            :key="item.id"
            class="su-item"
            :class="{ 'su-item-locked': !item.cleanable, 'su-item-danger': item.risk === 'danger' }"
            :data-item-id="item.id"
          >
            <div class="su-item-main">
              <input
                v-if="item.cleanable"
                class="su-check"
                type="checkbox"
                :checked="storage.isSelected(item.id)"
                :disabled="storage.cleaning.value || storage.scanning.value"
                :aria-label="itemLabel(item.id)"
                @change="storage.toggleSelected(item.id)"
              />
              <span v-else class="su-check-spacer" aria-hidden="true"></span>
              <div class="su-item-text">
                <div class="su-item-title">
                  <span class="su-item-label">{{ itemLabel(item.id) }}</span>
                  <span class="su-risk" :class="`su-risk-${item.risk}`">
                    {{ t(`resource.storage.risk.${item.risk}`) }}
                  </span>
                  <span v-if="!item.cleanable" class="su-locked">
                    {{ t('resource.storage.not-cleanable') }}
                  </span>
                </div>
                <div v-if="itemDesc(item.id)" class="su-item-desc">{{ itemDesc(item.id) }}</div>
                <div v-if="item.note" class="su-item-note">{{ item.note }}</div>
              </div>
              <div class="su-item-meta">
                <span class="su-size">{{ formatBytes(item.bytes) }}</span>
                <span class="su-count">
                  {{ t('resource.storage.files', { count: item.fileCount }) }}
                </span>
              </div>
              <button
                v-if="item.paths.length"
                type="button"
                class="su-btn su-paths-toggle"
                @click="storage.toggleExpanded(item.id)"
              >
                {{
                  storage.isExpanded(item.id)
                    ? t('resource.storage.hide-paths')
                    : t('resource.storage.show-paths')
                }}
              </button>
            </div>
            <ul v-if="storage.isExpanded(item.id)" class="su-paths">
              <li v-for="p in item.paths" :key="p">{{ storage.collapseHome(p) }}</li>
            </ul>
          </div>
        </div>

        <div v-if="storage.report.value.errors.length" class="su-warnings">
          <div class="su-warnings-title">{{ t('resource.storage.errors-title') }}</div>
          <ul>
            <li v-for="e in storage.report.value.errors" :key="e.path">
              <span class="su-warn-path">{{ storage.collapseHome(e.path) }}</span>
              <span class="su-warn-msg">{{ e.message }}</span>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <div v-if="storage.pendingConfirm.value" class="su-confirm" role="dialog" aria-modal="true">
      <div class="su-confirm-card">
        <h3>{{ t('resource.storage.confirm-title') }}</h3>
        <p>{{ t('resource.storage.confirm-body', { size: formatBytes(storage.confirmBytes.value) }) }}</p>
        <p v-if="storage.confirmHasDanger.value" class="su-confirm-danger">
          {{ t('resource.storage.confirm-danger') }}
        </p>
        <ul class="su-confirm-list">
          <li v-for="item in storage.pendingConfirm.value" :key="item.id" :data-confirm-id="item.id">
            <span>{{ itemLabel(item.id) }}</span>
            <span class="su-size">{{ formatBytes(item.bytes) }}</span>
          </li>
        </ul>
        <div class="su-confirm-actions">
          <button type="button" class="su-btn su-confirm-cancel" @click="storage.cancelConfirm()">
            {{ t('resource.storage.confirm-cancel') }}
          </button>
          <button type="button" class="su-btn su-confirm-ok" @click="void storage.confirmCleanup()">
            {{ t('resource.storage.confirm-ok') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.su-section {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--border-muted);
  font-size: var(--font-2xs);
}
/* Open, the section takes what its content needs up to half the card and
 * scrolls past that, so a short report does not push the process table down
 * for nothing; closed, it is the one header line the old disk strip used to be. */
.su-section[data-open='true'] {
  flex: 0 1 auto;
  max-height: 50%;
}
.su-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  flex: none;
}
.su-spacer { flex: 1; }
.su-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-bright);
  font-size: var(--font-xs);
  font-weight: 600;
  cursor: pointer;
}
.su-caret {
  width: 10px;
  color: var(--text-muted);
  font-size: var(--font-3xs);
}
.su-sub {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.su-sub-error { color: var(--danger-fg); }
.su-stale {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}
.su-stale-select {
  background: var(--bg-muted);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  padding: 2px 6px;
  font-size: var(--font-2xs);
}
.su-btn {
  padding: 4px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  white-space: nowrap;
}
.su-btn:hover:not(:disabled) { color: var(--text-bright); border-color: var(--border-default); }
.su-btn:disabled { color: var(--text-disabled); cursor: default; }
.su-clean-safe:not(:disabled) {
  background: var(--accent-subtle);
  color: var(--accent-fg);
  border-color: transparent;
}
.su-clean-selected:not(:disabled) {
  border-color: var(--danger-muted);
  color: var(--danger-fg);
}

.su-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px 12px;
}
.su-error {
  margin: 4px 0 6px;
  color: var(--danger-fg);
}
.su-result {
  margin: 4px 0 6px;
  color: var(--success-fg);
}
.su-result-failed {
  margin-left: 8px;
  color: var(--attention-fg);
}
.su-failures {
  margin: 0 0 6px;
  padding-left: 18px;
  color: var(--attention-fg);
}
.su-cleanup-warning {
  margin: 0 0 6px;
  color: var(--attention-fg);
}
.su-skeleton {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 4px;
}
.su-skeleton-row {
  height: 30px;
  border-radius: var(--radius-sm);
  background: var(--bg-muted);
  opacity: 0.6;
  animation: su-pulse 1.2s ease-in-out infinite;
}
@keyframes su-pulse {
  50% { opacity: 0.25; }
}

.su-bar {
  display: flex;
  height: 6px;
  margin-top: 4px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-muted);
}
.su-bar-seg { display: block; height: 100%; }
.su-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin: 4px 0 6px;
  color: var(--text-muted);
  font-size: var(--font-3xs);
}
.su-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 2px;
  vertical-align: 0;
}
.su-bar-seg[data-group='appData'],
.su-legend-item[data-group='appData'] .su-swatch { background: var(--accent-fg); }
.su-bar-seg[data-group='electron'],
.su-legend-item[data-group='electron'] .su-swatch { background: var(--attention-fg); }
.su-bar-seg[data-group='cliHomes'],
.su-legend-item[data-group='cliHomes'] .su-swatch { background: var(--warning-fg); }
.su-bar-seg[data-group='workspaces'],
.su-legend-item[data-group='workspaces'] .su-swatch { background: var(--success-fg); }

.su-group { margin-top: 8px; }
.su-group-head {
  display: flex;
  padding: 4px 0;
  color: var(--text-muted);
  font-size: var(--font-3xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border-muted);
}
.su-group-size {
  margin-left: auto;
  text-transform: none;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.su-item {
  padding: 5px 0;
  border-bottom: 1px solid var(--border-muted);
}
.su-item-locked { opacity: 0.55; }
.su-item-danger .su-item-label { color: var(--danger-fg); }
.su-item-main {
  display: flex;
  align-items: center;
  gap: 10px;
}
.su-check { margin: 0; }
.su-check-spacer {
  display: inline-block;
  width: 13px;
  flex-shrink: 0;
}
.su-item-text {
  flex: 1;
  min-width: 0;
}
.su-item-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.su-item-label {
  font-weight: 600;
  color: var(--text-primary);
}
.su-item-desc,
.su-item-note {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  margin-top: 1px;
}
.su-item-note { color: var(--text-muted); }
.su-item-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex-shrink: 0;
}
.su-size {
  color: var(--text-bright);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.su-count {
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.su-risk,
.su-locked {
  font-size: var(--font-3xs);
  font-weight: 600;
  padding: 0 6px;
  border-radius: var(--radius-pill);
}
.su-risk-safe { color: var(--success-fg); background: var(--success-subtle); }
.su-risk-caution { color: var(--attention-fg); background: var(--attention-subtle); }
.su-risk-danger { color: var(--danger-fg); background: var(--danger-subtle); }
.su-locked { color: var(--text-muted); background: var(--bg-muted); }
.su-paths-toggle { padding: 2px 8px; font-size: var(--font-3xs); }
.su-paths {
  margin: 6px 0 0 23px;
  padding: 0;
  list-style: none;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-3xs);
  color: var(--text-muted);
  word-break: break-all;
}
.su-warnings {
  margin-top: 10px;
  border: 1px solid var(--attention-muted);
  border-radius: var(--radius-sm);
  background: var(--attention-subtle);
  padding: 8px 12px;
  color: var(--text-secondary);
}
.su-warnings-title {
  font-weight: 600;
  color: var(--attention-fg);
  margin-bottom: 4px;
}
.su-warnings ul {
  margin: 0;
  padding-left: 18px;
}
.su-warn-path {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  margin-right: 8px;
  word-break: break-all;
}

/* Sits above the modal it belongs to: the overlay is its own stacking context
 * (see .rm-overlay), so this only needs to beat the card inside it. It also
 * relies on the overlay being the containing block for fixed descendants —
 * .nv-modal-overlay's backdrop-filter makes it one — which is what keeps
 * .rm-modal's overflow:hidden from clipping this. Drop that filter or the
 * overlay's inset:0 and this box would need re-homing. */
.su-confirm {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--shadow-scrim);
  z-index: 40;
}
.su-confirm-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  padding: 20px 24px;
  max-width: 460px;
  width: 100%;
  color: var(--text-primary);
  font-size: var(--font-xs);
}
.su-confirm-card h3 {
  margin: 0 0 8px;
  font-size: var(--font-md);
  color: var(--text-bright);
}
.su-confirm-danger {
  color: var(--danger-fg);
  font-weight: 600;
}
.su-confirm-list {
  list-style: none;
  margin: 12px 0;
  padding: 0;
  max-height: 220px;
  overflow-y: auto;
}
.su-confirm-list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;
  border-top: 1px solid var(--border-muted);
}
.su-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.su-confirm-ok:not(:disabled) {
  border-color: var(--danger-muted);
  background: var(--danger-deep);
  color: var(--text-on-emphasis);
}

@media (prefers-reduced-motion: reduce) {
  .su-skeleton-row { animation: none; }
}
</style>
