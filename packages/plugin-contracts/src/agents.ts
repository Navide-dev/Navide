/** Read-only Host data about the agent panes of the plugin's workspace on this
 *  machine. `agents` gives metadata only; message text needs the separately
 *  disclosed `agentMessages` namespace. Session transcripts are not exposed. */
export const AGENTS_CAPABILITY_OPERATIONS = {
  'agents.listPanes': 'list_panes',
  'agents.lineage': 'lineage',
  'agents.listMessages': 'list_messages',
  'agents.listSessions': 'list_sessions',
  'agentMessages.read': 'read_message',
} as const

export type AgentsCapabilityAddress = keyof typeof AGENTS_CAPABILITY_OPERATIONS

/** Most rows one listing returns. */
export const AGENTS_MAX_LIMIT = 200

export interface AgentPaneInfo {
  paneId: string
  name: string
  agentKey: string
  displayStatus: string
  busy: boolean
  realized: boolean
  offline: boolean
  /** Pane id of the pane that opened this one; '' for a root pane. */
  spawnedBy: string
  runGroupId: string
  origin: string
  /** Messaging handle this pane owes a report to; '' when none. */
  reportTo: string
  spawnedAt: string
}

export interface AgentLineageNode {
  paneId: string
  name: string
  parentId: string
  runGroupId: string
  origin: string
  spawnStatus: string
  spawnedAt: string
  removedAt: string
  reportTo: string
  live: boolean
}

export interface AgentMessageInfo {
  id: string
  /** Epoch milliseconds. */
  createdAt: number
  status: string
  sender: string
  recipient: string
  kind: string
  reason: string
  deliveredAt: number | null
  correlationId: string
  replyTo: string
  /** Length of the message text in characters; the text itself is not here. */
  bodyLength: number
}

/** No session id: it is what `--resume` takes, and transcripts stay unreachable. */
export interface AgentSessionInfo {
  agentKey: string
  paneId: string
  paneName: string
  spawnedAt: string
  removedAt: string
  starred: boolean
  spawnedBy: string
  runGroupId: string
  live: boolean
  resumable: boolean
}

export interface AgentsParams {
  'agents.listPanes': Record<string, never>
  'agents.lineage': { includeRemoved?: boolean }
  'agents.listMessages': { paneId?: string; since?: number; limit?: number }
  'agents.listSessions': { limit?: number }
  'agentMessages.read': { id: string }
}

export interface AgentsResults {
  'agents.listPanes': { panes: AgentPaneInfo[] }
  'agents.lineage': { nodes: AgentLineageNode[] }
  'agents.listMessages': {
    messages: AgentMessageInfo[]
    /** Oldest message of this workspace still in the bounded log, or null. */
    oldestCreatedAt: number | null
    truncated: boolean
  }
  'agents.listSessions': { sessions: AgentSessionInfo[] }
  'agentMessages.read': { message: AgentMessageInfo & { body: string } }
}

/** Host events a plugin can subscribe to with `context.events.subscribe`.
 *  Each one is declared individually under `permissions.agents.events` (and
 *  disclosed one by one); all of them also need the `agents` system grant.
 *  Payloads are metadata only: message text stays behind `agentMessages.read`. */
export const AGENTS_EVENTS = [
  'agents.paneCreated',
  'agents.paneClosed',
  'agents.turnEnded',
  'agents.paneIdle',
  'agents.messageReceived',
  'agents.planStageChanged',
  'agents.pipelineNodeChanged',
  'agents.scheduleFired',
] as const

export type AgentsEventAddress = (typeof AGENTS_EVENTS)[number]

export interface AgentsEventPayloads {
  'agents.paneCreated': { paneId: string; name: string; agentKey: string; spawnedBy: string }
  'agents.paneClosed': { paneId: string; name: string }
  'agents.turnEnded': { paneId: string; name: string }
  'agents.paneIdle': { paneId: string; name: string }
  'agents.messageReceived': AgentMessageInfo
  /** relPath is workspace-relative, e.g. `.agent-team/plans/x_1a2b3c.html`. */
  'agents.planStageChanged': { relPath: string; stage: string; previousStage: string }
  /** previousStatus is '' the first time a node reports in a run. */
  'agents.pipelineNodeChanged': { pipelineId: string; nodeId: string; status: string; previousStatus: string }
  'agents.scheduleFired': { jobId: string; name: string; actionKind: string; manual: boolean }
}
