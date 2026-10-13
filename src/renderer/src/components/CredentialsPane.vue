<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'

type Backend = ReturnType<typeof useBackend>
type Severity = 'high' | 'medium' | 'low'
type ReminderState = 'active' | 'snoozed' | 'dismissed'

interface Reminder { state: ReminderState; until?: string }
interface Finding {
  id: string
  code: string
  severity: Severity
  kind: string
  location: string
  steps: string[]
  manualFix: boolean
  links: Array<{ label: string; url: string }>
  reminder: Reminder
}
interface Item { id: string; kind: string; label: string; detail: Record<string, string | number | boolean> }
interface Root { path: string; source: 'workspace' | 'user'; repoCount: number; truncated: boolean }
interface Keyring { available: boolean; backend: string | null; reason: string }
interface Scan {
  complete: boolean
  scannedAt: string
  durationMs: number
  keyring: Keyring
  roots: Root[]
  high: number
  items: Item[]
  findings: Finding[]
}

// Codes with localized copy; anything else falls back to a generic card.
const KNOWN_CODES = new Set([
  'url-token', 'ssh-no-passphrase-default-host', 'ssh-no-passphrase', 'ssh-key-unreferenced', 'ssh-key-mode',
  'cli-token-plaintext', 'gh-active-account-only', 'helper-duplicate', 'helper-shadowed', 'env-token-in-shell-rc',
  'env-token-set', 'plaintext-credential-file', 'keyring-unavailable',
])
const KNOWN_KINDS = new Set(['git-helper', 'cli-account', 'ssh-key', 'keychain-item', 'remote', 'env-var', 'plaintext-file', 'keyring'])
const SEVERITIES: Severity[] = ['high', 'medium', 'low']

const props = withDefaults(defineProps<{ backend: Backend; active?: boolean }>(), { active: true })
const emit = defineEmits<{ (e: 'high-count', count: number): void }>()
const { t } = useI18n()

const scan = ref<Scan | null>(null)
const loading = ref(false)
const error = ref('')
const view = ref<'findings' | 'inventory'>('findings')
const kindFilter = ref('all')
const query = ref('')
const selectedId = ref('')
const reminderBusy = ref(false)
const reminderError = ref('')
const copiedStep = ref('')
let started = false
let scanSeq = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function str(value: unknown): string { return typeof value === 'string' ? value : '' }

function normalizeReminder(value: unknown): Reminder {
  const r = isRecord(value) ? value : {}
  const state: ReminderState = r.state === 'snoozed' || r.state === 'dismissed' ? r.state : 'active'
  return { state, ...(typeof r.until === 'string' ? { until: r.until } : {}) }
}

// Only whitelisted fields are copied out of the payload: anything else the
// backend might send never reaches the template.
function normalizeScan(p: Record<string, unknown>): Scan {
  const kr = isRecord(p.keyring) ? p.keyring : {}
  const summary = isRecord(p.summary) ? p.summary : {}
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  return {
    complete: p.complete !== false,
    scannedAt: str(p.scanned_at),
    durationMs: Number(p.duration_ms) || 0,
    keyring: { available: kr.available === true, backend: typeof kr.backend === 'string' ? kr.backend : null, reason: str(kr.reason) },
    roots: arr(p.roots).flatMap((r) => (isRecord(r) && str(r.path)
      ? [{ path: str(r.path), source: r.source === 'workspace' ? 'workspace' as const : 'user' as const, repoCount: Number(r.repo_count) || 0, truncated: r.truncated === true }]
      : [])),
    high: Number(summary.high) || 0,
    items: arr(p.items).flatMap((i) => {
      if (!isRecord(i) || !str(i.id)) return []
      const detail: Item['detail'] = {}
      if (isRecord(i.detail)) {
        for (const [k, v] of Object.entries(i.detail)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') detail[k] = v
        }
      }
      return [{ id: str(i.id), kind: str(i.kind), label: str(i.label), detail }]
    }),
    findings: arr(p.findings).flatMap((f) => {
      if (!isRecord(f) || !str(f.id)) return []
      const severity: Severity = f.severity === 'high' || f.severity === 'medium' ? f.severity : 'low'
      return [{
        id: str(f.id),
        code: str(f.code),
        severity,
        kind: str(f.kind),
        location: str(f.location),
        steps: arr(f.steps).filter((s): s is string => typeof s === 'string'),
        manualFix: f.manual_fix === true,
        links: arr(f.links).flatMap((l) => (isRecord(l) && str(l.url) ? [{ label: str(l.label) || str(l.url), url: str(l.url) }] : [])),
        reminder: normalizeReminder(f.reminder),
      }]
    }),
  }
}

function errorText(payload: unknown, fallback: string): string {
  return isRecord(payload) && typeof payload.error === 'string' && payload.error ? payload.error : fallback
}

async function runScan(force: boolean): Promise<void> {
  const seq = ++scanSeq
  loading.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<Record<string, unknown>>('credentials.scan', force ? { force: true } : {})
    if (seq !== scanSeq) return
    const payload = resp.payload
    if (!resp.ok || !isRecord(payload) || payload.ok === false) {
      error.value = errorText(payload, resp.error?.message || t('settings.credentials.error-load'))
      return
    }
    scan.value = normalizeScan(payload)
    if (selectedId.value && !currentList().some((x) => x.id === selectedId.value)) selectedId.value = ''
  } catch (e) {
    if (seq === scanSeq) error.value = e instanceof Error ? e.message : t('settings.credentials.error-load')
  } finally {
    if (seq === scanSeq) loading.value = false
  }
}

// Scan when the tab is first opened, never on every Settings open.
watch(
  () => props.active,
  (active) => {
    if (active && !started) {
      started = true
      void runScan(false)
    }
  },
  { immediate: true }
)

const activeHigh = computed(() => (scan.value?.findings ?? []).filter((f) => f.severity === 'high' && f.reminder.state === 'active').length)
watch(activeHigh, (n) => emit('high-count', n), { immediate: true })

function currentList(): Array<Finding | Item> {
  return view.value === 'findings' ? scan.value?.findings ?? [] : scan.value?.items ?? []
}

function kindLabel(kind: string): string {
  return KNOWN_KINDS.has(kind) ? t(`settings.credentials.kind.${kind}`) : kind
}
function codeKey(code: string): string { return KNOWN_CODES.has(code) ? code : '' }
function findingTitle(f: Finding): string {
  const k = codeKey(f.code)
  return k ? t(`settings.credentials.code.${k}.title`) : t('settings.credentials.code-unknown.title')
}
function findingBody(f: Finding): string {
  const k = codeKey(f.code)
  return k ? t(`settings.credentials.code.${k}.body`) : t('settings.credentials.code-unknown.body')
}

const kindChips = computed(() => {
  const counts = new Map<string, number>()
  for (const x of currentList()) counts.set(x.kind, (counts.get(x.kind) ?? 0) + 1)
  const total = currentList().length
  return [
    { key: 'all', label: t('settings.credentials.all'), count: total },
    ...[...counts.entries()].map(([key, count]) => ({ key, label: kindLabel(key), count })),
  ]
})
watch(view, () => { kindFilter.value = 'all'; selectedId.value = ''; reminderError.value = '' })

function matches(text: string): boolean {
  const q = query.value.trim().toLowerCase()
  return !q || text.toLowerCase().includes(q)
}

const filteredFindings = computed(() => (scan.value?.findings ?? []).filter((f) =>
  (kindFilter.value === 'all' || f.kind === kindFilter.value) && matches(`${findingTitle(f)} ${f.location} ${f.kind}`)))
const filteredItems = computed(() => (scan.value?.items ?? []).filter((i) =>
  (kindFilter.value === 'all' || i.kind === kindFilter.value) &&
  matches(`${i.label} ${i.kind} ${Object.values(i.detail).join(' ')}`)))

const findingGroups = computed(() => SEVERITIES
  .map((severity) => ({ severity, rows: filteredFindings.value.filter((f) => f.severity === severity) }))
  .filter((g) => g.rows.length > 0))
const itemGroups = computed(() => {
  const by = new Map<string, Item[]>()
  for (const i of filteredItems.value) by.set(i.kind, [...(by.get(i.kind) ?? []), i])
  return [...by.entries()].map(([kind, rows]) => ({ kind, rows }))
})

const selectedFinding = computed(() => (view.value === 'findings' ? scan.value?.findings.find((f) => f.id === selectedId.value) ?? null : null))
const selectedItem = computed(() => (view.value === 'inventory' ? scan.value?.items.find((i) => i.id === selectedId.value) ?? null : null))
const drawerOpen = computed(() => selectedFinding.value !== null || selectedItem.value !== null)

function select(id: string): void {
  selectedId.value = selectedId.value === id ? '' : id
  reminderError.value = ''
  copiedStep.value = ''
}

function itemKeyDetails(i: Item): Array<[string, string]> {
  return Object.entries(i.detail).slice(0, 3).map(([k, v]) => [k, String(v)])
}

function reminderLabel(r: Reminder): string {
  const base = t(`settings.credentials.reminder.${r.state}`)
  if (r.state !== 'snoozed' || !r.until) return base
  const d = new Date(r.until)
  return Number.isNaN(d.getTime()) ? base : `${base} ${t('settings.credentials.reminder.until', { date: d.toLocaleDateString() })}`
}

const scannedLabel = computed(() => {
  const s = scan.value
  if (!s?.scannedAt) return ''
  const d = new Date(s.scannedAt)
  return t('settings.credentials.scanned-at', { time: Number.isNaN(d.getTime()) ? s.scannedAt : d.toLocaleTimeString(), ms: s.durationMs })
})

async function setReminder(f: Finding, state: ReminderState): Promise<void> {
  reminderBusy.value = true
  reminderError.value = ''
  try {
    const params: Record<string, unknown> = { id: f.id, state }
    if (state === 'snoozed') params.days = 7
    const resp = await props.backend.send<Record<string, unknown>>('credentials.reminder.set', params)
    const payload = resp.payload
    if (!resp.ok || !isRecord(payload) || payload.ok === false) {
      reminderError.value = errorText(payload, resp.error?.message || t('settings.credentials.reminder.error'))
      return
    }
    f.reminder = normalizeReminder(payload.reminder ?? { state })
  } catch (e) {
    reminderError.value = e instanceof Error ? e.message : t('settings.credentials.reminder.error')
  } finally {
    reminderBusy.value = false
  }
}

async function copyStep(step: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(step)
    copiedStep.value = step
  } catch {
    copiedStep.value = ''
  }
}

function openLink(url: string): void {
  void window.agentTeam?.openExternal?.(url)
}

// ── Scan roots editor ────────────────────────────────────────────────────
const rootsOpen = ref(false)
const rootsDraft = ref<string[]>([])
const rootsInput = ref('')
const rootsError = ref('')
const rootsBusy = ref(false)

async function toggleRoots(): Promise<void> {
  rootsOpen.value = !rootsOpen.value
  if (!rootsOpen.value) return
  rootsError.value = ''
  try {
    const resp = await props.backend.send<Record<string, unknown>>('credentials.roots.get', {})
    const payload = resp.payload
    if (!resp.ok || !isRecord(payload) || payload.ok === false) {
      rootsError.value = errorText(payload, t('settings.credentials.roots.error-load'))
      return
    }
    rootsDraft.value = Array.isArray(payload.roots) ? payload.roots.filter((r): r is string => typeof r === 'string') : []
  } catch (e) {
    rootsError.value = e instanceof Error ? e.message : t('settings.credentials.roots.error-load')
  }
}
function addRoot(): void {
  const path = rootsInput.value.trim()
  if (path && !rootsDraft.value.includes(path)) rootsDraft.value = [...rootsDraft.value, path]
  rootsInput.value = ''
}
async function browseRoot(): Promise<void> {
  const picked = await window.agentTeam?.pickWorkspace?.()
  if (picked) {
    rootsInput.value = picked
    addRoot()
  }
}
function removeRoot(path: string): void {
  rootsDraft.value = rootsDraft.value.filter((r) => r !== path)
}
async function saveRoots(): Promise<void> {
  addRoot()
  rootsBusy.value = true
  rootsError.value = ''
  try {
    const resp = await props.backend.send<Record<string, unknown>>('credentials.roots.set', { roots: rootsDraft.value })
    const payload = resp.payload
    if (!resp.ok || !isRecord(payload) || payload.ok === false) {
      rootsError.value = errorText(payload, resp.error?.message || t('settings.credentials.roots.error'))
      return
    }
    if (Array.isArray(payload.roots)) rootsDraft.value = payload.roots.filter((r): r is string => typeof r === 'string')
  } catch (e) {
    rootsError.value = e instanceof Error ? e.message : t('settings.credentials.roots.error')
    return
  } finally {
    rootsBusy.value = false
  }
  await runScan(true)
}
</script>

<template>
  <div class="cred-pane" data-settings-section="credentials">
    <div class="cred-toolbar">
      <div>
        <h2>{{ t('settings.credentials.title') }}</h2>
        <p>{{ t('settings.credentials.intro') }}</p>
        <p class="cred-meta">
          <span>{{ t('settings.credentials.meta') }}</span>
          <span v-if="scan" class="cred-keyring" :class="scan.keyring.available ? 'ok' : 'bad'">
            <template v-if="scan.keyring.available">
              {{ scan.keyring.backend ? t('settings.credentials.keyring-ok', { backend: scan.keyring.backend }) : t('settings.credentials.keyring-ok-plain') }}
            </template>
            <template v-else>
              {{ t('settings.credentials.keyring-bad') }} · {{ scan.keyring.reason || t('settings.credentials.keyring-reason-unknown') }}
            </template>
          </span>
        </p>
      </div>
      <div class="cred-toolbar-actions">
        <button type="button" class="cred-roots-btn" :aria-expanded="rootsOpen" @click="toggleRoots">
          {{ t('settings.credentials.scan-roots') }}
        </button>
        <button type="button" class="primary cred-scan-btn" :disabled="loading" @click="runScan(true)">
          {{ loading ? t('settings.credentials.scanning') : t('settings.credentials.scan') }}
        </button>
      </div>
    </div>

    <p v-if="error" class="cred-error" role="alert">{{ error }}</p>
    <p v-if="scan && !scan.keyring.available" class="cred-warn">{{ t('settings.credentials.keyring-bad-hint') }}</p>
    <div v-if="scan && !scan.complete" class="cred-warn" role="status">
      <p class="cred-incomplete">{{ t('settings.credentials.incomplete') }}</p>
      <ul class="cred-root-list">
        <li v-for="r in scan.roots.filter((x) => x.truncated)" :key="r.path">
          <code v-truncate>{{ r.path }}</code>
          <span class="cred-tag cred-root-truncated">{{ t('settings.credentials.roots.truncated') }}</span>
        </li>
      </ul>
    </div>
    <div v-if="scan && scan.high > 0" class="cred-banner" role="status">
      <strong>{{ t('settings.credentials.banner-high', { count: scan.high }) }}</strong>
      <span>{{ t('settings.credentials.banner-high-hint') }}</span>
    </div>
    <p v-if="scannedLabel" class="cred-scanned">{{ scannedLabel }}</p>

    <section v-if="rootsOpen" class="cred-roots">
      <h3>{{ t('settings.credentials.roots.title') }}</h3>
      <p>{{ t('settings.credentials.roots.intro') }}</p>
      <p v-if="rootsError" class="cred-error" role="alert">{{ rootsError }}</p>
      <ul v-if="rootsDraft.length" class="cred-root-list">
        <li v-for="path in rootsDraft" :key="path">
          <code v-truncate>{{ path }}</code>
          <button type="button" class="cred-roots-remove" @click="removeRoot(path)">{{ t('settings.credentials.roots.remove') }}</button>
        </li>
      </ul>
      <p v-else class="cred-muted">{{ t('settings.credentials.roots.empty') }}</p>
      <div class="cred-root-add">
        <input v-model="rootsInput" :placeholder="t('settings.credentials.roots.placeholder')" spellcheck="false" autocomplete="off" @keydown.enter.prevent="addRoot" />
        <button type="button" class="cred-roots-add" :disabled="!rootsInput.trim()" @click="addRoot">{{ t('settings.credentials.roots.add') }}</button>
        <button type="button" class="cred-roots-browse" @click="browseRoot">{{ t('settings.credentials.roots.browse') }}</button>
        <button type="button" class="primary cred-roots-save" :disabled="rootsBusy" @click="saveRoots">{{ t('settings.credentials.roots.save') }}</button>
      </div>
      <template v-if="scan && scan.roots.length">
        <h4>{{ t('settings.credentials.roots.scanned') }}</h4>
        <ul class="cred-root-list scanned">
          <li v-for="r in scan.roots" :key="r.path">
            <code v-truncate>{{ r.path }}</code>
            <span class="cred-tag">{{ t(`settings.credentials.roots.source.${r.source}`) }}</span>
            <span class="cred-muted">{{ t('settings.credentials.roots.repos', { count: r.repoCount }) }}</span>
            <span v-if="r.truncated" class="cred-tag">{{ t('settings.credentials.roots.truncated') }}</span>
          </li>
        </ul>
      </template>
    </section>

    <div class="cred-filterbar">
      <div class="cred-chips" role="group" :aria-label="t('settings.credentials.filter-label')">
        <button
          v-for="chip in kindChips"
          :key="chip.key"
          type="button"
          class="cred-chip"
          :class="{ on: kindFilter === chip.key }"
          :aria-pressed="kindFilter === chip.key"
          @click="kindFilter = chip.key"
        >{{ chip.label }}<span class="count">{{ chip.count }}</span></button>
      </div>
      <input v-model="query" class="cred-search" type="search" :placeholder="t('settings.credentials.search')" />
      <div class="cred-view-switch" role="group" :aria-label="t('settings.credentials.view-label')">
        <button type="button" :class="{ on: view === 'findings' }" :aria-pressed="view === 'findings'" @click="view = 'findings'">{{ t('settings.credentials.view-findings') }}</button>
        <button type="button" :class="{ on: view === 'inventory' }" :aria-pressed="view === 'inventory'" @click="view = 'inventory'">{{ t('settings.credentials.view-inventory') }}</button>
      </div>
    </div>

    <div class="cred-body" :class="{ 'drawer-open': drawerOpen }">
      <div class="cred-main">
        <div v-if="loading && !scan" class="cred-state nv-loading">{{ t('settings.credentials.loading') }}</div>
        <div v-else-if="!scan" class="cred-state nv-empty">{{ t('settings.credentials.not-scanned') }}</div>

        <template v-else-if="view === 'findings'">
          <div v-if="findingGroups.length === 0" class="cred-state nv-empty">
            <strong>{{ t('settings.credentials.empty-findings-title') }}</strong>
            <span>{{ t('settings.credentials.empty-findings-body') }}</span>
          </div>
          <section v-for="g in findingGroups" :key="g.severity" class="cred-group" :data-severity="g.severity">
            <h3 class="cred-group-title">{{ t(`settings.credentials.severity.${g.severity}`) }}<span class="count">{{ g.rows.length }}</span></h3>
            <div class="cred-cards">
              <button v-for="f in g.rows" :key="f.id" type="button" class="cred-card" :class="{ active: selectedId === f.id, quiet: f.reminder.state !== 'active' }" @click="select(f.id)">
                <span class="cred-card-head">
                  <strong v-truncate>{{ findingTitle(f) }}</strong>
                  <span class="cred-sev" :class="f.severity">{{ t(`settings.credentials.severity.${f.severity}`) }}</span>
                </span>
                <span class="cred-card-loc" v-truncate>{{ f.location }}</span>
                <span class="cred-card-foot">
                  <span class="cred-tag">{{ kindLabel(f.kind) }}</span>
                  <span class="cred-reminder" :class="f.reminder.state">{{ reminderLabel(f.reminder) }}</span>
                </span>
              </button>
            </div>
          </section>
        </template>

        <template v-else>
          <div v-if="itemGroups.length === 0" class="cred-state nv-empty">
            <strong>{{ t('settings.credentials.empty-inventory-title') }}</strong>
            <span>{{ t('settings.credentials.empty-inventory-body') }}</span>
          </div>
          <section v-for="g in itemGroups" :key="g.kind" class="cred-group" :data-kind="g.kind">
            <h3 class="cred-group-title">{{ kindLabel(g.kind) }}<span class="count">{{ g.rows.length }}</span></h3>
            <div class="cred-cards">
              <button v-for="i in g.rows" :key="i.id" type="button" class="cred-card" :class="{ active: selectedId === i.id }" @click="select(i.id)">
                <span class="cred-card-head"><strong v-truncate>{{ i.label }}</strong></span>
                <span v-for="[k, v] in itemKeyDetails(i)" :key="k" class="cred-kv"><span>{{ k }}</span><span v-truncate>{{ v }}</span></span>
              </button>
            </div>
          </section>
        </template>
      </div>

      <aside v-if="selectedFinding" class="cred-drawer" :aria-label="findingTitle(selectedFinding)">
        <div class="cred-drawer-head">
          <h3>{{ findingTitle(selectedFinding) }}</h3>
          <button type="button" :aria-label="t('settings.credentials.drawer.close')" @click="selectedId = ''">×</button>
        </div>
        <span class="cred-sev" :class="selectedFinding.severity">{{ t(`settings.credentials.severity.${selectedFinding.severity}`) }}</span>
        <h4>{{ t('settings.credentials.drawer.location') }}</h4>
        <code class="cred-loc">{{ selectedFinding.location }}</code>
        <h4>{{ t('settings.credentials.drawer.why') }}</h4>
        <p>{{ findingBody(selectedFinding) }}</p>
        <template v-if="selectedFinding.manualFix">
          <h4>{{ t('settings.credentials.drawer.steps') }}</h4>
          <p class="cred-warn cred-manual-fix">{{ t('settings.credentials.drawer.manual-fix') }}</p>
        </template>
        <template v-else-if="selectedFinding.steps.length">
          <h4>{{ t('settings.credentials.drawer.steps') }}</h4>
          <p class="cred-muted">{{ t('settings.credentials.drawer.steps-note') }}</p>
          <div v-for="step in selectedFinding.steps" :key="step" class="cred-step">
            <code>{{ step }}</code>
            <button type="button" class="cred-copy" @click="copyStep(step)">{{ copiedStep === step ? t('settings.credentials.drawer.copied') : t('settings.credentials.drawer.copy') }}</button>
          </div>
        </template>
        <template v-if="selectedFinding.links.length">
          <h4>{{ t('settings.credentials.drawer.links') }}</h4>
          <ul class="cred-links">
            <li v-for="l in selectedFinding.links" :key="l.url"><a class="cred-link" href="#" @click.prevent="openLink(l.url)">{{ l.label }}</a></li>
          </ul>
        </template>
        <h4>{{ t('settings.credentials.reminder.title') }}</h4>
        <p><span class="cred-reminder" :class="selectedFinding.reminder.state">{{ reminderLabel(selectedFinding.reminder) }}</span></p>
        <p v-if="reminderError" class="cred-error" role="alert">{{ reminderError }}</p>
        <div class="cred-reminder-actions">
          <button v-if="selectedFinding.reminder.state === 'active'" type="button" class="cred-snooze" :disabled="reminderBusy" @click="setReminder(selectedFinding, 'snoozed')">{{ t('settings.credentials.reminder.snooze') }}</button>
          <button v-if="selectedFinding.reminder.state !== 'dismissed'" type="button" class="cred-dismiss" :disabled="reminderBusy" @click="setReminder(selectedFinding, 'dismissed')">{{ t('settings.credentials.reminder.dismiss') }}</button>
          <button v-if="selectedFinding.reminder.state !== 'active'" type="button" class="cred-reactivate" :disabled="reminderBusy" @click="setReminder(selectedFinding, 'active')">{{ t('settings.credentials.reminder.reactivate') }}</button>
        </div>
        <p class="cred-muted">{{ t('settings.credentials.drawer.no-reveal') }}</p>
      </aside>

      <aside v-else-if="selectedItem" class="cred-drawer" :aria-label="selectedItem.label">
        <div class="cred-drawer-head">
          <h3>{{ selectedItem.label }}</h3>
          <button type="button" :aria-label="t('settings.credentials.drawer.close')" @click="selectedId = ''">×</button>
        </div>
        <span class="cred-tag">{{ kindLabel(selectedItem.kind) }}</span>
        <h4>{{ t('settings.credentials.drawer.details') }}</h4>
        <dl class="cred-dl">
          <template v-for="(v, k) in selectedItem.detail" :key="k">
            <dt>{{ k }}</dt>
            <dd>{{ String(v) }}</dd>
          </template>
        </dl>
        <p class="cred-muted">{{ t('settings.credentials.drawer.no-reveal') }}</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.cred-pane { display: flex; flex: 1; min-height: 0; flex-direction: column; padding: 16px 22px 18px; gap: 12px; overflow: hidden; color: var(--text-primary); }
.cred-toolbar, .cred-toolbar-actions, .cred-drawer-head, .cred-root-add, .cred-step { display: flex; align-items: center; gap: 10px; }
.cred-toolbar { justify-content: space-between; align-items: flex-start; }
.cred-toolbar h2 { margin: 0; font-size: 15px; color: var(--text-bright); }
.cred-toolbar p { margin: 3px 0 0; color: var(--text-secondary); font-size: var(--font-2xs); }
.cred-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.cred-keyring.ok { color: var(--success-fg); }
.cred-keyring.bad { color: var(--attention-fg); }
button, input { font: inherit; }
button { border: 1px solid var(--border-default); border-radius: var(--radius-control); background: var(--bg-muted); color: var(--text-primary); padding: 5px 9px; cursor: pointer; }
button:hover:not(:disabled) { background: var(--bg-elevated); color: var(--text-bright); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent-emphasis); outline-offset: 2px; }
input { min-width: 0; border: 1px solid var(--border-default); border-radius: var(--radius-control); background: var(--bg-base); color: var(--text-primary); padding: 7px 8px; }
.cred-error { margin: 0; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--danger-fg) 45%, var(--border-default)); border-radius: var(--radius-control); color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 8%, var(--bg-subtle)); font-size: var(--font-2xs); }
.cred-warn { margin: 0; padding: 8px 10px; border-left: 3px solid var(--attention-fg); background: color-mix(in srgb, var(--attention-fg) 8%, var(--bg-subtle)); font-size: var(--font-2xs); }
.cred-banner { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-left: 3px solid var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 8%, var(--bg-subtle)); font-size: var(--font-2xs); }
.cred-banner strong { color: var(--danger-fg); }
.cred-scanned, .cred-muted { margin: 0; color: var(--text-secondary); font-size: var(--font-3xs); }
.cred-roots { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--border-default); border-radius: var(--radius-card); background: var(--bg-subtle); }
.cred-roots h3, .cred-roots h4 { margin: 0; font-size: var(--font-xs); color: var(--text-bright); }
.cred-roots p { margin: 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.cred-root-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.cred-root-list li { display: flex; align-items: center; gap: 8px; font-size: var(--font-2xs); }
.cred-root-list code { flex: 1; min-width: 0; font-family: Menlo, Monaco, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cred-root-add input { flex: 1; }
.cred-filterbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cred-chips, .cred-view-switch { display: flex; flex-wrap: wrap; gap: 4px; }
.cred-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: var(--radius-pill); font-size: var(--font-2xs); }
.cred-chip.on, .cred-view-switch button.on { background: var(--bg-elevated); color: var(--text-bright); font-weight: 600; }
.cred-chip .count { font-size: var(--font-3xs); opacity: 0.6; font-variant-numeric: tabular-nums; }
.cred-search { flex: 1; min-width: 140px; max-width: 260px; }
.cred-view-switch { margin-left: auto; }
.cred-body { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; flex: 1; gap: 12px; }
.cred-body.drawer-open { grid-template-columns: minmax(0, 1fr) minmax(300px, 380px); }
.cred-main { min-width: 0; min-height: 0; overflow-y: auto; }
.cred-state { display: flex; flex-direction: column; gap: 4px; padding: 18px 8px; color: var(--text-secondary); font-size: var(--font-2xs); text-align: center; }
.cred-state strong { color: var(--text-bright); }
.cred-group { margin-bottom: 16px; }
.cred-group-title { display: flex; align-items: baseline; gap: 6px; margin: 0 2px 8px; font-size: var(--font-2xs); font-weight: 700; color: var(--text-secondary); }
.cred-group-title .count { font-size: var(--font-3xs); font-weight: 500; opacity: 0.6; }
.cred-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.cred-card { display: flex; flex-direction: column; align-items: stretch; gap: 5px; padding: 9px 11px; text-align: left; border: 1px solid var(--border-muted); border-radius: var(--radius-card); background: var(--bg-subtle); min-width: 0; }
.cred-card:hover:not(:disabled) { background: var(--bg-muted); border-color: var(--border-default); }
.cred-card.active { border-color: var(--accent-fg, var(--border-emphasis)); background: var(--bg-muted); }
.cred-card.quiet { opacity: 0.6; }
.cred-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.cred-card-head strong { font-size: var(--font-xs); color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cred-card-loc { font-family: Menlo, Monaco, monospace; font-size: var(--font-3xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cred-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.cred-kv { display: flex; gap: 6px; font-size: var(--font-3xs); color: var(--text-secondary); min-width: 0; }
.cred-kv > span:first-child { flex: none; opacity: 0.7; }
.cred-kv > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cred-tag { display: inline-block; padding: 1px 6px; border-radius: var(--radius-pill); border: 1px solid var(--border-muted); font-size: var(--font-3xs); color: var(--text-secondary); white-space: nowrap; flex: none; }
.cred-sev { display: inline-block; align-self: flex-start; border-radius: var(--radius-pill); padding: 2px 7px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; flex: none; }
.cred-sev.high { color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 12%, transparent); }
.cred-sev.medium { color: var(--attention-fg); background: color-mix(in srgb, var(--attention-fg) 12%, transparent); }
.cred-sev.low { color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 12%, transparent); }
.cred-reminder { font-size: var(--font-3xs); color: var(--text-secondary); }
.cred-reminder.active { color: var(--text-primary); }
.cred-drawer { display: flex; flex-direction: column; gap: 6px; min-height: 0; overflow-y: auto; padding: 12px; border: 1px solid var(--border-default); border-radius: var(--radius-card); background: var(--bg-subtle); font-size: var(--font-2xs); }
.cred-drawer-head { justify-content: space-between; }
.cred-drawer h3 { margin: 0; font-size: var(--font-md); color: var(--text-bright); }
.cred-drawer h4 { margin: 8px 0 0; font-size: var(--font-3xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
.cred-drawer p { margin: 0; line-height: 1.45; }
.cred-loc { font-family: Menlo, Monaco, monospace; font-size: var(--font-3xs); word-break: break-all; }
.cred-step { align-items: flex-start; padding: 6px 8px; border: 1px solid var(--border-muted); border-radius: var(--radius-control); background: var(--bg-base); }
.cred-step code { flex: 1; min-width: 0; font-family: Menlo, Monaco, monospace; font-size: var(--font-3xs); white-space: pre-wrap; word-break: break-all; }
.cred-links { margin: 0; padding-left: 18px; }
.cred-link { color: var(--accent-fg, var(--text-bright)); }
.cred-reminder-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.cred-dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
.cred-dl dt { color: var(--text-secondary); }
.cred-dl dd { margin: 0; font-family: Menlo, Monaco, monospace; word-break: break-all; }
@media (max-width: 760px) { .cred-body.drawer-open { grid-template-columns: minmax(0, 1fr); } }
</style>
