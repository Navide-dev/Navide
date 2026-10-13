<script setup lang="ts">
// AiCliDock — the shared right-side CLI agent terminal shell (rail toggle +
// resize + agent picker + Start/Interrupt/Stop + embedded PTY terminal),
// extracted from the Pipeline Manager window's inline AI panel so other
// standalone windows (Plan) can embed the same real-CLI panel.
//
// Layout contract (inherited from the retired AiChatDock): renders three
// siblings (rail / resize
// handle / panel) meant to sit at the END of a row-flex container. Width is
// clamped 280–600 and persisted per-window via `widthKey`. The terminal mounts
// EAGERLY as soon as a workspace exists — panel visibility is v-show only —
// because the connect-time reattach must claim ownership of a still-running
// PTY even while the panel stays closed; an unclaimed PTY is reaped by the
// backend janitor after its idle window.
//
// State machine carried over from the PM panel verbatim:
// - connect-time tryReattach (once per window life) with a `reattaching` lock
//   that keeps Start disabled — a spawn racing the reattach would double-bind
//   the session handlers (doubled output + leaked subscription);
// - Start requires a live backend connection and always means a NEW PTY
//   (skipReattach: true; a still-live predecessor is reaped via
//   replaces_terminal_id);
// - context (host-supplied `buildContext`) is injected on FRESH spawns only —
//   reattach keeps the running conversation untouched;
// - Stop while 'starting' cancels the pending terminal.create (no sessionId
//   yet, kill() would be a no-op and a hung create uncancellable).
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { CLI_AGENT_SPECS } from '../agents'
import {
  bracketedPaste,
  dockOutputLogFile,
  dockSurfaceForOrigin,
  dockWindowLabelKey,
  pickDockPaneName,
  resolveCliCommand,
} from '../lib/aiCliContext'
import { cliPermissionKey, parseCliPermissionMode, skipPermissionFlagFor } from '../lib/cliPermission'
import { buildResumeCommand, isShellSafeSessionId } from '../lib/resume-command'
import {
  clusterMentionCandidates,
  type DockAgentMessage,
  type MentionCandidate,
  type TerminalDockPort,
} from '@navide/terminal'
import AiCliTerminal from './AiCliTerminal.vue'

const props = withDefaults(
  defineProps<{
    /** Settings key persisting this window's panel width (per-window). */
    widthKey: string
    /** Workspace the CLI spawns in; empty shows the no-workspace empty state. */
    workspacePath: string
    terminalPort: TerminalDockPort
    /** Pane id, unique per (surface, workspace) — derive it with
     *  aiTerminalPaneId(). The first 8 chars MUST be hex: aider's per-pane
     *  chat-history file name is derived from paneId.slice(0, 8) and the
     *  backend only claims 8-hex tokens — a non-hex prefix silently degrades
     *  aider to the SHARED history file. */
    paneId: string
    /** terminal.create metadata origin tag (e.g. 'pipeline-manager'). */
    origin: string
    /** False while the host is still resolving its workspace — suppresses the
     *  no-workspace empty state until the answer is definitive. */
    workspaceResolved?: boolean
    /** Initial width when no persisted value exists yet. */
    defaultWidth?: number
    /** i18n key for the rail tooltip and panel header title. */
    titleKey?: string
    /** Settings key persisting the agent choice; defaults to `${widthKey}.agent`. */
    agentKeyStorageKey?: string
    /** Subset of agent keys offered in the picker; defaults to all CLI agents. */
    agentKeys?: string[]
    /** Context payload injected after a fresh spawn; nothing is injected when
     *  absent. May be async (e.g. reads the open document via the backend). */
    buildContext?: () => string | Promise<string>
    /** Silence window after the CLI's startup output before injecting. */
    injectQuietMs?: number
    /** Hard cap on waiting for that silence. */
    injectTimeoutMs?: number
  }>(),
  {
    workspaceResolved: true,
    defaultWidth: 360,
    titleKey: 'pane.ai-terminal.title',
    injectQuietMs: 2000,
    injectTimeoutMs: 12000,
  }
)

const emit = defineEmits<{
  (e: 'spawned', agentKey: string): void
  (e: 'exited'): void
  (e: 'status', status: string): void
}>()

const { t } = useI18n()

// ── Shell: open state, lazy mount, width ────────────────────────────────────

const open = defineModel<boolean>('open', { default: false })

function toggle(): void {
  open.value = !open.value
}

function clampWidth(w: number): number {
  return Math.max(280, Math.min(600, w))
}
const width = ref(clampWidth(parseInt(settingsGet(props.widthKey, String(props.defaultWidth)), 10)))
let resizing = false
// The dock's right edge is the viewport edge in a standalone window but not
// when the host is a centered modal, so measure it instead of assuming.
const panelRef = ref<HTMLElement | null>(null)
let resizeAnchorX = 0
function onResizeStart(): void {
  resizing = true
  // A zero right edge means the element has no layout yet — fall back to the viewport.
  resizeAnchorX = panelRef.value?.getBoundingClientRect().right || window.innerWidth
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
}
function onResizeMove(e: MouseEvent): void {
  if (!resizing) return
  width.value = clampWidth(resizeAnchorX - e.clientX)
}
function onResizeEnd(): void {
  if (!resizing) return
  resizing = false
  settingsSet(props.widthKey, String(width.value))
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
}
onUnmounted(() => {
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
})

// ── CLI state machine ───────────────────────────────────────────────────────

const termRef = ref<InstanceType<typeof AiCliTerminal> | null>(null)

const agentSpecs = computed(() =>
  props.agentKeys
    ? CLI_AGENT_SPECS.filter((s) => props.agentKeys!.includes(s.agentKey))
    : CLI_AGENT_SPECS
)
const agentStorageKey = computed(() => props.agentKeyStorageKey ?? `${props.widthKey}.agent`)
const agentKey = ref(settingsGet<string>(agentStorageKey.value, 'claude'))
watch(agentKey, (k) => settingsSet(agentStorageKey.value, k))

const starting = ref(false)
const status = computed(() => termRef.value?.status ?? 'idle')
/** A PTY is attached (fresh spawn or reattach) and not yet exited. */
const active = computed(() => status.value === 'starting' || status.value === 'running')
const agentLabel = computed(
  () => CLI_AGENT_SPECS.find((s) => s.agentKey === agentKey.value)?.label ?? agentKey.value
)
const workspaceName = computed(() => props.workspacePath.split('/').filter(Boolean).pop() ?? '')

watch(status, (s, prev) => {
  emit('status', s)
  const wasActive = prev === 'starting' || prev === 'running'
  if (wasActive && !(s === 'starting' || s === 'running')) emit('exited')
})

// Connect-time reattach (once per window life): claim a CLI left running by a
// previous window instance instead of respawning. Runs once the backend is
// connected AND a workspace exists (the terminal mounts eagerly with it, even
// while the panel is closed) — a dead or absent PTY simply leaves the Start UI
// showing. Start is locked out while it is in flight (see header note).
let reattachAttempted = false
const reattaching = ref(false)
async function maybeReattach(): Promise<void> {
  if (reattachAttempted) return
  if (props.terminalPort.status.value !== 'connected') return
  if (!props.workspacePath) return
  reattachAttempted = true
  reattaching.value = true
  let reattached = false
  try {
    await nextTick() // the v-if just unlocked — let the terminal mount first
    // Pass the agent: this path never calls spawn(), which is the only other
    // place useTerminal records it, and the input protocol (Shift+Enter,
    // bracketed paste) degrades to plain-shell encoding without it.
    reattached = (await termRef.value?.tryReattach({ agentKey: agentKey.value })) === true
  } catch { /* PTY gone — fall through to the Start UI */ }
  finally { reattaching.value = false }
  if (!reattached && !active.value) await maybeResume()
}

// Restore: no PTY survived, but the backend still holds this panel's record as
// 'spawned' — the app quit with the CLI running (closing the panel's window
// retires the record). Resume that conversation as the main window resumes a
// pane after a restart; with no record, no session id, or a port that cannot
// read one, the Start UI stays as it was.
async function maybeResume(): Promise<void> {
  const read = props.terminalPort.readDockRestore
  if (!read) return
  let record: { agentKey: string; sessionId: string } | null = null
  try {
    record = await read(props.workspacePath, props.paneId)
  } catch {
    return
  }
  if (!record?.sessionId || !isShellSafeSessionId(record.sessionId)) return
  if (!agentSpecs.value.some((s) => s.agentKey === record.agentKey)) return
  // The plugin behind this surface was removed: retire the record, not resume.
  const retired = await props.terminalPort.dockSurfaceRetired?.(
    props.workspacePath, props.paneId, dockSurface.value.surface,
  ).catch(() => false)
  if (retired) return
  agentKey.value = record.agentKey
  await launch(record.sessionId)
}
watch(
  [() => props.terminalPort.status.value, () => props.workspacePath],
  () => void maybeReattach(),
  { immediate: true }
)

// Names offered by the terminal's @-mention menu: every pane in the backend
// messaging roster except this one, as `<folder>/<pane>` addresses. Polled
// rather than pushed (as in the main window) — the list only feeds
// autocomplete, so a stale snapshot costs nothing; routing always re-resolves
// in the backend. The panel's own entry (see the roster registration below) is
// left out — it cannot receive messages, so offering it would only bounce.
const mentionTargets = ref<MentionCandidate[]>([])
async function refreshMentionTargets(): Promise<void> {
  if (props.terminalPort.status.value !== 'connected') return
  try {
    const resp = await props.terminalPort.listAgentPanes()
    // Every address here lives in another window, so none of them carries a
    // status this panel could read — the menu draws hollow dots and says so by
    // omission rather than inventing one. Sections are KEYED on the workspace's
    // absolute path, as in the main window's menu, so two projects whose
    // folders share a name do not merge into one section; the header shows the
    // workspace's display name (its user-set alias) when the roster carries
    // one, and the folder name otherwise.
    mentionTargets.value = clusterMentionCandidates(
      (resp.payload?.panes ?? [])
        .filter((p) => p.qualified_name && p.pane_id !== props.paneId)
        .map((p) => {
          const folder = p.workspace_label || (p.qualified_name as string).split('/')[0]
          // An older backend sends neither field: the key falls back to the
          // (ambiguous) folder name and the header to the folder name too. The
          // alias is absent rather than blank when unknown, so a whitespace-only
          // value never blanks a section header.
          const label = p.workspace_display_name?.trim() || folder
          // Another embedded panel names the window it lives in, as in the
          // main window's menu; a window pane has no label.
          const windowKey = dockWindowLabelKey(p.surface)
          return {
            address: p.qualified_name as string,
            group: p.workspace_path || folder,
            groupLabel: label,
            ...(windowKey ? { windowLabel: t(windowKey) } : {}),
          }
        })
    )
  } catch {
    mentionTargets.value = []
  }
}
// Stable identity so the terminal's prop does not churn on every render; the
// polled list is read through it when the menu opens.
const mentionCandidateGetter = (): MentionCandidate[] => mentionTargets.value
watch(() => props.terminalPort.status.value, () => void refreshMentionTargets(), { immediate: true })
const mentionPollTimer = setInterval(() => void refreshMentionTargets(), 10_000)
onUnmounted(() => clearInterval(mentionPollTimer))

// ── Messaging roster registration ──────────────────────────────────────────
// The CLI here is wired to Navide's MCP tools under this panel's pane id, and
// every one of them refuses an id the backend's messaging roster has never
// seen. So while a CLI runs, the panel registers itself — named after its
// window (`pm-claude`, `plans-codex`, …) and marked with that window's surface.
// The backend refuses it as a message target unless it registers as
// deliverable, which it does when its port can hand it messages (see the
// delivery section below). Re-sent after a reconnect, as the main window
// re-mirrors its panes; dropped when the CLI ends or the panel unmounts.
const dockSurface = computed(() => dockSurfaceForOrigin(props.origin))
let registeredAs: { paneId: string; name: string } | null = null
/** The roster name while registered, shown in the header: it is the address
 *  every other pane reaches this panel by. Empty while unregistered. */
const rosterAddress = ref('')
// Bumped by every unregister, so a register still in flight when the CLI ends
// knows to undo itself instead of leaving a dead panel in the roster.
let registerSeq = 0
// A refused registration is retried before the panel gives up and says why: a
// Plan window reload races its old connection, which holds the pane id until
// the backend sees it close (FORBIDDEN "held by another window"). Until it
// registers, every Navide tool the CLI calls is refused too.
const REGISTER_RETRY_DELAYS_MS = [1000, 2000, 4000]
let registerRetryTimer: ReturnType<typeof setTimeout> | null = null
/** Why the last registration attempt failed, once retries ran out. */
const rosterError = ref('')

function clearRegisterRetry(): void {
  if (registerRetryTimer) clearTimeout(registerRetryTimer)
  registerRetryTimer = null
}

function dropRegistration(paneId: string): void {
  void Promise.resolve(props.terminalPort.unregisterAgentPane?.(paneId)).catch(() => undefined)
}

async function registerInRoster(attempt = 0): Promise<void> {
  const port = props.terminalPort
  if (!port.registerAgentPane || !props.workspacePath) return
  clearRegisterRetry()
  const seq = ++registerSeq
  const paneId = props.paneId
  let name = registeredAs?.paneId === paneId ? registeredAs.name : ''
  if (!name) {
    let panes: Parameters<typeof pickDockPaneName>[3] = []
    try {
      panes = (await port.listAgentPanes()).payload?.panes ?? []
    } catch { /* no roster to check against — take the plain name */ }
    if (seq !== registerSeq) return
    name = pickDockPaneName(`${dockSurface.value.surface}-${agentKey.value}`, props.workspacePath, paneId, panes)
  }
  let accepted = false
  let failure = ''
  try {
    const resp = await port.registerAgentPane({
      pane_id: paneId,
      name,
      workspace_path: props.workspacePath,
      agent_key: agentKey.value,
      surface: dockSurface.value.surface,
      window_kind: dockSurface.value.windowKind,
      ...(port.onAgentMessage ? { deliverable: true } : {}),
    })
    accepted = resp.ok
    // A host that cannot map the call never will: stay unregistered quietly,
    // as on a port without registerAgentPane.
    if (!accepted && resp.error?.code === 'UNMAPPED_CAPABILITY') return
    if (!accepted) failure = resp.error?.message || resp.error?.code || ''
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  if (seq !== registerSeq) {
    if (accepted) dropRegistration(paneId)
    return
  }
  // A refused or unroutable registration leaves no entry: show no address that
  // nothing answers at. Retry; a reconnect also starts over.
  if (!accepted) {
    const delay = REGISTER_RETRY_DELAYS_MS[attempt]
    if (delay === undefined) {
      rosterError.value = failure || t('dockWindow.roster-error-unknown')
      return
    }
    registerRetryTimer = setTimeout(() => {
      registerRetryTimer = null
      if (seq === registerSeq && props.terminalPort.status.value === 'connected') void registerInRoster(attempt + 1)
    }, delay)
    return
  }
  registeredAs = { paneId, name }
  rosterAddress.value = name
  rosterError.value = ''
}

function unregisterFromRoster(): void {
  registerSeq++
  clearRegisterRetry()
  const previous = registeredAs
  registeredAs = null
  rosterAddress.value = ''
  rosterError.value = ''
  if (previous) dropRegistration(previous.paneId)
}

watch(
  [active, () => props.terminalPort.status.value, () => props.paneId],
  ([isActive, conn], [, prevConn]) => {
    if (!isActive) {
      unregisterFromRoster()
      return
    }
    if (conn !== 'connected') return
    if (registeredAs && registeredAs.paneId !== props.paneId) unregisterFromRoster()
    // Newly running, back from a dropped connection (the backend marked the
    // entry offline and will forget it), or re-keyed: (re-)register.
    if (!registeredAs || prevConn !== 'connected') void registerInRoster()
  },
)
onUnmounted(unregisterFromRoster)

// The panel opens from display:none — refit once measurable so the terminal
// paints at the real width (sanctioned explicit-refit path, no history loss).
watch(open, (o) => {
  if (o) void nextTick(() => termRef.value?.fitTerminal({ redrawAfterSettle: true }))
})

function start(): Promise<void> {
  return launch('')
}

/** Spawn the CLI: fresh, or resuming `resumeSessionId` (restore only — it
 *  gets neither a new session pin nor the host's context). */
async function launch(resumeSessionId: string): Promise<void> {
  const term = termRef.value
  // Also require a live connection: a create queued while disconnected would
  // race the connect-time tryReattach and double-bind output handlers.
  if (!term || !props.workspacePath || starting.value || active.value || reattaching.value) return
  if (props.terminalPort.status.value !== 'connected') return
  starting.value = true
  try {
    const shell = props.terminalPort.shell.value || 'bash'
    const resumeCommand = resumeSessionId
      ? buildResumeCommand(agentKey.value, resumeSessionId, skipPermissionFlagFor({
        spec: CLI_AGENT_SPECS.find((s) => s.agentKey === agentKey.value),
        globalYolo: (settingsGet<string | null>('agentTeam.yolo', null) ?? '1') === '1',
        mode: parseCliPermissionMode(settingsGet<string | null>(cliPermissionKey(agentKey.value), null)),
      }))
      : ''
    if (resumeSessionId && !resumeCommand) return // vendor cannot resume by id
    const resolved = resolveCliCommand({
      agentKey: agentKey.value,
      paneId: props.paneId,
      historyRoot: props.workspacePath,
      yoloStored: settingsGet<string | null>('agentTeam.yolo', null),
      permissionStored: settingsGet<string | null>(cliPermissionKey(agentKey.value), null),
    })
    // Pin the session id the way the main window does for a fresh pane, so the
    // backend binds this CLI's session to the panel deterministically. The
    // host owns the function; a port without it spawns unpinned, as before.
    const pinned = resumeCommand
      ? { command: resumeCommand, explicitSessionId: resumeSessionId }
      : props.terminalPort.pinFreshSessionAtLaunch?.(
        agentKey.value, false, resolved, undefined, () => crypto.randomUUID(),
      ) ?? { command: resolved, explicitSessionId: '' }
    const command = pinned.command
    await term.spawn({
      // The host port knows the platform and builds the command (PowerShell and
      // cmd.exe on Windows; the same wrapping as App.vue spawns elsewhere).
      // This dock only ever spawns CLI agents, so it is always an agent pane —
      // on Windows that skips the PowerShell wrapper (a `--mcp-config {…}`
      // payload would not survive `-Command`). Without a port: zsh reads
      // ~/.zshrc (where installers add PATH) only in interactive mode — plain
      // -lc misses it.
      command:
        props.terminalPort.spawnArgv?.(shell, command, { agentPane: true }) ??
        [shell, shell.endsWith('zsh') ? '-ilc' : '-lc', command],
      cwd: props.workspacePath,
      agentKey: agentKey.value,
      metadata: {
        workspace_path: props.workspacePath,
        origin: props.origin,
        yolo: settingsGet<string>('agentTeam.yolo', '1') !== '0',
        // A panel surface makes the backend file this spawn's restore record
        // and Agent History entry, which no window does for a panel.
        surface: dockSurface.value.surface,
        window_kind: dockSurface.value.windowKind,
        cli_command: command,
        agent_label: agentLabel.value,
        ...(pinned.explicitSessionId ? { explicit_session_id: pinned.explicitSessionId } : {}),
      },
      // Same place the main window logs a manual pane. No resumeKey: it would
      // rewrite useTerminal's persist key, and the connect-time reattach finds
      // the PTY by pane id.
      outputLogFile: dockOutputLogFile(props.workspacePath, agentKey.value, props.paneId, dockSurface.value.surface),
      // Start always means a NEW PTY. Reattach belongs to the connect-time
      // tryReattach above — letting spawn's internal reattach run here could
      // rebind a live conversation and re-inject context into it. A still-live
      // predecessor is reaped via replaces_terminal_id.
      skipReattach: true,
    })
    // Context is injected on FRESH spawns only — reattach keeps the running
    // conversation untouched (mount-time tryReattach already claimed any live
    // PTY, so reaching here means this spawn created a new one).
    if (term.status === 'running') {
      emit('spawned', agentKey.value)
      if (!resumeCommand) void injectContext()
    }
  } catch { /* spawn errors are rendered inside the terminal by useTerminal */ }
  finally { starting.value = false }
}

/** Paste `build()`'s text and submit it. True when both the paste and the
 *  submitting CR left; false when there was nothing to send or a send failed. */
async function pasteContext(
  term: InstanceType<typeof AiCliTerminal>,
  build: () => string | Promise<string>
): Promise<boolean> {
  const text = await build()
  if (!text) return false
  // The two halves are separate sends 300 ms apart, so the transport can go
  // down between them. Sending the CR regardless would submit whatever the
  // prompt already held — or an empty line — as if it were this context.
  if (!term.pasteText(bracketedPaste(text))) return false
  // Let the CLI ingest the paste before the submitting CR.
  await new Promise((r) => setTimeout(r, 300))
  return term.pasteText('\r')
}

/** Wait for the CLI's output to go quiet (injectQuietMs of silence after its
 *  first output, injectTimeoutMs cap). 'timed-out' when the cap ran out first,
 *  false when the CLI died meanwhile. */
async function waitForQuiet(term: InstanceType<typeof AiCliTerminal>): Promise<'quiet' | 'timed-out' | false> {
  const deadline = Date.now() + props.injectTimeoutMs
  for (;;) {
    const last = term.lastRawActivityAt
    if (last > 0 && Date.now() - last >= props.injectQuietMs) return 'quiet'
    if (Date.now() >= deadline) return 'timed-out'
    await new Promise((r) => setTimeout(r, 250))
    if (term.status !== 'running') return false
  }
}

/** Best-effort context injection after a fresh spawn: wait for the CLI's
 *  startup output to go quiet, then bracketed-paste the host's context and
 *  submit. Failure never blocks the CLI. */
async function injectContext(): Promise<void> {
  const term = termRef.value
  const build = props.buildContext
  if (!term || !build) return
  try {
    if (!(await waitForQuiet(term))) return // died during startup — nothing to inject
    await pasteContext(term, build)
  } catch { /* best-effort */ }
}

// ── Message delivery ────────────────────────────────────────────────────────
// A port that can hand over routed messages (onAgentMessage) makes this panel
// a message target like any window pane: the backend broadcasts every routed
// message, the port renders the main window's envelope, and the panel takes
// the ones addressed to it — once each, one at a time, after the CLI goes
// quiet — and reports the outcome. Messages for other panes are left to their
// own windows without a word, as the main window does.
const DELIVERED_KEYS_CAP = 200
const seenMsgKeys = new Set<string>()
let deliveryChain: Promise<void> = Promise.resolve()

async function deliverAgentMessage(message: DockAgentMessage): Promise<void> {
  const port = props.terminalPort
  const report = (ok: boolean, reason?: string) =>
    void Promise.resolve(
      reason === undefined
        ? port.reportAgentDelivery?.(message.msgKey, ok)
        : port.reportAgentDelivery?.(message.msgKey, ok, reason),
    ).catch(() => undefined)
  if (message.kind === 'ack') {
    report(true, 'ack')
    return
  }
  const term = termRef.value
  if (!term || term.status !== 'running') {
    report(false, 'pane-closed')
    return
  }
  try {
    const waited = await waitForQuiet(term)
    if (!waited) {
      report(false, 'pane-closed')
      return
    }
    // Still pasted after the cap, but the sender learns it went into a busy CLI.
    if (!(await pasteContext(term, () => message.text))) report(false, 'inject-failed')
    else if (waited === 'timed-out') report(true, 'delivered-while-busy')
    else report(true)
  } catch {
    report(false, 'inject-failed')
  }
}

function onAgentMessage(message: DockAgentMessage): void {
  if (message.targetPaneId !== props.paneId) return
  if (seenMsgKeys.has(message.msgKey)) return
  seenMsgKeys.add(message.msgKey)
  if (seenMsgKeys.size > DELIVERED_KEYS_CAP) {
    const oldest = seenMsgKeys.values().next().value
    if (oldest !== undefined) seenMsgKeys.delete(oldest)
  }
  deliveryChain = deliveryChain.then(() => deliverAgentMessage(message))
}

const stopAgentMessages = props.terminalPort.onAgentMessage?.(onAgentMessage)
onUnmounted(() => stopAgentMessages?.())

/** Host-triggered re-injection into a running CLI (no quiet-wait: the CLI is
 *  already interactive). No-op without buildContext or a running PTY. */
async function injectNow(): Promise<void> {
  const term = termRef.value
  const build = props.buildContext
  if (!term || !build || term.status !== 'running') return
  try { await pasteContext(term, build) } catch { /* best-effort */ }
}

function interrupt(): void {
  void termRef.value?.interrupt()
}
function stop(): void {
  const term = termRef.value
  if (!term) return
  // While 'starting' there is no sessionId yet, so kill() would be a no-op and
  // a hung terminal.create would be uncancellable — cancel the pending create.
  if (term.status === 'starting') void term.cancelPendingCreate().catch(() => {})
  // The user does not want this CLI back: no restore on the next window open.
  // A refused kill rejects now; it is logged, not left unhandled.
  else void term.kill({ retireRestore: true }).catch((err) => console.warn('[AiCliDock] stop failed:', err))
}

function pasteText(text: string): boolean {
  return termRef.value?.pasteText(text) ?? false
}

defineExpose({ start, stop, interrupt, pasteText, injectNow, toggle, terminal: termRef })
</script>

<template>
  <!-- Activity rail (AI terminal toggle) -->
  <div class="ai-dock-rail">
    <button
      class="ai-dock-rail-btn"
      :class="{ active: open }"
      :title="t(titleKey)"
      @click="toggle"
    >
      <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z"/>
      </svg>
    </button>
  </div>
  <div v-show="open" class="ai-dock-resize-handle" @mousedown.prevent="onResizeStart" />
  <div v-show="open" ref="panelRef" class="ai-dock-panel" :style="{ width: width + 'px' }">
    <div class="ai-cli-head">
      <span class="ai-cli-title">{{ t(titleKey) }}</span>
      <span
        v-if="rosterAddress"
        class="ai-cli-address"
        v-truncate
        :title="t('dockWindow.address-title', { address: rosterAddress })"
      >@{{ rosterAddress }}</span>
      <span v-if="workspacePath" class="ai-cli-ws" v-truncate :title="workspacePath">{{ workspaceName }}</span>
    </div>
    <p v-if="rosterError" class="ai-cli-roster-error">{{ t('dockWindow.roster-error', { reason: rosterError }) }}</p>
    <div v-if="!active" class="ai-cli-controls">
      <select v-model="agentKey" class="ai-cli-agent-select">
        <option v-for="s in agentSpecs" :key="s.agentKey" :value="s.agentKey">{{ s.label }}</option>
      </select>
      <button
        class="ai-cli-btn primary"
        :disabled="!workspacePath || starting || reattaching || terminalPort.status.value !== 'connected'"
        :title="workspacePath ? 'Spawn the CLI in ' + workspacePath : 'No workspace available'"
        @click="start"
      >{{ starting ? 'Starting…' : reattaching ? 'Reattaching…' : 'Start' }}</button>
    </div>
    <div v-else class="ai-cli-controls">
      <span class="ai-cli-running-label" v-truncate>{{ agentLabel }}</span>
      <button class="ai-cli-btn ghost" title="Send Ctrl+C to the CLI" @click="interrupt">Interrupt</button>
      <button class="ai-cli-btn danger" title="Kill the CLI process" @click="stop">Stop</button>
    </div>
    <p v-if="workspaceResolved && !workspacePath" class="ai-cli-empty">No workspace available</p>
    <!-- Mounted eagerly once a workspace exists (even while the panel is
         closed) so the connect-time reattach claims PTY ownership before the
         backend janitor reaps it. Keyed by paneId: useTerminal captures
         paneId/workspacePath once at setup, so a re-pointed workspace must
         remount the terminal for a fresh capture. -->
    <AiCliTerminal
      v-if="workspacePath"
      :key="paneId"
      ref="termRef"
      :pane-id="paneId"
      :terminal-port="terminalPort"
      :workspace-path="workspacePath"
      :mention-candidates="mentionCandidateGetter"
      class="ai-cli-term"
    />
  </div>
</template>

<style scoped>
.ai-dock-rail {
  align-items: center;
  background: var(--bg-subtle);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding-top: 8px;
  width: 34px;
}

.ai-dock-rail-btn {
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 5px;
}

.ai-dock-rail-btn:hover {
  color: var(--text-bright);
}

.ai-dock-rail-btn.active {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}

.ai-dock-resize-handle {
  background: transparent;
  border-left: 1px solid var(--border-muted);
  cursor: col-resize;
  flex-shrink: 0;
  transition: background 0.15s;
  width: 4px;
}

.ai-dock-resize-handle:hover {
  background: var(--accent-emphasis);
}

.ai-dock-panel {
  background: var(--bg-base);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  max-width: 600px;
  min-width: 280px;
  overflow: hidden;
}

.ai-cli-head {
  align-items: center;
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  padding: 8px 10px 4px;
}

.ai-cli-title {
  font-size: var(--font-xs);
  font-weight: 600;
}

.ai-cli-address {
  animation: ai-cli-address-in var(--motion-fast) var(--ease-out);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-3xs);
  line-height: 15px;
  min-width: 0;
  overflow: hidden;
  padding: 0 5px;
  text-overflow: ellipsis;
  user-select: all;
  white-space: nowrap;
}

/* Appearing is the state change — the panel just became reachable. */
@keyframes ai-cli-address-in {
  from { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .ai-cli-address { animation: none; }
}

.ai-cli-ws {
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-cli-controls {
  align-items: center;
  border-bottom: 1px solid var(--border-muted);
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  padding: 4px 10px 8px;
}

.ai-cli-agent-select {
  flex: 1;
  font-size: var(--font-xs);
  min-width: 0;
  padding: 5px 8px;
}

/* Self-contained button styling: host windows style bare <button> elements in
   their own scoped CSS, which does not reach into this component. */
.ai-cli-btn {
  background: var(--bg-muted);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-bright);
  cursor: pointer;
  flex-shrink: 0;
  font-size: var(--font-2xs);
  padding: 5px 10px;
}

.ai-cli-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ai-cli-btn.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}

.ai-cli-btn.primary:not(:disabled):hover {
  background: var(--success-strong);
}

.ai-cli-btn.ghost {
  background: transparent;
}

.ai-cli-btn.ghost:hover:not(:disabled) {
  background: var(--bg-muted);
}

.ai-cli-btn.danger {
  background: var(--danger-deep);
  border-color: var(--danger-muted);
  color: var(--text-on-emphasis);
}

.ai-cli-btn.danger:hover {
  background: var(--danger-muted);
}

.ai-cli-running-label {
  flex: 1;
  font-size: var(--font-xs);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-cli-roster-error {
  color: var(--danger-fg);
  flex-shrink: 0;
  font-size: var(--font-2xs);
  margin: 0;
  padding: 4px 12px;
}

.ai-cli-empty {
  color: var(--text-muted);
  flex-shrink: 0;
  font-size: var(--font-xs);
  margin: 0;
  padding: 12px;
}

.ai-cli-term {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
</style>
