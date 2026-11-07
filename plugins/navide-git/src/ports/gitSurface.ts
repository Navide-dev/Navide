import type { GitTransport } from '#git-feature'
import type { InjectionKey } from 'vue'
import type { PortResponse } from '@navide/plugin-ui/shared'
import type { ReactiveValue } from '@navide/plugin-ui/shared'
import type {
  ConflictStages,
  DiscoveredRepo,
  GitBranch,
  GitStatus,
} from '../composables/useGit'
import type {
  Issue,
  IssueComment,
  IssueDetail,
  IssueProviderInfo,
} from '../composables/useIssues'

export interface GitFileReadResult {
  ok: boolean
  content: string
  error?: string
}

export interface GitFileWriteResult {
  ok: boolean
  error?: string
}

export interface GitFileAccessPort {
  readFile(workspacePath: string, relPath: string): Promise<GitFileReadResult>
  writeFile(workspacePath: string, relPath: string, content: string): Promise<GitFileWriteResult>
  readImage(workspacePath: string, relPath: string): Promise<string>
}

export interface GitEditorOpenResult {
  opened: boolean
  error?: string
}

export interface GitWindowUiPort {
  openInEditor(args: {
    workspacePath: string
    filepath: string
    line?: number
  }): Promise<GitEditorOpenResult>
  openExternal(url: string): Promise<void>
  revealPath(path: string): Promise<void>
  pickFolder(defaultPath?: string): Promise<string | null>
}

/** Legacy GitPane actions that open or manipulate Host-owned windows/files. */
export interface GitPaneUiPort {
  openInEditor(args: {
    workspacePath: string
    filepath: string
    line?: number
  }): Promise<void>
  openExternal(url: string): Promise<void>
  revealPath(path: string): Promise<void>
  openPath(path: string): Promise<void>
  openTempFile(name: string, content: string): Promise<void>
  pickWorkspace(defaultPath?: string): Promise<PickedWorkspace | null>
  openMainWindow(workspacePath: string): Promise<void>
  openBranchDiffWindow(workspacePath: string, base: string): Promise<void>
  openGitWindow(args: {
    workspacePath: string
    filepath?: string
    staged?: boolean
    commit?: string
    base?: string
    compare?: string
  }): Promise<void>
  openGitHistoryWindow(workspacePath: string): Promise<void>
}

/** An opaque Host picker grant accompanies the canonical picked path. */
export interface PickedWorkspace {
  path: string
  grant: string
}

/** Host-owned provenance for a workspace selected by the first-party picker. */
export interface GitWorkspaceGrantPort {
  pickWorkspace(defaultPath?: string): Promise<PickedWorkspace | null>
  openWorkspace(selection: PickedWorkspace): Promise<void>
  openKnownWorktree(path: string): Promise<void>
}

/** Read-only compatibility seed owned by the plugin composition root.
 *
 * Domain components only know that a legacy repository selection may exist;
 * request names and backend transport details stay in the adapter. */
export interface LegacyRepoSelectionPort {
  readLegacyRepoSelection(): Promise<string | null>
}

export interface GitBranchDiffPort {
  load(workspacePath: string, base: string, compare: string): Promise<{
    ok: boolean
    diff: string
    error?: string
  }>
}

export interface GitAccountPublic {
  id: string
  label: string
  host: string
  username: string
  tokenLast4: string
}

export interface GitAccountInput {
  label: string
  host: string
  username: string
  token: string
}

export interface GitAccountViewPort {
  accounts: ReactiveValue<GitAccountPublic[]>
  available: ReactiveValue<boolean>
}

export interface GitAccountPort extends GitAccountViewPort {
  refresh(): Promise<void>
  addAccount(input: GitAccountInput): Promise<boolean>
  bind(accountId: string): Promise<boolean>
  unbind(): Promise<boolean>
  getBinding(): Promise<string | null>
}

export type GitCredentialAccountPort = Pick<
  GitAccountPort,
  'accounts' | 'available' | 'refresh' | 'addAccount' | 'bind'
>

export interface IssuePort {
  provider(workspacePath: string): Promise<PortResponse<IssueProviderInfo>>
  list(workspacePath: string, limit: number): Promise<PortResponse<{
    ok: boolean
    provider: string
    issues: Issue[]
    error?: string
  }>>
  get(workspacePath: string, number: number): Promise<PortResponse<{
    ok: boolean
    issue: IssueDetail
    error?: string
  }>>
  create(workspacePath: string, title: string, body: string): Promise<PortResponse<{
    ok: boolean
    url?: string
    error?: string
  }>>
  comment(workspacePath: string, number: number, body: string): Promise<PortResponse<{
    ok: boolean
    error?: string
  }>>
  setState(workspacePath: string, number: number, state: 'open' | 'closed'): Promise<PortResponse<{
    ok: boolean
    error?: string
  }>>
}

export interface GitReviewFinding {
  id: string
  file: string
  line: number | null
  severity: 'critical' | 'warning' | 'suggestion'
  title: string
  body: string
}

export interface GitReviewResult {
  summary: string
  findings: GitReviewFinding[]
  verdict: 'approve' | 'approve_with_comments' | 'request_changes'
}

/** AI code review of the working tree or a branch comparison, run by the
 *  Host's analyzer through the aiCli capability. Provider credentials stay in
 *  Host Settings; this port only starts and stops a review, reads its events
 *  and the provider/model choice. */
export interface GitReviewPort {
  start(args: { mode: 'working' | 'branch'; base?: string; compare?: string }): Promise<string>
  stop(reviewId: string): Promise<void>
  onResult(callback: (reviewId: string, result: GitReviewResult) => void): () => void
  onEnd(callback: (reviewId: string) => void): () => void
  onError(callback: (reviewId: string, message: string) => void): () => void
  getModelPreferences(): Promise<{ provider: string; model: string }>
  setModelPreferences(provider: string, model: string): Promise<void>
  listModels(): Promise<string[]>
}

export interface GitSurfacePorts {
  gitTransport: GitTransport
  fileAccess: GitFileAccessPort
  ui: GitWindowUiPort
  paneUi: GitPaneUiPort
  branchDiff: GitBranchDiffPort
  accounts: GitAccountPort
  issues: IssuePort
}

export const GIT_TRANSPORT_KEY: InjectionKey<GitTransport> = Symbol('git-transport')
export const GIT_FILE_ACCESS_KEY: InjectionKey<GitFileAccessPort> = Symbol('git-file-access')
export const GIT_UI_KEY: InjectionKey<GitWindowUiPort> = Symbol('git-ui')
export const GIT_BRANCH_DIFF_KEY: InjectionKey<GitBranchDiffPort> = Symbol('git-branch-diff')
export const GIT_ACCOUNTS_KEY: InjectionKey<GitAccountPort> = Symbol('git-accounts')
export const GIT_ISSUES_KEY: InjectionKey<IssuePort> = Symbol('git-issues')
export const GIT_REVIEW_KEY: InjectionKey<GitReviewPort> = Symbol('git-review')

// Keep these imports type-only and colocated with the contracts so adapters can
// share the exact feature shapes without exposing a Host transport to the UI.
export type { ConflictStages, DiscoveredRepo, GitBranch, GitStatus, Issue, IssueComment }
