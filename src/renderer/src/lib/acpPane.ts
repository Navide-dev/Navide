// The pure part of an ACP pane: how the backend's acp.* events map onto the
// statuses the rest of the app already speaks, and the transcript the pane
// shows in place of a terminal screen. AcpPane.vue / useAcpSession hold the
// state; App.vue reads it through the shared PaneHandle.

import type { DisplayStatus, TerminalStatus } from '@navide/terminal'

/** acp_sessions' states, plus 'none' before acp.create has answered and
 *  'failed' when it was refused. */
export type AcpState = 'none' | 'starting' | 'idle' | 'running' | 'cancelling' | 'exited' | 'failed'

/** The badge word. 'cancelling' is still busy, so it reads 'running'
 *  (decided 2026-10-23: no new status value). A pending permission request
 *  parks the pane on the user: 'awaiting', for as long as it is open. */
export function acpDisplayStatus(state: AcpState, permissionsPending: number): DisplayStatus {
  if (state === 'exited') return 'exited'
  if (state === 'failed') return 'error'
  if (state === 'none' || state === 'starting') return 'starting'
  if (permissionsPending > 0) return 'awaiting'
  return state === 'idle' ? 'idle' : 'running'
}

/** The process-level status a terminal pane reports as `status`: 'running'
 *  for as long as the agent process is up, whether or not a turn runs. */
export function acpTerminalStatus(state: AcpState): TerminalStatus {
  if (state === 'exited') return 'exited'
  if (state === 'failed') return 'error'
  if (state === 'none' || state === 'starting') return 'starting'
  return 'running'
}

/** App.vue's messaging hold for an ACP pane. The terminal pane's gate reads a
 *  PTY (resume repaint, composer echo, typing in the TUI) and on a pane with no
 *  PTY it would hold forever ('starting'); an ACP pane's own state is exact. */
export function acpMessagingHoldKey(status: DisplayStatus | undefined): string | null {
  if (status === 'idle') return null
  if (status === 'running') return 'mid-turn'
  if (status === 'starting' || status === undefined) return 'starting'
  return 'not-ready'
}

export type TranscriptRole = 'user' | 'agent' | 'thought' | 'tool' | 'notice'

export interface TranscriptEntry {
  role: TranscriptRole
  text: string
  /** A tool call's id, so its later updates land on the same entry. */
  toolCallId?: string
  status?: string
}

export interface PermissionOption {
  optionId: string
  name: string
  kind: string
}

export interface PendingPermission {
  requestId: string
  title: string
  options: PermissionOption[]
}

/** Apply one session/update to the transcript. Consecutive chunks of the same
 *  role join one entry; a tool call is one entry updated in place. Returns the
 *  number of characters of text added (for the pane's activity counter). */
export function applyAcpUpdate(entries: TranscriptEntry[], update: unknown): number {
  if (!update || typeof update !== 'object') return 0
  const u = update as Record<string, unknown>
  const kind = String(u.sessionUpdate ?? '')
  const chunkRole: Record<string, TranscriptRole> = {
    user_message_chunk: 'user',
    agent_message_chunk: 'agent',
    agent_thought_chunk: 'thought',
  }
  if (kind in chunkRole) {
    const text = contentText(u.content)
    if (!text) return 0
    const role = chunkRole[kind]
    const last = entries[entries.length - 1]
    if (last && last.role === role && !last.toolCallId) last.text += text
    else entries.push({ role, text })
    return text.length
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = String(u.toolCallId ?? '')
    const title = typeof u.title === 'string' ? u.title : ''
    const status = typeof u.status === 'string' ? u.status : undefined
    const existing = id ? entries.find((e) => e.toolCallId === id) : undefined
    if (existing) {
      if (title) existing.text = title
      if (status) existing.status = status
      return 0
    }
    entries.push({ role: 'tool', text: title || id, toolCallId: id || undefined, status })
    return (title || id).length
  }
  return 0
}

/** The pane's text in reading order, for everything that reads a pane's
 *  "buffer" (context share, stage summaries, sentinel and question scans). */
export function transcriptText(entries: TranscriptEntry[]): string {
  return entries
    .filter((e) => e.role !== 'thought')
    .map((e) => (e.role === 'user' ? `> ${e.text}` : e.text))
    .join('\n')
}

export function permissionFromEvent(payload: Record<string, unknown>): PendingPermission | null {
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : ''
  if (!requestId) return null
  const toolCall = (payload.toolCall ?? {}) as Record<string, unknown>
  const options = Array.isArray(payload.options) ? payload.options : []
  return {
    requestId,
    title: typeof toolCall.title === 'string' ? toolCall.title : '',
    options: options
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map((o) => ({ optionId: String(o.optionId ?? ''), name: String(o.name ?? o.optionId ?? ''), kind: String(o.kind ?? '') }))
      .filter((o) => o.optionId),
  }
}

function contentText(content: unknown): string {
  if (!content || typeof content !== 'object') return ''
  const c = content as Record<string, unknown>
  return c.type === 'text' && typeof c.text === 'string' ? c.text : ''
}
