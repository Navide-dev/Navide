<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, toRef, nextTick } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { useEditorTargets } from '../composables/useEditorTargets'
import { useExplorer, type FsEntry } from '../composables/useExplorer'
import { useGit } from '../composables/useGit'
import { createHostGitTransport } from '../composables/hostGitTransport'
import { createHostGitCredentialPort } from '../composables/hostSurfacePorts'
import { revealPath } from '../composables/hostShell'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'

import { usePreview } from '../preview/usePreview'

const props = defineProps<{
  workspacePath: string
  // The alias the user gave this workspace, when the host knows one. Optional
  // because the two hosts learn it in different ways — the main window from its
  // alias store, the mini-IDE from its entry query — so each passes its own
  // already-resolved value and a host that has none simply omits it, leaving
  // the folder name (the behaviour before aliases existed).
  workspaceDisplayName?: string
  backend: ReturnType<typeof useBackend>
  // When embedded inside the editor window, file opens are handled in-place via
  // the `open-file` event instead of spawning a separate editor window.
  embedded?: boolean
  onAskAiAboutFile?: (relPath: string) => void
}>()

const preview = usePreview()

const emit = defineEmits<{
  (e: 'open-file', payload: { filepath: string; name: string }): void
  // Fired after every successful fs.rename (inline rename and drag-to-move,
  // file or folder) so the host can rebind open editor tabs to the new path.
  (e: 'entry-renamed', payload: { oldRel: string; newRel: string }): void
}>()

const wsRef = toRef(props, 'workspacePath')
// Skip focus-refreshes while the inline create/rename prompt is open so the
// user's input is never clobbered. (`prompt` is declared below; the guard only
// runs on later focus events.)
const explorer = useExplorer(props.backend, wsRef, { isRefreshBlocked: () => prompt.value !== null })
const git = useGit(() => props.workspacePath, createHostGitTransport(props.backend), createHostGitCredentialPort())
const { toast, alert, confirm } = useNotify()

type FsResult = { ok: boolean; error?: string }

const statusMap = computed(() => explorer.buildStatusMap(git.gitStatus.value))

interface Row {
  entry: FsEntry
  depth: number
}

interface DirNote {
  dirRel: string
  kind: 'error' | 'truncated'
  message: string
  depth: number
}

// Flatten the lazily-loaded cache + expanded set into a render list, plus
// inline notes (load error / truncated listing) anchored after the last
// rendered row of the dir they belong to. Notes are kept out of `rows` so
// selection and keyboard navigation are unaffected.
const treeView = computed<{ rows: Row[]; notes: Map<string, DirNote[]> }>(() => {
  const out: Row[] = []
  const notes = new Map<string, DirNote[]>()
  const addNotes = (dirRel: string, depth: number): void => {
    const anchor = out[out.length - 1]?.entry.rel_path
    if (anchor === undefined) return
    const list = notes.get(anchor) ?? []
    const err = explorer.dirErrors.value.get(dirRel)
    if (err) list.push({ dirRel, kind: 'error', message: err, depth })
    if (explorer.truncatedDirs.value.has(dirRel)) list.push({ dirRel, kind: 'truncated', message: '', depth })
    if (list.length) notes.set(anchor, list)
  }
  const walk = (rel: string, depth: number): void => {
    const children = explorer.childrenCache.value.get(rel) ?? []
    for (const entry of children) {
      out.push({ entry, depth })
      if (entry.is_dir && explorer.isExpanded(entry.rel_path)) {
        walk(entry.rel_path, depth + 1)
        addNotes(entry.rel_path, depth + 1)
      }
    }
  }
  walk('', 0)
  addNotes('', 0)
  return { rows: out, notes }
})
const rows = computed<Row[]>(() => treeView.value.rows)

const wsName = computed(() => {
  // A blank alias is the same as none — that is how clearing one works.
  const alias = props.workspaceDisplayName?.trim()
  if (alias) return alias
  const p = props.workspacePath.replace(/\/+$/, '')
  return p.split('/').pop() || p
})

function absPath(rel: string): string {
  return `${props.workspacePath.replace(/\/+$/, '')}/${rel}`
}

function statusFor(rel: string): { letter: string; staged: boolean } | undefined {
  return statusMap.value.get(rel)
}

const STATUS_CLASS: Record<string, string> = {
  M: 'st-mod', A: 'st-add', D: 'st-del', U: 'st-untracked',
  R: 'st-mod', C: 'st-mod', '?': 'st-untracked',
}

// Folders inheriting the status of any descendant change (VS Code-style):
// a tracked change (M/A/D/R/C) tints the folder yellow, untracked-only green.
const dirStatusMap = computed(() => {
  const map = new Map<string, string>()
  for (const [path, info] of statusMap.value) {
    const cls = info.letter === 'U' ? 'st-untracked' : 'st-mod'
    let idx = path.lastIndexOf('/')
    while (idx > 0) {
      const dir = path.slice(0, idx)
      if (map.get(dir) !== 'st-mod') map.set(dir, cls) // tracked wins over untracked
      idx = dir.lastIndexOf('/')
    }
  }
  return map
})

// Status class for an entry, applied to the filename (VS Code-style tint) and
// the trailing letter badge. Folders inherit from descendants; '' = clean.
function statusClassFor(entry: FsEntry): string {
  if (entry.is_dir) return dirStatusMap.value.get(entry.rel_path) || ''
  const st = statusFor(entry.rel_path)
  return st ? STATUS_CLASS[st.letter] || 'st-mod' : ''
}

// ── Multi-select ──────────────────────────────────────────────────────────────
const selectedKeys = ref(new Set<string>())
const lastClickKey = ref<string | null>(null)

const selectedFilePaths = computed<string[]>(() => {
  const fileRels = new Set(rows.value.filter(r => !r.entry.is_dir).map(r => r.entry.rel_path))
  return [...selectedKeys.value].filter(k => fileRels.has(k))
})

function clearSelection(): void {
  selectedKeys.value = new Set()
  lastClickKey.value = null
}

function rangeSelect(toKey: string): void {
  const keys = rows.value.map(r => r.entry.rel_path)
  const from = lastClickKey.value ? keys.indexOf(lastClickKey.value) : -1
  const to = keys.indexOf(toKey)
  if (from < 0 || to < 0) {
    selectedKeys.value = new Set([toKey])
    lastClickKey.value = toKey
    return
  }
  const [start, end] = from <= to ? [from, to] : [to, from]
  const next = new Set(selectedKeys.value)
  for (let i = start; i <= end; i++) next.add(keys[i])
  selectedKeys.value = next
  lastClickKey.value = toKey
}

function handleRowClick(e: MouseEvent, entry: FsEntry): void {
  const key = entry.rel_path
  if (e.ctrlKey || e.metaKey) {
    const next = new Set(selectedKeys.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    selectedKeys.value = next
    lastClickKey.value = key
    return
  }
  if (e.shiftKey) {
    rangeSelect(key)
    return
  }
  // plain click
  selectedKeys.value = new Set([key])
  lastClickKey.value = key
  if (entry.is_dir) void explorer.toggleDir(key)
  else openInEditor(entry)
}

function openSelected(): void {
  for (const rel of selectedFilePaths.value) {
    const entry = rows.value.find(r => r.entry.rel_path === rel)?.entry
    if (entry) openInEditor(entry)
  }
}

async function deleteSelected(): Promise<void> {
  const count = selectedKeys.value.size
  const ok = await confirm(`Delete ${count} selected items? They will be moved to the Trash.`, {
    title: 'Delete',
    confirmText: 'Delete',
  })
  if (!ok) return
  // Sort shallowest first; skip children whose ancestor is also selected
  const paths = [...selectedKeys.value].sort((a, b) => a.split('/').length - b.split('/').length)
  const deleted = new Set<string>()
  for (const rel of paths) {
    const parentDeleted = [...deleted].some(d => rel.startsWith(d + '/'))
    if (parentDeleted) continue
    try {
      const res = await props.backend.send<FsResult>('fs.delete', {
        workspace_path: props.workspacePath,
        rel_path: rel,
      })
      if (!res.payload?.ok) {
        void alert(res.payload?.error || `Failed to delete "${rel}"`, { title: 'Error' })
      } else {
        deleted.add(rel)
      }
    } catch (err) {
      void alert(err instanceof Error ? err.message : `Failed to delete "${rel}"`, { title: 'Error' })
    }
  }
  for (const rel of deleted) explorer.pruneDir(rel)
  clearSelection()
  await explorer.refreshVisible()
}

async function copyPathsSelected(): Promise<void> {
  const text = [...selectedKeys.value].map(rel => absPath(rel)).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    toast(`Copied ${selectedKeys.value.size} path(s)`, { type: 'success' })
  } catch {
    toast('Copy failed', { type: 'error' })
  }
}

// Send a file (or its diff) to the main window's right-rail preview panel.
// Explicit context-menu entries rather than a click-behaviour change: a plain
// click already opens the editor, and rebinding it would break that.
function previewFile(entry: FsEntry): void {
  preview.show({
    kind: 'file',
    workspacePath: props.workspacePath,
    relPath: entry.rel_path,
    source: 'user',
  })
}

function previewDiff(entry: FsEntry): void {
  const st = statusFor(entry.rel_path)
  preview.show({
    kind: 'diff',
    workspacePath: props.workspacePath,
    relPath: entry.rel_path,
    staged: st?.staged ?? false,
    source: 'user',
  })
}

function openDiff(entry: FsEntry): void {
  const st = statusFor(entry.rel_path)
  void window.agentTeam?.openDiffWindow({
    workspace_path: props.workspacePath,
    filepath: entry.rel_path,
    staged: st?.staged ?? false,
    name: entry.name,
  })
}

function openInEditor(entry: FsEntry): void {
  if (props.embedded) {
    emit('open-file', { filepath: entry.rel_path, name: entry.name })
    return
  }
  void window.agentTeam?.openEditorWindow({
    workspace_path: props.workspacePath,
    filepath: entry.rel_path,
    name: entry.name,
  })
}

// ── Open a folder in an editor ───────────────────────────────────────────────
const { editorTargets, loadEditorTargets } = useEditorTargets()

// The pane also runs inside the editor window's file tree; hosts without the
// bridge simply don't get the folder-open items.
function canOpenFolderInEditor(): boolean {
  return typeof window.agentTeam?.openFolderInEditor === 'function'
}

function openFolderInEditor(entry: FsEntry, editorId?: string): void {
  void window.agentTeam?.openFolderInEditor(absPath(entry.rel_path), editorId)
}

// ── Context menu ─────────────────────────────────────────────────────────────
const ctx = ref<{ x: number; y: number; entry: FsEntry | null } | null>(null)

function openCtx(e: MouseEvent, entry: FsEntry | null): void {
  e.preventDefault()
  ctx.value = { x: e.clientX, y: e.clientY, entry }
  if (entry?.is_dir) void loadEditorTargets()
}
function closeCtx(): void {
  ctx.value = null
}

watch(ctx, (val, old) => {
  if (val && !old) {
    document.addEventListener('click', closeCtx)
  } else if (!val && old) {
    document.removeEventListener('click', closeCtx)
  }
})
onUnmounted(() => document.removeEventListener('click', closeCtx))

// ── Inline prompt (create / rename) ──────────────────────────────────────────
const prompt = ref<{
  kind: 'new-file' | 'new-folder' | 'rename'
  title: string
  value: string
  parentRel: string
  srcRel?: string
} | null>(null)
const promptInput = ref<HTMLInputElement | null>(null)

function startNew(kind: 'new-file' | 'new-folder', entry: FsEntry | null): void {
  // New items go inside the entry if it's a dir, else alongside it (its parent).
  const parentRel = entry ? (entry.is_dir ? entry.rel_path : parentOf(entry.rel_path)) : ''
  prompt.value = {
    kind,
    title: kind === 'new-file' ? 'New File' : 'New Folder',
    value: '',
    parentRel,
  }
  focusPrompt()
}

function startRename(entry: FsEntry): void {
  prompt.value = {
    kind: 'rename',
    title: 'Rename',
    value: entry.name,
    parentRel: parentOf(entry.rel_path),
    srcRel: entry.rel_path,
  }
  focusPrompt()
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

function focusPrompt(): void {
  void Promise.resolve().then(() => promptInput.value?.focus())
}

async function submitPrompt(): Promise<void> {
  const p = prompt.value
  if (!p) return
  const name = p.value.trim()
  if (!name) {
    prompt.value = null
    return
  }
  if (name.includes('/') || name.includes('\\')) {
    void alert('Name cannot contain path separators', { title: 'Error' })
    return
  }
  const rel = p.parentRel ? `${p.parentRel}/${name}` : name
  let res: { payload: FsResult | null }
  try {
    if (p.kind === 'new-file') {
      res = await props.backend.send<FsResult>('fs.create_file', { workspace_path: props.workspacePath, rel_path: rel })
    } else if (p.kind === 'new-folder') {
      res = await props.backend.send<FsResult>('fs.mkdir', { workspace_path: props.workspacePath, rel_path: rel })
    } else {
      res = await props.backend.send<FsResult>('fs.rename', {
        workspace_path: props.workspacePath,
        src_path: p.srcRel,
        dst_path: rel,
      })
    }
  } catch (err) {
    prompt.value = null
    void alert(err instanceof Error ? err.message : 'Operation failed', { title: 'Error' })
    return
  }
  prompt.value = null
  if (!res.payload?.ok) {
    void alert(res.payload?.error || 'Operation failed', { title: 'Error' })
    return
  }
  // Drop stale expansion/cache state under the old path; keep the subtree
  // expanded under the new one.
  if (p.kind === 'rename' && p.srcRel) {
    explorer.pruneDir(p.srcRel, rel)
    emit('entry-renamed', { oldRel: p.srcRel, newRel: rel })
  }
  // Make sure the affected dir is expanded so the result is visible.
  if (p.kind !== 'rename' && p.parentRel && !explorer.isExpanded(p.parentRel)) {
    await explorer.toggleDir(p.parentRel)
  }
  await explorer.refreshVisible()
}

async function doDelete(entry: FsEntry): Promise<void> {
  const ok = await confirm(`Delete "${entry.name}"? It will be moved to the Trash.`, {
    title: 'Delete',
    confirmText: 'Delete',
  })
  if (!ok) return
  let res: { payload: FsResult | null }
  try {
    res = await props.backend.send<FsResult>('fs.delete', {
      workspace_path: props.workspacePath,
      rel_path: entry.rel_path,
    })
  } catch (err) {
    void alert(err instanceof Error ? err.message : 'Delete failed', { title: 'Error' })
    return
  }
  if (!res.payload?.ok) {
    void alert(res.payload?.error || 'Delete failed', { title: 'Error' })
    return
  }
  explorer.pruneDir(entry.rel_path)
  await explorer.refreshVisible()
}

async function reveal(entry: FsEntry): Promise<void> {
  await revealPath(absPath(entry.rel_path))
}

async function copyPath(entry: FsEntry): Promise<void> {
  try {
    await navigator.clipboard.writeText(absPath(entry.rel_path))
    toast('Path copied', { type: 'success' })
  } catch {
    toast('Copy failed', { type: 'error' })
  }
}

// ── Drag to move ─────────────────────────────────────────────────────────────
// Rows keep their absolute-path text/plain dragstart payload (cross-window
// drags depend on it). In-tree, folder rows and the tree background accept
// drops and move the dragged entry via fs.rename, keeping its basename.
const dropTargetRel = ref<string | null>(null) // '' = workspace root

// During dragover the payload is unreadable (dataTransfer protected mode), so
// only gate on types here; the path itself is validated on drop.
function canAcceptDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  const list = Array.from(types)
  return list.includes('text/plain') && !list.includes('Files')
}

/** Workspace-relative path from a drop payload, or null for foreign drops. */
function relFromDrop(e: DragEvent): string | null {
  if (e.dataTransfer?.files?.length) return null
  const text = e.dataTransfer?.getData('text/plain') ?? ''
  const root = props.workspacePath.replace(/\/+$/, '')
  if (!root || !text.startsWith(root + '/')) return null
  return text.slice(root.length + 1)
}

function onRowDragOver(e: DragEvent, entry: FsEntry): void {
  if (!entry.is_dir || !canAcceptDrag(e)) return // file rows bubble to the tree (root target)
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropTargetRel.value = entry.rel_path
}

function onTreeDragOver(e: DragEvent): void {
  if (!canAcceptDrag(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropTargetRel.value = ''
}

function onTreeDragLeave(e: DragEvent): void {
  const to = e.relatedTarget as Node | null
  if (!to || !treeEl.value?.contains(to)) dropTargetRel.value = null
}

function onRowDrop(e: DragEvent, entry: FsEntry): void {
  if (!entry.is_dir) return // bubbles to the tree handler (root target)
  e.preventDefault()
  e.stopPropagation()
  dropTargetRel.value = null
  const rel = relFromDrop(e)
  if (rel === null) return
  void moveEntries(rel, entry.rel_path)
}

function onTreeDrop(e: DragEvent): void {
  e.preventDefault()
  dropTargetRel.value = null
  const rel = relFromDrop(e)
  if (rel === null) return
  void moveEntries(rel, '')
}

/** Move the dragged entry (or the whole multi-selection containing it) into
 *  `targetDir`. Same-parent and folder-into-itself/descendant drops no-op;
 *  collisions are refused by the backend and surfaced via alert. */
async function moveEntries(draggedRel: string, targetDir: string): Promise<void> {
  const rels = selectedKeys.value.has(draggedRel) ? [...selectedKeys.value] : [draggedRel]
  // Shallowest first; skip children whose ancestor is also being moved.
  const sorted = rels.sort((a, b) => a.split('/').length - b.split('/').length)
  const moved = new Set<string>()
  for (const rel of sorted) {
    if ([...moved].some((m) => rel.startsWith(m + '/'))) continue
    if (parentOf(rel) === targetDir) continue // already in the target dir
    if (targetDir === rel || targetDir.startsWith(rel + '/')) continue // folder into itself/descendant
    const name = rel.split('/').pop()!
    const dst = targetDir ? `${targetDir}/${name}` : name
    try {
      const res = await props.backend.send<FsResult>('fs.rename', {
        workspace_path: props.workspacePath,
        src_path: rel,
        dst_path: dst,
      })
      if (!res.payload?.ok) {
        void alert(res.payload?.error || `Failed to move "${rel}"`, { title: 'Error' })
        continue
      }
    } catch (err) {
      void alert(err instanceof Error ? err.message : `Failed to move "${rel}"`, { title: 'Error' })
      continue
    }
    moved.add(rel)
    explorer.pruneDir(rel, dst)
    emit('entry-renamed', { oldRel: rel, newRel: dst })
  }
  if (moved.size === 0) return
  clearSelection()
  await explorer.refreshVisible()
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
function doInitialLoad(): void {
  if (!props.workspacePath) return
  void explorer.loadDir('')
  void git.loadStatus()
}

// The tree never loaded successfully: nothing cached yet, or the last load
// errored (a failed loadDir leaves the root uncached). While the backend is
// down this is a "waiting" state, not an empty directory.
const treeNeverLoaded = computed(
  () => explorer.childrenCache.value.size === 0 || !!explorer.error.value,
)
const waitingForBackend = computed(
  () => props.backend.status.value !== 'connected' && treeNeverLoaded.value,
)

onMounted(() => {
  if (props.backend.status.value === 'connected') {
    doInitialLoad()
  }
  // If backend isn't connected yet (fresh editor window), wait for it. Also
  // re-run the initial load after a reconnect when the previous attempt failed
  // (e.g. request timeout while the socket was wedged).
  watch(
    () => props.backend.status.value,
    (s) => {
      if (s === 'connected' && treeNeverLoaded.value) doInitialLoad()
    },
  )
})
watch(wsRef, (v) => {
  if (v) { clearSelection(); doInitialLoad() }
})

// ── Reveal file ──────────────────────────────────────────────────────────────
const treeEl = ref<HTMLElement | null>(null)

async function revealFile(relPath: string): Promise<void> {
  const segments = relPath.split('/')
  segments.pop()
  let current = ''
  for (const seg of segments) {
    current = current ? `${current}/${seg}` : seg
    if (!explorer.isExpanded(current)) await explorer.toggleDir(current)
  }
  await nextTick()
  treeEl.value?.querySelector<HTMLElement>(`[data-rel="${relPath}"]`)?.scrollIntoView({ block: 'nearest' })
}

// ── Keyboard navigation ───────────────────────────────────────────────────────
// Track by rel_path so expanding/collapsing folders doesn't shift the focused item.
const focusedRelPath = ref<string | null>(null)
const focusedIdx = computed(() =>
  focusedRelPath.value === null
    ? -1
    : rows.value.findIndex((r) => r.entry.rel_path === focusedRelPath.value),
)

function onTreeKeydown(e: KeyboardEvent): void {
  const list = rows.value
  if (!list.length) return
  if (focusedRelPath.value === null) { focusedRelPath.value = list[0].entry.rel_path; return }
  const idx = focusedIdx.value
  if (idx === -1) { focusedRelPath.value = list[0].entry.rel_path; return }
  const entry = list[idx].entry

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    focusedRelPath.value = list[Math.min(idx + 1, list.length - 1)].entry.rel_path
    scrollFocusedIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    focusedRelPath.value = list[Math.max(idx - 1, 0)].entry.rel_path
    scrollFocusedIntoView()
  } else if (e.key === 'ArrowRight' && entry.is_dir) {
    e.preventDefault()
    if (!explorer.isExpanded(entry.rel_path)) void explorer.toggleDir(entry.rel_path)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    if (entry.is_dir && explorer.isExpanded(entry.rel_path)) {
      void explorer.toggleDir(entry.rel_path)
    } else {
      const parentRel = entry.rel_path.includes('/') ? entry.rel_path.slice(0, entry.rel_path.lastIndexOf('/')) : ''
      const parentRow = list.find((r) => r.entry.rel_path === parentRel)
      if (parentRow) focusedRelPath.value = parentRow.entry.rel_path
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (entry.is_dir) void explorer.toggleDir(entry.rel_path)
    else openInEditor(entry)
  }
}

function scrollFocusedIntoView(): void {
  void nextTick(() => {
    const el = treeEl.value?.querySelectorAll<HTMLElement>('.exp-row')[focusedIdx.value]
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function onTreeFocus(): void {
  if (focusedRelPath.value === null && rows.value.length > 0) focusedRelPath.value = rows.value[0].entry.rel_path
}

function focusTree(): void {
  treeEl.value?.focus()
}
defineExpose({ revealFile, focusTree })
</script>

<template>
  <div class="explorer" @click="closeCtx(); clearSelection()">
    <!-- Header -->
    <div class="exp-header">
      <span class="exp-ws" v-truncate :title="workspacePath">{{ wsName || $t('label.no-workspace') }}</span>
      <div class="exp-actions">
        <button
          class="exp-icon-btn"
          :class="{ on: explorer.showHidden.value }"
          :title="$t('action.show-hidden-files')"
          @click="explorer.setShowHidden(!explorer.showHidden.value)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2c3.5 0 6.4 2.3 7.5 5.5C14.4 10.7 11.5 13 8 13S1.6 10.7.5 7.5C1.6 4.3 4.5 2 8 2Zm0 1.5C5.4 3.5 3.2 5 2.1 7.5 3.2 10 5.4 11.5 8 11.5s4.8-1.5 5.9-4C12.8 5 10.6 3.5 8 3.5Zm0 1.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>
        </button>
        <button class="exp-icon-btn" :title="$t('action.refresh')" @click="explorer.reloadAll()">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3a5 5 0 1 0 4.546 2.914.75.75 0 0 1 1.364-.626A6.5 6.5 0 1 1 8 1.5V0l3 2-3 2V3Z"/></svg>
        </button>
        <button class="exp-icon-btn" :title="$t('action.new-file')" @click.stop="startNew('new-file', null)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2H6.5a1 1 0 0 0-1 1v3.5"/><path d="M8.5 14H12a1 1 0 0 0 1-1V5l-3-3"/><path d="M10 2v3h3"/><path d="M3.5 9.5v4M1.5 11.5h4"/></svg>
        </button>
        <button class="exp-icon-btn" :title="$t('action.new-folder')" @click.stop="startNew('new-folder', null)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 10.5V4.5a1 1 0 0 1 1-1h3L8 5h4.5a1 1 0 0 1 1 1v1.5"/><path d="M13.5 7.5V12a1 1 0 0 1-1 1H7"/><path d="M3.5 9.5v4M1.5 11.5h4"/></svg>
        </button>
        <button class="exp-icon-btn" :title="$t('action.collapse-all-folders')" @click="explorer.expanded.value = new Set()">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="1.5" width="10" height="10" rx="1"/><rect x="1.5" y="4.5" width="10" height="10" rx="1" fill="var(--bg-surface)"/><path d="M4 9.5h5"/></svg>
        </button>
      </div>
    </div>

    <!-- Tree -->
    <div
      ref="treeEl"
      class="exp-tree"
      :class="{ 'drop-target-root': dropTargetRel === '' }"
      tabindex="0"
      @contextmenu="openCtx($event, null)"
      @keydown="onTreeKeydown"
      @focus="onTreeFocus"
      @dragover="onTreeDragOver"
      @dragleave="onTreeDragLeave"
      @drop="onTreeDrop"
    >
      <template v-for="(row, rowIdx) in rows" :key="row.entry.rel_path">
        <div
          :data-rel="row.entry.rel_path"
          class="exp-row"
          :class="{ noise: row.entry.is_noise, hidden: row.entry.is_hidden, 'row-selected': selectedKeys.has(row.entry.rel_path), 'row-focused': focusedIdx === rowIdx, 'drop-target': dropTargetRel === row.entry.rel_path }"
          :style="{ paddingLeft: 6 + row.depth * 12 + 'px' }"
          :draggable="true"
          @dragstart="(e) => e.dataTransfer?.setData('text/plain', absPath(row.entry.rel_path))"
          @dragover="onRowDragOver($event, row.entry)"
          @drop="onRowDrop($event, row.entry)"
          @click.stop="handleRowClick($event, row.entry)"
          @dblclick.stop="row.entry.is_dir ? explorer.toggleDir(row.entry.rel_path) : openInEditor(row.entry)"
          @contextmenu.stop="openCtx($event, row.entry)"
        >
          <span class="exp-chevron" :class="{ open: explorer.isExpanded(row.entry.rel_path) }">
            <svg v-if="row.entry.is_dir" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4V4Z"/></svg>
          </span>
          <span class="exp-glyph" :class="row.entry.is_dir ? 'is-dir' : 'is-file'">
            <svg v-if="row.entry.is_dir" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 2A1.75 1.75 0 0 0 0 3.75v8.5C0 13.216.784 14 1.75 14h12.5A1.75 1.75 0 0 0 16 12.25v-7.5A1.75 1.75 0 0 0 14.25 3H7.5L6.2 1.7A1.75 1.75 0 0 0 4.96 1H1.75Z"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 1A1.75 1.75 0 0 0 2 2.75v10.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0 0 14 13.25V5.5L9.5 1H3.75ZM9 2.5 12.5 6H9V2.5Z"/></svg>
          </span>
          <span class="exp-name" v-truncate :class="statusClassFor(row.entry)">{{ row.entry.name }}</span>
          <span v-if="statusFor(row.entry.rel_path)" class="exp-status" :class="statusClassFor(row.entry)">
            {{ statusFor(row.entry.rel_path)!.letter }}
          </span>
        </div>
        <div
          v-for="note in treeView.notes.get(row.entry.rel_path) ?? []"
          :key="`${note.kind}:${note.dirRel}`"
          class="exp-note" v-truncate
          :class="note.kind"
          :style="{ paddingLeft: 20 + note.depth * 12 + 'px' }"
        >
          {{ note.kind === 'error' ? $t('label.dir-list-error', { message: note.message }) : $t('label.list-truncated') }}
        </div>
      </template>

      <div v-if="rows.length === 0 && workspacePath" class="exp-empty">
        {{ waitingForBackend ? $t('label.waiting-backend') : (explorer.error.value || $t('label.no-items')) }}
      </div>
      <div v-if="!workspacePath" class="exp-empty">{{ $t('label.select-workspace') }}</div>

      <div v-if="selectedKeys.size >= 2" class="selection-bar" @click.stop>
        <span class="sel-count">{{ selectedKeys.size }} {{ $t('label.selected-count') }}</span>
        <button class="sel-btn close" @click="clearSelection()">✕</button>
      </div>
    </div>

    <!-- Inline prompt -->
    <div v-if="prompt" class="exp-prompt-overlay" @click.self="prompt = null">
      <div class="exp-prompt">
        <div class="exp-prompt-title">{{ prompt.title }}</div>
        <input
          ref="promptInput"
          v-model="prompt.value"
          class="exp-prompt-input"
          type="text"
          spellcheck="false"
          :placeholder="$t('label.name-placeholder')"
          @keydown.enter="submitPrompt"
          @keydown.esc="prompt = null"
        />
        <div class="exp-prompt-actions">
          <button class="exp-btn ghost" @click="prompt = null">{{ $t('action.cancel') }}</button>
          <button class="exp-btn primary" @click="submitPrompt">{{ $t('action.ok') }}</button>
        </div>
      </div>
    </div>

    <!-- Context menu -->
    <div v-if="ctx" class="exp-ctx" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @click.stop>
      <!-- Multi-select context menu -->
      <template v-if="selectedKeys.size > 1">
        <button
          v-if="selectedFilePaths.length > 0"
          class="exp-ctx-item"
          @click="openSelected(); closeCtx()"
        >{{ $t('action.open-files', { count: selectedFilePaths.length }) }}</button>
        <button class="exp-ctx-item danger" @click="deleteSelected(); closeCtx()">{{ $t('action.delete-items', { size: selectedKeys.size }) }}</button>
        <div class="exp-ctx-sep" />
        <button class="exp-ctx-item" @click="copyPathsSelected(); closeCtx()">{{ $t('action.copy-paths') }}</button>
      </template>
      <!-- Single-item context menu -->
      <template v-else>
        <button class="exp-ctx-item" @click="startNew('new-file', ctx.entry); closeCtx()">{{ $t('action.new-file') }}</button>
        <button class="exp-ctx-item" @click="startNew('new-folder', ctx.entry); closeCtx()">{{ $t('action.new-folder') }}</button>
        <template v-if="ctx.entry">
          <div class="exp-ctx-sep" />
          <button v-if="!ctx.entry.is_dir && !props.embedded" class="exp-ctx-item" @click="previewFile(ctx.entry!); closeCtx()">{{ $t('preview.show-file') }}</button>
          <button v-if="!ctx.entry.is_dir && !props.embedded" class="exp-ctx-item" @click="previewDiff(ctx.entry!); closeCtx()">{{ $t('preview.show-diff') }}</button>
          <button v-if="!ctx.entry.is_dir" class="exp-ctx-item" @click="openDiff(ctx.entry!); closeCtx()">{{ $t('action.open-diff') }}</button>
          <button v-if="!ctx.entry.is_dir" class="exp-ctx-item" @click="openInEditor(ctx.entry!); closeCtx()">{{ $t('action.open-in-editor') }}</button>
          <button v-if="!ctx.entry.is_dir && props.onAskAiAboutFile" class="exp-ctx-item" @click="props.onAskAiAboutFile!(ctx.entry!.rel_path); closeCtx()">{{ $t('action.ask-ai-about-file') }}</button>
          <template v-if="ctx.entry.is_dir && canOpenFolderInEditor()">
            <button class="exp-ctx-item" @click="openFolderInEditor(ctx.entry!); closeCtx()">{{ $t('action.open-in-default-editor') }}</button>
            <div class="exp-ctx-item has-sub">
              <span>{{ $t('action.open-with') }}</span><span class="exp-ctx-caret">▸</span>
              <div class="exp-ctx-submenu">
                <button
                  v-for="target in editorTargets"
                  :key="target.id"
                  class="exp-ctx-item"
                  @click="openFolderInEditor(ctx!.entry!, target.id); closeCtx()"
                >{{ $t(target.labelKey) }}</button>
              </div>
            </div>
          </template>
          <button class="exp-ctx-item" @click="startRename(ctx.entry!); closeCtx()">{{ $t('action.rename') }}</button>
          <button class="exp-ctx-item danger" @click="doDelete(ctx.entry!); closeCtx()">{{ $t('action.delete') }}</button>
          <div class="exp-ctx-sep" />
          <button class="exp-ctx-item" @click="reveal(ctx.entry!); closeCtx()">{{ $t('action.reveal-in-finder') }}</button>
          <button class="exp-ctx-item" @click="copyPath(ctx.entry!); closeCtx()">{{ $t('action.copy-path') }}</button>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.explorer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-base);
  color: var(--text-primary);
}
.exp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.exp-ws {
  font-size: var(--font-2xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.exp-actions { display: flex; gap: 2px; flex-shrink: 0; }
.exp-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn-md);
  height: var(--icon-btn-md);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.exp-icon-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.exp-icon-btn:focus-visible {
  outline: 2px solid var(--accent-emphasis);
  outline-offset: 1px;
}
.exp-icon-btn.on { color: var(--accent-fg); }

.exp-tree { flex: 1; overflow-y: auto; min-height: 0; padding: 4px 0; }
.exp-row {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding-right: 8px;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
  white-space: nowrap;
}
.exp-row:hover { background: var(--bg-hover); box-shadow: inset 2px 0 var(--border-default); }
.exp-row.noise .exp-name { color: var(--text-muted); }
.exp-row.hidden .exp-name,
.exp-row.hidden .exp-glyph { opacity: 0.55; }
.exp-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  color: var(--text-muted);
  transition: transform 0.1s;
  flex-shrink: 0;
}
.exp-chevron.open { transform: rotate(90deg); }
.exp-glyph { display: inline-flex; align-items: center; color: var(--text-secondary); flex-shrink: 0; }
.exp-glyph.is-dir svg { color: var(--accent-fg); }
.exp-glyph.is-file svg { color: var(--text-muted); }
.exp-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
}
.exp-status {
  font-size: var(--font-3xs);
  font-weight: 700;
  flex-shrink: 0;
  width: 14px;
  text-align: center;
}
.st-mod { color: var(--attention-fg); }
.st-add { color: var(--success-fg); }
.st-del { color: var(--danger-fg); }
.st-untracked { color: var(--success-fg); }

.exp-empty {
  padding: 16px 12px;
  font-size: 11.5px;
  color: var(--text-muted);
  text-align: center;
}

/* Inline dir notes (load error / truncated listing) */
.exp-note {
  padding-right: 8px;
  font-size: var(--font-2xs);
  font-style: italic;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}
.exp-note.error { color: var(--danger-fg); }
.exp-note.truncated { color: var(--attention-fg); }

/* Inline prompt */
.exp-prompt-overlay {
  position: absolute;
  inset: 0;
  background: var(--shadow-overlay);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 60px;
  z-index: 40;
}
.exp-prompt {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 14px;
  width: 84%;
  max-width: 280px;
  box-shadow: 0 8px 28px var(--shadow-overlay);
}
.exp-prompt-title { font-size: var(--font-xs); font-weight: 600; color: var(--text-bright); margin-bottom: 8px; }
.exp-prompt-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  font-size: 12.5px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 5px;
  color: var(--text-primary);
  outline: none;
}
.exp-prompt-input:focus { border-color: var(--accent-emphasis); }
.exp-prompt-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
.exp-btn {
  font-size: 11.5px;
  padding: 5px 12px;
  border-radius: 5px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-secondary);
}
.exp-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.exp-btn.ghost:hover { background: var(--bg-muted); color: var(--text-bright); }

/* Context menu */
.exp-ctx {
  position: fixed;
  z-index: 50;
  min-width: 160px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 4px;
  box-shadow: 0 8px 28px var(--shadow-overlay);
}
.exp-ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  font-size: var(--font-xs);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
}
.exp-ctx-item:hover { background: var(--bg-muted); }
.exp-ctx-item.danger:hover { color: var(--danger-fg); }
.exp-ctx-sep { height: 1px; background: var(--border-muted); margin: 4px 0; }
/* Hover submenu (Open with ▸) */
.exp-ctx-item.has-sub {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.exp-ctx-caret { color: var(--text-muted); font-size: var(--font-3xs); }
.exp-ctx-submenu {
  position: absolute;
  top: -5px;
  left: 100%;
  margin-left: 2px;
  display: none;
  min-width: 160px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 4px;
  box-shadow: 0 8px 28px var(--shadow-overlay);
}
.exp-ctx-item.has-sub:hover .exp-ctx-submenu { display: block; }

/* Multi-select */
.exp-row.row-selected { background: color-mix(in srgb, var(--accent-fg) 12%, transparent); }
.exp-row.row-selected { box-shadow: inset 2px 0 var(--accent-fg); }
.exp-row.row-selected:hover { background: color-mix(in srgb, var(--accent-fg) 18%, transparent); }
.exp-row.row-focused { outline: 1px solid var(--accent-emphasis); outline-offset: -1px; }
.exp-tree:focus { outline: none; }

/* Drag-to-move drop targets */
.exp-row.drop-target {
  background: color-mix(in srgb, var(--accent-fg) 18%, transparent);
  outline: 1px solid var(--accent-emphasis);
  outline-offset: -1px;
}
.exp-tree.drop-target-root { outline: 1px solid var(--accent-emphasis); outline-offset: -1px; }

.selection-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-default);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.sel-count {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  margin-right: 4px;
  white-space: nowrap;
}
.sel-btn {
  font-size: var(--font-2xs);
  padding: 3px 8px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.sel-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-bright); }
.sel-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.sel-btn.danger:hover:not(:disabled) { color: var(--danger-fg); border-color: var(--danger-fg); }
.sel-btn.close { margin-left: auto; }
</style>
