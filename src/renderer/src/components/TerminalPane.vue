<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch } from 'vue'
import { useTerminal, type ClipboardFailureReason } from '@navide/terminal'
import { agentProfileFor } from '@navide/plugin-shell'
import { useNotify, useTheme } from '@navide/plugin-ui/foundation'
import type { TerminalDockPort } from '@navide/terminal'
import type { useCliProfiles } from '../composables/useCliProfiles'
import { extractDropPaths, escapeDraggedPath, stabilizeDroppedPaths } from '../lib/drop'
import { CLI_CONTEXT_MIME, PANE_BATCH_MIME, PANE_ID_MIME, resolveCliDropSources, writeCliPaneDragPayload } from '@navide/terminal'
import type { MentionCandidate } from '@navide/terminal'
import { PLAN_REF_MIME, isPlanDrag, parsePlanRefPayload, type PlanDragRef } from '../lib/planDrag'
import { formatLoopTime } from '../lib/loopPrompt'
import PromptSkillPicker from './PromptSkillPicker.vue'
import { usePromptSkills } from '../composables/usePromptSkills'
import { castablePromptSkills } from '../lib/promptSkills'
import { paneStatusLabelText } from '../lib/paneStatusLabel'
import { statusBadgeStyle } from '../composables/useStatusBadgePrefs'
import { setBatchDragImage } from '../lib/batchDragImage'
import { i18n } from '@navide/plugin-ui/foundation'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { invokeCommand, isMacPlatform } from '@navide/plugin-ui/shared'
import RebuildIcon from './RebuildIcon.vue'
import UsageBadge from './UsageBadge.vue'
import PaneChannelButton from './PaneChannelButton.vue'
import PaneGuardBadge from './PaneGuardBadge.vue'
import CliRiskPill from './CliRiskPill.vue'
import { cliRiskKey } from '../composables/useResourceUsage'
import type { CliRiskAnalysisSpawn } from '../lib/cliRiskAnalysisPrompt'
import RestoredPanePlaceholder from './RestoredPanePlaceholder.vue'

interface Props {
  paneId: string
  title: string
  /** The title was written by the auto-namer, not the user — marked with a dot
   *  so a name you did not choose is recognisable at a glance. */
  autoNamed?: boolean
  subtitle?: string
  /** CLI vendor key (e.g. 'claude', 'codex') carried in the cli-context drag payload. */
  agentKey?: string
  /** Vendor conversation id, distinct from useTerminal's backend PTY id. */
  cliSessionId?: string
  sessionHomeId?: string
  conversationLogPath?: string
  pipeTag?: string
  isCommander?: boolean
  isFocus?: boolean
  /** True when this pane is part of the multi-select set (Cmd/Ctrl/Shift-click
   *  on the header), so batch context-menu actions target it. */
  isSelected?: boolean
  /** Pane ids of the current multi-selection in pane order, or empty when fewer
   *  than two panes are selected. Dragging a pane that appears here drags the
   *  whole selection, matching the context menu's batch actions. */
  selectionBatchIds?: string[]
  /** True when this pane's agent is resume-capable — RENDERS the rebuild button
   *  (disabled until canRebuild), so the control is discoverable from spawn. */
  rebuildVisible?: boolean
  /** True when this pane has a resumable CLI session id on disk — ENABLES the
   *  rebuild button (re-spawns the pane via --resume to recover from render
   *  corruption). */
  canRebuild?: boolean
  /** True while App has a rebuild in flight for this pane's session — disables
   *  the rebuild button so a double-click cannot start a second kill/spawn. */
  rebuilding?: boolean
  isPreparing?: boolean
  preparingLabel?: string
  /** A cold-restored terminal is mounted but has not rendered its first PTY output yet. */
  restoring?: boolean
  /** Runtime-only LOOP badge state — lit after the loop prompt was injected. */
  loopActive?: boolean
  /** Epoch ms of the scheduled session-limit auto-resume; set while the loop
   *  is paused waiting for the CLI quota to reset. */
  loopWaitUntil?: number | null
  /** Epoch ms of the heuristic quota-reset estimate (loop start + 5h Claude
   *  session window) shown on the running badge as an approximate time. */
  loopEstimateResetAt?: number | null
  /** Runtime-only login-expired badge — lit when the pane's CLI reported an
   *  expired login; clicking it asks App.vue to re-send the login command. */
  loginExpired?: boolean
  /** The user muted this pane: no desktop notification and no sound from it.
   *  Shown as a 🔇 badge; clicking it asks App.vue to unmute. */
  muted?: boolean
  /** Runtime-only quota badge — lit while this pane's CLI has announced it is
   *  out of quota. `usageLimitUntil` is when it comes back, or null when no
   *  reset time could be resolved (the badge then says so instead of naming a
   *  time it does not know). Not clickable: nothing here can grant quota. */
  usageLimitHit?: boolean
  usageLimitUntil?: number | null
  /** Runtime-only continue affordance — lit when this pane came back from a
   *  restore with `--resume`: the CLI reloaded its transcript but is parked at
   *  the prompt, so whatever it was doing is never picked up on its own. */
  continueAvailable?: boolean
  terminalPort: TerminalDockPort
  cliProfiles: ReturnType<typeof useCliProfiles>
  /** The CLI account this pane was started on (its restore pin). */
  profileId?: string
  workspacePath?: string
  /** Resolves the addresses offered by this pane's @-mention menu (self
   *  excluded), with the group and status words already translated by the host.
   *
   *  A getter rather than a ready-made array: building the list reads every
   *  pane's live status, and a plain prop would rebuild it on every render —
   *  once a second, for every pane, to feed a menu that is almost never open.
   *  Passing the resolver keeps the cost on the `@` keystroke that needs it. */
  mentionCandidates?: (paneId: string) => MentionCandidate[]
  /** Whether the layout currently shows this pane. Paged-out panes stay mounted
   *  (their terminals must survive), so the terminal uses this to skip
   *  display-only upkeep instead of running it for an invisible pane. */
  onScreen?: boolean
}

const props = defineProps<Props>()
const cliRisk = inject(cliRiskKey, null)
const emit = defineEmits<{
  (e: 'set-focus', ev?: MouseEvent): void
  (e: 'minimize'): void
  (e: 'toggle-mute'): void
  (e: 'rebuild'): void
  (e: 'rebuild-clean'): void
  (e: 'rename', name: string): void
  (e: 'context-menu', ev: MouseEvent): void
  (e: 'reorder-drop', draggedPaneId: string): void
  /** CLI pane(s) were dropped onto this pane's terminal area — App.vue pastes
   *  each source pane's recent output into this pane's input prompt, in order.
   *  More than one id when a multi-selection was dragged. */
  (e: 'cli-context-drop', sourcePaneIds: string[]): void
  /** A plan document was dropped onto this pane's terminal area — App.vue
   *  pastes the plan goal + execution instruction into this pane's input. */
  (e: 'plan-drop', ref: PlanDragRef): void
  /** Loop button clicked — App.vue injects the loop prompt or clears the badge.
   *  `skillId` is set only when the cast came from the skill picker; a plain
   *  click still emits with no argument and keeps its original meaning. */
  (e: 'toggle-loop', skillId?: string): void
  /** Waiting badge clicked — App.vue injects the resume prompt immediately
   *  instead of waiting for the scheduled quota reset. */
  (e: 'loop-resume-now'): void
  /** Login-expired badge clicked — App.vue sends the CLI's login command into
   *  this pane and clears the badge. */
  (e: 'fix-login'): void
  /** Quota badge clicked and the confirm accepted — App.vue clears the pane's
   *  quota flag and resumes a loop that was parked on that limit. */
  (e: 'usage-limit-dismiss'): void
  /** Continue button clicked on a resumed pane — App.vue injects the resume
   *  prompt once so the interrupted work carries on. */
  (e: 'continue-resume'): void
  /** The user typed into a STOPped pane (Enter/printable), taking over — App.vue
   *  clears + un-persists the STOP badge. */
  (e: 'user-resume'): void
  /** An @-mention was completed in this pane's terminal — App.vue records the
   *  chosen addresses so the menu can offer them first next time. */
  (e: 'mention-pick', addresses: string[]): void
  (e: 'first-output'): void
  /** This pane's PTY did not survive a backend outage — App.vue resumes the
   *  CLI session so the conversation continues instead of leaving a dead pane. */
  (e: 'pty-lost'): void
}>()
const containerRef = ref<HTMLElement | null>(null)
const isDragOver = ref(false)
/** Hovering a CLI pane over this terminal (context share), not files (path insert). */
const isCliDragOver = ref(false)
/** Hovering a plan document over this terminal (plan goal inject). */
const isPlanDragOver = ref(false)

// Inline title rename — double-click the header title to edit, Enter/blur to
// commit, Escape to cancel. The committed name bubbles up as a 'rename' event.
const editingTitle = ref(false)
const titleDraft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
let _cancelledTitle = false

async function startTitleEdit(): Promise<void> {
  _cancelledTitle = false
  titleDraft.value = props.title
  editingTitle.value = true
  await nextTick()
  titleInput.value?.select()
}

function commitTitleEdit(): void {
  if (_cancelledTitle) return
  editingTitle.value = false
  emit('rename', titleDraft.value.trim())
}

function onTitleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') { e.preventDefault(); commitTitleEdit() }
  if (e.key === 'Escape') { e.preventDefault(); _cancelledTitle = true; editingTitle.value = false }
}

const { toast: notifyToast } = useNotify()

// How urgent each clipboard failure is. "Try again in a moment" is not the same
// news as "this pane is dead" or "the copy you think you made did not happen".
const CLIPBOARD_TOAST_TYPE: Record<ClipboardFailureReason, 'info' | 'error'> = {
  empty: 'info',
  preparing: 'info',
  'no-session': 'error',
  'image-failed': 'error',
  'copy-failed': 'error',
  'send-failed': 'error',
  'send-failed-all': 'error',
  'copy-mouse-captured': 'info',
  'copy-no-selection': 'info',
}
// These repeat easily — ⌘V a few times while a pane starts and every press
// reports — and useNotify has no dedupe of its own, so identical toasts would
// stack up to its cap. One per reason per few seconds says as much.
const CLIPBOARD_TOAST_GAP_MS = 3000
const lastClipboardToastAt = new Map<ClipboardFailureReason, number>()

function onClipboardFailure(reason: ClipboardFailureReason, chars: number): void {
  const now = Date.now()
  if (now - (lastClipboardToastAt.get(reason) ?? 0) < CLIPBOARD_TOAST_GAP_MS) return
  lastClipboardToastAt.set(reason, now)
  // The pane name is in the message because the toast is global: with several
  // panes open, "paste dropped" alone does not say which one ignored you.
  notifyToast(
    i18n.global.t(`pane.terminal.clipboard-${reason}`, { pane: props.title, chars }),
    { type: CLIPBOARD_TOAST_TYPE[reason] }
  )
}

function onOpenFileFailure(filepath: string): void {
  notifyToast(i18n.global.t('pane.terminal.open-file-failed', { file: filepath }), { type: 'error' })
}

const terminal = useTerminal(props.paneId, props.terminalPort, {
  workspacePath: props.workspacePath,
  onClear: () => emit('rebuild-clean'),
  onUserResume: () => emit('user-resume'),
  mentionCandidates: () => props.mentionCandidates?.(props.paneId) ?? [],
  onMentionPick: (addresses) => emit('mention-pick', addresses),
  onScreen: () => props.onScreen ?? true,
  onFirstOutput: () => emit('first-output'),
  onClipboardFailure,
  onOpenFileFailure,
  onPtyLostWhileDisconnected: () => emit('pty-lost'),
  agentProfileFor,
})
// Reattached terminals can keep the backend's old pane id. Actions must use
// that same backend-owned identity, just like the resource usage projection.
const cliRiskPaneId = computed(() => cliRisk?.paneIdByKey.value.get(terminal.sessionId.value) ?? props.paneId)
const cliRiskState = computed(() => cliRisk?.cliRisksByPaneId.value.get(cliRiskPaneId.value))
/** Spawns the "Analyze with CLI" pane through the same command MCP ui_invoke uses. */
const spawnCliRiskAnalysis: CliRiskAnalysisSpawn = (request) => invokeCommand('ui.pane.create', request)
const { theme } = useTheme()
watch(theme, () => terminal.updateXtermTheme())

/**
 * The banner text while the backend is unreachable, or '' when there is
 * nothing to say.
 *
 * Only panes holding a PTY get it: a pane that never spawned has no work to
 * lose, and the boot overlay already owns the initial start. The three
 * messages are genuinely different situations — a transient reconnect, a
 * crashed backend being respawned within its budget, and a backend that gave
 * up for good — and the status bar's old single "connecting…" for all three is
 * what made a dead backend look like a slow one.
 */
const disconnectedNotice = computed<string>(() => {
  // Optional-chained throughout, like the rest of this file: the pane's tests
  // stub both useTerminal and the backend with partial objects.
  const status = props.terminalPort?.status?.value
  if (!status || status === 'connected') return ''
  // Which panes have something at stake: one holding a PTY ('running'), and one
  // mid-spawn ('starting'), whose keystrokes the input guard is already
  // refusing — leaving that one silent was the worse half, since the user got
  // no feedback at all for keys that went nowhere. A pane that exited or never
  // spawned has nothing the outage can take, and telling it "typing is paused"
  // promises a connection it is not waiting for.
  //
  // sessionId is the wrong test: it is assigned once and never cleared (not by
  // cleanupSession, not on exit), so it stays truthy on a pane whose CLI ended
  // long ago.
  const paneStatus = terminal.status?.value
  if (paneStatus !== 'running' && paneStatus !== 'starting') return ''
  const auto = props.terminalPort?.autoRestart?.value
  if (auto) {
    return i18n.global.t('pane.terminal.backend-restarting', { attempt: auto.attempt, max: auto.max })
  }
  if (status === 'error') return i18n.global.t('pane.terminal.backend-unavailable')
  return i18n.global.t('pane.terminal.backend-reconnecting')
})

watch(() => props.isPreparing, (isPrep) => {
  if (terminal.setDisableStdin) {
    terminal.setDisableStdin(!!isPrep)
  }
}, { immediate: true })

// RUNNING vs IDLE is derived inside useTerminal from the pane's own clean
// output, with hysteresis: a sustained burst enters RUNNING, and only a long
// clean silence leaves it. Two authoritative CLI signals are routed here by
// App.vue: turn_complete (markTurnComplete) drops to idle early, and Claude's
// Notification hook (markNeedsInput) raises AWAITING, which the PTY stream
// alone cannot tell apart from a finished turn.
const displayStatus = terminal.displayStatus

// 'idle' and 'awaiting' both look like a quiet pane but mean opposite things —
// done versus blocked on you — so each explains itself on hover. The badge no
// longer separates a permission prompt from a question, but the tooltip still
// names which one it is: the distinction is not worth a second badge, and is
// worth a sentence once someone stops to ask. The rest are self-evident from
// the badge text.
// The badge text itself comes from paneStatusLabel, shared with the sidebar and
// the agent overview. It used to print the raw status word with 'awaiting' and
// 'stopped' as hand-made exceptions, which is how one pane ended up reading
// "RUNNING" here and "執行中" in the overview at the same moment.
const statusBadgeText = computed<string>(() => paneStatusLabelText(displayStatus.value))

// Only a status the user recoloured carries inline variables; the rest are left
// to the [data-status] rules below, unchanged.
const statusBadgeVars = computed(() => statusBadgeStyle(displayStatus.value))

const statusTooltipKey = computed<string>(() => {
  if (displayStatus.value === 'idle') return 'pane.terminal.idle-status-tooltip'
  if (displayStatus.value === 'awaiting') {
    return terminal.awaitingKind.value === 'question'
      ? 'pane.terminal.question-status-tooltip'
      : 'pane.terminal.awaiting-status-tooltip'
  }
  return ''
})

// The continue affordance is deliberately narrow: it appears only at a genuine
// interruption — the pane came back from a restore with its transcript
// reloaded, the CLI is parked and idle, and the user has not touched it since.
// A plain finished turn is NOT an interruption; showing it there would put a
// button under every pane after every reply. The first keystroke retires it for
// good (the user took over), as does an active loop (already driving the pane).
const showContinueButton = computed<boolean>(
  () =>
    !!props.continueAvailable &&
    !props.loopActive &&
    !props.restoring &&
    displayStatus.value === 'idle' &&
    (terminal.lastUserKeyAt?.value ?? 0) === 0
)

defineExpose({
  spawn: terminal.spawn,
  interrupt: terminal.interrupt,
  kill: terminal.kill,
  focus: terminal.focus,
  status: terminal.status,
  displayStatus,
  awaitingKind: terminal.awaitingKind,
  startingStartedAt: terminal.startingStartedAt,
  startingAgeMs: terminal.startingAgeMs,
  cancelPendingCreate: terminal.cancelPendingCreate,
  sessionId: terminal.sessionId,
  // Empty unless this pane reattached to a live PTY, in which case it names
  // the transcript that PTY is really writing to.
  attachedOutputLogFile: terminal.attachedOutputLogFile,
  error: terminal.error,
  lastCommand: terminal.lastCommand,
  cleanBuffer: terminal.cleanBuffer,
  cleanBytesSeen: terminal.cleanBytesSeen,
  resumeSpawnedAt: terminal.resumeSpawnedAt,
  lastActivityAt: terminal.lastActivityAt,
  lastRawActivityAt: terminal.lastRawActivityAt,
  // The person at the keyboard, for App.vue's messaging idle gate.
  hasDraft: terminal.hasDraft,
  lastUserKeyAt: terminal.lastUserKeyAt,
  // What the CLI on the other end actually asked for, for injectText's guards.
  isBracketedPasteActive: terminal.isBracketedPasteActive,
  // The ⌘V path (never submits), false when the text would be dropped; voice
  // dictation types its text through it.
  insertText: terminal.insertText,
  markTurnComplete: terminal.markTurnComplete,
  markNeedsInput: terminal.markNeedsInput,
  clearNeedsInput: terminal.clearNeedsInput,
  markQuestion: terminal.markQuestion,
  clearQuestion: terminal.clearQuestion,
  markDeliveredPending: terminal.markDeliveredPending,
  clearDeliveredPending: terminal.clearDeliveredPending,
  noteBackgroundTasks: terminal.noteBackgroundTasks,
  markBufferPosition: terminal.markBufferPosition,
  recleanBuffer: terminal.recleanBuffer,
  flushPendingClean: terminal.flushPendingClean,
  readRenderedText: terminal.readRenderedText,
  readScreenTail: terminal.readScreenTail,
  // The pane's scrollback for a replacement pane to replay (quota-failover restart).
  serializeScrollback: terminal.serializeScrollback,
  readLineBeforeCursor: terminal.readLineBeforeCursor,
  fitTerminal: terminal.fitTerminal,
  lockCols: terminal.lockCols,
  redraw: terminal.redraw,
  // STOP badge: App.vue owns persistence; it reflects stored/broadcast truth
  // into this pane's composable ref via setStopped (no persist side-effect).
  setStopped: (v: boolean) => { terminal.isStopped.value = v }
})

/** True when the drag carries a CLI pane's identity (pane→pane context share)
 *  rather than files/text (path insert). Readable during dragover: the TYPES
 *  are visible in protected mode even though the data is not. */
function isCliPaneDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  return !!types && (types.includes(CLI_CONTEXT_MIME) || types.includes(PANE_ID_MIME))
}

function onTerminalDragOver(e: DragEvent): void {
  e.preventDefault()
  if (isPlanDrag(e.dataTransfer?.types)) {
    isPlanDragOver.value = true
    isCliDragOver.value = false
    isDragOver.value = false
    return
  }
  const cli = isCliPaneDrag(e)
  // Dragging this pane's own header over its own terminal is a no-op — don't
  // advertise a drop target for it.
  isCliDragOver.value = cli && !draggingSelf
  isDragOver.value = !cli
}

function onTerminalDragLeave(): void {
  isDragOver.value = false
  isCliDragOver.value = false
  isPlanDragOver.value = false
}

// Modifier that forces text selection while a CLI has mouse reporting on.
// xterm binds it to Option on macOS (macOptionClickForcesSelection) and to
// Shift everywhere else.
const selectModifierLabel = isMacPlatform() ? '⌥ Option' : 'Shift'

// xterm's selection lives outside the DOM, so main cannot read it from the
// context-menu params — pass it along with the request.
function onTerminalContextMenu(): void {
  props.terminalPort.showContextMenu?.(terminal.getSelection())
}

async function onTerminalDrop(e: DragEvent): Promise<void> {
  isDragOver.value = false
  isCliDragOver.value = false
  isPlanDragOver.value = false
  if (terminal.displayStatus.value === 'exited' || terminal.displayStatus.value === 'error') return
  // Plan document dropped onto this terminal: App.vue owns pane state, so it
  // pastes the plan's path into this pane's input.
  if (isPlanDrag(e.dataTransfer?.types)) {
    const ref = parsePlanRefPayload(e.dataTransfer?.getData(PLAN_REF_MIME) || '')
    if (ref) emit('plan-drop', ref)
    return
  }
  // CLI pane dropped onto this terminal: share its recent output with this pane.
  // App.vue owns pane state, so it resolves the buffer and does the paste.
  if (isCliPaneDrag(e)) {
    const sourcePaneIds = resolveCliDropSources(
      e.dataTransfer?.getData(CLI_CONTEXT_MIME) || '',
      e.dataTransfer?.getData(PANE_ID_MIME) || '',
      e.dataTransfer?.getData(PANE_BATCH_MIME) || '',
      props.paneId
    )
    if (sourcePaneIds.length) emit('cli-context-drop', sourcePaneIds)
    return
  }
  const dropped = extractDropPaths(e)
  if (!dropped.length) return
  const paths = await stabilizeDroppedPaths(dropped)
  terminal.pasteFromClipboard(paths.map(escapeDraggedPath).join(' '))
}

// Drag the pane (by its header) onto a tab to move it into that run group,
// or onto another pane's header to reorder (see the drop handlers below).
/** Pane ids this header drag carries — the whole multi-selection when this pane
 *  belongs to one, otherwise just this pane. */
function headerDragBatch(): string[] {
  const batch = props.selectionBatchIds ?? []
  return batch.includes(props.paneId) ? batch : [props.paneId]
}

function onHeaderDragStart(e: DragEvent): void {
  if (!e.dataTransfer) return
  const batch = headerDragBatch()
  // Carry a fast local snapshot; AI Chat still fetches authoritative live
  // metadata and rendered output on drop through the pane-buffer IPC relay.
  writeCliPaneDragPayload(e.dataTransfer, {
    paneId: props.paneId,
    agentKey: props.agentKey ?? '',
    label: props.title,
    sessionId: props.cliSessionId || null,
    sessionHomeId: props.sessionHomeId ?? '',
    workspacePath: props.workspacePath ?? '',
    conversationLogPath: props.conversationLogPath ?? ''
  }, batch)
  setBatchDragImage(
    e.dataTransfer,
    batch.length,
    i18n.global.t('action.dragging-panes', { count: batch.length })
  )
  e.dataTransfer.effectAllowed = 'move'
  draggingSelf = true
}

/** True when a batch drag is in flight and this pane belongs to THIS window's
 *  multi-selection — the pane is being dragged, so it is not a reorder target
 *  for its own batch. The payload is unreadable during dragover, so the test is
 *  the batch TYPE plus the local selection. That over-matches for a batch
 *  dragged in from another window (this window may have its own selection), and
 *  the effect is only that no drop highlight appears: a cross-window header drop
 *  reorders nothing either way, since the dragged ids are not panes of this
 *  window. */
function isOwnBatchMember(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes(PANE_BATCH_MIME)
    && (props.selectionBatchIds ?? []).includes(props.paneId)
}

// Drop target for pane reordering: another pane's header dropped onto this
// header emits 'reorder-drop' with the dragged pane's id; App.vue moves that
// pane into this pane's slot. During dragover the payload is unreadable
// (dataTransfer protected mode), so hovering is gated on the data TYPE plus a
// local "this pane is the drag source" flag — the id check happens on drop.
const isReorderDragOver = ref(false)
let draggingSelf = false

function onHeaderDragEnd(e: DragEvent): void {
  draggingSelf = false
  isReorderDragOver.value = false
  // Cross-window handoff. Chromium DOES deliver same-app cross-window drops
  // to another window's drop targets (verified 2026-07-24) — a consumed drop,
  // local or cross-window, reports dropEffect 'move' here and needs no
  // follow-up. A release over a NON-accepting area consumes nothing, so
  // dropEffect stays 'none' — only then ask main to route the pane to the
  // window under the pointer. (Esc-cancel also reports 'none' —
  // indistinguishable in Chromium, which suppresses keyboard events during a
  // drag; main drops the release when it lands inside this window's own
  // bounds, which covers the common cancel-in-place case.)
  if (e.dataTransfer?.dropEffect !== 'none') return
  props.terminalPort.reportDragEnd?.(props.paneId, e.screenX, e.screenY, headerDragBatch())
}

function onHeaderDragOver(e: DragEvent): void {
  if (draggingSelf || isOwnBatchMember(e) || !e.dataTransfer?.types.includes('application/x-pane-id')) return
  e.preventDefault()
  isReorderDragOver.value = true
}

function onHeaderDragLeave(): void {
  isReorderDragOver.value = false
}

function onHeaderDrop(e: DragEvent): void {
  isReorderDragOver.value = false
  const draggedId = e.dataTransfer?.getData('application/x-pane-id') || ''
  if (!draggedId || draggedId === props.paneId) return
  emit('reorder-drop', draggedId)
}

const { skills: promptSkills } = usePromptSkills()
/** The skill picker is showing (or about to). The header's own native tooltip
 *  would otherwise be drawn on top of the ring. */
const skillMenuActive = ref(false)
/** While the loop runs the default skill is left out: casting it would toggle
 *  the loop off, and the badge is already the off-switch. */
const castableSkills = computed(() =>
  castablePromptSkills(promptSkills.value).filter((s) => !(props.loopActive && s.isDefault))
)

/** Single source for the loop badge's 3-way state machine (waiting /
 *  estimate / plain): which i18n keys to render and the formatted time they
 *  interpolate — the template's text and tooltip both read from here. */
const loopBadge = computed(() => {
  if (props.loopWaitUntil != null) {
    return {
      textKey: 'pane.terminal.loop-badge-resume' as string | null,
      titleKey: 'pane.terminal.loop-waiting-tooltip',
      time: formatLoopTime(props.loopWaitUntil)
    }
  }
  if (props.loopEstimateResetAt != null) {
    return {
      textKey: 'pane.terminal.loop-badge-estimate' as string | null,
      titleKey: 'pane.terminal.loop-estimate-tooltip',
      time: formatLoopTime(props.loopEstimateResetAt)
    }
  }
  return { textKey: null as string | null, titleKey: 'pane.terminal.loop-badge-tooltip', time: '' }
})

/** The badge is the off-switch while the loop runs; while waiting it is a
 *  click-to-resume-now affordance. */
function onLoopBadgeClick(e: MouseEvent): void {
  e.stopPropagation()
  if (props.loopWaitUntil != null) emit('loop-resume-now')
  else emit('toggle-loop')
}

/** The quota badge can be wrong (or already moot) — let the user drop it. */
function onUsageLimitBadgeClick(): void {
  if (!window.confirm(i18n.global.t('pane.terminal.usage-limit-dismiss-confirm'))) return
  emit('usage-limit-dismiss')
}

onMounted(() => {
  if (containerRef.value) terminal.mount(containerRef.value)
})
</script>

<template>
  <div :class="['pane', { 'pane-focus': isFocus, 'pane-selected': isSelected }]">
    <button
      v-if="rebuildVisible"
      class="rebuild-btn"
      :disabled="rebuilding || !canRebuild"
      @click.stop="emit('rebuild')"
      :title="canRebuild ? $t('pane.terminal.rebuild-tooltip') : $t('pane.terminal.rebuild-tooltip-disabled')"
      :aria-label="canRebuild ? $t('pane.terminal.rebuild-tooltip') : $t('pane.terminal.rebuild-tooltip-disabled')"
    ><RebuildIcon /></button>
    <button class="minimize-btn" @click.stop="emit('minimize')" :title="$t('pane.terminal.minimize-tooltip')">⊟</button>
    <header
      :class="['pane-header', { 'drag-over': isReorderDragOver }]"
      data-tour="pane-header"
      :draggable="!editingTitle"
      :title="skillMenuActive ? '' : $t('pane.terminal.drag-to-tab-tooltip')"
      @click="emit('set-focus', $event)"
      @dragstart="onHeaderDragStart"
      @dragend="onHeaderDragEnd"
      @dragover="onHeaderDragOver"
      @dragenter="onHeaderDragOver"
      @dragleave="onHeaderDragLeave"
      @drop.prevent="onHeaderDrop"
      @contextmenu.prevent="emit('context-menu', $event)"
    >
      <div class="header-main">
        <span v-if="pipeTag" class="pipe-tag">{{ pipeTag }}</span>
        <input
          v-if="editingTitle"
          ref="titleInput"
          class="title-edit"
          v-model="titleDraft"
          @keydown="onTitleKeydown"
          @blur="commitTitleEdit"
          @click.stop
          @dblclick.stop
        />
        <span
          v-else
          class="title"
          :title="$t('pane.terminal.rename-title-tooltip')"
          @dblclick.stop="startTitleEdit"
        >{{ title }}</span>
        <span
          v-if="autoNamed && !editingTitle"
          class="auto-name-mark"
          :title="$t('pane.terminal.auto-named-tooltip')"
        >◦</span>
        <span v-if="isCommander" class="commander-inline" :title="$t('pane.terminal.commander-tooltip')">🎯 Mgr</span>
        <span
          v-if="loopActive"
          class="loop-inline"
          :class="{ waiting: loopWaitUntil != null }"
          role="button"
          :title="$t(loopBadge.titleKey, { time: loopBadge.time })"
          @click="onLoopBadgeClick"
        >{{ loopBadge.textKey ? $t(loopBadge.textKey, { time: loopBadge.time }) : '∞ Loop' }}</span>
        <PromptSkillPicker
          v-if="displayStatus !== 'exited' && displayStatus !== 'error' && (!loopActive || castableSkills.length > 0)"
          :skills="castableSkills"
          @cast="(id: string) => emit('toggle-loop', id)"
          @active="(v: boolean) => (skillMenuActive = v)"
        >
          <button
            class="loop-btn"
            @click.stop="!loopActive && emit('toggle-loop')"
            :aria-label="$t('pane.terminal.loop-tooltip')"
          >∞</button>
        </PromptSkillPicker>
        <span
          v-if="muted"
          class="muted-inline"
          role="button"
          :title="$t('pane.terminal.muted-tooltip')"
          @click.stop="emit('toggle-mute')"
        ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"></path><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path><line x1="2" y1="2" x2="22" y2="22"></line></svg></span>
        <span
          v-if="loginExpired"
          class="login-expired-inline"
          role="button"
          :title="$t('pane.terminal.login-expired-tooltip')"
          @click.stop="emit('fix-login')"
        >{{ $t('pane.terminal.login-expired-badge') }}</span>
        <span
          v-if="usageLimitHit"
          class="usage-limit-inline"
          role="button"
          :title="usageLimitUntil != null
            ? $t('pane.terminal.usage-limit-tooltip', { time: formatLoopTime(usageLimitUntil) })
            : $t('pane.terminal.usage-limit-tooltip-unknown')"
          @click.stop="onUsageLimitBadgeClick"
        >{{ usageLimitUntil != null
          ? $t('pane.terminal.usage-limit-badge', { time: formatLoopTime(usageLimitUntil) })
          : $t('pane.terminal.usage-limit-badge-unknown') }}</span>
        <CliRiskPill
          v-if="cliRisk && cliRiskState?.signals.length && !restoring && onScreen !== false"
          :pane-id="cliRiskPaneId"
          :state="cliRiskState"
          :available="cliRisk.cliRisksAvailable.value"
          :compact="loginExpired && usageLimitHit"
          :act="cliRisk.actOnCliRisk"
          :agent-key="agentKey"
          :workspace-path="workspacePath"
          :spawn="spawnCliRiskAnalysis"
        />
        <PaneGuardBadge :pane-id="paneId" :compact="loginExpired && usageLimitHit" />
        <span
          class="status"
          :data-status="displayStatus"
          :style="statusBadgeVars"
          :title="statusTooltipKey ? $t(statusTooltipKey) : ''"
        >{{ statusBadgeText }}</span>
        <UsageBadge
          v-if="agentKey"
          data-tour="usage-badge"
          :agent-key="agentKey"
          :cli-profiles="cliProfiles"
          :pane-id="paneId"
          :pane-profile-id="profileId"
        />
        <PaneChannelButton :pane-id="paneId" :pane-name="title" :agent-key="agentKey" />
      </div>
      <div v-if="subtitle" class="header-sub" v-truncate>{{ subtitle }}</div>
    </header>
    <div
      ref="containerRef"
      class="xterm-host"
      :class="{ 'drag-over': isDragOver, 'cli-drag-over': isCliDragOver, 'plan-drag-over': isPlanDragOver, 'alt-buffer': terminal.isAltBuffer.value }"
      :data-pane-id="paneId"
      @mousedown.left="emit('set-focus')"
      @contextmenu.prevent="onTerminalContextMenu"
      @dragover.prevent="onTerminalDragOver"
      @dragenter.prevent="onTerminalDragOver"
      @dragleave="onTerminalDragLeave"
      @drop.prevent="onTerminalDrop"
    ></div>
    <!-- Backend down: a frozen pane is indistinguishable from a thinking CLI,
         and keystrokes are refused while it shows (see inputTransportReady).
         Deliberately a banner, not a cover: the history stays readable and
         selectable, since nothing about it stopped being true. -->
    <div v-if="disconnectedNotice" class="disconnected-banner" role="status" aria-live="polite">
      <span class="disconnected-dot" />
      <span class="disconnected-text" v-truncate>{{ disconnectedNotice }}</span>
    </div>
    <!-- Optional-chained: the pane's tests stub useTerminal with partial objects. -->
    <div
      v-if="terminal.optionSelectHint?.value"
      class="select-hint"
      :class="{ 'hint-raised': showContinueButton }"
      aria-live="polite"
    >
      {{ $t('pane.terminal.option-select-hint', { key: selectModifierLabel }) }}
    </div>
    <!-- Sibling of .xterm-host, never inside it: everything under the host
         belongs to xterm's renderer. Same placement as .select-hint. -->
    <button
      v-if="showContinueButton"
      class="continue-btn"
      type="button"
      :title="$t('pane.terminal.continue-tooltip')"
      @click.stop="emit('continue-resume')"
    >
      {{ $t('pane.terminal.continue') }}
    </button>
    <div v-if="isPreparing" class="prep-overlay" aria-live="polite">
      <div class="prep-panel">
        <div class="prep-spinner" />
        <div class="prep-text" v-truncate>{{ preparingLabel || 'Preparing CLI' }}</div>
      </div>
    </div>
    <RestoredPanePlaceholder
      v-if="restoring && displayStatus !== 'exited' && displayStatus !== 'error'"
      class="restoring-overlay"
      :pane-id="paneId"
      :title="title"
      :subtitle="subtitle"
      :pipe-tag="pipeTag"
      :is-focus="isFocus"
      realizing
      @minimize="emit('minimize')"
      @context-menu="emit('context-menu', $event)"
    />
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  overflow: hidden;
  position: relative;
}
.pipe-tag {
  font-size: var(--font-3xs);
  font-weight: 700;
  background: var(--accent-subtle);
  color: var(--accent-fg);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
}
.pane:focus-within {
  border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-emphasis) 20%, transparent);
}
.pane.pane-focus {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 27%, transparent);
}
.pane.pane-focus .pane-header {
  background: var(--bg-elevated);
}
.pane.pane-selected {
  border-color: var(--accent-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 45%, transparent);
}
.pane.pane-selected .pane-header {
  background: color-mix(in srgb, var(--accent-focus) 18%, var(--bg-elevated));
}
.pane.pane-focus.pane-selected {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-focus) 32%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--accent-focus) 30%, transparent);
}
.pane.pane-focus.pane-selected .pane-header {
  background: color-mix(in srgb, var(--accent-focus) 14%, var(--bg-elevated));
}
.minimize-btn,
.rebuild-btn {
  position: absolute;
  top: 5px;
  z-index: 10;
}
/* The chat-channel connect button sits in the header row but is the same
   icon button as its two corner neighbours. */
.minimize-btn,
.rebuild-btn,
.header-main :deep(.pch-btn) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: var(--font-md);
  cursor: pointer;
  box-sizing: border-box;
  padding: 0;
  line-height: 1;
  border-radius: var(--radius-xs);
  opacity: 1;
  transition: color 0.15s, background-color 0.15s;
}
.minimize-btn {
  right: 6px;
}
.rebuild-btn {
  right: 26px;
}
.rebuild-btn svg,
.header-main :deep(.pch-btn svg) {
  width: 14px;
  height: 14px;
}
.minimize-btn:hover,
.rebuild-btn:hover:not(:disabled),
.header-main :deep(.pch-btn:hover) {
  color: var(--text-primary);
  background: var(--bg-muted);
}
.minimize-btn:focus-visible,
.rebuild-btn:focus-visible,
.header-main :deep(.pch-btn:focus-visible) {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.rebuild-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
/* In flow, a 20px button would make the header row taller than the badges. */
.header-main :deep(.pch-btn) {
  flex-shrink: 0;
  margin: -3px 0;
}
.pane-header {
  container: cli-pane-header / inline-size;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  padding: 5px 52px 5px 12px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  font-size: var(--font-xs);
  color: var(--text-primary);
}
/* Reorder drop target feedback, matching .tab-btn.drag-over in StageTabBar.vue. */
.pane-header.drag-over {
  background: var(--accent-subtle);
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.header-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-sub {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.title {
  color: var(--text-bright);
  font-weight: 600;
}
/* Auto-name marker: quiet enough to ignore while scanning the header, present
   enough to answer "did I name this?" without hovering. */
.auto-name-mark {
  font-size: 0.75em;
  line-height: 1;
  opacity: 0.45;
  /* Pulls back most of .header-main's 8px gap: the mark belongs to the title,
     and at a full gap it reads as a separate badge. */
  margin-left: -6px;
  flex-shrink: 0;
  cursor: default;
  user-select: none;
}
.title-edit {
  font: inherit;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-base);
  border: 1px solid var(--accent-emphasis);
  border-radius: var(--radius-xs);
  padding: 1px 5px;
  min-width: 0;
  outline: none;
}
.commander-inline {
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: 999px;
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
}
.loop-inline {
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--success-fg);
  background: var(--success-subtle);
  border: 1px solid var(--success-emphasis);
  border-radius: var(--radius-xs);
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
}
.loop-inline:hover {
  border-color: var(--success-fg);
}
.loop-inline.waiting {
  opacity: 0.55;
  cursor: pointer;
}
.loop-inline.waiting:hover {
  opacity: 1;
  border-color: var(--success-fg);
}
.muted-inline {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-muted);
  cursor: pointer;
}
.muted-inline:hover {
  color: var(--text-primary);
}
.login-expired-inline {
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: var(--radius-xs);
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
}
.login-expired-inline:hover {
  border-color: var(--attention-fg);
}
/* Quota exhausted. Deliberately louder than the login badge. Clicking it
   (after a confirm) dismisses the flag, e.g. when it is stale or moot. */
.usage-limit-inline {
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--danger-fg);
  background: var(--danger-deep);
  border: 1px solid var(--danger-fg);
  border-radius: var(--radius-xs);
  padding: 1px 6px;
  letter-spacing: 0.2px;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
}
.loop-btn {
  font-size: var(--font-3xs);
  line-height: 1.4;
  background: transparent;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  padding: 1px 6px;
  cursor: pointer;
  flex-shrink: 0;
  opacity: 0.7;
}
.loop-btn:hover {
  opacity: 1;
  color: var(--success-fg);
  border-color: var(--success-emphasis);
}
/* Each rule is the DEFAULT colour of its status, and stays the whole story
 * until the user recolours that status in Settings; only then does the badge
 * carry --status-badge-bg/-fg inline and win the var() fallback. Keeping the
 * defaults here rather than moving them into the palette means a pane still
 * paints correctly with no settings loaded at all. */
.status {
  margin-left: auto;
  font-size: var(--font-3xs);
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--status-badge-bg, var(--bg-muted));
  color: var(--status-badge-fg, var(--text-secondary));
}
.status[data-status='running'] {
  background: var(--status-badge-bg, var(--success-muted));
  color: var(--status-badge-fg, var(--success-fg));
}
.status[data-status='starting'] {
  background: var(--status-badge-bg, var(--status-starting-muted));
  color: var(--status-badge-fg, var(--status-starting-fg));
}
.status[data-status='error'] {
  background: var(--status-badge-bg, var(--danger-deep));
  color: var(--status-badge-fg, var(--danger-fg));
}
.status[data-status='exited'] {
  background: var(--status-badge-bg, var(--bg-muted));
  color: var(--status-badge-fg, var(--text-primary));
}
.status[data-status='idle'] {
  background: var(--status-badge-bg, var(--status-idle-muted));
  color: var(--status-badge-fg, var(--status-idle-fg));
}
.status[data-status='awaiting'] {
  background: var(--status-badge-bg, color-mix(in srgb, var(--warning-fg) 20%, transparent));
  color: var(--status-badge-fg, var(--warning-fg));
}
/* 'stopped' was the one status painted in literal hex, which punched a black
 * hole through the light theme. It resolves through the palette's `ink` now,
 * like every other status. */
.status[data-status='stopped'] {
  background: var(--status-badge-bg, var(--bg-inset));
  color: var(--status-badge-fg, var(--text-bright));
  border: 1px solid var(--border-default);
}
.xterm-host {
  flex: 1;
  min-height: 0;
  padding: 4px 8px;
  position: relative;
  transition: box-shadow 0.1s;
}
.xterm-host.drag-over,
.xterm-host.cli-drag-over,
.xterm-host.plan-drag-over {
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.xterm-host.drag-over::after,
.xterm-host.cli-drag-over::after,
.xterm-host.plan-drag-over::after {
  content: 'Drop to insert path';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-subtle);
  color: var(--accent-bright);
  font-size: var(--font-sm);
  font-family: inherit;
  pointer-events: none;
}
.xterm-host.cli-drag-over::after {
  content: 'Drop to paste this pane context';
}
/* Transient teaching hint; must never eat clicks meant for the terminal. */
.select-hint {
  position: absolute;
  right: 10px;
  bottom: 8px;
  z-index: 9;
  padding: 4px 9px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  pointer-events: none;
}
/* Both live in the bottom-right corner; the hint steps up when the button is out. */
.select-hint.hint-raised {
  bottom: 38px;
}
/* Interruption affordance: a CLI brought back by --resume sits at its prompt
   with its transcript loaded and nothing telling it to carry on. Small,
   corner-anchored and short-lived — it retires on the first keystroke — so an
   uninterrupted pane never carries any extra chrome. */
.continue-btn {
  position: absolute;
  right: 10px;
  bottom: 8px;
  z-index: 10;
  box-sizing: border-box;
  padding: 4px 10px;
  border: 1px solid var(--accent-emphasis);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  color: var(--accent-bright);
  font-family: inherit;
  font-size: var(--font-2xs);
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
}
.continue-btn:hover {
  background: var(--accent-subtle);
  border-color: var(--accent-focus);
}
/* Sits over the top of the terminal area rather than covering it: the
   scrollback stays readable and selectable while the backend is away. */
.disconnected-banner {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 35px;
  z-index: 9;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  border: 1px solid var(--danger-fg);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  color: var(--text-secondary);
  font-size: 11.5px;
  pointer-events: none;
}
.disconnected-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger-fg);
  animation: disconnected-pulse 1.6s ease-in-out infinite;
}
.disconnected-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@keyframes disconnected-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .disconnected-dot { animation: none; }
}
.prep-overlay {
  position: absolute;
  inset: 31px 0 0;
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg-base) 78%, transparent);
  backdrop-filter: blur(1px);
  pointer-events: auto;
}
.restoring-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
}
.prep-panel {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  max-width: min(78%, 360px);
  padding: 8px 12px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
  color: var(--text-primary);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--bg-inverse) 10%, transparent);
}
.prep-spinner {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 2px solid var(--border-muted);
  border-top-color: var(--accent-emphasis);
  animation: prep-spin 0.8s linear infinite;
  flex: 0 0 auto;
}
.prep-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-secondary);
}
@keyframes prep-spin {
  to { transform: rotate(360deg); }
}
/* xterm.js Monaco scrollbar: show track vs thumb contrast in main buffer.
   xterm injects --vscode-scrollbarSlider-background from ITheme but the track
   has no background — add a dim track so the thumb position is distinguishable. */
/* xterm Monaco scrollbar: keep thumb (slider) always visible without a track
   background. Track stays transparent so only the thumb shows as a colored
   strip — white on dark themes, dark on light theme. Avoids the "all gray"
   appearance caused by track + thumb blending to the same shade. */
.xterm-host:not(.alt-buffer) :deep(.xterm-scrollable-element > .invisible) {
  opacity: 0.7 !important;
}
/* Alt buffer (TUI): thumb fills 100% = no useful position info. Hide it. */
.xterm-host.alt-buffer :deep(.xterm-scrollable-element > .invisible) {
  opacity: 0.08 !important;
}
</style>
