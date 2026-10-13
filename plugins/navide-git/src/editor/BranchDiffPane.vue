<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { parseHunks, toSideBySide, type Hunk, type SideRow } from '../lib/git-diff'
import type { GitTransport } from '#git-feature'
import type { GitBranchDiffPort } from '../ports/gitSurface'
import type { GitBranch, GitStatus } from '../composables/useGit'

const props = defineProps<{
  workspacePath: string
  base: string
  compare: string
  gitTransport: GitTransport
  branchDiff: GitBranchDiffPort
  // Injected by the parent surface rather than read from a second useGit()
  // instance: every instance subscribes to git.changed and fans out seven
  // loaders, so owning one here doubled the refresh cost of the whole window
  // just to hand two values to the review slot.
  gitStatus: GitStatus
  gitBranches: GitBranch[]
}>()

const emit = defineEmits<{
  (e: 'open-file', payload: { filepath: string; name: string; line?: number }): void
  (e: 'ask-ai-fix', text: string): void
}>()

function openFile(filename: string) {
  emit('open-file', { filepath: filename, name: filename.split('/').at(-1) ?? filename })
}

function closeReview(): void {
  reviewOpen.value = false
}

function reviewOpenFile(payload: { filepath: string; line: number | null }): void {
  emit('open-file', {
    filepath: payload.filepath,
    name: payload.filepath.split('/').at(-1) ?? payload.filepath,
    ...(payload.line === null ? {} : { line: payload.line }),
  })
}

function reviewAskAiFix(text: string): void {
  emit('ask-ai-fix', text)
}

const reviewOpen = ref(true)
const reviewHeight = ref(300)

function startReviewDrag(e: MouseEvent) {
  e.preventDefault()
  const startY = e.clientY
  const startH = reviewHeight.value
  function onMove(ev: MouseEvent) {
    reviewHeight.value = Math.max(80, Math.min(700, startH + (ev.clientY - startY)))
  }
  function onUp() {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

interface FileDiff {
  filename: string
  addCount: number
  delCount: number
  hunks: Hunk[]
  rows: Array<{ hunk: Hunk; sideRows: SideRow[]; hiddenAbove: number }>
}

const loading = ref(false)
const loadError = ref('')
const fileDiffs = ref<FileDiff[]>([])
const totalAdded = ref(0)
const totalDeleted = ref(0)
const resolvedCompare = ref('')
const collapsed = ref<Record<number, boolean>>({})

let _seq = 0

function splitFileDiffs(raw: string) {
  return raw
    .split(/(?=^diff --git )/m)
    .filter(p => p.startsWith('diff --git '))
    .map(p => {
      const m = p.match(/^diff --git a\/(.+?) b\//)
      return { filename: m?.[1] ?? '(unknown)', diff: p }
    })
}

function countLines(hunks: Hunk[]) {
  let added = 0; let deleted = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === '+') added++
      else if (l.kind === '-') deleted++
    }
  }
  return { added, deleted }
}

async function loadDiff() {
  if (!props.workspacePath) return
  const seq = ++_seq
  loading.value = true
  loadError.value = ''
  fileDiffs.value = []
  try {
    const result = await props.branchDiff.load(props.workspacePath, props.base, props.compare)
    if (seq !== _seq) return
    let raw = ''
    if (result.ok) raw = result.diff ?? ''
    else loadError.value = result.error || 'Failed to load diff'
    if (loadError.value) return
    const parts = splitFileDiffs(raw)
    let ta = 0; let td = 0
    fileDiffs.value = parts.map(p => {
      const parsed = parseHunks(p.diff)
      const { added, deleted } = countLines(parsed.hunks)
      ta += added; td += deleted
      const rows = parsed.hunks.map((hunk, i) => ({
        hunk,
        sideRows: toSideBySide(hunk),
        hiddenAbove: i === 0
          ? hunk.oldStart - 1
          : hunk.oldStart - (parsed.hunks[i - 1].oldStart + parsed.hunks[i - 1].oldCount),
      }))
      return { filename: p.filename, addCount: added, delCount: deleted, hunks: parsed.hunks, rows }
    })
    totalAdded.value = ta
    totalDeleted.value = td
    resolvedCompare.value = props.compare || ''
    collapsed.value = {}
  } catch (e) {
    if (seq === _seq) loadError.value = e instanceof Error ? e.message : 'Failed to load diff'
  } finally {
    if (seq === _seq) loading.value = false
  }
}

watch(() => props.gitTransport.status.value, s => {
  if (s === 'connected' && !fileDiffs.value.length && !loadError.value) void loadDiff()
}, { immediate: true })

watch([() => props.base, () => props.compare, () => props.workspacePath], () => loadDiff())

const allCollapsed = computed(() => fileDiffs.value.length > 0 && fileDiffs.value.every((_, i) => collapsed.value[i]))

function toggleCollapse(i: number) {
  collapsed.value = { ...collapsed.value, [i]: !collapsed.value[i] }
}

function collapseAll() {
  const next: Record<number, boolean> = {}
  fileDiffs.value.forEach((_, i) => { next[i] = true })
  collapsed.value = next
}

function expandAll() {
  collapsed.value = {}
}

function cellClass(cell: SideRow['left']): string {
  if (!cell) return 'k-empty'
  if (cell.kind === '+') return 'k-add'
  if (cell.kind === '-') return 'k-del'
  return 'k-ctx'
}
</script>

<template>
  <div class="bdp">
    <!-- Top bar -->
    <div class="bdp-bar">
      <span class="bdp-badge">±</span>
      <span class="bdp-title">{{ compare ? `${base} → ${resolvedCompare || compare}` : 'Working Changes' }}</span>
      <template v-if="!loading && fileDiffs.length">
        <span class="bdp-meta">{{ fileDiffs.length }} file{{ fileDiffs.length !== 1 ? 's' : '' }}</span>
        <span class="bdp-add">+{{ totalAdded }}</span>
        <span class="bdp-del">-{{ totalDeleted }}</span>
      </template>
      <div class="bdp-sp" />
      <template v-if="fileDiffs.length">
        <button class="bdp-btn" :title="allCollapsed ? 'Expand All' : 'Collapse All'"
          @click="allCollapsed ? expandAll() : collapseAll()">
          <svg v-if="allCollapsed" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.75 2.5a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H1.75zm0 5a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H1.75zm0 5a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H1.75z"/>
          </svg>
          <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M7.22 1.47a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1-1.06 1.06L8 3.06 5.53 5.53a.75.75 0 0 1-1.06-1.06l3.25-3.25zm-3.25 9 3.25 3.25a.75.75 0 0 0 1.06 0l3.25-3.25a.75.75 0 1 0-1.06-1.06L8 12.94l-2.47-2.47a.75.75 0 0 0-1.06 1.06z"/>
          </svg>
        </button>
      </template>
      <button class="bdp-btn" title="Refresh" :disabled="loading" @click="loadDiff">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 7.5A6 6 0 0 1 13 5.185V2.75a.75.75 0 0 1 1.5 0V7a.75.75 0 0 1-.75.75H9.25a.75.75 0 0 1 0-1.5h2.565A4.5 4.5 0 1 0 12 10a.75.75 0 1 1 1.261.815A6 6 0 1 1 1.5 7.5z"/>
        </svg>
      </button>
    </div>

    <!-- Optional AI review is supplied through a slot so the plugin graph does
         not import the review implementation or its extra chat surface. -->
    <div v-if="$slots.review" class="bdp-review-hdr" @click="reviewOpen = !reviewOpen">
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" class="bdp-review-ic">
        <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM7 5v3.5l3 1.5-.5 1L6 9V5z"/>
      </svg>
      <span class="bdp-review-label">{{ $t('label.ai-review') }}</span>
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
        class="bdp-chevron" :style="{ transform: reviewOpen ? '' : 'rotate(-90deg)' }">
        <path d="M4.427 7.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427z"/>
      </svg>
    </div>
    <div v-if="$slots.review" v-show="reviewOpen" class="bdp-review-body" :style="{ height: reviewHeight + 'px' }">
      <slot
        name="review"
        :workspace-path="workspacePath"
        :git-status="gitStatus"
        :git-branches="gitBranches"
        :close="closeReview"
        :open-file="reviewOpenFile"
        :ask-ai-fix="reviewAskAiFix"
      />
    </div>
    <div v-if="$slots.review" v-show="reviewOpen" class="bdp-review-resizer" @mousedown.prevent="startReviewDrag" />

    <!-- States -->
    <div v-if="loading" class="bdp-msg">{{ $t('label.loading-diff') }}</div>
    <div v-else-if="loadError" class="bdp-msg bdp-err">{{ loadError }}</div>
    <div v-else-if="!fileDiffs.length" class="bdp-msg">
      {{ compare ? `No changes between ${base} and ${resolvedCompare || compare}` : 'No uncommitted changes' }}
    </div>

    <!-- File list -->
    <div v-else class="bdp-scroll">
      <div v-for="(f, fi) in fileDiffs" :key="f.filename" class="bdp-file" :class="{ 'bdp-file--open': !collapsed[fi] }">

        <!-- File header row -->
        <div class="bdp-file-hdr" @click="toggleCollapse(fi)">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"
            class="bdp-chevron" :style="{ transform: collapsed[fi] ? 'rotate(-90deg)' : '' }">
            <path d="M4.427 7.427l3.396 3.396a.25.25 0 0 0 .354 0l3.396-3.396A.25.25 0 0 0 11.396 7H4.604a.25.25 0 0 0-.177.427z"/>
          </svg>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" class="bdp-file-ic">
            <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.56v2.19c0 .138.112.25.25.25h2.19Z"/>
          </svg>
          <span class="bdp-fname" v-truncate>{{ f.filename }}</span>
          <span v-if="f.addCount" class="bdp-add">+{{ f.addCount }}</span>
          <span v-if="f.delCount" class="bdp-del">-{{ f.delCount }}</span>
          <button class="bdp-open-btn" title="Open file" @click.stop="openFile(f.filename)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1z"/>
            </svg>
          </button>
        </div>

        <!-- Hunks (side-by-side) -->
        <div v-if="!collapsed[fi]" class="bdp-hunks">
          <template v-for="({ hunk, sideRows, hiddenAbove }, hi) in f.rows" :key="hi">

            <!-- Hidden lines separator -->
            <div v-if="hiddenAbove > 0" class="bdp-hidden">
              <div class="bdp-hidden-side" />
              <div class="bdp-hidden-side">{{ hiddenAbove }} hidden line{{ hiddenAbove !== 1 ? 's' : '' }}</div>
            </div>

            <!-- Hunk header -->
            <div class="bdp-hunk-hdr">
              <span class="bdp-range">{{ hunk.header }}</span>
            </div>

            <!-- Side-by-side grid -->
            <div class="bdp-grid">
              <template v-for="(row, ri) in sideRows" :key="ri">
                <!-- Left (old) -->
                <div class="bdp-side bdp-left" :class="cellClass(row.left)">
                  <span class="bdp-no">{{ row.left?.lineNo ?? '' }}</span>
                  <span class="bdp-sign">{{ row.left ? (row.left.kind === ' ' ? '' : row.left.kind) : '' }}</span>
                  <span class="bdp-code" v-truncate>{{ row.left?.text ?? '' }}</span>
                </div>
                <!-- Right (new) -->
                <div class="bdp-side bdp-right" :class="cellClass(row.right)">
                  <span class="bdp-no">{{ row.right?.lineNo ?? '' }}</span>
                  <span class="bdp-sign">{{ row.right ? (row.right.kind === ' ' ? '' : row.right.kind) : '' }}</span>
                  <span class="bdp-code" v-truncate>{{ row.right?.text ?? '' }}</span>
                </div>
              </template>
            </div>
          </template>
        </div>

      </div>
    </div>
  </div>
</template>

<style scoped>
.bdp {
  display: flex; flex-direction: column; height: 100%;
  background: var(--bg-base); color: var(--text-primary);
  font-size: 12px; overflow: hidden;
}

/* Top bar */
.bdp-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0; min-height: 28px; background: var(--bg-elevated);
}
.bdp-badge {
  font-size: 10px; font-weight: 700; color: var(--accent-fg);
  background: var(--accent-subtle); border-radius: 3px; padding: 1px 5px; flex-shrink: 0;
}
.bdp-title { font-size: 11px; font-weight: 600; color: var(--text-primary); }
.bdp-meta { font-size: 11px; color: var(--text-muted); margin-left: 4px; }
.bdp-add { font-size: 11px; color: var(--success-fg); font-variant-numeric: tabular-nums; }
.bdp-del { font-size: 11px; color: var(--danger-fg); font-variant-numeric: tabular-nums; }
.bdp-sp { flex: 1; }
.bdp-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; background: transparent; border: none;
  border-radius: 4px; color: var(--text-muted); cursor: pointer; padding: 0;
}
.bdp-btn:hover { color: var(--text-primary); background: var(--bg-active); }
.bdp-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* AI Review section */
.bdp-review-hdr {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; cursor: pointer; user-select: none;
  border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
  background: var(--bg-subtle);
}
.bdp-review-hdr:hover { background: var(--bg-hover); }
.bdp-review-ic { color: var(--accent-fg); flex-shrink: 0; }
.bdp-review-label {
  flex: 1; font-size: 11px; font-weight: 600; color: var(--text-primary);
}
.bdp-review-body {
  flex-shrink: 0; overflow: hidden;
  display: flex; flex-direction: column;
}
.bdp-review-resizer {
  height: 4px; flex-shrink: 0; cursor: ns-resize;
  background: var(--border-muted);
  transition: background 0.15s;
}
.bdp-review-resizer:hover { background: var(--accent-fg); opacity: 0.5; }

/* States */
.bdp-msg {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: var(--text-muted); padding: 24px; text-align: center;
}
.bdp-err { color: var(--danger-fg); }

/* Scroll container */
.bdp-scroll { flex: 1; overflow-y: auto; overflow-x: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }

/* File card */
.bdp-file {
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}

.bdp-file-hdr {
  display: flex; align-items: center; gap: 5px;
  padding: 6px 10px; cursor: pointer; user-select: none;
  background: var(--bg-subtle);
}
.bdp-file-hdr:hover { background: var(--bg-active); }
.bdp-file--open > .bdp-file-hdr { border-bottom: 1px solid var(--border-muted); }
.bdp-chevron { color: var(--text-muted); flex-shrink: 0; transition: transform 0.15s; }
.bdp-file-ic { color: var(--text-muted); flex-shrink: 0; }
.bdp-open-btn {
  display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; flex-shrink: 0;
  background: transparent; border: none; border-radius: 4px;
  color: var(--text-muted); cursor: pointer; padding: 0;
  opacity: 0; transition: opacity 0.1s;
}
.bdp-file-hdr:hover .bdp-open-btn { opacity: 1; }
.bdp-open-btn:hover { color: var(--accent-fg); background: var(--bg-hover-strong); }
.bdp-fname {
  flex: 1; font-size: 12px; font-weight: 600; color: var(--text-primary);
  font-family: ui-monospace, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Hidden lines row */
.bdp-hidden {
  display: grid; grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--border-muted);
}
.bdp-hidden-side {
  padding: 3px 10px; font-size: 11px; color: var(--text-muted);
  background: var(--bg-base); border-right: 1px solid var(--border-muted);
  font-style: italic;
}
.bdp-hidden-side:last-child { border-right: none; }

/* Hunk header */
.bdp-hunk-hdr {
  padding: 3px 10px; background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  font-family: ui-monospace, Menlo, monospace;
}
.bdp-range {
  font-size: 11px; color: var(--accent-fg); opacity: 0.85;
}

/* Side-by-side grid: each hunk is a 2-column grid */
.bdp-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--border-muted);
}

.bdp-side {
  display: flex; align-items: baseline; gap: 0;
  font-family: ui-monospace, Menlo, monospace; font-size: 12px;
  line-height: 1.5; min-width: 0; border-right: 1px solid var(--border-muted);
}
.bdp-right { border-right: none; }

.bdp-no {
  min-width: 36px; text-align: right; padding: 0 6px;
  color: var(--text-muted); user-select: none; flex-shrink: 0;
  font-variant-numeric: tabular-nums; font-size: 11px;
}
.bdp-sign {
  width: 14px; text-align: center; flex-shrink: 0;
  color: var(--text-muted); font-weight: 700;
}
.bdp-code {
  flex: 1; padding: 0 6px 0 2px; white-space: pre; overflow: hidden; text-overflow: ellipsis;
}

/* Cell colours */
.k-add  { background: color-mix(in srgb, var(--success-strong) 12%, transparent); }
.k-add .bdp-no, .k-add .bdp-sign { color: var(--success-fg); }
.k-del  { background: var(--diff-del-bg); }
.k-del .bdp-no, .k-del .bdp-sign { color: var(--danger-fg); }
.k-ctx  { background: transparent; }
.k-empty { background: rgba(0,0,0,0.06); }
</style>
