import type { Issue, IssueDetail, IssueHandlerMode, IssueProvider } from '../lib/issueDispatch'

export interface GitContributionState {
  workspacePath: string
  analyzerModel: string
  dispatchTargets: { id: string; label: string }[]
  availableAgents: { key: string; label: string }[]
  issueHandoffs: Record<string, { paneId: string; mode: string; state: string }>
}

export const HOST_GIT_COMMAND_IDS = [
  'controlPane.selectSidebarTab1',
  'controlPane.selectSidebarTab2',
  'controlPane.selectSidebarTab3',
  'controlPane.selectSidebarTab4',
  'controlPane.selectSidebarTab5',
  'workbench.action.focusSourceControl',
  'workbench.action.openGitWindow',
] as const

export type HostGitCommandId = typeof HOST_GIT_COMMAND_IDS[number]

export type GitContributionAction =
  | { operation: 'open_path'; path: string }
  | { operation: 'open_temp_file'; name: string; content: string }
  | { operation: 'open_main_window'; workspace_path: string }
  | { operation: 'open_branch_diff_window'; workspace_path: string; base: string }
  | { operation: 'open_git_window'; workspace_path: string; filepath?: string; staged?: boolean; commit?: string; base?: string; compare?: string }
  | { operation: 'open_git_history_window'; workspace_path: string }
  | { operation: 'changes_count'; count: number }
  | { operation: 'open_workspace'; path: string }
  | { operation: 'open_file'; payload: { workspace_path: string; filepath: string; name: string } }
  | { operation: 'open_conflict'; payload: { workspace_path: string; filepath: string; name: string } }
  | { operation: 'open_diff'; payload: { workspace_path: string; filepath: string; staged: boolean; name: string; commit?: string } }
  | { operation: 'open_branch_diff'; payload: { workspace_path: string; base: string; compare: string } }
  | { operation: 'dispatch_issue'; payload: { paneId: string; issue: IssueDetail } }
  | { operation: 'spawn_for_issue'; payload: { agentKey: string; mode: IssueHandlerMode; issue: Issue; provider: IssueProvider } }
  | { operation: 'focus_pane'; paneId: string }
  | { operation: 'open_git_accounts' }
  | { operation: 'execute_host_command'; command: HostGitCommandId }

export interface GitContributionActionEnvelope {
  operation: string
  payload?: Record<string, unknown>
}

const NESTED_PAYLOAD_OPERATIONS = new Set([
  'open_file',
  'open_conflict',
  'open_diff',
  'open_branch_diff',
  'dispatch_issue',
  'spawn_for_issue',
])

/** Convert the Host envelope back to the legacy event shape consumed by App. */
export function normalizeGitContributionAction(
  envelope: GitContributionActionEnvelope,
): GitContributionAction {
  if (NESTED_PAYLOAD_OPERATIONS.has(envelope.operation)) {
    return { operation: envelope.operation, payload: envelope.payload } as GitContributionAction
  }
  return { operation: envelope.operation, ...(envelope.payload ?? {}) } as GitContributionAction
}
