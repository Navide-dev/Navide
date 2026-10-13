<script setup lang="ts">
// Navide account modal: sign in, create an account, or paste a token.
//
// Opened from the titlebar "Sign in" button, so it is the first thing a new
// user can find without knowing Settings exists. It is an in-app overlay like
// SettingsModal rather than its own OS window: the account is app-wide, and a
// modal cannot be left behind another window or opened twice.
//
// The server address is not shown or editable: it is built into the app
// (server_link.DEFAULT_SERVER_URL). A typo'd address used to produce a link
// that silently never dialled, and there was no correct value a user could
// have discovered on their own.
import { canonicalJson } from '../../../shared/canonicalJson'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { LegalRoute } from '../../../shared/legalLinks'
import { linkErrorKey } from '../lib/linkStatus'
import { usePairingState, failureKey } from '../composables/usePairingState'
import NavideCloudMark from './NavideCloudMark.vue'
import { relativeTime } from '../lib/relativeTime'
import PaneGitChip, { type PaneGit } from './PaneGitChip.vue'
import { dockWindowLabelKey } from '../lib/dockWindow'
import type { useBackend } from '../composables/useBackend'

const props = defineProps<{
  open: boolean
  backend: ReturnType<typeof useBackend>
}>()
const emit = defineEmits<{
  (e: 'close'): void
  /** The stored credential changed (sign-in, sign-out, token). */
  (e: 'changed'): void
  /** Show the pane-authorization rules, which live in the settings window. */
  (e: 'open-rules'): void
}>()

const { t } = useI18n()

interface LinkStatus {
  state:
    | 'unconfigured'
    | 'connecting'
    | 'waiting-for-keychain'
    | 'connected'
    | 'unreachable'
    | 'unauthorized'
  serverUrl: string
  hasToken: boolean
  detail: string
  deviceId: string
  accountEmail?: string
  displayName?: string
  /** Soft gate: an unverified account works normally, it is only flagged. */
  emailVerified?: boolean
  /** Why the last dial failed, verbatim from the socket. Shown rather than
   *  paraphrased: "not connected" is the part the user already knows. */
  lastError?: string
  /** Seconds until the next dial, or null where waiting is not the answer. */
  nextRetryInS?: number | null
  /** This machine's own signing key, as the short digest people compare.
   *  Read straight from the local key — it never goes near the server. */
  selfFingerprint?: string
  /**
   * The user turned this link off. Reported beside `state`, never folded into
   * it: pausing is something a person did, and showing it as "unreachable"
   * would blame the network for their own switch.
   */
  paused?: boolean
}

/**
 * Something about a peer's identity that the user has to be told.
 *
 * Three kinds, and the difference between the first two is the whole point:
 * meeting a device for the first time is a statement, while a device whose key
 * changed is a refusal in progress — and a key change looks exactly like an
 * impersonation attempt, because in the data they are the same event.
 */
interface TrustNotice {
  key: string
  /** Every kind trust_store can record — kept in step with its
   *  ALL_NOTICE_KINDS by a test, because nothing else can. A missing member is
   *  legal TypeScript (these values arrive as JSON), and the cost is not a
   *  render failure: the notice falls through to the last branch below and is
   *  announced as something it is not. */
  kind:
    | 'device-first-seen'
    | 'device-key-changed'
    | 'device-pairing'
    | 'remote-command'
    | 'policy-unverified'
    | 'member-changed'
    | 'plaintext-refused'
  deviceId: string
  at: number
  memberId?: string
  /** first-seen */
  fingerprint?: string
  /** device-pairing: paired | refused | revoked */
  pairing?: string
  /** device-pairing, remote-command */
  deviceName?: string
  /** remote-command */
  workspace?: string
  paneName?: string
  /** first-seen: this device landed in the "my own machines" ring. */
  own?: boolean
  /** key-changed: both halves, so a person can compare them out of band. */
  pinnedFingerprint?: string
  offeredFingerprint?: string
  /** policy-unverified, member-changed */
  reason?: string
  /** plaintext-refused: which message was dropped. */
  msgKey?: string
  seq?: number
  expected?: number
}

/** One CLI pane, as Navide-Server's session directory describes it. */
interface NetworkPane {
  sessionId: string
  paneId: string
  agentKey: string
  title: string
  workspace: string
  workspacePath: string
  /** running | waiting | exited | disconnected | not-opened — or anything a newer server invents. */
  status: string
  hostOnline: boolean
  /** When the session started, ISO-8601, or '' when the directory did not say.
   *  The backend has always sent it; nothing read it, so every row was silent
   *  about age. It is a start time and is labelled as one — the roster carries
   *  no last-activity stamp, and printing one would be a claim we cannot make. */
  startedAt?: string
  /** This machine's own panes only, and only inside a git checkout: the
   *  backend reads it locally and never uploads it. */
  git?: PaneGit
  /** An embedded AI panel's window ('pm', 'plans', 'git', 'editor'); absent
   *  for a window pane, and from a backend or peer that does not send it. */
  surface?: string
}

interface NetworkDevice {
  /** self | trusted | pending | blocked — where this device stands with this
   *  machine. The list said nothing about it, so an unvouched device looked
   *  exactly like a vouched one while the card above asked you to confirm it. */
  trustState?: string
  deviceId: string
  deviceName: string
  isLocal: boolean
  online: boolean
  paneCount: number
  panes: NetworkPane[]
  /** This row can be paired from here, without waiting for that machine to send
   *  anything: it is undecided, the directory advertises a key to pin, and that
   *  key is attributed to this account. */
  canTrust?: boolean
  /** The newest thing the directory says about this machine. Shown on an
   *  offline row so "offline" reads as "not right now" rather than "gone". */
  lastSeenAt?: string
  /** The digest of the key that would be pinned — the one part of a pairing a
   *  server cannot fake, so it is what the confirmation below asks about.
   *  Empty on every row where there is nothing to decide. */
  signFingerprint?: string
}

/**
 * One pairing exchange, waiting on a person at this end or the other.
 *
 * Both machines derive the same six digits from both signing keys and both
 * nonces, and a person at each end confirms they match. Neither is pinned until
 * both have — which is the whole difference from the button this replaced,
 * where one side decided and the other found out when something ran.
 */
interface Pairing {
  deviceId: string
  deviceName: string
  /** initiator | responder — which sentence to show, nothing more. */
  role: string
  /** awaiting-response | awaiting-local | awaiting-remote */
  state: string
  /** The six digits, as "482 913". Empty until both nonces are known. */
  code: string
  /** Their signing key's digest, beside the code so the two things a person can
   *  compare are in the same place. */
  fingerprint: string
  /** When it stops waiting, in seconds since the epoch. */
  expiresAt?: number
}

/** A device that tried to reach a pane here and was refused. */
interface AccessRequest {
  key: string
  memberId: string
  deviceId: string
  deviceName: string
  workspace: string
  paneName: string
  attempts: number
}

/** A device or member refused ahead of every rule. */
interface BlockedEntry {
  deviceId: string
  memberId: string
  deviceName: string
  reason: string
}

/**
 * A device this machine pinned but nobody has vouched for yet.
 *
 * Deliberately not a notice. A notice records that something happened and can
 * be acknowledged away; this records a question that is still open, and
 * dismissing the first-sighting notice must not be able to answer it.
 *
 * Every row here is a machine that actually tried to reach this one. The card
 * briefly also listed every device the directory advertised, which put a
 * question on it that no answer could clear: the row was rebuilt from the
 * directory on the next poll, so unpairing dropped the pin and grew the row
 * straight back. Pairing a machine that has never messaged this one moved to
 * the quiet button on its row in the network list.
 */
interface PendingDevice {
  deviceId: string
  /** What the directory calls this machine. Absent for a device the directory
   *  has not mentioned, which is the only case the id has to stand in for. */
  deviceName?: string
  online?: boolean
  paneCount?: number
  workspaces?: string[]
  memberId?: string
  at?: number
  fingerprint?: string
}

interface NetworkSnapshot {
  state: LinkStatus['state']
  deviceId: string
  devices: NetworkDevice[]
  /** Absent on a backend that predates the trust surface. */
  accessRequests?: AccessRequest[]
  blocked?: BlockedEntry[]
  trustNotices?: TrustNotice[]
  /** Absent on a backend that predates first-sight approval. */
  trustPending?: PendingDevice[]
  /**
   * Non-empty means this machine has lost the trust state it once had, and all
   * cross-device traffic is stopped in both directions until it is understood.
   * There is deliberately no button to clear it: starting over is exactly what
   * an attacker who deleted that state wants next.
   */
  trustLocked?: string
  /** "full" when that stop is a trust record with no room left: intact, and
   *  unpairing a device is the way back, so there is no start-over to offer. */
  trustLockedCode?: string
  /** No rules written under this identity yet, so nothing inbound is accepted.
   *  Reachable by recovering — a machine that heals a device conflict lands on
   *  a new identity with an empty policy. */
  policyEmpty?: boolean
  /** True when that stop is a read that may succeed next time — the offer to
   *  erase everything waits on this being false. */
  trustLockedTransient?: boolean
  /** The record is there but cut off — a damaged record is known to be
   *  useless, so the card says so and that pairing again is the fix. */
  trustDamaged?: boolean
  /** The trust journal (notices, delivered-message ledger) is unreadable or
   *  was set aside; the backend's sentence says which. Pairing is unaffected. */
  trustJournalProblem?: string
}

/** The four the server defines; anything else is shown as the server spelled it. */
// 'not-opened' is not one of the server's four: the backend substitutes it
// into this device's own rows for a pane that was restored but never opened,
// because only this machine can know that. Anything else unknown still falls
// through to the raw value below.
/** The wire vocabulary is the sidebar's badge vocabulary, with two words that
 *  do not line up — so they are translated here rather than left to look right
 *  by accident:
 *
 *  - `not-opened` is this device's word for a cold-restore placeholder. The
 *    sidebar has always filed that under `waiting`, whose label already reads
 *    "not opened"; the wire needed a distinct token because `waiting` was taken.
 *  - `waiting` on the wire means the reporting machine only knows the delivery
 *    flag — a build too old to send a badge word, or a window that has not
 *    finished its first tick. `idle` is the nearest word that is actually true.
 *
 *  Everything else is passed through unchanged, which is the point: one pane
 *  must not be called two different things in two places. */
const WIRE_TO_BADGE: Record<string, string> = { 'not-opened': 'waiting', waiting: 'idle' }

type Mode = 'login' | 'register' | 'token'

const mode = ref<Mode>('login')
const email = ref('')
const password = ref('')
/** Write-only: the backend never sends a stored token back. */
const token = ref('')
const busy = ref(false)
const error = ref('')
const status = ref<LinkStatus | null>(null)
/** Resend runs on its own flag so it cannot grey out sign-out beside it. */
const resending = ref(false)
const resent = ref(false)
/**
 * Whether this account still owes us a confirmed e-mail address.
 *
 * Seeded from the register/login reply so the notice is up the instant the
 * account exists, then confirmed by the status poll — but only while the link
 * is connected, because a reconnecting link reports no flag and a verified user
 * must not be told to check their mail every time the socket blinks.
 *
 * The confirming click happens in a browser this app never sees, so this only
 * clears on a reconnect or on a resend that comes back already verified.
 */
const verifyPending = ref(false)

// Read from the shared state, not from this window's own snapshot: the prompt
// that pops up over everything reads the same endpoint, and two pollers a tick
// apart would let one surface ask a question the other had already answered —
// as well as costing two requests for one answer.
const pairingState = usePairingState(props.backend)
/**
 * The team space as the server last described it: devices, and the CLI panes
 * on each. Null until the first answer, which is why the section reserves its
 * height rather than growing when the data lands.
 */
const network = computed<NetworkSnapshot | null>(
  () => pairingState.snapshot.value as NetworkSnapshot | null,
)
/** Set only when the machine has no server at all — a link that is merely down
 *  still answers, with the last picture the server sent. */
const networkUnavailable = pairingState.unavailable

const signedIn = computed(() => Boolean(status.value?.accountEmail))
/** Before the first poll answers, nothing is known. Rendering that as "not
 *  signed in" is a claim — and the wrong one for everybody who is. */
const loaded = computed(() => status.value !== null)
/** Only a positive answer earns the tick; "unknown" is not "confirmed". */
const verified = computed(() => status.value?.emailVerified === true)
const state = computed(() => status.value?.state ?? 'unconfigured')

/**
 * Whether an action that needs the server can be attempted at all.
 *
 * Every one of these goes to the relay, and a link that is still dialling
 * answers them with "configured but not connected right now, retry shortly" —
 * a sentence that arrives *after* the click, which makes the button look broken
 * rather than unavailable. Reading the state the panel is already polling turns
 * that into something visible before the click.
 */
const linkReady = computed(() => state.value === 'connected')
/** A button that is off needs to say which kind of off. "Connecting" is worth
 *  waiting out; the others are not. */
const linkWaitReason = computed(() =>
  linkReady.value
    ? ''
    : state.value === 'waiting-for-keychain'
      ? t('settings.p2p.link-waiting-keychain')
      : state.value === 'connecting'
        ? t('settings.p2p.link-connecting')
        : t('settings.p2p.link-not-connected'),
)
/**
 * The socket's own words, under the sentence above.
 *
 * "Not connected" is the half the person can already see; which of "starting
 * up", "the address is not answering" and "your token was rejected" it is, is
 * the half that decides whether waiting is the right thing to do. Verbatim,
 * because paraphrasing a transport error loses the one detail that identifies
 * it.
 */
const linkErrorDetail = computed(() => (linkReady.value ? '' : status.value?.lastError ?? ''))
/**
 * The socket's failure in words, in the reader's language.
 *
 * The classifying is a pure function in lib/linkStatus so it can be tested by
 * what it returns rather than by which strings are still in this file — an
 * inline version passed every test while wired to the wrong branch. Falls back
 * to the original when that function has never seen the failure: the original
 * stays in the `title` either way.
 */
const linkErrorPlain = computed(() => {
  const raw = linkErrorDetail.value
  if (!raw) return ''
  const key = linkErrorKey(raw)
  return key ? t(`settings.p2p.${key}`) : raw
})
/** Seconds until the loop dials again, when it is going to. Absent for the two
 *  states where waiting is not what fixes it. */
const linkRetryIn = computed(() => (linkReady.value ? 0 : status.value?.nextRetryInS ?? 0))
/**
 * One lamp for the link, everywhere it appears.
 *
 * There were two: this one, and an inline expression on the link card that read
 * `network.state` and knew only "connected or not" — so a rejected token showed
 * amber in one place and red in another, on the same screen, about the same
 * fact. The state comes from `p2p.link.status` in all three places now; the
 * network snapshot has its own reasons to be a poll behind.
 */
function dotFor(value: string): string {
  if (value === 'connected') return 'ok'
  if (value === 'unauthorized') return 'err'
  if (value === 'unreachable') return 'warn'
  return 'idle'
}
const dotClass = computed(() => dotFor(state.value))

/** "Connecting" resolves on its own, so the modal keeps asking while open. */
let timer: ReturnType<typeof setInterval> | null = null

async function loadStatus(): Promise<void> {
  try {
    const resp = await props.backend.send<{ status: LinkStatus }>('p2p.link.status', {})
    if (resp.ok && resp.payload?.status) {
      status.value = resp.payload.status
      if (resp.payload.status.state === 'connected') {
        verifyPending.value = resp.payload.status.emailVerified === false
      }
    }
  } catch {
    /* non-fatal: the status line keeps its last value */
  }
}

/**
 * Re-read the network view.
 *
 * The backend keeps its own copy current from the server's `sessions.changed`
 * and `presence.changed` pushes — a device going offline touches no session
 * row, so both are needed and both are already subscribed to — which makes this
 * a read of a cache rather than a request to the server. The read itself lives
 * in the shared state, so an action here and the prompt over the app are
 * looking at one answer.
 */
const loadNetwork = pairingState.refresh

/** Both halves of what the modal shows, on one tick of the one timer. */
async function refresh(): Promise<void> {
  await Promise.all([loadStatus(), loadNetwork()])
}

const trustNotices = computed<TrustNotice[]>(() => network.value?.trustNotices ?? [])
const trustPending = computed<PendingDevice[]>(() => network.value?.trustPending ?? [])
const trustLocked = computed(() => network.value?.trustLocked ?? '')
const trustFull = computed(() => network.value?.trustLockedCode === 'full')
/** The last read did not come back. Says only that, because a failed read says
 *  nothing about the socket — see usePairingState. */
const readFailed = pairingState.readFailed
/** The stop is a read that may succeed on the next try. Same card, but no offer
 *  to erase everything: a keychain locked for a moment has nothing wrong with
 *  it to erase, and that offer is the one act here nobody can undo. */
const trustLockedTransient = computed(() => network.value?.trustLockedTransient === true)
const trustDamaged = computed(() => network.value?.trustDamaged === true)
const trustJournalProblem = computed(() => network.value?.trustJournalProblem ?? '')
/** Two clicks, not one: the first only reveals what the second costs. A single
 *  button beside an explanation of a lock is a button people press to make the
 *  red text go away. */
const rebuildArmed = ref(false)
const rebuildDone = ref(false)

/**
 * Erase this machine's trust record and start again.
 *
 * Carries a confirmation token like every other trust-changing act, which is
 * what keeps it out of reach of MCP and the plugin broker — they talk to the
 * backend directly and cannot mint one. The backend refuses it outright unless
 * the store is genuinely locked.
 */
async function rebuildTrust(): Promise<void> {
  if (pending.value) return
  pending.value = 'trust-rebuild'
  try {
    const resp = await props.backend.send(
      'p2p.trust.rebuild',
      await withConfirmation('p2p.trust.rebuild', '', {}),
    )
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('account.err-generic')
      return
    }
    rebuildArmed.value = false
    rebuildDone.value = true
    await loadNetwork()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    pending.value = ''
  }
}
const paused = computed(() => status.value?.paused === true)

/** Which switch or notice is mid-flight, so a double click cannot act twice. */
const pending = ref('')

/**
 * Turn the cross-device link off, or back on.
 *
 * Signing out was the only way to stop this machine talking to the server, and
 * it throws the credential away — so "off for now" cost the user their account
 * on this device. This keeps everything and closes the socket.
 */
async function togglePaused(): Promise<void> {
  if (pending.value) return
  pending.value = 'link'
  try {
    const resp = await props.backend.send<{ status: LinkStatus }>('p2p.link.set_paused', {
      paused: !paused.value,
    })
    if (resp.ok && resp.payload?.status) status.value = resp.payload.status
    await refresh()
  } catch {
    /* the switch shows whatever the next poll reports, which is the truth */
  } finally {
    pending.value = ''
  }
}

/** Clear a first-seen notice. The backend refuses this for a changed key, and
 *  the template does not offer the button there — see the section comment. */
async function dismissNotice(notice: TrustNotice): Promise<void> {
  if (pending.value) return
  pending.value = notice.key
  try {
    await props.backend.send('p2p.trust.notices.dismiss', { key: notice.key })
    await loadNetwork()
  } catch {
    /* left on screen; nothing was decided */
  } finally {
    pending.value = ''
  }
}

/**
 * "Not now": take a row off the card without answering it.
 *
 * The weakest button here, and deliberately so. Approving and blocking are
 * decisions and are written where they are enforced; this changes nothing about
 * what that machine may reach — it stays pinned, unapproved, and held to rules
 * that deny by default. It only stops an already-seen question being re-asked
 * every three seconds. The backend puts the row back the moment that device
 * knocks again, so it cannot be used to make a machine quietly go away.
 */
async function deferDevice(row: PendingDevice): Promise<void> {
  if (pending.value) return
  pending.value = row.deviceId
  try {
    await props.backend.send(
      'p2p.trust.device.defer',
      await withConfirmation('p2p.trust.device.defer', row.deviceId, { deviceId: row.deviceId }),
    )
    await loadNetwork()
  } catch {
    /* the row stays, and the next poll shows whatever is really true */
  } finally {
    pending.value = ''
  }
}

/**
 * Forget a device: drop the pin and everything decided with it.
 *
 * The way back out of a pairing, which this panel did not have — a device seen
 * once stayed pinned for good. It grants nothing, so unlike approving it does
 * not ask for a fingerprint to be compared; what it costs is that the machine
 * shows up as a first sighting again the next time it says anything.
 */
async function unpairDevice(deviceId: string): Promise<void> {
  if (pending.value || !deviceId) return
  pending.value = deviceId
  try {
    await props.backend.send(
      'p2p.trust.device.unpair',
      await withConfirmation('p2p.trust.device.unpair', deviceId, { deviceId }),
    )
    await loadNetwork()
  } catch {
    /* left on screen; nothing was decided */
  } finally {
    pending.value = ''
  }
}

/** How a person would name the machine; the id is always there, the name is not. */
function deviceLabel(device: NetworkDevice): string {
  if (device.deviceName) return device.deviceName
  return device.deviceId.length > 12 ? `${device.deviceId.slice(0, 12)}…` : device.deviceId
}


/** At most three workspace labels, then how many were left out. */
function workspaceSummary(names: string[] | undefined): string {
  const list = names ?? []
  if (!list.length) return ''
  return list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} +${list.length - 3}`
}

/**
 * Ask main for a one-time confirmation, and fold it into the payload.
 *
 * The six actions that change who this machine trusts are refused by the
 * backend without one. Only a window can obtain it — MCP and the plugin broker
 * hold the same socket but have no path to the key — so this is what separates
 * "the person clicked it" from "an agent was talked into it by a remote peer".
 */
async function withConfirmation(
  action: string,
  deviceId: string,
  payload: Record<string, unknown> = {},
  subject = '',
): Promise<Record<string, unknown>> {
  const confirm = await window.agentTeam?.trustConfirm(action, deviceId, subject)
  // Sent through even when null: the backend's refusal names the reason, and
  // inventing a different one here would hide it.
  return { ...payload, confirm }
}

/** Whether the last copy of this machine's fingerprint just landed, so the
 *  button can say so rather than looking like it did nothing. */
const copiedFingerprint = ref(false)

async function copyFingerprint(): Promise<void> {
  const value = status.value?.selfFingerprint
  if (!value) return
  try {
    await navigator.clipboard?.writeText(value)
    copiedFingerprint.value = true
    window.setTimeout(() => { copiedFingerprint.value = false }, 1500)
  } catch {
    /* the value is selectable on screen either way, which is the point */
  }
}

const pairings = computed<Pairing[]>(() => pairingState.pairings.value as Pairing[])
/** Rounds that ended because one side refused a frame, with why. */
const pairingFailures = computed(() => pairingState.failures.value)
/** Everything waiting on a person, of either shape. */
const needsYouCount = computed(() => trustPending.value.length + accessRequests.value.length)

/**
 * Ask another machine to pair.
 *
 * A request, not a grant. The button this replaced pinned the other device on
 * the spot, without anybody there being asked or told; this puts a card on both
 * screens and writes nothing until two people have compared the same digits.
 */
async function startPairing(device: NetworkDevice): Promise<void> {
  if (pending.value) return
  pending.value = device.deviceId
  error.value = ''
  // Before the token is minted and before anything is sent. The confirmation is
  // an IPC round trip of its own, so acknowledging after it would still leave a
  // gap — and the gap is the whole complaint: the press produced nothing until
  // the far machine answered.
  pairingState.noteAsked(device.deviceId, deviceLabel(device))
  try {
    const resp = await props.backend.send(
      'p2p.pair.start',
      await withConfirmation('p2p.pair.start', device.deviceId, { deviceId: device.deviceId }),
    )
    if (!resp.ok) {
      const message = startPairingError(device, resp.error) ?? t('account.err-generic')
      error.value = message
      // Said on the card too. Clearing it instead would return the screen to
      // the silence this replaced, with the failure only in the panel below.
      pairingState.noteAskFailed(device.deviceId, message)
      return
    }
    await refresh()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    error.value = message
    pairingState.noteAskFailed(device.deviceId, message)
  } finally {
    pending.value = ''
  }
}

/**
 * What a refused "Pair" press says. Two refusals get a sentence that says what
 * to do next; the rest are the backend's own words, as before.
 */
function startPairingError(
  device: NetworkDevice,
  err: { code?: string; message?: string } | null | undefined,
): string | undefined {
  if (err?.code === 'TRUST_UNAVAILABLE') return t('settings.p2p.pair.trust-unavailable-start')
  if (err?.code === 'PAIRING_BUSY') {
    const row = pairings.value.find((r) => r.deviceId === device.deviceId)
    if (row?.expiresAt) {
      const minutes = Math.max(1, Math.ceil((row.expiresAt * 1000 - Date.now()) / 60000))
      return t('settings.p2p.pair.busy', { device: deviceLabel(device), minutes })
    }
  }
  return err?.message
}

/**
 * Answer "do the digits match?".
 *
 * Refusing is as much a decision as accepting, so both carry a confirmation
 * token and both tell the other side — a refusal that only closed this card
 * would leave the other machine waiting out the five minutes.
 */
async function answerPairing(row: Pairing, accept: boolean): Promise<void> {
  if (pending.value) return
  pending.value = row.deviceId
  error.value = ''
  try {
    const resp = await props.backend.send(
      'p2p.pair.confirm',
      await withConfirmation('p2p.pair.confirm', row.deviceId, {
        deviceId: row.deviceId,
        accept,
      }),
    )
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('account.err-generic')
      return
    }
    await refresh()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    pending.value = ''
  }
}

/** Open one of the published legal pages. The addresses live in the shared
 *  table and are resolved in main, so nothing here builds a URL. */
function openLegal(route: LegalRoute): void {
  void window.agentTeam?.openLegal(route)
}

/**
 * Remote-command notices, and everything else.
 *
 * One line per delivery is the right record and the wrong list: a busy day
 * pushes everything that needs somebody off the panel. Collapsed behind a
 * summary the record survives and the panel stays about the open questions.
 */
/**
 * Notices that are history, folded into one line per device.
 *
 * A remote command, a completed pairing and a first sighting are all receipts:
 * worth keeping, not worth a card each. Twenty of them push the four kinds that
 * are refusals-in-force off the panel, which is the one thing this list must
 * never do. Grouped by device because ten deliveries from one machine is one
 * fact about that machine, not ten.
 */
const LOG_KINDS = ['remote-command', 'device-pairing', 'device-first-seen']
const logNotices = computed(() => trustNotices.value.filter((n) => LOG_KINDS.includes(n.kind)))
const logByDevice = computed(() => {
  const rows = new Map<string, { key: string; label: string; count: number }>()
  for (const n of logNotices.value) {
    const id = n.deviceId
    const row = rows.get(id)
    if (row) {
      row.count += 1
      continue
    }
    rows.set(id, { key: n.key, label: n.deviceName || n.deviceId, count: 1 })
  }
  return [...rows.values()]
})
const standingNotices = computed(() =>
  trustNotices.value.filter((n) => !LOG_KINDS.includes(n.kind)),
)

/**
 * Notices that describe a refusal in force, as opposed to something that
 * happened.
 *
 * "This device changed its key" and "we paired" are the same shape in the data
 * and nothing about the row said which was which — so a refusal that is
 * blocking traffic right now sat in a list looking exactly like a receipt.
 */
const alertKinds = [
  'device-key-changed',
  'policy-unverified',
  'plaintext-refused',
  'member-changed',
]

/**
 * A fingerprint in groups of four.
 *
 * The backend already spaces it, but a value that arrives ungrouped (an older
 * peer, or a pin taken before that) has to be grouped here too — comparing
 * sixteen unbroken hex characters across two screens is the step people give up
 * on, and letter-spacing looks like grouping without being it.
 */
function grouped(value: string | undefined): string {
  const raw = (value ?? '').replace(/\s+/g, '')
  if (!raw) return ''
  return raw.match(/.{1,4}/g)?.join(' ') ?? raw
}

/** Whether the card below is currently asking about this device. */
function hasPendingRow(device: NetworkDevice): boolean {
  return trustPending.value.some((row) => row.deviceId === device.deviceId)
}

/** Bring the pending card into view. The device list can say a machine is
 *  waiting on you; this is how it hands you over to the place that asks. */
function reviewPending(): void {
  document.querySelector('.pending-card')?.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth',
    block: 'start',
  })
}

/** The badge word for a wire state. The one place the mapping is applied, so a
 *  pane's label, its pill colour and the section it is filed under can never
 *  disagree — they used to: the pill keyed off the raw wire word while the text
 *  keyed off the mapped one, so a pane reading "idle" wore the loud
 *  attention-coloured pill meant for one that is holding a prompt open. */
function badgeOf(value: string): string {
  return WIRE_TO_BADGE[value] ?? value
}

function statusLabel(value: string): string {
  const key = `paneStatus.${badgeOf(value)}`
  // A machine running a build newer than this one can send a word we have no
  // label for. Showing the raw word is better than showing the key, and far
  // better than hiding the pane.
  const label = t(key)
  return label === key ? value : label
}

function paneCountLabel(count: number): string {
  if (count === 0) return t('settings.p2p.network.panes-none')
  if (count === 1) return t('settings.p2p.network.panes-one')
  return t('settings.p2p.network.panes', { count })
}

/**
 * The second line of a device row.
 *
 * A machine that is not there has no current panes to report, so the two cases
 * say different things: offline rows answer "when was it last here", online
 * rows "what is it running".
 */
function deviceMeta(device: NetworkDevice): string {
  if (device.isLocal || device.online) return paneCountLabel(device.paneCount)
  const seen = lastSeenLabel(device.lastSeenAt)
  const off = t('settings.p2p.network.device-offline')
  return seen ? `${off} · ${seen}` : off
}

/** "8 minutes ago", in the window's language — the row printed the ISO string
 *  the server sent, which is not an answer to "when". */
function lastSeenLabel(iso: string | undefined): string {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(at)) return t('settings.p2p.network.last-seen-unknown')
  const { unit, count } = relativeTime(at, Date.now())
  // `count` is both the placeholder and the plural choice — vue-i18n reads it
  // as the number to select on — so this call was already right and only the
  // message was wrong: English said "38 minute(s) ago", a form written to avoid
  // choosing that nobody says out loud. It now carries both cases. Chinese
  // declines nothing and supplies one, which is what gets picked when there is
  // only one.
  return t(`time.ago-${unit}`, { count })
}

/** The exact moment, on hover. "8 minutes ago" is the right answer to read and
 *  the wrong one to compare against a log. */
function deviceMetaTitle(device: NetworkDevice): string {
  if (device.isLocal || device.online) return ''
  const at = device.lastSeenAt ? Date.parse(device.lastSeenAt) : Number.NaN
  return Number.isFinite(at) ? new Date(at).toLocaleString() : ''
}

const devices = computed<NetworkDevice[]>(() => network.value?.devices ?? [])

/**
 * The three sections a pane can be filed under, in the order they are drawn.
 *
 * The list used to be flat: seventy-four rows in which the two that were
 * running sat between sixty-three that had never been opened, and the only
 * thing separating them was a pill the eye had to read one row at a time. The
 * sections answer "is anything running" before the first row is read.
 */
const GROUP_ORDER = ['running', 'idle', 'not-opened'] as const
type PaneGroupKey = (typeof GROUP_ORDER)[number]

/** Which section a pane belongs to. `not-opened` is decided on the wire
 *  word, not the badge word: the badge word for it is `waiting`, which is also
 *  what an old machine sends for a perfectly live idle pane.
 *
 *  A pane nobody can reach is neither running nor idle: `disconnected` is how
 *  another machine reports its own restore placeholders (only this machine can
 *  say `not-opened`), and a machine that is gone keeps its last rows on the
 *  server. Filed under Idle they outnumbered the panes that were.
 *
 *  Reachability is the device's: `hostOnline` is a directory snapshot that
 *  presence changes do not refresh, while `online` follows them. A row that
 *  does not carry `online` falls back to the snapshot. */
function paneGroupOf(pane: NetworkPane, device: NetworkDevice): PaneGroupKey {
  const reachable = device.isLocal || (device.online ?? pane.hostOnline)
  if (pane.status === 'not-opened' || pane.status === 'disconnected' || !reachable) {
    return 'not-opened'
  }
  return badgeOf(pane.status) === 'running' ? 'running' : 'idle'
}

/** One line in a section: either a pane, or the workspace rule above the first
 *  pane of a run. The rule is not a third level of folding — it is a caption on
 *  the boundary, so a pane is always two clicks from the top, never three. */
interface PaneRow {
  key: string
  /** Non-empty on a workspace rule; `pane` is null on those rows. */
  divider: string
  pane: NetworkPane | null
}

interface PaneGroup {
  key: PaneGroupKey
  count: number
  rows: PaneRow[]
}

/**
 * Split one device's panes into the three sections, with workspace rules.
 *
 * The backend already sorts by (workspace, title), so filing into buckets keeps
 * each section sorted by workspace and a run of equal workspaces is contiguous
 * — the rules only have to watch for the value changing.
 */
function groupsFor(device: NetworkDevice): PaneGroup[] {
  const buckets: Record<PaneGroupKey, NetworkPane[]> = {
    running: [],
    idle: [],
    'not-opened': [],
  }
  for (const pane of device.panes) buckets[paneGroupOf(pane, device)].push(pane)

  const out: PaneGroup[] = []
  for (const key of GROUP_ORDER) {
    const panes = buckets[key]
    if (!panes.length) continue
    // A section that spans one workspace does not need to say so on every
    // boundary — there are none. Drawing the rule anyway is the same repetition
    // the workspace column was, one line further up.
    const spans = new Set(panes.map((pane) => pane.workspace)).size > 1
    const rows: PaneRow[] = []
    let seen: string | null = null
    for (const pane of panes) {
      if (spans && pane.workspace !== seen) {
        seen = pane.workspace
        // A rule with nothing to say is a blank line with a hairline through
        // it. The server can send an empty workspace, and the pane still sorts
        // and renders — it just gets no caption.
        if (seen) rows.push({ key: `ws:${key}:${seen}`, divider: seen, pane: null })
      }
      rows.push({ key: pane.sessionId || pane.paneId, divider: '', pane })
    }
    out.push({ key, count: panes.length, rows })
  }
  return out
}

/** The counts on the three tiles: every device, because the tiles sit above the
 *  device list and a number that only counted one machine would be a lie on a
 *  paired account. */
const paneTotals = computed<Record<PaneGroupKey, number>>(() => {
  const totals: Record<PaneGroupKey, number> = { running: 0, idle: 0, 'not-opened': 0 }
  for (const device of devices.value) {
    for (const pane of device.panes) totals[paneGroupOf(pane, device)] += 1
  }
  return totals
})

const paneTotal = computed(() => {
  const totals = paneTotals.value
  return totals.running + totals.idle + totals['not-opened']
})

/** Which section the tiles have narrowed the list to; '' is all three. */
const paneFilter = ref<PaneGroupKey | ''>('')

function toggleFilter(key: PaneGroupKey): void {
  paneFilter.value = paneFilter.value === key ? '' : key
}

const paneQuery = ref('')

/**
 * Searching abandons the sections on purpose.
 *
 * A hit is meaningful across devices and across states, and once a row is out
 * of its section the section is no longer saying what state it is in — so these
 * rows carry the pill and the workspace back, the two things the grouped view
 * can leave out precisely because position says them.
 */
interface PaneHit {
  key: string
  pane: NetworkPane
  device: string
}

const paneHits = computed<PaneHit[]>(() => {
  const needle = paneQuery.value.trim().toLowerCase()
  if (!needle) return []
  const hits: PaneHit[] = []
  for (const device of devices.value) {
    const name = deviceLabel(device)
    const deviceMatches = name.toLowerCase().includes(needle)
    for (const pane of device.panes) {
      const hay = `${pane.title} ${pane.workspace} ${pane.agentKey}`.toLowerCase()
      if (deviceMatches || hay.includes(needle)) {
        hits.push({ key: `${device.deviceId}:${pane.sessionId || pane.paneId}`, pane, device: name })
      }
    }
  }
  return hits
})

const searching = computed(() => paneQuery.value.trim().length > 0)

/**
 * Folded sections, by key.
 *
 * Stored as explicit overrides rather than as "the set of folded things", so a
 * device that has not been touched still follows the default — and the defaults
 * are the whole point: the sixty-three panes that were never opened start
 * folded, and so does every machine that is not this one.
 */
const FOLD_STORE = 'navide.cloud.paneFolds'
const folds = ref<Record<string, boolean>>(readFolds())

function readFolds(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(FOLD_STORE)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    // A blocked or corrupt store is not a reason to render nothing; the
    // defaults below are perfectly usable on their own.
    return {}
  }
}

function writeFolds(): void {
  try {
    localStorage.setItem(FOLD_STORE, JSON.stringify(folds.value))
  } catch {
    /* the fold still applies for this session */
  }
}

function deviceFoldKey(device: NetworkDevice): string {
  return `dev:${device.deviceId}`
}

function groupFoldKey(device: NetworkDevice, group: PaneGroupKey): string {
  return `${device.deviceId}:${group}`
}

function folded(key: string, fallback: boolean): boolean {
  const set = folds.value[key]
  return set === undefined ? fallback : set
}

function toggleFold(key: string, fallback: boolean): void {
  folds.value = { ...folds.value, [key]: !folded(key, fallback) }
  writeFolds()
}

/** This machine is what the user came to look at; the others start closed. */
function deviceFolded(device: NetworkDevice): boolean {
  return folded(deviceFoldKey(device), !device.isLocal)
}

/** Panes that were restored but never opened are history, not work in progress.
 *  Shown by default they were 85% of the list. */
function groupFolded(device: NetworkDevice, group: PaneGroupKey): boolean {
  return folded(groupFoldKey(device, group), group === 'not-opened')
}

/** Sections left after the tiles have had their say. */
function visibleGroups(device: NetworkDevice): PaneGroup[] {
  const groups = groupsFor(device)
  return paneFilter.value ? groups.filter((group) => group.key === paneFilter.value) : groups
}

/** "started 12 minutes ago" — the only new fact on a pane row, and the reason
 *  the workspace column could be given up without the row losing information. */
function startedLabel(pane: NetworkPane): string {
  const at = pane.startedAt ? Date.parse(pane.startedAt) : Number.NaN
  if (!Number.isFinite(at)) return ''
  const { unit, count } = relativeTime(at, Date.now())
  return t(`time.ago-${unit}`, { count })
}

function startedTitle(pane: NetworkPane): string {
  const at = pane.startedAt ? Date.parse(pane.startedAt) : Number.NaN
  if (!Number.isFinite(at)) return ''
  return t('settings.p2p.network.started-at', { at: new Date(at).toLocaleString() })
}
const accessRequests = computed<AccessRequest[]>(() => network.value?.accessRequests ?? [])
const blocked = computed<BlockedEntry[]>(() => network.value?.blocked ?? [])

/** Which knock is mid-decision, so a double click cannot act twice. */
const deciding = ref('')

/**
 * Act on one knock, then re-read.
 *
 * Every one of these writes the policy document, and the snapshot is what the
 * section is drawn from — so the refresh is not a nicety, it is how the row
 * leaves the screen. Failures keep the row: a rule that was not written must
 * not look like one that was.
 */
async function decide(key: string, type: string, args: Record<string, unknown>): Promise<void> {
  if (deciding.value) return
  deciding.value = key
  try {
    const resp = await props.backend.send(type, args)
    await loadNetwork()
    if (!resp.ok) error.value = resp.error?.message ?? t('account.err-generic')
    // KC3-1: a block refused before it reached the server (p2p-trust-store-full)
    // made nothing; one whose local copy was not saved is in force (fail closed).
    if (type === 'p2p.trust.block' && resp.error?.code === 'p2p-trust-store-full') error.value = t('settings.p2p.trust.block-full')
    if (type === 'p2p.trust.block' && resp.error?.code === 'P2P_BLOCK_NOT_SAVED_LOCALLY') error.value = t('settings.p2p.trust.block-not-saved')
    if (type === 'p2p.trust.block' && resp.error?.code === 'P2P_BLOCK_NOT_SAVED_LOCALLY_FULL') error.value = t('settings.p2p.trust.block-not-saved-full')
  } catch {
    /* the row stays, and the next poll shows whatever is really true */
  } finally {
    deciding.value = ''
  }
}

async function approveRequest(req: AccessRequest): Promise<void> {
  await decide(
    req.key,
    'p2p.access_requests.approve',
    await withConfirmation('p2p.access_requests.approve', '', { key: req.key }, req.key),
  )
}

function dismissRequest(req: AccessRequest): void {
  void decide(req.key, 'p2p.access_requests.dismiss', { key: req.key })
}

async function blockPending(row: PendingDevice): Promise<void> {
  if (pending.value) return
  pending.value = row.deviceId
  try {
    const resp = await props.backend.send(
      'p2p.trust.block',
      await withConfirmation('p2p.trust.block', row.deviceId, { deviceId: row.deviceId }),
    )
    await loadNetwork()
    if (!resp.ok) error.value = resp.error?.message ?? t('account.err-generic')
    if (resp.error?.code === 'p2p-trust-store-full') error.value = t('settings.p2p.trust.block-full')
    if (resp.error?.code === 'P2P_BLOCK_NOT_SAVED_LOCALLY') error.value = t('settings.p2p.trust.block-not-saved')
    if (resp.error?.code === 'P2P_BLOCK_NOT_SAVED_LOCALLY_FULL') error.value = t('settings.p2p.trust.block-not-saved-full')
  } catch {
    /* the row stays, and the next poll shows whatever is really true */
  } finally {
    pending.value = ''
  }
}

function blockRequest(req: AccessRequest): void {
  void (async () =>
    decide(
      req.key,
      'p2p.trust.block',
      await withConfirmation('p2p.trust.block', req.deviceId, {
        deviceId: req.deviceId,
        deviceName: req.deviceName,
      }),
    ))()
}

function unblock(entry: BlockedEntry): void {
  void (async () =>
    decide(
      entry.deviceId || entry.memberId,
      'p2p.trust.unblock',
      await withConfirmation('p2p.trust.unblock', entry.deviceId, {
        deviceId: entry.deviceId,
        memberId: entry.memberId,
      }, entry.memberId),
    ))()
}

/** How a person recognises a blocked row: the name if the directory ever knew
 *  one, else whichever id the block was written against. */
function blockedLabel(entry: BlockedEntry): string {
  return entry.deviceName || entry.deviceId || entry.memberId
}
/** The common case for a new account, and the one a blank box would fail. */
const soloDevice = computed(() => devices.value.length === 1 && devices.value[0].isLocal)
/** The link is down, so what is on screen is the last thing the server said. */
const networkStale = computed(
  () => network.value !== null && network.value.state !== 'connected'
)

/** Turn a server error code into something a person can act on. */
/**
 * Turn a server error into something a person can act on.
 *
 * `where` matters for one code only: RATE_LIMITED now comes from two very
 * different places. Asking for another verification mail too soon is "a link
 * was just sent"; being throttled after repeated sign-in attempts is not, and
 * showing the mail sentence there would send the user looking through an inbox
 * for something nobody sent.
 */
function explain(
  error: { code?: string; message?: string; details?: Record<string, unknown> } | null | undefined,
  fallback: string,
  where: 'auth' | 'resend' = 'auth',
): string {
  const code = error?.code
  // The deployed server may predate account support, in which case it answers
  // UNKNOWN_TYPE. Showing that raw reads as "this dialog is broken".
  if (code === 'UNKNOWN_TYPE') return t('account.err-unsupported')
  if (code === 'EMAIL_TAKEN') return t('account.err-email-taken')
  if (code === 'AUTH_REJECTED') return t('account.err-rejected')
  if (code === 'LINK_OFFLINE') return t('account.err-offline')
  // The server owns the cooldown and the gate; both are answers to show, not
  // failures to retry.
  if (code === 'RATE_LIMITED') {
    if (where === 'resend') return t('settings.p2p.account.verify-rate-limited')
    // The server says how long it will keep refusing; "try again later" without
    // a number is the kind of message people retry against pointlessly.
    const seconds = Math.ceil(Number(error?.details?.retryAfterMs ?? 0) / 1000)
    return seconds > 0
      ? t('account.err-rate-limited', { seconds })
      : t('account.err-rate-limited-soon')
  }
  if (code === 'EMAIL_UNVERIFIED') return t('settings.p2p.account.verify-required')
  return fallback
}

async function submit(): Promise<void> {
  if (busy.value || !canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    let resp
    if (mode.value === 'token') {
      resp = await props.backend.send<{ status: LinkStatus }>('p2p.link.configure', { token: token.value })
    } else {
      const payload: Record<string, unknown> = { email: email.value, password: password.value }
      if (mode.value === 'register') {
      }
      resp = await props.backend.send<{ status: LinkStatus; account?: { emailVerified?: boolean } }>(
        `p2p.account.${mode.value}`,
        payload
      )
    }
    if (!resp.ok) {
      error.value = explain(resp.error, resp.error?.message ?? t('account.err-generic'))
      return
    }
    // The password has served its purpose the moment a token comes back.
    password.value = ''
    token.value = ''
    if (resp.payload?.status) status.value = resp.payload.status
    // A brand new account is never verified, and the mail has just gone out —
    // say so here rather than after the link has finished reconnecting.
    const account = (resp.payload as { account?: { emailVerified?: boolean } } | undefined)?.account
    if (account) { verifyPending.value = account.emailVerified !== true; resent.value = false }
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function signOut(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    // A pasted token has no account to log out of; clearing it is the same act.
    const resp = signedIn.value
      ? await props.backend.send<{ status: LinkStatus }>('p2p.account.logout', {})
      : await props.backend.send<{ status: LinkStatus }>('p2p.link.configure', { token: '' })
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('account.err-generic')
      return
    }
    mode.value = 'login'
    verifyPending.value = false
    resent.value = false
    // The network belonged to the account that just left; showing its last
    // picture to whoever signs in next would be showing them someone else's
    // machines.
    pairingState.clear()
    if (resp.payload?.status) status.value = resp.payload.status
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

/** Whether a re-sign is in flight, so a second click cannot stack. */
const signingPolicy = ref(false)
/** The re-sign had nothing to re-sign and signed the default instead — worth
 *  saying, because "nothing is allowed" is not what the button sounded like. */
const signedDefaultPolicy = ref(false)
/** Verbatim, under the button: a refusal to sign is the whole problem here, so
 *  paraphrasing it would remove the only clue to why. */
const policySignError = ref('')

/**
 * Sign this device's rules again, in place.
 *
 * The signature is over the document plus a counter this machine keeps, so
 * re-writing the same rules produces a new, verifiable signature — which is
 * exactly what the warning is asking for and why this needs no edit. The
 * document comes from the server's own copy rather than from anything cached
 * here: signing a stale document would replace the rules with older ones while
 * looking like it only fixed a signature.
 */
async function signPolicyNow(): Promise<void> {
  if (signingPolicy.value) return
  signingPolicy.value = true
  policySignError.value = ''
  signedDefaultPolicy.value = false
  try {
    const current = await props.backend.send<{ policy?: unknown }>('p2p.policy.get', {})
    const held = current.ok ? current.payload?.policy : null
    const usingDefault = !held || typeof held !== 'object' || Array.isArray(held)
    // A machine that has never had rules still has to be able to clear this,
    // and the only honest document to sign for it is the one that allows
    // nothing — the same default the server hands out at revision 0.
    const doc = usingDefault ? { version: 1, default: 'deny', rules: [] } : held
    const resp = await props.backend.send(
      'p2p.policy.set',
      await withConfirmation('p2p.policy.set', '', { policy: doc }, canonicalJson(doc)),
    )
    if (!resp.ok) {
      policySignError.value = resp.error?.message ?? t('account.err-generic')
      return
    }
    signedDefaultPolicy.value = usingDefault
    // The notice is cleared server-side by the write; this is what takes it off
    // the screen without waiting for the next poll.
    await refresh()
  } catch (err) {
    policySignError.value = err instanceof Error ? err.message : String(err)
  } finally {
    signingPolicy.value = false
  }
}

/** Whether a "check now" is in flight, so a second click cannot stack. */
const checking = ref(false)
/** A check came back still unverified — worth saying, because the button
 *  otherwise looks like it did nothing at all. */
const checkedStillPending = ref(false)

/**
 * Ask the server right now whether the address has been confirmed.
 *
 * The backend polls this every half minute and adopts a push when the server
 * sends one, so this changes nothing about what is eventually true. What it
 * changes is the person in front of a sentence that says "check your mail"
 * seconds after they did: without a way to ask, the only evidence available to
 * them is that clicking the link achieved nothing.
 */
async function checkVerification(): Promise<void> {
  if (checking.value) return
  checking.value = true
  error.value = ''
  checkedStillPending.value = false
  try {
    const resp = await props.backend.send<{ emailVerified: boolean }>(
      'p2p.account.check_verification',
      {}
    )
    if (!resp.ok) {
      error.value = explain(resp.error, resp.error?.message ?? t('account.err-generic'), 'resend')
      return
    }
    if (resp.payload?.emailVerified) {
      verifyPending.value = false
      resent.value = false
      // The card above reads from `status`, so it has to be re-read rather
      // than inferred: this only knows the one field.
      await loadStatus()
    } else {
      checkedStillPending.value = true
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    checking.value = false
  }
}

async function resendVerification(): Promise<void> {
  if (resending.value) return
  resending.value = true
  error.value = ''
  resent.value = false
  try {
    const resp = await props.backend.send<{ emailVerified: boolean; status?: LinkStatus }>(
      'p2p.account.resend_verification',
      {}
    )
    if (!resp.ok) {
      error.value = explain(resp.error, resp.error?.message ?? t('account.err-generic'), 'resend')
      return
    }
    if (resp.payload?.status) status.value = resp.payload.status
    // Already confirmed in a browser since this link signed in: no mail was
    // sent and there is nothing left to nag about.
    if (resp.payload?.emailVerified) verifyPending.value = false
    else resent.value = true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    resending.value = false
  }
}

const canSubmit = computed(() => {
  if (busy.value) return false
  if (mode.value === 'token') return token.value.trim() !== ''
  return email.value.trim() !== '' && password.value !== ''
})

/** Holding a hand-pasted token: linked, but with no account to show. */
const tokenOnly = computed(() => !signedIn.value && Boolean(status.value?.hasToken))

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) emit('close')
}

function startPolling(): void {
  stopPolling()
  void refresh()
  timer = setInterval(() => void refresh(), 3000)
}
function stopPolling(): void {
  if (timer) { clearInterval(timer); timer = null }
}

watch(() => props.open, (open) => {
  if (open) { error.value = ''; resent.value = false; startPolling() } else stopPolling()
})

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  if (props.open) startPolling()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  stopPolling()
})
</script>

<template>
  <div v-if="open" class="s-overlay nv-modal-overlay acct-overlay" @click.self="emit('close')">
    <div class="acct-modal nv-modal-shell" role="dialog" aria-modal="true" :aria-label="t('account.title')">
      <button class="s-close" @click="emit('close')" :title="t('settings.p2p.close')">✕</button>

      <header class="acct-head">
        <span class="acct-mark" aria-hidden="true"><NavideCloudMark /></span>
        <div class="acct-head-text">
          <h1 class="acct-title">{{ t('account.title') }}</h1>
          <p class="tagline">{{ t('account.tagline') }}</p>
        </div>
      </header>

      <!-- Signed in: the credential belongs to the server, so this side only
           shows which account it is and offers to let go of it. -->
      <section v-if="signedIn || tokenOnly" class="body">
        <!-- Said once, above everything it disables: the state belongs to the
             panel, not to any one button. Three parts, in the order somebody
             needs them — what is happening, the transport's own words for why,
             and when it will try again. One sentence carried all three badly,
             and told every state to "retry shortly", which is right for one. -->
        <p v-if="signedIn && linkWaitReason" class="hint link-wait">
          {{ linkWaitReason }}
          <span v-if="linkErrorPlain" class="link-detail" :title="linkErrorDetail">
            {{ linkErrorPlain }}
          </span>
          <span v-if="linkRetryIn" class="link-detail">
            {{ t('settings.p2p.link-retry-in', { seconds: linkRetryIn }) }}
          </span>
        </p>

        <!-- Pairings in flight, at either end. Above everything else in this
             panel: it is the only thing here that another person is currently
             standing in front of, waiting on. -->
        <section v-if="signedIn && (pairings.length || pairingFailures.length)" class="net">
          <h2 class="net-title">{{ t('settings.p2p.pair.title') }}</h2>
          <div class="card net-card">
            <!-- A round that ended because one side refused a frame of it. The
                 card that was waiting is gone; without this, its absence — or
                 five minutes of "waiting" — was all anybody was told. -->
            <div
              v-for="f in pairingFailures"
              :key="'failed:' + f.deviceId + ':' + f.at"
              class="req pair-card"
            >
              <div class="req-head">
                <span class="dev-name" v-truncate>
                  {{ t('settings.p2p.pair.failed-title', { device: f.deviceName || f.deviceId }) }}
                </span>
              </div>
              <p class="req-what danger-text">
                {{ t('settings.p2p.pair.' + failureKey(f), { device: f.deviceName || f.deviceId, reason: f.reason }) }}
              </p>
              <div class="req-acts">
                <button class="btn ghost small" @click="pairingState.dismissFailure(f)">
                  {{ t('settings.p2p.pair.dismiss') }}
                </button>
              </div>
            </div>
            <div v-for="row in pairings" :key="row.deviceId" class="req pair-card">
              <div class="req-head">
                <!-- "Waiting for them to answer" stops being true the moment
                     they answer, and this heading used to say it anyway, over
                     six digits that only exist because they did. The prompt
                     now sits over this window rather than under it, so the two
                     were on screen together saying different things about the
                     same exchange — and this was the half that was wrong. -->
                <span class="dev-name" v-truncate>
                  {{ row.role === 'responder'
                    ? t('settings.p2p.pair.asked-by', { device: row.deviceName || row.deviceId })
                    : t(row.code ? 'settings.p2p.pair.with-device' : 'settings.p2p.pair.asking',
                        { device: row.deviceName || row.deviceId }) }}
                </span>
              </div>
              <!-- Nothing to compare yet: the other machine has not answered.
                   A button that decided something here would be offered before
                   the question it answers exists. -->
              <template v-if="!row.code">
                <!-- Two stages before there is anything to compare: the frame
                     has gone, and the other machine has not answered. They are
                     different waits and the second one is the one worth
                     mentioning to somebody standing at the other machine. -->
                <span class="dev-tag pair-step">
                  {{ t(row.role === 'initiator' ? 'settings.p2p.pair.step-waiting-them'
                                                : 'settings.p2p.pair.step-sent') }}
                </span>
                <p class="req-what">{{ t('settings.p2p.pair.waiting-response') }}</p>
                <p class="hint">{{ t('settings.p2p.pair.auto-updates') }}</p>
                <!-- The way out of a wait. Without it the only end was the
                     five-minute deadline, and pressing "Pair" again in the
                     meantime only said one was already in progress. -->
                <div class="req-acts">
                  <button
                    class="btn ghost small"
                    :disabled="!!pending || !linkReady"
                    :title="linkWaitReason || undefined"
                    @click="answerPairing(row, false)"
                  >
                    {{ t('settings.p2p.pair.cancel-request') }}
                  </button>
                </div>
              </template>
              <template v-else>
                <!-- Labelled: six digits and sixteen hex characters, one above
                     the other, are two things a person is asked to do different
                     things with. -->
                <p class="pair-label">{{ t('settings.p2p.pair.code-label') }}</p>
                <p class="pair-code">{{ row.code }}</p>
                <p class="req-what">
                  {{ t('settings.p2p.pair.compare', { device: row.deviceName || row.deviceId }) }}
                </p>
                <p class="pair-label">{{ t('settings.p2p.pair.fingerprint-label') }}</p>
                <p class="pend-facts"><code>{{ grouped(row.fingerprint) }}</code></p>
                <!-- This side answered; the other has not. Still not paired,
                     which is why this says waiting rather than done. -->
                <!-- Both roles answer, and the same way. The initiator used to
                     have no button here — comparing digits is one act by one
                     person at two screens, and pressing "Pair with…" had
                     already said what this side wanted. That reasoning assumes
                     there is another machine and another person at it. A relay
                     is what breaks the assumption: it can answer with its own
                     key and never forward the request, and this side would pin
                     it having compared nothing with nobody. The digits cannot
                     rescue it — a relay supplies half of what they are derived
                     from and receives the other half, so it knows them. Only a
                     person reading two screens is out of its reach.
                     See device_pairing.complete. -->
                <template v-if="row.state === 'awaiting-remote'">
                  <span class="dev-tag pair-step">{{ t('settings.p2p.pair.step-you-confirmed') }}</span>
                  <p class="req-what">{{ t('settings.p2p.pair.waiting-remote') }}</p>
                  <p class="hint">{{ t('settings.p2p.pair.auto-updates') }}</p>
                  <div class="req-acts">
                    <button
                      class="btn ghost small"
                      :disabled="!!pending || !linkReady"
                      :title="linkWaitReason || undefined"
                      @click="answerPairing(row, false)"
                    >
                      {{ t('settings.p2p.pair.cancel-request') }}
                    </button>
                  </div>
                </template>
                <!-- Whose turn it is, said plainly. The heading above says
                     which exchange this is, not who it is waiting on, so this
                     is the only thing on the card that answers "and now what". -->
                <template v-else>
                <span class="dev-tag pair-step">{{ t('settings.p2p.pair.step-your-turn') }}</span>
                <p class="req-what">{{ t('settings.p2p.pair.your-turn') }}</p>
                <div class="req-acts">
                  <button class="btn small" :disabled="!!pending || !linkReady" @click="answerPairing(row, true)" :title="linkWaitReason || undefined">
                    {{ t('settings.p2p.pair.match') }}
                  </button>
                  <button
                    class="btn ghost small danger"
                    :disabled="!!pending || !linkReady"
                    :title="linkWaitReason || undefined"
                    @click="answerPairing(row, false)"
                  >
                    {{ t('settings.p2p.pair.mismatch') }}
                  </button>
                </div>
                </template>
              </template>
            </div>
          </div>
          <p class="hint">{{ t('settings.p2p.pair.hint') }}</p>
        </section>

        <!-- Everything waiting on a person, under one heading. Pairing and
             access requests are two shapes of one question, and they used to be
             two sections with two near-identical titles — which read as one
             list somebody had split in half. The first attempt at merging hid
             the second heading with CSS; that left the whole region untitled
             whenever there were only access requests, which is the common case.
             So: one section, one heading, two lists. -->
        <section v-if="signedIn && needsYouCount" class="net">
          <h2 class="net-title">
            {{ t('settings.p2p.trust.needs-you', { count: needsYouCount }) }}
          </h2>
          <div v-if="trustPending.length" class="card net-card">
            <p class="hint">{{ t('settings.p2p.trust.pending-body') }}</p>
            <div v-for="row in trustPending" :key="row.deviceId" class="req pending-card">
              <div class="req-head">
                <span class="dev-tag">{{ t('settings.p2p.trust.kind-device') }}</span>
                <!-- The name, at the same weight as the device list uses, so
                     the two surfaces name the same machine the same way. The id
                     is a tooltip: it is what the logs show, and it is not the
                     question anybody is being asked. -->
                <span class="dev-name" v-truncate :title="row.deviceId">
                  {{ row.deviceName || row.deviceId }}
                </span>
              </div>
              <!-- The id stays, in full and underneath: it is what the logs and
                   the other machine's own settings show, so it has to be
                   matchable. It is not the question, though — a uuid is not a
                   machine anybody recognises, which is why the name is above. -->
              <p class="pend-facts">
                <span :class="row.online ? 'ok-text' : 'muted-text'">
                  {{ t(row.online ? 'settings.p2p.trust.pending-online'
                                  : 'settings.p2p.trust.pending-offline') }}
                </span>
                <span>
                  · {{ row.paneCount
                    ? t('settings.p2p.trust.pending-panes', {
                        count: row.paneCount,
                        workspaces: workspaceSummary(row.workspaces),
                      })
                    : t('settings.p2p.trust.pending-panes-none') }}
                </span>
              </p>
              <p class="req-what"><code>{{ grouped(row.fingerprint) }}</code></p>
              <div class="req-acts">
                <!-- The other half of the question. With approval as the only
                     button, somebody who did not recognise a machine could only
                     leave it alone — and doing nothing looked exactly like
                     refusing, while the row stayed listed forever. -->
                <button
                  class="btn ghost small danger"
                  :disabled="!!pending || !linkReady"
                  :title="linkWaitReason || undefined"
                  @click="blockPending(row)"
                >
                  {{ t('settings.p2p.trust.pending-block') }}
                </button>
                <!-- The third answer, and the only one that decides nothing.
                     Without it the choice was decide now or be asked again in
                     three seconds, forever; unpairing looked like the way out
                     and was not — it dropped the pin and the row came back. -->
                <button
                  class="btn ghost small"
                  :disabled="!!pending || !linkReady"
                  :title="linkWaitReason || t('settings.p2p.trust.pending-later-title')"
                  @click="deferDevice(row)"
                >
                  {{ t('settings.p2p.trust.pending-later') }}
                </button>
              </div>
            </div>
          </div>

          <!-- The other shape of the same question. Each row says which it is. -->
          <div v-if="accessRequests.length" class="card net-card">
            <div v-for="req in accessRequests" :key="req.key" class="req">
              <div class="req-head">
                <span class="dev-tag">{{ t('settings.p2p.trust.kind-access') }}</span>
                <span class="dev-name" v-truncate>{{ req.deviceName || req.deviceId }}</span>
                <span v-if="req.attempts > 1" class="dev-count">
                  {{ t('settings.p2p.trust.attempts', { count: req.attempts }) }}
                </span>
              </div>
              <p class="req-what">
                {{ t('settings.p2p.trust.wants', { workspace: req.workspace, pane: req.paneName }) }}
              </p>
              <div class="req-acts">
                <button class="btn small" :disabled="!!deciding || !linkReady" @click="approveRequest(req)" :title="linkWaitReason || undefined">
                  {{ t('settings.p2p.trust.approve') }}
                </button>
                <button class="btn ghost small" :disabled="!!deciding || !linkReady" @click="dismissRequest(req)" :title="linkWaitReason || undefined">
                  {{ t('settings.p2p.trust.dismiss') }}
                </button>
                <button class="btn ghost small danger" :disabled="!!deciding || !linkReady" @click="blockRequest(req)" :title="linkWaitReason || undefined">
                  {{ t('settings.p2p.trust.block') }}
                </button>
              </div>
            </div>
          </div>
          <p v-if="accessRequests.length" class="hint">{{ t('settings.p2p.trust.requests-hint') }}</p>
        </section>

        <!-- The account card sits below the things that are waiting on
             somebody. It answers "which account is this", which nobody opens
             this window to find out while a machine is asking to pair. -->
        <div class="card">
          <template v-if="signedIn">
            <!-- First row, because "can this machine reach the others" is the
                 first thing anybody opens this window to find out. The address
                 answers "which account", which is the second question. -->
            <div class="kv">
              <span>{{ t('settings.p2p.status-label') }}</span>
              <span>
                <span class="dot" :class="dotClass"></span>{{ t('settings.p2p.state-' + state) }}
              </span>
            </div>
            <div class="kv">
              <span>{{ t('settings.p2p.account.email') }}</span>
              <span>
                {{ status?.accountEmail }}
                <span v-if="verified" class="tick" :title="t('settings.p2p.account.verified')">✓</span>
                <!-- The notice below says the same thing, and it is below the
                     device id and the identity block — far enough down that
                     somebody reading the address itself would not see it. This
                     is the state of *this line*, so it belongs on it. -->
                <span v-else-if="signedIn" class="unverified">
                  {{ t('settings.p2p.account.not-verified') }}
                </span>
                <!-- The pill can outlive the notice below it (a resend hides
                     that block), and a warning with no next step is a warning
                     nobody can act on. -->
                <span v-if="!verified && signedIn && !verifyPending" class="unverified-next">
                  {{ t('settings.p2p.account.not-verified-next') }}
                </span>
              </span>
            </div>
            <div v-if="status?.displayName" class="kv">
              <span>{{ t('settings.p2p.account.display-name') }}</span><span>{{ status.displayName }}</span>
            </div>
          </template>
          <div v-else class="kv">
            <span>{{ t('settings.p2p.token') }}</span><span>{{ t('account.token-stored') }}</span>
          </div>
          <!-- A token reaches the relay but names no account, so the directory
               has nothing to list and there is nobody to pair with. Worth
               saying, because the window otherwise looks broken rather than
               half configured. -->
          <p v-if="tokenOnly" class="hint">{{ t('settings.p2p.token-only-note') }}</p>
          <div v-if="status?.deviceId" class="kv">
            <span>{{ t('settings.p2p.device-id') }}</span><span class="mono">{{ status.deviceId }}</span>
          </div>
          <!-- **The only reason this line exists is so that the confirmation box
               on another machine has something to check against.** Pairing asks
               a person to type this machine's first four characters over there;
               until this was here, that box asked for a value the app never
               showed anywhere, so the step could only be guessed at or asked
               for — and a value asked for over the wire is exactly what the
               comparison is meant to catch. It is not decoration. -->
          <div v-if="status?.selfFingerprint" class="kv">
            <span>{{ t('settings.p2p.fingerprint') }}</span>
            <span class="fp-row">
              <code class="mono fp-value">{{ grouped(status.selfFingerprint) }}</code>
              <button
                class="fp-copy"
                :title="t('settings.p2p.fingerprint-copy')"
                @click="copyFingerprint"
              >
                {{ copiedFingerprint ? t('settings.p2p.fingerprint-copied')
                                     : t('settings.p2p.fingerprint-copy') }}
              </button>
            </span>
          </div>

          <!-- Identity news lives with the account rather than in a section of
               its own: it is a handful of lines that are usually absent, and a
               heading over an empty region reads as a feature to go and
               configure. A first sighting is a statement; a changed key is a
               refusal happening right now, and the two are still told apart
               below rather than merged. -->
          <div v-if="signedIn && trustNotices.length" class="ident">
            <!-- Labelled, because a run of unlabelled notices under the account
                 details reads as more account details. The key already existed;
                 it stopped being rendered when this moved into the card. -->
            <p class="ident-label">{{ t('settings.p2p.trust.notices-title') }}</p>
            <div
              v-for="n in standingNotices"
              :key="n.key"
              class="req"
              :class="{ 'req-alert': alertKinds.includes(n.kind) }"
            >
              <template v-if="n.kind === 'device-key-changed'">
                <div class="req-head">
                  <span class="dev-name danger-text" v-truncate>
                    {{ t('settings.p2p.trust.key-changed', { device: n.deviceId }) }}
                  </span>
                  <!-- Present tense, and a standing state rather than a line of
                       prose further down: the refusal is in force while this is
                       on screen, which is the part that decides how urgent it
                       is. -->
                  <span class="dev-tag ts-blocked">
                    {{ t('settings.p2p.trust.key-changed-refusing') }}
                  </span>
                </div>
                <p class="req-what">{{ t('settings.p2p.trust.key-changed-body') }}</p>
                <dl class="fp">
                  <dt>{{ t('settings.p2p.trust.fp-pinned') }}</dt>
                  <dd><code>{{ n.pinnedFingerprint }}</code></dd>
                  <dt>{{ t('settings.p2p.trust.fp-offered') }}</dt>
                  <dd><code>{{ n.offeredFingerprint }}</code></dd>
                </dl>
                <!-- No dismiss: the backend refuses it, and a button that
                     always failed would read as a bug rather than as a rule. -->
                <p class="hint">{{ t('settings.p2p.trust.key-changed-what-to-do') }}</p>
              </template>

              <template v-else-if="n.kind === 'plaintext-refused'">
                <div class="req-head">
                  <span class="dev-name danger-text" v-truncate>
                    {{ t('settings.p2p.trust.plaintext-refused', { device: n.deviceId }) }}
                  </span>
                </div>
                <p class="req-what">{{ t('settings.p2p.trust.plaintext-refused-body') }}</p>
                <p class="hint">{{ t('settings.p2p.trust.plaintext-refused-what-to-do') }}</p>
              </template>

              <template v-else-if="n.kind === 'member-changed'">
                <div class="req-head">
                  <span class="dev-name danger-text" v-truncate>
                    {{ t('settings.p2p.trust.member-changed', { device: n.deviceId }) }}
                  </span>
                </div>
                <p class="req-what">{{ t('settings.p2p.trust.member-changed-body') }}</p>
                <p v-if="n.reason" class="hint">{{ n.reason }}</p>
              </template>

              <template v-else-if="n.kind === 'policy-unverified'">
                <div class="req-head">
                  <span class="dev-name danger-text" v-truncate>
                    {{ t('settings.p2p.trust.policy-unverified') }}
                  </span>
                </div>
                <p class="req-what">{{ t('settings.p2p.trust.policy-unverified-body') }}</p>
                <p v-if="n.reason" class="hint">{{ n.reason }}</p>
                <!-- This notice used to say "open the rules and save them
                     once" and point nowhere, in a window that does not contain
                     the rules. Worse, the rules section has no save button —
                     every change there writes immediately — so the instruction
                     described an act that does not exist. The button does the
                     thing the sentence was asking for. -->
                <div class="req-acts">
                  <button
                    class="btn ghost small"
                    :disabled="signingPolicy || !linkReady"
                    :title="linkWaitReason || undefined"
                    @click="signPolicyNow"
                  >
                    {{ t('settings.p2p.trust.policy-sign') }}
                  </button>
                  <button class="btn ghost small" @click="emit('open-rules')">
                    {{ t('settings.p2p.trust.policy-open-rules') }}
                  </button>
                </div>
                <!-- One line instead of a paragraph: it is a repair for a
                     warning that is right there, not something to learn. -->
                <p class="hint">{{ t('settings.p2p.trust.policy-sign-when') }}</p>
                <p v-if="signedDefaultPolicy" class="hint">
                  {{ t('settings.p2p.trust.policy-signed-default') }}
                </p>
                <p v-if="policySignError" class="hint danger-text">{{ policySignError }}</p>
              </template>

              <!-- Named rather than `v-else`. It used to be the fallthrough,
                   which meant any kind without a branch above was announced as
                   a first sighting — a sentence that is not merely unhelpful
                   but false, and false in the reassuring direction. -->
              <!-- What the other machine did. All three describe something the
                   person here did not do and would otherwise never learn — which
                   is exactly the complaint the two-sided exchange answers. -->
              <template v-else-if="n.kind === 'device-pairing'">
                <div class="req-head">
                  <span class="dev-name" v-truncate>
                    {{ t('settings.p2p.pair.' + n.pairing, { device: n.deviceName || n.deviceId }) }}
                  </span>
                </div>
              </template>

              <template v-else-if="n.kind === 'device-first-seen'">
                <div class="req-head">
                  <span class="dev-name" v-truncate>
                    {{ t('settings.p2p.trust.first-seen', { device: n.deviceId }) }}
                  </span>
                  <span v-if="n.own" class="dev-tag">
                    {{ t('settings.p2p.trust.first-seen-own') }}
                  </span>
                </div>
                <p class="req-what">
                  <code>{{ n.fingerprint }}</code>
                </p>
                <p v-if="n.own" class="hint">{{ t('settings.p2p.trust.first-seen-own-body') }}</p>
                <div class="req-acts">
                  <button class="btn ghost small" :disabled="!!pending || !linkReady" @click="dismissNotice(n)" :title="linkWaitReason || undefined">
                    {{ t('settings.p2p.trust.notice-ack') }}
                  </button>
                </div>
              </template>

              <!-- A kind this build has no branch for. Showing it raw is ugly
                   and deliberate: the alternatives are to render nothing, which
                   hides a security notice the backend thought worth recording,
                   or to borrow another branch's wording, which is how this
                   panel came to announce member changes as first sightings. -->
              <template v-else>
                <div class="req-head">
                  <span class="dev-name danger-text" v-truncate>
                    {{ t('settings.p2p.trust.unknown-notice', { kind: n.kind }) }}
                  </span>
                </div>
                <p class="req-what"><code>{{ n.deviceId }}</code></p>
              </template>
            </div>
            <!-- Collapsed, and no JavaScript: <details> is the one control the
                 platform already has for "keep this, do not show it to me".
                 One line per delivery is the right record and the wrong list. -->
            <details v-if="logNotices.length" class="cmd-log">
              <summary>
                {{ t('settings.p2p.pair.commands-summary', { count: logNotices.length }) }}
              </summary>
              <p v-for="row in logByDevice" :key="row.key" class="cmd-line">
                {{ t('settings.p2p.pair.log-line', { device: row.label, count: row.count }) }}
              </p>
            </details>
          </div>
        </div>
        <!-- Soft gate: nothing here is blocked while unverified, so this is a
             notice with a way to act on it, not a wall. -->
        <div v-if="signedIn && verifyPending" class="verify">
          <p class="hint">{{ t('settings.p2p.account.verify-sent', { email: status?.accountEmail }) }}</p>
          <!-- The question somebody actually has after clicking the link and
               finding this sentence still here. Asking is cheap and the answer
               arrives on its own within half a minute anyway, so this is
               impatience rather than repair — but staring at a stale sentence
               is exactly what makes people think the click failed. -->
          <button
            class="btn ghost small"
            :disabled="checking || resending || !linkReady"
            :title="linkWaitReason || undefined"
            @click="checkVerification"
          >
            {{ t('settings.p2p.account.verify-check') }}
          </button>
          <button
            class="btn ghost small"
            :disabled="resending || !linkReady"
            :title="linkWaitReason || undefined"
            @click="resendVerification"
          >
            {{ t('settings.p2p.account.verify-resend') }}
          </button>
        </div>
        <p v-if="checkedStillPending" class="hint">
          {{ t('settings.p2p.account.verify-still-pending') }}
        </p>
        <p v-if="resent" class="hint">{{ t('settings.p2p.account.verify-resent') }}</p>

        <!-- Your network: the same card/kv/hint language as the account block
             above, one more section of the same panel. The box keeps its height
             whether it is waiting, empty or full, so the modal does not jump
             under the pointer when the first snapshot lands. -->
        <section v-if="signedIn" class="net">
          <div class="net-head">
            <h2 class="net-title">{{ t('settings.p2p.network.title') }}</h2>
            <!-- Being paired is identity, not permission: what a device may
                 reach is decided by the rules, which live in another window.
                 The pill said "Trusted" and people read it as "may drive this
                 machine", which is one window away from true. -->
            <button class="dev-review net-rules" @click="emit('open-rules')">
              {{ t('settings.p2p.network.who-can-command') }}
            </button>
          </div>

          <!-- The switch and what it is doing, in one row. The state text is
               the link's own answer, not a guess: paused says the user did
               this, every other value says what the connection is actually
               doing, and `detail` carries the reason when there is one. A
               connection surface that rounded any of that off would be the one
               place in the app lying about the thing it exists to report. -->
          <div class="card link-card">
            <div class="link-row">
              <span class="dot" :class="paused ? 'idle' : dotClass"></span>
              <!-- The same words the footer and the Settings card use. Three
                   surfaces on one screen saying three things about one fact is
                   how "unauthorized" came to read as amber here and red there. -->
              <span class="link-state">
                {{ paused ? t('settings.p2p.link.paused') : t('settings.p2p.state-' + state) }}
              </span>
              <button class="btn ghost small link-btn" :disabled="!!pending" @click="togglePaused">
                {{ paused ? t('settings.p2p.link.resume') : t('settings.p2p.link.pause') }}
              </button>
            </div>
            <p v-if="paused" class="hint">{{ t('settings.p2p.link.paused-body') }}</p>
            <p v-else-if="status?.detail" class="hint">{{ status.detail }}</p>
            <!-- The address only. The device id and its fingerprint live on
                 the account card, one screen up: repeating identity here made
                 this card look like a second account panel. -->
            <dl class="kv link-kv">
              <dt>{{ t('settings.p2p.link.server') }}</dt>
              <dd><code>{{ status?.serverUrl }}</code></dd>
            </dl>
          </div>

          <!-- The link has lost trust state it once had. It sits between the
               connection and the directory because that is what it is about:
               the list below cannot be trusted while this is unresolved. There
               is a way out, and it is one click behind a warning: "start over"
               is what an attacker who deleted that state is waiting for, so it
               must never happen by itself — but the only alternative on a
               machine that hits this was Keychain Access, which is the same
               reset performed with less information and leaves the two halves
               disagreeing. Loud and deliberate beats undiscoverable. -->
          <!-- There was a card here saying "no rules yet on this device —
               nothing from your other machines can reach this one until you
               write at least one rule". It was removed because that is not
               true, and it named the one audience for whom it is least true.
               Do not add it back in that form.

               Your own machines never reach the policy at all: a sender this
               device has paired with lands in RING_SELF, and RING_SELF skips
               the policy check outright (server_link `refused = ... trust_ring
               != RING_SELF and not pane_policy.is_allowed(...)`). A sender it
               has *not* paired with is refused earlier still, by
               `_authenticate_sender`, as NOT_PAIRED. Neither path reaches the
               state the card described.

               What the policy actually governs is devices belonging to *other
               people's* accounts. A card about an empty policy would have to
               say that, and would have to be worth interrupting somebody for.
               The backend still reports `policyEmpty`; it is a true fact with
               no honest use here yet. -->
          <div v-if="trustJournalProblem" class="card journal-card">
            <p class="req-what">{{ t('settings.p2p.trust.journal-problem') }}</p>
            <p class="hint">{{ trustJournalProblem }}</p>
          </div>
          <div v-if="trustLocked" class="card locked-card">
            <h2 class="net-title">{{ t('settings.p2p.trust.locked-title') }}</h2>
            <p v-if="trustFull" class="req-what">{{ t('settings.p2p.trust.full-body') }}</p>
            <template v-else>
              <p v-if="trustDamaged" class="req-what">{{ t('settings.p2p.trust.damaged-body') }}</p>
              <p v-else class="req-what">{{ t('settings.p2p.trust.locked-body') }}</p>
              <p class="hint">{{ trustLocked }}</p>
              <p v-if="trustLockedTransient" class="hint locked-warn">
                {{ t('settings.p2p.trust.locked-retrying') }}
              </p>
              <p v-else-if="rebuildDone" class="hint ok-text">
                {{ t('settings.p2p.trust.rebuild-done') }}
              </p>
              <template v-else-if="rebuildArmed">
                <p class="hint locked-warn">
                  {{ t(trustDamaged ? 'settings.p2p.trust.damaged-rebuild-warn' : 'settings.p2p.trust.rebuild-warn') }}
                </p>
                <div class="locked-acts">
                  <button
                    class="dev-review locked-go"
                    :disabled="!!pending"
                    @click="rebuildTrust()"
                  >
                    {{ t('settings.p2p.trust.rebuild-confirm') }}
                  </button>
                  <button class="dev-review" :disabled="!!pending" @click="rebuildArmed = false">
                    {{ t('settings.p2p.trust.rebuild-cancel') }}
                  </button>
                </div>
              </template>
              <div v-else class="locked-acts">
                <button
                  class="dev-review"
                  :title="t('settings.p2p.trust.rebuild-title')"
                  @click="rebuildArmed = true"
                >
                  {{ t('settings.p2p.trust.rebuild') }}
                </button>
              </div>
            </template>
          </div>

          <div class="card net-card">
            <p v-if="networkUnavailable" class="hint net-note">
              {{ t('settings.p2p.network.unavailable') }}
            </p>
            <p v-else-if="!network" class="hint net-note">
              {{ t('settings.p2p.network.loading') }}
            </p>
            <template v-else>
              <!-- Three numbers before the first row, because "is anything
                   running" was the question the list was being scrolled to
                   answer. They are also the filter: a fourth row of chips
                   saying the same three words would be the repetition this
                   redesign exists to remove. -->
              <div v-if="paneTotal" class="pane-tiles">
                <button
                  v-for="key in GROUP_ORDER"
                  :key="key"
                  type="button"
                  class="pane-tile"
                  :class="[`tile-${key}`, { on: paneFilter === key }]"
                  :aria-pressed="paneFilter === key"
                  @click="toggleFilter(key)"
                >
                  <span class="tile-n">{{ paneTotals[key] }}</span>
                  <span class="tile-l">
                    <span class="dot" :class="key === 'running' ? 'ok' : 'idle'"></span>
                    {{ t(`settings.p2p.network.group-${key}`) }}
                  </span>
                </button>
              </div>
              <div v-if="paneTotal" class="pane-search">
                <input
                  v-model="paneQuery"
                  type="search"
                  class="pane-search-input"
                  :placeholder="t('settings.p2p.network.search-placeholder')"
                  :aria-label="t('settings.p2p.network.search-placeholder')"
                />
              </div>

              <!-- Searching drops the sections: a hit means something across
                   every machine and every state, and a section that has been
                   filtered down to one row is no longer grouping anything. -->
              <template v-if="searching">
                <ul v-if="paneHits.length" class="panes flat">
                  <li v-for="hit in paneHits" :key="hit.key" class="pane">
                    <span class="pane-agent">{{ hit.pane.agentKey || '—' }}</span>
                    <span class="pane-name" v-truncate>{{ hit.pane.title }}</span>
                    <span v-if="dockWindowLabelKey(hit.pane.surface)" class="pane-window">{{ t(dockWindowLabelKey(hit.pane.surface)!) }}</span>
                    <span class="pane-ws" v-truncate>{{ hit.device }} · {{ hit.pane.workspace }}</span>
                    <!-- The pill comes back here and only here: out of its
                         section, the row has nothing else saying what state it
                         is in. -->
                    <span class="pane-pill" :class="'st-' + badgeOf(hit.pane.status)">
                      {{ statusLabel(hit.pane.status) }}
                    </span>
                  </li>
                </ul>
                <p v-else class="hint net-note">{{ t('settings.p2p.network.no-match') }}</p>
              </template>

              <!-- The one thing the old list did not have: a ceiling. Seventy-
                   four rows had nothing to stop them, so the roster grew until
                   the dialog was as tall as the screen. -->
              <div v-else class="pane-roster">
              <div v-for="device in devices" :key="device.deviceId" class="dev">
                <div class="dev-head">
                  <!-- The whole machine folds. On a paired account the other
                       machines' rosters are context, not the thing you opened
                       this for, so they start closed. -->
                  <button
                    type="button"
                    class="dev-fold"
                    :aria-expanded="!deviceFolded(device)"
                    :title="t(deviceFolded(device) ? 'settings.p2p.network.expand' : 'settings.p2p.network.collapse')"
                    @click="toggleFold(deviceFoldKey(device), !device.isLocal)"
                  >
                    {{ deviceFolded(device) ? '▸' : '▾' }}
                  </button>
                  <span
                    class="dot"
                    :class="device.online ? 'ok' : 'idle'"
                    :title="t(device.online ? 'settings.p2p.network.device-online' : 'settings.p2p.network.device-offline')"
                  ></span>
                  <!-- The one thing on this row a person is looking for, so it
                       is the one thing allowed to take the space: it stretches,
                       everything else is its natural width. It used to share a
                       line with five other elements and was clipped to "M…"
                       while a two-line sentence about being offline sat beside
                       it. -->
                  <span class="dev-name" v-truncate="device.deviceName || device.deviceId">{{ deviceLabel(device) }}</span>
                  <span v-if="device.isLocal" class="dev-tag">
                    {{ t('settings.p2p.network.this-device') }}
                  </span>
                  <!-- Where the machine is, or what it is running. Beside the
                       name rather than under it: a second line turned every row
                       into two, which is a lot of height for the secondary
                       half of the sentence. -->
                  <span class="dev-meta" v-truncate :title="deviceMetaTitle(device)">
                    {{ deviceMeta(device) }}
                  </span>
                  <!-- Without this the list said nothing about trust, so a
                       device you had never vouched for looked exactly like one
                       you had — while the card above was asking you to confirm
                       it. Two surfaces, one device, opposite stories. -->
                  <!-- Presence moved to the line below. It is a fact that
                       changes on its own; trust is a decision somebody made,
                       and only the second one belongs beside the name. -->
                  <span
                    v-if="!device.isLocal && device.trustState"
                    class="dev-tag"
                    :class="'ts-' + device.trustState"
                  >
                    {{ t('settings.p2p.trust.state-' + device.trustState) }}
                  </span>
                  <!-- Asking, not granting. This used to pair the other
                       machine outright once you had typed four characters of
                       its fingerprint — one side deciding, the other finding
                       out when something started running on it. Now it puts a
                       card on both screens and nothing is written until two
                       people have compared the same six digits. -->
                  <button
                    v-if="device.canTrust"
                    class="dev-review"
                    :disabled="!!pending || !linkReady"
                    :title="linkWaitReason || t('settings.p2p.pair.start-title')"
                    @click="startPairing(device)"
                  >
                    {{ t('settings.p2p.pair.start') }}
                  </button>
                  <!-- It has knocked and the card above is asking about it, so
                       this points there rather than asking a second time. -->
                  <!-- Only when that device is actually on the card below.
                       Otherwise it scrolled to a section that was not there and
                       nothing happened, which reads as a broken button. -->
                  <button
                    v-else-if="!device.isLocal && device.online && hasPendingRow(device)"
                    class="dev-review"
                    @click="reviewPending()"
                  >
                    {{ t('settings.p2p.trust.review') }}
                  </button>
                  <!-- Not on this machine's own row: there is no pairing with
                       yourself to undo, and the button would read as one.
                       Last, and quiet: on a row that is already settled this is
                       the one thing you are least likely to have come for. -->
                  <!-- Kept on an offline row, unlike everything else: it is
                       the one act that does not need the other machine, and a
                       device you want rid of is often one that is not there. -->
                  <button
                    v-if="!device.isLocal && device.trustState === 'trusted'"
                    class="dev-review dev-undo"
                    :disabled="!!pending || !linkReady"
                    :title="linkWaitReason || t('settings.p2p.trust.unpair-title')"
                    @click="unpairDevice(device.deviceId)"
                  >
                    {{ t('settings.p2p.trust.unpair') }}
                  </button>
                </div>
                <template v-if="!deviceFolded(device)">
                  <!-- One block per state, each foldable. The pane rows below
                       carry no status pill: the section they are in is the
                       status, and saying it again on every row is how the old
                       list spent a fifth of its width repeating itself. -->
                  <div
                    v-for="group in visibleGroups(device)"
                    :key="group.key"
                    class="pane-group"
                  >
                    <button
                      type="button"
                      class="grp-head"
                      :class="`grp-${group.key}`"
                      :aria-expanded="!groupFolded(device, group.key)"
                      @click="toggleFold(groupFoldKey(device, group.key), group.key === 'not-opened')"
                    >
                      <span class="grp-caret">{{ groupFolded(device, group.key) ? '▸' : '▾' }}</span>
                      <span class="dot" :class="group.key === 'running' ? 'ok' : 'idle'"></span>
                      <span class="grp-name">{{ t(`settings.p2p.network.group-${group.key}`) }}</span>
                      <span class="grp-count">{{ group.count }}</span>
                    </button>
                    <ul v-if="!groupFolded(device, group.key)" class="panes">
                      <template v-for="row in group.rows" :key="row.key">
                        <!-- Not a third fold, a caption on the boundary: the
                             workspace used to be a column repeated on all
                             seventy-four rows. -->
                        <li v-if="!row.pane" class="pane-wsrule">{{ row.divider }}</li>
                        <li v-else class="pane">
                          <span class="pane-agent">{{ row.pane.agentKey || '—' }}</span>
                          <!-- `title` because the longest name is the one
                               carrying the most information, and it was the one
                               being clipped. -->
                          <span class="pane-name" v-truncate>{{ row.pane.title }}</span>
                          <!-- An embedded AI panel says which window it lives in. -->
                          <span v-if="dockWindowLabelKey(row.pane.surface)" class="pane-window">{{ t(dockWindowLabelKey(row.pane.surface)!) }}</span>
                          <PaneGitChip v-if="device.isLocal && row.pane.git" :git="row.pane.git" />
                          <span class="pane-time" :title="startedTitle(row.pane)">
                            {{ startedLabel(row.pane) }}
                          </span>
                        </li>
                      </template>
                    </ul>
                  </div>
                  <p v-if="!device.panes.length" class="hint net-note">
                    {{ t('settings.p2p.network.no-panes') }}
                  </p>
                </template>
              </div>
              </div>
            </template>
          </div>
          <!-- One machine is not an error state, and it is what every new
               account looks like — so it gets the way forward, not a blank box. -->
          <!-- One machine is not an error, it is what every new account looks
               like — and "nobody else is here" is not an answer to "how do I
               get somebody else here". -->
          <div v-if="soloDevice" class="solo-guide">
            <p class="hint">{{ t('settings.p2p.network.solo') }}</p>
            <p class="solo-title">{{ t('settings.p2p.first-pair-title') }}</p>
            <ol class="solo-steps">
              <li>{{ t('settings.p2p.first-pair-1') }}</li>
              <li>{{ t('settings.p2p.first-pair-2') }}</li>
              <li>{{ t('settings.p2p.first-pair-3') }}</li>
            </ol>
          </div>
          <!-- Two different reasons for the same picture, and naming the wrong
               one is worse than naming none: this said "the link is down" on a
               screen whose connection card was green, because the snapshot had
               failed to load while the socket was fine. -->
          <p v-if="readFailed" class="hint">{{ t('settings.p2p.network.not-current') }}</p>
          <p v-else-if="networkStale" class="hint">{{ t('settings.p2p.network.link-offline') }}</p>
        </section>

        <!-- Only when something is blocked: an empty list here would read as a
             feature the user has to configure, and it is the opposite — the
             absence of a block is the normal state. -->
        <section v-if="signedIn && blocked.length" class="net">
          <h2 class="net-title">{{ t('settings.p2p.trust.blocked-title') }}</h2>
          <div class="card net-card">
            <div v-for="entry in blocked" :key="entry.deviceId || entry.memberId" class="req">
              <div class="req-head">
                <span class="dev-name" v-truncate>{{ blockedLabel(entry) }}</span>
                <span v-if="entry.reason" class="dev-count">{{ entry.reason }}</span>
              </div>
              <div class="req-acts">
                <button class="btn ghost small" :disabled="!!deciding || !linkReady" @click="unblock(entry)" :title="linkWaitReason || undefined">
                  {{ t('settings.p2p.trust.unblock') }}
                </button>
              </div>
            </div>
          </div>
          <p class="hint">{{ t('settings.p2p.trust.blocked-hint') }}</p>
        </section>

        <button class="btn ghost wide" :disabled="busy" @click="signOut">
          <!-- Signing out of an account and removing a pasted token are two
               different acts; one word for both told half the users the wrong
               thing about what the button does. -->
          {{ t(tokenOnly ? 'settings.p2p.account.remove-token'
                         : 'settings.p2p.account.sign-out') }}
        </button>
      </section>

      <section v-else class="body">
        <div class="tabs" role="tablist">
          <button
            v-for="m in (['login', 'register', 'token'] as const)"
            :key="m"
            type="button"
            role="tab"
            class="tab"
            :class="{ on: mode === m }"
            :aria-selected="mode === m"
            :disabled="busy"
            @click="mode = m; error = ''"
          >
            {{ t('settings.p2p.account.tab-' + m) }}
          </button>
        </div>

        <template v-if="mode === 'token'">
          <!-- Pasting a token directly: kept for machines that have no
               account to sign in with (CI, servers). -->
          <label class="lbl" for="acct-token">{{ t('settings.p2p.token') }}</label>
          <input
            id="acct-token"
            v-model="token"
            type="password"
            spellcheck="false"
            autocomplete="off"
            :disabled="busy"
            :placeholder="t('settings.p2p.token-placeholder')"
            @keyup.enter="submit"
          />
          <p class="hint">{{ t('settings.p2p.token-hint') }}</p>
        </template>

        <template v-else>
          <label class="lbl" for="acct-email">{{ t('settings.p2p.account.email') }}</label>
          <input
            id="acct-email"
            v-model="email"
            type="email"
            autocomplete="username"
            spellcheck="false"
            :disabled="busy"
            placeholder="you@example.com"
          />

          <label class="lbl" for="acct-password">{{ t('settings.p2p.account.password') }}</label>
          <input
            id="acct-password"
            v-model="password"
            type="password"
            :autocomplete="mode === 'register' ? 'new-password' : 'current-password'"
            spellcheck="false"
            :disabled="busy"
            :placeholder="t('settings.p2p.account.password-placeholder')"
            @keyup.enter="submit"
          />

          <!-- A display name is not asked for: the server derives one from the
               email when the field is absent (see accounts.ts), and it cannot be
               changed later anyway, so a field here would only be a decision the
               user cannot revisit. There used to be a network name beside it;
               the identity convergence removed that concept from the server. -->
          <p v-if="mode === 'register'" class="hint">{{ t('settings.p2p.account.account-hint') }}</p>
        </template>

        <button class="btn wide" :disabled="!canSubmit" @click="submit">
          {{ t('settings.p2p.account.submit-' + mode) }}
        </button>
        <p v-if="mode === 'register'" class="hint">{{ t('account.no-recovery') }}</p>
      </section>

      <footer class="acct-foot">
        <!-- One row: where the link stands on the left, what this window agrees
             to on the right. Two stacked lines with an underlined link read as a
             web page footer rather than as part of an app. -->
        <div class="foot-row">
          <p class="status">
            <span class="dot" :class="loaded ? dotClass : 'idle'"></span>
            {{ loaded ? t('settings.p2p.state-' + state) : t('settings.p2p.loading') }}
          </p>
          <!-- The addresses come from the shared table through preload; nothing
               here assembles a URL. -->
          <span class="legal-row">
            <button class="legal-link" @click="openLegal('privacy')">{{ t('settings.p2p.legal-privacy') }}</button>
            <span aria-hidden="true">·</span>
            <button class="legal-link" @click="openLegal('boundaries')">{{ t('settings.p2p.legal-boundaries') }}</button>
          </span>
        </div>
        <!-- The error stays: it is about the act somebody just performed, and
             the footer is where the eye goes after pressing something. The
             link's own detail moved to the link card, where the link is. -->
        <p v-if="error" class="err">{{ error }}</p>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Overlay and shell mirror SettingsModal's .s-overlay / .s-modal so the two
   dialogs read as one family; only the panel is narrower. */
.s-overlay {
  position: fixed;
  inset: 0;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  /* The modal band, under the toast band the pairing prompt lives in. It was
     8000 against the prompt's 3000, so a pairing request — a question that
     expires in five minutes — was drawn behind this window and blurred by its
     own backdrop filter. A number picked to beat whatever was on screen at the
     time is the bug; the offset only keeps this above the other overlays it
     was already above. */
  z-index: calc(var(--z-modal) + 120);
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}
.acct-modal {
  position: relative;
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-lg);
  width: min(440px, 92vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-modal);
  font-size: 13px;
  line-height: 1.6;
}
.s-close {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 30;
  border: none;
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: var(--font-lg);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  line-height: 1;
}
.s-close:hover { background: var(--bg-muted); color: var(--text-bright); }
.s-close:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
/* Brand header. The mark is what names the feature — "Navide Cloud" is a new
   word for something the app already did, so the first screen that says it has
   to also show it. The tinted band is the only decorative surface in this
   dialog; everything below stays flat so the eye lands here first. */
.acct-head {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 22px 28px 16px;
  background:
    radial-gradient(120% 160% at 0% 0%, var(--accent-subtle) 0%, transparent 62%);
  border-bottom: 1px solid var(--border-muted);
}
.acct-mark {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--accent-muted);
  background: var(--bg-subtle);
  color: var(--accent-fg);
  --nv-cloud-node-fill: var(--bg-subtle);
}
.acct-mark :deep(.nv-cloud-mark) { width: 26px; height: 20px; }
.acct-head-text { min-width: 0; }
.acct-title {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--text-bright);
  letter-spacing: 0.01em;
}
.tagline { margin: 4px 0 0; font-size: 12px; color: var(--text-secondary); }
.body { padding: 4px 28px 0; overflow-y: auto; }
.tabs { display: flex; gap: 2px; margin: 0 0 12px; border-bottom: 1px solid var(--border-default); }
.tab {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 7px 12px; font-size: 12.5px; color: var(--text-secondary); cursor: pointer;
}
.tab.on { color: var(--text-bright); border-bottom-color: var(--accent-emphasis); font-weight: 500; }
.tab:hover:not(:disabled) { color: var(--text-bright); background: var(--bg-muted); border-radius: var(--radius-control); }
.tab:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: -2px; border-radius: var(--radius-control); }
.tab:disabled { opacity: 0.5; cursor: default; }
.lbl { display: block; font-size: 11.5px; color: var(--text-secondary); margin: 12px 0 5px; }
input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-inset); border: 1px solid var(--border-default);
  border-radius: var(--radius-sm); padding: 8px 10px; color: inherit; font: inherit; font-size: 12.5px;
}
input:focus {
  outline: none; border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 2px var(--accent-focus, rgba(31, 111, 235, 0.3));
}
.btn {
  appearance: none; border-radius: var(--radius-sm); padding: 9px 16px; font: inherit; font-size: 12.5px;
  font-weight: 500; cursor: pointer;
  background: var(--accent-emphasis); border: 1px solid var(--accent-emphasis); color: var(--text-on-emphasis);
}
.btn:not(:disabled) { transition: background var(--motion-fast, 120ms) var(--ease-out, ease-out), border-color var(--motion-fast, 120ms) var(--ease-out, ease-out), color var(--motion-fast, 120ms) var(--ease-out, ease-out); }
.btn:not(:disabled):hover { box-shadow: inset 0 0 0 1px var(--text-on-emphasis); }
.btn.ghost:not(:disabled):hover { background: var(--bg-muted); border-color: var(--border-strong); box-shadow: none; }
.btn:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.btn.ghost { background: transparent; border-color: var(--border-default); color: inherit; }
.btn.wide { display: block; width: 100%; margin-top: 18px; }
.btn:disabled { opacity: 0.5; cursor: default; }
.card {
  border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: 4px 14px; margin-top: 8px; background: var(--bg-subtle);
}
.kv {
  display: flex; justify-content: space-between; gap: 12px; font-size: 12px;
  padding: 7px 0; border-bottom: 1px solid var(--border-muted);
}
.kv:last-child { border-bottom: 0; }
.kv span:first-child { color: var(--text-secondary); flex-shrink: 0; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; word-break: break-all; }
.hint { margin: 8px 0 0; font-size: 11.5px; color: var(--text-secondary); }
/* Amber, and on the address line itself. The tick beside a verified address is
   the same idea in the other direction, so they sit in the same place. */
.unverified {
  margin-left: 6px; padding: 1px 6px; border-radius: 999px;
  font-size: 11px; color: var(--attention-fg);
  border: 1px solid var(--attention-fg); opacity: 0.9;
}
.verify { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.verify .hint { margin: 0; flex: 1; }
/* One definition. It was declared twice with different padding; the later one
   won silently, so reading the first told you the opposite of what rendered. */
.btn.small { padding: 2px 10px; font-size: 12px; flex-shrink: 0; }
.tick { color: var(--success-fg); margin-left: 5px; }
/* Your network. Same card, same hint, same dot as the account block above —
   only the rows inside are new. */
.net { margin-top: 18px; }
.net-head { display: flex; align-items: baseline; gap: 10px; }
.net-head .net-title { flex: 1; }
.net-rules { margin-left: 0; }
.net-title { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--text-secondary); }

/* Identity news, inside the account card. Separated by a hairline rather than
   by a heading: these lines are usually absent, and a heading over an empty
   region reads as a feature the user has to go and configure. */
.ident { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-muted); }
/* A left rule, not a colour on the text: these are already dense, and the one
   thing that has to be legible at a glance is which of them is a refusal. */
.req-alert { border-left: 2px solid var(--danger-fg); padding-left: 8px; }
.cmd-log { margin-top: 10px; font-size: 12px; color: var(--text-secondary); }
.cmd-log summary { cursor: pointer; }
.cmd-line { margin: 4px 0 0 14px; }
.ident-label {
  margin: 0 0 8px; font-size: var(--font-3xs); text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-secondary);
}
.ident .req + .req { margin-top: 12px; }
/* Reserved height: the section is filled by a poll, and a box that grows from
   nothing moves the sign-out button out from under the pointer. */
.net-card { min-height: 62px; padding: 10px 14px; }
.net-note { margin: 0; }
.dev + .dev { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-muted); }
/* One line, never two. `nowrap` on the container stops the items wrapping and
   on the text stops a long label breaking mid-row; what gives instead is the
   name, which truncates. */
.dev-head {
  display: flex; flex-wrap: nowrap; align-items: center; gap: 6px;
  font-size: 12px; white-space: nowrap;
}
/* The shared .dot carries a margin for the footer status line; here the flex gap does that job. */
.dev-head .dot { margin-right: 0; flex: none; }
/* The only element allowed to give up space, and the last one that should have
   to. `min-width: 0` is what lets it shrink at all — a flex item's floor is its
   content, so without it the name pushes the row wider and the pill wraps. */
.dev-name {
  flex: 1 1 auto; min-width: 0;
  color: var(--text-bright); font-size: 14px; font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* One capsule shape for every pill. The trust pills were bare coloured text,
   which reads as prose rather than as a state. */
.dev-tag {
  padding: 1px 6px; border-radius: var(--radius-pill, 999px); font-size: var(--font-3xs);
  background: var(--bg-inset); color: var(--text-secondary); flex: none;
}
.dev-count { margin-left: auto; font-size: 11px; color: var(--text-secondary); flex-shrink: 0; }
/* Three numbers and the filter, in one control each. `aria-pressed` rather than
   a checked input: they are toggles over a list, not a form. */
.pane-roster, .panes.flat { max-height: 260px; overflow-y: auto; }
.pane-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 8px; }
.pane-tile {
  display: block; text-align: left; cursor: pointer;
  padding: 6px 8px; border: 1px solid var(--border-muted); border-radius: var(--radius-md, 8px);
  background: var(--bg-inset); color: var(--text-primary);
  transition: border-color var(--motion-fast, 120ms) var(--ease-out, ease);
}
.pane-tile:hover { border-color: var(--border-default); }
.pane-tile.on { border-color: var(--accent-emphasis); background: var(--accent-subtle); }
.pane-tile .tile-n {
  display: block; font-size: 17px; font-weight: 600; line-height: 1.15;
  font-variant-numeric: tabular-nums; color: var(--text-bright);
}
.pane-tile.tile-running .tile-n { color: var(--success-fg); }
.pane-tile .tile-l {
  display: flex; align-items: center; font-size: var(--font-3xs); color: var(--text-secondary);
}
.pane-tile .tile-l .dot { width: 6px; height: 6px; margin-right: 5px; }
.pane-search { margin-bottom: 8px; }
/* Only the size. Background, border, radius and the focus ring come from this
   modal's own `input` rule above — a second set of values here is how one field
   ends up looking like it belongs to a different dialog. */
.pane-search-input { padding: 4px 8px; font-size: 11.5px; }
/* The section header is the status, which is why the rows below carry no pill. */
.grp-head {
  display: flex; align-items: center; gap: 6px; width: 100%; cursor: pointer;
  margin-top: 6px; padding: 2px 0 2px 2px; border: 0; background: none;
  font-size: 11.5px; color: var(--text-secondary); text-align: left;
}
.grp-head:hover .grp-name { color: var(--text-bright); }
.grp-caret { width: 9px; font-size: 9px; color: var(--text-secondary); flex: none; }
.grp-head .dot { margin-right: 0; }
.grp-name { flex: 1 1 auto; min-width: 0; font-weight: 500; }
.grp-count { flex: none; font-variant-numeric: tabular-nums; }
/* Same shape as the group caret so the two folds read as one mechanism. */
.dev-fold {
  width: 14px; padding: 0; border: 0; background: none; cursor: pointer;
  font-size: 9px; color: var(--text-secondary); flex: none;
}
.panes { list-style: none; margin: 2px 0 0; padding: 0; }
.pane {
  display: flex; align-items: center; gap: 8px; padding: 3px 0 3px 14px; font-size: 11.5px;
}
/* A caption on a boundary, not a row: it only appears where the workspace
   changes, and only in a section that spans more than one. */
.pane-wsrule {
  display: flex; align-items: center; gap: 8px; margin: 5px 0 1px; padding-left: 14px;
  font-size: var(--font-3xs); letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--text-secondary);
}
.pane-wsrule::after { content: ''; flex: 1; height: 1px; background: var(--border-muted); }
.pane-agent { color: var(--text-secondary); flex-shrink: 0; }
/* The only element that may take the space it needs. It used to share the row
   with a workspace column repeated on every line and was clipped instead. */
.pane-name {
  flex: 1 1 auto; color: var(--text-bright); min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pane-time {
  flex: none; font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums;
}
.pane-window {
  flex: none; padding: 0 5px; border-radius: var(--radius-pill, 999px); font-size: var(--font-3xs);
  border: 1px solid var(--border-muted); color: var(--text-secondary);
}
/* Search results only: there the row is out of its section, so the workspace
   and the device have to be said again. */
.panes.flat .pane-ws {
  color: var(--text-secondary); font-size: 11px; min-width: 0; flex: 0 1 auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Capsule, like every other pill. This was the 4px square the report named. */
.pane-pill {
  flex-shrink: 0; padding: 1px 6px; border-radius: var(--radius-pill, 999px); font-size: var(--font-3xs);
  border: 1px solid transparent; background: var(--bg-inset); color: var(--text-secondary);
}
/* Three groups, so the eye sorts them before it reads them: solid means the
   pane wants something from you, hollow means it does not, red means it is
   broken. `awaiting` is the loud one on purpose — a pane holding a prompt open
   is the whole reason to look at another machine's list. */
.pane-pill.st-running { background: var(--success-fg); color: var(--text-on-emphasis); }
.pane-pill.st-awaiting { background: var(--attention-fg); color: var(--text-on-emphasis); }
/* `waiting` is the badge word for "not opened" — a restore placeholder, the
   quietest thing on the list. It wore the loud attention pill because the class
   was built from the raw wire word, where `waiting` means a live idle pane;
   both ends now read the same mapped word, so the colour matches the label. */
.pane-pill.st-waiting,
.pane-pill.st-idle,
.pane-pill.st-starting,
.pane-pill.st-disconnected { background: none; border-color: var(--border-default); }
.pane-pill.st-error,
.pane-pill.st-stopped,
.pane-pill.st-exited { background: none; border-color: var(--danger-fg); color: var(--danger-fg); }
/* A knock is a row that owes an answer, so it gets a little more room than a
   pane line and its own separator — the same card, one step louder. */
/* The switch row: one line that answers "is it on, what is it doing, and can
   I change that" without the eye having to travel. */
.link-card { margin-bottom: 10px; }
.link-row { display: flex; align-items: center; gap: 8px; }
.link-state { font-weight: 600; }
.link-btn { margin-left: auto; }
.link-kv { margin-top: 8px; }
.link-kv code { font-size: 11px; word-break: break-all; }
.dot.warn { background: var(--attention-fg); }
.danger-text { color: var(--danger-fg); }
/* Fingerprints sit in their own grid so the two halves line up character by
   character — the whole point is that a person can compare them. */
.fp { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 6px 0; font-size: 12px; }
.fp dt { color: var(--text-secondary); }
.fp dd { margin: 0; }
.fp code { font-size: 12px; letter-spacing: 0.04em; }
/* It sits between the connection card and the directory — the position the
   warning has to be read from — so it needs the same gap the connection card
   carries. Restored: the rule was written when the card moved there and was
   lost to a parallel edit before it reached any commit. */
.journal-card { margin-bottom: 10px; }
.locked-card { border-color: var(--danger-fg); margin-bottom: 10px; }
.req { padding: 8px 0; border-bottom: 1px solid var(--border-muted); }
.req:last-child { border-bottom: none; }
.req:first-child { padding-top: 0; }
.req-head { display: flex; align-items: baseline; gap: 8px; }
.req-what { margin: 3px 0 7px; font-size: 12px; color: var(--text-secondary); }
.req-acts { display: flex; gap: 6px; }
.btn.ghost.small.danger { color: var(--danger-fg); }
/* Where the machine is and what it has open, under the name. Small and muted:
   the fingerprint below is what the decision actually turns on. */
.pend-facts { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); }
.ok-text { color: var(--success-fg, var(--text-primary)); }
.muted-text { color: var(--text-secondary); }
.dev-tag.ts-trusted { color: var(--success-fg); }
.dev-tag.ts-pending { color: var(--attention-fg); }
.dev-tag.ts-blocked { color: var(--danger-fg); }
/* Secondary, so it is the first thing to give way when the row runs out of
   room — that is what the large shrink factor buys. The name has shrink 1 and
   is therefore the last thing clipped, which is the whole point: a row reading
   "M… · 38 minutes ago" tells you when something you cannot identify was last
   seen. */
.dev-meta {
  flex: 0 999 auto; min-width: 0;
  color: var(--text-secondary); font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.solo-guide { margin-top: 4px; }
.solo-title { margin: 10px 0 4px; font-size: 12px; color: var(--text-primary); font-weight: 500; }
.solo-steps {
  margin: 0; padding-left: 18px; font-size: 12px;
  color: var(--text-secondary); line-height: 1.6;
}
/* The row's one action, pushed to the far edge. Only ever one of them shows —
   a device is undecided or settled, not both — so the auto margin can live on
   the shared class rather than on each button. */
/* Secondary: a real outline, so it reads as something you press. It was a bare
   word with a transparent border, which on a row of text is indistinguishable
   from a label. */
.dev-review {
  flex: none;
  background: none; border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: 12px; padding: 2px 8px; border-radius: var(--radius-control, 6px);
  cursor: pointer;
}
.dev-review:hover { color: var(--text-primary); border-color: var(--border-strong, var(--border-default)); }
.dev-review:disabled { opacity: 0.5; cursor: default; }
/* Destructive, and quiet at rest: unpairing a settled device is the thing on
   this row you are least likely to have come for. Red only on hover, so the row
   does not look alarming for simply existing. */
.dev-undo { color: var(--text-muted, var(--text-secondary)); }
.dev-undo:hover { color: var(--danger-fg); border-color: var(--danger-fg); }
/* The pairing button used to be `btn ghost small`, which is a slightly larger
   shape than the other two actions on this row and read as the primary thing to
   do on every unpaired device. It now shares .dev-review with them: same
   padding, same size, same weight. The label went with it — "Pair with this
   device…" took the width of the row to say what one word says, and the full
   sentence lives in the tooltip where it costs nothing. */
/* The question the button opens, inside the row it is about. Indented to the
   name above it so it reads as that row saying something, not as a new item. */
/* Big, because it is read aloud across a desk or over a call — and because two
   people reading different digits is the failure this whole exchange exists to
   make visible. */
.pair-label {
  margin: 8px 0 0; font-size: var(--font-3xs); text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-secondary);
}
.pair-step { display: inline-block; margin-bottom: 4px; }
.pair-code {
  margin: 2px 0 0; font-family: var(--font-mono, monospace);
  font-size: 22px; letter-spacing: 0.18em; color: var(--text-primary);
  user-select: text;
}
.dev-review:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 1px; }
/* The warning reads as one, and the button that acts on it is the only red
   thing on the card — so the eye lands on the cost before the control. */
.locked-warn { color: var(--danger-fg); line-height: 1.55; margin-top: 8px; }
.locked-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.locked-go { color: var(--danger-fg); border-color: var(--danger-fg); }
.locked-go:hover { background: var(--danger-subtle); }
/* `st-not-opened` used to be here. The pill is now keyed on the badge word, and
   `not-opened` maps to `waiting` — the hollow rule above covers it. */
.status { display: flex; align-items: center; margin: 0; font-size: 12.5px; color: var(--text-secondary); }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; flex-shrink: 0; }
.dot.ok { background: var(--success-fg); }
.dot.err { background: var(--danger-fg); }
.dot.idle { background: var(--text-secondary); }
.detail { margin: 4px 0 0; font-size: var(--font-2xs); color: var(--text-secondary); word-break: break-all; }
/* Selectable, because the whole use of this line is being read or copied off
   this screen and typed on another. */
.fp-row { display: inline-flex; align-items: center; gap: 8px; }
.fp-value { user-select: text; letter-spacing: 0.06em; }
.fp-copy {
  background: none; border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  padding: 1px 6px; font-size: 11px; color: var(--text-secondary); cursor: pointer;
}
.fp-copy:hover { color: var(--text-primary); }
.fp-copy:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 1px; }
.link-wait { margin: 0 0 10px; color: var(--attention-fg); }
.unverified-next { margin-left: 6px; font-size: 11px; color: var(--text-secondary); }
/* The transport's own words, quieter than the sentence explaining them: it is
   the identifying detail, not the thing to read first. */
.link-detail { display: block; margin-top: 2px; color: var(--text-secondary); word-break: break-word; }
.acct-foot { padding: 12px 28px; }
.foot-row { display: flex; align-items: center; gap: 10px; }
/* Right-aligned rather than on its own line: it is a footnote about this
   window, not an action, and stacking it made the footer look like a page. */
.legal-row { display: flex; align-items: center; gap: 6px; margin-left: auto;
             font-size: 12.5px; color: var(--text-secondary); }
.legal-link {
  background: none; border: 0; padding: 0; cursor: pointer;
  font: inherit; color: var(--text-secondary); text-decoration: none;
}
.legal-link:hover { color: var(--text-primary); text-decoration: underline; }
.legal-link:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.err { margin: 8px 0 0; font-size: 11.5px; color: var(--danger-fg); }
</style>
