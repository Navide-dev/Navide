<script setup lang="ts">
// Editable keyboard shortcuts.
//
// Rows are generated from the command manifest joined with defaults.ts, so the
// list can never drift from the bindings the resolver actually runs, and it
// includes the commands that ship with no key at all — the ones a user most
// needs to reach. Keys the central rule table does not own (terminal control
// sequences, the Electron menu) are appended as read-only reference sections.
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import SettingsOverflowActions from './settings/SettingsOverflowActions.vue'
import {
  buildRows,
  classifyRow,
  conflictsByRow,
  resetRow,
  reviewImportedRules,
  serializeUserRules,
  setRowKeys,
  type BindingRow,
} from '@navide/plugin-ui/shared'
import { commandI18nKey } from '@navide/plugin-ui/shared'
import { formatKeySpec, keySpecToTokens } from '@navide/plugin-ui/shared'
import {
  MENU_OWNED_SPECS,
  nativeMenuKeys,
  TERMINAL_KEYS,
  splitKeyTokens,
  type ExternalKeyRow,
} from '@navide/plugin-ui/shared'
import { FN_KEY, validateKeySpec } from '@navide/plugin-ui/shared'
import {
  getUserRules,
  onUserRulesChanged,
  saveUserRules,
} from '@navide/plugin-ui/shared'
import type { KeybindingRule } from '@navide/plugin-ui/shared'
import { useKeyChordRecorder } from '../composables/useKeyChordRecorder'
import { useFnKeyRecorder } from '../voice/fnKeyRecorder'
import { HOLD_TO_TALK_COMMAND } from '../voice/voiceSettings'
import KeyRecorderFeedback from './settings/KeyRecorderFeedback.vue'

type FilterMode = 'all' | 'customized' | 'conflicts'

const props = defineProps<{
  /** Search text to open with, e.g. a command id another settings page links to. */
  initialQuery?: string
}>()

const { t, te } = useI18n()

/**
 * Translated command title, falling back to the label derived from the id.
 * A command added without an i18n entry then shows a readable English name
 * rather than a blank cell.
 */
/**
 * A command bound under several conditions is named per condition where the
 * locale has a name for it (Close Dialog: any dialog, outside a terminal, the
 * Plan window), so the list does not repeat one title three times.
 */
function whenVariant(when: string | undefined): string {
  if (!when) return ''
  if (/\bplanWindow\b/.test(when)) return 'planWindow'
  if (/!\s*terminalFocus\b/.test(when)) return 'notTerminal'
  return ''
}
function labelFor(row: BindingRow): string {
  const variant = whenVariant(row.when)
  const variantKey = `settings.keybindings.cmdWhen.${row.command.replace(/\./g, '_')}.${variant}`
  if (variant && te(variantKey)) return t(variantKey)
  const key = commandI18nKey(row.command)
  return te(key) ? t(key) : row.label
}

/** A group heading in the UI language; the catalog's English name otherwise. */
function categoryLabel(row: BindingRow): string {
  const key = `settings.keybindings.category.${row.command.split('.')[0]}`
  return te(key) ? t(key) : row.category
}

const userRules = ref<KeybindingRule[]>([...getUserRules()])
const query = ref(props.initialQuery ?? '')
const filterMode = ref<FilterMode>('all')
const saveError = ref('')

const stopWatching = onUserRulesChanged(() => {
  userRules.value = [...getUserRules()]
})
onUnmounted(() => {
  stopWatching()
  if (recording.value) stopRecording()
})

const rows = computed(() => buildRows(userRules.value))
const conflicts = computed(() => conflictsByRow(rows.value))
const customizedCount = computed(() => rows.value.filter((r) => r.customized).length)

function searchText(row: BindingRow): string {
  // Both forms: the rule spelling ("cmd+shift+p") and what the caps show
  // ("⌘⇧P"), so typing either finds the row.
  const keys = row.keys.map((k) => `${k.key} ${formatKeySpec(k.key)}`).join(' ')
  // Both the translated title and the derived English one, so the list stays
  // searchable by either while the UI is in Chinese.
  return `${labelFor(row)} ${row.label} ${row.command} ${row.category} ${row.when ?? ''} ${keys}`
    .toLowerCase()
}

const visibleRows = computed(() => {
  const q = query.value.trim().toLowerCase()
  return rows.value.filter((row) => {
    if (filterMode.value === 'customized' && !row.customized) return false
    if (filterMode.value === 'conflicts' && !conflicts.value.has(row.id)) return false
    if (!q) return true
    return searchText(row).includes(q)
  })
})

// Rows are emitted in defaults.ts order; group headers keep that order readable
// without re-sorting the list out from under the user.
const groupedRows = computed(() => {
  const groups: { category: string; rows: BindingRow[] }[] = []
  for (const row of visibleRows.value) {
    const last = groups[groups.length - 1]
    if (last && last.category === row.category) last.rows.push(row)
    else groups.push({ category: row.category, rows: [row] })
  }
  return groups
})

function hardConflict(row: BindingRow): boolean {
  return (conflicts.value.get(row.id) ?? []).some((c) => c.hard)
}

function conflictTitle(row: BindingRow): string {
  const list = conflicts.value.get(row.id) ?? []
  return list
    .map((c) => {
      // Name the guard each rival waits for. Without it the tooltip says the key
      // is shared but not the thing the user actually needs — which of them wins
      // when they press it, and where.
      const others = c.rows
        .filter((r) => r.id !== row.id)
        .map((r) => `${labelFor(r)}${r.when ? ` (${r.when})` : ''}`)
      const verdict = c.shadowed.some((r) => r.id === row.id)
        ? t('settings.keybindings.conflict-shadowed')
        : t('settings.keybindings.conflict-shared')
      return `${formatKeySpec(c.key)} — ${verdict}\n  ${others.join('\n  ')}`
    })
    .join('\n\n')
}

// ── Persistence ───────────────────────────────────────────────────────────────
async function commit(next: KeybindingRule[]): Promise<void> {
  saveError.value = ''
  userRules.value = next
  const result = await saveUserRules(next)
  saveError.value = result.ok ? '' : (result.error ?? 'write failed')
}

function applyKeys(row: BindingRow, keys: string[]): Promise<void> {
  return commit(setRowKeys(userRules.value, row, keys))
}

function onReset(row: BindingRow): Promise<void> {
  return commit(resetRow(userRules.value, row))
}

function onResetAll(): Promise<void> {
  return commit([])
}

function onRemoveKey(row: BindingRow, key: string): Promise<void> {
  return applyKeys(row, row.keys.map((k) => k.key).filter((k) => k !== key))
}

// ── Recorder ──────────────────────────────────────────────────────────────────
interface Recording {
  rowId: string
  replacing: string | null // the chip being re-recorded, null when adding
}

const recording = ref<Recording | null>(null)
const recorder = useKeyChordRecorder({ onCancel: () => stopRecording() })
// fn (🌐) is only ever a key to hold: listened for on the hold-to-talk row.
const fnRecorder = useFnKeyRecorder(() => recorder.recordKey(FN_KEY))

function isRecordingRow(row: BindingRow): boolean {
  return recording.value?.rowId === row.id
}

function isRecording(row: BindingRow, key: string): boolean {
  const r = recording.value
  return !!r && r.rowId === row.id && r.replacing === key
}

function startRecording(row: BindingRow, replacing: string | null): void {
  if (recording.value) stopRecording()
  recording.value = { rowId: row.id, replacing }
  // A modifier by itself (Right Option, Left ⌘) or fn is only a key to hold.
  const hold = row.command === HOLD_TO_TALK_COMMAND
  recorder.start(hold)
  if (hold) fnRecorder.start()
}

function stopRecording(): void {
  recorder.stop()
  fnRecorder.stop()
  recording.value = null
}

const recordedSpec = recorder.spec

async function confirmRecording(row: BindingRow): Promise<void> {
  const r = recording.value
  const spec = recordedSpec.value
  if (!r || !spec) return
  const current = row.keys.map((k) => k.key)
  const next = r.replacing
    ? current.map((k) => (k === r.replacing ? spec : k))
    : [...current, spec]
  stopRecording()
  // setRowKeys drops anything validateKeySpec rejects, so without this the chip
  // would simply fail to appear with no reason given.
  if (!validateKeySpec(spec).ok) {
    saveError.value = t('settings.keybindings.invalid-key', { key: formatKeySpec(spec) })
    return
  }
  // Adding a key the row already has would silently collapse back to one chip.
  if (!r.replacing && current.includes(spec)) {
    saveError.value = t('settings.keybindings.already-bound', { key: formatKeySpec(spec) })
    return
  }
  await applyKeys(row, next)
}

function clearRecording(): void {
  recorder.clear()
}

// ── Import / export ───────────────────────────────────────────────────────────
const ioBusy = ref(false)
const ioMessage = ref('')
const ioRejected = ref<string[]>([])

interface FileBridge {
  saveJson?: (a: { defaultName?: string; content: string; title?: string })
    => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  openJson?: (a?: { title?: string })
    => Promise<{ ok: boolean; content?: string; canceled?: boolean; error?: string }>
}
const fileBridge = (): FileBridge | undefined =>
  (window as Window & { agentTeam?: FileBridge }).agentTeam

async function onExport(): Promise<void> {
  const api = fileBridge()
  if (!api?.saveJson) return
  ioBusy.value = true
  ioMessage.value = ''
  ioRejected.value = []
  try {
    const result = await api.saveJson({
      title: t('settings.keybindings.export'),
      defaultName: 'navide-keybindings.json',
      content: serializeUserRules(userRules.value),
    })
    if (result.canceled) return
    ioMessage.value = result.ok
      ? t('settings.keybindings.export-done', { count: userRules.value.length })
      : `${t('settings.keybindings.export-failed')} — ${result.error ?? ''}`
  } finally {
    ioBusy.value = false
  }
}

async function onImport(): Promise<void> {
  const api = fileBridge()
  if (!api?.openJson) return
  ioBusy.value = true
  ioMessage.value = ''
  ioRejected.value = []
  try {
    const result = await api.openJson({ title: t('settings.keybindings.import') })
    if (result.canceled) return
    if (!result.ok || typeof result.content !== 'string') {
      ioMessage.value = `${t('settings.keybindings.import-failed')} — ${result.error ?? ''}`
      return
    }
    // Replaces the current set, so the file has to be reviewed first: anything
    // rejected is listed rather than quietly discarded.
    const review = reviewImportedRules(result.content)
    ioRejected.value = review.rejected
    if (!review.rules.length && review.rejected.length) {
      ioMessage.value = t('settings.keybindings.import-failed')
      return
    }
    // Importing replaces rather than merges, and there is no undo, so confirm
    // before discarding work. An empty-but-valid file is the sharpest edge: it
    // parses cleanly and would silently wipe every customisation.
    if (customizedCount.value > 0 && !window.confirm(
      t('settings.keybindings.import-confirm', {
        incoming: review.rules.length,
        current: customizedCount.value,
      }),
    )) return
    await commit(review.rules)
    ioMessage.value = t('settings.keybindings.import-done', {
      count: review.rules.length,
      rejected: review.rejected.length,
    })
  } finally {
    ioBusy.value = false
  }
}

// ── Read-only reference (keys the rule table does not own) ────────────────────
const referenceSections: { key: string; rows: ExternalKeyRow[] }[] = [
  { key: 'terminal', rows: TERMINAL_KEYS },
  { key: 'native', rows: nativeMenuKeys() },
]

// The reference honours the search box too, so looking up "⌘R" finds it here
// rather than appearing to be missing from the app entirely.
const visibleReference = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (filterMode.value !== 'all') return []
  if (!q) return referenceSections
  return referenceSections
    .map((section) => ({
      key: section.key,
      rows: section.rows.filter((row) => {
        const desc = t(`settings.keybindings.reference.desc.${row.desc}`)
        return `${row.keys} ${desc}`.toLowerCase().includes(q)
      }),
    }))
    .filter((section) => section.rows.length > 0)
})
</script>

<template>
  <div class="kse">
    <!-- The page intro sits under the page title (the settings modal renders
         it, with the file's name and place in its tooltip). -->
    <div class="kse-toolbar">
      <input
        v-model="query"
        class="kse-search"
        type="search"
        :placeholder="$t('settings.keybindings.search-placeholder')"
      />
      <div class="kse-filters">
        <button
          v-for="mode in (['all', 'customized', 'conflicts'] as FilterMode[])"
          :key="mode"
          type="button"
          class="kse-filter settings-filter-chip"
          :class="{ active: filterMode === mode }"
          :aria-pressed="filterMode === mode"
          @click="filterMode = mode"
        >{{ $t('settings.keybindings.filter.' + mode) }}<span class="count">{{ mode === 'all' ? rows.length : mode === 'customized' ? rows.filter((row) => row.customized).length : conflicts.size }}</span></button>
      </div>
      <!-- The actions wrap as one group, right-aligned: the usual ones first,
           the often-disabled Reset All last. All three are secondary, so on a
           narrow page they fold into one "⋯" menu beside the filters. -->
      <div class="kse-actions">
        <SettingsOverflowActions>
          <button type="button" class="kse-filter" :disabled="ioBusy" @click="onExport()">
            {{ $t('settings.keybindings.export') }}
          </button>
          <button type="button" class="kse-filter" :disabled="ioBusy" @click="onImport()">
            {{ $t('settings.keybindings.import') }}
          </button>
          <button
            type="button"
            class="kse-reset-all"
            :disabled="!customizedCount"
            @click="onResetAll()"
          >{{ $t('settings.keybindings.reset-all') }}</button>
        </SettingsOverflowActions>
      </div>
    </div>

    <!-- The row icons carry their meaning only in a tooltip; this legend puts it
         in visible text once, above the tables. -->
    <p class="kse-legend">
      <span class="kse-legend-item" :title="$t('settings.keybindings.protected-hint')">
        <span class="kse-locked"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg></span>{{ $t('settings.keybindings.legend-locked') }}
      </span>
      <span class="kse-legend-item" :title="$t('settings.keybindings.menu-owned-hint')">
        <span class="kse-menu-owned"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 14 13H2Z"/><path d="M8 6.5v3M8 11.5v.01"/></svg></span>{{ $t('settings.keybindings.legend-menu-owned') }}
      </span>
    </p>

    <p v-if="customizedCount" class="kse-status">
      {{ $t('settings.keybindings.customized-count', { count: customizedCount }) }}
    </p>
    <p v-if="ioMessage" class="kse-status">{{ ioMessage }}</p>
    <div v-if="ioRejected.length" class="kse-rejected">
      <p>{{ $t('settings.keybindings.import-rejected', { count: ioRejected.length }) }}</p>
      <ul><li v-for="(r, i) in ioRejected" :key="i">{{ r }}</li></ul>
    </div>
    <p v-if="saveError" class="kse-error">
      {{ $t('settings.keybindings.save-failed') }} — {{ saveError }}
    </p>

    <div v-for="group in groupedRows" :key="group.category" class="kse-group">
      <h3 class="kse-group-title">{{ categoryLabel(group.rows[0]) }}</h3>
      <div class="kse-table-scroll kse-bindings-scroll">
        <table class="kse-table kse-bindings">
          <thead>
            <tr>
              <th class="kse-th-command">{{ $t('settings.keybindings.col.command') }}</th>
              <th class="kse-th-keys">{{ $t('settings.keybindings.col.keys') }}</th>
              <th class="kse-th-when">{{ $t('settings.keybindings.col.when') }}</th>
              <th class="kse-th-source">{{ $t('settings.keybindings.col.source') }}</th>
              <th class="kse-th-actions"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in group.rows" :key="row.id" :class="{ customized: row.customized }">
              <td class="kse-td-command">
                <!-- The command id is for keybindings.json, not for reading: it
                     stays searchable and in the tooltip, out of the visible line. -->
                <span class="kse-label" :title="row.command">{{ labelFor(row) }}</span>
                <span class="kse-id" aria-hidden="true">{{ row.command }}</span>
              </td>

              <td class="kse-td-keys" :data-label="$t('settings.keybindings.col.keys')">
                <div class="kse-chips">
                  <!-- The cap being re-recorded is replaced by the recorder,
                       which is rendered once per row at the end of the chips. -->
                  <template v-for="chip in row.keys" :key="chip.key">
                    <span
                      v-if="!isRecording(row, chip.key)"
                      class="kse-chip"
                      :class="{ user: chip.source === 'user' }"
                    >
                      <button
                        type="button"
                        class="kse-chip-keys"
                        :title="$t('settings.keybindings.click-to-rebind')"
                        @click="startRecording(row, chip.key)"
                      >
                        <template v-for="(seg, si) in keySpecToTokens(chip.key)" :key="si">
                          <span v-if="si" class="kse-chord-sep">→</span>
                          <kbd v-for="(tok, ti) in seg" :key="ti">{{ tok }}</kbd>
                        </template>
                      </button>
                      <button
                        v-if="!(row.protected && row.keys.length === 1)"
                        type="button"
                        class="kse-chip-remove"
                        :title="$t('settings.keybindings.remove-binding')"
                        @click="onRemoveKey(row, chip.key)"
                      >✕</button>
                      <span
                        v-else
                        class="kse-locked"
                        :title="$t('settings.keybindings.protected-hint')"
                        :aria-label="$t('settings.keybindings.protected-hint')"
                        role="img"
                      ><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg></span>
                      <span
                        v-if="MENU_OWNED_SPECS.has(chip.key)"
                        class="kse-menu-owned"
                        :title="$t('settings.keybindings.menu-owned-hint')"
                        :aria-label="$t('settings.keybindings.menu-owned-hint')"
                        role="img"
                      ><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 14 13H2Z"/><path d="M8 6.5v3M8 11.5v.01"/></svg></span>
                    </span>
                  </template>

                  <span v-if="isRecordingRow(row)" class="kse-recorder">
                    <span class="kse-recorder-preview">
                      <template v-if="recordedSpec">
                        <template v-for="(seg, si) in keySpecToTokens(recordedSpec)" :key="si">
                          <span v-if="si" class="kse-chord-sep">→</span>
                          <kbd v-for="(tok, ti) in seg" :key="ti">{{ tok }}</kbd>
                        </template>
                      </template>
                      <em v-else>{{ $t('settings.keybindings.press-keys') }}</em>
                    </span>
                    <button type="button" class="kse-mini" :disabled="!recordedSpec" @click="confirmRecording(row)">✓</button>
                    <button type="button" class="kse-mini" @click="clearRecording()">↺</button>
                    <button type="button" class="kse-mini" @click="stopRecording()">✕</button>
                  </span>
                  <button
                    v-else
                    type="button"
                    class="kse-add"
                    :title="$t('settings.keybindings.add-binding')"
                    @click="startRecording(row, null)"
                  >+</button>
                  <KeyRecorderFeedback
                    v-if="isRecordingRow(row)"
                    class="kse-recorder-feedback"
                    :notice="recorder.notice.value"
                    :fn="row.command === HOLD_TO_TALK_COMMAND ? fnRecorder : undefined"
                  />

                  <span v-if="!row.keys.length && !isRecordingRow(row)" class="kse-unbound">
                    {{ $t('settings.keybindings.unbound') }}
                  </span>

                  <span
                    v-if="conflicts.has(row.id)"
                    class="kse-conflict"
                    :class="{ hard: hardConflict(row) }"
                    :title="conflictTitle(row)"
                  >{{ hardConflict(row)
                    ? $t('settings.keybindings.conflict-hard')
                    : $t('settings.keybindings.conflict-soft') }}</span>
                </div>
              </td>

              <td class="kse-td-when" :data-label="$t('settings.keybindings.col.when')">
                <!-- The raw condition is an expression; it waits behind a
                     disclosure for the people who want it. -->
                <details v-if="row.when" class="kse-when-details">
                  <summary>{{ $t('settings.keybindings.when-limited') }}</summary>
                  <code>{{ row.when }}</code>
                </details>
                <span v-else class="kse-when-any">{{ $t('settings.keybindings.when-any') }}</span>
              </td>

              <td class="kse-td-source" :data-label="$t('settings.keybindings.col.source')">
                <span class="kse-source" :class="classifyRow(row)">
                  {{ $t('settings.keybindings.source.' + classifyRow(row)) }}
                </span>
              </td>

              <td class="kse-td-actions">
                <button
                  v-if="row.customized"
                  type="button"
                  class="kse-mini"
                  :title="$t('settings.keybindings.reset-row')"
                  @click="onReset(row)"
                >↺</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p v-if="!groupedRows.length && !visibleReference.length" class="kse-empty">
      {{ $t('settings.keybindings.no-results') }}
    </p>

    <!-- Keys the rule table does not own: listed, never editable. -->
    <div v-if="visibleReference.length" class="kse-reference">
      <p class="kse-reference-intro">{{ $t('settings.keybindings.reference.intro') }}</p>
      <section v-for="section in visibleReference" :key="section.key" class="kse-group">
        <h3 class="kse-group-title">
          {{ $t('settings.keybindings.reference.' + section.key + '.title') }}
          <span class="kse-readonly">{{ $t('settings.keybindings.reference.readonly') }}</span>
        </h3>
        <p class="kse-group-note">{{ $t('settings.keybindings.reference.' + section.key + '.note') }}</p>
        <div class="kse-table-scroll">
          <table class="kse-table">
            <tbody>
              <tr v-for="row in section.rows" :key="row.keys">
                <td class="kse-td-keys">
                  <span class="kse-chips">
                    <template v-for="(p, i) in splitKeyTokens(row.keys)" :key="i">
                      <span v-if="p.type === 'sep'" class="kse-chord-sep">{{ p.value }}</span>
                      <template v-else>
                        <span v-if="p.plus" class="kse-chord-sep">+</span><kbd>{{ p.value }}</kbd>
                      </template>
                    </template>
                  </span>
                </td>
                <td class="kse-td-desc">
                  {{ $t('settings.keybindings.reference.desc.' + row.desc) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <p class="kse-footnote">{{ $t('settings.keybindings.footnote') }}</p>
  </div>
</template>

<style scoped>
.kse {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text-primary);
}

.kse-footnote {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  max-width: 74ch;
  line-height: 1.55;
}
.kse-footnote {
  font-size: var(--font-xs);
  border-top: 1px solid var(--border-muted);
  padding-top: 12px;
}

.kse-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.kse-legend-item {
  display: inline-flex;
  align-items: center;
  cursor: help;
}
.kse-legend .kse-locked,
.kse-legend .kse-menu-owned {
  padding: 0 4px 0 0;
}

/* ── toolbar ── */
.kse-toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  position: sticky;
  /* The scroll container is .keybindings-body, whose 18px/22px gutter sits
     inside the scrollport. The negative margin cancels that gutter so the bar
     starts flush at the top and repaints the full width; its own padding gives
     the gutter back visually, and rows scroll underneath instead of through. */
  top: 0;
  z-index: 3;
  margin: -18px -22px 0;
  padding: 18px 22px 10px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-muted);
}
.kse-search {
  flex: 1 1 220px;
  min-width: 180px;
  padding: 6px 10px;
  font-size: var(--font-sm);
  color: var(--text-primary);
  background: var(--bg-inset);
  border: 1px solid var(--border-default);
  border-radius: 6px;
}
.kse-search:focus {
  outline: none;
  border-color: var(--accent-fg);
}
.kse-filters {
  display: flex;
  gap: 4px;
}
.kse-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
/* Narrow page: the search takes a full row; under it the filter chips start
   at the content edge and the actions sit at the right of the same row while
   they fit, dropping below the chips as one group otherwise. */
.kse-toolbar { container: kse-toolbar / inline-size; }
@container kse-toolbar (max-width: 720px) {
  .kse-search { flex-basis: 100%; }
}
.kse-filter,
.kse-reset-all {
  padding: 5px 10px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  cursor: pointer;
}
/* The filter modes are the Settings window's shared .settings-filter-chip;
   .kse-filter stays the skin of the Export / Import buttons. */
.kse-reset-all:disabled {
  opacity: 0.45;
  cursor: default;
}

.kse-status {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--accent-fg);
}
.kse-rejected {
  border: 1px solid var(--danger-fg, #f85149);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.kse-rejected p {
  margin: 0 0 4px;
  color: var(--danger-fg, #f85149);
  font-weight: 600;
}
.kse-rejected ul {
  margin: 0;
  padding-left: 1.2em;
  font-family: monospace;
  font-size: var(--font-2xs);
}

.kse-error {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--danger-fg, #f85149);
}

/* ── groups & table ── */
.kse-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kse-group-title {
  margin: 0;
  font-size: var(--font-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
}
/* The column header repeats once per category. It earns its place when the page
   is scrolled, but it should read as a ruler, not as five competing headings. */
.kse-table thead th {
  opacity: 0.75;
}
.kse-table-scroll {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  background: var(--bg-subtle);
}
.kse-table {
  width: 100%;
  /* Each category renders its own <table>. With auto layout every one of them
     sizes its columns independently, so the groups do not line up down the page
     — fixed layout plus the explicit widths below keeps one grid throughout. */
  table-layout: fixed;
  border-collapse: collapse;
  font-size: var(--font-sm);
}
.kse-table th {
  text-align: left;
  font-size: var(--font-2xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  font-weight: 600;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-default);
  white-space: nowrap;
}
.kse-table td {
  padding: 7px 12px;
  border-bottom: 1px solid var(--border-muted);
  vertical-align: top;
}
.kse-table tr:last-child td {
  border-bottom: none;
}
.kse-table tr.customized td:first-child {
  box-shadow: inset 2px 0 0 var(--accent-fg);
}
.kse-th-command { width: 34%; }
.kse-th-keys    { width: 30%; }
.kse-th-when    { width: 20%; }
.kse-th-source  { width: 10%; }
.kse-th-actions { width: 6%; }

/* Narrow card: the five-column ruler stops fitting, so each binding becomes a
   block — command title and reset button on top, then one labelled line each
   for keys, condition and source. */
.kse-bindings-scroll { container: kse-bindings / inline-size; }
@container kse-bindings (max-width: 600px) {
  .kse-bindings, .kse-bindings tbody { display: block; }
  .kse-bindings thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  /* Two columns for the labelled lines, shared by all three through a
     subgrid: the labels end on one line and every value (key caps included)
     starts on one line, each label on its value's first baseline. */
  .kse-bindings tr {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr) auto;
    grid-template-areas: 'command command actions' 'keys keys keys' 'when when when' 'source source source';
    column-gap: 12px;
    row-gap: 4px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-muted);
  }
  .kse-bindings tr:last-child { border-bottom: none; }
  .kse-bindings td { display: block; padding: 0; border-bottom: none; }
  .kse-bindings .kse-td-command { grid-area: command; }
  .kse-bindings .kse-td-actions { grid-area: actions; }
  .kse-bindings .kse-td-keys { grid-area: keys; }
  .kse-bindings .kse-td-when { grid-area: when; }
  .kse-bindings .kse-td-source { grid-area: source; }
  .kse-bindings td[data-label] {
    display: grid;
    grid-template-columns: subgrid;
    align-items: baseline;
  }
  .kse-bindings td[data-label] > * { grid-column: 2 / -1; min-width: 0; }
  .kse-bindings td[data-label]::before {
    content: attr(data-label);
    grid-column: 1;
    max-width: 12em;
    font-size: var(--font-xs);
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .kse-bindings .kse-source { justify-self: start; }
}

/* ── source badge ── */
.kse-source {
  display: inline-block;
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  white-space: nowrap;
  border: 1px solid var(--border-muted);
  color: var(--text-muted);
}
.kse-source.modified {
  color: var(--attention-fg, #d29922);
  border-color: var(--attention-fg, #d29922);
}
.kse-source.custom {
  color: var(--accent-fg);
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
}
.kse-source.unbound {
  color: var(--danger-fg, #f85149);
  border-color: var(--danger-fg, #f85149);
}

/* The cell stays a table cell: as a flex box it left the fixed grid and ran
   under the keys column. Label and id stack as blocks instead. */
.kse-label {
  display: block;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.kse-id {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.kse-td-command { position: relative; }

.kse-when-details summary {
  cursor: pointer;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.kse-when-details[open] summary { margin-bottom: 4px; }

.kse-td-when code {
  display: inline-block;
  max-width: 100%;
  font-family: monospace;
  font-size: var(--font-xs);
  line-height: 1.45;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.kse-when-any {
  font-size: var(--font-xs);
  color: var(--text-muted);
}

/* ── key chips ── */
.kse-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
/* Conflict / shared-key notices sit on their own line. Inline they read as part
   of the chord itself, which is exactly the thing they are commenting on. */
.kse-chips .kse-conflict {
  flex-basis: 100%;
  margin-top: 2px;
  /* A full-width line, so it reads as a caption rather than a stretched pill. */
  padding: 0;
  border: none;
  border-radius: 0;
}
.kse-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: var(--bg-inset);
}
.kse-chip.user {
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
}
.kse-chip-keys {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  padding: 2px 6px;
  background: none;
  border: none;
  cursor: pointer;
}
.kse-chip-remove,
.kse-add,
.kse-mini {
  padding: 2px 6px;
  font-size: var(--font-2xs);
  line-height: 1.4;
  color: var(--text-muted);
  background: none;
  border: none;
  cursor: pointer;
}
.kse-add {
  border: 1px dashed var(--border-default);
  border-radius: 6px;
  /* The add placeholder: a readable "+" inside its 28px target. */
  font-size: var(--font-sm);
}
/* 28px targets: the remove "✕" and add "+" are the main actions on a row. */
.kse-chip-remove,
.kse-add,
.kse-mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--control-h-md);
  min-height: var(--control-h-md);
}
.kse-chip-remove:hover,
.kse-add:hover,
.kse-mini:hover {
  color: var(--text-bright);
}
.kse-mini:disabled {
  opacity: 0.35;
  cursor: default;
}

.kse-chips kbd,
.kse-recorder kbd {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--border-default);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 11.5px;
  font-weight: 600;
  font-family: monospace;
  line-height: 1.4;
  white-space: nowrap;
}
.kse-chord-sep {
  color: var(--text-muted);
  font-size: var(--font-2xs);
  padding: 0 2px;
}

.kse-recorder {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border: 1px solid var(--accent-fg);
  border-radius: 6px;
  background: var(--accent-subtle);
}
.kse-recorder-preview {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  min-width: 96px;
}
.kse-recorder-preview em {
  font-style: normal;
  font-size: var(--font-2xs);
  color: var(--accent-fg);
}
.kse-recorder-feedback {
  flex-basis: 100%;
}
.kse-recorder-feedback :deep(.krf-line) {
  padding: 2px 0 0;
}

.kse-locked {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  color: var(--text-secondary);
  cursor: help;
}

/* Sits next to the cap, not in place of the remove button: the binding is still
   editable, it just cannot be cleared by unbinding it here. */
.kse-menu-owned {
  display: inline-flex;
  align-items: center;
  padding: 2px 4px;
  cursor: help;
  color: var(--warn, #d29922);
}

.kse-unbound {
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-style: italic;
  order: -1;
}

.kse-conflict {
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-muted);
  color: var(--text-secondary);
  cursor: help;
}
.kse-conflict.hard {
  color: var(--danger-fg, #f85149);
  border-color: var(--danger-fg, #f85149);
}

.kse-empty {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-muted);
}
</style>
