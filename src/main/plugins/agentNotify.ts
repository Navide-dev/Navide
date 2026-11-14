import {
  AGENT_NOTIFY_MAX_REF_LENGTH,
  AGENT_NOTIFY_MAX_TARGET_LENGTH,
  AGENT_NOTIFY_MAX_TEXT_BYTES,
  AGENT_NOTIFY_PER_MINUTE,
} from '../../../packages/plugin-contracts/src/agentNotify'
import { PluginFactoryOptOutStore } from './pluginFactoryOptOutStore'

/**
 * Plan P4 (plugin-comms-security): a plugin's notification to one agent pane
 * of its bound workspace (`agentNotify.send`, the `agent-notify` Bridge port).
 *
 * The Host decides who may send and how often; the backend delivers (it fills
 * the sender `plugin:<id>`, fences the text as external content and marks the
 * pane as having read third-party content). In order:
 *  1. the manifest declares `agentNotify` and the user's Grant holds it (the
 *     broker's usual checks; disclosed as high risk at install);
 *  2. the user turned on "Notify agent panes" for the plugin in Settings
 *     (PluginNotifySwitchStore, off by default);
 *  3. at most AGENT_NOTIFY_PER_MINUTE a minute per plugin (RESOURCE_LIMIT);
 *  4. the backend refuses a pane that refuses plugin notifications, a
 *     terminal, and any pane outside the bound workspace.
 */

export const AGENT_NOTIFY_METHODS = ['agentNotify.send'] as const
/** Operations of the backend Bridge port `agent-notify`; same arguments and result. */
export const AGENT_NOTIFY_BRIDGE_OPERATIONS = ['send'] as const

export type AgentNotifyErrorCode = 'CAPABILITY_DENIED' | 'INVALID_ARGUMENT' | 'RESOURCE_LIMIT' | 'BACKEND_UNAVAILABLE'

/** A refusal with the capability error code the plugin is told. */
export class AgentNotifyError extends Error {
  constructor(readonly code: AgentNotifyErrorCode, message: string) {
    super(message)
    this.name = 'AgentNotifyError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** `{to, text, ref?}`: a pane name, plain text of at most 2 KB in UTF-8, an
 *  optional reference of at most 200 characters. Nothing else. */
export function validateAgentNotifyOperation(operation: string, value: unknown): value is Record<string, unknown> {
  if (operation !== 'send' || !isPlainObject(value)) return false
  if (!Object.keys(value).every((key) => key === 'to' || key === 'text' || key === 'ref')) return false
  const { to, text, ref } = value
  if (typeof to !== 'string' || to.trim().length === 0 || to.length > AGENT_NOTIFY_MAX_TARGET_LENGTH) return false
  if (typeof text !== 'string' || text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > AGENT_NOTIFY_MAX_TEXT_BYTES) return false
  return ref === undefined || (typeof ref === 'string' && ref.length > 0 && ref.length <= AGENT_NOTIFY_MAX_REF_LENGTH)
}

export function validateAgentNotifyRequest(address: string, value: unknown): value is Record<string, unknown> {
  return address === 'agentNotify.send' && validateAgentNotifyOperation('send', value)
}

/** Per plugin, the notifications of the last minute (every pane together). */
export class AgentNotifyLimiter {
  private readonly sent = new Map<string, number[]>()

  constructor(
    private readonly perMinute = AGENT_NOTIFY_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one send; false when the plugin already sent its share this minute. */
  take(pluginId: string): boolean {
    const now = this.now()
    const recent = (this.sent.get(pluginId) ?? []).filter((at) => at > now - 60_000)
    if (recent.length >= this.perMinute) {
      this.sent.set(pluginId, recent)
      return false
    }
    recent.push(now)
    this.sent.set(pluginId, recent)
    return true
  }
}

export const AGENT_NOTIFY_ALLOWED_FILE = '.navide-plugin-notify-allowed.json'

/** The user's per-plugin "Notify agent panes" switch (owner-only id list;
 *  absent, unreadable or malformed reads as off). */
export class PluginNotifySwitchStore extends PluginFactoryOptOutStore {
  constructor(root: string) {
    super(root, AGENT_NOTIFY_ALLOWED_FILE)
  }
}
