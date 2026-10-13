<script setup lang="ts">
// Plan review window (?window=plans&workspace_path=…): plan list on the left,
// the opened plan document on the right. Plan docs stack the shared review
// toolbar (PlanReviewToolbar, format-agnostic via PlanStore) above a body that
// switches on format: HTML plans render in the interactive srcdoc preview
// (PlanDocPreview, render-time injected runtime); markdown plans render in
// PlanMarkdownBody. Other HTML docs keep the plain sandboxed FilePreviewPane;
// plain markdown (no frontmatter meta) falls back to the read-only PlanFileView.
// Plans only — no file tree, terminal, or git.
import { computed, onBeforeMount, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useBackend } from './composables/useBackend'
import { resolvePlanRoot as resolvePlanRootOperation } from '../plugins/plans/resolvePlanRoot'
import { createHostGitSettingsPort, createHostKeybindingsPort, createHostTerminalDockPort } from './composables/hostSurfacePorts'
import { initSettingsBackend, onSettingsChanged, seedSettings, settingsGet } from '@navide/plugin-ui/shared'
import { i18n, useTheme, vTruncate } from '@navide/plugin-ui/foundation'
import { useNotify } from '@navide/plugin-ui/foundation'
import { resolvePlanStore, type PlanCtx, type WriteResult } from './composables/planStore'
import { sanitizePlanSectionHtml } from './editor/planRuntime'
import { resetUiScale, stepUiScaleBy } from './lib/uiScale'
import PlansPane from './editor/PlansPane.vue'
import WindowControls from './components/WindowControls.vue'
import { needsDrawnWindowControls } from '../../shared/osplat'
import { lastOpenedStorageKey, loadStoredValue, saveStoredChoice } from './editor/plansPaneModel'
import { initKeybindingsPort, useKeybindings, setContext } from '@navide/plugin-ui/shared'
import { registerCommand } from '@navide/plugin-ui/shared'
import PlanReviewToolbar from './editor/PlanReviewToolbar.vue'
import PlanFileView from './editor/PlanFileView.vue'
import PlanMarkdownBody from './editor/PlanMarkdownBody.vue'
import FilePreviewPane from './editor/FilePreviewPane.vue'
import PlanDocPreview from './editor/PlanDocPreview.vue'
import NotificationHost from './components/NotificationHost.vue'
// Shared right-side CLI agent terminal shell (rail toggle + resize + real PTY).
import { AiCliDock } from '@navide/plugin-shell'
import { aiTerminalPaneId, buildPlanCliContext, type PlanCliMetaSummary } from '@navide/plugin-shell'

const params = new URLSearchParams(window.location.search)
const workspacePath = params.get('workspace_path') ?? ''
const workspaceBaseName = workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath
// What this window's title calls the workspace: the alias the user gave it,
// which the Host resolved and passed as `workspace_display_name`, else the
// folder name. A blank or absent param means "no alias" — that is how clearing
// one works. KNOWN LIMITATION: a load-time snapshot. Renaming the workspace
// while this window is open does NOT retitle it; the title is correct again
// the next time the window opens.
const workspaceTitleName = params.get('workspace_display_name')?.trim() || workspaceBaseName
// This window keeps the system's frame on macOS (see drawnFrameWhereNeeded in
// main), so the bar is drawn only where the system draws none. Rendering it on
// macOS would put a second title bar underneath the real one.
const drawsOwnTitleBar = needsDrawnWindowControls()
// Plan to auto-open on mount: the sidebar list clicked a plan, which opened
// this window with the plan carried in the query string.
const initialRelPath = params.get('rel_path') ?? ''
const rawLocale =
  params.get('locale') ??
  (settingsGet<string | null>('agent-team:language', null) as string | null)
const initialLocale = rawLocale === 'zh-TW' || rawLocale === 'en-US' || rawLocale === 'ja-JP' ? rawLocale : null
// Launched without one (Window menu), the window reopens on whichever plan this
// workspace last had open, keyed per workspace like the sidebar's own choices.
const lastOpenedKey = lastOpenedStorageKey(workspacePath)

const backend = useBackend()
const terminalPort = createHostTerminalDockPort(backend)
// Hook the settings cache to this window's own ws connection so theme changes
// made in other windows arrive as ui.settings_changed broadcasts.
initSettingsBackend(createHostGitSettingsPort(backend))
initKeybindingsPort(createHostKeybindingsPort())

// Plan documents live in the project root, which is the workspace itself
// unless the workspace is a subdirectory of the repository holding them (see
// plans.list_docs). Every rel_path in this window is relative to this root, so
// it must be settled before the first document opens — the preview components
// load once and do not re-resolve a changed workspace.
const planRoot = ref(workspacePath)
let pendingPlansChangedRoot: string | null = null
async function resolvePlanRoot(): Promise<void> {
  try {
    const resolvedRoot = await resolvePlanRootOperation(backend, workspacePath)
    planRoot.value = resolvedRoot
    if (pendingPlansChangedRoot === resolvedRoot) {
      planPreviewRefresh.value++
    }
    pendingPlansChangedRoot = null
  } catch {
    pendingPlansChangedRoot = null
    // Keep the workspace as the root: unchanged from the pre-resolution behaviour.
  }
}
const { loadTheme } = useTheme()
const { t, locale } = useI18n()
if (initialLocale) {
  locale.value = initialLocale
  i18n.global.locale.value = initialLocale
  seedSettings({ 'agent-team:language': initialLocale })
}
const { toast, confirm } = useNotify()

const openDoc = ref<{ relPath: string; name: string } | null>(null)
// Read-only history snapshot shown instead of the live plan (Phase C); the
// snapshot preview renders without a toolbar and ignores write interactions.
const snapshotPreview = ref<{ relPath: string; label: string } | null>(null)

// Reviewable plan doc: a non-infrastructure `.agent-team/plans/*.html` sitting
// directly in that directory. The directory may belong to a nested plan root
// (a repository below the workspace), whose documents the list surfaces with
// their root as a path prefix — they get the same review treatment.
function isHtmlPlanDoc(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/') // tolerate Windows separators
  const marker = '.agent-team/plans/'
  const at = normalized.lastIndexOf(marker)
  if (at === -1 || (at > 0 && normalized[at - 1] !== '/')) return false
  const name = normalized.slice(at + marker.length)
  return name.endsWith('.html') && !name.startsWith('_') && !name.includes('/')
}

// Bumped after a plan-meta write; PlanDocPreview reloads in place (keeping
// the reported scroll position) instead of remounting.
const planPreviewRefresh = ref(0)

// Format-agnostic persistence adapter for the open doc; the review toolbar and
// the body write-back below both go through it instead of the backend directly.
// `.html` plans resolve to the HTML store (the only branch that mounts the
// toolbar / interactive preview in this stage).
const planStore = computed(() => resolvePlanStore(openDoc.value?.relPath ?? ''))

const toolbarRef = ref<InstanceType<typeof PlanReviewToolbar> | null>(null)
const previewRef = ref<InstanceType<typeof PlanDocPreview> | null>(null)
const mdBodyRef = ref<InstanceType<typeof PlanMarkdownBody> | null>(null)
const plansPaneRef = ref<InstanceType<typeof PlansPane> | null>(null)

// For an open markdown doc: 'loading' while probing frontmatter, then 'plan'
// (carries valid plan meta → shared review toolbar + PlanMarkdownBody) or 'doc'
// (plain markdown with no meta → legacy read-only PlanFileView, no toolbar).
// HTML docs route by path (isHtmlPlanDoc) and never consult this.
const mdKind = ref<'loading' | 'plan' | 'doc'>('loading')

function isMarkdownDoc(relPath: string): boolean {
  return !relPath.endsWith('.html')
}

// Probe the markdown doc's meta once per open: a valid frontmatter plan mounts
// the toolbar, a plain markdown file stays a read-only doc. Re-probing is not
// needed on live refresh — a plain .md does not gain frontmatter from in-window
// actions, and legacy .plan.md already carry frontmatter from the first read.
async function probeMarkdownKind(relPath: string): Promise<void> {
  mdKind.value = 'loading'
  let result: Awaited<ReturnType<ReturnType<typeof resolvePlanStore>['readMeta']>>
  try {
    result = await resolvePlanStore(relPath).readMeta(planCtx(relPath))
  } catch {
    // Transport down mid-probe. The rejection used to escape here, leaving the
    // doc on 'loading' forever with nothing to re-probe it — a markdown plan
    // opened while the backend was away simply spun for the rest of the
    // session. Stay on 'loading' (the answer is genuinely unknown; calling it a
    // plain doc would drop the review toolbar off a real plan) and retry when
    // the backend is back.
    pendingMarkdownProbe = relPath
    return
  }
  pendingMarkdownProbe = ''
  if (openDoc.value?.relPath !== relPath) return // superseded by a newer open
  mdKind.value = result ? 'plan' : 'doc'
}

/** A meta probe that could not reach the backend, retried on reconnect. */
let pendingMarkdownProbe = ''
/** A restore-on-open that could not verify the stored plan, same deal. */
let pendingInitialOpen = ''

watch(
  () => backend.status.value,
  (s) => {
    if (s !== 'connected') return
    if (pendingMarkdownProbe) {
      const relPath = pendingMarkdownProbe
      pendingMarkdownProbe = ''
      if (openDoc.value?.relPath === relPath) void probeMarkdownKind(relPath)
    }
    if (pendingInitialOpen) {
      pendingInitialOpen = ''
      if (!openDoc.value) void openInitialDoc()
    }
  }
)

function onOpenFile(payload: { filepath: string; name: string }): void {
  openDoc.value = { relPath: payload.filepath, name: payload.name }
  snapshotPreview.value = null
  saveStoredChoice(lastOpenedKey, payload.filepath)
  // Keep the sidebar's Recent section in step with opens it did not originate
  // (launch path, plan:open-doc switch, the restore above).
  plansPaneRef.value?.noteOpened?.(payload.filepath)
  if (isMarkdownDoc(payload.filepath)) void probeMarkdownKind(payload.filepath)
}

// Open a plan by its workspace-relative path (auto-open on mount, or when an
// already-open window is asked to switch plans via the plan:open-doc IPC).
function openRelPath(relPath: string): void {
  if (!relPath) return
  onOpenFile({ filepath: relPath, name: relPath.split('/').pop() ?? relPath })
}

// Open what this window was launched for; with no rel_path in the query string
// fall back to the plan this workspace last had open. A stored plan that has
// since been deleted or renamed is dropped silently — opening the window onto
// an error is worse than opening it empty.
async function openInitialDoc(): Promise<void> {
  if (initialRelPath) {
    openRelPath(initialRelPath)
    return
  }
  const stored = loadStoredValue(lastOpenedKey)
  if (!stored) return
  const exists = await planDocExists(stored)
  if (exists === false) return
  if (exists === null) {
    // Could not ask. Treating that as "gone" silently dropped the plan the user
    // had open and brought the window up empty for no visible reason, so hold
    // the restore and try again once the backend answers.
    pendingInitialOpen = stored
    return
  }
  // The list was interactive during the existence check; a plan opened in the
  // meantime (click, or a plan:open-doc switch) wins over the restore.
  if (openDoc.value) return
  openRelPath(stored)
}

/** true = present, false = definitely absent, null = could not ask. */
async function planDocExists(relPath: string): Promise<boolean | null> {
  try {
    const res = await backend.send<{ ok: boolean; exists?: boolean }>('fs.stat_path', {
      path: `${planRoot.value}/${relPath}`,
    })
    return res.payload?.exists === true
  } catch {
    return null
  }
}

// A plan deleted from the list clears the right pane when it's the open one.
function onPlanDeleted(relPath: string): void {
  if (openDoc.value?.relPath === relPath) {
    openDoc.value = null
    snapshotPreview.value = null
  }
}

function onPreviewSnapshot(payload: { relPath: string; label: string }): void {
  snapshotPreview.value = payload
}

function closeSnapshotPreview(): void {
  snapshotPreview.value = null
}

// file:line references clicked inside the plan document (validated by the
// runtime protocol) open the editor window at that line.
type AgentApi = { openEditorWindow?: (a: Record<string, unknown>) => Promise<unknown> }
function onOpenCode(payload: { path: string; line: number }): void {
  const api = (window as Window & { agentTeam?: AgentApi }).agentTeam
  if (!api?.openEditorWindow) return
  void api.openEditorWindow({
    workspace_path: workspacePath,
    filepath: payload.path,
    line: payload.line,
  })
}

// In-document interactions, already validated by PlanDocPreview against the
// whitelist protocol, are routed through the toolbar's existing write paths.
function onDocTodoClicked(payload: { todoId: string; alt: boolean }): void {
  const toolbar = toolbarRef.value
  if (!toolbar) return
  if (payload.alt) void toolbar.toggleSkipTodo(payload.todoId)
  else void toolbar.cycleTodo(payload.todoId)
}

function onDocSectionComment(anchor: string): void {
  toolbarRef.value?.startNoteWithAnchor(anchor)
}

// Only one body is mounted per doc (HTML preview or markdown body); scrolling
// the null one is a no-op, so route the toolbar's outline pick to both.
function onOutlineScroll(anchor: string): void {
  previewRef.value?.scrollToAnchor(anchor)
  mdBodyRef.value?.scrollToAnchor(anchor)
}

// Body write-back for inline section edit/delete now goes through the store's
// replaceSectionBody / deleteSection, which mirror the toolbar's optimistic
// lock (re-read fresh content + mtime, apply the byte-surgical mutation to the
// fresh bytes preserving concurrent agent edits, write with expected_mtime,
// retry once on a conflict; a mutation that leaves the content unchanged is a
// silent no-op success). The host still sanitizes untrusted frame HTML first.
function planCtx(relPath: string): PlanCtx {
  return { backend, workspacePath: planRoot.value, relPath }
}

function applyBodyWriteResult(result: WriteResult): void {
  if (result.ok) {
    planPreviewRefresh.value++
    return
  }
  if (result.conflict) {
    toast(t('pane.plans.review-save-failed'))
    return
  }
  toast(result.error ?? t('pane.plans.review-save-failed'))
}

// Inline section edit: sanitize the untrusted frame HTML host-side, then
// replace only that section's prose body (never plan-meta/header/todos).
async function onSectionEdit(payload: { anchor: string; html: string }): Promise<void> {
  const relPath = openDoc.value?.relPath
  if (!relPath) return
  const sanitized = sanitizePlanSectionHtml(payload.html)
  const result = await planStore.value.replaceSectionBody(planCtx(relPath), payload.anchor, {
    kind: 'html',
    sanitized,
  })
  applyBodyWriteResult(result)
}

async function onSectionDelete(anchor: string): Promise<void> {
  const relPath = openDoc.value?.relPath
  if (!relPath) return
  const ok = await confirm(t('pane.plans.doc-delete-confirm'), {
    title: t('pane.plans.delete'),
    confirmText: t('pane.plans.delete'),
  })
  if (!ok) return
  const result = await planStore.value.deleteSection(planCtx(relPath), anchor)
  applyBodyWriteResult(result)
}

useKeybindings()
// Window identity, the same way GitWindowApp declares `gitWindow`: it gates the
// ESC rule below, which must not fire in the windows that have their own.
setContext('planWindow', true)

// Quick open (⌘P), from the shared rule table like every other window. Handlers
// that return false do not consume the event, which is how the CLI dock keeps
// its own ⌘P: the PTY owns every key while focus is inside it.
registerCommand('workbench.action.quickOpen', () => {
  if (document.activeElement?.closest('.ai-dock-panel')) return false
  void plansPaneRef.value?.openQuickOpen?.()
  return undefined
})

// ⌘⇧W. This window has no unsaved-buffer state of its own — an in-flight
// section edit is cancelled through ESC below — so it closes outright.
registerCommand('workbench.action.closeWindow', () => { window.close() })
// ⇧⌘R. Same reasoning: plans live on disk, so a reload costs nothing but an
// in-progress section edit, which ESC discards anyway.
registerCommand('workbench.action.reloadWindow', () => { location.reload() })

// ⇧⌘=/⇧⌘-/⇧⌘0. Interface zoom is app-wide: main applies the new factor to
// every window, so scaling from here moves the main shell too.
registerCommand('workbench.action.zoomUiIn',    () => { stepUiScaleBy(1) })
registerCommand('workbench.action.zoomUiOut',   () => { stepUiScaleBy(-1) })
registerCommand('workbench.action.zoomUiReset', () => { resetUiScale() })

// ESC, bound centrally as closeModal on `planWindow` (keybindings/defaults.ts).
//
// The priority walk stays here rather than becoming five bindings: each step is
// internal window state, and only the last one — closing the window — is a
// decision the user could reasonably want on a different key. That one already
// has its own command (⌘⇧W above); this is the same action reached by falling
// through everything nearer.
//
// Order: an in-frame section edit (only when focus is outside the frame —
// inside it the srcdoc runtime handles ESC and it never reaches us), then the
// plan list's context menu / rename input, then an unsent review note, then a
// read-only snapshot; otherwise close the window.
registerCommand('workbench.action.closeModal', () => {
  if (previewRef.value?.isEditing?.()) {
    previewRef.value.cancelEdit()
    return
  }
  // Markdown body's inline section edit — same priority as the HTML preview's
  // in-frame edit (only one body is ever mounted).
  if (mdBodyRef.value?.isEditing?.()) {
    mdBodyRef.value.cancelEdit()
    return
  }
  if (plansPaneRef.value?.closeActiveOverlay?.()) return
  if (toolbarRef.value?.closeActiveOverlay?.()) return
  if (snapshotPreview.value) {
    closeSnapshotPreview()
    return
  }
  window.close()
})

// Pane id for the CLI dock, derived per (surface, workspace): Plan windows for
// different workspaces coexist, and a shared fixed id would let one window's
// reattach steal — and its Start reap — another's running CLI (see
// aiTerminalPaneId). workspacePath is fixed at window creation, so this is
// stable for the window's life.
const AI_PANE_ID = aiTerminalPaneId('plan', workspacePath)

// Context payload the CLI dock injects after a fresh spawn: the open plan
// document (path + plan-meta summary + truncated content) and the workspace.
// Reads through the same store the toolbar uses, so the snapshot is fresh at
// injection time; a plain doc without plan meta still injects its raw content.
async function buildPlanContext(): Promise<string> {
  const relPath = openDoc.value?.relPath ?? null
  let meta: PlanCliMetaSummary | null = null
  let content: string | null = null
  if (relPath) {
    const read = await resolvePlanStore(relPath).readMeta(planCtx(relPath)).catch(() => null)
    if (read) {
      meta = {
        name: read.meta.name,
        stage: read.meta.stage,
        todoStatuses: read.meta.todos.map((todo) => todo.status),
      }
      content = read.raw
    } else {
      const resp = await backend
        .send<{ ok: boolean; content?: string }>('fs.read_file', {
          workspace_path: planRoot.value,
          rel_path: relPath,
        })
        .catch(() => null)
      content = resp?.payload?.ok ? (resp.payload.content ?? null) : null
    }
  }
  return buildPlanCliContext({ workspacePath: planRoot.value, relPath, meta, content })
}

let offSettingsChange: (() => void) | null = null
let offPlansChanged: (() => void) | null = null
let offPlanOpenDoc: (() => void) | null = null

// Live refresh: subscribe before child mounts start their initial list calls.
// The packaged resolver emits its first plans.changed event immediately after
// resolving the root, so registering in onMounted can miss that event.
onBeforeMount(() => {
  offPlansChanged = backend.on('plans.changed', (payload) => {
    const p = payload as { workspace_path?: unknown } | null
    const changedWorkspace = p?.workspace_path
    if (typeof changedWorkspace !== 'string') return
    // The watcher reports the path it was started on — the resolved root once
    // any plan surface has listed this workspace. The packaged resolver sends
    // its response and event back-to-back, so retain one unmatched root until
    // the response continuation publishes planRoot.
    if (changedWorkspace === workspacePath || changedWorkspace === planRoot.value) {
      planPreviewRefresh.value++
    } else {
      pendingPlansChangedRoot = changedWorkspace
    }
  })
})

onMounted(() => {
  document.title = `${workspaceTitleName} — Plans`
  loadTheme()
  offSettingsChange = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
    if (keys.includes('agent-team:language')) {
      const nextLocale = settingsGet<string>('agent-team:language', '')
      if (nextLocale === 'zh-TW' || nextLocale === 'en-US' || nextLocale === 'ja-JP') {
        locale.value = nextLocale
        i18n.global.locale.value = nextLocale
      }
    }
  })
  window.agentTeam?.onLanguageChanged?.((nextLocale) => {
    if (nextLocale === 'zh-TW' || nextLocale === 'en-US' || nextLocale === 'ja-JP') {
      locale.value = nextLocale
      i18n.global.locale.value = nextLocale
      seedSettings({ 'agent-team:language': nextLocale })
    }
  })
  // Auto-open the plan this window was launched for, once the root its path is
  // relative to is known.
  void resolvePlanRoot().then(() => openInitialDoc())
  // While the window stays open, the sidebar clicking another plan focuses this
  // window and asks it to switch (no reopen).
  offPlanOpenDoc = window.agentTeam?.onPlanOpenDoc?.((relPath) => openRelPath(relPath)) ?? null
})
onUnmounted(() => {
  offSettingsChange?.()
  offPlansChanged?.()
  offPlanOpenDoc?.()
})
</script>

<template>
  <div class="plan-window">
    <!-- The bar the system is no longer drawing here. Draggable, with the
         window's own controls at the right, like the main and editor windows. -->
    <div v-if="drawsOwnTitleBar" class="plan-titlebar">
      <WindowControls />
      <span class="plan-titlebar-name" v-truncate>{{ workspaceTitleName }}</span>
    </div>
    <!-- The list, the document and the AI dock are one row; the bar above is
         the column's other child. NotificationHost stays outside both — it is
         a fixed overlay and takes no part in this layout. -->
    <div class="plan-window-body">
    <aside class="plan-window-side">
      <PlansPane ref="plansPaneRef" :workspace-path="workspacePath" :backend="backend" @open-file="onOpenFile" @deleted="onPlanDeleted" />
    </aside>
    <main class="plan-window-main">
      <template v-if="openDoc">
        <div v-if="openDoc.relPath.endsWith('.html')" class="plan-window-doc">
          <template v-if="isHtmlPlanDoc(openDoc.relPath)">
            <!-- Read-only snapshot view: no toolbar, write interactions ignored. -->
            <template v-if="snapshotPreview">
              <div class="plan-snapshot-banner">
                <span class="plan-snapshot-label">{{ snapshotPreview.label }}</span>
                <span class="plan-snapshot-note">{{ t('pane.plans.snapshot-readonly') }}</span>
                <button class="plan-snapshot-close" @click="closeSnapshotPreview">
                  {{ t('pane.plans.snapshot-close') }}
                </button>
              </div>
              <PlanDocPreview
                :key="snapshotPreview.relPath"
                :workspace-path="planRoot"
                :rel-path="snapshotPreview.relPath"
                :backend="backend"
                :refresh="0"
                @open-code="onOpenCode"
              />
            </template>
            <template v-else>
              <PlanReviewToolbar
                ref="toolbarRef"
                :key="openDoc.relPath"
                :workspace-path="planRoot"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :store="planStore"
                @updated="planPreviewRefresh++"
                @scroll-to-anchor="onOutlineScroll"
                @preview-snapshot="onPreviewSnapshot"
                @deleted="onPlanDeleted"
              />
              <PlanDocPreview
                ref="previewRef"
                :key="openDoc.relPath"
                :workspace-path="planRoot"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :refresh="planPreviewRefresh"
                @todo-clicked="onDocTodoClicked"
                @section-comment="onDocSectionComment"
                @section-edit="onSectionEdit"
                @section-delete="onSectionDelete"
                @open-code="onOpenCode"
              />
            </template>
          </template>
          <FilePreviewPane
            v-else
            :key="openDoc.relPath"
            :workspace-path="planRoot"
            :rel-path="openDoc.relPath"
            :name="openDoc.name"
            :backend="backend"
          />
        </div>
        <!-- Markdown plan: the shared review toolbar + PlanMarkdownBody when the
             file carries valid frontmatter meta; plain markdown (no meta) keeps
             the legacy read-only PlanFileView with no meta-driven toolbar. -->
        <template v-else>
          <div v-if="mdKind === 'plan'" class="plan-window-doc">
            <!-- Read-only markdown snapshot view: no toolbar, edits ignored. -->
            <template v-if="snapshotPreview">
              <div class="plan-snapshot-banner">
                <span class="plan-snapshot-label">{{ snapshotPreview.label }}</span>
                <span class="plan-snapshot-note">{{ t('pane.plans.snapshot-readonly') }}</span>
                <button class="plan-snapshot-close" @click="closeSnapshotPreview">
                  {{ t('pane.plans.snapshot-close') }}
                </button>
              </div>
              <PlanFileView
                :key="snapshotPreview.relPath"
                :workspace-path="planRoot"
                :rel-path="snapshotPreview.relPath"
                :backend="backend"
                :readonly="true"
              />
            </template>
            <template v-else>
              <PlanReviewToolbar
                ref="toolbarRef"
                :key="openDoc.relPath"
                :workspace-path="planRoot"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :store="planStore"
                @updated="planPreviewRefresh++"
                @scroll-to-anchor="onOutlineScroll"
                @preview-snapshot="onPreviewSnapshot"
                @deleted="onPlanDeleted"
              />
              <PlanMarkdownBody
                ref="mdBodyRef"
                :key="openDoc.relPath"
                :workspace-path="planRoot"
                :rel-path="openDoc.relPath"
                :backend="backend"
                :refresh="planPreviewRefresh"
                @updated="planPreviewRefresh++"
              />
            </template>
          </div>
          <PlanFileView
            v-else-if="mdKind === 'doc'"
            :key="openDoc.relPath"
            :workspace-path="planRoot"
            :rel-path="openDoc.relPath"
            :backend="backend"
          />
          <div v-else class="plan-window-doc" />
        </template>
      </template>
      <div v-else class="plan-window-empty">{{ t('pane.plans.window-empty') }}</div>
    </main>
    <!-- Right AI terminal dock (rail toggle + resize + embedded CLI PTY).
         width-key is carried over from the previous AiChatDock so the user's
         persisted panel width survives the module swap. -->
    <AiCliDock
      width-key="plan-ai-panel-width"
      :pane-id="AI_PANE_ID"
      origin="plan-window"
      :workspace-path="workspacePath"
      :terminal-port="terminalPort"
      :build-context="buildPlanContext"
    />
    </div>
    <NotificationHost />
  </div>
</template>

<style scoped>
.plan-window {
  background: var(--bg-base);
  color: var(--text-primary);
  /* A column now: the title bar sits above the list / document / dock row,
     which keeps its own horizontal layout inside `.plan-window-body`. */
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.plan-window-body {
  display: flex;
  flex: 1;
  /* Without this the row refuses to shrink below its content and pushes the
     title bar off the top of a short window. */
  min-height: 0;
  overflow: hidden;
}

.plan-titlebar {
  flex-shrink: 0;
  height: var(--titlebar-height);
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: drag;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  user-select: none;
  /* No macOS traffic-light gutter to leave on the left: this bar exists only
     where we draw the controls ourselves, and WindowControls' own global rule
     reserves the room they need on the right. */
  padding-left: 8px;
  padding-right: 8px;
}

.plan-titlebar-name {
  flex: 1;
  text-align: center;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.plan-window-side {
  border-right: 1px solid var(--border-subtle);
  flex-shrink: 0;
  overflow: hidden;
  width: 300px;
}

.plan-window-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* Every direct child (doc stack, markdown view, empty state) fills the pane. */
.plan-window-main > * {
  flex: 1 1 0;
  min-height: 0;
}

.plan-window-doc {
  display: flex;
  flex-direction: column;
}

/* Same stretch rule as the editor's .ide-preview-stack: the preview pane
   (last child, below the optional toolbar) takes all remaining height. */
.plan-window-doc > :last-child {
  flex: 1 1 0;
  min-height: 0;
}

.plan-snapshot-banner {
  align-items: center;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-default);
  display: flex;
  flex-shrink: 0;
  font-size: var(--font-xs);
  gap: 10px;
  padding: 6px 12px;
}

.plan-snapshot-label {
  font-weight: 650;
}

.plan-snapshot-note {
  color: var(--text-muted);
  flex: 1;
  font-size: var(--font-2xs);
}

.plan-snapshot-close {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-2xs);
  padding: 3px 10px;
}

.plan-snapshot-close:hover {
  background: var(--bg-hover-strong);
}

.plan-window-empty {
  align-items: center;
  color: var(--text-muted);
  display: flex;
  font-size: var(--font-sm);
  justify-content: center;
}

</style>

<!-- Global reset (non-scoped): scoped styles cannot target html/body/#app, so
     without this the window's dark backgroundColor shows through body's default
     8px margin as a thick frame around the content (App.vue/EditorWindowApp do
     the same reset for their windows). -->
<style>
html,
body,
#app {
  margin: 0;
  height: 100%;
}
</style>
