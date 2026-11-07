import { randomUUID } from 'node:crypto'

/**
 * Batch 4: agent tools a running view serves (`contributes.agentTools`,
 * contract section 2.9). The Host sends one `plugin:agentTool:call` to the
 * view's bridge (ipc for a surface, the private MessagePort for a frame) and
 * the view answers with one `plugin:agentTool:result` carrying the same
 * `callId`. This class owns the calls in flight: it settles each one on its
 * reply, at its deadline, or when its view goes away, and refuses a reply
 * from any instance but the one the call was sent to.
 */

export const IPC_AGENT_TOOL_CALL = 'plugin:agentTool:call'
export const IPC_AGENT_TOOL_RESULT = 'plugin:agentTool:result'

export interface ViewAgentToolCallPayload {
  callId: string
  name: string
  arguments: Record<string, unknown>
  /** How long the view has, from now, before the Host stops waiting. */
  timeoutMs: number
}

export type ViewAgentToolReply =
  | { callId: string; ok: true; result: unknown }
  | { callId: string; ok: false; error: { code: string; message: string } }

export type ViewAgentToolOutcome =
  | { kind: 'result'; result: unknown }
  /** The view's handler threw or answered an error; `code` is the plugin's own. */
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'timeout' }
  /** The bridge refused the message (the view was already going away). */
  | { kind: 'not-delivered' }
  /** The view was torn down while the call waited. */
  | { kind: 'view-closed' }

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/

/** The exact shape a view may answer with; anything else is ignored. */
export function parseViewAgentToolReply(value: unknown): ViewAgentToolReply | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const reply = value as Record<string, unknown>
  if (typeof reply.callId !== 'string' || reply.callId === '') return null
  if (reply.ok === true) {
    if (!('result' in reply) || Object.keys(reply).length !== 3) return null
    return { callId: reply.callId, ok: true, result: reply.result }
  }
  if (reply.ok !== false || Object.keys(reply).length !== 3) return null
  const error = reply.error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return null
  const { code, message } = error as Record<string, unknown>
  if (typeof code !== 'string' || !CODE.test(code) || typeof message !== 'string') return null
  return { callId: reply.callId, ok: false, error: { code, message: message.slice(0, 2000) } }
}

interface Pending {
  instanceId: string
  settle: (outcome: ViewAgentToolOutcome) => void
}

export class ViewAgentToolCalls {
  private readonly pending = new Map<string, Pending>()

  /** Send one call to a view and wait for its reply until `deadline` (epoch ms). */
  call(
    instanceId: string,
    send: (payload: ViewAgentToolCallPayload) => boolean,
    name: string,
    args: Record<string, unknown>,
    deadline: number,
  ): Promise<ViewAgentToolOutcome> {
    const callId = randomUUID()
    const timeoutMs = Math.max(1, deadline - Date.now())
    return new Promise<ViewAgentToolOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (outcome: ViewAgentToolOutcome): void => {
        if (!this.pending.delete(callId)) return
        if (timer) clearTimeout(timer)
        resolve(outcome)
      }
      this.pending.set(callId, { instanceId, settle })
      if (!send({ callId, name, arguments: args, timeoutMs })) {
        settle({ kind: 'not-delivered' })
        return
      }
      timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs)
      timer.unref?.()
    })
  }

  /** A reply from `instanceId`; false when it answers no call of that instance. */
  resolve(instanceId: string, value: unknown): boolean {
    const reply = parseViewAgentToolReply(value)
    if (!reply) return false
    const pending = this.pending.get(reply.callId)
    if (!pending || pending.instanceId !== instanceId) return false
    pending.settle(reply.ok ? { kind: 'result', result: reply.result } : { kind: 'failed', ...reply.error })
    return true
  }

  /** The view is gone: every call waiting on it fails now, not at its deadline. */
  cancelInstance(instanceId: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.instanceId === instanceId) pending.settle({ kind: 'view-closed' })
    }
  }

  inFlight(): number {
    return this.pending.size
  }
}
