<script setup lang="ts">
import { native } from '../composables/native'

import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
  // When embedded inside the editor window, matches open in-place via `open-file`
  // instead of spawning a separate editor window.
  embedded?: boolean
  // When the pane is shown (activity bar click), auto-focus the search input.
  active?: boolean
}>()

const emit = defineEmits<{
  (e: 'open-file', payload: { filepath: string; name: string; line: number }): void
}>()

const { confirm, toast, alert } = useNotify()
const { t } = useI18n()

interface Match { line: number; col: number; end: number; text: string }
interface FileResult { rel_path: string; name: string; matches: Match[] }
interface FindResult { ok: boolean; results?: FileResult[]; total?: number; truncated?: boolean; error?: string }
interface ReplaceResult { ok: boolean; changed?: { rel_path: string; count: number }[]; total?: number; error?: string }
interface FsRead { ok: boolean; content?: string; error?: string }

// ── State (options persisted) ────────────────────────────────────────────────
const OPTS_KEY = 'agentTeam.search.opts'
function loadOpts(): { cs: boolean; ww: boolean; re: boolean } {
  try {
    const o = JSON.parse(settingsGet(OPTS_KEY, '') || '{}')
    return { cs: !!o.cs, ww: !!o.ww, re: !!o.re }
  } catch { return { cs: false, ww: false, re: false } }
}
const saved = loadOpts()

const query = ref('')
const replacement = ref('')
const includes = ref('')
const excludes = ref('')
const caseSensitive = ref(saved.cs)
const wholeWord = ref(saved.ww)
const isRegex = ref(saved.re)
const showReplace = ref(false)

const results = ref<FileResult[]>([])
const total = ref(0)
const truncated = ref(false)
const error = ref('')
const searching = ref(false)
const collapsed = reactive<Record<string, boolean>>({})

const fileCount = computed(() => results.value.length)
const queryInput = ref<HTMLInputElement | null>(null)

watch([caseSensitive, wholeWord, isRegex], () => {
  settingsSet(OPTS_KEY, JSON.stringify({ cs: caseSensitive.value, ww: wholeWord.value, re: isRegex.value }))
})

// ── Search (debounced, race-guarded) ─────────────────────────────────────────
let debounce: ReturnType<typeof setTimeout> | null = null
let seq = 0

function scheduleSearch(): void {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => void doSearch(), 250)
}

watch([query, caseSensitive, wholeWord, isRegex, includes, excludes], () => {
  // An emptied query must invalidate any in-flight search immediately —
  // waiting out the debounce would let a stale response repopulate the pane.
  if (!query.value) {
    if (debounce) { clearTimeout(debounce); debounce = null }
    void doSearch()
    return
  }
  scheduleSearch()
})

async function doSearch(): Promise<void> {
  const q = query.value
  if (!q) {
    seq++ // drop any in-flight response via the mySeq !== seq stale guard
    results.value = []; total.value = 0; truncated.value = false; error.value = ''
    searching.value = false
    return
  }
  const mySeq = ++seq
  searching.value = true
  error.value = ''
  try {
    const resp = await props.backend.send<FindResult>('search.find_in_files', {
      workspace_path: props.workspacePath,
      query: q,
      is_regex: isRegex.value,
      case_sensitive: caseSensitive.value,
      whole_word: wholeWord.value,
      includes: includes.value,
      excludes: excludes.value,
    }, 30_000)
    if (mySeq !== seq) return // stale
    const p = resp.payload
    if (!p?.ok) {
      error.value = p?.error || 'Search failed'
      results.value = []; total.value = 0; truncated.value = false
      return
    }
    results.value = p.results ?? []
    total.value = p.total ?? 0
    truncated.value = !!p.truncated
  } catch (e) {
    if (mySeq !== seq) return
    error.value = e instanceof Error ? e.message : 'Search failed'
  } finally {
    if (mySeq === seq) searching.value = false
  }
}

// Search once the socket is ready if a query was typed before connect.
watch(() => props.backend.status.value, (s) => {
  if (s === 'connected' && query.value) void doSearch()
})

// ── Highlight: split the line around [col, end) ──────────────────────────────
function parts(m: Match): { a: string; h: string; b: string } {
  const t = m.text
  if (m.end > m.col && m.end <= t.length) {
    return { a: t.slice(0, m.col), h: t.slice(m.col, m.end), b: t.slice(m.end) }
  }
  return { a: t, h: '', b: '' }
}

// ── Open result in editor at line ────────────────────────────────────────────
function openMatch(file: FileResult, m: Match): void {
  if (props.embedded) {
    emit('open-file', { filepath: file.rel_path, name: file.name, line: m.line })
    return
  }
  void native?.openEditorWindow({
    workspace_path: props.workspacePath,
    filepath: file.rel_path,
    name: file.name,
    line: m.line,
  })
}

// ── Replace ──────────────────────────────────────────────────────────────────
async function replaceInFiles(files: string[]): Promise<void> {
  try {
    const resp = await props.backend.send<ReplaceResult>('search.replace_in_files', {
      workspace_path: props.workspacePath,
      query: query.value,
      replacement: replacement.value,
      files,
      is_regex: isRegex.value,
      case_sensitive: caseSensitive.value,
      whole_word: wholeWord.value,
    }, 30_000)
    const p = resp.payload
    if (!p?.ok) {
      void alert(p?.error || 'Replace failed', { title: 'Replace' })
      return
    }
    toast(`Replaced ${p.total ?? 0} occurrence(s)`, { type: 'success' })
    await doSearch()
  } catch (e) {
    void alert(e instanceof Error ? e.message : 'Replace failed', { title: 'Replace' })
  }
}

async function replaceAll(): Promise<void> {
  if (!total.value) return
  // The backend caps results; files whose matches fell past the cap are not in
  // `results`, so a replace-all here would silently skip them. Block instead.
  if (truncated.value) {
    void alert(t('hint.replace-all-truncated'), { title: 'Replace All' })
    return
  }
  const q = query.value
  const r = replacement.value
  // Capture the file list before the async confirm() so a concurrent search
  // triggered while the dialog is open can't change results.value under us.
  const filePaths = results.value.map((f) => f.rel_path)
  const ok = await confirm(
    `Replace "${q}" with "${r}" — ${total.value} occurrence(s) across ${fileCount.value} file(s). This will modify files directly.`,
    { title: 'Replace All', confirmText: 'Replace All' }
  )
  if (!ok) return
  query.value = q
  replacement.value = r
  await replaceInFiles(filePaths)
}

async function replaceFile(file: FileResult): Promise<void> {
  const r = replacement.value
  const ok = await confirm(
    `Replace ${file.matches.length} occurrence(s) in "${file.name}" with "${r}"?`,
    { title: 'Replace in File', confirmText: 'Replace' }
  )
  if (!ok) return
  replacement.value = r
  await replaceInFiles([file.rel_path])
}

// Single-match replace (literal mode only — regex backrefs need backend semantics).
async function replaceOne(file: FileResult, m: Match): Promise<void> {
  const r = replacement.value
  try {
    const read = await props.backend.send<FsRead>('fs.read_file', {
      workspace_path: props.workspacePath,
      rel_path: file.rel_path,
    })
    if (!read.payload?.ok || read.payload.content == null) {
      void alert(read.payload?.error || 'Failed to read file', { title: 'Replace' })
      return
    }
    const lines = read.payload.content.split('\n')
    const idx = m.line - 1
    const line = lines[idx]
    // Verify the matched text at (col, end) still matches what was found at search time.
    // An empty check (=== '') misses cases where other content landed at those positions.
    const expectedSnippet = m.text.slice(m.col, m.end)
    if (line == null || line.slice(m.col, m.end) !== expectedSnippet) {
      toast('Content has changed, please search again', { type: 'info' })
      await doSearch()
      return
    }
    lines[idx] = line.slice(0, m.col) + r + line.slice(m.end)
    const write = await props.backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
      workspace_path: props.workspacePath,
      rel_path: file.rel_path,
      content: lines.join('\n'),
    })
    if (!write.payload?.ok) {
      void alert(write.payload?.error || 'Write failed', { title: 'Replace' })
      return
    }
    await doSearch()
  } catch (e) {
    void alert(e instanceof Error ? e.message : 'Replace failed', { title: 'Replace' })
  }
}

function toggleFile(rel: string): void {
  collapsed[rel] = !collapsed[rel]
}

function clearSearch(): void {
  if (debounce) { clearTimeout(debounce); debounce = null }
  seq++ // drop any in-flight response via the mySeq !== seq stale guard
  query.value = ''
  results.value = []
  total.value = 0
  truncated.value = false
  error.value = ''
  searching.value = false
}

// Auto-focus when pane becomes active (e.g. clicking Search in the activity bar).
// v-show keeps the component mounted, so onMounted only fires once; watch handles later activations.
watch(() => props.active, (v) => {
  if (v) void nextTick(() => queryInput.value?.focus())
})

onMounted(() => {
  void Promise.resolve().then(() => queryInput.value?.focus())
})
onUnmounted(() => { if (debounce) clearTimeout(debounce) })

function openReplace(): void {
  showReplace.value = true
  void nextTick(() => queryInput.value?.focus())
}
function focusInput(): void {
  void nextTick(() => queryInput.value?.focus())
}
function setQuery(q: string): void {
  query.value = q
  void nextTick(() => { queryInput.value?.focus(); queryInput.value?.select() })
}
defineExpose({ openReplace, focusInput, setQuery })
</script>

<template>
  <div class="search-pane">
    <!-- ── Search / replace inputs ──────────────────────────────────────── -->
    <div class="sp-inputs">
      <button class="sp-expand" :title="showReplace ? 'Collapse replace' : 'Expand replace'" @click="showReplace = !showReplace">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" :style="{ transform: showReplace ? 'rotate(90deg)' : '' }">
          <path d="M6 4l4 4-4 4V4Z" />
        </svg>
      </button>

      <div class="sp-fields">
        <!-- query row -->
        <div class="sp-field">
          <input
            ref="queryInput"
            v-model="query"
            class="sp-input"
            :placeholder="$t('label.search-placeholder')"
            spellcheck="false"
            @keydown.enter="doSearch"
            @keydown.esc="clearSearch"
          />
          <div class="sp-toggles">
            <button class="sp-tg" :class="{ on: caseSensitive }" :title="$t('hint.match-case')" @click="caseSensitive = !caseSensitive">Aa</button>
            <button class="sp-tg" :class="{ on: wholeWord }" title="Match whole word" @click="wholeWord = !wholeWord">
              <span style="text-decoration: underline">ab</span>
            </button>
            <button class="sp-tg" :class="{ on: isRegex }" title="Use regular expression" @click="isRegex = !isRegex">.*</button>
          </div>
        </div>

        <!-- replace row -->
        <div v-show="showReplace" class="sp-field">
          <input
            v-model="replacement"
            class="sp-input"
            :placeholder="$t('label.replace-placeholder')"
            spellcheck="false"
            @keydown.enter="replaceAll"
          />
          <button
            class="sp-replace-all"
            :disabled="!total || truncated"
            :title="truncated ? $t('hint.replace-all-truncated') : 'Replace All'"
            @click="replaceAll"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 3h7v2l3-3-3-3v2H1v6h2V3Zm10 10H6v-2l-3 3 3 3v-2h8V9h-2v4Z"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- ── include / exclude ────────────────────────────────────────────── -->
    <div class="sp-globs">
      <label class="sp-glob-label">files to include</label>
      <input v-model="includes" class="sp-glob-input" placeholder="e.g. *.ts, src/**" spellcheck="false" />
      <label class="sp-glob-label">files to exclude</label>
      <input v-model="excludes" class="sp-glob-input" placeholder="e.g. *.test.ts, dist/**" spellcheck="false" />
    </div>

    <!-- ── summary ──────────────────────────────────────────────────────── -->
    <div class="sp-summary">
      <span v-if="searching" class="sp-muted">{{ $t('label.searching') }}</span>
      <span v-else-if="error" class="sp-error">{{ error }}</span>
      <span v-else-if="query && total === 0" class="sp-muted">{{ $t('label.no-results') }}</span>
      <span v-else-if="total > 0">{{ total }} result(s) · {{ fileCount }} file(s)<span v-if="truncated" class="sp-trunc"> · Truncated</span></span>
    </div>

    <!-- ── results ──────────────────────────────────────────────────────── -->
    <div class="sp-results">
      <div v-for="file in results" :key="file.rel_path" class="sp-file">
        <div class="sp-file-head" @click="toggleFile(file.rel_path)">
          <span class="sp-chev" :class="{ open: !collapsed[file.rel_path] }">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4V4Z" /></svg>
          </span>
          <span class="sp-file-name">{{ file.name }}</span>
          <span class="sp-file-path" v-truncate>{{ file.rel_path }}</span>
          <span class="sp-file-count">{{ file.matches.length }}</span>
          <button
            v-if="showReplace"
            class="sp-file-replace"
            :title="$t('action.replace-in-file')"
            @click.stop="replaceFile(file)"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M3 3h7v2l3-3-3-3v2H1v6h2V3Zm10 10H6v-2l-3 3 3 3v-2h8V9h-2v4Z"/></svg>
          </button>
        </div>

        <div v-show="!collapsed[file.rel_path]" class="sp-matches">
          <div
            v-for="(m, i) in file.matches"
            :key="i"
            class="sp-match"
            @click="openMatch(file, m)"
          >
            <span class="sp-ln">{{ m.line }}</span>
            <span class="sp-text" v-truncate><span>{{ parts(m).a }}</span><span class="sp-hit">{{ parts(m).h }}</span><span>{{ parts(m).b }}</span></span>
            <span v-if="showReplace" class="sp-match-actions">
              <button
                v-if="!isRegex"
                class="sp-match-btn"
                :title="$t('action.replace-match')"
                @click.stop="replaceOne(file, m)"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3 3h7v2l3-3-3-3v2H1v6h2V3Zm10 10H6v-2l-3 3 3 3v-2h8V9h-2v4Z"/></svg>
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 12.5px;
}

/* inputs */
.sp-inputs { display: flex; gap: 4px; padding: 10px 12px 6px; align-items: stretch; }
.sp-expand {
  width: 18px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  padding-top: 7px;
}
.sp-expand:hover { color: var(--text-bright); }
.sp-expand svg { transition: transform 0.12s; }
.sp-fields { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.sp-field { display: flex; align-items: center; gap: 4px; }
.sp-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  font-size: 12.5px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  outline: none;
}
.sp-input:focus { border-color: var(--accent-emphasis); }
.sp-toggles { display: flex; gap: 1px; }
.sp-tg {
  width: 24px;
  height: 26px;
  font-size: var(--font-2xs);
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.sp-tg:hover { background: var(--bg-muted); color: var(--text-bright); }
.sp-tg.on { background: var(--accent-muted); border-color: var(--accent-emphasis); color: var(--accent-fg); }
.sp-replace-all {
  width: 26px;
  height: 26px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sp-replace-all:hover:not(:disabled) { background: var(--bg-muted); color: var(--text-bright); }
.sp-replace-all:disabled { opacity: 0.4; cursor: default; }

/* globs */
.sp-globs { display: flex; flex-direction: column; gap: 3px; padding: 4px 12px 8px 30px; }
.sp-glob-label { font-size: 10.5px; color: var(--text-muted); margin-top: 2px; }
.sp-glob-input {
  padding: 5px 8px;
  font-size: var(--font-xs);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  outline: none;
}
.sp-glob-input:focus { border-color: var(--accent-emphasis); }

/* summary */
.sp-summary {
  padding: 4px 12px;
  font-size: 11.5px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-muted);
  min-height: 20px;
}
.sp-muted { color: var(--text-muted); }
.sp-error { color: var(--danger-fg); }
.sp-trunc { color: var(--attention-fg); }

/* results */
.sp-results { flex: 1; overflow-y: auto; min-height: 0; padding: 4px 0; }
.sp-file-head {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 10px;
  cursor: pointer;
  user-select: none;
}
.sp-file-head:hover { background: var(--bg-hover); }
.sp-chev { display: inline-flex; color: var(--text-muted); transition: transform 0.1s; }
.sp-chev.open { transform: rotate(90deg); }
.sp-file-name { font-weight: 600; color: var(--text-primary); flex-shrink: 0; }
.sp-file-path { color: var(--text-muted); font-size: var(--font-2xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.sp-file-count {
  flex-shrink: 0;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
  border-radius: 8px;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.sp-file-replace {
  flex-shrink: 0;
  width: 20px; height: 20px;
  border: none; border-radius: 4px;
  background: transparent; color: var(--text-muted);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.sp-file-replace:hover { background: var(--bg-muted); color: var(--text-bright); }

.sp-match {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 1px 10px 1px 28px;
  cursor: pointer;
  white-space: nowrap;
}
.sp-match:hover { background: var(--bg-hover); }
.sp-ln { color: var(--text-muted); font-size: var(--font-2xs); min-width: 30px; text-align: right; flex-shrink: 0; }
.sp-text {
  font: 12px/1.6 ui-monospace, Menlo, monospace;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.sp-hit { background: var(--attention-muted, rgba(255, 213, 0, 0.25)); color: var(--text-bright); border-radius: 2px; }
.sp-match-actions { flex-shrink: 0; visibility: hidden; }
.sp-match:hover .sp-match-actions { visibility: visible; }
.sp-match-btn {
  width: 18px; height: 18px;
  border: none; border-radius: 3px;
  background: transparent; color: var(--text-muted);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.sp-match-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
</style>
