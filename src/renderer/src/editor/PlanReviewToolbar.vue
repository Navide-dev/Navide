<script setup lang="ts">
// Plan review toolbar shown above the sandboxed HTML preview of
// `.agent-team/plans/*.html` documents. Reads/writes only the `plan-meta`
// JSON island via usePlanHtml — every other byte of the file is preserved.
// Renders nothing when the file has no valid plan-meta block.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  htmlPlanProgress,
  addTodoMarkup,
  removeTodoMarkup,
  setTodoContentMarkup,
  setNoteTextMarkup,
  removeNoteMarkup,
} from '../composables/usePlanHtml'
import {
  diffPlanContents,
  parseSnapshotName,
  planHistoryDirRelPath,
  type PlanDiffSummary,
} from './planHistory'
import type { PlanMeta, ReviewNote, PlanTodo, TodoStatus, PlanStage } from '../composables/planModel'
import type { PlanStore, PlanCtx } from '../composables/planStore'
import type { useBackend } from '../composables/useBackend'
import { sharePlanToGit } from '../composables/planShare'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'

const props = defineProps<{
  workspacePath: string
  relPath: string
  backend: ReturnType<typeof useBackend>
  store: PlanStore
}>()

// Persistence context assembled from the transport props; passed to every
// store call so the toolbar never talks to the backend directly for meta I/O.
const ctx = computed<PlanCtx>(() => ({
  backend: props.backend,
  workspacePath: props.workspacePath,
  relPath: props.relPath,
}))

// `updated`: emitted after the file content changed (own write or external
// edit detected on window focus) so the host can refresh the HTML preview.
// `scroll-to-anchor`: an outline entry was picked; the host forwards it to
// the plan preview frame.
// `preview-snapshot`: a history snapshot's Preview action was clicked; the
// host swaps the doc area to a read-only view of that snapshot.
const emit = defineEmits<{
  (e: 'updated'): void
  (e: 'scroll-to-anchor', anchor: string): void
  (e: 'preview-snapshot', payload: { relPath: string; label: string }): void
  (e: 'deleted', relPath: string): void
}>()

const { t } = useI18n()
const { toast, confirm } = useNotify()

const rawContent = ref('')
const meta = ref<PlanMeta | null>(null)
const notesOpen = ref(false)
const todosOpen = ref(false)
const newNoteText = ref('')
// Section anchor attached to the note being composed ('' = unanchored);
// prefilled by the in-document comment button via startNoteWithAnchor().
const pendingAnchor = ref('')
const noteInput = ref<HTMLInputElement | null>(null)
const saving = ref(false)

function applyContent(content: string, notifyHost: boolean): void {
  const changed = content !== rawContent.value
  rawContent.value = content
  // Format-agnostic: the store parses HTML `plan-meta` islands or `.plan.md`
  // frontmatter, so the same toolbar drives markdown and HTML plans alike.
  meta.value = props.store.parseMeta(content)
  if (notifyHost && changed) emit('updated')
}

async function loadContent(notifyHost = false): Promise<void> {
  // In-flight guard: while a write is running, a focus-triggered re-read
  // could resolve with stale content and clobber the just-written state.
  if (saving.value) return
  try {
    const result = await props.store.readMeta(ctx.value)
    if (result) applyContent(result.raw, notifyHost)
  } catch {
    // Toolbar simply stays hidden when the file cannot be read.
  }
}

// No fs-watch exists in the app; re-read on window focus so external edits
// (e.g. by an agent) refresh the toolbar and, via `updated`, the preview.
function onWindowFocus(): void {
  void loadContent(true)
}

// Primary live-refresh path: the backend broadcasts plans.changed when any
// plan document changes on disk; the focus listener stays as a last resort.
let offPlansChanged: (() => void) | null = null
let offExecutionResult: (() => void) | null = null
onMounted(() => {
  void loadContent()
  window.addEventListener('focus', onWindowFocus)
  offPlansChanged = props.backend.on('plans.changed', (payload) => {
    const p = payload as { workspace_path?: unknown } | null
    if (p && p.workspace_path === props.workspacePath) void loadContent(true)
  })
  offExecutionResult = window.agentTeam?.onPlanExecutionResult?.(onExecutionResult) ?? null
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', onWindowFocus)
  offPlansChanged?.()
  offPlansChanged = null
  offExecutionResult?.()
  offExecutionResult = null
  clearDispatchTimer()
  pendingDispatch = null
})
watch(
  () => props.relPath,
  () => {
    rawContent.value = ''
    meta.value = null
    historyOpen.value = false
    historyEntries.value = []
    diffFor.value = null
    diffSummary.value = null
    // Reset composer/editing state so a draft or edit-in-progress on the
    // previous plan cannot leak into — or be written against — the new one
    // (note/todo ids can collide across plans). Defensive: the parent also
    // keys the toolbar per relPath, but this keeps the watch safe on its own.
    notesOpen.value = false
    todosOpen.value = false
    newTodoText.value = ''
    newNoteText.value = ''
    editingTodoId.value = null
    editTodoText.value = ''
    editingNoteId.value = null
    editNoteText.value = ''
    pendingAnchor.value = ''
    // A dispatch pending on the previous file can no longer be settled here
    // (results are matched against props.relPath); drop it so the timeout
    // cannot fire a rollback against the newly opened file.
    clearDispatchTimer()
    pendingDispatch = null
    void loadContent()
  },
)

const progress = computed(() => htmlPlanProgress(meta.value?.todos ?? []))
// Width of the progress-bar fill; the bar itself only renders when total > 0.
const progressPercent = computed(() =>
  progress.value.total > 0 ? `${Math.round((progress.value.done / progress.value.total) * 100)}%` : '0%'
)
const unresolvedCount = computed(() => (meta.value?.reviewNotes ?? []).filter((n) => !n.resolved).length)
// Approve is reachable from draft as well as in-review. The toolbar has no
// draft→in-review transition, so gating approval on in-review alone left every
// freshly-created draft plan permanently un-approvable; draft now skips straight
// to approved (still requiring all review notes resolved).
const canApprove = computed(
  () => (meta.value?.stage === 'draft' || meta.value?.stage === 'in-review') && unresolvedCount.value === 0
)
// Outline entries (section h2 / phase-head leading text) for the ⋯ menu's
// section-navigation submenu.
const outline = computed(() => props.store.outline(rawContent.value))

function pickOutlineAnchor(anchor: string): void {
  closeOverflow()
  emit('scroll-to-anchor', anchor)
}

// Read-before-write, delegated to the store: it re-reads the file and applies
// `mutate` to the fresh meta so external edits made since our last read (e.g.
// by an AI agent) are preserved instead of clobbered, syncs the stage/todo
// markup, carries the optimistic lock (expected_mtime + one re-read/retry on
// conflict), and writes. `mutate` returns null to abort when its precondition
// no longer holds against the fresh meta; the UI is then refreshed from the
// fresh content. `syncBody` runs (inside the store, after the standard
// stage/todo-status markup sync) to apply structural body edits that the
// status sync cannot (inserting/removing a todo `<li>`, editing todo/note
// visible text) and returns the final content.
async function writeMeta(
  mutate: (fresh: PlanMeta) => PlanMeta | null,
  syncBody?: (content: string) => string,
): Promise<boolean> {
  saving.value = true
  try {
    // `syncBody` only patches HTML plans' visible `<li>` markup. Markdown plans
    // keep todos/notes solely in frontmatter (written by the store's meta
    // serialize), so there is no body markup to sync — skip it entirely.
    const bodySync = props.store.format === 'html' ? syncBody : undefined
    const result = await props.store.writeMeta(ctx.value, mutate, bodySync)
    if (result.ok) {
      applyContent(result.raw ?? rawContent.value, false)
      emit('updated')
      return true
    }
    // A refused conflict (both attempts lost the race) surfaces the generic
    // save-failed toast, matching the pre-store behavior.
    if (result.conflict) {
      toast(t('pane.plans.review-save-failed'))
      return false
    }
    // Mutation abandoned against the fresh meta: refresh the UI to the fresh
    // on-disk state instead of writing.
    if (result.raw !== undefined) {
      applyContent(result.raw, true)
      return false
    }
    toast(result.error ?? t('pane.plans.review-save-failed'))
    return false
  } catch (err) {
    toast(err instanceof Error ? err.message : t('pane.plans.review-save-failed'))
    return false
  } finally {
    saving.value = false
  }
}

async function approve(): Promise<void> {
  if (!meta.value || !canApprove.value || saving.value) return
  await writeMeta((fresh) => {
    if ((fresh.stage !== 'draft' && fresh.stage !== 'in-review') || fresh.reviewNotes.some((n) => !n.resolved)) return null
    return { ...fresh, stage: 'approved', approvedAt: new Date().toISOString() }
  })
}

// ── Todo sidebar ──────────────────────────────────────────────────────────
// Click cycles pending → in-progress → done → pending; right-click toggles
// skipped (and back to pending). Every write goes through writeMeta, so the
// visible todo markup is synced alongside the meta.
function nextTodoStatus(status: TodoStatus): TodoStatus {
  if (status === 'pending') return 'in-progress'
  if (status === 'in-progress') return 'done'
  return 'pending' // done or skipped cycle back to pending
}

async function cycleTodo(id: string): Promise<void> {
  if (!meta.value || saving.value) return
  await writeMeta((fresh) => {
    const todo = fresh.todos.find((td) => td.id === id)
    if (!todo) return null
    const status = nextTodoStatus(todo.status)
    return { ...fresh, todos: fresh.todos.map((td) => (td.id === id ? { ...td, status } : td)) }
  })
}

async function toggleSkipTodo(id: string): Promise<void> {
  if (!meta.value || saving.value) return
  await writeMeta((fresh) => {
    const todo = fresh.todos.find((td) => td.id === id)
    if (!todo) return null
    const status: TodoStatus = todo.status === 'skipped' ? 'pending' : 'skipped'
    return { ...fresh, todos: fresh.todos.map((td) => (td.id === id ? { ...td, status } : td)) }
  })
}

// ── Todo CRUD ──────────────────────────────────────────────────────────────
// Add (content → stable kebab id), inline-edit content, delete (confirmed).
// All go through writeMeta with a syncBody step so the document's visible
// `<li data-todo-id>` markup is inserted/updated/removed alongside the meta.
const newTodoText = ref('')
const editingTodoId = ref<string | null>(null)
const editTodoText = ref('')

/** Derive a stable kebab-case id from content, de-duplicated against existing ids. */
function slugTodoId(content: string, existing: PlanTodo[]): string {
  const base =
    content
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'todo'
  const ids = new Set(existing.map((t) => t.id))
  if (!ids.has(base)) return base
  let n = 2
  while (ids.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

async function addTodo(): Promise<void> {
  const text = newTodoText.value.trim()
  if (!meta.value || !text || saving.value) return
  let added: PlanTodo | null = null
  const ok = await writeMeta(
    (fresh) => {
      added = { id: slugTodoId(text, fresh.todos), content: text, status: 'pending' }
      return { ...fresh, todos: [...fresh.todos, added] }
    },
    (content) => {
      if (!added) return content
      const result = addTodoMarkup(content, added)
      if (result.warning) console.warn(`[plan] ${result.warning}`)
      return result.content
    },
  )
  if (ok) newTodoText.value = ''
}

function onNewTodoEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  void addTodo()
}

function startEditTodo(todo: PlanTodo): void {
  editingTodoId.value = todo.id
  editTodoText.value = todo.content
}

function cancelEditTodo(): void {
  editingTodoId.value = null
  editTodoText.value = ''
}

async function submitEditTodo(): Promise<void> {
  const id = editingTodoId.value
  const text = editTodoText.value.trim()
  if (!id || !text || saving.value) return
  const ok = await writeMeta(
    (fresh) => {
      if (!fresh.todos.some((td) => td.id === id)) return null
      return { ...fresh, todos: fresh.todos.map((td) => (td.id === id ? { ...td, content: text } : td)) }
    },
    (content) => setTodoContentMarkup(content, id, text),
  )
  if (ok) cancelEditTodo()
}

function onEditTodoEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  void submitEditTodo()
}

async function deleteTodo(id: string): Promise<void> {
  if (!meta.value || saving.value) return
  const todo = meta.value.todos.find((td) => td.id === id)
  const ok = await confirm(t('pane.plans.todo-delete-confirm', { content: todo?.content ?? id }), {
    title: t('pane.plans.delete'),
    confirmText: t('pane.plans.delete'),
  })
  if (!ok) return
  await writeMeta(
    (fresh) => {
      if (!fresh.todos.some((td) => td.id === id)) return null
      return { ...fresh, todos: fresh.todos.filter((td) => td.id !== id) }
    },
    (content) => removeTodoMarkup(content, id),
  )
  if (editingTodoId.value === id) cancelEditTodo()
}

// ── Stage controls ────────────────────────────────────────────────────────
// abandon: any active stage → abandoned (confirmed; approvedAt kept as a
// historical record). reopen: done/abandoned → in-review (approvedAt cleared
// — the plan is no longer approved once it is back in review).
const ACTIVE_STAGES: readonly PlanStage[] = ['draft', 'in-review', 'approved', 'in-progress']
const canAbandon = computed(() => !!meta.value && ACTIVE_STAGES.includes(meta.value.stage))
const canReopen = computed(() => meta.value?.stage === 'done' || meta.value?.stage === 'abandoned')

async function abandon(): Promise<void> {
  if (!meta.value || !canAbandon.value || saving.value) return
  const ok = await confirm(t('pane.plans.abandon-confirm', { name: meta.value.name }), {
    title: t('pane.plans.abandon'),
    confirmText: t('pane.plans.abandon'),
  })
  if (!ok) return
  await writeMeta((fresh) => {
    if (!ACTIVE_STAGES.includes(fresh.stage)) return null
    return { ...fresh, stage: 'abandoned' }
  })
}

async function reopen(): Promise<void> {
  if (!meta.value || !canReopen.value || saving.value) return
  await writeMeta((fresh) => {
    if (fresh.stage !== 'done' && fresh.stage !== 'abandoned') return null
    return { ...fresh, stage: 'in-review', approvedAt: null }
  })
}

// ── Archive ────────────────────────────────────────────────────────────────
// Orthogonal to stage: archiving keeps the file and its stage, only setting
// `archivedAt` (null clears it). This is the window-level entry point so
// markdown plans — frozen in the PlansPane context menu — can still be archived.
const isArchived = computed(() => !!meta.value?.archivedAt)

async function archive(): Promise<void> {
  if (!meta.value || saving.value || meta.value.archivedAt) return
  await writeMeta((fresh) => (fresh.archivedAt ? null : { ...fresh, archivedAt: new Date().toISOString() }))
}

async function unarchive(): Promise<void> {
  if (!meta.value || saving.value || !meta.value.archivedAt) return
  await writeMeta((fresh) => (fresh.archivedAt ? { ...fresh, archivedAt: null } : null))
}

// ── Execute dispatch (Phase D) ────────────────────────────────────────────
// Only an approved plan can be dispatched. Selecting an agent appends an
// execution record + moves the stage to in-progress (through writeMeta, so
// the write re-validates against the fresh on-disk meta), then asks the main
// process to hand the plan to that agent's CLI pane in the workspace's main
// window. A fresh meta that is already in-progress with a recorded execution
// means someone else dispatched meanwhile — re-dispatch needs confirmation.
// delivered only means the payload was forwarded: the "dispatched" toast
// waits for the main window's plans:execution-result. ok=false,
// delivered:false, or a silent 60s timeout rolls the execution record back
// (stage returns to approved when it was the only execution) so a retry
// starts from a clean approved plan.
const executeOpen = ref(false)
const dispatching = ref(false)
const canExecute = computed(() => meta.value?.stage === 'approved')
const cliAgentSpecs = CLI_AGENT_SPECS

const DISPATCH_RESULT_TIMEOUT_MS = 60_000
let pendingDispatch: { agentKey: string; startedAt: string } | null = null
let dispatchTimer: ReturnType<typeof setTimeout> | null = null

function clearDispatchTimer(): void {
  if (dispatchTimer !== null) {
    clearTimeout(dispatchTimer)
    dispatchTimer = null
  }
}

function appendExecution(fresh: PlanMeta, agentKey: string, startedAt: string): PlanMeta {
  return {
    ...fresh,
    stage: 'in-progress',
    executions: [...(fresh.executions ?? []), { agent: agentKey, startedAt }],
  }
}

// Roll back one dispatch: remove exactly the execution record this window
// appended (matched by agent + startedAt; if it is already gone there is
// nothing to write) and return to approved when no other execution keeps the
// plan in-progress. Runs through writeMeta, so markup stays in sync.
async function rollbackExecution(agentKey: string, startedAt: string): Promise<void> {
  await writeMeta((fresh) => {
    const executions = fresh.executions ?? []
    const idx = executions.findIndex((e) => e.agent === agentKey && e.startedAt === startedAt)
    if (idx === -1) return null
    const remaining = executions.filter((_, i) => i !== idx)
    const stage = fresh.stage === 'in-progress' && remaining.length === 0 ? 'approved' : fresh.stage
    return { ...fresh, stage, executions: remaining }
  })
}

// Settle the pending dispatch exactly once (result event or timeout).
function settleDispatch(ok: boolean): void {
  const pending = pendingDispatch
  if (!pending) return
  pendingDispatch = null
  clearDispatchTimer()
  if (ok) {
    toast(t('pane.plans.execute-dispatched'))
  } else {
    void rollbackExecution(pending.agentKey, pending.startedAt)
    toast(t('pane.plans.execute-failed'))
  }
}

function onExecutionResult(payload: {
  workspace_path: string
  rel_path: string
  ok: boolean
  reason?: string
}): void {
  if (payload.workspace_path !== props.workspacePath || payload.rel_path !== props.relPath) return
  settleDispatch(payload.ok)
}

async function dispatchExecution(agentKey: string): Promise<void> {
  if (!meta.value || saving.value || dispatching.value || pendingDispatch) return
  const planName = meta.value.name
  const startedAt = new Date().toISOString()
  dispatching.value = true
  try {
    let duplicate = false
    let wrote = await writeMeta((fresh) => {
      if (fresh.stage === 'in-progress' && (fresh.executions?.length ?? 0) > 0) {
        duplicate = true
        return null
      }
      if (fresh.stage !== 'approved') return null
      return appendExecution(fresh, agentKey, startedAt)
    })
    if (!wrote) {
      if (!duplicate) return
      const ok = await confirm(t('pane.plans.execute-duplicate-confirm', { name: planName }), {
        title: t('pane.plans.execute'),
        confirmText: t('pane.plans.execute'),
      })
      if (!ok) return
      wrote = await writeMeta((fresh) => {
        if (fresh.stage !== 'approved' && fresh.stage !== 'in-progress') return null
        return appendExecution(fresh, agentKey, startedAt)
      })
      if (!wrote) return
    }
    executeOpen.value = false
    const resp = await window.agentTeam?.dispatchPlanExecution?.({
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
      agent_key: agentKey,
    })
    if (!resp?.delivered) {
      // No main window took the dispatch: roll back immediately so the retry
      // (after opening the main window) starts from a clean approved plan.
      await rollbackExecution(agentKey, startedAt)
      toast(t('pane.plans.execute-no-window'))
      return
    }
    pendingDispatch = { agentKey, startedAt }
    dispatchTimer = setTimeout(() => settleDispatch(false), DISPATCH_RESULT_TIMEOUT_MS)
  } finally {
    dispatching.value = false
  }
}

async function resolveNote(id: string): Promise<void> {
  if (!meta.value || saving.value) return
  await writeMeta((fresh) => ({
    ...fresh,
    reviewNotes: fresh.reviewNotes.map((n) => (n.id === id ? { ...n, resolved: true } : n)),
  }))
}

function nextNoteId(notes: ReviewNote[]): string {
  let max = 0
  for (const note of notes) {
    const m = note.id.match(/^n(\d+)$/)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `n${max + 1}`
}

async function submitNote(): Promise<void> {
  const text = newNoteText.value.trim()
  if (!meta.value || !text || saving.value) return
  const anchor = pendingAnchor.value
  const ok = await writeMeta((fresh) => {
    const note: ReviewNote = {
      id: nextNoteId(fresh.reviewNotes),
      author: 'user',
      text,
      resolved: false,
      reply: '',
      anchor,
    }
    return { ...fresh, reviewNotes: [...fresh.reviewNotes, note] }
  })
  if (ok) {
    newNoteText.value = ''
    pendingAnchor.value = ''
  }
}

// Entry point for the in-document section comment button (routed through the
// host): open the notes panel with the anchor prefilled and focus the input.
function startNoteWithAnchor(anchor: string): void {
  if (!meta.value) return
  notesOpen.value = true
  pendingAnchor.value = anchor
  void nextTick(() => noteInput.value?.focus())
}

// Guard against IME composition: pressing Enter to commit a candidate must
// not submit the half-composed note.
function onNoteEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  void submitNote()
}

// ── Review note CRUD ───────────────────────────────────────────────────────
// Edit text (user-authored notes only; a resolved note keeps its resolved
// state) and delete (confirmed). Both sync the visible `<li data-note-id>`
// markup when present via writeMeta's syncBody.
const editingNoteId = ref<string | null>(null)
const editNoteText = ref('')

function startEditNote(note: ReviewNote): void {
  if (note.author !== 'user') return
  editingNoteId.value = note.id
  editNoteText.value = note.text
}

function cancelEditNote(): void {
  editingNoteId.value = null
  editNoteText.value = ''
}

async function submitEditNote(): Promise<void> {
  const id = editingNoteId.value
  const text = editNoteText.value.trim()
  if (!id || !text || saving.value) return
  const ok = await writeMeta(
    (fresh) => {
      const note = fresh.reviewNotes.find((n) => n.id === id)
      if (!note || note.author !== 'user') return null
      // Resolved state is preserved verbatim; only the text changes.
      return { ...fresh, reviewNotes: fresh.reviewNotes.map((n) => (n.id === id ? { ...n, text } : n)) }
    },
    (content) => setNoteTextMarkup(content, id, text),
  )
  if (ok) cancelEditNote()
}

function onEditNoteEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  void submitEditNote()
}

async function deleteNote(id: string): Promise<void> {
  if (!meta.value || saving.value) return
  const ok = await confirm(t('pane.plans.note-delete-confirm'), {
    title: t('pane.plans.delete'),
    confirmText: t('pane.plans.delete'),
  })
  if (!ok) return
  await writeMeta(
    (fresh) => {
      if (!fresh.reviewNotes.some((n) => n.id === id)) return null
      return { ...fresh, reviewNotes: fresh.reviewNotes.filter((n) => n.id !== id) }
    },
    (content) => removeNoteMarkup(content, id),
  )
  if (editingNoteId.value === id) cancelEditNote()
}

// ESC overlay support (queried by PlanWindowApp): cancel an in-progress inline
// edit, or clear a non-empty unsent composer, topmost-first. Returns whether
// something was actually closed so the host stops before closing the window.
function closeActiveOverlay(): boolean {
  if (overflowOpen.value) {
    closeOverflow()
    return true
  }
  if (editingTodoId.value) {
    cancelEditTodo()
    return true
  }
  if (editingNoteId.value) {
    cancelEditNote()
    return true
  }
  if (newTodoText.value.trim()) {
    newTodoText.value = ''
    return true
  }
  if (notesOpen.value && newNoteText.value.trim()) {
    newNoteText.value = ''
    return true
  }
  // A panel open with no active edit / composer text still counts as an overlay:
  // collapse it before ESC falls through to closing the window.
  if (todosOpen.value || notesOpen.value || historyOpen.value || executeOpen.value) {
    todosOpen.value = false
    notesOpen.value = false
    historyOpen.value = false
    executeOpen.value = false
    return true
  }
  return false
}

// ── History panel ─────────────────────────────────────────────────────────
// Stage-transition snapshots written by the backend to
// `.agent-team/plans/.history/<stem>/`. Missing directory = empty history.
interface HistorySnapshot {
  relPath: string
  ts: string
  stage: string
  date: Date
}

const historyOpen = ref(false)
const historyEntries = ref<HistorySnapshot[]>([])
// Snapshot relPath whose diff summary is shown inline (null = none).
const diffFor = ref<string | null>(null)
const diffSummary = ref<PlanDiffSummary | null>(null)

async function toggleHistory(): Promise<void> {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value) await loadHistory()
}

async function loadHistory(): Promise<void> {
  diffFor.value = null
  diffSummary.value = null
  const dir = planHistoryDirRelPath(props.relPath)
  try {
    const resp = await props.backend.send<{
      ok: boolean
      entries?: { name: string; is_dir: boolean }[]
      error?: string
    }>('fs.list_dir', { workspace_path: props.workspacePath, rel_path: dir })
    const entries = resp.payload?.ok ? (resp.payload.entries ?? []) : []
    // A history dir can hold snapshots of both an `.html` and a same-stem
    // `.plan.md` plan; only show the ones matching the open plan's format so
    // parseSnapshotName / diff never mix formats.
    const isHtml = props.relPath.endsWith('.html')
    historyEntries.value = entries
      .flatMap((entry) => {
        if (entry.is_dir) return []
        if (entry.name.endsWith('.html') !== isHtml) return []
        const parsed = parseSnapshotName(entry.name)
        return parsed ? [{ relPath: `${dir}/${entry.name}`, ...parsed }] : []
      })
      .sort((a, b) => b.ts.localeCompare(a.ts))
  } catch {
    historyEntries.value = []
  }
}

function snapshotLabel(snap: HistorySnapshot): string {
  return `${snap.date.toLocaleString()} · ${snap.stage}`
}

async function showDiff(snap: HistorySnapshot): Promise<void> {
  if (diffFor.value === snap.relPath) {
    diffFor.value = null
    diffSummary.value = null
    return
  }
  try {
    const read = (relPath: string) =>
      props.backend.send<{ ok: boolean; content?: string; error?: string }>('fs.read_file', {
        workspace_path: props.workspacePath,
        rel_path: relPath,
      })
    const [snapResp, currentResp] = await Promise.all([read(snap.relPath), read(props.relPath)])
    if (
      !snapResp.payload?.ok ||
      snapResp.payload.content === undefined ||
      !currentResp.payload?.ok ||
      currentResp.payload.content === undefined
    ) {
      toast(t('pane.plans.history-diff-failed'))
      return
    }
    diffSummary.value = diffPlanContents(snapResp.payload.content, currentResp.payload.content)
    diffFor.value = snap.relPath
  } catch {
    toast(t('pane.plans.history-diff-failed'))
  }
}

const diffIsEmpty = computed(() => {
  const d = diffSummary.value
  if (!d) return false
  return (
    d.stageFrom === d.stageTo &&
    d.todoChanges.length === 0 &&
    d.todosAdded === 0 &&
    d.todosRemoved === 0 &&
    d.notesDelta === 0 &&
    d.linesAdded === 0 &&
    d.linesRemoved === 0
  )
})

function previewSnapshot(snap: HistorySnapshot): void {
  emit('preview-snapshot', { relPath: snap.relPath, label: snapshotLabel(snap) })
}

const sharing = ref(false)

// Snapshot the plan into `.plans/` (git-tracked); shared logic lives in
// planShare.ts so the PlansPane context menu reuses the same semantics.
async function shareToGit(): Promise<void> {
  if (sharing.value) return
  sharing.value = true
  try {
    const result = await sharePlanToGit(props.backend, props.workspacePath, props.relPath)
    if (result.ok) toast(t('pane.plans.share-git-success'))
    else toast(result.error ?? t('pane.plans.share-git-failed'))
  } catch (err) {
    toast(err instanceof Error ? err.message : t('pane.plans.share-git-failed'))
  } finally {
    sharing.value = false
  }
}

const openingInBrowser = ref(false)

// Open the plan's raw .html file in the OS default handler for .html
// (normally the default browser). Uses shell:openPath — openExternal rejects
// file:// URLs in the main process, so it can't open a local file.
async function openInBrowser(): Promise<void> {
  if (openingInBrowser.value) return
  openingInBrowser.value = true
  try {
    const absPath = `${props.workspacePath.replace(/\/+$/, '')}/${props.relPath}`
    const result = await window.agentTeam?.openPath(absPath)
    if (!result?.ok) toast(result?.error ?? t('pane.plans.open-in-browser-failed'))
  } catch (err) {
    toast(err instanceof Error ? err.message : t('pane.plans.open-in-browser-failed'))
  } finally {
    openingInBrowser.value = false
  }
}

// In-document interactions (validated by the host) reuse these existing
// write paths — the injected runtime never writes to disk on its own.
// ── Overflow menu (⋯) ─────────────────────────────────────────────────────
// The bar keeps only what an edit session actually reaches for; navigation,
// export and lifecycle actions live in this menu, with the irreversible ones
// fenced off at the bottom. Dismissal follows the plan list's menu: a
// full-viewport backdrop for outside clicks, ESC via closeActiveOverlay.
const overflowOpen = ref(false)
const outlineOpen = ref(false)

function toggleOverflow(): void {
  overflowOpen.value = !overflowOpen.value
  if (!overflowOpen.value) outlineOpen.value = false
}

function closeOverflow(): void {
  overflowOpen.value = false
  outlineOpen.value = false
}

// Menu actions dismiss the menu first: several of them raise a confirm dialog,
// and leaving an open menu behind it reads as two competing surfaces.
function runFromOverflow(action: () => unknown): void {
  closeOverflow()
  void action()
}

// Delete lives here as well as in the list's context menu, so the open document
// can be dealt with without going back to the sidebar. Same two-step guard as
// the list: a plan under review or already approved asks a second time.
async function deletePlan(): Promise<void> {
  const name = meta.value?.name ?? props.relPath.split('/').pop() ?? props.relPath
  const ok = await confirm(t('pane.plans.delete-confirm', { name }), {
    title: t('pane.plans.menu-delete'),
    confirmText: t('pane.plans.menu-delete'),
  })
  if (!ok) return
  const stage = meta.value?.stage
  if (stage === 'in-review' || stage === 'approved') {
    const ok2 = await confirm(t('pane.plans.delete-confirm-review', { stage }), {
      title: t('pane.plans.menu-delete'),
      confirmText: t('pane.plans.menu-delete'),
    })
    if (!ok2) return
  }
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.delete', {
    workspace_path: props.workspacePath,
    rel_path: props.relPath,
  })
  if (!resp.payload?.ok) {
    toast(resp.payload?.error ?? t('pane.plans.delete-failed'), { type: 'error' })
    return
  }
  emit('deleted', props.relPath)
}

// ── Narrow-width demotion ─────────────────────────────────────────────────
// The bar must never wrap. When the buttons no longer fit, they move into the
// ⋯ menu in reverse priority — Todos goes first, Approve last, because that is
// the action the whole review flow leads to.
const DEMOTION_ORDER = ['todos', 'execute', 'approve'] as const
type DemotableAction = (typeof DEMOTION_ORDER)[number]

const barEl = ref<HTMLElement | null>(null)
const demotedCount = ref(0)
let refitting = false

function isDemoted(action: DemotableAction): boolean {
  return DEMOTION_ORDER.indexOf(action) < demotedCount.value
}

// Measure, demote one, measure again — at most three passes. Done against the
// live layout rather than width breakpoints because the information block
// (stage, progress) has no fixed width.
async function refitBar(): Promise<void> {
  const el = barEl.value
  if (!el || refitting) return
  refitting = true
  try {
    demotedCount.value = 0
    await nextTick()
    while (demotedCount.value < DEMOTION_ORDER.length && el.scrollWidth > el.clientWidth + 1) {
      demotedCount.value++
      await nextTick()
    }
  } finally {
    refitting = false
  }
}

let barResizeObserver: ResizeObserver | null = null
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !barEl.value) return
  barResizeObserver = new ResizeObserver(() => void refitBar())
  barResizeObserver.observe(barEl.value)
})
onBeforeUnmount(() => barResizeObserver?.disconnect())

defineExpose({ cycleTodo, toggleSkipTodo, startNoteWithAnchor, closeActiveOverlay, refitBar })
</script>

<template>
  <div v-if="meta" class="prt">
    <div ref="barEl" class="prt-bar">
      <span class="prt-stage" :class="`prt-stage--${meta.stage}`">{{ t(`pane.plans.stage-${meta.stage}`) }}</span>
      <span v-if="isArchived" class="prt-archived-pill">{{ t('pane.plans.archived') }}</span>
      <span class="prt-progress">{{ t('pane.plans.progress-done', { done: progress.done, total: progress.total }) }}</span>
      <span
        v-if="progress.total > 0"
        class="prt-progress-bar"
        :class="`prt-progress-bar--${meta.stage}`"
        role="progressbar"
        aria-valuemin="0"
        :aria-valuenow="progress.done"
        :aria-valuemax="progress.total"
        :aria-label="t('pane.plans.progress-done', { done: progress.done, total: progress.total })"
      >
        <span class="prt-progress-fill" :style="{ width: progressPercent }" />
      </span>
      <span class="prt-spacer" />
      <!-- Persistent actions: icon-only, named by their tooltip. Unresolved
           review notes rejoin them — burying "2 still open" in a menu hides
           exactly what the review stage exists to surface. -->
      <button
        v-if="!isDemoted('todos')"
        class="prt-icon-btn prt-todos-btn"
        :class="{ 'prt-icon-btn--on': todosOpen }"
        :title="t('pane.plans.todos')"
        :aria-label="t('pane.plans.todos')"
        :aria-pressed="todosOpen"
        @click="todosOpen = !todosOpen"
      >☑</button>
      <button
        v-if="unresolvedCount > 0"
        class="prt-icon-btn prt-icon-btn--attention prt-notes-btn"
        :class="{ 'prt-icon-btn--on': notesOpen }"
        :title="`${t('pane.plans.review-notes')} · ${t('pane.plans.review-unresolved', { count: unresolvedCount })}`"
        :aria-label="`${t('pane.plans.review-notes')} · ${t('pane.plans.review-unresolved', { count: unresolvedCount })}`"
        :aria-pressed="notesOpen"
        @click="notesOpen = !notesOpen"
      >💬<span class="prt-icon-count">{{ unresolvedCount }}</span></button>
      <button
        v-if="canExecute && !isDemoted('execute')"
        class="prt-icon-btn prt-icon-btn--execute prt-execute"
        :class="{ 'prt-icon-btn--on': executeOpen }"
        :disabled="saving || dispatching"
        :title="t('pane.plans.execute-tooltip')"
        :aria-label="t('pane.plans.execute')"
        :aria-pressed="executeOpen"
        @click="executeOpen = !executeOpen"
      >▶</button>
      <button
        v-if="!isDemoted('approve')"
        class="prt-icon-btn prt-icon-btn--approve prt-approve"
        :disabled="!canApprove || saving"
        :title="canApprove ? t('pane.plans.review-approve') : t('pane.plans.review-approve-hint')"
        :aria-label="t('pane.plans.review-approve')"
        @click="approve"
      >✓</button>
      <button
        class="prt-icon-btn prt-overflow-btn"
        :class="{ 'prt-icon-btn--on': overflowOpen }"
        :title="t('pane.plans.more-actions')"
        :aria-label="t('pane.plans.more-actions')"
        :aria-expanded="overflowOpen"
        @click="toggleOverflow"
      >⋯</button>
    </div>

    <template v-if="overflowOpen">
      <div class="prt-menu-backdrop" @click="closeOverflow" @contextmenu.prevent="closeOverflow" />
      <div class="prt-menu" @click.stop>
        <template v-if="isDemoted('todos')">
          <button class="prt-menu-item prt-menu-todos" @click="closeOverflow(); todosOpen = !todosOpen">
            {{ t('pane.plans.todos') }}
          </button>
        </template>
        <template v-if="canExecute && isDemoted('execute')">
          <button
            class="prt-menu-item prt-menu-execute"
            :disabled="saving || dispatching"
            @click="closeOverflow(); executeOpen = !executeOpen"
          >{{ t('pane.plans.execute') }}</button>
        </template>
        <template v-if="isDemoted('approve')">
          <button
            class="prt-menu-item prt-menu-approve"
            :disabled="!canApprove || saving"
            @click="runFromOverflow(approve)"
          >{{ t('pane.plans.review-approve') }}</button>
        </template>

        <button
          v-if="outline.length"
          class="prt-menu-item prt-menu-item--parent prt-menu-outline"
          :aria-expanded="outlineOpen"
          @click="outlineOpen = !outlineOpen"
        >
          <span>{{ t('pane.plans.outline') }}</span>
          <span class="prt-menu-chevron" :class="{ open: outlineOpen }">▸</span>
        </button>
        <button
          v-for="anchor in outlineOpen ? outline : []"
          :key="anchor"
          class="prt-menu-item prt-menu-item--child prt-menu-anchor"
          @click="pickOutlineAnchor(anchor)"
        >{{ anchor }}</button>
        <button
          v-if="unresolvedCount === 0"
          class="prt-menu-item prt-notes-btn"
          @click="closeOverflow(); notesOpen = !notesOpen"
        >{{ t('pane.plans.review-notes') }}</button>
        <button class="prt-menu-item prt-history-btn" @click="runFromOverflow(toggleHistory)">
          {{ t('pane.plans.history') }}
        </button>

        <div class="prt-menu-sep" />
        <button class="prt-menu-item prt-share" :disabled="sharing" @click="runFromOverflow(shareToGit)">
          {{ t('pane.plans.share-git') }}
        </button>
        <button
          v-if="props.relPath.endsWith('.html')"
          class="prt-menu-item prt-open-browser"
          :disabled="openingInBrowser"
          @click="runFromOverflow(openInBrowser)"
        >{{ t('pane.plans.open-in-browser') }}</button>

        <div class="prt-menu-sep" />
        <button
          v-if="canReopen"
          class="prt-menu-item prt-reopen"
          :disabled="saving"
          @click="runFromOverflow(reopen)"
        >{{ t('pane.plans.reopen') }}</button>
        <button
          v-if="isArchived"
          class="prt-menu-item prt-unarchive"
          :disabled="saving"
          @click="runFromOverflow(unarchive)"
        >{{ t('pane.plans.unarchive') }}</button>
        <button
          v-else
          class="prt-menu-item prt-archive"
          :disabled="saving"
          @click="runFromOverflow(archive)"
        >{{ t('pane.plans.archive') }}</button>

        <!-- Irreversible actions, fenced off from everything above. -->
        <div class="prt-menu-sep" />
        <button
          v-if="canAbandon"
          class="prt-menu-item prt-menu-item--danger prt-abandon"
          :disabled="saving"
          @click="runFromOverflow(abandon)"
        >{{ t('pane.plans.abandon') }}</button>
        <button class="prt-menu-item prt-menu-item--danger prt-delete" @click="runFromOverflow(deletePlan)">
          {{ t('pane.plans.menu-delete') }}
        </button>
      </div>
    </template>

    <div v-if="executeOpen && canExecute" class="prt-panel">
      <div class="prt-execute-pick">{{ t('pane.plans.execute-pick-agent') }}</div>
      <button
        v-for="spec in cliAgentSpecs"
        :key="spec.agentKey"
        class="prt-execute-agent"
        :disabled="saving || dispatching"
        @click="dispatchExecution(spec.agentKey)"
      >
        <span class="prt-execute-agent-label">{{ spec.label }}</span>
        <span v-if="spec.hint" class="prt-execute-agent-hint">{{ spec.hint }}</span>
      </button>
    </div>

    <div v-if="todosOpen" class="prt-panel">
      <div v-if="meta.todos.length === 0" class="prt-empty">{{ t('pane.plans.todos-empty') }}</div>
      <div v-for="todo in meta.todos" :key="todo.id" class="prt-todo-row">
        <template v-if="editingTodoId === todo.id">
          <input
            v-model="editTodoText"
            class="prt-input"
            :disabled="saving"
            @keydown.enter="onEditTodoEnter"
            @keydown.escape="cancelEditTodo"
          />
          <button class="prt-send" :disabled="saving || !editTodoText.trim()" @click="submitEditTodo">
            {{ t('pane.plans.save') }}
          </button>
          <button class="prt-ghost" :disabled="saving" @click="cancelEditTodo">{{ t('pane.plans.cancel') }}</button>
        </template>
        <template v-else>
          <button
            class="prt-todo"
            :class="`prt-todo--${todo.status}`"
            :disabled="saving"
            :title="t('pane.plans.todo-cycle-tooltip')"
            @click="cycleTodo(todo.id)"
            @contextmenu.prevent="toggleSkipTodo(todo.id)"
          >
            <span class="prt-todo-status">{{ todo.status }}</span>
            <span class="prt-todo-content">{{ todo.content }}</span>
          </button>
          <button class="prt-ghost" :disabled="saving" :title="t('pane.plans.edit')" @click="startEditTodo(todo)">
            {{ t('pane.plans.edit') }}
          </button>
          <button
            class="prt-ghost prt-ghost--danger"
            :disabled="saving"
            :title="t('pane.plans.delete')"
            @click="deleteTodo(todo.id)"
          >{{ t('pane.plans.delete') }}</button>
        </template>
      </div>
      <div class="prt-new">
        <input
          v-model="newTodoText"
          class="prt-input"
          :placeholder="t('pane.plans.todo-add-placeholder')"
          :disabled="saving"
          @keydown.enter="onNewTodoEnter"
        />
        <button class="prt-send" :disabled="saving || !newTodoText.trim()" @click="addTodo">
          {{ t('pane.plans.todo-add') }}
        </button>
      </div>
    </div>

    <div v-if="historyOpen" class="prt-panel">
      <div v-if="historyEntries.length === 0" class="prt-empty">{{ t('pane.plans.history-empty') }}</div>
      <template v-for="snap in historyEntries" :key="snap.relPath">
        <div class="prt-history-row">
          <span class="prt-history-time">{{ snap.date.toLocaleString() }}</span>
          <span class="prt-history-stage">{{ snap.stage }}</span>
          <span class="prt-spacer" />
          <button class="prt-history-action" @click="previewSnapshot(snap)">
            {{ t('pane.plans.history-preview') }}
          </button>
          <button
            class="prt-history-action"
            :class="{ 'prt-history-action--open': diffFor === snap.relPath }"
            @click="showDiff(snap)"
          >{{ t('pane.plans.history-diff') }}</button>
        </div>
        <div v-if="diffFor === snap.relPath && diffSummary" class="prt-history-diff">
          <div v-if="diffIsEmpty">{{ t('pane.plans.history-no-differences') }}</div>
          <template v-else>
            <div v-if="diffSummary.stageFrom !== diffSummary.stageTo">
              {{ t('pane.plans.history-diff-stage', { from: diffSummary.stageFrom ?? '—', to: diffSummary.stageTo ?? '—' }) }}
            </div>
            <div v-for="change in diffSummary.todoChanges" :key="change.id">
              {{ t('pane.plans.history-diff-todo', { id: change.id, from: change.from, to: change.to }) }}
            </div>
            <div v-if="diffSummary.todosAdded > 0">
              {{ t('pane.plans.history-diff-todos-added', { count: diffSummary.todosAdded }) }}
            </div>
            <div v-if="diffSummary.todosRemoved > 0">
              {{ t('pane.plans.history-diff-todos-removed', { count: diffSummary.todosRemoved }) }}
            </div>
            <div v-if="diffSummary.notesDelta !== 0">
              {{ t('pane.plans.history-diff-notes', { delta: (diffSummary.notesDelta > 0 ? '+' : '') + diffSummary.notesDelta }) }}
            </div>
            <div v-if="diffSummary.linesAdded > 0 || diffSummary.linesRemoved > 0">
              {{ t('pane.plans.history-diff-lines', { added: diffSummary.linesAdded, removed: diffSummary.linesRemoved }) }}
            </div>
          </template>
        </div>
      </template>
    </div>

    <div v-if="notesOpen" class="prt-panel">
      <div v-if="meta.reviewNotes.length === 0" class="prt-empty">{{ t('pane.plans.review-empty') }}</div>
      <div
        v-for="note in meta.reviewNotes"
        :key="note.id"
        class="prt-note"
        :class="{ 'prt-note--resolved': note.resolved }"
      >
        <span class="prt-note-author">{{ note.author }}</span>
        <div class="prt-note-main">
          <template v-if="editingNoteId === note.id">
            <input
              v-model="editNoteText"
              class="prt-input"
              :disabled="saving"
              @keydown.enter="onEditNoteEnter"
              @keydown.escape="cancelEditNote"
            />
            <div class="prt-note-editbar">
              <button class="prt-send" :disabled="saving || !editNoteText.trim()" @click="submitEditNote">
                {{ t('pane.plans.save') }}
              </button>
              <button class="prt-ghost" :disabled="saving" @click="cancelEditNote">{{ t('pane.plans.cancel') }}</button>
            </div>
          </template>
          <template v-else>
            <div class="prt-note-text">
              <span v-if="note.anchor" class="prt-note-anchor" v-truncate>{{ note.anchor }}</span>{{ note.text }}
            </div>
            <div v-if="note.reply" class="prt-note-reply">{{ note.reply }}</div>
          </template>
        </div>
        <template v-if="editingNoteId !== note.id">
          <button
            v-if="note.author === 'user'"
            class="prt-ghost"
            :disabled="saving"
            :title="t('pane.plans.edit')"
            @click="startEditNote(note)"
          >{{ t('pane.plans.edit') }}</button>
          <button
            class="prt-ghost prt-ghost--danger"
            :disabled="saving"
            :title="t('pane.plans.delete')"
            @click="deleteNote(note.id)"
          >{{ t('pane.plans.delete') }}</button>
          <span v-if="note.resolved" class="prt-note-done">{{ t('pane.plans.review-resolved') }}</span>
          <button v-else class="prt-note-resolve" :disabled="saving" @click="resolveNote(note.id)">
            {{ t('pane.plans.review-resolve') }}
          </button>
        </template>
      </div>
      <div class="prt-new">
        <span v-if="pendingAnchor" class="prt-note-anchor prt-note-anchor--pending" v-truncate>
          {{ pendingAnchor }}
          <button
            class="prt-anchor-clear"
            :title="t('pane.plans.note-anchor-clear')"
            @click="pendingAnchor = ''"
          >✕</button>
        </span>
        <input
          ref="noteInput"
          v-model="newNoteText"
          class="prt-input"
          :placeholder="t('pane.plans.review-add-placeholder')"
          @keydown.enter="onNoteEnter"
        />
        <button class="prt-send" :disabled="saving || !newNoteText.trim()" @click="submitNote">
          {{ t('pane.plans.review-send') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prt {
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
  font-family: var(--font-ui, system-ui, sans-serif);
  font-size: var(--font-xs);
  /* Anchor for the ⋯ menu. */
  position: relative;
}

/* Never wraps: when the buttons stop fitting they demote into the ⋯ menu
   (refitBar) rather than pushing the bar onto a second line. */
.prt-bar {
  align-items: center;
  display: flex;
  flex-wrap: nowrap;
  gap: 6px 10px;
  overflow: hidden;
  padding: 6px 12px;
}

.prt-icon-btn {
  align-items: center;
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  flex-shrink: 0;
  font-size: var(--font-2xs);
  gap: 3px;
  height: 22px;
  justify-content: center;
  min-width: 26px;
  padding: 0 6px;
}

.prt-icon-btn:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}

.prt-icon-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.prt-icon-btn--on {
  border-color: var(--accent-focus);
}

.prt-icon-btn--execute {
  background: var(--accent-subtle);
  border-color: var(--accent-fg);
  color: var(--accent-fg);
}

.prt-icon-btn--approve {
  background: var(--success-subtle);
  border-color: var(--success-fg);
  color: var(--success-fg);
}

.prt-icon-btn--attention {
  background: var(--attention-subtle);
  border-color: var(--attention-bright);
  color: var(--attention-bright);
}

.prt-icon-count {
  font-size: var(--font-3xs);
  font-weight: 700;
}

.prt-menu-backdrop {
  inset: 0;
  position: fixed;
  z-index: 40;
}

.prt-menu {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  min-width: 190px;
  padding: 4px;
  position: absolute;
  right: 10px;
  top: 32px;
  z-index: 41;
}

.prt-menu-item {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 5px;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  font-size: 11.5px;
  gap: 8px;
  justify-content: space-between;
  padding: 5px 8px;
  text-align: left;
  width: 100%;
}

.prt-menu-item:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}

.prt-menu-item:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.prt-menu-item--child {
  color: var(--text-muted);
  font-size: var(--font-2xs);
  padding-left: 20px;
}

.prt-menu-item--danger {
  color: var(--danger-fg);
}

.prt-menu-chevron {
  color: var(--text-muted);
  font-size: 9px;
}

.prt-menu-chevron.open {
  transform: rotate(90deg);
}

.prt-menu-sep {
  background: var(--border-subtle);
  height: 1px;
  margin: 4px 2px;
}

.prt-stage {
  border-radius: 10px;
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  text-transform: uppercase;
}

.prt-stage--draft {
  background: var(--bg-muted);
  color: var(--text-secondary);
}

.prt-stage--in-review {
  background: var(--attention-subtle);
  color: var(--attention-bright);
}

.prt-stage--approved {
  background: var(--accent-subtle);
  color: var(--accent-fg);
}

.prt-stage--in-progress {
  background: var(--attention-subtle);
  color: var(--warning-fg);
}

.prt-stage--done {
  background: var(--success-subtle);
  color: var(--success-fg);
}

.prt-stage--abandoned {
  background: var(--danger-subtle);
  color: var(--danger-fg);
}

.prt-progress {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}

.prt-progress-bar {
  background: var(--bg-muted);
  border-radius: 999px;
  flex-shrink: 0;
  height: 4px;
  overflow: hidden;
  width: 90px;
}

.prt-progress-fill {
  background: var(--text-secondary);
  border-radius: 999px;
  display: block;
  height: 100%;
}

/* Fill colors mirror the .prt-stage--{stage} pill palette above — keep in sync. */
.prt-progress-bar--draft > .prt-progress-fill {
  background: var(--text-secondary);
}

.prt-progress-bar--in-review > .prt-progress-fill {
  background: var(--attention-bright);
}

.prt-progress-bar--approved > .prt-progress-fill {
  background: var(--accent-fg);
}

.prt-progress-bar--in-progress > .prt-progress-fill {
  background: var(--warning-fg);
}

.prt-progress-bar--done > .prt-progress-fill {
  background: var(--success-fg);
}

.prt-progress-bar--abandoned > .prt-progress-fill {
  background: var(--danger-fg);
}

.prt-note-anchor {
  background: var(--accent-subtle);
  border-radius: 999px;
  color: var(--accent-fg);
  display: inline-block;
  font-size: var(--font-3xs);
  font-weight: 600;
  margin-right: 6px;
  max-width: 180px;
  overflow: hidden;
  padding: 1px 8px;
  text-overflow: ellipsis;
  vertical-align: 1px;
  white-space: nowrap;
}

.prt-note-anchor--pending {
  align-self: center;
  flex-shrink: 0;
  margin-right: 0;
}

.prt-anchor-clear {
  background: none;
  border: none;
  color: var(--accent-fg);
  cursor: pointer;
  font-size: var(--font-2xs);
  padding: 0 0 0 4px;
}

.prt-spacer {
  flex: 1;
}

.prt-history-action,
.prt-note-resolve,
.prt-send {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-2xs);
  padding: 3px 10px;
}

.prt-archived-pill {
  background: var(--bg-muted);
  border-radius: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  text-transform: uppercase;
}

.prt-history-action:hover,
.prt-note-resolve:hover:not(:disabled),
.prt-send:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}

.prt-history-action--open {
  border-color: var(--accent-focus);
}

.prt-history-row {
  align-items: center;
  border-bottom: 1px dashed var(--border-muted);
  display: flex;
  gap: 8px;
  padding: 5px 0;
}

.prt-history-row:last-of-type {
  border-bottom: none;
}

.prt-history-time {
  color: var(--text-primary);
}

.prt-history-stage {
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-secondary);
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  padding: 1px 8px;
  text-transform: uppercase;
}

.prt-history-diff {
  border-left: 2px solid var(--border-strong);
  color: var(--text-secondary);
  line-height: var(--lh-base);
  margin: 2px 0 6px;
  padding-left: 8px;
}

.prt-todo-row {
  align-items: center;
  border-bottom: 1px dashed var(--border-muted);
  display: flex;
  gap: 6px;
  padding: 2px 0;
}

.prt-todo-row:last-of-type {
  border-bottom: none;
}

.prt-ghost {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  font-size: var(--font-3xs);
  padding: 2px 8px;
}

.prt-ghost:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}

.prt-ghost:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.prt-ghost--danger {
  color: var(--danger-fg);
}

.prt-note-editbar {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.prt-todo {
  align-items: baseline;
  background: transparent;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  flex: 1;
  font-size: var(--font-xs);
  gap: 8px;
  min-width: 0;
  padding: 5px 0;
  text-align: left;
}

.prt-todo:hover:not(:disabled) {
  background: var(--bg-hover);
}

.prt-todo:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.prt-todo-status {
  border-radius: 999px;
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  min-width: 74px;
  padding: 1px 8px;
  text-align: center;
  text-transform: uppercase;
}

.prt-todo--pending .prt-todo-status {
  background: var(--bg-muted);
  color: var(--text-secondary);
}

.prt-todo--in-progress .prt-todo-status {
  background: var(--attention-subtle);
  color: var(--attention-bright);
}

.prt-todo--done .prt-todo-status {
  background: var(--success-subtle);
  color: var(--success-fg);
}

.prt-todo--skipped .prt-todo-status {
  background: var(--bg-muted);
  color: var(--text-muted);
  text-decoration: line-through;
}

.prt-todo--done .prt-todo-content,
.prt-todo--skipped .prt-todo-content {
  color: var(--text-secondary);
}

.prt-todo-content {
  flex: 1;
  line-height: 1.45;
  min-width: 0;
  overflow-wrap: break-word;
}

.prt-execute-pick {
  color: var(--text-secondary);
  padding: 2px 0 6px;
}

.prt-execute-agent {
  align-items: baseline;
  background: transparent;
  border: none;
  border-bottom: 1px dashed var(--border-muted);
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  font-size: var(--font-xs);
  gap: 8px;
  padding: 5px 0;
  text-align: left;
  width: 100%;
}

.prt-execute-agent:last-of-type {
  border-bottom: none;
}

.prt-execute-agent:hover:not(:disabled) {
  background: var(--bg-hover);
}

.prt-execute-agent:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.prt-execute-agent-label {
  font-weight: 600;
}

.prt-execute-agent-hint {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}

.prt-note-resolve:disabled,
.prt-send:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.prt-panel {
  border-top: 1px solid var(--border-muted);
  max-height: 40vh;
  overflow-y: auto;
  padding: 8px 12px;
}

.prt-empty {
  color: var(--text-secondary);
  font-style: italic;
  padding: 4px 0;
}

.prt-note {
  align-items: baseline;
  display: flex;
  gap: 8px;
  padding: 5px 0;
}

.prt-note--resolved .prt-note-text {
  color: var(--text-secondary);
}

.prt-note-author {
  color: var(--text-secondary);
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  min-width: 30px;
  text-transform: uppercase;
}

.prt-note-main {
  flex: 1;
  min-width: 0;
}

.prt-note-text {
  color: var(--text-primary);
  line-height: 1.45;
  overflow-wrap: break-word;
}

.prt-note-reply {
  border-left: 2px solid var(--border-strong);
  color: var(--text-secondary);
  line-height: 1.45;
  margin-top: 2px;
  overflow-wrap: break-word;
  padding-left: 8px;
}

.prt-note-done {
  color: var(--success-fg);
  flex-shrink: 0;
  font-size: var(--font-3xs);
  font-weight: 600;
  text-transform: uppercase;
}

.prt-new {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}

.prt-input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  flex: 1;
  font-size: var(--font-xs);
  padding: 4px 8px;
}

.prt-input:focus {
  border-color: var(--accent-focus);
  outline: none;
}
</style>
