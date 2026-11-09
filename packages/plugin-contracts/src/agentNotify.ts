/** A notification from a plugin to one agent pane of its own workspace,
 *  declared with `agentNotify` in `permissions.system` (plan P4, 0.2.40).
 *
 *  It tells the agent something happened (a cloud agent finished, a sign-in
 *  expired); it is never an instruction. The Host fills the sender
 *  (`plugin:<id>`), the pane sees the text between the external-content
 *  boundary lines under a line saying it is data, not instructions, and the
 *  pane is marked as having read third-party content. Nothing goes out until
 *  the user turns on "Notify agent panes" for the plugin in Settings (off by
 *  default); a pane can refuse plugin notifications; a plugin may send at most
 *  `AGENT_NOTIFY_PER_MINUTE` a minute (`RESOURCE_LIMIT` after that). There is
 *  no broadcast. */

/** Longest notification text, in UTF-8 bytes. Plain text; control characters are dropped. */
export const AGENT_NOTIFY_MAX_TEXT_BYTES = 2048
/** Longest optional reference (an id or URL the plugin wants the agent to quote back). */
export const AGENT_NOTIFY_MAX_REF_LENGTH = 200
/** Most notifications one plugin may send in a minute, every pane together. */
export const AGENT_NOTIFY_PER_MINUTE = 6
/** Longest pane name `to` may give. */
export const AGENT_NOTIFY_MAX_TARGET_LENGTH = 128

export interface AgentNotifyParams {
  /** `to`: the name of one agent pane in the plugin's bound workspace. */
  'agentNotify.send': { to: string; text: string; ref?: string }
}

export interface AgentNotifyResults {
  /** Queued: it goes in when the pane is free, like a message between panes. */
  'agentNotify.send': { queued: true }
}
