<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import { parseHunks, buildPatch, hunkHasChanges, toSideBySide, type Hunk } from '../lib/git-diff'
import { loadImageDataUrl } from '../lib/imageData'
import type { GitTransport } from '#git-feature'
import type { GitFileAccessPort } from '../ports/gitSurface'

const props = defineProps<{
  workspacePath: string
  filepath: string
  staged: boolean
  name: string
  gitTransport: GitTransport
  fileAccess: GitFileAccessPort
  // When set, shows the diff this commit introduced (read-only: no stage/
  // unstage/discard actions) instead of the working-tree/staged diff.
  commit?: string
}>()

const emit = defineEmits<{
  'open-file': [{ filepath: string; name: string }]
  'close-state': [state: 'accepted' | 'busy']
}>()

const notify = useNotify()

// ── Hunk navigation ───────────────────────────────────────────────────────────
const bodyRef = ref<HTMLElement | null>(null)
const currentHunkIdx = ref(-1)

function hunkEls() {
  return bodyRef.value?.querySelectorAll('.dp-hunk') ?? ([] as Element[])
}

function jumpToHunk(idx: number): void {
  if (closePrepared.value || applying.value) return
  const els = hunkEls()
  if (!els.length) return
  const clamped = Math.max(0, Math.min(idx, els.length - 1))
  currentHunkIdx.value = clamped
  els[clamped]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function prevHunk(): void { jumpToHunk(currentHunkIdx.value <= 0 ? 0 : currentHunkIdx.value - 1) }
function nextHunk(): void {
  const count = hunkEls().length
  jumpToHunk(currentHunkIdx.value < count - 1 ? currentHunkIdx.value + 1 : count - 1)
}

const hunkCount = computed(() => parsed.value.hunks.length)
const atFirst = computed(() => currentHunkIdx.value <= 0)
const atLast = computed(() => currentHunkIdx.value >= hunkCount.value - 1)

const rawDiff = ref<string | null>(null)
const loading = ref(false)
const loadError = ref('')
const applying = ref(false)
const closePrepared = ref(false)
const selected = ref<Record<number, Set<number>>>({})
let _loadSeq = 0

const parsed = computed(() => (rawDiff.value ? parseHunks(rawDiff.value) : { fileHeader: '', hunks: [] }))
const isBinary = computed(() => rawDiff.value !== null && /^Binary files /m.test(rawDiff.value ?? ''))
const isEmpty = computed(() => rawDiff.value !== null && !isBinary.value && parsed.value.hunks.length === 0)

// Image preview: a binary image diff is meaningless as text, so show the
// working-tree version itself (base64 data URL — origin-independent). Detected
// by extension; before/after image diffs are out of scope.
const _IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.avif'])
const isImage = computed(() => {
  const m = props.filepath.toLowerCase().match(/\.[^./]+$/)
  return m ? _IMAGE_EXTS.has(m[0]) : false
})
const imageDataUrl = ref('')
async function loadImage(): Promise<void> {
  imageDataUrl.value = ''
  // Commit mode: the working-tree version may not match the commit — skip.
  if (props.commit || !isImage.value || !props.filepath) return
  imageDataUrl.value = await loadImageDataUrl(props.fileAccess, props.workspacePath, props.filepath)
}

async function loadDiff(): Promise<void> {
  if (!props.filepath) { rawDiff.value = null; return }
  const seq = ++_loadSeq
  loading.value = true
  loadError.value = ''
  try {
    const resp = await props.gitTransport.send<{ ok: boolean; diff: string; error?: string }>('git.diff_file', {
      workspace_path: props.workspacePath,
      filepath: props.filepath,
      staged: props.staged,
      commit: props.commit ?? '',
    })
    if (seq !== _loadSeq) return
    if (resp.ok && resp.payload?.ok) {
      rawDiff.value = resp.payload.diff ?? ''
      selected.value = {}
      currentHunkIdx.value = -1
    } else {
      loadError.value = resp.payload?.error || resp.error?.message || 'Failed to load diff'
    }
  } catch (err) {
    if (seq === _loadSeq) loadError.value = err instanceof Error ? err.message : 'Failed to load diff'
  } finally {
    if (seq === _loadSeq) loading.value = false
  }
}

watch(
  () => props.gitTransport.status.value,
  (s) => { if (s === 'connected' && rawDiff.value === null) { void loadDiff(); void loadImage() } },
  { immediate: true },
)

watch([() => props.filepath, () => props.staged, () => props.commit], () => {
  rawDiff.value = null
  void loadDiff()
  void loadImage()
})

function toggleLine(hunkIdx: number, lineIdx: number): void {
  if (closePrepared.value || applying.value) return
  const set = new Set(selected.value[hunkIdx] ?? [])
  if (set.has(lineIdx)) set.delete(lineIdx)
  else set.add(lineIdx)
  selected.value = { ...selected.value, [hunkIdx]: set }
}
function isSelected(hunkIdx: number, lineIdx: number): boolean {
  return selected.value[hunkIdx]?.has(lineIdx) ?? false
}
function selectedCount(hunkIdx: number): number {
  return selected.value[hunkIdx]?.size ?? 0
}

async function apply(patch: string, reverse: boolean, cached: boolean): Promise<void> {
  if (closePrepared.value || applying.value) return
  applying.value = true
  try {
    const resp = await props.gitTransport.send<{ ok: boolean; error?: string }>('git.apply_patch', {
      workspace_path: props.workspacePath,
      patch,
      reverse,
      cached,
    })
    if (!(resp.ok && resp.payload?.ok)) {
      notify.toast(resp.payload?.error || resp.error?.message || 'Failed to apply patch', { type: 'error' })
      return
    }
    await loadDiff()
  } catch (e) {
    notify.toast(e instanceof Error ? e.message : 'Failed to apply patch', { type: 'error' })
  } finally {
    applying.value = false
  }
}

function reloadDiff(): void {
  if (!closePrepared.value && !applying.value) void loadDiff()
}

function getCloseState(): 'accepted' | 'busy' {
  return closePrepared.value || applying.value ? 'busy' : 'accepted'
}

function setClosePrepared(prepared: boolean): void {
  closePrepared.value = prepared
}

watch([closePrepared, applying], () => emit('close-state', getCloseState()), { immediate: true })
defineExpose({ getCloseState, setClosePrepared })

function stageHunk(hunk: Hunk): void { void apply(buildPatch(parsed.value, hunk), false, true) }
function unstageHunk(hunk: Hunk): void { void apply(buildPatch(parsed.value, hunk), true, true) }
function discardHunk(hunk: Hunk): void { void apply(buildPatch(parsed.value, hunk), true, false) }
function stageSelected(hunk: Hunk, hunkIdx: number): void {
  const set = selected.value[hunkIdx]
  if (!set || set.size === 0) return
  void apply(buildPatch(parsed.value, hunk, set), false, true)
}

function cellClass(cell: { kind: ' ' | '+' | '-' } | null): string {
  if (!cell) return 'empty'
  if (cell.kind === '+') return 'k-add'
  if (cell.kind === '-') return 'k-del'
  return 'k-ctx'
}
</script>

<template>
  <div class="diff-pane">
    <div class="dp-toolbar">
      <span v-if="commit" class="dp-badge commit">{{ commit.slice(0, 7) }}</span>
      <span v-else class="dp-badge" :class="staged ? 'staged' : 'unstaged'">{{ staged ? 'STAGED' : 'WORKING TREE' }}</span>
      <span class="dp-filepath" v-truncate>{{ filepath }}</span>
      <div class="dp-toolbar-actions">
        <!-- Open file in editor -->
        <button class="dp-tbtn" title="Open file in editor" @click="emit('open-file', { filepath, name })">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25V1.75zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5H3.75zm6.75.56v2.19c0 .138.112.25.25.25h2.19L10.5 2.06z"/>
          </svg>
        </button>
        <!-- Prev hunk -->
        <button class="dp-tbtn" title="Previous change (↑)" :disabled="closePrepared || applying || !hunkCount || atFirst" @click="prevHunk">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7.78 12.53a.75.75 0 0 1-1.06 0L2.47 8.28a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L4.81 7h7.44a.75.75 0 0 1 0 1.5H4.81l2.97 2.97a.75.75 0 0 1 0 1.06z" transform="rotate(90 8 8)"/></svg>
        </button>
        <!-- Next hunk -->
        <button class="dp-tbtn" title="Next change (↓)" :disabled="closePrepared || applying || !hunkCount || atLast" @click="nextHunk">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8.22 3.47a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L11.19 9H3.75a.75.75 0 0 1 0-1.5h7.44L8.22 4.53a.75.75 0 0 1 0-1.06z" transform="rotate(90 8 8)"/></svg>
        </button>
        <button class="dp-tbtn" title="Reload diff" :disabled="closePrepared || applying" @click="reloadDiff">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
        </button>
      </div>
    </div>

    <div ref="bodyRef" class="dp-body">
      <div v-if="loading" class="dp-msg">{{ $t('label.loading') }}</div>
      <div v-else-if="loadError" class="dp-msg err">{{ loadError }}</div>
      <div v-else-if="isImage && imageDataUrl" class="dp-img-wrap">
        <img :src="imageDataUrl" class="dp-img" :alt="name" />
      </div>
      <div v-else-if="isBinary" class="dp-msg">{{ $t('label.binary-file') }}</div>
      <div v-else-if="isEmpty" class="dp-msg">{{ $t('label.no-changes') }}</div>
      <div v-else-if="rawDiff === null" class="dp-msg">
        Diff not loaded
        <button class="dp-refresh" style="margin-left: 8px" :disabled="closePrepared || applying" @click="reloadDiff">{{ $t('action.reload') }}</button>
      </div>
      <div v-else class="dp-hunks">
        <div v-for="(hunk, hi) in parsed.hunks" :key="hi" class="dp-hunk" :class="{ active: hi === currentHunkIdx }">
          <div class="dp-hunk-head">
            <span class="dp-range">{{ hunk.header }}</span>
            <span v-if="!commit" class="dp-actions">
              <template v-if="staged">
                <button class="hk-btn" :disabled="closePrepared || applying" @click="unstageHunk(hunk)">{{ $t('action.unstage-hunk') }}</button>
              </template>
              <template v-else>
                <button v-if="hunkHasChanges(hunk)" class="hk-btn" :disabled="closePrepared || applying" @click="stageHunk(hunk)">{{ $t('action.stage-hunk') }}</button>
                <button v-if="selectedCount(hi) > 0" class="hk-btn primary" :disabled="closePrepared || applying" @click="stageSelected(hunk, hi)">Stage Selected ({{ selectedCount(hi) }})</button>
                <button v-if="hunkHasChanges(hunk)" class="hk-btn danger" :disabled="closePrepared || applying" @click="discardHunk(hunk)">{{ $t('action.discard-hunk') }}</button>
              </template>
            </span>
          </div>
          <div class="dp-grid">
            <template v-for="(row, ri) in toSideBySide(hunk)" :key="ri">
              <div class="dp-side left" :class="cellClass(row.left)">
                <span class="dp-no">{{ row.left ? row.left.lineNo : '' }}</span>
                <input v-if="!commit && !staged && row.left && row.left.kind === '-'" class="dp-check" type="checkbox" :disabled="closePrepared || applying" :checked="isSelected(hi, row.left.idx)" @change="toggleLine(hi, row.left.idx)" />
                <span v-else class="dp-check-sp" />
                <span class="dp-sign">{{ row.left ? row.left.kind : '' }}</span>
                <span class="dp-code">{{ row.left ? row.left.text : '' }}</span>
              </div>
              <div class="dp-side right" :class="cellClass(row.right)">
                <span class="dp-no">{{ row.right ? row.right.lineNo : '' }}</span>
                <input v-if="!commit && !staged && row.right && row.right.kind === '+'" class="dp-check" type="checkbox" :disabled="closePrepared || applying" :checked="isSelected(hi, row.right.idx)" @change="toggleLine(hi, row.right.idx)" />
                <span v-else class="dp-check-sp" />
                <span class="dp-sign">{{ row.right ? row.right.kind : '' }}</span>
                <span class="dp-code">{{ row.right ? row.right.text : '' }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.dp-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  flex-shrink: 0;
  font-size: 12px;
}
.dp-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  flex-shrink: 0;
}
.dp-badge.staged { background: var(--success-subtle); color: var(--success-fg); }
.dp-badge.unstaged { background: var(--attention-subtle); color: var(--attention-fg); }
.dp-badge.commit { background: var(--accent-subtle); color: var(--accent-fg); font-family: ui-monospace, Menlo, monospace; }
.dp-filepath {
  flex: 1;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, Menlo, monospace;
}
.dp-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.dp-tbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
}
.dp-tbtn:hover:not(:disabled) { background: var(--bg-muted); color: var(--text-primary); }
.dp-tbtn:disabled { opacity: 0.35; cursor: default; }

.dp-body { flex: 1; overflow: auto; }
.dp-msg { padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px; }
.dp-msg.err { color: var(--danger-fg); }

.dp-img-wrap { display: flex; justify-content: center; padding: 24px; }
.dp-img { max-width: 100%; max-height: 70vh; object-fit: contain; border-radius: 4px; box-shadow: 0 2px 16px rgba(0,0,0,.3); }

.dp-hunk { border-bottom: 1px solid var(--border-muted); }
.dp-hunk.active { outline: 1px solid var(--accent-emphasis); outline-offset: -1px; }
.dp-hunk-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-subtle);
  padding: 3px 10px;
  position: sticky;
  top: 0;
  z-index: 1;
}
.dp-range { color: var(--accent-fg); font-family: ui-monospace, Menlo, monospace; font-size: 11px; opacity: 0.85; }
.dp-actions { display: flex; gap: 5px; }
.hk-btn {
  background: var(--bg-muted);
  color: var(--text-primary);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
.hk-btn:hover { background: var(--bg-base); }
.hk-btn.primary { background: color-mix(in srgb, var(--accent-emphasis) 20%, transparent); border-color: var(--accent-emphasis); color: var(--accent-fg); }
.hk-btn.danger:hover { background: color-mix(in srgb, var(--danger-fg) 13%, transparent); border-color: var(--danger-fg); color: var(--danger-fg); }

.dp-grid { display: grid; grid-template-columns: 1fr 1fr; }
.dp-side {
  display: flex;
  align-items: flex-start;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  padding-right: 8px;
  min-height: 18px;
}
.dp-side.left { border-right: 1px solid var(--border-muted); }
.dp-side.empty { background: var(--bg-subtle); }
.dp-no { width: 42px; flex-shrink: 0; text-align: right; padding-right: 8px; color: var(--text-muted); user-select: none; font-size: 11px; }
.dp-check { margin: 2px 3px 0 0; flex-shrink: 0; cursor: pointer; }
.dp-check-sp { width: 16px; flex-shrink: 0; }
.dp-sign { width: 10px; flex-shrink: 0; text-align: center; user-select: none; }
.dp-code { white-space: pre-wrap; word-break: break-all; }
.dp-side.k-del { background: var(--diff-del-bg); }
.dp-side.k-del .dp-code, .dp-side.k-del .dp-sign { color: var(--danger-fg); }
.dp-side.k-add { background: var(--diff-add-bg); }
.dp-side.k-add .dp-code, .dp-side.k-add .dp-sign { color: var(--success-bright); }
.dp-side.k-ctx .dp-code { color: var(--text-primary); }
</style>
