<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useBackend } from './composables/useBackend'
import { createHostEditorPort } from './composables/hostEditorPort'
import { createHostGitTransport } from './composables/hostGitTransport'
import { createHostGitSettingsPort, createHostGitSurfacePorts, createHostKeybindingsPort, createHostTerminalDockPort } from './composables/hostSurfacePorts'
import { revealPath } from './composables/hostShell'
import { resetUiScale, stepUiScaleBy } from './lib/uiScale'
import ExplorerPane from './components/ExplorerPane.vue'
import WindowControls from './components/WindowControls.vue'
import SearchPane from './components/SearchPane.vue'
import GitPane from './components/GitPane.vue'
import { EditorPane } from '@navide/plugin-ui/editor'
import DiffPane from './editor/DiffPane.vue'
import BranchDiffPane from './editor/BranchDiffPane.vue'
import ConflictPane from './editor/ConflictPane.vue'
import ReviewPane from './components/ReviewPane.vue'
import NotificationHost from './components/NotificationHost.vue'
// Shared right-side AI CLI terminal shell (rail toggle + resize + embedded
// PTY terminal), same panel the Git/Plan windows embed.
import { AiCliDock } from '@navide/plugin-shell'
import { aiTerminalPaneId, bracketedPaste, truncateText } from '@navide/plugin-shell'
import ProblemsPane from './components/ProblemsPane.vue'
import PlanFileView from './editor/PlanFileView.vue'
import FilePreviewPane from './editor/FilePreviewPane.vue'
import { previewKind, isMarkdownFile } from './editor/previewTypes'
import { rebindTabs } from './editor/tabRebind'
import { initKeybindingsPort, useKeybindings, registerCommand, setContext, executeCommand } from '@navide/plugin-ui/shared'
import { i18n, useTheme, BUILTIN_THEMES, vTruncate } from '@navide/plugin-ui/foundation'
import { initSettingsBackend, settingsGet, settingsSet, onSettingsChanged } from '@navide/plugin-ui/shared'
import { useNotify } from '@navide/plugin-ui/foundation'
import { allDiagnosticsSorted, setDiagnostics, diagnosticsKey } from './editor/diagnostics'
import type { Diagnostic } from './editor/diagnostics'
// Type-only — erased at build time, no useGit in this window's bundle.
import type { ListConflictsResult } from './composables/useGit'

// ── window params (Electron appends ?window=editor&workspace_path=…&filepath=…) ──
const params = new URLSearchParams(window.location.search)
function applyEditorLocale(value: unknown): void {
  if (value === 'zh-TW' || value === 'en-US' || value === 'ja-JP') {
    i18n.global.locale.value = value
  }
}
applyEditorLocale(params.get('locale') ?? settingsGet<string>('agent-team:language', ''))
const workspacePath = params.get('workspace_path') ?? ''
const workspaceBaseName = workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath
// What the titlebar calls this workspace: the alias the user gave it, which the
// Host resolved and passed as `workspace_display_name`, else the folder name.
// A blank or absent param means "no alias" — that is how clearing one works.
// KNOWN LIMITATION: a load-time snapshot. Renaming the workspace while this
// window is open does NOT retitle it; this bundle talks to a capability shim
// with no project.* call or event, so there is nothing to follow. The name is
// correct again the next time the window opens.
const workspaceTitleName = params.get('workspace_display_name')?.trim() || workspaceBaseName
// Canonical spelling of the same workspace, used ONLY for comparisons — the
// workspace stays displayed as the user opened it. A workspace reached through
// a symlink (/tmp/wt/proj → /private/tmp/wt/proj, routine with git worktrees on
// macOS) comes back from the OS file picker in its canonical form; comparing
// only the literal string would file that pick as an external root and give one
// physical file two tabs, two buffers and two mtime baselines, so whichever is
// saved second silently overwrites the other. Resolved once here because
// `normWs`/⌘O are synchronous; empty until the IPC lands, which matches "no
// canonical alias known" and simply falls back to literal comparison.
const workspaceRealPath = ref('')
if (workspacePath) {
  void window.agentTeam?.realpath?.(workspacePath)
    .then((p) => { if (p) workspaceRealPath.value = p.replace(/\/+$/, '') || '/' })
    .catch(() => { /* keep the literal-only comparison */ })
}
const initialRel = params.get('filepath') ?? ''
// Files outside the window's workspace are addressed by (file_ws, filepath):
// the file's own parent directory is used as the backend workspace root.
const initialFileWs = params.get('file_ws') ?? ''
const initialName = params.get('name') ?? (initialRel.split('/').pop() || initialRel)
const initialLine = Number(params.get('line')) || 0
// diff pre-load: when opened via openDiffWindow with no existing editor window
const initialDiffFile = params.get('diff_filepath') ?? ''
const initialDiffStaged = params.get('diff_staged') === 'true'
const initialDiffName = params.get('diff_name') ?? (initialDiffFile.split('/').pop() || initialDiffFile)
const initialDiffCommit = params.get('diff_commit') ?? ''
// branch-diff pre-load: when opened via openBranchDiffWindow with no existing editor window
const initialBranchDiffBase = params.get('branch_diff_base') ?? ''
const initialBranchDiffCompare = params.get('branch_diff_compare') ?? ''

const backend = useBackend()
const editorPort = createHostEditorPort(backend)
const gitTransport = createHostGitTransport(backend)
const surfacePorts = createHostGitSurfacePorts(backend, gitTransport)
const terminalPort = createHostTerminalDockPort(backend)
// Hook the settings cache to this window's own ws connection: flushes writes
// (sidebar/panel widths) and receives ui.settings_changed broadcasts from the
// main window (theme changes — see the onSettingsChanged subscription below).
initSettingsBackend(createHostGitSettingsPort(backend))
initKeybindingsPort(createHostKeybindingsPort())
const { confirm, toast } = useNotify()

// ── Sidebar resize ────────────────────────────────────────────────────────────
const SIDEBAR_W_KEY = 'ide-sidebar-width'
const sidebarWidth = ref(Math.max(120, Math.min(500, parseInt(settingsGet(SIDEBAR_W_KEY, '260'), 10))))
let resizing = false
function onResizeStart(): void {
  resizing = true
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
}
function onResizeMove(e: MouseEvent): void {
  if (!resizing) return
  sidebarWidth.value = Math.max(120, Math.min(500, e.clientX - 48))
}
function onResizeEnd(): void {
  if (!resizing) return
  resizing = false
  settingsSet(SIDEBAR_W_KEY, String(sidebarWidth.value))
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
}

// ── AI Panel (shared CLI terminal dock) ───────────────────────────────────────
const cliDockRef = ref<InstanceType<typeof AiCliDock> | null>(null)
const aiPanelOpen = ref(false)
// Pane id unique per (surface, workspace): two editor windows on different
// workspaces must not steal each other's PTY (see aiTerminalPaneId).
const AI_PANE_ID = aiTerminalPaneId('editor', workspacePath)

// Context payload the CLI dock injects after a fresh spawn: workspace, open
// tabs, the active file plus its selection and (truncated) content.
const EDITOR_CONTEXT_TRUNCATE_AT = 8000
function buildEditorContext(): string {
  const lines = [
    "You are running in a terminal embedded in Navide's editor window, " +
      'assisting the user who is reading and editing files in this workspace.',
    `Workspace: ${workspacePath}`,
  ]
  // Tabs outside this workspace are listed by absolute path — their relPath
  // would otherwise read as a (non-existent) file inside the workspace.
  const files = openFiles.value.filter((f) => f.kind === 'file').map(tabDisplayPath)
  if (files.length) lines.push(`Open files: ${files.join(', ')}`)
  const active = activeFile.value
  // Synthetic tabs (diff/conflict/branch-diff) have no readable file content.
  if (active?.kind === 'file') {
    lines.push(`Active file: ${tabDisplayPath(active)}`)
    const selection = String(activeEditor()?.getSelection?.() ?? '')
    if (selection) {
      lines.push('', 'Selected text:', truncateText(selection, EDITOR_CONTEXT_TRUNCATE_AT))
    }
    const content = String(activeEditor()?.getContent?.() ?? '')
    if (content) {
      lines.push(
        '',
        content.length > EDITOR_CONTEXT_TRUNCATE_AT
          ? 'Active file content (truncated):'
          : 'Active file content:',
        truncateText(content, EDITOR_CONTEXT_TRUNCATE_AT)
      )
    }
  }
  return lines.join('\n')
}

// Route an editor "ask AI" action into the CLI terminal: open the panel and
// bracketed-paste the prompt into the running CLI (unsubmitted, so the user
// can edit before sending). Without a running CLI the panel opens on its Start
// UI and a toast says to start it first — no auto-spawn, a paste should never
// launch an agent the user did not start.
function pasteToCli(text: string): void {
  aiPanelOpen.value = true
  const dock = cliDockRef.value
  if (dock?.terminal?.status === 'running') dock.pasteText(bracketedPaste(text))
  else if (dock?.terminal?.status === 'starting') toast('AI terminal is starting — retry in a moment')
  else toast('Start the AI terminal first, then retry')
}

function selectionPrompt(relPath: string, selection: unknown, instruction: string): string {
  const sel = truncateText(String(selection ?? ''), EDITOR_CONTEXT_TRUNCATE_AT)
  return `${instruction}\n\nSelection from ${relPath}:\n\`\`\`\n${sel}\n\`\`\``
}

function handleAskAiAboutFile(relPath: string): void {
  pasteToCli(`Please explain the file ${relPath} in this workspace.`)
}

function addSelectionToChat(file: OpenFile, selection: unknown): void {
  pasteToCli(selectionPrompt(tabDisplayPath(file), selection, 'Consider this code selection:'))
}

function explainSelectionWithAi(file: OpenFile, selection: unknown): void {
  pasteToCli(
    selectionPrompt(tabDisplayPath(file), selection, 'Explain the selected code step by step.')
  )
}

function fixSelectionWithAi(file: OpenFile, selection: unknown): void {
  pasteToCli(
    selectionPrompt(tabDisplayPath(file), selection, 'Fix any bugs or issues in the selected code.')
  )
}

function writeTestsWithAi(file: OpenFile, selection: unknown): void {
  pasteToCli(
    selectionPrompt(
      tabDisplayPath(file),
      selection,
      'Generate comprehensive unit tests for the selected code.'
    )
  )
}

function askSelectionWithAi(file: OpenFile, payload: unknown): void {
  const body = (payload ?? {}) as { selection?: unknown; question?: unknown }
  pasteToCli(selectionPrompt(tabDisplayPath(file), body.selection, String(body.question ?? '')))
}

// ── Open files (VS Code-style tabs); each EditorPane stays mounted (v-show) so
//    edits/undo survive tab switches. ──────────────────────────────────────────
// kind='diff': relPath is a synthetic key (\x00diff:<staged-or-commit>:<filepath>), filepath/staged/commit hold the real values.
// kind='conflict': relPath is a synthetic key (\x00conflict:<filepath>), filepath holds the real path.
// kind='branch-diff': relPath is a synthetic key (\x00branch-diff:<base>), base holds the base branch.
// wsPath: workspace root this tab's relPath is resolved against. Undefined for
// the ordinary case (the window's own workspace); set when the file lives
// outside it, in which case it is the file's parent directory — the backend
// only checks that the target stays inside the given root, so an external file
// passes every existing guard with its own root and no backend change.
interface OpenFile { kind: 'file' | 'diff' | 'conflict' | 'branch-diff'; id: number; relPath: string; wsPath?: string; name: string; line: number; dirty: boolean; revealAt?: number; revealSeq: number; filepath?: string; staged?: boolean; commit?: string; base?: string; compare?: string }
// Stable tab identity for template keys: relPath is mutable (tabs follow
// explorer renames/moves), and keying panes by it would remount EditorPane on
// rename — losing the Monaco undo stack and any unsaved buffer.
let tabIdSeq = 1
function nextTabId(): number { return tabIdSeq++ }
const openFiles = ref<OpenFile[]>([])

// A tab is identified by (workspace, relPath): the same relPath under two roots
// is two independent files. Every per-tab map/set below is keyed this way.
function normWs(ws: string | undefined | null): string | undefined {
  if (!ws) return undefined
  // Strip trailing slashes, but keep the filesystem root itself: '/' must stay a
  // root of its own, not collapse to "the window's workspace".
  const v = ws.replace(/\/+$/, '') || '/'
  // The canonical spelling of the window's workspace folds too, or the same
  // file reached through a symlinked root would key as a second tab.
  if (v === workspaceRealPath.value) return undefined
  return v !== (workspacePath.replace(/\/+$/, '') || '/') ? v : undefined
}
function fileWs(f: { wsPath?: string }): string { return f.wsPath || workspacePath }
function tabKeyOf(wsPath: string | undefined, relPath: string): string {
  return diagnosticsKey(wsPath || workspacePath, relPath)
}
function tabKey(f: { wsPath?: string; relPath: string }): string { return tabKeyOf(f.wsPath, f.relPath) }
function findTab(key: string): OpenFile | undefined {
  return openFiles.value.find((f) => tabKey(f) === key)
}
function absPathOf(f: { wsPath?: string; relPath: string }): string {
  return `${fileWs(f).replace(/\/+$/, '')}/${f.relPath}`
}
/** What to show the user (and the AI) for a tab: external files need their absolute
 *  path. Non-file tabs carry a synthetic relPath (see OpenFile) that is not a path
 *  at all, so they are shown as-is rather than glued onto a root. */
function tabDisplayPath(f: { wsPath?: string; relPath: string; kind?: OpenFile['kind'] }): string {
  return f.wsPath && (f.kind ?? 'file') === 'file' ? absPathOf(f) : f.relPath
}

const activeKey = ref('')

// ── Plan file view mode ───────────────────────────────────────────────────────
// Tracks which .plan.md files are shown in the rich plan view (vs raw editor).
const planViewFiles = ref(new Set<string>())

function isPlanFile(relPath: string): boolean {
  return relPath.endsWith('.plan.md')
}

function togglePlanView(key: string): void {
  const s = new Set(planViewFiles.value)
  if (s.has(key)) {
    s.delete(key)
  } else {
    s.add(key)
  }
  planViewFiles.value = s
}

// ── File preview mode ─────────────────────────────────────────────────────────
// Tracks files shown in the preview pane (media/PDF/binary via FilePreviewPane)
// or, for plain .md files, the rendered markdown view (PlanFileView pipeline).
const previewFiles = ref(new Set<string>())

function isPreviewToggleFile(relPath: string): boolean {
  return previewKind(relPath) !== null || isMarkdownFile(relPath)
}

function togglePreview(key: string): void {
  const s = new Set(previewFiles.value)
  if (s.has(key)) {
    s.delete(key)
  } else {
    s.add(key)
  }
  previewFiles.value = s
}

const initialSidebar = (['explorer', 'search', 'git', 'problems'] as const).find(
  (v) => v === params.get('sidebar'),
) ?? 'explorer'
const sidebarView = ref<'explorer' | 'search' | 'git' | 'problems'>(initialSidebar)
const sidebarHidden = ref(false)
const zenMode = ref(false)
const changesCount = ref(0)
const activePath = computed(() => {
  const f = findTab(activeKey.value)
  if (!f) return []
  if (f.kind === 'branch-diff') return [f.name]
  const displayPath = (f.kind === 'diff' || f.kind === 'conflict') ? (f.filepath ?? '') : f.relPath
  return displayPath.split('/').filter(Boolean)
})

// ── Breadcrumb dropdown ───────────────────────────────────────────────────────
interface BcItem { name: string; isDir: boolean; relPath: string; line?: number; kind?: string }
interface BcDropdown { segIdx: number; items: BcItem[]; x: number; y: number }
const bcDropdown = ref<BcDropdown | null>(null)
const bcActiveIdx = ref(-1)

// Returns a positive score if `query` is a subsequence of `target`, 0 otherwise.
// Consecutive character matches score higher than scattered ones.
function _fuzzyScore(query: string, target: string): number {
  let qi = 0; let score = 0; let consecutive = 0
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      consecutive++
      score += 1 + consecutive  // reward runs of consecutive matches
      qi++
    } else {
      consecutive = 0
    }
  }
  return qi === query.length ? score : 0
}

function _extractSymbols(text: string, ext: string): BcItem[] {
  const lines = text.split('\n')
  const out: BcItem[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    let m: RegExpMatchArray | null
    // ── TypeScript / JavaScript / Vue ──────────────────────────────────────
    if (['ts', 'tsx', 'js', 'jsx', 'vue', 'mjs', 'cjs'].includes(ext)) {
      if ((m = raw.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'function' })
      else if ((m = raw.match(/^\s*(?:export\s+)?class\s+(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'class' })
      else if ((m = raw.match(/^\s*(?:export\s+)?interface\s+(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'interface' })
      else if ((m = raw.match(/^\s*(?:export\s+)?type\s+(\w+)\s*=/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'type' })
      else if ((m = raw.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\()/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'function' })
      // Vue: computed: { name() {} } or methods: { name() {} }
      else if ((m = raw.match(/^\s+(\w+)\s*(?:\([^)]*\))?\s*\{/)) && i > 0) {
        const prev = lines[i - 1]?.trimEnd()
        if (/computed:|methods:|setup\s*\(/.test(prev ?? ''))
          out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'method' })
      }
    // ── Python ──────────────────────────────────────────────────────────────
    } else if (ext === 'py') {
      if ((m = raw.match(/^(\s*)def\s+(\w+)/)))
        out.push({ name: m[2], isDir: false, relPath: '', line: i + 1, kind: m[1] ? 'method' : 'function' })
      else if ((m = raw.match(/^class\s+(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'class' })
    // ── Go ──────────────────────────────────────────────────────────────────
    } else if (ext === 'go') {
      if ((m = raw.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'function' })
      else if ((m = raw.match(/^type\s+(\w+)\s+(?:struct|interface)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: ext === 'go' ? 'struct' : 'interface' })
    // ── Rust ─────────────────────────────────────────────────────────────────
    } else if (ext === 'rs') {
      if ((m = raw.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'function' })
      else if ((m = raw.match(/^\s*(?:pub\s+)?struct\s+(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'struct' })
      else if ((m = raw.match(/^\s*(?:pub\s+)?(?:trait|enum)\s+(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'type' })
      else if ((m = raw.match(/^\s*impl\s+(?:<[^>]+>\s+)?(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'impl' })
    // ── Java / Kotlin ────────────────────────────────────────────────────────
    } else if (ext === 'java' || ext === 'kt') {
      if ((m = raw.match(/^\s*(?:public|private|protected|override)?\s*(?:static\s+)?(?:\w+\s+)?(?:fun\s+)?(\w+)\s*\([^)]*\)\s*(?:throws\s+\w+\s*)?\{/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'method' })
      else if ((m = raw.match(/^\s*(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'class' })
      else if ((m = raw.match(/^\s*(?:public\s+)?interface\s+(\w+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'interface' })
    // ── CSS / SCSS ───────────────────────────────────────────────────────────
    } else if (ext === 'css' || ext === 'scss' || ext === 'less') {
      if ((m = raw.match(/^([.#@][\w-]+(?:\s+[\w.#:[\]>~]+)*)\s*\{/)))
        out.push({ name: m[1].trim(), isDir: false, relPath: '', line: i + 1, kind: 'rule' })
      else if (ext === 'scss' && (m = raw.match(/^@mixin\s+([\w-]+)/)))
        out.push({ name: m[1], isDir: false, relPath: '', line: i + 1, kind: 'mixin' })
    // ── Markdown ─────────────────────────────────────────────────────────────
    } else if (ext === 'md' || ext === 'mdx') {
      if ((m = raw.match(/^(#{1,3})\s+(.+)/)))
        out.push({ name: m[2].trim(), isDir: false, relPath: '', line: i + 1, kind: `h${m[1].length}` })
    }
  }
  return out
}

async function openBcDropdown(segIdx: number, e: MouseEvent): Promise<void> {
  e.stopPropagation()
  const rect = (e.target as HTMLElement).getBoundingClientRect()
  const isFile = segIdx === activePath.value.length - 1
  if (bcDropdown.value?.segIdx === segIdx) { bcDropdown.value = null; return }
  if (isFile) {
    const fileContent = activeEditor()?.getContent?.() ?? ''
    const ext = activePath.value[segIdx].split('.').pop() ?? ''
    const symbols = _extractSymbols(fileContent, ext)
    bcDropdown.value = { segIdx, items: symbols, x: rect.left, y: rect.bottom }
    bcActiveIdx.value = -1
  } else {
    const parentPath = activePath.value.slice(0, segIdx).join('/')
    interface LsResp { ok: boolean; entries?: Array<{ name: string; is_dir: boolean; rel_path: string }> }
    let resp: Awaited<ReturnType<typeof backend.send<LsResp>>>
    try {
      // Breadcrumb segments are relative to the *active tab's* root, not the
      // window's — listing an external file's parent against the workspace
      // would show an unrelated directory.
      const ws = fileWs(activeFile.value ?? {})
      resp = await backend.send<LsResp>('fs.list_dir', { workspace_path: ws, rel_path: parentPath, show_hidden: false })
    } catch { return }
    const entries = resp.payload?.entries
    // Guard: if the user closed the dropdown (or opened another) while we waited, don't reopen.
    if (entries && bcDropdown.value === null) {
      bcDropdown.value = {
        segIdx,
        items: entries.map((en) => ({ name: en.name, isDir: en.is_dir, relPath: en.rel_path })),
        x: rect.left,
        y: rect.bottom,
      }
      bcActiveIdx.value = -1
    }
  }
}

function onBcItemClick(item: BcItem): void {
  bcDropdown.value = null
  if (item.line) {
    const f = activeFile.value
    if (f) { f.revealAt = item.line; f.revealSeq = (f.revealSeq ?? 0) + 1 }
  } else if (!item.isDir && item.relPath) {
    openFile({ filepath: item.relPath, wsPath: activeFile.value?.wsPath })
  }
}

function closeBcDropdown(): void { bcDropdown.value = null; bcActiveIdx.value = -1 }

function onBcCaptureKeydown(e: KeyboardEvent): void {
  const dd = bcDropdown.value
  if (!dd) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.stopImmediatePropagation()
    e.preventDefault()
    const n = dd.items.length
    if (!n) return
    bcActiveIdx.value = e.key === 'ArrowDown'
      ? (bcActiveIdx.value + 1) % n
      : (bcActiveIdx.value - 1 + n) % n
  } else if (e.key === 'Enter') {
    e.stopImmediatePropagation()
    e.preventDefault()
    const item = dd.items[bcActiveIdx.value]
    if (item) onBcItemClick(item)
    else closeBcDropdown()
  } else if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    e.preventDefault()
    closeBcDropdown()
  }
}

function openFile(p: { filepath: string; name?: string; line?: number; wsPath?: string }): void {
  const relPath = p.filepath
  if (!relPath) return
  const wsPath = normWs(p.wsPath)
  const name = p.name ?? (relPath.split('/').pop() || relPath)
  const key = tabKeyOf(wsPath, relPath)
  const existing = findTab(key)
  if (existing) {
    if (p.line && p.line > 0) {
      existing.revealAt = p.line
      existing.revealSeq = (existing.revealSeq ?? 0) + 1
    }
  } else {
    openFiles.value.push({ kind: 'file', id: nextTabId(), relPath, wsPath, name, line: p.line ?? 0, dirty: false, revealSeq: 0 })
    // Auto-enable plan view for .plan.md files.
    if (isPlanFile(relPath)) {
      const s = new Set(planViewFiles.value)
      s.add(key)
      planViewFiles.value = s
    } else if (
      previewKind(relPath) !== null &&
      previewKind(relPath) !== 'html' &&
      previewKind(relPath) !== 'csv'
    ) {
      // Media/PDF/font/archive/known-binary files auto-open in preview;
      // markdown, HTML and CSV stay raw with a Preview toggle.
      const s = new Set(previewFiles.value)
      s.add(key)
      previewFiles.value = s
    }
  }
  activeKey.value = key
}

function openDiff(p: { filepath: string; staged: boolean; name?: string; commit?: string }): void {
  const relPath = `\x00diff:${p.commit || (p.staged ? '1' : '0')}:${p.filepath}`
  const name = p.name ?? (p.filepath.split('/').pop() || p.filepath)
  const key = tabKeyOf(undefined, relPath)
  if (!findTab(key)) {
    openFiles.value.push({ kind: 'diff', id: nextTabId(), relPath, filepath: p.filepath, staged: p.staged, commit: p.commit || undefined, name, line: 0, dirty: false, revealSeq: 0 })
  }
  activeKey.value = key
}

function openConflict(p: { filepath: string; name?: string }): void {
  const relPath = `\x00conflict:${p.filepath}`
  const name = p.name ?? (p.filepath.split('/').pop() || p.filepath)
  const key = tabKeyOf(undefined, relPath)
  if (!findTab(key)) {
    openFiles.value.push({ kind: 'conflict', id: nextTabId(), relPath, filepath: p.filepath, name, line: 0, dirty: false, revealSeq: 0 })
  }
  activeKey.value = key
  void loadConflictPaths()
}

// ── Conflict tabs: is the merge that produced them still in progress? ────────
// ConflictPane refuses to write once its file is no longer an unmerged path
// (`merge --abort` run in the Git window or a terminal), but that guard only
// works if this host feeds it. GitPane keeps its useGit instance private, so
// the unmerged paths are read straight from the index here and re-read on the
// backend's git.changed broadcast. `null` = never read; only a successful read
// is allowed to declare a file no longer conflicted.
const conflictPaths = ref<Set<string> | null>(null)

async function loadConflictPaths(): Promise<void> {
  if (!workspacePath) return
  try {
    const resp = await backend.send<ListConflictsResult>(
      'git.list_conflicts', { workspace_path: workspacePath },
    )
    if (resp.ok && resp.payload?.ok) {
      conflictPaths.value = new Set(resp.payload.conflicts.map((c) => c.path))
    }
  } catch { /* keep the last known list rather than falsely aborting a merge */ }
}

function mergeAbortedFor(filepath: string): boolean {
  return conflictPaths.value !== null && !conflictPaths.value.has(filepath)
}

let offGitChanged: (() => void) | null = null
let gitChangedTimer: ReturnType<typeof setTimeout> | null = null

function openBranchDiff(p: { base: string; compare?: string; workspacePath?: string }): void {
  const base = p.base || 'main'
  const relPath = `\x00branch-diff:${base}`
  const name = `Diff with ${base}`
  // A branch diff carries its own repo root like any other tab (this used to
  // live in `filepath`); the root is part of the tab identity, so a diff of
  // another repo gets its own tab instead of overwriting this one.
  const wsPath = normWs(p.workspacePath)
  const key = tabKeyOf(wsPath, relPath)
  if (!findTab(key)) {
    openFiles.value.push({ kind: 'branch-diff', id: nextTabId(), relPath, wsPath, base, compare: p.compare ?? '', name, line: 0, dirty: false, revealSeq: 0 })
  }
  activeKey.value = key
}

// ── Tab rebinding on explorer rename/move ─────────────────────────────────────
// Keeps open tabs bound to their files after fs.rename (inline rename and
// drag-to-move, file or folder). Tabs are keyed by stable id, so rewriting
// relPath in place does NOT remount EditorPane — the buffer, undo stack, and
// mtime baseline survive, and the pane's next save targets the new path.
function onEntryRenamed(p: { oldRel: string; newRel: string }): void {
  // The explorer only ever renames inside the window's workspace, so tabs
  // carrying their own wsPath must not be rewritten — same relPath, other root.
  const moved = rebindTabs(openFiles.value, p.oldRel, p.newRel)
  for (const { tab, prevRelPath } of moved) {
    // Migrate state keyed by the old tab key.
    const prevKey = tabKeyOf(tab.wsPath, prevRelPath)
    const nextKey = tabKey(tab)
    const pane = editorPaneRefs.get(prevKey)
    if (pane) { editorPaneRefs.delete(prevKey); editorPaneRefs.set(nextKey, pane) }
    if (planViewFiles.value.has(prevKey)) {
      const s = new Set(planViewFiles.value); s.delete(prevKey); s.add(nextKey)
      planViewFiles.value = s
    }
    if (previewFiles.value.has(prevKey)) {
      const s = new Set(previewFiles.value); s.delete(prevKey); s.add(nextKey)
      previewFiles.value = s
    }
    if (activeKey.value === prevKey) activeKey.value = nextKey
  }
  if (secondaryGroup.value) {
    const movedSec = rebindTabs(secondaryGroup.value.files, p.oldRel, p.newRel)
    for (const { tab, prevRelPath } of movedSec) {
      const prevKey = tabKeyOf(tab.wsPath, prevRelPath)
      const nextKey = tabKey(tab)
      const pane = editorPaneRefsSecondary.get(prevKey)
      if (pane) { editorPaneRefsSecondary.delete(prevKey); editorPaneRefsSecondary.set(nextKey, pane) }
      if (secondaryGroup.value.activeKey === prevKey) secondaryGroup.value.activeKey = nextKey
    }
  }
}

const closedHistory: Array<{ relPath: string; wsPath?: string; name: string }> = []

async function closeFile(key: string): Promise<void> {
  const f = findTab(key)
  if (f?.dirty) {
    const ok = await confirm(i18n.global.t('editorWindow.close-file-dirty', { name: f.name }), {
      title: i18n.global.t('editorWindow.close-file'), confirmText: i18n.global.t('action.close'),
    })
    if (!ok) return
  }
  const i = openFiles.value.findIndex((x) => tabKey(x) === key)
  if (i === -1) return
  if (f?.kind === 'file') closedHistory.push({ relPath: f.relPath, wsPath: f.wsPath, name: f.name })
  openFiles.value.splice(i, 1)
  if (activeKey.value === key) {
    const next = openFiles.value[Math.min(i, openFiles.value.length - 1)]
    activeKey.value = next ? tabKey(next) : ''
  }
}

// ── Tab right-click context menu ──────────────────────────────────────────────
const tabCtxMenu = ref<{ key: string; x: number; y: number } | null>(null)

// Path actions only apply to real file tabs (diff/conflict/branch-diff are synthetic).
const tabCtxIsFile = computed(() => findTab(tabCtxMenu.value?.key ?? '')?.kind === 'file')

function openTabCtxMenu(e: MouseEvent, key: string): void {
  tabCtxMenu.value = { key, x: e.clientX, y: e.clientY }
}
function closeTabCtxMenu(): void { tabCtxMenu.value = null }

async function ctxCloseOthers(key: string): Promise<void> {
  closeTabCtxMenu()
  const dirty = openFiles.value.filter((f) => tabKey(f) !== key && f.kind === 'file' && f.dirty)
  if (dirty.length) { const ok = await confirm(i18n.global.t('editorWindow.close-others-dirty', { count: dirty.length }), { title: i18n.global.t('action.close-others'), confirmText: i18n.global.t('action.close') }); if (!ok) return }
  openFiles.value = openFiles.value.filter((f) => tabKey(f) === key)
}
async function ctxCloseRight(key: string): Promise<void> {
  closeTabCtxMenu()
  const idx = openFiles.value.findIndex((f) => tabKey(f) === key)
  if (idx < 0) return
  const dirty = openFiles.value.slice(idx + 1).filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length) { const ok = await confirm(i18n.global.t('editorWindow.close-right-dirty', { count: dirty.length }), { title: i18n.global.t('action.close-to-right'), confirmText: i18n.global.t('action.close') }); if (!ok) return }
  openFiles.value = openFiles.value.slice(0, idx + 1)
}
async function ctxCloseLeft(key: string): Promise<void> {
  closeTabCtxMenu()
  const idx = openFiles.value.findIndex((f) => tabKey(f) === key)
  if (idx <= 0) return
  const dirty = openFiles.value.slice(0, idx).filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length) { const ok = await confirm(i18n.global.t('editorWindow.close-left-dirty', { count: dirty.length }), { title: i18n.global.t('action.close-to-left'), confirmText: i18n.global.t('action.close') }); if (!ok) return }
  openFiles.value = openFiles.value.slice(idx)
}
async function ctxCloseAll(): Promise<void> {
  closeTabCtxMenu()
  const dirty = openFiles.value.filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length) { const ok = await confirm(i18n.global.t('editorWindow.close-all-dirty', { count: dirty.length }), { title: i18n.global.t('action.close-all'), confirmText: i18n.global.t('action.close-all') }); if (!ok) return }
  openFiles.value = []; activeKey.value = ''
}
async function ctxCopyPath(key: string): Promise<void> {
  closeTabCtxMenu()
  const f = findTab(key)
  if (f?.kind === 'file') await navigator.clipboard.writeText(absPathOf(f))
}
async function ctxCopyRelPath(key: string): Promise<void> {
  closeTabCtxMenu()
  const f = findTab(key)
  // An external tab's relPath is relative to its own root, so a bare copy would
  // resolve against the workspace and name a different file: copy the path that
  // actually round-trips.
  if (f?.kind === 'file') await navigator.clipboard.writeText(tabDisplayPath(f))
}
async function ctxRevealInFinder(key: string): Promise<void> {
  closeTabCtxMenu()
  const f = findTab(key)
  if (f?.kind === 'file' && fileWs(f)) await revealPath(absPathOf(f))
}

// ── EditorPane ref tracking (for command delegation) ─────────────────────────
const editorPaneRefs = new Map<string, InstanceType<typeof EditorPane>>()
function setEditorRef(key: string, el: unknown): void {
  if (el) editorPaneRefs.set(key, el as InstanceType<typeof EditorPane>)
  else editorPaneRefs.delete(key)
}

// ── Split Editor — secondary group (Phase D) ──────────────────────────────────
interface SecondaryGroup { files: OpenFile[]; activeKey: string }
const secondaryGroup = ref<SecondaryGroup | null>(null)
const activeGroupIsPrimary = ref(true)
const editorPaneRefsSecondary = new Map<string, InstanceType<typeof EditorPane>>()

function setEditorRefSecondary(key: string, el: unknown): void {
  if (el) editorPaneRefsSecondary.set(key, el as InstanceType<typeof EditorPane>)
  else editorPaneRefsSecondary.delete(key)
}

function activeEditor(): InstanceType<typeof EditorPane> | undefined {
  if (activeGroupIsPrimary.value) return editorPaneRefs.get(activeKey.value)
  return editorPaneRefsSecondary.get(secondaryGroup.value?.activeKey ?? '')
}

const activeFile = computed(() => findTab(activeKey.value))

function splitEditor(): void {
  const current = activeFile.value
  if (!current || current.kind !== 'file') return
  secondaryGroup.value = { files: [{ ...current }], activeKey: tabKey(current) }
  activeGroupIsPrimary.value = false
}

function closeFileInSecondary(key: string): void {
  if (!secondaryGroup.value) return
  const i = secondaryGroup.value.files.findIndex(f => tabKey(f) === key)
  if (i === -1) return
  secondaryGroup.value.files.splice(i, 1)
  if (secondaryGroup.value.activeKey === key) {
    const next = secondaryGroup.value.files[Math.min(i, secondaryGroup.value.files.length - 1)]
    secondaryGroup.value.activeKey = next ? tabKey(next) : ''
  }
  if (secondaryGroup.value.files.length === 0) {
    secondaryGroup.value = null
    activeGroupIsPrimary.value = true
  }
}

function openFileInSecondary(key: string): void {
  if (!secondaryGroup.value) return
  const exists = secondaryGroup.value.files.find(f => tabKey(f) === key)
  if (!exists) {
    const primary = findTab(key)
    if (primary) secondaryGroup.value.files.push({ ...primary })
  }
  secondaryGroup.value.activeKey = key
  activeGroupIsPrimary.value = false
}

// ── Keybinding system ─────────────────────────────────────────────────────────
useKeybindings()
registerCommand('editor.action.save',          () => activeEditor()?.save())
registerCommand('editor.action.inlineRewrite', () => activeEditor()?.openCmdK())
registerCommand('editor.action.triggerGhost',  () => activeEditor()?.requestGhost())
registerCommand('editor.action.openFind',             () => activeEditor()?.openFind())
registerCommand('editor.action.useSelectionForFind', () => activeEditor()?.useSelectionForFind())
registerCommand('editor.action.openReplace',          () => activeEditor()?.openReplace())
registerCommand('editor.action.nextMatch',     () => activeEditor()?.nextMatch())
registerCommand('editor.action.prevMatch',     () => activeEditor()?.prevMatch())
registerCommand('editor.action.gotoLine',      () => activeEditor()?.openGoto())
registerCommand('workbench.action.findInFiles', () => {
  sidebarHidden.value = false
  sidebarView.value = 'search'
  // If pane was already visible, the watcher on 'active' prop won't fire — focus explicitly.
  void nextTick(() => searchRef.value?.focusInput())
})
registerCommand('workbench.action.toggleSidebar', () => { sidebarHidden.value = !sidebarHidden.value })
registerCommand('workbench.action.toggleZenMode', () => {
  zenMode.value = !zenMode.value
  if (zenMode.value) sidebarHidden.value = true
})
registerCommand('workbench.action.focusExplorer', () => {
  sidebarHidden.value = false
  sidebarView.value = 'explorer'
  void nextTick(() => explorerRef.value?.focusTree())
})
registerCommand('workbench.action.focusSourceControl', () => { sidebarHidden.value = false; sidebarView.value = 'git' })
registerCommand('workbench.action.toggleAIChat', () => { aiPanelOpen.value = !aiPanelOpen.value })
registerCommand('workbench.action.addSelectionToChat', () => {
  const sel = activeEditor()?.getSelection() || activeEditor()?.getWordAtCursor?.() || ''
  if (!sel) return
  const f = activeFile.value
  pasteToCli(
    f
      ? selectionPrompt(tabDisplayPath(f), sel, 'Consider this code selection:')
      : `Consider this code selection:\n\`\`\`\n${truncateText(String(sel), EDITOR_CONTEXT_TRUNCATE_AT)}\n\`\`\``
  )
})
registerCommand('editor.action.toggleComment',    () => activeEditor()?.toggleLineComment())
registerCommand('editor.action.deleteLines',      () => activeEditor()?.deleteLine())
registerCommand('editor.action.deleteWordLeft',   () => activeEditor()?.deleteWordLeft())
registerCommand('editor.action.deleteWordRight',  () => activeEditor()?.deleteWordRight())
registerCommand('editor.action.deleteAllLeft',    () => activeEditor()?.deleteLineLeft())
registerCommand('editor.action.deleteAllRight',   () => activeEditor()?.deleteLineRight())
registerCommand('editor.action.insertLineAfter',  () => activeEditor()?.insertLineBelow())
registerCommand('editor.action.insertLineBefore', () => activeEditor()?.insertLineAbove())
registerCommand('editor.action.moveLineUp',       () => activeEditor()?.moveLineUp())
registerCommand('editor.action.moveLineDown',     () => activeEditor()?.moveLineDown())
registerCommand('editor.action.selectHighlights',  () => activeEditor()?.selectAllOccurrences())
registerCommand('editor.action.renameSymbol',      () => activeEditor()?.selectAllOccurrences())
registerCommand('editor.action.jumpToBracket',     () => activeEditor()?.jumpToBracket())
registerCommand('editor.action.selectToBracket',   () => activeEditor()?.selectToBracket())
registerCommand('editor.action.duplicateLineDown',  () => activeEditor()?.duplicateLineDown())
registerCommand('editor.action.duplicateLineUp',    () => activeEditor()?.duplicateLineUp())
registerCommand('editor.action.indentLines',         () => activeEditor()?.indentLine())
registerCommand('editor.action.outdentLines',        () => activeEditor()?.dedentLine())
registerCommand('editor.action.cursorTop',            () => activeEditor()?.cursorTop())
registerCommand('editor.action.cursorBottom',         () => activeEditor()?.cursorBottom())
registerCommand('editor.action.cursorTopSelect',       () => activeEditor()?.cursorTopSelect())
registerCommand('editor.action.cursorBottomSelect',    () => activeEditor()?.cursorBottomSelect())
registerCommand('editor.action.cursorLineStart',       () => activeEditor()?.cursorLineStart())
registerCommand('editor.action.cursorLineEnd',         () => activeEditor()?.cursorLineEnd())
registerCommand('editor.action.cursorLineStartSelect', () => activeEditor()?.cursorLineStartSelect())
registerCommand('editor.action.cursorLineEndSelect',   () => activeEditor()?.cursorLineEndSelect())
registerCommand('editor.action.selectCurrentWord',     () => activeEditor()?.selectCurrentWord())
registerCommand('editor.action.cursorWordLeft',        () => activeEditor()?.cursorWordLeft())
registerCommand('editor.action.cursorWordRight',      () => activeEditor()?.cursorWordRight())
registerCommand('editor.action.cursorWordLeftSelect', () => activeEditor()?.cursorWordLeftSelect())
registerCommand('editor.action.cursorWordRightSelect',() => activeEditor()?.cursorWordRightSelect())
registerCommand('editor.action.scrollLineUp',         () => activeEditor()?.scrollLineUp())
registerCommand('editor.action.scrollLineDown',       () => activeEditor()?.scrollLineDown())
registerCommand('editor.action.transformToUppercase',  () => activeEditor()?.transformToUppercase())
registerCommand('editor.action.transformToLowercase',  () => activeEditor()?.transformToLowercase())
registerCommand('editor.action.transformToTitlecase',  () => activeEditor()?.transformToTitleCase())
registerCommand('editor.action.transformToSnakeCase',  () => activeEditor()?.transformToSnakeCase())
registerCommand('editor.action.transformToCamelCase',  () => activeEditor()?.transformToCamelCase())
registerCommand('editor.action.transformToKebabCase',  () => activeEditor()?.transformToKebabCase())
registerCommand('editor.action.transformToPascalCase',    () => activeEditor()?.transformToPascalCase())
registerCommand('editor.action.transformToBase64',        () => activeEditor()?.transformToBase64())
registerCommand('editor.action.transformFromBase64',      () => activeEditor()?.transformFromBase64())
registerCommand('editor.action.transformToUrlEncoded',    () => activeEditor()?.transformToUrlEncoded())
registerCommand('editor.action.transformFromUrlEncoded',  () => activeEditor()?.transformFromUrlEncoded())
registerCommand('editor.action.joinLines',               () => activeEditor()?.joinLines())
registerCommand('editor.action.sortLinesAscending',     () => activeEditor()?.sortLinesAscending())
registerCommand('editor.action.sortLinesDescending',    () => activeEditor()?.sortLinesDescending())
registerCommand('editor.action.reverseLines',           () => activeEditor()?.reverseLines())
registerCommand('editor.action.removeDuplicateLines',   () => activeEditor()?.removeDuplicateLines())
registerCommand('editor.action.openLink',               () => { activeEditor()?.openLinkAtCursor() })
registerCommand('editor.action.navigateToLastEditLocation', () => activeEditor()?.navigateToLastEdit())
registerCommand('editor.action.openFileAtCursor', async () => {
  const lineText = activeEditor()?.getCursorLineText?.() ?? ''
  if (!lineText) return
  const m = lineText.match(/from\s+['"`]([^'"`]+)['"`]/)
    || lineText.match(/require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/)
    || lineText.match(/import\s+['"`]([^'"`]+)['"`]/)
    || lineText.match(/['"`]([./][^'"`]+)['"`]/)
  if (!m) return
  const raw = m[1]
  // Resolve the import against the active tab's own root — for an external
  // file that is its parent directory, not the window's workspace.
  const active = activeFile.value
  if (active?.kind !== 'file') return
  const activeDir = active.relPath.split('/').slice(0, -1).join('/')
  const joined = activeDir ? activeDir + '/' + raw : raw
  const parts = joined.split('/').filter(Boolean)
  const resolved: string[] = []
  for (const p of parts) { if (p === '..') resolved.pop(); else if (p !== '.') resolved.push(p) }
  const base = resolved.join('/')
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.vue', '.py', '/index.ts', '/index.js']) {
    const path = base + ext
    if (!path) continue
    const resp = await backend.send<{ content?: string }>('fs.read_file', { workspace_path: fileWs(active), rel_path: path })
    if (resp.payload?.content !== undefined) { openFile({ filepath: path, wsPath: active.wsPath }); return }
  }
})
registerCommand('editor.action.trimTrailingWhitespace', () => activeEditor()?.trimTrailingWhitespace())
registerCommand('editor.action.formatDocument', () => {
  activeEditor()?.formatDocument()
  // After formatting, validate JSON/YAML syntax and expose parse errors as diagnostics.
  const f = activeFile.value
  const ext = f?.name.split('.').pop()?.toLowerCase() ?? ''
  if (!f || ext !== 'json') return
  const content = activeEditor()?.getContent?.() ?? ''
  try {
    JSON.parse(content)
    // Clear any prior JSON parse diagnostics for this file.
    setDiagnostics(activeKey.value, [])
  } catch (err) {
    const msg = err instanceof SyntaxError ? err.message : String(err)
    // Try to extract line number from SyntaxError message (V8: "at position N").
    const posMatch = msg.match(/position (\d+)/)
    let line = 1
    if (posMatch) {
      const offset = parseInt(posMatch[1], 10)
      line = content.slice(0, offset).split('\n').length
    }
    setDiagnostics(activeKey.value, [{
      relPath: f.relPath, wsPath: fileWs(f), line, col: 0,
      severity: 'error', message: msg, source: 'json',
    }])
    toast(`JSON syntax error: ${msg}`)
  }
})
registerCommand('editor.action.formatSelection',        () => activeEditor()?.formatSelection())
registerCommand('editor.action.smartSelect.expand',     () => activeEditor()?.expandSelection())
registerCommand('editor.action.smartSelect.shrink',     () => activeEditor()?.shrinkSelection())
registerCommand('workbench.action.copyFilePath', async () => {
  const f = activeFile.value
  if (f?.kind !== 'file') return
  await navigator.clipboard.writeText(absPathOf(f))
})
registerCommand('workbench.action.copyRelativeFilePath', async () => {
  const f = activeFile.value
  if (f?.kind !== 'file') return
  await navigator.clipboard.writeText(tabDisplayPath(f))
})
registerCommand('workbench.action.revealInExplorer', () => {
  const f = activeFile.value
  sidebarHidden.value = false
  sidebarView.value = 'explorer'
  // The explorer tree only shows the window's workspace — a file from another
  // root simply is not in it.
  if (f?.kind !== 'file') return
  if (f.wsPath) { toast('File is outside this workspace'); return }
  void nextTick(() => explorerRef.value?.revealFile(f.relPath))
})
registerCommand('workbench.action.revealFileInOS', async () => {
  const f = activeFile.value
  if (f?.kind !== 'file') return
  await revealPath(absPathOf(f))
})
registerCommand('workbench.action.newWindow', async () => {
  await window.agentTeam?.openEditorWindow({ workspace_path: workspacePath })
})
registerCommand('workbench.action.openFolder', async () => {
  const path = await window.agentTeam?.pickWorkspace()
  if (path) await window.agentTeam?.openEditorWindow({ workspace_path: path })
})
registerCommand('workbench.action.reloadWindow', () => { window.location.reload() })
registerCommand('workbench.action.openFile', async () => {
  const result = await window.agentTeam?.pickFile({ title: 'Open File' })
  if (!result?.ok || !result.path) return
  // The picker answers with a canonical path, so a workspace opened through a
  // symlink only matches under its resolved spelling — test both, and cut the
  // relPath with whichever prefix hit.
  for (const root of [workspacePath, workspaceRealPath.value]) {
    if (!root) continue
    const prefix = root.replace(/\/+$/, '') + '/'
    if (result.path.startsWith(prefix)) {
      openFile({ filepath: result.path.slice(prefix.length) })
      return
    }
  }
  // Outside the workspace: the file's own directory becomes its root, so the
  // absolute path never leaks into a relPath the backend would reject.
  const cut = result.path.lastIndexOf('/')
  openFile({ filepath: result.path.slice(cut + 1), wsPath: result.path.slice(0, cut) || '/' })
})
registerCommand('workbench.action.openSettings', openKeyboardShortcuts)
registerCommand('editor.action.addSelectionToNextFindMatch',  () => activeEditor()?.selectNextOccurrence())
registerCommand('editor.action.moveSelectionToNextFindMatch', () => activeEditor()?.selectNextOccurrence())
registerCommand('editor.action.undo',      () => activeEditor()?.undo())
registerCommand('editor.action.redo',      () => activeEditor()?.redo())
registerCommand('editor.action.selectAll', () => activeEditor()?.selectAll())
for (let _i = 1; _i <= 9; _i++) {
  const idx = _i - 1
  registerCommand(`workbench.action.openEditorAtIndex${_i}`, () => {
    const f = openFiles.value[idx] ?? openFiles.value[openFiles.value.length - 1]
    if (f) activeKey.value = tabKey(f)
  })
}
registerCommand('workbench.action.closeActiveEditor', () => {
  if (!activeKey.value) return
  // Focus in a find/goto text input: ⌘W belongs to the input, not the tab.
  // Decline rather than no-op, so the keystroke still reaches it.
  //
  // onAppKeydown has carried this guard all along; it only starts mattering now
  // that the menu's `close` role stopped swallowing ⌘W before the renderer ever
  // saw it (main/menu.ts). INPUT only, deliberately — Monaco's editing surface
  // is a TEXTAREA, and ⌘W must still close the tab from inside the editor.
  if ((document.activeElement as HTMLElement | null)?.tagName === 'INPUT') return false
  // Returned, not awaited: the handler has to be synchronous to decline at all
  // (executeCommand compares the return value to `false`), while invokeCommand
  // still awaits the promise this hands back.
  return closeFile(activeKey.value)
})
// ⌘⇧W. Routed through closeEditorWindow so it keeps the unsaved-changes prompt
// and the plugin-view branch, exactly like Escape and the traffic lights.
registerCommand('workbench.action.closeWindow', () => { void closeEditorWindow() })
// ⇧⌘R. Unlike the main window, everything unsaved here lives only in the
// renderer, so a reload discards it outright — ask first when it would.
registerCommand('workbench.action.reloadWindow', async () => {
  const dirty = openFiles.value.filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length > 0) {
    const ok = await confirm(
      i18n.global.t('editorWindow.reload-dirty', { count: dirty.length }),
      { title: i18n.global.t('settings.keybindings.cmd.workbench_action_reloadWindow'), confirmText: i18n.global.t('action.reload') }
    )
    if (!ok) return
  }
  location.reload()
})
// Save every dirty file buffer to disk (reuses EditorPane.save, which carries
// the mtime-conflict protection).
async function saveDirtyFiles(): Promise<void> {
  for (const [key, pane] of editorPaneRefs.entries()) {
    const f = findTab(key)
    if (f?.kind === 'file' && f.dirty) await pane.save()
  }
}
registerCommand('workbench.action.saveAll', saveDirtyFiles)
registerCommand('workbench.action.closeAllEditors', async () => {
  const dirty = openFiles.value.filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length > 0) {
    const ok = await confirm(i18n.global.t('editorWindow.close-all-dirty', { count: dirty.length }), {
      title: i18n.global.t('action.close-all'), confirmText: i18n.global.t('action.close-all'),
    })
    if (!ok) return
  }
  openFiles.value = []
  activeKey.value = ''
})
registerCommand('workbench.action.closeOtherEditors', async () => {
  const cur = activeKey.value
  if (!cur) return
  const others = openFiles.value.filter((f) => tabKey(f) !== cur && f.kind === 'file' && f.dirty)
  if (others.length > 0) {
    const ok = await confirm(i18n.global.t('editorWindow.close-others-dirty', { count: others.length }), {
      title: i18n.global.t('action.close-others'), confirmText: i18n.global.t('action.close'),
    })
    if (!ok) return
  }
  openFiles.value = openFiles.value.filter((f) => tabKey(f) === cur)
})
registerCommand('workbench.action.closeEditorsToTheRight', async () => {
  const cur = activeKey.value
  if (!cur) return
  const idx = openFiles.value.findIndex((f) => tabKey(f) === cur)
  if (idx < 0) return
  const dirty = openFiles.value.slice(idx + 1).filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length > 0) {
    const ok = await confirm(i18n.global.t('editorWindow.close-right-dirty', { count: dirty.length }), {
      title: i18n.global.t('action.close-to-right'), confirmText: i18n.global.t('action.close'),
    })
    if (!ok) return
  }
  openFiles.value = openFiles.value.slice(0, idx + 1)
})
registerCommand('workbench.action.closeEditorsToTheLeft', async () => {
  const cur = activeKey.value
  if (!cur) return
  const idx = openFiles.value.findIndex((f) => tabKey(f) === cur)
  if (idx <= 0) return
  const dirty = openFiles.value.slice(0, idx).filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length > 0) {
    const ok = await confirm(i18n.global.t('editorWindow.close-left-dirty', { count: dirty.length }), {
      title: i18n.global.t('action.close-to-left'), confirmText: i18n.global.t('action.close'),
    })
    if (!ok) return
  }
  openFiles.value = openFiles.value.slice(idx)
})
registerCommand('workbench.action.openNextEditor', () => {
  const files = openFiles.value
  if (!files.length) return
  const idx = files.findIndex((f) => tabKey(f) === activeKey.value)
  const next = files[(idx + 1) % files.length]
  activeKey.value = next ? tabKey(next) : ''
})
registerCommand('workbench.action.openPreviousEditor', () => {
  const files = openFiles.value
  if (!files.length) return
  const idx = files.findIndex((f) => tabKey(f) === activeKey.value)
  const prev = files[(idx - 1 + files.length) % files.length]
  activeKey.value = prev ? tabKey(prev) : ''
})
registerCommand('workbench.action.moveEditorRightInGroup', () => {
  const files = openFiles.value
  const idx = files.findIndex((f) => tabKey(f) === activeKey.value)
  if (idx < 0 || idx >= files.length - 1) return
  ;[files[idx], files[idx + 1]] = [files[idx + 1], files[idx]]
})
registerCommand('workbench.action.moveEditorLeftInGroup', () => {
  const files = openFiles.value
  const idx = files.findIndex((f) => tabKey(f) === activeKey.value)
  if (idx <= 0) return
  ;[files[idx], files[idx - 1]] = [files[idx - 1], files[idx]]
})

// ── Navigation history (⌃- / ⌃⇧-) ──────────────────────────────────────────
const _navHistory: string[] = []
let _navIdx = -1
let _navIgnore = false
watch(activeKey, (v) => {
  if (!v || _navIgnore) return
  if (_navIdx < _navHistory.length - 1) _navHistory.splice(_navIdx + 1)
  _navHistory.push(v)
  _navIdx = _navHistory.length - 1
})
registerCommand('workbench.action.navigateBack', () => {
  if (_navIdx <= 0) return
  _navIgnore = true
  activeKey.value = _navHistory[--_navIdx]
  void nextTick(() => { _navIgnore = false })
})
registerCommand('workbench.action.navigateForward', () => {
  if (_navIdx >= _navHistory.length - 1) return
  _navIgnore = true
  activeKey.value = _navHistory[++_navIdx]
  void nextTick(() => { _navIgnore = false })
})

watch(activeKey, (key) => setContext('editorOpen', !!key), { immediate: true })

// ── Explorer pane ref (for revealFile) ───────────────────────────────────────
const explorerRef = ref<{ revealFile: (path: string) => Promise<void>; focusTree: () => void } | null>(null)

// ── Search pane ref (for openReplace / focusInput / setQuery) ───────────────
const searchRef = ref<{ openReplace: () => void; focusInput: () => void; setQuery: (q: string) => void } | null>(null)
registerCommand('workbench.action.findInFilesReplace', () => {
  sidebarHidden.value = false
  sidebarView.value = 'search'
  void nextTick(() => searchRef.value?.openReplace())
})
registerCommand('editor.action.findReferences', () => {
  const word = activeEditor()?.getWordAtCursor?.() ?? ''
  if (!word) return
  sidebarHidden.value = false
  sidebarView.value = 'search'
  void nextTick(() => searchRef.value?.setQuery(word))
})
registerCommand('editor.action.changeEOLtoCRLF',     () => activeEditor()?.changeEOL('CRLF'))
registerCommand('editor.action.changeEOLtoLF',       () => activeEditor()?.changeEOL('LF'))
registerCommand('editor.action.selectLine',          () => activeEditor()?.selectLine())
registerCommand('editor.action.transpose',           () => activeEditor()?.transpose())
registerCommand('editor.action.indentationToSpaces', () => activeEditor()?.indentationToSpaces())
registerCommand('editor.action.indentationToTabs',   () => activeEditor()?.indentationToTabs())
registerCommand('editor.action.detectIndentation', () => {
  const content = activeEditor()?.getContent() ?? ''
  const lines = content.split('\n').slice(0, 200).filter((l) => l.match(/^\s+\S/))
  const tabCount = lines.filter((l) => l.startsWith('\t')).length
  const spaceLines = lines.filter((l) => l.startsWith(' '))
  if (lines.length === 0) { toast('No indented lines detected'); return }
  if (tabCount > spaceLines.length) {
    toast('Detected indentation: Tabs')
  } else if (spaceLines.length > 0) {
    const sizes: Record<number, number> = {}
    for (const l of spaceLines) { const n = l.match(/^( +)/)?.[1].length ?? 0; if (n > 0) sizes[n] = (sizes[n] ?? 0) + 1 }
    const size = Object.entries(sizes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '2'
    toast(`Detected indentation: ${size} Spaces`)
  } else {
    toast('Detected indentation: Spaces')
  }
})

// ── Tab bar: auto-scroll active tab into view ─────────────────────────────────
const tabsEl = ref<HTMLElement | null>(null)
watch(activeKey, async () => {
  await nextTick()
  tabsEl.value?.querySelector<HTMLElement>('.ide-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
})

// ── Command Palette ──────────────────────────────────────────────────────────
interface PaletteCmd { id: string; label: string; keys?: string }
const PALETTE_COMMANDS: PaletteCmd[] = [
  { id: 'editor.action.save',                     label: 'Save File',     keys: '⌘S' },
  { id: 'workbench.action.saveAll',               label: 'Save All',     keys: '⌘⇧S' },
  { id: 'workbench.action.closeActiveEditor',     label: 'Close Editor',   keys: '⌘W' },
  { id: 'editor.action.undo',      label: 'Undo',       keys: '⌘Z' },
  { id: 'editor.action.redo',      label: 'Redo',       keys: '⌘⇧Z' },
  { id: 'editor.action.selectAll', label: 'Select All',       keys: '⌘A' },
  { id: 'editor.action.openFind',              label: 'Find',                      keys: '⌘F' },
  { id: 'editor.action.useSelectionForFind', label: 'Find with Selection',        keys: '⌘E' },
  { id: 'editor.action.gotoLine',  label: 'Go to Line',     keys: '⌘L' },
  { id: 'editor.action.toggleComment',   label: 'Toggle Line Comment',     keys: '⌘/' },
  { id: 'editor.action.deleteLines',     label: 'Delete Line',         keys: '⌘⇧K' },
  { id: 'editor.action.insertLineAfter', label: 'Insert Line Below',   keys: '⌘↵' },
  { id: 'editor.action.insertLineBefore',label: 'Insert Line Above',   keys: '⌘⇧↵' },
  { id: 'editor.action.moveLineUp',      label: 'Move Line Up',     keys: '⌥↑' },
  { id: 'editor.action.moveLineDown',    label: 'Move Line Down',     keys: '⌥↓' },
  { id: 'editor.action.selectHighlights',  label: 'Select All Occurrences',   keys: '⌘⇧L' },
  { id: 'editor.action.jumpToBracket',     label: 'Jump to Matching Bracket' },
  { id: 'editor.action.selectToBracket',  label: 'Select to Matching Bracket' },
  { id: 'editor.action.duplicateLineDown', label: 'Copy Line Down',   keys: '⇧⌥↓' },
  { id: 'editor.action.duplicateLineUp',   label: 'Copy Line Up',   keys: '⇧⌥↑' },
  { id: 'editor.action.indentLines',       label: 'Indent Line',        keys: '⌘]' },
  { id: 'editor.action.outdentLines',      label: 'Outdent Line',    keys: '⌘[' },
  { id: 'editor.action.cursorTop',              label: 'Go to Beginning of File',         keys: '⌘↑' },
  { id: 'editor.action.cursorBottom',           label: 'Go to End of File',               keys: '⌘↓' },
  { id: 'editor.action.cursorTopSelect',        label: 'Select to Beginning of File',     keys: '⌘⇧↑' },
  { id: 'editor.action.cursorBottomSelect',     label: 'Select to End of File',           keys: '⌘⇧↓' },
  { id: 'editor.action.cursorWordLeft',         label: 'Move Cursor Word Left',           keys: '⌥←' },
  { id: 'editor.action.cursorWordRight',        label: 'Move Cursor Word Right',          keys: '⌥→' },
  { id: 'editor.action.cursorWordLeftSelect',   label: 'Select Word Left',                keys: '⌥⇧←' },
  { id: 'editor.action.cursorWordRightSelect',  label: 'Select Word Right',               keys: '⌥⇧→' },
  { id: 'editor.action.scrollLineUp',           label: 'Scroll Line Up',                  keys: '⌃↑' },
  { id: 'editor.action.scrollLineDown',         label: 'Scroll Line Down',                keys: '⌃↓' },
  { id: 'editor.action.addSelectionToNextFindMatch', label: 'Select Next Occurrence', keys: '⌘D' },
  { id: 'editor.action.addLineComment',       label: 'Add Line Comment',       keys: '⌘K ⌘C' },
  { id: 'editor.action.removeLineComment',    label: 'Remove Line Comment',       keys: '⌘K ⌘U' },
  { id: 'editor.action.blockComment',         label: 'Toggle Block Comment',     keys: '⌘⌥/' },
  { id: 'editor.action.transformToUppercase',  label: 'Transform to Uppercase' },
  { id: 'editor.action.transformToLowercase',  label: 'Transform to Lowercase' },
  { id: 'editor.action.transformToTitlecase',  label: 'Transform to Title Case' },
  { id: 'editor.action.transformToSnakeCase',  label: 'Transform to Snake Case' },
  { id: 'editor.action.transformToCamelCase',  label: 'Transform to Camel Case' },
  { id: 'editor.action.transformToKebabCase',  label: 'Transform to Kebab Case' },
  { id: 'editor.action.transformToPascalCase',   label: 'Transform to Pascal Case' },
  { id: 'editor.action.transformToBase64',       label: 'Transform to Base64' },
  { id: 'editor.action.transformFromBase64',     label: 'Transform from Base64' },
  { id: 'editor.action.transformToUrlEncoded',   label: 'URL Encode Selection' },
  { id: 'editor.action.transformFromUrlEncoded', label: 'URL Decode Selection' },
  { id: 'editor.action.joinLines',              label: 'Join Lines',                  keys: '⌃J' },
  { id: 'editor.action.sortLinesAscending',    label: 'Sort Lines Ascending' },
  { id: 'editor.action.sortLinesDescending',   label: 'Sort Lines Descending' },
  { id: 'editor.action.reverseLines',          label: 'Reverse Lines' },
  { id: 'editor.action.removeDuplicateLines',  label: 'Remove Duplicate Lines' },
  { id: 'editor.action.openLink',              label: 'Open Link at Cursor',         keys: '⌘⌥↩' },
  { id: 'editor.action.changeEOLtoCRLF',       label: 'Change End of Line to CRLF' },
  { id: 'editor.action.changeEOLtoLF',         label: 'Change End of Line to LF' },
  { id: 'editor.action.indentationToSpaces',   label: 'Convert Indentation to Spaces' },
  { id: 'editor.action.indentationToTabs',     label: 'Convert Indentation to Tabs' },
  { id: 'editor.action.selectCurrentWord',       label: 'Select Current Word' },
  { id: 'editor.action.trimTrailingWhitespace', label: 'Trim Trailing Whitespace',   keys: '⌘K ⌘X' },
  { id: 'editor.action.toggleLineNumbers',      label: 'Toggle Line Numbers',         keys: '⌘K ⌘L' },
  { id: 'editor.action.toggleWordWrap',         label: 'Toggle Word Wrap' },
  { id: 'editor.action.marker.nextInFiles',     label: 'Next Problem',                keys: 'F8' },
  { id: 'editor.action.marker.prevInFiles',     label: 'Previous Problem',            keys: '⇧F8' },
  { id: 'workbench.action.problems.focus',      label: 'Show Problems',               keys: '⌘⇧M' },
  { id: 'editor.action.quickFix',               label: 'Quick Fix',                   keys: '⌘.' },
  { id: 'editor.fold',             label: 'Fold',               keys: '⌘⌥[' },
  { id: 'editor.unfold',           label: 'Unfold',             keys: '⌘⌥]' },
  { id: 'editor.toggleFold',       label: 'Toggle Fold' },
  { id: 'editor.foldAll',          label: 'Fold All',           keys: '⌘K ⌘0' },
  { id: 'editor.unfoldAll',        label: 'Unfold All',         keys: '⌘K ⌘J' },
  { id: 'editor.foldRecursively',  label: 'Fold Recursively',   keys: '⌘K ⌘[' },
  { id: 'editor.unfoldRecursively',label: 'Unfold Recursively', keys: '⌘K ⌘]' },
  { id: 'editor.foldLevel1',       label: 'Fold Level 1',       keys: '⌘K ⌘1' },
  { id: 'editor.foldLevel2',       label: 'Fold Level 2',       keys: '⌘K ⌘2' },
  { id: 'editor.foldLevel3',       label: 'Fold Level 3',       keys: '⌘K ⌘3' },
  { id: 'editor.foldLevel4',       label: 'Fold Level 4',       keys: '⌘K ⌘4' },
  { id: 'editor.foldLevel5',       label: 'Fold Level 5',       keys: '⌘K ⌘5' },
  { id: 'editor.foldLevel6',       label: 'Fold Level 6',       keys: '⌘K ⌘6' },
  { id: 'editor.foldLevel7',       label: 'Fold Level 7',       keys: '⌘K ⌘7' },
  { id: 'editor.action.insertCursorAbove',                   label: 'Add Cursor Above',                   keys: '⌘⌥↑' },
  { id: 'editor.action.insertCursorBelow',                   label: 'Add Cursor Below',                   keys: '⌘⌥↓' },
  { id: 'editor.action.insertCursorAtEndOfEachLineSelected', label: 'Add Cursors to Line Ends',           keys: '⇧⌥I' },
  { id: 'workbench.action.splitEditor',          label: 'Split Editor',               keys: '⌘\\' },
  { id: 'workbench.action.focusPreviousGroup',   label: 'Focus Previous Editor Group', keys: '⌘K ⌘←' },
  { id: 'workbench.action.focusNextGroup',       label: 'Focus Next Editor Group',    keys: '⌘K ⌘→' },
  { id: 'workbench.action.gotoSymbol',         label: 'Go to Symbol in File',     keys: '⌘⇧O' },
  { id: 'workbench.action.gotoWorkspaceSymbol', label: 'Go to Symbol in Workspace', keys: '⌘T' },
  { id: 'workbench.action.changeLanguageMode', label: 'Change Language Mode', keys: '⌘K ⌘M' },
  { id: 'editor.action.fontZoomIn',    label: 'Increase Font Size',     keys: '⌘=' },
  { id: 'editor.action.fontZoomOut',   label: 'Decrease Font Size',     keys: '⌘-' },
  { id: 'editor.action.fontZoomReset', label: 'Reset Font Size', keys: '⌘0' },
  { id: 'workbench.action.newFile',            label: 'New File',     keys: '⌘N' },
  { id: 'workbench.action.closeAllEditors', label: 'Close All Editors', keys: '⌘K ⌘W' },
  { id: 'editor.action.nextMatch',         label: 'Next Match',  keys: '⌘G' },
  { id: 'editor.action.prevMatch',       label: 'Previous Match',   keys: '⌘⇧G' },
  { id: 'editor.action.inlineRewrite',   label: 'AI Rewrite',        keys: '⌘K ⌘K' },
  { id: 'editor.action.triggerGhost',    label: 'AI Completion (Cmd+I)',keys: '⌘I' },
  { id: 'workbench.action.toggleSidebar',label: 'Toggle Sidebar',     keys: '⌘B' },
  { id: 'workbench.action.focusExplorer',label: 'Show Explorer',   keys: '⌘⇧E' },
  { id: 'workbench.action.focusSourceControl', label: 'Show Source Control', keys: '⌘⇧G' },
  { id: 'workbench.action.focusActiveEditorGroup', label: 'Focus Editor', keys: '⌘K ⌘E' },
  { id: 'workbench.action.findInFiles',  label: 'Find in Files',   keys: '⌘⇧F' },
  { id: 'workbench.action.openMiniIDE', label: 'Open Mini-IDE',   keys: '⌘⇧I' },
  { id: 'workbench.action.openNextEditor',      label: 'Next Tab',   keys: '⌃Tab' },
  { id: 'workbench.action.openPreviousEditor',  label: 'Previous Tab',   keys: '⌃⇧Tab' },
  { id: 'workbench.action.quickOpen',             label: 'Quick Open',     keys: '⌘P' },
  { id: 'workbench.action.reopenClosedEditor',    label: 'Reopen Last Closed Tab', keys: '⌘⇧T' },
  { id: 'workbench.action.openKeyboardShortcuts', label: 'Show Keyboard Shortcuts',       keys: '⌘K ⌘S' },
  { id: 'workbench.action.selectTheme',           label: 'Select Color Theme',     keys: '⌘K ⌘T' },
  { id: 'editor.action.openReplace',    label: 'Find and Replace',       keys: '⌘⌥F' },
  { id: 'editor.action.formatDocument', label: 'Format Document',       keys: '⌥⇧F' },
  { id: 'editor.action.formatSelection',label: 'Format Selection',   keys: '⌘K ⌘F' },
  { id: 'workbench.action.toggleAIChat',         label: 'Toggle AI Terminal',                   keys: '⌘⇧A / ⌃`' },
  { id: 'workbench.action.addSelectionToChat',  label: 'Add Selection/Word to AI Terminal',    keys: '⌘⇧L' },
  { id: 'editor.action.smartSelect.expand',          label: 'Expand Selection',   keys: '⇧⌥→' },
  { id: 'editor.action.smartSelect.shrink',          label: 'Shrink Selection',   keys: '⇧⌥←' },
  { id: 'workbench.action.copyFilePath',         label: 'Copy Absolute Path',      keys: '⌘K ⌘P' },
  { id: 'workbench.action.revealInExplorer',label: 'Reveal in Explorer', keys: '⌘K ⌘R' },
  { id: 'workbench.action.revealFileInOS',  label: 'Reveal in Finder',  keys: '⇧⌥R' },
  { id: 'workbench.action.newWindow',       label: 'New Editor Window',    keys: '⌘⇧N' },
  { id: 'workbench.action.openEditorAtIndex1', label: 'Switch to Tab 1', keys: '⌘1' },
  { id: 'workbench.action.openEditorAtIndex2', label: 'Switch to Tab 2', keys: '⌘2' },
  { id: 'workbench.action.openEditorAtIndex3', label: 'Switch to Tab 3', keys: '⌘3' },
  { id: 'editor.action.deleteWordLeft',              label: 'Delete Word Left',   keys: '⌥⌫' },
  { id: 'editor.action.deleteWordRight',             label: 'Delete Word Right',   keys: '⌥⌦' },
  { id: 'editor.action.deleteAllLeft',              label: 'Delete to Line Start',       keys: '⌘⌫' },
  { id: 'editor.action.deleteAllRight',             label: 'Delete to Line End',       keys: '⌘⌦' },
  { id: 'workbench.action.closeOtherEditors',       label: 'Close Other Editors' },
  { id: 'workbench.action.closeEditorsToTheRight', label: 'Close Editors to the Right' },
  { id: 'workbench.action.closeEditorsToTheLeft',  label: 'Close Editors to the Left' },
  { id: 'workbench.action.moveEditorRightInGroup',  label: 'Move Tab Right',   keys: '⌘⇧]' },
  { id: 'workbench.action.moveEditorLeftInGroup',   label: 'Move Tab Left',   keys: '⌘⇧[' },
  { id: 'workbench.action.navigateBack',    label: 'Go Back', keys: '⌃-' },
  { id: 'workbench.action.navigateForward', label: 'Go Forward', keys: '⌃⇧-' },
  { id: 'workbench.action.toggleZenMode',  label: 'Toggle Zen Mode',    keys: '⌘K ⌘Z' },
  { id: 'workbench.action.openFolder',    label: 'Open Folder',    keys: '⌘K ⌘O' },
  { id: 'workbench.action.reloadWindow',  label: 'Reload Window' },
  { id: 'workbench.action.openFile',      label: 'Open File',     keys: '⌘O' },
  { id: 'workbench.action.openSettings',  label: 'Open Settings',     keys: '⌘,' },
  { id: 'workbench.action.findInFilesReplace', label: 'Replace in Files', keys: '⌘⇧H' },
  { id: 'editor.action.transpose',           label: 'Transpose Characters',     keys: '⌃T' },
  { id: 'editor.action.selectLine',          label: 'Select Current Line',     keys: '⌃L' },
  { id: 'editor.action.navigateToLastEditLocation', label: 'Go to Last Edit Location', keys: '⌘K ⌘Q' },
  { id: 'editor.action.moveSelectionToNextFindMatch', label: 'Move Selection to Next Occurrence', keys: '⌘K ⌘D' },
  { id: 'workbench.action.copyRelativeFilePath', label: 'Copy Relative Path', keys: '⌘⇧⌥C' },
  { id: 'editor.action.openFileAtCursor',  label: 'Open File at Cursor',           keys: 'F12' },
  { id: 'editor.action.findReferences',   label: 'Find References in Files',      keys: '⇧F12' },
  { id: 'editor.action.renameSymbol',     label: 'Rename Symbol (Select All)',    keys: 'F2' },
  { id: 'editor.action.detectIndentation',    label: 'Detect Indentation' },
]
const paletteOpen = ref(false)
const paletteQuery = ref('')
const paletteIdx = ref(0)
const paletteInputEl = ref<HTMLInputElement | null>(null)
const filteredCmds = computed(() => {
  const q = paletteQuery.value.toLowerCase()
  return q
    ? PALETTE_COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
    : PALETTE_COMMANDS
})
function openPalette(): void {
  paletteOpen.value = true
  paletteQuery.value = ''
  paletteIdx.value = 0
  void nextTick(() => paletteInputEl.value?.focus())
}
function closePalette(): void { paletteOpen.value = false }
function runPaletteCmd(id: string | undefined): void {
  if (!id) return
  closePalette()
  void Promise.resolve().then(() => executeCommand(id))
}
function onPaletteKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closePalette() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx.value = (paletteIdx.value + 1) % Math.max(1, filteredCmds.value.length) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx.value = (paletteIdx.value - 1 + filteredCmds.value.length) % Math.max(1, filteredCmds.value.length) }
  else if (e.key === 'Enter') { e.preventDefault(); runPaletteCmd(filteredCmds.value[paletteIdx.value]?.id) }
}
watch(paletteQuery, () => { paletteIdx.value = 0 })
registerCommand('workbench.action.showCommands', openPalette)

// ── Quick Open (⌘P) ─────────────────────────────────────────────────────────
type QoFileItem   = { qoKind: 'file';   name: string; relPath: string; wsPath?: string; key: string }
type QoLineItem   = { qoKind: 'line';   line: number }
type QoSymbolItem = { qoKind: 'symbol'; name: string; line: number; kind: string }
type QoHeaderItem = { qoKind: 'header'; label: string }
type QoItem = QoFileItem | QoLineItem | QoSymbolItem | QoHeaderItem

const qoOpen = ref(false)
const qoQuery = ref('')
const qoIdx = ref(0)
const qoInputEl = ref<HTMLInputElement | null>(null)
const qoPlaceholder = computed(() => {
  const q = qoQuery.value
  if (q.startsWith(':')) return 'Enter line number to jump to… (e.g. :42)'
  if (q === '@:') return 'Show all symbols grouped'
  if (q.startsWith('@')) return 'Enter symbol name… (e.g. @myFunction  @:grouped)'
  return 'Search open files… (:line  @symbol  >command)'
})
const qoItems = computed((): QoItem[] => {
  const q = qoQuery.value
  // :N → jump to line in current file
  if (q.startsWith(':')) {
    const n = parseInt(q.slice(1).trim(), 10)
    if (!isNaN(n) && n > 0) return [{ qoKind: 'line', line: n }]
    return []
  }
  // @name → filter symbols from active file
  if (q.startsWith('@')) {
    const rest = q.slice(1)
    const grouped = rest.startsWith(':')
    const symQ = (grouped ? rest.slice(1) : rest).toLowerCase()
    const f = activeFile.value
    if (!f || f.kind !== 'file') return []
    const content = activeEditor()?.getContent?.() ?? ''
    const ext = f.name.split('.').pop() ?? ''
    const all = _extractSymbols(content, ext)
    const filtered = symQ ? all.filter((s) => s.name.toLowerCase().includes(symQ)) : all
    if (!grouped) return filtered.map((s): QoSymbolItem => ({ qoKind: 'symbol', name: s.name, line: s.line ?? 1, kind: s.kind ?? '' }))
    // @: grouped mode: insert header items before each kind group
    const groups = new Map<string, BcItem[]>()
    for (const s of filtered) { const k = s.kind ?? 'other'; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(s) }
    const out: QoItem[] = []
    for (const [kind, syms] of groups) {
      out.push({ qoKind: 'header', label: kind })
      out.push(...syms.map((s): QoSymbolItem => ({ qoKind: 'symbol', name: s.name, line: s.line ?? 1, kind: s.kind ?? '' })))
    }
    return out
  }
  // default: fuzzy-filter open + recently-closed files (subsequence match)
  const ql = q.toLowerCase()
  const files = openFiles.value.filter((f) => f.kind === 'file')
  const openSet = new Set(files.map(tabKey))
  const recentClosed = [...closedHistory].reverse().filter((r) => !openSet.has(tabKey(r))).slice(0, 20)
    .map((r) => ({ name: r.name, relPath: r.relPath, wsPath: r.wsPath, kind: 'file' as const, isDir: false }))
  const item = (f: { name: string; relPath: string; wsPath?: string }): QoFileItem =>
    ({ qoKind: 'file', name: f.name, relPath: f.relPath, wsPath: f.wsPath, key: tabKey(f) })
  if (!ql) {
    return [...files.map(item), ...recentClosed.slice(0, 8).map(item)]
  }
  type Scored = { f: (typeof files[0]) | (typeof recentClosed[0]); score: number }
  const scored: Scored[] = []
  for (const f of [...files, ...recentClosed]) {
    const nameLow = f.name.toLowerCase()
    const pathLow = f.relPath.toLowerCase()
    const nameHit = nameLow.includes(ql) ? 2 : _fuzzyScore(ql, nameLow)
    const pathHit = pathLow.includes(ql) ? 1 : _fuzzyScore(ql, pathLow) * 0.5
    const best = Math.max(nameHit, pathHit)
    if (best > 0) scored.push({ f, score: best })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map(({ f }) => item(f))
})
function openQuickOpen(): void {
  qoQuery.value = ''
  qoIdx.value = 0
  qoOpen.value = true
  void nextTick(() => qoInputEl.value?.focus())
}
function closeQuickOpen(): void { qoOpen.value = false }
function confirmQuickOpen(): void {
  const item = qoItems.value[qoIdx.value]
  if (!item || item.qoKind === 'header') { closeQuickOpen(); return }
  if (item.qoKind === 'file') { activeKey.value = item.key }
  else if (item.qoKind === 'line') { activeEditor()?.jumpToLine(item.line) }
  else if (item.qoKind === 'symbol') { activeEditor()?.jumpToLine(item.line) }
  closeQuickOpen()
}
function qoItemKey(item: QoItem, i: number): string {
  if (item.qoKind === 'file') return item.key
  if (item.qoKind === 'line') return `line:${item.line}`
  if (item.qoKind === 'header') return `hdr:${i}:${item.label}`
  return `sym:${i}:${item.name}`
}
// Skip over header items when navigating with arrow keys
function _qoNextSelectable(from: number, dir: 1 | -1): number {
  const items = qoItems.value; let idx = from + dir
  while (idx >= 0 && idx < items.length && items[idx]?.qoKind === 'header') idx += dir
  return idx >= 0 && idx < items.length ? idx : from
}
function onQoKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeQuickOpen(); return }
  if (e.key === 'Enter') { e.preventDefault(); confirmQuickOpen(); return }
  if (e.key === 'ArrowDown') { e.preventDefault(); qoIdx.value = _qoNextSelectable(qoIdx.value, 1); return }
  if (e.key === 'ArrowUp') { e.preventDefault(); qoIdx.value = _qoNextSelectable(qoIdx.value, -1); return }
}
watch(qoQuery, (q) => {
  // If the first item is a non-selectable header (e.g. @: grouped mode), start at first real item
  const firstIdx = qoItems.value[0]?.qoKind === 'header' ? _qoNextSelectable(-1, 1) : 0
  qoIdx.value = firstIdx >= 0 ? firstIdx : 0
  // VS Code: typing '>' in Quick Open switches to command palette mode
  if (q.startsWith('>')) {
    const cmd = q.slice(1).trimStart()
    closeQuickOpen()
    openPalette()
    paletteQuery.value = cmd
  }
})
registerCommand('workbench.action.quickOpen', openQuickOpen)
registerCommand('workbench.action.focusActiveEditorGroup', () => { activeEditor()?.focus?.() })

// ── Split Editor ──────────────────────────────────────────────────────────────
registerCommand('workbench.action.splitEditor', splitEditor)
registerCommand('workbench.action.focusPreviousGroup', () => { activeGroupIsPrimary.value = true })
registerCommand('workbench.action.focusNextGroup', () => { if (secondaryGroup.value) activeGroupIsPrimary.value = false })

// ── Code Folding ──────────────────────────────────────────────────────────────
registerCommand('editor.fold',              () => { const e = activeEditor(); const l = e?.getCursorLine?.() ?? 0; e?.foldAt?.(l) })
registerCommand('editor.unfold',            () => { const e = activeEditor(); const l = e?.getCursorLine?.() ?? 0; e?.unfoldAt?.(l) })
registerCommand('editor.toggleFold',        () => { const e = activeEditor(); const l = e?.getCursorLine?.() ?? 0; e?.toggleFoldAt?.(l) })
registerCommand('editor.foldAll',           () => activeEditor()?.foldAll?.())
registerCommand('editor.unfoldAll',         () => activeEditor()?.unfoldAll?.())
registerCommand('editor.foldRecursively',   () => { const e = activeEditor(); const l = e?.getCursorLine?.() ?? 0; e?.foldRecursively?.(l) })
registerCommand('editor.unfoldRecursively', () => { const e = activeEditor(); const l = e?.getCursorLine?.() ?? 0; e?.unfoldRecursively?.(l) })
for (let _n = 1; _n <= 7; _n++) {
  const n = _n
  registerCommand(`editor.foldLevel${n}`, () => activeEditor()?.foldToLevel?.(n))
}
registerCommand('workbench.action.reopenClosedEditor', () => {
  const last = closedHistory.pop()
  if (last) openFile({ filepath: last.relPath, wsPath: last.wsPath, name: last.name })
})

// ── Problems Panel (F8 / ⇧F8 / ⌘⇧M) ──────────────────────────────────────────
// Diagnostics are addressed like tabs — by (workspace, relPath).
function diagKey(d: Diagnostic): string { return tabKeyOf(d.wsPath, d.relPath) }
function nextProblem(): void {
  const all = allDiagnosticsSorted()
  if (!all.length) { toast('No problems detected'); return }
  const curLine = (activeEditor()?.getCursorLine?.() ?? 0) + 1 // 1-based
  const curKey = activeKey.value
  const next = all.find(d => diagKey(d) > curKey || (diagKey(d) === curKey && d.line > curLine))
    ?? all[0]
  if (diagKey(next) !== curKey) openFile({ filepath: next.relPath, wsPath: next.wsPath })
  nextTick(() => (activeEditor() as unknown as { revealLine?: (line: number) => void } | null)?.revealLine?.(next.line))
}
function prevProblem(): void {
  const all = allDiagnosticsSorted()
  if (!all.length) { toast('No problems detected'); return }
  const curLine = (activeEditor()?.getCursorLine?.() ?? 0) + 1
  const curKey = activeKey.value
  const reversed = [...all].reverse()
  const prev = reversed.find(d => diagKey(d) < curKey || (diagKey(d) === curKey && d.line < curLine))
    ?? reversed[0]
  if (diagKey(prev) !== curKey) openFile({ filepath: prev.relPath, wsPath: prev.wsPath })
  nextTick(() => (activeEditor() as unknown as { revealLine?: (line: number) => void } | null)?.revealLine?.(prev.line))
}
registerCommand('editor.action.marker.nextInFiles', nextProblem)
registerCommand('editor.action.marker.prevInFiles', prevProblem)
registerCommand('workbench.action.problems.focus', () => { sidebarHidden.value = false; sidebarView.value = 'problems' })

// ── Quick Fix ⌘. ─────────────────────────────────────────────────────────────
const quickFixOpen = ref(false)
const quickFixItems = ref<Array<{ label: string; message: string }>>([])
const quickFixIdx = ref(0)

function showQuickFix(): void {
  const curLine = (activeEditor()?.getCursorLine?.() ?? 0) + 1 // diagnostics are 1-based
  const diags = (allDiagnosticsSorted()).filter(d => diagKey(d) === activeKey.value && d.line === curLine)
  if (!diags.length) { toast('No quick fixes available'); return }
  quickFixItems.value = diags.map(d => ({ label: `AI Fix: ${d.message}`, message: d.message }))
  quickFixIdx.value = 0
  quickFixOpen.value = true
}
function closeQuickFix(): void { quickFixOpen.value = false }
function runQuickFix(idx: number): void {
  const item = quickFixItems.value[idx]
  closeQuickFix()
  if (!item) return
  executeCommand('editor.action.inlineRewrite')
}
registerCommand('editor.action.quickFix', showQuickFix)

// ── Multi-cursor ──────────────────────────────────────────────────────────────
registerCommand('editor.action.insertCursorAbove',                  () => activeEditor()?.insertCursorAbove?.())
registerCommand('editor.action.insertCursorBelow',                  () => activeEditor()?.insertCursorBelow?.())
registerCommand('editor.action.insertCursorAtEndOfEachLineSelected', () => activeEditor()?.addCursorsToLineEnds?.())

// ── Line comment ─────────────────────────────────────────────────────────────
registerCommand('editor.action.addLineComment',    () => activeEditor()?.addLineComment())
registerCommand('editor.action.removeLineComment', () => activeEditor()?.removeLineComment())
registerCommand('editor.action.blockComment',      () => activeEditor()?.toggleBlockComment())

// ── Font zoom (⌘=/⌘-/⌘0) ─────────────────────────────────────────────────────
registerCommand('editor.action.fontZoomIn',    () => activeEditor()?.zoomIn())
registerCommand('editor.action.fontZoomOut',   () => activeEditor()?.zoomOut())
registerCommand('editor.action.fontZoomReset', () => activeEditor()?.zoomReset())

// ── Interface zoom (⇧⌘=/⇧⌘-/⇧⌘0) ─────────────────────────────────────────────
// Scales this whole window's chrome, not just the editor's font. Main applies
// it to every window at once, so zooming here also moves the main shell.
registerCommand('workbench.action.zoomUiIn',    () => { stepUiScaleBy(1) })
registerCommand('workbench.action.zoomUiOut',   () => { stepUiScaleBy(-1) })
registerCommand('workbench.action.zoomUiReset', () => { resetUiScale() })
registerCommand('editor.action.toggleLineNumbers', () => activeEditor()?.toggleLineNumbers())
registerCommand('editor.action.toggleWordWrap',    () => activeEditor()?.toggleWordWrap())

// ── Go to Symbol in Workspace (⌘T) ──────────────────────────────────────────
interface WsymItem { name: string; kind: string; relPath: string; wsPath?: string; line: number }
const wsymOpen = ref(false)
const wsymQuery = ref('')
const wsymIdx = ref(0)
const wsymInputEl = ref<HTMLInputElement | null>(null)
const wsymItems = computed<WsymItem[]>(() => {
  if (!wsymOpen.value) return []
  const all: WsymItem[] = []
  for (const f of openFiles.value) {
    if (f.kind !== 'file') continue
    const content = editorPaneRefs.get(tabKey(f))?.getContent?.() ?? ''
    const ext = f.name.split('.').pop() ?? ''
    for (const s of _extractSymbols(content, ext)) {
      all.push({ name: s.name, kind: s.kind ?? '', relPath: f.relPath, wsPath: f.wsPath, line: s.line ?? 0 })
    }
    if (all.length >= 500) break
  }
  const q = wsymQuery.value.toLowerCase()
  return q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all
})
function openWorkspaceSymbol(): void {
  wsymOpen.value = true
  wsymQuery.value = ''
  wsymIdx.value = 0
  void nextTick(() => wsymInputEl.value?.focus())
}
function closeWorkspaceSymbol(): void { wsymOpen.value = false }
function confirmWorkspaceSymbol(): void {
  const item = wsymItems.value[wsymIdx.value]
  if (item) {
    openFile({ filepath: item.relPath, wsPath: item.wsPath, name: item.relPath.split('/').pop() ?? item.relPath, line: item.line })
    void nextTick(() => activeEditor()?.jumpToLine(item.line))
  }
  closeWorkspaceSymbol()
}
function onWsymKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeWorkspaceSymbol() }
  else if (e.key === 'Enter') { e.preventDefault(); confirmWorkspaceSymbol() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); wsymIdx.value = Math.min(wsymIdx.value + 1, wsymItems.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); wsymIdx.value = Math.max(0, wsymIdx.value - 1) }
}
watch(wsymQuery, () => { wsymIdx.value = 0 })
registerCommand('workbench.action.gotoWorkspaceSymbol', openWorkspaceSymbol)

// ── Go to Symbol (⌘⇧O) ──────────────────────────────────────────────────────
const symOpen = ref(false)
const symQuery = ref('')
const symIdx = ref(0)
const symInputEl = ref<HTMLInputElement | null>(null)
const symItems = computed(() => {
  if (!symOpen.value) return []
  const f = activeFile.value
  if (!f || f.kind !== 'file') return []
  const content = activeEditor()?.getContent?.() ?? ''
  const ext = f.name.split('.').pop() ?? ''
  const all = _extractSymbols(content, ext)
  const q = symQuery.value.toLowerCase()
  return q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all
})
function openGotoSymbol(): void {
  symOpen.value = true
  symQuery.value = ''
  symIdx.value = 0
  void nextTick(() => symInputEl.value?.focus())
}
function closeGotoSymbol(): void { symOpen.value = false }
function confirmGotoSymbol(): void {
  const item = symItems.value[symIdx.value]
  if (item?.line != null) activeEditor()?.jumpToLine(item.line)
  closeGotoSymbol()
}
function onSymKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeGotoSymbol() }
  else if (e.key === 'Enter') { e.preventDefault(); confirmGotoSymbol() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); symIdx.value = Math.min(symIdx.value + 1, symItems.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); symIdx.value = Math.max(0, symIdx.value - 1) }
}
watch(symQuery, () => { symIdx.value = 0 })
registerCommand('workbench.action.gotoSymbol', openGotoSymbol)

// ── Language mode picker (⌘K ⌘M) ────────────────────────────────────────────
interface LangOption { ext: string; label: string }
const LANGUAGES: LangOption[] = [
  { ext: 'ts', label: 'TypeScript' }, { ext: 'tsx', label: 'TypeScript JSX' },
  { ext: 'js', label: 'JavaScript' }, { ext: 'jsx', label: 'JavaScript JSX' },
  { ext: 'vue', label: 'Vue' }, { ext: 'py', label: 'Python' },
  { ext: 'json', label: 'JSON' }, { ext: 'md', label: 'Markdown' },
  { ext: 'html', label: 'HTML' }, { ext: 'css', label: 'CSS' },
  { ext: 'scss', label: 'SCSS' }, { ext: 'sh', label: 'Shell' },
  { ext: 'go', label: 'Go' }, { ext: 'rs', label: 'Rust' },
  { ext: 'java', label: 'Java' }, { ext: 'kt', label: 'Kotlin' },
  { ext: 'swift', label: 'Swift' }, { ext: 'cpp', label: 'C++' },
  { ext: 'c', label: 'C' }, { ext: 'yaml', label: 'YAML' },
  { ext: 'toml', label: 'TOML' }, { ext: 'sql', label: 'SQL' },
  { ext: '', label: 'Plain Text' },
]
const langOpen = ref(false)
const langQuery = ref('')
const langIdx = ref(0)
const langInputEl = ref<HTMLInputElement | null>(null)
const langItems = computed(() => {
  const q = langQuery.value.toLowerCase()
  return q ? LANGUAGES.filter((l) => l.label.toLowerCase().includes(q) || l.ext.includes(q)) : LANGUAGES
})
function openLangPicker(): void {
  langOpen.value = true
  langQuery.value = ''
  langIdx.value = 0
  void nextTick(() => langInputEl.value?.focus())
}
function closeLangPicker(): void { langOpen.value = false }
function confirmLangPicker(): void {
  const item = langItems.value[langIdx.value]
  if (item) activeEditor()?.setLanguage(item.ext)
  closeLangPicker()
}
function onLangKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeLangPicker() }
  else if (e.key === 'Enter') { e.preventDefault(); confirmLangPicker() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); langIdx.value = Math.min(langIdx.value + 1, langItems.value.length - 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); langIdx.value = Math.max(0, langIdx.value - 1) }
}
watch(langQuery, () => { langIdx.value = 0 })
registerCommand('workbench.action.changeLanguageMode', openLangPicker)

// ── Keyboard shortcuts reference (⌘K ⌘S) ─────────────────────────────────────
const kbOpen = ref(false)
const kbQuery = ref('')
const kbInputEl = ref<HTMLInputElement | null>(null)
const kbItems = computed(() => {
  const q = kbQuery.value.toLowerCase()
  return q
    ? PALETTE_COMMANDS.filter((c) => c.label.toLowerCase().includes(q) || (c.keys ?? '').toLowerCase().includes(q))
    : PALETTE_COMMANDS
})
function openKeyboardShortcuts(): void {
  kbOpen.value = true; kbQuery.value = ''
  void nextTick(() => kbInputEl.value?.focus())
}
function closeKeyboardShortcuts(): void { kbOpen.value = false }
function onKbKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeKeyboardShortcuts() }
}
registerCommand('workbench.action.openKeyboardShortcuts', openKeyboardShortcuts)

// ── Color theme picker (⌘K ⌘T) ───────────────────────────────────────────────
const { theme: currentTheme, setTheme, loadTheme } = useTheme()
const themeOpen = ref(false)
const themeQuery = ref('')
const themeIdx = ref(0)
const themeInputEl = ref<HTMLInputElement | null>(null)
let _themeBeforeOpen = ''
const themeItems = computed(() => {
  const q = themeQuery.value.toLowerCase()
  return q ? BUILTIN_THEMES.filter((t) => t.label.toLowerCase().includes(q)) : BUILTIN_THEMES
})
function openThemePicker(): void {
  _themeBeforeOpen = currentTheme.value
  themeOpen.value = true
  themeQuery.value = ''
  themeIdx.value = BUILTIN_THEMES.findIndex((t) => t.id === currentTheme.value)
  if (themeIdx.value < 0) themeIdx.value = 0
  void nextTick(() => themeInputEl.value?.focus())
}
function closeThemePicker(restoreOriginal = true): void {
  if (restoreOriginal) setTheme(_themeBeforeOpen)
  themeOpen.value = false
}
function confirmThemePicker(): void {
  const item = themeItems.value[themeIdx.value]
  if (item) setTheme(item.id)
  themeOpen.value = false
}
function previewTheme(idx: number): void {
  themeIdx.value = idx
  const item = themeItems.value[idx]
  if (item) setTheme(item.id)
}
function onThemeKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.stopPropagation(); closeThemePicker(true) }
  else if (e.key === 'Enter') { e.preventDefault(); confirmThemePicker() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); previewTheme(Math.min(themeIdx.value + 1, themeItems.value.length - 1)) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); previewTheme(Math.max(0, themeIdx.value - 1)) }
}
watch(themeQuery, () => { themeIdx.value = 0 })
registerCommand('workbench.action.selectTheme', openThemePicker)

// ── Modal context (any overlay open) → Escape can close via keybinding ────────
const newFileOpen = ref(false)
const newFilePath = ref('untitled.txt')
const newFileInputEl = ref<HTMLInputElement | null>(null)

function openNewFileDialog(): void {
  if (!workspacePath) return
  newFilePath.value = 'untitled.txt'
  newFileOpen.value = true
  nextTick(() => { newFileInputEl.value?.select() })
}
function closeNewFileDialog(): void { newFileOpen.value = false }
async function confirmNewFile(): Promise<void> {
  const relPath = newFilePath.value.trim()
  if (!relPath) { closeNewFileDialog(); return }
  closeNewFileDialog()
  const resp = await backend.send<{ ok: boolean; error?: string }>('fs.write_file', { workspace_path: workspacePath, rel_path: relPath, content: '' })
  if (!resp.payload?.ok) { toast(resp.payload?.error ?? 'Failed to create file'); return }
  openFile({ filepath: relPath })
}

const anyOverlayOpen = computed(() => paletteOpen.value || qoOpen.value || symOpen.value || wsymOpen.value || langOpen.value || kbOpen.value || themeOpen.value || newFileOpen.value || quickFixOpen.value)
watch(anyOverlayOpen, (v) => setContext('modalOpen', v))

// ── Close modal (Escape when any overlay is open) ────────────────────────────
registerCommand('workbench.action.closeModal', () => {
  if (paletteOpen.value) { closePalette(); return }
  if (qoOpen.value) { closeQuickOpen(); return }
  if (symOpen.value) { closeGotoSymbol(); return }
  if (wsymOpen.value) { closeWorkspaceSymbol(); return }
  if (quickFixOpen.value) { closeQuickFix(); return }
  if (langOpen.value) { closeLangPicker(); return }
  if (kbOpen.value) { closeKeyboardShortcuts(); return }
  if (themeOpen.value) { closeThemePicker(true); return }
  if (newFileOpen.value) { closeNewFileDialog(); return }
})

// ── New file (⌘N) ─────────────────────────────────────────────────────────────
registerCommand('workbench.action.newFile', openNewFileDialog)

async function closeEditorWindow(): Promise<void> {
  const dirty = openFiles.value.filter((f) => f.kind === 'file' && f.dirty)
  if (dirty.length > 0) {
    const ok = await confirm(
      i18n.global.t('editorWindow.close-editor-dirty', { count: dirty.length }),
      { title: i18n.global.t('editorWindow.close-editor'), confirmText: i18n.global.t('action.close') }
    )
    if (!ok) return
  }
  // Inside the plugin view there is no window to close — ask the host to hide
  // the view. The residual `?window=editor` window still closes itself.
  const navBridge = (window as unknown as { nav?: { hideSelf?: () => void } }).nav
  if (navBridge?.hideSelf) {
    navBridge.hideSelf()
    return
  }
  window.close()
}

function onAppKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && tabCtxMenu.value) { tabCtxMenu.value = null; return }
  if (e.key === 'Escape' && bcDropdown.value) { bcDropdown.value = null; return }
  if (e.key === 'Escape') {
    // Skip if focus is inside Monaco (Monaco handles Escape internally)
    if (document.activeElement?.closest('.monaco-editor')) return
    e.preventDefault()
    closeEditorWindow()
    return
  }
  const mod = e.metaKey || e.ctrlKey
  if (mod && (e.key === 'w' || e.key === 'W') && activeKey.value) {
    // Don't close the tab while focus is in a find/goto/cmdk text input.
    const tag = (document.activeElement as HTMLElement | null)?.tagName
    if (tag === 'INPUT') return
    e.preventDefault()
    closeFile(activeKey.value)
  }
  if (mod && e.key === 'l') {
    e.preventDefault()
    if (!aiPanelOpen.value) aiPanelOpen.value = true
    void nextTick(() => cliDockRef.value?.terminal?.focus())
  }
}

// Theme changes made in the main window arrive as ui.settings_changed
// broadcasts over this window's ws connection (they used to be cross-window
// localStorage `storage` events); re-apply on any theme key change.
let offThemeSettingsChange: (() => void) | null = null

// ── Incremental opens pushed by the host (plugin view only) ──────────────────
// The host delivers a new open target (entry-query-shaped params) to the
// already-running view instead of reloading it — mirroring the legacy
// `editor:openFile` / `editor:openDiff` / `editor:openBranchDiff` channels:
// add/reveal the tab in place so open tabs and unsaved buffers survive.
let offOpenTarget: (() => void) | null = null

function applyOpenTarget(p: Record<string, string>): void {
  applyEditorLocale(p.locale)
  const sidebar = p.sidebar
  if (sidebar === 'explorer' || sidebar === 'search' || sidebar === 'git') {
    sidebarView.value = sidebar
    sidebarHidden.value = false
  }
  if (p.diff_filepath) {
    openDiff({
      filepath: p.diff_filepath,
      staged: p.diff_staged === 'true',
      name: p.diff_name || undefined,
      commit: p.diff_commit || undefined,
    })
    return
  }
  if (p.branch_diff_base) {
    openBranchDiff({ base: p.branch_diff_base, compare: p.branch_diff_compare ?? '' })
    return
  }
  if (p.filepath) {
    const line = Number(p.line)
    openFile({
      filepath: p.filepath,
      name: p.name || undefined,
      line: Number.isFinite(line) && line > 0 ? line : undefined,
      wsPath: p.file_ws || undefined,
    })
  }
}

onMounted(() => {
  loadTheme()
  window.agentTeam?.onLanguageChanged?.(applyEditorLocale)
  offThemeSettingsChange = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:language')) {
      applyEditorLocale(settingsGet<string>('agent-team:language', ''))
    }
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
  })
  window.addEventListener('keydown', onAppKeydown)
  window.addEventListener('keydown', onBcCaptureKeydown, { capture: true })
  document.addEventListener('click', closeBcDropdown)
  const api = (window as Window & {
    agentTeam?: {
      onSwitchEditorSidebar?: (cb: (s: string) => void) => void
      onOpenEditorFile?: (cb: (params: Record<string, string>) => void) => void
      onOpenEditorDiff?: (cb: (params: Record<string, string>) => void) => void
      onOpenEditorBranchDiff?: (cb: (params: Record<string, string>) => void) => void
    }
  }).agentTeam
  api?.onSwitchEditorSidebar?.((sidebar) => {
    if (sidebar === 'explorer' || sidebar === 'search' || sidebar === 'git') {
      sidebarView.value = sidebar
      sidebarHidden.value = false
    }
  })
  api?.onOpenEditorFile?.((params) => {
    const line = Number(params.line)
    openFile({
      filepath: params.filepath ?? '',
      name: params.name,
      line: Number.isFinite(line) && line > 0 ? line : undefined,
      wsPath: params.file_ws || undefined,
    })
  })
  api?.onOpenEditorDiff?.((params) => {
    openDiff({
      filepath: params.filepath ?? '',
      staged: params.staged === 'true',
      name: params.name,
      commit: params.commit || undefined,
    })
  })
  api?.onOpenEditorBranchDiff?.((params) => {
    openBranchDiff({ base: params.branch_diff_base ?? 'main', compare: params.branch_diff_compare ?? '', workspacePath: params.workspace_path })
  })
  const navBridge = (window as unknown as {
    nav?: { onOpenTarget?: (cb: (params: Record<string, string>) => void) => () => void }
  }).nav
  offOpenTarget = navBridge?.onOpenTarget?.(applyOpenTarget) ?? null
  if (initialBranchDiffBase) openBranchDiff({ base: initialBranchDiffBase, compare: initialBranchDiffCompare })
  // Debounced at 300 ms like useGit's own listener: one git operation reaches
  // us twice (GitWatcher plus app.py's own broadcast).
  offGitChanged = backend.on('git.changed', () => {
    if (!openFiles.value.some((f) => f.kind === 'conflict')) return
    if (gitChangedTimer !== null) clearTimeout(gitChangedTimer)
    gitChangedTimer = setTimeout(() => {
      gitChangedTimer = null
      void loadConflictPaths()
    }, 300)
  })
})
onUnmounted(() => {
  offThemeSettingsChange?.()
  offThemeSettingsChange = null
  offOpenTarget?.()
  offOpenTarget = null
  offGitChanged?.()
  offGitChanged = null
  if (gitChangedTimer !== null) { clearTimeout(gitChangedTimer); gitChangedTimer = null }
  window.removeEventListener('keydown', onAppKeydown)
  window.removeEventListener('keydown', onBcCaptureKeydown, { capture: true })
  document.removeEventListener('click', closeBcDropdown)
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
})

function markDirty(key: string, v: boolean): void {
  const f = findTab(key)
  if (f) f.dirty = v
}

// Host owns the window title — tracks the active file (+ dirty marker).
watch(
  [activeKey, openFiles],
  () => {
    const f = activeFile.value
    document.title = f ? `${f.dirty ? '● ' : ''}${f.name} — Mini-IDE` : 'Mini-IDE'
  },
  { deep: true, immediate: true },
)

if (workspacePath && initialRel) openFile({ filepath: initialRel, name: initialName, line: initialLine, wsPath: initialFileWs || undefined })
if (workspacePath && initialDiffFile) openDiff({ filepath: initialDiffFile, staged: initialDiffStaged, name: initialDiffName, commit: initialDiffCommit || undefined })
</script>

<template>
  <div class="ide">
    <!-- Titlebar -->
    <div v-show="!zenMode" class="ide-titlebar">
      <WindowControls />
      <span class="ide-titlebar-name" v-truncate>{{ workspaceTitleName }}</span>
    </div>
    <div class="ide-body">
    <!-- Activity bar -->
    <div v-show="!zenMode" class="ide-activity">
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'explorer' }"
        :title="$t('pane.explorer.title')"
        @click="sidebarView = 'explorer'"
      >
        <svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
      </button>
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'search' }"
        :title="$t('pane.search.title')"
        @click="sidebarView = 'search'"
      >
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>
      </button>
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'git' }"
        :title="$t('pane.git.tab')"
        @click="sidebarView = 'git'"
      >
        <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM3.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm0-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"/></svg>
        <span v-if="changesCount" class="ide-act-badge">{{ changesCount > 99 ? '99+' : changesCount }}</span>
      </button>
      <button
        class="ide-act-btn"
        :class="{ active: sidebarView === 'problems' }"
        :title="$t('pane.problems.tab-shortcut')"
        @click="sidebarView = 'problems'; sidebarHidden = false"
      >
        <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor"><path d="M8.22 1.754a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm-.25-5.25a.75.75 0 0 0-1.5 0v2.5a.75.75 0 0 0 1.5 0Z"/></svg>
        <span v-if="allDiagnosticsSorted().filter(d => d.severity === 'error').length" class="ide-act-badge ide-act-badge--err">{{ allDiagnosticsSorted().filter(d => d.severity === 'error').length }}</span>
      </button>
    </div>

    <!-- Sidebar -->
    <div v-show="!sidebarHidden" class="ide-sidebar" :style="{ width: sidebarWidth + 'px' }">
      <ExplorerPane
        ref="explorerRef"
        v-show="sidebarView === 'explorer'"
        :workspace-path="workspacePath"
        :workspace-display-name="workspaceTitleName"
        :backend="backend"
        embedded
        :on-ask-ai-about-file="handleAskAiAboutFile"
        @open-file="openFile"
        @entry-renamed="onEntryRenamed"
      />
      <SearchPane
        ref="searchRef"
        v-show="sidebarView === 'search'"
        :workspace-path="workspacePath"
        :backend="backend"
        embedded
        :active="sidebarView === 'search'"
        @open-file="openFile"
      />
      <GitPane
        v-show="sidebarView === 'git'"
        :workspace-path="workspacePath"
        :git-transport="gitTransport"
        :file-access="surfacePorts.fileAccess"
        :ui="surfacePorts.paneUi"
        :issue-port="surfacePorts.issues"
        :credentials="surfacePorts.credentials"
        :accounts="surfacePorts.accounts"
        embedded
        @open-file="openFile"
        @open-diff="openDiff"
        @open-conflict="openConflict"
        @open-branch-diff="openBranchDiff"
        @changes-count="changesCount = $event"
      />
      <ProblemsPane
        v-show="sidebarView === 'problems'"
        :workspace-path="workspacePath"
        @open-file="(p) => openFile({ filepath: p.filepath, line: p.line, wsPath: p.wsPath })"
        @fix-with-ai="(p) => {
          const loc = `${tabDisplayPath({ wsPath: normWs(p.diag.wsPath), relPath: p.diag.relPath })}:${p.diag.line}${p.diag.col ? ':' + p.diag.col : ''}`
          pasteToCli(`Fix this problem: ${p.diag.severity.toUpperCase()}: ${p.diag.message} at ${loc}${p.diag.source ? ' (' + p.diag.source + ')' : ''}`)
        }"
      />
    </div>
    <div v-show="!sidebarHidden" class="ide-resize-handle" @mousedown.prevent="onResizeStart" />

    <!-- Editor area -->
    <div class="ide-main-container" :class="{ 'ide-split': secondaryGroup }">
      <div class="ide-main" :class="{ 'group-active': activeGroupIsPrimary && secondaryGroup }">
      <div v-if="openFiles.length && !zenMode" class="ide-tab-bar">
        <div ref="tabsEl" class="ide-tabs">
          <div
            v-for="f in openFiles"
            :key="f.id"
            class="ide-tab"
            :class="{ active: tabKey(f) === activeKey }"
            :title="(f.kind === 'diff' || f.kind === 'conflict') ? f.filepath : tabDisplayPath(f)"
            @click="activeKey = tabKey(f)"
            @contextmenu.prevent="openTabCtxMenu($event, tabKey(f))"
          >
            <span v-if="f.kind === 'diff'" class="ide-tab-diff-badge" :class="f.commit ? 'commit' : f.staged ? 'staged' : 'unstaged'">{{ f.commit ? 'C' : f.staged ? 'S' : 'U' }}</span>
            <span v-else-if="f.kind === 'conflict'" class="ide-tab-diff-badge conflict-badge">!</span>
            <span v-else-if="f.kind === 'branch-diff'" class="ide-tab-diff-badge branch-diff-badge">±</span>
            <span class="ide-tab-name">{{ f.name }}</span>
            <span v-if="f.dirty" class="ide-tab-dirty" :title="$t('label.unsaved')">●</span>
            <button class="ide-tab-close" :title="$t('action.close')" @click.stop="closeFile(tabKey(f))">✕</button>
          </div>
        </div>
        <div v-if="activeFile?.kind === 'file'" class="ide-tab-actions">
          <button
            v-if="activeFile && isPlanFile(activeFile.relPath)"
            class="ide-tab-act ide-tab-act--plan-toggle"
            :title="planViewFiles.has(activeKey) ? 'Switch to raw editor' : 'Switch to plan view'"
            @click="togglePlanView(activeKey)"
          >{{ planViewFiles.has(activeKey) ? 'Raw' : 'Plan' }}</button>
          <button
            v-if="activeFile && isPreviewToggleFile(activeFile.relPath)"
            class="ide-tab-act ide-tab-act--preview-toggle"
            :title="previewFiles.has(activeKey) ? $t('preview.switch-to-raw') : $t('preview.switch-to-preview')"
            @click="togglePreview(activeKey)"
          >{{ previewFiles.has(activeKey) ? $t('preview.toggle-raw') : $t('preview.toggle-preview') }}</button>
          <template v-if="!isPlanFile(activeFile?.relPath ?? '')">
            <button class="ide-tab-act" :title="'AI complete (⌘I)'" @click="activeEditor()?.requestGhost()">✦ Complete</button>
            <button class="ide-tab-act" :title="'AI rewrite selection (⌘K)'" @click="activeEditor()?.openCmdK()">✦ Cmd+K</button>
          </template>
        </div>
      </div>

      <!-- Breadcrumb -->
      <div v-if="activeKey" class="ide-breadcrumb">
        <template v-for="(seg, i) in activePath" :key="i">
          <span v-if="i > 0" class="ide-bc-sep">›</span>
          <span
            class="ide-bc-seg"
            :class="{ 'ide-bc-file': i === activePath.length - 1, 'ide-bc-seg--open': bcDropdown?.segIdx === i }"
            @click.stop="openBcDropdown(i, $event)"
          >{{ seg }}</span>
        </template>
      </div>

      <div class="ide-editors">
        <template v-for="f in openFiles" :key="f.id">
          <!-- Plan view: .plan.md files in plan mode, and plain .md files in
               markdown preview mode (same rendering pipeline). -->
          <PlanFileView
            v-if="f.kind === 'file' && ((isPlanFile(f.relPath) && planViewFiles.has(tabKey(f))) || (isMarkdownFile(f.relPath) && previewFiles.has(tabKey(f))))"
            v-show="tabKey(f) === activeKey"
            :workspace-path="fileWs(f)"
            :rel-path="f.relPath"
            :backend="backend"
            @dirty="(v) => markDirty(tabKey(f), v)"
          />
          <!-- File preview: media/PDF/binary files in preview mode. -->
          <div
            v-if="f.kind === 'file' && !isMarkdownFile(f.relPath) && !isPlanFile(f.relPath) && previewFiles.has(tabKey(f))"
            v-show="tabKey(f) === activeKey"
            class="ide-preview-stack"
          >
            <FilePreviewPane
              :key="tabKey(f)"
              :workspace-path="fileWs(f)"
              :rel-path="f.relPath"
              :name="f.name"
              :backend="backend"
            />
          </div>
          <!-- Code editor: shown for all non-plan files, and plan files in raw mode.
               Key changes when toggling plan/raw, forcing a fresh load from disk. -->
          <EditorPane
            v-if="f.kind === 'file' && !(isPlanFile(f.relPath) && planViewFiles.has(tabKey(f))) && !previewFiles.has(tabKey(f))"
            :key="f.id + ':' + (planViewFiles.has(tabKey(f)) ? 'plan' : 'raw')"
            v-show="tabKey(f) === activeKey"
            :ref="(el) => setEditorRef(tabKey(f), el)"
            :workspace-path="fileWs(f)"
            :port="editorPort"
            :rel-path="f.relPath"
            :name="f.name"
            :initial-line="f.line"
            :reveal-at="f.revealAt"
            :reveal-seq="f.revealSeq"
            embedded
            :active="tabKey(f) === activeKey"
            @dirty="(v) => markDirty(tabKey(f), v)"
            @add-to-chat="addSelectionToChat(f, $event)"
            @explain-with-ai="explainSelectionWithAi(f, $event)"
            @fix-with-ai="fixSelectionWithAi(f, $event)"
            @write-tests-with-ai="writeTestsWithAi(f, $event)"
            @ask-with-ai="askSelectionWithAi(f, $event)"
          />
          <DiffPane
            v-else-if="f.kind === 'diff'"
            v-show="tabKey(f) === activeKey"
            :workspace-path="workspacePath"
            :filepath="f.filepath!"
            :staged="f.staged!"
            :commit="f.commit"
            :name="f.name"
            :git-transport="gitTransport"
            :file-access="surfacePorts.fileAccess"
            @open-file="openFile"
          />
          <ConflictPane
            v-else-if="f.kind === 'conflict'"
            v-show="tabKey(f) === activeKey"
            :workspace-path="workspacePath"
            :filepath="f.filepath!"
            :name="f.name"
            :git-transport="gitTransport"
            :file-access="surfacePorts.fileAccess"
            :merge-aborted="mergeAbortedFor(f.filepath!)"
            @resolved="closeFile(tabKey(f))"
          />
          <BranchDiffPane
            v-else-if="f.kind === 'branch-diff'"
            v-show="tabKey(f) === activeKey"
            :workspace-path="fileWs(f)"
            :base="f.base!"
            :compare="f.compare ?? ''"
            :git-transport="gitTransport"
            :branch-diff="surfacePorts.branchDiff"
            :credentials="surfacePorts.credentials"
            @open-file="(p) => openFile({ ...p, wsPath: f.wsPath })"
            @ask-ai-fix="(text) => pasteToCli(text)"
          >
            <template #review="{ workspacePath: reviewWorkspacePath, gitStatus: reviewGitStatus, gitBranches: reviewGitBranches, close, openFile: reviewOpenFile, askAiFix }">
              <ReviewPane
                :workspace-path="reviewWorkspacePath"
                :backend="backend"
                :git-status="reviewGitStatus"
                :git-branches="reviewGitBranches"
                :hide-header="true"
                @close="close"
                @open-file="reviewOpenFile"
                @ask-ai-fix="askAiFix"
              />
            </template>
          </BranchDiffPane>
        </template>
        <div v-if="!openFiles.length" class="ide-empty">
          Open a file from the Explorer or Search pane on the left
        </div>
      </div>
      </div><!-- end ide-main primary -->

      <!-- Secondary editor group (Phase D split editor) -->
      <div v-if="secondaryGroup" class="ide-main ide-main--secondary" :class="{ 'group-active': !activeGroupIsPrimary }" @mousedown="activeGroupIsPrimary = false">
        <div class="ide-tabs">
          <div
            v-for="f in secondaryGroup.files"
            :key="f.id"
            class="ide-tab"
            :class="{ active: tabKey(f) === secondaryGroup.activeKey }"
            @click="secondaryGroup.activeKey = tabKey(f)"
          >
            <span class="ide-tab-name">{{ f.name }}</span>
            <button class="ide-tab-close" :title="$t('action.close')" @click.stop="closeFileInSecondary(tabKey(f))">✕</button>
          </div>
        </div>
        <div class="ide-editors">
          <template v-for="f in secondaryGroup.files" :key="'sec:' + f.id">
            <EditorPane
              v-if="f.kind === 'file'"
              v-show="tabKey(f) === secondaryGroup.activeKey"
              :ref="(el) => setEditorRefSecondary(tabKey(f), el)"
              :workspace-path="fileWs(f)"
              :port="editorPort"
              :rel-path="f.relPath"
              :name="f.name"
              embedded
              :active="tabKey(f) === secondaryGroup.activeKey && !activeGroupIsPrimary"
              @dirty="(v) => markDirty(tabKey(f), v)"
            />
          </template>
        </div>
      </div><!-- end ide-main secondary -->
    </div><!-- end ide-main-container -->

    <!-- Right AI CLI dock (rail toggle + resize + embedded PTY terminal) -->
    <AiCliDock
      ref="cliDockRef"
      v-model:open="aiPanelOpen"
      width-key="ide-ai-panel-width"
      :default-width="320"
      :pane-id="AI_PANE_ID"
      origin="mini-ide"
      :workspace-path="workspacePath"
      :terminal-port="terminalPort"
      :build-context="buildEditorContext"
    />
    </div><!-- end ide-body -->
  </div>
  <!-- Color Theme Picker -->
  <div v-if="themeOpen" class="ide-palette-overlay" @mousedown.self="closeThemePicker(true)">
    <div class="ide-palette">
      <input
        ref="themeInputEl"
        v-model="themeQuery"
        class="ide-palette-input"
        :placeholder="$t('editorWindow.select-theme')"
        @keydown="onThemeKeydown"
      />
      <ul class="ide-palette-list">
        <li
          v-for="(t, i) in themeItems"
          :key="t.id"
          class="ide-palette-item"
          :class="{ active: i === themeIdx }"
          @mouseover="previewTheme(i)"
          @click="confirmThemePicker"
        >
          <span class="ide-palette-label">{{ t.label }}</span>
          <span v-if="t.id === currentTheme" class="ide-palette-key">{{ $t('label.current') }}</span>
        </li>
      </ul>
    </div>
  </div>
  <!-- Keyboard Shortcuts Reference -->
  <div v-if="kbOpen" class="ide-palette-overlay" @mousedown.self="closeKeyboardShortcuts">
    <div class="ide-palette ide-palette--wide">
      <input
        ref="kbInputEl"
        v-model="kbQuery"
        class="ide-palette-input"
        :placeholder="$t('editorWindow.search-shortcuts')"
        @keydown="onKbKeydown"
      />
      <ul class="ide-palette-list">
        <li v-for="c in kbItems" :key="c.id" class="ide-palette-item ide-palette-item--static">
          <span class="ide-palette-label">{{ c.label }}</span>
          <span v-if="c.keys" class="ide-palette-key">{{ c.keys }}</span>
        </li>
      </ul>
    </div>
  </div>
  <!-- Language Mode Picker -->
  <div v-if="langOpen" class="ide-palette-overlay" @mousedown.self="closeLangPicker">
    <div class="ide-palette">
      <input
        ref="langInputEl"
        v-model="langQuery"
        class="ide-palette-input"
        :placeholder="$t('editorWindow.select-language')"
        @keydown="onLangKeydown"
      />
      <ul class="ide-palette-list">
        <li
          v-for="(l, i) in langItems"
          :key="l.ext + l.label"
          class="ide-palette-item"
          :class="{ active: i === langIdx }"
          @mouseover="langIdx = i"
          @click="confirmLangPicker"
        >
          <span class="ide-palette-label">{{ l.label }}</span>
          <span v-if="l.ext" class="ide-palette-key">{{ l.ext }}</span>
        </li>
      </ul>
    </div>
  </div>
  <!-- Go to Symbol in Workspace (⌘T) -->
  <div v-if="wsymOpen" class="ide-palette-overlay" @mousedown.self="closeWorkspaceSymbol">
    <div class="ide-palette">
      <input
        ref="wsymInputEl"
        v-model="wsymQuery"
        class="ide-palette-input"
        :placeholder="$t('editorWindow.workspace-symbol')"
        @keydown="onWsymKeydown"
      />
      <ul v-if="wsymItems.length" class="ide-palette-list">
        <li
          v-for="(s, i) in wsymItems"
          :key="(s.wsPath ?? '') + s.relPath + s.name + s.line"
          class="ide-palette-item"
          :class="{ active: i === wsymIdx }"
          @mouseover="wsymIdx = i"
          @click="confirmWorkspaceSymbol"
        >
          <span class="ide-palette-label">{{ s.name }}</span>
          <span class="ide-palette-key" style="opacity:.6; font-size:.85em">{{ s.kind }} · {{ s.wsPath ? tabDisplayPath({ wsPath: s.wsPath, relPath: s.relPath }) : s.relPath.split('/').pop() }}:{{ s.line }}</span>
        </li>
      </ul>
      <div v-else class="ide-palette-empty">{{ $t('label.no-symbols-found') }}</div>
    </div>
  </div>
  <!-- Go to Symbol -->
  <div v-if="symOpen" class="ide-palette-overlay" @mousedown.self="closeGotoSymbol">
    <div class="ide-palette">
      <input
        ref="symInputEl"
        v-model="symQuery"
        class="ide-palette-input"
        :placeholder="$t('editorWindow.symbol')"
        @keydown="onSymKeydown"
      />
      <ul v-if="symItems.length" class="ide-palette-list">
        <li
          v-for="(s, i) in symItems"
          :key="s.name + s.line"
          class="ide-palette-item"
          :class="{ active: i === symIdx }"
          @mouseover="symIdx = i"
          @click="confirmGotoSymbol"
        >
          <span class="ide-palette-label">{{ s.name }}</span>
          <span class="ide-palette-key" style="opacity:.6; font-size:.85em">{{ s.kind }} · Line {{ s.line }}</span>
        </li>
      </ul>
      <div v-else class="ide-palette-empty">{{ $t('label.no-symbols-detected') }}</div>
    </div>
  </div>
  <div v-if="qoOpen" class="ide-palette-overlay" @mousedown.self="closeQuickOpen">
    <div class="ide-palette">
      <input
        ref="qoInputEl"
        v-model="qoQuery"
        class="ide-palette-input"
        :placeholder="qoPlaceholder"
        @keydown="onQoKeydown"
      />
      <ul v-if="qoItems.length" class="ide-palette-list">
        <template v-for="(item, i) in qoItems" :key="qoItemKey(item, i)">
          <!-- section header for @: grouped mode -->
          <li v-if="item.qoKind === 'header'" class="ide-palette-section-header">
            {{ item.label }}
          </li>
          <li
            v-else
            class="ide-palette-item"
            :class="{ active: i === qoIdx }"
            @mouseover="qoIdx = i"
            @click="confirmQuickOpen"
          >
            <template v-if="item.qoKind === 'file'">
              <span class="ide-palette-label">{{ item.name }}</span>
              <span class="ide-palette-key" style="opacity:.6; font-size:.85em">{{ tabDisplayPath(item) }}</span>
            </template>
            <template v-else-if="item.qoKind === 'line'">
              <span class="ide-palette-label">Go to line {{ item.line }}</span>
            </template>
            <template v-else-if="item.qoKind === 'symbol'">
              <span class="ide-palette-label">{{ item.name }}</span>
              <span class="ide-palette-key" style="opacity:.6; font-size:.85em">{{ item.kind }} · Line {{ item.line }}</span>
            </template>
          </li>
        </template>
      </ul>
      <div v-else class="ide-palette-empty">
        <template v-if="qoQuery.startsWith(':')">{{ $t('label.enter-valid-line') }}</template>
        <template v-else-if="qoQuery.startsWith('@')">{{ $t('label.no-symbols-detected') }}</template>
        <template v-else>{{ $t('label.no-open-files') }}</template>
      </div>
    </div>
  </div>
  <div v-if="paletteOpen" class="ide-palette-overlay" @mousedown.self="closePalette">
    <div class="ide-palette">
      <input
        ref="paletteInputEl"
        v-model="paletteQuery"
        class="ide-palette-input"
        :placeholder="$t('label.command-name-placeholder')"
        @keydown="onPaletteKeydown"
      />
      <ul v-if="filteredCmds.length" class="ide-palette-list">
        <li
          v-for="(cmd, i) in filteredCmds"
          :key="cmd.id"
          class="ide-palette-item"
          :class="{ active: i === paletteIdx }"
          @mouseover="paletteIdx = i"
          @click="runPaletteCmd(cmd.id)"
        >
          <span class="ide-palette-label">{{ cmd.label }}</span>
          <span v-if="cmd.keys" class="ide-palette-key">{{ cmd.keys }}</span>
        </li>
      </ul>
      <div v-else class="ide-palette-empty">{{ $t('label.no-matching-commands') }}</div>
    </div>
  </div>

  <!-- New file dialog -->
  <div v-if="newFileOpen" class="ide-palette-overlay" @mousedown.self="closeNewFileDialog">
    <div class="ide-palette" style="max-width:440px">
      <div class="ide-new-file-label">{{ $t('label.new-file-hint') }}</div>
      <input
        ref="newFileInputEl"
        v-model="newFilePath"
        class="ide-palette-input"
        placeholder="e.g. src/components/MyComponent.vue"
        @keydown.enter.prevent="confirmNewFile"
        @keydown.escape.prevent="closeNewFileDialog"
      />
      <div class="ide-new-file-hint">{{ $t('label.file-create-hint') }}</div>
    </div>
  </div>

  <!-- Quick Fix overlay (⌘.) -->
  <div v-if="quickFixOpen" class="ide-palette-overlay" @mousedown.self="closeQuickFix">
    <div class="ide-palette" style="max-width: 480px">
      <div class="ide-new-file-label">{{ $t('label.quick-fix') }}</div>
      <ul class="ide-palette-list">
        <li
          v-for="(item, i) in quickFixItems"
          :key="i"
          class="ide-palette-item"
          :class="{ active: i === quickFixIdx }"
          @mouseover="quickFixIdx = i"
          @click="runQuickFix(i)"
        >
          <span class="ide-palette-label">{{ item.label }}</span>
        </li>
      </ul>
    </div>
  </div>

  <NotificationHost />

  <!-- Tab right-click context menu -->
  <teleport to="body">
    <div v-if="tabCtxMenu" class="ide-tab-ctx" :style="{ left: tabCtxMenu.x + 'px', top: tabCtxMenu.y + 'px' }" @click.stop @mousedown.stop>
      <div class="ide-tab-ctx-item" @click="closeFile(tabCtxMenu!.key).then(closeTabCtxMenu)">{{ $t('action.close') }}</div>
      <div class="ide-tab-ctx-item" @click="ctxCloseOthers(tabCtxMenu!.key)">{{ $t('action.close-others') }}</div>
      <div class="ide-tab-ctx-item" @click="ctxCloseRight(tabCtxMenu!.key)">{{ $t('action.close-to-right') }}</div>
      <div class="ide-tab-ctx-item" @click="ctxCloseLeft(tabCtxMenu!.key)">{{ $t('action.close-to-left') }}</div>
      <div class="ide-tab-ctx-item" @click="ctxCloseAll">{{ $t('action.close-all') }}</div>
      <div class="ide-tab-ctx-sep" />
      <div class="ide-tab-ctx-item" :class="{ disabled: !tabCtxIsFile }" @click="ctxCopyPath(tabCtxMenu!.key)">{{ $t('action.copy-path') }}</div>
      <div class="ide-tab-ctx-item" :class="{ disabled: !tabCtxIsFile }" @click="ctxCopyRelPath(tabCtxMenu!.key)">{{ $t('action.copy-relative-path') }}</div>
      <div v-if="tabCtxIsFile" class="ide-tab-ctx-item" @click="ctxRevealInFinder(tabCtxMenu!.key)">{{ $t('action.reveal-in-finder') }}</div>
    </div>
    <div v-if="tabCtxMenu" class="ide-tab-ctx-backdrop" @mousedown="closeTabCtxMenu" />
  </teleport>

  <!-- Breadcrumb dropdown -->
  <teleport to="body">
    <div
      v-if="bcDropdown"
      class="ide-bc-dd"
      :style="{ left: bcDropdown.x + 'px', top: bcDropdown.y + 'px' }"
      @click.stop
    >
      <div v-if="!bcDropdown.items.length" class="ide-bc-dd-empty">{{ $t('label.no-results') }}</div>
      <div
        v-for="(item, i) in bcDropdown.items"
        :key="(item.relPath || '') + (item.line ?? 0)"
        class="ide-bc-dd-item"
        :class="{ 'is-dir': item.isDir, 'is-sym': !!item.line, 'is-active': i === bcActiveIdx }"
        @mouseover="bcActiveIdx = i"
        @click="onBcItemClick(item)"
      >
        <span class="ide-bc-dd-icon">
          <svg v-if="item.isDir" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
          <svg v-else-if="!item.line" width="12" height="14" viewBox="0 0 12 16" fill="currentColor"><path d="M6 5H2V4h4v1zM2 8h7V7H2v1zm0 2h7V9H2v1zm0 2h7v-1H2v1zm10-7.5V14c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V2c0-.55.45-1 1-1h7.5L12 4.5zM11 5L8 2H1v12h10V5z"/></svg>
          <span v-else class="ide-bc-dd-sym-badge" :data-kind="item.kind">{{ item.kind === 'function' ? 'ƒ' : item.kind === 'class' ? 'C' : item.kind === 'interface' ? 'I' : item.kind === 'type' ? 'T' : '·' }}</span>
        </span>
        <span class="ide-bc-dd-name" v-truncate>{{ item.name }}</span>
        <span v-if="item.line" class="ide-bc-dd-line">L{{ item.line }}</span>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.ide {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-base);
  color: var(--text-primary);
  overflow: hidden;
}
.ide-titlebar {
  flex-shrink: 0;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: drag;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  user-select: none;
  padding-left: 80px;
  padding-right: 8px;
  gap: 4px;
}
.ide-titlebar-name {
  flex: 1;
  text-align: center;
  font-size: var(--font-xs);
  font-weight: 500;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ide-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}
.ide-activity {
  flex-shrink: 0;
  width: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding-top: 8px;
  background: var(--bg-subtle);
  border-right: 1px solid var(--border-muted);
}
.ide-act-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-left: 2px solid transparent;
  border-radius: 0;
}
.ide-act-btn:hover { color: var(--text-bright); }
.ide-act-btn.active { color: var(--text-bright); border-left-color: var(--accent-focus); }
.ide-act-btn { position: relative; }
.ide-act-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 8px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: 9px;
  line-height: 15px;
  text-align: center;
}
.ide-act-badge--err { background: var(--danger-fg); color: var(--text-on-emphasis); }

.ide-sidebar {
  flex-shrink: 0;
  min-width: 120px;
  max-width: 500px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ide-resize-handle {
  flex-shrink: 0;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  border-right: 1px solid var(--border-muted);
  transition: background 0.15s;
}
.ide-resize-handle:hover { background: var(--accent-emphasis); }
.ide-sidebar > * { flex: 1; min-height: 0; }

.ide-main-container {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}
.ide-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.ide-split .ide-main { border-right: 1px solid var(--border-muted); }
.ide-main--secondary { flex: 1; }
.ide-tab-bar {
  display: flex;
  align-items: stretch;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.group-active .ide-tab-bar { border-bottom: 2px solid var(--accent-focus); }
.ide-tabs {
  display: flex;
  align-items: stretch;
  gap: 0;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.ide-tabs::-webkit-scrollbar { display: none; }
.ide-tab-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  flex-shrink: 0;
  border-left: 1px solid var(--border-muted);
}
.ide-tab-act {
  font-size: 11.5px;
  padding: 3px 9px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}
.ide-tab-act:hover:not(:disabled) { background: var(--bg-muted); color: var(--text-bright); }
.ide-tab-act:disabled { opacity: 0.4; cursor: default; }
.ide-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
  background: transparent;
  border-right: 1px solid var(--border-muted);
  cursor: pointer;
  white-space: nowrap;
  border-top: 2px solid transparent;
}
.ide-tab:hover { background: var(--bg-muted); }
.ide-tab.active {
  background: var(--bg-base);
  color: var(--text-bright);
  border-top-color: var(--accent-emphasis);
}
.ide-tab-dirty { color: var(--attention-fg); font-size: var(--font-3xs); }
.ide-tab-diff-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 3px;
  flex-shrink: 0;
}
.ide-tab-diff-badge.staged { background: color-mix(in srgb, var(--success-fg) 18%, transparent); color: var(--success-bright); }
.ide-tab-diff-badge.unstaged { background: color-mix(in srgb, var(--attention-fg) 18%, transparent); color: var(--attention-bright); }
.ide-tab-diff-badge.conflict-badge { background: color-mix(in srgb, var(--danger-fg) 18%, transparent); color: var(--danger-fg); }
.ide-tab-diff-badge.commit { background: var(--accent-subtle); color: var(--accent-fg); }
.ide-tab-diff-badge.branch-diff-badge { background: var(--accent-subtle); color: var(--accent-fg); }
.ide-tab-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--font-2xs);
  line-height: 1;
  padding: 2px;
  border-radius: 3px;
}
.ide-tab-close:hover { background: var(--bg-muted); color: var(--text-bright); }

.ide-breadcrumb {
  display: flex;
  align-items: center;
  padding: 2px 12px;
  height: 22px;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-muted);
  font-size: 11.5px;
  flex-shrink: 0;
  gap: 4px;
  overflow: hidden;
}
.ide-bc-sep { color: var(--text-muted); opacity: 0.6; font-size: var(--font-3xs); }
.ide-bc-seg {
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: pointer;
  border-radius: 3px;
  padding: 1px 4px;
  margin: 0 -4px;
}
.ide-bc-seg:hover { color: var(--text-primary); background: var(--bg-muted); }
.ide-bc-seg--open { color: var(--text-primary) !important; background: var(--bg-muted) !important; }
.ide-bc-file { color: var(--text-primary); font-weight: 500; }

/* ── Breadcrumb Dropdown ─────────────────────────────────────────────────── */
.ide-tab-ctx-backdrop {
  position: fixed; inset: 0; z-index: 299;
}
.ide-tab-ctx {
  position: fixed;
  z-index: 300;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  padding: 4px 0;
  min-width: 180px;
  user-select: none;
}
.ide-tab-ctx-item {
  padding: 5px 14px;
  font-size: var(--font-xs);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.ide-tab-ctx-item:hover { background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ide-tab-ctx-item.disabled { opacity: 0.4; pointer-events: none; }
.ide-tab-ctx-sep {
  height: 1px;
  background: var(--border-default);
  margin: 4px 0;
}
.ide-bc-dd {
  position: fixed;
  z-index: 300;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  min-width: 180px;
  max-width: 300px;
  max-height: 320px;
  overflow-y: auto;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  padding: 4px 0;
  font-size: var(--font-xs);
}
.ide-bc-dd-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
}
.ide-bc-dd-item:hover, .ide-bc-dd-item.is-active { background: var(--bg-muted); }
.ide-bc-dd-item.is-dir { color: var(--accent-fg); }
.ide-bc-dd-icon { flex-shrink: 0; display: flex; align-items: center; width: 16px; }
.ide-bc-dd-sym-badge {
  width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  font-size: 9px;
  font-weight: 700;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.ide-bc-dd-sym-badge[data-kind="class"] { background: #6c9ef8; }
.ide-bc-dd-sym-badge[data-kind="interface"] { background: #56b6c2; }
.ide-bc-dd-sym-badge[data-kind="type"] { background: #c678dd; }
.ide-bc-dd-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.ide-bc-dd-line { font-size: var(--font-3xs); color: var(--text-muted); flex-shrink: 0; }
.ide-bc-dd-empty { padding: 8px 10px; color: var(--text-muted); font-size: 11.5px; }

.ide-editors { flex: 1; position: relative; min-height: 0; }
.ide-editors > * { height: 100%; }
/* Preview wrapper: optional plan review toolbar stacked above the preview. */
.ide-preview-stack { display: flex; flex-direction: column; }
.ide-preview-stack > :last-child { flex: 1 1 0; min-height: 0; }
.ide-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: var(--font-sm);
}

/* ── Command Palette ─────────────────────────────────────────────────────── */
.ide-palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: center;
  padding-top: 72px;
}
.ide-palette {
  width: 520px;
  max-height: 420px;
}
.ide-palette--wide {
  width: 640px;
  max-height: 560px;
  display: flex;
  flex-direction: column;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  align-self: flex-start;
}
.ide-palette-input {
  padding: 11px 14px;
  font-size: var(--font-sm);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-muted);
  color: var(--text-primary);
  outline: none;
}
.ide-palette-input:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.ide-palette-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
}
.ide-palette-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 14px;
  cursor: pointer;
  font-size: 12.5px;
}
.ide-palette-item.active { background: var(--bg-muted); }
.ide-palette-label { color: var(--text-primary); }
.ide-palette-key {
  font-size: var(--font-2xs);
  color: var(--text-muted);
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: ui-monospace, Menlo, monospace;
  flex-shrink: 0;
}
.ide-palette-empty { padding: 12px 14px; color: var(--text-muted); font-size: var(--font-xs); }
.ide-new-file-label { padding: 10px 14px 4px; font-size: var(--font-2xs); color: var(--text-muted); user-select: none; }
.ide-new-file-hint { padding: 6px 14px 8px; font-size: 10.5px; color: var(--text-muted); opacity: .7; }
.ide-palette-section-header {
  padding: 4px 14px 2px;
  font-size: var(--font-3xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .06em;
  color: var(--text-muted);
  opacity: .7;
  user-select: none;
}

</style>

<style>
html, body, #app {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: var(--bg-base);
}
</style>
