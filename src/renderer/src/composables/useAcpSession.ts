// One ACP pane's session with the backend (acp.* requests and events; see
// backend/agent_team_backend/acp_ws.py). Holds what the pane shows — the
// transcript, the pending permission requests, the agent's state — and the
// clocks App.vue reads through the PaneHandle.
//
// No PTY: nothing here types into a terminal. A prompt is one acp.prompt
// request; the backend queues it behind a running turn.

import { computed, reactive, ref } from 'vue'
import type { WsResponse } from '../../../shared/wsClient'
import {
  acpDisplayStatus,
  acpTerminalStatus,
  applyAcpUpdate,
  permissionFromEvent,
  transcriptText,
  type AcpState,
  type PendingPermission,
  type TranscriptEntry,
} from '../lib/acpPane'

/** The slice of the backend client an ACP pane needs (useBackend's send/on). */
export interface AcpPort {
  send<T = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<WsResponse<T>>
  on(type: string, cb: (payload: unknown) => void): () => void
}

const ACP_EVENTS = [
  'acp.state', 'acp.update', 'acp.permission', 'acp.permission_closed', 'acp.turn_end', 'acp.exit',
] as const

// Starting an agent can take a first npx download; the backend bounds nothing
// here either, so the request waits as long as a cold start may take.
const CREATE_TIMEOUT_MS = 330_000

export function useAcpSession(paneId: string, port: AcpPort) {
  const state = ref<AcpState>('none')
  const sessionId = ref('') // the backend's ACP session id (acp.* requests)
  const queued = ref(0)
  const transcript = reactive<TranscriptEntry[]>([])
  const permissions = reactive<PendingPermission[]>([])
  const error = ref('')
  const exitCode = ref<number | null>(null)
  const stderrTail = ref('')
  const textSeen = ref(0) // monotonic: characters ever added to the transcript
  const lastActivityAt = ref(0)
  const startingStartedAt = ref<number | null>(null)
  const turnEndedAt = ref(0)

  const displayStatus = computed(() => acpDisplayStatus(state.value, permissions.length))
  const status = computed(() => acpTerminalStatus(state.value))
  const text = computed(() => transcriptText(transcript))

  let creating: Promise<void> | null = null
  let killRequested = false
  let firstOutputSeen = false
  const firstOutputListeners: Array<() => void> = []

  function mine(payload: unknown): Record<string, unknown> | null {
    if (!payload || typeof payload !== 'object') return null
    const p = payload as Record<string, unknown>
    if (sessionId.value ? p.session_id !== sessionId.value : p.pane_id !== paneId) return null
    return p
  }

  function touch(): void {
    lastActivityAt.value = Date.now()
    if (!firstOutputSeen) {
      firstOutputSeen = true
      for (const listener of firstOutputListeners) listener()
    }
  }

  const disposers = ACP_EVENTS.map((type) => port.on(type, (raw) => {
    const p = mine(raw)
    if (!p) return
    if (type === 'acp.state') {
      const next = String(p.state ?? '') as AcpState
      if (next) state.value = next
      queued.value = Number(p.queued ?? 0) || 0
      if (next === 'idle') touch()
    } else if (type === 'acp.update') {
      const added = applyAcpUpdate(transcript, p.update)
      if (added > 0) textSeen.value += added
      touch()
    } else if (type === 'acp.permission') {
      const request = permissionFromEvent(p)
      if (request && !permissions.some((r) => r.requestId === request.requestId)) permissions.push(request)
      touch()
    } else if (type === 'acp.permission_closed') {
      const index = permissions.findIndex((r) => r.requestId === p.request_id)
      if (index >= 0) permissions.splice(index, 1)
    } else if (type === 'acp.turn_end') {
      turnEndedAt.value = Date.now()
      const failure = typeof p.error === 'string' ? p.error : ''
      if (failure) transcript.push({ role: 'notice', parts: [failure] })
    } else if (type === 'acp.exit') {
      exitCode.value = typeof p.code === 'number' ? p.code : null
      stderrTail.value = typeof p.stderr_tail === 'string' ? p.stderr_tail : ''
      state.value = 'exited'
      permissions.splice(0, permissions.length)
    }
  }))

  /** Start the agent (acp.create). Resolves once it is idle or has failed. */
  async function create(opts: { agentKey: string; cwd: string; outputLogFile?: string }): Promise<void> {
    if (creating) return creating
    state.value = 'starting'
    startingStartedAt.value = Date.now()
    creating = (async () => {
      try {
        const reply = await port.send<{ session?: { session_id?: string; state?: string } }>(
          'acp.create',
          {
            pane_id: paneId, agent_key: opts.agentKey, cwd: opts.cwd,
            // The pane's output log (Agent History, cli_read_log): the backend appends the transcript.
            ...(opts.outputLogFile ? { output_log_file: opts.outputLogFile } : {}),
          },
          CREATE_TIMEOUT_MS,
        )
        if (!reply.ok || !reply.payload?.session?.session_id) {
          // Closed while starting: the backend abandoned this start on purpose.
          if (killRequested) {
            state.value = 'exited'
            return
          }
          state.value = 'failed'
          error.value = reply.error?.message ?? 'the ACP agent could not be started'
          stderrTail.value = String(reply.error?.details?.stderr_tail ?? '')
          return
        }
        sessionId.value = reply.payload.session.session_id
        state.value = (reply.payload.session.state as AcpState) || 'idle'
        if (killRequested) await kill()
      } catch (err) {
        state.value = 'failed'
        error.value = String(err)
      } finally {
        startingStartedAt.value = null
      }
    })()
    return creating
  }

  /** Send one prompt: "sent", "queued" behind the running turn, or "" when refused. */
  async function prompt(textToSend: string): Promise<'sent' | 'queued' | ''> {
    if (!sessionId.value || !textToSend) return ''
    transcript.push({ role: 'user', parts: [textToSend] })
    // The reactive copy of what was just pushed, so marking it re-renders.
    const entry = transcript[transcript.length - 1]
    let status: 'sent' | 'queued' | '' = ''
    try {
      const reply = await port.send<{ status?: 'sent' | 'queued' }>('acp.prompt', { session_id: sessionId.value, text: textToSend })
      status = reply.ok ? (reply.payload?.status ?? '') : ''
    } catch {
      status = ''
    }
    // Refused, or never answered: it must not read as sent.
    if (!status) entry.unsent = true
    return status
  }

  async function cancel(): Promise<boolean> {
    if (!sessionId.value) return false
    const reply = await port.send<{ cancel_sent?: boolean }>('acp.cancel', { session_id: sessionId.value })
    return !!(reply.ok && reply.payload?.cancel_sent)
  }

  async function answer(requestId: string, optionId: string | null): Promise<boolean> {
    if (!sessionId.value) return false
    const reply = await port.send<{ answered?: boolean }>(
      'acp.permission_answer', { session_id: sessionId.value, request_id: requestId, option_id: optionId },
    )
    return !!(reply.ok && reply.payload?.answered)
  }

  /** Stop the agent. A kill while it is still starting takes effect at once:
   *  the backend abandons the start by pane id (a cold start can take minutes,
   *  and closing the pane must not wait for it), stopping whatever it had
   *  started; should the start still answer with a session, that is stopped too. */
  async function kill(): Promise<void> {
    if (!sessionId.value) {
      killRequested = true
      if (!creating) return
      state.value = 'exited'
      await port.send('acp.kill', { pane_id: paneId }).catch(() => {})
      return
    }
    killRequested = true
    const id = sessionId.value
    await port.send('acp.kill', { session_id: id })
    state.value = 'exited'
  }

  function dispose(): void {
    for (const off of disposers) off()
  }

  function onFirstOutput(listener: () => void): void {
    firstOutputListeners.push(listener)
  }

  return {
    state, sessionId, queued, transcript, permissions, error, exitCode, stderrTail,
    textSeen, lastActivityAt, startingStartedAt, turnEndedAt, displayStatus, status, text,
    create, prompt, cancel, answer, kill, dispose, onFirstOutput,
  }
}
