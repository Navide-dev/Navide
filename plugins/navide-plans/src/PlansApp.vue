<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { SafeAiCliPanel } from '@navide/plugin-ui'
import {
  preparePlanDocHtml,
} from './planSecurity'
import { useNotify, useTheme, vTruncate } from '@navide/plugin-ui/foundation'
import {
  backendErrorMessage,
  callCapability,
  getWorkspacePreference,
  plansBackend,
  plansViewRuntime,
  setWorkspacePreference,
  createPlansAiCliController,
} from './backend'
import { installPlansKeybindings } from './plansKeybindings'
import { buildPlanCliContext } from './planCliContext'
import { workspaceDisplayName } from './workspaceAlias'
import PlanReviewToolbar from './retained/PlanReviewToolbar.vue'
import PlanMarkdownBody from './retained/PlanMarkdownBody.vue'
import HtmlFilePreview from './HtmlFilePreview.vue'
import PlanShareButton from './PlanShareButton.vue'
import NotificationHost from './retained/NotificationHost.vue'
import SectionConflictDialog from './retained/SectionConflictDialog.vue'
import { preserveConflictSide, resolvePlanStore, type SectionBody, type SectionConflict, type WriteResult } from './retained/planStore'
import { htmlPlanAwaitingUser, parseHtmlPlanMeta, replaceSectionBody as spliceHtmlSection, syncHeaderMarkup } from './retained/usePlanHtml'
import { sharePlanToGit } from './retained/planShare'
import { plansTransport } from './retained/transport'
import { listAllPlans, readWholeDocument } from './planPaging'
import type { ReviewNote, PlanTodo as RetainedTodo, PlanMeta as RetainedMeta } from './retained/planModel'
import { buildPlanRuntimeScript, buildTodoStatusRuntime, createPlanRuntimeMessageHandler, sanitizePlanSectionHtml } from './retained/planRuntime'

interface TodoSummary {
  total: number
  by_status: Record<string, number>
  awaiting_user?: number
}

interface PlanTodo {
  id: string
  content: string
  status: string
}

interface PlanMeta {
  schemaVersion?: number
  name: string
  overview?: string
  stage: string
  approvedAt?: string | null
  archivedAt?: string | null
  todos: PlanTodo[]
  reviewNotes: Array<{ id: string; author: string; text: string; resolved?: boolean; reply?: string; anchor?: string }>
  [key: string]: unknown
}

interface PlanSummary {
  rel_path: string
  name: string
  stage?: string | null
  overview?: string
  todos?: TodoSummary
  mtime?: number | null
  kind?: 'plan' | 'document' | 'unreadable'
  meta?: PlanMeta | null
  /** Why the backend could not fully read or parse this document; it is
   *  listed regardless, so no plan ever disappears from the view. */
  reason?: string
  size?: number
  /** Set when the entry had to drop its meta but the plan is archived. */
  archivedAt?: string
}

interface PlanDocument {
  rel_path: string
  meta: PlanMeta | null
  html?: string
  mtime?: number | null
}

interface PlanGroup {
  key: string
  label: string
  plans: PlanSummary[]
}

const PLAN_STAGES = ['draft', 'in-review', 'approved', 'in-progress', 'done', 'abandoned'] as const
type PlanStage = (typeof PLAN_STAGES)[number]
type StageFilter = 'all' | PlanStage
type SortMode = 'updated' | 'title' | 'progress'
type SortDirection = 'asc' | 'desc'
type GroupMode = 'flat' | 'stage'

const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
// Plan rel_paths are '/'-separated; a Windows Host may hand over '\\' ones.
const toPlanRelPath = (path: string): string => path.replace(/\\/g, '/')
const initialRelPath = toPlanRelPath(params.get('rel_path') ?? '')
const initialFilePath = params.get('filepath') ?? ''
// What the window title calls this workspace: the alias the user gave it,
// resolved by the Host and passed as `workspace_display_name`, else the folder
// name. Blank or absent means "no alias" — that is how clearing one works.
// KNOWN LIMITATION: a load-time snapshot. Renaming the workspace while this
// window is open does NOT retitle it — this bundle talks to a capability shim
// with no project.* call or event, so there is nothing to follow. The title is
// correct again the next time the window opens.
const workspaceTitleName = workspaceDisplayName(workspacePath, params.get('workspace_display_name'))
function isLeftContribution(): boolean {
  return new URLSearchParams(window.location.search).get('contribution') === 'left'
}
const { loadTheme } = useTheme()
const { toast, confirm, dialog } = useNotify()
const { t, te } = useI18n()

function formatBackendError(cause: unknown): string {
  return backendErrorMessage(cause, { t, te })
}

const planDocFrame = ref<HTMLIFrameElement | null>(null)
const reviewToolbar = ref<InstanceType<typeof PlanReviewToolbar> | null>(null)
// Markdown documents render their body in-process (no iframe); the ref carries
// the outline-scroll and cancel-edit handles the HTML path gets by postMessage.
const markdownBody = ref<InstanceType<typeof PlanMarkdownBody> | null>(null)
// Bumped on every completed document read so an open markdown body reloads in
// place after a toolbar write, mirroring the HTML preview's refresh counter.
const markdownRefresh = ref(0)

const plans = ref<PlanSummary[]>([])
const selectedPath = ref(initialRelPath)
const selected = ref<PlanDocument | null>(null)
const htmlPreviewTarget = ref<{ path: string; name: string } | null>(null)
const documentLoadError = ref<{ relPath: string; reason: string } | null>(null)
const searchQuery = ref('')
const stageFilter = ref<StageFilter>('all')
const sort = ref<SortMode>('updated')
const sortDirection = ref<SortDirection>('desc')
const groupMode = ref<GroupMode>('flat')
const collapsedSections = ref<Set<string>>(new Set(['archived']))
const loading = ref(false)
const error = ref('')
const busy = ref(false)
const recentPaths = ref<string[]>([])
const pinnedPaths = ref<string[]>([])
const sidebarCollapsed = ref(false)
const quickOpenActive = ref(false)
const quickOpenQuery = ref('')
const quickOpenIndex = ref(0)
const quickOpenInput = ref<HTMLInputElement | null>(null)
const contextMenu = ref<{ x: number; y: number; relPath: string } | null>(null)
const renameInput = ref<HTMLInputElement | null>(null)
const renameTarget = ref<string | null>(null)
const renameValue = ref('')
// The share entry exists only after the Host confirmed share links work for
// this plan (Cloud linked, server supports links); any failure keeps the
// toolbar exactly as it is without the feature.
const shareAvailable = ref(false)
let shareCapsToken = 0
watch(() => selected.value?.rel_path, (relPath) => {
  shareAvailable.value = false
  void refreshShareCaps(relPath)
})
/** Ask the Host again whether share links work; the answer for a plan that
 *  is no longer open is dropped. The Cloud link has no event a plugin can
 *  follow, so this also runs when the window regains focus (back from
 *  linking in the account window) and before the share dialog opens. */
async function refreshShareCaps(relPath = selected.value?.rel_path): Promise<boolean> {
  const token = ++shareCapsToken
  if (!relPath || isLeftContribution()) return false
  let available = false
  try {
    const caps = await callCapability('ui', 'shareCaps', {}) as { ok?: unknown } | null
    available = caps?.ok === true
  } catch {
    // Unavailable: leave the toolbar unchanged.
  }
  if (token === shareCapsToken) shareAvailable.value = available
  return token === shareCapsToken && available
}
function onShareWindowFocus(): void {
  void refreshShareCaps()
}
window.addEventListener('focus', onShareWindowFocus)
onUnmounted(() => window.removeEventListener('focus', onShareWindowFocus))
let stopTarget: (() => void) | null = null
let plansSubscription: ReturnType<typeof plansBackend.subscribe> | null = null
/** One saved document produces several plans.changed events and a file storm
 * produces hundreds; each one used to start its own full plans.list scan. */
const PLANS_CHANGED_DEBOUNCE_MS = 200
let plansChangedTimer: ReturnType<typeof setTimeout> | null = null
const aiCliController = createPlansAiCliController()

/**
 * Briefing injected into the embedded CLI agent right after it spawns, the way
 * v1's AiCliDock did it: which plan is open, its plan-meta summary and a
 * truncated copy of the document. Built from the document already in hand so
 * the panel's synchronous `buildContext` contract is satisfied without a
 * second backend read.
 */
function buildAiCliContext(): string {
  const document = selected.value
  const meta = document?.meta ?? null
  return buildPlanCliContext({
    workspacePath,
    relPath: document?.rel_path ?? null,
    meta: meta
      ? { name: meta.name, stage: meta.stage, todoStatuses: meta.todos.map((todo) => todo.status) }
      : null,
    content: document?.html ?? null,
  })
}


const reviewNoteAnchors = computed(() => {
  const content = selected.value?.html
  if (!content) return []
  const document = new DOMParser().parseFromString(content, 'text/html')
  const anchors: string[] = []
  for (const heading of document.querySelectorAll('h2, .phase-head')) {
    let text = ''
    for (const node of heading.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) break
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? ''
    }
    const anchor = text.replace(/\s+/g, ' ').trim()
    if (anchor && !anchors.includes(anchor)) anchors.push(anchor)
  }
  return anchors
})

const currentDocumentToken = ref<string | null>(null)

let savedScrollY = 0
// Edit mode is owned by the frame (its toggle, Escape, or our request) and
// mirrored here; a plain flag, not a ref, so turning it on never re-renders
// the document, while a re-render for another reason keeps it on.
let editModeOnRender = false
let previewAnchorCounts: Record<string, number> = {}
const currentAnchorCounts = computed(() => JSON.stringify(countNoteAnchors(selected.value?.meta?.reviewNotes ?? [])))
const sectionEditing = ref(false)
const snapshotPreview = ref<{ relPath: string; label: string; html: string; anchors: Record<string, number> } | null>(null)
const previewHtml = computed(() => snapshotPreview.value?.html ?? selected.value?.html ?? '')
const previewTodoIds = computed(() => JSON.stringify(snapshotPreview.value ? [] : selected.value?.meta?.todos.map(todo => todo.id) ?? []))
const preparedDoc = computed(() => {
  const html = previewHtml.value
  if (!html) return null
  const todoIds = JSON.parse(previewTodoIds.value) as string[]
  return preparePlanDocHtml(html, {
    buildTrustedRuntimeScript: ({ documentToken }) => buildPlanRuntimeScript({
      documentToken,
      anchors: snapshotPreview.value?.anchors ?? previewAnchorCounts,
      commentLabel: t('pane.plans.doc-comment'),
      editLabel: t('pane.plans.edit'), deleteLabel: t('pane.plans.delete'),
      saveLabel: t('pane.plans.save'), cancelLabel: t('pane.plans.cancel'),
      scrollY: savedScrollY,
      editMode: editModeOnRender,
    }) + buildTodoStatusRuntime(documentToken, todoIds),
  })
})

watch(preparedDoc, (prepared) => {
  sectionEditing.value = false
  currentDocumentToken.value = prepared?.documentToken ?? null
}, { immediate: true })

const iframeSrcdoc = computed(() => preparedDoc.value?.html ?? '')

watch(currentAnchorCounts, (serialized) => {
  if (serialized === JSON.stringify(previewAnchorCounts)) return
  previewAnchorCounts = JSON.parse(serialized)
  if (snapshotPreview.value || !currentDocumentToken.value) return
  planDocFrame.value?.contentWindow?.postMessage({
    type: 'review-note-anchors-updated',
    documentToken: currentDocumentToken.value,
    anchors: previewAnchorCounts,
  }, '*')
}, { flush: 'post' })

async function toggleDocTodo(todoId: string, alt = false): Promise<void> {
  if (snapshotPreview.value) return
  const doc = selected.value
  const targetPath = doc?.rel_path
  const documentToken = currentDocumentToken.value
  const frameWindow = planDocFrame.value?.contentWindow
  if (!doc || !targetPath) return
  const currentTodo = doc.meta?.todos?.find((t) => t.id === todoId)
  const nextStatus = alt
    ? currentTodo?.status === 'skipped' ? 'pending' : 'skipped'
    : currentTodo?.status === 'pending' ? 'in-progress' : currentTodo?.status === 'in-progress' ? 'done' : 'pending'
  try {
    busy.value = true
    const result = await plansBackend.call('plans.update_todo', {
      rel_path: targetPath,
      todo_id: todoId,
      status: nextStatus,
    }) as unknown as PlanTodo
    if (
      selectedPath.value !== targetPath ||
      selected.value !== doc ||
      currentDocumentToken.value !== documentToken ||
      planDocFrame.value?.contentWindow !== frameWindow ||
      !frameWindow
    ) return

    const selectedTodo = doc.meta?.todos?.find((todo) => todo.id === todoId)
    if (!selectedTodo) return
    const confirmedStatus = typeof result?.status === 'string' ? result.status : nextStatus
    selectedTodo.status = confirmedStatus
    const listedTodo = plans.value
      .find((plan) => plan.rel_path === targetPath)
      ?.meta?.todos?.find((todo) => todo.id === todoId)
    if (listedTodo && listedTodo !== selectedTodo) listedTodo.status = confirmedStatus

    frameWindow.postMessage({
      type: 'todo-status-updated',
      documentToken,
      todoId,
      status: confirmedStatus,
    }, '*')
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}


interface SectionTarget { path: string; generation: number; document: PlanDocument }
function captureSectionTarget(): SectionTarget | null {
  if (!selected.value || !selectedPath.value || selected.value.rel_path !== selectedPath.value) return null
  return { path: selectedPath.value, generation: activeReadGeneration, document: selected.value }
}
function isActiveSectionTarget(target: SectionTarget): boolean {
  return selectedPath.value === target.path && activeReadGeneration === target.generation && selected.value === target.document
}
// The document the user saw when the current inline edit began. Section
// writes are checked against it, so an agent's change to the same section is
// never overwritten without the user choosing.
let sectionEditBase: string | null = null
// A section write waiting on the user's choice between their version and the
// one on disk; `body` is absent for a delete.
const pendingSectionConflict = ref<{ target: SectionTarget; conflict: SectionConflict; body?: SectionBody } | null>(null)
const sectionConflictSaving = ref(false)
const sectionConflictDialog = ref<InstanceType<typeof SectionConflictDialog> | null>(null)

function writeSection(target: SectionTarget, anchor: string, body: SectionBody | undefined, base: string): Promise<WriteResult> {
  const store = resolvePlanStore(target.path)
  const ctx = { backend: plansTransport, workspacePath, relPath: target.path }
  return body ? store.replaceSectionBody(ctx, anchor, body, base) : store.deleteSection(ctx, anchor, base)
}
/** Apply a section write's result; true when it was written. In edit mode
 *  the document is not re-rendered (that would drop the caret and anything
 *  typed since): the save state says it was written instead. */
async function settleSectionWrite(target: SectionTarget, body: SectionBody | undefined, result: WriteResult, inEditMode = false): Promise<boolean> {
  if (result.sectionConflict) {
    pendingSectionConflict.value = { target, conflict: result.sectionConflict, body }
    return false
  }
  if (!result.ok) {
    throw new Error(result.conflict ? t('pane.plans.section-write-busy') : result.error || t('pane.plans.review-save-failed'))
  }
  if (inEditMode) return true
  if (result.merged) toast(t('pane.plans.merged-others'), { type: 'success' })
  if (isActiveSectionTarget(target)) await refreshSelected()
  return true
}

const editModeActive = ref(false)
const editSaveState = ref<'idle' | 'saving' | 'saved' | 'failed'>('idle')
const editSavedAt = ref('')
// What the edit-mode frame shows: the document it rendered with this view's
// own saves applied. Saves are checked against it, so a section someone else
// changed after the frame rendered is a conflict, never overwritten with the
// stale text on screen.
let editModeView: string | null = null
// The bytes this view wrote last, which tells its own writes from others'.
let lastOwnWrite: string | null = null
// Edit-mode saves run one at a time, in the order they were typed.
let editWrites: Promise<void> = Promise.resolve()
let queuedEditWrites = 0

function queueEditWrite(task: () => Promise<boolean>): Promise<void> {
  queuedEditWrites++
  editSaveState.value = 'saving'
  const run = editWrites
    .then(task)
    .then(
      (written) => {
        if (written) editSavedAt.value = new Date().toLocaleTimeString()
        return written ? 'saved' as const : 'held' as const
      },
      (cause: unknown) => {
        toast(formatBackendError(cause), { type: 'error' })
        return 'failed' as const
      },
    )
    .then((outcome) => {
      queuedEditWrites--
      if (outcome === 'failed') editSaveState.value = 'failed'
      else if (queuedEditWrites === 0 && editSaveState.value === 'saving') {
        // 'held': a conflict waits on the user's choice; nothing new was saved.
        editSaveState.value = outcome === 'saved' || editSavedAt.value ? 'saved' : 'idle'
      }
    })
  editWrites = run
  return run
}

function postToFrame(message: Record<string, unknown>): void {
  planDocFrame.value?.contentWindow?.postMessage({ ...message, documentToken: currentDocumentToken.value }, '*')
}
function toggleEditMode(): void {
  postToFrame({ type: 'edit-mode', active: !editModeActive.value })
}
async function onEditModeChanged(active: boolean): Promise<void> {
  editModeActive.value = active
  editModeOnRender = active
  if (active) {
    editModeView = selected.value?.html ?? null
    lastOwnWrite = null
    editSaveState.value = 'idle'
    return
  }
  // Leaving edit mode: once its last saves land, show the document as saved.
  await editWrites
  if (lastOwnWrite !== null && !editModeActive.value) await refreshSelected()
}

async function saveSectionInEditMode(target: SectionTarget, anchor: string, body: SectionBody & { kind: 'html' }): Promise<boolean> {
  const base = editModeView ?? target.document.html ?? ''
  const result = await writeSection(target, anchor, body, base)
  if (!(await settleSectionWrite(target, body, result, true))) return false
  editModeView = spliceHtmlSection(base, anchor, body.sanitized)
  lastOwnWrite = result.raw ?? lastOwnWrite
  return true
}

async function saveHeaderInEditMode(field: 'name' | 'overview', text: string): Promise<boolean> {
  const target = captureSectionTarget()
  if (!target) return false
  const store = resolvePlanStore(target.path)
  const result = await store.writeMeta(
    { backend: plansTransport, workspacePath, relPath: target.path },
    fresh => ({ ...fresh, [field]: text }),
    content => syncHeaderMarkup(content, field, text),
  )
  if (!result.ok) {
    throw new Error(result.conflict ? t('pane.plans.section-write-busy') : result.error || t('pane.plans.review-save-failed'))
  }
  editModeView = syncHeaderMarkup(editModeView ?? target.document.html ?? '', field, text)
  lastOwnWrite = result.raw ?? lastOwnWrite
  const meta = result.raw ? store.parseMeta(result.raw) : null
  if (meta) applyToolbarMetadata(meta)
  return true
}

async function replaceSectionBody(anchor: string, body: string): Promise<void> {
  const target = captureSectionTarget()
  if (!target) return
  const store = resolvePlanStore(target.path)
  if (editModeActive.value && store.format === 'html') {
    const sanitized = { kind: 'html' as const, sanitized: sanitizePlanSectionHtml(body) }
    await queueEditWrite(() => saveSectionInEditMode(target, anchor, sanitized))
    return
  }
  const base = sectionEditBase ?? target.document.html ?? ''
  sectionEditBase = null
  try {
    // The carrier decides the payload kind: a markdown file stores the edited
    // text verbatim, only an HTML plan is sanitized as markup.
    const sectionBody: SectionBody = store.format === 'markdown'
      ? { kind: 'markdown', text: body }
      : { kind: 'html', sanitized: sanitizePlanSectionHtml(body) }
    await settleSectionWrite(target, sectionBody, await writeSection(target, anchor, sectionBody, base))
  } catch (cause) { toast(formatBackendError(cause), { type: 'error' }) }
}
async function deleteSection(anchor: string): Promise<void> {
  const target = captureSectionTarget()
  if (!target) return
  const accepted = await confirm(t('pane.plans.section-delete-confirm', { anchor }), {
    title: t('pane.plans.delete'), confirmText: t('pane.plans.delete'),
  })
  if (!accepted || !isActiveSectionTarget(target)) return
  try {
    await settleSectionWrite(target, undefined, await writeSection(target, anchor, undefined, target.document.html ?? ''))
  } catch (cause) { toast(formatBackendError(cause), { type: 'error' }) }
}
/** Keep the side the user did not choose as a version; false when it could
 *  not be (the dialog then says it exists only on screen). */
async function preserveDiscarded(target: SectionTarget, mine?: string): Promise<boolean> {
  try {
    return await preserveConflictSide({ backend: plansTransport, workspacePath, relPath: target.path }, mine)
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
    return false
  }
}
/** Write the user's version over the document shown in the conflict. */
async function keepMySection(): Promise<void> {
  const pending = pendingSectionConflict.value
  if (!pending || sectionConflictSaving.value) return
  sectionConflictSaving.value = true
  try {
    // The disk version is about to be overwritten: pin it as a version first.
    const kept = await preserveDiscarded(pending.target)
    const result = await writeSection(pending.target, pending.conflict.anchor, pending.body, pending.conflict.fresh)
    // Conflicting again replaces the dialog's content with the newer disk version.
    if (await settleSectionWrite(pending.target, pending.body, result, editModeActive.value)) {
      sectionConflictDialog.value?.showDiscarded('theirs', kept)
      // The edit-mode frame still shows the other sections as they were; show
      // the document as it is now (edit mode stays on).
      if (editModeActive.value) await refreshSelected()
    }
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  } finally {
    sectionConflictSaving.value = false
  }
}
/** Keep the disk version; the user's version is kept as a version of the
 *  plan, and stays in the dialog to copy. */
async function keepTheirSection(): Promise<void> {
  const pending = pendingSectionConflict.value
  if (!pending || sectionConflictSaving.value) return
  sectionConflictSaving.value = true
  const store = resolvePlanStore(pending.target.path)
  const mine = store.withSection(pending.conflict.fresh, pending.conflict.anchor, pending.body)
  const kept = await preserveDiscarded(pending.target, mine)
  sectionConflictSaving.value = false
  sectionConflictDialog.value?.showDiscarded('mine', kept)
  if (isActiveSectionTarget(pending.target) || editModeActive.value) await refreshSelected()
}

const onWindowMessage = createPlanRuntimeMessageHandler({
  getSourceWindow: () => planDocFrame.value?.contentWindow,
  getDocumentToken: () => selected.value?.rel_path === selectedPath.value ? currentDocumentToken.value ?? '' : '',
  getTodoIds: () => selected.value?.meta?.todos.map(todo => todo.id) ?? [],
  getAnchors: () => reviewNoteAnchors.value,
  onTodoClicked: (todoId, alt) => { void toggleDocTodo(todoId, alt) },
  onSectionComment: anchor => { if (!snapshotPreview.value && selected.value?.rel_path === selectedPath.value) reviewToolbar.value?.startNoteWithAnchor(anchor) },
  onScrollPos: y => { savedScrollY = y },
  onOpenCode: (path, line) => {
    if (selected.value?.rel_path !== selectedPath.value) return
    void callCapability('ui', 'openInEditor', { path, line }).catch(cause => toast(formatBackendError(cause), { type: 'error' }))
  },
  onSectionEdit: (anchor, html) => { if (!snapshotPreview.value) void replaceSectionBody(anchor, html) },
  onSectionDelete: anchor => { if (!snapshotPreview.value) void deleteSection(anchor) },
  onSectionEditing: active => {
    sectionEditing.value = active
    if (active) sectionEditBase = selected.value?.html ?? null
  },
  onHeaderEdit: (field, text) => {
    if (snapshotPreview.value || !editModeActive.value) return
    void queueEditWrite(() => saveHeaderInEditMode(field, text))
  },
  onEditModeChanged: active => { void onEditModeChanged(active) },
})

function planTitle(plan: PlanSummary): string {
  return plan.meta?.name || plan.name || plan.rel_path.split('/').pop() || t('pane.plans.v2.untitled')
}

function planStage(plan: PlanSummary): string | null {
  return plan.meta?.stage ?? plan.stage ?? null
}

function planStageLabel(value: string | null | undefined): string {
  if (!value) return t('pane.plans.v2.document')
  return t(`pane.plans.stage-${value}`)
}

function todoStatusLabel(value: string): string {
  return t(`pane.plans.status-${value}`)
}

function planProgress(plan: PlanSummary): { done: number; total: number } {
  const todos = plan.meta?.todos
  if (todos) {
    return {
      done: todos.filter((todo) => todo.status === 'done').length,
      total: todos.length,
    }
  }
  return {
    done: plan.todos?.by_status.done ?? 0,
    total: plan.todos?.total ?? 0,
  }
}

/** Unfinished todos this plan's meta marks as `owner: 'user'` — the listing
 *  answers "what is waiting on me" without opening every document. Shared with
 *  the retained HTML parser so both carriers count the same way. */
function planAwaiting(plan: PlanSummary): number {
  const todos = plan.meta?.todos
  if (todos) return htmlPlanAwaitingUser(todos as unknown as RetainedTodo[])
  // An entry too big for one list page arrives without meta; the backend's
  // todo summary still carries the count.
  return plan.todos?.awaiting_user ?? 0
}

function progressRatio(plan: PlanSummary): number {
  const { done, total } = planProgress(plan)
  return total > 0 ? Math.round((done / total) * 100) : 0
}

function isArchived(plan: PlanSummary): boolean {
  const archivedAt = plan.meta?.archivedAt ?? plan.archivedAt
  return typeof archivedAt === 'string' && archivedAt.length > 0
}

/** A plan rather than a plain document. The backend's kind decides: a plan
 *  whose entry was too big for one list page arrives without its meta. */
function isPlan(plan: PlanSummary | null | undefined): boolean {
  if (!plan) return false
  return plan.kind ? plan.kind === 'plan' : Boolean(plan.meta)
}

function matchesSearch(plan: PlanSummary): boolean {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return true
  return `${planTitle(plan)} ${plan.name} ${plan.rel_path} ${plan.meta?.overview ?? plan.overview ?? ''}`
    .toLowerCase()
    .includes(query)
}

function matchesStage(plan: PlanSummary): boolean {
  return stageFilter.value === 'all' || planStage(plan) === stageFilter.value
}

function comparePlans(left: PlanSummary, right: PlanSummary): number {
  let comparison: number
  if (sort.value === 'title') {
    comparison = planTitle(left).localeCompare(planTitle(right), undefined, { numeric: true })
  } else if (sort.value === 'progress') {
    const leftProgress = planProgress(left)
    const rightProgress = planProgress(right)
    const leftRatio = leftProgress.done / Math.max(leftProgress.total, 1)
    const rightRatio = rightProgress.done / Math.max(rightProgress.total, 1)
    comparison = rightRatio - leftRatio
  } else {
    comparison = (right.mtime ?? 0) - (left.mtime ?? 0)
  }
  return sortDirection.value === 'asc' ? -comparison : comparison
}

function sortedPlans(items: PlanSummary[]): PlanSummary[] {
  return [...items].sort(comparePlans)
}

const activePlans = computed(() =>
  sortedPlans(plans.value.filter((plan) => !isArchived(plan) && matchesStage(plan) && matchesSearch(plan))),
)

const archivedPlans = computed(() =>
  stageFilter.value === 'all'
    ? sortedPlans(plans.value.filter((plan) => isArchived(plan) && matchesSearch(plan)))
    : [],
)

const planGroups = computed<PlanGroup[]>(() => {
  if (groupMode.value === 'flat') {
    return activePlans.value.length
      ? [{
          key: 'all',
          label: isLeftContribution() ? t('pane.plans.section-all') : t('pane.plans.v2.all-documents'),
          plans: activePlans.value,
        }]
      : []
  }

  const groups: PlanGroup[] = []
  const documents = activePlans.value.filter((plan) => !planStage(plan))
  if (stageFilter.value === 'all' && documents.length) {
    groups.push({ key: 'documents', label: t('pane.plans.v2.documents'), plans: documents })
  }
  for (const value of PLAN_STAGES) {
    const groupPlans = activePlans.value.filter((plan) => planStage(plan) === value)
    if (groupPlans.length) groups.push({ key: value, label: planStageLabel(value), plans: groupPlans })
  }
  return groups
})

const pinnedAndRecent = computed(() => {
  const byPath = new Map(plans.value.map((plan) => [plan.rel_path, plan]))
  const inScope = (relPath: string): PlanSummary | null => {
    const plan = byPath.get(relPath)
    if (!plan || !matchesSearch(plan) || !matchesStage(plan)) return null
    return plan
  }
  const pinned = pinnedPaths.value.map(inScope).filter((plan): plan is PlanSummary => plan !== null)
  const recent = recentPaths.value
    .filter((relPath) => !pinnedPaths.value.includes(relPath))
    .map(inScope)
    .filter((plan): plan is PlanSummary => plan !== null)
  return [...pinned, ...recent]
})

const archivableDone = computed(() =>
  plans.value.filter((plan) => planStage(plan) === 'done' && !isArchived(plan) && isPlan(plan)),
)

const deletablePlans = computed(() =>
  plans.value.filter(
    (plan) => isPlan(plan) && !isArchived(plan) && ['done', 'abandoned'].includes(planStage(plan) ?? ''),
  ),
)

const selectedTodos = computed(() => selected.value?.meta?.todos ?? [])

const quickOpenRows = computed(() => {
  const query = quickOpenQuery.value.trim().toLowerCase()
  const source = query
    ? plans.value.filter((plan) => matchesQuickOpen(plan, query))
    : pinnedAndRecent.value
  return sortedPlans(source).slice(0, 8)
})

function matchesQuickOpen(plan: PlanSummary, query: string): boolean {
  return `${planTitle(plan)} ${plan.name} ${plan.rel_path} ${plan.meta?.overview ?? ''}`
    .toLowerCase()
    .includes(query)
}

function preferenceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return JSON.stringify(value)
  return undefined
}

async function loadPreference(key: string, fallback: string): Promise<string> {
  try {
    const stored = preferenceString(await getWorkspacePreference(key))
    if (stored !== undefined) return stored
    return fallback
  } catch {
    return fallback
  }
}

async function loadPreferences(): Promise<void> {
  const [filter, sortValue, direction, group, collapsed, recent, pinned, lastOpened] = await Promise.all([
    loadPreference('plans.filter', 'all'),
    loadPreference('plans.sort', 'updated'),
    loadPreference('plans.sortdir', 'desc'),
    loadPreference('plans.group', 'flat'),
    loadPreference('plans.collapsed', JSON.stringify(['archived'])),
    loadPreference('plans.recent', '[]'),
    loadPreference('plans.pinned', '[]'),
    loadPreference(LAST_OPENED_KEY, ''),
  ])
  lastOpenedPath.value = lastOpened
  if (filter === 'all' || PLAN_STAGES.includes(filter as PlanStage)) stageFilter.value = filter as StageFilter
  if (['updated', 'title', 'progress'].includes(sortValue)) sort.value = sortValue as SortMode
  if (direction === 'asc' || direction === 'desc') sortDirection.value = direction
  if (group === 'flat' || group === 'stage') groupMode.value = group
  try {
    const parsed = JSON.parse(collapsed) as unknown
    collapsedSections.value = new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : parsed === true
          ? ['all']
          : ['archived'],
    )
  } catch {
    collapsedSections.value = new Set(['archived'])
  }
  try {
    const parsed = JSON.parse(recent) as unknown
    if (Array.isArray(parsed)) recentPaths.value = parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    recentPaths.value = []
  }
  try {
    const parsed = JSON.parse(pinned) as unknown
    if (Array.isArray(parsed)) pinnedPaths.value = parsed.filter((value): value is string => typeof value === 'string')
  } catch {
    pinnedPaths.value = []
  }
}

async function persistPreference(key: string, value: string): Promise<void> {
  try {
    await setWorkspacePreference(key, value)
  } catch {
    // Preference persistence is best effort; document operations remain usable.
  }
}

function noteOpened(relPath: string): void {
  if (!relPath) return
  const next = [relPath, ...recentPaths.value.filter((path) => path !== relPath)].slice(0, 5)
  if (next.length === recentPaths.value.length && next.every((path, index) => path === recentPaths.value[index])) return
  recentPaths.value = next
  void persistPreference('plans.recent', JSON.stringify(recentPaths.value))
}

// The plan this workspace last had open. v1's PlanWindowApp persisted the same
// pointer (lastOpenedStorageKey) so that opening the window from the Window
// menu — with no rel_path in the entry query — came back to the document the
// user was in, rather than to an empty window.
const LAST_OPENED_KEY = 'plans.last-opened'
const lastOpenedPath = ref('')

function persistLastOpened(relPath: string): void {
  if (!relPath || lastOpenedPath.value === relPath) return
  lastOpenedPath.value = relPath
  void persistPreference(LAST_OPENED_KEY, relPath)
}

/**
 * Reopen the stored plan when the window was launched without one.
 *
 * A pointer at a plan that has since been deleted or renamed is simply not
 * opened: the list is the authority on what exists, and opening the window onto
 * a load error is worse than opening it empty.
 */
async function restoreLastOpened(): Promise<void> {
  if (isLeftContribution() || initialRelPath || initialFilePath || htmlPreviewTarget.value || selectedPath.value) return
  const stored = lastOpenedPath.value
  if (!stored || !plans.value.some((plan) => plan.rel_path === stored)) return
  await openPlan(stored)
}

function togglePin(relPath: string): void {
  pinnedPaths.value = pinnedPaths.value.includes(relPath)
    ? pinnedPaths.value.filter((path) => path !== relPath)
    : [...pinnedPaths.value, relPath]
  void persistPreference('plans.pinned', JSON.stringify(pinnedPaths.value))
}

function isPinned(relPath: string): boolean {
  return pinnedPaths.value.includes(relPath)
}

let activeReadGeneration = 0

function applySelected(document: PlanDocument, relPath: string): void {
  openDocumentChangedOnDisk.value = false
  htmlPreviewTarget.value = null
  previewAnchorCounts = countNoteAnchors(document.meta?.reviewNotes ?? [])
  selected.value = { ...document, rel_path: document.rel_path || relPath }
  selectedPath.value = relPath
  markdownRefresh.value++
  persistLastOpened(relPath)
}

function isHtmlPreviewPath(path: string): boolean {
  return path.toLowerCase().endsWith('.html') || path.toLowerCase().endsWith('.htm')
}

function workspaceRelativeHtmlTarget(target: Record<string, string>): { path: string; name: string } | null {
  const root = (target.workspace_path || workspacePath).replace(/\/+$/, '')
  const currentRoot = workspacePath.replace(/\/+$/, '')
  const filepath = target.filepath?.trim() ?? ''
  if (!root || root !== currentRoot || !filepath || !isHtmlPreviewPath(filepath)) return null
  const prefix = `${root}/`
  if (!filepath.startsWith(prefix)) return null
  const path = filepath.slice(prefix.length)
  if (!path || path === '.' || path.startsWith('/') || path === '../' || path.includes('/../')) return null
  return { path, name: path.split('/').pop() ?? path }
}

function openHtmlPreview(target: { path: string; name: string }): void {
  activeReadGeneration++
  reviewToolbar.value?.resetDocumentState()
  cancelRename()
  snapshotPreview.value = null
  savedScrollY = 0
  sectionEditing.value = false
  documentLoadError.value = null
  selected.value = null
  selectedPath.value = ''
  htmlPreviewTarget.value = target
}

function countNoteAnchors(notes: PlanMeta['reviewNotes']): Record<string, number> {
  const counts: Record<string, number> = Object.create(null)
  for (const note of notes) {
    if (!note.resolved && note.anchor) counts[note.anchor] = (counts[note.anchor] ?? 0) + 1
  }
  return counts
}

function applyToolbarMetadata(meta: RetainedMeta): void {
  if (!selected.value || selected.value.rel_path !== selectedPath.value) return
  for (const todo of meta.todos) {
    const previous = selected.value.meta?.todos.find(item => item.id === todo.id)
    if (previous && previous.status !== todo.status) {
      planDocFrame.value?.contentWindow?.postMessage({ type: 'todo-status-updated', documentToken: currentDocumentToken.value, todoId: todo.id, status: todo.status }, '*')
    }
  }
  selected.value.meta = meta
  const listed = plans.value.find(plan => plan.rel_path === selectedPath.value)
  if (listed) listed.meta = meta
}

async function readPlan(relPath: string): Promise<void> {
  const currentGeneration = ++activeReadGeneration
  // Close the Review Notes overlay before awaiting the next document. The
  // panel owns drafts and pending edits, so unmounting it here prevents Plan
  // A state (or a delayed Plan A request) from surfacing on Plan B.
  if (selected.value?.rel_path !== relPath) {
    reviewToolbar.value?.resetDocumentState()
    snapshotPreview.value = null
    savedScrollY = 0
    sectionEditing.value = false
    // Edit mode belongs to the document it was turned on for.
    editModeOnRender = false
    editModeActive.value = false
  }
  selectedPath.value = relPath
  try {
    const document = await readWholeDocument<PlanDocument & Record<string, unknown>>(
      plansBackend.call.bind(plansBackend) as never, 'plans.read', 'html', { rel_path: relPath },
    )
    if (currentGeneration !== activeReadGeneration || selectedPath.value !== relPath) return
    documentLoadError.value = null
    applySelected(document, relPath)
  } catch (cause) {
    if (currentGeneration !== activeReadGeneration || selectedPath.value !== relPath) return
    const listed = plans.value.find(plan => plan.rel_path === relPath)
    documentLoadError.value = {
      relPath,
      reason: [listed?.reason, cause instanceof Error ? cause.message : String(cause ?? '').trim()]
        .filter(Boolean).join(' — '),
    }
    selected.value = null
    snapshotPreview.value = null
    sectionEditing.value = false
  }
}

async function openInEditor(relPath: string): Promise<void> {
  noteOpened(relPath)
  try {
    const result = await callCapability('ui', 'openInEditor', { path: relPath }) as { opened?: boolean }
    if (result?.opened !== true) toast(t('pane.plans.v2.editor-open-failed'), { type: 'error' })
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  }
}

async function openPlan(relPath: string): Promise<void> {
  htmlPreviewTarget.value = null
  selectedPath.value = relPath
  if (isLeftContribution()) {
    noteOpened(relPath)
    try {
      const result = await callCapability('ui', 'openPlansWindow', { path: relPath }) as { opened?: boolean }
      if (result?.opened !== true) toast(t('pane.plans.v2.editor-open-failed'), { type: 'error' })
    } catch (cause) {
      toast(formatBackendError(cause), { type: 'error' })
    }
    return
  }
  try {
    await readPlan(relPath)
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  }
}

async function refreshSelected(): Promise<void> {
  if (!selectedPath.value) return
  try {
    await readPlan(selectedPath.value)
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  }
}

function schedulePlansReload(): void {
  if (plansChangedTimer !== null) clearTimeout(plansChangedTimer)
  plansChangedTimer = setTimeout(() => {
    plansChangedTimer = null
    void loadPlans(false).then(reloadOpenDocumentIfChanged)
  }, PLANS_CHANGED_DEBOUNCE_MS)
}

// Set when the open document changed on disk while the user was editing it;
// the document reloads once the edit (or a pending conflict) ends.
const openDocumentChangedOnDisk = ref(false)

function isEditingOpenDocument(): boolean {
  return sectionEditing.value || pendingSectionConflict.value !== null ||
    markdownBody.value?.isEditing() === true || markdownBody.value?.hasPendingConflict() === true
}

/** Reload the open document when the listing shows a newer copy on disk:
 *  in place when nobody is editing it, otherwise after the edit ends. */
async function reloadOpenDocumentIfChanged(): Promise<void> {
  const open = selected.value
  if (!open || open.rel_path !== selectedPath.value || typeof open.mtime !== 'number') return
  const listed = plans.value.find(plan => plan.rel_path === open.rel_path)
  if (typeof listed?.mtime !== 'number' || listed.mtime === open.mtime) return
  if (editModeActive.value && lastOwnWrite !== null) {
    // Edit mode does not re-render after its own saves; a newer copy that is
    // exactly what it wrote last is not someone else's change.
    const ownWrite = lastOwnWrite
    const disk = await plansTransport.send<{ ok: boolean; content?: string }>('fs.read_file', {
      workspace_path: workspacePath, rel_path: open.rel_path,
    }).catch(() => null)
    if (disk?.payload?.ok && disk.payload.content === ownWrite) {
      open.mtime = listed.mtime
      return
    }
  }
  if (isEditingOpenDocument()) {
    openDocumentChangedOnDisk.value = true
    return
  }
  await refreshSelected()
}

watch(() => isEditingOpenDocument(), (editing) => {
  if (!editing && openDocumentChangedOnDisk.value) void refreshSelected()
})

async function loadPlans(openSelected = true): Promise<void> {
  if (!workspacePath) {
    error.value = t('pane.plans.v2.workspace-required')
    return
  }
  const isFirstLoad = plans.value.length === 0
  loading.value = isFirstLoad
  error.value = ''
  try {
    const result = await listAllPlans(plansBackend.call.bind(plansBackend) as never) as PlanSummary[]
    plans.value = Array.isArray(result) ? result : []
    if (openSelected && selectedPath.value && plans.value.some((plan) => plan.rel_path === selectedPath.value)) {
      if (!selected.value || selected.value.rel_path !== selectedPath.value) {
        await openPlan(selectedPath.value)
      }
    }
  } catch (cause) {
    error.value = formatBackendError(cause)
  } finally {
    loading.value = false
  }
}



interface ReviewTarget {
  path: string
  generation: number
  document: PlanDocument
}

function captureReviewTarget(): ReviewTarget | null {
  if (!selectedPath.value || !selected.value?.meta || selected.value.rel_path !== selectedPath.value) return null
  return { path: selectedPath.value, generation: activeReadGeneration, document: selected.value }
}

function isActiveReviewTarget(target: ReviewTarget): boolean {
  return selectedPath.value === target.path && activeReadGeneration === target.generation
}

async function addReviewNote(text: string, anchor = ''): Promise<boolean> {
  const target = captureReviewTarget()
  if (!target || !text.trim()) return false
  try {
    const note = await plansBackend.call<PlanMeta['reviewNotes'][number]>('plans.review_note_add', {
      rel_path: target.path,
      text: text.trim(),
      anchor,
    })
    if (!isActiveReviewTarget(target) || !target.document.meta) return false
    target.document.meta.reviewNotes.push(note)
    const listed = plans.value.find((plan) => plan.rel_path === target.path)?.meta
    if (listed && listed !== target.document.meta) listed.reviewNotes.push(note)
    return true
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
    return false
  }
}

async function editReviewNote(id: string, text: string): Promise<boolean> {
  const target = captureReviewTarget()
  if (!target) return false
  try {
    const note = await plansBackend.call<PlanMeta['reviewNotes'][number]>('plans.review_note_edit', { rel_path: target.path, note_id: id, text })
    if (!isActiveReviewTarget(target)) return false
    const current = target.document.meta?.reviewNotes.find((item) => item.id === id)
    if (current) Object.assign(current, note)
    return true
  } catch (cause) { toast(formatBackendError(cause), { type: 'error' }); return false }
}

async function resolveReviewNote(id: string): Promise<boolean> {
  const target = captureReviewTarget()
  if (!target) return false
  try {
    const note = await plansBackend.call<PlanMeta['reviewNotes'][number]>('plans.review_note_resolve', { rel_path: target.path, note_id: id })
    if (!isActiveReviewTarget(target)) return false
    const current = target.document.meta?.reviewNotes.find((item) => item.id === id)
    if (current) Object.assign(current, note)
    return true
  } catch (cause) { toast(formatBackendError(cause), { type: 'error' }); return false }
}

async function deleteReviewNote(id: string): Promise<boolean> {
  const target = captureReviewTarget()
  if (!target) return false
  try {
    await plansBackend.call('plans.review_note_delete', { rel_path: target.path, note_id: id })
    if (!isActiveReviewTarget(target) || !target.document.meta) return false
    target.document.meta.reviewNotes = target.document.meta.reviewNotes.filter((note) => note.id !== id)
    const listed = plans.value.find((plan) => plan.rel_path === target.path)?.meta
    if (listed && listed !== target.document.meta) listed.reviewNotes = listed.reviewNotes.filter((note) => note.id !== id)
    return true
  } catch (cause) { toast(formatBackendError(cause), { type: 'error' }); return false }
}


async function archiveAllDone(): Promise<void> {
  if (!archivableDone.value.length) return
  const ok = await confirm(t('pane.plans.archive-all-confirm', { count: archivableDone.value.length }), {
    title: t('pane.plans.archive-all-done'),
    confirmText: t('pane.plans.archive-all-done'),
  })
  if (!ok) return
  busy.value = true
  try {
    for (const plan of archivableDone.value) {
      await plansBackend.call('plans.update_archive', {
        rel_path: plan.rel_path,
        archived_at: new Date().toISOString(),
      })
    }
    await loadPlans(false)
    await refreshSelected()
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
    // Earlier items already took effect; show what is really left.
    await loadPlans(false)
  } finally {
    busy.value = false
  }
}

async function deletePath(relPath: string): Promise<void> {
  const plan = plans.value.find((item) => item.rel_path === relPath)
  if (!plan) return
  const ok = await confirm(t('pane.plans.delete-confirm', { name: planTitle(plan) }), {
    title: t('pane.plans.menu-delete'),
    confirmText: t('pane.plans.menu-delete'),
  })
  if (!ok) return
  busy.value = true
  try {
    await plansBackend.call('plans.delete', { rel_path: relPath })
    recentPaths.value = recentPaths.value.filter((path) => path !== relPath)
    pinnedPaths.value = pinnedPaths.value.filter((path) => path !== relPath)
    void persistPreference('plans.recent', JSON.stringify(recentPaths.value))
    void persistPreference('plans.pinned', JSON.stringify(pinnedPaths.value))
    if (selectedPath.value === relPath) {
      selectedPath.value = ''
      selected.value = null
    }
    await loadPlans(false)
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

async function deleteCompleted(): Promise<void> {
  if (!deletablePlans.value.length) return
  const ok = await confirm(t('pane.plans.delete-completed-confirm', { count: deletablePlans.value.length }), {
    title: t('pane.plans.delete-completed-title'),
    confirmText: t('pane.plans.menu-delete'),
  })
  if (!ok) return
  busy.value = true
  try {
    for (const plan of deletablePlans.value) {
      await plansBackend.call('plans.delete', { rel_path: plan.rel_path })
    }
    await loadPlans(false)
    if (selectedPath.value && !plans.value.some((plan) => plan.rel_path === selectedPath.value)) {
      selectedPath.value = ''
      selected.value = null
    }
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
    // Earlier items already took effect; show what is really left.
    await loadPlans(false)
  } finally {
    busy.value = false
  }
}

/** Promote one plain document to a plan. Addressed by row so the list's own
 *  context menu can invoke it without opening the document first. */
async function promotePath(relPath: string): Promise<void> {
  const plan = plans.value.find((item) => item.rel_path === relPath)
  if (!relPath || isPlan(plan)) return
  busy.value = true
  try {
    await plansBackend.call('plans.promote', { rel_path: relPath })
    await loadPlans(false)
    await refreshSelected()
    toast(t('pane.plans.upgrade-success'), { type: 'success' })
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

/** Snapshot one plan into the git-tracked `.plans/` directory. Same semantics
 *  as the review toolbar's overflow entry, addressed by row. */
async function shareToGitPath(relPath: string): Promise<void> {
  busy.value = true
  try {
    const result = await sharePlanToGit(plansTransport, workspacePath, relPath)
    if (result.ok) toast(t('pane.plans.share-git-success'), { type: 'success' })
    else toast(result.error ?? t('pane.plans.share-git-failed'), { type: 'error' })
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

/** Archive / unarchive one row. Unarchiving is reversible, so it skips the
 *  confirmation the way the legacy pane did. */
async function toggleArchivePath(relPath: string): Promise<void> {
  const plan = plans.value.find((item) => item.rel_path === relPath)
  if (!plan || !isPlan(plan)) return
  const archiving = !isArchived(plan)
  if (archiving) {
    const ok = await confirm(t('pane.plans.archive-confirm', { name: planTitle(plan) }), {
      title: t('pane.plans.archive'),
      confirmText: t('pane.plans.archive'),
    })
    if (!ok) return
  }
  busy.value = true
  try {
    await plansBackend.call('plans.update_archive', {
      rel_path: relPath,
      archived_at: archiving ? new Date().toISOString() : null,
    })
    await loadPlans(false)
    await refreshSelected()
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

function isHtmlPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith('.html')
}

function isMarkdownPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith('.md')
}


// Drag contract with the Host's CLI pane drop handler (TerminalPane): the
// terminal tells a plan drag from a pane drag by MIME type, then pastes the
// plan's workspace-relative path into the target CLI prompt. The plugin cannot
// import the Host's planDrag module, so the wire shape is restated here; it
// must stay byte-compatible with `parsePlanRefPayload`.
const PLAN_REF_MIME = 'application/x-plan-ref'

function onPlanRowDragStart(event: DragEvent, plan: PlanSummary): void {
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'copy'
  const overview = plan.meta?.overview || plan.overview || undefined
  event.dataTransfer.setData(
    PLAN_REF_MIME,
    JSON.stringify({ relPath: plan.rel_path, name: planTitle(plan), overview }),
  )
}

async function copyPath(relPath: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(relPath)
    toast(t('pane.plans.copy-path-success'), { type: 'success' })
  } catch {
    toast(relPath, { type: 'error' })
  }
}

function toggleSection(key: string): void {
  const next = new Set(collapsedSections.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedSections.value = next
  void persistPreference('plans.collapsed', JSON.stringify([...next]))
}

function isSectionCollapsed(key: string): boolean {
  return collapsedSections.value.has(key)
}

function toggleSortDirection(): void {
  sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
  void persistPreference('plans.sortdir', sortDirection.value)
}

function changeSort(): void {
  sortDirection.value = sort.value === 'title' ? 'asc' : 'desc'
  void persistPreference('plans.sort', sort.value)
  void persistPreference('plans.sortdir', sortDirection.value)
}

function openContextMenu(event: MouseEvent, relPath: string): void {
  contextMenu.value = {
    x: Math.min(event.clientX, Math.max(8, window.innerWidth - 220)),
    y: Math.min(event.clientY, Math.max(8, window.innerHeight - 180)),
    relPath,
  }
}

function closeContextMenu(): void {
  contextMenu.value = null
}

/** The listed row the open context menu points at, so the menu can branch on
 *  plan meta (archive state, plan vs plain document) without a second lookup. */
const contextMenuPlan = computed<PlanSummary | null>(() => {
  const relPath = contextMenu.value?.relPath
  if (!relPath) return null
  return plans.value.find((plan) => plan.rel_path === relPath) ?? null
})

function closeTransientMenus(): void {
  closeContextMenu()
}

function openQuickOpen(): void {
  quickOpenActive.value = true
  quickOpenQuery.value = ''
  quickOpenIndex.value = 0
  void nextTick(() => quickOpenInput.value?.focus())
}

function closeQuickOpen(): void {
  quickOpenActive.value = false
  quickOpenQuery.value = ''
}

function moveQuickOpen(delta: number): void {
  const count = quickOpenRows.value.length
  if (count) quickOpenIndex.value = (quickOpenIndex.value + delta + count) % count
}

function confirmQuickOpen(): void {
  const plan = quickOpenRows.value[quickOpenIndex.value]
  if (!plan) return
  closeQuickOpen()
  void openPlan(plan.rel_path)
}

/**
 * Peel one layer of open surface state, topmost first; returns whether
 * anything was actually closed. Escape walks this from both key routes — the
 * Host `closeModal` command in the window, the local listener in the embedded
 * left contribution — so the priority order lives in one place.
 */
function peelOverlay(): boolean {
  // A section conflict holds text that exists nowhere else: only its own
  // buttons may close it, never a stray Escape.
  if (pendingSectionConflict.value || markdownBody.value?.hasPendingConflict()) return true
  if (sectionEditing.value) {
    planDocFrame.value?.contentWindow?.postMessage({ type: 'cancel-edit' }, '*')
    sectionEditing.value = false
    return true
  }
  if (markdownBody.value?.isEditing()) {
    markdownBody.value.cancelEdit()
    return true
  }
  if (quickOpenActive.value) {
    closeQuickOpen()
    return true
  }
  if (reviewToolbar.value?.closeActiveOverlay()) return true
  if (snapshotPreview.value) {
    snapshotPreview.value = null
    return true
  }
  return false
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    openQuickOpen()
  } else if (event.key === 'Escape' && peelOverlay()) {
    event.preventDefault()
  }
}

function scrollToAnchor(anchor: string): void {
  if (markdownBody.value) {
    markdownBody.value.scrollToAnchor(anchor)
    return
  }
  planDocFrame.value?.contentWindow?.postMessage({ type: 'scroll-to', anchor }, '*')
}

async function previewSnapshot(snapshot: { relPath: string; label: string }): Promise<void> {
  const path = selectedPath.value
  const generation = activeReadGeneration
  try {
    const response = await plansTransport.send<{ ok: boolean; content?: string; error?: string }>('fs.read_file', { rel_path: snapshot.relPath })
    if (selectedPath.value !== path || activeReadGeneration !== generation) return
    if (!response.payload.ok || response.payload.content === undefined) throw new Error(response.payload.error || t('pane.plans.history-diff-failed'))
    snapshotPreview.value = {
      ...snapshot,
      html: response.payload.content,
      anchors: countNoteAnchors(parseHtmlPlanMeta(response.payload.content)?.meta.reviewNotes ?? []),
    }
  } catch (cause) { toast(formatBackendError(cause), { type: 'error' }) }
}

async function onToolbarDeleted(path: string): Promise<void> {
  if (selected.value?.rel_path === path) {
    selected.value = null
    selectedPath.value = ''
    snapshotPreview.value = null
  }
  await loadPlans(false)
}

function receiveTarget(target: Record<string, string>): void {
  const htmlTarget = workspaceRelativeHtmlTarget(target)
  if (htmlTarget) {
    openHtmlPreview(htmlTarget)
    return
  }
  if (target.rel_path) void openPlan(toPlanRelPath(target.rel_path))
}

async function beginRename(): Promise<void> {
  closeContextMenu()
  if (!selectedPath.value || !isHtmlPath(selectedPath.value)) return
  renameTarget.value = selectedPath.value
  renameValue.value = selectedPath.value.split('/').pop() ?? ''
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

function cancelRename(): void {
  renameTarget.value = null
  renameValue.value = ''
}

async function submitRename(): Promise<void> {
  const target = renameTarget.value
  if (!target) return
  const nextName = renameValue.value.trim()
  cancelRename()
  if (!nextName || nextName === target.split('/').pop()) return
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*_[0-9a-f]{6}\.html$/.test(nextName)) {
    toast(t('pane.plans.rename-invalid'), { type: 'error' })
    return
  }
  busy.value = true
  try {
    const result = await plansBackend.call<{ to: string }>('plans.rename', {
      from: target,
      to: `${target.includes('/') ? target.slice(0, target.lastIndexOf('/') + 1) : '.agent-team/plans/'}${nextName}`,
    })
    if (selectedPath.value === target) selectedPath.value = result.to
    await loadPlans(false)
    await refreshSelected()
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  } finally {
    busy.value = false
  }
}

watch(quickOpenQuery, () => {
  quickOpenIndex.value = 0
})

// The Plans window joins the Host's shared rule table, so the user's shortcut
// set reaches it the way it reaches every other window — ⌘P quick open, ⌘⇧W
// close, ⇧⌘R reload and ESC/⌘W close-modal all resolve through the same
// commands v1's PlanWindowApp registered. The embedded left contribution is a
// panel inside the Host shell and keeps its own local listener instead: a
// `planWindow` context or a closeWindow command would be wrong there.
const hostKeybindings = !isLeftContribution()
if (hostKeybindings) {
  installPlansKeybindings({
    quickOpen: openQuickOpen,
    closeModal: () => {
      // An application dialog owns Escape itself (NotificationHost cancels on
      // it); declining leaves the event alone so it reaches that handler.
      if (dialog.value) return false
      if (peelOverlay()) return undefined
      window.close()
      return undefined
    },
  })
}

onMounted(() => {
  // The dedicated Plans window's own webContents is blank; its title is
  // mirrored from this document's (frontendPluginManager `mirrorTitle`), so
  // without this the window stayed on the static 'Plans' and never said which
  // project it belonged to. Only the window surface has a title to set — the
  // embedded left contribution shares the main window's.
  if (!isLeftContribution() && workspaceTitleName) {
    document.title = `${workspaceTitleName} — Plans`
  }
  loadTheme()
  const initialHtmlTarget = workspaceRelativeHtmlTarget({ workspace_path: workspacePath, filepath: initialFilePath })
  if (initialHtmlTarget) openHtmlPreview(initialHtmlTarget)
  if (!hostKeybindings) window.addEventListener('keydown', onKeydown)
  window.addEventListener('click', closeTransientMenus)
  window.addEventListener('message', onWindowMessage)
  try {
    plansSubscription = plansBackend.subscribe('plans.changed', schedulePlansReload)
    void plansSubscription.ready.catch((cause: unknown) => toast(formatBackendError(cause), { type: 'error' }))
    void plansSubscription.settled.catch((cause: unknown) => {
      const code = typeof cause === 'object' && cause !== null && 'code' in cause
        ? (cause as { code?: unknown }).code
        : undefined
      if (code !== 'USER_CANCELLED' && code !== 'PLUGIN_STOPPING') toast(formatBackendError(cause), { type: 'error' })
    })
  } catch (cause) {
    toast(formatBackendError(cause), { type: 'error' })
  }
  const targetSubscription = plansViewRuntime.onOpenTarget(receiveTarget)
  stopTarget = () => targetSubscription.dispose()
  void Promise.all([loadPreferences(), loadPlans()]).then(restoreLastOpened)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('click', closeTransientMenus)
  window.removeEventListener('message', onWindowMessage)
  plansSubscription?.dispose()
  plansSubscription = null
  if (plansChangedTimer !== null) clearTimeout(plansChangedTimer)
  plansChangedTimer = null
  stopTarget?.()
  aiCliController.dispose()
})
</script>

<template>
  <NotificationHost />
  <div
    :class="isLeftContribution()
      ? ['plans-surface', 'plans-left-surface', 'plans-layout', 'is-left-contribution']
      : ['plan-window']"
  >
      <aside
        v-if="!sidebarCollapsed"
        class="plans-sidebar"
        :class="{ 'plan-window-side': !isLeftContribution() }"
      >
      <div class="plans-pane">
        <header class="plans-head">
          <div>
            <div class="plans-title">{{ t('pane.plans.title') }}</div>
          </div>
          <button
            class="plans-icon-btn"
            type="button"
            :title="t('pane.plans.refresh')"
            :aria-label="t('pane.plans.refresh')"
            @click="void loadPlans(false)"
          >↻</button>
          <button
            v-if="!isLeftContribution()"
            class="plans-icon-btn plans-sidebar-toggle"
            type="button"
            :title="t('pane.plans.v2.hide-list')"
            :aria-label="t('pane.plans.v2.hide-list')"
            @click="sidebarCollapsed = true"
          >⟨</button>
        </header>

        <div class="plans-toolbar">
          <div class="plans-search">
            <input
              v-model="searchQuery"
              class="plans-search-input"
              type="search"
              :placeholder="t('pane.plans.search-placeholder')"
              :aria-label="t('pane.plans.search-placeholder')"
            />
            <button
              v-if="searchQuery"
              class="plans-search-clear"
              type="button"
              :title="t('pane.plans.search-clear')"
              :aria-label="t('pane.plans.search-clear')"
              @click="searchQuery = ''"
            >✕</button>
          </div>
          <div class="plans-toolbar-row">
            <select
              v-model="stageFilter"
              class="plans-select plans-stage-select"
              :title="t('pane.plans.filter-stage')"
              :aria-label="t('pane.plans.filter-stage')"
              @change="void persistPreference('plans.filter', stageFilter)"
            >
              <option value="all">{{ t('pane.plans.filter-all-stages') }}</option>
              <option v-for="value in PLAN_STAGES" :key="value" :value="value">{{ planStageLabel(value) }}</option>
            </select>
            <select
              v-model="sort"
              class="plans-select plans-sort-select"
              :title="t('pane.plans.sort-by')"
              :aria-label="t('pane.plans.sort-by')"
              @change="changeSort"
            >
              <option value="updated">{{ t('pane.plans.sort-updated') }}</option>
              <option value="title">{{ t('pane.plans.sort-title') }}</option>
              <option value="progress">{{ t('pane.plans.sort-progress') }}</option>
            </select>
            <button
              class="plans-toggle-btn plans-sort-dir"
              type="button"
              :title="sortDirection === 'asc' ? t('pane.plans.sort-asc') : t('pane.plans.sort-desc')"
              :aria-label="sortDirection === 'asc' ? t('pane.plans.sort-asc') : t('pane.plans.sort-desc')"
              @click="toggleSortDirection"
            >
              {{ sortDirection === 'asc' ? '↑' : '↓' }}
            </button>
            <button
              class="plans-toggle-btn plans-group-toggle"
              :class="{ 'plans-toggle-btn--on': groupMode === 'stage' }"
              type="button"
              :aria-pressed="groupMode === 'stage'"
              :title="groupMode === 'stage' ? t('pane.plans.group-stage') : t('pane.plans.group-flat')"
              :aria-label="groupMode === 'stage' ? t('pane.plans.group-stage') : t('pane.plans.group-flat')"
              @click="groupMode = groupMode === 'flat' ? 'stage' : 'flat'; void persistPreference('plans.group', groupMode)"
            >
              ☰
            </button>
          </div>
        </div>

        <div class="plans-sidebar-list">
          <p v-if="loading" class="muted plans-muted">{{ t('pane.plans.file-loading') }}</p>
          <p v-else-if="error" class="error plans-error">{{ error }}</p>
          <div v-else-if="searchQuery && !planGroups.length && !pinnedAndRecent.length && !archivedPlans.length" class="plans-empty">
            {{ t('pane.plans.search-no-results') }}
          </div>

          <section v-if="pinnedAndRecent.length" class="plan-section plans-section">
            <div
              class="plans-section-head"
              role="button"
              tabindex="0"
              @click="toggleSection('recent')"
              @keydown.enter.prevent="toggleSection('recent')"
              @keydown.space.prevent="toggleSection('recent')"
            >
              <span class="plans-section-title">
                <span class="plans-section-chevron" :class="{ collapsed: isSectionCollapsed('recent') }">▾</span>
                {{ t('pane.plans.section-recent') }}
              </span>
              <span>{{ pinnedAndRecent.length }}</span>
            </div>
            <template v-if="!isSectionCollapsed('recent')">
              <div
                v-for="plan in pinnedAndRecent"
                :key="`recent:${plan.rel_path}`"
                class="plan-row plan-row--compact"
                :class="{ selected: selectedPath === plan.rel_path }"
                role="button"
                tabindex="0"
                draggable="true"
                @dragstart="onPlanRowDragStart($event, plan)"
                @click="void openPlan(plan.rel_path)"
                @keydown.enter.prevent="void openPlan(plan.rel_path)"
                @contextmenu.prevent="openContextMenu($event, plan.rel_path)"
              >
                <span class="plan-row-title plan-row-name" v-truncate>{{ planTitle(plan) }}</span>
                <span v-if="planStage(plan)" class="plan-chip" :class="`plan-chip--stage-${planStage(plan)}`">
                  {{ planStageLabel(planStage(plan)) }}
                </span>
                <span v-else class="plan-chip">{{ t('pane.plans.v2.document') }}</span>
                <span
                  v-if="planAwaiting(plan) > 0"
                  class="plan-chip plan-chip--awaiting"
                  :title="t('pane.plans.awaiting-you-title')"
                >{{ t('pane.plans.awaiting-you', { count: planAwaiting(plan) }) }}</span>
                <button
                  type="button"
                  class="plan-row-pin"
                  :class="{ 'plan-row-pin--on': isPinned(plan.rel_path) }"
                  :aria-pressed="isPinned(plan.rel_path)"
                  :title="isPinned(plan.rel_path) ? t('pane.plans.unpin') : t('pane.plans.pin')"
                  @click.stop="togglePin(plan.rel_path)"
                >
                  📌
                </button>
              </div>
            </template>
          </section>

          <section v-for="group in planGroups" :key="group.key" class="plan-section plans-section">
            <div
              class="plans-section-head"
              role="button"
              tabindex="0"
              @click="toggleSection(group.key)"
              @keydown.enter.prevent="toggleSection(group.key)"
              @keydown.space.prevent="toggleSection(group.key)"
            >
              <span class="plans-section-title">
                <span class="plans-section-chevron" :class="{ collapsed: isSectionCollapsed(group.key) }">▾</span>
                {{ group.label }}
              </span>
              <span>{{ group.plans.length }}</span>
            </div>
            <template v-if="!isSectionCollapsed(group.key)">
              <button
                v-for="plan in group.plans"
                :key="plan.rel_path"
                type="button"
                class="plan-row"
                :class="{ selected: selectedPath === plan.rel_path, 'plan-row--done': planStage(plan) === 'done' }"
                draggable="true"
                @dragstart="onPlanRowDragStart($event, plan)"
                @click="void openPlan(plan.rel_path)"
                @contextmenu.prevent="openContextMenu($event, plan.rel_path)"
              >
                <span class="plan-row-title plan-row-name" v-truncate>{{ planTitle(plan) }}</span>
                <span v-if="plan.meta?.overview || plan.overview" class="plan-row-overview" v-truncate>
                  {{ plan.meta?.overview || plan.overview }}
                </span>
                <span class="plan-row-path" v-truncate>{{ plan.rel_path }}</span>
                <span class="plan-row-meta">
                  <span class="plan-row-progress">
                    <span class="plan-progress-bar" :class="`plan-progress-bar--${planStage(plan) ?? 'draft'}`">
                      <span class="plan-progress-fill" :style="{ width: `${progressRatio(plan)}%` }" />
                    </span>
                    <span>{{ t('pane.plans.progress-done', { done: planProgress(plan).done, total: planProgress(plan).total }) }}</span>
                  </span>
                  <span v-if="planStage(plan)" class="plan-chip" :class="`plan-chip--stage-${planStage(plan)}`">
                    {{ planStageLabel(planStage(plan)) }}
                  </span>
                  <span v-else class="plan-chip">{{ t('pane.plans.v2.document') }}</span>
                  <span
                    v-if="plan.reason"
                    class="plan-chip plan-chip--problem"
                    :title="`${t('pane.plans.v2.needs-attention-title')} ${plan.reason}`"
                  >{{ t('pane.plans.v2.needs-attention') }}</span>
                  <span
                    v-if="planAwaiting(plan) > 0"
                    class="plan-chip plan-chip--awaiting"
                    :title="t('pane.plans.awaiting-you-title')"
                  >{{ t('pane.plans.awaiting-you', { count: planAwaiting(plan) }) }}</span>
                  <span class="plan-row-type">
                    {{ isHtmlPath(plan.rel_path) ? t('pane.plans.v2.html') : t('pane.plans.v2.markdown') }}
                  </span>
                </span>
                <span
                  role="button"
                  tabindex="0"
                  class="plan-row-pin"
                  :class="{ 'plan-row-pin--on': isPinned(plan.rel_path) }"
                  :aria-pressed="isPinned(plan.rel_path)"
                  :title="isPinned(plan.rel_path) ? t('pane.plans.unpin') : t('pane.plans.pin')"
                  @click.stop="togglePin(plan.rel_path)"
                  @keydown.enter.stop.prevent="togglePin(plan.rel_path)"
                >
                  📌
                </span>
                <span
                  class="plan-row-delete"
                  role="button"
                  tabindex="0"
                  :title="t('action.delete')"
                  :aria-label="t('action.delete')"
                  @click.stop="void deletePath(plan.rel_path)"
                  @keydown.enter.stop.prevent="void deletePath(plan.rel_path)"
                >✕</span>
              </button>
            </template>
          </section>

          <section v-if="archivedPlans.length" class="plan-section plans-section">
            <div
              class="plans-section-head"
              role="button"
              tabindex="0"
              @click="toggleSection('archived')"
              @keydown.enter.prevent="toggleSection('archived')"
              @keydown.space.prevent="toggleSection('archived')"
            >
              <span class="plans-section-title">
                <span class="plans-section-chevron" :class="{ collapsed: isSectionCollapsed('archived') }">▾</span>
                {{ t('pane.plans.archived') }}
              </span>
              <span>{{ archivedPlans.length }}</span>
            </div>
            <template v-if="!isSectionCollapsed('archived')">
              <button
                v-for="plan in archivedPlans"
                :key="plan.rel_path"
                type="button"
                class="plan-row plan-row--done"
                :class="{ selected: selectedPath === plan.rel_path }"
                draggable="true"
                @dragstart="onPlanRowDragStart($event, plan)"
                @click="void openPlan(plan.rel_path)"
                @contextmenu.prevent="openContextMenu($event, plan.rel_path)"
              >
                <span class="plan-row-title plan-row-name" v-truncate>{{ planTitle(plan) }}</span>
                <span v-if="plan.meta?.overview || plan.overview" class="plan-row-overview" v-truncate>
                  {{ plan.meta?.overview || plan.overview }}
                </span>
                <span class="plan-row-path" v-truncate>{{ plan.rel_path }}</span>
                <span class="plan-row-meta">
                  <span v-if="planStage(plan)" class="plan-chip" :class="`plan-chip--stage-${planStage(plan)}`">
                    {{ planStageLabel(planStage(plan)) }}
                  </span>
                  <span
                    v-if="planAwaiting(plan) > 0"
                    class="plan-chip plan-chip--awaiting"
                    :title="t('pane.plans.awaiting-you-title')"
                  >{{ t('pane.plans.awaiting-you', { count: planAwaiting(plan) }) }}</span>
                  <span class="plan-chip archived">{{ t('pane.plans.archived') }}</span>
                </span>
                <span
                  class="plan-row-delete"
                  role="button"
                  tabindex="0"
                  :title="t('action.delete')"
                  :aria-label="t('action.delete')"
                  @click.stop="void deletePath(plan.rel_path)"
                  @keydown.enter.stop.prevent="void deletePath(plan.rel_path)"
                >✕</span>
              </button>
            </template>
          </section>

          <p v-if="!loading && !error && !planGroups.length && !archivedPlans.length" class="muted plans-muted">{{ t('pane.plans.v2.no-documents') }}</p>
          <section v-if="archivableDone.length || deletablePlans.length" class="completed-actions">
            <button type="button" :disabled="busy || !archivableDone.length" @click="void archiveAllDone()">{{ t('pane.plans.archive-all-done') }}</button>
            <button type="button" :disabled="busy || !deletablePlans.length" @click="void deleteCompleted()">{{ t('pane.plans.delete-all') }}</button>
          </section>
        </div>

      </div>
      </aside>

      <button
        v-if="!isLeftContribution() && sidebarCollapsed"
        class="plans-icon-btn plans-sidebar-toggle plans-sidebar-toggle--show"
        type="button"
        :title="t('pane.plans.v2.show-list')"
        :aria-label="t('pane.plans.v2.show-list')"
        @click="sidebarCollapsed = false"
      >⟩</button>

      <main v-if="!isLeftContribution()" class="plan-window-main plan-content">
        <HtmlFilePreview
          v-if="htmlPreviewTarget"
          :path="htmlPreviewTarget.path"
          :name="htmlPreviewTarget.name"
        />
        <div v-else-if="documentLoadError" class="pdp-error">
          <span>{{ t('pane.plans.doc-load-failed') }}</span>
          <span v-if="documentLoadError.reason" class="pdp-error-reason">{{ documentLoadError.reason }}</span>
          <span class="pdp-error-path">{{ workspacePath }} › {{ documentLoadError.relPath }}</span>
        </div>
        <div v-else-if="selected" class="plan-window-doc selected-document" :aria-label="selected.meta?.name ?? selected.rel_path">
          <PlanReviewToolbar
            v-if="selected.meta && !snapshotPreview"
            ref="reviewToolbar"
            :key="selected.rel_path"
            :workspace-path="workspacePath"
            :rel-path="selected.rel_path"
            :backend="plansTransport"
            :store="resolvePlanStore(selected.rel_path)"
            :notes="selected.meta.reviewNotes as ReviewNote[]"
            :todos="selected.meta.todos as RetainedTodo[]"
            :note-actions="{ add: addReviewNote, edit: editReviewNote, resolve: resolveReviewNote, remove: deleteReviewNote }"
            @updated="void refreshSelected()"
            @metadata="applyToolbarMetadata"
            @scroll-to-anchor="scrollToAnchor"
            @preview-snapshot="void previewSnapshot($event)"
            @deleted="void onToolbarDeleted($event)"
          >
            <template v-if="shareAvailable" #actions>
              <PlanShareButton :rel-path="selected.rel_path" :before-open="refreshShareCaps" />
            </template>
          </PlanReviewToolbar>
          <div v-if="snapshotPreview" class="plan-snapshot-banner">
            <span class="plan-snapshot-label">{{ snapshotPreview.label }}</span>
            <span class="plan-snapshot-note">{{ t('pane.plans.snapshot-readonly') }}</span>
            <button class="plan-snapshot-close" @click="snapshotPreview = null">{{ t('pane.plans.snapshot-close') }}</button>
          </div>
          <div v-if="openDocumentChangedOnDisk" class="plan-snapshot-banner plan-disk-changed-banner" role="status">
            <span class="plan-snapshot-note">{{ t('pane.plans.external-change') }}</span>
          </div>

          <div class="plan-main-body">
            <!-- Edit mode: the whole document editable, saving by itself. -->
            <div
              v-if="selected.html && isHtmlPath(selected.rel_path) && selected.meta && !snapshotPreview"
              class="plan-edit-bar"
              :class="{ active: editModeActive }"
            >
              <button type="button" class="plan-edit-toggle" :aria-pressed="editModeActive" @click="toggleEditMode">
                {{ editModeActive ? t('pane.plans.edit-mode-done') : t('pane.plans.edit-mode') }}
              </button>
              <span v-if="editModeActive" class="plan-edit-status" role="status">
                <template v-if="editSaveState === 'saving'">{{ t('pane.plans.edit-saving') }}</template>
                <template v-else-if="editSaveState === 'failed'">{{ t('pane.plans.edit-save-failed') }}</template>
                <template v-else-if="editSaveState === 'saved'">{{ t('pane.plans.edit-saved', { time: editSavedAt }) }}</template>
                <template v-else>{{ t('pane.plans.edit-mode-hint') }}</template>
              </span>
            </div>
            <!-- HTML preview iframe -->
            <div v-if="selected.html && isHtmlPath(selected.rel_path)" class="plan-preview-container">
              <iframe
                ref="planDocFrame"
                class="plan-doc-frame"
                name="navide-plan-doc"
                sandbox="allow-scripts"
                :key="currentDocumentToken ?? selected?.rel_path ?? ''"
                :srcdoc="iframeSrcdoc"
              />
            </div>

            <!-- Markdown plan / plain markdown document: rendered body with
                 editable sections and clickable frontmatter todos. -->
            <div v-else-if="isMarkdownPath(selected.rel_path)" class="plan-markdown-container">
              <div class="document-status">
                <span>{{ selected.meta ? t('pane.plans.v2.plan-metadata') : t('pane.plans.v2.plain-document') }}</span>
                <button type="button" @click="void copyPath(selected.rel_path)">{{ t('action.copy-path') }}</button>
              </div>
              <PlanMarkdownBody
                ref="markdownBody"
                :key="selected.rel_path"
                :workspace-path="workspacePath"
                :rel-path="selected.rel_path"
                :backend="plansTransport"
                :refresh="markdownRefresh"
                @updated="void refreshSelected()"
              />
            </div>

            <!-- Plain document / fallback view -->
            <div v-else class="plan-fallback-container">
              <div class="document-status">
                <span>{{ selected.meta ? t('pane.plans.v2.plan-metadata') : t('pane.plans.v2.plain-document') }}</span>
                <button type="button" @click="void copyPath(selected.rel_path)">{{ t('action.copy-path') }}</button>
              </div>
              <article v-if="selected.meta" class="plan-summary">
                <p v-if="selected.meta.overview">{{ selected.meta.overview }}</p>
                <h3>{{ t('pane.plans.todos') }}</h3>
                <ul>
                  <li v-for="todo in selectedTodos" :key="todo.id" :class="{ complete: todo.status === 'done' }">
                    {{ todoStatusLabel(todo.status) }} — {{ todo.content }}
                  </li>
                  <li v-if="!selectedTodos.length" class="muted">{{ t('pane.plans.todos-empty') }}</li>
                </ul>
              </article>
              <div v-else class="document-summary">
                <p>{{ t('pane.plans.v2.promote-description') }}</p>
                <p class="muted">{{ t('pane.plans.v2.editor-description') }}</p>
              </div>
            </div>

          </div>
        </div>
        <div v-else class="plan-window-empty empty-state">
          <h2>{{ t('pane.plans.v2.empty-title') }}</h2>
          <p>{{ t('pane.plans.v2.empty-description') }}</p>
        </div>
      </main>

      <aside v-if="!isLeftContribution()" class="ai-sidebar">
        <SafeAiCliPanel :controller="aiCliController" :build-context="buildAiCliContext" width-key="plans-ai-panel-width" />
      </aside>
    <div v-if="contextMenu" class="context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @click.stop>
      <button type="button" @click="void openInEditor(contextMenu.relPath); closeContextMenu()">{{ t('action.open-in-editor') }}</button>
      <button type="button" @click="void copyPath(contextMenu.relPath); closeContextMenu()">{{ t('action.copy-path') }}</button>
      <button type="button" @click="void openPlan(contextMenu.relPath); closeContextMenu()">{{ t('pane.plans.v2.select') }}</button>
      <button v-if="isHtmlPath(contextMenu.relPath)" type="button" @click="selectedPath = contextMenu!.relPath; void beginRename()">{{ t('action.rename') }}</button>
      <button v-if="isHtmlPath(contextMenu.relPath)" type="button" class="plans-ctx-share" @click="void shareToGitPath(contextMenu!.relPath); closeContextMenu()">{{ t('pane.plans.share-git') }}</button>
      <button v-if="isPlan(contextMenuPlan)" type="button" class="plans-ctx-archive" @click="void toggleArchivePath(contextMenu!.relPath); closeContextMenu()">
        {{ contextMenuPlan && isArchived(contextMenuPlan) ? t('pane.plans.unarchive') : t('pane.plans.archive') }}
      </button>
      <button v-if="contextMenuPlan && !isPlan(contextMenuPlan)" type="button" class="plans-ctx-promote" @click="void promotePath(contextMenu!.relPath); closeContextMenu()">{{ t('pane.plans.menu-upgrade') }}</button>
      <button type="button" class="danger" @click="void deletePath(contextMenu!.relPath); closeContextMenu()">{{ t('action.delete') }}</button>
    </div>

    <div v-if="quickOpenActive" class="overlay" @click.self="closeQuickOpen">
      <div class="quick-open" role="dialog" :aria-label="t('pane.plans.v2.quick-open')">
        <input ref="quickOpenInput" v-model="quickOpenQuery" :placeholder="t('pane.plans.v2.search-plans')" @keydown.down.prevent="moveQuickOpen(1)" @keydown.up.prevent="moveQuickOpen(-1)" @keydown.enter.prevent="confirmQuickOpen" @keydown.escape="closeQuickOpen" />
        <button v-for="(plan, index) in quickOpenRows" :key="plan.rel_path" type="button" :class="{ active: index === quickOpenIndex }" @mousemove="quickOpenIndex = index" @click="confirmQuickOpen"><span>{{ planTitle(plan) }}</span><span class="muted">{{ planStageLabel(planStage(plan)) }}</span></button>
        <p v-if="!quickOpenRows.length" class="muted">{{ t('pane.plans.v2.no-matching') }}</p>
      </div>
    </div>

    <SectionConflictDialog
      v-if="pendingSectionConflict"
      ref="sectionConflictDialog"
      :conflict="pendingSectionConflict.conflict"
      :saving="sectionConflictSaving"
      @keep-mine="void keepMySection()"
      @keep-theirs="void keepTheirSection()"
      @close="pendingSectionConflict = null"
    />

    <div v-if="renameTarget" class="overlay" @click.self="cancelRename">
      <form class="rename-dialog" @submit.prevent="void submitRename()"><h2>{{ t('pane.plans.v2.rename-plan') }}</h2><input ref="renameInput" v-model="renameValue" @keydown.escape="cancelRename" /><div class="dialog-actions"><button type="button" @click="cancelRename">{{ t('action.cancel') }}</button><button type="submit">{{ t('action.rename') }}</button></div></form>
    </div>
  </div>
</template>

<style scoped>
.pdp-error { align-items: center; color: var(--text-muted); display: flex; flex: 1; flex-direction: column; font-size: var(--font-sm); gap: 6px; justify-content: center; padding: 0 16px; text-align: center; }
.pdp-error-reason, .pdp-error-path { font-size: var(--font-xs); opacity: 0.75; overflow-wrap: anywhere; }
.pdp-error-path { font-family: var(--font-mono, monospace); }
.plan-snapshot-banner { align-items: center; background: var(--bg-subtle); border-bottom: 1px solid var(--border-default); display: flex; flex-shrink: 0; font-size: var(--font-xs); gap: 10px; padding: 6px 12px; }
.plan-snapshot-label { font-weight: 650; }
.plan-snapshot-note { color: var(--text-muted); flex: 1; font-size: var(--font-2xs); }
.plan-snapshot-close { background: var(--bg-muted); border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-primary); cursor: pointer; font-size: var(--font-2xs); padding: 3px 10px; }
.plan-snapshot-close:hover { background: var(--bg-hover-strong); }
.plan-window {
  height: 100%;
  width: 100%;
  display: flex;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--text-primary);
  box-sizing: border-box;
}
.plans-surface {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--text-primary);
  box-sizing: border-box;
}
.plans-surface.plans-left-surface {
  width: 100%;
  max-width: 100%;
  height: 100%;
}
.plans-layout.is-left-contribution {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.plans-head {
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  gap: 8px;
  justify-content: space-between;
  padding: 8px 12px;
  flex: 0 0 auto;
  box-sizing: border-box;
}
.plans-title {
  font-size: var(--font-xs, 12px);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.plans-icon-btn {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-xs, 12px);
  padding: 3px 7px;
}
.plans-icon-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

/* The re-open control sits outside the sidebar, which is unmounted while the
   list is hidden, so it anchors to the layout instead of the header. */
.plans-sidebar-toggle--show {
  align-self: flex-start;
  margin: 8px 0 0 8px;
}

.plans-layout.is-left-contribution .plans-sidebar {
  border-right: 0;
  flex: 1 1 0;
  width: 100%;
  max-width: none;
  height: 100%;
  padding: 0;
  overflow: hidden;
}

.plans-sidebar {
  width: 300px;
  min-width: 260px;
  max-width: 340px;
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-base);
  overflow: hidden;
  padding: 0;
  box-sizing: border-box;
}
.plan-window-side {
  border-right: 1px solid var(--border-subtle);
  flex-shrink: 0;
  overflow: hidden;
  width: 300px;
}
.plans-pane {
  background: var(--bg-base);
  color: var(--text-primary);
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  font-size: var(--font-xs, 12px);
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.plans-sidebar-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  padding: 0;
}
.plans-toolbar {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border-subtle);
  padding: 8px 12px;
  display: grid;
  gap: 6px;
}
.plans-search { position: relative; }
.plans-search-input {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-sizing: border-box;
  color: var(--text-primary);
  font-size: var(--font-xs, 12px);
  padding: 4px 24px 4px 8px;
  width: 100%;
}
.plans-search-input:focus { border-color: var(--accent-focus, #388bfd); outline: none; }
.plans-search-clear {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: var(--font-2xs, 11px);
  height: 18px;
  justify-content: center;
  padding: 0;
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
}
.plans-search-clear:hover { color: var(--text-primary); }
.plans-toolbar-row { display: flex; gap: 6px; }
.plans-select {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-secondary);
  flex: 1;
  font-size: var(--font-2xs, 11px);
  min-width: 0;
  padding: 3px 4px;
}
.plans-toggle-btn {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  flex: 0 0 auto;
  font-size: var(--font-2xs, 11px);
  line-height: 1;
  padding: 3px 7px;
}
.plans-toggle-btn:hover { color: var(--text-primary); }
.plans-toggle-btn--on { border-color: var(--accent-focus, #388bfd); color: var(--text-primary); }

.plans-section { padding: 8px 8px 4px; }
.plans-section-head {
  align-items: center;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: var(--font-2xs, 11px);
  font-weight: 700;
  justify-content: space-between;
  letter-spacing: 0.05em;
  padding: 0 4px 6px;
  text-transform: uppercase;
  user-select: none;
}
.plans-section-title { align-items: center; display: flex; gap: 5px; }
.plans-section-chevron { display: inline-block; font-size: 9px; transition: transform 0.12s ease; margin-right: 2px; }
.plans-section-chevron.collapsed { transform: rotate(-90deg); }
.plan-row {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  box-sizing: border-box;
  color: inherit;
  cursor: pointer;
  display: grid;
  gap: 4px;
  padding: 6px 8px;
  position: relative;
  text-align: left;
  width: 100%;
}
.plan-row:hover { background: var(--bg-hover); border-color: var(--border-subtle); }
.plan-row.selected { background: var(--bg-hover); border-color: var(--border-subtle); }
.plan-row--done { opacity: .78; }
.plan-row-name { font-size: var(--font-xs, 12px); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-row-overview {
  color: var(--text-muted);
  font-size: var(--font-2xs, 11px);
  line-height: 1.35;
  max-height: 2.7em;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.plan-row-path {
  color: var(--text-muted);
  font-family: var(--font-mono, monospace);
  font-size: var(--font-3xs, 10px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-2xs, 11px);
  color: var(--text-muted);
  flex-wrap: wrap;
  margin-top: 2px;
}
.plan-row-progress { display: inline-flex; align-items: center; gap: 6px; }
.plan-progress-bar {
  background: var(--bg-subtle);
  border-radius: 999px;
  height: 4px;
  overflow: hidden;
  width: 90px;
  display: inline-block;
  vertical-align: middle;
}
.plan-progress-fill {
  background: var(--accent-color, #f0883e);
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 0.15s ease;
}
.plan-progress-bar--draft > .plan-progress-fill { background: var(--text-muted); }
.plan-progress-bar--in-review > .plan-progress-fill { background: #e3b341; }
.plan-progress-bar--approved > .plan-progress-fill { background: #58a6ff; }
.plan-progress-bar--in-progress > .plan-progress-fill { background: #f0883e; }
.plan-progress-bar--done > .plan-progress-fill { background: #3fb950; }
.plan-progress-bar--abandoned > .plan-progress-fill { background: #8b949e; }
.plan-chip {
  border-radius: 4px;
  font-size: var(--font-3xs, 10px);
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  text-transform: uppercase;
  background: var(--bg-subtle);
  color: var(--text-secondary);
}
.plan-chip--stage-draft { background: rgba(139, 148, 158, 0.2); color: #8b949e; }
.plan-chip--stage-in-review { background: rgba(227, 179, 65, 0.2); color: #e3b341; }
.plan-chip--stage-approved { background: rgba(88, 166, 255, 0.2); color: #58a6ff; }
.plan-chip--stage-in-progress { background: rgba(240, 136, 62, 0.2); color: #f0883e; }
.plan-chip--stage-done { background: rgba(63, 185, 80, 0.2); color: #3fb950; }
.plan-chip--stage-abandoned { background: rgba(139, 148, 158, 0.15); color: #6e7681; }
.plan-chip.archived { background: var(--bg-muted); color: var(--text-muted); }
.plan-chip--awaiting {
  background: var(--danger-subtle, var(--attention-subtle));
  color: var(--danger-bright, var(--attention-bright));
  text-transform: none;
}
.plan-chip--problem {
  background: var(--attention-subtle);
  color: var(--attention-bright);
  text-transform: none;
}

.plan-row-delete {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: var(--font-xs, 12px);
  height: 20px;
  justify-content: center;
  opacity: 0;
  padding: 0;
  position: absolute;
  right: 6px;
  top: 6px;
  width: 20px;
}
.plan-row:hover .plan-row-delete,
.plan-row:focus-within .plan-row-delete {
  opacity: 1;
}
.plan-row-delete:hover { background: var(--bg-hover-strong); color: var(--danger-fg, #f85149); }
.plan-row--compact { align-items: center; display: flex; gap: 8px; padding-right: 28px; }
.plan-row--compact .plan-row-name { flex: 1; min-width: 0; }
.plan-row-pin {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  font-size: var(--font-2xs, 11px);
  height: 20px;
  justify-content: center;
  opacity: 0;
  padding: 0;
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
}
.plan-row-pin--on, .plan-row:hover .plan-row-pin { opacity: 1; }
.plans-muted, .plans-error, .plans-empty { color: var(--text-muted); padding: 12px; font-size: var(--font-xs, 12px); }
.plans-error { color: var(--text-danger, #d45b5b); }
.completed-actions { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border-subtle); }

.plan-content {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
}
.plan-window-main {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.plan-window-main > * {
  flex: 1 1 0;
  min-height: 0;
}
.plan-window-doc {
  display: flex;
  flex-direction: column;
}
.plan-window-doc > :last-child {
  flex: 1 1 0;
  min-height: 0;
}
.plan-window-empty {
  align-items: center;
  color: var(--text-muted);
  display: flex;
  font-size: var(--font-sm);
  justify-content: center;
}
.selected-document {
  display: flex;
  flex-direction: column;
}
.selected-document > :last-child {
  flex: 1 1 0;
  min-height: 0;
}
.selected-document {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
}

.plan-main-body {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.plan-edit-bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 10px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: var(--font-xs);
}
.plan-edit-bar.active { background: var(--bg-subtle); }
.plan-edit-toggle { border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-muted); color: var(--text-primary); font-size: var(--font-xs); padding: 3px 10px; }
.plan-edit-bar.active .plan-edit-toggle { border-color: var(--accent-focus); color: var(--accent-fg); }
.plan-edit-status { color: var(--text-muted); }
.plan-preview-container {
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  position: relative;
  overflow: hidden;
  background: transparent;
}
.plan-doc-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
  display: block;
  background: #fff;
}
.plan-fallback-container {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.plan-markdown-container {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* The markdown body owns its own scroller; give it the remaining height. */
.plan-markdown-container > :last-child {
  flex: 1 1 0;
  min-height: 0;
}

.document-status {
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.plan-summary, .document-summary { padding: 24px; line-height: 1.55; }
.plan-summary h3 { margin: 22px 0 6px; font-size: 14px; }
.plan-summary ul { padding-left: 20px; }
.plan-summary li.complete { color: var(--success-fg, #5aba75); }
.empty-state { margin: auto; padding: 40px; color: var(--text-muted); text-align: center; }

/* No width of its own: the panel sets it (resizable, 42px when collapsed). */
.ai-sidebar {
  flex: 0 0 auto;
  height: 100%;
  border-left: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
  background: var(--bg-base);
  box-sizing: border-box;
}

button, input, select, textarea {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-subtle);
  color: inherit;
  padding: 6px 8px;
  font: inherit;
}
button { cursor: pointer; }
button:hover, .quick-open button.active { background: var(--bg-hover); }

.context-menu { position: fixed; z-index: 20; display: grid; min-width: 180px; padding: 5px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-subtle); box-shadow: 0 8px 30px rgb(0 0 0 / 25%); }
.context-menu button { border: 0; background: transparent; text-align: left; }
.overlay { position: fixed; inset: 0; z-index: 30; display: grid; place-items: start center; padding-top: 15vh; background: rgb(0 0 0 / 35%); }
.quick-open, .rename-dialog { display: grid; gap: 6px; width: min(520px, calc(100vw - 32px)); padding: 12px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-base); box-shadow: 0 14px 40px rgb(0 0 0 / 35%); }
.quick-open button { display: flex; justify-content: space-between; border: 0; text-align: left; }
.rename-dialog h2 { margin: 0 0 8px; font-size: 15px; }

@media (max-width: 900px) {
  .plans-sidebar { width: 240px; min-width: 200px; }
}
</style>
