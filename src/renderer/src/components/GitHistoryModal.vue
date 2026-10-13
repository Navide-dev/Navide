<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { computeGraph, laneColor } from '../lib/git-graph'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import type { GitCommit, GitCommitDetail, DiffBlameHunk } from '../composables/useGit'

// The full-history dialog reuses the parent GitPane's single useGit instance
// (passed in as capabilities) so it never spawns duplicate event listeners or
// requests. It owns its own search / selection / context-menu state so the main
// panel keeps showing just the latest page untouched.
//
// Layout mimics Atlassian SourceTree's Git History: a filter bar, a dense
// five-column commit table (Graph / Description / Author / Date / Commit) on
// top, and a fixed detail split (metadata + files | inline diff) below.
const props = defineProps<{
  show: boolean
  // Inline component mode: render inside container without Teleport or popup header.
  inline?: boolean
  workspacePath: string
  gitLog: GitCommit[]
  logScope: 'all' | 'current'
  logOrder: 'ancestor' | 'date'
  isLoadingLog: boolean
  canLoadMoreLog: boolean
  setLogScope: (scope: 'all' | 'current') => Promise<void>
  setLogOrder: (order: 'ancestor' | 'date') => Promise<void>
  loadMoreLog: () => Promise<void>
  logSearch: (query: string, opts?: { scope?: 'all' | 'current'; limit?: number; order?: 'ancestor' | 'date' }) => Promise<GitCommit[]>
  showCommit: (hash: string) => Promise<GitCommitDetail | null>
  commitFileDiff: (hash: string, file: string) => Promise<DiffBlameHunk[]>
  cherryPick: (hash: string) => Promise<{ ok: boolean; error?: string }>
  revertCommit: (hash: string) => Promise<{ ok: boolean; error?: string }>
  checkoutCommit: (hash: string) => Promise<{ ok: boolean; error?: string }>
  createBranch: (name: string, startPoint?: string) => Promise<{ ok: boolean; error?: string }>
  createTag: (name: string, message?: string, hash?: string) => Promise<{ ok: boolean; error?: string }>
  mergeIntoCurrent: (ref: string) => Promise<{ ok: boolean; error?: string; conflict_files?: string[] }>
  resetToCommit: (commit: string, mode: 'soft' | 'mixed' | 'hard') => Promise<{ ok: boolean; error?: string }>
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { toast: notifyToast } = useNotify()

// ── search (backend, isolated from the parent's gitLog) ───────────────────────
const SEARCH_LIMIT = 50
const searchInputRef = ref<HTMLInputElement | null>(null)
const searchQuery = ref('')
const searchResults = ref<GitCommit[]>([])
const searchLimit = ref(SEARCH_LIMIT)
const searching = ref(false)
const searchActive = computed(() => searchQuery.value.trim().length > 0)

// When searching, show the backend results; otherwise mirror the shared gitLog.
// The search results are NEVER written back to props.gitLog — the main panel
// relies on gitLog staying pinned to the latest page.
const displayLog = computed<GitCommit[]>(() => (searchActive.value ? searchResults.value : props.gitLog))

let searchTimer: ReturnType<typeof setTimeout> | null = null
async function runSearch(): Promise<void> {
  const q = searchQuery.value.trim()
  if (!q) return
  searching.value = true
  try {
    const r = await props.logSearch(q, { scope: props.logScope, limit: searchLimit.value, order: props.logOrder })
    if (searchQuery.value.trim() === q) searchResults.value = r
  } finally {
    searching.value = false
  }
}
watch(searchQuery, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchLimit.value = SEARCH_LIMIT
  if (!searchActive.value) { searchResults.value = []; searching.value = false; return }
  searchTimer = setTimeout(() => void runSearch(), 280)
})
// Re-run an active search when the scope / order toggles.
watch(() => props.logScope, () => { if (searchActive.value) void runSearch() })
watch(() => props.logOrder, () => { if (searchActive.value) void runSearch() })

// ── filter bar controls (scope / order dropdowns, remote toggle) ──────────────
const showRemote = ref(true)
function onScopeChange(e: Event): void {
  void props.setLogScope((e.target as HTMLSelectElement).value as 'all' | 'current')
}
function onOrderChange(e: Event): void {
  void props.setLogOrder((e.target as HTMLSelectElement).value as 'ancestor' | 'date')
}

// ── load more (single long scroll list; no front-end pagination) ──────────────
const canLoadMore = computed(() =>
  searchActive.value ? searchResults.value.length >= searchLimit.value : props.canLoadMoreLog,
)
const isLoading = computed(() => (searchActive.value ? searching.value : props.isLoadingLog))
async function doLoadMore(): Promise<void> {
  if (searchActive.value) { searchLimit.value += SEARCH_LIMIT; await runSearch() }
  else await props.loadMoreLog()
}

// ── commit graph (own layout over this dialog's current list) ─────────────────
const GRAPH_LANE_W = 14
const graphLayout = computed(() =>
  computeGraph(displayLog.value.map((c) => ({ hash: c.hash, parents: c.parents ?? [] }))),
)
const graphWidth = computed(() => Math.max(graphLayout.value.width * GRAPH_LANE_W, GRAPH_LANE_W))
function laneX(lane: number): number { return lane * GRAPH_LANE_W + GRAPH_LANE_W / 2 }

// ── ref pills / HEAD detection ────────────────────────────────────────────────
type RefKind = 'head' | 'tag' | 'remote' | 'local'
function refPill(r: string): { label: string; kind: RefKind } {
  if (r.startsWith('tag: ')) return { label: r.slice(5), kind: 'tag' }
  if (r.startsWith('HEAD -> ')) return { label: r.slice(8), kind: 'head' }
  if (r === 'HEAD') return { label: 'HEAD', kind: 'head' }
  const s = r.replace(/^refs\/(heads|remotes)\//, '')
  if (s.startsWith('origin/')) return { label: s, kind: 'remote' }
  return { label: s, kind: 'local' }
}
function rowRefs(c: GitCommit): { label: string; kind: RefKind }[] {
  return (c.branches ?? []).map(refPill).filter((p) => showRemote.value || p.kind !== 'remote')
}
function isHeadCommit(c: GitCommit): boolean {
  return (c.branches ?? []).some((b) => b === 'HEAD' || b.startsWith('HEAD '))
}
function authorName(c: GitCommit): string { return c.author ?? '' }

// ── selection + detail split ──────────────────────────────────────────────────
const selectedHash = ref('')
const selectedCommit = computed<GitCommit | null>(
  () => displayLog.value.find((c) => c.hash === selectedHash.value) ?? null,
)
const commitDetailData = ref<GitCommitDetail | null>(null)
const commitDetailLoading = ref(false)
const commitDiffFile = ref('')
const commitDiffHunks = ref<DiffBlameHunk[]>([])
const commitDiffLoading = ref(false)
function resetCommitDiff(): void { commitDiffFile.value = ''; commitDiffHunks.value = []; commitDiffLoading.value = false }

async function selectCommit(hash: string): Promise<void> {
  if (selectedHash.value === hash) return
  selectedHash.value = hash
  resetCommitDiff()
  commitDetailData.value = null
  commitDetailLoading.value = true
  try {
    commitDetailData.value = await props.showCommit(hash)
  } finally {
    commitDetailLoading.value = false
  }
}
async function selectFile(file: string): Promise<void> {
  if (!selectedHash.value) return
  if (commitDiffFile.value === file) { resetCommitDiff(); return }
  commitDiffFile.value = file; commitDiffHunks.value = []; commitDiffLoading.value = true
  try {
    const hunks = await props.commitFileDiff(selectedHash.value, file)
    if (commitDiffFile.value === file) commitDiffHunks.value = hunks
  } finally {
    commitDiffLoading.value = false
  }
}

// ── commit context-menu actions ───────────────────────────────────────────────
const ctxMenu = ref<{ show: boolean; x: number; y: number; hash: string }>({ show: false, x: 0, y: 0, hash: '' })
function openCommitCtxMenu(e: MouseEvent, hash: string): void {
  e.preventDefault()
  e.stopPropagation()
  void selectCommit(hash)
  const x = Math.min(e.clientX, window.innerWidth - 244)
  const y = Math.min(e.clientY, window.innerHeight - 360)
  ctxMenu.value = { show: true, x, y, hash }
}
function closeCtxMenu(): void { ctxMenu.value.show = false }

async function doCheckoutCommit(hash: string): Promise<void> {
  const r = await props.checkoutCommit(hash); if (!r.ok) notifyToast(r.error || 'checkout failed', { type: 'error' })
}
async function doCherryPick(hash: string): Promise<void> {
  const r = await props.cherryPick(hash); if (!r.ok) notifyToast(r.error || 'cherry-pick failed', { type: 'error' })
}
async function doRevert(hash: string): Promise<void> {
  const r = await props.revertCommit(hash); if (!r.ok) notifyToast(r.error || 'revert failed', { type: 'error' })
}
async function doMerge(hash: string): Promise<void> {
  const r = await props.mergeIntoCurrent(hash); if (!r.ok) notifyToast(r.error || 'merge failed', { type: 'error' })
}
function copyCommitId(hash: string): void {
  void navigator.clipboard.writeText(hash)
  notifyToast('Commit ID copied', { type: 'info' })
}
function copyCommitMessage(hash: string): void {
  const c = displayLog.value.find((x) => x.hash === hash)
  void navigator.clipboard.writeText(c?.message ?? '')
  notifyToast('Commit message copied', { type: 'info' })
}

// Name-input modal shared by "Create Branch…" / "Create Tag…" from a commit.
const commitRefModal = ref<{ kind: 'branch' | 'tag'; hash: string; name: string; message: string; error: string } | null>(null)
function startCreateBranchFromCommit(hash: string): void {
  commitRefModal.value = { kind: 'branch', hash, name: '', message: '', error: '' }
  closeCtxMenu()
}
function startCreateTagFromCommit(hash: string): void {
  commitRefModal.value = { kind: 'tag', hash, name: '', message: '', error: '' }
  closeCtxMenu()
}
async function submitCommitRef(): Promise<void> {
  const m = commitRefModal.value; if (!m) return
  const name = m.name.trim(); if (!name) { m.error = 'name required'; return }
  const r = m.kind === 'branch'
    ? await props.createBranch(name, m.hash)
    : await props.createTag(name, m.message.trim(), m.hash)
  if (r.ok) commitRefModal.value = null; else m.error = r.error || 'failed'
}

// ── reset-current-branch dialog (soft / mixed / hard, in-app confirm) ─────────
const resetDialog = ref<{ hash: string; mode: 'soft' | 'mixed' | 'hard' | null } | null>(null)
function openResetDialog(hash: string): void {
  resetDialog.value = { hash, mode: null }
  closeCtxMenu()
}
async function confirmReset(): Promise<void> {
  const d = resetDialog.value; if (!d || !d.mode) return
  const r = await props.resetToCommit(d.hash, d.mode)
  if (!r.ok) notifyToast(r.error || 'reset failed', { type: 'error' })
  resetDialog.value = null
}

// ── layered ESC handling (window-level, so focus never eats the key) ──────────
function onKeydown(e: KeyboardEvent): void {
  if (!props.show || e.key !== 'Escape') return
  if (ctxMenu.value.show) { closeCtxMenu(); e.stopPropagation(); return }
  if (resetDialog.value) { resetDialog.value = null; e.stopPropagation(); return }
  if (commitRefModal.value) { commitRefModal.value = null; e.stopPropagation(); return }
  e.stopPropagation()
  emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

// Reset transient state when the dialog closes; autofocus search on open.
watch(() => props.show, (visible) => {
  if (!visible) {
    closeCtxMenu(); commitRefModal.value = null; resetDialog.value = null
    selectedHash.value = ''; commitDetailData.value = null; resetCommitDiff()
    return
  }
  void nextTick(() => searchInputRef.value?.focus())
})
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <template v-if="show">
      <div v-if="!inline" class="tp-backdrop nv-modal-overlay" @click="emit('close')" />
      <div class="history-modal nv-modal-shell nv-modal-shell--wide" :class="{ inline }" @click="closeCtxMenu()">
        <!-- Header -->
        <div v-if="!inline" class="hm-hdr">
          <span class="hm-title">{{ $t('label.history') }}</span>
          <div class="spacer" />
          <button class="hm-close" :title="$t('action.close')" @click="emit('close')">✕</button>
        </div>

        <!-- Filter bar -->
        <div class="hm-filterbar">
          <select class="hm-select" :value="logScope" :disabled="isLoadingLog" @change="onScopeChange">
            <option value="all">{{ $t('label.all-branches') }}</option>
            <option value="current">{{ $t('label.current-branch') }}</option>
          </select>
          <select class="hm-select" :value="logOrder" :disabled="isLoadingLog" @change="onOrderChange">
            <option value="date">{{ $t('label.date-order') }}</option>
            <option value="ancestor">{{ $t('label.ancestor-order') }}</option>
          </select>
          <label class="hm-toggle">
            <input v-model="showRemote" type="checkbox" />
            <span>{{ $t('label.show-remote-branches') }}</span>
          </label>
          <div class="hm-search">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="var(--text-muted)" style="flex-shrink:0"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>
            <input ref="searchInputRef" v-model="searchQuery" class="search-input" :placeholder="$t('label.search-commits')" />
          </div>
        </div>

        <!-- Upper: five-column commit table -->
        <div class="hm-table">
          <div class="tbl-head">
            <div class="col-graph" :style="{ width: graphWidth + 'px' }">{{ $t('label.col-graph') }}</div>
            <div class="col-desc">{{ $t('label.col-description') }}</div>
            <div class="col-author">{{ $t('label.col-author') }}</div>
            <div class="col-date">{{ $t('label.col-date') }}</div>
            <div class="col-commit">{{ $t('label.col-commit') }}</div>
          </div>
          <div class="tbl-body">
            <div v-if="!displayLog.length" class="empty-msg">
              {{ searchActive ? $t('label.no-matches') : $t('label.no-commits-yet') }}
            </div>
            <div
              v-for="(c, gi) in displayLog"
              v-else
              :key="c.hash"
              class="tbl-row"
              :class="{ selected: selectedHash === c.hash }"
              @click="selectCommit(c.hash)"
              @contextmenu.prevent="openCommitCtxMenu($event, c.hash)"
            >
              <div class="col-graph graph-cell" :style="{ width: graphWidth + 'px' }">
                <svg class="graph-svg" :viewBox="`0 0 ${graphWidth} 100`" preserveAspectRatio="none">
                  <line
                    v-for="(seg, si) in (graphLayout.rows[gi]?.segments ?? [])"
                    :key="si"
                    :x1="laneX(seg.fromLane)" :y1="seg.half === 'top' ? 0 : 50"
                    :x2="laneX(seg.toLane)" :y2="seg.half === 'top' ? 50 : 100"
                    :stroke="laneColor(seg.half === 'top' ? seg.fromLane : seg.toLane)"
                    stroke-width="1.5"
                  />
                </svg>
                <span
                  class="graph-dot"
                  :class="{ head: isHeadCommit(c) }"
                  :style="{ left: laneX(graphLayout.rows[gi]?.lane ?? 0) + 'px', background: laneColor(graphLayout.rows[gi]?.lane ?? 0) }"
                />
              </div>
              <div class="col-desc desc-cell">
                <span v-for="(p, pi) in rowRefs(c)" :key="pi" class="ref-pill" :class="p.kind">{{ p.label }}</span>
                <span class="desc-msg" v-truncate>{{ c.message }}</span>
              </div>
              <div class="col-author cell-ellip" v-truncate>{{ authorName(c) }}</div>
              <div class="col-date cell-ellip" v-truncate>{{ c.date ?? '' }}</div>
              <div class="col-commit"><code class="chash">{{ c.short_hash }}</code></div>
            </div>
          </div>
          <div v-if="canLoadMore" class="hm-loadmore">
            <button class="load-more-btn" :disabled="isLoading" @click="doLoadMore">
              {{ isLoading ? $t('label.loading') : $t('label.load-more') }}
            </button>
          </div>
        </div>

        <!-- Lower: detail split -->
        <div class="hm-detail">
          <div v-if="!selectedHash" class="detail-empty">{{ $t('label.no-commit-selected') }}</div>
          <template v-else>
            <div class="detail-left">
              <div v-if="commitDetailLoading" class="loading-text">{{ $t('label.loading') }}</div>
              <template v-else-if="commitDetailData">
                <div class="dl-msg">{{ commitDetailData.message }}</div>
                <div v-if="commitDetailData.body" class="dl-body">{{ commitDetailData.body }}</div>
                <div class="dl-meta">
                  <div class="dl-row"><span class="dl-key">{{ $t('label.col-commit') }}</span><code class="dl-mono">{{ commitDetailData.hash }}</code></div>
                  <div v-if="selectedCommit && selectedCommit.parents.length" class="dl-row">
                    <span class="dl-key">{{ $t('label.detail-parents') }}</span>
                    <span><code v-for="p in selectedCommit.parents" :key="p" class="dl-mono dl-parent">{{ p.slice(0, 8) }}</code></span>
                  </div>
                  <div class="dl-row"><span class="dl-key">{{ $t('label.col-author') }}</span><span>{{ commitDetailData.author_name }} &lt;{{ commitDetailData.author_email }}&gt;</span></div>
                  <div class="dl-row"><span class="dl-key">{{ $t('label.col-date') }}</span><span>{{ new Date(commitDetailData.date).toLocaleString() }}</span></div>
                </div>
                <div class="dl-files-hdr">{{ $t('label.changed-files') }} ({{ commitDetailData.files.length }})</div>
                <div class="dl-files">
                  <div
                    v-for="f in commitDetailData.files"
                    :key="f"
                    v-truncate
                    class="dl-file"
                    :class="{ active: commitDiffFile === f }"
                    @click="selectFile(f)"
                  >{{ f }}</div>
                </div>
              </template>
            </div>
            <div class="detail-right">
              <div v-if="!commitDiffFile" class="detail-empty">{{ $t('label.select-file-to-diff') }}</div>
              <div v-else-if="commitDiffLoading" class="loading-text">{{ $t('label.loading') }}</div>
              <div v-else-if="!commitDiffHunks.length" class="loading-text">{{ $t('label.no-changes') }}</div>
              <div v-else class="diff-view">
                <template v-for="(dh, dhi) in commitDiffHunks" :key="dhi">
                  <div class="db-hunk-head">{{ dh.header }}</div>
                  <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                    <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                    <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                    <code class="db-code">{{ dl.text }}</code>
                  </div>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>
    </template>
  </Teleport>

  <!-- ── commit context-menu ──────────────────────────────────────────── -->
  <Teleport to="body">
    <div v-if="ctxMenu.show" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
      <button class="menu-item" @click="doCheckoutCommit(ctxMenu.hash); closeCtxMenu()">⎇ {{ $t('action.checkout-detached') }}</button>
      <button class="menu-item" @click="startCreateBranchFromCommit(ctxMenu.hash)">＋ {{ $t('action.create-branch') }}</button>
      <button class="menu-item" @click="startCreateTagFromCommit(ctxMenu.hash)">🏷 {{ $t('action.create-tag') }}</button>
      <div class="menu-sep" />
      <button class="menu-item" @click="doMerge(ctxMenu.hash); closeCtxMenu()">⛙ {{ $t('action.merge-into-current') }}</button>
      <button class="menu-item" @click="doCherryPick(ctxMenu.hash); closeCtxMenu()">🍒 {{ $t('action.cherry-pick') }}</button>
      <button class="menu-item" @click="doRevert(ctxMenu.hash); closeCtxMenu()">↺ {{ $t('action.revert') }}</button>
      <button class="menu-item danger" @click="openResetDialog(ctxMenu.hash)">⟲ {{ $t('action.reset-current-branch') }}</button>
      <div class="menu-sep" />
      <button class="menu-item" @click="copyCommitId(ctxMenu.hash); closeCtxMenu()">⧉ {{ $t('action.copy-commit-id') }}</button>
      <button class="menu-item" @click="copyCommitMessage(ctxMenu.hash); closeCtxMenu()">⧉ {{ $t('action.copy-commit-message') }}</button>
    </div>
  </Teleport>

  <!-- ── Create branch / tag from a commit ────────────────────────────── -->
  <Teleport to="body">
    <div v-if="commitRefModal" class="tp-backdrop nv-modal-overlay" @click="commitRefModal = null" />
    <div v-if="commitRefModal" class="mini-modal" @click.stop>
      <div class="mini-modal-path">
        {{ commitRefModal.kind === 'branch' ? $t('label.create-branch-from') : $t('label.create-tag-at') }} {{ commitRefModal.hash.slice(0, 7) }}
      </div>
      <input v-model="commitRefModal.name" class="git-input" :placeholder="commitRefModal.kind === 'branch' ? $t('label.branch-name-placeholder') : 'v1.0.0'" @keydown.enter="submitCommitRef" />
      <input v-if="commitRefModal.kind === 'tag'" v-model="commitRefModal.message" class="git-input" :placeholder="$t('label.message-optional')" @keydown.enter="submitCommitRef" />
      <p v-if="commitRefModal.error" class="err-text">{{ commitRefModal.error }}</p>
      <div class="mini-modal-btns">
        <button class="btn-ghost sm nv-btn nv-btn--ghost" @click="commitRefModal = null">{{ $t('action.cancel') }}</button>
        <button class="btn-ghost sm nv-btn nv-btn--ghost" @click="submitCommitRef">{{ $t('action.create') }}</button>
      </div>
    </div>
  </Teleport>

  <!-- ── Reset current branch dialog (soft / mixed / hard) ───────────────── -->
  <Teleport to="body">
    <div v-if="resetDialog" class="tp-backdrop nv-modal-overlay" @click="resetDialog = null" />
    <div v-if="resetDialog" class="mini-modal" @click.stop>
      <div class="mini-modal-path">
        {{ $t('label.reset-title') }} → {{ resetDialog.hash.slice(0, 7) }}
      </div>
      <template v-if="!resetDialog.mode">
        <button class="reset-mode-btn" @click="resetDialog.mode = 'soft'">
          <span class="rm-name">Soft</span><span class="rm-desc">{{ $t('label.reset-soft-desc') }}</span>
        </button>
        <button class="reset-mode-btn" @click="resetDialog.mode = 'mixed'">
          <span class="rm-name">Mixed</span><span class="rm-desc">{{ $t('label.reset-mixed-desc') }}</span>
        </button>
        <button class="reset-mode-btn danger" @click="resetDialog.mode = 'hard'">
          <span class="rm-name">Hard</span><span class="rm-desc">{{ $t('label.reset-hard-desc') }}</span>
        </button>
        <div class="mini-modal-btns">
          <button class="btn-ghost sm nv-btn nv-btn--ghost" @click="resetDialog = null">{{ $t('action.cancel') }}</button>
        </div>
      </template>
      <template v-else>
        <p class="reset-confirm-text" :class="{ danger: resetDialog.mode === 'hard' }">
          {{ resetDialog.mode === 'hard' ? $t('label.reset-hard-warning') : $t('label.reset-confirm') }}
        </p>
        <div class="mini-modal-btns">
          <button class="btn-ghost sm nv-btn nv-btn--ghost" @click="resetDialog.mode = null">{{ $t('action.cancel') }}</button>
          <button class="btn-ghost sm nv-btn nv-btn--ghost" :class="{ 'btn-danger': resetDialog.mode === 'hard' }" @click="confirmReset">
            {{ $t('action.reset') }} ({{ resetDialog.mode }})
          </button>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.tp-backdrop {
  position: fixed; inset: 0; z-index: calc(var(--z-modal) + 150);
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
}

.history-modal {
  position: fixed; z-index: calc(var(--z-modal) + 151); top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(var(--modal-w-wide), 92vw); height: 86vh;
  background: var(--bg-base); border: 1px solid var(--border-default); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  display: flex; flex-direction: column; overflow: hidden;
}
/* Local entry animation: the shared .nv-modal-shell keyframes end on
   `transform: none`, which would drop this dialog's translate centering while
   they play. Same motion, centering preserved — and never in inline mode. */
.history-modal:not(.inline) { animation: hm-modal-in var(--motion-base) var(--ease-out); }
@keyframes hm-modal-in {
  from { opacity: 0; transform: translate(-50%, -50%) translateY(6px) scale(0.985); }
  to { opacity: 1; transform: translate(-50%, -50%); }
}
.history-modal.inline {
  position: relative; top: 0; left: 0; transform: none;
  width: 100%; height: 100%;
  border: none; border-radius: 0; box-shadow: none; animation: none;
}
.hm-hdr {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.hm-title { font-size: var(--font-sm); font-weight: 600; color: var(--text-primary); }
.spacer { flex: 1; }
.hm-close {
  background: transparent; border: none; color: var(--text-muted);
  font-size: var(--font-sm); cursor: pointer; padding: 2px 6px; border-radius: var(--radius-sm);
  transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.hm-close:hover { background: var(--bg-active); color: var(--text-primary); }

/* ── Filter bar ──────────────────────────────────────────────────────────── */
.hm-filterbar {
  display: flex; align-items: center; gap: 8px; padding: 6px 14px;
  border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.hm-select {
  background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: var(--font-2xs); padding: 3px 6px; cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out);
}
.hm-select:focus { outline: none; border-color: var(--accent-focus); }
.hm-select:disabled { opacity: 0.5; cursor: default; }
.hm-toggle { display: flex; align-items: center; gap: 4px; font-size: var(--font-2xs); color: var(--text-secondary); cursor: pointer; user-select: none; }
.hm-toggle input { margin: 0; cursor: pointer; }
.hm-search { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 120px; margin-left: auto; }
.search-input {
  flex: 1; background: transparent; border: none;
  border-bottom: 1px solid var(--border-default); color: var(--text-primary); font-size: var(--font-2xs); padding: 2px 0;
}
.search-input:focus { outline: none; border-bottom-color: var(--accent-focus); }
.search-input::placeholder { color: var(--text-muted); }

/* ── Five-column commit table (upper half) ───────────────────────────────── */
.hm-table { flex: 1 1 55%; display: flex; flex-direction: column; min-height: 0; border-bottom: 1px solid var(--border-default); }
.tbl-head, .tbl-row {
  display: flex; align-items: center; gap: 0;
  font-size: var(--font-xs); line-height: 1;
}
.tbl-head {
  flex-shrink: 0; height: 24px; padding: 0 14px;
  border-bottom: 1px solid var(--border-muted); background: var(--bg-subtle);
  color: var(--text-muted); font-size: var(--font-2xs); font-weight: 600; user-select: none;
}
.tbl-body { flex: 1; overflow-y: auto; }
.tbl-row { height: 24px; padding: 0 14px; cursor: pointer; color: var(--text-primary); transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
.tbl-row:hover { background: var(--bg-hover-faint); }
.tbl-row.selected { background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.tbl-row.selected .chash,
.tbl-row.selected .desc-msg,
.tbl-row.selected .cell-ellip { color: var(--text-on-emphasis); }

.col-graph { flex-shrink: 0; min-width: 44px; }
.col-desc { flex: 1; min-width: 0; max-width: 640px; display: flex; align-items: center; gap: 4px; padding-left: 10px; }
.col-author { width: 160px; flex-shrink: 0; padding: 0 8px; }
.col-date { width: 120px; flex-shrink: 0; padding: 0 8px; }
.col-commit { width: 88px; flex-shrink: 0; padding: 0 8px; }
.cell-ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
/* Thin column dividers on the header only — keeps the dense ledger legible
   without cluttering every body row (or fighting the selected-row fill). */
.tbl-head .col-author,
.tbl-head .col-date,
.tbl-head .col-commit { border-left: 1px solid var(--border-muted); }

.graph-cell { position: relative; align-self: stretch; }
.graph-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.graph-dot {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 8px; height: 8px; border-radius: 50%; background: var(--accent-focus);
  border: 2px solid var(--bg-base); box-shadow: 0 0 0 1px currentColor;
}
.graph-dot.head { box-shadow: 0 0 0 1px var(--success-fg), 0 0 4px var(--success-fg); }

.desc-msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
.ref-pill { font-size: var(--font-3xs); font-weight: 600; padding: 0 5px; border-radius: 999px; line-height: var(--lh-base); flex-shrink: 0; }
.ref-pill.local  { background: var(--accent-muted); color: var(--accent-bright); }
.ref-pill.remote { background: var(--success-subtle); color: var(--success-bright); }
.ref-pill.tag    { background: var(--attention-subtle); color: var(--attention-fg); }
.ref-pill.head   { background: var(--accent-emphasis); color: var(--text-on-emphasis); }
/* On the solid-accent selected row, tint pills with a translucent overlay so
   they stay legible instead of clashing with (or vanishing into) the fill. */
.tbl-row.selected .ref-pill { background: var(--overlay-soft); color: var(--text-on-emphasis); }
.chash { font-size: var(--font-2xs); color: var(--text-muted); font-family: var(--font-mono); background: transparent; }

.hm-loadmore { display: flex; justify-content: center; padding: 5px 0; flex-shrink: 0; }
.load-more-btn {
  background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: var(--font-2xs); padding: 3px 14px; cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.load-more-btn:hover:not(:disabled) { border-color: var(--accent-focus); color: var(--text-bright); }
.load-more-btn:disabled { opacity: 0.5; cursor: default; }

/* ── Detail split (lower half) ───────────────────────────────────────────── */
.hm-detail { flex: 1 1 45%; display: flex; min-height: 0; }
.detail-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: var(--font-2xs); font-style: italic; padding: 12px;
}
.detail-left {
  width: 42%; flex-shrink: 0; overflow-y: auto; padding: 8px 14px;
  border-right: 1px solid var(--border-default); font-size: var(--font-2xs);
}
.dl-msg { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); margin-bottom: 4px; white-space: pre-wrap; }
.dl-body { color: var(--text-secondary); font-size: var(--font-2xs); margin-bottom: 8px; white-space: pre-wrap; }
.dl-meta { margin-bottom: 8px; }
.dl-row { display: flex; gap: 8px; margin-bottom: 3px; color: var(--text-primary); }
.dl-key { color: var(--text-muted); min-width: 56px; flex-shrink: 0; }
.dl-mono { font-family: var(--font-mono); font-size: var(--font-3xs); color: var(--text-secondary); background: transparent; word-break: break-all; }
.dl-parent { margin-right: 6px; }
.dl-files-hdr { color: var(--text-muted); font-weight: 600; margin-bottom: 3px; }
.dl-files { display: flex; flex-direction: column; }
.dl-file {
  font-family: var(--font-mono); font-size: var(--font-3xs); color: var(--text-primary);
  padding: 2px 4px; border-radius: 3px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.dl-file:hover { background: var(--bg-hover-faint); }
.dl-file.active { background: var(--accent-muted); color: var(--accent-bright); }

.detail-right { flex: 1; min-width: 0; overflow: auto; padding: 4px 0; }
.diff-view { font-family: var(--font-mono); font-size: var(--font-2xs); }
.db-hunk-head { color: var(--accent-bright); font-size: var(--font-3xs); opacity: 0.8; padding: 2px 8px; white-space: pre; }
.db-line { display: flex; align-items: baseline; line-height: var(--lh-base); width: max-content; min-width: 100%; padding: 0 8px; }
.db-no { color: var(--text-muted); min-width: 34px; text-align: right; padding-right: 8px; flex-shrink: 0; user-select: none; }
.db-sign { width: 10px; flex-shrink: 0; text-align: center; user-select: none; }
.db-code { white-space: pre; flex-shrink: 0; }
.db-line.db-add { background: var(--diff-add-bg); }
.db-line.db-add .db-code, .db-line.db-add .db-sign { color: var(--success-bright); }
.db-line.db-del { background: var(--diff-del-bg); }
.db-line.db-del .db-code, .db-line.db-del .db-sign { color: var(--danger-fg); }
.db-line.db-ctx .db-code { color: var(--text-primary); }

.empty-msg { color: var(--text-muted); font-size: var(--font-2xs); font-style: italic; padding: 8px 14px; }
.loading-text { color: var(--text-muted); font-size: var(--font-3xs); padding: 6px 10px; }
.err-text { color: var(--danger-fg); font-size: var(--font-2xs); margin: 0; }

/* ── commit context menu ────────────────────────────────────────────────── */
.ctx-menu {
  position: fixed; z-index: calc(var(--z-modal) + 153);
  background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: var(--radius-sm); padding: 4px; min-width: 220px;
  box-shadow: 0 8px 24px var(--shadow-scrim);
}
.ctx-menu .menu-item {
  display: flex; align-items: center; width: 100%;
  background: transparent; border: none; color: var(--text-primary);
  font-size: var(--font-xs); padding: 5px 10px; border-radius: var(--radius-sm); cursor: pointer;
  text-align: left; font-family: var(--font-ui); gap: 6px;
  transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.ctx-menu .menu-item:hover { background: var(--bg-active); }
.ctx-menu .menu-item.danger { color: var(--danger-fg); }
.ctx-menu .menu-item.danger:hover { background: var(--danger-subtle, var(--bg-active)); }
.ctx-menu .menu-sep { height: 1px; background: var(--border-muted); margin: 4px 0; }

/* ── mini modals (create branch/tag, reset) ─────────────────────────────── */
.mini-modal {
  position: fixed; z-index: calc(var(--z-modal) + 152); top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(420px, 80vw); background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: var(--radius-md); padding: 16px; box-shadow: var(--shadow-modal);
  display: flex; flex-direction: column; gap: 10px;
}
.mini-modal-path {
  font-family: var(--font-mono); font-size: var(--font-2xs); color: var(--accent-fg);
  word-break: break-all;
}
.mini-modal-btns { display: flex; gap: 6px; justify-content: flex-end; }
.git-input {
  flex: 1; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: var(--font-2xs); padding: 3px 7px;
}
.git-input:focus { outline: none; border-color: var(--accent-focus); }

.reset-mode-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  background: var(--bg-base); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  padding: 7px 10px; cursor: pointer; text-align: left;
  transition: border-color var(--motion-fast) var(--ease-out);
}
.reset-mode-btn:hover { border-color: var(--accent-focus); }
.reset-mode-btn.danger:hover { border-color: var(--danger-fg); }
.rm-name { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); }
.reset-mode-btn.danger .rm-name { color: var(--danger-fg); }
.rm-desc { font-size: var(--font-3xs); color: var(--text-muted); }
.reset-confirm-text { font-size: var(--font-xs); color: var(--text-secondary); margin: 0; }
.reset-confirm-text.danger { color: var(--danger-fg); font-weight: 600; }

/* Canonical button spec — byte-identical in GitPane.vue,
   GitCredentialModal.vue and GitHistoryModal.vue. Scoped styles don't cross
   component boundaries, so the house spec is restated in each; keep the three
   copies in sync. Colours preserve each variant's existing identity (Git's
   primary action stays green); only the scale and the four states are new. */
.btn-primary,
.btn-ghost,
.btn-danger {
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-family: var(--font-ui);
  font-size: var(--font-xs);
  line-height: var(--lh-tight);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    opacity var(--motion-fast) var(--ease-out);
}
.btn-primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
}
.btn-primary:hover:not(:disabled) {
  background: var(--success-strong);
  border-color: var(--success-strong);
}
.btn-ghost {
  background: transparent;
  border-color: var(--border-default);
  color: var(--text-secondary);
}
.btn-ghost:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text-primary);
}
.btn-danger {
  background: var(--danger-emphasis);
  border-color: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.btn-danger:hover:not(:disabled) {
  background: var(--danger-bright);
  border-color: var(--danger-bright);
}
.btn-ghost.btn-danger {
  background: transparent;
  border-color: var(--danger-fg);
  color: var(--danger-fg);
}
.btn-ghost.btn-danger:hover:not(:disabled) {
  background: var(--danger-subtle);
  border-color: var(--danger-fg);
  color: var(--danger-fg);
}
.btn-primary.sm,
.btn-ghost.sm,
.btn-danger.sm {
  padding: 3px 7px;
  font-size: var(--font-2xs);
}
.btn-ghost.icon-only {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  flex: 0 0 auto;
}
.btn-primary:active:not(:disabled),
.btn-ghost:active:not(:disabled),
.btn-danger:active:not(:disabled) {
  transform: translateY(1px);
}
.btn-primary:focus-visible,
.btn-ghost:focus-visible,
.btn-danger:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.btn-primary:disabled,
.btn-ghost:disabled,
.btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
