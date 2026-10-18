import type { JsonValue } from './index.js'

/** Fixed repository operations. These are request data schemas, not a backend
 * method proxy. Workspace identity, credentials and execution authority are
 * supplied exclusively by the Host. Optional fields retain service defaults. */
export const GIT_OPERATION_FIELDS = {
  abort: { op: 'string' }, add_remote: { name: 'string', url: 'string' },
  add_worktree: { worktree_path: 'string', branch: 'string', new_branch: 'boolean', selectionGrant: 'string' },
  amend: { message: 'string' }, apply_patch: { patch: 'string', reverse: 'boolean', cached: 'boolean' },
  blame: { filepath: 'string' }, branches: {}, check_ignore: { filepath: 'string' }, check_staged: {},
  checkout_commit: { commit_hash: 'string' }, checkout_remote_branch: { remote_ref: 'string' },
  cherry_pick: { commit_hash: 'string' }, clean: { dry_run: 'boolean' },
  clone: { url: 'string', target_dir: 'string', selectionGrant: 'string' },
  commit: { message: 'string', all: 'boolean' }, commit_file_diff: { commit_hash: 'string', filepath: 'string' },
  compare_branches: { base: 'string', compare: 'string' }, config_get: {}, config_set: { key: 'string', value: 'string' },
  conflict_stages: { filepath: 'string' }, connect_to_remote: { url: 'string' },
  create_branch: { name: 'string', switch_to: 'boolean', start_point: 'string' },
  create_tag: { name: 'string', message: 'string', commit_hash: 'string' },
  credential_cancel: { request_id: 'string' }, credential_submit: { request_id: 'string', value: 'string' },
  delete_branch: { name: 'string', force: 'boolean' }, delete_tag: { name: 'string' },
  diff_blame: { filepath: 'string', staged: 'boolean' }, diff_branches: { base: 'string', compare: 'string' },
  diff_file: { filepath: 'string', staged: 'boolean' }, discard: { files: 'strings' },
  discover_repositories: { max_depth: 'number', limit: 'number', force: 'boolean' }, fetch: {},
  file_log: { filepath: 'string', n: 'number' }, generate_message: { model: 'string', attempt_count: 'number' },
  ignore: { pattern: 'string', target: 'string', untrack: 'boolean' }, init: { create_gitignore: 'boolean' },
  list_conflicts: {}, lock_worktree: { worktree_path: 'string', reason: 'string' },
  log: { n: 'number', all: 'boolean', query: 'string', order: 'string' }, mark_resolved: { filepath: 'string' },
  merge: { branch: 'string' }, merge_into: { target: 'string' },
  move_worktree: { worktree_path: 'string', new_path: 'string', selectionGrant: 'string' },
  prune_worktrees: {}, pull: {}, pull_rebase: {}, push: { remote: 'string', branch: 'string' },
  push_force: { remote: 'string', branch: 'string' }, push_upstream: { branch: 'string', remote: 'string' },
  rebase: { branch: 'string' }, remotes: {}, remove_remote: { name: 'string' },
  remove_worktree: { worktree_path: 'string', force: 'boolean' }, repair_worktrees: {},
  reset: { commit: 'string', mode: 'string' }, resolve_ours: { filepath: 'string' }, resolve_theirs: { filepath: 'string' },
  restore_from_branch: { branch: 'string', filepath: 'string' }, revert: { commit_hash: 'string' },
  show_commit: { commit_hash: 'string' }, show_file: { filepath: 'string', rev: 'string' },
  stage: { files: 'strings' }, stage_all: {}, stash: { message: 'string', paths: 'strings' },
  stash_apply: { index: 'number' }, stash_drop: { index: 'number' }, stash_list: {}, stash_pop: { index: 'number' },
  status: { include_ignored: 'boolean' }, switch_branch: { name: 'string' }, sync: {}, tags: {}, undo_commit: {},
  unlock_worktree: { worktree_path: 'string' }, unstage: { files: 'strings' }, worktrees: {},
} as const

type Camel<S extends string> = S extends `${infer First}_${infer Rest}` ? `${Capitalize<First>}${Camel<Rest>}` : Capitalize<S>
export type GitOperation = keyof typeof GIT_OPERATION_FIELDS
export type GitCapabilityMethod<K extends GitOperation = GitOperation> =
  K extends 'generate_message' ? 'aiCli.generateCommitMessage' : `shell.git${Camel<K>}`
type Field<T> = T extends 'string' ? string : T extends 'boolean' ? boolean : T extends 'number' ? number : string[]
export type GitCapabilityParams = {
  [K in GitOperation as GitCapabilityMethod<K>]: {
    [F in keyof typeof GIT_OPERATION_FIELDS[K]]?: Field<typeof GIT_OPERATION_FIELDS[K][F]>
  } & { repositoryPath?: string }
}
export type GitCapabilityResults = { [K in GitCapabilityMethod]: { [key: string]: JsonValue } }

export function gitCapabilityMethod<K extends GitOperation>(operation: K): GitCapabilityMethod<K> {
  return (operation === 'generate_message' ? 'aiCli.generateCommitMessage'
    : `shell.git${operation.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('')}`) as GitCapabilityMethod<K>
}

// A pure call, so a bundler can drop the table when a plugin does not read it
// (an annotated call still keeps side effects it cannot rule out in its arguments).
export const GIT_CAPABILITY_METHODS = /*#__PURE__*/ (() => Object.fromEntries(
  (Object.keys(GIT_OPERATION_FIELDS) as GitOperation[]).map(operation => [gitCapabilityMethod(operation), operation]),
))() as Record<GitCapabilityMethod, GitOperation>
