// Commander WS contract (0.2.51). Mirrors backend/agent_team_backend/
// commander_store.py, commander_service.py and commander_ws.py; keep them in
// step. Timestamps are Unix seconds; 0 means "not yet" (detached_at,
// closed_at, archived_at).

/** The detected state of a pane in a commander's dispatch tree. */
export type CommanderState = 'working' | 'waiting' | 'reported' | 'idle' | 'stalled' | 'gone'

export const COMMANDER_STATES: readonly CommanderState[] = [
  'working', 'waiting', 'reported', 'idle', 'stalled', 'gone',
]

export interface Commander {
  id: string
  name: string
  icon: string
  color: string
  duty: string
  /** Workspace paths; the first one is the main workspace. */
  workspaces: string[]
  agent_key: string
  /** A credential-vault account id, or '' for the CLI default. Never a token. */
  account_id: string
  /** '' means the account's default model. */
  model: string
  skills: string[]
  mcp: string[]
  stall_minutes: number
  created_at: number
  updated_at: number
  archived_at: number
}

export interface CommanderBody {
  commander_id: string
  pane_id: string
  workspace: string
  agent_key: string
  session_id: string
  attached_at: number
  detached_at: number
}

/** A binding or schedule that targets the commander (filled by the bindings work). */
export interface CommanderBindingSummary {
  kind: string
  ref_id: string
  label: string
  target: string
  paused: boolean
}

export interface CommanderSummary extends Commander {
  body: CommanderBody | null
  /** The body's pane is registered right now. */
  body_live: boolean
  bindings: CommanderBindingSummary[]
  /** Open dispatches by detected state. */
  dispatch_counts: Record<CommanderState, number>
}

export interface CommanderTreeNode {
  pane_id: string
  name: string
  opened_by: string
  /** The first 200 characters of the kickoff. */
  task: string
  opened_at: number
  closed_at: number
  state: CommanderState
  children: CommanderTreeNode[]
}

export interface CommanderTree {
  commander_id: string
  /** The commander's current body (pane_id '' when it has none). */
  root: CommanderTreeNode
}

/** Fields create / upgrade_pane / update accept. */
export type CommanderFields = Partial<Pick<Commander,
  'name' | 'icon' | 'color' | 'duty' | 'workspaces' | 'agent_key' | 'account_id' | 'model' | 'skills' | 'mcp'
  | 'stall_minutes'>>

/** Request payload and response of each commander.* message. */
export interface CommanderMessages {
  'commander.list': {
    request: { include_archived?: boolean }
    response: { commanders: CommanderSummary[] }
  }
  'commander.get': {
    request: { id: string }
    response: { commander: CommanderSummary; memory: string; tree: CommanderTree }
  }
  'commander.tree': {
    request: { id: string }
    response: CommanderTree
  }
  /** Main window only. */
  'commander.create': {
    request: CommanderFields & { name: string; pane_id?: string; session_id?: string }
    response: { commander: CommanderSummary }
  }
  /** Main window only. */
  'commander.upgrade_pane': {
    request: CommanderFields & { pane_id: string; session_id?: string }
    response: { commander: CommanderSummary }
  }
  /** Main window only. Restores migrated bindings and archives the commander. */
  'commander.downgrade': {
    request: { id: string }
    response: { id: string }
  }
  /** Main window only. */
  'commander.update': {
    request: { id: string; changes: CommanderFields }
    response: { commander: CommanderSummary }
  }
  /** Main window only. Bindings are paused, not deleted. */
  'commander.archive': {
    request: { id: string }
    response: { id: string }
  }
}

export type CommanderMessageType = keyof CommanderMessages

/** Events broadcast to every main window. */
export interface CommanderEvents {
  /** `commander` is null once archived. */
  'commander.changed': { id: string; commander: CommanderSummary | null }
  'commander.stall': { commander_id: string; pane_id: string; state: CommanderState }
}

/** Error codes the commander.* messages answer with. */
export type CommanderErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST'
