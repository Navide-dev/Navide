/** The agent_msg.push request, asked again under the same push_id when its
 *  answer is lost.
 *
 *  The backend runs a push to its end even after the window that asked hangs up
 *  or gives up waiting, and keeps the outcome under its push_id. A lost answer
 *  (socket closed, request timed out) therefore says nothing about the pane:
 *  the CLI may well have taken the text. Typing the message in at that point
 *  delivered it twice, so the same push_id is asked again — the backend answers
 *  with the first push's outcome instead of pushing a second time. */

export interface AgentPushAnswer {
  ok?: boolean
  payload?: { ok?: boolean; reason?: string; unclear?: boolean } | null
  error?: { message?: string } | null
}

export type AgentPushSend = (
  type: 'agent_msg.push',
  payload: { pane_id: string; text: string; push_id: string },
) => Promise<AgentPushAnswer>

/** Times the same push_id is asked again after a lost answer. */
export const PUSH_ANSWER_RETRIES = 2

/** The answer to one push, or null when none came back after the retries —
 *  the caller must then treat the text as possibly delivered. */
export async function requestAgentPush(
  send: AgentPushSend,
  paneId: string,
  text: string,
  pushId: string,
  retries = PUSH_ANSWER_RETRIES,
): Promise<AgentPushAnswer | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await send('agent_msg.push', { pane_id: paneId, text, push_id: pushId })
    } catch {
      /* the answer was lost, not the push: ask again under the same id */
    }
  }
  return null
}
