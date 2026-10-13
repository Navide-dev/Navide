<script setup lang="ts">
import { computed, nextTick, onBeforeMount, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { parsePlanMeta, writePlanMeta } from '../composables/usePlanFile'
import { resolvePlanStore } from '../composables/planStore'
import { PLAN_STAGES, type PlanMeta } from '../composables/planModel'
import {
  DEFAULT_SORT_DIRECTION,
  PLAN_GROUP_MODES,
  PLAN_SORT_DIRECTIONS,
  PLAN_SORT_MODES,
  comparePlanRows,
  loadStoredChoice,
  planMatchesQuery,
  saveStoredChoice,
  type PlanGroupMode,
  type PlanSortDirection,
  type PlanSortMode,
} from './plansPaneModel'
import {
  htmlPlanAwaitingUser,
  htmlPlanProgress,
  injectPlanMeta,
  parseHtmlPlanMeta,
  type HtmlPlanMeta,
  type PlanStage,
} from '../composables/usePlanHtml'
import { sharePlanToGit } from '../composables/planShare'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import { writePlanDragPayload } from '../lib/planDrag'
import {
  isLegacyPlansRecoveryRuntime,
  readLegacyPlansPreferenceProjection,
  type LegacyPlansPreferenceProjection,
} from './plansPreferences'

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
}>()

const emit = defineEmits<{
  (e: 'open-file', payload: { filepath: string; name: string; root: string }): void
  (e: 'deleted', relPath: string): void
}>()

// The project root plans actually live in, reported by `plans.list_docs`. It
// differs from `workspacePath` only when the workspace is a subdirectory of a
// repository: every writer (the MCP tools, asset provisioning) resolves up to
// the repository root, so reads, writes and rel_paths must use the same root or
// they address a file that is not there. Seeded with the workspace so the first
// render before the list arrives behaves as it always did.
const planRoot = ref(props.workspacePath)

// One row of `plans.list_docs`. `cached: true` means `meta` is the backend's
// stored copy and still matches the file on disk, so it needs no re-read;
// `cached: false` means this document must be read and parsed (and is then fed
// back through `plans.cache_put`).
interface PlanDoc {
  rel_path: string
  name: string
  mtime: number
  meta: PlanMeta | null
  cached: boolean
}

// `meta` carries the unified plan model for BOTH formats: HTML plans parse
// their `plan-meta` island, markdown plans parse their YAML frontmatter
// (`resolvePlanStore(relPath).parseMeta`). It is null for files with no valid
// plan meta of their format — those are listed as plain docs (badge 'doc', no
// progress, no stage group), the same treatment for markdown and HTML.
interface PlanItem {
  relPath: string
  name: string
  meta: PlanMeta | null
  /** File mtime (seconds) from fs.read_file; drives the last-updated sort. */
  mtime?: number
}

const { t } = useI18n()
const { toast, confirm } = useNotify()
const loading = ref(false)
const waitingForBackend = ref(false)
const error = ref('')
const plans = ref<PlanItem[]>([])

/**
 * Whether a cached meta payload can be trusted as-is. `null` is a legitimate
 * cached outcome ("this file carries no valid meta"); an object must still look
 * like the current plan model. Anything else — e.g. a payload written by an
 * older model shape — counts as a miss, and the file on disk wins.
 */
function isUsableCachedMeta(meta: PlanMeta | null): boolean {
  if (meta === null) return true
  return typeof (meta as { stage?: unknown }).stage === 'string'
}

async function loadPlans(): Promise<void> {
  if (!props.workspacePath) return
  // Only the very first load (no plans yet) shows the loading overlay. Later
  // refreshes (own todo-status toggles, external plans.changed broadcasts)
  // keep the existing list on screen and swap it in silently — no flicker,
  // no sidebar scroll reset.
  const isFirstLoad = plans.value.length === 0
  if (props.backend.status?.value && props.backend.status.value !== 'connected') {
    waitingForBackend.value = true
    loading.value = isFirstLoad
    error.value = ''
    return
  }

  waitingForBackend.value = false
  loading.value = isFirstLoad
  error.value = ''
  try {
    const list = await props.backend.send<{ ok: boolean; docs?: PlanDoc[]; root?: string; error?: string }>('plans.list_docs', {
      workspace_path: props.workspacePath,
    })
    if (!list.payload?.ok) {
      error.value = list.payload?.error || t('pane.plans.list-failed')
      return
    }
    // Every rel_path below is relative to this root, not to the workspace.
    planRoot.value = list.payload.root || props.workspacePath

    // Documents the cache could not answer for get read and parsed here, then
    // written back so the next refresh skips them.
    const parsed: { rel_path: string; mtime: number; meta: PlanMeta | null }[] = []

    const items = await Promise.all(
      (list.payload.docs ?? []).map(async (doc): Promise<PlanItem | null> => {
        if (doc.cached && isUsableCachedMeta(doc.meta)) {
          return { relPath: doc.rel_path, name: doc.name, meta: doc.meta, mtime: doc.mtime }
        }
        const read = await props.backend.send<{ ok: boolean; content?: string; mtime?: number; error?: string }>('fs.read_file', {
          workspace_path: planRoot.value,
          rel_path: doc.rel_path,
        })
        if (!read.payload?.ok) return null
        const meta = resolvePlanStore(doc.rel_path).parseMeta(read.payload.content ?? '')
        // The read's own mtime, not the scan's: it is the one that matches the
        // bytes this meta was parsed from.
        const mtime = read.payload.mtime ?? doc.mtime
        parsed.push({ rel_path: doc.rel_path, mtime, meta })
        return { relPath: doc.rel_path, name: doc.name, meta, mtime }
      })
    )

    plans.value = items.filter((item): item is PlanItem => item !== null)

    if (parsed.length) {
      // Fire-and-forget: the cache is an optimization, so a failed write costs
      // the next refresh some re-reads and nothing else.
      void props.backend.send('plans.cache_put', {
        workspace_path: planRoot.value,
        entries: parsed,
      })
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('pane.plans.load-failed')
  } finally {
    loading.value = false
  }
}

// Backend broadcasts plans.changed when any plan document under
// .agent-team/plans changes on disk (own writes or external agents).
let offPlansChanged: (() => void) | null = null
let offLegacyRecoveryPreferences: (() => void) | null = null
onBeforeMount(() => {
  offPlansChanged = props.backend.on('plans.changed', (payload) => {
    const p = payload as { workspace_path?: unknown } | null
    // The watcher reports whichever path it was started on, which is the
    // resolved root once a subdirectory workspace has listed once.
    if (p && (p.workspace_path === props.workspacePath || p.workspace_path === planRoot.value)) {
      void loadPlans()
    }
  })
})
onMounted(() => {
  offLegacyRecoveryPreferences = window.agentTeam?.onPlansLegacyRecoveryPreferences?.((values) => {
    if (isLegacyPlansRecoveryRuntime()) void applyLegacyRecoveryPreferences(values)
  }) ?? null
  if (!isLegacyPlansRecoveryRuntime()) {
    void window.agentTeam?.projectLegacyPlansPreferences({
      workspace_path: props.workspacePath,
      values: readLegacyPlansPreferenceProjection(props.workspacePath),
    })
  }
  void loadLegacyRecoveryPreferences()
  void loadPlans()
})
onUnmounted(() => {
  offPlansChanged?.()
  offPlansChanged = null
  offLegacyRecoveryPreferences?.()
  offLegacyRecoveryPreferences = null
  removeCtxListeners()
})
watch(() => props.workspacePath, (next) => {
  if (!isLegacyPlansRecoveryRuntime()) {
    void window.agentTeam?.projectLegacyPlansPreferences({
      workspace_path: next,
      values: readLegacyPlansPreferenceProjection(next),
    })
  }
  planRoot.value = next // re-resolved by the next list
  collapsedSections.value = loadCollapsed(next)
  searchQuery.value = ''
  stageFilter.value = loadStoredChoice(filterStorageKey(next), STAGE_FILTERS, 'all')
  sortMode.value = loadStoredChoice(sortStorageKey(next), PLAN_SORT_MODES, 'updated')
  sortDirection.value = loadStoredChoice(
    sortDirStorageKey(next),
    PLAN_SORT_DIRECTIONS,
    DEFAULT_SORT_DIRECTION[sortMode.value],
  )
  groupMode.value = loadStoredChoice(groupStorageKey(next), PLAN_GROUP_MODES, 'flat')
  recentRelPaths.value = loadStringList(recentStorageKey(next))
  pinnedRelPaths.value = loadStringList(pinnedStorageKey(next))
  void loadLegacyRecoveryPreferences()
  void loadPlans()
})
watch(() => props.backend.status?.value, (status) => {
  if (status === 'connected' && waitingForBackend.value) void loadPlans()
})

// ── Search / stage filter / sort / grouping ───────────────────────────────
// Search is transient (never persisted); stage filter, sort mode, sort
// direction and grouping are persisted per workspace with the same fail-safe
// localStorage contract as the collapse state below.
const FILTER_KEY_PREFIX = 'navide.plans.filter.'
// The default moved from 'title' to 'updated'. No migration is needed: these
// keys are written only by the watchers below, i.e. only once the user has
// picked something, so a stored value is always an explicit choice and a
// workspace that was left alone simply reads the new default.
const SORT_KEY_PREFIX = 'navide.plans.sort.'
const SORT_DIR_KEY_PREFIX = 'navide.plans.sortdir.'
const GROUP_KEY_PREFIX = 'navide.plans.group.'
const STAGE_FILTERS = ['all', ...PLAN_STAGES] as const
type StageFilter = (typeof STAGE_FILTERS)[number]

function filterStorageKey(workspacePath: string): string {
  return `${FILTER_KEY_PREFIX}${workspacePath}`
}
function sortStorageKey(workspacePath: string): string {
  return `${SORT_KEY_PREFIX}${workspacePath}`
}
function sortDirStorageKey(workspacePath: string): string {
  return `${SORT_DIR_KEY_PREFIX}${workspacePath}`
}
function groupStorageKey(workspacePath: string): string {
  return `${GROUP_KEY_PREFIX}${workspacePath}`
}

const searchQuery = ref('')
const stageFilter = ref<StageFilter>(loadStoredChoice(filterStorageKey(props.workspacePath), STAGE_FILTERS, 'all'))
const sortMode = ref<PlanSortMode>(loadStoredChoice(sortStorageKey(props.workspacePath), PLAN_SORT_MODES, 'updated'))
const sortDirection = ref<PlanSortDirection>(
  loadStoredChoice(sortDirStorageKey(props.workspacePath), PLAN_SORT_DIRECTIONS, DEFAULT_SORT_DIRECTION[sortMode.value]),
)
const groupMode = ref<PlanGroupMode>(loadStoredChoice(groupStorageKey(props.workspacePath), PLAN_GROUP_MODES, 'flat'))
let suppressPreferencePersistence = false

watch(stageFilter, (next) => {
  if (!suppressPreferencePersistence) saveStoredChoice(filterStorageKey(props.workspacePath), next)
})
watch(sortMode, (next) => {
  if (!suppressPreferencePersistence) saveStoredChoice(sortStorageKey(props.workspacePath), next)
})
watch(sortDirection, (next) => {
  if (!suppressPreferencePersistence) saveStoredChoice(sortDirStorageKey(props.workspacePath), next)
})
watch(groupMode, (next) => {
  if (!suppressPreferencePersistence) saveStoredChoice(groupStorageKey(props.workspacePath), next)
})

// Picking a mode resets the arrow to that mode's natural direction (A→Z for
// titles, newest/most-complete first otherwise). Done on the change event
// rather than in a watcher so it cannot race the workspace-switch reload,
// which assigns both refs in the same tick.
function onSortModeChange(event: Event): void {
  const next = (event.target as HTMLSelectElement).value as PlanSortMode
  sortMode.value = next
  sortDirection.value = DEFAULT_SORT_DIRECTION[next]
}
function toggleSortDirection(): void {
  sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
}
function toggleGroupMode(): void {
  groupMode.value = groupMode.value === 'flat' ? 'stage' : 'flat'
}

const searchActive = computed(() => searchQuery.value.trim().length > 0)

// Plans match on title (meta.name, or filename for docs), filename and
// overview text; docs have no overview.
function itemMatchesSearch(p: PlanItem): boolean {
  return planMatchesQuery(searchQuery.value, {
    title: p.meta?.name ?? p.name,
    filename: p.name,
    overview: p.meta?.overview,
  })
}

// Row list order: last-updated first by default (the near-random `_6hex`
// filename order reads as arbitrary and title order buries fresh work), or the
// user-selected mode and direction.
function sortRows<T extends PlanListRow>(rows: T[]): T[] {
  return rows.sort((a, b) =>
    comparePlanRows(
      sortMode.value,
      { title: rowTitle(a), mtime: a.item.mtime, done: a.done, total: a.total },
      { title: rowTitle(b), mtime: b.item.mtime, done: b.done, total: b.total },
      sortDirection.value,
    ),
  )
}

/** Docs have no plan meta, so they sort under their filename. */
function rowTitle(row: PlanListRow): string {
  return row.meta?.name ?? row.item.name
}

// Files without valid plan meta (markdown or HTML) are plain docs — listed
// under Active with a 'doc' badge, no progress, never stage-grouped.
const docItems = computed(() => plans.value.filter((p) => !p.meta))

// Docs carry no stage, so a specific stage filter hides the whole doc group;
// while searching, the group only shows when it has matches. The doc group
// honours the sort selection exactly like the stage groups do.
const visibleDocItems = computed(() =>
  stageFilter.value === 'all' && groupMode.value === 'stage'
    ? sortRows(docItems.value.filter(itemMatchesSearch).map(toListRow)).map((row) => row.item)
    : [],
)
const showDocsSection = computed(
  () =>
    groupMode.value === 'stage' &&
    stageFilter.value === 'all' &&
    (!searchActive.value || visibleDocItems.value.length > 0),
)

// Same contract as the doc group: while searching, an empty flat list is not
// worth a header — the Archived group below may still have matched something,
// so `noVisibleResults` alone would leave an empty "All plans / 0" above it.
const showFlatSection = computed(
  () => groupMode.value === 'flat' && (!searchActive.value || flatRows.value.length > 0),
)

// A row is one listed file: a plan (meta present) or a plain doc (meta null).
// Stage groups only ever hold plans, so they narrow `meta` to non-null.
interface PlanListRow {
  item: PlanItem
  meta: PlanMeta | null
  done: number
  total: number
  /** Unfinished todos owned by the user — see htmlPlanAwaitingUser. */
  awaiting: number
}

interface PlanStageRow extends PlanListRow {
  meta: PlanMeta
}

function toListRow(item: PlanItem): PlanListRow {
  const progress = item.meta ? htmlPlanProgress(item.meta.todos) : { done: 0, total: 0 }
  const awaiting = item.meta ? htmlPlanAwaitingUser(item.meta.todos) : 0
  return { item, meta: item.meta, done: progress.done, total: progress.total, awaiting }
}

// Both formats group by `meta.stage`; progress uses `htmlPlanProgress`
// (skipped counts toward neither done nor total-done), consistent across
// markdown and HTML.
function stageRows(stages: PlanStage[]): PlanStageRow[] {
  return sortRows(
    plans.value.flatMap((p) => {
      // Archived plans leave their stage group and live in the Archived group so
      // they never appear in both places at once.
      if (!p.meta || p.meta.archivedAt || !stages.includes(p.meta.stage)) return []
      if (!itemMatchesSearch(p)) return []
      const progress = htmlPlanProgress(p.meta.todos)
      const awaiting = htmlPlanAwaitingUser(p.meta.todos)
      return [{ item: p, meta: p.meta, done: progress.done, total: progress.total, awaiting }]
    }),
  )
}

// Flat mode replaces the stage grouping with one list, so the sort order is
// global: the newest plan in the workspace is the first row whatever stage it
// sits in. Plans and plain docs share the list; archived plans keep their own
// group in both modes.
const flatRows = computed<PlanListRow[]>(() => {
  if (groupMode.value !== 'flat') return []
  return sortRows(
    plans.value.flatMap((p) => {
      if (p.meta?.archivedAt) return []
      // Docs carry no stage, so a specific stage filter hides them here too.
      if (stageFilter.value !== 'all' && p.meta?.stage !== stageFilter.value) return []
      if (!itemMatchesSearch(p)) return []
      return [toListRow(p)]
    }),
  )
})

// Archived plans (any stage) collected into their own collapsed group. The
// group is a cross-stage bucket, so a specific stage filter hides it entirely.
const archivedRows = computed<PlanStageRow[]>(() => {
  if (stageFilter.value !== 'all') return []
  return sortRows(
    plans.value.flatMap((p) => {
      if (!p.meta || !p.meta.archivedAt) return []
      if (!itemMatchesSearch(p)) return []
      const progress = htmlPlanProgress(p.meta.todos)
      const awaiting = htmlPlanAwaitingUser(p.meta.todos)
      return [{ item: p, meta: p.meta, done: progress.done, total: progress.total, awaiting }]
    }),
  )
})

// Width of the row progress-bar fill; callers guard total > 0.
function progressPercent(done: number, total: number): string {
  return `${Math.round((done / total) * 100)}%`
}

// Drag a plan row onto a CLI pane's terminal to inject its goal + execution
// instruction into that pane's input prompt (TerminalPane's 'plan-drop').
// overview is the plan goal; plain docs have none.
function onPlanRowDragStart(e: DragEvent, relPath: string, name: string, overview?: string): void {
  if (!e.dataTransfer) return
  writePlanDragPayload(e.dataTransfer, { relPath, name, overview })
  e.dataTransfer.effectAllowed = 'copy'
}

// "Archive all done": done plans not yet archived. Drives the button state and
// the batch target.
const archivableDone = computed(() =>
  plans.value.filter((p) => p.meta && p.meta.stage === 'done' && !p.meta.archivedAt)
)

const stageGroups = computed(() => {
  if (groupMode.value !== 'stage') return []
  return (
    [
      { key: 'draft', label: t('pane.plans.stage-draft'), stages: ['draft'], finished: false },
      { key: 'in-review', label: t('pane.plans.stage-in-review'), stages: ['in-review'], finished: false },
      { key: 'approved', label: t('pane.plans.stage-approved'), stages: ['approved'], finished: false },
      { key: 'in-progress', label: t('pane.plans.stage-in-progress'), stages: ['in-progress'], finished: false },
      { key: 'done', label: t('pane.plans.stage-done'), stages: ['done'], finished: true },
      { key: 'abandoned', label: t('pane.plans.stage-abandoned'), stages: ['abandoned'], finished: true },
    ] as { key: string; label: string; stages: PlanStage[]; finished: boolean }[]
  )
    .filter((group) => stageFilter.value === 'all' || group.key === stageFilter.value)
    .map((group) => ({ ...group, rows: stageRows(group.stages) }))
    .filter((group) => group.rows.length > 0)
})

// "Nothing to show" while a search or stage filter is active — distinct from
// the workspace having no plans at all.
const noVisibleResults = computed(
  () =>
    (searchActive.value || stageFilter.value !== 'all') &&
    !visibleDocItems.value.length &&
    !flatRows.value.length &&
    !stageGroups.value.length &&
    !archivedRows.value.length,
)

// Batch-deletable = finished stages (done/abandoned), markdown and HTML alike.
// Archived plans are intentionally kept — they live in the Archived group and
// must never be swept up by "Delete all".
const deletablePlans = computed(() =>
  plans.value.filter(
    (p) => p.meta && !p.meta.archivedAt && (p.meta.stage === 'done' || p.meta.stage === 'abandoned'),
  )
)

// Section collapse — click a group header to fold/unfold its rows. Keyed by
// 'active' for the doc group and by stage key for the stage groups. The
// 'archived' group starts collapsed so archived plans stay out of the way.
// Persisted to localStorage per workspace so manual folds survive tab switches
// (unmount/remount) and window reopens.
const COLLAPSE_KEY_PREFIX = 'navide.plans.collapsed.'
const DEFAULT_COLLAPSED = ['archived']

function collapseStorageKey(workspacePath: string): string {
  return `${COLLAPSE_KEY_PREFIX}${workspacePath}`
}

// Restore the workspace's collapsed set; the first time there is nothing stored
// (or the stored value is corrupt) fall back to the default (archived folded).
// Never let a storage/parse error break the component.
function loadCollapsed(workspacePath: string): Set<string> {
  try {
    const raw = localStorage.getItem(collapseStorageKey(workspacePath))
    if (raw === null) return new Set(DEFAULT_COLLAPSED)
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set(DEFAULT_COLLAPSED)
    return new Set(parsed.filter((k): k is string => typeof k === 'string'))
  } catch {
    return new Set(DEFAULT_COLLAPSED)
  }
}

function saveCollapsed(workspacePath: string, set: Set<string>): void {
  try {
    localStorage.setItem(collapseStorageKey(workspacePath), JSON.stringify([...set]))
  } catch {
    // Storage unavailable (quota/private mode) — persistence is best-effort.
  }
}

const collapsedSections = ref<Set<string>>(loadCollapsed(props.workspacePath))
function toggleSection(key: string): void {
  const next = new Set(collapsedSections.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedSections.value = next
  saveCollapsed(props.workspacePath, next)
}
function isSectionCollapsed(key: string): boolean {
  return collapsedSections.value.has(key)
}

// ── Recent / pinned ───────────────────────────────────────────────────────
// The list below orders by mtime, which any CLI agent writing another plan
// outranks — it does not answer "the one I was working on". This section
// records opens instead, and lets long-running plans be pinned above them.
// Both are per-workspace localStorage, same fail-safe contract as the rest.
const RECENT_KEY_PREFIX = 'navide.plans.recent.'
const PINNED_KEY_PREFIX = 'navide.plans.pinned.'
/** Recent entries kept on disk; the section shows at most this many. */
const RECENT_LIMIT = 5

function recentStorageKey(workspacePath: string): string {
  return `${RECENT_KEY_PREFIX}${workspacePath}`
}
function pinnedStorageKey(workspacePath: string): string {
  return `${PINNED_KEY_PREFIX}${workspacePath}`
}

function loadStringList(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

function saveStringList(storageKey: string, list: string[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(list))
  } catch {
    // Storage unavailable (quota/private mode) — persistence is best-effort.
  }
}

const recentRelPaths = ref<string[]>(loadStringList(recentStorageKey(props.workspacePath)))
const pinnedRelPaths = ref<string[]>(loadStringList(pinnedStorageKey(props.workspacePath)))

function recoveryChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return value !== undefined && allowed.includes(value as T) ? value as T : fallback
}

function recoveryStringList(value: string | undefined): string[] {
  if (value === undefined) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function recoveryCollapsed(value: string | undefined): Set<string> {
  if (value === undefined) return new Set(DEFAULT_COLLAPSED)
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? new Set(parsed.filter((entry): entry is string => typeof entry === 'string'))
      : new Set(DEFAULT_COLLAPSED)
  } catch {
    return new Set(DEFAULT_COLLAPSED)
  }
}

async function applyLegacyRecoveryPreferences(
  values: LegacyPlansPreferenceProjection,
): Promise<void> {
  suppressPreferencePersistence = true
  try {
    stageFilter.value = recoveryChoice(values['plans.filter'], STAGE_FILTERS, 'all')
    sortMode.value = recoveryChoice(values['plans.sort'], PLAN_SORT_MODES, 'updated')
    sortDirection.value = recoveryChoice(
      values['plans.sortdir'],
      PLAN_SORT_DIRECTIONS,
      DEFAULT_SORT_DIRECTION[sortMode.value],
    )
    groupMode.value = recoveryChoice(values['plans.group'], PLAN_GROUP_MODES, 'flat')
    collapsedSections.value = recoveryCollapsed(values['plans.collapsed'])
    recentRelPaths.value = recoveryStringList(values['plans.recent'])
    pinnedRelPaths.value = recoveryStringList(values['plans.pinned'])
    await nextTick()
  } finally {
    suppressPreferencePersistence = false
  }
}

let recoveryPreferenceRequest = 0
async function loadLegacyRecoveryPreferences(): Promise<void> {
  if (!isLegacyPlansRecoveryRuntime()) return
  const request = ++recoveryPreferenceRequest
  try {
    const values = await window.agentTeam?.getPlansLegacyRecoveryPreferences?.()
    if (!values || request !== recoveryPreferenceRequest) return
    await applyLegacyRecoveryPreferences(values)
  } catch {
    // A missing previous snapshot or unavailable Host recovery port leaves the
    // retained renderer on its normal fail-safe defaults.
  }
}

/**
 * Record a plan as just-opened. Called for clicks in this pane and, in the plan
 * window, for every other way a document is opened (launch path, plan:open-doc,
 * the restore of the last opened plan).
 */
function noteOpened(relPath: string): void {
  if (!relPath) return
  const next = [relPath, ...recentRelPaths.value.filter((p) => p !== relPath)].slice(0, RECENT_LIMIT)
  recentRelPaths.value = next
  saveStringList(recentStorageKey(props.workspacePath), next)
}

function isPinned(relPath: string): boolean {
  return pinnedRelPaths.value.includes(relPath)
}

function togglePin(relPath: string): void {
  const next = isPinned(relPath)
    ? pinnedRelPaths.value.filter((p) => p !== relPath)
    : [...pinnedRelPaths.value, relPath]
  pinnedRelPaths.value = next
  saveStringList(pinnedStorageKey(props.workspacePath), next)
}

// Pinned first (in pin order), then the most recently opened. A remembered
// path with no matching row — deleted or renamed since — simply drops out.
const recentRows = computed<PlanListRow[]>(() => {
  const byRelPath = new Map(plans.value.map((p) => [p.relPath, p]))
  const inSection = (relPath: string): PlanItem | null => {
    const item = byRelPath.get(relPath)
    if (!item || !itemMatchesSearch(item)) return null
    if (stageFilter.value !== 'all' && item.meta?.stage !== stageFilter.value) return null
    return item
  }
  const pinned = pinnedRelPaths.value.map(inSection).filter((p): p is PlanItem => p !== null)
  const recent = recentRelPaths.value
    .filter((relPath) => !isPinned(relPath))
    .map(inSection)
    .filter((p): p is PlanItem => p !== null)
  return [...pinned, ...recent].map(toListRow)
})

function openPlan(item: PlanItem): void {
  noteOpened(item.relPath)
  emit('open-file', { filepath: item.relPath, name: item.name, root: planRoot.value })
}

// ── Quick open ────────────────────────────────────────────────────────────
// Name-first way into a plan when the workspace holds hundreds: type part of
// the title or filename, Enter opens it. Matching is the search box's, and the
// list it searches is already in memory — no extra backend call.
const QUICK_OPEN_LIMIT = 8
const quickOpenActive = ref(false)
const quickOpenQuery = ref('')
const quickOpenIndex = ref(0)
const quickOpenInput = ref<HTMLInputElement | null>(null)

const quickOpenRows = computed<PlanListRow[]>(() => {
  // Nothing typed yet: offer the recent/pinned shortlist rather than an
  // arbitrary slice of the whole workspace.
  if (!quickOpenQuery.value.trim()) return recentRows.value.slice(0, QUICK_OPEN_LIMIT)
  return sortRows(
    plans.value.flatMap((p) =>
      planMatchesQuery(quickOpenQuery.value, {
        title: p.meta?.name ?? p.name,
        filename: p.name,
        overview: p.meta?.overview,
      })
        ? [toListRow(p)]
        : [],
    ),
  ).slice(0, QUICK_OPEN_LIMIT)
})

watch(quickOpenQuery, () => (quickOpenIndex.value = 0))

async function openQuickOpen(): Promise<void> {
  quickOpenActive.value = true
  quickOpenQuery.value = ''
  quickOpenIndex.value = 0
  await nextTick()
  quickOpenInput.value?.focus()
}

function closeQuickOpen(): void {
  quickOpenActive.value = false
  quickOpenQuery.value = ''
}

function moveQuickOpen(delta: number): void {
  const count = quickOpenRows.value.length
  if (!count) return
  quickOpenIndex.value = (quickOpenIndex.value + delta + count) % count
}

function confirmQuickOpen(): void {
  const row = quickOpenRows.value[quickOpenIndex.value]
  if (!row) return
  closeQuickOpen()
  openPlan(row.item)
}

async function deleteCompleted(): Promise<void> {
  if (!deletablePlans.value.length) return
  const ok = await confirm(t('pane.plans.delete-completed-confirm', { count: deletablePlans.value.length }), {
    title: t('pane.plans.delete-completed-title'),
    confirmText: t('pane.plans.menu-delete'),
  })
  if (!ok) return

  let deleted = 0
  for (const item of deletablePlans.value) {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.delete', {
      workspace_path: planRoot.value,
      rel_path: item.relPath,
    })
    if (resp.payload?.ok) deleted++
    else toast(resp.payload?.error || t('pane.plans.delete-item-failed', { name: item.name }), { type: 'error' })
  }
  toast(t('pane.plans.deleted-count', { count: deleted }), { type: 'success' })
  await loadPlans()
}

// ── Archive ────────────────────────────────────────────────────────────────
// Archiving is non-destructive: the file stays on disk, only `archivedAt` is
// set (null clears it). Writes go through the optimistic-lock store.writeMeta
// so concurrent external edits are preserved, unlike the unlocked fs.delete.
function planCtx(relPath: string) {
  return { backend: props.backend, workspacePath: planRoot.value, relPath }
}

async function setArchived(item: PlanItem, archivedAt: string | null): Promise<void> {
  const resp = await resolvePlanStore(item.relPath).writeMeta(planCtx(item.relPath), (fresh) => ({
    ...fresh,
    archivedAt,
  }))
  if (!resp.ok) {
    toast(resp.error ?? t('pane.plans.review-save-failed'), { type: 'error' })
    return
  }
  await loadPlans()
}

async function archiveAllDone(): Promise<void> {
  if (!archivableDone.value.length) return
  const ok = await confirm(t('pane.plans.archive-all-confirm', { count: archivableDone.value.length }), {
    title: t('pane.plans.archive-all-done'),
    confirmText: t('pane.plans.archive-all-done'),
  })
  if (!ok) return

  let archived = 0
  for (const item of archivableDone.value) {
    const resp = await resolvePlanStore(item.relPath).writeMeta(planCtx(item.relPath), (fresh) => ({
      ...fresh,
      archivedAt: new Date().toISOString(),
    }))
    if (resp.ok) archived++
    else toast(resp.error || t('pane.plans.archive-item-failed', { name: item.name }), { type: 'error' })
  }
  toast(t('pane.plans.archived-count', { count: archived }), { type: 'success' })
  await loadPlans()
}

// ── Context menu ──────────────────────────────────────────────────────────
// Opens for every row. Individual items are gated per format/state below:
// markdown plans (with meta) get Open/Archive-Unarchive/Delete but not the
// HTML-only Rename/Share/Promote; meta-less docs get Promote.
// Backdrop + absolutely-positioned menu, following the GitPane convention.
const ctxMenu = ref<{ show: boolean; x: number; y: number; item: PlanItem | null }>({
  show: false,
  x: 0,
  y: 0,
  item: null,
})
const ctxMenuEl = ref<HTMLElement | null>(null)

function isHtmlItem(item: PlanItem): boolean {
  return item.name.endsWith('.html')
}

// Keep the menu inside the viewport. Clamp the requested corner with a rough
// size first (so it never spawns off-screen on a narrow sidebar), then re-clamp
// once the real element is measured.
function clampMenu(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

// Any scroll/resize while the menu is open would leave it detached from its
// anchor, so close it. Registered only while open; removed on close/unmount.
let ctxListening = false
function addCtxListeners(): void {
  if (ctxListening) return
  window.addEventListener('scroll', closeCtxMenu, true)
  window.addEventListener('resize', closeCtxMenu)
  ctxListening = true
}
function removeCtxListeners(): void {
  if (!ctxListening) return
  window.removeEventListener('scroll', closeCtxMenu, true)
  window.removeEventListener('resize', closeCtxMenu)
  ctxListening = false
}

async function openCtxMenu(e: MouseEvent, item: PlanItem): Promise<void> {
  const first = clampMenu(e.clientX, e.clientY, 200, 300)
  ctxMenu.value = { show: true, x: first.x, y: first.y, item }
  addCtxListeners()
  await nextTick()
  const el = ctxMenuEl.value
  if (!el || !ctxMenu.value.show) return
  const rect = el.getBoundingClientRect()
  if (!rect.width && !rect.height) return
  const fit = clampMenu(e.clientX, e.clientY, rect.width, rect.height)
  if (fit.x !== ctxMenu.value.x || fit.y !== ctxMenu.value.y) {
    ctxMenu.value = { ...ctxMenu.value, x: fit.x, y: fit.y }
  }
}

function closeCtxMenu(): void {
  removeCtxListeners()
  ctxMenu.value = { ...ctxMenu.value, show: false, item: null }
}

function ctxOpen(): void {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (item) openPlan(item)
}

async function ctxCopyPath(): Promise<void> {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (!item) return
  try {
    await navigator.clipboard.writeText(item.relPath)
    toast(t('pane.plans.copy-path-success'), { type: 'success' })
  } catch {
    toast(item.relPath, { type: 'error' })
  }
}

async function ctxShareToGit(): Promise<void> {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (!item) return
  const result = await sharePlanToGit(props.backend, planRoot.value, item.relPath)
  if (result.ok) toast(t('pane.plans.share-git-success'), { type: 'success' })
  else toast(result.error ?? t('pane.plans.share-git-failed'), { type: 'error' })
}

// ── Rename (keeps the `<kebab-slug>_<6-hex>.html` naming contract) ────────
const PLAN_FILENAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*_[0-9a-f]{6}\.html$/
const renameTarget = ref<PlanItem | null>(null)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

async function ctxRename(): Promise<void> {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (!item) return
  renameTarget.value = item
  renameValue.value = item.name
  // Focus + select so the name is editable immediately, no extra click.
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

function cancelRename(): void {
  renameTarget.value = null
  renameValue.value = ''
}

// ESC overlay support (queried by PlanWindowApp): close the topmost open
// overlay — the context menu first, then the rename dialog. Returns whether
// one was actually closed so the host knows to stop there.
function closeActiveOverlay(): boolean {
  if (ctxMenu.value.show) {
    closeCtxMenu()
    return true
  }
  if (renameTarget.value) {
    cancelRename()
    return true
  }
  if (quickOpenActive.value) {
    closeQuickOpen()
    return true
  }
  return false
}

defineExpose({ closeActiveOverlay, noteOpened, openQuickOpen })

async function submitRename(): Promise<void> {
  const item = renameTarget.value
  if (!item) return
  const newName = renameValue.value.trim()
  if (newName === item.name) {
    cancelRename()
    return
  }
  if (!PLAN_FILENAME_RE.test(newName)) {
    toast(t('pane.plans.rename-invalid'), { type: 'error' })
    return
  }
  const dir = item.relPath.slice(0, item.relPath.lastIndexOf('/'))
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.rename', {
    workspace_path: planRoot.value,
    src_path: item.relPath,
    dst_path: `${dir}/${newName}`,
  })
  if (!resp.payload?.ok) {
    toast(resp.payload?.error ?? t('pane.plans.rename-failed'), { type: 'error' })
    return
  }
  cancelRename()
  await loadPlans()
}

// Guard against IME composition: Enter committing a candidate must not submit.
function onRenameEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  void submitRename()
}

// ── Delete single (in-review/approved plans need a second confirmation) ───
// Shared by the context menu and the always-visible per-row delete button.
async function deletePlan(item: PlanItem): Promise<void> {
  const ok = await confirm(t('pane.plans.delete-confirm', { name: item.meta?.name ?? item.name }), {
    title: t('pane.plans.menu-delete'),
    confirmText: t('pane.plans.menu-delete'),
  })
  if (!ok) return
  const stage = item.meta?.stage
  if (stage === 'in-review' || stage === 'approved') {
    const ok2 = await confirm(t('pane.plans.delete-confirm-review', { stage }), {
      title: t('pane.plans.menu-delete'),
      confirmText: t('pane.plans.menu-delete'),
    })
    if (!ok2) return
  }
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.delete', {
    workspace_path: planRoot.value,
    rel_path: item.relPath,
  })
  if (!resp.payload?.ok) {
    toast(resp.payload?.error ?? t('pane.plans.delete-failed'), { type: 'error' })
    return
  }
  emit('deleted', item.relPath)
  await loadPlans()
}

async function ctxDelete(): Promise<void> {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (item) await deletePlan(item)
}

async function ctxToggleArchive(): Promise<void> {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (!item) return
  if (item.meta?.archivedAt) {
    await setArchived(item, null) // unarchive — reversible, no confirm
    return
  }
  const ok = await confirm(t('pane.plans.archive-confirm', { name: item.meta?.name ?? item.name }), {
    title: t('pane.plans.archive'),
    confirmText: t('pane.plans.archive'),
  })
  if (!ok) return
  await setArchived(item, new Date().toISOString())
}

// ── Promote doc → plan ────────────────────────────────────────────────────
// HTML docs get a `plan-meta` island injected; markdown docs get a YAML
// frontmatter block prepended (body preserved byte-for-byte). Both start at
// `stage: draft` with empty todos/reviewNotes.

/** First non-heading paragraph of a markdown doc, whitespace-collapsed, or ''. */
function firstMarkdownParagraph(md: string): string {
  for (const block of md.split(/\n\s*\n/)) {
    const text = block.trim()
    if (!text || text.startsWith('#')) continue
    return text.replace(/\s+/g, ' ')
  }
  return ''
}

/** Build the upgraded content for a doc, or null when it is already a plan. */
function upgradedContent(relPath: string, name: string, content: string): string | null {
  if (relPath.endsWith('.html')) {
    if (parseHtmlPlanMeta(content)) return null // already a plan
    const title = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim()
    const meta: HtmlPlanMeta = {
      schemaVersion: 1,
      name: title || name,
      overview: '',
      stage: 'draft',
      approvedAt: null,
      todos: [],
      reviewNotes: [],
    }
    return injectPlanMeta(content, meta)
  }
  // Markdown doc: prepend frontmatter, keeping the original body verbatim.
  if (parsePlanMeta(content)) return null // already has frontmatter
  const title = content.match(/^#\s+(.+)$/m)?.[1].trim() || name.replace(/\.(?:plan\.md|md)$/, '')
  const meta: PlanMeta = {
    schemaVersion: 1,
    format: 'markdown',
    name: title,
    overview: firstMarkdownParagraph(content),
    stage: 'draft',
    approvedAt: null,
    todos: [],
    reviewNotes: [],
    isProject: false,
  }
  // writePlanMeta needs an existing frontmatter block; a synthetic empty one
  // makes it serialize our meta and keep `content` as the preserved body.
  return writePlanMeta(meta, `---\n---\n${content}`)
}

async function ctxUpgradeToPlan(): Promise<void> {
  const item = ctxMenu.value.item
  closeCtxMenu()
  if (!item) return
  const read = await props.backend.send<{ ok: boolean; content?: string; error?: string }>('fs.read_file', {
    workspace_path: planRoot.value,
    rel_path: item.relPath,
  })
  if (!read.payload?.ok || read.payload.content === undefined) {
    toast(read.payload?.error ?? t('pane.plans.upgrade-failed'), { type: 'error' })
    return
  }
  const next = upgradedContent(item.relPath, item.name, read.payload.content)
  if (next === null) {
    // Already a plan (e.g. promoted externally since the last refresh).
    await loadPlans()
    return
  }
  const resp = await props.backend.send<{ ok: boolean; error?: string }>('fs.write_file', {
    workspace_path: planRoot.value,
    rel_path: item.relPath,
    content: next,
  })
  if (!resp.payload?.ok) {
    toast(resp.payload?.error ?? t('pane.plans.upgrade-failed'), { type: 'error' })
    return
  }
  toast(t('pane.plans.upgrade-success'), { type: 'success' })
  await loadPlans()
}
</script>

<template>
  <div class="plans-pane">
    <header class="plans-head">
      <div>
        <div class="plans-title">{{ t('pane.plans.title') }}</div>
      </div>
      <button class="plans-icon-btn" :title="t('pane.plans.refresh')" @click="loadPlans">↻</button>
    </header>

    <div v-if="loading" class="plans-muted">
      {{ waitingForBackend ? t('pane.plans.waiting-backend') : t('pane.plans.loading') }}
    </div>
    <div v-else-if="error" class="plans-error">{{ error }}</div>

    <template v-else>
      <div v-if="!plans.length" class="plans-empty">{{ t('pane.plans.empty-all') }}</div>
      <template v-else>
      <div class="plans-toolbar">
        <div class="plans-search">
          <input
            v-model="searchQuery"
            class="plans-search-input"
            type="text"
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
          >
            <option value="all">{{ t('pane.plans.filter-all-stages') }}</option>
            <option value="draft">{{ t('pane.plans.stage-draft') }}</option>
            <option value="in-review">{{ t('pane.plans.stage-in-review') }}</option>
            <option value="approved">{{ t('pane.plans.stage-approved') }}</option>
            <option value="in-progress">{{ t('pane.plans.stage-in-progress') }}</option>
            <option value="done">{{ t('pane.plans.stage-done') }}</option>
            <option value="abandoned">{{ t('pane.plans.stage-abandoned') }}</option>
          </select>
          <select
            :value="sortMode"
            class="plans-select plans-sort-select"
            :title="t('pane.plans.sort-by')"
            :aria-label="t('pane.plans.sort-by')"
            @change="onSortModeChange"
          >
            <option value="title">{{ t('pane.plans.sort-title') }}</option>
            <option value="updated">{{ t('pane.plans.sort-updated') }}</option>
            <option value="progress">{{ t('pane.plans.sort-progress') }}</option>
          </select>
          <button
            class="plans-toggle-btn plans-sort-dir"
            type="button"
            :title="sortDirection === 'asc' ? t('pane.plans.sort-asc') : t('pane.plans.sort-desc')"
            :aria-label="sortDirection === 'asc' ? t('pane.plans.sort-asc') : t('pane.plans.sort-desc')"
            @click="toggleSortDirection"
          >{{ sortDirection === 'asc' ? '↑' : '↓' }}</button>
          <button
            class="plans-toggle-btn plans-group-toggle"
            type="button"
            :class="{ 'plans-toggle-btn--on': groupMode === 'stage' }"
            :title="groupMode === 'stage' ? t('pane.plans.group-stage') : t('pane.plans.group-flat')"
            :aria-label="groupMode === 'stage' ? t('pane.plans.group-stage') : t('pane.plans.group-flat')"
            :aria-pressed="groupMode === 'stage'"
            @click="toggleGroupMode"
          >☰</button>
        </div>
      </div>
      <div v-if="noVisibleResults" class="plans-empty">{{ t('pane.plans.search-no-results') }}</div>

      <section v-if="recentRows.length" class="plans-section">
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
          <span>{{ recentRows.length }}</span>
        </div>
        <template v-if="!isSectionCollapsed('recent')">
          <div
            v-for="row in recentRows"
            :key="row.item.relPath"
            class="plan-row plan-row--compact"
            role="button"
            tabindex="0"
            draggable="true"
            @dragstart="onPlanRowDragStart($event, row.item.relPath, row.meta?.name ?? row.item.name, row.meta?.overview)"
            @click="openPlan(row.item)"
            @keydown.enter.prevent="openPlan(row.item)"
            @keydown.space.prevent="openPlan(row.item)"
            @contextmenu.prevent="openCtxMenu($event, row.item)"
          >
            <span class="plan-row-name" v-truncate>{{ row.meta?.name ?? row.item.name }}</span>
            <span v-if="row.meta" class="plan-chip" :class="`plan-chip--stage-${row.meta.stage}`">
              {{ row.meta.stage }}
            </span>
            <span
              v-if="row.awaiting > 0"
              class="plan-chip plan-chip--awaiting"
              :title="t('pane.plans.awaiting-you-title')"
            >
              {{ t('pane.plans.awaiting-you', { count: row.awaiting }) }}
            </span>
            <span v-else class="plan-chip">{{ t('pane.plans.doc-badge') }}</span>
            <button
              class="plan-row-pin"
              type="button"
              :class="{ 'plan-row-pin--on': isPinned(row.item.relPath) }"
              :title="isPinned(row.item.relPath) ? t('pane.plans.unpin') : t('pane.plans.pin')"
              :aria-label="isPinned(row.item.relPath) ? t('pane.plans.unpin') : t('pane.plans.pin')"
              :aria-pressed="isPinned(row.item.relPath)"
              @click.stop="togglePin(row.item.relPath)"
              @keydown.enter.stop
              @keydown.space.stop
            >📌</button>
          </div>
        </template>
      </section>

      <section v-if="showFlatSection" class="plans-section">
        <div
          class="plans-section-head"
          role="button"
          tabindex="0"
          @click="toggleSection('all')"
          @keydown.enter.prevent="toggleSection('all')"
          @keydown.space.prevent="toggleSection('all')"
        >
          <span class="plans-section-title">
            <span class="plans-section-chevron" :class="{ collapsed: isSectionCollapsed('all') }">▾</span>
            {{ t('pane.plans.section-all') }}
          </span>
          <span>{{ flatRows.length }}</span>
        </div>
        <template v-if="!isSectionCollapsed('all')">
          <div
            v-for="row in flatRows"
            :key="row.item.relPath"
            class="plan-row"
            :class="{ 'plan-row--done': row.meta?.stage === 'done' || row.meta?.stage === 'abandoned' }"
            role="button"
            tabindex="0"
            draggable="true"
            @dragstart="onPlanRowDragStart($event, row.item.relPath, row.meta?.name ?? row.item.name, row.meta?.overview)"
            @click="openPlan(row.item)"
            @keydown.enter.prevent="openPlan(row.item)"
            @keydown.space.prevent="openPlan(row.item)"
            @contextmenu.prevent="openCtxMenu($event, row.item)"
          >
            <span class="plan-row-name" v-truncate>{{ row.meta?.name ?? row.item.name }}</span>
            <span v-if="row.meta?.overview" class="plan-row-overview" v-truncate>{{ row.meta.overview }}</span>
            <span class="plan-row-path" v-truncate>{{ row.item.relPath }}</span>
            <span class="plan-row-meta">
              <span v-if="row.meta" class="plan-row-progress">
                <span
                  v-if="row.total > 0"
                  class="plan-progress-bar"
                  :class="`plan-progress-bar--${row.meta.stage}`"
                  role="progressbar"
                  aria-valuemin="0"
                  :aria-valuenow="row.done"
                  :aria-valuemax="row.total"
                  :aria-label="t('pane.plans.progress-done', { done: row.done, total: row.total })"
                >
                  <span class="plan-progress-fill" :style="{ width: progressPercent(row.done, row.total) }" />
                </span>
                <span>{{ t('pane.plans.progress-done', { done: row.done, total: row.total }) }}</span>
              </span>
              <span v-else>
                {{ row.item.name.endsWith('.html') ? t('pane.plans.format-html') : t('pane.plans.format-markdown') }}
              </span>
              <span v-if="row.meta" class="plan-chip" :class="`plan-chip--stage-${row.meta.stage}`">
                {{ row.meta.stage }}
              </span>
              <span
                v-if="row.awaiting > 0"
                class="plan-chip plan-chip--awaiting"
                :title="t('pane.plans.awaiting-you-title')"
              >
                {{ t('pane.plans.awaiting-you', { count: row.awaiting }) }}
              </span>
              <span v-else class="plan-chip">{{ t('pane.plans.doc-badge') }}</span>
            </span>
            <button
              class="plan-row-delete"
              type="button"
              :title="t('pane.plans.menu-delete')"
              :aria-label="t('pane.plans.menu-delete')"
              @click.stop="deletePlan(row.item)"
              @keydown.enter.stop
              @keydown.space.stop
            >✕</button>
          </div>
          <div v-if="!flatRows.length" class="plans-empty">{{ t('pane.plans.empty-flat') }}</div>
        </template>
      </section>

      <section v-if="showDocsSection" class="plans-section">
        <div
          class="plans-section-head"
          role="button"
          tabindex="0"
          @click="toggleSection('active')"
          @keydown.enter.prevent="toggleSection('active')"
          @keydown.space.prevent="toggleSection('active')"
        >
          <span class="plans-section-title">
            <span class="plans-section-chevron" :class="{ collapsed: isSectionCollapsed('active') }">▾</span>
            {{ t('pane.plans.section-active') }}
          </span>
          <span>{{ visibleDocItems.length }}</span>
        </div>
        <template v-if="!isSectionCollapsed('active')">
          <div
            v-for="item in visibleDocItems"
            :key="item.relPath"
            class="plan-row"
            role="button"
            tabindex="0"
            draggable="true"
            @dragstart="onPlanRowDragStart($event, item.relPath, item.name)"
            @click="openPlan(item)"
            @keydown.enter.prevent="openPlan(item)"
            @keydown.space.prevent="openPlan(item)"
            @contextmenu.prevent="openCtxMenu($event, item)"
          >
            <span class="plan-row-name" v-truncate>{{ item.name }}</span>
            <span class="plan-row-path" v-truncate>{{ item.relPath }}</span>
            <span class="plan-row-meta">
              <span>{{ item.name.endsWith('.html') ? t('pane.plans.format-html') : t('pane.plans.format-markdown') }}</span>
              <span class="plan-chip">{{ t('pane.plans.doc-badge') }}</span>
            </span>
            <button
              class="plan-row-delete"
              type="button"
              :title="t('pane.plans.menu-delete')"
              :aria-label="t('pane.plans.menu-delete')"
              @click.stop="deletePlan(item)"
              @keydown.enter.stop
              @keydown.space.stop
            >✕</button>
          </div>
          <div v-if="!visibleDocItems.length" class="plans-empty">{{ t('pane.plans.empty-active') }}</div>
        </template>
      </section>

      <section v-for="group in stageGroups" :key="group.key" class="plans-section">
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
          <span>{{ group.rows.length }}</span>
        </div>
        <template v-if="!isSectionCollapsed(group.key)">
          <div
            v-for="row in group.rows"
            :key="row.item.relPath"
            class="plan-row"
            :class="{ 'plan-row--done': group.finished }"
            role="button"
            tabindex="0"
            draggable="true"
            @dragstart="onPlanRowDragStart($event, row.item.relPath, row.meta.name, row.meta.overview)"
            @click="openPlan(row.item)"
            @keydown.enter.prevent="openPlan(row.item)"
            @keydown.space.prevent="openPlan(row.item)"
            @contextmenu.prevent="openCtxMenu($event, row.item)"
          >
            <span class="plan-row-name" v-truncate>{{ row.meta.name }}</span>
            <span v-if="row.meta.overview" class="plan-row-overview" v-truncate>{{ row.meta.overview }}</span>
            <span class="plan-row-path" v-truncate>{{ row.item.relPath }}</span>
            <span class="plan-row-meta">
              <span class="plan-row-progress">
                <span
                  v-if="row.total > 0"
                  class="plan-progress-bar"
                  :class="`plan-progress-bar--${row.meta.stage}`"
                  role="progressbar"
                  aria-valuemin="0"
                  :aria-valuenow="row.done"
                  :aria-valuemax="row.total"
                  :aria-label="t('pane.plans.progress-done', { done: row.done, total: row.total })"
                >
                  <span class="plan-progress-fill" :style="{ width: progressPercent(row.done, row.total) }" />
                </span>
                <span>{{ t('pane.plans.progress-done', { done: row.done, total: row.total }) }}</span>
              </span>
              <span class="plan-chip" :class="`plan-chip--stage-${row.meta.stage}`">{{ row.meta.stage }}</span>
              <span v-if="row.awaiting > 0" class="plan-chip plan-chip--awaiting" :title="t('pane.plans.awaiting-you-title')">{{ t('pane.plans.awaiting-you', { count: row.awaiting }) }}</span>
            </span>
            <button
              class="plan-row-delete"
              type="button"
              :title="t('pane.plans.menu-delete')"
              :aria-label="t('pane.plans.menu-delete')"
              @click.stop="deletePlan(row.item)"
              @keydown.enter.stop
              @keydown.space.stop
            >✕</button>
          </div>
        </template>
      </section>

      <section v-if="archivedRows.length" class="plans-section">
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
          <span>{{ archivedRows.length }}</span>
        </div>
        <template v-if="!isSectionCollapsed('archived')">
          <div
            v-for="row in archivedRows"
            :key="row.item.relPath"
            class="plan-row plan-row--done"
            role="button"
            tabindex="0"
            draggable="true"
            @dragstart="onPlanRowDragStart($event, row.item.relPath, row.meta.name, row.meta.overview)"
            @click="openPlan(row.item)"
            @keydown.enter.prevent="openPlan(row.item)"
            @keydown.space.prevent="openPlan(row.item)"
            @contextmenu.prevent="openCtxMenu($event, row.item)"
          >
            <span class="plan-row-name" v-truncate>{{ row.meta.name }}</span>
            <span v-if="row.meta.overview" class="plan-row-overview" v-truncate>{{ row.meta.overview }}</span>
            <span class="plan-row-path" v-truncate>{{ row.item.relPath }}</span>
            <span class="plan-row-meta">
              <span class="plan-row-progress">
                <span
                  v-if="row.total > 0"
                  class="plan-progress-bar"
                  :class="`plan-progress-bar--${row.meta.stage}`"
                  role="progressbar"
                  aria-valuemin="0"
                  :aria-valuenow="row.done"
                  :aria-valuemax="row.total"
                  :aria-label="t('pane.plans.progress-done', { done: row.done, total: row.total })"
                >
                  <span class="plan-progress-fill" :style="{ width: progressPercent(row.done, row.total) }" />
                </span>
                <span>{{ t('pane.plans.progress-done', { done: row.done, total: row.total }) }}</span>
              </span>
              <span class="plan-row-chips">
                <span class="plan-chip" :class="`plan-chip--stage-${row.meta.stage}`">{{ row.meta.stage }}</span>
                <span v-if="row.awaiting > 0" class="plan-chip plan-chip--awaiting" :title="t('pane.plans.awaiting-you-title')">{{ t('pane.plans.awaiting-you', { count: row.awaiting }) }}</span>
                <span class="plan-chip plan-chip--archived">{{ t('pane.plans.archived') }}</span>
              </span>
            </span>
            <button
              class="plan-row-delete"
              type="button"
              :title="t('pane.plans.menu-delete')"
              :aria-label="t('pane.plans.menu-delete')"
              @click.stop="deletePlan(row.item)"
              @keydown.enter.stop
              @keydown.space.stop
            >✕</button>
          </div>
        </template>
      </section>

      <section v-if="!noVisibleResults && (archivableDone.length || deletablePlans.length)" class="plans-section">
        <div class="plans-section-head">
          <span>{{ t('pane.plans.section-completed') }}</span>
          <span class="plans-head-actions">
            <button
              class="plans-link-btn"
              :disabled="!archivableDone.length"
              @click="archiveAllDone"
            >{{ t('pane.plans.archive-all-done') }}</button>
            <button
              class="plans-link-btn"
              :disabled="!deletablePlans.length"
              @click="deleteCompleted"
            >{{ t('pane.plans.delete-all') }}</button>
          </span>
        </div>
      </section>
      </template>
    </template>

    <template v-if="ctxMenu.show && ctxMenu.item">
      <div class="ctx-backdrop" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
      <div ref="ctxMenuEl" class="ctx-menu" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button class="menu-item" @click="ctxOpen">{{ t('pane.plans.menu-open') }}</button>
        <button class="menu-item" @click="ctxCopyPath">{{ t('action.copy-path') }}</button>
        <template v-if="isHtmlItem(ctxMenu.item)">
          <button class="menu-item" @click="ctxShareToGit">{{ t('pane.plans.share-git') }}</button>
          <button class="menu-item" @click="ctxRename">{{ t('pane.plans.menu-rename') }}</button>
        </template>
        <button v-if="ctxMenu.item.meta" class="menu-item" @click="ctxToggleArchive">
          {{ ctxMenu.item.meta.archivedAt ? t('pane.plans.unarchive') : t('pane.plans.archive') }}
        </button>
        <template v-if="!ctxMenu.item.meta">
          <div class="menu-sep" />
          <button class="menu-item" @click="ctxUpgradeToPlan">{{ t('pane.plans.menu-upgrade') }}</button>
        </template>
        <div class="menu-sep" />
        <button class="menu-item danger" @click="ctxDelete">{{ t('pane.plans.menu-delete') }}</button>
      </div>
    </template>

    <template v-if="renameTarget">
      <div class="ctx-backdrop" @click="cancelRename" />
      <div class="rename-dialog">
        <div class="rename-title">{{ t('pane.plans.rename-title') }}</div>
        <input
          ref="renameInput"
          v-model="renameValue"
          class="rename-input"
          :placeholder="t('pane.plans.rename-placeholder')"
          @keydown.enter="onRenameEnter"
          @keydown.escape="cancelRename"
        />
        <div class="rename-hint">{{ t('pane.plans.rename-hint') }}</div>
        <div class="rename-actions">
          <button class="rename-btn" @click="cancelRename">{{ t('pane.plans.rename-cancel') }}</button>
          <button class="rename-btn rename-btn--primary" @click="submitRename">
            {{ t('pane.plans.rename-confirm') }}
          </button>
        </div>
      </div>
    </template>

    <template v-if="quickOpenActive">
      <div class="ctx-backdrop" @click="closeQuickOpen" />
      <div class="quick-open">
        <input
          ref="quickOpenInput"
          v-model="quickOpenQuery"
          class="rename-input"
          :placeholder="t('pane.plans.quick-open-placeholder')"
          @keydown.down.prevent="moveQuickOpen(1)"
          @keydown.up.prevent="moveQuickOpen(-1)"
          @keydown.enter.prevent="confirmQuickOpen"
          @keydown.escape="closeQuickOpen"
        />
        <div v-if="!quickOpenRows.length" class="quick-open-empty">
          {{ t('pane.plans.search-no-results') }}
        </div>
        <div
          v-for="(row, i) in quickOpenRows"
          :key="row.item.relPath"
          class="quick-open-row"
          :class="{ 'quick-open-row--active': i === quickOpenIndex }"
          @mousemove="quickOpenIndex = i"
          @click="confirmQuickOpen"
        >
          <span class="plan-row-name" v-truncate>{{ row.meta?.name ?? row.item.name }}</span>
          <span v-if="row.meta" class="plan-chip" :class="`plan-chip--stage-${row.meta.stage}`">
            {{ row.meta.stage }}
          </span>
          <span
            v-if="row.awaiting > 0"
            class="plan-chip plan-chip--awaiting"
            :title="t('pane.plans.awaiting-you-title')"
          >
            {{ t('pane.plans.awaiting-you', { count: row.awaiting }) }}
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.plans-pane {
  background: var(--bg-base);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  font-size: var(--font-xs);
  height: 100%;
  overflow-y: auto;
}

.plans-head {
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  gap: 8px;
  justify-content: space-between;
  padding: 12px;
}

.plans-title {
  font-size: var(--font-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.plans-toolbar {
  border-bottom: 1px solid var(--border-subtle);
  display: grid;
  gap: 6px;
  padding: 8px 12px;
}

.plans-search {
  position: relative;
}

.plans-search-input {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  box-sizing: border-box;
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 4px 24px 4px 8px;
  width: 100%;
}

.plans-search-input:focus-visible, .plans-select:focus-visible, .plans-toggle-btn:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }

.plans-search-input:focus {
  border-color: var(--accent-focus);
  outline: none;
}

.plans-search-clear {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: var(--font-2xs);
  height: 18px;
  justify-content: center;
  padding: 0;
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
}

.plans-search-clear:hover {
  color: var(--text-primary);
}

.plans-toolbar-row {
  display: flex;
  gap: 6px;
}

.plans-select {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  flex: 1;
  font-size: var(--font-2xs);
  min-width: 0;
  padding: 3px 4px;
}

/* Square toggles (sort direction, grouping) sitting next to the selects —
   fixed width so the two selects keep the rest of the row. */
.plans-toggle-btn {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  flex: 0 0 auto;
  font-size: var(--font-2xs);
  line-height: 1;
  padding: 3px 7px;
}

.plans-toggle-btn:hover {
  color: var(--text-primary);
}

.plans-toggle-btn--on {
  border-color: var(--accent-focus);
  background: var(--accent-subtle);
  color: var(--text-bright);
}

.plans-icon-btn,
.plans-link-btn {
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-xs);
  padding: 3px 7px;
}

.plans-link-btn {
  border: none;
  padding: 0;
}

.plans-link-btn:disabled {
  cursor: default;
  opacity: 0.45;
}

.plans-icon-btn:hover,
.plans-link-btn:not(:disabled):hover {
  color: var(--text-primary);
}

.plans-muted,
.plans-error,
.plans-empty {
  color: var(--text-muted);
  padding: 12px;
}

.plans-error {
  color: var(--danger-fg);
}

.plans-section {
  padding: 10px 8px 4px;
}

.plans-section-head {
  align-items: center;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: var(--font-2xs);
  font-weight: 700;
  justify-content: space-between;
  letter-spacing: 0.05em;
  padding: 0 4px 6px;
  text-transform: uppercase;
  user-select: none;
}

.plans-section-title {
  align-items: center;
  display: flex;
  gap: 5px;
}

.plans-section-chevron {
  display: inline-block;
  font-size: 9px;
  transition: transform 0.12s ease;
}

.plans-section-chevron.collapsed {
  transform: rotate(-90deg);
}

.plan-row {
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
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

.plan-row:hover {
  background: var(--bg-hover);
  border-color: var(--border-subtle);
}

.plan-row:focus-visible {
  border-color: var(--accent-focus);
  outline: 2px solid var(--accent-focus);
  outline-offset: -1px;
}

.plan-row-delete {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  font-size: var(--font-xs);
  height: 20px;
  justify-content: center;
  opacity: 0;
  padding: 0;
  position: absolute;
  right: 6px;
  top: 6px;
  width: 20px;
}

/* The delete button is opacity-hidden (never display:none — that would drop it
   from the tab order) until the row is hovered or holds focus; keep it
   reachable and visible while keyboard-focused. */
.plan-row-delete:focus-visible {
  opacity: 1;
  outline: 2px solid var(--accent-focus);
  outline-offset: -1px;
}

.plan-row:hover .plan-row-delete,
.plan-row:focus-within .plan-row-delete {
  opacity: 1;
}

.plan-row-delete:hover {
  background: var(--bg-hover-strong);
  color: var(--danger-fg);
}

/* Recent/pinned rows are a single line: title, stage, pin toggle. The full row
   (overview, path, progress) stays the job of the list below. */
.plan-row--compact {
  align-items: center;
  display: flex;
  gap: 8px;
  padding-right: 28px;
}

.plan-row--compact .plan-row-name {
  flex: 1;
  min-width: 0;
}

.plan-row-pin {
  align-items: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  cursor: pointer;
  display: flex;
  font-size: var(--font-2xs);
  height: 20px;
  justify-content: center;
  /* Hidden until the row is touched — except when pinned, where it is the
     badge that explains why the row sits at the top. */
  opacity: 0;
  padding: 0;
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
}

.plan-row-pin--on,
.plan-row:hover .plan-row-pin,
.plan-row:focus-within .plan-row-pin {
  opacity: 1;
}

.plan-row-pin:not(.plan-row-pin--on) {
  filter: grayscale(1);
}

.plan-row-pin:focus-visible {
  opacity: 1;
  outline: 2px solid var(--accent-focus);
  outline-offset: -1px;
}

.plan-row-pin:hover {
  background: var(--bg-hover-strong);
}

.plan-row-name {
  color: var(--text-primary);
  font-size: 12.5px;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-row-overview {
  color: var(--text-muted);
  display: -webkit-box;
  font-size: var(--font-2xs);
  line-height: 1.35;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.plan-row-path {
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--font-3xs);
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-row-meta {
  align-items: center;
  color: var(--text-muted);
  display: flex;
  font-size: var(--font-2xs);
  gap: 8px;
  justify-content: space-between;
}

/* Waiting on the user: the one thing in this list nobody else can clear, so it
   reads as an action rather than as another status label. */
.plan-chip--awaiting {
  background: var(--danger-subtle, var(--attention-subtle));
  color: var(--danger-bright, var(--attention-bright));
  text-transform: none;
}

.plan-chip {
  background: var(--attention-subtle);
  border-radius: var(--radius-pill);
  color: var(--attention-bright);
  font-size: var(--font-3xs);
  font-weight: 700;
  padding: 1px 6px;
  text-transform: uppercase;
}

/* Stage chip colors mirror PlanReviewToolbar's .prt-stage--{stage} pill
   palette (same theme variables) — keep the two in sync. An unknown stage
   modifier matches no rule and falls back to the base .plan-chip look. */
.plan-chip--stage-draft {
  background: var(--bg-muted);
  color: var(--text-secondary);
}

.plan-chip--stage-in-review {
  background: var(--attention-subtle);
  color: var(--attention-bright);
}

.plan-chip--stage-approved {
  background: var(--accent-subtle);
  color: var(--accent-fg);
}

.plan-chip--stage-in-progress {
  background: var(--attention-subtle);
  color: var(--warning-fg);
}

.plan-chip--stage-done {
  background: var(--success-subtle);
  color: var(--success-fg);
}

.plan-chip--stage-abandoned {
  background: var(--danger-subtle);
  color: var(--danger-fg);
}

.plan-chip--archived {
  background: var(--bg-muted);
  color: var(--text-muted);
}

.plan-row-chips {
  align-items: center;
  display: flex;
  gap: 6px;
}

.plan-row-progress {
  align-items: center;
  display: flex;
  gap: 6px;
  min-width: 0;
}

.plan-progress-bar {
  background: var(--bg-muted);
  border-radius: var(--radius-pill);
  flex-shrink: 0;
  height: 4px;
  overflow: hidden;
  width: 64px;
}

.plan-progress-fill {
  background: var(--text-secondary);
  border-radius: var(--radius-pill);
  display: block;
  height: 100%;
}

/* Fill colors mirror PlanReviewToolbar's .prt-stage--{stage} pill palette
   (same theme variables) — keep the two in sync. */
.plan-progress-bar--draft > .plan-progress-fill {
  background: var(--text-secondary);
}

.plan-progress-bar--in-review > .plan-progress-fill {
  background: var(--attention-bright);
}

.plan-progress-bar--approved > .plan-progress-fill {
  background: var(--accent-fg);
}

.plan-progress-bar--in-progress > .plan-progress-fill {
  background: var(--warning-fg);
}

.plan-progress-bar--done > .plan-progress-fill {
  background: var(--success-fg);
}

.plan-progress-bar--abandoned > .plan-progress-fill {
  background: var(--danger-fg);
}

.plans-head-actions {
  display: flex;
  gap: 12px;
}

.ctx-backdrop {
  inset: 0;
  position: fixed;
  z-index: 40;
}

.ctx-menu {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  min-width: 180px;
  padding: 4px;
  position: fixed;
  z-index: 41;
}

.ctx-menu .menu-item {
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  cursor: pointer;
  display: block;
  font-size: var(--font-xs);
  padding: 6px 10px;
  text-align: left;
  width: 100%;
}

.ctx-menu .menu-item:hover {
  background: var(--bg-hover);
}

.ctx-menu .menu-item.danger {
  color: var(--danger-fg);
}

.ctx-menu .menu-sep {
  background: var(--border-subtle);
  height: 1px;
  margin: 4px 6px;
}

.rename-dialog {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  left: 50%;
  padding: 14px;
  position: fixed;
  top: 30%;
  transform: translateX(-50%);
  width: min(360px, 90vw);
  z-index: 41;
}

/* Quick open sits where the rename dialog does, sized for a result list. */
.quick-open {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  left: 50%;
  padding: 10px;
  position: fixed;
  top: 18%;
  transform: translateX(-50%);
  width: min(420px, 92vw);
  z-index: 41;
}

.quick-open-row {
  align-items: center;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  gap: 8px;
  margin-top: 2px;
  padding: 5px 8px;
}

.quick-open-row .plan-row-name {
  flex: 1;
  min-width: 0;
}

.quick-open-row--active {
  background: var(--bg-hover-strong);
}

.quick-open-empty {
  color: var(--text-muted);
  font-size: var(--font-2xs);
  padding: 8px;
}

.rename-title {
  font-size: var(--font-xs);
  font-weight: 700;
  margin-bottom: 8px;
}

.rename-input {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 5px 8px;
  width: 100%;
}

.rename-input:focus {
  border-color: var(--accent-focus);
  outline: none;
}

.rename-hint {
  color: var(--text-muted);
  font-size: var(--font-2xs);
  margin-top: 6px;
}

.rename-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 10px;
}

.rename-btn {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-2xs);
  padding: 4px 12px;
}

.rename-btn:hover {
  background: var(--bg-hover-strong);
}

.rename-btn--primary {
  border-color: var(--accent-focus);
}
</style>
