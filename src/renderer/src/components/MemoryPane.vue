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

function workspacePayload(): Record<string, string> {
  return { workspace_path: props.workspacePath ?? '' }
}

async function reload(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<{ files?: unknown; agents?: unknown }>(
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

/** The two scopes, always both, so an empty project list explains itself. */
const groups = computed(() =>
  (['user', 'project'] as const).map((scope) => ({
    scope,
    label: t(`settings.memory.scope-${scope}`),
    files: files.value.filter((file) => file.scope === scope),
  })),
)

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

async function openFile(file: MemoryFile): Promise<void> {
  error.value = ''
  conflict.value = false
  busy.value = true
  try {
    const resp = await props.backend.send<{ text?: unknown; modified?: unknown }>('memory.get', {
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
    const resp = await props.backend.send<{ modified?: unknown }>('memory.save', {
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
    await reload()
  } catch (err) {
    error.value = String((err as Error).message ?? err)
  } finally {
    busy.value = false
  }
}

function closeEditor(): void {
  selectedPath.value = ''
  draftText.value = ''
  savedText.value = ''
  expectedModified.value = 0
  conflict.value = false
}

/** Re-read the open file, throwing the draft away. Only ever user-initiated. */
async function reloadFile(): Promise<void> {
  const file = selectedFile.value
  if (file) await openFile(file)
}

onMounted(reload)

defineExpose({ reload })
</script>

<template>
  <section class="memory-pane" :aria-label="t('settings.memory.title')">
    <header class="memory-pane-head">
      <div>
        <h2>{{ t('settings.memory.title') }}</h2>
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
            @click="closeEditor"
          >✕</button>
        </header>
        <code class="memory-editor-path">{{ selectedFile.path }}</code>
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
        <textarea
          v-model="draftText"
          class="memory-editor-text"
          spellcheck="false"
          :aria-label="selectedFile.relative"
        ></textarea>
        <div class="memory-editor-actions">
          <button type="button" @click="closeEditor">{{ t('action.cancel') }}</button>
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
.memory-pane-head h2 { margin: 0; font-size: 15px; color: var(--text-bright); }
.memory-pane-head p { margin: 3px 0 0; color: var(--text-secondary); font-size: var(--font-2xs); }
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
