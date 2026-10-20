// Frontend defenses against "ghost" session ids — persisted ids whose
// transcript never materialized on disk (e.g. /clear re-rolled the CLI's real
// id, or the pinned id was never adopted). A ghost id survives restarts as a
// dead pointer: it cannot be resumed, and pre-fix logic both refused to learn
// the real id and minted a NEW ghost on every cold start. The helpers here are
// the pure/testable cores consumed by App.vue.
//
// Only a vendor that can be handed a session id at launch has ghosts at all,
// which is what `pinsSessionIdAtLaunch` in its spec declares — currently just
// Claude, which is why the vocabulary here is shaped by it.

import { AGENT_SPECS } from '@navide/plugin-shell'

/** How the attribution handler should react to a backend-attributed session id. */
export type AttributionAction = 'adopt' | 'verify'

/** Tri-state resumability: true = transcript exists, false = definitively
 *  absent (the backend answered "no"), null = the probe itself failed (RPC
 *  error/timeout) — unknown, NOT absent. */
export type SessionResumability = boolean | null

/** Map an agent.session_exists response to tri-state resumability. A missing
 *  response (the RPC failed) or a malformed payload is "unknown", never
 *  "absent" — callers must not treat a flaky probe as proof of a ghost. */
export function classifySessionExistsResponse(
  resp: { exists?: unknown } | null | undefined
): SessionResumability {
  if (resp?.exists === true) return true
  if (resp?.exists === false) return false
  return null
}

/** Restore routing: attempt --resume unless the transcript is definitively
 * absent. A failed probe is unknown, so retaining the saved resume command is
 * safer than silently replacing the conversation with a fresh process. */
export function shouldAttemptResume(canResume: SessionResumability): boolean {
  return canResume !== false
}

/** Only the first restore-fallback spawn may reuse a saved session id — a
 *  second record carrying the same id would collide on `--session-id`.
 *  Claims are scoped to one restore batch (the caller owns `usedIds`); a
 *  duplicate gets '' so pinFreshSessionAtLaunch mints a new uuid instead. */
export function claimFreshSessionId(usedIds: Set<string>, sessionId: string): string {
  const id = sessionId.trim()
  if (!id || usedIds.has(id)) return ''
  usedIds.add(id)
  return id
}

/** No pinned id (or the same id) is always safe to adopt. A DIFFERENT id may be
 *  attribution mis-routing (an unowned session claimed by a sibling pane in the
 *  same cwd) — never clobber a healthy pinned id blindly; verify the pinned id
 *  is a ghost first (see createGhostHealGate). */
export function classifyAttributedSession(
  pinnedSessionId: string | undefined,
  attributedSessionId: string
): AttributionAction {
  if (!pinnedSessionId || pinnedSessionId === attributedSessionId) return 'adopt'
  return 'verify'
}

export interface GhostHealGate {
  /** Resolves true when the pane's pinned id was verified to have NO transcript
   *  (ghost) and this call won the adoption race. Calls arriving while a check
   *  is in flight resolve false; after one confirmed adoption the pane is
   *  marked healed and every later divergent attribution is refused — first
   *  confirmed adoption wins. */
  shouldAdopt(paneId: string, pinnedSessionId: string): Promise<boolean>
}

/** `pinnedIdHasTranscript` is the tri-state resumability probe
 *  (agent.session_exists): true = transcript exists, false = definitively
 *  absent (ghost), null = probe failed (unknown). Adoption is confirmed only
 *  on a DEFINITIVE false — a failed probe must never justify overwriting a
 *  possibly-healthy pinned id (fail-safe: keep the pin, a later event
 *  re-probes). */
export function createGhostHealGate(
  pinnedIdHasTranscript: (paneId: string, pinnedSessionId: string) => Promise<SessionResumability>
): GhostHealGate {
  const inFlight = new Set<string>()
  const healed = new Set<string>()
  return {
    async shouldAdopt(paneId: string, pinnedSessionId: string): Promise<boolean> {
      if (healed.has(paneId) || inFlight.has(paneId)) return false
      inFlight.add(paneId)
      try {
        if ((await pinnedIdHasTranscript(paneId, pinnedSessionId)) !== false) return false
        if (healed.has(paneId)) return false
        healed.add(paneId)
        return true
      } finally {
        inFlight.delete(paneId)
      }
    },
  }
}

/** Can this vendor be handed a session id at launch? The flag and the
 *  hand-written form are the vendor's own knowledge (`pinsSessionIdAtLaunch`);
 *  everything below is vendor-neutral. */
export function pinsSessionAtLaunch(agentKey: string | undefined): boolean {
  return !!AGENT_SPECS.find((s) => s.agentKey === agentKey)?.pinsSessionIdAtLaunch
}

/** Can a ghost pane of this vendor be repointed at a real session instead of
 *  silently starting over? Requires sessions attributable by cwd, which is why
 *  it is declared per vendor rather than assumed. */
export function supportsGhostReconnect(agentKey: string | undefined): boolean {
  return !!AGENT_SPECS.find((s) => s.agentKey === agentKey)?.supportsGhostReconnect
}

/** Fresh (non-resume) launch pinning — extracted from spawnPane.
 *
 *  `requestedId` lets a restore/rebuild of a NOT-resumable session reuse the
 *  SAME saved id for the fresh spawn: the id has no transcript, so pinning the
 *  old id is valid for a fresh CLI session, cold-start rebuild becomes
 *  idempotent (no ghost-id rotation), and if the user then types, the
 *  transcript materializes under that id so future resumes work. */
export function pinFreshSessionAtLaunch(
  agentKey: string,
  isResume: boolean,
  command: string,
  requestedId: string | undefined,
  generate: () => string
): { command: string; explicitSessionId: string } {
  const pin = AGENT_SPECS.find((s) => s.agentKey === agentKey)?.pinsSessionIdAtLaunch
  if (!pin || isResume) {
    return { command, explicitSessionId: '' }
  }
  if (command.includes(pin.flag)) {
    // Hand-written --session-id: the pane's session IS that id — definitive
    // provenance from the launch command itself. Surface it as the explicit
    // pin so (a) the backend binds session→pane deterministically instead of
    // leaving the pane claimable by the same-cwd first-come heuristic, and
    // (b) the attribution handler sees a pinned id and never blind-adopts a
    // mis-routed sibling session (a pane's session must never be silently
    // replaced). An unparseable form keeps the old no-pin behavior.
    const handwritten = command.match(pin.handwritten)
    return { command, explicitSessionId: handwritten ? handwritten[1] : '' }
  }
  const id = requestedId?.trim() || (pin.generateId ?? generate)()
  return { command: `${command} ${pin.flag} ${id}`, explicitSessionId: id }
}

/** project.set_ui_state persists freshly computed spawn-history/run-group
 *  state; a single cold-start-storm timeout would lose it permanently. */
export function isRetriableUiStateTimeout(type: string, message: string): boolean {
  return type === 'project.set_ui_state' && message.includes('timeout')
}

/** Which UI-state write a set_ui_state payload targets: same workspace + same
 *  state field(s) = same key. Distinct fields (spawn_history vs run_groups vs
 *  active_tab) and distinct workspaces never suppress each other's retries. */
export function uiStateWriteKey(type: string, payload: Record<string, unknown>): string {
  const ws = typeof payload.workspace_path === 'string' ? payload.workspace_path : ''
  const fields = Object.keys(payload).filter((k) => k !== 'workspace_path').sort().join(',')
  return `${type}|${ws}|${fields}`
}

/** Monotonic sequence per UI-state write key. A retried send re-issues its
 *  ORIGINAL snapshot up to seconds later; if a NEWER send for the same key was
 *  issued meanwhile, the stale retry would overwrite it (last-writer-wins).
 *  The guard lets the retry proceed only while it is still the newest write. */
export interface UiStateSeqGuard {
  begin(key: string): number
  isCurrent(key: string, seq: number): boolean
}

export function createUiStateSeqGuard(): UiStateSeqGuard {
  const latest = new Map<string, number>()
  return {
    begin(key: string): number {
      const seq = (latest.get(key) ?? 0) + 1
      latest.set(key, seq)
      return seq
    },
    isCurrent(key: string, seq: number): boolean {
      return latest.get(key) === seq
    },
  }
}

/** Retry project.set_ui_state exactly ONCE after a short delay when the first
 *  attempt times out. Any other request, any other failure, or a second
 *  timeout propagates unchanged — deliberately not a retry framework.
 *  With a `guard`, the retry is DROPPED (original timeout propagates) when a
 *  newer send for the same write key was issued during the delay — a stale
 *  snapshot must never overwrite fresher state. */
export async function sendWithUiStateRetry<T>(
  send: (type: string, payload: Record<string, unknown>) => Promise<T>,
  type: string,
  payload: Record<string, unknown>,
  retryDelayMs = 500,
  guard?: UiStateSeqGuard
): Promise<T> {
  const key = guard && type === 'project.set_ui_state' ? uiStateWriteKey(type, payload) : ''
  const seq = key ? guard!.begin(key) : 0
  try {
    return await send(type, payload)
  } catch (err) {
    if (!isRetriableUiStateTimeout(type, String((err as Error)?.message ?? err))) throw err
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    if (key && !guard!.isCurrent(key, seq)) throw err
    return send(type, payload)
  }
}

export interface ReconnectPane {
  paneId: string
  customName: string
  sessionId: string
}

export interface ReconnectProvenanceEntry {
  paneId: string
  customName?: string
  sessionId?: string
}

/** Prefer pane-id provenance; a name is only a legacy fallback. */
export function reconnectCandidateSessionIds(
  pane: Pick<ReconnectPane, 'paneId' | 'customName'>,
  spawnHistory: ReconnectProvenanceEntry[],
): string[] {
  const byPaneId = spawnHistory.filter((entry) => entry.paneId === pane.paneId)
  const source = byPaneId.length > 0 ? byPaneId : pane.customName
    ? spawnHistory.filter((entry) => (entry.customName ?? '') === pane.customName) : []
  return [...new Set(source.map((entry) => (entry.sessionId ?? '').trim()).filter(Boolean))]
}

/** Resolve only one live, unclaimed provenance candidate for a ghost pane. */
export function resolveDeterministicReconnect(
  pane: ReconnectPane,
  spawnHistory: ReconnectProvenanceEntry[],
  transcriptExists: (sessionId: string) => boolean,
  livePanes: { paneId: string; sessionId: string }[],
): string | null {
  const ownId = pane.sessionId.trim()
  if (ownId && transcriptExists(ownId)) return null
  const claimedElsewhere = new Set(
    livePanes.filter((other) => other.paneId !== pane.paneId).map((other) => other.sessionId.trim()).filter(Boolean),
  )
  const candidates = reconnectCandidateSessionIds(pane, spawnHistory).filter(
    (id) => id !== ownId && transcriptExists(id) && !claimedElsewhere.has(id),
  )
  return candidates.length === 1 ? candidates[0] : null
}

/** A row of workspace.list_orphan_sessions as the backend sends it: the display
 *  name arrives as `custom_name`, while the picker/OrphanSession read `.name`. */
export interface RawOrphanSession {
  session_id: string
  preview?: string[]
  size_bytes?: number
  mtime?: number
  resumable?: boolean
  custom_name?: string
}

/** Normalize a backend orphan row into the picker's OrphanSession shape. The
 *  key fix is `custom_name → name`: casting the response straight to
 *  OrphanSession left `.name` undefined, so every row rendered as "(unnamed)".
 *  Mapping explicitly makes the rename type-checked instead of silently lost. */
export function mapOrphanSession(raw: RawOrphanSession): {
  session_id: string
  preview: string[]
  size_bytes: number
  mtime: number
  resumable: boolean
  name: string
} {
  return {
    session_id: raw.session_id,
    preview: raw.preview ?? [],
    size_bytes: raw.size_bytes ?? 0,
    mtime: raw.mtime ?? 0,
    resumable: raw.resumable ?? false,
    name: raw.custom_name ?? '',
  }
}

/** Post-probe adoption re-check for the ghost-heal path. The gate's probe
 *  awaited the backend, so the world may have moved: the pane can have been
 *  killed/removed, re-pinned, or attributed already. Adopt only when the gate
 *  won, the pane is STILL mounted, it still pins the exact id verified as a
 *  ghost, and the attributed id actually differs. */
export function confirmGhostAdoption(args: {
  gateWon: boolean
  paneStillMounted: boolean
  currentPinnedId: string | undefined
  verifiedPinnedId: string
  attributedId: string
}): boolean {
  return (
    args.gateWon &&
    args.paneStillMounted &&
    args.currentPinnedId === args.verifiedPinnedId &&
    args.verifiedPinnedId !== args.attributedId
  )
}
