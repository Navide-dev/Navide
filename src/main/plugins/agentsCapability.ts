import {
  AGENTS_CAPABILITY_OPERATIONS,
  AGENTS_MAX_LIMIT,
  type AgentsCapabilityAddress,
} from '../../../packages/plugin-contracts/src/agents'

/** Request contract for the read-only `agents` / `agentMessages` system
 *  namespaces. Validators are strict and fail closed; the backend projects a
 *  fixed field list and the Host supplies the workspace from the binding. */

export const AGENTS_METHODS = Object.keys(AGENTS_CAPABILITY_OPERATIONS) as AgentsCapabilityAddress[]

/** Bridge operations of the `agents` port (metadata) and the
 *  `agent-message-bodies` port (message text), in backend operation names. */
export const AGENTS_BRIDGE_OPERATIONS = ['list_panes', 'lineage', 'list_messages', 'list_sessions'] as const
export const AGENT_MESSAGE_BODIES_BRIDGE_OPERATIONS = ['read_message'] as const

const MAX_ID_LENGTH = 256

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function optionalId(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH)
}

function optionalLimit(value: unknown): boolean {
  return value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= AGENTS_MAX_LIMIT)
}

/** Validate by backend operation name; shared by the view capability and the
 *  Bridge ports so both refuse exactly the same requests. */
export function validateAgentsOperation(operation: string, value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  switch (operation) {
    case 'list_panes':
      return Object.keys(value).length === 0
    case 'lineage':
      return hasOnlyKeys(value, ['includeRemoved']) &&
        (value.includeRemoved === undefined || typeof value.includeRemoved === 'boolean')
    case 'list_messages':
      return hasOnlyKeys(value, ['paneId', 'since', 'limit']) && optionalId(value.paneId) &&
        (value.since === undefined ||
          (typeof value.since === 'number' && Number.isSafeInteger(value.since) && value.since >= 0)) &&
        optionalLimit(value.limit)
    case 'list_sessions':
      return hasOnlyKeys(value, ['limit']) && optionalLimit(value.limit)
    case 'read_message':
      return hasOnlyKeys(value, ['id']) && value.id !== undefined && optionalId(value.id)
  }
  return false
}

export function agentsOperation(address: string): string | null {
  return Object.hasOwn(AGENTS_CAPABILITY_OPERATIONS, address)
    ? AGENTS_CAPABILITY_OPERATIONS[address as AgentsCapabilityAddress]
    : null
}

export function validateAgentsRequest(address: string, value: unknown): value is Record<string, unknown> {
  const operation = agentsOperation(address)
  return operation !== null && validateAgentsOperation(operation, value)
}
