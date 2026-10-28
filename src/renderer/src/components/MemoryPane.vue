<script setup lang="ts">
/**
 * The instruction files every CLI reads before it starts working — CLAUDE.md,
 * AGENTS.md, QWEN.md, .cursor/rules/*.mdc — listed in one place and editable.
 *
 * The unit is the **file**, not the CLI, because one file is usually read by
 * several: a row therefore carries every reader. Files the backend knows about
 * but that do not exist yet are listed too, so the page can offer to create
 * them rather than hiding what a CLI would load if it were there.
 *
 * Claude Code's auto-memory — the notes Claude writes about the workspace by
 * itself — is listed as a group of its own, so it is never mistaken for a file
 * the user wrote; it goes through the same read/save/restore path.
 *
 * Coverage is honest: a CLI that has no instruction file name of its own — the
 * files it loads are whatever its config names — must not look like one Navide
 * knows a path for, so the footer keeps those two states apart.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import { formatBytes } from '../lib/formatBytes'

type Backend = ReturnType<typeof useBackend>

/** One instruction file on disk, and every CLI that loads it. */
interface MemoryFile {
  scope: 'user' | 'project'
  /** Absolute path — the identity used by `memory.get` / `memory.save`. */
  path: string
  /** Path as shown: relative to the home or the workspace root. */
  relative: string
  /** Agent keys that read this file, sorted. */
  readers: string[]
  /** At least one reader treats it as its own canonical file. */
  canonical: boolean
  exists: boolean
  size: number
  /** Epoch seconds, 0 when the file does not exist. */
  modified: number
  error: string
  /** A Claude Code auto-memory file: written by Claude itself, and `relative`
   *  is relative to the memory folder rather than the workspace. */
  autoMemory: boolean
}

/** One CLI vendor and what Navide knows about its instruction file. */
interface AgentTarget {
  agent: string
  label: string
  /** `mapped` = a path is known; `configured` = the CLI has no file name of its
   *  own and loads whatever its own config names. `unknown` is a defensive
   *  fallback for a state this build does not recognise. */
  state: 'mapped' | 'configured' | 'unknown'
  scopes: string[]
}

const props = defineProps<{
  backend: Backend
  /** Workspace the project-scoped files belong to; empty when none is open. */
  workspacePath?: string
}>()
const { t } = useI18n()

const files = ref<MemoryFile[]>([])
const agents = ref<AgentTarget[]>([])
/** Where Claude keeps its auto-memory for this workspace; empty without one. */
const autoMemoryDir = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
/** Absolute path of the file open in the editor, empty when none is. */
const selectedPath = ref('')
const draftText = ref('')
/** The text as last read or written, so the editor can tell dirty from clean. */
const savedText = ref('')
/** The open file's mtime as the backend last reported it; 0 for a file that
 *  does not exist yet. Sent back on save so a file another writer changed in
 *  the meantime is refused instead of overwritten. */
const expectedModified = ref(0)
/** True once a save was refused because the file moved on under the editor. */
const conflict = ref(false)
/** The version the last save replaced, kept in Navide's own folder; null when
 *  there is none to restore. `savedAt` is epoch seconds. */
const previous = ref<{ savedAt: number; size: number } | null>(null)
/** Set when Navide created the open file, so its creation can be undone by
 *  moving it to the Trash; `createdAt` is epoch seconds. */
const created = ref<{ createdAt: number } | null>(null)
/** The file changed since Navide created it: what Navide wrote and what is
 *  there now, shown before the user agrees to trash it anyway. */
const createdChange = ref<{ created: string; current: string } | null>(null)

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeFile(value: unknown): MemoryFile | null {
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path) return null
  return {
    scope: value.scope === 'user' ? 'user' : 'project',
    path: value.path,
    relative: stringValue(value.relative, value.path),
    readers: Array.isArray(value.readers)
      ? value.readers.filter((item): item is string => typeof item === 'string')
      : [],
    canonical: value.canonical === true,
    exists: value.exists === true,
    size: numberValue(value.size),
    modified: numberValue(value.modified),
    error: stringValue(value.error),
    autoMemory: value.auto_memory === true,
  }
}

function normalizeAgent(value: unknown): AgentTarget | null {
  if (!isRecord(value) || typeof value.agent !== 'string' || !value.agent) return null
  const state = stringValue(value.state)
  return {
    agent: value.agent,
    label: stringValue(value.label, value.agent),
    state: state === 'mapped' || state === 'configured' ? state : 'unknown',
    scopes: Array.isArray(value.scopes)
      ? value.scopes.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

function normalizePrevious(value: unknown): { savedAt: number; size: number } | null {
  if (!isRecord(value)) return null
  return { savedAt: numberValue(value.saved_at), size: numberValue(value.size) }
}

function normalizeCreated(value: unknown): { createdAt: number } | null {
  if (!isRecord(value)) return null
  return { createdAt: numberValue(value.created_at) }
}

/** A line diff of what Navide wrote against what is there now. Past a size
 *  where the table would be slow, every line is shown as removed then added. */
function lineDiff(before: string, after: string): Array<{ kind: 'same' | 'del' | 'add'; text: string }> {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 1_000_000) {
    return [
      ...a.map((text) => ({ kind: 'del' as const, text })),
      ...b.map((text) => ({ kind: 'add' as const, text })),
    ]
  }
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: Array<{ kind: 'same' | 'del' | 'add'; text: string }> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

const createdDiff = computed(() =>
  createdChange.value ? lineDiff(createdChange.value.created, createdChange.value.current) : [],
)

function workspacePayload(): Record<string, string> {
  return { workspace_path: props.workspacePath ?? '' }
}

async function reload(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ files?: unknown; agents?: unknown; auto_memory_dir?: unknown }>(
      'memory.list',
      workspacePayload(),
    )
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? t('settings.memory.error-load')
      return
    }
    files.value = (Array.isArray(resp.payload.files) ? resp.payload.files : [])
      .map(normalizeFile)
      .filter((entry): entry is MemoryFile => entry !== null)
    agents.value = (Array.isArray(resp.payload.agents) ? resp.payload.agents : [])
      .map(normalizeAgent)
      .filter((entry): entry is AgentTarget => entry !== null)
    autoMemoryDir.value = stringValue(resp.payload.auto_memory_dir)
    if (selectedPath.value && !files.value.some((file) => file.path === selectedPath.value)) {
      closeEditor()
    }
  } catch (err) {
    error.value = String((err as Error).message ?? err)
  } finally {
    loading.value = false
  }
}

const agentLabels = computed(() => {
  const map = new Map<string, string>()
  for (const agent of agents.value) map.set(agent.agent, agent.label)
  return map
})

/** The two scopes, always both, so an empty project list explains itself.
 *  Claude's auto-memory is kept out of them: it is listed on its own below. */
const groups = computed(() =>
  (['user', 'project'] as const).map((scope) => ({
    scope,
    label: t(`settings.memory.scope-${scope}`),
    files: files.value.filter((file) => file.scope === scope && !file.autoMemory),
  })),
)

const autoMemoryFiles = computed(() => files.value.filter((file) => file.autoMemory))

const selectedFile = computed(
  () => files.value.find((file) => file.path === selectedPath.value) ?? null,
)

const dirty = computed(() => draftText.value !== savedText.value)

/** The states, kept apart: mapped, configured, and the unknown fallback. */
const agentGroups = computed(() =>
  (['mapped', 'configured', 'unknown'] as const)
    .map((state) => ({
      state,
      label: t(`settings.memory.agents-${state}`),
      hint: t(`settings.memory.agents-${state}-hint`),
      agents: agents.value.filter((agent) => agent.state === state),
    }))
    .filter((group) => group.agents.length > 0),
)

function readerLabel(agent: string): string {
  return agentLabels.value.get(agent) ?? agent
}

function modifiedLabel(file: MemoryFile): string {
  if (!file.modified) return ''
  return new Date(file.modified * 1000).toLocaleString()
}

const previousLabel = computed(() =>
  previous.value?.savedAt ? new Date(previous.value.savedAt * 1000).toLocaleString() : '',
)

const createdLabel = computed(() =>
  created.value?.createdAt ? new Date(created.value.createdAt * 1000).toLocaleString() : '',
)

/** True when nothing unsaved would be lost, or the user agreed to lose it. */
function confirmDiscard(): boolean {
  if (!selectedFile.value || !dirty.value) return true
  return window.confirm(t('settings.memory.discard-confirm', { name: selectedFile.value.relative }))
}

async function openFile(file: MemoryFile): Promise<void> {
  if (!confirmDiscard()) return
  await loadFile(file)
}

async function loadFile(file: MemoryFile): Promise<void> {
  error.value = ''
  conflict.value = false
  busy.value = true
  try {
    const resp = await props.backend.send<{
      text?: unknown
      modified?: unknown
      previous?: unknown
      created?: unknown
    }>('memory.get', {
      path: file.path,
      ...workspacePayload(),
    })
    if (!resp.ok || !resp.payload) {
      error.value = resp.error?.message ?? t('settings.memory.error-read')
      return
    }
    const text = stringValue(resp.payload.text)
    selectedPath.value = file.path
    draftText.value = text
    savedText.value = text
    // A file that does not exist reports no mtime; 0 is what the backend
    // compares against, so creating it twice from two windows still conflicts.
    expectedModified.value = numberValue(resp.payload.modified)
    previous.value = normalizePrevious(resp.payload.previous)
    created.value = normalizeCreated(resp.payload.created)
    createdChange.value = null
  } catch (err) {
    error.value = String((err as Error).message ?? err)
  } finally {
    busy.value = false
  }
}

async function save(): Promise<void> {
  const file = selectedFile.value
  if (!file) return
  error.value = ''
  conflict.value = false
  busy.value = true
  try {
    const resp = await props.backend.send<{ modified?: unknown; previous?: unknown; created?: unknown }>('memory.save', {
      path: file.path,
      text: draftText.value,
      expected_modified: expectedModified.value,
      ...workspacePayload(),
    })
    if (!resp.ok) {
      // A conflict is not an ordinary failure: the draft stays, and the only
      // way forward is a reload the user asks for.
      if (resp.error?.code === 'MEMORY_FILE_CONFLICT') conflict.value = true
      else error.value = resp.error?.message ?? t('settings.memory.error-save')
      return
    }
    savedText.value = draftText.value
    // Saving moved the file on; adopt the new mtime so a second save in a row
    // is not refused as a conflict with the user's own write.
    expectedModified.value = numberValue(resp.payload?.modified)
    previous.value = normalizePrevious(resp.payload?.previous)
    created.value = normalizeCreated(resp.payload?.created)
    createdChange.value = null
    await reload()
  } catch (err) {
    error.value = String((err as Error).message ?? err)
  } finally {
    busy.value = false
  }
}

/** Write back the version the last save replaced. The backend keeps the text
 *  it replaces as the new previous version, so this is undone the same way. */
async function restorePrevious(): Promise<void> {
  const file = selectedFile.value
  if (!file || !confirmDiscard()) return
  error.value = ''
  conflict.value = false
  busy.value = true
  let restored = false
  try {
    const resp = await props.backend.send('memory.restore', {
      path: file.path,
      expected_modified: expectedModified.value,
      ...workspacePayload(),
    })
    if (!resp.ok) {
      if (resp.error?.code === 'MEMORY_FILE_CONFLICT') conflict.value = true
      else error.value = resp.error?.message ?? t('settings.memory.error-restore')
      return
    }
    restored = true
  } catch (err) {
    error.value = String((err as Error).message ?? err)
  } finally {
    busy.value = false
  }
  if (restored) {
    await loadFile(file)
    await reload()
  }
}

/** Move the file Navide created to the Trash. Main accepts only a file the
 *  backend recorded creating, and only moves it -- never a permanent delete.
 *  A file that changed since comes back with both texts, and is trashed only
 *  after the user has seen the difference and asked again. */
async function undoCreate(acceptChanged = false): Promise<void> {
  const file = selectedFile.value
  if (!file || !confirmDiscard()) return
  error.value = ''
  const trash = window.agentTeam?.trashCreatedMemoryFile
  if (!trash) {
    error.value = t('settings.memory.undo-create-unavailable')
    return
  }
  busy.value = true
  let trashed = false
  try {
    const result = await trash(file.path, acceptChanged)
    if (result.ok) {
      trashed = true
    } else if (result.code === 'changed') {
      createdChange.value = { created: result.created ?? '', current: result.current ?? '' }
    } else {
      error.value = t('settings.memory.undo-create-failed', { reason: result.error ?? '' })
    }
  } catch (err) {
    error.value = t('settings.memory.undo-create-failed', { reason: String((err as Error).message ?? err) })
  } finally {
    busy.value = false
  }
  if (trashed) {
    await loadFile(file)
    await reload()
  }
}

function closeEditor(): void {
  selectedPath.value = ''
  draftText.value = ''
  savedText.value = ''
  expectedModified.value = 0
  conflict.value = false
  previous.value = null
  created.value = null
  createdChange.value = null
}

/** Cancel and ✕: close, but never drop a draft without asking. */
function requestClose(): void {
  if (confirmDiscard()) closeEditor()
}

/** Re-read the open file, throwing the draft away. Only ever user-initiated. */
async function reloadFile(): Promise<void> {
  const file = selectedFile.value
  if (file) await loadFile(file)
}

onMounted(reload)

defineExpose({ reload, confirmDiscard })
</script>

<template>
  <section class="memory-pane" :aria-label="t('settings.memory.title')">
    <header class="memory-pane-head">
      <div>
        <p>{{ t('settings.memory.intro') }}</p>
      </div>
      <button type="button" :disabled="loading || busy" @click="reload">{{ t('action.refresh') }}</button>
    </header>

    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>

    <div class="memory-body" :class="{ 'editor-open': selectedFile !== null }">
      <div class="memory-main">
        <div v-if="loading" class="memory-state nv-loading">{{ t('label.loading') }}</div>
        <template v-else>
          <section v-for="group in groups" :key="group.scope" class="memory-group">
            <h3 class="memory-group-title">
              {{ group.label }}<span class="count">{{ group.files.length }}</span>
            </h3>
            <p
              v-if="group.scope === 'project' && !props.workspacePath"
              class="memory-group-note"
            >{{ t('settings.memory.no-workspace') }}</p>
            <p
              v-else-if="group.files.length === 0"
              class="memory-group-note"
            >{{ t('settings.memory.empty') }}</p>
            <ul v-else class="memory-list">
              <li
                v-for="file in group.files"
                :key="file.path"
                class="memory-row"
                :class="{ active: selectedPath === file.path, missing: !file.exists }"
              >
                <button type="button" class="memory-open" :disabled="busy" @click="openFile(file)">
                  <span class="memory-row-head">
                    <strong class="memory-relative" v-truncate>{{ file.relative }}</strong>
                    <span v-if="!file.exists" class="memory-tag missing">
                      {{ t('settings.memory.not-created') }}
                    </span>
                    <span v-else-if="file.error" class="memory-tag danger">{{ file.error }}</span>
                  </span>
                  <span class="memory-readers">
                    <span
                      v-for="reader in file.readers"
                      :key="reader"
                      class="rchip"
                      :title="readerLabel(reader)"
                    >{{ reader }}</span>
                  </span>
                  <span class="memory-row-meta">
                    <template v-if="file.exists">
                      {{ formatBytes(file.size) }} · {{ modifiedLabel(file) }}
                    </template>
                    <template v-else>{{ file.path }}</template>
                  </span>
                </button>
                <button
                  v-if="!file.exists"
                  type="button"
                  class="memory-create"
                  :disabled="busy"
                  @click="openFile(file)"
                >{{ t('action.create') }}</button>
              </li>
            </ul>
          </section>

          <!-- Claude's auto-memory: written by Claude, editable like the rest. -->
          <section v-if="props.workspacePath" class="memory-group memory-auto">
            <h3 class="memory-group-title">
              {{ t('settings.memory.scope-auto') }}<span class="count">{{ autoMemoryFiles.length }}</span>
            </h3>
            <p class="memory-group-note">{{ t('settings.memory.auto-intro') }}</p>
            <code v-if="autoMemoryDir" class="memory-auto-dir">{{ autoMemoryDir }}</code>
            <p v-if="autoMemoryFiles.length === 0" class="memory-group-note">
              {{ t('settings.memory.auto-empty') }}
            </p>
            <ul v-else class="memory-list">
              <li
                v-for="file in autoMemoryFiles"
                :key="file.path"
                class="memory-row"
                :class="{ active: selectedPath === file.path }"
              >
                <button type="button" class="memory-open" :disabled="busy" @click="openFile(file)">
                  <span class="memory-row-head">
                    <strong class="memory-relative" v-truncate>{{ file.relative }}</strong>
                    <span class="memory-tag">{{ t('settings.memory.auto-tag') }}</span>
                    <span v-if="file.error" class="memory-tag danger">{{ file.error }}</span>
                  </span>
                  <span class="memory-row-meta">
                    {{ formatBytes(file.size) }} · {{ modifiedLabel(file) }}
                  </span>
                </button>
              </li>
            </ul>
          </section>
        </template>

        <!-- Coverage: which CLIs Navide can point at a file, and which it cannot. -->
        <section class="memory-agents">
          <h3 class="memory-group-title">{{ t('settings.memory.agents-title') }}</h3>
          <div
            v-for="group in agentGroups"
            :key="group.state"
            class="memory-agent-group"
            :data-state="group.state"
          >
            <div class="memory-agent-state">
              <strong>{{ group.label }}</strong>
              <span>{{ group.hint }}</span>
            </div>
            <div class="memory-agent-chips">
              <span
                v-for="agent in group.agents"
                :key="agent.agent"
                class="rchip"
                :title="agent.agent"
              >{{ agent.label }}</span>
            </div>
          </div>
        </section>
      </div>

      <!-- Editor: one file at a time, saved back to exactly where it came from. -->
      <aside v-if="selectedFile" class="memory-editor" :aria-label="selectedFile.relative">
        <header class="memory-editor-head">
          <div class="memory-editor-title">
            <h3>{{ selectedFile.relative }}</h3>
            <span v-if="dirty" class="memory-tag unsaved">{{ t('settings.memory.unsaved') }}</span>
          </div>
          <button
            type="button"
            class="memory-editor-close"
            :aria-label="t('action.close')"
            @click="requestClose"
          >✕</button>
        </header>
        <code class="memory-editor-path">{{ selectedFile.path }}</code>
        <p v-if="selectedFile.autoMemory" class="memory-editor-hint">
          {{ t('settings.memory.auto-editor-hint') }}
        </p>
        <p v-if="!selectedFile.exists" class="memory-editor-hint">
          {{ t('settings.memory.create-hint') }}
        </p>
        <div v-if="conflict" class="memory-conflict" role="alert">
          <strong>{{ t('settings.memory.conflict-title') }}</strong>
          <span>{{ t('settings.memory.conflict-body') }}</span>
          <button type="button" :disabled="busy" @click="reloadFile">
            {{ t('settings.memory.conflict-reload') }}
          </button>
        </div>
        <div v-if="previous" class="memory-previous">
          <strong>{{ t('settings.memory.previous-kept', { when: previousLabel }) }}</strong>
          <span>{{ t('settings.memory.restore-hint') }}</span>
          <button type="button" :disabled="busy" @click="restorePrevious">
            {{ t('settings.memory.restore-previous') }}
          </button>
        </div>
        <div v-if="created && selectedFile.exists" class="memory-created">
          <strong>{{ t('settings.memory.created-by-navide', { when: createdLabel }) }}</strong>
          <span>{{ t('settings.memory.undo-create-hint') }}</span>
          <template v-if="createdChange">
            <span role="alert">{{ t('settings.memory.undo-create-changed') }}</span>
            <span class="memory-diff-legend">{{ t('settings.memory.undo-create-diff-legend') }}</span>
            <pre class="memory-diff"><span
              v-for="(line, index) in createdDiff"
              :key="index"
              :class="`memory-diff-${line.kind}`"
            >{{ line.kind === 'del' ? '− ' : line.kind === 'add' ? '+ ' : '  ' }}{{ line.text }}
</span></pre>
            <div class="memory-created-actions">
              <button type="button" :disabled="busy" @click="createdChange = null">
                {{ t('settings.memory.undo-create-keep') }}
              </button>
              <button type="button" class="danger" :disabled="busy" @click="undoCreate(true)">
                {{ t('settings.memory.undo-create-confirm') }}
              </button>
            </div>
          </template>
          <button v-else type="button" :disabled="busy" @click="undoCreate()">
            {{ t('settings.memory.undo-create') }}
          </button>
        </div>
        <textarea
          v-model="draftText"
          class="memory-editor-text"
          spellcheck="false"
          :aria-label="selectedFile.relative"
        ></textarea>
        <div class="memory-editor-actions">
          <button type="button" @click="requestClose">{{ t('action.cancel') }}</button>
          <button
            type="button"
            class="nv-btn nv-btn--primary"
            :disabled="busy || !dirty"
            @click="save"
          >{{ t('action.save') }}</button>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.memory-pane {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  /* Horizontal gutter matches the settings page gutter so the pane lines up
     with the <h1> and the scope band the settings modal renders above it. */
  padding: 16px 22px 18px;
  gap: 12px;
  overflow: hidden;
  color: var(--text-primary);
}
.memory-pane-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.memory-pane-head p { margin: 0; color: var(--text-secondary); font-size: var(--font-2xs); }
button, textarea { font: inherit; }
button {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-muted);
  color: var(--text-primary);
  padding: 5px 9px;
  cursor: pointer;
}
button:hover:not(:disabled) { background: var(--bg-elevated); color: var(--text-bright); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent-emphasis); outline-offset: 2px; }
.memory-error {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--danger-fg) 45%, var(--border-default));
  border-radius: var(--radius-control);
  color: var(--danger-fg);
  background: color-mix(in srgb, var(--danger-fg) 8%, var(--bg-subtle));
  font-size: var(--font-2xs);
}

/* ── Body: list + optional editor ──────────────────────────────────────── */
.memory-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-height: 0; flex: 1; }
.memory-body.editor-open { grid-template-columns: minmax(0, 1fr) minmax(300px, 420px); }
.memory-main { min-width: 0; min-height: 0; overflow-y: auto; }
.memory-state { padding: 18px 8px; color: var(--text-secondary); font-size: var(--font-2xs); text-align: center; }

/* ── List ──────────────────────────────────────────────────────────────── */
.memory-group { margin-bottom: 14px; }
.memory-group-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 10px 4px 6px;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.memory-group-title .count { font-weight: 500; opacity: 0.6; font-variant-numeric: tabular-nums; }
.memory-group-note { margin: 0 4px; color: var(--text-secondary); font-size: var(--font-2xs); }
.memory-auto { display: flex; flex-direction: column; gap: 6px; }
.memory-auto .memory-group-title { margin-bottom: 0; }
.memory-auto-dir {
  display: block;
  margin: 0 4px;
  font-size: 10.5px;
  color: var(--text-secondary);
  word-break: break-all;
}
.memory-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.memory-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  padding: 4px 9px 4px 4px;
  min-width: 0;
}
.memory-row.missing { border-style: dashed; }
.memory-row.active { border-color: var(--accent-fg, var(--border-emphasis)); background: var(--bg-muted); }
.memory-open {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  border: 0;
  background: transparent;
  padding: 5px 7px;
  text-align: left;
}
.memory-open:hover:not(:disabled) { background: var(--bg-muted); }
.memory-row-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.memory-relative {
  font-size: var(--font-xs);
  color: var(--text-bright);
  font-family: Menlo, Monaco, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.memory-readers { display: flex; flex-wrap: wrap; gap: 3px; }
.memory-row-meta {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}
.memory-create { flex: none; font-size: var(--font-2xs); }
.rchip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--font-3xs);
  font-weight: 600;
  border: 1px solid var(--border-muted);
  color: var(--text-secondary);
  white-space: nowrap;
  line-height: var(--lh-base);
}
.memory-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-muted);
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  white-space: nowrap;
  flex: none;
}
.memory-tag.danger { color: var(--danger-fg); border-color: color-mix(in srgb, var(--danger-fg) 45%, var(--border-muted)); }
.memory-tag.unsaved { color: var(--warning-fg, var(--text-bright)); }

/* ── Coverage footer ───────────────────────────────────────────────────── */
.memory-agents {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid var(--border-muted);
}
.memory-agent-group { display: flex; flex-direction: column; gap: 4px; }
.memory-agent-state { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.memory-agent-state strong { font-size: var(--font-2xs); color: var(--text-bright); }
.memory-agent-state span { font-size: 10.5px; color: var(--text-secondary); }
.memory-agent-chips { display: flex; flex-wrap: wrap; gap: 3px; }
.memory-agent-group[data-state='configured'] .rchip,
.memory-agent-group[data-state='unknown'] .rchip { opacity: 0.7; border-style: dashed; }

/* ── Editor ────────────────────────────────────────────────────────────── */
.memory-editor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 8px;
  padding: 12px 14px 16px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  min-height: 0;
  overflow-y: auto;
}
.memory-editor-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.memory-editor-title { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.memory-editor-title h3 { margin: 0; font-size: var(--font-md); color: var(--text-bright); word-break: break-all; }
.memory-editor-close { padding: 2px 7px; font-size: var(--font-xs); line-height: 1; }
.memory-editor-path {
  display: block;
  font-size: 10.5px;
  padding: 5px 8px;
  border-radius: var(--radius-control);
  background: var(--bg-muted);
  color: var(--text-secondary);
  word-break: break-all;
}
.memory-editor-hint { margin: 0; font-size: 10.5px; color: var(--text-secondary); line-height: 1.4; }
.memory-conflict {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--danger-fg) 45%, var(--border-default));
  border-radius: var(--radius-control);
  background: color-mix(in srgb, var(--danger-fg) 8%, var(--bg-subtle));
  font-size: var(--font-2xs);
}
.memory-conflict strong { color: var(--danger-fg); }
.memory-conflict span { color: var(--text-secondary); line-height: 1.4; }
.memory-previous,
.memory-created {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-subtle);
  font-size: var(--font-2xs);
}
.memory-previous span,
.memory-created span { color: var(--text-secondary); line-height: 1.4; }
.memory-diff {
  align-self: stretch;
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 6px 8px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  font-family: Menlo, Monaco, monospace;
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-all;
}
.memory-diff .memory-diff-del { color: var(--danger-fg); }
.memory-diff .memory-diff-add { color: var(--success-fg, var(--text-bright)); }
.memory-created-actions { display: flex; gap: 8px; }
.memory-created-actions .danger { color: var(--danger-fg); }
.memory-editor-text {
  min-height: 320px;
  resize: vertical;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-primary);
  padding: 8px;
  font-family: Menlo, Monaco, monospace;
  font-size: var(--font-2xs);
  line-height: 1.5;
}
.memory-editor-text:focus { border-color: var(--accent-emphasis); }
.memory-editor-actions { display: flex; justify-content: flex-end; gap: 8px; }

@media (max-width: 900px) {
  .memory-pane { overflow-y: auto; }
  .memory-body, .memory-body.editor-open { grid-template-columns: 1fr; }
}
</style>
