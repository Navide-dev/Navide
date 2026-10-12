// One owner of the cross-device snapshot, so the account window and the prompt
// that pops up over everything cannot disagree about what is waiting.
//
// They show the same pairing from two places: the window is the record and the
// fallback entry point, the prompt is the thing somebody actually sees when a
// machine asks. Two copies of that state would drift by exactly one poll — long
// enough for a card to answer a question the prompt is still asking.
//
// Module-level on purpose. Every window in this app holds one backend, and this
// endpoint is the same read for all of them; a per-component instance would
// mean one poll per mount of a thing that is mounted twice.
import { computed, ref } from 'vue'

import type { useBackend } from './useBackend'

/** One in-flight pairing, as both surfaces draw it. */
export interface PairingRow {
  deviceId: string
  deviceName: string
  /** initiator | responder — which side of the exchange this machine is on. */
  role: string
  /** awaiting-response | awaiting-local | awaiting-remote */
  state: string
  /** The six digits, as "482 913". Empty until both nonces are known. */
  code: string
  /** Their signing key's digest, beside the code so the two things a person can
   *  compare are in the same place. */
  fingerprint: string
  /** When this exchange began. Two requests from one device are two questions,
   *  so this is what tells them apart — see `requestKey`. */
  startedAt?: number
  /** When it stops waiting, in seconds since the epoch. */
  expiresAt?: number
}

/** A round that ended because one side refused a frame of it. */
export interface PairingFailure {
  deviceId: string
  deviceName: string
  /** The refusal's wire reason: trust-unavailable, policy-denied, … */
  reason: string
  /** local: this machine refused; remote: the other one did. */
  side: string
  at: number
}

/** Reasons with a sentence of their own; anything else gets the general one. */
const FAILURE_REASONS: Record<string, string[]> = {
  local: ['trust-unavailable', 'pairing-refused'],
  remote: ['trust-unavailable', 'policy-denied', 'unauthenticated', 'pairing-refused'],
}

/** The i18n key under `settings.p2p.pair` that says what ended a round and
 *  what to do next. */
export function failureKey(failure: Pick<PairingFailure, 'reason' | 'side'>): string {
  const side = failure.side === 'local' ? 'local' : 'remote'
  const reason = FAILURE_REASONS[side].includes(failure.reason) ? failure.reason : 'other'
  return `failed-${side}-${reason}`
}

function failureId(failure: Pick<PairingFailure, 'deviceId' | 'at'>): string {
  return `${failure.deviceId}:${failure.at}`
}

/**
 * A name for *this* request, not for the device that sent it.
 *
 * Dismissing was keyed by device, which made "not now" mean "never again from
 * that machine for the rest of this session" — so a request that expired and
 * was sent again never reappeared. A person clicking "later" is answering the
 * question in front of them, not writing a rule.
 */
export function requestKey(row: Pick<PairingRow, 'deviceId' | 'startedAt'>): string {
  return `${row.deviceId}:${row.startedAt ?? 0}`
}

interface Snapshot {
  pairings?: PairingRow[]
  pairingFailures?: PairingFailure[]
  [key: string]: unknown
}

type Backend = ReturnType<typeof useBackend>

const snapshot = ref<Snapshot | null>(null)
/** Requests a person has waved away in the prompt, by `requestKey`. Kept here
 *  rather than in the component so dismissing survives the prompt unmounting,
 *  and pruned on every read so a key can never outlive the request it names —
 *  which is what made "later" behave like "never". */
const dismissed = ref<Set<string>>(new Set())
/** Ended rounds whose notice somebody closed, by device and end time. */
const dismissedFailures = ref<Set<string>>(new Set())
/**
 * Requests this machine has just sent, before any answer has come back.
 *
 * Pressing "Pair" produced nothing on screen until the far machine replied —
 * seconds of a button that had visibly done nothing, which is indistinguishable
 * from a button that did nothing. The snapshot is polled, so even the local
 * record of "we asked" is up to a poll away; this is what lets the press be
 * acknowledged at the moment it happens.
 *
 * Dropped as soon as the real row arrives (the snapshot then owns it) or the
 * send fails. Keyed by device id because that is all the caller knows before
 * the exchange has a start time.
 */
const asked = ref<Map<string, { deviceName: string; error: string }>>(new Map())
/** Set only when the machine has no server at all. A link that is merely down
 *  still answers, with the last picture the server sent, so this is not the
 *  same thing as an empty snapshot. */
const unavailable = ref(false)
/**
 * The last read did not come back, so what is on screen is older than it looks.
 *
 * Deliberately not folded into anything about the link, because they are
 * different facts and the account window used to report one as the other: a
 * snapshot that failed to load left a banner reading "the link is down" on a
 * screen whose connection card was green. A failed read says nothing about the
 * socket — the handler can throw while the link is perfectly healthy, which is
 * the case that produced the contradiction.
 */
const readFailed = ref(false)

let consumers = 0
let timer: ReturnType<typeof setInterval> | null = null
let client: Backend | null = null

/** How often the snapshot is re-read. The account window used to poll this same
 *  endpoint separately — two reads of one thing every three seconds — and now
 *  takes its copy from here, so there is one request per tick however many
 *  surfaces are open. */
export const POLL_MS = 3000

async function refresh(): Promise<void> {
  if (!client) return
  try {
    const resp = await client.send<Snapshot>('p2p.network.snapshot', {})
    if (resp.ok && resp.payload) {
      snapshot.value = resp.payload
      unavailable.value = false
      readFailed.value = false
      prune()
    } else if (resp.error?.code === 'P2P_NOT_CONFIGURED') {
      snapshot.value = null
      unavailable.value = true
      readFailed.value = false
      prune()
    } else {
      // Any other refusal: the picture below is the previous one. It stays —
      // an emptied list would be a claim of its own — but it stops passing for
      // current.
      readFailed.value = true
    }
  } catch {
    /* the last answer stays on screen; the next poll corrects it — but it is
       now visibly not current, rather than silently so */
    readFailed.value = true
  }
}

/** Forget dismissals whose request is gone — answered, withdrawn or expired.
 *  Without this the set only ever grows, and the next request from the same
 *  machine inherits an answer given to a different one. */
function prune(): void {
  const live = new Set((snapshot.value?.pairings ?? []).map(requestKey))
  if (![...dismissed.value].some((key) => !live.has(key))) return
  dismissed.value = new Set([...dismissed.value].filter((key) => live.has(key)))
}

/**
 * Subscribe to the shared snapshot. Call `release` when the caller goes away.
 *
 * Polling runs while anybody is subscribed and stops when nobody is, so a
 * closed window costs nothing and the prompt — which is always mounted — keeps
 * it running for the one reader that has to notice a request arriving.
 */
export function usePairingState(backend: Backend) {
  client = backend
  return {
    snapshot,
    unavailable,
    readFailed,
    pairings: computed<PairingRow[]>(() => snapshot.value?.pairings ?? []),
    /** Rounds that ended on a refusal, not yet closed by anybody. Both
     *  surfaces show them: the card that was waiting is gone, and without this
     *  its absence was the only thing that said anything had happened. */
    failures: computed<PairingFailure[]>(() =>
      (snapshot.value?.pairingFailures ?? []).filter(
        (failure) => !dismissedFailures.value.has(failureId(failure)),
      ),
    ),
    dismissFailure(failure: Pick<PairingFailure, 'deviceId' | 'at'>): void {
      dismissedFailures.value = new Set([...dismissedFailures.value, failureId(failure)])
    },
    /**
     * What the prompt should show: every exchange waiting on a person here,
     * whichever end this machine is.
     *
     * It served the responder alone, on the reasoning that the initiator had
     * already said what it wanted by pressing Pair. Both ends confirm now — the
     * digits are the only thing a relay cannot produce, so somebody has to
     * compare them at each end — and the reason the responder got a popup
     * applies unchanged to the initiator: the account window may be closed or
     * scrolled elsewhere, and that button is the whole exchange.
     */
    prompts: computed<PairingRow[]>(() =>
      (snapshot.value?.pairings ?? []).filter(
        (row) => !dismissed.value.has(requestKey(row)),
      ),
    ),
    /** Requests sent from here and not yet visible in the snapshot. */
    asked: computed(() =>
      [...asked.value.entries()]
        .filter(([deviceId]) =>
          !(snapshot.value?.pairings ?? []).some((row) => row.deviceId === deviceId),
        )
        .map(([deviceId, value]) => ({ deviceId, ...value })),
    ),
    /** Acknowledge the press itself, before anything has been sent. */
    noteAsked(deviceId: string, deviceName: string): void {
      if (!deviceId) return
      asked.value = new Map(asked.value).set(deviceId, { deviceName, error: '' })
    },
    /** The request did not go out. Said here rather than left to time out: a
     *  failure that returns the screen to silence is the state this replaced. */
    noteAskFailed(deviceId: string, error: string): void {
      const existing = asked.value.get(deviceId)
      if (!existing) return
      asked.value = new Map(asked.value).set(deviceId, { ...existing, error })
    },
    /** Forget a press — the exchange is under way, or it was given up on. */
    forgetAsked(deviceId: string): void {
      if (!asked.value.has(deviceId)) return
      const next = new Map(asked.value)
      next.delete(deviceId)
      asked.value = next
    },
    refresh,
    /** Put one request away. Keyed by the request, so the same machine asking
     *  again is a new question and gets asked again. */
    dismiss(row: Pick<PairingRow, 'deviceId' | 'startedAt'>): void {
      dismissed.value = new Set([...dismissed.value, requestKey(row)])
    },
    /** Drop the picture on sign-out. It belonged to the account that just left,
     *  and showing it to whoever signs in next would be showing them somebody
     *  else's machines. */
    clear(): void {
      snapshot.value = null
      readFailed.value = false
      prune()
    },
    subscribe(): void {
      consumers += 1
      void refresh()
      if (!timer) timer = setInterval(() => void refresh(), POLL_MS)
    },
    release(): void {
      consumers = Math.max(0, consumers - 1)
      if (consumers === 0 && timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

/** Forget everything between tests. */
export function _resetForTest(): void {
  snapshot.value = null
  dismissed.value = new Set()
  dismissedFailures.value = new Set()
  asked.value = new Map()
  unavailable.value = false
  readFailed.value = false
  consumers = 0
  if (timer) { clearInterval(timer); timer = null }
  client = null
}
