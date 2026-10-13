<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import {
  parseConflicts, buildResolved, countConflicts, hasConflicts,
  type FileSection, type ConflictChoice,
} from '../lib/conflict-parser'
import type { GitTransport } from '#git-feature'
import type { GitFileAccessPort } from '../ports/gitSurface'
// Type-only — erased at build time, so this never pulls useGit into a bundle.
import type { ConflictStages } from '../composables/useGit'

const props = defineProps<{
  workspacePath: string
  filepath: string
  name: string
  gitTransport: GitTransport
  fileAccess: GitFileAccessPort
  // injected by parent when merge is no longer in progress (abort)
  mergeAborted?: boolean
}>()

const emit = defineEmits<{ resolved: [] }>()

const notify = useNotify()

const content = ref<string | null>(null)
const loading = ref(false)
const loadError = ref('')
const applying = ref(false)
// Detail close preparation freezes mutations only when a parent opts in through
// the exposed private handle; standalone ConflictPane instances stay mutable.
const closePrepared = ref(false)

// The index's three merge stages (`git show :1:/:2:/:3:`), fetched alongside
// the working-tree file. Only used to (a) reveal the common ancestor the file
// itself does not carry unless the user runs diff3 conflict style, and (b)
// recognise a binary conflict, which has no text merge to offer at all.
const stages = ref<ConflictStages | null>(null)
const showBase = ref(false)
/** A binary conflict: the transport returns empty stages plus this flag. */
const binaryConflict = computed(() => stages.value?.binary === true)
/** The base toggle is offered only when stage 1 exists (add/add has none). */
const canShowBase = computed(
  () => stages.value?.ok === true && stages.value.has_base && !stages.value.binary,
)
const baseText = computed(() => stages.value?.base ?? '')

const sections = computed<FileSection[]>(() =>
  content.value !== null ? parseConflicts(content.value) : [],
)
const totalConflicts = computed(() => countConflicts(sections.value))

// per-conflict-index choice: 'ours' | 'theirs' | 'both' | 'manual'
const choices = ref(new Map<number, ConflictChoice>())
// per-conflict-index manual edit text
const manualEdits = ref(new Map<number, string>())
// Saves the non-manual choice that was active before the user clicked "Edit",
// so Cancel can restore it instead of dropping the resolution entirely.
const _priorChoice = ref(new Map<number, ConflictChoice>())
const editingIdx = ref<number | null>(null)
const editBuf = ref('')

const resolvedCount = computed(() => choices.value.size)
const allResolved = computed(() => resolvedCount.value >= totalConflicts.value && totalConflicts.value > 0)

async function loadFile(): Promise<void> {
  loading.value = true
  loadError.value = ''
  choices.value = new Map()
  manualEdits.value = new Map()
  _priorChoice.value = new Map()
  editingIdx.value = null
  stages.value = null
  void loadStages()
  try {
    const resp = await props.fileAccess.readFile(props.workspacePath, props.filepath)
    if (resp.ok) {
      const raw = resp.content ?? ''
      if (!hasConflicts(raw)) {
        loadError.value = 'This file has no conflict markers'
      } else {
        content.value = raw
      }
    } else {
      loadError.value = resp.error || 'Failed to read file'
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Failed to read file'
  } finally {
    loading.value = false
  }
}

/** Merge stages are a side channel: a failure here only costs the base view,
 *  so it never surfaces as a load error on the merge itself. */
async function loadStages(): Promise<void> {
  const target = props.filepath
  try {
    const resp = await props.gitTransport.send<ConflictStages>(
      'git.conflict_stages',
      { workspace_path: props.workspacePath, filepath: target },
    )
    if (props.filepath !== target) return
    stages.value = resp.payload ?? null
  } catch {
    stages.value = null
  }
}

watch(
  () => props.gitTransport.status.value,
  (s) => { if (s === 'connected' && content.value === null && !loadError.value) void loadFile() },
  { immediate: true },
)
watch([() => props.filepath], () => {
  content.value = null
  loadError.value = ''
  showBase.value = false
  void loadFile()
})

function choose(conflictIdx: number, choice: ConflictChoice): void {
  if (closePrepared.value) return
  if (choice === 'manual') {
    // Auto-save current in-progress edit before switching to another conflict's textarea
    if (editingIdx.value !== null && editingIdx.value !== conflictIdx) {
      manualEdits.value = new Map(manualEdits.value).set(editingIdx.value, editBuf.value)
    }
    // Remember the current non-manual choice so Cancel can restore it
    const existing = choices.value.get(conflictIdx)
    if (existing !== undefined && existing !== 'manual') {
      _priorChoice.value = new Map(_priorChoice.value).set(conflictIdx, existing)
    }
    const sec = sections.value.filter((s) => s.kind === 'conflict')[conflictIdx]
    if (sec?.kind === 'conflict') {
      editBuf.value = manualEdits.value.get(conflictIdx) ?? sec.ours.join('\n')
      editingIdx.value = conflictIdx
    }
    choices.value = new Map(choices.value).set(conflictIdx, 'manual')
  } else {
    editingIdx.value = null
    choices.value = new Map(choices.value).set(conflictIdx, choice)
  }
}

function saveManual(conflictIdx: number): void {
  if (closePrepared.value) return
  manualEdits.value = new Map(manualEdits.value).set(conflictIdx, editBuf.value)
  // No longer need the pre-manual backup
  if (_priorChoice.value.has(conflictIdx)) {
    const next = new Map(_priorChoice.value)
    next.delete(conflictIdx)
    _priorChoice.value = next
  }
  editingIdx.value = null
}

function cancelManual(conflictIdx: number): void {
  if (closePrepared.value) return
  if (!manualEdits.value.has(conflictIdx)) {
    const prior = _priorChoice.value.get(conflictIdx)
    if (prior !== undefined) {
      // Restore the choice that was active before the user clicked "Edit"
      choices.value = new Map(choices.value).set(conflictIdx, prior)
    } else {
      // No prior choice and no confirmed manual edit — revert to unresolved
      const next = new Map(choices.value)
      next.delete(conflictIdx)
      choices.value = next
    }
    if (_priorChoice.value.has(conflictIdx)) {
      const next = new Map(_priorChoice.value)
      next.delete(conflictIdx)
      _priorChoice.value = next
    }
  }
  editingIdx.value = null
}

async function applyAndStage(): Promise<void> {
  if (closePrepared.value || !allResolved.value || applying.value) return
  // Flush any in-progress textarea edit before applying
  if (editingIdx.value !== null) {
    manualEdits.value = new Map(manualEdits.value).set(editingIdx.value, editBuf.value)
    editingIdx.value = null
  }
  applying.value = true
  try {
    const resolved = buildResolved(sections.value, choices.value, manualEdits.value)
    const writeResp = await props.fileAccess.writeFile(props.workspacePath, props.filepath, resolved)
    if (!writeResp.ok) {
      notify.toast(writeResp.error || 'Write failed', { type: 'error' })
      return
    }
    const stageResp = await props.gitTransport.send<{ ok: boolean; error?: string }>(
      'git.stage',
      { workspace_path: props.workspacePath, files: [props.filepath] },
    )
    if (!(stageResp.ok && stageResp.payload?.ok)) {
      notify.toast(stageResp.payload?.error || 'Stage failed', { type: 'error' })
      return
    }
    notify.toast(`${props.name} conflicts resolved`, { type: 'success' })
    emit('resolved')
  } catch (e) {
    notify.toast(e instanceof Error ? e.message : 'Apply failed', { type: 'error' })
  } finally {
    applying.value = false
  }
}

// helpers to split sections by kind for rendering
interface RenderBlock {
  type: 'context' | 'conflict'
  conflictIdx?: number
  lines?: string[]
  ours?: string[]
  base?: string[]
  hasBase?: boolean
  theirs?: string[]
  oursLabel?: string
  theirsLabel?: string
}

const blocks = computed<RenderBlock[]>(() => {
  let ci = 0
  return sections.value.map((s) => {
    if (s.kind === 'context') return { type: 'context', lines: s.lines }
    const b: RenderBlock = {
      type: 'conflict',
      conflictIdx: ci,
      ours: s.ours,
      base: s.base,
      hasBase: s.hasBase,
      theirs: s.theirs,
      oursLabel: s.oursLabel,
      theirsLabel: s.theirsLabel,
    }
    ci++
    return b
  })
})

function reloadFile(): void {
  if (!closePrepared.value) void loadFile()
}

function updateEditBuffer(event: Event): void {
  if (!closePrepared.value) editBuf.value = (event.target as HTMLTextAreaElement).value
}

function undoChoice(conflictIdx: number): void {
  if (!closePrepared.value) choices.value = new Map([...choices.value].filter(([key]) => key !== conflictIdx))
}

function choiceOf(idx: number): ConflictChoice | undefined {
  return choices.value.get(idx)
}

function getCloseState(): 'accepted' | 'refused' | 'busy' {
  if (closePrepared.value || applying.value) return 'busy'
  if (editingIdx.value !== null || choices.value.size > 0 || manualEdits.value.size > 0) return 'refused'
  return 'accepted'
}

function setClosePrepared(prepared: boolean): void {
  closePrepared.value = prepared
}

defineExpose({ getCloseState, setClosePrepared })
</script>

<template>
  <div class="cp-root">
    <!-- Toolbar -->
    <div class="cp-toolbar">
      <span class="cp-badge conflict">{{ $t('label.conflict') }}</span>
      <span class="cp-filepath" v-truncate>{{ filepath }}</span>
      <span class="cp-progress">{{ resolvedCount }} / {{ totalConflicts }} resolved</span>
      <button
        v-if="canShowBase"
        class="cp-btn cp-base-toggle"
        :class="{ active: showBase }"
        :title="$t('action.toggle-base')"
        @click="showBase = !showBase"
      >{{ $t('label.merge-base') }}</button>
      <button
        class="cp-apply"
        :disabled="closePrepared || !allResolved || applying || !!mergeAborted || binaryConflict"
        :title="allResolved ? 'Write and stage this file' : 'Resolve all conflicts first'"
        @click="applyAndStage"
      >
        {{ applying ? 'Applying…' : 'Apply & Stage' }}
      </button>
      <button class="cp-reload" title="Reload" :disabled="closePrepared" @click="reloadFile">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
      </button>
    </div>

    <!-- Body -->
    <div class="cp-body">
      <div v-if="loading" class="cp-msg">{{ $t('label.loading') }}</div>
      <div v-else-if="mergeAborted" class="cp-msg warn">{{ $t('status.merge-aborted') }}</div>
      <!-- A binary conflict has no text to merge — say so instead of showing an
           empty merge view (the transport returns empty stages plus the flag). -->
      <div v-else-if="binaryConflict" class="cp-msg warn">{{ $t('label.binary-conflict') }}</div>
      <div v-else-if="loadError" class="cp-msg err">{{ loadError }}</div>
      <div v-else-if="content === null" class="cp-msg">{{ $t('label.not-loaded') }}</div>

      <template v-else>
        <!-- Common ancestor, VS Code's "toggle base": the whole stage-1 file,
             which is the only base available when the file is not written in
             diff3 conflict style. -->
        <div v-if="showBase" class="cp-base-panel">
          <div class="cp-base-head">{{ $t('label.common-ancestor') }}</div>
          <pre class="cp-base-text">{{ baseText }}</pre>
        </div>

        <div v-for="(block, bi) in blocks" :key="bi">
          <!-- Context block -->
          <div v-if="block.type === 'context'" class="cp-context">
            <pre class="cp-ctx-text">{{ block.lines!.join('\n') }}</pre>
          </div>

          <!-- Conflict block -->
          <div v-else class="cp-conflict" :class="{ resolved: choiceOf(block.conflictIdx!) !== undefined }">
            <!-- Conflict header -->
            <div class="cp-conflict-head">
              <span class="cp-ci-num">#{{ block.conflictIdx! + 1 }}</span>
              <span class="cp-head-label ours">◀ {{ block.oursLabel || 'HEAD (ours)' }}</span>
              <span class="cp-head-sep">vs</span>
              <span class="cp-head-label theirs">▶ {{ block.theirsLabel || 'theirs' }}</span>
              <div class="cp-conflict-actions">
                <button
                  class="cp-btn" :class="{ active: choiceOf(block.conflictIdx!) === 'ours' }" :disabled="closePrepared"
                  @click="choose(block.conflictIdx!, 'ours')"
                >{{ $t('action.accept-ours') }}</button>
                <button
                  class="cp-btn" :class="{ active: choiceOf(block.conflictIdx!) === 'theirs' }" :disabled="closePrepared"
                  @click="choose(block.conflictIdx!, 'theirs')"},{
                >{{ $t('action.accept-theirs') }}</button>
                <button
                  class="cp-btn" :class="{ active: choiceOf(block.conflictIdx!) === 'both' }" :disabled="closePrepared"
                  @click="choose(block.conflictIdx!, 'both')"},{
                >{{ $t('action.accept-both') }}</button>
                <button
                  v-if="showBase && block.hasBase"
                  class="cp-btn" :class="{ active: choiceOf(block.conflictIdx!) === 'base' }" :disabled="closePrepared"
                  @click="choose(block.conflictIdx!, 'base')"},{
                >{{ $t('action.accept-base') }}</button>
                <button
                  class="cp-btn edit-btn" :class="{ active: choiceOf(block.conflictIdx!) === 'manual' }" :disabled="closePrepared"
                  @click="choose(block.conflictIdx!, 'manual')"},{
                >{{ $t('action.edit') }}</button>
              </div>
            </div>

            <!-- Manual edit textarea -->
            <div v-if="editingIdx === block.conflictIdx" class="cp-manual-edit">
              <textarea
                :value="editBuf"
                :disabled="closePrepared"
                @input="updateEditBuffer"
                class="cp-manual-ta"
                spellcheck="false"
                rows="6"
              />
              <div class="cp-manual-actions">
                <button class="cp-btn primary" :disabled="closePrepared" @click="saveManual(block.conflictIdx!)">{{ $t('action.confirm') }}</button>
                <button class="cp-btn" :disabled="closePrepared" @click="cancelManual(block.conflictIdx!)">{{ $t('action.cancel') }}</button>
              </div>
            </div>

            <!-- Side-by-side diff -->
            <div v-else class="cp-sbs" :class="{ 'with-base': showBase && block.hasBase }">
              <!-- Ours -->
              <div
                class="cp-side ours-side"
                :class="{
                  'side-chosen': choiceOf(block.conflictIdx!) === 'ours' || choiceOf(block.conflictIdx!) === 'both',
                  'side-rejected': choiceOf(block.conflictIdx!) === 'theirs' || choiceOf(block.conflictIdx!) === 'base',
                }"
              >
                <div v-for="(line, li) in block.ours" :key="li" class="cp-line">
                  <span class="cp-lno">{{ li + 1 }}</span>
                  <span class="cp-ltext">{{ line }}</span>
                </div>
                <div v-if="!block.ours!.length" class="cp-empty-side">(empty)</div>
              </div>
              <!-- Base (diff3 conflict style only) -->
              <div
                v-if="showBase && block.hasBase"
                class="cp-side base-side"
                :class="{ 'side-chosen': choiceOf(block.conflictIdx!) === 'base' }"
              >
                <div v-for="(line, li) in block.base" :key="li" class="cp-line">
                  <span class="cp-lno">{{ li + 1 }}</span>
                  <span class="cp-ltext">{{ line }}</span>
                </div>
                <div v-if="!block.base!.length" class="cp-empty-side">(empty)</div>
              </div>
              <!-- Theirs -->
              <div
                class="cp-side theirs-side"
                :class="{
                  'side-chosen': choiceOf(block.conflictIdx!) === 'theirs' || choiceOf(block.conflictIdx!) === 'both',
                  'side-rejected': choiceOf(block.conflictIdx!) === 'ours' || choiceOf(block.conflictIdx!) === 'base',
                }"
              >
                <div v-for="(line, li) in block.theirs" :key="li" class="cp-line">
                  <span class="cp-lno">{{ li + 1 }}</span>
                  <span class="cp-ltext">{{ line }}</span>
                </div>
                <div v-if="!block.theirs!.length" class="cp-empty-side">(empty)</div>
              </div>
            </div>

            <!-- Resolution preview -->
            <div v-if="choiceOf(block.conflictIdx!) !== undefined && editingIdx !== block.conflictIdx" class="cp-preview">
              <span class="cp-preview-label">
                <template v-if="choiceOf(block.conflictIdx!) === 'ours'">✓ Accepted Ours</template>
                <template v-else-if="choiceOf(block.conflictIdx!) === 'theirs'">✓ Accepted Theirs</template>
                <template v-else-if="choiceOf(block.conflictIdx!) === 'both'">✓ Accepted Both</template>
                <template v-else-if="choiceOf(block.conflictIdx!) === 'base'">✓ {{ $t('label.accepted-base') }}</template>
                <template v-else>✓ Manually edited</template>
              </span>
              <button class="cp-undo-btn" :disabled="closePrepared" @click="undoChoice(block.conflictIdx!)">Undo</button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cp-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}

/* ── Toolbar ─────────────────────────────────────────────────────────── */
.cp-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  flex-shrink: 0;
  font-size: 12px;
}
.cp-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}
.cp-badge.conflict { background: var(--danger-subtle); color: var(--danger-fg); }
.cp-filepath {
  flex: 1;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Menlo, monospace;
}
.cp-progress { color: var(--text-muted); font-size: 11px; flex-shrink: 0; white-space: nowrap; }
.cp-apply {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--accent-emphasis);
  background: color-mix(in srgb, var(--accent-emphasis) 18%, transparent);
  color: var(--accent-fg);
  cursor: pointer;
  flex-shrink: 0;
}
.cp-apply:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-emphasis) 35%, transparent); }
.cp-apply:disabled { opacity: 0.4; cursor: default; }
.cp-reload {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px;
  background: transparent; border: none; border-radius: 4px;
  color: var(--text-muted); cursor: pointer;
}
.cp-reload:hover { background: var(--bg-muted); color: var(--text-primary); }

/* ── Body ─────────────────────────────────────────────────────────────── */
.cp-body { flex: 1; overflow-y: auto; }
.cp-msg { padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px; }
.cp-msg.err { color: var(--danger-fg); }
.cp-msg.warn { color: var(--warning-fg); }

/* Context block */
.cp-context {
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-base);
}
.cp-ctx-text {
  margin: 0;
  padding: 4px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

/* Conflict block */
.cp-conflict {
  border: 1px solid var(--danger-fg);
  border-left-width: 3px;
  margin: 6px 8px;
  border-radius: 4px;
  overflow: hidden;
}
.cp-conflict.resolved {
  border-color: var(--success-fg);
}
.cp-conflict-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: color-mix(in srgb, var(--danger-fg) 8%, transparent);
  border-bottom: 1px solid var(--border-muted);
  flex-wrap: wrap;
}
.cp-conflict.resolved .cp-conflict-head {
  background: color-mix(in srgb, var(--success-fg) 7%, transparent);
}
.cp-ci-num {
  font-size: 10px;
  font-weight: 700;
  color: var(--danger-fg);
  flex-shrink: 0;
}
.cp-conflict.resolved .cp-ci-num { color: var(--success-fg); }
.cp-head-label { font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
.cp-head-label.ours { color: var(--attention-fg); }
.cp-head-label.theirs { color: var(--accent-fg); }
.cp-head-sep { font-size: 10px; color: var(--text-muted); }
.cp-conflict-actions { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; flex-wrap: wrap; }

.cp-btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--border-muted);
  background: var(--bg-muted);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.cp-btn:hover { background: var(--bg-base); }
.cp-btn.active { border-color: var(--accent-emphasis); background: color-mix(in srgb, var(--accent-emphasis) 20%, transparent); color: var(--accent-fg); }
.cp-btn.primary { border-color: var(--accent-emphasis); background: color-mix(in srgb, var(--accent-emphasis) 25%, transparent); color: var(--accent-fg); }
.cp-btn.edit-btn.active { border-color: var(--attention-fg); background: var(--attention-subtle); color: var(--attention-fg); }

/* Common-ancestor panel (the "Base" toggle) */
.cp-base-toggle { flex-shrink: 0; }
.cp-base-panel {
  margin: 6px 8px 0;
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  overflow: hidden;
}
.cp-base-head {
  padding: 3px 8px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
}
.cp-base-text {
  margin: 0;
  padding: 4px 12px;
  max-height: 220px;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}

/* Side-by-side */
.cp-sbs { display: grid; grid-template-columns: 1fr 1fr; }
.cp-sbs.with-base { grid-template-columns: 1fr 1fr 1fr; }
.cp-side {
  padding: 4px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  transition: opacity 0.15s;
}
.cp-side.ours-side { background: color-mix(in srgb, var(--warning-fg) 6%, transparent); border-right: 1px solid var(--border-muted); }
.cp-side.base-side { background: var(--bg-subtle); border-right: 1px solid var(--border-muted); }
.cp-side.theirs-side { background: color-mix(in srgb, var(--accent-fg) 6%, transparent); }
.cp-side.side-chosen { opacity: 1; }
.cp-side.side-rejected { opacity: 0.3; }
.cp-line { display: flex; align-items: flex-start; }
.cp-lno { width: 36px; flex-shrink: 0; text-align: right; padding-right: 8px; color: var(--text-muted); user-select: none; font-size: 11px; }
.cp-ltext { white-space: pre-wrap; word-break: break-all; color: var(--text-primary); }
.cp-empty-side { padding: 4px 8px; color: var(--text-muted); font-size: 11px; font-style: italic; }

/* Manual edit */
.cp-manual-edit { padding: 8px; background: var(--bg-subtle); }
.cp-manual-ta {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-base);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 6px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
}
.cp-manual-ta:focus { border-color: var(--accent-emphasis); }
.cp-manual-actions { display: flex; gap: 6px; margin-top: 6px; justify-content: flex-end; }

/* Resolution preview strip */
.cp-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  background: color-mix(in srgb, var(--success-fg) 7%, transparent);
  border-top: 1px solid var(--border-muted);
  font-size: 11px;
}
.cp-preview-label { color: var(--success-fg); flex: 1; }
.cp-undo-btn {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid var(--border-muted);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.cp-undo-btn:hover { color: var(--text-primary); background: var(--bg-muted); }
</style>
