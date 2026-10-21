<script lang="ts">
// Module scope is shared by every pane in this renderer document.
let nextMenuOwnerId = 0
</script>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useGit } from '../composables/useGit'
import type { DiscoveredRepo, IgnoreTarget, GitWorktree } from '../composables/useGit'
import { useIssues } from '../composables/useIssues'
import type { IssueDetail } from '../composables/useIssues'
import type { GitTransport } from '#git-feature'
import type {
  GitAccountPort,
  GitFileAccessPort,
  GitPaneUiPort,
  IssuePort,
} from '../ports/gitSurface'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import { computeGraph, laneColor } from '../lib/git-graph'
import { guardedDiscard } from '../lib/discardConfirm'
import { closeGitPaneMenusOnEscape } from '../lib/gitMenuEscape'
import { placeSubmenu } from '../lib/submenuPlacement'
import GitCredentialModal from './GitCredentialModal.vue'

const props = defineProps<{
  workspacePath: string
  analyzerModel?: string
  gitTransport: GitTransport
  fileAccess: GitFileAccessPort
  ui: GitPaneUiPort
  issuePort: IssuePort
  accounts: GitAccountPort
  // When embedded in the editor window, "open in editor" opens in-place via the
  // `open-file` event instead of spawning a separate editor window.
  embedded?: boolean
  // Running agent panes an issue can be dispatched to. Empty (e.g. editor
  // window) hides the "Dispatch to Agent" control.
  dispatchTargets?: { id: string; label: string }[]
  // When true, hides the "Found N repos in subfolders" list (used by MultiRepoGit
  // which already shows those repos as tabs).
  hideDiscoveredRepos?: boolean
  // Issue dispatch/handle status — shows badges on issue rows.
  issueHandoffs?: Record<string, { paneId: string; mode: string; state: string }>
}>()

const paneRoot = ref<HTMLElement | null>(null)
// Set while a receiver close preparation has frozen this pane. It gates every
// mutating request through the transport and is released on cancellation.
const closePrepared = ref(false)
const menuOwnerId = `git-pane-${++nextMenuOwnerId}`
const openMenuOwners = new Set<string>()
let activeMenuOwnerId: string | null = null

const emit = defineEmits<{
  (e: 'changes-count', n: number): void
  (e: 'open-workspace', picked: { path: string; grant: string }): void
  (e: 'open-file', payload: { filepath: string; name: string }): void
  (e: 'open-conflict', payload: { filepath: string; name: string }): void
  (e: 'open-diff', payload: { filepath: string; staged: boolean; name: string; commit?: string }): void
  (e: 'open-branch-diff', payload: { base: string; compare: string }): void
  (e: 'dispatch-issue', payload: { paneId: string; issue: IssueDetail }): void
  (e: 'focus-pane', paneId: string): void
  (e: 'open-git-accounts'): void
  (e: 'force-discovered', repos: DiscoveredRepo[]): void
}>()

function openBranchDiffTab(base = 'main'): void {
  void props.ui.openBranchDiffWindow(props.workspacePath, base)
}

const {
  gitStatus, statusError, logError, commitDetailError, statusLoaded, loadStatus, discoveredRepos, discoverySkipped, discoverRepositories, showIgnored, gitLog, gitBranches, gitStashes, gitRemotes, gitTags,
  gitWorktrees, gitConfig, gitConfigAllowedKeys, autoCommit, gitTopRatio, setAutoCommit, setGitTopRatio,
  isLoadingStatus, isCommitting, isGenerating, isInitializing,
  syncOutput, syncError, gitError, clearGitError,
  initRepo, stageFile, unstageFile, stageAll, stageFiles, unstageFiles, discardFiles,
  fetchRemote, pullOnly, pushOnly, pushUpstream, sync,
  createBranch, switchBranch, checkoutRemoteBranch, deleteBranch, mergeBranch, mergeInto, rebaseOn,
  compareBranches, restoreFileFromBranch, commitFileDiff,
  stashPush, stashPop, stashDrop,
  commit, amendCommit, undoLastCommit, generateMessage, checkStaged,
  fileLog, showFile, diffBlame, resolveConflictOurs, resolveConflictTheirs,
  addRemote, removeRemote,
  createTag, deleteTag, showCommit,
  addWorktree, removeWorktree, pruneWorktrees, lockWorktree, unlockWorktree, moveWorktree, repairWorktrees,
  setGitConfig,
  cloneRepo, connectToRemote, addToGitignore, checkIgnore, abortOperation, stashApply,
  pullRebase, pushForce,
  credentialPrompt, showCredentialPrompt, submitCredential, cancelCredential,
} = useGit(() => props.workspacePath, props.gitTransport, { isPrepared: () => closePrepared.value })

const {
  provider: issueProvider, issues, selectedIssue,
  isLoadingIssues, isLoadingDetail, isSubmitting: isIssueSubmitting,
  issuesError,
  ensureLoaded: ensureIssuesLoaded, refresh: refreshIssues,
  openIssue, closeDetail: closeIssueDetail,
  createIssue, addComment, setState: setIssueState,
} = useIssues(() => props.workspacePath, props.issuePort)

// ── git account binding (safeStorage-backed) ───────────────────────────────────
const gitAccounts = props.accounts
const boundAccountId = ref<string | null>(null)
const showAccountMenu = ref(false)
const accountMenuPos = ref({ top: 0, right: 0 })

const boundAccount = computed(() =>
  gitAccounts.accounts.value.find((a) => a.id === boundAccountId.value) ?? null
)

async function loadAccountBinding(): Promise<void> {
  if (!props.workspacePath) {
    boundAccountId.value = null
    return
  }
  await gitAccounts.refresh()
  boundAccountId.value = await gitAccounts.getBinding()
}

function openAccountMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  accountMenuPos.value = { top: rect.bottom + 4, right: window.innerWidth - rect.right }
  showAccountMenu.value = !showAccountMenu.value
  if (showAccountMenu.value) void loadAccountBinding()
}

async function selectAccount(accountId: string | null): Promise<void> {
  showAccountMenu.value = false
  if (!props.workspacePath) return
  const ok = accountId ? await gitAccounts.bind(accountId) : await gitAccounts.unbind()
  if (ok) boundAccountId.value = accountId
  else notifyToast(t('git.account-update-failed'), { type: 'error' })
}

// ── path helpers ──────────────────────────────────────────────────────────────
function fileName(path: string): string { return path.split('/').at(-1) ?? path }
function fileDir(path: string): string {
  const parts = path.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}

// ── view / sort ───────────────────────────────────────────────────────────────
const viewMode = ref<'list' | 'tree'>('tree')
const sortBy = ref<'name' | 'path' | 'status'>('path')
const showViewMenu = ref(false)
const viewMenuPos = ref({ top: 0, right: 0 })
const showCommitMenuPos = ref({ top: 0, right: 0 })
const showRemoteMenu = ref(false)
const remoteMenuPos = ref({ top: 0, right: 0 })
function openRemoteMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  remoteMenuPos.value = { top: rect.bottom + 4, right: window.innerWidth - rect.right }
  showRemoteMenu.value = !showRemoteMenu.value
}
const collapsedDirs = ref(new Set<string>())

function openViewMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  viewMenuPos.value = { top: rect.bottom + 4, right: window.innerWidth - rect.right }
  showViewMenu.value = !showViewMenu.value
  showCommitMenu.value = false
}

function openCommitMenu(e: MouseEvent): void {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  showCommitMenuPos.value = { top: rect.bottom + 4, right: window.innerWidth - rect.right }
  showCommitMenu.value = !showCommitMenu.value
  showViewMenu.value = false
}

function toggleDir(key: string): void {
  const next = new Set(collapsedDirs.value)
  if (next.has(key)) next.delete(key); else next.add(key)
  collapsedDirs.value = next
}

function collapseAllDirs(): void {
  const next = new Set<string>()
  const add = (files: GitFileEntry[], prefix: string): void => {
    for (const f of files) {
      const parts = f.path.split('/')
      let dir = ''
      for (let i = 0; i < parts.length - 1; i++) {
        dir = dir ? `${dir}/${parts[i]}` : parts[i]
        next.add(prefix + dir)
      }
    }
  }
  add(gitStatus.value?.staged ?? [], 's:')
  add([...(gitStatus.value?.unstaged ?? []), ...(gitStatus.value?.untracked ?? [])], 'u:')
  collapsedDirs.value = next
}

interface GitFileEntry { path: string; status: string }

function sortFiles(files: GitFileEntry[]): GitFileEntry[] {
  return [...files].sort((a, b) => {
    if (sortBy.value === 'name') return fileName(a.path).localeCompare(fileName(b.path))
    if (sortBy.value === 'status') return a.status.localeCompare(b.status) || a.path.localeCompare(b.path)
    return a.path.localeCompare(b.path)
  })
}

// Nested folder tree → flat render rows with depth, honouring collapsed dirs.
interface TreeNode { name: string; path: string; dirs: Map<string, TreeNode>; files: GitFileEntry[] }
interface TreeRow {
  kind: 'folder' | 'file'
  depth: number
  name: string
  key: string            // collapse key (folder) or file path (file)
  dir?: string           // full dir path (folder rows)
  fileCount?: number     // total files under folder
  file?: GitFileEntry    // file rows
}

function countNodeFiles(node: TreeNode): number {
  let n = node.files.length
  for (const d of node.dirs.values()) n += countNodeFiles(d)
  return n
}

function flattenTree(files: GitFileEntry[], prefix: string): TreeRow[] {
  const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of sortFiles(files)) {
    const parts = f.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      const full = node.path ? `${node.path}/${seg}` : seg
      if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, path: full, dirs: new Map(), files: [] })
      node = node.dirs.get(seg)!
    }
    node.files.push(f)
  }

  const rows: TreeRow[] = []
  function walk(node: TreeNode, depth: number): void {
    for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const key = prefix + dir.path
      rows.push({ kind: 'folder', depth, name: dir.name, key, dir: dir.path, fileCount: countNodeFiles(dir) })
      if (!collapsedDirs.value.has(key)) walk(dir, depth + 1)
    }
    for (const f of node.files) {
      rows.push({ kind: 'file', depth, name: fileName(f.path), key: f.path, file: f })
    }
  }
  walk(root, 0)
  return rows
}

// Depth-based indentation for tree rows (each level nests further in).
function treeIndent(depth: number): Record<string, string> {
  return { paddingLeft: `${10 + depth * 14}px` }
}

// ── file context menu (right-click) ─────────────────────────────────────────────
const ctxMenu = ref<{
  show: boolean; x: number; y: number
  kind: 'file' | 'folder' | 'branch' | 'commit'
  file: GitFileEntry | null
  dir: string
  branch: string
  hash: string
  staged: boolean
}>({ show: false, x: 0, y: 0, kind: 'file', file: null, dir: '', branch: '', hash: '', staged: false })

function openCtxMenu(e: MouseEvent, file: GitFileEntry, staged: boolean): void {
  e.preventDefault()
  // Clamp so the menu stays on-screen (menu is ~220×300).
  const x = Math.min(e.clientX, window.innerWidth - 224)
  const y = Math.min(e.clientY, window.innerHeight - 304)
  ctxMenu.value = { show: true, x, y, kind: 'file', file, dir: '', branch: '', hash: '', staged }
  showViewMenu.value = false
  showCommitMenu.value = false
}
function openFolderCtxMenu(e: MouseEvent, dir: string, staged: boolean): void {
  e.preventDefault()
  e.stopPropagation()
  const x = Math.min(e.clientX, window.innerWidth - 224)
  const y = Math.min(e.clientY, window.innerHeight - 304)
  ctxMenu.value = { show: true, x, y, kind: 'folder', file: null, dir, branch: '', hash: '', staged }
  showViewMenu.value = false
  showCommitMenu.value = false
}
function openBranchCtxMenu(e: MouseEvent, name: string): void {
  e.preventDefault()
  e.stopPropagation()
  // Branch menu has 4 items + separator (~130px), so clamp to its real height, not the file menu's.
  const x = Math.min(e.clientX, window.innerWidth - 224)
  const y = Math.min(e.clientY, window.innerHeight - 130)
  ctxMenu.value = { show: true, x, y, kind: 'branch', file: null, dir: '', branch: name, hash: '', staged: false }
  showViewMenu.value = false
  showCommitMenu.value = false
}
function ctxDeleteBranch(): void {
  if (ctxMenu.value.branch) void doDeleteBranch(ctxMenu.value.branch)
  closeCtxMenu()
}
function closeCtxMenu(): void { ctxMenu.value.show = false }

// All changed-file paths under a folder, scoped to the tree the menu opened on:
// staged tree → staged list; Changes tree → unstaged + untracked.
function filesUnderDir(dir: string, staged: boolean): string[] {
  const pool = staged
    ? gitStatus.value.staged
    : [...(gitStatus.value.unstaged ?? []), ...(gitStatus.value.untracked ?? [])]
  const prefix = dir + '/'
  return pool.filter((f) => f.path === dir || f.path.startsWith(prefix)).map((f) => f.path)
}
function ctxFolderStage(): void {
  void stageFiles(filesUnderDir(ctxMenu.value.dir, false))
  closeCtxMenu()
}
function ctxFolderUnstage(): void {
  void unstageFiles(filesUnderDir(ctxMenu.value.dir, true))
  closeCtxMenu()
}
function ctxFolderDiscard(): void {
  const paths = filesUnderDir(ctxMenu.value.dir, false)
  closeCtxMenu()
  void confirmDiscard(paths)
}
async function ctxFolderAddIgnore(target: IgnoreTarget = 'project'): Promise<void> {
  if (ctxMenu.value.dir) await addToGitignore(ctxMenu.value.dir + '/', target)
  closeCtxMenu()
}
async function ctxFolderReveal(): Promise<void> {
  if (ctxMenu.value.dir) await props.ui.revealPath(absPath(ctxMenu.value.dir))
  closeCtxMenu()
}
async function ctxFolderCopyPath(rel: boolean): Promise<void> {
  const d = ctxMenu.value.dir
  if (d) await navigator.clipboard.writeText(rel ? d : absPath(d))
  closeCtxMenu()
}

function absPath(p: string): string {
  return `${props.workspacePath.replace(/\/+$/, '')}/${p}`
}
async function ctxOpenFile(): Promise<void> {
  const f = ctxMenu.value.file
  if (f) await props.ui.openPath(absPath(f.path))
  closeCtxMenu()
}
async function ctxOpenFileAtHead(): Promise<void> {
  const f = ctxMenu.value.file
  closeCtxMenu()
  if (!f) return
  const r = await showFile(f.path)
  if (r.ok) await props.ui.openTempFile(`${fileName(f.path)} (HEAD)`, r.content)
  else { gitError.value = r.error || 'Failed to read HEAD version' }
}
async function ctxReveal(): Promise<void> {
  const f = ctxMenu.value.file
  if (f) await props.ui.revealPath(absPath(f.path))
  closeCtxMenu()
}
function ctxOpenChanges(): void {
  const f = ctxMenu.value.file
  if (f) toggleDiff(f.path, ctxMenu.value.staged)
  closeCtxMenu()
}
function ctxOpenInEditor(): void {
  const f = ctxMenu.value.file
  if (f) {
    const name = f.path.split('/').pop() || f.path
    if (props.embedded) {
      emit('open-file', { filepath: f.path, name })
    } else {
      void props.ui.openInEditor({ workspacePath: props.workspacePath, filepath: f.path })
    }
  }
  closeCtxMenu()
}
function ctxStageToggle(): void {
  const f = ctxMenu.value.file
  if (f) ctxMenu.value.staged ? unstageFile(f.path) : stageFile(f.path)
  closeCtxMenu()
}
function ctxDiscard(): void {
  const f = ctxMenu.value.file
  closeCtxMenu()
  if (f) void confirmDiscard([f.path])
}
async function ctxStashFile(): Promise<void> {
  const f = ctxMenu.value.file
  closeCtxMenu()
  if (!f) return
  const r = await stashPush('', [f.path])
  if (!r.ok) gitError.value = r.error || 'draft failed'
}
async function ctxRestoreFromBranch(branch: string): Promise<void> {
  const f = ctxMenu.value.file
  closeCtxMenu()
  if (!f) return
  const r = await restoreFileFromBranch(branch, f.path)
  if (!r.ok) gitError.value = r.error || 'restore failed'
}
async function ctxCopyPath(rel: boolean): Promise<void> {
  const f = ctxMenu.value.file
  if (f) await navigator.clipboard.writeText(rel ? f.path : absPath(f.path))
  closeCtxMenu()
}
async function ctxAddToGitignore(target: IgnoreTarget = 'project'): Promise<void> {
  const f = ctxMenu.value.file
  if (f) await addToGitignore(f.path, target)
  closeCtxMenu()
}

// "Why is this ignored?" — runs git check-ignore -v and shows the verdict.
const ignoreResult = ref<{ path: string; text: string } | null>(null)
async function ctxWhyIgnored(): Promise<void> {
  const f = ctxMenu.value.file
  const p = f ? f.path : (ctxMenu.value.dir || '')
  closeCtxMenu()
  if (!p) return
  const r = await checkIgnore(p)
  let text: string
  if (!r.ok) {
    text = r.error || 'check-ignore failed'
  } else if (r.ignored) {
    text = `Ignored by rule "${r.pattern}" at ${r.source}:${r.line}`
    if (r.tracked) text += '; but this file is already tracked by git, so the rule has no effect — use "Add to .gitignore" to untrack it.'
  } else {
    text = r.tracked ? 'No ignore rules matched (file is tracked).' : 'No ignore rules matched.'
  }
  ignoreResult.value = { path: p, text }
}
// "Why is this ignored?" only makes sense on a file that is actually ignored —
// a file showing up in Staged/Changes is by definition tracked, never ignored.
const ctxIsIgnored = computed(() => {
  const f = ctxMenu.value.file
  return !!f && (gitStatus.value?.ignored ?? []).some((ig) => ig.path === f.path)
})

// ── init ──────────────────────────────────────────────────────────────────────
const initError = ref('')
async function doInit(createGitignore: boolean): Promise<void> {
  initError.value = ''
  const r = await initRepo(createGitignore)
  if (!r.ok) initError.value = r.error || 'git init failed'
  else commitMessage.value = 'Initial commit'
}

// Pick any folder via the native picker and git init there, then open it.
async function doInitInFolder(): Promise<void> {
  initError.value = ''
  const picked = await props.ui.pickWorkspace(props.workspacePath || undefined)
  if (!picked) return
  const r = await initRepo(true, picked.path)
  if (!r.ok) { initError.value = r.error || 'git init failed'; return }
  emit('open-workspace', picked)
}

const forcingScan = ref(false)
async function doForceScan(): Promise<void> {
  if (forcingScan.value) return
  forcingScan.value = true
  try {
    await discoverRepositories(true)
    emit('force-discovered', [...discoveredRepos.value])
  } finally {
    forcingScan.value = false
  }
}

async function openPickedWorkspace(defaultPath: string): Promise<void> {
  const picked = await props.ui.pickWorkspace(defaultPath)
  if (picked) emit('open-workspace', picked)
}

// ── clone ───────────────────────────────────────────────────────────────────────
const cloneUrl = ref(''), cloneParent = ref(''), cloneParentGrant = ref(''), cloning = ref(false), cloneError = ref('')
function repoNameFromUrl(url: string): string {
  const seg = url.trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).at(-1)
  return seg || 'repo'
}
async function pickCloneDir(): Promise<void> {
  const picked = await props.ui.pickWorkspace(cloneParent.value || undefined)
  if (picked) {
    cloneParent.value = picked.path
    cloneParentGrant.value = picked.grant
  }
}
async function doClone(): Promise<void> {
  cloneError.value = ''
  if (!cloneUrl.value.trim()) { cloneError.value = 'Enter repository URL'; return }
  if (!cloneParent.value.trim() || !cloneParentGrant.value) { cloneError.value = 'Select a target folder'; return }
  const target = `${cloneParent.value.replace(/\/+$/, '')}/${repoNameFromUrl(cloneUrl.value)}`
  cloning.value = true
  try {
    const r = await cloneRepo(cloneUrl.value.trim(), target, cloneParentGrant.value)
    if (!r.ok) { cloneError.value = r.error || 'Clone failed'; return }
    if (r.path && r.openWorkspaceGrant) emit('open-workspace', { path: r.path, grant: r.openWorkspaceGrant })
  } finally {
    cloning.value = false
  }
}

// ── connect to remote ───────────────────────────────────────────────────────────
const connectUrl = ref(''), connecting = ref(false), connectError = ref('')
async function doConnect(): Promise<void> {
  connectError.value = ''
  if (!connectUrl.value.trim()) { connectError.value = 'Enter repository URL'; return }
  connecting.value = true
  try {
    const r = await connectToRemote(connectUrl.value.trim())
    if (!r.ok) connectError.value = r.error || 'Connect failed'
  } finally {
    connecting.value = false
  }
}

// ── abort in-progress operation ──────────────────────────────────────────────────
const opInProgress = computed(() => gitStatus.value?.operation_in_progress ?? '')
// Paths a truncated status still lists -- the backend stops at an entry or byte
// cap on huge trees (#144), so the count is what was read, not a constant.
const listedPathCount = computed(() => new Set(
  [...(gitStatus.value?.staged ?? []), ...(gitStatus.value?.unstaged ?? []), ...(gitStatus.value?.untracked ?? [])]
    .map((entry) => entry.path),
).size)
const conflictFileCount = computed(() => {
  const staged = gitStatus.value?.staged ?? []
  const unstaged = gitStatus.value?.unstaged ?? []
  return [...staged, ...unstaged].filter((f) => f.status === 'U').length
})
async function doAbort(): Promise<void> {
  const op = opInProgress.value
  if (!op) return
  const r = await abortOperation(op)
  if (!r.ok) notifyToast(r.error || t('git.abort-failed'), { type: 'error' })
}

// ── Auto-detect and pre-fill commit message once all conflicts are resolved ────
// Only stage check removed: accepting "ours" resolves conflicts without adding staged diff vs HEAD
const allConflictsResolved = computed(() =>
  opInProgress.value === 'merge' && conflictFileCount.value === 0,
)

watch(allConflictsResolved, async (val) => {
  if (!val || commitMessage.value) return
  // Read .git/MERGE_MSG to pre-populate commit message
  try {
    const resp = await props.fileAccess.readFile(props.workspacePath, '.git/MERGE_MSG')
    if (resp.ok && resp.content) {
      commitMessage.value = resp.content.trim()
    }
  } catch {
    // best-effort — leave commitMessage empty if read fails
  }
})

// ── commit graph (DAG lane layout) ───────────────────────────────────────────────
const GRAPH_LANE_W = 14 // px per lane column
const graphLayout = computed(() =>
  computeGraph(latestLog.value.map((c) => ({ hash: c.hash, parents: c.parents ?? [] }))),
)
const graphWidth = computed(() => Math.max(graphLayout.value.width * GRAPH_LANE_W, GRAPH_LANE_W))
function laneX(lane: number): number { return lane * GRAPH_LANE_W + GRAPH_LANE_W / 2 }

// ── changes ───────────────────────────────────────────────────────────────────
const hasStaged = computed(() => (gitStatus.value?.staged?.length ?? 0) > 0)
const hasChanges = computed(
  () => hasStaged.value || (gitStatus.value?.unstaged?.length ?? 0) > 0 || (gitStatus.value?.untracked?.length ?? 0) > 0
)
// Key format: 'staged:<path>' | 'changes:<path>'
const selectedKeys = ref(new Set<string>())
const lastClickKey = ref<string | null>(null)

watch(gitStatus, (s) => {
  emit('changes-count', (s.staged?.length ?? 0) + (s.unstaged?.length ?? 0) + (s.untracked?.length ?? 0))
  // Prune selections that no longer exist instead of wiping them all.
  // This preserves the user's selection across background status refreshes
  // (e.g. auto-commit staging) while removing keys for files that disappeared.
  const valid = new Set<string>()
  for (const f of s.staged ?? []) valid.add('staged:' + f.path)
  for (const f of [...(s.unstaged ?? []), ...(s.untracked ?? [])]) valid.add('changes:' + f.path)
  const pruned = new Set([...selectedKeys.value].filter((k) => valid.has(k)))
  if (pruned.size !== selectedKeys.value.size) selectedKeys.value = pruned
}, { immediate: true })

const STATUS_LABEL: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: '!', '?': 'U' }
function statusLabel(s: string): string { return STATUS_LABEL[s] ?? s }

// ── commit ────────────────────────────────────────────────────────────────────
const commitMessage = ref('')
const commitError = ref('')
const amendMode = ref(false)
const showCommitMenu = ref(false)
// During a merge where all conflicts are resolved, git commit works even with
// empty staged diff (e.g. "Accept Ours" keeps HEAD content, no diff to show).
const canCommit = computed(() =>
  (hasChanges.value || allConflictsResolved.value) &&
  commitMessage.value.trim().length > 0 &&
  !isCommitting.value,
)

const commitInputEl = ref<HTMLTextAreaElement | null>(null)
function autoGrowCommit(): void {
  const el = commitInputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}
function onCommitInput(): void {
  commitError.value = ''
  autoGrowCommit()
}
watch(commitMessage, () => nextTick(autoGrowCommit))

// Commit variants mirror VS Code / Cursor's commit dropdown:
// plain Commit, Commit (Amend), Commit & Push, Commit & Sync.
async function runCommit(opts: { amend?: boolean; then?: 'push' | 'sync' } = {}): Promise<void> {
  showCommitMenu.value = false
  commitError.value = ''
  const amend = opts.amend ?? amendMode.value
  // Nothing staged → stage everything (incl. untracked) and commit it all.
  const r = amend
    ? await amendCommit(commitMessage.value)
    : await commit(commitMessage.value, !hasStaged.value)
  if (!r.ok) { commitError.value = r.error || t('git.commit-failed'); return }
  commitMessage.value = ''; amendMode.value = false; genAttempt.value = 0
  if (opts.then === 'push') await doPush()
  else if (opts.then === 'sync') await doSync()
}
async function doCommit(): Promise<void> { await runCommit() }
async function doUndo(): Promise<void> {
  commitError.value = ''
  const r = await undoLastCommit()
  if (!r.ok) commitError.value = r.error || t('git.undo-failed')
}
// Each successive sparkle click raises the backend temperature (Copilot-style
// retry) to escape a repeated answer; reset to 0 once the form clears.
const genAttempt = ref(0)
async function doGenerate(): Promise<void> {
  if (autoCommitRunning.value) return  // yield to in-flight auto-commit
  commitError.value = ''
  clearGitError()
  const r = await generateMessage(props.analyzerModel || 'qwen2:latest', genAttempt.value)
  if (r.ok) { commitMessage.value = r.message; genAttempt.value++ }
  else commitError.value = r.error || t('git.generation-failed')
}

// ── auto-commit (background patrol) ──────────────────────────────────────────
// Replicates the manual flow: Stage All → AI Generate → Commit (local only).
// Never pushes to remote.
const autoCommitPending = ref(false)
// '' = idle, 'staging' | 'checking' | 'generating' | 'committing' = active step
const autoCommitStep = ref<'' | 'staging' | 'checking' | 'generating' | 'committing'>('')
// Whole-flow lock: prevents concurrent runs and blocks manual ✦ during auto-commit
const autoCommitRunning = ref(false)
const autoCommitCountdown = ref(0)
const AUTO_COMMIT_DELAY_MS = 60_000  // wait 60s of no new changes
let _autoCommitTimer: ReturnType<typeof setTimeout> | null = null
let _countdownInterval: ReturnType<typeof setInterval> | null = null

function _clearAutoTimer(): void {
  if (_autoCommitTimer) { clearTimeout(_autoCommitTimer); _autoCommitTimer = null }
  if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null }
  autoCommitPending.value = false
  autoCommitCountdown.value = 0
}

async function runAutoCommit(): Promise<void> {
  _autoCommitTimer = null
  autoCommitPending.value = false
  if (!autoCommit.value) return
  // Guard: skip during merge/rebase/conflicts, user-initiated ops, or already running
  if (opInProgress.value || conflictFileCount.value > 0) return
  if (!hasChanges.value || isCommitting.value || isGenerating.value) return
  if (autoCommitRunning.value) return

  autoCommitRunning.value = true
  try {
    // Step 1: Stage All — re-check before each async step in case user acted
    autoCommitStep.value = 'staging'
    await stageAll()
    if (!autoCommit.value || !hasStaged.value) return

    // Step 2: Lint check — abort if staged files have errors
    if (isGenerating.value || isCommitting.value) return
    autoCommitStep.value = 'checking'
    const lint = await checkStaged()
    if (!lint.ok) {
      notifyToast(t('git.auto-commit-lint-aborted', { count: lint.errorCount }), { type: 'error' })
      return
    }

    // Step 3: AI Generate — guard against user having started a manual generate
    if (isGenerating.value || isCommitting.value) return
    autoCommitStep.value = 'generating'
    const r = await generateMessage(props.analyzerModel || 'qwen2:latest', 0)
    if (!r.ok || !r.message) {
      notifyToast(t('git.auto-commit-generate-failed'), { type: 'error' })
      return
    }

    // Step 4: Commit staged files — guard against user having committed manually
    if (!autoCommit.value || isCommitting.value) return
    autoCommitStep.value = 'committing'
    const cr = await commit(r.message, false)
    if (cr.ok) notifyToast(t('git.auto-commit-done', { message: r.message }), { type: 'success' })
    else notifyToast(t('git.auto-commit-commit-failed', { error: cr.error || t('git.commit-failed') }), { type: 'error' })
  } finally {
    autoCommitRunning.value = false
    autoCommitStep.value = ''
  }
}

function scheduleAutoCommit(): void {
  _clearAutoTimer()
  if (!autoCommit.value || !hasChanges.value) return
  autoCommitPending.value = true
  const totalSecs = AUTO_COMMIT_DELAY_MS / 1000
  autoCommitCountdown.value = totalSecs
  _countdownInterval = setInterval(() => {
    if (autoCommitCountdown.value > 1) {
      autoCommitCountdown.value--
    } else {
      clearInterval(_countdownInterval!); _countdownInterval = null
    }
  }, 1_000)
  _autoCommitTimer = setTimeout(runAutoCommit, AUTO_COMMIT_DELAY_MS)
}

// Reset the timer whenever the change list shifts while auto-commit is active.
watch(
  () => [gitStatus.value.staged, gitStatus.value.unstaged, gitStatus.value.untracked],
  () => { if (autoCommit.value && !autoCommitRunning.value) scheduleAutoCommit() },
  { deep: true },
)

watch(autoCommit, (val) => {
  if (!val) {
    _clearAutoTimer()
    // Only clear step if not mid-run; running flow clears in finally
    if (!autoCommitRunning.value) autoCommitStep.value = ''
  } else if (hasChanges.value) {
    scheduleAutoCommit()
  }
})

onUnmounted(() => {
  _clearAutoTimer()
  document.removeEventListener('mousemove', onGitDividerMove)
  document.removeEventListener('mouseup', onGitDividerEnd)
  document.removeEventListener('keydown', closeMenusOnEscape)
  openMenuOwners.delete(menuOwnerId)
  if (activeMenuOwnerId === menuOwnerId) activeMenuOwnerId = [...openMenuOwners].at(-1) ?? null
})

// ── remote actions ────────────────────────────────────────────────────────────
const { toast: notifyToast, alert: notifyAlert, confirm: notifyConfirm } = useNotify()
const { t } = useI18n()

// A bound-account push/pull that fails on auth almost always means the stored
// token is stale/revoked — point the user at Settings › Accounts to update it,
// rather than leaving them staring at git's generic "Authentication failed".
function isAuthLikeError(msg: string): boolean {
  return /authentication|auth failed|403|401|access denied|could not read (username|password)|invalid credential|permission denied/i.test(msg)
}
const remoteOpLabel: Record<string, string> = {
  fetch: 'Fetch', pull: 'Pull', push: 'Push', sync: 'Sync', publish: 'Publish'
}
const remoteError = ref('')

// Tracks the in-flight remote operation so the clicked button shows a spinner
// and the rest stay disabled until it finishes.
const remoteBusy = ref<'' | 'fetch' | 'pull' | 'push' | 'sync' | 'publish'>('')
async function runRemote(op: Exclude<typeof remoteBusy.value, ''>, fn: () => Promise<void>): Promise<void> {
  if (remoteBusy.value) return
  remoteBusy.value = op
  try {
    await fn()
    // Surface the outcome through the modular notification system:
    // failures as a blocking alert (full git output), success as a toast.
    const label = remoteOpLabel[op] ?? op
    if (remoteError.value === 'CREDENTIAL_REQUIRED') {
      const openAccounts = await notifyConfirm(t('git.account.credential-required'), {
        title: `${label} failed`,
        confirmText: t('git.account.open-accounts'),
        cancelText: t('action.cancel'),
      })
      if (openAccounts) emit('open-git-accounts')
    } else if (remoteError.value) {
      const hint =
        boundAccount.value && isAuthLikeError(remoteError.value)
          ? `\n\n${t('git.account.credential-invalid')}`
          : ''
      void notifyAlert(remoteError.value + hint, { title: `${label} failed` })
    } else notifyToast(t(`git.remote-op-done.${op}`), { type: 'success' })
  } finally {
    remoteBusy.value = ''
  }
}
async function doFetch(): Promise<void> {
  await runRemote('fetch', async () => {
    remoteError.value = ''
    const r = await fetchRemote()
    remoteError.value = r.error
  })
}
async function doPull(): Promise<void> {
  await runRemote('pull', async () => {
    remoteError.value = ''
    const r = await pullOnly()
    remoteError.value = r.error
  })
}
// Derive the push remote from the tracked upstream ("origin/main" → "origin");
// fall back to "origin" when the branch has no upstream.
function trackedRemote(): string {
  const rb = gitStatus.value?.remote_branch || ''
  return rb.includes('/') ? rb.split('/')[0] : 'origin'
}
async function doPush(remote = ''): Promise<void> {
  const branch = remote ? (gitStatus.value?.branch ?? '') : ''
  await runRemote('push', async () => {
    remoteError.value = ''
    const r = await pushOnly(remote, branch)
    remoteError.value = r.error
  })
}
async function doPullRebase(): Promise<void> {
  showRemoteMenu.value = false
  await runRemote('pull', async () => {
    remoteError.value = ''
    const r = await pullRebase()
    remoteError.value = r.error ?? ''
  })
}
async function doPushForce(remote = ''): Promise<void> {
  showRemoteMenu.value = false
  const branch = remote ? (gitStatus.value?.branch ?? '') : ''
  await runRemote('push', async () => {
    remoteError.value = ''
    const r = await pushForce(remote, branch)
    remoteError.value = r.error ?? ''
  })
}
async function doSync(): Promise<void> {
  await runRemote('sync', async () => {
    remoteError.value = ''
    await sync()
    remoteError.value = syncError.value
  })
}
async function doPushUpstream(): Promise<void> {
  const branch = gitStatus.value?.branch; if (!branch) return
  await runRemote('publish', async () => {
    remoteError.value = ''
    const r = await pushUpstream(branch)
    remoteError.value = r.error || ''
  })
}

const aheadBehind = computed(() => {
  const a = gitStatus.value?.ahead ?? 0, b = gitStatus.value?.behind ?? 0
  if (!a && !b) return ''
  return [a ? `↑${a}` : '', b ? `↓${b}` : ''].filter(Boolean).join(' ')
})

// ── branches ──────────────────────────────────────────────────────────────────
const branchExpanded = ref(false)
const showRemoteBranches = ref(false)
const newBranchName = ref('')
const branchError = ref('')
const branchCreating = ref(false)
const branchBusy = ref(false)

async function doCreateBranch(): Promise<void> {
  if (!newBranchName.value.trim()) return
  branchError.value = ''; branchCreating.value = true
  try {
    const r = await createBranch(newBranchName.value.trim())
    if (r.ok) newBranchName.value = ''; else branchError.value = r.error || 'failed'
  } finally {
    branchCreating.value = false
  }
}
async function doSwitch(name: string): Promise<void> {
  if (branchBusy.value) return
  branchBusy.value = true
  branchError.value = ''
  try {
    const r = await switchBranch(name); if (!r.ok) branchError.value = r.error || 'switch failed'
  } finally {
    branchBusy.value = false
  }
}
async function doCheckoutRemote(remoteRef: string): Promise<void> {
  branchError.value = ''
  const r = await checkoutRemoteBranch(remoteRef)
  if (!r.ok) branchError.value = r.error || 'checkout failed'
}
async function doDeleteBranch(name: string): Promise<void> {
  branchError.value = ''
  const r = await deleteBranch(name, false); if (!r.ok) branchError.value = r.error || 'delete failed'
}

const comparingBranch = ref('')
const compareResult = ref<{ stat: string; files: string[] } | null>(null)
async function doCompareBranch(branch: string): Promise<void> {
  if (comparingBranch.value === branch) { comparingBranch.value = ''; compareResult.value = null; return }
  comparingBranch.value = branch; compareResult.value = null
  const current = gitStatus.value?.branch; if (!current) return
  const r = await compareBranches(branch, current)
  if (r.ok) compareResult.value = { stat: r.stat, files: r.files }
  else { comparingBranch.value = ''; notifyToast(r.error || t('label.compare-failed'), { type: 'error' }) }
}

const rebaseError = ref(''), rebaseOutput = ref('')
async function doRebase(branch: string): Promise<void> {
  if (branchBusy.value) return
  branchBusy.value = true
  rebaseError.value = ''; rebaseOutput.value = ''
  try {
    const r = await rebaseOn(branch)
    if (r.ok) rebaseOutput.value = r.output || ''
    else if ((r.conflict_files?.length ?? 0) > 0) {
      mergeConflictFiles.value = r.conflict_files as string[]
      mergeConflictContext.value = `Rebase onto ${branch}`
      showMergeConflictModal.value = true
    } else rebaseError.value = r.error || 'rebase failed'
  } finally {
    branchBusy.value = false
  }
}

const mergeError = ref(''), mergeOutput = ref('')
const showMergeConflictModal = ref(false)
const mergeConflictFiles = ref<string[]>([])
const mergeConflictContext = ref('')  // describes which branch was merged into which

function _handleMergeResult(r: { ok: boolean; output?: string; error?: string; conflict_files?: string[] }): void {
  if (r.ok) {
    mergeOutput.value = r.output || ''
    return
  }
  mergeOutput.value = ''
  const files = r.conflict_files ?? []
  if (files.length > 0) {
    mergeConflictFiles.value = files
    showMergeConflictModal.value = true
  } else {
    mergeError.value = r.error || 'merge failed'
  }
}

async function doMerge(branch: string): Promise<void> {
  if (branchBusy.value) return
  branchBusy.value = true
  mergeError.value = ''; mergeOutput.value = ''
  try {
    const r = await mergeBranch(branch)
    _handleMergeResult(r)
  } finally {
    branchBusy.value = false
  }
}

async function doMergeInto(target: string): Promise<void> {
  mergeError.value = ''; mergeOutput.value = ''
  ctxMenu.value.show = false
  try {
    const r = await mergeInto(target)
    if (!r.ok && (r.conflict_files ?? []).length > 0) {
      mergeConflictContext.value = `Switched to ${target}, conflict occurred while merging ${(r as any).source_branch || ''}`
    }
    _handleMergeResult(r)
  } catch (err) {
    mergeError.value = err instanceof Error ? err.message : 'merge failed'
  }
}

async function doMergeIntoAndPush(target: string): Promise<void> {
  mergeError.value = ''; mergeOutput.value = ''
  ctxMenu.value.show = false
  let mergeResult: { ok: boolean; conflict_files?: string[]; source_branch?: string; error?: string }
  try {
    mergeResult = await mergeInto(target)
  } catch (err) {
    mergeError.value = err instanceof Error ? err.message : 'merge failed'
    return
  }
  if (!mergeResult.ok) {
    if ((mergeResult.conflict_files ?? []).length > 0) {
      mergeConflictContext.value = `Switched to ${target}, conflict occurred while merging ${mergeResult.source_branch || ''}`
    }
    _handleMergeResult(mergeResult)
    return
  }
  await runRemote('push', async () => {
    remoteError.value = ''
    const r = await pushOnly('', target)
    remoteError.value = r.error
  })
}

async function doConflictAbort(): Promise<void> {
  const r = await abortOperation('merge')
  if (!r.ok) notifyToast(r.error || t('git.abort-failed'), { type: 'error' })
  showMergeConflictModal.value = false
  mergeConflictFiles.value = []
  mergeConflictContext.value = ''
}

function doConflictKeep(): void {
  showMergeConflictModal.value = false
  mergeConflictFiles.value = []
  mergeConflictContext.value = ''
}

// ── Section header context menus ─────────────────────────────────────────────
const stagedSectionMenu = ref<{ show: boolean; x: number; y: number }>({ show: false, x: 0, y: 0 })
function openStagedSectionMenu(e: MouseEvent): void {
  e.preventDefault()
  stagedSectionMenu.value = { show: true, x: e.clientX, y: e.clientY }
}
function closeStagedSectionMenu(): void { stagedSectionMenu.value.show = false }

const changesSectionMenu = ref<{ show: boolean; x: number; y: number }>({ show: false, x: 0, y: 0 })
function openChangesSectionMenu(e: MouseEvent): void {
  e.preventDefault()
  changesSectionMenu.value = { show: true, x: e.clientX, y: e.clientY }
}
function closeChangesSectionMenu(): void { changesSectionMenu.value.show = false }

watch(
  () => [
    ctxMenu.value.show,
    stagedSectionMenu.value.show,
    changesSectionMenu.value.show,
    showCommitMenu.value,
    showRemoteMenu.value,
    showViewMenu.value,
  ],
  (states) => {
    if (states.some(Boolean)) {
      openMenuOwners.delete(menuOwnerId)
      openMenuOwners.add(menuOwnerId)
      activeMenuOwnerId = menuOwnerId
      return
    }
    if (!openMenuOwners.delete(menuOwnerId)) return
    if (activeMenuOwnerId === menuOwnerId) activeMenuOwnerId = [...openMenuOwners].at(-1) ?? null
  },
)

function closeMenusOnEscape(event: KeyboardEvent): void {
  const open =
    ctxMenu.value.show ||
    stagedSectionMenu.value.show ||
    changesSectionMenu.value.show ||
    showCommitMenu.value ||
    showRemoteMenu.value ||
    showViewMenu.value
  closeGitPaneMenusOnEscape(event, {
    root: paneRoot.value,
    menuOwnerId,
    activeMenuOwnerId,
    isMenuOpen: open,
    close: () => {
      ctxMenu.value.show = false
      stagedSectionMenu.value.show = false
      changesSectionMenu.value.show = false
      showCommitMenu.value = false
      showRemoteMenu.value = false
      showViewMenu.value = false
    },
  })
}

onMounted(() => document.addEventListener('keydown', closeMenusOnEscape))

// ── stash ─────────────────────────────────────────────────────────────────────
const stashExpanded = ref(false), stashMessage = ref(''), stashError = ref('')
const showStashPrompt = ref(false)
const stashBusy = ref(false)
// Auto-expand the Stashes section when stashes appear (e.g. after a stash push)
watch(() => gitStashes.value.length, (n, prev) => {
  if (n > 0 && (prev ?? 0) === 0) stashExpanded.value = true
}, { immediate: true })
function openStashPrompt(): void {
  stashError.value = ''; stashMessage.value = ''; showStashPrompt.value = true
}
async function doStash(): Promise<void> {
  stashError.value = ''
  const r = await stashPush(stashMessage.value)
  if (r.ok) { stashMessage.value = ''; showStashPrompt.value = false }
  else stashError.value = r.error || 'stash failed'
}
async function doStashApply(i: number): Promise<void> {
  if (stashBusy.value) return
  stashBusy.value = true
  stashError.value = ''
  try {
    const r = await stashApply(i); if (!r.ok) stashError.value = r.error || 'apply failed'
  } finally {
    stashBusy.value = false
  }
}
async function doStashPop(i: number): Promise<void> {
  if (stashBusy.value) return
  stashBusy.value = true
  stashError.value = ''
  try {
    const r = await stashPop(i); if (!r.ok) stashError.value = r.error || 'pop failed'
  } finally {
    stashBusy.value = false
  }
}
async function doStashDrop(i: number): Promise<void> {
  if (stashBusy.value) return
  stashBusy.value = true
  stashError.value = ''
  try {
    const r = await stashDrop(i); if (!r.ok) stashError.value = r.error || 'drop failed'
  } finally {
    stashBusy.value = false
  }
}

// ── remotes ───────────────────────────────────────────────────────────────────
const remoteExpanded = ref(false), newRemoteName = ref(''), newRemoteUrl = ref(''), remotesMgrError = ref('')
async function doAddRemote(): Promise<void> {
  remotesMgrError.value = ''
  const r = await addRemote(newRemoteName.value.trim(), newRemoteUrl.value.trim())
  if (r.ok) { newRemoteName.value = ''; newRemoteUrl.value = '' } else remotesMgrError.value = r.error || 'failed'
}
function doOpenRemote(url: string): void {
  if (url) void props.ui.openExternal(url)
}
async function doRemoveRemote(name: string): Promise<void> {
  remotesMgrError.value = ''
  const r = await removeRemote(name); if (!r.ok) remotesMgrError.value = r.error || 'failed'
}

// ── tags ──────────────────────────────────────────────────────────────────────
const tagExpanded = ref(false), newTagName = ref(''), newTagMessage = ref(''), tagError = ref('')
const tagBusy = ref(false)
async function doCreateTag(): Promise<void> {
  tagError.value = ''
  const r = await createTag(newTagName.value.trim(), newTagMessage.value.trim())
  if (r.ok) { newTagName.value = ''; newTagMessage.value = '' } else tagError.value = r.error || 'failed'
}
async function doDeleteTag(name: string): Promise<void> {
  if (tagBusy.value) return
  tagBusy.value = true
  tagError.value = ''
  try {
    const r = await deleteTag(name); if (!r.ok) tagError.value = r.error || 'failed'
  } finally {
    tagBusy.value = false
  }
}

// ── worktrees ─────────────────────────────────────────────────────────────────
const worktreeExpanded = ref(false), newWtPath = ref(''), newWtBranch = ref(''), newWtIsNew = ref(false), worktreeError = ref('')
const worktreeBranchOptions = computed(() => gitBranches.value.filter((b) => !b.is_remote).map((b) => b.name))
watch(newWtIsNew, () => { newWtBranch.value = '' })
// per-row in-flight guard: holds the busy worktree path, or '*' for card-level ops
const worktreeBusy = ref('')
async function doAddWorktree(): Promise<void> {
  worktreeError.value = ''
  const r = await addWorktree(newWtPath.value.trim(), newWtBranch.value.trim(), newWtIsNew.value)
  if (r.ok) { newWtPath.value = ''; newWtBranch.value = '' } else worktreeError.value = r.error || t('label.worktree-add-failed')
}
async function doRemoveWorktree(wt: GitWorktree): Promise<void> {
  worktreeError.value = ''
  const ok = await notifyConfirm(
    t('label.confirm-remove-worktree', { name: wt.path.split('/').at(-1) || wt.path }),
    { title: t('label.remove-worktree-title'), confirmText: t('action.remove') }
  )
  if (!ok) return
  worktreeBusy.value = wt.path
  try {
    const r = await removeWorktree(wt.path, false)
    if (r.ok) return
    // A dirty/locked worktree fails a plain remove — surface the error and offer --force.
    const forced = await notifyConfirm(
      t('label.force-remove-worktree', { error: r.error || t('label.worktree-remove-failed') }),
      { title: t('label.remove-worktree-title'), confirmText: t('action.force-remove') }
    )
    if (!forced) { worktreeError.value = r.error || t('label.worktree-remove-failed'); return }
    const fr = await removeWorktree(wt.path, true)
    if (!fr.ok) worktreeError.value = fr.error || t('label.worktree-remove-failed')
  } finally {
    worktreeBusy.value = ''
  }
}
async function doOpenWorktree(wt: GitWorktree): Promise<void> {
  await props.ui.openMainWindow(wt.path)
}
async function doRevealWorktree(wt: GitWorktree): Promise<void> {
  try { await props.ui.revealPath(wt.path) } catch (err) {
    notifyToast(err instanceof Error ? err.message : t('label.worktree-reveal-failed'), { type: 'error' })
  }
}
async function doToggleWorktreeLock(wt: GitWorktree): Promise<void> {
  worktreeError.value = ''
  worktreeBusy.value = wt.path
  try {
    const r = wt.locked ? await unlockWorktree(wt.path) : await lockWorktree(wt.path)
    if (!r.ok) worktreeError.value = r.error || t(wt.locked ? 'label.worktree-unlock-failed' : 'label.worktree-lock-failed')
  } finally {
    worktreeBusy.value = ''
  }
}
async function doMoveWorktree(wt: GitWorktree): Promise<void> {
  const dest = await props.ui.pickWorkspace(wt.path)
  if (!dest) return
  worktreeError.value = ''
  worktreeBusy.value = wt.path
  try {
    const r = await moveWorktree(wt.path, dest.path)
    if (!r.ok) worktreeError.value = r.error || t('label.worktree-move-failed')
  } finally {
    worktreeBusy.value = ''
  }
}
async function doPruneWorktrees(): Promise<void> {
  worktreeError.value = ''
  worktreeBusy.value = '*'
  try {
    const r = await pruneWorktrees()
    if (r.ok) notifyToast(r.output?.trim() || t('label.worktree-pruned'), { type: 'success' })
    else notifyToast(r.error || t('label.worktree-prune-failed'), { type: 'error' })
  } finally {
    worktreeBusy.value = ''
  }
}
async function doRepairWorktrees(): Promise<void> {
  worktreeError.value = ''
  worktreeBusy.value = '*'
  try {
    const r = await repairWorktrees()
    if (r.ok) notifyToast(r.output?.trim() || t('label.worktree-repaired'), { type: 'success' })
    else notifyToast(r.error || t('label.worktree-repair-failed'), { type: 'error' })
  } finally {
    worktreeBusy.value = ''
  }
}
async function pickWorktreeDir(): Promise<void> {
  const picked = await props.ui.pickWorkspace(newWtPath.value || undefined)
  if (picked) newWtPath.value = picked.path
}

// ── config ────────────────────────────────────────────────────────────────────
const configExpanded = ref(false), configError = ref('')
const configDisplayKeys = computed(() =>
  gitConfigAllowedKeys.value.length ? gitConfigAllowedKeys.value
    : ['user.name', 'user.email', 'core.autocrlf', 'core.filemode', 'pull.rebase']
)
const CONFIG_OPTIONS: Record<string, string[]> = {
  'core.autocrlf': ['true', 'false', 'input'],
  'core.filemode': ['true', 'false'],
  'pull.rebase': ['true', 'false'],
}
const inlineEditKey = ref(''), inlineEditValue = ref('')
function startInlineEdit(key: string): void {
  configError.value = ''
  inlineEditKey.value = key
  inlineEditValue.value = gitConfig.value[key] || ''
}
function cancelInlineEdit(): void { inlineEditKey.value = ''; inlineEditValue.value = '' }
async function saveInlineEdit(): Promise<void> {
  configError.value = ''
  const key = inlineEditKey.value
  if (!key) return
  const r = await setGitConfig(key, inlineEditValue.value)
  if (!r.ok) configError.value = r.error || 'failed'
  else cancelInlineEdit()
}

// ── cloud issues (GitHub via gh / GitLab via glab) ────────────────────────────
const issuesExpanded = ref(false)
const showNewIssue = ref(false)
const newIssueTitle = ref(''), newIssueBody = ref('')
const newComment = ref('')
const openIssueCount = computed(() => issues.value.filter(i => i.state === 'open').length)

// Lazy: only spawn the CLI the first time the card is opened.
function toggleIssuesCard(): void {
  issuesExpanded.value = !issuesExpanded.value
  if (issuesExpanded.value) void ensureIssuesLoaded()
}

// Switching workspace while the card is open resets the composable's state but
// keeps it lazy — no expand event re-fires, so without this the panel would sit
// on a stale `unknown` (misleading "no supported issue host" message). Reload.
watch(() => props.workspacePath, () => {
  if (issuesExpanded.value) void refreshIssues()
})
async function submitNewIssue(): Promise<void> {
  const r = await createIssue(newIssueTitle.value, newIssueBody.value)
  if (r.ok) { newIssueTitle.value = ''; newIssueBody.value = ''; showNewIssue.value = false }
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

// ── dispatch issue to a running agent pane ────────────────────────────────────
const dispatchTargets = computed(() => props.dispatchTargets ?? [])
const showDispatchMenu = ref(false)
function dispatchTo(paneId: string): void {
  const issue = selectedIssue.value
  if (!issue) return
  emit('dispatch-issue', { paneId, issue })
  showDispatchMenu.value = false
}
function onDispatchClick(): void {
  const targets = dispatchTargets.value
  if (targets.length === 1) dispatchTo(targets[0].id)
  else if (targets.length > 1) showDispatchMenu.value = !showDispatchMenu.value
}

// ── diff blame (used by toggleHistoryPanel) ───────────────────────────────────
const diffBlamePath = ref(''), diffBlameStaged = ref(false)
const diffBlameHunks = ref<import('../composables/useGit').DiffBlameHunk[]>([]), diffBlameLoading = ref(false)

// ── diff ──────────────────────────────────────────────────────────────────────
// Open the file's diff in the standalone Git window's own diff panel (NOT the
// mini-IDE — that is reserved for "open file in editor"). Kept the `toggleDiff`
// name so every call site stays unchanged. The Git window reads the git_diff_*
// target from its entry query / incremental openTarget; the backend broadcasts
// git.changed afterwards so this pane refreshes itself.
function toggleDiff(path: string, staged: boolean): void {
  void props.ui.openGitWindow({ workspacePath: props.workspacePath, filepath: path, staged })
}

function isConflictFile(path: string): boolean {
  const allFiles = [
    ...(gitStatus.value?.staged ?? []),
    ...(gitStatus.value?.unstaged ?? []),
  ]
  return allFiles.some((f) => f.path === path && f.status === 'U')
}

// Plain click = open diff; modifier click (Shift/Meta) = multi-select for batch ops.
function handleFileRowClick(e: MouseEvent, path: string, staged: boolean): void {
  const key = `${staged ? 'staged' : 'changes'}:${path}`
  if (e.shiftKey) {
    rangeSelect(key)
    return
  }
  if (e.metaKey || e.ctrlKey) {
    const next = new Set(selectedKeys.value)
    if (next.has(key)) next.delete(key); else next.add(key)
    selectedKeys.value = next
    lastClickKey.value = key
    return
  }
  // Plain click — open diff immediately
  selectedKeys.value = new Set([key])
  lastClickKey.value = key
  if (isConflictFile(path)) {
    if (props.embedded) emit('open-conflict', { filepath: path, name: fileName(path) })
    else onFileOpen(path, staged)
    return
  }
  if (props.embedded) {
    emit('open-diff', { filepath: path, staged, name: fileName(path) })
  } else {
    toggleDiff(path, staged)
  }
}
function rangeSelect(toKey: string): void {
  const ordered = orderedKeys.value
  const from = lastClickKey.value ? ordered.indexOf(lastClickKey.value) : -1
  const to = ordered.indexOf(toKey)
  if (from === -1 || to === -1) { selectedKeys.value = new Set([toKey]); return }
  const [a, b] = from <= to ? [from, to] : [to, from]
  selectedKeys.value = new Set(ordered.slice(a, b + 1))
}
function clearSelection(): void {
  selectedKeys.value = new Set()
  lastClickKey.value = null
}
function onFileOpen(path: string, staged: boolean): void {
  if (props.embedded && isConflictFile(path)) {
    emit('open-conflict', { filepath: path, name: fileName(path) })
    return
  }
  toggleDiff(path, staged)
}
async function stageSelected(): Promise<void> {
  const paths = selectedChangesPaths.value; if (!paths.length) return
  await stageFiles(paths); clearSelection()
}
async function unstageSelected(): Promise<void> {
  const paths = selectedStagedPaths.value; if (!paths.length) return
  await unstageFiles(paths); clearSelection()
}
function discardSelected(): void {
  void confirmDiscard(selectedChangesPaths.value)
}

// ── file history + diff blame (combined ⊡ panel) ─────────────────────────────
const fileHistoryPath = ref(''), fileHistoryCommits = ref<import('../composables/useGit').GitCommit[]>([]), fileHistoryLoading = ref(false)
async function toggleHistoryPanel(path: string, staged: boolean): Promise<void> {
  const isOpen = fileHistoryPath.value === path
  fileHistoryPath.value = ''; fileHistoryCommits.value = []
  diffBlamePath.value = ''; diffBlameHunks.value = []
  if (isOpen) return
  fileHistoryPath.value = path; fileHistoryLoading.value = true
  try {
    fileHistoryCommits.value = await fileLog(path)
    if (fileHistoryPath.value !== path) return // user toggled the panel closed while waiting
    fileHistoryLoading.value = false
    diffBlamePath.value = path; diffBlameStaged.value = staged; diffBlameLoading.value = true
    diffBlameHunks.value = await diffBlame(path, staged)
    if (diffBlamePath.value !== path) return
    diffBlameLoading.value = false
  } finally {
    fileHistoryLoading.value = false
    diffBlameLoading.value = false
  }
}

// ── conflict ──────────────────────────────────────────────────────────────────
const conflictError = ref('')
async function doResolveOurs(path: string): Promise<void> {
  conflictError.value = ''
  const r = await resolveConflictOurs(path); if (!r.ok) conflictError.value = r.error || 'failed'
}
async function doResolveTheirs(path: string): Promise<void> {
  conflictError.value = ''
  const r = await resolveConflictTheirs(path); if (!r.ok) conflictError.value = r.error || 'failed'
}


// ── group actions: discard all (Changes) / unstage all (Staged) ─────────────────
// Errors surface through the shared gitError channel (set inside useGit's
// runWrite), so these handlers stay thin.
// Discarding is destructive and irreversible, so EVERY path — single file,
// selection, folder, and "Discard All" — routes through one modal confirm.
async function confirmDiscard(paths: string[]): Promise<void> {
  const ran = await guardedDiscard(paths, notifyConfirm, discardFiles)
  if (ran) clearSelection()
}
function openDiscardAll(): void {
  void confirmDiscard([
    ...(gitStatus.value.unstaged ?? []).map((f) => f.path),
    ...(gitStatus.value.untracked ?? []).map((f) => f.path),
  ])
}
async function doUnstageAll(): Promise<void> {
  await unstageFiles(gitStatus.value.staged.map((f) => f.path))
}

// ── commit detail ─────────────────────────────────────────────────────────────
const expandedCommitHash = ref(''), commitDetailData = ref<import('../composables/useGit').GitCommitDetail | null>(null), commitDetailLoading = ref(false)
// Per-file inline diff within the expanded commit detail ("Open Changes").
const commitDiffFile = ref(''), commitDiffHunks = ref<import('../composables/useGit').DiffBlameHunk[]>([]), commitDiffLoading = ref(false)
function resetCommitDiff(): void { commitDiffFile.value = ''; commitDiffHunks.value = [] }
async function toggleCommitDetail(hash: string): Promise<void> {
  resetCommitDiff()
  if (expandedCommitHash.value === hash) { expandedCommitHash.value = ''; commitDetailData.value = null; return }
  expandedCommitHash.value = hash; commitDetailLoading.value = true
  try {
    commitDetailData.value = await showCommit(hash)
  } finally {
    commitDetailLoading.value = false
  }
}
async function toggleCommitFileDiff(hash: string, file: string): Promise<void> {
  if (commitDiffFile.value === file) { resetCommitDiff(); return }
  commitDiffFile.value = file; commitDiffHunks.value = []; commitDiffLoading.value = true
  try {
    const hunks = await commitFileDiff(hash, file)
    if (commitDiffFile.value === file) commitDiffHunks.value = hunks
  } finally {
    commitDiffLoading.value = false
  }
}
// Open a commit's file diff, mirroring how the stage/changes rows open diffs:
// embedded (inside mini-IDE) → diff tab; standalone → the standalone Git
// window's own diff panel (not the mini-IDE).
function openCommitFileDiffInIDE(hash: string, file: string): void {
  if (props.embedded) {
    emit('open-diff', { filepath: file, staged: false, name: fileName(file), commit: hash })
  } else {
    void props.ui.openGitWindow({ workspacePath: props.workspacePath, filepath: file, staged: false, commit: hash })
  }
}

// ── history ───────────────────────────────────────────────────────────────────
// The main panel shows only the latest page (read-only expand). Search, scope
// toggle, pagination and commit actions live in the Git plugin window's History
// view, which `window:openGitHistory` routes to — one window per workspace.
const historyExpanded = ref(true)
const latestLog = computed(() => gitLog.value.slice(0, 15))

function openHistoryWindow(): void {
  void props.ui.openGitHistoryWindow(props.workspacePath)
}

// Pop the standalone Git client (navide.git plugin) into its own window —
// parallel to this in-panel Git surface, not a replacement. Main window only.
function openStandaloneGitWindow(): void {
  void props.ui.openGitWindow({ workspacePath: props.workspacePath })
}

// ── section expand states ─────────────────────────────────────────────────────
const stagedExpanded = ref(true)
const changesExpanded = ref(true)
const ignoredExpanded = ref(false)

// ── multi-select ───────────────────────────────────────────────────────────────
const orderedKeys = computed((): string[] => {
  const keys: string[] = []
  const status = gitStatus.value
  if (stagedExpanded.value) {
    const files = status?.staged ?? []
    if (viewMode.value === 'tree') {
      flattenTree(files, 's:').filter((r) => r.kind === 'file').forEach((r) => keys.push(`staged:${r.file!.path}`))
    } else {
      sortFiles(files).forEach((f) => keys.push(`staged:${f.path}`))
    }
  }
  if (changesExpanded.value) {
    const files = [...(status?.unstaged ?? []), ...(status?.untracked ?? [])]
    if (viewMode.value === 'tree') {
      flattenTree(files, 'u:').filter((r) => r.kind === 'file').forEach((r) => keys.push(`changes:${r.file!.path}`))
    } else {
      sortFiles(files).forEach((f) => keys.push(`changes:${f.path}`))
    }
  }
  return keys
})

const selectedStagedPaths = computed(() =>
  [...selectedKeys.value].filter((k) => k.startsWith('staged:')).map((k) => k.slice(7)),
)
const selectedChangesPaths = computed(() =>
  [...selectedKeys.value].filter((k) => k.startsWith('changes:')).map((k) => k.slice(8)),
)

// ── draggable split between top (changes) and bottom (history/cards) ────────────
const partTopEl = ref<HTMLElement | null>(null)

let _gitDragStartY = 0, _gitDragStartTopPx = 0, _gitDragContainerPx = 0
function onGitDividerStart(e: MouseEvent): void {
  const top = partTopEl.value
  if (!top) return
  _gitDragStartY = e.clientY
  _gitDragStartTopPx = top.getBoundingClientRect().height
  _gitDragContainerPx = top.parentElement?.getBoundingClientRect().height || 0
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'row-resize'
  document.addEventListener('mousemove', onGitDividerMove)
  document.addEventListener('mouseup', onGitDividerEnd)
  e.preventDefault()
}
function onGitDividerMove(e: MouseEvent): void {
  if (!_gitDragContainerPx) return
  const ratio = (_gitDragStartTopPx + e.clientY - _gitDragStartY) / _gitDragContainerPx
  setGitTopRatio(Math.max(0.15, Math.min(0.85, ratio)))
}
function onGitDividerEnd(): void {
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  document.removeEventListener('mousemove', onGitDividerMove)
  document.removeEventListener('mouseup', onGitDividerEnd)
}

watch(() => props.workspacePath, () => {
  commitMessage.value = ''; commitError.value = ''; genAttempt.value = 0
  remoteError.value = ''
  branchError.value = ''; stashError.value = ''
  clearGitError()
  boundAccountId.value = null
  void loadAccountBinding()
}, { immediate: true })

function shortBranch(r: string): string { return r.replace(/^refs\/(heads|remotes)\//, '') }
// A commit is HEAD when its ref names include "HEAD" (e.g. "HEAD -> branch", or
// bare "HEAD" when detached). In all-branches mode the topmost row isn't always
// HEAD, so we detect the ref rather than assuming index 0.
function isHeadCommit(c: import('../composables/useGit').GitCommit): boolean {
  return (c.branches ?? []).some(b => b === 'HEAD' || b.startsWith('HEAD '))
}

// ── Close preparation ─────────────────────────────────────────────
// A close transaction must not discard work: in-flight operations are busy,
// and user drafts (commit/amend text, clone/connect/branch/stash/remote/tag/
// worktree/config/issue forms) need an explicit receiver decision.
type GitPaneCloseState = 'accepted' | 'busy' | 'draft'

const closeBusy = computed(() =>
  isInitializing.value || isCommitting.value || isGenerating.value ||
  cloning.value || connecting.value ||
  forcingScan.value || autoCommitPending.value || autoCommitRunning.value ||
  remoteBusy.value !== '' || branchBusy.value || branchCreating.value ||
  stashBusy.value || tagBusy.value || worktreeBusy.value !== '' ||
  isIssueSubmitting.value || credentialPrompt.value !== null
)

const closeDraft = computed(() =>
  commitMessage.value !== '' || amendMode.value ||
  cloneUrl.value !== '' || connectUrl.value !== '' ||
  newBranchName.value !== '' || stashMessage.value !== '' || showStashPrompt.value ||
  newRemoteName.value !== '' || newRemoteUrl.value !== '' ||
  newTagName.value !== '' || newTagMessage.value !== '' ||
  newWtPath.value !== '' || newWtBranch.value !== '' ||
  inlineEditKey.value !== '' ||
  newIssueTitle.value !== '' || newIssueBody.value !== '' || newComment.value !== '' || showNewIssue.value
)

function getCloseState(): { state: GitPaneCloseState } {
  if (closeBusy.value) return { state: 'busy' }
  if (closeDraft.value) return { state: 'draft' }
  return { state: 'accepted' }
}

function setClosePrepared(prepared: boolean): void {
  closePrepared.value = prepared
}

defineExpose({ getCloseState, setClosePrepared })
</script>

<template>
  <div ref="paneRoot" class="git-pane" :data-git-pane-owner="menuOwnerId" @click="showViewMenu = false; showCommitMenu = false; clearSelection()">

    <div v-if="!workspacePath" class="empty-state">{{ $t('label.select-workspace') }}</div>

    <div v-else-if="statusError" class="status-error-panel">
      <div class="init-title">{{ statusError }}</div>
      <button class="btn-primary w-full status-retry" :disabled="isLoadingStatus" @click="loadStatus">
        {{ $t('action.retry') }}
      </button>
    </div>

    <div v-else-if="!statusLoaded" class="empty-state">{{ $t('label.loading') }}</div>

    <!-- ── Init panel ─────────────────────────────────────── -->
    <div v-else-if="!gitStatus.is_git_repo" class="init-panel">
      <svg class="init-svg" width="32" height="32" viewBox="0 0 16 16" fill="var(--success-fg)">
        <path d="M15.698 7.287 8.712.302a1.03 1.03 0 0 0-1.457 0l-1.45 1.45 1.84 1.84a1.223 1.223 0 0 1 1.55 1.56l1.773 1.774a1.224 1.224 0 0 1 1.267 2.025 1.226 1.226 0 0 1-2.002-1.334L8.58 5.965v4.233a1.226 1.226 0 0 1 .321 2.432 1.226 1.226 0 0 1-1.11-1.384 1.224 1.224 0 0 1 .787-1.03V5.926a1.224 1.224 0 0 1-.666-1.608L6.076 2.486 .302 8.26a1.03 1.03 0 0 0 0 1.456l6.986 6.986a1.03 1.03 0 0 0 1.456 0l6.953-6.953a1.031 1.031 0 0 0 0-1.462z"/>
      </svg>
      <div class="init-title">{{ $t('status.not-git-repo') }}</div>
      <div class="init-desc">{{ $t('error.not-git-repo-desc') }}</div>
      <button class="btn-primary w-full" :disabled="isInitializing" @click="doInit(true)">
        {{ isInitializing ? $t('label.initializing') : $t('error.initialize-repository') }}
      </button>
      <button class="btn-ghost w-full" style="font-size:11px" :disabled="isInitializing" @click="doInit(false)">
        {{ $t('label.init-no-gitignore') }}
      </button>
      <button class="btn-ghost w-full" style="font-size:11px" :disabled="isInitializing" @click="doInitInFolder">
        {{ $t('label.init-in-folder') }}
      </button>
      <p v-if="initError" class="err-text">{{ initError }}</p>

      <!-- Connect existing directory to a remote -->
      <div class="clone-box">
        <div class="clone-title">{{ $t('label.connect-remote-title') }}</div>
        <div class="clone-hint">{{ $t('label.connect-remote-hint') }}</div>
        <input
          v-model="connectUrl"
          class="clone-input"
          :placeholder="$t('label.repo-url-placeholder')"
          :disabled="connecting"
        />
        <button class="btn-ghost w-full" :disabled="connecting" @click="doConnect">
          {{ connecting ? $t('label.connecting') : $t('action.connect-to-remote') }}
        </button>
        <p v-if="connectError" class="err-text">{{ connectError }}</p>
      </div>

      <div v-if="discoverySkipped && !props.hideDiscoveredRepos" class="discovered-box">
        <div class="clone-title">{{ $t('label.discovery-skipped-title') }}</div>
        <div class="clone-hint">{{ $t('label.discovery-skipped-hint') }}</div>
        <button class="btn-ghost w-full nv-btn nv-btn--ghost" style="font-size:11px" :disabled="forcingScan" @click="doForceScan">
          {{ forcingScan ? $t('label.scanning-repos') : $t('action.scan-repos-anyway') }}
        </button>
      </div>

      <!-- Nested repos found by scanning downward (git rev-parse only looks up) -->
      <div v-if="discoveredRepos.length && !props.hideDiscoveredRepos" class="discovered-box">
        <div class="clone-title">{{ $t('label.nested-repos-title', { n: discoveredRepos.length }) }}</div>
        <div class="clone-hint">{{ $t('label.nested-repos-hint') }}</div>
        <button
          v-for="repo in discoveredRepos"
          :key="repo.abs_path"
          class="repo-row"
          @click="openPickedWorkspace(repo.abs_path)"
        >
          <svg class="repo-icon" width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5z"/></svg>
          <span class="repo-path" v-truncate>{{ repo.rel_path }}</span>
          <span v-if="repo.branch" class="repo-branch">{{ repo.branch }}</span>
        </button>
      </div>
    </div>

    <template v-else>

      <!-- ══════════════════════════════════════════════════════
           PART 1 — COMMIT
           ══════════════════════════════════════════════════════ -->

      <!-- Panel header -->
      <div class="panel-header">
        <span class="panel-title">{{ $t('pane.git.title') }}</span>
        <div class="spacer" />
        <!-- View mode toggle -->
        <button
          class="hdr-btn"
          :title="viewMode === 'tree' ? $t('action.switch-to-list-view') : $t('action.switch-to-tree-view')"
          @click.stop="viewMode = viewMode === 'tree' ? 'list' : 'tree'; showViewMenu = false"
        >
          <svg v-if="viewMode === 'tree'" width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM1.5 8a.75.75 0 1 1 1.5 0A.75.75 0 0 1 1.5 8zm.75 4.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM4.25 3.5h9.5a.75.75 0 0 0 0-1.5h-9.5a.75.75 0 0 0 0 1.5zM4 8.75h9.75a.75.75 0 0 0 0-1.5H4a.75.75 0 0 0 0 1.5zm0 5.5h9.75a.75.75 0 0 0 0-1.5H4a.75.75 0 0 0 0 1.5z"/></svg>
          <svg v-else width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 4h12v1.5H2zm0 3.5h12V9H2zm0 3.5h12v1.5H2z"/></svg>
        </button>
        <button
          v-if="viewMode === 'tree'"
          class="hdr-btn"
          :title="$t('action.collapse-all-folders')"
          @click.stop="collapseAllDirs"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="1.5" width="10" height="10" rx="1"/><rect x="1.5" y="4.5" width="10" height="10" rx="1" fill="var(--bg-surface)"/><path d="M4 9.5h5"/></svg>
        </button>
        <button class="hdr-btn" :title="$t('action.refresh')" @click.stop="loadStatus">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 7.5A6 6 0 0 1 13 5.185V2.75a.75.75 0 0 1 1.5 0V7a.75.75 0 0 1-.75.75H9.25a.75.75 0 0 1 0-1.5h2.565A4.5 4.5 0 1 0 12 10a.75.75 0 1 1 1.261.815A6 6 0 1 1 1.5 7.5z"/></svg>
        </button>
        <!-- Open standalone Git client window (main window only; parallel to this panel) -->
        <button
          v-if="!embedded && workspacePath"
          class="hdr-btn"
          :title="$t('action.open-in-new-window')"
          @click.stop="openStandaloneGitWindow"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5"/><path d="M5.5 1.5v13M1.5 5.5h4"/></svg>
        </button>
        <!-- Diff Review button (mini-IDE only) — opens combined diff+review in editor tab -->
        <button
          v-if="embedded"
          class="hdr-btn"
          :title="$t('action.diff-review')"
          @click.stop="openBranchDiffTab('main')"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM7 5v3.5l3 1.5-.5 1L6 9V5z"/>
          </svg>
        </button>
        <!-- Sort menu -->
        <button class="hdr-btn" :title="$t('action.more-options')" @click.stop="openViewMenu($event)">···</button>
        <Teleport to="body">
          <div v-if="showViewMenu" class="tp-backdrop" :data-git-pane-menu-owner="menuOwnerId" @click="showViewMenu = false" />
          <div v-if="showViewMenu" class="tp-dropdown" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: viewMenuPos.top + 'px', right: viewMenuPos.right + 'px' }" @click.stop>
            <div class="menu-group-label">{{ $t('label.view') }}</div>
            <button class="menu-item" @click="viewMode = 'list'; showViewMenu = false">
              <span class="menu-check">{{ viewMode === 'list' ? '✓' : '' }}</span> {{ $t('action.view-as-list') }}
            </button>
            <button class="menu-item" @click="viewMode = 'tree'; showViewMenu = false">
              <span class="menu-check">{{ viewMode === 'tree' ? '✓' : '' }}</span> {{ $t('action.view-as-tree') }}
            </button>
            <div class="menu-sep" />
            <div class="menu-group-label">{{ $t('label.sort-by') }}</div>
            <button class="menu-item" @click="sortBy = 'name'; showViewMenu = false">
              <span class="menu-check">{{ sortBy === 'name' ? '✓' : '' }}</span> {{ $t('label.name') }}
            </button>
            <button class="menu-item" @click="sortBy = 'path'; showViewMenu = false">
              <span class="menu-check">{{ sortBy === 'path' ? '✓' : '' }}</span> {{ $t('label.path') }}
            </button>
            <button class="menu-item" @click="sortBy = 'status'; showViewMenu = false">
              <span class="menu-check">{{ sortBy === 'status' ? '✓' : '' }}</span> {{ $t('label.status') }}
            </button>
            <div class="menu-sep" />
            <button class="menu-item" @click="showIgnored = !showIgnored; showViewMenu = false">
              <span class="menu-check">{{ showIgnored ? '✓' : '' }}</span> {{ $t('action.show-ignored-files') }}
            </button>
          </div>
        </Teleport>
      </div>

      <!-- In-progress operation banner (merge / rebase / cherry-pick) -->
      <!-- All-conflicts-resolved banner -->
      <div v-if="allConflictsResolved" class="op-banner op-banner-ready">
        <span class="op-text">✓ {{ $t('label.conflicts-resolved') }}</span>
        <button class="op-commit-btn" @click="$el.closest('.git-pane')?.querySelector('textarea')?.focus()">{{ $t('action.go-to-commit') }}</button>
      </div>
      <!-- In-progress operation banner (merge / rebase / cherry-pick) -->
      <div v-else-if="opInProgress" class="op-banner" :class="{ 'op-banner-conflict': (opInProgress === 'merge' || opInProgress === 'rebase') && conflictFileCount > 0 }">
        <span class="op-text">
          ⚠ {{ $t('label.op-in-progress', { op: opInProgress }) }}
          <template v-if="(opInProgress === 'merge' || opInProgress === 'rebase') && conflictFileCount > 0">・{{ $t('label.conflict-files', { count: conflictFileCount }) }}</template>
        </span>
        <button class="op-abort-btn" @click="doAbort">{{ $t('action.abort-op', { op: opInProgress }) }}</button>
      </div>
      <div v-if="gitStatus.truncated" class="op-banner status-truncated-banner">
        <span class="status-truncated-text">{{ $t('git.status-truncated', { count: listedPathCount }) }}</span>
      </div>

      <!-- ── PART 1 scroll region ──────────────────────────────── -->
      <div ref="partTopEl" class="git-scroll part-top" :style="{ flexBasis: gitTopRatio * 100 + '%' }">

      <!-- Commit message input -->
      <div class="commit-area">
        <div class="commit-input-row">
          <textarea
            ref="commitInputEl"
            v-model="commitMessage"
            class="commit-input"
            :placeholder="amendMode ? $t('label.amend-message-placeholder') : $t('label.commit-message-placeholder')"
            rows="1"
            @input="onCommitInput"
            @keydown.meta.enter.prevent="canCommit && doCommit()"
            @keydown.ctrl.enter.prevent="canCommit && doCommit()"
            @click.stop
          />
          <button class="ai-btn" :class="{ generating: isGenerating, 'auto-active': autoCommit }" :disabled="isGenerating || !hasChanges" :title="autoCommit ? $t('action.auto-commit-enabled') : $t('action.ai-commit-message')" @click.stop="doGenerate">
            <span v-if="isGenerating" class="spinner">⟳</span><span v-else>✦</span>
          </button>
        </div>
        <p v-if="commitError" class="err-text commit-error-row" style="padding: 0 2px">
          {{ commitError }}
          <button class="git-error-x" :title="$t('action.dismiss')" @click.stop="commitError = ''">✕</button>
        </p>

        <!-- Commit button with dropdown -->
        <div class="commit-btn-row">
          <button class="commit-main-btn" :disabled="!canCommit" @click.stop="doCommit">
            <span v-if="isCommitting">{{ $t('label.committing') }}</span>
            <span v-else>✓ {{ amendMode ? $t('action.amend-commit') : $t('action.commit') }}</span>
          </button>
          <button class="commit-arrow-btn" :disabled="!hasStaged && !gitLog.length" :title="$t('action.commit-more-options')" @click.stop="openCommitMenu($event)">▾</button>
          <Teleport to="body">
            <div v-if="showCommitMenu" class="tp-backdrop" :data-git-pane-menu-owner="menuOwnerId" @click="showCommitMenu = false" />
            <div v-if="showCommitMenu" class="tp-dropdown" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: showCommitMenuPos.top + 'px', right: showCommitMenuPos.right + 'px' }" @click.stop>
              <button class="menu-item" :disabled="!canCommit" @click="runCommit()">✓ {{ $t('action.commit') }}</button>
              <button class="menu-item" :disabled="!gitLog.length" @click="runCommit({ amend: true })">✎ {{ $t('action.amend-commit') }}</button>
              <div class="menu-sep" />
              <button class="menu-item" :disabled="!canCommit" @click="runCommit({ then: 'push' })">↑ {{ $t('action.commit-and-push') }}</button>
              <button class="menu-item" :disabled="!canCommit" @click="runCommit({ then: 'sync' })">⇅ {{ $t('action.commit-and-sync') }}</button>
              <div class="menu-sep" />
              <button class="menu-item" :disabled="!gitLog.length" @click="doUndo(); showCommitMenu = false">
                ↺ {{ $t('action.undo-last-commit') }}
              </button>
              <div class="menu-sep" />
              <button class="menu-item auto-commit-btn" :class="{ 'on': autoCommit }" @click="setAutoCommit(!autoCommit); showCommitMenu = false">
                ✦ {{ $t('action.auto-commit') }}
                <span class="spacer" />
                <span class="ac-badge">{{ autoCommit ? $t('label.on') : $t('label.off') }}</span>
                <span v-if="autoCommitPending" class="auto-pending-dot" :title="$t('label.auto-commit-scheduled')" />
              </button>
            </div>
          </Teleport>
        </div>

        <!-- Auto Commit status bar -->
        <div v-if="autoCommit && (autoCommitPending || autoCommitStep)" class="ac-status-bar">
          <span v-if="autoCommitStep" class="ac-status-spinner">⟳</span>
          <span v-else class="ac-status-dot" />
          <span class="ac-status-label">
            <template v-if="autoCommitStep === 'staging'">{{ $t('label.staging-changes') }}</template>
            <template v-else-if="autoCommitStep === 'checking'">{{ $t('label.running-lint') }}</template>
            <template v-else-if="autoCommitStep === 'generating'">{{ $t('label.generating-message') }}</template>
            <template v-else-if="autoCommitStep === 'committing'">{{ $t('label.committing') }}</template>
            <template v-else>{{ $t('label.auto-commit-waiting', { count: autoCommitCountdown }) }}</template>
          </span>
        </div>
      </div>

      <!-- ── STAGED CHANGES ──────────────────────────────────── -->
      <div class="sec-hdr clickable" @click="stagedExpanded = !stagedExpanded" @contextmenu.prevent="openStagedSectionMenu($event)">
        <span class="sec-caret">{{ stagedExpanded ? '▾' : '▸' }}</span>
        <span class="sec-label">{{ $t('label.staged-changes') }}</span>
        <span v-if="hasStaged" class="sec-badge">{{ gitStatus.staged.length }}</span>
        <div class="spacer" />
        <div class="sec-actions" @click.stop>
          <button v-if="hasStaged" class="sec-btn" :title="$t('action.unstage-all')" @click="doUnstageAll">−</button>
        </div>
      </div>
      <p v-if="gitError" class="err-text git-error-row" style="padding:2px 16px">
        {{ gitError }}
        <button class="git-error-x" :title="$t('action.dismiss')" @click.stop="clearGitError">✕</button>
      </p>

      <div v-if="stagedExpanded && hasStaged" class="file-group">
        <div v-if="conflictError" class="err-text" style="padding:2px 16px">{{ conflictError }}</div>

        <!-- Tree mode -->
        <template v-if="viewMode === 'tree'">
          <template v-for="row in flattenTree(gitStatus.staged, 's:')" :key="'s:' + row.key">
            <div
              v-if="row.kind === 'folder'"
              class="folder-row" :style="treeIndent(row.depth)" @click.stop="toggleDir(row.key)"
              @contextmenu="openFolderCtxMenu($event, row.dir!, true)"
            >
              <span class="folder-caret">{{ collapsedDirs.has(row.key) ? '▸' : '▾' }}</span>
              <svg class="folder-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
              <span class="folder-name" v-truncate :title="row.dir">{{ row.name }}</span>
              <span class="folder-count">{{ row.fileCount }}</span>
              <div class="row-actions">
                <button class="row-btn" :title="$t('action.unstage-folder')" @click.stop="unstageFiles(filesUnderDir(row.dir!, true))">−</button>
              </div>
            </div>
            <template v-else>
              <div
                class="file-row" :style="treeIndent(row.depth)"
                :class="{ 'row-conflict': row.file!.status === 'U', 'row-selected': selectedKeys.has('staged:' + row.file!.path) }"
                draggable="true"
                @dragstart="(e) => e.dataTransfer?.setData('text/plain', absPath(row.file!.path))"
                @click.stop="handleFileRowClick($event, row.file!.path, true)"
                @contextmenu="openCtxMenu($event, row.file!, true)"
              >
                <span class="file-status" :data-s="row.file!.status">{{ statusLabel(row.file!.status) }}</span>
                <span class="file-name-only" v-truncate :title="row.file!.path">{{ row.name }}</span>
                <div class="row-actions">
                  <template v-if="row.file!.status === 'U'">
                    <button class="row-btn" :title="$t('action.accept-ours')" @click.stop="doResolveOurs(row.file!.path)">↰</button>
                    <button class="row-btn" :title="$t('action.accept-theirs')" @click.stop="doResolveTheirs(row.file!.path)">↱</button>
                  </template>
                  <template v-else>
                    <button class="row-btn" :title="$t('action.file-history-blame')" @click.stop="toggleHistoryPanel(row.file!.path, true)">⊡</button>
                    <button class="row-btn" :title="$t('action.unstage')" @click.stop="unstageFile(row.file!.path)">−</button>
                  </template>
                </div>
              </div>
              <div v-if="fileHistoryPath === row.file!.path" class="subpanel blue-border">
                <div v-if="fileHistoryLoading" class="loading-text">{{ $t('label.loading') }}</div>
                <div v-else-if="!fileHistoryCommits.length" class="loading-text">{{ $t('label.no-commits') }}</div>
                <div v-for="hc in fileHistoryCommits" :key="hc.hash" class="mini-row">
                  <code class="hash-tag">{{ hc.short_hash }}</code>
                  <span class="mini-msg" v-truncate>{{ hc.message }}</span>
                </div>
              </div>
              <div v-if="diffBlamePath === row.file!.path && diffBlameStaged" class="subpanel green-border diffblame-inline">
                <div v-if="diffBlameLoading" class="loading-text">{{ $t('label.loading') }}</div>
                <div v-else-if="!diffBlameHunks.length" class="loading-text">{{ $t('git.pane.no-changes-to-display') }}</div>
                <template v-else v-for="(dh, dhi) in diffBlameHunks" :key="dhi">
                  <div class="db-hunk-head">{{ dh.header }}</div>
                  <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                    <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                    <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                    <code class="db-code">{{ dl.text }}</code>
                    <span class="db-annot">{{ dl.committed ? `${dl.author}, ${dl.date}` : $t('label.uncommitted') }}</span>
                  </div>
                </template>
              </div>
            </template>
          </template>
        </template>

        <!-- List mode -->
        <template v-else>
          <template v-for="f in sortFiles(gitStatus.staged)" :key="'sl:' + f.path">
            <div
              class="file-row"
              :class="{ 'row-conflict': f.status === 'U', 'row-selected': selectedKeys.has('staged:' + f.path) }"
              draggable="true"
              @dragstart="(e) => e.dataTransfer?.setData('text/plain', absPath(f.path))"
              @click.stop="handleFileRowClick($event, f.path, true)"
              @contextmenu="openCtxMenu($event, f, true)"
            >
              <span class="file-status" :data-s="f.status">{{ statusLabel(f.status) }}</span>
              <span class="file-name-main" v-truncate :title="f.path">{{ fileName(f.path) }}</span>
              <span class="file-path-dim" v-truncate :title="f.path">{{ fileDir(f.path) }}</span>
              <div class="row-actions">
                <template v-if="f.status === 'U'">
                  <button class="row-btn" :title="$t('action.accept-ours')" @click.stop="doResolveOurs(f.path)">↰</button>
                  <button class="row-btn" :title="$t('action.accept-theirs')" @click.stop="doResolveTheirs(f.path)">↱</button>
                </template>
                <template v-else>
                  <button class="row-btn" :title="$t('action.file-history-blame')" @click.stop="toggleHistoryPanel(f.path, true)">⊡</button>
                </template>
              </div>
            </div>
            <div v-if="fileHistoryPath === f.path" class="subpanel blue-border">
              <div v-if="fileHistoryLoading" class="loading-text">{{ $t('label.loading') }}</div>
              <div v-else-if="!fileHistoryCommits.length" class="loading-text">{{ $t('label.no-commits') }}</div>
              <div v-for="hc in fileHistoryCommits" :key="hc.hash" class="mini-row">
                <code class="hash-tag">{{ hc.short_hash }}</code>
                <span class="mini-msg" v-truncate>{{ hc.message }}</span>
              </div>
            </div>
            <div v-if="diffBlamePath === f.path && diffBlameStaged" class="subpanel green-border diffblame-inline">
              <div v-if="diffBlameLoading" class="loading-text">{{ $t('label.loading') }}</div>
              <div v-else-if="!diffBlameHunks.length" class="loading-text">{{ $t('git.pane.no-changes-to-display') }}</div>
              <template v-else v-for="(dh, dhi) in diffBlameHunks" :key="dhi">
                <div class="db-hunk-head">{{ dh.header }}</div>
                <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                  <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                  <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                  <code class="db-code">{{ dl.text }}</code>
                  <span class="db-annot">{{ dl.committed ? `${dl.author}, ${dl.date}` : $t('label.uncommitted') }}</span>
                </div>
              </template>
            </div>
          </template>
        </template>
      </div>

      <!-- ── CHANGES (unstaged) ──────────────────────────────── -->
      <div class="sec-hdr clickable" @click="changesExpanded = !changesExpanded" @contextmenu.prevent="openChangesSectionMenu($event)">
        <span class="sec-caret">{{ changesExpanded ? '▾' : '▸' }}</span>
        <span class="sec-label">{{ $t('label.changes') }}</span>
        <span v-if="gitStatus.unstaged?.length || gitStatus.untracked?.length" class="sec-badge">
          {{ (gitStatus.unstaged?.length ?? 0) + (gitStatus.untracked?.length ?? 0) }}
        </span>
        <div class="spacer" />
        <div class="sec-actions" @click.stop>
          <button v-if="hasChanges" class="sec-btn danger" :title="$t('action.discard-all')" @click="openDiscardAll">↩</button>
          <button v-if="hasChanges" class="sec-btn" :title="$t('action.stage-all')" @click="stageAll">＋</button>
        </div>
      </div>

      <!-- Merge conflict modal -->
      <div v-if="showMergeConflictModal" class="merge-conflict-box">
        <div class="clean-title">{{ $t('label.merge-conflict-files', { count: mergeConflictFiles.length }) }}</div>
        <div v-if="mergeConflictContext" class="merge-conflict-context">{{ mergeConflictContext }}</div>
        <div v-for="f in mergeConflictFiles" :key="f" class="clean-file conflict-file">{{ f }}</div>
        <div class="merge-conflict-actions">
          <button class="btn-danger" @click="doConflictAbort">{{ $t('action.abort-merge') }}</button>
          <button class="btn-primary" @click="doConflictKeep">{{ $t('action.resolve-conflicts') }}</button>
        </div>
      </div>

      <!-- Stash with optional label -->
      <div v-if="showStashPrompt" class="stash-box">
        <div class="stash-title">{{ $t('action.save-draft-title') }}</div>
        <div class="input-row">
          <input
            v-model="stashMessage"
            class="git-input"
            type="text"
            :placeholder="$t('label.name-draft-placeholder')"
            @keydown.enter="doStash"
            @keydown.esc="showStashPrompt = false"
          />
        </div>
        <div class="clean-actions">
          <button class="btn-ghost" @click="showStashPrompt = false">{{ $t('action.cancel') }}</button>
          <button class="btn-primary" @click="doStash">{{ $t('action.save-draft') }}</button>
        </div>
        <p v-if="stashError" class="err-text">{{ stashError }}</p>
      </div>


      <div v-if="changesExpanded">
        <div v-if="!hasChanges" class="empty-msg">{{ $t('label.no-changes') }}</div>

        <div v-else class="file-group">
          <!-- Tree mode -->
          <template v-if="viewMode === 'tree'">
            <template v-for="row in flattenTree([...gitStatus.unstaged, ...gitStatus.untracked], 'u:')" :key="'u:' + row.key">
              <div
                v-if="row.kind === 'folder'"
                class="folder-row" :style="treeIndent(row.depth)" @click.stop="toggleDir(row.key)"
                @contextmenu="openFolderCtxMenu($event, row.dir!, false)"
              >
                <span class="folder-caret">{{ collapsedDirs.has(row.key) ? '▸' : '▾' }}</span>
                <svg class="folder-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
                <span class="folder-name" v-truncate :title="row.dir">{{ row.name }}</span>
                <span class="folder-count">{{ row.fileCount }}</span>
                <div class="row-actions">
                  <button class="row-btn danger shrink" :title="$t('action.discard-folder')" @click.stop="confirmDiscard(filesUnderDir(row.dir!, false))">↩</button>
                  <button class="row-btn primary" :title="$t('action.stage-folder')" @click.stop="stageFiles(filesUnderDir(row.dir!, false))">＋</button>
                </div>
              </div>
              <template v-else>
                <div
                  class="file-row" :style="treeIndent(row.depth)"
                  :class="{ 'row-selected': selectedKeys.has('changes:' + row.file!.path) }"
                  draggable="true"
                  @dragstart="(e) => e.dataTransfer?.setData('text/plain', absPath(row.file!.path))"
                  @click.stop="handleFileRowClick($event, row.file!.path, false)"
                  @contextmenu="openCtxMenu($event, row.file!, false)"
                >
                  <span class="file-status unstaged-st" :data-s="row.file!.status">{{ statusLabel(row.file!.status) }}</span>
                  <span class="file-name-only" v-truncate :title="row.file!.path">{{ row.name }}</span>
                  <div class="row-actions">
                    <button class="row-btn" :title="$t('action.file-history-blame')" @click.stop="toggleHistoryPanel(row.file!.path, false)">⊡</button>
                    <button class="row-btn danger shrink" :title="$t('action.discard')" @click.stop="confirmDiscard([row.file!.path])">↩</button>
                    <button class="row-btn primary" :title="$t('action.stage')" @click.stop="stageFile(row.file!.path)">＋</button>
                  </div>
                </div>
                <div v-if="fileHistoryPath === row.file!.path" class="subpanel blue-border">
                  <div v-if="fileHistoryLoading" class="loading-text">{{ $t('label.loading') }}</div>
                  <div v-else-if="!fileHistoryCommits.length" class="loading-text">{{ $t('label.no-commits') }}</div>
                  <div v-for="hc in fileHistoryCommits" :key="hc.hash" class="mini-row">
                    <code class="hash-tag">{{ hc.short_hash }}</code>
                    <span class="mini-msg" v-truncate>{{ hc.message }}</span>
                  </div>
                </div>
                <div v-if="diffBlamePath === row.file!.path && !diffBlameStaged" class="subpanel green-border diffblame-inline">
                  <div v-if="diffBlameLoading" class="loading-text">{{ $t('label.loading') }}</div>
                  <div v-else-if="!diffBlameHunks.length" class="loading-text">{{ $t('git.pane.no-changes-to-display') }}</div>
                  <template v-else v-for="(dh, dhi) in diffBlameHunks" :key="dhi">
                    <div class="db-hunk-head">{{ dh.header }}</div>
                    <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                      <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                      <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                      <code class="db-code">{{ dl.text }}</code>
                      <span class="db-annot">{{ dl.committed ? `${dl.author}, ${dl.date}` : $t('label.uncommitted') }}</span>
                    </div>
                  </template>
                </div>
              </template>
            </template>
          </template>

          <!-- List mode -->
          <template v-else>
            <template v-for="f in sortFiles([...gitStatus.unstaged, ...gitStatus.untracked])" :key="'ul:' + f.path">
              <div
                class="file-row"
                :class="{ 'row-selected': selectedKeys.has('changes:' + f.path) }"
                draggable="true"
                @dragstart="(e) => e.dataTransfer?.setData('text/plain', absPath(f.path))"
                @click.stop="handleFileRowClick($event, f.path, false)"
                @contextmenu="openCtxMenu($event, f, false)"
              >
                <span class="file-status unstaged-st" :data-s="f.status">{{ statusLabel(f.status) }}</span>
                <span class="file-name-main" v-truncate :title="f.path">{{ fileName(f.path) }}</span>
                <span class="file-path-dim" v-truncate :title="f.path">{{ fileDir(f.path) }}</span>
                <div class="row-actions">
                  <button class="row-btn" :title="$t('action.file-history-blame')" @click.stop="toggleHistoryPanel(f.path, false)">⊡</button>
                  <button class="row-btn danger shrink" :title="$t('action.discard')" @click.stop="confirmDiscard([f.path])">↩</button>
                  <button class="row-btn primary" :title="$t('action.stage')" @click.stop="stageFile(f.path)">＋</button>
                </div>
              </div>
              <div v-if="fileHistoryPath === f.path" class="subpanel blue-border">
                <div v-if="fileHistoryLoading" class="loading-text">{{ $t('label.loading') }}</div>
                <div v-else-if="!fileHistoryCommits.length" class="loading-text">{{ $t('label.no-commits') }}</div>
                <div v-for="hc in fileHistoryCommits" :key="hc.hash" class="mini-row">
                  <code class="hash-tag">{{ hc.short_hash }}</code>
                  <span class="mini-msg" v-truncate>{{ hc.message }}</span>
                </div>
              </div>
              <div v-if="diffBlamePath === f.path && !diffBlameStaged" class="subpanel green-border diffblame-inline">
                <div v-if="diffBlameLoading" class="loading-text">{{ $t('label.loading') }}</div>
                <div v-else-if="!diffBlameHunks.length" class="loading-text">{{ $t('git.pane.no-changes-to-display') }}</div>
                <template v-else v-for="(dh, dhi) in diffBlameHunks" :key="dhi">
                  <div class="db-hunk-head">{{ dh.header }}</div>
                  <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                    <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                    <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                    <code class="db-code">{{ dl.text }}</code>
                    <span class="db-annot">{{ dl.committed ? `${dl.author}, ${dl.date}` : $t('label.uncommitted') }}</span>
                  </div>
                </template>
              </div>
            </template>
          </template>
        </div>
      </div>

      <!-- ── IGNORED (only when "Show Ignored Files" is on) ──────── -->
      <div v-if="showIgnored" class="sec-hdr clickable" @click="ignoredExpanded = !ignoredExpanded">
        <span class="sec-caret">{{ ignoredExpanded ? '▾' : '▸' }}</span>
        <span class="sec-label">{{ $t('label.ignored') }}</span>
        <span v-if="gitStatus.ignored?.length" class="sec-badge">{{ gitStatus.ignored.length }}</span>
        <div class="spacer" />
      </div>
      <div v-if="showIgnored && ignoredExpanded">
        <div v-if="!gitStatus.ignored?.length" class="empty-msg">{{ $t('git.pane.no-ignored-files') }}</div>
        <template v-for="f in sortFiles(gitStatus.ignored ?? [])" :key="'ig:' + f.path">
          <div class="file-row ignored-row" @contextmenu="openCtxMenu($event, f, false)">
            <span class="file-status" :title="$t('label.ignored')">!</span>
            <span class="file-name-main" v-truncate :title="f.path">{{ fileName(f.path) }}</span>
            <span class="file-path-dim" v-truncate :title="f.path">{{ fileDir(f.path) }}</span>
          </div>
        </template>
      </div>

      </div><!-- /part-top -->

      <!-- ── selection action bar ──────────────────────────────── -->
      <div v-if="selectedKeys.size > 1" class="selection-bar" @click.stop>
        <span class="sel-count">{{ $t('action.selected-count', { count: selectedKeys.size }) }}</span>
        <button class="sel-btn sel-clear" @click="clearSelection">✕</button>
      </div>

      <!-- ══════════════════════════════════════════════════════
           PART 2 — REMOTE / HISTORY
           ══════════════════════════════════════════════════════ -->
      <div class="part-resize" :title="$t('git.pane.drag-to-resize')" @mousedown="onGitDividerStart">
        <div class="part-resize-grip" />
      </div>

      <!-- ── PART 2: branch header (fixed) + scrollable cards ──── -->
      <div class="part-bottom">

      <!-- Branch + remote action bar (never scrolls) -->
      <div class="remote-bar">
        <button class="branch-pill" v-truncate :class="{ active: branchExpanded }" @click.stop="branchExpanded = !branchExpanded">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25z"/></svg>
          <span>{{ gitStatus.branch || '(detached)' }}</span>
          <span v-if="aheadBehind" class="ab-text">{{ aheadBehind }}</span>
        </button>
        <div class="spacer" />
        <button
          class="remote-btn account-pill"
          :title="$t('git.account.selector-title')"
          @click.stop="openAccountMenu($event)"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.622 0zM8 1.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>
          <span class="account-pill-label" v-truncate>{{ boundAccount ? boundAccount.label : $t('git.account.unbound') }}</span>
        </button>
        <button v-if="gitStatus.branch && !gitStatus.remote_branch" class="remote-btn publish-btn" :class="{ busy: remoteBusy === 'publish' }" :title="$t('action.publish-branch')" :disabled="!!remoteBusy" @click="doPushUpstream">
          <span v-if="remoteBusy === 'publish'" class="spinner">⟳</span><template v-else>↑ {{ $t('action.publish') }}</template>
        </button>
        <button class="remote-btn" :class="{ busy: remoteBusy === 'fetch' }" :title="$t('action.fetch')" :disabled="!!remoteBusy" @click="doFetch">
          <span v-if="remoteBusy === 'fetch'" class="spinner">⟳</span>
          <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 7.5A6 6 0 0 1 13 5.185V2.75a.75.75 0 0 1 1.5 0V7a.75.75 0 0 1-.75.75H9.25a.75.75 0 0 1 0-1.5h2.565A4.5 4.5 0 1 0 12 10a.75.75 0 1 1 1.261.815A6 6 0 1 1 1.5 7.5z"/></svg>
        </button>
        <button class="remote-btn" :class="{ busy: remoteBusy === 'pull' }" :title="$t('action.pull')" :disabled="!!remoteBusy" @click="doPull">
          <span v-if="remoteBusy === 'pull'" class="spinner">⟳</span><template v-else>↓</template>
        </button>
        <button class="remote-btn" :class="{ busy: remoteBusy === 'push' }" :title="$t('action.push')" :disabled="!!remoteBusy" @click="doPush(trackedRemote())">
          <span v-if="remoteBusy === 'push'" class="spinner">⟳</span><template v-else>↑<span v-if="gitStatus.ahead" class="ahead-num">{{ gitStatus.ahead }}</span></template>
        </button>
        <button class="remote-btn" :class="{ busy: remoteBusy === 'sync' }" :title="$t('action.sync-title')" :disabled="!!remoteBusy" @click="doSync">
          <span v-if="remoteBusy === 'sync'" class="spinner">⟳</span><template v-else>⇅</template>
        </button>
        <button class="remote-btn" :title="$t('action.more-pull-push')" :disabled="!!remoteBusy" @click.stop="openRemoteMenu($event)">▾</button>
        <Teleport to="body">
          <div v-if="showRemoteMenu" class="tp-backdrop" :data-git-pane-menu-owner="menuOwnerId" @click="showRemoteMenu = false" />
          <div v-if="showRemoteMenu" class="tp-dropdown" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: remoteMenuPos.top + 'px', right: remoteMenuPos.right + 'px' }" @click.stop>
            <button class="menu-item" @click="doPull(); showRemoteMenu = false">↓ {{ $t('action.pull') }}</button>
            <button class="menu-item" @click="doPullRebase">↓ {{ $t('action.pull-rebase') }}</button>
            <div class="menu-sep" />
            <button class="menu-item" @click="doPush(trackedRemote()); showRemoteMenu = false">↑ {{ $t('action.push') }}</button>
            <button class="menu-item danger" @click="doPushForce(trackedRemote())">↑ {{ $t('action.push-force-lease') }}</button>
            <template v-if="gitRemotes.length > 1">
              <div class="menu-sep" />
              <div class="menu-group-label">{{ $t('label.push-to-remote') }}</div>
              <button
                v-for="r in gitRemotes"
                :key="r.name"
                class="menu-item"
                @click="doPush(r.name); showRemoteMenu = false"
              >↑ {{ r.name }}</button>
            </template>
          </div>
        </Teleport>
        <Teleport to="body">
          <div v-if="showAccountMenu" class="tp-backdrop" :data-git-pane-menu-owner="menuOwnerId" @click="showAccountMenu = false" />
          <div v-if="showAccountMenu" class="tp-dropdown account-menu" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: accountMenuPos.top + 'px', right: accountMenuPos.right + 'px' }" @click.stop>
            <div class="menu-group-label">{{ $t('git.account.selector-title') }}</div>
            <button class="menu-item" :class="{ active: !boundAccountId }" @click="selectAccount(null)">
              {{ $t('git.account.unbound') }}
            </button>
            <template v-if="gitAccounts.accounts.value.length">
              <div class="menu-sep" />
              <button
                v-for="account in gitAccounts.accounts.value"
                :key="account.id"
                class="menu-item"
                :class="{ active: account.id === boundAccountId }"
                @click="selectAccount(account.id)"
              >{{ account.label }} <span class="acct-meta">{{ account.username }}</span></button>
            </template>
            <template v-else>
              <div class="menu-sep" />
              <div class="menu-empty">{{ $t('git.account.none') }}</div>
            </template>
            <div class="menu-sep" />
            <button class="menu-item" @click="showAccountMenu = false; emit('open-git-accounts')">
              + {{ $t('git.account.add-new') }}
            </button>
          </div>
        </Teleport>
      </div>

      <!-- Branch panel -->
      <div v-if="branchExpanded" class="collapsible-body">
        <div class="input-row">
          <input v-model="newBranchName" class="git-input" :placeholder="$t('label.create-branch-placeholder')" @keydown.enter="doCreateBranch" />
          <button class="btn-ghost sm" :disabled="branchCreating || !newBranchName.trim() || /\s|\.\./.test(newBranchName.trim()) || newBranchName.trim().startsWith('-')" @click="doCreateBranch">＋</button>
          <button class="btn-ghost sm" :class="{ active: showRemoteBranches }" :title="showRemoteBranches ? $t('action.hide-remote-branches') : $t('action.show-remote-branches')" @click="showRemoteBranches = !showRemoteBranches">⇅</button>
        </div>
        <p v-if="branchError || mergeError || rebaseError" class="err-text">{{ branchError || mergeError || rebaseError }}</p>
        <p v-if="mergeOutput || rebaseOutput" class="ok-text">{{ mergeOutput || rebaseOutput }}</p>
        <!-- local branches -->
        <div v-for="b in gitBranches.filter(x => !x.is_remote)" :key="b.name" class="branch-row" :class="{ current: b.is_current }" @contextmenu.prevent="!b.is_current && openBranchCtxMenu($event, b.name)">
          <span class="b-check">{{ b.is_current ? '✓' : '' }}</span>
          <span class="b-name" v-truncate>{{ b.name }}</span>
          <span v-if="b.tracking" class="b-track">→ {{ b.tracking }}</span>
          <div class="spacer" />
          <template v-if="!b.is_current">
            <button class="row-btn always" :title="$t('action.compare')" @click.stop="doCompareBranch(b.name)">⇔</button>
            <button class="row-btn always" :title="$t('action.rebase-onto')" :disabled="branchBusy" @click.stop="doRebase(b.name)">⇡</button>
            <button class="row-btn always" :title="$t('action.merge-into-current')" :disabled="branchBusy" @click.stop="doMerge(b.name)">⇣</button>
            <button class="row-btn always" :title="$t('action.switch')" :disabled="branchBusy" @click.stop="doSwitch(b.name)">↵</button>
          </template>
        </div>
        <!-- remote branches (toggleable) -->
        <template v-if="showRemoteBranches">
          <div class="branch-section-label">{{ $t('label.remote-branches') }}</div>
          <div v-if="!gitBranches.some(x => x.is_remote)" class="empty-msg">{{ $t('label.no-remote-branches') }}</div>
          <div
            v-for="b in gitBranches.filter(x => x.is_remote)"
            :key="b.name"
            class="branch-row remote-branch-row"
            :class="{ 'remote-has-local': b.has_local }"
          >
            <span class="b-check">{{ b.has_local ? '✓' : '' }}</span>
            <span class="b-name remote" v-truncate>{{ b.name }}</span>
            <div class="spacer" />
            <button v-if="!b.has_local" class="row-btn always" :title="$t('action.checkout-locally')" @click.stop="doCheckoutRemote(b.name)">⬇</button>
          </div>
        </template>
        <div v-if="comparingBranch && compareResult" class="compare-panel">
          <div class="compare-title">{{ comparingBranch }} ↔ {{ gitStatus.branch }}</div>
          <div class="compare-stat">{{ compareResult.stat }}</div>
          <div v-for="f in compareResult.files" :key="f" class="compare-file">{{ f }}</div>
        </div>
      </div>

      <!-- scrollable cards: History / Remotes / Tags / Worktrees / Config -->
      <div class="part-bottom-cards">

      <!-- ── HISTORY ─────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="historyExpanded = !historyExpanded">
          <span class="sec-caret">{{ historyExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">{{ $t('label.history') }}</span>
          <div class="spacer" />
        </div>
        <div v-if="historyExpanded" class="card-body">
        <div v-if="logError" class="read-error" role="alert">{{ $t('git.read-failed', { reason: logError }) }}</div>
        <div v-if="!latestLog.length" class="empty-msg">{{ $t('label.no-commits-yet') }}</div>
        <div v-else class="commit-list">
          <div v-for="(c, gi) in latestLog" :key="c.hash">
            <div class="commit-row" @click="toggleCommitDetail(c.hash)">
              <div class="graph-col" :style="{ width: graphWidth + 'px' }">
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
              <div class="commit-body">
                <div class="commit-msg" v-truncate>{{ c.message }}</div>
                <div class="commit-meta">
                  <code class="chash">{{ c.short_hash }}</code>
                  <span v-for="b in c.branches" :key="b" class="ref-pill" :class="b.startsWith('origin') ? 'remote' : 'local'">{{ shortBranch(b) }}</span>
                </div>
              </div>
              <div class="commit-btns-right" @click.stop>
                <span class="expand-caret">{{ expandedCommitHash === c.hash ? '▾' : '▸' }}</span>
              </div>
            </div>
            <div v-if="expandedCommitHash === c.hash" class="commit-detail">
              <div v-if="commitDetailLoading" class="loading-text">{{ $t('label.loading') }}</div>
              <div v-else-if="!commitDetailData && commitDetailError" class="read-error" role="alert">{{ $t('git.read-failed', { reason: commitDetailError }) }}</div>
              <template v-else-if="commitDetailData">
                <div class="cd-body">{{ commitDetailData.message }}</div>
                <div class="cd-row"><span class="cd-key">{{ $t('label.col-author') }}</span><span>{{ commitDetailData.author_name }} &lt;{{ commitDetailData.author_email }}&gt;</span></div>
                <div class="cd-row"><span class="cd-key">{{ $t('label.col-date') }}</span><span>{{ new Date(commitDetailData.date).toLocaleString() }}</span></div>
                <div v-if="commitDetailData.body" class="cd-body">{{ commitDetailData.body }}</div>
                <div v-if="commitDetailData.files.length">
                  <div class="cd-key">{{ $t('git.pane.commit-files', { count: commitDetailData.files.length }) }}</div>
                  <template v-for="f in commitDetailData.files" :key="f">
                    <div class="cd-file cd-file-clickable cd-file-row" @click="toggleCommitFileDiff(c.hash, f)">
                      <span class="cd-file-label" v-truncate><span class="expand-caret">{{ commitDiffFile === f ? '▾' : '▸' }}</span> {{ f }}</span>
                      <button class="row-btn cd-open-btn" :title="$t('action.open-diff-in-editor')" @click.stop="openCommitFileDiffInIDE(c.hash, f)">
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25V1.75zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5H3.75zm6.75.56v2.19c0 .138.112.25.25.25h2.19L10.5 2.06z"/></svg>
                      </button>
                    </div>
                    <div v-if="commitDiffFile === f" class="subpanel green-border diffblame-inline">
                      <div v-if="commitDiffLoading" class="loading-text">{{ $t('label.loading') }}</div>
                      <div v-else-if="!commitDiffHunks.length" class="loading-text">{{ $t('git.pane.no-changes-to-display') }}</div>
                      <template v-else v-for="(dh, dhi) in commitDiffHunks" :key="dhi">
                        <div class="db-hunk-head">{{ dh.header }}</div>
                        <div v-for="(dl, dli) in dh.lines" :key="dhi + ':' + dli" class="db-line" :class="`db-${dl.kind === '+' ? 'add' : dl.kind === '-' ? 'del' : 'ctx'}`">
                          <span class="db-no">{{ dl.new_no ?? dl.old_no ?? '' }}</span>
                          <span class="db-sign">{{ dl.kind === ' ' ? '' : dl.kind }}</span>
                          <code class="db-code">{{ dl.text }}</code>
                        </div>
                      </template>
                    </div>
                  </template>
                </div>
              </template>
            </div>
          </div>
        </div>
        <div class="history-load-more">
          <button class="load-more-btn" @click.stop="openHistoryWindow()">{{ $t('label.view-full-history') }}</button>
        </div>
        </div>
      </div>

      <!-- ── STASHES ─────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="stashExpanded = !stashExpanded">
          <span class="sec-caret">{{ stashExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">{{ $t('label.draft') }}</span>
          <span v-if="gitStashes.length" class="sec-badge">{{ gitStashes.length }}</span>
          <div class="spacer" />
        </div>
        <div v-if="stashExpanded" class="card-body">
        <div v-if="!gitStashes.length" class="empty-msg">{{ $t('git.pane.no-draft') }}</div>
        <div v-for="s in gitStashes" :key="s.ref" class="generic-row">
          <span class="stash-ref">{{ s.ref }}</span>
          <span class="stash-msg" v-truncate>{{ s.message }}</span>
          <div class="row-actions always">
            <button class="row-btn always" :title="$t('action.stash-apply')" :disabled="stashBusy" @click.stop="doStashApply(s.index)">⎘</button>
            <button class="row-btn always" :title="$t('action.stash-pop')" :disabled="stashBusy" @click.stop="doStashPop(s.index)">↑</button>
            <button class="row-btn always danger" :title="$t('action.drop')" :disabled="stashBusy" @click.stop="doStashDrop(s.index)">✕</button>
          </div>
        </div>
        <p v-if="stashError" class="err-text">{{ stashError }}</p>
        </div>
      </div>

      <!-- ── REMOTES ─────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="remoteExpanded = !remoteExpanded">
          <span class="sec-caret">{{ remoteExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">{{ $t('label.remotes') }}</span>
          <span v-if="gitRemotes.length" class="sec-badge">{{ gitRemotes.length }}</span>
          <div class="spacer" />
        </div>
        <div v-if="remoteExpanded" class="card-body collapsible-body">
        <div v-if="!gitRemotes.length" class="empty-msg" style="padding:2px 0">{{ $t('label.no-remotes') }}</div>
        <div v-for="r in gitRemotes" :key="r.name" class="generic-row">
          <span class="remote-name">{{ r.name }}</span>
          <span class="remote-url" v-truncate>{{ r.fetch_url }}</span>
          <button class="row-btn always" :title="$t('action.open-remote-url')" @click.stop="doOpenRemote(r.fetch_url)">↗</button>
          <button class="row-btn always danger" @click.stop="doRemoveRemote(r.name)">✕</button>
        </div>
        <div class="input-row" style="margin-top:6px">
          <input v-model="newRemoteName" class="git-input" :placeholder="$t('label.name')" style="width:72px;flex:0 0 auto" />
          <input v-model="newRemoteUrl" class="git-input" :placeholder="$t('label.url')" />
          <button class="btn-ghost sm" :disabled="!newRemoteName.trim() || !newRemoteUrl.trim()" @click="doAddRemote">＋</button>
        </div>
        <p v-if="remotesMgrError" class="err-text">{{ remotesMgrError }}</p>
        </div>
      </div>

      <!-- ── TAGS ───────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="tagExpanded = !tagExpanded">
          <span class="sec-caret">{{ tagExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">{{ $t('label.tags') }}</span>
          <span v-if="gitTags.length" class="sec-badge">{{ gitTags.length }}</span>
          <div class="spacer" />
        </div>
        <div v-if="tagExpanded" class="card-body collapsible-body">
        <div v-if="!gitTags.length" class="empty-msg" style="padding:2px 0">{{ $t('label.no-tags') }}</div>
        <div v-for="t in gitTags" :key="t.name" class="generic-row">
          <span class="b-name" v-truncate>{{ t.name }}</span>
          <code class="chash" style="margin-left:4px">{{ t.commit_hash }}</code>
          <span v-if="t.message" class="b-track">{{ t.message }}</span>
          <div class="spacer" />
          <button class="row-btn always danger" :disabled="tagBusy" @click.stop="doDeleteTag(t.name)">✕</button>
        </div>
        <div class="input-row" style="margin-top:6px; flex-wrap:wrap; gap:4px">
          <input v-model="newTagName" class="git-input" placeholder="v1.0.0" style="flex:1;min-width:72px" />
          <input v-model="newTagMessage" class="git-input" :placeholder="$t('label.message')" style="flex:2;min-width:80px" />
          <button class="btn-ghost sm" :disabled="!newTagName.trim()" @click="doCreateTag">＋</button>
        </div>
        <p v-if="tagError" class="err-text">{{ tagError }}</p>
        </div>
      </div>

      <!-- ── WORKTREES ──────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="worktreeExpanded = !worktreeExpanded">
          <span class="sec-caret">{{ worktreeExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">{{ $t('label.worktrees') }}</span>
          <span v-if="gitWorktrees.length > 1" class="sec-badge">{{ gitWorktrees.length }}</span>
          <div class="spacer" />
        </div>
        <div v-if="worktreeExpanded" class="card-body collapsible-body">
        <div class="input-row" style="margin-bottom:6px">
          <button class="btn-ghost sm" :disabled="worktreeBusy === '*'" :title="$t('action.prune')" @click="doPruneWorktrees">{{ $t('action.prune') }}</button>
          <button class="btn-ghost sm" :disabled="worktreeBusy === '*'" :title="$t('action.repair')" @click="doRepairWorktrees">{{ $t('action.repair') }}</button>
        </div>
        <div v-for="wt in gitWorktrees" :key="wt.path" class="generic-row">
          <span class="wt-icon">{{ wt.is_main ? '✦' : '○' }}</span>
          <div style="flex:1;min-width:0">
            <div class="wt-name-row">
              <span class="b-name" v-truncate :title="wt.path">{{ wt.path.split('/').at(-1) }}</span>
              <span v-if="wt.bare" class="wt-badge">{{ $t('label.bare') }}</span>
              <span v-if="wt.detached" class="wt-badge">{{ $t('label.detached') }}</span>
              <span v-if="wt.locked" class="wt-badge warn" :title="wt.lock_reason">🔒 {{ $t('label.locked') }}</span>
              <span v-if="wt.prunable" class="wt-badge warn" :title="wt.prune_reason">⚠ {{ $t('label.stale') }}</span>
            </div>
            <div class="b-track">
              {{ wt.bare ? $t('label.bare') : (wt.branch || $t('label.detached-head')) }} · {{ wt.head
              }}<template v-if="wt.locked && wt.lock_reason"> · {{ wt.lock_reason }}</template
              ><template v-if="wt.prunable && wt.prune_reason"> · {{ wt.prune_reason }}</template>
            </div>
          </div>
          <button v-if="!wt.bare && wt.path !== workspacePath" class="row-btn always" :disabled="worktreeBusy === wt.path" :title="$t('action.open-in-new-window')" @click.stop="doOpenWorktree(wt)">⧉</button>
          <button v-if="!wt.bare" class="row-btn always" :disabled="worktreeBusy === wt.path" :title="$t('action.reveal-in-finder')" @click.stop="doRevealWorktree(wt)">◱</button>
          <button v-if="!wt.is_main" class="row-btn always" :disabled="worktreeBusy === wt.path" :title="wt.locked ? $t('action.unlock') : $t('action.lock')" @click.stop="doToggleWorktreeLock(wt)">{{ wt.locked ? '🔓' : '🔒' }}</button>
          <button v-if="!wt.is_main && !wt.bare" class="row-btn always" :disabled="worktreeBusy === wt.path" :title="$t('action.move')" @click.stop="doMoveWorktree(wt)">⇄</button>
          <button v-if="!wt.is_main" class="row-btn always danger" :disabled="worktreeBusy === wt.path" :title="$t('action.remove')" @click.stop="doRemoveWorktree(wt)">✕</button>
        </div>
        <div class="input-row" style="margin-top:6px; flex-direction:column; gap:4px">
          <div class="input-row">
            <input v-model="newWtPath" class="git-input" :placeholder="$t('label.worktree-path-placeholder')" style="flex:2" />
            <button class="btn-ghost sm icon-only" :title="$t('action.browse-folder')" @click="pickWorktreeDir">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
            </button>
            <input v-if="newWtIsNew" v-model="newWtBranch" class="git-input" :placeholder="$t('label.new-worktree-branch-placeholder')" style="flex:1" />
            <select v-else v-model="newWtBranch" class="git-input" style="flex:1">
              <option value="" disabled>{{ $t('label.branch-placeholder') }}</option>
              <option v-for="b in worktreeBranchOptions" :key="b" :value="b">{{ b }}</option>
            </select>
            <button class="btn-ghost sm" :disabled="!newWtPath.trim() || !newWtBranch.trim()" :title="$t('action.add-worktree')" @click="doAddWorktree">＋</button>
          </div>
          <label class="check-label">
            <input v-model="newWtIsNew" type="checkbox" /> {{ $t('label.create-new-branch') }}
          </label>
        </div>
        <p v-if="worktreeError" class="err-text">{{ worktreeError }}</p>
        </div>
      </div>

      <!-- ── CONFIG ─────────────────────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="configExpanded = !configExpanded">
          <span class="sec-caret">{{ configExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">{{ $t('label.config') }}</span>
          <div class="spacer" />
        </div>
        <div v-if="configExpanded" class="card-body collapsible-body">
        <div v-for="key in configDisplayKeys" :key="key" class="config-row">
          <span class="config-key">{{ key }}</span>
          <template v-if="inlineEditKey === key">
            <select
              v-if="CONFIG_OPTIONS[key]"
              v-model="inlineEditValue"
              class="git-input config-inline-input"
            >
              <option value="" disabled>—</option>
              <option v-for="opt in CONFIG_OPTIONS[key]" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <input
              v-else
              v-model="inlineEditValue"
              class="git-input config-inline-input"
              autofocus
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

      <!-- ── ISSUES (GitHub/GitLab) ─────────────────────────── -->
      <div class="git-card">
        <div class="card-hdr clickable" @click="toggleIssuesCard">
          <span class="sec-caret">{{ issuesExpanded ? '▾' : '▸' }}</span>
          <span class="sec-label">{{ $t('label.issues') }}</span>
          <span v-if="issuesExpanded && issueProviderLabel()" class="sec-badge">{{ issueProviderLabel() }}</span>
          <span v-if="issuesExpanded && openIssueCount" class="sec-badge">{{ $t('git.pane.issues-open-count', { count: openIssueCount }) }}</span>
          <div class="spacer" />
          <button
            v-if="issuesExpanded && issueProvider.authenticated && !selectedIssue"
            class="row-btn always" :title="$t('action.new-issue')"
            @click.stop="showNewIssue = !showNewIssue"
          >＋</button>
          <button
            v-if="issuesExpanded"
            class="row-btn always" :title="$t('action.refresh')" @click.stop="refreshIssues"
          >↻</button>
        </div>
        <div v-if="issuesExpanded" class="card-body collapsible-body">
          <!-- unsupported host -->
          <div v-if="issueProvider.provider === 'unknown'" class="empty-msg" style="padding:2px 0">
            {{ $t('git.pane.issue-host-unsupported') }}
          </div>
          <!-- CLI missing / not authenticated -->
          <div v-else-if="!issueProvider.cli_available" class="empty-msg" style="padding:2px 0">
            {{ $t('git.pane.issue-cli-missing', { cli: issueProvider.provider === 'github' ? 'GitHub CLI (gh)' : 'GitLab CLI (glab)' }) }}
          </div>
          <div v-else-if="!issueProvider.authenticated" class="empty-msg" style="padding:2px 0">
            {{ $t('git.pane.issue-auth-before') }}
            <code>{{ issueProvider.provider === 'github' ? 'gh auth login' : 'glab auth login' }}</code>
            {{ $t('git.pane.issue-auth-after') }}
          </div>

          <!-- detail view -->
          <template v-else-if="selectedIssue">
            <div class="input-row" style="margin-bottom:6px">
              <button class="btn-ghost sm" @click="closeIssueDetail">{{ $t('git.issue-back') }}</button>
              <div class="spacer" />
              <div class="dispatch-wrap">
                <button
                  class="btn-ghost sm"
                  :disabled="!dispatchTargets.length"
                  :title="dispatchTargets.length ? $t('git.pane.issue-dispatch-title') : $t('git.pane.issue-no-running-agent')"
                  @click="onDispatchClick"
                >{{ $t('git.pane.issue-dispatch') }}</button>
                <div v-if="showDispatchMenu" class="dispatch-menu">
                  <button
                    v-for="t in dispatchTargets" :key="t.id"
                    class="dispatch-menu-item" @click="dispatchTo(t.id)"
                  >{{ t.label }}</button>
                </div>
              </div>
              <a class="btn-ghost sm" :href="selectedIssue.url" target="_blank" rel="noopener">{{ $t('action.open') }} ↗</a>
              <button class="btn-ghost sm" :disabled="isIssueSubmitting" @click="toggleIssueState">
                {{ selectedIssue.state === 'open' ? $t('action.close') : $t('action.reopen') }}
              </button>
            </div>
            <div class="issue-detail-title">
              <span class="issue-state-dot" :class="selectedIssue.state" />
              #{{ selectedIssue.number }} · {{ selectedIssue.title }}
            </div>
            <div class="b-track" style="margin-bottom:6px">{{ selectedIssue.author }} · {{ selectedIssue.created_at }}</div>
            <pre class="issue-body">{{ selectedIssue.body || $t('label.no-description') }}</pre>
            <div v-for="(c, i) in selectedIssue.comments" :key="i" class="issue-comment">
              <div class="b-track">{{ c.author }} · {{ c.created_at }}</div>
              <pre class="issue-body">{{ c.body }}</pre>
            </div>
            <div class="input-row" style="margin-top:6px; flex-direction:column; gap:4px">
              <textarea v-model="newComment" class="git-input" rows="2" :placeholder="$t('label.add-comment-placeholder')" />
              <button class="btn-ghost sm" :disabled="!newComment.trim() || isIssueSubmitting" @click="submitComment">{{ $t('git.issue-comment') }}</button>
            </div>
          </template>

          <!-- list view -->
          <template v-else>
            <div v-if="showNewIssue" class="input-row" style="margin-bottom:6px; flex-direction:column; gap:4px">
              <input v-model="newIssueTitle" class="git-input" :placeholder="$t('label.issue-title-placeholder')" />
              <textarea v-model="newIssueBody" class="git-input" rows="3" :placeholder="$t('label.description-optional')" />
              <div class="input-row">
                <button class="btn-ghost sm" :disabled="!newIssueTitle.trim() || isIssueSubmitting" @click="submitNewIssue">{{ $t('git.issue-create') }}</button>
                <button class="btn-ghost sm" @click="showNewIssue = false">{{ $t('action.cancel') }}</button>
              </div>
            </div>
            <div v-if="isLoadingIssues" class="empty-msg" style="padding:2px 0">{{ $t('label.loading') }}</div>
            <div v-else-if="!issues.length" class="empty-msg" style="padding:2px 0">{{ $t('label.no-issues') }}</div>
            <div
              v-for="it in issues" :key="it.number"
              class="generic-row clickable" :class="{ loading: isLoadingDetail }"
              @click="openIssue(it.number)"
            >
              <span class="issue-state-dot" :class="it.state" />
              <div style="flex:1;min-width:0">
                <div class="b-name" v-truncate>#{{ it.number }} {{ it.title }}</div>
                <div class="b-track">
                  {{ it.author }}
                  <span v-for="l in it.labels" :key="l" class="issue-label">{{ l }}</span>
                </div>
              </div>
              <span
                v-if="props.issueHandoffs?.[it.url]"
                class="issue-handoff-badge"
                :class="props.issueHandoffs[it.url].state"
                :title="props.issueHandoffs[it.url].state === 'handling' ? $t('git.pane.issue-handoff-handling') : $t('git.pane.issue-handoff-closed')"
                @click.stop="props.issueHandoffs![it.url].state === 'handling' && emit('focus-pane', props.issueHandoffs![it.url].paneId)"
              >{{ props.issueHandoffs[it.url].state === 'handling' ? '🤖' : '✓' }}</span>
            </div>
          </template>
          <p v-if="issuesError" class="err-text">{{ issuesError }}</p>
        </div>
      </div>

      </div><!-- /part-bottom-cards -->
      </div><!-- /part-bottom -->

    </template>

    <!-- ── Staged section context menu ──────────────────────────────────── -->
    <Teleport to="body">
      <div v-if="stagedSectionMenu.show" class="tp-backdrop" :data-git-pane-menu-owner="menuOwnerId" @click="closeStagedSectionMenu" @contextmenu.prevent="closeStagedSectionMenu" />
      <div v-if="stagedSectionMenu.show" class="ctx-menu" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: stagedSectionMenu.y + 'px', left: stagedSectionMenu.x + 'px' }" @click.stop>
        <button v-if="hasStaged" class="menu-item" @click="doUnstageAll(); closeStagedSectionMenu()">{{ $t('action.unstage-all') }}</button>
      </div>
    </Teleport>

    <!-- ── Changes section context menu ─────────────────────────────────── -->
    <Teleport to="body">
      <div v-if="changesSectionMenu.show" class="tp-backdrop" :data-git-pane-menu-owner="menuOwnerId" @click="closeChangesSectionMenu" @contextmenu.prevent="closeChangesSectionMenu" />
      <div v-if="changesSectionMenu.show" class="ctx-menu" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: changesSectionMenu.y + 'px', left: changesSectionMenu.x + 'px' }" @click.stop>
        <button class="menu-item" @click="openStashPrompt(); closeChangesSectionMenu()">{{ $t('action.save-draft') }}</button>
        <div class="menu-sep" />
        <button v-if="hasChanges" class="menu-item" @click="stageAll(); closeChangesSectionMenu()">{{ $t('action.stage-all') }}</button>
        <button v-if="hasChanges" class="menu-item danger" @click="openDiscardAll(); closeChangesSectionMenu()">{{ $t('action.discard-all') }}</button>
      </div>
    </Teleport>

    <!-- ── File context menu (right-click) ──────────────────────────────── -->
    <Teleport to="body">
      <div v-if="ctxMenu.show" class="tp-backdrop" :data-git-pane-menu-owner="menuOwnerId" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
      <!-- Multi-select menu -->
      <div v-if="ctxMenu.show && selectedKeys.size > 1" class="ctx-menu" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button v-if="selectedChangesPaths.length > 0" class="menu-item" @click="stageSelected(); closeCtxMenu()">{{ $t('action.stage-files', { count: selectedChangesPaths.length }) }}</button>
        <button v-if="selectedStagedPaths.length > 0" class="menu-item" @click="unstageSelected(); closeCtxMenu()">{{ $t('action.unstage-files', { count: selectedStagedPaths.length }) }}</button>
        <button v-if="selectedChangesPaths.length > 0" class="menu-item danger" @click="discardSelected(); closeCtxMenu()">{{ $t('action.discard-files', { count: selectedChangesPaths.length }) }}</button>
      </div>
      <!-- File menu -->
      <div v-else-if="ctxMenu.show && ctxMenu.kind === 'file'" class="ctx-menu" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button class="menu-item" @click="ctxOpenChanges">{{ $t('action.open-changes') }}</button>
        <button class="menu-item" @click="ctxOpenInEditor">{{ $t('action.open-in-editor') }}</button>
        <button class="menu-item" @click="ctxOpenFile">{{ $t('action.open-file-plain') }}</button>
        <button class="menu-item" @click="ctxOpenFileAtHead">{{ $t('action.open-file-head') }}</button>
        <button class="menu-item" @click="ctxStashFile">{{ $t('action.save-file-as-draft') }}</button>
        <div class="menu-sep" />
        <button class="menu-item" @click="ctxStageToggle">{{ ctxMenu.staged ? $t('action.unstage-changes') : $t('action.stage-changes') }}</button>
        <button v-if="!ctxMenu.staged" class="menu-item danger" @click="ctxDiscard">{{ $t('action.discard-changes') }}</button>
        <div v-if="gitBranches.some(x=>!x.is_current)" class="menu-item has-sub danger" @mouseenter="placeSubmenu($event, '.ctx-submenu')">
          <span>{{ $t('action.restore-from-branch') }}</span><span class="sub-caret">▸</span>
          <div class="ctx-submenu">
            <button v-for="b in gitBranches.filter(x=>!x.is_current)" :key="b.name" class="menu-item" @click="ctxRestoreFromBranch(b.name)">{{ b.name }}</button>
          </div>
        </div>
        <div class="menu-sep" />
        <div class="menu-item has-sub" @mouseenter="placeSubmenu($event, '.ctx-submenu')">
          <span>{{ $t('action.add-to-ignore') }}</span><span class="sub-caret">▸</span>
          <div class="ctx-submenu">
            <button class="menu-item" @click="ctxAddToGitignore('project')">{{ $t('git.pane.ignore-target.project') }}</button>
            <button class="menu-item" @click="ctxAddToGitignore('nested')">{{ $t('git.pane.ignore-target.nested') }}</button>
            <button class="menu-item" @click="ctxAddToGitignore('local')">{{ $t('git.pane.ignore-target.local') }}</button>
            <button class="menu-item" @click="ctxAddToGitignore('global')">{{ $t('git.pane.ignore-target.global') }}</button>
          </div>
        </div>
        <button v-if="ctxIsIgnored" class="menu-item" @click="ctxWhyIgnored">{{ $t('action.why-ignored') }}</button>
        <div class="menu-sep" />
        <button class="menu-item" @click="ctxReveal">{{ $t('action.reveal-in-finder') }}</button>
        <button class="menu-item" @click="ctxCopyPath(false)">{{ $t('action.copy-path') }}</button>
        <button class="menu-item" @click="ctxCopyPath(true)">{{ $t('action.copy-relative-path') }}</button>
      </div>

      <!-- Folder menu (applies to all changed files under the folder) -->
      <div v-else-if="ctxMenu.show && ctxMenu.kind === 'folder'" class="ctx-menu" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button v-if="ctxMenu.staged" class="menu-item" @click="ctxFolderUnstage">{{ $t('action.unstage-changes') }}</button>
        <template v-else>
          <button class="menu-item" @click="ctxFolderStage">{{ $t('action.stage-changes') }}</button>
          <button class="menu-item danger" @click="ctxFolderDiscard">{{ $t('action.discard-changes') }}</button>
          <div class="menu-sep" />
          <div class="menu-item has-sub" @mouseenter="placeSubmenu($event, '.ctx-submenu')">
            <span>{{ $t('action.add-to-ignore') }}</span><span class="sub-caret">▸</span>
            <div class="ctx-submenu">
              <button class="menu-item" @click="ctxFolderAddIgnore('project')">{{ $t('git.pane.ignore-target.project') }}</button>
              <button class="menu-item" @click="ctxFolderAddIgnore('nested')">{{ $t('git.pane.ignore-target.nested') }}</button>
              <button class="menu-item" @click="ctxFolderAddIgnore('local')">{{ $t('git.pane.ignore-target.local') }}</button>
              <button class="menu-item" @click="ctxFolderAddIgnore('global')">{{ $t('git.pane.ignore-target.global') }}</button>
            </div>
          </div>
        </template>
        <div class="menu-sep" />
        <button class="menu-item" @click="ctxFolderReveal">{{ $t('action.reveal-in-finder') }}</button>
        <button class="menu-item" @click="ctxFolderCopyPath(false)">{{ $t('action.copy-path') }}</button>
        <button class="menu-item" @click="ctxFolderCopyPath(true)">{{ $t('action.copy-relative-path') }}</button>
      </div>

      <!-- Branch menu -->
      <div v-else-if="ctxMenu.show && ctxMenu.kind === 'branch'" class="ctx-menu" :data-git-pane-menu-owner="menuOwnerId" :style="{ top: ctxMenu.y + 'px', left: ctxMenu.x + 'px' }" @click.stop>
        <button class="menu-item" @click="doMergeInto(ctxMenu.branch)">{{ $t('action.merge-current-into', { branch: ctxMenu.branch }) }}</button>
        <button class="menu-item" @click="doMergeIntoAndPush(ctxMenu.branch)">{{ $t('action.merge-current-into-push', { branch: ctxMenu.branch }) }}</button>
        <div class="menu-sep" />
        <button class="menu-item danger" @click="ctxDeleteBranch">{{ $t('action.delete-branch') }}</button>
      </div>

    </Teleport>

    <!-- ── "Why is this ignored?" verdict ───────────────────────────────── -->
    <Teleport to="body">
      <div v-if="ignoreResult" class="tp-backdrop" @click="ignoreResult = null" />
      <div v-if="ignoreResult" class="ignore-modal" @click.stop>
        <div class="ignore-modal-path" :title="ignoreResult.path">{{ ignoreResult.path }}</div>
        <div class="ignore-modal-text">{{ ignoreResult.text }}</div>
        <button class="btn-ghost sm" @click="ignoreResult = null">{{ $t('action.close') }}</button>
      </div>
    </Teleport>

    <GitCredentialModal
      :show="showCredentialPrompt"
      :prompt="credentialPrompt"
      :account-port="gitAccounts"
      @submit="submitCredential"
      @cancel="cancelCredential"
    />

  </div>
</template>

<style scoped>
/* ── Tokens (GitHub dark) ───────────────────────────────────────────────────── */
.git-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--font-xs);
  user-select: none;
}
/* Independent scroll regions: top (commit + changes) and bottom (history/cards) */
.git-scroll { min-height: 0; overflow-y: auto; }
.part-top { flex-grow: 0; flex-shrink: 0; }
.part-bottom { flex: 1 1 0; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.part-bottom-cards { flex: 1 1 0; overflow-y: auto; min-height: 0; padding-bottom: 20px; }
.spacer { flex: 1; }
.err-text { color: var(--danger-fg); font-size: var(--font-2xs); margin: 0; padding: 2px 12px; }
.git-error-row,
.commit-error-row { display: flex; align-items: flex-start; gap: 6px; }
.git-error-x {
  flex-shrink: 0; margin-left: auto; background: transparent; border: none;
  color: var(--danger-fg); cursor: pointer; font-size: var(--font-2xs); line-height: 1; padding: 0 2px;
}
.git-error-x:hover { color: var(--danger-bright); }
.ok-text  { color: var(--success-fg); font-size: var(--font-2xs); margin: 0; padding: 2px 4px; }
.loading-text { color: var(--text-muted); font-size: var(--font-3xs); padding: 3px 8px; }
.empty-msg { color: var(--text-muted); font-size: var(--font-2xs); font-style: italic; padding: 3px 20px 6px; }
/* A read that failed: the reason, beside whatever the list still shows. */
.read-error { color: var(--danger-fg); font-size: var(--font-2xs); padding: 3px 20px 6px; overflow-wrap: anywhere; }
.w-full { width: 100%; }
.spinner { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Empty state ─────────────────────────────────────────────────────────────── */
.empty-state {
  color: var(--text-muted); font-size: var(--font-2xs); font-style: italic; padding: 16px 12px;
}

/* ── Init panel ─────────────────────────────────────────────────────────────── */
.init-panel,
.status-error-panel {
  display: flex; flex-direction: column; align-items: center;
  gap: 10px; padding: 28px 20px; text-align: center;
}
.init-svg { opacity: 0.8; }
.init-title { font-size: var(--font-sm); font-weight: 600; color: var(--text-bright); }
.init-desc { font-size: var(--font-2xs); color: var(--text-secondary); line-height: 1.6; }
.init-desc code { background: var(--bg-subtle); padding: 1px 5px; border-radius: 3px; font-size: var(--font-3xs); color: var(--accent-bright); }
.clone-box {
  width: 100%; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-muted);
  display: flex; flex-direction: column; gap: 6px;
}
.clone-title { font-size: var(--font-2xs); color: var(--text-secondary); text-align: center; }
.clone-hint { font-size: var(--font-3xs); color: var(--text-muted); margin-bottom: 6px; text-align: center; }
.clone-input {
  width: 100%; box-sizing: border-box; background: var(--bg-base); border: 1px solid var(--border-default);
  border-radius: var(--radius-sm); color: var(--text-primary); font-size: var(--font-2xs); padding: 5px 8px;
}
.clone-input:focus { outline: none; border-color: var(--accent-emphasis); }
.clone-dir-row { display: flex; gap: 6px; }
.clone-dir-row .clone-input { flex: 1; }
.clone-pick { flex-shrink: 0; font-size: var(--font-2xs); }
/* Nested repos discovered by downward scan */
.discovered-box {
  width: 100%; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-muted);
  display: flex; flex-direction: column; gap: 4px;
}
.repo-row {
  display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box;
  background: var(--bg-base); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: var(--font-2xs); padding: 5px 8px; cursor: pointer; text-align: left;
}
.repo-row:hover { border-color: var(--accent-emphasis); background: var(--bg-elevated); }
.repo-icon { flex-shrink: 0; color: var(--text-muted); }
.repo-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-branch { flex-shrink: 0; font-size: var(--font-3xs); color: var(--text-muted); }
/* In-progress operation banner */
.op-banner {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: var(--attention-subtle); border-bottom: 1px solid var(--attention-muted);
  padding: 5px 10px; font-size: var(--font-2xs);
}
.op-text { color: var(--attention-bright); font-weight: 600; text-transform: capitalize; }
.op-abort-btn {
  background: var(--danger-subtle); color: var(--danger-fg); border: 1px solid var(--danger-fg);
  border-radius: var(--radius-xs); font-size: var(--font-2xs); padding: 2px 8px; cursor: pointer; text-transform: capitalize;
}
.op-abort-btn:hover { background: var(--danger-muted); }
.op-banner-conflict { background: var(--attention-subtle); border-bottom-color: var(--attention-muted); }
.op-banner-conflict .op-text { color: var(--warning-fg); }
.op-banner-ready { background: var(--success-subtle); border-bottom-color: var(--success-muted); }
.op-banner-ready .op-text { color: var(--success-fg); font-weight: 600; }
.status-truncated-text { color: var(--attention-bright); }
.op-commit-btn {
  background: var(--success-subtle); color: var(--success-fg); border: 1px solid var(--success-fg);
  border-radius: var(--radius-xs); font-size: var(--font-2xs); padding: 2px 8px; cursor: pointer; margin-left: auto;
}
.op-commit-btn:hover { background: var(--success-muted); }
.btn-primary {
  background: var(--success-emphasis); color: var(--text-on-emphasis); border: 1px solid var(--success-strong);
  border-radius: var(--radius-sm); font-size: var(--font-xs); padding: 5px 10px; cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out);
}
.btn-primary:hover { background: var(--success-strong); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-ghost {
  background: transparent; border: 1px solid var(--border-default); border-radius: var(--radius-xs);
  color: var(--text-secondary); font-size: var(--font-xs); padding: 4px 8px; cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out);
}
.btn-ghost:hover { border-color: var(--border-strong); color: var(--text-primary); }
.btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-ghost.sm { font-size: var(--font-2xs); padding: 3px 7px; }
.btn-ghost.icon-only { display: inline-flex; align-items: center; justify-content: center; padding: 4px 6px; flex: 0 0 auto; }
.btn-danger {
  background: var(--danger-emphasis); border: 1px solid transparent; border-radius: var(--radius-xs);
  color: var(--text-on-emphasis); font-size: var(--font-2xs); padding: 4px 10px; cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out);
}
.btn-danger:hover { background: var(--danger-bright); }
.btn-primary:active:not(:disabled),
.btn-ghost:active:not(:disabled),
.btn-danger:active:not(:disabled) { opacity: 0.8; }
.btn-primary:focus-visible,
.btn-ghost:focus-visible,
.btn-danger:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--accent-focus); }
.btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Panel header ───────────────────────────────────────────────────────────── */
.panel-header {
  display: flex; align-items: center; gap: 2px;
  padding: 1px 6px; border-bottom: 1px solid var(--border-muted);
  min-height: 24px; flex-shrink: 0; z-index: 10;
  background: var(--bg-base);
}
.panel-title {
  font-size: 9px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 1px; color: var(--text-secondary); padding: 0 4px;
}
.hdr-btn {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; background: transparent; border: none;
  border-radius: var(--radius-xs); color: var(--text-muted); cursor: pointer; font-size: var(--font-xs); padding: 0;
}
.hdr-btn:hover { color: var(--text-primary); background: var(--bg-active); }
.hdr-btn.active { color: var(--accent-fg); }
.hdr-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.hdr-btn:active:not(:disabled) { opacity: 0.8; }
.hdr-btn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent-focus); }

/* ── Dropdown menu ──────────────────────────────────────────────────────────── */
.menu-anchor { position: relative; }
.dropdown-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 100;
  background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  padding: 4px; min-width: 170px; box-shadow: 0 8px 24px rgba(1,4,9,0.8);
}
.menu-group-label {
  font-size: 9px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px;
  padding: 4px 8px 2px;
}
.menu-item {
  display: flex; align-items: center; gap: 4px; width: 100%;
  background: transparent; border: none; color: var(--text-primary); font-size: var(--font-xs);
  padding: 5px 8px; border-radius: var(--radius-xs); cursor: pointer; text-align: left;
}
.menu-item:hover { background: var(--bg-active); }
.menu-item:disabled { opacity: 0.4; cursor: not-allowed; }
.menu-item:active:not(:disabled) { opacity: 0.8; }
.menu-item:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent-focus); }
.menu-check { width: 14px; text-align: center; font-size: var(--font-2xs); color: var(--accent-fg); flex-shrink: 0; }
.menu-sep { height: 1px; background: var(--border-muted); margin: 4px 0; }

/* ── Commit area ────────────────────────────────────────────────────────────── */
.commit-area {
  padding: 8px 8px 6px; border-bottom: 1px solid var(--border-muted);
  display: flex; flex-direction: column; gap: 5px;
  position: sticky; top: 0; z-index: 6; background: var(--bg-base);
}
.commit-input-row { display: flex; gap: 5px; align-items: flex-start; }
.commit-input {
  flex: 1; resize: none; background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: var(--radius-sm); color: var(--text-bright); font-size: var(--font-xs); padding: 6px 8px;
  font-family: inherit; line-height: var(--lh-base);
  min-height: 30px; max-height: 160px; overflow-y: auto;
  box-sizing: border-box;
}
.commit-input:focus { outline: none; border-color: var(--accent-focus); }
.commit-input::placeholder { color: var(--text-muted); }
.ai-btn {
  flex-shrink: 0; width: 26px; height: 26px; background: transparent;
  border: 1px solid var(--border-default); border-radius: var(--radius-xs); color: var(--text-muted);
  font-size: var(--font-sm); cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.ai-btn:hover { border-color: var(--accent-fg); color: var(--accent-fg); }
.ai-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.ai-btn.generating { opacity: 1; color: var(--accent-fg); border-color: var(--accent-fg); cursor: progress; }
.ai-btn.generating .spinner { font-size: 15px; }
.ai-btn.auto-active {
  color: var(--accent-fg);
  border-color: var(--accent-fg);
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent-fg) 45%, transparent);
}
.ai-btn.auto-active:not(.generating) span {
  display: inline-block;
  animation: auto-pulse 2.4s ease-in-out infinite;
}
@keyframes auto-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.88); }
}
.auto-pending-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent-fg); margin-left: 4px; flex-shrink: 0;
  animation: auto-pulse 1.2s ease-in-out infinite;
}
.auto-commit-btn { gap: 4px; }
.auto-commit-btn .ac-badge {
  font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
  padding: 1px 5px; border-radius: var(--radius-md); flex-shrink: 0;
  background: var(--border-muted); color: var(--text-muted);
}
.auto-commit-btn.on {
  color: var(--accent-fg);
  background: color-mix(in srgb, var(--accent-fg) 10%, transparent);
}
.auto-commit-btn.on .ac-badge {
  background: color-mix(in srgb, var(--accent-fg) 25%, transparent);
  color: var(--accent-fg);
}
.ac-status-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 12px;
  font-size: var(--font-2xs); color: var(--text-muted);
  background: color-mix(in srgb, var(--accent-fg) 6%, transparent);
  border-top: 1px solid color-mix(in srgb, var(--accent-fg) 18%, transparent);
}
.ac-status-spinner {
  display: inline-block; flex-shrink: 0;
  animation: ac-spin 1s linear infinite;
  color: var(--accent-fg);
}
@keyframes ac-spin { to { transform: rotate(360deg); } }
.ac-status-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
  background: var(--accent-fg);
  animation: auto-pulse 1.6s ease-in-out infinite;
}
.ac-status-label { flex: 1; }
.commit-btn-row { display: flex; gap: 0; }
.commit-main-btn {
  flex: 1; background: var(--success-emphasis); color: var(--text-on-emphasis); border: 1px solid var(--success-strong);
  border-right: none; border-radius: var(--radius-sm) 0 0 5px; font-size: var(--font-xs); font-weight: 500;
  padding: 6px 10px; cursor: pointer; transition: background var(--motion-fast) var(--ease-out);
}
.commit-main-btn:hover { background: var(--success-strong); }
.commit-main-btn:disabled { background: var(--bg-subtle); border-color: var(--border-default); color: var(--text-muted); cursor: not-allowed; }
.commit-arrow-btn {
  background: var(--success-emphasis); color: var(--text-on-emphasis); border: 1px solid var(--success-strong); border-left: 1px solid var(--success-emphasis);
  border-radius: 0 5px 5px 0; font-size: var(--font-2xs); padding: 6px 8px; cursor: pointer;
}
.commit-arrow-btn:hover { background: var(--success-strong); }
.commit-arrow-btn:disabled { background: var(--bg-subtle); border-color: var(--border-default); color: var(--text-muted); cursor: not-allowed; }

/* ── Section headers ────────────────────────────────────────────────────────── */
.sec-hdr {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 8px; min-height: 22px;
}
.sec-hdr.clickable { cursor: pointer; user-select: none; }
.sec-hdr:hover { background: var(--bg-hover-faint); }
.sec-caret { font-size: 9px; color: var(--text-muted); width: 10px; flex-shrink: 0; }
.sec-label {
  font-size: var(--font-2xs); font-weight: 600; color: var(--text-secondary);
  letter-spacing: 0.3px;
}
.sec-badge {
  font-size: var(--font-3xs); color: var(--text-secondary); background: var(--bg-active);
  border-radius: var(--radius-md); padding: 0 6px; flex-shrink: 0;
}
.sec-actions { display: flex; align-items: center; gap: 1px; }
.sec-btn {
  display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; background: transparent; border: none;
  border-radius: var(--radius-xs); color: var(--text-muted); cursor: pointer; font-size: var(--font-xs); padding: 0;
}
.sec-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.sec-btn.danger:hover { color: var(--danger-fg); }
.sec-btn.always { opacity: 1; }
.sec-btn:active:not(:disabled) { opacity: 0.8; }
.sec-btn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent-focus); }

/* ── Section cards (History / Stashes / Remotes / Tags / Worktrees / Config) ─── */
.git-card {
  margin: 6px 8px;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
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

/* ── File rows ──────────────────────────────────────────────────────────────── */
.file-group { padding-bottom: 2px; }

.file-row {
  display: flex; align-items: center; height: 22px;
  padding: 0 8px 0 16px; gap: 0; cursor: default; position: relative;
}
.file-row:hover { background: var(--bg-hover-faint); }
.row-conflict { background: color-mix(in srgb, var(--danger-fg) 5%, transparent) !important; }
.row-selected { background: color-mix(in srgb, var(--accent-fg) 10%, transparent) !important; }
.row-selected:hover { background: color-mix(in srgb, var(--accent-fg) 15%, transparent) !important; }
.selection-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-top: 1px solid color-mix(in srgb, var(--accent-fg) 25%, transparent);
  background: color-mix(in srgb, var(--bg-base) 96%, transparent); flex-shrink: 0; z-index: 2;
}
.sel-count { font-size: var(--font-2xs); color: var(--text-muted); margin-right: 4px; white-space: nowrap; }
.sel-btn {
  font-size: var(--font-2xs); padding: 2px 8px; border-radius: var(--radius-xs); border: 1px solid var(--bg-hover-strong);
  background: var(--bg-hover); color: var(--text-primary); cursor: pointer;
}
.sel-btn:hover { background: var(--bg-hover-strong); }
.sel-btn.primary { border-color: color-mix(in srgb, var(--accent-fg) 40%, transparent); color: var(--accent-fg); }
.sel-btn.primary:hover { background: color-mix(in srgb, var(--accent-fg) 12%, transparent); }
.sel-btn.danger { border-color: color-mix(in srgb, var(--danger-fg) 40%, transparent); color: var(--danger-fg); }
.sel-btn.danger:hover { background: color-mix(in srgb, var(--danger-fg) 12%, transparent); }
.sel-clear { margin-left: auto; opacity: 0.6; }

.file-status {
  flex-shrink: 0; width: 14px; text-align: center;
  font-size: var(--font-2xs); font-weight: 700; margin-right: 5px; color: var(--success-bright);
}
.unstaged-st { color: var(--attention-fg); }
[data-s="D"] { color: var(--danger-fg) !important; }
[data-s="U"] { color: var(--danger-fg) !important; }
[data-s="?"] { color: var(--success-bright) !important; }

.file-name-only {
  font-size: var(--font-xs); color: var(--text-primary); flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}
.file-name-only:hover { color: var(--text-bright); }
.file-name-main {
  font-size: var(--font-xs); color: var(--text-primary); flex-shrink: 0; max-width: 55%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}
.file-name-main:hover { color: var(--text-bright); }
.file-path-dim {
  flex: 1; font-size: var(--font-2xs); color: var(--text-muted); padding-left: 6px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}

.row-actions {
  display: none; align-items: center; gap: 1px; flex-shrink: 0; margin-left: 4px;
}
.file-row:hover .row-actions,
.folder-row:hover .row-actions { display: flex; }
.row-actions.always { display: flex; }
.row-btn {
  display: flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; background: transparent; border: none;
  border-radius: var(--radius-xs); color: var(--text-secondary); font-size: var(--font-2xs); cursor: pointer; padding: 0 2px;
}
.row-btn:hover { color: var(--text-primary); background: var(--bg-active); }
.row-btn.danger:hover { color: var(--danger-fg); }
.row-btn.always { opacity: 1; }
.row-btn:active:not(:disabled) { opacity: 0.8; }
.row-btn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--accent-focus); }
/* Stage = primary action, emphasised and rightmost */
.row-btn.primary { color: var(--accent-fg); font-size: var(--font-sm); font-weight: 700; }
.row-btn.primary:hover { color: var(--text-on-emphasis); background: color-mix(in srgb, var(--accent-focus) 25%, transparent); }
/* Discard = shrunk to avoid accidental clicks */
.row-btn.shrink { min-width: 14px; height: 14px; font-size: 8px; opacity: 0.5; padding: 0; }
.row-btn.shrink:hover { opacity: 1; }

/* ── Folder rows (tree mode) ────────────────────────────────────────────────── */
.folder-row {
  display: flex; align-items: center; height: 22px; gap: 4px;
  padding: 0 8px 0 16px; cursor: pointer;
}
.folder-row:hover { background: var(--bg-hover-faint); }
.folder-caret { font-size: 9px; color: var(--text-muted); width: 10px; flex-shrink: 0; }
.folder-icon { color: var(--text-primary); flex-shrink: 0; }
.folder-name {
  flex: 1; font-size: var(--font-2xs); color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.folder-count {
  font-size: var(--font-3xs); color: var(--text-muted); background: var(--bg-hover);
  border-radius: var(--radius-md); padding: 0 5px; flex-shrink: 0;
}

/* ── Subpanels (file history / blame) ──────────────────────────────────────── */
.subpanel {
  margin: 0 0 2px 30px; border-left: 2px solid var(--border-muted);
  max-height: 130px; overflow-y: auto;
}
.blue-border   { border-left-color: var(--accent-focus) !important; }
.yellow-border { border-left-color: var(--attention-fg) !important; }
.green-border  { border-left-color: var(--success-fg) !important; }
.mini-row {
  display: flex; align-items: center; gap: 6px; padding: 2px 8px; font-size: var(--font-2xs);
}
.mini-msg { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
/* Inline blame — VS Code style: each source line followed by its author/date */
.blame-inline { font-family: var(--font-mono); font-size: var(--font-2xs); overflow-x: auto; padding: 2px 0; }
/* Each row is only as wide as its content (no full-width stretch → no long trailing
   blank on short lines), full content kept, long lines scroll horizontally. */
.blame-line { display: flex; align-items: baseline; line-height: 1.55; width: max-content; }
.blame-ln { color: var(--text-muted); min-width: 34px; text-align: right; padding-right: 12px; flex-shrink: 0; user-select: none; }
.blame-content { color: var(--text-primary); white-space: pre; flex-shrink: 0; }
.blame-annot { color: var(--text-muted); font-style: italic; margin-left: 16px; white-space: nowrap; flex-shrink: 0; }

/* Inline diff-blame — only changed lines, each tagged with last author/date. */
.diffblame-inline { font-family: var(--font-mono); font-size: var(--font-2xs); overflow-x: auto; padding: 2px 0; }
.db-hunk-head { color: var(--accent-bright); font-size: var(--font-3xs); opacity: 0.8; padding: 2px 8px; white-space: pre; }
.db-line { display: flex; align-items: baseline; line-height: var(--lh-base); width: max-content; padding: 0 8px; }
.db-no { color: var(--text-muted); min-width: 30px; text-align: right; padding-right: 8px; flex-shrink: 0; user-select: none; }
.db-sign { width: 10px; flex-shrink: 0; text-align: center; user-select: none; }
.db-code { white-space: pre; flex-shrink: 0; }
.db-annot { color: var(--text-muted); font-style: italic; margin-left: 16px; white-space: nowrap; flex-shrink: 0; }
.db-line.db-add { background: var(--diff-add-bg); }
.db-line.db-add .db-code, .db-line.db-add .db-sign { color: var(--success-bright); }
.db-line.db-del { background: var(--diff-del-bg); }
.db-line.db-del .db-code, .db-line.db-del .db-sign { color: var(--danger-fg); }
.db-line.db-ctx .db-code { color: var(--text-primary); }

/* ── Part divider ───────────────────────────────────────────────────────────── */
.part-resize {
  flex-shrink: 0; height: 7px; cursor: row-resize;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-base);
}
.part-resize-grip {
  height: 1px; width: 100%; background: var(--border-muted);
  transition: background var(--motion-fast) var(--ease-out), height var(--motion-fast) var(--ease-out);
}
.part-resize:hover .part-resize-grip { height: 3px; background: var(--accent-focus); }

/* ── Remote bar ─────────────────────────────────────────────────────────────── */
.remote-bar {
  display: flex; align-items: center; gap: 2px;
  padding: 4px 6px; min-height: 30px; border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0; background: var(--bg-base);
}
.branch-pill {
  display: flex; align-items: center; gap: 5px;
  background: transparent; border: none; color: var(--text-secondary); font-size: var(--font-2xs);
  cursor: pointer; padding: 2px 5px; border-radius: var(--radius-xs); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.branch-pill:hover, .branch-pill.active { color: var(--text-primary); background: var(--bg-hover); }
.ab-text { font-size: var(--font-3xs); color: var(--attention-fg); flex-shrink: 0; }
.remote-btn {
  display: flex; align-items: center; gap: 2px; background: transparent; border: none;
  color: var(--text-muted); font-size: var(--font-xs); cursor: pointer; padding: 3px 5px; border-radius: var(--radius-xs);
  flex-shrink: 0; white-space: nowrap;
}
.remote-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.remote-btn:disabled { opacity: 0.3; cursor: not-allowed; }
.remote-btn.busy { opacity: 1; color: var(--accent-fg); cursor: progress; }
.publish-btn { color: var(--attention-fg); font-size: var(--font-3xs); }
.ahead-num { font-size: 9px; color: var(--attention-fg); font-weight: 700; }
.account-pill { font-size: var(--font-3xs); max-width: 140px; }
.account-pill-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-dropdown .menu-item.active { color: var(--accent-fg); font-weight: 600; }
.tp-dropdown .acct-meta { color: var(--text-muted); font-size: var(--font-3xs); margin-left: 4px; }
.tp-dropdown .menu-empty { padding: 4px 10px; font-size: var(--font-2xs); color: var(--text-muted); }
.tp-dropdown .menu-item.active { color: var(--accent-fg); font-weight: 600; }

/* ── Remote output ──────────────────────────────────────────────────────────── */
.remote-output {
  margin: 4px 8px; background: var(--bg-inset); border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm); padding: 6px 28px 6px 8px; position: relative;
}
.remote-output pre { margin: 0; font-size: var(--font-3xs); color: var(--text-primary); white-space: pre-wrap; max-height: 80px; overflow: auto; }
.err-pre { color: var(--danger-fg) !important; }
.close-btn {
  position: absolute; top: 4px; right: 6px; background: transparent;
  border: none; color: var(--text-muted); font-size: var(--font-3xs); cursor: pointer;
}

/* ── Collapsible body (for inline sections) ─────────────────────────────────── */
.collapsible-body {
  padding: 4px 12px 8px; border-bottom: 1px solid var(--border-muted);
  display: flex; flex-direction: column; gap: 2px;
}

/* ── Branch panel ───────────────────────────────────────────────────────────── */
.branch-row {
  display: flex; align-items: center; gap: 4px;
  padding: 2px 0; font-size: var(--font-2xs); border-radius: 3px;
}
.branch-row:hover { background: var(--bg-hover-faint); }
.branch-row.current .b-name { color: var(--accent-bright); font-weight: 600; }
.b-check { width: 14px; color: var(--success-bright); font-size: var(--font-3xs); text-align: center; flex-shrink: 0; }
.b-name { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.b-track { color: var(--text-muted); font-size: var(--font-3xs); flex-shrink: 0; }
.b-name.remote { color: var(--text-muted); font-style: italic; }
.branch-section-label { font-size: var(--font-3xs); color: var(--text-muted); padding: 4px 0 2px; letter-spacing: 0.04em; text-transform: uppercase; }
.remote-branch-row { opacity: 0.85; }
.remote-branch-row.remote-has-local { opacity: 0.5; }
.remote-branch-row.remote-has-local .b-check { color: var(--success-bright); }
.btn-ghost.active { color: var(--accent-bright); }
.compare-panel {
  margin: 4px 0; background: var(--bg-inset); border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs); padding: 6px 8px; font-size: var(--font-2xs);
}
.compare-title { color: var(--accent-bright); font-weight: 600; margin-bottom: 3px; }
.compare-stat  { color: var(--success-bright); margin-bottom: 2px; }
.compare-file  { color: var(--text-secondary); font-family: monospace; font-size: var(--font-3xs); }
.sub-label { font-size: var(--font-3xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.4px; }

/* ── History / commit graph ─────────────────────────────────────────────────── */
.history-search-row {
  display: flex; align-items: center; gap: 6px; padding: 4px 12px 5px;
}
.search-input {
  flex: 1; background: transparent; border: none;
  border-bottom: 1px solid var(--border-default); color: var(--text-primary); font-size: var(--font-2xs); padding: 2px 0;
}
.search-input:focus { outline: none; border-bottom-color: var(--accent-focus); }
.search-input::placeholder { color: var(--text-muted); }
.history-scope-row {
  display: flex; gap: 4px; padding: 2px 12px 6px;
}
.scope-btn {
  flex: 1; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-secondary); font-size: var(--font-3xs); padding: 3px 6px; cursor: pointer;
}
.scope-btn:hover:not(:disabled) { color: var(--text-bright); border-color: var(--accent-focus); }
.scope-btn.active { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.scope-btn:disabled { opacity: 0.5; cursor: default; }
.commit-list { margin-bottom: 4px; }
.history-load-more { display: flex; justify-content: center; padding: 0 0 6px; }
.load-more-btn {
  background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: var(--font-2xs); padding: 3px 14px; cursor: pointer;
}
.load-more-btn:hover:not(:disabled) { border-color: var(--accent-focus); color: var(--text-bright); }
.load-more-btn:disabled { opacity: 0.5; cursor: default; }
.history-pagination {
  display: flex; align-items: center; justify-content: center;
  gap: 6px; padding: 4px 0 6px;
}
.history-pagination .pg-btn {
  background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: var(--font-sm); line-height: 1; min-width: 26px;
  padding: 3px 8px; cursor: pointer;
}
.history-pagination .pg-btn:hover:not(:disabled) { border-color: var(--accent-focus); color: var(--text-bright); }
.history-pagination .pg-btn:disabled { opacity: 0.3; cursor: default; }
.history-pagination .pg-info { font-size: var(--font-2xs); color: var(--text-secondary); min-width: 40px; text-align: center; }
.commit-row {
  display: flex; align-items: flex-start; gap: 0;
  padding: 0 8px 0 0; cursor: pointer;
}
.commit-row:hover { background: var(--bg-hover-faint); }
.graph-col {
  position: relative; flex-shrink: 0; align-self: stretch; min-height: 28px;
}
.graph-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.graph-dot {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 8px; height: 8px; border-radius: 50%; background: var(--accent-focus);
  border: 2px solid var(--bg-base); box-shadow: 0 0 0 1px currentColor;
}
.graph-dot.head { box-shadow: 0 0 0 1px var(--success-fg), 0 0 4px var(--success-fg); }
.commit-body { flex: 1; min-width: 0; padding: 3px 0; }
.commit-msg {
  font-size: var(--font-2xs); color: var(--text-primary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; line-height: 1.4;
}
.commit-meta {
  display: flex; align-items: center; gap: 3px; margin-top: 1px; flex-wrap: wrap;
}
.chash { font-size: var(--font-3xs); color: var(--text-muted); font-family: monospace; background: transparent; }
.ref-pill {
  font-size: var(--font-3xs); font-weight: 600; padding: 0 5px; border-radius: 999px; line-height: var(--lh-base);
}
.ref-pill.local  { background: var(--accent-muted); color: var(--accent-bright); }
.ref-pill.remote { background: var(--success-subtle); color: var(--success-bright); }
.commit-btns-right { display: flex; align-items: center; gap: 2px; padding: 3px 0; flex-shrink: 0; }
.expand-caret { font-size: 9px; color: var(--text-muted); padding: 0 2px; }

.commit-detail {
  margin: 0 8px 4px 24px; background: var(--bg-inset); border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs); padding: 6px 10px; font-size: var(--font-2xs);
}
.cd-row { display: flex; gap: 8px; margin-bottom: 3px; color: var(--text-primary); }
.cd-key { color: var(--text-muted); min-width: 46px; flex-shrink: 0; }
.cd-body { color: var(--text-secondary); margin: 4px 0; white-space: pre-wrap; font-size: var(--font-3xs); }
.cd-file { color: var(--text-primary); font-family: monospace; font-size: var(--font-3xs); padding: 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cd-file-clickable { cursor: pointer; }
.cd-file-clickable:hover { color: var(--accent, #4a9eff); }
.cd-file-row { display: flex; align-items: center; }
.cd-file-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.cd-open-btn { display: none; min-width: 16px; height: 16px; }
.cd-file-row:hover .cd-open-btn { display: flex; }

/* ── Generic rows (stashes, remotes, tags) ──────────────────────────────────── */
.generic-row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 0; font-size: var(--font-2xs);
}
.generic-row:hover { background: var(--bg-hover-faint); }
.stash-ref { color: var(--text-muted); font-size: var(--font-3xs); flex-shrink: 0; }
.stash-msg { color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remote-name { color: var(--text-muted); font-size: var(--font-3xs); flex-shrink: 0; min-width: 44px; }
.remote-url  { color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-2xs); }
.wt-icon { color: var(--success-bright); font-size: var(--font-2xs); flex-shrink: 0; width: 14px; text-align: center; }
.wt-name-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.wt-name-row .b-name { flex: 0 1 auto; }
.wt-badge {
  font-size: 9px; color: var(--text-secondary); background: var(--bg-active);
  border-radius: var(--radius-md); padding: 0 5px; flex-shrink: 0; white-space: nowrap;
}
.wt-badge.warn { color: var(--danger-fg); }

/* ── Issues (GitHub/GitLab) ─────────────────────────────────────────────────── */
.issue-state-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); }
.issue-state-dot.open { background: var(--success-bright); }
.issue-state-dot.closed { background: var(--accent-purple, #a371f7); }
.issue-label {
  display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: var(--radius-md);
  background: var(--bg-muted); color: var(--text-muted); font-size: 9px; line-height: 14px;
}
.issue-detail-title { font-size: var(--font-xs); color: var(--text-primary); display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.issue-body {
  white-space: pre-wrap; word-break: break-word; font-size: var(--font-2xs); color: var(--text-primary);
  background: var(--bg-muted); border-radius: var(--radius-xs); padding: 6px; margin: 0 0 4px; font-family: inherit;
}
.issue-comment { border-top: 1px solid var(--border-faint, var(--border)); padding-top: 4px; margin-top: 4px; }
.issue-handoff-badge { font-size: var(--font-2xs); flex-shrink: 0; opacity: 0.75; line-height: 1; }
.issue-handoff-badge.handling { cursor: pointer; }
.issue-handoff-badge.handling:hover { opacity: 1; }
.issue-handoff-badge.pane-gone { opacity: 0.45; }
.dispatch-wrap { position: relative; display: inline-block; }
.dispatch-menu {
  position: absolute; top: 100%; right: 0; z-index: 20; margin-top: 2px;
  background: var(--bg-elevated, var(--bg-muted)); border: 1px solid var(--border);
  border-radius: var(--radius-xs); box-shadow: 0 2px 8px rgba(0,0,0,0.25); min-width: 120px; padding: 2px;
}
.dispatch-menu-item {
  display: block; width: 100%; text-align: left; padding: 4px 8px; font-size: var(--font-2xs);
  background: none; border: none; color: var(--text-primary); cursor: pointer; border-radius: 3px;
}
.dispatch-menu-item:hover { background: var(--bg-hover-faint); }

/* ── Config ─────────────────────────────────────────────────────────────────── */
.config-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: var(--font-2xs); }
.config-key { color: var(--text-muted); min-width: 108px; flex-shrink: 0; font-family: monospace; font-size: var(--font-3xs); }
.config-val { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.config-val.clickable { cursor: pointer; border-radius: 3px; padding: 1px 4px; margin: -1px -4px; }
.config-val.clickable:hover { background: var(--bg-muted); color: var(--text-on-emphasis); }
.config-inline-input { flex: 1; min-width: 0; }

/* ── Merge conflict modal ───────────────────────────────────────────────────── */
.merge-conflict-box {
  margin: 4px 8px; background: var(--attention-subtle); border: 1px solid var(--warning-fg);
  border-radius: var(--radius-xs); padding: 8px 10px; font-size: var(--font-2xs);
}
.merge-conflict-box .clean-title { color: var(--warning-fg); }
.merge-conflict-context { color: var(--text-muted); font-size: var(--font-3xs); margin-bottom: 4px; }
.conflict-file { color: var(--warning-fg) !important; opacity: 0.9; }
.merge-conflict-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }

/* ── Danger confirm text (shared by merge-conflict box) ──────────────────────── */
.clean-title { color: var(--danger-fg); font-weight: 600; margin-bottom: 4px; }
.clean-file { color: var(--text-primary); padding: 1px 4px; font-family: monospace; font-size: var(--font-3xs); }
.clean-actions { display: flex; gap: 6px; margin-top: 8px; justify-content: flex-end; }

.stash-box {
  margin: 4px 8px; background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: var(--radius-xs); padding: 8px 10px; font-size: var(--font-2xs);
}
.stash-title { color: var(--text-primary); font-weight: 600; margin-bottom: 6px; }

/* ── Inputs ─────────────────────────────────────────────────────────────────── */
.git-input {
  flex: 1; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-xs);
  color: var(--text-primary); font-size: var(--font-2xs); padding: 3px 7px;
}
.git-input:focus { outline: none; border-color: var(--accent-focus); }
.input-row { display: flex; gap: 4px; }
.check-label { display: flex; align-items: center; gap: 4px; font-size: var(--font-2xs); color: var(--text-secondary); cursor: pointer; }
.check-label input { accent-color: var(--accent-focus); cursor: pointer; }
</style>

<!-- Teleported dropdowns render at body level; must be non-scoped -->
<style>
.tp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
}
.tp-dropdown {
  position: fixed;
  z-index: 9999;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 4px;
  min-width: 170px;
  box-shadow: 0 8px 24px var(--shadow-scrim);
}
.tp-dropdown .menu-group-label {
  font-size: 9px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  padding: 4px 8px 2px;
}
.tp-dropdown .menu-item {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 5px 8px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.tp-dropdown .menu-item:hover { background: var(--bg-active); }
.tp-dropdown .menu-item:disabled { opacity: 0.4; cursor: not-allowed; }
.tp-dropdown .menu-check {
  width: 14px;
  text-align: center;
  font-size: var(--font-2xs);
  color: var(--accent-fg);
  flex-shrink: 0;
}
.tp-dropdown .menu-sep {
  height: 1px;
  background: var(--border-muted);
  margin: 4px 0;
}

/* ── File context menu ─────────────────────────────────────────────────────── */
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 4px;
  min-width: 200px;
  box-shadow: 0 8px 24px var(--shadow-scrim);
}
.ctx-menu .menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 5px 10px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}
.ctx-menu .menu-item:hover { background: var(--bg-active); }
.ctx-menu .menu-item.danger { color: var(--danger-fg); }
.ctx-menu .menu-item.danger:hover { background: var(--diff-del-bg); }
.ctx-menu .menu-sep {
  height: 1px;
  background: var(--border-muted);
  margin: 4px 0;
}
/* Hover submenu (Add to ignore ▸) */
.ctx-menu .menu-item.has-sub { position: relative; justify-content: space-between; }
.ctx-menu .sub-caret { color: var(--text-muted); font-size: var(--font-3xs); }
.ctx-menu .ctx-submenu {
  position: absolute; top: -5px; left: 100%; margin-left: 2px;
  display: none; min-width: 220px;
  background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  padding: 4px; box-shadow: 0 8px 24px var(--shadow-scrim);
}
.ctx-menu .menu-item.has-sub:hover .ctx-submenu { display: block; }
.ctx-menu .menu-item.has-sub[data-sub-place="left"] .ctx-submenu { left: auto; right: 100%; margin-left: 0; margin-right: 2px; }
.ctx-menu .menu-item.has-sub[data-sub-place="below"] .ctx-submenu { top: 100%; left: 0; margin-left: 0; }

/* Ignored file rows — dimmed */
.file-row.ignored-row { opacity: 0.55; }
.file-row.ignored-row .file-status { color: var(--text-muted); width: 14px; text-align: center; }

/* "Why is this ignored?" verdict modal */
.ignore-modal {
  position: fixed; z-index: 10000; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: min(420px, 80vw); background: var(--bg-subtle); border: 1px solid var(--border-default);
  border-radius: var(--radius-md); padding: 16px; box-shadow: 0 12px 32px rgba(1, 4, 9, 0.9);
  display: flex; flex-direction: column; gap: 10px;
}
.ignore-modal-path {
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: var(--font-2xs); color: var(--accent-fg);
  word-break: break-all;
}
.ignore-modal-text { font-size: var(--font-sm); color: var(--text-primary); line-height: var(--lh-base); }
.ignore-modal .btn-ghost { align-self: flex-end; }
</style>
