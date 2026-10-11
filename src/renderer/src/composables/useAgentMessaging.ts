import { readonly, ref } from 'vue'
import {
  renderEnvelope,
  renderFailureNotice,
  renderStaleNotice,
  reasonToEnglish,
  holdToEnglish,
  defaultMessagingName,
  isChannelTarget,
  isQualifiedTarget,
  normalizeMessagingName,
  uniqueMessagingName,
  PUSH_UNCLEAR_LIMIT,
} from '../lib/agentMessaging'
import { normalizeForMatch, TAIL_MATCH_LEN } from '../lib/injectEcho'

/**
 * Inter-CLI messaging: pane name registry + per-target delivery queue.
 *
 * Singleton module-level state (same pattern as useNotify). App.vue configures
 * the runtime deps (deliver/isPaneIdle) once at mount via configureMessaging();
 * unit tests inject fakes and call _resetMessagingForTest().
 *
 * Delivery discipline: one in-flight injection per target pane, only when the
 * pane is idle, FIFO per target. Loop guards: per sender→target rate limit,
 * per-target queue cap, global pause switch. A message that has not been taken
 * off its queue yet can still be withdrawn — see cancelMessage().
 */

export type MessageStatus = 'queued' | 'delivering' | 'delivered' | 'failed' | 'cancelled'

/**
 * Why a message is still sitting in `queued`. `key` is an i18n key suffix the
 * log panel renders as `msg.hold-<key>`; `n` is its only parameter (the number
 * of messages ahead of this one). Transient by design — it describes a live
 * gate, so it is never persisted and never restored.
 */
export interface MessageHold {
  key: string
  n?: number
}

/**
 * Why a message failed. `key` is an i18n key suffix the log panel renders as
 * `msg.reason-<key>`, with `params` as its substitutions.
 *
 * `raw` is the escape hatch for text this app did not author — an exception
 * message, or an error from a backend old enough not to send a code — and
 * renders the text verbatim.
 */
export interface MessageReason {
  key: string
  params?: Record<string, string | number>
}

export function rawReason(text: string): MessageReason {
  return { key: 'raw', params: { text } }
}

/** Reasons cross a process boundary twice — the log store and the delivery
 *  report to another window — and both carry text, so they travel as JSON. */
export function encodeReason(reason: MessageReason): string {
  return JSON.stringify(reason)
}

/** The inverse, and the compatibility path: a row written before reasons were
 *  structured holds a plain English sentence, which decodes to `raw`. */
export function decodeReason(encoded: string | undefined | null): MessageReason | undefined {
  if (!encoded) return undefined
  try {
    const parsed = JSON.parse(encoded)
    if (parsed && typeof parsed === 'object' && typeof parsed.key === 'string') {
      return parsed as MessageReason
    }
  } catch {
    /* not JSON — a pre-structured reason, handled below */
  }
  return rawReason(encoded)
}

export interface AgentMessage {
  id: number
  /** Persistence key, `${bootUid}:${id}`. `id` is a module counter that restarts
   *  at 0 on every reload and is shared-by-value across windows, so only this is
   *  safe as a key in the (global) backend store. */
  uid: string
  from: string
  to: string
  /** Which CLI vendor each side is (an `agentKey`), captured when the message
   *  was sent. Snapshotted rather than looked up on render: a pane can be
   *  renamed, closed, or rebuilt onto a different CLI, and the log has to keep
   *  showing who actually took part. Absent for a sender outside any pane (an
   *  external MCP client) and for rows restored from before this was stored. */
  fromAgent?: string
  toAgent?: string
  /** Raw (unsanitized) content, for display in the log panel. */
  content: string
  status: MessageStatus
  /** 'notice' marks a message Navide wrote itself (delivery-failure feedback to
   *  a sending pane) rather than one an agent sent. It stops a bounced notice
   *  from producing another one, and it is what the log panel reads to suppress
   *  Resend — so unlike `hold` it is persisted: after a reload the panel must
   *  still know what a row is without parsing its text.
   *
   *  'ack' marks a message that is logged and never delivered: a bare
   *  acknowledgement ("got it", "done") the user may want to read in the log,
   *  but that must not interrupt the recipient. It is the only kind that never
   *  enters a queue, so nothing is ever typed into the recipient's pane. */
  kind?: 'notice' | 'fallback' | 'ack'
  /** Failure reason when status === 'failed'. */
  reason?: MessageReason
  /** Why this message has not been injected yet, while status === 'queued'. */
  hold?: MessageHold
  /** Set once the sender has been told this message is still held, so it is
   *  told once and not every second. In-memory only, like `hold`: a restored
   *  row is not queued any more and has nothing left to warn about. */
  staleNotified?: true
  /** Set on a message that reached its pane without being typed in: `hook` for
   *  a claude Stop hook that was handed it as its next instruction, `read` for
   *  a recipient that asked for it itself (the `cli_read_incoming` MCP tool),
   *  `push:<kind>` for one of the vendor push channels. Like `hold` it is
   *  in-memory only: it describes how a live row got out, and a restored log has
   *  no delivery left to explain.
   *
   *  'ack' is the odd one out: it records that the message deliberately never
   *  went out at all. The row is settled and correct — an 'ack' kind is only
   *  ever logged — so this says how it was settled, not how it was typed in.
   *  'channel' is a reply to a chat sender, left for the backend to post. */
  route?: 'hook' | 'read' | 'ack' | 'channel' | `push:${string}`
  /** Set when the receiving panel typed the message in after giving up waiting
   *  for its CLI to go quiet (the 'delivered-while-busy' delivery reason): it
   *  arrived, but mid-turn. In-memory only, like `route`. */
  deliveredWhileBusy?: true
  /** `uid` of the message this one answers, set when the sender echoed back the
   *  correlation id carried in that message's envelope. Persisted (`reply_to`):
   *  a recipient reading its own mail over MCP has to be able to see what a
   *  message answers, and unlike `hold` the link does not stop being true when
   *  the row stops being live. */
  inReplyTo?: string
  /** The routing key both ends of this message know it by — `<paneId>:<seq>` for
   *  a window-to-window send, `<paneId>:mcp:<hex>` for one from `cli_send`. It
   *  is the correlation id the envelope hands out, so it is also what a reply
   *  echoes back in `re:`.
   *
   *  Absent for a message between two panes of THIS window: nothing routes it,
   *  so no such key is ever minted, and both ends already share this row. Never
   *  invent one — the whole value of the field is that the sender's `msg_key`
   *  and the recipient's copy are the same string. */
  correlationId?: string
  createdAt: number
  deliveredAt?: number
  /** Set when the message crossed a workspace boundary. 'outbound' entries live
   *  in the sending window and are resolved by a delivery report; 'inbound'
   *  entries live in the receiving window and are delivered locally. */
  remote?: 'outbound' | 'inbound'
  /** The other workspace involved, for display in the log panel. */
  remoteWorkspace?: string
}

/** A log row as the backend store holds it (snake_case DB columns; `from`/`to`
 *  are reserved-ish words in SQL, hence `sender`/`recipient`). */
export interface PersistedMessageRow {
  uid: string
  created_at: number
  status: MessageStatus
  sender: string
  recipient: string
  content: string
  /** JSON-encoded MessageReason; see encodeReason(). */
  reason?: string
  delivered_at?: number
  remote?: 'outbound' | 'inbound'
  remote_workspace?: string
  sender_agent?: string
  recipient_agent?: string
  /** See AgentMessage.kind. Absent on rows written before the column existed,
   *  which is exactly right — every one of them is an ordinary message. */
  kind?: 'notice' | 'fallback' | 'ack'
  /** See AgentMessage.inReplyTo — the `uid` of the row this one answers. */
  reply_to?: string
  /** See AgentMessage.correlationId. */
  correlation_id?: string
}

/** A status patch for an already-persisted row. */
export interface PersistedMessageUpdate {
  uid: string
  status?: MessageStatus
  /** JSON-encoded MessageReason; see encodeReason(). */
  reason?: string
  delivered_at?: number
}

/**
 * How a push attempt ended.
 *
 * The distinction that matters is the last one. Some channels write the CLI's
 * composer, and a failure after that write leaves the envelope sitting in it:
 * typing the same message in on top would submit it twice over, concatenated.
 * So an 'unclear' push is not retried in the same breath — the message goes
 * back to the head of its queue and the next pump decides again, by which time
 * the pane has either sent what it was holding or been cleared.
 *
 * - `landed`   — the CLI took it; nothing further to do.
 * - `declined` — the channel did not take it and touched nothing. Safe to type
 *                the message in right away.
 * - `unclear`  — the channel may be holding the text. Re-queue, never type.
 */
export type PushOutcome = 'landed' | 'declined' | 'unclear'

export interface RouteResult {
  ok: boolean
  /** The backend's English sentence, kept as the fallback when it sends no
   *  code (an older backend). */
  error?: string
  /** Machine code for the same failure, resolved against `msg.reason-*`. */
  errorCode?: string
  errorParams?: Record<string, string | number>
  targetDisplay?: string
  targetWorkspacePath?: string
  /** The resolved target's CLI vendor, which only the backend registry knows
   *  for a pane in another window. */
  targetAgentKey?: string
}

export interface MessagingDeps {
  now: () => number
  /** Inject text into a pane; resolves true when the injection verified OK.
   *  `shouldAbort` turns true when the user withdraws the message while the
   *  pane's PTY is holding it unread (see cancelMessage); an injection that
   *  honours it clears what it wrote and resolves false. */
  /** true: typed. false: did not arrive. null: put it back at the head of the
   *  queue, nothing spent. `{ failed }`: refused for good, with the reason the
   *  sender is told (a terminal command the backend will not type).
   *  `{ unconfirmed }`: typed and submitted, but the CLI has not shown it
   *  received it — see UNCONFIRMED_REASON. */
  deliver: (paneId: string, text: string, shouldAbort?: () => boolean) =>
    Promise<boolean | null | { failed: MessageReason } | { unconfirmed: true }>
  /** True when the pane can accept an injection right now (idle + settled). */
  isPaneIdle: (paneId: string) => boolean
  /** Why isPaneIdle() said no, as an i18n key suffix under `msg.hold-*`. Must
   *  be derived from the same gate as isPaneIdle so the log cannot claim a
   *  reason the gate does not actually apply. Absent → a generic 'busy'. */
  idleHoldKey?: (paneId: string) => string | null
  /** Why the head message must not be typed into this pane at all, checked
   *  once the gate is open (so it sees the pane as it will be typed into), or
   *  null. A refusal fails the message instead of holding it — waiting would
   *  not change the answer. Today: a multi-line command for a plain terminal
   *  whose shell has no bracketed paste. */
  refuseDelivery?: (paneId: string, envelope: string) => MessageReason | null
  /** The push channel that could take a message for this pane right now, or
   *  null when there is none — the vendor has no channel, it is not armed, or
   *  the gates that channel still answers to are closed. Non-null is what lets
   *  a message skip isPaneIdle(), so the caller must have applied whichever
   *  gates that channel does keep. */
  pushTarget?: (paneId: string) => { kind: string } | null
  /** Hand the envelope to that channel. See {@link PushOutcome} — anything but
   *  'landed' ends in the typed path, immediately or on a later tick. */
  pushDeliver?: (paneId: string, text: string) => Promise<PushOutcome>
  /** Ask the backend registry to route a target this window does not own.
   *  Absent (or throwing) → cross-workspace addressing degrades to the previous
   *  local-only behaviour. */
  routeRemote?: (args: {
    fromPaneId: string
    fromName: string
    to: string
    content: string
    msgKey: string
    /** Correlation id this message is answering, echoed back to the window that
     *  handed it out. Absent for a message that starts a thread. */
    replyTo?: string
  }) => Promise<RouteResult>
  /** Tell the sending window how an inbound cross-workspace message ended.
   *  The caller serializes; see encodeReason(). */
  reportDelivery?: (msgKey: string, ok: boolean, reason: MessageReason | null) => void
  /** Ask the window that owns the target's queue to drop a message this window
   *  sent. The answer comes back over the ordinary delivery-report path, so a
   *  window that is gone (or a message already on its way in) simply leaves the
   *  row as it was. Rejecting means the request never left this machine. */
  requestRemoteCancel?: (msgKey: string) => Promise<unknown> | void
  /** Tell the backend why a tracked message has not gone out yet, so an MCP
   *  caller can read the hold this panel shows. Called only when a message's
   *  hold KEY changes — never on the per-second re-annotation. */
  reportHold?: (msgKey: string, hold: MessageHold | null) => void
  /** Mirror the log into the backend store. All three are optional — without
   *  them the log stays in-memory only, exactly as it was before. The caller
   *  batches; these are called once per row/transition. */
  persistAppend?: (rows: PersistedMessageRow[]) => void
  persistUpdate?: (updates: PersistedMessageUpdate[]) => void
  persistClear?: (keepStatuses: MessageStatus[]) => void
}

export const RATE_LIMIT_MAX = 5
export const RATE_LIMIT_WINDOW_MS = 60_000
export const QUEUE_CAP = 10
const LOG_CAP = 500
/** Backstop for an outbound cross-workspace message whose target window never
 *  reports back (window killed mid-queue, machine slept). Deliberately long: the
 *  receiving pane may legitimately stay busy for a long turn before its queue
 *  drains, and every orderly outcome — delivered, injection failed, pane closed,
 *  queue full — is reported explicitly well before this fires. */
const REMOTE_ACK_TIMEOUT_MS = 30 * 60_000
/** How long a correlation id handed out in an envelope stays linkable. Same
 *  window as the remote-ack backstop: long enough for a slow turn to answer,
 *  short enough that the table cannot grow for the life of the session. */
const CORRELATION_TTL_MS = REMOTE_ACK_TIMEOUT_MS
/** How long a message may stay queued before its sender is told it is stuck.
 *  Matches the backend's _STALE_HOLD_S, which answers the same question for an
 *  MCP caller (cli_check_message's `stale`). The two clocks start a round trip
 *  apart — the row is created here, the backend entry when the send reaches it —
 *  and nothing compares them, so they need to agree on the threshold and not on
 *  the moment. */
export const STALE_HOLD_MS = 120_000
/**
 * How long a reserveIncoming() reservation may stay open before the queue takes
 * its message back.
 *
 * This is not a guard against losing a message — the two-phase protocol already
 * covers that, since an unsettled row never leaves its queue. It guards against
 * the pane going permanently DEAF: a reserved head stops pumpPane() and
 * drainForHook() from touching that queue, so a reservation that is never
 * settled would silently end delivery to that pane for the life of the window,
 * with no error and nothing in the UI to show for it. Nothing else expires it —
 * expireStaleRemotes() only covers OUTBOUND messages awaiting another window's
 * report.
 *
 * Sized off the RPC that settles it: `ui.invoke` gives an ordinary action 15s
 * (the backend's `_UI_INVOKE_TIMEOUT_S`), so double that leaves an answer that
 * is merely slow room to arrive. The trade-off runs both ways and neither side
 * is free — expire too late and the pane stays deaf for longer; expire too
 * early and a settle still in flight loses its race against the next pump,
 * which would hand the same message over twice.
 */
export const READ_RESERVE_TIMEOUT_MS = 30_000

const RATE_LIMIT_REASON: MessageReason = {
  key: 'rate-limit',
  params: { max: RATE_LIMIT_MAX, seconds: RATE_LIMIT_WINDOW_MS / 1000 },
}
const QUEUE_FULL_REASON: MessageReason = { key: 'queue-full', params: { cap: QUEUE_CAP } }

/** A plain shell pane's agentKey. A message to one is typed in verbatim and
 *  run as a command line, so it gets no envelope, no reply hint and no
 *  correlation id — every extra line would be executed by the shell. */
export const TERMINAL_AGENT_KEY = 'terminal'
/** Navide's own text (a delivery-failure notice, a fallback report) is prose
 *  for an agent to read; typed into a shell it would run as a command. */
const TERMINAL_NOTICE_REASON = rawReason('a Navide notice is never typed into a plain terminal pane — the shell would run it')
/** Content from outside this machine's user (a chat channel, a remote device)
 *  would run as the user's own shell command in a terminal. */
/** A command held that long is no longer the one the sender meant to run now:
 *  typing it once the shell frees up, perhaps hours later, would surprise the
 *  user at the keyboard — so it fails and the sender decides again. */
const TERMINAL_STALE_REASON = rawReason('not typed: the terminal stayed busy for 2 minutes — a held command is never run late; resend it if it still applies')
const TERMINAL_EXTERNAL_REASON = rawReason('external content is never typed into a plain terminal pane — the shell would run it')

/** Handle Navide writes its own messages under — delivery-failure notices here,
 *  SPAWN feedback in App.vue. Reserved rather than merely unregistered: a pane
 *  answering to it would share the feedback rate-limit budget, and paneIdOf()
 *  would hand Navide's own notices to that pane instead of failing. */
export const NOTICE_SENDER = 'Navide'
/** Verdict for an outbound message the receiving window never answered for.
 *  See expireStaleRemotes(). */
const NO_REPORT_REASON: MessageReason = { key: 'no-report' }

/** Reserved `to:` keywords that fan a message out to every other pane instead
 *  of a single named target. `all` (case-insensitive) or `*`. */
export function isBroadcastTarget(to: string): boolean {
  const t = to.trim().toLowerCase()
  return t === 'all' || t === '*'
}

/** Reason written onto rows that were still in flight when the window died. */
const HYDRATE_LOST_REASON: MessageReason = { key: 'window-reloaded' }
/** Verdict reported back for a message the sender withdrew. Travels the same
 *  reportDelivery path as a failure, and the sending window reads the key to
 *  land its own row on `cancelled` rather than `failed`. */
const CANCELLED_REASON: MessageReason = { key: 'cancelled' }
/** Reason on a message that was typed and submitted into a CLI that never
 *  showed it received it (a just-resumed one; see App's deliverAgentMessage).
 *  The row reads `delivered` with this caveat rather than `failed`: it may well
 *  be running, and a failure invites the resend that would run it twice. Sent
 *  back with ok=false so the backend can tell it apart, and followed by an ok
 *  report if the transcript shows the message later (confirmDelivery). */
const UNCONFIRMED_REASON: MessageReason = { key: 'delivery-unconfirmed' }
/** Verdict reported back for a message the RECIPIENT took itself, by reading it
 *  through `cli_read_incoming` instead of waiting for it to be typed in.
 *
 *  Deliberately paired with `ok: true`, unlike {@link CANCELLED_REASON}. The
 *  message did arrive — an agent asked for it and got the text — so reporting a
 *  failure would leave the sender's row on `failed` and invite it to send the
 *  same instruction again, which is the one thing `cli_send` warns about. The
 *  reason rides along only to say HOW it arrived; every consumer of a positive
 *  report ignores it (see resolveRemoteDelivery). */
export const READ_REASON: MessageReason = { key: 'read' }
/** Verdict reported back for a message that was logged and never delivered.
 *
 *  Paired with `ok: true`, like {@link READ_REASON}: an ack did not fail, it
 *  was deliberately never typed into the recipient. The sender's
 *  cli_check_message would otherwise sit on `queued` forever and read as
 *  stuck. */
export const ACK_REASON: MessageReason = { key: 'ack' }

// ── Module-level singleton state ──────────────────────────────────────────
let deps: MessagingDeps | null = null
let seq = 0

function newBootUid(): string {
  const c = globalThis.crypto
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(8))
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return Math.random().toString(16).slice(2, 18)
}

/** Per-boot prefix that makes `uid` unique across windows and reloads. */
let bootUid = newBootUid()

function nextMessageKeys(): { id: number; uid: string } {
  const id = ++seq
  return { id, uid: `${bootUid}:${id}` }
}

function toPersistedRow(m: AgentMessage): PersistedMessageRow {
  return {
    uid: m.uid,
    created_at: m.createdAt,
    status: m.status,
    sender: m.from,
    recipient: m.to,
    content: m.content,
    reason: m.reason ? encodeReason(m.reason) : undefined,
    delivered_at: m.deliveredAt,
    remote: m.remote,
    remote_workspace: m.remoteWorkspace,
    sender_agent: m.fromAgent,
    recipient_agent: m.toAgent,
    kind: m.kind,
    reply_to: m.inReplyTo,
    correlation_id: m.correlationId,
  }
}

function fromPersistedRow(row: PersistedMessageRow): AgentMessage {
  // A restored row keeps its persisted uid but takes a fresh local id: the
  // in-memory side maps are keyed by id and must stay collision-free.
  const m: AgentMessage = {
    id: ++seq,
    uid: String(row.uid),
    from: String(row.sender ?? ''),
    to: String(row.recipient ?? ''),
    content: String(row.content ?? ''),
    status: row.status,
    createdAt: Number(row.created_at) || 0,
  }
  if (row.reason) m.reason = decodeReason(row.reason)
  if (row.delivered_at != null) m.deliveredAt = row.delivered_at
  if (row.remote) m.remote = row.remote
  if (row.remote_workspace) m.remoteWorkspace = row.remote_workspace
  if (row.sender_agent) m.fromAgent = row.sender_agent
  if (row.recipient_agent) m.toAgent = row.recipient_agent
  if (row.kind === 'notice' || row.kind === 'fallback' || row.kind === 'ack') m.kind = row.kind
  if (row.reply_to) m.inReplyTo = row.reply_to
  if (row.correlation_id) m.correlationId = row.correlation_id
  return m
}

const messages = ref<AgentMessage[]>([])
const paused = ref(false)

const nameByPane = new Map<string, string>()
const paneByName = new Map<string, string>()
/** Each registered pane's CLI vendor (agentKey), for stamping messages. */
const agentByPane = new Map<string, string>()
/** FIFO of message ids per target paneId. */
const queues = new Map<string, number[]>()
/** Target paneIds with an injection currently in flight. */
const delivering = new Set<string>()
/** Envelope text per message id (not shown in the log panel). */
const envelopes = new Map<number, string>()
/** Enqueue timestamps per `${from}→${to}` pair, for rate limiting. */
const pairSends = new Map<string, number[]>()
/** msgKeys this window has already accepted, newest last. The backend
 *  broadcasts each routed message exactly once, but a window holding two
 *  sockets (a connect() race) hears every broadcast twice — and each copy
 *  would otherwise become its own queued row, injected back to back. */
const acceptedMsgKeys = new Set<string>()
const ACCEPTED_MSG_KEYS_CAP = 500
/** Outbound cross-workspace messages awaiting a delivery report, by msgKey. */
const remoteOutbound = new Map<string, { id: number; sentAt: number }>()
/** Inbound cross-workspace messages to report back on, message id → msgKey. */
const remoteInbound = new Map<number, string>()
/** Messages delivered here with UNCONFIRMED_REASON, by id: the pane they went
 *  into, and the msgKey to report the confirmation back on (absent for one sent
 *  from this window, whose row is the sender's own). */
const unconfirmedDeliveries = new Map<number, { paneId: string; msgKey?: string }>()
/** Outbound messages another window reported unconfirmed, by msgKey, so its
 *  later confirmation can still find the row. */
const unconfirmedOutbound = new Map<string, number>()
/** Message ids by the correlation id their envelope handed out, so a reply that
 *  echoes one back can be linked to the message it answers. Populated wherever
 *  an envelope is rendered; pruned by expireCorrelations(). */
const correlations = new Map<string, { id: number; sentAt: number }>()
/** Messages a recipient has reserved but not yet consumed, by message id. See
 *  reserveIncoming(); `reservedAt` is what expireReadReservations() reads. */
const readReserved = new Map<number, { paneId: string; reservedAt: number }>()
/** Messages withdrawn while `delivering` on a `pty-blocked` hold — the one
 *  in-flight state a cancel can still reach, because the pane has not read
 *  the text yet. The injection polls this and clears what it wrote. */
const cancelRequested = new Set<number>()
/** How many times each queued message's push has come back `unclear`, by
 *  message id. Compared against {@link PUSH_UNCLEAR_LIMIT} in pumpPane();
 *  cleared when the message gets out or leaves the queue. */
const pushUnclearCount = new Map<number, number>()

function configureMessaging(d: MessagingDeps): void {
  deps = d
}

// ── Name registry ──────────────────────────────────────────────────────────
/** Whether a handle claims {@link NOTICE_SENDER}. Case-insensitive: the point
 *  is that no pane answers to the name Navide speaks under, and `navide` reads
 *  as that name to everyone involved. */
function isReservedName(name: string): boolean {
  return name.toLowerCase() === NOTICE_SENDER.toLowerCase()
}

/** A free handle for `base`. The reserved handle counts as taken even though no
 *  pane holds it, so claiming it takes a suffix exactly like colliding with
 *  another pane does. */
function uniqueHandle(base: string): string {
  return uniqueMessagingName(isReservedName(base) ? `${base}-2` : base, paneByName.keys())
}

function registerPane(paneId: string, agentKey: string, preferredName?: string): string {
  const existing = nameByPane.get(paneId)
  if (existing) return existing
  // A requested handle (persisted name / pane title) keeps its base and only
  // gains a -N suffix on collision; with no valid request, use <agent>-N.
  const base = preferredName ? normalizeMessagingName(preferredName) : null
  const name = base ? uniqueHandle(base) : defaultMessagingName(agentKey, paneByName.keys())
  nameByPane.set(paneId, name)
  paneByName.set(name, paneId)
  agentByPane.set(paneId, agentKey)
  return name
}

/** The CLI vendor behind a handle, or undefined when it is not a local pane. */
function agentOfName(name: string): string | undefined {
  const paneId = paneByName.get(name)
  return paneId ? agentByPane.get(paneId) : undefined
}

/** Re-derive a pane's handle from a new base (its title). Collision-suffixed;
 *  an empty/invalid base falls back to the `<agent>-N` default. Returns the new
 *  handle, or null when the pane is not in the registry (plain terminal). */
function setDerivedName(paneId: string, base: string | null, agentKey: string): string | null {
  const current = nameByPane.get(paneId)
  if (current === undefined) return null
  // Free the current name first so the base can reclaim it (or take a suffix
  // relative to OTHER panes only).
  paneByName.delete(current)
  const norm = base ? normalizeMessagingName(base) : null
  const name = norm ? uniqueHandle(norm) : defaultMessagingName(agentKey, paneByName.keys())
  nameByPane.set(paneId, name)
  paneByName.set(name, paneId)
  return name
}

function renamePane(paneId: string, rawName: string): boolean {
  const name = normalizeMessagingName(rawName)
  if (!name) return false
  const current = nameByPane.get(paneId)
  if (name === current) return true
  // Rejected rather than suffixed: a manual rename is an explicit choice, and
  // the caller already handles a refusal by asking for another name.
  if (isReservedName(name) || paneByName.has(name)) return false
  if (current) paneByName.delete(current)
  nameByPane.set(paneId, name)
  paneByName.set(name, paneId)
  return true
}

function unregisterPane(paneId: string): void {
  const q = queues.get(paneId) ?? []
  for (const id of q) {
    failMessage(id, { key: 'pane-closed' })
    // Undelivered cross-workspace messages must not leave the sending window
    // waiting for a report that will never come.
    ackInbound(id, false, { key: 'pane-closed' })
    // Including anything reserved for a read: the queue is going away, so the
    // reservation has nothing left to hold and no settle to wait for.
    readReserved.delete(id)
  }
  queues.delete(paneId)
  delivering.delete(paneId)
  for (const [id, entry] of unconfirmedDeliveries) {
    if (entry.paneId === paneId) unconfirmedDeliveries.delete(id)
  }
  const name = nameByPane.get(paneId)
  if (name) paneByName.delete(name)
  nameByPane.delete(paneId)
  agentByPane.delete(paneId)
}

/** Move a pane's undelivered messages onto the id that replaces it. Opening a
 *  restore placeholder (and rebuilding a pane) spawns the replacement under a
 *  fresh id and then releases the old one through unregisterPane, which fails
 *  whatever is still queued as 'pane-closed' — so a message cli_send promised
 *  would wait for the pane to be opened was lost the moment it was. Call this
 *  before that release. A head already being injected into the old pane stays
 *  where it is: that attempt finishes against the pane it started on. */
function handOverQueue(fromPaneId: string, toPaneId: string): void {
  if (!fromPaneId || !toPaneId || fromPaneId === toPaneId) return
  const q = queues.get(fromPaneId)
  if (!q || q.length === 0) return
  const kept = delivering.has(fromPaneId) ? q.slice(0, 1) : []
  const moved = q.slice(kept.length)
  if (moved.length === 0) return
  for (const id of moved) {
    const reserved = readReserved.get(id)
    if (reserved) reserved.paneId = toPaneId
  }
  queues.set(toPaneId, [...(queues.get(toPaneId) ?? []), ...moved])
  if (kept.length) queues.set(fromPaneId, kept)
  else queues.delete(fromPaneId)
}

function nameOf(paneId: string): string | null {
  return nameByPane.get(paneId) ?? null
}

function paneIdOf(name: string): string | null {
  return paneByName.get(name) ?? null
}

/** A free handle near `base` (base itself, or `base-2`, `base-3`…). Used to
 *  pre-fill the collision-resolution prompt on a manual rename. */
function suggestName(base: string): string {
  return uniqueHandle(base)
}

// ── Queue ──────────────────────────────────────────────────────────────────
function findMessage(id: number): AgentMessage | undefined {
  return messages.value.find((m) => m.id === id)
}

function failMessage(id: number, reason: MessageReason): void {
  const m = findMessage(id)
  if (m && m.status !== 'delivered') {
    m.status = 'failed'
    m.reason = reason
    delete m.hold
    deps?.persistUpdate?.([{ uid: m.uid, status: 'failed', reason: encodeReason(reason) }])
    notifySenderOfFailure(m)
  }
  envelopes.delete(id)
  pushUnclearCount.delete(id)
}

/**
 * Tell the SENDING pane that its message bounced.
 *
 * An agent writing bare-line `---MSG-START---` blocks has no other way to learn
 * this: the failure is otherwise only visible in the user's Messages panel. The
 * notice goes out as an ordinary message, so it takes the same queue, idle gate
 * and verified injection as everything else rather than a private path.
 *
 * Skipped for anything whose sender is not a live CLI pane in this window: an
 * inbound cross-workspace row (the sending window is told by reportDelivery and
 * notifies its own pane), a closed pane (not in the registry), a plain terminal
 * (sendMessage fails a notice addressed to one rather than typing it),
 * an MCP client (which polls `cli_check_message` instead), and a notice itself —
 * a bounced notice is logged and left there, never answered with another.
 */
function notifySenderOfFailure(m: AgentMessage): void {
  if (!deps || !m.reason) return
  if (m.kind === 'notice' || m.remote === 'inbound') return
  if (!paneByName.has(m.from)) return
  sendMessage(
    NOTICE_SENDER,
    m.from,
    renderFailureNotice(m.to, reasonToEnglish(m.reason.key, m.reason.params), m.content),
    { kind: 'notice' },
  )
}

/**
 * Tell the SENDING pane that its message is still queued, once it has been
 * waiting long enough that "it is on its way" has stopped being a useful thing
 * to assume.
 *
 * Same audience and same path as a failure notice, and the same exclusions —
 * with one addition: a message that already produced one of these does not
 * produce another, so a target that stays busy for an hour costs its senders
 * one notice each rather than one a second.
 *
 * This is where the still-held warning lives for EVERY sender that is a pane,
 * whichever way the message was sent. The backend tracks only `cli_send`
 * messages and could warn about those alone; the queue, the sender's name and
 * the injection path are all here, so nothing is gained by splitting the job in
 * two and a message would risk being reported twice.
 */
function notifyStaleHolds(now: number): void {
  if (!deps) return
  // Copied first: each notice appends to the log being iterated.
  for (const m of [...messages.value]) {
    if (m.status !== 'queued' || m.staleNotified) continue
    if (m.kind === 'notice' || m.remote === 'inbound') continue
    if (now - m.createdAt < STALE_HOLD_MS) continue
    if (!paneByName.has(m.from)) continue
    m.staleNotified = true
    sendMessage(
      NOTICE_SENDER,
      m.from,
      renderStaleNotice(
        m.to,
        holdToEnglish(m.hold?.key ?? 'busy', { n: m.hold?.n ?? 0 }),
        Math.round((now - m.createdAt) / 60_000),
        m.content,
      ),
      { kind: 'notice' },
    )
  }
}

/**
 * Explain a target's queue: the head carries why the gate is closed (null when
 * it is open and the head is about to go out), everything behind it carries its
 * own position. Only `queued` rows are annotated — a row that already moved on
 * has an outcome to show instead.
 */
function annotateHold(q: number[], headKey: string | null): void {
  q.forEach((id, i) => {
    const m = findMessage(id)
    if (!m || m.status !== 'queued') return
    if (i > 0) setHold(m, { key: 'behind', n: i })
    else if (headKey) setHold(m, { key: headKey })
    else setHold(m, undefined)
  })
}

/** Assign only on a real change. pump() re-annotates every second, and a fresh
 *  object each tick would invalidate the log panel on every one of them even
 *  though nothing it displays moved. */
function setHold(m: AgentMessage, hold: MessageHold | undefined): void {
  if (m.hold?.key === hold?.key && m.hold?.n === hold?.n) return
  const keyChanged = m.hold?.key !== hold?.key
  if (hold) m.hold = hold
  else delete m.hold
  if (keyChanged) reportHoldChange(m, hold)
}

/**
 * Report a hold change for a message the backend tracks by `msgKey` — one that
 * arrived through `agent_msg.deliver`, so an MCP `cli_send` or another window's
 * send. A message between two panes of this window is known nowhere else and
 * has nobody to tell.
 *
 * Only a changed hold KEY is worth the round trip: `n` moving as the queue
 * drains says nothing about why the head is stuck, and pump() re-annotates
 * every second. Delivery clears the hold on the backend's side, so there is
 * nothing to send when a message leaves the queue.
 */
function reportHoldChange(m: AgentMessage, hold: MessageHold | undefined): void {
  const msgKey = remoteInbound.get(m.id)
  if (msgKey === undefined) return
  deps?.reportHold?.(msgKey, hold ?? null)
}

/** Mark a message as the answer to the one whose envelope handed out `corrId`.
 *  An id this window never handed out — expired, evicted, or issued by another
 *  window — leaves the message unlinked, which is exactly how a reply written
 *  without a `re:` field behaves. */
function linkReply(m: AgentMessage, corrId: string): void {
  const rec = correlations.get(corrId)
  if (!rec) return
  const original = findMessage(rec.id)
  if (original) m.inReplyTo = original.uid
}

/** Record which CLI vendor each side is, skipping the ones we cannot name. */
function stampAgents(m: AgentMessage, from?: string, to?: string): void {
  if (from) m.fromAgent = from
  if (to) m.toAgent = to
}

/** Re-persist a row whose fields were filled in after it was first logged (the
 *  cross-workspace route resolves the target asynchronously). The store upserts
 *  on `uid` and keeps the original insertion order, so this refreshes the row
 *  rather than duplicating it. */
function repersist(m: AgentMessage): void {
  deps?.persistAppend?.([toPersistedRow(m)])
}

function pushLog(m: AgentMessage): void {
  messages.value.push(m)
  if (messages.value.length > LOG_CAP) {
    for (const evicted of messages.value.splice(0, messages.value.length - LOG_CAP)) {
      envelopes.delete(evicted.id)
    }
  }
  // The store prunes to the same 500 rows independently, so the eviction above
  // needs no counterpart write.
  deps?.persistAppend?.([toPersistedRow(m)])
}

/**
 * Merge a persisted snapshot (oldest-first) into the in-memory log.
 *
 * Restored rows are history only: envelopes, queues and the remote-ack maps are
 * in-memory and died with the previous window, so a row left `queued` or
 * `delivering` can never be delivered here — pumpPane() would silently drop it.
 * They are shown as `failed`, but the coercion is NEVER written back: the store
 * is global, so the same row may be live and about to deliver in another window,
 * and persisting `failed` over it would corrupt that window's log. A later
 * hydrate simply re-coerces. Nothing is re-enqueued.
 */
function hydrateLog(rows: PersistedMessageRow[]): void {
  // The snapshot arrives asynchronously; anything this window already logged
  // wins over its persisted copy. The live object keeps its original `id`, which
  // envelopes/queues/remoteOutbound are keyed by — replacing it with a restored
  // copy would strand those bindings and leave a delivered message showing as
  // failed.
  const live = messages.value
  const liveUids = new Set(live.map((m) => m.uid))
  const restored = (rows ?? [])
    .filter((row) => !liveUids.has(String(row.uid)))
    .map(fromPersistedRow)
  for (const m of restored) {
    if (m.status !== 'queued' && m.status !== 'delivering') continue
    m.status = 'failed'
    m.reason = HYDRATE_LOST_REASON
  }
  messages.value = [...restored, ...live].slice(-LOG_CAP)
}

/** Rate-limit key for a sender→target pair.
 *
 *  Local targets key on the exact handle, exactly as before — a pane may
 *  legitimately be named `fix/bug`, and it must keep its own budget.
 *
 *  A remotely-routed target instead keys on the pane name alone: the backend
 *  accepts several spellings of the same address (folder basename, path suffix,
 *  absolute path), and one budget per spelling would multiply the limit. */
function pairKey(from: string, to: string, remote: boolean): string {
  if (!remote) return `${from}→${to}`
  const t = to.trim()
  const slash = t.lastIndexOf('/')
  return `${from}→remote:${slash === -1 ? t : t.slice(slash + 1)}`
}

function overRateLimit(from: string, to: string, now: number, remote = false): boolean {
  const key = pairKey(from, to, remote)
  const stamps = (pairSends.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS)
  pairSends.set(key, stamps)
  return stamps.length >= RATE_LIMIT_MAX
}

/** Report an inbound cross-workspace message's outcome back to the sending
 *  window. Idempotent: only the first call for a message reports. */
function ackInbound(id: number, ok: boolean, reason: MessageReason | null): void {
  const msgKey = remoteInbound.get(id)
  if (msgKey === undefined) return
  remoteInbound.delete(id)
  deps?.reportDelivery?.(msgKey, ok, reason)
}

export interface SendOptions {
  includeReplyHint?: boolean
  /** Correlation id the sender echoed back, when this message is a reply. */
  replyTo?: string
  /** Internal: marks a Navide-authored notice. See notifySenderOfFailure().
   *  'ack' marks a bare acknowledgement: logged for the user to read, never
   *  injected into the recipient's pane. */
  kind?: 'notice' | 'fallback' | 'ack'
}

/**
 * Validate and enqueue a message. Always returns the log entry; invalid sends
 * come back already `failed` with a reason.
 */
function sendMessage(from: string, to: string, content: string, opts: SendOptions = {}): AgentMessage {
  if (!deps) throw new Error('messaging not configured')
  const now = deps.now()
  const msg: AgentMessage = {
    ...nextMessageKeys(),
    from,
    to,
    content,
    status: 'queued',
    createdAt: now,
  }
  // Stamped before anything can reject the send: every rejection below runs
  // through failMessage, which must already see this row for what it is.
  if (opts.kind) msg.kind = opts.kind
  stampAgents(msg, agentOfName(from), agentOfName(to))
  // Linked before the row is logged so even a rejected reply shows what it was
  // answering.
  if (opts.replyTo) linkReply(msg, opts.replyTo)
  pushLog(msg)

  const targetPane = paneIdOf(to)
  if (!targetPane) {
    // A `<folder>/<pane>` target this window does not own may live in another
    // workspace window; anything else keeps failing straight away as before.
    if (deps.routeRemote && isQualifiedTarget(to)) {
      dispatchRemote(msg, from, to, content, now, opts.replyTo)
      return msg
    }
    // A reply to a chat sender: the backend posts this turn's chat-addressed
    // blocks to the pane's bound chat itself (channels/manager.py _send_reply),
    // so there is nothing to send here and nothing to fail.
    if (isChannelTarget(to)) {
      markHandedToChannel(msg)
      return msg
    }
    failMessage(msg.id, { key: 'unknown-target', params: { to } })
    return msg
  }
  if (from === to) {
    failMessage(msg.id, { key: 'self-send' })
    return msg
  }
  if (overRateLimit(from, to, now)) {
    failMessage(msg.id, RATE_LIMIT_REASON)
    return msg
  }
  const q = queues.get(targetPane) ?? []
  if (q.length >= QUEUE_CAP) {
    failMessage(msg.id, QUEUE_FULL_REASON)
    return msg
  }

  const key = pairKey(from, to, false)
  pairSends.set(key, [...(pairSends.get(key) ?? []), now])
  if (msg.kind === 'ack') {
    // Never enqueued, so pumpPane can never reach it and deliverAgentMessage is
    // never called: this is the only point that can guarantee the recipient's
    // input box is left alone. The row stays in the log for the user to read.
    //
    // Deliberately AFTER the rate limit and queue cap checks, and after the
    // pair's budget is spent above: an ack still costs the loop guard, or it
    // would be a hole through the rate limit that two agents acking each other
    // could ride forever.
    markLoggedOnly(msg)
    return msg
  }
  const toTerminal = agentByPane.get(targetPane) === TERMINAL_AGENT_KEY
  // Any labelled message left here (a notice or a fallback report; an ack
  // returned above) is prose for an agent, never a command line.
  if (toTerminal && msg.kind) {
    failMessage(msg.id, TERMINAL_NOTICE_REASON)
    return msg
  }
  if (toTerminal) {
    // A shell runs exactly what it is given: the body alone, unsanitized, and
    // no correlation id — nothing in a shell can echo one back.
    envelopes.set(msg.id, content)
  } else if (msg.kind === 'notice') {
    // A notice is Navide's own text, already in the form the pane must see: its
    // first line says "delivery failed", which is how an agent tells it apart
    // from a message. An envelope would bury that under `from: Navide` and ask
    // for a reply to a handle nothing can address — so it is injected verbatim,
    // and hands out no correlation id, because it is not a message to answer.
    envelopes.set(msg.id, content)
  } else {
    // `uid` is already unique across windows and reloads, so it doubles as the
    // correlation id for a locally delivered message.
    envelopes.set(
      msg.id,
      renderEnvelope(from, content, {
        includeReplyHint: opts.includeReplyHint,
        correlationId: msg.uid,
      }),
    )
    correlations.set(msg.uid, { id: msg.id, sentAt: now })
  }
  q.push(msg.id)
  queues.set(targetPane, q)
  return msg
}

// ── Cross-workspace routing ────────────────────────────────────────────────
/** Turn a rejected route into a displayable reason: prefer the backend's code
 *  so the log localizes, fall back to its English sentence (a backend older
 *  than the code), and finally to the target that could not be resolved. */
function routeFailureReason(result: RouteResult, to: string): MessageReason {
  if (result.errorCode) return { key: result.errorCode, params: result.errorParams }
  if (result.error) return rawReason(result.error)
  return { key: 'unknown-target', params: { to } }
}

/**
 * Hand a `<folder>/<pane>` target to the backend registry. The message stays
 * `queued` here until the receiving window reports back, so the log reflects
 * what actually happened rather than assuming success. The per-pair rate limit
 * applies exactly as it does locally; the queue cap belongs to the receiving
 * window, which owns the target's queue.
 */
function dispatchRemote(
  msg: AgentMessage,
  from: string,
  to: string,
  content: string,
  now: number,
  replyTo?: string,
): void {
  const routeRemote = deps?.routeRemote
  if (!routeRemote) {
    failMessage(msg.id, { key: 'unknown-target', params: { to } })
    return
  }
  const fromPaneId = paneIdOf(from)
  if (!fromPaneId) {
    failMessage(msg.id, { key: 'unknown-target', params: { to } })
    return
  }
  if (overRateLimit(from, to, now, true)) {
    failMessage(msg.id, RATE_LIMIT_REASON)
    return
  }
  const key = pairKey(from, to, true)
  pairSends.set(key, [...(pairSends.get(key) ?? []), now])

  msg.remote = 'outbound'
  // The target's queue lives in another window, so nothing local explains this
  // row's `queued` — say so rather than leaving it looking stuck.
  msg.hold = { key: 'remote-ack' }
  const msgKey = `${fromPaneId}:${msg.id}`
  // The one name this message has on both machines; see AgentMessage.correlationId.
  msg.correlationId = msgKey
  remoteOutbound.set(msgKey, { id: msg.id, sentAt: now })
  // The receiving window renders its envelope with this same key, so a reply
  // that echoes it back lands on this row.
  correlations.set(msgKey, { id: msg.id, sentAt: now })

  void (async () => {
    try {
      const result = await routeRemote({ fromPaneId, fromName: from, to, content, msgKey, replyTo })
      if (!result.ok) {
        remoteOutbound.delete(msgKey)
        failMessage(msg.id, routeFailureReason(result, to))
        return
      }
      msg.remoteWorkspace = result.targetWorkspacePath
      stampAgents(msg, undefined, result.targetAgentKey)
      repersist(msg)
    } catch (err) {
      remoteOutbound.delete(msgKey)
      failMessage(msg.id, {
        key: 'route-error',
        params: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  })()
}

/**
 * Accept a cross-workspace message addressed to a pane in THIS window. Returns
 * false when the target is not ours, which is how each window filters the
 * broadcast. Delivery then runs through the ordinary queue, so the idle gate,
 * FIFO order and injection verification are unchanged.
 */
function acceptRemoteMessage(args: {
  msgKey: string
  targetPaneId: string
  fromDisplay: string
  content: string
  remoteWorkspace?: string
  /** The sending pane's CLI vendor, as reported by the backend registry. */
  fromAgent?: string
  /** Apply the per-pair rate limit here — set for senders that did not pass
   *  through sendMessage (the MCP tools), which would otherwise have no loop
   *  guard at all. */
  rateLimit?: boolean
  /** Correlation id the sender echoed back when this message is a reply to one
   *  this window sent. Unknown ids leave the row unlinked. */
  replyTo?: string
  /** Only ever 'ack', and only from the MCP cli_send tool: the message is
   *  logged here and never injected. Absent for every other sender. */
  kind?: 'ack'
  /** From a chat channel or a remote device: fence the body as external
   *  content (see isExternalDelivery / renderEnvelope). */
  external?: boolean
}): boolean {
  if (!deps) return false
  const localName = nameByPane.get(args.targetPaneId)
  if (!localName) return false
  // Checked after the ownership test so a window that does not own the target
  // never records the key — the owning window still has to accept it.
  if (acceptedMsgKeys.has(args.msgKey)) return false
  acceptedMsgKeys.add(args.msgKey)
  if (acceptedMsgKeys.size > ACCEPTED_MSG_KEYS_CAP) {
    const oldest = acceptedMsgKeys.values().next().value
    if (oldest !== undefined) acceptedMsgKeys.delete(oldest)
  }

  if (args.rateLimit) {
    const now = deps.now()
    if (overRateLimit(args.fromDisplay, localName, now, true)) {
      const reason = RATE_LIMIT_REASON
      const rejected: AgentMessage = {
        ...nextMessageKeys(),
        from: args.fromDisplay,
        to: localName,
        content: args.content,
        status: 'failed',
        reason,
        createdAt: now,
        remote: 'inbound',
        remoteWorkspace: args.remoteWorkspace,
        correlationId: args.msgKey,
      }
      stampAgents(rejected, args.fromAgent, agentByPane.get(args.targetPaneId))
      if (args.replyTo) linkReply(rejected, args.replyTo)
      pushLog(rejected)
      deps.reportDelivery?.(args.msgKey, false, reason)
      return true
    }
    const key = pairKey(args.fromDisplay, localName, true)
    pairSends.set(key, [...(pairSends.get(key) ?? []), now])
  }

  const msg: AgentMessage = {
    ...nextMessageKeys(),
    from: args.fromDisplay,
    to: localName,
    content: args.content,
    status: 'queued',
    createdAt: deps.now(),
    remote: 'inbound',
    remoteWorkspace: args.remoteWorkspace,
    // Set before the row is logged: this is the id the SENDER already knows the
    // message by, and it is what lets a recipient reading over MCP name the
    // same message its sender does.
    correlationId: args.msgKey,
  }
  if (args.kind === 'ack') msg.kind = 'ack'
  stampAgents(msg, args.fromAgent, agentByPane.get(args.targetPaneId))
  if (args.replyTo) linkReply(msg, args.replyTo)
  pushLog(msg)

  if (args.kind === 'ack') {
    // Settled here rather than enqueued: see markLoggedOnly. Reporting `ok:
    // true` is not optional — without it the sender's cli_check_message sits on
    // `queued` until it reads as stale two minutes later.
    markLoggedOnly(msg)
    deps.reportDelivery?.(args.msgKey, true, ACK_REASON)
    return true
  }

  const q = queues.get(args.targetPaneId) ?? []
  if (q.length >= QUEUE_CAP) {
    failMessage(msg.id, QUEUE_FULL_REASON)
    deps.reportDelivery?.(args.msgKey, false, QUEUE_FULL_REASON)
    return true
  }
  const toTerminal = agentByPane.get(args.targetPaneId) === TERMINAL_AGENT_KEY
  if (toTerminal && args.external) {
    failMessage(msg.id, TERMINAL_EXTERNAL_REASON)
    deps.reportDelivery?.(args.msgKey, false, TERMINAL_EXTERNAL_REASON)
    return true
  }
  // The routing key is what the sending side already knows this message by, so
  // it is the correlation id the reply is asked to echo. A terminal gets the
  // bare content — see TERMINAL_AGENT_KEY.
  envelopes.set(
    msg.id,
    toTerminal
      ? args.content
      : renderEnvelope(args.fromDisplay, args.content, { correlationId: args.msgKey, external: args.external }),
  )
  correlations.set(args.msgKey, { id: msg.id, sentAt: msg.createdAt })
  remoteInbound.set(msg.id, args.msgKey)
  q.push(msg.id)
  queues.set(args.targetPaneId, q)
  pump()
  return true
}

/**
 * Log the SENDER's side of a message the backend routed without it passing
 * through sendMessage() — the MCP `cli_send` tool broadcasts `agent_msg.deliver`
 * straight out, so without this the sending window's log stays empty. Returns
 * true when this window owns the sender and a row was added.
 *
 * No envelope and no enqueue: the window owning the TARGET pane delivers.
 */
function noteOutboundMessage(args: {
  msgKey: string
  fromPaneId: string
  /** Target pane, when the event names one. Used to skip the row when this
   *  window also owns the target — acceptRemoteMessage logs that message. */
  targetPaneId?: string
  toDisplay: string
  /** The target pane's CLI vendor, as reported by the backend registry. */
  toAgent?: string
  content: string
  crossWorkspace: boolean
  remoteWorkspace?: string
}): boolean {
  if (!deps) return false
  const fromName = nameByPane.get(args.fromPaneId)
  if (!fromName) return false
  // The local sendMessage → agent_msg.route path already logged this message in
  // dispatchRemote under the same msgKey, and its broadcast comes back here too.
  if (remoteOutbound.has(args.msgKey)) return false
  // Sender and target both live in this window: the inbound row already shows
  // the message and owns its real delivery status, so an outbound row would
  // duplicate one message in one log.
  if (args.targetPaneId && nameByPane.has(args.targetPaneId)) return false

  const now = deps.now()
  const msg: AgentMessage = {
    ...nextMessageKeys(),
    from: fromName,
    to: args.toDisplay,
    content: args.content,
    status: 'queued',
    createdAt: now,
    correlationId: args.msgKey,
  }
  // `remote` means "crossed a workspace boundary" — a same-workspace MCP send
  // must not get the cross-workspace badge.
  if (args.crossWorkspace) {
    msg.remote = 'outbound'
    msg.remoteWorkspace = args.remoteWorkspace
  }
  msg.hold = { key: 'remote-ack' }
  stampAgents(msg, agentByPane.get(args.fromPaneId), args.toAgent)
  pushLog(msg)
  // Hook the row into the ordinary outbound lifecycle: resolveRemoteDelivery()
  // flips it to delivered/failed, expireStaleRemotes() is the backstop.
  remoteOutbound.set(args.msgKey, { id: msg.id, sentAt: now })
  // The receiving window renders its envelope with this key, so a reply echoing
  // it back links to this row — same as a send through dispatchRemote.
  correlations.set(args.msgKey, { id: msg.id, sentAt: now })
  return true
}

/** Apply a delivery report to this window's outbound log entry (no-op when the
 *  report belongs to another window). */
function resolveRemoteDelivery(msgKey: string, ok: boolean, reason: string): void {
  const lateId = unconfirmedOutbound.get(msgKey)
  if (lateId !== undefined) {
    // The receiving window said unconfirmed earlier; this is it confirming.
    unconfirmedOutbound.delete(msgKey)
    const late = findMessage(lateId)
    if (ok && late?.reason?.key === UNCONFIRMED_REASON.key) clearUnconfirmed(late)
    return
  }
  const rec = remoteOutbound.get(msgKey)
  if (rec === undefined) return
  remoteOutbound.delete(msgKey)
  const msg = findMessage(rec.id)
  if (!msg) return
  if (!ok && decodeReason(reason)?.key === UNCONFIRMED_REASON.key) {
    markUnconfirmed(msg)
    unconfirmedOutbound.set(msgKey, rec.id)
    return
  }
  if (ok) {
    msg.status = 'delivered'
    msg.deliveredAt = deps ? deps.now() : msg.createdAt
    delete msg.hold
    if (reason === 'delivered-while-busy') msg.deliveredWhileBusy = true
    deps?.persistUpdate?.([{ uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt }])
  } else {
    const decoded = decodeReason(reason) ?? { key: 'delivery-failed' }
    // The message was called off before it went in — either this window asked,
    // or the receiving one dropped it from its own panel. Withdrawn, not failed:
    // nothing went wrong, so the sending pane gets no failure notice.
    if (decoded.key === CANCELLED_REASON.key) markCancelled(msg)
    else failMessage(rec.id, decoded)
  }
}

/** Fail outbound messages whose target window never reported back, so they stop
 *  sitting in `queued` (which clearMessageLog deliberately keeps) and stop
 *  holding a remoteOutbound entry.
 *
 *  The same verdict goes out over the ordinary reportDelivery path, because the
 *  backend keeps its own per-msgKey status for the MCP `cli_check_message` tool
 *  and nothing else will ever close this one: the window that was supposed to
 *  report is gone. Without it that status sits on `queued` until its TTL drops
 *  it — precisely the case (target window killed, machine slept) the tool
 *  exists to answer.
 *
 *  Reported only AFTER the remoteOutbound entry is dropped: the report comes
 *  back as an `agent_msg.delivery_result` broadcast, and resolveRemoteDelivery()
 *  must find nothing left to resolve rather than fail the row a second time. */
function expireStaleRemotes(now: number): void {
  for (const [msgKey, rec] of [...remoteOutbound]) {
    if (now - rec.sentAt < REMOTE_ACK_TIMEOUT_MS) continue
    remoteOutbound.delete(msgKey)
    failMessage(rec.id, NO_REPORT_REASON)
    deps?.reportDelivery?.(msgKey, false, NO_REPORT_REASON)
  }
}

/** Drop correlation ids old enough that no reply is still coming, so the table
 *  stays bounded over a long session. */
function expireCorrelations(now: number): void {
  for (const [corrId, rec] of [...correlations]) {
    if (now - rec.sentAt >= CORRELATION_TTL_MS) correlations.delete(corrId)
  }
}

/**
 * Broadcast: fan `content` out to every registered pane except `from`, each as
 * an ordinary single-target message (so per-pair rate limit, queue cap, idle
 * gate and the delivery log all apply per recipient). Returns one log entry per
 * recipient; empty when there is no one else to send to.
 */
/** @param opts.only  Optional per-pane filter on the recipients.
 *
 *  The registry knows a pane's name and agent, not its workspace, and one
 *  window can now hold several — so the caller, which does know, decides who
 *  counts as "everyone here". Without it the recipients are every registered
 *  pane, exactly as before. */
function sendBroadcast(
  from: string,
  content: string,
  opts: SendOptions & { only?: (paneId: string) => boolean } = {},
): AgentMessage[] {
  // Never a terminal: a broadcast is prose for agents, and a shell would run it.
  const targets = [...paneByName.entries()]
    .filter(([name, paneId]) =>
      name !== from &&
      agentByPane.get(paneId) !== TERMINAL_AGENT_KEY &&
      (!opts.only || opts.only(paneId)))
    .map(([name]) => name)
  return targets.map((to) => sendMessage(from, to, content, opts))
}

/**
 * Try to deliver queue heads. Safe to call often (interval + turn events);
 * per-pane in-flight guard makes it re-entrant.
 */
function pump(): void {
  if (!deps) return
  // Runs even while paused: pausing stops local injection, it does not make a
  // dead target window start answering.
  const now = deps.now()
  expireStaleRemotes(now)
  expireCorrelations(now)
  // Before the pause check, like the other two: a paused window still has to
  // stop a pane going deaf, and a released reservation only goes back to
  // waiting — it delivers nothing.
  expireReadReservations(now)
  if (paused.value) {
    for (const q of queues.values()) annotateHold(q, 'paused')
    return
  }
  // After the pause check, not before: while delivery is paused everything is
  // held on purpose, and the notice itself would be stuck in the same queue.
  expireStaleTerminalMessages(now)
  notifyStaleHolds(now)
  for (const paneId of queues.keys()) void pumpPane(paneId)
}

/** Fail every message that has sat queued for a plain terminal past
 *  STALE_HOLD_MS — see TERMINAL_STALE_REASON. Only queued rows: one already
 *  being typed is past the point of taking back. */
function expireStaleTerminalMessages(now: number): void {
  for (const [paneId, q] of queues) {
    if (agentByPane.get(paneId) !== TERMINAL_AGENT_KEY) continue
    for (const id of [...q]) {
      const m = findMessage(id)
      if (!m || m.status !== 'queued' || now - m.createdAt < STALE_HOLD_MS) continue
      q.splice(q.indexOf(id), 1)
      failMessage(id, TERMINAL_STALE_REASON)
      ackInbound(id, false, TERMINAL_STALE_REASON)
    }
  }
}

/** How many messages are still waiting to reach this pane.
 *
 *  Exposed for the idle-reclaim decision, which has to know the pane is owed
 *  something before it ends the CLI: unregisterPane fails the whole queue as
 *  'pane-closed' and tells each sender so, and there is no re-queue on the way
 *  back. Counting is the only read — the queue itself stays private. */
function queuedCountFor(paneId: string): number {
  return queues.get(paneId)?.length ?? 0
}

async function pumpPane(paneId: string): Promise<void> {
  if (!deps || paused.value) return
  const q = queues.get(paneId)
  if (!q || q.length === 0) return
  // Mid-injection: the head has no hold and the rest already carry their
  // positions from the call that let the head through.
  if (delivering.has(paneId)) return
  // The head is reserved for a recipient reading it itself; typing it in as
  // well would hand the same instruction over twice. FIFO means nothing behind
  // it can go out first either, so the whole pane waits — bounded by
  // expireReadReservations().
  if (isReadReserved(q[0])) return
  // A push channel answers to its own gates, which the caller has already
  // applied — so a pane it accepts needs no second opinion from the typed
  // path's gate, which is exactly what makes a message reach a pane someone is
  // typing in.
  const push = deps.pushTarget?.(paneId) ?? null
  if (!push && !deps.isPaneIdle(paneId)) {
    annotateHold(q, deps.idleHoldKey?.(paneId) ?? 'busy')
    return
  }
  annotateHold(q, null)

  const id = q[0]
  const msg = findMessage(id)
  const envelope = envelopes.get(id)
  if (!msg || !envelope) {
    q.shift()
    ackInbound(id, false, { key: 'dropped' })
    return
  }
  const refusal = push ? null : deps.refuseDelivery?.(paneId, envelope) ?? null
  if (refusal) {
    q.shift()
    failMessage(id, refusal)
    ackInbound(id, false, refusal)
    return
  }
  delivering.add(paneId)
  msg.status = 'delivering'
  deps.persistUpdate?.([{ uid: msg.uid, status: 'delivering' }])
  let ackOk = false
  let ackReason: MessageReason | null = null
  let requeued = false
  try {
    const ok = await deliverOnce(paneId, msg, envelope, push, () => cancelRequested.has(id))
    const stuck = ok === 'unclear'
      && (pushUnclearCount.get(id) ?? 0) + 1 >= PUSH_UNCLEAR_LIMIT
    if (typeof ok === 'object' && ok !== null && 'unconfirmed' in ok) {
      markUnconfirmed(msg)
      envelopes.delete(id)
      unconfirmedDeliveries.set(id, { paneId, msgKey: remoteInbound.get(id) })
      ackReason = UNCONFIRMED_REASON
    } else if (typeof ok === 'object' && ok !== null) {
      ackReason = ok.failed
      failMessage(id, ackReason)
    } else if (stuck) {
      // The composer would not clear after PUSH_UNCLEAR_LIMIT pushes: the
      // message is never getting through this way, and re-queuing it again
      // would only park the pane's whole queue behind it. Fail it so the
      // sender hears about it.
      ackReason = { key: 'push-stuck' }
      failMessage(id, ackReason)
    } else if (ok === null || ok === 'unclear') {
      // Pushed and it did not land, and typing it in now is not an option —
      // either the channel may still be holding the text, or the typed path's
      // own gate is shut because the push was chosen for a pane someone is
      // typing in. Put the message back at the head of its queue with nothing
      // spent: the next pump sends it whichever way is open then.
      if (ok === 'unclear') pushUnclearCount.set(id, (pushUnclearCount.get(id) ?? 0) + 1)
      requeued = true
      msg.status = 'queued'
      delete msg.route
      deps.persistUpdate?.([{ uid: msg.uid, status: 'queued' }])
    } else if (ok) {
      msg.status = 'delivered'
      msg.deliveredAt = deps.now()
      deps.persistUpdate?.([{ uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt }])
      envelopes.delete(id)
      ackOk = true
    } else if (cancelRequested.has(id)) {
      ackReason = CANCELLED_REASON
      markCancelled(msg)
    } else if (msg.status !== 'delivering') {
      // Settled from outside while the injection was still waiting on the
      // pane — unregisterPane failed the whole queue as the pane closed, and
      // told the sender. A second verdict here would tell it twice.
    } else {
      ackReason = { key: 'inject-failed' }
      failMessage(id, ackReason)
    }
  } catch (err) {
    ackReason = {
      key: 'inject-error',
      params: { error: err instanceof Error ? err.message : String(err) },
    }
    failMessage(id, ackReason)
  } finally {
    delivering.delete(paneId)
    cancelRequested.delete(id)
    if (!requeued) {
      q.shift()
      pushUnclearCount.delete(id)
      ackInbound(id, ackOk, ackReason)
    }
  }
}

/**
 * One delivery attempt for the head of a pane's queue.
 *
 * Returns true when the message reached the pane, false when it demonstrably
 * did not, and null or 'unclear' when a push failed and typing it in now would
 * be wrong — the caller puts the message back rather than choosing between
 * losing it and writing it into a pane that cannot take it.
 *
 * Two separate reasons to hold off, and both have to be checked. The channel
 * may still be holding the text ('unclear'), in which case typing would submit
 * the envelope twice over — passed through by name so the caller can count how
 * often the same message hits it. And the push may have been chosen precisely
 * because the typed path's gate was shut — someone is typing in the pane — so
 * the fallback is re-gated rather than assumed (null).
 */
async function deliverOnce(
  paneId: string,
  msg: AgentMessage,
  envelope: string,
  push: { kind: string } | null,
  shouldAbort: () => boolean,
): Promise<boolean | null | 'unclear' | { failed: MessageReason } | { unconfirmed: true }> {
  if (!deps) return false
  if (push && deps.pushDeliver) {
    msg.route = `push:${push.kind}`
    const outcome = await deps.pushDeliver(paneId, envelope)
    if (outcome === 'landed') return true
    delete msg.route
    if (outcome === 'unclear') return 'unclear'
    if (!deps.isPaneIdle(paneId)) return null
  }
  return deps.deliver(paneId, envelope, shouldAbort)
}

/**
 * Why the message being typed into `paneId` has not gone in yet — today only
 * `pty-blocked`, reported by the injection while the pane's PTY holds the
 * text unread. Same hold field and the same report to the backend as a queued
 * message's, so cli_check_message shows it the same way; `undefined` clears it
 * once the wait ends. No new status: the row stays `delivering`, which is what
 * it is.
 */
function setDeliveringHold(paneId: string, hold: MessageHold | undefined): void {
  const id = queues.get(paneId)?.[0]
  if (id === undefined || !delivering.has(paneId)) return
  const m = findMessage(id)
  if (!m || m.status !== 'delivering') return
  setHold(m, hold)
}

/** A `delivering` message the user may still withdraw: its pane has not read
 *  the text (see setDeliveringHold), so aborting the injection and clearing
 *  the composer leaves nothing behind. */
function withdrawable(m: AgentMessage): boolean {
  return m.status === 'delivering' && m.hold?.key === 'pty-blocked' && !cancelRequested.has(m.id)
}

/**
 * Reserve the next deliverable message for `paneId` and return its envelope,
 * for a caller that will hand it over WITHOUT injecting it — today that is a
 * claude pane's Stop hook, which passes the text to the agent as its next
 * instruction (see the backend's `hook_drain`).
 *
 * The gates that still apply are the ones about whether the message may go out
 * at all: the global pause, and the per-pane in-flight guard (a message being
 * typed into the pane right now must finish before another one starts). The
 * per-pair rate limit needs no check here — it is spent when a message is sent,
 * so anything already queued has paid for itself.
 *
 * The gates that do NOT apply are the ones about the input box: the idle gate
 * (the turn is ending, which is why we were asked) and the typing hold (nothing
 * is written to the pane, so a half-typed line cannot be submitted by this).
 *
 * Reserved, not consumed. The row stays at the head of its queue, marked
 * `delivering` with the pane held in-flight — the same state pumpPane keeps a
 * message in while its write is unconfirmed — until settleHookDrain() says
 * whether the hand-over landed. That is what makes a Stop hook that gave up
 * before its answer arrived cost nothing: the message is still exactly where
 * it was, for the ordinary typed path to pick up.
 */
function drainForHook(paneId: string): string | null {
  if (!deps || paused.value) return null
  if (delivering.has(paneId)) return null
  const q = queues.get(paneId)
  if (!q || q.length === 0) return null
  // Already promised to a recipient that asked for it; see pumpPane().
  if (isReadReserved(q[0])) return null
  const id = q[0]
  const msg = findMessage(id)
  const envelope = envelopes.get(id)
  if (!msg || !envelope) {
    q.shift()
    ackInbound(id, false, { key: 'dropped' })
    return null
  }
  delivering.add(paneId)
  msg.status = 'delivering'
  msg.route = 'hook'
  delete msg.hold
  deps.persistUpdate?.([{ uid: msg.uid, status: 'delivering' }])
  return envelope
}

/**
 * Close a drainForHook() reservation. `ok` means the envelope reached the Stop
 * hook that was waiting for it; anything else — the hook timed out first, the
 * socket failed — restores the message, because nothing was written anywhere
 * and no agent has seen it.
 *
 * A pane that closed in between has already failed everything it had queued
 * (see unregisterPane), so there is nothing left to settle.
 */
function settleHookDrain(paneId: string, ok: boolean): void {
  if (!deps) return
  delivering.delete(paneId)
  const q = queues.get(paneId)
  const id = q?.[0]
  if (!q || id === undefined) return
  const msg = findMessage(id)
  if (!msg || msg.status !== 'delivering' || msg.route !== 'hook') return
  if (!ok) {
    msg.status = 'queued'
    delete msg.route
    deps.persistUpdate?.([{ uid: msg.uid, status: 'queued' }])
    return
  }
  q.shift()
  envelopes.delete(id)
  msg.status = 'delivered'
  msg.deliveredAt = deps.now()
  deps.persistUpdate?.([{ uid: msg.uid, status: 'delivered', delivered_at: msg.deliveredAt }])
  // Same report the injection path sends, so a cross-workspace sender's row
  // leaves `queued` whichever way its message actually arrived — and only once
  // it actually has.
  ackInbound(id, true, null)
}

// ── Recipient-initiated read ───────────────────────────────────────────────
/** What reserveIncoming() hands back: the message as its recipient needs to
 *  read it, which is the raw content and who sent it — not the envelope, which
 *  exists to be typed into a pane. */
export interface ReservedIncoming {
  uid: string
  from: string
  to: string
  content: string
  createdAt: number
  /** Set when the message crossed a workspace boundary. */
  remoteWorkspace?: string
}

/** Find a logged message by its persistence key.
 *
 *  `uid` is what the backend store and the MCP tools address a message by; the
 *  in-memory side maps are all keyed by the local `id`, so every uid-addressed
 *  entry point starts here. A linear scan of at most LOG_CAP (500) rows, called
 *  once per message a recipient asks for — an index would be state to keep
 *  correct through eviction, hydration and reload for no measurable gain. */
function findByUid(uid: string): AgentMessage | undefined {
  return messages.value.find((m) => m.uid === uid)
}

/** Whether a queue entry is reserved for a recipient that asked for it. The
 *  registry is the single source of truth, so a row cannot look reserved to one
 *  caller and free to another. */
function isReadReserved(id: number | undefined): boolean {
  return id !== undefined && readReserved.has(id)
}

/**
 * Reserve messages a recipient is about to read for itself, and return their
 * contents — today that is the `cli_read_incoming` MCP tool, where the agent a
 * message is addressed to pulls it instead of waiting for Navide to type it in.
 *
 * Reserved, not consumed — the same discipline as drainForHook(), for the same
 * reason and with sharper teeth. The answer travels back over `ui.invoke`: a
 * 15-second RPC that fails silently. If returning the text and dropping the row
 * were one indivisible act, a lost reply would turn a message that was still
 * going to be retried into a history row nobody will ever look at again, and
 * NEITHER side would find out — the recipient never saw it, and the sender was
 * already told it arrived. So each row stays exactly where it is in its queue,
 * marked `delivering` with `route: 'read'`, until settleIncomingRead() says
 * whether the hand-over landed.
 *
 * What stops it going out twice meanwhile: a reserved entry is skipped by
 * pumpPane() and drainForHook(), so nothing types it in behind the reader's
 * back. What stops it going out never: expireReadReservations(), because that
 * skip is otherwise permanent.
 *
 * Per message, not per pane. A recipient asks for the messages it can see, and
 * the head of its queue may be mid-injection at that moment — that one entry is
 * refused (the write is already happening; it is going to arrive by typing) and
 * the ones behind it are still perfectly reservable. Returns only the messages
 * actually reserved, so a caller that asked for four and gets three has been
 * told precisely which three it may report on.
 */
function reserveIncoming(paneId: string, uids: string[]): ReservedIncoming[] {
  if (!deps || paused.value) return []
  const now = deps.now()
  const taken: ReservedIncoming[] = []
  for (const uid of uids) {
    const msg = findByUid(uid)
    // Anything not still waiting in a queue is not the reader's to take: it is
    // already delivered, failed, cancelled, or reserved by an earlier call.
    if (!msg || msg.status !== 'queued') continue
    const loc = queuedLocation(msg.id)
    // Addressed to a different pane — a recipient reads its own mail only.
    if (!loc || loc.paneId !== paneId) continue
    if (heldInFlight(loc)) continue
    readReserved.set(msg.id, { paneId, reservedAt: now })
    msg.status = 'delivering'
    msg.route = 'read'
    delete msg.hold
    deps.persistUpdate?.([{ uid: msg.uid, status: 'delivering' }])
    taken.push({
      uid: msg.uid,
      from: msg.from,
      to: msg.to,
      content: msg.content,
      createdAt: msg.createdAt,
      remoteWorkspace: msg.remoteWorkspace,
    })
  }
  return taken
}

/**
 * Give a reservation back. The row returns to `queued` where it already is —
 * nothing was removed, so there is nothing to put back and no position to
 * restore. Costs nothing: no budget was spent reserving it, and the next pump
 * treats it as it would any other queued message.
 */
function releaseReservation(msg: AgentMessage): void {
  readReserved.delete(msg.id)
  msg.status = 'queued'
  delete msg.route
  deps?.persistUpdate?.([{ uid: msg.uid, status: 'queued' }])
}

/**
 * Close a reserveIncoming() reservation. `ok` means the contents reached the
 * agent that asked for them; anything else — the RPC timed out, the tool call
 * was abandoned, the socket failed — puts the messages back, because nothing
 * was written anywhere and no agent has seen them.
 *
 * Only the reservations this pane actually holds are settled, so a stale or
 * confused settle cannot consume somebody else's mail.
 */
function settleIncomingRead(paneId: string, uids: string[], ok: boolean): void {
  if (!deps) return
  for (const uid of uids) {
    const msg = findByUid(uid)
    if (!msg) continue
    const rec = readReserved.get(msg.id)
    if (!rec || rec.paneId !== paneId) continue
    // unqueue() has the final say on removal, and it refuses a head another
    // hand-over is holding. Either way the message goes back rather than
    // vanishing — the only outcome this protocol will not produce.
    if (ok && unqueue(msg.id)) {
      readReserved.delete(msg.id)
      markRead(msg)
      continue
    }
    releaseReservation(msg)
  }
}

/**
 * Hand back reservations old enough that no answer is still coming.
 *
 * The failure this exists for is not a lost message — an unsettled row never
 * left its queue. It is a pane that stops receiving: pumpPane() and
 * drainForHook() both step over a reserved head, so one reservation that is
 * never settled would end delivery to that pane silently and permanently. See
 * {@link READ_RESERVE_TIMEOUT_MS}.
 */
function expireReadReservations(now: number): void {
  for (const [id, rec] of [...readReserved]) {
    if (now - rec.reservedAt < READ_RESERVE_TIMEOUT_MS) continue
    const msg = findMessage(id)
    // The row is gone (log eviction) or was resolved by another path, such as
    // the pane closing and failing everything it had queued.
    if (!msg || msg.status !== 'delivering' || msg.route !== 'read') {
      readReserved.delete(id)
      continue
    }
    releaseReservation(msg)
  }
}

// ── Cancel ─────────────────────────────────────────────────────────────────
/** The queue a message is sitting in, or null when nothing local holds it —
 *  it was already taken, or its queue lives in another window. */
function queuedLocation(id: number): { paneId: string; q: number[]; index: number } | null {
  for (const [paneId, q] of queues) {
    const index = q.indexOf(id)
    if (index !== -1) return { paneId, q, index }
  }
  return null
}

/** Whether a queue entry is the one a hand-over in flight is holding.
 *
 *  Only the head can be mid-injection — pumpPane and drainForHook both hold
 *  `q[0]` and shift it when they are done — so that is the one entry a pane
 *  with an injection in flight must keep. Everything behind it is free.
 *
 *  Shared by unqueue() and reserveIncoming(), which need the same answer to
 *  different questions ("may I remove this?" / "may I reserve this?") and must
 *  not be able to disagree about it. */
function heldInFlight(loc: { paneId: string; index: number }): boolean {
  return loc.index === 0 && delivering.has(loc.paneId)
}

/** Take a message out of its local queue, if it is still there to take.
 *
 *  Everything behind an in-flight head splices out safely, and the head being
 *  held stays exactly where it was. */
function unqueue(id: number): boolean {
  const loc = queuedLocation(id)
  if (!loc) return false
  if (heldInFlight(loc)) return false
  loc.q.splice(loc.index, 1)
  pushUnclearCount.delete(id)
  return true
}

/** Mark a message withdrawn. Deliberately not failMessage(): the send was
 *  called off on purpose, so there is nothing to tell the sending pane about —
 *  a "delivery failed" notice injected into the pane that just cancelled would
 *  be the noise cancelling exists to avoid. */
function markCancelled(m: AgentMessage): void {
  m.status = 'cancelled'
  delete m.hold
  envelopes.delete(m.id)
  deps?.persistUpdate?.([{ uid: m.uid, status: 'cancelled' }])
}

/**
 * Mark a message the recipient took for itself. Same shape as markCancelled(),
 * opposite verdict — and the difference is the whole point.
 *
 * A cancelled message never reached anyone, so its sender is told `ok: false`
 * and lands on `failed`. A read message DID reach its agent: it asked for the
 * text and got it. Reporting that as a failure would show the sending pane a
 * delivery that did not happen, and an agent reading `failed` does the sensible
 * thing and sends the instruction again — which `cli_send` documents as the way
 * to get one job done twice. So this reports `ok: true` with {@link
 * READ_REASON}, which lands the sender's row on `delivered` exactly as an
 * injection would.
 *
 * Who actually hears it: only a sender in ANOTHER window. ackInbound() speaks
 * through `remoteInbound`, which is populated by acceptRemoteMessage() alone —
 * a message between two panes of this window has no `msg_key` and no separate
 * sender-side row (both sides read the one row this call updates), so there is
 * nobody to notify and nothing to notify them about. That is a known limit of
 * the local path, not something to fix here.
 */
function markRead(m: AgentMessage): void {
  m.status = 'delivered'
  m.deliveredAt = deps ? deps.now() : m.createdAt
  delete m.hold
  envelopes.delete(m.id)
  // `route` is left as 'read' on purpose: like 'hook' it records how the row
  // got out. No `reason` is written onto the row — that field is what the log
  // panel renders for a FAILED message, and this one succeeded.
  deps?.persistUpdate?.([{ uid: m.uid, status: 'delivered', delivered_at: m.deliveredAt }])
  ackInbound(m.id, true, READ_REASON)
}

/**
 * Settle a message that is logged but never delivered.
 *
 * An 'ack' never enters a queue, so nothing downstream will ever settle it:
 * pumpPane cannot reach a message no queue holds, and the row would sit on
 * `queued` for good. Mirrors markRead() — the row succeeded, so no `reason` is
 * written onto it; `route` records how it got out, which here is that it
 * deliberately did not.
 *
 * `route` is not persisted, like 'hook' and 'read' before it: PersistedMessageUpdate
 * carries no such column, and a restored row has no delivery left to explain.
 */
function markLoggedOnly(m: AgentMessage): void {
  m.status = 'delivered'
  m.deliveredAt = deps ? deps.now() : m.createdAt
  m.route = 'ack'
  delete m.hold
  deps?.persistUpdate?.([{ uid: m.uid, status: 'delivered', delivered_at: m.deliveredAt }])
}

/** Settle a reply to a chat sender: handed to the channel, which posts it at the
 *  turn's end (or the whole turn text if that fails). Not persisted, like 'ack'. */
function markHandedToChannel(m: AgentMessage): void {
  m.status = 'delivered'
  m.deliveredAt = deps ? deps.now() : m.createdAt
  m.route = 'channel'
  delete m.hold
  deps?.persistUpdate?.([{ uid: m.uid, status: 'delivered', delivered_at: m.deliveredAt }])
}

/** The routing key an outbound cross-workspace message is known by, while it is
 *  still awaiting a report. */
function outboundKeyOf(id: number): string | null {
  for (const [msgKey, rec] of remoteOutbound) {
    if (rec.id === id) return msgKey
  }
  return null
}

/**
 * Withdraw a message that has not gone in yet. Returns false when it is too
 * late — anything already `delivering`, `delivered` or `failed` is beyond
 * recall, because the text is being (or has been) written into the pane.
 *
 * A message whose queue this window owns is dropped on the spot. One handed to
 * another window is only a request: that window owns the queue and decides, and
 * the answer arrives as an ordinary delivery report, so a message that went in
 * while the request was in flight stays `delivered` rather than being rewritten
 * as cancelled here.
 */
function cancelMessage(id: number): boolean {
  const m = findMessage(id)
  if (!m) return false
  if (withdrawable(m)) {
    // The injection settles it: pumpPane marks the row cancelled once the
    // abort has cleared the pane, so the composer is never reported empty
    // before it is.
    cancelRequested.add(id)
    return true
  }
  if (m.status !== 'queued') return false
  if (unqueue(id)) {
    markCancelled(m)
    // An inbound cross-workspace row's sender is still waiting on a verdict.
    ackInbound(id, false, CANCELLED_REASON)
    return true
  }
  const msgKey = outboundKeyOf(id)
  const request = deps?.requestRemoteCancel
  if (!msgKey || !request) return false
  setHold(m, { key: 'cancelling' })
  void (async () => {
    try {
      await request(msgKey)
    } catch {
      // The request never left. Put the row back to waiting rather than leaving
      // it claiming a cancellation nobody was asked for.
      if (m.status === 'queued') setHold(m, { key: 'remote-ack' })
    }
  })()
  return true
}

/**
 * Honor another window's cancel request for a message queued here. Returns
 * false when it is too late, which is why nothing is reported in that case:
 * the delivery that beat the request will report the real outcome itself.
 */
function cancelRemoteInbound(msgKey: string): boolean {
  for (const [id, key] of remoteInbound) {
    if (key !== msgKey) continue
    const m = findMessage(id)
    if (m && withdrawable(m)) {
      cancelRequested.add(id)
      return true
    }
    if (!m || m.status !== 'queued' || !unqueue(id)) return false
    markCancelled(m)
    ackInbound(id, false, CANCELLED_REASON)
    return true
  }
  return false
}

// ── Pause / log ────────────────────────────────────────────────────────────
function pauseMessaging(): void {
  paused.value = true
  // Don't make the log wait for the next pump tick to explain itself.
  for (const q of queues.values()) annotateHold(q, 'paused')
}

/**
 * Re-send a finished entry as a brand-new message. Everything is re-validated
 * from scratch — target lookup, rate limit, queue cap — so a retry can fail
 * again for a different reason, and it spends the pair's budget like any other
 * send, which is what stops the button from being a loop hole.
 *
 * A retried cross-workspace message is logged as an ordinary send: the original
 * routing key was consumed when its failure was reported, and re-deriving the
 * route from `to` is exactly what sendMessage already does.
 *
 * A cancelled row is re-sendable for the same reason a failed one is: the text
 * never reached anyone, so sending it again delivers it once, not twice.
 *
 * `kind` is not carried over, and nothing reaches here that would need it to be:
 * the panel gives a 'notice' and an 'ack' row no Resend button, so neither can
 * be retried into an ordinary message.
 */
function retryMessage(id: number): AgentMessage | null {
  const m = findMessage(id)
  if (!m || (m.status !== 'failed' && m.status !== 'cancelled')) return null
  return sendMessage(m.from, m.to, m.content)
}

function resumeMessaging(): void {
  paused.value = false
  pump()
}

const CLEAR_KEEP_STATUSES: MessageStatus[] = ['queued', 'delivering']

function clearMessageLog(): void {
  // Keep undelivered entries — they are still queued state, not just history.
  messages.value = messages.value.filter((m) => CLEAR_KEEP_STATUSES.includes(m.status))
  deps?.persistClear?.(CLEAR_KEEP_STATUSES)
}

/** Land a row on `delivered` with the unconfirmed caveat. Not failMessage: no
 *  Resend in the panel, and no failure notice to the sender. */
function markUnconfirmed(m: AgentMessage): void {
  m.status = 'delivered'
  m.deliveredAt = deps ? deps.now() : m.createdAt
  m.reason = UNCONFIRMED_REASON
  delete m.hold
  deps?.persistUpdate?.([{
    uid: m.uid, status: 'delivered', delivered_at: m.deliveredAt, reason: encodeReason(UNCONFIRMED_REASON),
  }])
}

function clearUnconfirmed(m: AgentMessage): void {
  delete m.reason
  deps?.persistUpdate?.([{ uid: m.uid, reason: '' }])
}

/**
 * A user record from `paneId`'s CLI log — `text` is what the transcript reader
 * read back — confirms a delivery that went out unconfirmed, when it is that
 * message: its correlation id, or the start of its content, is in the record.
 * The row loses its caveat and the confirmation is reported to whoever is
 * waiting on the msgKey. Returns whether one was confirmed.
 */
function confirmDelivery(paneId: string, text: string): boolean {
  const record = normalizeForMatch(text)
  if (!record) return false
  for (const [id, entry] of unconfirmedDeliveries) {
    if (entry.paneId !== paneId) continue
    const m = findMessage(id)
    if (!m) { unconfirmedDeliveries.delete(id); continue }
    const head = normalizeForMatch(m.content).slice(0, TAIL_MATCH_LEN)
    const matches = (!!m.correlationId && text.includes(m.correlationId)) || (!!head && record.includes(head))
    if (!matches) continue
    unconfirmedDeliveries.delete(id)
    if (m.reason?.key === UNCONFIRMED_REASON.key) clearUnconfirmed(m)
    if (entry.msgKey !== undefined) deps?.reportDelivery?.(entry.msgKey, true, null)
    return true
  }
  return false
}

/** Test-only: wipe all singleton state. */
export function _resetMessagingForTest(): void {
  deps = null
  seq = 0
  bootUid = newBootUid()
  messages.value = []
  paused.value = false
  nameByPane.clear()
  paneByName.clear()
  agentByPane.clear()
  queues.clear()
  delivering.clear()
  envelopes.clear()
  pairSends.clear()
  acceptedMsgKeys.clear()
  remoteOutbound.clear()
  remoteInbound.clear()
  unconfirmedDeliveries.clear()
  unconfirmedOutbound.clear()
  correlations.clear()
  readReserved.clear()
  pushUnclearCount.clear()
  cancelRequested.clear()
}

export function useAgentMessaging() {
  return {
    messages: readonly(messages),
    paused: readonly(paused),
    configureMessaging,
    registerPane,
    renamePane,
    setDerivedName,
    unregisterPane,
    handOverQueue,
    queuedCountFor,
    nameOf,
    paneIdOf,
    suggestName,
    sendMessage,
    sendBroadcast,
    retryMessage,
    cancelMessage,
    cancelRemoteInbound,
    setDeliveringHold,
    acceptRemoteMessage,
    noteOutboundMessage,
    resolveRemoteDelivery,
    confirmDelivery,
    drainForHook,
    settleHookDrain,
    findByUid,
    reserveIncoming,
    settleIncomingRead,
    pump,
    pauseMessaging,
    resumeMessaging,
    clearMessageLog,
    hydrateLog,
  }
}
