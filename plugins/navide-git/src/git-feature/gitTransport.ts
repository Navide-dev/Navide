/**
 * The private Git feature's transport contract.
 *
 * This is the only transport surface the Git feature may depend on. Its
 * request and event names are the inventory of the current legacy Git
 * consumers; Host, plugin, and test compositions provide implementations.
 */

export type GitTransportStatus = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface GitTransportStatusSource {
  readonly value: GitTransportStatus
}

export interface GitTransportError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface GitTransportResponse<TPayload = unknown> {
  ok: boolean
  payload: TPayload | null
  error: GitTransportError | null
}

/**
 * The version of the Host bridge contract (./gitBridgeContract.json) this
 * package is built against: the git.* requests and events the Host serves
 * navide.git on its first-party bridge.
 */
export const GIT_BRIDGE_VERSION = '1.0.0'

/** Default request deadline preserved from the legacy WebSocket transport. */
export const DEFAULT_GIT_TIMEOUT_MS = 10_000

/** Every request currently issued by the legacy Git consumers. */
export const GIT_REQUEST_TYPES = [
  'git.abort',
  'git.add_remote',
  'git.add_worktree',
  'git.amend',
  'git.apply_patch',
  'git.blame',
  'git.branches',
  'git.check_ignore',
  'git.check_staged',
  'git.checkout_commit',
  'git.checkout_remote_branch',
  'git.cherry_pick',
  'git.clean',
  'git.clone',
  'git.commit',
  'git.commit_file_diff',
  'git.compare_branches',
  'git.config_get',
  'git.config_set',
  'git.conflict_stages',
  'git.connect_to_remote',
  'git.create_branch',
  'git.create_tag',
  'git.credential_cancel',
  'git.credential_submit',
  'git.delete_branch',
  'git.delete_tag',
  'git.diff_blame',
  'git.diff_branches',
  'git.diff_file',
  'git.discard',
  'git.discover_repositories',
  'git.fetch',
  'git.file_log',
  'git.generate_message',
  'git.ignore',
  'git.init',
  'git.list_conflicts',
  'git.lock_worktree',
  'git.log',
  'git.mark_resolved',
  'git.merge',
  'git.merge_into',
  'git.move_worktree',
  'git.prune_worktrees',
  'git.pull',
  'git.pull_rebase',
  'git.push',
  'git.push_force',
  'git.push_upstream',
  'git.rebase',
  'git.remotes',
  'git.remove_remote',
  'git.remove_worktree',
  'git.repair_worktrees',
  'git.reset',
  'git.resolve_ours',
  'git.resolve_theirs',
  'git.restore_from_branch',
  'git.revert',
  'git.show_commit',
  'git.show_file',
  'git.stage',
  'git.stage_all',
  'git.stash',
  'git.stash_apply',
  'git.stash_drop',
  'git.stash_list',
  'git.stash_pop',
  'git.status',
  'git.switch_branch',
  'git.sync',
  'git.tags',
  'git.undo_commit',
  'git.unlock_worktree',
  'git.unstage',
  'git.worktrees',
] as const

export type GitRequestType = (typeof GIT_REQUEST_TYPES)[number]

export const GIT_EVENT_TYPES = [
  'git.changed',
  'git.credential_request',
  'git.credential_cancelled',
] as const

export type GitEventType = (typeof GIT_EVENT_TYPES)[number]

export interface GitTransport {
  readonly status: GitTransportStatusSource
  send<TPayload = unknown>(
    type: GitRequestType,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<GitTransportResponse<TPayload>>
  on(type: GitEventType, callback: (payload: unknown) => void): () => void
}
