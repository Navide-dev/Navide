<script setup lang="ts">
// The Shipped Log panel (built-in navide.shipped-log) for one workspace: what
// went live in a window, the deploy commands the hooks noticed (confirm or
// dismiss), adding an entry, your own line or sensitive mark for an item, the
// register of production settings (names and places, never values) and the
// daily digest. Opened from the sidebar workspace menus and from the Schedule
// panel's system job row; mounted once in App.vue and shown while
// useShippedLog's panelWorkspace is set.
//
// Everything is per workspace and goes through `ship_log.*` (useShippedLog's
// shipLogCall); the backend keeps the rules (a value is refused, not masked).
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import {
  SHIP_WINDOWS,
  closeShippedLogPanel,
  shipLogCall,
  useShippedLogPanel,
  type ShipConfig,
  type ShipDigestSettings,
  type ShipDigestState,
  type ShipItem,
  type ShipReport,
  type ShipSourceKind,
} from '../composables/useShippedLog'
import { blockTourWhile } from '../composables/useTourBlockers'
import { isValidHhmm, isValidTimeZone } from '../lib/schedulerJobs'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()

const { t } = useI18n()
const { panelWorkspace } = useShippedLogPanel()
const workspace = computed(() => panelWorkspace.value)
blockTourWhile(() => !!workspace.value)

const WINDOW_KEYS: Record<(typeof SHIP_WINDOWS)[number], string> = {
  今天: 'today', 昨天: 'yesterday', '7d': '7d', '30d': '30d',
}
const SOURCE_KINDS: ShipSourceKind[] = ['other', 'commit', 'config', 'migration']

const since = ref<(typeof SHIP_WINDOWS)[number]>('今天')
const report = ref<ShipReport | null>(null)
const configs = ref<ShipConfig[]>([])
const digest = ref<ShipDigestState | null>(null)
const digestDraft = ref<ShipDigestSettings | null>(null)
const loadError = ref('')
const opError = ref('')
const notice = ref('')
const busy = ref(false)

// Inline editors: one item's line, one detection's confirmation.
const editingKey = ref<string | null>(null)
const editSummary = ref('')
const editSensitive = ref(false)
const confirmingId = ref<number | null>(null)
const confirmSummary = ref('')

const addSummary = ref('')
const addKind = ref<ShipSourceKind>('other')
const addRef = ref('')
const addSensitive = ref(false)

const cfgKey = ref('')
const cfgLabel = ref('')
const cfgLocation = ref('')
const cfgEnvironment = ref('')
const cfgNote = ref('')

const workspaceName = computed(() => {
  const parts = (workspace.value ?? '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? workspace.value ?? ''
})
const digestErrors = computed(() => {
  const d = digestDraft.value
  if (!d) return { at: '', tz: '' }
  return {
    at: isValidHhmm(d.digest_at) ? '' : t('shippedLog.error-at'),
    tz: !d.digest_tz || isValidTimeZone(d.digest_tz) ? '' : t('shippedLog.error-tz'),
  }
})

function close(): void {
  closeShippedLogPanel()
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function itemLine(item: ShipItem): string {
  if (item.kind === 'detected') return item.summary
  if (item.kind === 'recorded' || item.edited) return item.summary
  return `${t(`shippedLog.verb.${item.kind}`)} ${item.summary}`
}

function itemSource(item: ShipItem): string {
  const head = item.short_hash || item.config_label || t(`shippedLog.kind.${item.source_kind}`)
  return [head, ...item.tags].join(' ')
}

async function loadReport(): Promise<void> {
  const ws = workspace.value
  if (!ws) return
  const res = await shipLogCall<ShipReport>(props.backend, 'ship_log.report', { workspace: ws, since: since.value })
  if (workspace.value !== ws) return
  if (res.ok) report.value = res.data
  else loadError.value = res.error
}

async function loadAll(): Promise<void> {
  const ws = workspace.value
  report.value = null
  configs.value = []
  digest.value = null
  digestDraft.value = null
  loadError.value = ''
  opError.value = ''
  notice.value = ''
  editingKey.value = null
  confirmingId.value = null
  if (!ws) return
  const [cfg, dig] = await Promise.all([
    shipLogCall<{ configs: ShipConfig[] }>(props.backend, 'ship_log.configs', { workspace: ws }),
    shipLogCall<ShipDigestState>(props.backend, 'ship_log.digest_get', { workspace: ws }),
    loadReport(),
  ])
  if (workspace.value !== ws) return
  if (cfg.ok) configs.value = cfg.data.configs
  if (dig.ok) {
    digest.value = dig.data
    digestDraft.value = { ...dig.data.settings }
  }
  if (!cfg.ok || !dig.ok) loadError.value = (!cfg.ok ? cfg.error : '') || (!dig.ok ? dig.error : '')
}

watch(workspace, () => void loadAll(), { immediate: true })
watch(since, () => void loadReport())

/** Run one write; on success reload what it changed. */
async function act(type: string, payload: Record<string, unknown>, after: () => Promise<void> = loadReport): Promise<boolean> {
  const ws = workspace.value
  if (!ws || busy.value) return false
  busy.value = true
  opError.value = ''
  notice.value = ''
  try {
    const res = await shipLogCall<Record<string, unknown>>(props.backend, type, { workspace: ws, ...payload })
    if (!res.ok) {
      opError.value = res.error
      return false
    }
    await after()
    return true
  } finally {
    busy.value = false
  }
}

function startEdit(item: ShipItem): void {
  editingKey.value = item.key
  editSummary.value = item.summary
  editSensitive.value = item.sensitive
}

async function saveEdit(item: ShipItem): Promise<void> {
  if (await act('ship_log.override', { item_key: item.key, summary: editSummary.value, sensitive: editSensitive.value })) {
    editingKey.value = null
  }
}

async function resetEdit(item: ShipItem): Promise<void> {
  if (await act('ship_log.override', { item_key: item.key })) editingKey.value = null
}

function startConfirm(item: ShipItem): void {
  confirmingId.value = item.detection_id ?? null
  confirmSummary.value = ''
}

async function confirmDetection(item: ShipItem): Promise<void> {
  const ok = await act('ship_log.record', {
    summary: confirmSummary.value, source_kind: 'other', at: new Date(item.at * 1000).toISOString(),
    detection_id: item.detection_id,
  })
  if (ok) confirmingId.value = null
}

async function dismissDetection(item: ShipItem): Promise<void> {
  await act('ship_log.detection', { id: item.detection_id, status: 'dismissed' })
}

async function addEntry(): Promise<void> {
  const ok = await act('ship_log.record', {
    summary: addSummary.value, source_kind: addKind.value, ref: addRef.value.trim(),
    sensitive: addKind.value === 'config' ? true : addSensitive.value,
  })
  if (ok) {
    addSummary.value = ''
    addRef.value = ''
    addSensitive.value = false
  }
}

async function reloadConfigs(): Promise<void> {
  const res = await shipLogCall<{ configs: ShipConfig[] }>(props.backend, 'ship_log.configs', { workspace: workspace.value })
  if (res.ok) configs.value = res.data.configs
}

async function addConfig(): Promise<void> {
  const ok = await act('ship_log.config_set', {
    key: cfgKey.value.trim(), label: cfgLabel.value, location: cfgLocation.value,
    environment: cfgEnvironment.value, note: cfgNote.value,
  }, reloadConfigs)
  if (ok) cfgKey.value = cfgLabel.value = cfgLocation.value = cfgEnvironment.value = cfgNote.value = ''
}

async function removeConfig(cfg: ShipConfig): Promise<void> {
  await act('ship_log.config_set', { key: cfg.key, remove: true }, reloadConfigs)
}

async function reloadDigest(): Promise<void> {
  const res = await shipLogCall<ShipDigestState>(props.backend, 'ship_log.digest_get', { workspace: workspace.value })
  if (res.ok) {
    digest.value = res.data
    digestDraft.value = { ...res.data.settings }
  }
}

async function saveDigest(): Promise<void> {
  if (!digestDraft.value || digestErrors.value.at || digestErrors.value.tz) return
  await act('ship_log.digest_set', { settings: { ...digestDraft.value } }, reloadDigest)
}

async function runDigest(): Promise<void> {
  if (await act('ship_log.digest_run', {}, reloadDigest)) notice.value = t('shippedLog.digest-sent')
}
</script>

<template>
  <Teleport to="body">
    <template v-if="workspace">
      <div class="sl-backdrop nv-modal-overlay" @click="close" />
      <div
        class="sl-card nv-modal-shell nv-modal-shell--standard"
        data-test="shipped-log-panel"
        :data-workspace="workspace"
        role="dialog"
        @click.stop
        @keydown.esc="close"
      >
        <div class="sl-head">
          <span class="sl-title">🚀 {{ t('shippedLog.title') }}</span>
          <span class="sl-ws" :title="workspace"><b>{{ workspaceName }}</b> · {{ workspace }}</span>
          <button class="sl-x" data-test="close" :title="t('shippedLog.close')" @click="close">✕</button>
        </div>

        <div class="sl-body">
          <div v-if="loadError" class="sl-err" data-test="load-error">{{ loadError }}</div>
          <div v-if="opError" class="sl-err" data-test="op-error">{{ opError }}</div>
          <div v-if="notice" class="sl-ok" data-test="notice">{{ notice }}</div>

          <!-- Window and timeline -->
          <div class="sl-windows" role="tablist">
            <button
              v-for="w in SHIP_WINDOWS"
              :key="w"
              class="nv-btn"
              :class="{ 'nv-btn--primary': since === w }"
              :data-test="`window-${WINDOW_KEYS[w]}`"
              @click="since = w"
            >{{ t(`shippedLog.window.${WINDOW_KEYS[w]}`) }}</button>
          </div>
          <div v-if="!report" class="sl-muted">{{ t('shippedLog.loading') }}</div>
          <template v-else>
            <div class="sl-summary" data-test="summary">
              {{ t('shippedLog.count', { n: report.count }) }}
              <template v-if="report.pending_detections"> · {{ t('shippedLog.pending', { n: report.pending_detections }) }}</template>
              <template v-if="report.branch"> · {{ report.branch }}</template>
            </div>
            <div v-for="(w, i) in report.warnings" :key="i" class="sl-muted" data-test="warning">{{ w }}</div>
            <div v-if="!report.items.length" class="sl-muted" data-test="empty">{{ t('shippedLog.empty') }}</div>
            <ul class="sl-items">
              <li
                v-for="item in report.items"
                :key="item.key"
                class="sl-item"
                :data-kind="item.kind"
                :data-test="`item-${item.key}`"
              >
                <div class="sl-line">
                  <span class="sl-time">{{ when(item.at) }}</span>
                  <span v-if="item.kind === 'detected'" class="sl-tag sl-detected">{{ t('shippedLog.detected') }}</span>
                  <span class="sl-text">{{ itemLine(item) }}</span>
                </div>
                <div class="sl-meta">
                  <span class="sl-source">{{ itemSource(item) }}</span>
                  <span v-for="b in item.bases" :key="b" class="sl-tag">{{ t(`shippedLog.basis.${b}`) }}</span>
                  <span v-if="item.sensitive" class="sl-tag sl-sensitive">{{ t('shippedLog.sensitive') }}</span>
                  <span v-if="item.edited" class="sl-tag">{{ t('shippedLog.edited') }}</span>
                  <span class="sl-spacer" />
                  <template v-if="item.kind === 'detected'">
                    <button class="nv-btn" data-test="confirm" :disabled="busy" @click="startConfirm(item)">{{ t('shippedLog.confirm') }}</button>
                    <button class="nv-btn" data-test="dismiss" :disabled="busy" @click="dismissDetection(item)">{{ t('shippedLog.dismiss') }}</button>
                  </template>
                  <button v-else class="nv-btn" data-test="edit" :disabled="busy" @click="startEdit(item)">{{ t('shippedLog.edit') }}</button>
                </div>
                <div v-if="item.kind === 'detected' && confirmingId === item.detection_id" class="sl-inline" data-test="confirm-form">
                  <input v-model="confirmSummary" class="nv-input sl-grow" :placeholder="t('shippedLog.summary-placeholder')" />
                  <button class="nv-btn nv-btn--primary" data-test="confirm-save" :disabled="busy || !confirmSummary.trim()" @click="confirmDetection(item)">{{ t('shippedLog.save') }}</button>
                  <button class="nv-btn" @click="confirmingId = null">{{ t('shippedLog.cancel') }}</button>
                </div>
                <div v-if="editingKey === item.key" class="sl-inline" data-test="edit-form">
                  <input v-model="editSummary" class="nv-input sl-grow" :placeholder="t('shippedLog.summary-placeholder')" />
                  <label class="sl-check"><input v-model="editSensitive" type="checkbox" /> {{ t('shippedLog.mark-sensitive') }}</label>
                  <button class="nv-btn nv-btn--primary" data-test="edit-save" :disabled="busy" @click="saveEdit(item)">{{ t('shippedLog.save') }}</button>
                  <button v-if="item.edited" class="nv-btn" data-test="edit-reset" :disabled="busy" @click="resetEdit(item)">{{ t('shippedLog.reset') }}</button>
                  <button class="nv-btn" @click="editingKey = null">{{ t('shippedLog.cancel') }}</button>
                </div>
              </li>
            </ul>
          </template>

          <!-- Add an entry -->
          <section class="sl-section" data-test="add">
            <h4>{{ t('shippedLog.add-title') }}</h4>
            <div class="sl-inline">
              <input v-model="addSummary" class="nv-input sl-grow" data-field="add-summary" :placeholder="t('shippedLog.summary-placeholder')" />
              <select v-model="addKind" class="nv-select" data-field="add-kind">
                <option v-for="k in SOURCE_KINDS" :key="k" :value="k">{{ t(`shippedLog.kind.${k}`) }}</option>
              </select>
            </div>
            <div class="sl-inline">
              <input v-model="addRef" class="nv-input sl-grow" data-field="add-ref" :placeholder="t('shippedLog.ref-placeholder')" />
              <label v-if="addKind !== 'config'" class="sl-check"><input v-model="addSensitive" type="checkbox" /> {{ t('shippedLog.mark-sensitive') }}</label>
              <button class="nv-btn nv-btn--primary" data-test="add-save" :disabled="busy || !addSummary.trim()" @click="addEntry">{{ t('shippedLog.add') }}</button>
            </div>
          </section>

          <!-- Production settings register -->
          <section class="sl-section" data-test="configs">
            <h4>{{ t('shippedLog.config-title') }}</h4>
            <div class="sl-muted">{{ t('shippedLog.config-hint') }}</div>
            <div v-if="!configs.length" class="sl-muted" data-test="config-empty">{{ t('shippedLog.config-empty') }}</div>
            <ul class="sl-items">
              <li v-for="cfg in configs" :key="cfg.key" class="sl-item" :data-test="`config-${cfg.key}`">
                <div class="sl-line">
                  <b>{{ cfg.label }}</b>
                  <span class="sl-source">{{ cfg.key }} · {{ cfg.environment }}</span>
                  <span class="sl-spacer" />
                  <button class="nv-btn" data-test="config-remove" :disabled="busy" @click="removeConfig(cfg)">{{ t('shippedLog.remove') }}</button>
                </div>
                <div class="sl-meta"><span class="sl-source">{{ cfg.location }}</span><span v-if="cfg.note" class="sl-muted"> · {{ cfg.note }}</span></div>
              </li>
            </ul>
            <div class="sl-inline">
              <input v-model="cfgKey" class="nv-input" data-field="cfg-key" :placeholder="t('shippedLog.config-key')" />
              <input v-model="cfgLabel" class="nv-input sl-grow" data-field="cfg-label" :placeholder="t('shippedLog.config-label')" />
              <input v-model="cfgEnvironment" class="nv-input" data-field="cfg-env" :placeholder="t('shippedLog.config-environment')" />
            </div>
            <div class="sl-inline">
              <input v-model="cfgLocation" class="nv-input sl-grow" data-field="cfg-location" :placeholder="t('shippedLog.config-location')" />
              <input v-model="cfgNote" class="nv-input" data-field="cfg-note" :placeholder="t('shippedLog.config-note')" />
              <button class="nv-btn nv-btn--primary" data-test="config-save" :disabled="busy || !cfgKey.trim() || !cfgLocation.trim()" @click="addConfig">{{ t('shippedLog.add') }}</button>
            </div>
          </section>

          <!-- Daily digest -->
          <section v-if="digestDraft" class="sl-section" data-test="digest">
            <h4>{{ t('shippedLog.digest-title') }}</h4>
            <div class="sl-muted">{{ t('shippedLog.digest-hint') }}</div>
            <div class="sl-inline">
              <label class="sl-check"><input v-model="digestDraft.digest_enabled" type="checkbox" data-field="digest-enabled" /> {{ t('shippedLog.digest-enabled') }}</label>
            </div>
            <div class="sl-inline">
              <span>{{ t('shippedLog.digest-at') }}</span>
              <input v-model="digestDraft.digest_at" class="nv-input sl-time-input" data-field="digest-at" placeholder="09:00" />
              <span>{{ t('shippedLog.digest-tz') }}</span>
              <input v-model="digestDraft.digest_tz" class="nv-input" data-field="digest-tz" placeholder="Asia/Taipei" />
              <label class="sl-check"><input v-model="digestDraft.digest_skip_empty" type="checkbox" /> {{ t('shippedLog.digest-skip-empty') }}</label>
            </div>
            <div v-if="digestErrors.at || digestErrors.tz" class="sl-err" data-test="digest-error">{{ digestErrors.at || digestErrors.tz }}</div>
            <div class="sl-inline">
              <span v-if="digest?.next_run_at && digest.settings.digest_enabled" class="sl-muted" data-test="digest-next">
                {{ t('shippedLog.digest-next', { time: new Date(digest.next_run_at).toLocaleString() }) }}
              </span>
              <span class="sl-spacer" />
              <button class="nv-btn" data-test="digest-run" :disabled="busy" @click="runDigest">▶ {{ t('shippedLog.digest-run') }}</button>
              <button class="nv-btn nv-btn--primary" data-test="digest-save" :disabled="busy || !!digestErrors.at || !!digestErrors.tz" @click="saveDigest">{{ t('shippedLog.save') }}</button>
            </div>
          </section>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.sl-backdrop { position: fixed; inset: 0; z-index: 1000; }
.sl-card {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 1001;
  width: min(720px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
  font-size: var(--font-xs); color: var(--text-primary);
}
.sl-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 16px 8px; border-bottom: 1px solid var(--border-muted); }
.sl-title { flex: none; font-weight: 600; color: var(--text-bright); }
.sl-ws { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-2xs); color: var(--text-secondary); }
.sl-x { appearance: none; border: none; background: none; color: var(--text-secondary); cursor: pointer; }
.sl-body { overflow-y: auto; padding: 10px 16px 16px; display: flex; flex-direction: column; gap: 8px; }
.sl-windows { display: flex; gap: 6px; }
.sl-summary { font-weight: 600; }
.sl-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.sl-item { border: 1px solid var(--border-muted); border-radius: 6px; padding: 6px 8px; }
.sl-item[data-kind='detected'] { border-style: dashed; }
.sl-line, .sl-meta, .sl-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sl-meta { margin-top: 2px; font-size: var(--font-2xs); color: var(--text-secondary); }
.sl-inline { margin-top: 4px; }
.sl-time { flex: none; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.sl-text { min-width: 0; overflow-wrap: anywhere; }
.sl-source { overflow-wrap: anywhere; }
.sl-tag { border: 1px solid var(--border-muted); border-radius: 99px; padding: 0 6px; font-size: var(--font-2xs); }
.sl-detected { border-color: var(--warning, #c77400); }
.sl-sensitive { border-color: var(--danger, #c0392b); }
.sl-spacer { flex: 1; }
.sl-grow { flex: 1; min-width: 160px; }
.sl-time-input { width: 64px; }
.sl-check { display: inline-flex; align-items: center; gap: 4px; }
.sl-section { border-top: 1px solid var(--border-muted); padding-top: 8px; }
.sl-section h4 { margin: 0 0 4px; font-size: var(--font-xs); }
.sl-muted { color: var(--text-secondary); }
.sl-err { color: var(--danger, #c0392b); }
.sl-ok { color: var(--success, #2b8a3e); }
</style>
