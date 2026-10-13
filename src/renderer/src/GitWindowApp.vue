<script setup lang="ts">
// GitWindowApp — the standalone Git client surface, "Editorial Calm" design.
//
// Runs inside the isolated `navide.git` plugin WebContentsView (see
// src/renderer/plugins/git/). The plugin mount injects the feature-owned
// transports and ports; this surface never reaches into the Host backend.
//
// Layout: a calm, borderless reading surface. Toolbar (wordmark → repo crumb →
// ghost sync actions + one primary). Sidebar: view nav on top, then GitPane's
// section cards replicated 1:1 (Branches panel with compare/rebase/merge/
// switch, Stashes, Remotes, Tags, Worktrees, inline-edit Config, and the
// gh/glab Issues card) — same collapse style and controls as the main
// window's Git tab. Center: the signature interaction — one file
// card where the checkbox IS the stage state (check to stage, uncheck to
// unstage) — plus a floating commit composer card. Bottom: shared DiffPane
// detail. History (GitHistoryModal) and branch comparison (BranchDiffPane)
// keep their own views. Editor, worktree, and remote hand-offs use the injected
// UI port, so this surface stays independent of the concrete host transport.
// All colors map to semantic tokens so the five app themes translate the design.

import { ref, computed, nextTick, onMounted, onUnmounted, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { isMacPlatform, useKeybindings, registerCommand, setContext } from '@navide/plugin-ui/shared'
// macOS paints its traffic lights over this bar; every other platform gives
// the window a system frame instead, leaving the reserved space empty.
const reserveTrafficLights = isMacPlatform()

import {
  useGit,
  type BlameEntry,
  type DiffBlameHunk,
  type GitCommit,
  type GitFileEntry
} from './composables/useGit'
import { useIssues } from './composables/useIssues'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import { useTheme } from '@navide/plugin-ui/foundation'
import { settingsGet, onSettingsChanged } from '@navide/plugin-ui/shared'
import {
  GIT_BRANCH_DIFF_KEY,
  GIT_ACCOUNTS_KEY,
  GIT_CREDENTIALS_KEY,
  GIT_FILE_ACCESS_KEY,
  GIT_ISSUES_KEY,
  GIT_TRANSPORT_KEY,
  GIT_UI_KEY,
} from './ports/gitSurface'
import { TERMINAL_DOCK_KEY } from '@navide/terminal'
import GitHistoryModal from './components/GitHistoryModal.vue'
import GitCredentialModal from './components/GitCredentialModal.vue'
import NotificationHost from './components/NotificationHost.vue'
import DiffPane from './editor/DiffPane.vue'
import BranchDiffPane from './editor/BranchDiffPane.vue'
// Hand-rolled three-way merge view (plain Vue, no Monaco — keeps it out of the
// git plugin bundle); the same component the mini-IDE opens conflicts in.
import ConflictPane from './editor/ConflictPane.vue'
// Shared right-side CLI agent dock (rail toggle + resize + embedded PTY).
import { AiCliDock } from '@navide/plugin-shell'
import { aiTerminalPaneId, bracketedPaste } from '@navide/plugin-shell'
import { closeGitWindowMenuOnEscape } from './lib/gitMenuEscape'

// The host sets ?workspace_path= when it loads this entry (frontendPluginManager
// gitQuery). A getter is what useGit expects.
const workspacePath = new URLSearchParams(window.location.search).get('workspace_path') ?? ''
// The alias the user gave this workspace, resolved by the Host and passed as
// `workspace_display_name`; blank or absent means "no alias" and the folder
// name stands in. KNOWN LIMITATION: a load-time snapshot. Renaming the
// workspace while this window is open does NOT retitle it; the name is correct
// again the next time the window opens.
const workspaceAliasParam =
  new URLSearchParams(window.location.search).get('workspace_display_name')?.trim() ?? ''

const { t } = useI18n()
const gitTransport = inject(GIT_TRANSPORT_KEY)!
const fileAccess = inject(GIT_FILE_ACCESS_KEY)!
const uiPort = inject(GIT_UI_KEY)!
const branchDiff = inject(GIT_BRANCH_DIFF_KEY)!
const credentialPort = inject(GIT_CREDENTIALS_KEY)!
const accountPort = inject(GIT_ACCOUNTS_KEY)!
const issuePort = inject(GIT_ISSUES_KEY)!
const terminalPort = inject(TERMINAL_DOCK_KEY)!
if (!gitTransport || !fileAccess || !uiPort || !branchDiff || !credentialPort || !accountPort || !issuePort || !terminalPort) {
  throw new Error('Git plugin ports were not provided by the composition root')
}
const { loadTheme } = useTheme()
const notify = useNotify()
const git = useGit(() => workspacePath, gitTransport, credentialPort)

const {
  gitStatus,
  gitLog,
  gitBranches,
  gitStashes,
  gitRemotes,
  gitTags,
  logScope,
  logOrder,
  isLoadingStatus,
  isLoadingLog,
  canLoadMoreLog,
  isFetching,
  isSyncing,
  gitError,
  loadStatus,
  loadLog,
  loadBranches,
  loadStashes,
  loadRemotes,
  loadTags,
  setLogScope,
  setLogOrder,
  loadMoreLog,
  logSearch,
  showCommit,
  commitFileDiff,
  // per-file detail modes (blame / changed-line blame / file history)
  blameFile,
  diffBlame,
  fileLog,
  fetchRemote,
  pullOnly,
  pushOnly,
  sync,
  // toolbar "⋯" operations
  pullRebase,
  pushUpstream,
  pushForce,
  undoLastCommit,
  cleanUntracked,
  cherryPick,
  revertCommit,
  checkoutCommit,
  createBranch,
  createTag,
  mergeBranch,
  resetToCommit,
  // working tree + commit (the checkbox-stage surface)
  stageFile,
  unstageFile,
  stageAll,
  unstageFiles,
  discardFile,
  resolveConflictOurs,
  resolveConflictTheirs,
  abortOperation,
  commit,
  amendCommit,
  generateMessage,
  isCommitting,
  isGenerating,
  // branches / stash / remotes / tags
  rebaseOn,
  switchBranch,
  deleteBranch,
  mergeInto,
  restoreFileFromBranch,
  checkoutRemoteBranch,
  stashPush,
  stashPop,
  stashApply,
  stashDrop,
  addRemote,
  removeRemote,
  deleteTag,
  // worktrees / config
  gitWorktrees,
  loadWorktrees,
  addWorktree,
  removeWorktree,
  pruneWorktrees,
  lockWorktree,
  unlockWorktree,
  moveWorktree,
  repairWorktrees,
  gitConfig,
  gitConfigAllowedKeys,
  loadGitConfig,
  setGitConfig,
  // branch comparison (inline compare panel, GitPane parity)
  compareBranches,
  // repository bootstrap (the non-repo empty state) + ignore
  initRepo,
  isInitializing,
  cloneRepo,
  addToGitignore,
  // askpass credential prompt
  credentialPrompt,
  showCredentialPrompt,
  submitCredential,
  cancelCredential
} = git

// Cloud issues (GitHub via gh / GitLab via glab) — same wiring as GitPane.
const {
  provider: issueProvider, issues, selectedIssue,
  isLoadingIssues, isLoadingDetail, isSubmitting: isIssueSubmitting,
  issuesError,
  ensureLoaded: ensureIssuesLoaded, refresh: refreshIssues,
  openIssue, closeDetail: closeIssueDetail,
  createIssue, addComment, setState: setIssueState
} = useIssues(() => workspacePath, issuePort)

// ── View state ───────────────────────────────────────────────────────────────
type CenterView = 'history' | 'status' | 'branchdiff'
const view = ref<CenterView>('status')

// ── Diff detail target ───────────────────────────────────────────────────────
// Shown in the bottom detail panel of the Changes view. Fed by (a) file-row
// clicks in the center card, and (b) the main process forwarding a git_diff_*
// target (see window:openGit) when a file is clicked in the main window's
// GitPane. The shared DiffPane fetches the diff itself from these coordinates.
interface ExternalDiff {
  name: string
  staged: boolean
  commit: string
}
const externalDiff = ref<ExternalDiff | null>(null)

// Local busy flags for actions useGit doesn't expose a dedicated ref for.
const isPulling = ref(false)
const isPushing = ref(false)

const localBranches = computed(() => gitBranches.value.filter((b) => !b.is_remote))
const remoteBranches = computed(() => gitBranches.value.filter((b) => b.is_remote))

const hasWorkspace = computed(() => workspacePath.length > 0)
const isRepo = computed(() => gitStatus.value.is_git_repo)
const repoName = computed(
  () => workspaceAliasParam || (workspacePath.split('/').filter(Boolean).at(-1) ?? '')
)

const changeCount = computed(() => {
  const s = gitStatus.value
  return s.staged.length + s.unstaged.length + s.untracked.length
})

// ── Loading ──────────────────────────────────────────────────────────────────
async function refreshAll(): Promise<void> {
  await loadStatus()
  if (!isRepo.value) return
  await Promise.all([
    loadLog(),
    loadBranches(),
    loadRemotes(),
    loadTags(),
    loadStashes(),
    loadWorktrees()
  ])
}

let offThemeSettingsChange: (() => void) | null = null

onMounted(() => {
  if (repoName.value) document.title = `${repoName.value} — Git`
  document.addEventListener('keydown', closeMenuOnEscape)
  loadTheme()
  offThemeSettingsChange = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
    if (keys.includes('agentTeam.analyzerModel')) {
      analyzerModel.value = settingsGet('agentTeam.analyzerModel', '')
    }
  })
  if (hasWorkspace.value) void refreshAll()
  // Initial diff target from the entry query, then incremental deliveries.
  showDiffTarget(Object.fromEntries(new URLSearchParams(window.location.search)))
  const nav = (
    window as unknown as {
      nav?: { onOpenTarget?: (cb: (p: Record<string, string>) => void) => () => void }
    }
  ).nav
  nav?.onOpenTarget?.((p) => {
    showDiffTarget(p)
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', closeMenuOnEscape)
  offThemeSettingsChange?.()
})

function showDiffTarget(params: Record<string, string>): void {
  const filepath = params['git_diff_filepath'] ?? ''
  if (!filepath) return
  view.value = 'status'
  externalDiff.value = {
    name: filepath,
    staged: params['git_diff_staged'] === 'true',
    commit: params['git_diff_commit'] ?? '',
  }
  resetDetailAux()
}

function clearExternalDiff(): void {
  externalDiff.value = null
  resetDetailAux()
}

function toastResult(r: { ok: boolean; error?: string }, okMsg?: string): boolean {
  if (!r.ok) notify.toast(r.error || t('label.operation-failed'), { type: 'error' })
  else if (okMsg) notify.toast(okMsg, { type: 'success' })
  return r.ok
}

// ── Popover menus (the "⋯" row menus) ────────────────────────────────────────
interface MenuItem {
  label: string
  danger?: boolean
  /** Draw a hairline above this item (groups the destructive tail). */
  separator?: boolean
  /** Inert row — used for the "…more" overflow hint. */
  disabled?: boolean
  action: () => void
}
const menu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

/** Place a menu at viewport coordinates. Two-level flows (pick an action, then
 *  pick a branch) reopen at the same spot by passing the coordinates again. */
function openMenuAt(x: number, y: number, items: MenuItem[]): void {
  menu.value = {
    x: Math.min(x, window.innerWidth - 208),
    y: Math.min(y, window.innerHeight - items.length * 30 - 16),
    items
  }
}

function openMenu(e: MouseEvent, items: MenuItem[]): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  openMenuAt(r.left, r.bottom + 4, items)
}
function runMenuItem(item: MenuItem): void {
  menu.value = null
  item.action()
}

function closeMenuOnEscape(event: KeyboardEvent): void {
  closeGitWindowMenuOnEscape(event, Boolean(menu.value), () => { menu.value = null })
}

// ── UI hand-offs (mini-IDE / shell actions) ──────────────────────────────────
const analyzerModel = ref(settingsGet('agentTeam.analyzerModel', ''))

/** Route a file through the injected UI port; the composition decides where it
 *  opens when the mini-IDE is not installed or available. */
async function openInEditor(filepath: string): Promise<void> {
  if (!filepath) return
  try {
    await uiPort.openInEditor({ workspacePath, filepath })
  } catch (err) {
    notify.toast(err instanceof Error ? err.message : t('label.could-not-open-editor'), { type: 'error' })
  }
}
async function openExternal(url: string): Promise<void> {
  if (!url) return
  try {
    await uiPort.openExternal(url)
  } catch (err) {
    notify.toast(err instanceof Error ? err.message : t('label.could-not-open-url'), { type: 'error' })
  }
}
async function revealPath(path: string): Promise<void> {
  try {
    await uiPort.revealPath(path)
  } catch (err) {
    notify.toast(err instanceof Error ? err.message : t('label.could-not-reveal-path'), { type: 'error' })
  }
}
async function pickFolder(defaultPath?: string): Promise<string | null> {
  try { return await uiPort.pickFolder(defaultPath) } catch { return null }
}
async function onOpenWorktree(path: string): Promise<void> {
  try {
    await uiPort.openWorkspace(path)
  } catch (err) {
    notify.toast(err instanceof Error ? err.message : t('label.could-not-open-workspace'), { type: 'error' })
  }
}

// ── AI CLI dock (embedded PTY agent panel) ───────────────────────────────────
// Pane id for the CLI dock, derived per (surface, workspace): Git windows for
// different workspaces coexist, and a shared fixed id would let one window's
// reattach steal — and its Start reap — another's running CLI (see
// aiTerminalPaneId). workspacePath is fixed at window creation, so this is
// stable for the window's life.
const AI_PANE_ID = aiTerminalPaneId('git', workspacePath)

// Context payload the CLI dock injects after a fresh spawn: workspace, current
// branch, and the staged/unstaged/untracked file lists this window is showing.
// Lists are capped so the CLI is not buried under a huge startup paste.
const GIT_CONTEXT_MAX_FILES = 50
function gitContextFileLines(label: string, files: GitFileEntry[]): string[] {
  if (!files.length) return []
  const shown = files.slice(0, GIT_CONTEXT_MAX_FILES).map((f) => `  ${f.status} ${f.path}`)
  const more = files.length - GIT_CONTEXT_MAX_FILES
  return [`${label} (${files.length}):`, ...shown, ...(more > 0 ? [`  …and ${more} more`] : [])]
}
function buildGitContext(): string {
  const s = gitStatus.value
  const lines = [
    "You are running in a terminal embedded in Navide's Git window, assisting " +
      'the user who is reviewing and committing changes in this repository.',
    `Workspace: ${workspacePath}`,
  ]
  if (s.branch) lines.push(`Current branch: ${s.branch}`)
  lines.push('')
  const files = [
    ...gitContextFileLines('Staged files', s.staged),
    ...gitContextFileLines('Unstaged files', s.unstaged),
    ...gitContextFileLines('Untracked files', s.untracked),
  ]
  lines.push(...(files.length ? files : ['Working tree clean.']))
  return lines.join('\n')
}

// ── Resolve with agent (hand a conflicted file to the CLI dock) ──────────────
// The dock's `buildContext` pipeline runs on a FRESH spawn only, and its
// injectNow() re-injects that same buildContext — neither can carry a
// per-file prompt. So the prompt goes in through the dock's exposed
// pasteText() wrapped in the very envelope the dock uses internally: one
// bracketed paste, then a submitting CR after the CLI has ingested it.
const aiDockRef = ref<InstanceType<typeof AiCliDock> | null>(null)
const aiDockOpen = ref(false)

/** Caps on quoting the whole conflicted file: past either one the CLI would be
 *  buried in a paste it has to scroll past before reading anything useful, so
 *  only the conflict regions are quoted and the agent is told to open the file
 *  itself. */
const CONFLICT_PROMPT_MAX_LINES = 400
const CONFLICT_PROMPT_MAX_CHARS = 16000
/** Lines quoted around each conflict block in that excerpt mode. */
const CONFLICT_EXCERPT_CONTEXT = 6

/** 1-based inclusive line ranges of the `<<<<<<<` … `>>>>>>>` blocks.
 *  Deliberately a line scan, not a parser: excerpting needs line numbers only,
 *  and the sides themselves are quoted verbatim for the agent to read. */
function conflictBlockRanges(lines: string[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  let open = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('<<<<<<<')) open = i
    else if (line.startsWith('>>>>>>>') && open >= 0) {
      ranges.push({ start: open + 1, end: i + 1 })
      open = -1
    }
  }
  return ranges
}

/** Pad each block with context lines and merge the ones that then touch, so
 *  neighbouring conflicts are quoted once instead of twice. */
function excerptRanges(
  blocks: { start: number; end: number }[],
  totalLines: number
): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = []
  for (const b of blocks) {
    const start = Math.max(1, b.start - CONFLICT_EXCERPT_CONTEXT)
    const end = Math.min(totalLines, b.end + CONFLICT_EXCERPT_CONTEXT)
    const last = merged[merged.length - 1]
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else merged.push({ start, end })
  }
  return merged
}

/** The instruction handed to the CLI agent. English on purpose: it is a prompt
 *  for the CLI, not UI copy (same rule as buildGitContext). */
function buildConflictPrompt(relPath: string, content: string): string {
  const lines = content.split('\n')
  const blocks = conflictBlockRanges(lines)
  const op = opInProgress.value
  const out = [
    'Resolve a git merge conflict for me.',
    '',
    `Repository: ${workspacePath}`,
    `File: ${relPath} (absolute path: ${absPath(relPath)})`,
    ...(op ? [`Operation in progress: ${op}`] : []),
    `Conflict blocks in this file: ${blocks.length}`,
    '',
    'What to do:',
    '1. Read both sides of every conflict block: "ours" is between <<<<<<< and' +
      ' =======, "theirs" is between ======= and >>>>>>>.',
    '2. Work out what each side is trying to do, then edit the file in place so' +
      ' the result keeps both intents wherever they are compatible.',
    '3. Remove every conflict marker line (<<<<<<<, |||||||, =======, >>>>>>>).',
    '4. Do not stage and do not commit — I review the result and commit from' +
      " Navide's Git window.",
    '5. If a block is genuinely ambiguous, stop and explain the options instead' +
      ' of guessing.',
    ''
  ]
  if (lines.length <= CONFLICT_PROMPT_MAX_LINES && content.length <= CONFLICT_PROMPT_MAX_CHARS) {
    out.push(`Full content of ${relPath}:`, '', content)
    return out.join('\n')
  }
  out.push(
    `The file is large (${lines.length} lines, ${content.length} characters), so` +
      ` only the conflict regions are quoted below, with ${CONFLICT_EXCERPT_CONTEXT}` +
      ' lines of context around each one. This is an excerpt — read the complete' +
      ` file at ${absPath(relPath)} before editing it.`,
    ''
  )
  if (!blocks.length) {
    out.push('(No conflict markers found — check whether the file is already resolved.)')
    return out.join('\n')
  }
  for (const r of excerptRanges(blocks, lines.length)) {
    out.push(`--- ${relPath} lines ${r.start}-${r.end} ---`, ...lines.slice(r.start - 1, r.end), '')
  }
  return out.join('\n')
}

// A fresh spawn injects the dock's own git context first, after 2000 ms of CLI
// silence (AiCliDock injectQuietMs). Requiring a strictly longer quiet window
// here keeps this prompt behind that injection instead of interleaving with
// it: the context paste is itself PTY activity, so it restarts this wait.
const AGENT_PROMPT_QUIET_MS = 3500
const AGENT_PROMPT_TIMEOUT_MS = 25000

type DockTerminal = { status: string; lastRawActivityAt: number } | null

async function waitForCliQuiet(term: () => DockTerminal): Promise<void> {
  const deadline = Date.now() + AGENT_PROMPT_TIMEOUT_MS
  for (;;) {
    const t = term()
    if (!t || t.status !== 'running') return
    const last = t.lastRawActivityAt
    if ((last > 0 && Date.now() - last >= AGENT_PROMPT_QUIET_MS) || Date.now() >= deadline) return
    await new Promise((r) => setTimeout(r, 250))
  }
}

async function sendPromptToAgent(prompt: string): Promise<{ ok: boolean; error?: string }> {
  const dock = aiDockRef.value
  if (!dock) return { ok: false, error: t('label.resolve-agent-unavailable') }
  const term = (): DockTerminal => (dock.terminal as unknown as DockTerminal) ?? null
  if (term()?.status !== 'running') {
    await dock.start()
    if (term()?.status !== 'running') return { ok: false, error: t('label.resolve-agent-start-failed') }
    await waitForCliQuiet(term)
    if (term()?.status !== 'running') return { ok: false, error: t('label.resolve-agent-start-failed') }
  }
  // Report a refused paste rather than following it with a bare CR: the two
  // sends are 300 ms apart and the transport can drop in between.
  if (!dock.pasteText(bracketedPaste(prompt))) {
    return { ok: false, error: t('label.resolve-agent-start-failed') }
  }
  // Let the CLI ingest the paste before the submitting CR (the dock's own
  // context injection uses the same 300 ms gap).
  await new Promise((r) => setTimeout(r, 300))
  dock.pasteText('\r')
  return { ok: true }
}

/** Read the conflicted file, build the prompt, and hand it to the CLI dock —
 *  opening the panel so the user sees the agent working. The agent's edits
 *  arrive back through the existing git.changed refresh; nothing to wire here. */
async function onResolveWithAgent(path: string): Promise<void> {
  const resp = await fileAccess.readFile(workspacePath, path)
  if (!resp.ok || typeof resp.content !== 'string') {
    const detail = resp.error
    notify.toast(detail || t('label.resolve-agent-read-failed', { path }), { type: 'error' })
    return
  }
  aiDockOpen.value = true
  const sent = await sendPromptToAgent(buildConflictPrompt(path, resp.content))
  if (!sent.ok) {
    notify.toast(sent.error || t('label.operation-failed'), { type: 'error' })
    return
  }
  notify.toast(t('label.resolve-agent-sent', { path }), { type: 'success' })
}

// ── The file card: checkbox IS the stage state ───────────────────────────────
function isConflictEntry(f: GitFileEntry): boolean {
  return f.status === 'U'
}
const conflictFiles = computed(() =>
  [...gitStatus.value.staged, ...gitStatus.value.unstaged].filter(isConflictEntry)
)
const stagedFiles = computed(() => gitStatus.value.staged.filter((f) => !isConflictEntry(f)))
const changedFiles = computed(() => gitStatus.value.unstaged.filter((f) => !isConflictEntry(f)))
const untrackedFiles = computed(() => gitStatus.value.untracked)

const opInProgress = computed(() => gitStatus.value.operation_in_progress)

function fileTag(f: GitFileEntry, untracked = false): { label: string; cls: string } {
  if (untracked) return { label: t('label.tag-new'), cls: 'q' }
  const c = f.status[0]
  if (c === 'A') return { label: t('label.tag-added'), cls: 'a' }
  if (c === 'D') return { label: t('label.tag-deleted'), cls: 'd' }
  if (c === 'R') return { label: t('label.tag-renamed'), cls: 'm' }
  if (c === 'U') return { label: t('label.tag-conflict'), cls: 'u' }
  return { label: t('label.tag-modified'), cls: 'm' }
}
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) }
}
function absPath(p: string): string {
  return `${workspacePath.replace(/\/+$/, '')}/${p}`
}
/** File rows carry their absolute path as `text/plain`, the payload convention
 *  ExplorerPane and GitPane already use. A terminal in the main window turns
 *  that into a shell-escaped path at the prompt (see lib/drop.ts); Chromium
 *  delivers same-app drops across window boundaries on its own. */
function onFileDragStart(e: DragEvent, path: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('text/plain', absPath(path))
  e.dataTransfer.effectAllowed = 'copy'
}

async function toggleStage(f: GitFileEntry, staged: boolean): Promise<void> {
  if (staged) await unstageFile(f.path)
  else await stageFile(f.path)
}
async function onStageAll(): Promise<void> {
  await stageAll()
}
async function onUnstageAll(): Promise<void> {
  const paths = stagedFiles.value.map((f) => f.path)
  if (!paths.length) return
  toastResult(await unstageFiles(paths))
}
async function onDiscard(f: GitFileEntry): Promise<void> {
  const ok = await notify.confirm(t('label.discard-file-confirm', { path: f.path }), {
    title: t('label.discard-changes-title'),
    confirmText: t('action.discard')
  })
  if (!ok) return
  await discardFile(f.path)
}
async function onResolveOurs(path: string): Promise<void> {
  toastResult(await resolveConflictOurs(path))
}
async function onResolveTheirs(path: string): Promise<void> {
  toastResult(await resolveConflictTheirs(path))
}
async function onAbortOperation(): Promise<void> {
  const op = opInProgress.value
  if (!op) return
  const ok = await notify.confirm(t('label.abort-op-confirm', { op }), {
    title: t('action.abort'),
    confirmText: t('action.abort')
  })
  if (!ok) return
  toastResult(await abortOperation(op))
}

/** A file row click shows its working-tree/staged diff in the bottom detail.
 *  The context menu reuses it with a mode so "Blame"/"View history" open the
 *  same detail panel already switched to that reading. */
function showWorkingDiff(path: string, staged: boolean, mode: DetailMode = 'diff'): void {
  externalDiff.value = { name: path, staged, commit: '' }
  resetDetailAux()
  if (mode !== 'diff') void setDetailMode(mode)
}

// ── File row context menu ────────────────────────────────────────────────────
// Only the second-level branch list is capped: a repo with dozens of branches
// would otherwise render a menu taller than the window (the popover does not
// scroll). The overflow row is inert rather than paging, because restoring a
// file from an old branch is rare enough that the branch card is the better
// path when the shortlist misses.
const RESTORE_BRANCH_MAX = 12

function openFileCtxMenu(e: MouseEvent, f: GitFileEntry, staged = false, untracked = false): void {
  const { clientX: x, clientY: y } = e
  const items: MenuItem[] = [
    { label: t('action.open-in-editor'), action: () => void openInEditor(f.path) },
    { label: t('action.view-history'), action: () => showWorkingDiff(f.path, staged, 'history') },
    { label: t('label.blame'), action: () => showWorkingDiff(f.path, staged, 'blame') },
    { label: t('action.restore-from-branch-menu'), action: () => openRestoreBranchMenu(x, y, f.path) }
  ]
  if (untracked) {
    items.push({ label: t('action.add-to-gitignore'), action: () => void onAddToGitignore(f.path) })
  }
  if (isConflictEntry(f)) {
    items.unshift({
      label: t('action.resolve-with-agent'),
      action: () => void onResolveWithAgent(f.path)
    })
  }
  openMenuAt(x, y, items)
}

/** Second level of the file menu: reopened at the same coordinates. */
function openRestoreBranchMenu(x: number, y: number, path: string): void {
  const names = localBranches.value
    .map((b) => b.name)
    .filter((n) => n !== gitStatus.value.branch)
  if (!names.length) {
    notify.toast(t('label.no-other-branch'), { type: 'error' })
    return
  }
  const items: MenuItem[] = names.slice(0, RESTORE_BRANCH_MAX).map((n) => ({
    label: n,
    action: () => void onRestoreFromBranch(n, path)
  }))
  const hidden = names.length - items.length
  if (hidden > 0) {
    items.push({
      label:
        hidden === 1
          ? t('label.more-branches-one', { count: hidden })
          : t('label.more-branches-many', { count: hidden }),
      disabled: true,
      action: () => {}
    })
  }
  openMenuAt(x, y, items)
}

async function onRestoreFromBranch(branch: string, path: string): Promise<void> {
  const ok = await notify.confirm(t('label.restore-file-confirm', { path, branch }), {
    title: t('label.restore-file-title'),
    confirmText: t('action.restore-file')
  })
  if (!ok) return
  if (
    toastResult(
      await restoreFileFromBranch(branch, path),
      t('label.restored-file', { path, branch })
    )
  ) {
    await refreshAll()
  }
}

async function onAddToGitignore(path: string): Promise<void> {
  const r = await addToGitignore(path)
  if (!r.ok) {
    toastResult(r)
    return
  }
  notify.toast(
    t('label.added-to-ignore-file', { path, file: r.target_file || '.gitignore' }),
    { type: 'success' }
  )
  await refreshAll()
}

// ── Detail panel: Diff / Blame / History / Conflict ──────────────────────────
type DetailMode = 'diff' | 'blame' | 'history' | 'conflict'
const detailMode = ref<DetailMode>('diff')
/** The detail's file is still an unmerged path. Drives both the Conflict mode
 *  being offered at all and ConflictPane's `mergeAborted` guard: `git status`
 *  is re-read on every git.changed broadcast, so a `merge --abort` run in
 *  another window takes the panel out of service instead of letting the user
 *  keep resolving a merge that no longer exists. */
const detailIsConflict = computed(() => {
  const target = externalDiff.value
  return !!target && conflictFiles.value.some((f) => f.path === target.name)
})
const detailModes = computed<readonly DetailMode[]>(() =>
  detailIsConflict.value
    ? (['diff', 'blame', 'history', 'conflict'] as const)
    : (['diff', 'blame', 'history'] as const)
)
// Blame: whole file (blameFile) or only the changed lines (diffBlame).
const blameChangedOnly = ref(false)
const blameEntries = ref<BlameEntry[]>([])
const blameHunks = ref<DiffBlameHunk[]>([])
const blameLoading = ref(false)
const blameMessage = ref('')
// History: this file's commits, plus the diff of the selected one.
const fileHistory = ref<GitCommit[]>([])
const historyLoading = ref(false)
const historyMessage = ref('')
const historyCommit = ref('')
const historyHunks = ref<DiffBlameHunk[]>([])
const historyDiffLoading = ref(false)

/** Switching files drops every mode's cache — the panes are per-file. */
function resetDetailAux(): void {
  detailMode.value = 'diff'
  blameChangedOnly.value = false
  blameEntries.value = []
  blameHunks.value = []
  blameLoading.value = false
  blameMessage.value = ''
  fileHistory.value = []
  historyLoading.value = false
  historyMessage.value = ''
  historyCommit.value = ''
  historyHunks.value = []
  historyDiffLoading.value = false
}

async function setDetailMode(mode: DetailMode): Promise<void> {
  detailMode.value = mode
  if (mode === 'blame') await loadBlame()
  else if (mode === 'history') await loadFileHistory()
}

function detailModeLabel(mode: DetailMode): string {
  if (mode === 'blame') return t('label.blame')
  if (mode === 'history') return t('label.history')
  if (mode === 'conflict') return t('label.conflict-mode')
  return t('label.diff')
}

/** ConflictPane resolved the file: back to the diff of what was just staged. */
async function onConflictResolved(): Promise<void> {
  detailMode.value = 'diff'
  await refreshAll()
}

async function loadBlame(): Promise<void> {
  const target = externalDiff.value
  if (!target) return
  blameLoading.value = true
  blameMessage.value = ''
  blameEntries.value = []
  blameHunks.value = []
  try {
    if (blameChangedOnly.value) {
      const hunks = await diffBlame(target.name, target.staged)
      if (externalDiff.value?.name !== target.name) return
      blameHunks.value = hunks
      if (!hunks.length) blameMessage.value = t('label.no-changed-lines')
    } else {
      const entries = await blameFile(target.name)
      if (externalDiff.value?.name !== target.name) return
      blameEntries.value = entries
      if (!entries.length) blameMessage.value = t('label.no-blame-info')
    }
  } finally {
    blameLoading.value = false
  }
}

const FILE_LOG_LIMIT = 30

async function loadFileHistory(): Promise<void> {
  const target = externalDiff.value
  if (!target) return
  historyLoading.value = true
  historyMessage.value = ''
  fileHistory.value = []
  historyCommit.value = ''
  historyHunks.value = []
  try {
    const commits = await fileLog(target.name, FILE_LOG_LIMIT)
    if (externalDiff.value?.name !== target.name) return
    fileHistory.value = commits
    if (!commits.length) historyMessage.value = t('label.no-file-history')
  } finally {
    historyLoading.value = false
  }
}

/** Same shape GitHistoryModal uses: commitFileDiff → DiffBlameHunk[] rendered
 *  inline (a second click on the same commit collapses it). */
async function selectHistoryCommit(hash: string): Promise<void> {
  const target = externalDiff.value
  if (!target) return
  if (historyCommit.value === hash) {
    historyCommit.value = ''
    historyHunks.value = []
    return
  }
  historyCommit.value = hash
  historyHunks.value = []
  historyDiffLoading.value = true
  try {
    const hunks = await commitFileDiff(hash, target.name)
    if (historyCommit.value === hash) historyHunks.value = hunks
  } finally {
    historyDiffLoading.value = false
  }
}

function hunkLineClass(kind: ' ' | '-' | '+'): string {
  return kind === '+' ? 'db-add' : kind === '-' ? 'db-del' : 'db-ctx'
}

// ── Commit composer ──────────────────────────────────────────────────────────
const commitMessage = ref('')
const canCommit = computed(
  () =>
    commitMessage.value.trim().length > 0 &&
    (gitStatus.value.staged.length > 0 || opInProgress.value !== '') &&
    !isCommitting.value
)

async function onCommit(): Promise<void> {
  if (!canCommit.value) return
  const r = await commit(commitMessage.value.trim())
  if (toastResult(r, t('label.committed'))) {
    commitMessage.value = ''
    await refreshAll()
  }
}
async function onAmend(): Promise<void> {
  const ok = await notify.confirm(
    commitMessage.value.trim()
      ? t('label.amend-confirm-with-message')
      : t('label.amend-confirm-keep-message'),
    { title: t('action.amend'), confirmText: t('action.amend') }
  )
  if (!ok) return
  const r = await amendCommit(commitMessage.value.trim())
  if (toastResult(r, t('label.amended'))) {
    commitMessage.value = ''
    await refreshAll()
  }
}
async function onGenerateMessage(): Promise<void> {
  const model = analyzerModel.value || 'qwen2:latest'
  const r = await generateMessage(model)
  if (r.ok) commitMessage.value = r.message
  else notify.toast(r.error || t('label.message-generation-failed'), { type: 'error' })
}

// ── Sidebar cards (aligned 1:1 with GitPane's sections) ──────────────────────
// Collapse state per card; branches expanded by default like GitPane's panel.
const branchesExpanded = ref(true)
const stashesExpanded = ref(false)
const remotesExpanded = ref(false)
const tagsExpanded = ref(false)
const worktreesExpanded = ref(false)
const configExpanded = ref(false)
// Remote branches live inside the branch card behind the ⇅ toggle (GitPane).
const showRemoteBranches = ref(false)

// ── Branches (GitPane branch panel) ──────────────────────────────────────────
const newBranchName = ref('')
const branchOpError = ref('')
// Inline compare panel (GitPane's ⇔): stat + files against the current branch.
const comparingBranch = ref('')
const compareResult = ref<{ stat: string; files: string[] } | null>(null)

async function onSwitchBranch(name: string): Promise<void> {
  if (name === gitStatus.value.branch) return
  branchOpError.value = ''
  const r = await switchBranch(name)
  if (!r.ok) branchOpError.value = r.error || t('label.switch-failed')
}
async function doCreateBranch(): Promise<void> {
  const name = newBranchName.value.trim()
  if (!name || /\s|\.\./.test(name) || name.startsWith('-')) return
  branchOpError.value = ''
  const r = await createBranch(name)
  if (r.ok) newBranchName.value = ''
  else branchOpError.value = r.error || t('label.create-failed')
}
async function doCompareBranch(name: string): Promise<void> {
  if (comparingBranch.value === name) {
    comparingBranch.value = ''
    compareResult.value = null
    return
  }
  comparingBranch.value = name
  const r = await compareBranches(name, gitStatus.value.branch)
  compareResult.value = r.ok ? { stat: r.stat, files: r.files } : null
  if (!r.ok) branchOpError.value = r.error || t('label.compare-failed')
}
async function doMergeIntoCurrent(name: string): Promise<void> {
  branchOpError.value = ''
  const r = await mergeBranch(name)
  if (!r.ok) branchOpError.value = r.error || t('label.merge-failed')
}
async function doRebaseOnto(name: string): Promise<void> {
  branchOpError.value = ''
  const r = await rebaseOn(name)
  if (!r.ok) branchOpError.value = r.error || t('label.rebase-failed')
}
/** Merge the current branch INTO another one (git.merge_into: checkout target,
 *  merge, come back) — the mirror of the row's ⤵ "merge into current". */
async function doMergeCurrentInto(name: string): Promise<void> {
  const current = gitStatus.value.branch
  const ok = await notify.confirm(
    t('label.merge-current-into-confirm', {
      branch: current || t('label.the-current-branch'),
      target: name
    }),
    { title: t('action.merge'), confirmText: t('action.merge') }
  )
  if (!ok) return
  const r = await mergeInto(name)
  if (!r.ok) {
    toastResult(r)
    return
  }
  const conflicts = r.conflict_files?.length ?? 0
  if (conflicts) {
    notify.toast(
      conflicts === 1
        ? t('label.merged-with-conflicts-one', { branch: name, count: conflicts })
        : t('label.merged-with-conflicts-many', { branch: name, count: conflicts }),
      { type: 'error' }
    )
  } else {
    notify.toast(t('label.merged-into', { branch: name }), { type: 'success' })
  }
  await refreshAll()
}

// GitPane deletes branches from a right-click context menu — same here.
function openBranchCtxMenu(e: MouseEvent, name: string): void {
  openMenu(e, [
    {
      label: t('action.merge-current-into-branch', { branch: name }),
      action: () => void doMergeCurrentInto(name)
    },
    {
      label: t('action.delete-branch-menu'),
      danger: true,
      action: () =>
        void notify
          .confirm(t('label.delete-branch-confirm', { name }), {
            title: t('label.delete-branch-title'),
            confirmText: t('action.delete')
          })
          .then(async (ok) => {
            if (ok) toastResult(await deleteBranch(name), t('label.deleted-name', { name }))
          })
    }
  ])
}
async function onCheckoutRemoteBranch(ref: string): Promise<void> {
  branchOpError.value = ''
  const r = await checkoutRemoteBranch(ref)
  if (!r.ok) branchOpError.value = r.error || t('label.checkout-failed')
}

// ── Stashes ──────────────────────────────────────────────────────────────────
async function onStashPush(): Promise<void> {
  const msg = await notify.prompt(t('label.stash-message-optional'), {
    title: t('label.stash-changes-title')
  })
  if (msg === null) return
  toastResult(await stashPush(msg.trim()), t('label.stashed'))
}
async function onStashApply(index: number): Promise<void> {
  toastResult(await stashApply(index))
}
async function onStashPop(index: number): Promise<void> {
  toastResult(await stashPop(index))
}
async function onStashDrop(index: number): Promise<void> {
  const ok = await notify.confirm(t('label.drop-stash-confirm'), {
    title: t('label.drop-stash-title'),
    confirmText: t('action.drop')
  })
  if (!ok) return
  toastResult(await stashDrop(index))
}

// ── Remotes ──────────────────────────────────────────────────────────────────
const newRemoteName = ref('')
const newRemoteUrl = ref('')

async function doAddRemote(): Promise<void> {
  const name = newRemoteName.value.trim()
  const url = newRemoteUrl.value.trim()
  if (!name || !url) return
  if (toastResult(await addRemote(name, url), t('label.added-name', { name }))) {
    newRemoteName.value = ''
    newRemoteUrl.value = ''
  }
}
async function onRemoveRemote(name: string): Promise<void> {
  const ok = await notify.confirm(t('label.remove-remote-confirm', { name }), {
    title: t('action.remove-remote'),
    confirmText: t('action.remove')
  })
  if (!ok) return
  toastResult(await removeRemote(name))
}

// ── Tags ─────────────────────────────────────────────────────────────────────
const newTagName = ref('')
const newTagMessage = ref('')

async function doCreateTag(): Promise<void> {
  const name = newTagName.value.trim()
  if (!name) return
  if (
    toastResult(
      await createTag(name, newTagMessage.value.trim()),
      t('label.tagged-name', { name })
    )
  ) {
    newTagName.value = ''
    newTagMessage.value = ''
  }
}
async function onDeleteTag(name: string): Promise<void> {
  const ok = await notify.confirm(t('label.delete-tag-confirm', { name }), {
    title: t('action.delete-tag'),
    confirmText: t('action.delete')
  })
  if (!ok) return
  toastResult(await deleteTag(name))
}

// ── Worktrees ────────────────────────────────────────────────────────────────
const newWtPath = ref('')
const newWtBranch = ref('')
const newWtIsNew = ref(false)
const worktreeBranchOptions = computed(() =>
  gitBranches.value.filter((b) => !b.is_remote).map((b) => b.name)
)

async function doAddWorktree(): Promise<void> {
  const path = newWtPath.value.trim()
  const branch = newWtBranch.value.trim()
  if (!path || !branch) return
  if (
    toastResult(await addWorktree(path, branch, newWtIsNew.value), t('label.worktree-added'))
  ) {
    newWtPath.value = ''
    newWtBranch.value = ''
  }
  await loadWorktrees()
}
async function pickWorktreeDir(): Promise<void> {
  const picked = await pickFolder(newWtPath.value.trim() || undefined)
  if (picked) newWtPath.value = picked
}
async function onRemoveWorktree(path: string): Promise<void> {
  const ok = await notify.confirm(t('label.remove-worktree-at-confirm', { path }), {
    title: t('action.remove-worktree'),
    confirmText: t('action.remove')
  })
  if (!ok) return
  const r = await removeWorktree(path)
  if (!r.ok) {
    // A dirty/locked worktree fails a plain remove — offer --force (GitPane).
    const forced = await notify.confirm(
      t('label.force-remove-confirm', { error: r.error || t('label.worktree-remove-failed') }),
      {
        title: t('action.remove-worktree'),
        confirmText: t('action.force-remove-worktree')
      }
    )
    if (forced) toastResult(await removeWorktree(path, true))
  }
  await loadWorktrees()
}
async function onToggleWorktreeLock(wt: { path: string; locked: boolean }): Promise<void> {
  toastResult(wt.locked ? await unlockWorktree(wt.path) : await lockWorktree(wt.path))
  await loadWorktrees()
}
async function onMoveWorktree(path: string): Promise<void> {
  const dest = await pickFolder(path)
  if (!dest) return
  toastResult(await moveWorktree(path, dest), t('label.worktree-moved'))
  await loadWorktrees()
}
async function onPruneWorktrees(): Promise<void> {
  toastResult(await pruneWorktrees(), t('label.pruned'))
  await loadWorktrees()
}
async function onRepairWorktrees(): Promise<void> {
  toastResult(await repairWorktrees(), t('label.repaired'))
  await loadWorktrees()
}

// ── Config (inline editing, GitPane parity) ──────────────────────────────────
const configDisplayKeys = computed(() =>
  gitConfigAllowedKeys.value.length
    ? gitConfigAllowedKeys.value
    : ['user.name', 'user.email', 'core.autocrlf', 'core.filemode', 'pull.rebase']
)
const CONFIG_OPTIONS: Record<string, string[]> = {
  'core.autocrlf': ['true', 'false', 'input'],
  'core.filemode': ['true', 'false'],
  'pull.rebase': ['true', 'false']
}
const inlineEditKey = ref('')
const inlineEditValue = ref('')
const configError = ref('')

function toggleConfigCard(): void {
  configExpanded.value = !configExpanded.value
  if (configExpanded.value) void loadGitConfig()
}
function startInlineEdit(key: string): void {
  inlineEditKey.value = key
  inlineEditValue.value = gitConfig.value[key] ?? ''
}
function cancelInlineEdit(): void {
  inlineEditKey.value = ''
  inlineEditValue.value = ''
}
async function saveInlineEdit(): Promise<void> {
  configError.value = ''
  const key = inlineEditKey.value
  if (!key) return
  const r = await setGitConfig(key, inlineEditValue.value)
  if (!r.ok) configError.value = r.error || t('label.failed')
  else cancelInlineEdit()
}

// ── Issues card (GitPane parity; lazy-loads the CLI on first expand) ─────────
const issuesExpanded = ref(false)
const showNewIssue = ref(false)
const newIssueTitle = ref('')
const newIssueBody = ref('')
const newComment = ref('')
const openIssueCount = computed(() => issues.value.filter((i) => i.state === 'open').length)

function toggleIssuesCard(): void {
  issuesExpanded.value = !issuesExpanded.value
  if (issuesExpanded.value) void ensureIssuesLoaded()
}
async function submitNewIssue(): Promise<void> {
  const r = await createIssue(newIssueTitle.value, newIssueBody.value)
  if (r.ok) {
    newIssueTitle.value = ''
    newIssueBody.value = ''
    showNewIssue.value = false
  }
}
async function submitComment(): Promise<void> {
  const n = selectedIssue.value?.number
  if (n == null) return
  const r = await addComment(n, newComment.value)
  if (r.ok) newComment.value = ''
}
async function toggleIssueState(): Promise<void> {
  const issue = selectedIssue.value
  if (!issue) return
  await setIssueState(issue.number, issue.state === 'open' ? 'closed' : 'open')
}
function issueProviderLabel(): string {
  if (issueProvider.value.provider === 'github') return 'GitHub'
  if (issueProvider.value.provider === 'gitlab') return 'GitLab'
  return ''
}

// ── Branch diff view ─────────────────────────────────────────────────────────
const diffBase = ref('')
const diffCompare = ref('')

function openBranchDiff(): void {
  view.value = 'branchdiff'
  if (!diffCompare.value) diffCompare.value = gitStatus.value.branch
  if (!diffBase.value) {
    const names = localBranches.value.map((b) => b.name)
    diffBase.value =
      names.find((n) => n === 'main' || n === 'master') ??
      names.find((n) => n !== diffCompare.value) ??
      ''
  }
}

// ── Toolbar actions ──────────────────────────────────────────────────────────
async function onFetch(): Promise<void> {
  await fetchRemote()
  await refreshAll()
}
async function onPull(): Promise<void> {
  isPulling.value = true
  try {
    await pullOnly()
    await refreshAll()
  } finally {
    isPulling.value = false
  }
}
async function onPush(): Promise<void> {
  isPushing.value = true
  try {
    await pushOnly()
    await refreshAll()
  } finally {
    isPushing.value = false
  }
}
async function onSync(): Promise<void> {
  await sync()
  await refreshAll()
}

// ── Toolbar "⋯" menu (the less-used / destructive remote operations) ─────────
const isRunningExtra = ref(false)

async function runExtraOp(
  op: () => Promise<{ ok: boolean; error?: string }>,
  okMsg: string
): Promise<void> {
  isRunningExtra.value = true
  try {
    if (toastResult(await op(), okMsg)) await refreshAll()
  } finally {
    isRunningExtra.value = false
  }
}

async function onForcePush(): Promise<void> {
  const ok = await notify.confirm(t('label.force-push-confirm'), {
    title: t('action.force-push'),
    confirmText: t('action.force-push')
  })
  if (!ok) return
  await runExtraOp(() => pushForce(), t('label.force-pushed'))
}

async function onUndoLastCommit(): Promise<void> {
  const ok = await notify.confirm(t('label.undo-last-commit-confirm'), {
    title: t('label.undo-last-commit-title'),
    confirmText: t('action.undo-commit')
  })
  if (!ok) return
  await runExtraOp(() => undoLastCommit(), t('label.last-commit-undone'))
}

/** Two-stage clean: a dry run names the victims, and only a confirmation on
 *  that exact list runs the real (irreversible) delete. */
const CLEAN_PREVIEW_MAX = 10

async function onCleanUntracked(): Promise<void> {
  isRunningExtra.value = true
  let preview: { ok: boolean; files: string[]; error?: string }
  try {
    preview = await cleanUntracked(true)
  } finally {
    isRunningExtra.value = false
  }
  if (!preview.ok) {
    toastResult(preview)
    return
  }
  if (!preview.files.length) {
    notify.toast(t('label.nothing-to-clean'))
    return
  }
  const shown = preview.files.slice(0, CLEAN_PREVIEW_MAX)
  const hidden = preview.files.length - shown.length
  const listed = [
    ...shown,
    ...(hidden > 0 ? [t('label.and-more', { count: hidden })] : [])
  ].join('\n')
  const count = preview.files.length
  const ok = await notify.confirm(
    count === 1
      ? t('label.clean-untracked-confirm-one', { count, files: listed })
      : t('label.clean-untracked-confirm-many', { count, files: listed }),
    { title: t('label.clean-untracked-title'), confirmText: t('action.delete-files') }
  )
  if (!ok) return
  isRunningExtra.value = true
  try {
    const r = await cleanUntracked(false)
    const removed = r.files.length || preview.files.length
    const doneMsg =
      removed === 1
        ? t('label.deleted-files-one', { count: removed })
        : t('label.deleted-files-many', { count: removed })
    if (toastResult(r, doneMsg)) await refreshAll()
  } finally {
    isRunningExtra.value = false
  }
}

function openToolbarMenu(e: MouseEvent): void {
  const branch = gitStatus.value.branch
  const items: MenuItem[] = [
    {
      label: t('action.pull-rebase-menu'),
      action: () => void runExtraOp(() => pullRebase(), t('label.pulled-rebase'))
    }
  ]
  if (branch) {
    items.push({
      label: t('action.push-set-upstream'),
      action: () =>
        void runExtraOp(
          () => pushUpstream(branch),
          t('label.pushed-set-upstream', { branch })
        )
    })
  }
  items.push(
    {
      label: t('action.force-push-menu'),
      danger: true,
      separator: true,
      action: () => void onForcePush()
    },
    { label: t('action.undo-last-commit-menu'), danger: true, action: () => void onUndoLastCommit() },
    { label: t('action.clean-untracked-menu'), danger: true, action: () => void onCleanUntracked() }
  )
  openMenu(e, items)
}

// ── Non-repo empty state: initialize here, or clone somewhere ────────────────
const initGitignore = ref(true)
const showCloneForm = ref(false)
const cloneUrl = ref('')
const cloneDir = ref('')
const isCloning = ref(false)
const canClone = computed(
  () => cloneUrl.value.trim().length > 0 && cloneDir.value.trim().length > 0 && !isCloning.value
)

async function onInitRepo(): Promise<void> {
  const r = await initRepo(initGitignore.value)
  if (!r.ok) {
    toastResult(r)
    return
  }
  notify.toast(
    r.gitignore_created ? t('label.initialized-with-gitignore') : t('label.initialized'),
    { type: 'success' }
  )
  await refreshAll()
}

async function pickCloneDir(): Promise<void> {
  const picked = await pickFolder(cloneDir.value.trim() || undefined)
  if (picked) cloneDir.value = picked
}

/** A clone lands outside this window's workspace, so the injected UI port opens
 *  the result in a workspace window. */
async function onCloneRepo(): Promise<void> {
  if (!canClone.value) return
  isCloning.value = true
  try {
    const r = await cloneRepo(cloneUrl.value.trim(), cloneDir.value.trim())
    if (!toastResult(r)) return
    notify.toast(r.path ? t('label.cloned-into', { path: r.path }) : t('label.cloned'), {
      type: 'success'
    })
    if (r.path) await onOpenWorktree(r.path)
  } finally {
    isCloning.value = false
  }
}

const busy = computed(
  () =>
    isFetching.value ||
    isSyncing.value ||
    isPulling.value ||
    isPushing.value ||
    isRunningExtra.value ||
    isLoadingStatus.value ||
    isLoadingLog.value
)

// ── Keyboard shortcuts ───────────────────────────────────────────────────────
// Same wiring as the Mini IDE window: install the shared capture-phase
// dispatcher, flag this window with a `when` context so the git.* rules in
// keybindings/defaults.ts only resolve here, then register the handlers.
// The plugin composition supplies an intentionally empty persistence port, so
// this view uses the shipped defaults unless a later composition opts in.
useKeybindings()
setContext('gitWindow', true)

// Mirrors the toolbar buttons' `busy || !isRepo` disabled state — a shortcut
// must not fire an operation the equivalent button refuses to run.
function gitActionsReady(): boolean {
  return isRepo.value && !busy.value
}

// ⌘⇧W. Inside the plugin view there is no window of our own to close — ask the
// host to hide the view instead, the same fallback EditorWindowApp takes.
registerCommand('workbench.action.closeWindow', () => {
  const navBridge = (window as unknown as { nav?: { hideSelf?: () => void } }).nav
  if (navBridge?.hideSelf) {
    navBridge.hideSelf()
    return
  }
  window.close()
})

registerCommand('git.refresh', () => {
  if (hasWorkspace.value) void refreshAll()
})
registerCommand('git.commit', () => {
  if (gitActionsReady()) void onCommit()
})
registerCommand('git.amend', () => {
  if (gitActionsReady()) void onAmend()
})
registerCommand('git.generateMessage', () => {
  if (gitActionsReady()) void onGenerateMessage()
})
registerCommand('git.stageAll', () => {
  if (gitActionsReady()) void onStageAll()
})
registerCommand('git.unstageAll', () => {
  if (gitActionsReady()) void onUnstageAll()
})
registerCommand('git.fetch', () => {
  if (gitActionsReady()) void onFetch()
})
registerCommand('git.pull', () => {
  if (gitActionsReady()) void onPull()
})
registerCommand('git.push', () => {
  if (gitActionsReady()) void onPush()
})
registerCommand('git.sync', () => {
  if (gitActionsReady()) void onSync()
})
registerCommand('git.focusAgent', () => {
  aiDockOpen.value = true
  void nextTick(() => aiDockRef.value?.terminal?.focus())
})
</script>

<template>
  <div class="git-window">
    <!-- ── Toolbar ────────────────────────────────────────────────────── -->
    <!-- No <WindowControls> here: this root is mounted inside the Git plugin
         bundle, which has no Host bridge, and gitComposition.test.ts enforces
         that boundary. Both Git windows need window controls through a
         `ui.window.*` capability instead — see the cross-platform plan. -->
    <header class="toolbar" :class="{ 'no-traffic-lights': !reserveTrafficLights }">
      <span class="wm">Navide Git</span>
      <span class="crumb" v-truncate>
        {{ repoName }}<template v-if="gitStatus.branch">
          <span class="crumb-sep">／</span><b class="mono">{{ gitStatus.branch }}</b>
          <span v-if="gitStatus.ahead" class="crumb-cnt">↑{{ gitStatus.ahead }}</span>
          <span v-if="gitStatus.behind" class="crumb-cnt">↓{{ gitStatus.behind }}</span>
        </template>
      </span>
      <span v-if="busy" class="busy-dot" :title="$t('label.working')" />
      <div class="tb-actions">
        <button class="gbtn" :disabled="busy || !isRepo" @click="onFetch">{{ $t('action.fetch') }}</button>
        <button class="gbtn" :disabled="busy || !isRepo" @click="onPull">{{ $t('action.pull') }}</button>
        <button class="gbtn" :disabled="busy || !isRepo" @click="onPush">{{ $t('action.push') }}</button>
        <button class="pbtn" :disabled="busy || !isRepo" :title="$t('hint.pull-then-push')" @click="onSync">{{ $t('action.sync') }}</button>
        <button
          class="gbtn icon tb-more"
          :disabled="busy || !isRepo"
          :title="$t('hint.more-git-operations')"
          @click="openToolbarMenu"
        >⋯</button>
      </div>
    </header>

    <div v-if="gitError" class="err-bar">{{ gitError }}</div>

    <div v-if="!hasWorkspace" class="empty">{{ $t('label.no-workspace-path') }}</div>
    <div v-else-if="!isRepo && !isLoadingStatus" class="empty">
      <div class="init-card">
        <h2 class="init-title">{{ $t('error.not-git-repo') }}</h2>
        <p class="init-sub">{{ $t('hint.init-repo') }}</p>
        <div class="init-row">
          <button class="pbtn" :disabled="isInitializing" @click="onInitRepo">
            {{ isInitializing ? $t('label.initializing') : $t('action.initialize-repository') }}
          </button>
          <label class="check-label">
            <input v-model="initGitignore" type="checkbox" :disabled="isInitializing" />
            {{ $t('label.create-gitignore') }}
          </label>
        </div>
        <div class="init-row">
          <button class="gbtn" @click="showCloneForm = !showCloneForm">{{ $t('action.clone-repository') }}</button>
        </div>
        <div v-if="showCloneForm" class="init-clone">
          <input
            v-model="cloneUrl"
            class="git-input"
            :placeholder="$t('label.repository-url-placeholder')"
            spellcheck="false"
          />
          <div class="input-row">
            <input
              v-model="cloneDir"
              class="git-input"
              :placeholder="$t('label.target-folder-placeholder')"
              spellcheck="false"
            />
            <button class="btn-ghost sm" :title="$t('hint.choose-a-folder')" @click="pickCloneDir">…</button>
          </div>
          <button class="pbtn clone-go" :disabled="!canClone" @click="onCloneRepo">
            {{ isCloning ? $t('label.cloning') : $t('action.clone') }}
          </button>
        </div>
      </div>
    </div>

    <div v-else class="body">
      <!-- ── Sidebar ──────────────────────────────────────────────────── -->
      <aside class="sidebar">
        <nav class="navi">
          <button :class="{ on: view === 'status' }" @click="view = 'status'">
            {{ $t('label.changes') }}<span v-if="changeCount" class="n">{{ changeCount }}</span>
          </button>
          <button :class="{ on: view === 'history' }" @click="view = 'history'">{{ $t('label.history') }}</button>
          <button :class="{ on: view === 'branchdiff' }" @click="openBranchDiff">{{ $t('label.branch-diff') }}</button>
        </nav>
        <div class="divider" />

        <!-- ── BRANCHES (GitPane branch panel, verbatim controls) ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="branchesExpanded = !branchesExpanded">
            <span class="sec-caret">{{ branchesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">{{ $t('label.branches') }}</span>
            <span v-if="localBranches.length" class="sec-badge">{{ localBranches.length }}</span>
            <div class="spacer" />
          </div>
          <div v-if="branchesExpanded" class="card-body collapsible-body">
            <div class="input-row">
              <input
                v-model="newBranchName"
                class="git-input"
                :placeholder="$t('label.new-branch-input-placeholder')"
                spellcheck="false"
                @keydown.enter="doCreateBranch"
              />
              <button
                class="btn-ghost sm"
                :disabled="!newBranchName.trim() || /\s|\.\./.test(newBranchName.trim()) || newBranchName.trim().startsWith('-')"
                @click="doCreateBranch"
              >＋</button>
              <button
                class="btn-ghost sm"
                :class="{ active: showRemoteBranches }"
                :title="showRemoteBranches ? $t('action.hide-remote-branches') : $t('action.show-remote-branches')"
                @click="showRemoteBranches = !showRemoteBranches"
              >⇅</button>
            </div>
            <p v-if="branchOpError" class="err-text">{{ branchOpError }}</p>
            <div
              v-for="b in localBranches"
              :key="b.name"
              class="branch-row"
              :class="{ current: b.is_current }"
              @contextmenu.prevent="!b.is_current && openBranchCtxMenu($event, b.name)"
            >
              <span class="b-check">{{ b.is_current ? '✓' : '' }}</span>
              <span class="b-name" v-truncate>{{ b.name }}</span>
              <span v-if="b.tracking" class="b-track">→ {{ b.tracking }}</span>
              <div class="spacer" />
              <template v-if="!b.is_current">
                <button class="row-btn always" :title="$t('action.compare')" @click.stop="doCompareBranch(b.name)">⇔</button>
                <button class="row-btn always" :title="$t('action.rebase-current-onto')" @click.stop="doRebaseOnto(b.name)">⇡</button>
                <button class="row-btn always" :title="$t('action.merge-into-current')" @click.stop="doMergeIntoCurrent(b.name)">⇣</button>
                <button class="row-btn always" :title="$t('action.switch')" @click.stop="onSwitchBranch(b.name)">↵</button>
              </template>
            </div>
            <div v-if="!localBranches.length" class="empty-msg">{{ $t('label.no-branches') }}</div>
            <template v-if="showRemoteBranches">
              <div class="branch-section-label">{{ $t('label.remote-branches') }}</div>
              <div v-if="!remoteBranches.length" class="empty-msg">{{ $t('label.no-remote-branches') }}</div>
              <div
                v-for="b in remoteBranches"
                :key="b.name"
                class="branch-row remote-branch-row"
                :class="{ 'remote-has-local': b.has_local }"
              >
                <span class="b-check">{{ b.has_local ? '✓' : '' }}</span>
                <span class="b-name remote" v-truncate>{{ b.name }}</span>
                <div class="spacer" />
                <button
                  v-if="!b.has_local"
                  class="row-btn always"
                  :title="$t('action.checkout-locally')"
                  @click.stop="onCheckoutRemoteBranch(b.name)"
                >⬇</button>
              </div>
            </template>
            <div v-if="comparingBranch && compareResult" class="compare-panel">
              <div class="compare-title">{{ comparingBranch }} ↔ {{ gitStatus.branch }}</div>
              <div class="compare-stat">{{ compareResult.stat }}</div>
              <div v-for="f in compareResult.files" :key="f" class="compare-file">{{ f }}</div>
            </div>
          </div>
        </div>

        <!-- ── STASHES ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="stashesExpanded = !stashesExpanded">
            <span class="sec-caret">{{ stashesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">{{ $t('label.stashes') }}</span>
            <span v-if="gitStashes.length" class="sec-badge">{{ gitStashes.length }}</span>
            <div class="spacer" />
            <button class="row-btn always" :title="$t('action.stash-working-changes')" @click.stop="onStashPush">＋</button>
          </div>
          <div v-if="stashesExpanded" class="card-body collapsible-body">
            <div v-if="!gitStashes.length" class="empty-msg">{{ $t('label.no-stashes') }}</div>
            <div v-for="st in gitStashes" :key="st.ref" class="generic-row">
              <span class="stash-ref">{{ st.ref }}</span>
              <span class="stash-msg" v-truncate>{{ st.message }}</span>
              <div class="row-actions always">
                <button class="row-btn always" :title="$t('action.stash-apply')" @click.stop="onStashApply(st.index)">⎘</button>
                <button class="row-btn always" :title="$t('action.stash-pop')" @click.stop="onStashPop(st.index)">↑</button>
                <button class="row-btn always danger" :title="$t('action.drop')" @click.stop="onStashDrop(st.index)">✕</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── REMOTES ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="remotesExpanded = !remotesExpanded">
            <span class="sec-caret">{{ remotesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">{{ $t('label.remotes') }}</span>
            <span v-if="gitRemotes.length" class="sec-badge">{{ gitRemotes.length }}</span>
            <div class="spacer" />
          </div>
          <div v-if="remotesExpanded" class="card-body collapsible-body">
            <div v-if="!gitRemotes.length" class="empty-msg">{{ $t('label.no-remotes') }}</div>
            <div v-for="r in gitRemotes" :key="r.name" class="generic-row">
              <span class="remote-name">{{ r.name }}</span>
              <span class="remote-url" v-truncate>{{ r.fetch_url }}</span>
              <button class="row-btn always" :title="$t('action.open-remote-url')" @click.stop="openExternal(r.fetch_url)">↗</button>
              <button class="row-btn always danger" :title="$t('action.remove-remote')" @click.stop="onRemoveRemote(r.name)">✕</button>
            </div>
            <div class="input-row" style="margin-top: 6px">
              <input v-model="newRemoteName" class="git-input" :placeholder="$t('label.name-placeholder')" style="width: 72px; flex: 0 0 auto" />
              <input v-model="newRemoteUrl" class="git-input" :placeholder="$t('label.url')" @keydown.enter="doAddRemote" />
              <button class="btn-ghost sm" :disabled="!newRemoteName.trim() || !newRemoteUrl.trim()" @click="doAddRemote">＋</button>
            </div>
          </div>
        </div>

        <!-- ── TAGS ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="tagsExpanded = !tagsExpanded">
            <span class="sec-caret">{{ tagsExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">{{ $t('label.tags') }}</span>
            <span v-if="gitTags.length" class="sec-badge">{{ gitTags.length }}</span>
            <div class="spacer" />
          </div>
          <div v-if="tagsExpanded" class="card-body collapsible-body">
            <div v-if="!gitTags.length" class="empty-msg">{{ $t('label.no-tags') }}</div>
            <div v-for="t in gitTags" :key="t.name" class="generic-row">
              <span class="b-name" v-truncate>{{ t.name }}</span>
              <code class="chash" style="margin-left: 4px">{{ t.commit_hash }}</code>
              <span v-if="t.message" class="b-track">{{ t.message }}</span>
              <div class="spacer" />
              <button class="row-btn always danger" :title="$t('action.delete-tag')" @click.stop="onDeleteTag(t.name)">✕</button>
            </div>
            <div class="input-row" style="margin-top: 6px; flex-wrap: wrap; gap: 4px">
              <input v-model="newTagName" class="git-input" placeholder="v1.0.0" style="flex: 1; min-width: 72px" />
              <input v-model="newTagMessage" class="git-input" :placeholder="$t('label.message')" style="flex: 2; min-width: 80px" />
              <button class="btn-ghost sm" :disabled="!newTagName.trim()" @click="doCreateTag">＋</button>
            </div>
          </div>
        </div>

        <!-- ── WORKTREES ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="worktreesExpanded = !worktreesExpanded">
            <span class="sec-caret">{{ worktreesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">{{ $t('label.worktrees') }}</span>
            <span v-if="gitWorktrees.length > 1" class="sec-badge">{{ gitWorktrees.length }}</span>
            <div class="spacer" />
          </div>
          <div v-if="worktreesExpanded" class="card-body collapsible-body">
            <div class="input-row" style="margin-bottom: 6px">
              <button class="btn-ghost sm" :title="$t('hint.prune-stale-worktrees')" @click="onPruneWorktrees">{{ $t('action.prune') }}</button>
              <button class="btn-ghost sm" :title="$t('hint.repair-worktree-links')" @click="onRepairWorktrees">{{ $t('action.repair') }}</button>
            </div>
            <div v-for="wt in gitWorktrees" :key="wt.path" class="generic-row">
              <span class="wt-icon">{{ wt.is_main ? '✦' : '○' }}</span>
              <div style="flex: 1; min-width: 0">
                <div class="wt-name-row">
                  <span class="b-name" v-truncate :title="wt.path">{{ wt.path.split('/').at(-1) }}</span>
                  <span v-if="wt.bare" class="wt-badge">{{ $t('label.bare') }}</span>
                  <span v-if="wt.detached" class="wt-badge">{{ $t('label.detached') }}</span>
                  <span v-if="wt.locked" class="wt-badge warn" :title="wt.lock_reason">🔒 {{ $t('label.locked') }}</span>
                  <span v-if="wt.prunable" class="wt-badge warn" :title="wt.prune_reason">⚠ {{ $t('label.stale') }}</span>
                </div>
                <div class="b-track">{{ wt.branch || wt.head.slice(0, 8) }}</div>
              </div>
              <button
                v-if="!wt.bare && wt.path !== workspacePath"
                class="row-btn always"
                :title="$t('action.open-in-new-window')"
                @click.stop="onOpenWorktree(wt.path)"
              >⧉</button>
              <button v-if="!wt.bare" class="row-btn always" :title="$t('action.reveal-in-finder')" @click.stop="revealPath(wt.path)">◱</button>
              <button
                v-if="!wt.is_main"
                class="row-btn always"
                :title="wt.locked ? $t('action.unlock') : $t('action.lock')"
                @click.stop="onToggleWorktreeLock(wt)"
              >{{ wt.locked ? '🔓' : '🔒' }}</button>
              <button
                v-if="!wt.is_main && !wt.bare"
                class="row-btn always"
                :title="$t('action.move-worktree')"
                @click.stop="onMoveWorktree(wt.path)"
              >⇄</button>
              <button
                v-if="!wt.is_main"
                class="row-btn always danger"
                :title="$t('action.remove-worktree')"
                @click.stop="onRemoveWorktree(wt.path)"
              >✕</button>
            </div>
            <div class="input-row" style="margin-top: 6px">
              <input v-model="newWtPath" class="git-input" :placeholder="$t('label.absolute-path-placeholder')" style="flex: 2" spellcheck="false" />
              <button class="btn-ghost sm" :title="$t('hint.browse-for-folder')" @click="pickWorktreeDir">…</button>
              <input v-if="newWtIsNew" v-model="newWtBranch" class="git-input" placeholder="new-branch" style="flex: 1" spellcheck="false" />
              <select v-else v-model="newWtBranch" class="git-input" style="flex: 1">
                <option value="" disabled>{{ $t('label.branch-placeholder') }}</option>
                <option v-for="b in worktreeBranchOptions" :key="b" :value="b">{{ b }}</option>
              </select>
              <button class="btn-ghost sm" :disabled="!newWtPath.trim() || !newWtBranch.trim()" :title="$t('action.add-worktree')" @click="doAddWorktree">＋</button>
            </div>
            <label class="check-label"><input v-model="newWtIsNew" type="checkbox" /> {{ $t('label.worktree-create-new-branch') }}</label>
          </div>
        </div>

        <!-- ── CONFIG (inline editing) ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="toggleConfigCard">
            <span class="sec-caret">{{ configExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">{{ $t('label.config') }}</span>
            <div class="spacer" />
          </div>
          <div v-if="configExpanded" class="card-body collapsible-body">
            <div v-for="key in configDisplayKeys" :key="key" class="config-row">
              <span class="config-key">{{ key }}</span>
              <template v-if="inlineEditKey === key">
                <select v-if="CONFIG_OPTIONS[key]" v-model="inlineEditValue" class="git-input config-inline-input">
                  <option value="" disabled>—</option>
                  <option v-for="opt in CONFIG_OPTIONS[key]" :key="opt" :value="opt">{{ opt }}</option>
                </select>
                <input
                  v-else
                  v-model="inlineEditValue"
                  class="git-input config-inline-input"
                  @keydown.enter="saveInlineEdit"
                  @keydown.esc="cancelInlineEdit"
                />
                <button class="btn-ghost sm" @click="saveInlineEdit">✓</button>
                <button class="btn-ghost sm" @click="cancelInlineEdit">✕</button>
              </template>
              <span v-else class="config-val clickable" v-truncate @click="startInlineEdit(key)">{{ gitConfig[key] || '—' }}</span>
            </div>
            <p v-if="configError" class="err-text">{{ configError }}</p>
          </div>
        </div>

        <!-- ── ISSUES (GitHub/GitLab) ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="toggleIssuesCard">
            <span class="sec-caret">{{ issuesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">{{ $t('label.issues') }}</span>
            <span v-if="issuesExpanded && issueProviderLabel()" class="sec-badge">{{ issueProviderLabel() }}</span>
            <span v-if="issuesExpanded && openIssueCount" class="sec-badge">{{ $t('label.n-open', { count: openIssueCount }) }}</span>
            <div class="spacer" />
            <button
              v-if="issuesExpanded && issueProvider.authenticated && !selectedIssue"
              class="row-btn always"
              :title="$t('action.new-issue')"
              @click.stop="showNewIssue = !showNewIssue"
            >＋</button>
            <button v-if="issuesExpanded" class="row-btn always" :title="$t('action.refresh')" @click.stop="refreshIssues">↻</button>
          </div>
          <div v-if="issuesExpanded" class="card-body collapsible-body">
            <div v-if="issueProvider.provider === 'unknown'" class="empty-msg" style="padding: 2px 0">
              {{ $t('label.no-issue-host') }}
            </div>
            <div v-else-if="!issueProvider.cli_available" class="empty-msg" style="padding: 2px 0">
              {{ $t('label.cli-not-installed', { cli: issueProvider.provider === 'github' ? 'GitHub CLI (gh)' : 'GitLab CLI (glab)' }) }}
            </div>
            <div v-else-if="!issueProvider.authenticated" class="empty-msg" style="padding: 2px 0">
              {{ $t('label.issues-not-authenticated-prefix') }}
              <code>{{ issueProvider.provider === 'github' ? 'gh auth login' : 'glab auth login' }}</code>
              {{ $t('label.issues-not-authenticated-suffix') }}
            </div>

            <!-- detail view -->
            <template v-else-if="selectedIssue">
              <div class="input-row" style="margin-bottom: 6px">
                <button class="btn-ghost sm" @click="closeIssueDetail">← {{ $t('action.back') }}</button>
                <div class="spacer" />
                <button class="btn-ghost sm" :title="$t('hint.open-in-browser')" @click="openExternal(selectedIssue.url)">{{ $t('action.open') }} ↗</button>
                <button class="btn-ghost sm" :disabled="isIssueSubmitting" @click="toggleIssueState">
                  {{ selectedIssue.state === 'open' ? $t('action.close') : $t('action.reopen') }}
                </button>
              </div>
              <div class="issue-detail-title">
                <span class="issue-state-dot" :class="selectedIssue.state" />
                #{{ selectedIssue.number }} · {{ selectedIssue.title }}
              </div>
              <div class="b-track" style="margin-bottom: 6px">{{ selectedIssue.author }} · {{ selectedIssue.created_at }}</div>
              <pre class="issue-body">{{ selectedIssue.body || $t('label.no-description') }}</pre>
              <div v-for="(c, i) in selectedIssue.comments" :key="i" class="issue-comment">
                <div class="b-track">{{ c.author }} · {{ c.created_at }}</div>
                <pre class="issue-body">{{ c.body }}</pre>
              </div>
              <div class="input-row" style="margin-top: 6px; flex-direction: column; gap: 4px">
                <textarea v-model="newComment" class="git-input" rows="2" :placeholder="$t('label.add-comment-placeholder')" />
                <button class="btn-ghost sm" :disabled="!newComment.trim() || isIssueSubmitting" @click="submitComment">{{ $t('action.comment') }}</button>
              </div>
            </template>

            <!-- list view -->
            <template v-else>
              <div v-if="showNewIssue" class="input-row" style="margin-bottom: 6px; flex-direction: column; gap: 4px">
                <input v-model="newIssueTitle" class="git-input" :placeholder="$t('label.issue-title-placeholder')" />
                <textarea v-model="newIssueBody" class="git-input" rows="3" :placeholder="$t('label.description-optional')" />
                <div class="input-row">
                  <button class="btn-ghost sm" :disabled="!newIssueTitle.trim() || isIssueSubmitting" @click="submitNewIssue">{{ $t('action.create') }}</button>
                  <button class="btn-ghost sm" @click="showNewIssue = false">{{ $t('action.cancel') }}</button>
                </div>
              </div>
              <div v-if="isLoadingIssues" class="empty-msg" style="padding: 2px 0">{{ $t('label.loading') }}</div>
              <div v-else-if="!issues.length" class="empty-msg" style="padding: 2px 0">{{ $t('label.no-issues') }}</div>
              <div
                v-for="it in issues"
                :key="it.number"
                class="generic-row clickable"
                :class="{ loading: isLoadingDetail }"
                @click="openIssue(it.number)"
              >
                <span class="issue-state-dot" :class="it.state" />
                <div style="flex: 1; min-width: 0">
                  <div class="b-name" v-truncate>#{{ it.number }} {{ it.title }}</div>
                  <div class="b-track">
                    {{ it.author }}
                    <span v-for="l in it.labels" :key="l" class="issue-label">{{ l }}</span>
                  </div>
                </div>
              </div>
            </template>
            <p v-if="issuesError" class="err-text">{{ issuesError }}</p>
          </div>
        </div>
      </aside>

      <!-- ── Center ───────────────────────────────────────────────────── -->
      <section class="center">
        <!-- History -->
        <div v-if="view === 'history'" class="pane history-full">
          <GitHistoryModal
            show
            inline
            :workspace-path="workspacePath"
            :git-log="gitLog"
            :log-scope="logScope"
            :log-order="logOrder"
            :is-loading-log="isLoadingLog"
            :can-load-more-log="canLoadMoreLog"
            :set-log-scope="setLogScope"
            :set-log-order="setLogOrder"
            :load-more-log="loadMoreLog"
            :log-search="logSearch"
            :show-commit="showCommit"
            :commit-file-diff="commitFileDiff"
            :cherry-pick="cherryPick"
            :revert-commit="revertCommit"
            :checkout-commit="checkoutCommit"
            :create-branch="createBranch"
            :create-tag="createTag"
            :merge-into-current="mergeBranch"
            :reset-to-commit="resetToCommit"
          />
        </div>

        <!-- Branch comparison -->
        <div v-else-if="view === 'branchdiff'" class="pane branchdiff">
          <div class="bd-pickers">
            <select v-model="diffBase" class="ed-select" :title="$t('label.base-branch')">
              <option value="" disabled>{{ $t('label.base-placeholder') }}</option>
              <option v-for="b in gitBranches" :key="'b' + b.name" :value="b.name">{{ b.name }}</option>
            </select>
            <span class="bd-arrow">→</span>
            <select v-model="diffCompare" class="ed-select" :title="$t('label.compare-branch')">
              <option value="" disabled>{{ $t('label.compare-placeholder') }}</option>
              <option v-for="b in gitBranches" :key="'c' + b.name" :value="b.name">{{ b.name }}</option>
            </select>
          </div>
          <div class="bd-body">
            <BranchDiffPane
              v-if="diffBase && diffCompare"
              :key="diffBase + '…' + diffCompare"
              :workspace-path="workspacePath"
              :base="diffBase"
              :compare="diffCompare"
              :git-transport="gitTransport"
              :branch-diff="branchDiff"
            />
            <div v-else class="empty-hint">{{ $t('hint.pick-two-branches') }}</div>
          </div>
        </div>

        <!-- Changes: the checkbox-stage file card + commit composer -->
        <div v-else class="status-wrap">
          <div class="pane changes">
            <div v-if="opInProgress" class="op-banner">
              <span>{{ $t('label.op-in-progress', { op: opInProgress }) }}<template v-if="conflictFiles.length"> — {{ conflictFiles.length > 1 ? $t('label.conflicted-files-many', { count: conflictFiles.length }) : $t('label.conflicted-files-one', { count: conflictFiles.length }) }}</template></span>
              <button class="linkbtn danger" @click="onAbortOperation">{{ $t('action.abort-op', { op: opInProgress }) }}</button>
            </div>

            <div class="list-hdr">
              <div>
                <div class="gtitle">{{ changeCount === 1 ? $t('label.files-changed-one', { count: changeCount }) : $t('label.files-changed-many', { count: changeCount }) }}</div>
                <div class="gsub">{{ $t('hint.file-card') }}</div>
              </div>
              <div class="hdr-actions">
                <button v-if="stagedFiles.length" class="linkbtn" @click="onUnstageAll">{{ $t('action.unstage-all-files') }}</button>
                <button v-if="changedFiles.length + untrackedFiles.length" class="linkbtn" @click="onStageAll">{{ $t('action.stage-all-files') }}</button>
              </div>
            </div>

            <div v-if="!changeCount && !conflictFiles.length" class="clean-hint">
              {{ $t('label.working-tree-clean') }}
            </div>
            <div v-else class="fcard">
              <div
                v-for="f in conflictFiles"
                :key="'c' + f.path"
                class="frow conflict"
                draggable="true"
                @dragstart="onFileDragStart($event, f.path)"
                @click="showWorkingDiff(f.path, false, 'conflict')"
                @contextmenu.prevent="openFileCtxMenu($event, f)"
              >
                <span class="conflict-mark">⚠</span>
                <span class="stag u">{{ $t('label.tag-conflict') }}</span>
                <span class="fpath mono" v-truncate><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact">
                  <button class="linkbtn" @click.stop="onResolveOurs(f.path)">{{ $t('action.row-ours') }}</button>
                  <button class="linkbtn" @click.stop="onResolveTheirs(f.path)">{{ $t('action.row-theirs') }}</button>
                  <button class="linkbtn" @click.stop="openInEditor(f.path)">{{ $t('action.row-editor') }}</button>
                  <button class="linkbtn" @click.stop="onResolveWithAgent(f.path)">{{ $t('action.row-agent') }}</button>
                </span>
              </div>
              <div
                v-for="f in stagedFiles"
                :key="'s' + f.path"
                class="frow"
                draggable="true"
                @dragstart="onFileDragStart($event, f.path)"
                @click="showWorkingDiff(f.path, true)"
                @contextmenu.prevent="openFileCtxMenu($event, f, true)"
              >
                <button class="chk on" :title="$t('action.unstage')" @click.stop="toggleStage(f, true)" />
                <span class="stag" :class="fileTag(f).cls">{{ fileTag(f).label }}</span>
                <span class="fpath mono" v-truncate><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact"><button class="linkbtn" @click.stop="showWorkingDiff(f.path, true)">{{ $t('action.row-diff') }}</button></span>
              </div>
              <div
                v-for="f in changedFiles"
                :key="'u' + f.path"
                class="frow"
                draggable="true"
                @dragstart="onFileDragStart($event, f.path)"
                @click="showWorkingDiff(f.path, false)"
                @contextmenu.prevent="openFileCtxMenu($event, f)"
              >
                <button class="chk" :title="$t('action.stage')" @click.stop="toggleStage(f, false)" />
                <span class="stag" :class="fileTag(f).cls">{{ fileTag(f).label }}</span>
                <span class="fpath mono" v-truncate><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact">
                  <button class="linkbtn" @click.stop="showWorkingDiff(f.path, false)">{{ $t('action.row-diff') }}</button>
                  <button class="linkbtn danger" @click.stop="onDiscard(f)">{{ $t('action.row-discard') }}</button>
                </span>
              </div>
              <div
                v-for="f in untrackedFiles"
                :key="'n' + f.path"
                class="frow"
                draggable="true"
                @dragstart="onFileDragStart($event, f.path)"
                @click="showWorkingDiff(f.path, false)"
                @contextmenu.prevent="openFileCtxMenu($event, f, false, true)"
              >
                <button class="chk" :title="$t('action.stage')" @click.stop="toggleStage(f, false)" />
                <span class="stag q">{{ $t('label.tag-new') }}</span>
                <span class="fpath mono" v-truncate><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact"><button class="linkbtn" @click.stop="showWorkingDiff(f.path, false)">{{ $t('action.row-diff') }}</button></span>
              </div>
            </div>

            <div class="composer">
              <textarea
                v-model="commitMessage"
                class="cmp-input"
                rows="2"
                :placeholder="$t('label.describe-change-placeholder')"
                :disabled="isCommitting"
              />
              <div class="cmp-actions">
                <button class="chipbtn" :disabled="isGenerating || busy" @click="onGenerateMessage">
                  {{ isGenerating ? $t('label.generating') : $t('action.ai-message') }}
                </button>
                <button class="chipbtn" :disabled="isCommitting" @click="onAmend">{{ $t('action.amend') }}</button>
                <button class="commitbtn" :disabled="!canCommit" @click="onCommit">
                  {{
                    isCommitting
                      ? $t('label.committing')
                      : gitStatus.staged.length === 1
                        ? $t('action.commit-files-one', { count: gitStatus.staged.length })
                        : $t('action.commit-files-many', { count: gitStatus.staged.length })
                  }}
                </button>
              </div>
            </div>
          </div>

          <!-- Bottom: per-file diff detail -->
          <div v-if="externalDiff" class="detail">
            <div class="detail-hdr">
              <span class="dt-name mono" v-truncate>{{ externalDiff.name }}</span>
              <span class="dt-kind">
                {{
                  externalDiff.commit
                    ? $t('label.detail-commit', { hash: externalDiff.commit.slice(0, 8) })
                    : externalDiff.staged
                      ? $t('label.detail-staged')
                      : $t('label.detail-working-tree')
                }}
              </span>
              <div class="dt-modes">
                <button
                  v-for="m in detailModes"
                  :key="m"
                  :class="{ on: detailMode === m }"
                  @click="setDetailMode(m)"
                >{{ detailModeLabel(m) }}</button>
              </div>
              <label v-if="detailMode === 'blame'" class="check-label">
                <input v-model="blameChangedOnly" type="checkbox" @change="loadBlame" />
                {{ $t('label.only-changed-lines') }}
              </label>
              <span class="spacer" />
              <button class="linkbtn" @click="openInEditor(externalDiff.name)">{{ $t('action.open-in-editor') }}</button>
              <button class="linkbtn" @click="clearExternalDiff">{{ $t('action.close') }}</button>
            </div>
            <div class="detail-body">
              <DiffPane
                v-if="detailMode === 'diff'"
                :key="'ext:' + externalDiff.name + ':' + externalDiff.commit + ':' + externalDiff.staged"
                :workspace-path="workspacePath"
                :filepath="externalDiff.name"
                :staged="externalDiff.staged"
                :name="externalDiff.name"
                :git-transport="gitTransport"
                :file-access="fileAccess"
                :commit="externalDiff.commit || undefined"
                @open-file="(p) => openInEditor(p.filepath)"
              />

              <!-- Conflict: resolve the merge here instead of routing to the
                   mini-IDE (the row's "editor" button stays as the other path) -->
              <ConflictPane
                v-else-if="detailMode === 'conflict'"
                :key="'cf:' + externalDiff.name"
                :workspace-path="workspacePath"
                :filepath="externalDiff.name"
                :name="externalDiff.name"
                :git-transport="gitTransport"
                :file-access="fileAccess"
                :merge-aborted="!detailIsConflict"
                @resolved="onConflictResolved"
              />

              <!-- Blame: whole file, or only the changed lines (diff blame) -->
              <div v-else-if="detailMode === 'blame'" class="aux-body">
                <div v-if="blameLoading" class="empty-msg">{{ $t('label.loading') }}</div>
                <div v-else-if="blameMessage" class="empty-msg">{{ blameMessage }}</div>
                <template v-else-if="blameChangedOnly">
                  <template v-for="(h, hi) in blameHunks" :key="'h' + hi">
                    <div class="db-hunk-head">{{ h.header }}</div>
                    <div
                      v-for="(l, li) in h.lines"
                      :key="'h' + hi + ':' + li"
                      class="db-line"
                      :class="hunkLineClass(l.kind)"
                    >
                      <span class="bl-who" v-truncate>{{ l.committed ? l.author : $t('label.uncommitted') }}</span>
                      <span class="bl-date">{{ l.committed ? l.date : '' }}</span>
                      <span class="db-no">{{ l.new_no ?? l.old_no ?? '' }}</span>
                      <span class="db-sign">{{ l.kind === ' ' ? '' : l.kind }}</span>
                      <code class="db-code">{{ l.text }}</code>
                    </div>
                  </template>
                </template>
                <template v-else>
                  <div v-for="(b, bi) in blameEntries" :key="'b' + bi" class="blame-row">
                    <span class="chash">{{ b.short_hash }}</span>
                    <span class="bl-who" v-truncate>{{ b.author }}</span>
                    <span class="bl-date">{{ b.date }}</span>
                    <span class="db-no">{{ b.line_no }}</span>
                    <code class="db-code">{{ b.content }}</code>
                  </div>
                </template>
              </div>

              <!-- History: this file's commits + the selected commit's diff -->
              <div v-else class="aux-body">
                <div v-if="historyLoading" class="empty-msg">{{ $t('label.loading') }}</div>
                <div v-else-if="historyMessage" class="empty-msg">{{ historyMessage }}</div>
                <template v-else>
                  <div
                    v-for="c in fileHistory"
                    :key="c.hash"
                    class="hist-row"
                    :class="{ on: historyCommit === c.hash }"
                    @click="selectHistoryCommit(c.hash)"
                  >
                    <span class="chash">{{ c.short_hash }}</span>
                    <span class="hist-msg" v-truncate>{{ c.message }}</span>
                    <span class="bl-who" v-truncate>{{ c.author }}</span>
                    <span class="bl-date">{{ c.date }}</span>
                  </div>
                  <div v-if="historyDiffLoading" class="empty-msg">{{ $t('label.loading') }}</div>
                  <template v-else-if="historyCommit">
                    <div v-if="!historyHunks.length" class="empty-msg">
                      {{ $t('label.no-changes-in-commit') }}
                    </div>
                    <template v-for="(h, hi) in historyHunks" :key="'c' + hi">
                      <div class="db-hunk-head">{{ h.header }}</div>
                      <div
                        v-for="(l, li) in h.lines"
                        :key="'c' + hi + ':' + li"
                        class="db-line"
                        :class="hunkLineClass(l.kind)"
                      >
                        <span class="db-no">{{ l.new_no ?? l.old_no ?? '' }}</span>
                        <span class="db-sign">{{ l.kind === ' ' ? '' : l.kind }}</span>
                        <code class="db-code">{{ l.text }}</code>
                      </div>
                    </template>
                  </template>
                </template>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Right AI CLI dock (rail toggle + resize + embedded PTY terminal) -->
      <AiCliDock
        ref="aiDockRef"
        v-model:open="aiDockOpen"
        width-key="git-ai-panel-width"
        :pane-id="AI_PANE_ID"
        origin="git-window"
        :workspace-path="workspacePath"
        :terminal-port="terminalPort"
        :build-context="buildGitContext"
      />
    </div>

    <!-- ⋯ popover menu -->
    <template v-if="menu">
      <div class="menu-backdrop" @click="menu = null" />
      <div class="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <template v-for="(item, i) in menu.items" :key="i">
          <div v-if="item.separator" class="menu-sep" />
          <button
            class="menu-item"
            :class="{ danger: item.danger }"
            :disabled="item.disabled"
            @click="runMenuItem(item)"
          >{{ item.label }}</button>
        </template>
      </div>
    </template>

    <!-- Askpass credential prompt for a push/pull/fetch waiting on this window
         (git.credential_request forwarded by the host broker). -->
    <GitCredentialModal
      :show="showCredentialPrompt"
      :prompt="credentialPrompt"
      :workspace-path="workspacePath"
      :account-port="accountPort"
      @submit="submitCredential"
      @cancel="cancelCredential"
    />
    <NotificationHost />
  </div>
</template>

<style scoped>
/* Editorial Calm — generous spacing, hairline borders, soft cards. All colors
 * come from semantic tokens so every app theme translates the design; the
 * light theme reproduces the approved mockup. */
.git-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  color: var(--text-primary);
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow: hidden;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.spacer { flex: 1; }

/* ── Toolbar ── */
.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 54px;
  padding: 0 18px 0 84px; /* clear the hidden-titlebar traffic lights */
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  -webkit-app-region: drag;
  flex-shrink: 0;
}
/* No traffic lights to clear when the system draws the frame itself (every
   platform but macOS), so the reserved space on the left is just a gap. */
.toolbar.no-traffic-lights {
  padding-left: 18px;
}
.wm {
  font-weight: 800;
  font-size: 13.5px;
  letter-spacing: 0.02em;
  color: var(--text-bright);
  -webkit-app-region: no-drag;
}
.crumb {
  color: var(--text-secondary);
  font-size: 12.5px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.crumb b { color: var(--text-bright); font-weight: 650; }
.crumb-sep { margin: 0 4px; color: var(--text-muted); }
.crumb-cnt { margin-left: 6px; color: var(--accent-fg); font-size: var(--font-xs); }
.busy-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--attention-fg);
  animation: busy-pulse 1.2s ease-in-out infinite;
}
@keyframes busy-pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .busy-dot { animation: none; } }
.tb-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
  -webkit-app-region: no-drag;
}
.gbtn {
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 12.5px;
  padding: 7px 11px;
  border-radius: 8px;
  cursor: pointer;
}
.gbtn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.gbtn:disabled { opacity: 0.4; cursor: default; }
.gbtn.icon { padding: 7px 9px; }
.pbtn {
  border: none;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: 12.5px;
  font-weight: 700;
  padding: 8px 16px;
  border-radius: 10px;
  cursor: pointer;
}
.pbtn:hover:not(:disabled) { filter: brightness(1.08); }
.pbtn:disabled { opacity: 0.45; cursor: default; }

.err-bar {
  padding: 6px 18px;
  background: var(--danger-subtle);
  color: var(--danger-bright);
  font-size: var(--font-xs);
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

/* ── Non-repo bootstrap card (init / clone) ── */
.init-card {
  width: min(460px, 88%);
  padding: 22px 24px 20px;
  border: 1px solid var(--border-muted);
  border-radius: 12px;
  background: var(--bg-subtle);
}
.init-title { margin: 0 0 6px; font-size: var(--font-lg); font-weight: 800; color: var(--text-bright); }
.init-sub { margin: 0 0 16px; font-size: 12.5px; line-height: var(--lh-base); color: var(--text-muted); }
.init-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.init-clone {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-muted);
}
.init-clone .clone-go { align-self: flex-start; margin-top: 2px; }

/* ── Body ── */
.body { flex: 1; display: flex; min-height: 0; }

/* ── Sidebar ── */
.sidebar {
  width: 280px;
  flex-shrink: 0;
  background: var(--bg-subtle);
  border-right: 1px solid var(--border-muted);
  overflow-y: auto;
  padding: 14px 0 20px;
}
.navi { display: flex; flex-direction: column; gap: 2px; padding: 0 12px 12px; }
.navi button {
  display: flex;
  align-items: center;
  text-align: left;
  border: none;
  background: none;
  padding: 7px 12px;
  border-radius: 9px;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  cursor: pointer;
}
.navi button:hover { background: var(--bg-hover-faint); }
.navi .on { background: var(--bg-selected); color: var(--accent-bright); font-weight: 700; }
.navi .n { margin-left: auto; font-size: 11.5px; color: var(--text-muted); }
.divider { height: 1px; background: var(--border-muted); margin: 4px 12px 12px; }

/* ── GitPane-copied card vocabulary (keep in sync with GitPane.vue) ────────── */
.empty-msg { color: var(--text-muted); font-size: var(--font-2xs); font-style: italic; padding: 3px 8px 6px; }
.err-text { color: var(--danger-fg); font-size: var(--font-2xs); margin: 0; padding: 2px 4px; }
.chash { font-size: var(--font-3xs); color: var(--text-muted); font-family: monospace; background: transparent; }

.git-card {
  margin: 6px 10px;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
}
.card-hdr {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; min-height: 22px;
  background: var(--bg-subtle);
}
.card-hdr.clickable { cursor: pointer; user-select: none; }
.card-hdr.clickable:hover { background: var(--bg-elevated); }
.git-card:has(.card-body) .card-hdr { border-bottom: 1px solid var(--border-muted); }
.card-body { padding: 4px 2px 6px; }
.collapsible-body {
  padding: 4px 12px 8px;
  display: flex; flex-direction: column; gap: 2px;
}
.sec-caret { font-size: 9px; color: var(--text-muted); width: 10px; flex-shrink: 0; }
.sec-label {
  font-size: var(--font-2xs); font-weight: 600; color: var(--text-secondary);
  letter-spacing: 0.3px;
}
.sec-badge {
  font-size: var(--font-3xs); color: var(--text-secondary); background: var(--bg-active);
  border-radius: 10px; padding: 0 6px; flex-shrink: 0;
}

.branch-row {
  display: flex; align-items: center; gap: 4px;
  padding: 2px 0; font-size: var(--font-2xs); border-radius: 3px;
}
.branch-row:hover { background: var(--bg-hover-faint); }
.branch-row.current .b-name { color: var(--accent-bright); font-weight: 600; }
.b-check { width: 14px; color: var(--success-bright); font-size: var(--font-3xs); text-align: center; flex-shrink: 0; }
.b-name { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.b-name.remote { color: var(--text-muted); font-style: italic; }
.b-track { color: var(--text-muted); font-size: var(--font-3xs); flex-shrink: 0; }
.branch-section-label { font-size: var(--font-3xs); color: var(--text-muted); padding: 4px 0 2px; letter-spacing: 0.04em; text-transform: uppercase; }
.compare-panel {
  margin: 4px 0; background: var(--bg-inset, var(--bg-subtle)); border: 1px solid var(--border-muted);
  border-radius: 4px; padding: 6px 8px; font-size: var(--font-2xs);
}
.compare-title { color: var(--accent-bright); font-weight: 600; margin-bottom: 3px; }
.compare-stat  { color: var(--success-bright); margin-bottom: 2px; }
.compare-file  { color: var(--text-secondary); font-family: monospace; font-size: var(--font-3xs); }

.generic-row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 0; font-size: var(--font-2xs);
}
.generic-row:hover { background: var(--bg-hover-faint); }
.generic-row.clickable { cursor: pointer; }
.generic-row.loading { opacity: 0.6; }
.row-actions.always { display: flex; }
.row-btn {
  display: flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; background: transparent; border: none;
  border-radius: 3px; color: var(--text-secondary); font-size: var(--font-2xs); cursor: pointer; padding: 0 2px;
}
.row-btn:hover { color: var(--text-primary); background: var(--bg-active); }
.row-btn.danger:hover { color: var(--danger-fg); }
.row-btn.always { opacity: 1; }
.stash-ref { color: var(--text-muted); font-size: var(--font-3xs); flex-shrink: 0; }
.stash-msg { color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remote-name { color: var(--text-muted); font-size: var(--font-3xs); flex-shrink: 0; min-width: 44px; }
.remote-url  { color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-2xs); }
.wt-icon { color: var(--success-bright); font-size: var(--font-2xs); flex-shrink: 0; width: 14px; text-align: center; }
.wt-name-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.wt-name-row .b-name { flex: 0 1 auto; }
.wt-badge {
  font-size: 9px; color: var(--text-secondary); background: var(--bg-active);
  border-radius: 8px; padding: 0 5px; flex-shrink: 0; white-space: nowrap;
}
.wt-badge.warn { color: var(--danger-fg); }

.git-input {
  flex: 1; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 4px;
  color: var(--text-primary); font-size: var(--font-2xs); padding: 3px 7px;
}
.git-input:focus { outline: none; border-color: var(--accent-focus); }
.input-row { display: flex; gap: 4px; }
.btn-ghost {
  background: transparent; border: 1px solid var(--border-default); border-radius: 4px;
  color: var(--text-secondary); font-size: var(--font-xs); padding: 4px 8px; cursor: pointer;
}
.btn-ghost:hover { border-color: var(--border-strong); color: var(--text-primary); }
.btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-ghost.sm { font-size: var(--font-2xs); padding: 3px 7px; }
.btn-ghost.active { color: var(--accent-bright); }
.check-label { display: flex; align-items: center; gap: 4px; font-size: var(--font-2xs); color: var(--text-secondary); cursor: pointer; }
.check-label input { accent-color: var(--accent-focus); cursor: pointer; }

.config-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: var(--font-2xs); }
.config-key { color: var(--text-muted); min-width: 108px; flex-shrink: 0; font-family: monospace; font-size: var(--font-3xs); }
.config-val { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.config-val.clickable { cursor: pointer; border-radius: 3px; padding: 1px 4px; margin: -1px -4px; }
.config-val.clickable:hover { background: var(--bg-muted); color: var(--text-on-emphasis); }
.config-inline-input { flex: 1; min-width: 0; }

.issue-state-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); }
.issue-state-dot.open { background: var(--success-bright); }
.issue-state-dot.closed { background: var(--accent-purple, #a371f7); }
.issue-label {
  display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 8px;
  background: var(--bg-muted); color: var(--text-muted); font-size: 9px; line-height: 14px;
}
.issue-detail-title { font-size: var(--font-xs); color: var(--text-primary); display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.issue-body {
  white-space: pre-wrap; word-break: break-word; font-size: var(--font-2xs); color: var(--text-primary);
  background: var(--bg-muted); border-radius: 4px; padding: 6px; margin: 0 0 4px; font-family: inherit;
}
.issue-comment { border-top: 1px solid var(--border-muted); padding-top: 4px; margin-top: 4px; }

.linkbtn {
  border: none;
  background: none;
  color: var(--accent-fg);
  font-size: var(--font-xs);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 5px;
}
.linkbtn:hover { background: var(--bg-hover-faint); }
.linkbtn.danger { color: var(--danger-fg); }

/* ── Center ── */
.center { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.pane { flex: 1; overflow: auto; min-height: 0; }
.pane.history-full { overflow: hidden; }
.status-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.pane.changes { display: flex; flex-direction: column; padding: 20px 26px 18px; overflow-y: auto; }

.op-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--attention-fg) 12%, transparent);
  color: var(--attention-fg);
  font-size: 12.5px;
  margin-bottom: 14px;
}
.op-banner .linkbtn { margin-left: auto; }

.list-hdr { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 12px; }
.gtitle { font-size: 15px; font-weight: 800; color: var(--text-bright); }
.gsub { font-size: var(--font-xs); color: var(--text-muted); margin-top: 1px; }
.hdr-actions { margin-left: auto; display: flex; gap: 10px; }
.clean-hint, .empty-hint { color: var(--text-muted); font-size: var(--font-sm); padding: 26px 4px; }

.fcard {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 14px;
  overflow: hidden;
}
.frow {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 8.5px 16px;
  border-bottom: 1px solid var(--border-muted);
  font-size: var(--font-sm);
  cursor: pointer;
}
.frow:last-child { border-bottom: none; }
.frow:hover { background: var(--bg-hover-faint); }
.frow.conflict { background: color-mix(in srgb, var(--danger-fg) 7%, transparent); }
.conflict-mark { color: var(--danger-fg); flex: none; width: 15px; text-align: center; }
.chk {
  width: 15px;
  height: 15px;
  border-radius: 5px;
  border: 1.5px solid var(--border-strong);
  background: none;
  cursor: pointer;
  flex: none;
  padding: 0;
  position: relative;
}
.chk:hover { border-color: var(--accent-focus); }
.chk.on { background: var(--accent-emphasis); border-color: var(--accent-emphasis); }
.chk.on::after {
  content: '✓';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-emphasis);
  font-size: var(--font-3xs);
  font-weight: 800;
}
.stag {
  font-size: 10.5px;
  font-weight: 800;
  border-radius: 5px;
  padding: 1px 7px;
  flex: none;
}
.stag.m { background: color-mix(in srgb, var(--attention-fg) 14%, transparent); color: var(--attention-fg); }
.stag.a { background: color-mix(in srgb, var(--success-fg) 14%, transparent); color: var(--success-fg); }
.stag.q { background: color-mix(in srgb, var(--accent-fg) 13%, transparent); color: var(--accent-fg); }
.stag.d, .stag.u { background: color-mix(in srgb, var(--danger-fg) 13%, transparent); color: var(--danger-fg); }
.fpath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-size: 12.5px; }
.fpath i { color: var(--text-muted); font-style: normal; }
.rowact { display: flex; gap: 6px; flex: none; visibility: hidden; }
.frow:hover .rowact, .frow.conflict .rowact { visibility: visible; }

/* ── Commit composer ── */
.composer {
  margin-top: 16px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 16px;
  padding: 12px 14px;
  box-shadow: 0 6px 22px var(--shadow-scrim);
  flex-shrink: 0;
}
.cmp-input {
  width: 100%;
  border: none;
  background: none;
  resize: vertical;
  color: var(--text-primary);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  padding: 2px 2px 8px;
}
.cmp-input:focus { outline: none; }
.cmp-input:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: -2px; }
.cmp-input::placeholder { color: var(--text-muted); }
.cmp-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--border-muted);
  padding-top: 10px;
}
.chipbtn {
  border: none;
  background: var(--bg-muted);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  padding: 6px 12px;
  cursor: pointer;
}
.chipbtn:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover-strong); }
.chipbtn:disabled { opacity: 0.45; cursor: default; }
.commitbtn {
  margin-left: auto;
  border: none;
  background: var(--success-emphasis);
  color: var(--text-on-emphasis);
  border-radius: 10px;
  padding: 8px 18px;
  font-weight: 700;
  font-size: 12.5px;
  cursor: pointer;
}
.commitbtn:hover:not(:disabled) { background: var(--success-strong); }
.commitbtn:disabled { opacity: 0.45; cursor: default; }

/* ── ⋯ popover menu ── */
.menu-backdrop { position: fixed; inset: 0; z-index: calc(var(--z-modal) + 150); }
.menu {
  position: fixed;
  z-index: calc(var(--z-modal) + 151);
  min-width: 188px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  box-shadow: 0 8px 26px var(--shadow-scrim);
  padding: 4px;
  display: flex;
  flex-direction: column;
}
.menu-item {
  border: none;
  background: none;
  text-align: left;
  color: var(--text-primary);
  font-size: 12.5px;
  padding: 6.5px 11px;
  border-radius: 7px;
  cursor: pointer;
}
.menu-item:hover:not(:disabled) { background: var(--bg-hover); }
.menu-item.danger { color: var(--danger-fg); }
.menu-item:disabled { opacity: 0.5; cursor: default; font-style: italic; }
.menu-sep { height: 1px; background: var(--border-muted); margin: 4px 6px; }

/* ── Branch diff view ── */
.branchdiff { display: flex; flex-direction: column; overflow: hidden; }
.bd-pickers {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 26px;
}
.ed-select {
  background: var(--bg-subtle);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  font-size: 12.5px;
  padding: 5px 8px;
  max-width: 240px;
}
.bd-arrow { color: var(--text-muted); }
.bd-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.bd-body > * { flex: 1; min-height: 0; }

/* ── Diff detail ── */
.detail {
  height: 44%;
  min-height: 170px;
  border-top: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.detail-hdr {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.dt-name { font-size: 12.5px; font-weight: 650; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-kind { font-size: 11.5px; color: var(--text-muted); flex: none; }
.detail-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.detail-body > .diff-pane { flex: 1; min-height: 0; }
.detail-body > .cp-root { flex: 1; min-height: 0; }

/* Diff / Blame / History segmented switch in the detail header */
.dt-modes { display: flex; gap: 2px; flex: none; }
.dt-modes button {
  border: none;
  background: none;
  padding: 3px 9px;
  border-radius: 7px;
  color: var(--text-secondary);
  font-size: 11.5px;
  cursor: pointer;
}
.dt-modes button:hover { background: var(--bg-hover-faint); }
.dt-modes button.on { background: var(--bg-selected); color: var(--accent-bright); font-weight: 700; }

/* Blame / file-history readings (the non-DiffPane detail modes) */
.aux-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--font-2xs);
}
.blame-row, .db-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  line-height: 1.55;
  padding: 0 14px;
  width: max-content;
  min-width: 100%;
}
.blame-row:hover { background: var(--bg-hover-faint); }
.bl-who {
  color: var(--text-secondary);
  min-width: 86px;
  max-width: 86px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.bl-date { color: var(--text-muted); font-size: var(--font-3xs); min-width: 74px; flex-shrink: 0; }
.db-no { color: var(--text-muted); min-width: 36px; text-align: right; flex-shrink: 0; user-select: none; }
.db-sign { width: 10px; flex-shrink: 0; text-align: center; user-select: none; }
.db-code { white-space: pre; flex-shrink: 0; color: var(--text-primary); }
.db-hunk-head { color: var(--accent-bright); font-size: var(--font-3xs); opacity: 0.8; padding: 4px 14px 2px; white-space: pre; }
.db-line.db-add { background: var(--diff-add-bg); }
.db-line.db-add .db-code, .db-line.db-add .db-sign { color: var(--success-bright); }
.db-line.db-del { background: var(--diff-del-bg); }
.db-line.db-del .db-code, .db-line.db-del .db-sign { color: var(--danger-fg); }
.hist-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 4px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-muted);
}
.hist-row:hover { background: var(--bg-hover-faint); }
.hist-row.on { background: var(--bg-selected); }
.hist-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-family: inherit;
}

</style>
