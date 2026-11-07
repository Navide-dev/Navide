import {
  AGENTS_EVENTS,
  type AgentsEventAddress,
} from '../../../packages/plugin-contracts/src/agents'

/** The backend's `plugins.host_event` frame (backend/agent_team_backend/
 *  plugin_host_events.py): one Host event for the plugins of one workspace.
 *  Validated strictly and fail closed, so a field the backend should never
 *  send (message text, a session id) is dropped with the whole frame instead
 *  of reaching a plugin. */
export const HOST_AGENT_EVENT_TYPE = 'plugins.host_event'

export interface HostAgentEvent {
  event: AgentsEventAddress
  workspacePath: string
  payload: Record<string, string | number | boolean | null>
}

type FieldType = 'string' | 'number' | 'boolean' | 'number|null'

const PANE = { paneId: 'string', name: 'string' } as const

/** Exact payload fields per event; pinned against capabilities-v1.json. */
export const AGENTS_EVENT_FIELDS: Record<AgentsEventAddress, Record<string, FieldType>> = {
  'agents.paneCreated': { ...PANE, agentKey: 'string', spawnedBy: 'string' },
  'agents.paneClosed': PANE,
  'agents.turnEnded': PANE,
  'agents.paneIdle': PANE,
  'agents.messageReceived': {
    id: 'string', createdAt: 'number', status: 'string', sender: 'string', recipient: 'string',
    kind: 'string', reason: 'string', deliveredAt: 'number|null', correlationId: 'string',
    replyTo: 'string', bodyLength: 'number',
  },
  'agents.planStageChanged': { relPath: 'string', stage: 'string', previousStage: 'string' },
  'agents.pipelineNodeChanged': {
    pipelineId: 'string', nodeId: 'string', status: 'string', previousStatus: 'string',
  },
  'agents.scheduleFired': { jobId: 'string', name: 'string', actionKind: 'string', manual: 'boolean' },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function fieldMatches(type: FieldType, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    case 'number|null': return value === null || fieldMatches('number', value)
  }
}

export function isAgentsEvent(value: unknown): value is AgentsEventAddress {
  return typeof value === 'string' && (AGENTS_EVENTS as readonly string[]).includes(value)
}

/** Parse one frame payload, or null when anything about it is off. */
export function parseHostAgentEvent(frame: unknown): HostAgentEvent | null {
  if (!isPlainObject(frame)) return null
  const keys = Object.keys(frame)
  if (keys.length !== 3 || !keys.every(key => ['event', 'workspace_path', 'payload'].includes(key))) return null
  const { event, workspace_path: workspacePath, payload } = frame
  if (!isAgentsEvent(event) || typeof workspacePath !== 'string' || workspacePath.length === 0) return null
  if (!isPlainObject(payload)) return null
  const fields = AGENTS_EVENT_FIELDS[event]
  const payloadKeys = Object.keys(payload)
  if (payloadKeys.length !== Object.keys(fields).length) return null
  for (const key of payloadKeys) {
    const type = fields[key]
    if (type === undefined || !fieldMatches(type, payload[key])) return null
  }
  return { event, workspacePath, payload: payload as HostAgentEvent['payload'] }
}
