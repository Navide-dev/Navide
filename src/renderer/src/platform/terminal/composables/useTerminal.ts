import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { bufferTail, createRedrawGuard, dropTuiNoise, stripAnsi } from '../lib/buffer'
import { createResizeController, type ResizeController } from './useTerminalResize'
import { installTerminalZoomShortcuts, terminalFontSize } from './useTerminalFontSize'
import { getResumeConcurrency } from '../lib/resumeConcurrency'
import {
  applyMentionPickToInput,
  buildMentionPickData,
  chunkForPty,
  shouldOpenMentionMenu,
  stripInputSequences,
  type MentionCandidate,
} from '../lib/cliContext'
import { extractClipboardImage } from '../lib/clipboardImage'
import { stopWebglCursorBlink } from '../lib/webglCursorBlink'
import { createThrottledDiag, diagLog } from '../lib/diagLog'
import { TERMINAL_CREATE_TIMEOUT_MS, formatTerminalExit, isTerminalCrashLoopOpen, recordTerminalExit, terminalCrashKey } from '../lib/terminalLifecycle'
import { settingsGet, settingsSet, setContext } from '@navide/plugin-ui/shared'
import {
  createTerminalInputHandlers,
  createTerminalMentionMenu,
  encodeShiftEnter,
  readXtermTheme,
  TERMINAL_MOUSE_MODE_RESET,
  TERMINAL_NEW_PROCESS_RESET,
  TERMINAL_RECONNECTED_DIVIDER,
  findFileLinkAt,
  findFileLinkMatchAt,
  findUrlLinkMatchAt,
  findUrlMatches,
  rootedTailCandidate,
  shedCjkPieces,
  shedCjkProse,
  splitMatchAtRowStarts,
  trimUrlTrailing,
  getWrappedLineGroup,
  groupPosToRowCol,
  groupRowColToPos,
  installTerminalLinks,
  cellColToStrCol,
  strColToCellCol,
  splitTerminalLinkSuffix,
  visualWidth,
  extractPlanDocRelPath,
  htmlReportRoute,
} from '@navide/plugin-ui'
import { createTerminalFilePicker } from '@navide/plugin-ui/file-picker'
import type {
  TerminalAgentProfile,
  TerminalAgentProfileResolver,
  WrappedLineGroup,
} from '@navide/plugin-ui'
import type { TerminalDockPort, TerminalInputOptions, TerminalSpawnOptions } from '../ports/terminalDock'

export { encodeShiftEnter }
export type { TerminalAgentProfile, TerminalAgentProfileResolver }
export {
  findFileLinkAt,
  findFileLinkMatchAt,
  findUrlLinkMatchAt,
  findUrlMatches,
  rootedTailCandidate,
  shedCjkPieces,
  shedCjkProse,
  splitMatchAtRowStarts,
  trimUrlTrailing,
} from '@navide/plugin-ui'
export type { WrappedLineGroup } from '@navide/plugin-ui'
export type { PickerItem } from '@navide/plugin-ui/file-picker'
export { mergePreferredPath } from '@navide/plugin-ui/file-picker'
export {
  cellColToStrCol,
  getWrappedLineGroup,
  groupPosToRowCol,
  groupRowColToPos,
  strColToCellCol,
  visualWidth,
  extractPlanDocRelPath,
  htmlReportRoute,
} from '@navide/plugin-ui'

export type SpawnOptions = TerminalSpawnOptions

/** Historic aliases some call sites passed before agent keys were canonical. */
function terminalSpecFor(
  agentKey: string | undefined,
  resolveProfile?: TerminalAgentProfileResolver,
): TerminalAgentProfile | undefined {
  const key = agentKey?.toLowerCase()
  const canonical = key === 'claude-code' ? 'claude' : key === 'agy' ? 'antigravity' : key
  return resolveProfile?.(canonical)
}

/** Clipboard bytes per `terminal.input` write, matching App.vue's injectText. */
const PASTE_CHUNK = 512

/**
 * How long a paste chunk waits for its `terminal.input` ack.
 *
 * Deliberately far above wsClient's 10s default. The ack shares one socket —
 * and one per-session send lock — with the PTY output firehose, so a CLI mid
 * flood (an agent repainting a full-screen TUI can push megabytes in seconds)
 * pushes the ack minutes behind the write it acknowledges. At 10s that was
 * reported as a lost paste on every busy pane; the write itself runs in the
 * handler's first line, long before the ack gets its turn.
 */
const PASTE_ACK_TIMEOUT_MS = 60_000
/** Pause between a dictated paste landing and the Enter that submits it: a
 *  CLI that tells a paste from typing by timing would otherwise read a CR in
 *  the same burst as a newline inside the paste. */
const SUBMIT_AFTER_PASTE_MS = 150
/** How long a dictated paste may wait for its acks before its Enter is given
 *  up on: a late Enter could land on whatever the user typed meanwhile. */
const SUBMIT_ACK_WAIT_MS = 3_000

/** Why a paste chunk never got a positive ack. */
type PasteChunkFailure =
  /** No socket to write to — the bytes genuinely never left the renderer. */
  | 'transport'
  /** The backend answered, and the answer was no. */
  | 'refused'
  /** Written to the socket, but the ack did not come back in time. */
  | 'timeout'

/** The alternate-screen ENTER sequence, plus the cursor-home the serializer
 *  always pairs with it. `?1047h` / `?47h` are the pre-xterm-88 spellings —
 *  matched for completeness, not because this addon emits them. */
const ALT_SCREEN_ENTER = /\x1b\[\?(?:1049|1047|47)h(?:\x1b\[H)?/

/**
 * Remove the alternate-screen ENTER sequence from a snapshot serialized with
 * `excludeAltBuffer: false`.
 *
 * @xterm/addon-serialize renders the normal buffer first and, when the terminal
 * sits in its alternate buffer, appends a literal `ESC[?1049h ESC[H` followed by
 * the alt screen. Replaying that verbatim leaves the fresh terminal PARKED in
 * its alternate buffer (measured: `buffer.active.type === 'alternate'`) — the
 * user cannot scroll back, the normal history is hidden underneath, and every
 * later write (mouse reset, the reconnected divider, live output) lands on a
 * screen that is thrown away. Without the sequence the alt screenful replays as
 * ordinary normal-buffer lines: scrollable, re-wrappable, the same shape as the
 * rest of the payload.
 *
 * Only the FIRST occurrence is touched. The serializer emits it exactly once,
 * as the boundary between the two buffers, and no other part of a serialized
 * payload can reproduce it — buffer cells hold glyphs, never raw ESC, and the
 * trailing mode section only ever writes 1h/66h/2004h/4h/6h/45h/1004h/7l/mouse.
 * When the boundary is not at position 0 the normal buffer had content of its
 * own, so the sequence becomes a line break instead of vanishing, keeping the
 * restored screen off the end of the last history line.
 */
export function stripAltScreenEnter(payload: string): string {
  const found = ALT_SCREEN_ENTER.exec(payload)
  if (!found) return payload
  const rest = payload.slice(found.index + found[0].length)
  return found.index === 0 ? rest : `${payload.slice(0, found.index)}\r\n${rest}`
}

/** Set once the "hold ⌥ to select" hint has been shown — it teaches once.
 *  Goes through settings (backend-persisted) rather than localStorage, which
 *  this app has been migrating away from and which plugin bundles don't share. */
const OPTION_SELECT_HINT_KEY = 'agentTeam.terminal.optionSelectHintSeen'

/** Agents whose TUI keeps bracketed paste on — see pasteFromClipboard(), and
 *  App.vue's injectText, which wraps its writes for the same vendors. */
export function agentUsesBracketedPaste(profile?: TerminalAgentProfile): boolean {
  return profile?.bracketedPaste === true
}

/** A mouse report, which xterm delivers through the SAME data event as a
 *  keystroke. Without this, a CLI that turned mouse tracking on would make a
 *  pane look actively typed at for as long as the pointer sits over it. SGR
 *  (`ESC[<…M/m`) and X10 (`ESC[M…`) are the encodings xterm emits. */
const MOUSE_REPORT = /^\x1b\[(?:<[\d;]*[Mm]|M)/

/** A focus report (`ESC[I` in, `ESC[O` out), sent when a CLI has focus tracking
 *  on. Same problem as a mouse report: the terminal is telling the program the
 *  pointer/focus moved, which is not the user typing. */
const FOCUS_REPORT = /^\x1b\[[IO]/

/** What the terminal reports on its own rather than what the user typed. Both
 *  the keystroke clock and the draft buffer read this: neither may be advanced
 *  by moving the mouse over a pane or clicking into and out of it. */
function isTerminalReport(data: string): boolean {
  return MOUSE_REPORT.test(data) || FOCUS_REPORT.test(data)
}

/** The custom key handler sends its bytes through pasteText, the same helper
 *  programmatic injection uses — but a chord like Shift+Enter or ⌘⌫ is still
 *  the person at the keyboard, so those sites pass this and injection does not. */
const HUMAN_KEY: TerminalInputOptions = { human: true }

// ── Edit > Copy bridge ──────────────────────────────────────────────────────
// Main cannot read an xterm selection (`.xterm` is user-select: none, so
// webContents.copy() sees nothing). Publish it on a global that Edit > Copy
// evaluates in the focused page (see TERMINAL_SELECTION_EXPRESSION in menu.ts).
// A global rather than an IPC listener on purpose: a page without one — no
// terminal mounted yet, or a plugin view on a different preload — yields '' and
// main falls back to its built-in copy, so Copy can never end up doing nothing.
//
// The FOCUSED pane answers. Keying off focus rather than "who has a selection"
// keeps a stale highlight in a background pane from hijacking a Copy aimed at
// the editor or a plain input.
let _focusOwner: Terminal | null = null
let _selectionGlobalInstalled = false

/** The focused pane's "⌘C copied nothing" reporter — only it may answer, for
 *  the same reason `_focusOwner` exists. */
let _emptyCopyReporter: ((origin?: string) => void) | undefined
let _copyEmptyBridgeInstalled = false

/** One ⌘C can reach both the menu accelerator and this handler; collapse them. */
const EMPTY_COPY_DEDUPE_MS = 300
let _lastEmptyCopyAt = 0

/** When a copy last succeeded here. A renderer too busy to answer main's 300ms
 *  selection read sends main down its "nothing selected" branch even though
 *  this page just copied fine — without this, that reports a failure over a
 *  copy the user watched work. */
let _lastCopyOkAt = 0

/** How long a success here silences a copy-empty from main. It must be
 *  comfortably LONGER than main's own selection deadline (menu.ts's
 *  SELECTION_READ_TIMEOUT_MS, 300ms): the notification this suppresses is
 *  emitted when that deadline expires, so a window of the same length lands
 *  exactly on the boundary and suppresses or not depending on task ordering
 *  we do not control. */
const COPY_OK_SUPPRESS_MS = 1_000

function installTerminalSelectionGlobal(): void {
  if (_selectionGlobalInstalled) return
  _selectionGlobalInstalled = true
  window.__navideTerminalSelection = () => {
    try {
      return _focusOwner?.getSelection() ?? ''
    } catch {
      return ''  // disposed terminal — let main run the built-in copy
    }
  }
}

/** Main tells the page when Edit > Copy's accelerator fell through to a copy
 *  that cannot work over a terminal. Installed once per page, and a no-op where
 *  the bridge is absent (older preload, or a plugin view). */
function installTerminalCopyEmptyBridge(): void {
  if (_copyEmptyBridgeInstalled) return
  // Claim the flag only once the subscription actually happened. Setting it
  // first would burn the single attempt on a bridge that was not up yet and
  // leave main unable to reach this page for the rest of the session — the
  // same shape as the write-once hint flag this whole change exists to fix.
  if (!window.agentTeam?.onTerminalCopyEmpty) return
  try {
    window.agentTeam.onTerminalCopyEmpty((branch) => { _emptyCopyReporter?.(branch) })
    _copyEmptyBridgeInstalled = true
  } catch { /* no bridge — the renderer's own ⌘C handler still reports */ }
}

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error' | 'stopped'

/** Every value `displayStatus` can report — the badge vocabulary.
 *
 *  A superset of TerminalStatus: the PTY lifecycle knows nothing about a pane
 *  parked on the user, which is derived from out-of-band CLI signals. Keep this
 *  the single source: AgentOverviewStatus extends it, and every status-keyed
 *  CSS block and i18n key is written against these exact strings. Adding a
 *  value here is what makes the compiler point at the places that must follow.
 *
 *  'awaiting' covers EVERY way a pane can be parked on the user — a permission
 *  box, an MCP form, or the agent asking a question. They were once two badges
 *  and the split confused more than it explained: the person reading it only
 *  needs to know the pane will not move until they answer. Which kind it is
 *  still matters to code that is not the badge (see `awaitingKind`). */
export type DisplayStatus = TerminalStatus | 'awaiting'

// Every live useTerminal instance, so the module-level helpers below can reach
// each pane's scrollback snapshot: the app-exit save (App.vue's beforeunload),
// the session-id rotation, and the orphan-first eviction inside a pane.
interface TerminalSnapshotHooks {
  /** The pane's current persistence key (the `terminal-pty:` / `terminal-scroll:` suffix). */
  currentKey: () => string
  /** Follow a session-id rotation, so later saves land on the key the next restore reads. */
  retargetKey: (key: string) => void
  /** Persist this pane's scrollback right now. */
  save: () => void
}
const _liveTerminals = new Set<TerminalSnapshotHooks>()

/** Persist every live pane's scrollback snapshot.
 *
 *  Called from App.vue's `beforeunload`, which is the only notice a hard page
 *  teardown (⌘R's `role: 'reload'`, app quit) gives — `onScopeDispose` never
 *  runs there. `beforeunload` cannot await, so this only catches what xterm has
 *  already parsed; the periodic save inside each pane is what makes the stored
 *  snapshot complete, and this is the ≤60s catch-up on top of it. */
export function saveAllScrollSnapshots(): void {
  for (const hooks of _liveTerminals) {
    try { hooks.save() } catch { /* one pane must not stop the rest */ }
  }
}

/** `terminal-scroll:` keys a live pane still owns. Everything else under that
 *  prefix is an orphan — no pane will ever write or replay it again. */
function liveScrollSnapKeys(): Set<string> {
  const keys = new Set<string>()
  for (const hooks of _liveTerminals) {
    const key = hooks.currentKey()
    if (key) keys.add(`terminal-scroll:${key}`)
  }
  return keys
}

// The persistence key (`terminal-pty:<resumeKey>`, `terminal-scroll:<resumeKey>`)
// follows the CLI's session id, but a CLI rewrites its session id on every
// resume (claude --resume A records a NEW session B). Carry both the live PTY id
// and the scrollback snapshot over to the rotated key — otherwise the next
// restore can't find the running PTY, spawns a second CLI, and the old one
// lingers detached until the backend janitor reaps it; and the snapshot, written
// under the old id but read back under the new one, is invisible history that
// still competes for the shared localStorage quota.
export function migrateTerminalPtyKey(oldKey: string, newKey: string): void {
  if (!oldKey || !newKey || oldKey === newKey) return
  try {
    for (const prefix of ['terminal-pty:', 'terminal-scroll:']) {
      const value = localStorage.getItem(prefix + oldKey)
      if (value == null) continue
      localStorage.setItem(prefix + newKey, value)
      localStorage.removeItem(prefix + oldKey)
    }
  } catch { /* ignore */ }
  // Moving the stored entries is only half the job: the pane that owns them
  // captured its key at spawn() time and keeps writing to it, so without this
  // every later save would land back on the dead key — leaving a fresh orphan
  // behind and freezing the migrated snapshot at the moment of rotation.
  for (const hooks of _liveTerminals) {
    if (hooks.currentKey() === oldKey) hooks.retargetKey(newKey)
  }
}

// Cached dimensions from any visible terminal. Hidden tabs use these to start
// their PTY at the real layout size instead of xterm's 80x24 default: a PTY
// created too narrow makes the CLI draw its banner and footer narrow, and that
// already-printed output never widens again (static output can't re-wrap wider,
// and an idle alt-buffer TUI ignores the later SIGWINCH). Persisted so the
// spawns right after an app restart — a workspace restore fires them while
// every pane is still hidden — have a size to borrow as well.
const LAST_SIZE_KEY = 'terminal-last-size'
let _lastKnownCols = 0
let _lastKnownRows = 0
try {
  const raw = localStorage.getItem(LAST_SIZE_KEY)
  const parsed = raw ? (JSON.parse(raw) as { cols?: unknown; rows?: unknown }) : null
  if (typeof parsed?.cols === 'number' && typeof parsed?.rows === 'number'
      && parsed.cols > 0 && parsed.rows > 0) {
    _lastKnownCols = Math.trunc(parsed.cols)
    _lastKnownRows = Math.trunc(parsed.rows)
  }
} catch { /* no persisted size — the 80x24 fallback still applies */ }

/** Open a clicked path in the mini-IDE. Files inside the pane's workspace open
 *  as a workspace-relative path; files outside it keep `workspace_path` on the
 *  workspace and name their own root in `file_ws` (their parent directory), so
 *  the mini-IDE adds a tab instead of reloading onto a different workspace and
 *  losing every open tab. Without a pane workspace there is nothing to stay
 *  on, so the file's own directory becomes the workspace (previous behaviour). */
function openInEditor(
  terminalPort: TerminalDockPort,
  absPath: string,
  line: number | undefined,
  workspacePath?: string,
  onFailure?: (filepath: string) => void,
): void {
  const slash = absPath.lastIndexOf('/')
  const dir = slash > 0 ? absPath.slice(0, slash) : '/'
  const root = workspacePath?.replace(/\/+$/, '')
  const inWorkspace = !!root && absPath.startsWith(`${root}/`)
  const filepath = inWorkspace ? absPath.slice(root.length + 1) : absPath.slice(slash + 1)
  // Called synchronously so the request leaves at pick time; a sync throw is
  // folded into the same failure path as a rejection.
  let pending: Promise<boolean | void>
  try {
    pending = terminalPort.openFile({
      workspacePath: root || dir,
      filepath,
      ...(root && !inWorkspace ? { fileWorkspace: dir } : {}),
      ...(line !== undefined ? { line } : {}),
    })
  } catch (err) {
    pending = Promise.reject(err)
  }
  // `void` (a port that reports nothing) is not a failure; only `false` or a throw is.
  void pending
    .then((opened) => { if (opened === false) onFailure?.(filepath) })
    .catch(() => onFailure?.(filepath))
}

// '~/'-prefixed links (shell output loves them) resolve against the user's
// home directory: the expanded absolute form is used for stat/open, while the
// picker keeps displaying the '~' form. Home is fetched once over IPC and
// cached for the sync display path.
let _homeDir = ''
async function fetchHomeDir(terminalPort: TerminalDockPort): Promise<string> {
  if (_homeDir) return _homeDir
  try {
    _homeDir = (await terminalPort.getHomeDirectory?.()) ?? ''
  } catch { /* ignore — '~' links just fall back to fuzzy search */ }
  return _homeDir
}

export function expandHomePath(fp: string, home: string): string {
  if (!home || (fp !== '~' && !fp.startsWith('~/'))) return fp
  return home.replace(/\/+$/, '') + fp.slice(1)
}

// Moved to lib/paths so a caller that only wants the string helper does not
// load this module. Re-exported because every existing import names it here.
// The box-frame regex is shared with lib/injectEcho, which also has to find the
// frame — there by its position rather than to skip it — so the two cannot
// drift apart.
import { BOX_ONLY_LINE_RE } from '../../../lib/injectEcho'
import { collapseHomePath } from '../lib/paths'
export { collapseHomePath } from '../lib/paths'

/** Serialize the RENDERED scrollback (what the user actually sees) as text.
 *  Unlike the raw-stream cleanBuffer, TUI repaints overwrite buffer lines in
 *  place, so a status footer that repaints 1000 times appears once here.
 *  Walks backwards from the cursor row, drops the trailing blank / box-only
 *  frame lines, takes at most `maxLines` rows and returns them oldest→newest.
 *  READ-ONLY: never mutates the terminal. */
/** Text of the cursor's row up to the cursor column. Module-level (like
 *  serializeRenderedBuffer) so tests can drive it with a buffer fixture.
 *  Never trims: trimRight cuts the row at its last non-blank cell BEFORE the
 *  slice, which eats the space right before the cursor on any CLI without a
 *  right border - and callers key off that space. */
export function readBufferLineBeforeCursor(term: import('@xterm/xterm').Terminal): string {
  const buf = term.buffer.active
  const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(false) ?? ''
  return line.slice(0, buf.cursorX)
}

export function serializeRenderedBuffer(
  term: import('@xterm/xterm').Terminal,
  maxLines: number,
  from: 'cursor' | 'viewport-bottom' = 'cursor',
): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  let inTrailingTail = true
  // Reading from the cursor is right when the cursor marks where output ended.
  // A full-screen TUI showing a dialog breaks that: it hides the cursor and
  // leaves it wherever it last wrote, which can be ABOVE the dialog, so
  // everything below — including the dialog — would be invisible. Starting at
  // the viewport bottom instead sees the whole screen; the trailing-blank skip
  // below still lands on the last real line either way.
  const start = from === 'cursor'
    ? buffer.baseY + buffer.cursorY
    : buffer.baseY + term.rows - 1
  for (let i = start; i >= 0 && lines.length < maxLines; i--) {
    const text = buffer.getLine(i)?.translateToString(true) ?? ''
    if (inTrailingTail) {
      if (!text.trim() || BOX_ONLY_LINE_RE.test(text)) continue
      inTrailingTail = false
    }
    lines.push(text)
  }
  lines.reverse()
  return lines.join('\n')
}

interface UseTerminalOptions {
  workspacePath?: string
  onClear?: () => void
  onUserResume?: () => void
  /** Getter for the OTHER CLI panes' addresses (already excluding self), with
   *  the pre-translated group and status words the menu draws beside them.
   *  Feeds the @-mention autocomplete menu. Read lazily at trigger time so the
   *  list stays current as panes come and go.
   *
   *  The host resolves the words because this composable owns no i18n scope,
   *  and it orders the list because recency is the host's to remember — see
   *  onMentionPick. */
  mentionCandidates?: () => MentionCandidate[]
  /** The addresses a mention pick just inserted, for the host to record as
   *  recently used (it feeds the next call's ordering). */
  onMentionPick?: (addresses: string[]) => void
  onFirstOutput?: () => void
  /** Whether App's layout currently shows this pane (onScreenPaneIds). Paged-out
   *  panes stay mounted so their terminals survive, which also means every
   *  hidden pane keeps paying for display-only upkeep. Read lazily so it tracks
   *  layout changes. Defaults to always on screen. */
  onScreen?: () => boolean
  /** A copy or paste that came to nothing, for the pane to surface.
   *
   *  Reported rather than shown here: this composable deliberately imports
   *  neither i18n nor useNotify (the pane owns both), the same split onClear
   *  and onUserResume follow. The diagnostic log line is written regardless —
   *  it serves a bug report, this serves the person watching the pane. */
  onClipboardFailure?: (reason: ClipboardFailureReason, chars: number) => void
  /** The pane's PTY did not survive the disconnect — a backend restart kills
   *  every PTY, and the ownerless janitor eventually reaps the rest. Reported
   *  rather than handled here because resuming is the owner's job: only App
   *  knows the agent, the session id, and how to build the vendor's resume
   *  command. */
  onPtyLostWhileDisconnected?: () => void
  /** A file picked from the ⌘-click picker that the host could not open.
   *  Reported rather than shown here, like onClipboardFailure. */
  onOpenFileFailure?: (filepath: string) => void
  /** Vendor-specific terminal behavior is supplied by the plugin-shell owner. */
  agentProfileFor?: TerminalAgentProfileResolver
}

/** Why a clipboard action produced nothing. One key per user-visible message. */
export type ClipboardFailureReason =
  /** Nothing on the clipboard to send (⌘V on an empty one, or a drop that resolved no paths). */
  | 'empty'
  /** The pane is still starting and gates stdin; the text was discarded, not queued. */
  | 'preparing'
  /** No live session to receive it — never spawned, or the CLI has exited. */
  | 'no-session'
  /** A pasted image could not be written to disk, so no path was sent. */
  | 'image-failed'
  /** The browser refused the clipboard write, so ⌘C copied nothing. */
  | 'copy-failed'
  /** Some of the paste never left: the transport was down, or the backend refused it. */
  | 'send-failed'
  /** Every chunk failed the same way — nothing of this paste reached the pane. */
  | 'send-failed-all'
  /** ⌘C with no selection while the CLI holds the mouse — a plain drag cannot select. */
  | 'copy-mouse-captured'
  /** ⌘C with no selection and no mouse capture — nothing was highlighted. */
  | 'copy-no-selection'

// Whether this renderer process can create a WebGL context at all, probed once.
//
// WebglAddon does not fail in a way a try/catch around loadAddon can observe:
// when no context can be created it reports that asynchronously from inside
// activate(), so the catch stayed silent and every pane quietly kept the DOM
// renderer while looking like it had been upgraded. Probing directly gives an
// answer that can be logged and asserted on. The probe context is released
// immediately so it does not eat one of the browser's limited context slots.
let _webglProbe: boolean | null = null
function webglAvailable(): boolean {
  if (_webglProbe !== null) return _webglProbe
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    if (gl) (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext()
    _webglProbe = !!gl
  } catch {
    _webglProbe = false
  }
  if (!_webglProbe) {
    console.info(
      '[terminal] WebGL unavailable — terminals run on the DOM renderer. ' +
        'On desktop GPU acceleration is on by default; NAVIDE_DISABLE_GPU=1 turns it off.'
    )
  }
  return _webglProbe
}

/** Test seam: forget the cached probe result. */
export function _resetWebglProbeForTests(): void {
  _webglProbe = null
}

// Throttle for RESUME spawns' terminal.create across all panes. A session
// restore (App.vue restores panes with Promise.all) or a multi-pane layout can
// fire N resume spawns at once, and each does serial pre-ack work on the
// backend's single event-loop thread: a login-shell PATH refresh, a CLI probe
// (up to 8s), a synchronous PTY fork, an attribution scan. Letting all N hit at
// once stacks that work and pushes later acks past the request deadline
// ("request terminal.create timeout" → pane setup failed). This module-level
// semaphore caps how many resume creates are in flight (rest queue) so the
// backend drains them in small batches; the cap is user-configurable
// (getResumeConcurrency, default 3). Fresh spawns are light and stay
// unthrottled — throttling them too would stall pipeline stages spawned into
// background tabs. Acquired BEFORE send() so queue-wait doesn't count against
// the per-request timeout. Orthogonal to each composable's own `_creating` lock.
// Raised from wsClient's 10s default: the backend's near-8s CLI probe plus PTY
// fork and attribution scan is legitimately heavier than an average request, so
// 10s was too tight even for a single healthy spawn.
// Upper bound on the queue wait. Not charging it against the per-request
// timeout is the point of acquiring early, but "not charged" was implemented as
// "unbounded": when the in-flight creates never ack, the queued panes never even
// send their create and sit in 'starting' with nothing to time out. A single
// healthy spawn is dominated by the near-8s CLI probe, so 45s absorbs several
// normal drain rounds and still fails loudly long before "stuck forever".
const RESUME_QUEUE_TIMEOUT_MS = 45_000

let _resumeSpawnActive = 0
// Waiters are objects, not bare resolvers, so a timed-out one is identifiable.
// A timed-out waiter removes itself from the queue, and grant() reports whether
// it actually took the baton — handing the slot to a waiter that already gave up
// would destroy it (the active count would never come back down), so the
// releaser keeps walking the queue until someone accepts or it runs out.
interface ResumeSpawnWaiter { grant(): boolean }
const _resumeSpawnWaiters: ResumeSpawnWaiter[] = []

async function acquireResumeSpawnSlot(): Promise<void> {
  // Cap read live at acquire time so a Settings change takes effect immediately.
  if (_resumeSpawnActive < getResumeConcurrency()) {
    _resumeSpawnActive++
    return
  }
  // Wait; releaseResumeSpawnSlot hands us the slot (count stays put).
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const waiter: ResumeSpawnWaiter = {
      grant(): boolean {
        if (settled) return false
        settled = true
        if (timer !== null) clearTimeout(timer)
        resolve()
        return true
      },
    }
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      const at = _resumeSpawnWaiters.indexOf(waiter)
      if (at >= 0) _resumeSpawnWaiters.splice(at, 1)  // no slot may be sent our way
      reject(new Error(
        `resume spawn queue timed out after ${Math.round(RESUME_QUEUE_TIMEOUT_MS / 1000)}s`
      ))
    }, RESUME_QUEUE_TIMEOUT_MS)
    _resumeSpawnWaiters.push(waiter)
  })
}

function releaseResumeSpawnSlot(): void {
  // Pass the baton to the first waiter still alive (the count stays put); only
  // when nobody takes it does the slot actually go back to the pool.
  while (_resumeSpawnWaiters.length > 0) {
    if (_resumeSpawnWaiters.shift()!.grant()) return
  }
  _resumeSpawnActive--
}

export function useTerminal(paneId: string, terminalPort: TerminalDockPort, opts?: UseTerminalOptions) {
  installTerminalZoomShortcuts()
  installTerminalSelectionGlobal()
  installTerminalCopyEmptyBridge()

  const agentProfile = (agentKey?: string): TerminalAgentProfile | undefined =>
    terminalSpecFor(agentKey, opts?.agentProfileFor)

  const term = new Terminal({
    // Option+drag forces normal text selection even while a TUI has mouse
    // reporting on (vim/htop/tmux/less). Without it, xterm's macOS branch of
    // shouldForceSelection() is `altKey && macOptionClickForcesSelection`, so
    // it is permanently false and there is NO way to select terminal text once
    // a CLI enables mouse tracking — the Shift+drag escape hatch other
    // platforms get is macOS-excluded. Trade-off: this disables Option+drag
    // column selection on macOS (xterm binds both to the same gesture and
    // makes them mutually exclusive); Navide never surfaced column select.
    macOptionClickForcesSelection: true,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    // Seeded from the shared size so a pane spawned after a zoom matches the rest.
    fontSize: terminalFontSize.value,
    cursorBlink: true,
    convertEol: false,
    scrollback: 10000,
    // Auto-lift any low-contrast text (e.g. a TUI's dimmed/faint prompt that
    // renders as near-background grey) to a readable foreground. We can't
    // recolor a CLI's alt-buffer output directly, but this WCAG-AAA ratio forces
    // xterm to nudge unreadable fg/bg pairs into legibility across all panes.
    minimumContrastRatio: 7,
    theme: readXtermTheme(),
    // Required for `term.unicode` below — the unicode API is still a proposed
    // API in xterm 6; without this flag its getter throws at setup time and
    // the whole pane renders blank.
    allowProposedApi: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  // Unicode 11 width tables (VS Code parity: unicodeVersion defaults to "11").
  // xterm's built-in tables are Unicode 6; agent CLIs measure display width
  // with newer Unicode (string-width), so emoji/symbol widths disagree and
  // mid-line input repaints land at the wrong column (overlapping text).
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  // Scrollback is persisted by serializing xterm's own buffer, NOT by hoarding
  // the raw PTY bytes. Claude Code paints its whole screen with absolute cursor
  // moves (measured on a real snapshot: 1300 ESC[r;cH, 2032 ESC[nG, zero \n),
  // and those coordinates are constants baked in at the width they were drawn
  // at. Replaying them into a terminal of a different width writes into the
  // wrong cells — text lands on top of text and the leftovers stay on screen.
  // Serializing emits the RESULT (glyphs + SGR) instead of the drawing
  // instructions, so a replay only ever re-wraps.
  const serializer = new SerializeAddon()
  term.loadAddon(serializer)

  term.onResize(({ cols, rows }) => {
    if (cols > 0 && rows > 0) {
      _lastKnownCols = cols
      _lastKnownRows = rows
      try { localStorage.setItem(LAST_SIZE_KEY, JSON.stringify({ cols, rows })) } catch { /* ignore */ }
    }
  })

  const containerRef = shallowRef<HTMLElement | null>(null)
  const status = ref<TerminalStatus>('idle')
  const sessionId = ref<string>('')
  const error = ref<string>('')
  const lastCommand = ref<string>('')
  const isAltBuffer = ref(false)
  let isDisposed = false
  let activeAgentKey: string | undefined

  // ── "hold ⌥ to select" hint ────────────────────────────────────────────────
  // Once a CLI turns mouse reporting on, a plain drag is forwarded to the
  // process and highlights nothing; the force-selection modifier is the only
  // way out (see macOptionClickForcesSelection above). Nothing on screen says
  // so, so teach it the first time a drag visibly does nothing.
  const optionSelectHint = ref(false)
  let _hintDragX = -1
  let _hintDragY = -1
  let _hintTimer: ReturnType<typeof setTimeout> | null = null

  function maybeShowOptionSelectHint(e: MouseEvent): void {
    if (_hintDragX < 0 || optionSelectHint.value) return
    if (Math.abs(e.clientX - _hintDragX) + Math.abs(e.clientY - _hintDragY) < 12) return
    _hintDragX = -1  // one shot per drag
    if (settingsGet(OPTION_SELECT_HINT_KEY, false)) return
    settingsSet(OPTION_SELECT_HINT_KEY, true)
    showOptionSelectHint()
  }

  /** Show the hint for its usual dwell, restarting the timer if it is already up. */
  function showOptionSelectHint(): void {
    if (_hintTimer) clearTimeout(_hintTimer)
    optionSelectHint.value = true
    _hintTimer = setTimeout(() => { optionSelectHint.value = false }, 6000)
  }
  let activeCrashKey = ''

  // Rolling ANSI-stripped text accumulator used by the pipeline orchestrator
  // to detect stage sentinels and QUESTION blocks. Capped at ~128KB to keep
  // memory predictable across long-running panes.
  const cleanBuffer = ref<string>('')
  const cleanBytesSeen = ref(0)
  // When this terminal created a PTY for a resume spawn (0 otherwise, and for a
  // reattach, whose CLI never stopped). The messaging gate reads it: a resumed
  // CLI reloads its transcript in silence, so quiet alone does not mean ready —
  // see lib/resumeBoot.ts.
  const resumeSpawnedAt = ref(0)
  // `lastActivityAt` only updates when CLEANED text changes — i.e. real content.
  // Used for analyzer triggers and sentinel scans.
  const lastActivityAt = ref<number>(0)
  // `lastRawActivityAt` updates on ANY non-empty PTY chunk including TUI
  // spinners / status-bar redraws / animated progress glyphs. Used by the
  // idle-stall safety net so a long-thinking agent that's still visibly
  // alive on screen isn't mistaken for a wedged process.
  const lastRawActivityAt = ref<number>(0)
  // When the user clicks/focuses the pane, Claude TUI redraws its status bar
  // & cursor. After ANSI/noise stripping some clean bytes still arrive, which
  // would flip the idle/running badge back to "running" even though the
  // agent isn't actually working. We suppress lastActivityAt updates for a
  // short window after a focus event so the badge stays honest.
  const lastFocusAt = ref<number>(0)
  const FOCUS_GRACE_MS = 3_000
  // Wheel events forwarded to the PTY (alt buffer + mouse tracking, see the
  // custom wheel handler in mount()) make the TUI repaint a SHIFTED viewport.
  // That repaint is real content lines, so noise-stripping keeps it, and it is
  // reassembled/reflowed (often from history already past the replay tail), so
  // isRedrawReplay can't recognize it either — a sustained scroll used to
  // latch the RUNNING badge. Output landing inside this window after a
  // forwarded wheel event is excluded from burst/latch tracking and the
  // activity clock; each wheel notch re-arms the window.
  const lastScrollAt = ref<number>(0)
  const SCROLL_GRACE_MS = 1_000

  // ── RUNNING vs IDLE ──────────────────────────────────────────────────────────
  // We want RUNNING only when the CLI is genuinely executing — not for brief
  // nudges, TUI redraws, or prompt echoes that last a second or two.
  //
  // The design is deliberately ASYMMETRIC: entering RUNNING is strict, leaving
  // it is slow (hysteresis). Entry still needs a CONTINUOUS burst of clean
  // output lasting MIN_BURST_MS, so short nudge responses never qualify. Exit
  // needs IDLE_CONFIRM_MS of clean silence, because an agent running a tool
  // call goes quiet for many seconds at a time and must not flicker to idle.
  //
  // INVARIANT: BURST_GAP_MS > MIN_BURST_MS. If the gap that splits two bursts
  // were shorter than the time a burst must last, chunky output landing in
  // between would reset the burst start before it could ever reach the
  // threshold — a dead zone where the badge stays idle forever.
  //
  // The PTY stream is the primary source; the only external signal involved is
  // the CLI's own turn_complete (see markTurnComplete), which lets the badge
  // drop to idle early instead of waiting out IDLE_CONFIRM_MS.
  const BURST_GAP_MS      = 3_000    // gap that splits two separate bursts
  const MIN_BURST_MS      = 2_000    // burst must last this long to ENTER running
  const IDLE_CONFIRM_MS   = 10_000   // clean silence required to LEAVE running
  const activityBurstStartAt = ref<number>(0)
  // Clean-content activity clock for the RUNNING badge (see appendClean). Kept
  // separate from lastRawActivityAt so an idle CLI that only repaints its
  // footer/cursor (raw bytes, but empty after noise-stripping) can't keep the
  // badge stuck on RUNNING.
  const lastCleanBurstAt = ref<number>(0)
  // Hysteresis latch: entering RUNNING is strict (a burst must last
  // MIN_BURST_MS), but leaving it is deliberately slow — an agent running a
  // tool call goes quiet for seconds at a time and must not flicker back to
  // idle. Once latched, only IDLE_CONFIRM_MS of clean silence (or an
  // authoritative turn_complete) clears it.
  const runningLatched = ref(false)
  // Authoritative turn end from the CLI's own log (agent.activity
  // turn_complete), fed in by App.vue. Lets claude/copilot drop to idle
  // immediately instead of waiting out IDLE_CONFIRM_MS.
  const turnCompleteAt = ref<number>(0)
  // Authoritative "parked on the user" signal, fed in by App.vue from Claude's
  // Notification hook. Unlike turn_complete this is NOT a turn boundary: the
  // agent is mid-task, waiting on a permission prompt (or sitting at an empty
  // prompt), which on the PTY is indistinguishable from a finished turn — the
  // prompt paints once and then goes silent, so the hysteresis below would
  // call it idle. See markNeedsInput.
  const awaitingInputAt = ref<number>(0)
  // The prompt box the hook announces is itself clean output, and it can land
  // on either side of the hook (one arrives over HTTP, the other over the PTY).
  // Clean output inside this window is read as the prompt painting itself;
  // anything after it means the user answered and the CLI moved on.
  const AWAITING_SETTLE_MS = 3_000
  // "The agent asked you something", fed in by App.vue. Distinct from
  // awaitingInputAt: that one is a permission prompt the CLI raised to run a
  // tool, this one is the agent putting a question to the user — either its
  // AskUserQuestion box (which pauses the turn mid-flight, so no turn_complete
  // ever arrives) or a turn that ended on a question. Both look exactly like a
  // finished turn on the PTY. Same settle semantics as awaiting: clean output
  // past the window means the user answered and the CLI moved on.
  const questionAt = ref<number>(0)
  // Messages Navide itself delivered into this pane that the CLI has not yet
  // picked up, fed in by App.vue. A CLI that queues mid-turn input (Claude
  // Code) keeps working on the current turn — often painting only a spinner,
  // which is stripped as TUI noise — so the PTY heuristic settles to idle
  // while our message is still sitting in its queue. A count, not a flag: each
  // envelope the recipient's transcript shows consumed releases one, so two
  // deliveries need two consumes. The timestamp is the fuse's clock, taken at
  // the LATEST delivery — see displayStatus for why the fuse exists at all.
  const deliveredPendingCount = ref<number>(0)
  const deliveredPendingAt = ref<number>(0)
  // Same reasoning as TURN_STALE_MS in lib/agentMessaging.ts: the consume
  // signal is trustworthy but a single miss (a reader dropping a record, a
  // turn aborted with ESC) must not park the badge on RUNNING forever.
  const DELIVERED_PENDING_FUSE_MS = 120_000
  // Background tasks (a backgrounded shell, an async subagent) the CLI started
  // and has not reported finished, from its transcript. They outlive the turn
  // that launched them — that turn still ends with a normal turn_complete — so
  // without this the pane reads as idle while the work runs. Ids, not a count:
  // a fast command's completion is logged BEFORE the record that launched it,
  // so ids that already ended are remembered and a late start for one is
  // ignored. Fused like delivered-pending: a task killed outside TaskStop (a
  // `kill <pid>`, a dev server left running) writes no end record, and nothing
  // but a respawn would otherwise take the badge off RUNNING. The fuse is an
  // inactivity window, not a lifetime: it runs from the latest sign of life
  // (the task's start, clean output, a turn end), so a long watch the agent
  // keeps checking on holds RUNNING however long it runs, and only a pane that
  // has gone quiet for the whole window lets it lapse. Past the fuse a task no
  // longer holds the badge; its id stays tracked so an end still clears it.
  const BACKGROUND_TASK_FUSE_MS = 30 * 60_000
  const backgroundTaskIds = ref<Map<string, number>>(new Map())
  const endedBackgroundTaskIds = new Set<string>()
  // Tick so displayStatus re-evaluates after output goes quiet.
  const nowTick = ref<number>(Date.now())
  const isOnScreen = (): boolean => opts?.onScreen?.() ?? true
  // Its only consumers — displayStatus's idle check and startingAgeMs — are
  // display-only. An off-screen pane still needs to settle (its sidebar badge
  // must reach idle), so the tick slows rather than stops: at one second per
  // pane, a workspace with dozens of panes spent a wakeup and a computed
  // re-evaluation per pane per second redrawing nothing anyone was looking at.
  const TICK_ON_SCREEN_MS = 1_000
  const TICK_OFF_SCREEN_MS = 10_000
  const startTick = (ms: number): number =>
    window.setInterval(() => { nowTick.value = Date.now() }, ms)
  let tickInterval = startTick(isOnScreen() ? TICK_ON_SCREEN_MS : TICK_OFF_SCREEN_MS)
  watch(isOnScreen, (onScreen) => {
    clearInterval(tickInterval)
    tickInterval = startTick(onScreen ? TICK_ON_SCREEN_MS : TICK_OFF_SCREEN_MS)
    // A pane coming back on screen must not show a status up to
    // TICK_OFF_SCREEN_MS stale, so settle it immediately.
    if (onScreen) nowTick.value = Date.now()
    // Output that arrived under the off-screen window must not wait on it now
    // that someone is looking. Before the renderer is re-attached, so the
    // catch-up write lands in one redraw rather than two.
    if (onScreen) _flushPendingOutput(true)
    // Nothing drawn means nothing scheduled: a blinking cursor on a pane that
    // is not on screen is a 600 ms timer (WebGL) or a forever CSS animation
    // (DOM) that no one can see. xterm pauses its renderer on its own, but not
    // this.
    setCursorBlink(onScreen)
    // Hand the WebGL context back while off screen so on-screen panes stay
    // within Chromium's live-context budget (see attachWebgl).
    if (onScreen) attachWebgl()
    else detachWebgl()
  })
  setCursorBlink(isOnScreen())

  // Starts when spawn() enters the raw STARTING state, before any reattach,
  // layout, or resume-semaphore wait. App uses this to unlock recovery at the
  // same deadline as terminal.create itself.
  const startingStartedAt = ref<number | null>(null)
  const startingAgeMs = computed<number | null>(() => (
    status.value === 'starting' && startingStartedAt.value != null
      ? Math.max(0, nowTick.value - startingStartedAt.value)
      : null
  ))
  // Which early exit in _doCreate last stopped a spawn from reaching
  // terminal.create. Those exits are silent on purpose — the spawn stays parked
  // and the reconciler / ResizeObserver retry it once the pane is measurable —
  // so a pane that is never retried is indistinguishable from one that is
  // legitimately still waiting. Recording the exit is what lets the starting
  // watchdog say WHERE a stuck pane stopped instead of only that it stopped.
  const stallReason = ref<string | null>(null)

  const isStopped = ref(false)

  const displayStatus = computed<DisplayStatus>(() => {
    if (status.value === 'exited' || status.value === 'error') return status.value
    if (isStopped.value) return 'stopped'
    // A resume parked for a hidden tab hasn't created its PTY yet — a resumed
    // agent comes up idle, so show 'idle' instead of a stuck 'starting' in the
    // agent list until the tab is shown. (Fresh spawns create immediately, so
    // their brief parked window keeps the normal status.)
    if (pendingSpawn.value?.isResume) return 'idle'
    if (status.value !== 'running') return status.value
    // Spawned but not a single byte of output yet — the CLI is still booting
    // (Gemini stays silent ~5s during auth/init). Show "starting", not "idle".
    // Any byte (even a pure TUI repaint) means the CLI is up, so this gates
    // "booting" only.
    if (lastRawActivityAt.value === 0) return 'starting'
    // RUNNING/idle is judged on CLEANED activity, not raw bytes: an idle CLI
    // repainting its footer/cursor emits raw bytes but no clean content, so it
    // goes idle after IDLE_CONFIRM_MS instead of sticking on RUNNING.
    //
    // Authoritative turn end wins — but only while no newer clean output has
    // arrived. A trailing chunk that lands after the event pushes
    // lastCleanBurstAt past it and falls through to the hysteresis path.
    //
    // runningLatched is the ONLY entry into RUNNING. The MIN_BURST_MS test
    // lives entirely in appendClean, which is the only place that knows output
    // is still arriving. Do not re-add a burst-age check here: measured from a
    // computed it just counts wall time since the burst started, so a single
    // clean chunk would light the badge 2 s later and hold it until the
    // IDLE_CONFIRM_MS timeout. The timeout below stays because silence never
    // calls appendClean, so nothing else can drop the latch.
    //
    // AWAITING wins over every idle path below. A CLI parked on a permission
    // prompt emits nothing once the prompt is painted, so the silence timeout
    // would report it as idle — visually identical to a finished turn, and the
    // one case where the user has to act for anything to happen at all. The
    // settle window absorbs the prompt's own paint; real output past it, or an
    // authoritative turn end (which clears the flag), means it is over.
    if (
      awaitingInputAt.value > 0 &&
      lastCleanBurstAt.value < awaitingInputAt.value + AWAITING_SETTLE_MS
    ) return 'awaiting'
    // A question reports the same badge as a permission prompt — both mean the
    // pane will not move until the user answers. It is kept a separate signal
    // rather than folded into awaitingInputAt because the two are raised and
    // released by different code and mean different things to the messaging
    // gate; only the BADGE is shared. It must outrank every idle path below —
    // including the authoritative turn end, because a turn that ends ON a
    // question reports turn_complete and would otherwise read as idle.
    if (
      questionAt.value > 0 &&
      lastCleanBurstAt.value < questionAt.value + AWAITING_SETTLE_MS
    ) return 'awaiting'
    // Background work still running is work, whatever the turn end says. Below
    // both AWAITING paths for the same reason as the delivered-pending check
    // that follows: a pane parked on a prompt needs the user, not patience.
    const lastSignOfLife = Math.max(lastCleanBurstAt.value, turnCompleteAt.value)
    for (const startedAt of backgroundTaskIds.value.values()) {
      if (nowTick.value - Math.max(startedAt, lastSignOfLife) <= BACKGROUND_TASK_FUSE_MS) return 'running'
    }
    // A message we delivered that the CLI has not consumed yet means it still
    // has work queued, whatever the PTY says. Below both AWAITING paths on
    // purpose: a pane parked on a prompt or a question cannot consume anything
    // until the user acts, and hiding that behind RUNNING would take the one
    // badge that tells them to. Above the authoritative turn end because
    // Claude Code ends the CURRENT turn before it dequeues — that turn_complete
    // is exactly the moment this must keep reporting RUNNING. The fuse is not
    // a detection window: a consume signal that never arrives would otherwise
    // hold RUNNING indefinitely (GitHub #21 parked a pane 8.5h on one lost
    // signal), so past it the delivery is deemed consumed.
    if (
      deliveredPendingCount.value > 0 &&
      nowTick.value - deliveredPendingAt.value <= DELIVERED_PENDING_FUSE_MS
    ) return 'running'
    if (turnCompleteAt.value > lastCleanBurstAt.value) return 'idle'
    if (nowTick.value - lastCleanBurstAt.value > IDLE_CONFIRM_MS) return 'idle'
    return runningLatched.value ? 'running' : 'idle'
  })

  /** Which kind of wait the AWAITING badge is currently reporting, for the
   *  code that still has to tell them apart. Null whenever the badge is
   *  something else.
   *
   *  The badge merged the two; the messaging gate must not. What this splits on
   *  is NOT who asked — it is whether a widget is currently on screen eating
   *  keystrokes:
   *
   *   • 'permission' — something is drawn and waiting for a choice. Delivery
   *     writes to the PTY, so a message injected now is swallowed as that
   *     widget's answer instead of starting a turn. Raised by markNeedsInput,
   *     whose callers are the notification hook and the screen watcher, and
   *     both of those only fire while a box is painted. A Claude
   *     AskUserQuestion box lands here too, and belongs here: it is a select
   *     widget, and typing into it is exactly as destructive as answering a
   *     permission prompt by accident.
   *   • 'question' — the agent asked something and went back to its ordinary
   *     prompt, so the pane can take a turn normally. Raised by markQuestion
   *     (a turn whose text ends on a question). Those panes reached the gate as
   *     'idle' before any of this existed, and holding them back now would newly
   *     park them out of dispatch.
   *
   *  See messagingHoldKey. Resolved in the same order displayStatus resolves
   *  them, so a pane with both flags lit reports the more restrictive one. */
  const awaitingKind = computed<'permission' | 'question' | null>(() => {
    if (displayStatus.value !== 'awaiting') return null
    const permission =
      awaitingInputAt.value > 0 &&
      lastCleanBurstAt.value < awaitingInputAt.value + AWAITING_SETTLE_MS
    return permission ? 'permission' : 'question'
  })
  const BUFFER_CAP = 128 * 1024
  const redrawGuard = createRedrawGuard()

  // Only ever called from flushPendingClean, with the decoded text of every
  // chunk that arrived inside one CLEAN_COALESCE_MS window. The raw-activity
  // clock is NOT touched here: it is bumped per chunk in _flushPendingOutput,
  // so liveness never waits on the coalescing timer.
  function appendClean(chunk: string): void {
    const cleaned = dropTuiNoise(stripAnsi(chunk))
    if (!cleaned) return
    // A focus/resize repaint re-emits content already on screen; after noise
    // stripping it looks like fresh output and would flip the badge to RUNNING
    // for a mere click/resize. Drop replays here — the raw-activity clock above
    // already marked the process alive, but a replay must not build a burst or
    // double the buffer. Genuinely new content isn't a replay and falls through.
    if (redrawGuard.isReplay(cleaned)) return
    // Badge burst tracking, driven by CLEANED content only. Output inside the
    // scroll grace window is a shifted-viewport repaint the replay check above
    // can't recognize — it must neither build a burst nor drop/raise the
    // latch. Unlike the focus grace below, this must gate the LATCH, not just
    // the activity clock: the latch update is what flips the badge. Bytes are
    // still kept (buffer/liveness) so genuine output isn't lost; a latched
    // RUNNING coasts through the scroll on hysteresis, which is why the wheel
    // handler advances lastCleanBurstAt itself while RUNNING holds — freezing
    // the clock here is only safe for as long as the silence timeout hasn't
    // expired against it.
    const now = Date.now()
    const inScrollGrace = now - lastScrollAt.value < SCROLL_GRACE_MS
    if (!inScrollGrace) {
      const sinceLastClean = now - lastCleanBurstAt.value
      // Silence past the confirm window ends the run: drop the latch so the next
      // burst has to re-earn RUNNING rather than resuming it on a single byte.
      if (sinceLastClean > IDLE_CONFIRM_MS) runningLatched.value = false
      // A gap > BURST_GAP_MS in clean output starts a new burst.
      if (sinceLastClean > BURST_GAP_MS) activityBurstStartAt.value = now
      lastCleanBurstAt.value = now
      if (!runningLatched.value && now - activityBurstStartAt.value >= MIN_BURST_MS) {
        runningLatched.value = true
      }
    }
    // Monotonic total — unlike cleanBuffer.length, this keeps growing after
    // the buffer hits BUFFER_CAP, so quiet-detection (waitForQuiet etc.) can
    // tell "still streaming" from "quiet" during large session replays.
    cleanBytesSeen.value += cleaned.length
    // Trim lazily. `a + b` is a rope in V8 and costs nothing, but bufferTail's
    // slice flattens it — so trimming on every chunk charged ~30µs per chunk
    // once the buffer sat at cap, however small the chunk was. At 20 chunks per
    // keystroke (macOS splits a PTY read at 1KB) that tax dominated the whole
    // output path. Trimming only at twice the cap amortises it to ~nothing per
    // chunk; the buffer now drifts between BUFFER_CAP and 2x it, which no
    // consumer depends on — App.vue already treats cleanBuffer.length as
    // unreliable past the cap and uses cleanBytesSeen for progress.
    const next = cleanBuffer.value + cleaned
    cleanBuffer.value = next.length > BUFFER_CAP * 2 ? bufferTail(next, BUFFER_CAP) : next
    redrawGuard.accept(cleaned)
    // Skip the activity timestamp if this chunk arrived inside the focus
    // grace window — those bytes are very likely a focus-triggered TUI
    // redraw, not real agent output. Buffer content is still kept so any
    // genuine output isn't lost; only the timestamp is held back.
    const inFocusGrace = now - lastFocusAt.value < FOCUS_GRACE_MS
    if (!inFocusGrace && !inScrollGrace) lastActivityAt.value = now
  }

  /** Authoritative turn end from the CLI's own conversation log. Drops the
   *  hysteresis latch so the badge goes idle now instead of waiting out
   *  IDLE_CONFIRM_MS. Only vendors whose log reader emits turn_complete reach
   *  here: every vendor except cursor, which emits agent_active only and so
   *  falls back to the silence timeout. Four of them (grok/kimi/pi/qwen) have
   *  no turn-end record in the log and flush a turn after their reader's own
   *  quiet window, so they arrive a few seconds late; the rest read the
   *  boundary from a record — opencode a `step-finish` reason, antigravity a
   *  completed step that carries a reply. */
  function markTurnComplete(): void {
    // turn_complete is a synchronous chain (App.vue agent.activity → here →
    // judgeTurnText → onStageSlotCompleted → cleanBuffer read): the turn's
    // last chunk usually lands inside the coalesce window, so settle it now.
    // Otherwise the deferred clean pass would run AFTER the latch is dropped
    // below, re-latch RUNNING, and the handoff would miss the final text.
    flushPendingClean()
    turnCompleteAt.value = Date.now()
    runningLatched.value = false
    // A turn that ended is not waiting on anyone: clear the flag so a stale
    // notification can't hold the badge on AWAITING past the turn.
    awaitingInputAt.value = 0
  }

  /** The CLI is parked on the user. Two callers, both in App.vue: Claude's
   *  Notification hook (event-shaped — it fires once, so the settle window and
   *  markTurnComplete are what end it), and the prompt-pattern watcher for
   *  vendors with no hook (state-shaped — it re-asserts every poll while the
   *  prompt is on screen, and calls clearNeedsInput when it goes away). */
  function markNeedsInput(): void {
    awaitingInputAt.value = Date.now()
  }

  /** The prompt is gone — the pattern watcher stopped matching. Only that
   *  watcher calls this: the hook has nothing to re-check, so clearing it on a
   *  poll would drop AWAITING while Claude is still parked. */
  function clearNeedsInput(): void {
    awaitingInputAt.value = 0
  }

  /** The agent put a question to the user. Called from App.vue on the reader's
   *  `assistant:question` detail (Claude's AskUserQuestion box) and on a
   *  turn_complete whose text ends on a question. */
  function markQuestion(): void {
    questionAt.value = Date.now()
  }

  /** The question was answered — or the turn that follows one started. Called
   *  on the user's next prompt and on any turn_complete that does NOT end on a
   *  question, so a stale flag can't hold the badge past the answer. */
  function clearQuestion(): void {
    questionAt.value = 0
  }

  /** Navide delivered a message into this pane and the CLI accepted it (Enter
   *  verified). Called from App.vue's deliverAgentMessage. A count that already
   *  outlived the fuse is stale by definition — its consume signal was lost —
   *  so it is dropped rather than carried into the new delivery, or the next
   *  consume would leave a ghost holding RUNNING for a message long gone. */
  function markDeliveredPending(): void {
    const now = Date.now()
    if (deliveredPendingCount.value > 0 && now - deliveredPendingAt.value > DELIVERED_PENDING_FUSE_MS) {
      deliveredPendingCount.value = 0
    }
    deliveredPendingCount.value += 1
    deliveredPendingAt.value = now
  }

  /** The CLI picked a delivered message up. One per envelope the recipient's
   *  transcript shows as a user record; `all` for readers that carry no user
   *  text, where the next turn end is the only consume signal there is. */
  function clearDeliveredPending(all = false): void {
    deliveredPendingCount.value = all ? 0 : Math.max(0, deliveredPendingCount.value - 1)
  }

  /** The CLI's transcript shows background tasks starting or finishing.
   *  Called from App.vue on the reader's `background:start` / `background:end`
   *  details. */
  function noteBackgroundTasks(kind: 'start' | 'end', ids: string[]): void {
    const next = new Map(backgroundTaskIds.value)
    for (const id of ids) {
      if (kind === 'end') {
        endedBackgroundTaskIds.add(id)
        next.delete(id)
      } else if (!endedBackgroundTaskIds.has(id)) {
        next.set(id, Date.now())
      }
    }
    backgroundTaskIds.value = next
  }

  function markBufferPosition(): number {
    flushPendingClean()
    return cleanBuffer.value.length
  }

  /** Retroactively scrub TUI noise from the existing buffer — useful when
   *  the noise-filter rules change (HMR) or a watcher arms on an old pane. */
  function recleanBuffer(): void {
    flushPendingClean()
    cleanBuffer.value = dropTuiNoise(cleanBuffer.value)
    redrawGuard.reset(cleanBuffer.value)
  }

  /** Tail of the RENDERED scrollback — the text the user sees on screen. The
   *  right source for sharing a pane's content (context paste / AI-Chat chip):
   *  cleanBuffer's tail is dominated by TUI status-footer repaints. */
  function readRenderedText(maxLines: number): string {
    return serializeRenderedBuffer(term, maxLines)
  }

  /** Like readRenderedText, but read from the bottom of the visible screen
   *  rather than the cursor — see serializeRenderedBuffer. Used by the
   *  AWAITING prompt watcher, which must see a dialog a TUI drew below
   *  wherever it happened to leave the cursor. */
  function readScreenTail(maxLines: number): string {
    return serializeRenderedBuffer(term, maxLines, 'viewport-bottom')
  }

  /** Cursor-row text up to the cursor column. Used by the pane-drop handler
   *  to detect an "@" typed right before the drop (mention mode: insert just
   *  the source pane's messaging name, not its scrollback). */
  function readLineBeforeCursor(): string {
    return readBufferLineBeforeCursor(term)
  }

  // The public terminal mention menu owns the imperative overlay, filtering,
  // selection, and document-level keyboard handling. Host state remains here.
  const mentionMenu = createTerminalMentionMenu({
    terminal: term,
    host: () => mountedEl,
    onPick: (query, addresses) => {
      const data = buildMentionPickData(query, addresses)
      if (!data || !inputTransportReady()) return
      inputBuffer = applyMentionPickToInput(inputBuffer, query, addresses)
      syncDraft()
      void terminalPort.input(sessionId.value, data, undefined, { human: true })
      opts?.onMentionPick?.(addresses)
    },
  })

  let inputDisposer: { dispose(): void } | null = null
  let outputUnsub: (() => void) | null = null
  let exitUnsub: (() => void) | null = null
  let firstOutputSeen = false
  // Pending terminal output coalescing. The focused pane flushes immediately
  // on arrival — keystroke echo must not wait for a frame (worst for IME
  // input, where the whole commit waits on it). Unfocused panes coalesce
  // writes for _BACKGROUND_COALESCE_MS so a streaming background agent does
  // not starve the pane the user is typing in of main-thread time. (A timer,
  // not rAF: rAF is paused in packaged Electron when the window is occluded,
  // which would leave output stuck in _pendingOutput.)
  const _BACKGROUND_COALESCE_MS = 100
  // A pane that is off screen is not drawn at all — xterm pauses its renderer
  // once the terminal stops intersecting the viewport — so the reason to hand
  // it output promptly is gone. What still reads from it is the badge path,
  // whose hysteresis is measured in seconds, and pollAwaitingPanes, which looks
  // once a second; batching at half a second costs them nothing and saves a
  // parse, a write-buffer wake-up and a clean pass per chunk. Coming back on
  // screen flushes immediately, so nothing arrives late on the way in.
  const _OFF_SCREEN_COALESCE_MS = 500
  const _coalesceMs = (): number =>
    isOnScreen() ? _BACKGROUND_COALESCE_MS : _OFF_SCREEN_COALESCE_MS
  // The text side path (decode → stripAnsi/dropTuiNoise → cleanBuffer → badge
  // burst) is NOT needed per chunk: its consumers are the RUNNING/IDLE
  // hysteresis (BURST_GAP_MS / IDLE_CONFIRM_MS, seconds) and App.vue
  // watchers/polls, none of which read cleanBuffer synchronously with output.
  // Under a flood (cat of a big file, TUI repaint) a focused pane sees dozens
  // of chunks per keystroke, and running the regex passes on each one competes
  // with rendering for the main thread. So chunks are queued and the whole
  // window is cleaned once, CLEAN_COALESCE_MS after the first chunk. This
  // only applies to the focused pane's immediate writes: a background flush is
  // already one batch per _BACKGROUND_COALESCE_MS and cleans inline, so no
  // pane ever waits longer than 100ms to reflect output. Far below every
  // timing gate that reads the result; sync readers call flushPendingClean().
  const CLEAN_COALESCE_MS = 50
  // Output arrives as raw PTY bytes (binary WS frames); legacy string chunks
  // are still accepted defensively. Chunks are queued as-is — xterm.js takes
  // Uint8Array natively and runs its own streaming UTF-8 decoder.
  let _pendingOutput: (string | Uint8Array)[] = []
  let _outputTimer: ReturnType<typeof setTimeout> | null = null
  // Streaming decoder for appendClean's text-side consumers (badge/liveness):
  // a chunk may end mid-character, so the decoder must carry state across
  // chunks. Recreated per session so a dead session's tail state never bleeds
  // into the next one.
  let _cleanDecoder = new TextDecoder('utf-8')

  function _chunkText(chunk: string | Uint8Array): string {
    return typeof chunk === 'string' ? chunk : _cleanDecoder.decode(chunk, { stream: true })
  }

  // Chunks already written to xterm but not yet run through appendClean.
  let _pendingClean: (string | Uint8Array)[] = []
  let _cleanTimer: ReturnType<typeof setTimeout> | null = null

  /** Run the text side path over every queued chunk now, in arrival order.
   *  Synchronous: after it returns cleanBuffer/badge state reflect everything
   *  written to xterm so far. */
  function flushPendingClean(): void {
    if (_cleanTimer) { clearTimeout(_cleanTimer); _cleanTimer = null }
    const chunks = _pendingClean
    if (!chunks.length) return
    _pendingClean = []
    // Feed the ONE streaming decoder chunk by chunk so a multi-byte character
    // split across chunks still decodes correctly, then clean the joined text
    // once — an escape sequence split across chunks is stripped whole here.
    appendClean(chunks.map(_chunkText).join(''))
  }

  function _flushPendingOutput(immediateClean = false): void {
    if (_outputTimer) { clearTimeout(_outputTimer); _outputTimer = null }
    const chunks = _pendingOutput
    _pendingOutput = []
    if (!chunks.length) return
    const onFirstOutput = !firstOutputSeen ? opts?.onFirstOutput : undefined
    firstOutputSeen = true
    for (let i = 0; i < chunks.length; i++) {
      // Callback on the last write: it fires once ALL pending chunks are
      // processed, matching the old single-string-write semantics.
      term.write(chunks[i], i === chunks.length - 1 ? onFirstOutput : undefined)
      // ANY byte counts as "process still alive" — spinners included. This
      // feeds liveness/stall detection (App.vue safety net, resize-quiet gate)
      // ONLY and stays on the chunk path; it deliberately does NOT drive the
      // RUNNING badge: an idle CLI that merely repaints its footer/cursor emits
      // raw bytes too. The badge burst is built from CLEANED content, batched
      // by flushPendingClean.
      if (chunks[i].length > 0) lastRawActivityAt.value = Date.now()
      _pendingClean.push(chunks[i])
    }
    if (immediateClean) flushPendingClean()
    else if (!_cleanTimer) _cleanTimer = setTimeout(flushPendingClean, CLEAN_COALESCE_MS)
  }
  let mounted = false
  let mountedEl: HTMLElement | null = null
  let _mousedownHandler: ((e: MouseEvent) => void) | null = null
  let _cmdKeyDown: ((e: KeyboardEvent) => void) | null = null
  let _cmdKeyUp: ((e: KeyboardEvent) => void) | null = null
  let _cmdClickHandler: ((e: MouseEvent) => void) | null = null
  let _linkProviderDisposer: (() => void) | null = null
  let _filePickerCloser: (() => void) | null = null
  let _mousePosTracker: ((e: MouseEvent) => void) | null = null
  let _pasteHandler: ((e: ClipboardEvent) => void) | null = null
  // Whether THIS pane's xterm textarea currently holds focus. Used to publish
  // the `terminalFocus` keybinding context (defaults.ts gates editor shortcuts
  // like cmd+f on `!terminalFocus`) and to clear it if the pane is disposed
  // while focused. Focus moving between two panes is safe: blur (old pane,
  // sets false) always fires before focus (new pane, sets true).
  let _ownsTerminalFocus = false
  // Set when the textarea lost focus only because the whole window did (cmd+tab,
  // clicking another app). Chromium fires a textarea blur in that case even
  // though focus never moved to another element in this document. Treating that
  // as "lost focus" would drop this pane's echo into the 100ms coalesced path —
  // and strand it there whenever the window returns without handing focus back
  // to the textarea, so every later keystroke echoes a frame late.
  let _blurredWithWindow = false

  // ── Edit > Copy: report the selection instead of being asked for it ────────
  // main used to evaluate a global in this page when the user pressed ⌘C, on a
  // 300ms deadline (menu.ts). A renderer busy painting CLI output loses that
  // race, and the fallback copies nothing at all over a terminal — so Copy
  // silently did nothing exactly when the pane was busiest. Pushing moves that
  // work to when the selection changes, off the path the user waits on.
  //
  // Only the focus owner reports: panes in a window share one WebContents, so
  // a background pane's stale highlight would otherwise answer a Copy aimed at
  // this one. Same rule the global it replaces followed.
  let _selectionPushTimer: ReturnType<typeof setTimeout> | null = null
  // Long enough to coalesce a drag, far short of the time it takes to let go of
  // the mouse and reach for ⌘C.
  const SELECTION_PUSH_DEBOUNCE_MS = 60
  const _reportSelection = (selection: string): void => {
    try {
      terminalPort.reportSelection?.(selection)
    } catch { /* no bridge (tests, plugin preload) — Copy keeps its own fallback */ }
  }
  const _cancelSelectionPush = (): void => {
    if (!_selectionPushTimer) return
    clearTimeout(_selectionPushTimer)
    _selectionPushTimer = null
  }
  const _onSelectionChange = (): void => {
    if (_focusOwner !== term) return
    _cancelSelectionPush()
    // hasSelection() is a boolean; getSelection() joins every selected row. On
    // each change the latter would make a drag across a long scrollback pay for
    // the whole range on every mouse move — the very renderer stall this exists
    // to route around. So clearing reports at once (cheap, and a stale entry
    // would let Copy return text the user just deselected) while a growing
    // selection is read once, after the drag settles.
    if (!term.hasSelection()) {
      _reportSelection('')
      return
    }
    _selectionPushTimer = setTimeout(() => {
      _selectionPushTimer = null
      if (_focusOwner === term) _reportSelection(term.getSelection())
    }, SELECTION_PUSH_DEBOUNCE_MS)
  }

  // Every path that concludes "this pane no longer holds focus" goes through
  // here, so Edit > Copy ownership can never outlive the keybinding context —
  // a stale owner would answer Copy with an old selection and suppress main's
  // fallback for good.
  const _releaseTerminalFocus = (): void => {
    _ownsTerminalFocus = false
    if (_focusOwner === term) {
      _focusOwner = null
      _emptyCopyReporter = undefined
      _cancelSelectionPush()
      _reportSelection('') // main must not answer Copy from a pane that lost focus
    }
    setContext('terminalFocus', false)
  }
  const _onTermFocus = (): void => {
    _blurredWithWindow = false
    _ownsTerminalFocus = true
    _focusOwner = term  // answers Edit > Copy for this window
    _emptyCopyReporter = reportEmptyCopy  // …and reports a Copy that found nothing
    // Publish what is already highlighted, so Copy is right from the first
    // press rather than only after the next selection change.
    _reportSelection(term.hasSelection() ? term.getSelection() : '')
    setContext('terminalFocus', true)
  }
  const _onTermBlur = (): void => {
    // A blur that came with the whole window losing focus is not a focus
    // change — keep owning Edit > Copy, since reaching the menu bar causes it.
    if (!document.hasFocus()) { _blurredWithWindow = true; return }
    _blurredWithWindow = false
    _releaseTerminalFocus()
  }
  // Runs in every mounted pane, but the _blurredWithWindow guard means only the
  // one that actually held focus reacts — panes never fight over it.
  const _onWindowFocus = (): void => {
    if (!_blurredWithWindow) return
    _blurredWithWindow = false
    const active = document.activeElement
    if (!active || active === document.body) {
      // Nothing claimed focus while we were away; take it back so typing lands
      // in the terminal the user left off in. focus() is a no-op on an element
      // that stopped being rendered while the window was away (pane hidden by a
      // layout change), so verify rather than assert focus we never received.
      term.focus()
      if (document.activeElement !== term.textarea) {
        // Typing now goes nowhere the user can see until they click the pane,
        // which is indistinguishable from "the terminal became laggy".
        diagLog(terminalPort, 'focus', `pane=${paneId} window returned but the terminal could not retake focus`, 'warning')
        _releaseTerminalFocus()
      }
    } else if (active !== term.textarea) {
      _releaseTerminalFocus()
    }
  }

  // Subscribed for the life of the pane; the handler is a no-op unless this
  // pane owns focus, so background panes cost one comparison per change.
  const _selectionDisposer = term.onSelectionChange(_onSelectionChange)

  // xterm's CompositionHelper latches on compositionstart and only unlatches on
  // compositionend — which macOS does not reliably deliver when the user
  // switches input method mid-composition. While latched, its keydown() returns
  // early for keyCode 229, so every subsequent IME keystroke is swallowed and
  // piles up in the hidden textarea until some non-IME key forces a flush. That
  // is the "typed for seconds, then everything appears at once" symptom.
  //
  // Only reads the helper's public surface (isComposing getter, compositionend
  // method), and is optional-chained so an xterm upgrade that relocates it
  // degrades to today's behaviour rather than breaking input entirely.
  //
  // The latch itself was derived from xterm's source, never caught in the act,
  // so it is instrumented: _compositionStartedAt dates the composition that is
  // still open, and every unlatch reports how long it had been stuck. If input
  // still feels slow after an input-method switch and NO 'stale composition'
  // line appears, the latch is not the cause and the search moves elsewhere.
  let _compositionStartedAt = 0
  // A composition open this long is no longer someone picking a candidate.
  const IME_COMPOSITION_WARN_MS = 1500
  // Both IME probes sit on a per-keystroke path, so they are throttled: if the
  // latch turns out to fire constantly, the log says so through the suppressed
  // count instead of adding a WebSocket message per key to an already slow one.
  const DIAG_THROTTLE_MS = 5000
  const _imeDiag = createThrottledDiag(terminalPort, 'ime', DIAG_THROTTLE_MS)
  const _onCompositionStart = (): void => { _compositionStartedAt = Date.now() }
  const _onCompositionEnd = (): void => {
    const held = _compositionStartedAt ? Date.now() - _compositionStartedAt : 0
    _compositionStartedAt = 0
    if (held >= IME_COMPOSITION_WARN_MS) {
      _imeDiag(`pane=${paneId} composition open ${held}ms before commit`, 'warning')
    }
  }

  type CompositionHelperLike = { isComposing: boolean, compositionend: () => void }
  function finalizeStaleComposition(): void {
    const helper = (term as unknown as { _core?: { _compositionHelper?: CompositionHelperLike } })
      ._core?._compositionHelper
    if (!helper?.isComposing) return
    const latched = _compositionStartedAt ? Date.now() - _compositionStartedAt : 0
    _compositionStartedAt = 0
    _imeDiag(
      `pane=${paneId} stale composition unlatched after ${latched}ms — xterm was swallowing keys`,
      'warning'
    )
    // waitForPropagation: the deferred path sends substring(start) — everything
    // to the end of the textarea — so the pending text is committed whole. The
    // immediate path would use a `end` offset that compositionupdate stopped
    // refreshing when the composition went stale, truncating the commit.
    helper.compositionend()
  }

  // Copy and paste are discrete human actions, so unlike the IME and echo
  // probes these are not throttled: which individual attempt failed is exactly
  // what a "the paste vanished" report needs to answer. The one path that can
  // outrun a human is a held ⌘C, which gates its own line on e.repeat.
  const _clipboardDiag = (message: string, level: 'info' | 'warning' = 'info'): void =>
    diagLog(terminalPort, 'clipboard', message, level)

  /**
   * Report a clipboard failure to both audiences at once.
   *
   * A log line answers "why did that paste vanish?" after the fact; it does
   * nothing for the person watching the pane as it happens — and "I pasted and
   * nothing appeared" is exactly the report of someone who was given no
   * feedback. So the log keeps the detail a maintainer needs (pane, sizes, the
   * underlying error) and the pane is told the one thing the user needs, which
   * is that it failed at all. Pairing them in a single call is what stops a
   * future failure path from being wired to only one of the two.
   */
  const _clipboardFailure = (
    logMessage: string,
    reason: ClipboardFailureReason,
    chars = 0
  ): void => {
    _clipboardDiag(logMessage, 'warning')
    opts?.onClipboardFailure?.(reason, chars)
  }

  /** ⌘C produced nothing. Say so — and, where a plain drag cannot select at
   *  all, say what to do about it. Reached from this pane's own key handler and
   *  from main when the Edit > Copy accelerator claimed the key first. */
  function reportEmptyCopy(origin?: string): void {
    const now = Date.now()
    if (now - _lastEmptyCopyAt < EMPTY_COPY_DEDUPE_MS) return
    if (now - _lastCopyOkAt < COPY_OK_SUPPRESS_MS) return  // this page already copied it
    _lastEmptyCopyAt = now
    // menu.ts distinguishes a renderer too busy to answer its 300ms selection
    // read from a page that promptly said there was nothing selected. Only the
    // first scales with CLI output, so the log has to keep them apart.
    const from = origin ? ` (main: ${origin})` : ''
    if (term.modes.mouseTrackingMode !== 'none') {
      // The once-ever flag is deliberately bypassed: being unable to rediscover
      // ⌥-drag after the first six seconds is the bug this fixes.
      showOptionSelectHint()
      _clipboardFailure(`pane=${paneId} Cmd+C copied nothing — the CLI captures the mouse and there is no selection${from}`, 'copy-mouse-captured')
    } else {
      _clipboardFailure(`pane=${paneId} Cmd+C copied nothing — no selection${from}`, 'copy-no-selection')
    }
  }

  // Set when a reattached pane is waiting to repaint. We never force_redraw at
  // reattach time: the renderer is mid-reflow then (reload, or a hidden tab
  // being shown), so the width is transient and would repaint the live agent
  // narrow. The reconciler fires the redraw only once container == xterm ==
  // backend, so Claude's TUI clears the transient frame and repaints at the real
  // width instead of stranding a narrow one in scrollback.
  let pendingReattachRedraw = false

  // Declared here (assigned after createWhenMeasurable is defined below) so the
  // reconciler interval and other async closures can reference it safely.
  // eslint-disable-next-line prefer-const
  let resizeCtrl!: ResizeController

  // Self-healing size reconciler. A pane that spawns or resizes while hidden
  // (background tab / spotlight / minimized → display:none) can leave the PTY
  // and xterm at different sizes — the CLI then draws its TUI for one width
  // while xterm renders another, corrupting the layout and cursor position.
  // Every tick: refit if the container disagrees with xterm, re-send if the
  // backend may disagree with xterm. Heals any missed resize within seconds.
  const RECONCILE_MS = 2_000
  const reconcileInterval = window.setInterval(() => {
    if (!mounted) return
    isAltBuffer.value = term.buffer.active.type === 'alternate'
    // A spawn parked while hidden creates as soon as the pane is measurable.
    if (pendingSpawn.value) { void createWhenMeasurable(); return }
    if (!sessionId.value) return
    // Reading clientWidth below forces a synchronous layout, and with many
    // panes mounted that cost is paid every tick for panes the layout already
    // knows are hidden. The clientWidth check stays: it still catches what
    // onScreen cannot see (minimized window, zero-height container).
    if (!isOnScreen()) return
    const el = containerRef.value
    if (!el || el.clientWidth === 0) return  // hidden — nothing to reconcile yet
    const dims = fit.proposeDimensions()
    const sized = !!dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)
    // Compare against the CAPPED width: while a cols cap is active the container
    // is deliberately wider than xterm, and comparing the raw proposal would
    // make this tick refit forever.
    if (sized && (resizeCtrl.capCols(dims.cols) !== term.cols || dims.rows !== term.rows)) {
      resizeCtrl.applyFit()
      return
    }
    if (term.cols !== resizeCtrl.ackedCols || term.rows !== resizeCtrl.ackedRows) {
      resizeCtrl.sendResizeNow()
      return
    }
    // Fully settled (container == xterm == backend-acked). A reattached pane that
    // has been waiting now repaints at this stable width — a no-op resize won't
    // raise SIGWINCH, so nudge the agent explicitly via force_redraw.
    if (sized && pendingReattachRedraw) {
      pendingReattachRedraw = false
      void terminalPort.reattach([sessionId.value], term.cols, term.rows)
    }
  }, RECONCILE_MS)

  // xterm 6 ships only the DOM renderer, which rewrites a row of DOM nodes per
  // write. That is the dominant cost of typing latency: a CLI repaints its
  // viewport on every keystroke, and each repaint lands as several writes.
  // WebGL moves the drawing to the GPU.
  //
  // It is attached only while the pane is on screen. Chromium caps how many
  // live WebGL contexts one page may hold (~16); with more panes than that,
  // attaching everywhere makes the browser evict the oldest contexts, and each
  // eviction fires context-loss on a pane that was rendering perfectly well.
  // Off-screen panes render nothing, so they give their context up.
  let webglAddon: WebglAddon | null = null
  /** Which renderer this pane ended up on. Diagnostic — see webglAvailable. */
  const rendererKind = ref<'dom' | 'webgl'>('dom')

  function attachWebgl(): void {
    // Load AFTER open(): the addon attaches its canvas to an existing element.
    if (webglAddon || !containerRef.value) return
    if (!isOnScreen() || !webglAvailable()) return
    try {
      const addon = new WebglAddon()
      // Context loss (GPU reset, driver recovery, or eviction because too many
      // contexts are live) leaves a dead canvas behind — fall back to DOM.
      addon.onContextLoss(() => { detachWebgl() })
      term.loadAddon(addon)
      webglAddon = addon
      rendererKind.value = 'webgl'
    } catch (err) {
      console.warn('[terminal] WebGL renderer failed to load, using DOM renderer', err)
      detachWebgl()
    }
  }

  function detachWebgl(): void {
    const addon = webglAddon
    webglAddon = null
    rendererKind.value = 'dom'
    if (!addon) return
    // Before dispose: the addon does not stop its own cursor-blink timer, and
    // this runs on every trip off screen. See stopWebglCursorBlink.
    stopWebglCursorBlink(addon)
    try { addon.dispose() } catch { /* xterm may have disposed it already */ }
  }

  /** Blink the cursor only while the pane is on screen. Constructed with
   *  cursorBlink: true, so this is what turns it off — including for a pane
   *  that is created behind a hidden tab and never shown. */
  function setCursorBlink(on: boolean): void {
    if (term.options.cursorBlink === on) return
    term.options.cursorBlink = on
  }

  function mount(el: HTMLElement): void {
    containerRef.value = el
    term.open(el)
    attachWebgl()

    // Publish terminal focus to the keybinding context (see _onTermFocus doc).
    term.textarea?.addEventListener('focus', _onTermFocus)
    term.textarea?.addEventListener('blur', _onTermBlur)
    window.addEventListener('focus', _onWindowFocus)
    // Observation only — xterm keeps driving the composition itself.
    term.textarea?.addEventListener('compositionstart', _onCompositionStart)
    term.textarea?.addEventListener('compositionend', _onCompositionEnd)

    const inputHandlers = createTerminalInputHandlers({
      terminal: term,
      isAgentPane: () => !!activeAgentKey && activeAgentKey !== 'terminal',
      send: (text) => { void pasteText(text, HUMAN_KEY) },
      encodeNewline: () => encodeShiftEnter(agentProfile(activeAgentKey)),
      finalizeStaleComposition,
      reportEmptyCopy: () => reportEmptyCopy(),
      copy: (selection, firstPress = true) => {
        _lastCopyOkAt = Date.now()
        void navigator.clipboard.writeText(selection).then(
          () => {
            if (firstPress) _clipboardDiag(`pane=${paneId} Cmd+C copied ${selection.length} chars (renderer path)`)
          },
          (err) => {
            if (firstPress) {
              _clipboardFailure(
                `pane=${paneId} Cmd+C clipboard write rejected (${selection.length} chars): ${String(err)}`,
                'copy-failed',
                selection.length
              )
            }
          }
        )
      },
      onScroll: () => {
        const now = Date.now()
        if (runningLatched.value && now - lastCleanBurstAt.value <= IDLE_CONFIRM_MS) {
          lastCleanBurstAt.value = now
        }
        lastScrollAt.value = now
      },
    })
    term.attachCustomWheelEventHandler(inputHandlers.wheelHandler)
    term.attachCustomKeyEventHandler(inputHandlers.keyHandler)
    // Make the whole pane click-focusable so the user can type immediately.
    el.tabIndex = 0
    el.style.cursor = 'text'
    _mousedownHandler = (e: MouseEvent) => {
      // A drag that starts without the force-selection modifier while the CLI
      // has mouse reporting on will select nothing — arm the hint (fired from
      // the mousemove tracker below, once the drag is unmistakable).
      _hintDragX = !e.altKey && !e.shiftKey && term.modes.mouseTrackingMode !== 'none' ? e.clientX : -1
      _hintDragY = e.clientY
      // Record click moment too — Claude TUI redraws on focus regardless of
      // which path got us there.
      lastFocusAt.value = Date.now()
      try {
        term.focus()
      } catch {
        /* ignore */
      }
    }
    el.addEventListener('mousedown', _mousedownHandler)

    // Intercept ⌘V / right-click Paste before xterm's own textarea handler —
    // see pasteFromClipboard() for why xterm's version truncates multi-line
    // pastes here. Capture phase so the event never reaches the textarea.
    _pasteHandler = (e: ClipboardEvent) => {
      if (e.target !== term.textarea) return
      const text = e.clipboardData?.getData('text/plain')
      if (!text) {
        // A screenshot is pixels on the clipboard with no text and no file, so
        // there is nothing to send and the agent cannot read the clipboard
        // itself. Write it out and paste the path — see lib/clipboardImage.ts.
        const image = extractClipboardImage(e.clipboardData)
        if (!image) {
          // Neither text nor pixels. This is what a copy that never landed
          // leaves behind — Edit > Copy falls back to a webContents.copy() that
          // cannot work over a terminal — and until now ⌘V on an empty
          // clipboard returned from here without a trace, which is the exact
          // shape of "I pasted and the text just disappeared".
          _clipboardFailure(
            `pane=${paneId} paste ignored — the clipboard is empty (a copy that selected nothing is the usual cause)`,
            'empty'
          )
          return
        }
        e.preventDefault()
        e.stopPropagation()
        if (term.textarea) term.textarea.value = ''
        inputHandlers.resetSelection()
        // Sent unquoted: the generated name has no spaces, so the shell is
        // happy and an agent scanning for a readable path is not tripped up by
        // quotes it may not strip.
        if (!terminalPort.saveClipboardImage) {
          _clipboardFailure(
            `pane=${paneId} clipboard image could not be saved — image support is unavailable`,
            'image-failed'
          )
          return
        }
        void terminalPort.saveClipboardImage(image).then((path) => {
          if (path) pasteFromClipboard(path)
          // saveClipboardImage resolves null (it never rejects) when the bridge
          // is missing or main declined the media type. The screenshot then
          // silently produced nothing — the same "paste did nothing" symptom.
          else {
            _clipboardFailure(
              `pane=${paneId} clipboard image could not be saved — nothing pasted`,
              'image-failed'
            )
          }
        })
        return
      }
      e.preventDefault()
      e.stopPropagation()
      // xterm's paste path clears the helper textarea; the right-click handler
      // fills it with the selection, so skipping that would leave stale text
      // for CompositionHelper (which anchors IME input at value.length).
      if (term.textarea) term.textarea.value = ''
      pasteFromClipboard(text)
      // pasteFromClipboard drops the visible selection; the keyboard-selection
      // anchor has to go with it. ⌘V is on the keepForCmd list below, so it
      // survives the key handler — and a stale anchor makes the next Backspace
      // take the "delete the selection" branch and emit a burst of deletes.
      inputHandlers.resetSelection()
    }
    el.addEventListener('paste', _pasteHandler, true)

    // ── Cmd+Click file search overlay ────────────────────────────────────────
    let _isCmdHeld = false
    let _lastMX = 0
    let _lastMY = 0

    _mousePosTracker = (e: MouseEvent) => {
      _lastMX = e.clientX
      _lastMY = e.clientY
      // Disarm as soon as the button is up, so a drag that began outside this
      // element (or ended below the threshold) cannot fire the hint later.
      if (e.buttons === 1) maybeShowOptionSelectHint(e)
      else _hintDragX = -1
    }
    el.addEventListener('mousemove', _mousePosTracker)

    _cmdKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Meta' || _isCmdHeld) return
      _isCmdHeld = true
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: _lastMX, clientY: _lastMY, metaKey: true }))
    }
    _cmdKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Meta') return
      _isCmdHeld = false
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: _lastMX, clientY: _lastMY }))
    }
    window.addEventListener('keydown', _cmdKeyDown)
    window.addEventListener('keyup', _cmdKeyUp)

    const filePicker = createTerminalFilePicker({
      query: async (q) => {
        const wsPath = opts?.workspacePath
        if (!q.trim() || !wsPath) return []
        try {
          const r = await terminalPort.listFiles(wsPath, q, 20)
          return (r.ok && r.payload?.files ? r.payload.files : []).map((rel) => {
            const parts = rel.split('/')
            const name = parts.pop() ?? rel
            return { abs: `${wsPath}/${rel}`, name, dir: parts.join('/') }
          })
        } catch { return [] }
      },
      onPick: (item, lineNum) => openInEditor(terminalPort, item.abs, lineNum, opts?.workspacePath, opts?.onOpenFileFailure),
      collapsePath: (dir) => collapseHomePath(dir, _homeDir) || '/',
    })
    _filePickerCloser = filePicker.close

    const links = installTerminalLinks({
      terminal: term,
      element: el,
      isCmdHeld: () => _isCmdHeld,
      sessionId: () => sessionId.value,
      openExternal: (href) => terminalPort.openExternal(href),
      workspacePath: () => opts?.workspacePath,
      extractPlanDocRelPath,
      openPlan: terminalPort.openPlan
        ? ({ workspacePath, relPath }) => terminalPort.openPlan!({ workspacePath: workspacePath!, relPath })
        : undefined,
      openFilePicker: (request) => {
        const wsPath = opts?.workspacePath
        const statOk = async (abs: string | undefined): Promise<boolean> => {
          if (!abs) return false
          try {
            const r = await terminalPort.statPath(abs, 1500)
            return !!(r.ok && r.payload?.exists)
          } catch { return false }
        }
        void (async () => {
          const home = await fetchHomeDir(terminalPort)
          const resolveAbs = (fp: string): string | undefined => {
            const expanded = expandHomePath(fp, home)
            return expanded.startsWith('/')
              ? expanded
              : wsPath ? `${wsPath}/${expanded.replace(/^\.\//, '')}` : undefined
          }
          const absList = request.candidates.map((c) => resolveAbs(splitTerminalLinkSuffix(c).filepath))
          const stats = await Promise.all(absList.map(statOk))
          const okIdx = stats.findIndex(Boolean)
          if (okIdx >= 0) {
            const reportRoute = htmlReportRoute(absList[okIdx]!, wsPath)
            if (reportRoute && terminalPort.openPlan) {
              void terminalPort.openPlan({ workspacePath: reportRoute.workspace_path, relPath: reportRoute.rel_path })
              return
            }
          }
          const chosenRaw = okIdx >= 0 ? request.candidates[okIdx] : request.fallback
          const { filepath, line: lineNum } = splitTerminalLinkSuffix(chosenRaw)
          if (!filepath) return
          const basename = filepath.split('/').filter(Boolean).pop() ?? filepath
          filePicker.open({
            initialQuery: basename,
            lineNum,
            preferredAbsPath: okIdx >= 0 ? absList[okIdx] : undefined,
            displayText: filepath,
          })
        })()
      },
    })
    _cmdClickHandler = links.handler
    _linkProviderDisposer = links.dispose
    el.addEventListener('mousedown', _cmdClickHandler, { capture: true })

    mountedEl = el
    resizeCtrl.attachObserver(el)
    mounted = true
  }

  function focus(): void {
    // Record focus moment so the next few hundred ms of TUI redraw don't
    // get counted as "agent activity". See FOCUS_GRACE_MS comment above.
    lastFocusAt.value = Date.now()
    try {
      term.focus()
    } catch {
      /* ignore */
    }
  }

  // Persistence key for this pane's backend PTY id (terminal_session_id), stored
  // so we can reattach to the still-running terminal after a reload instead of
  // respawning. Defaults to paneId but is overridden at spawn() time by
  // opts.resumeKey (the stable CLI session id) — the paneId is regenerated on
  // restore and would never match.
  let persistKey = paneId
  // The transcript this pane's PTY is actually writing to.
  //
  // spawn()'s caller derives a path from the NEW pane id and hands it over,
  // but a spawn that reattaches never reaches terminal.create, so nothing ever
  // opens that file: the conversation stays in the log the surviving PTY
  // opened under its original id. The backend reports that path on reattach
  // and it is adopted here, so the caller can record what exists rather than
  // what it guessed.
  const attachedOutputLogFile = ref('')
  // Previous PTY id snapshotted at spawn() time (before tryReattach can clear
  // it) — sent as replaces_terminal_id so the backend reaps the predecessor.
  let replacesPtyId = ''
  function ptyKey(): string { return `terminal-pty:${persistKey}` }
  function rememberSessionId(id: string): void {
    try {
      if (id) localStorage.setItem(ptyKey(), id)
      else localStorage.removeItem(ptyKey())
    } catch { /* ignore */ }
  }
  function persistedSessionId(): string {
    try { return localStorage.getItem(ptyKey()) || '' } catch { return '' }
  }

  // ── Scrollback snapshot ──────────────────────────────────────────────────────
  // Rolling buffer of raw ANSI output, saved to localStorage so the user's
  // terminal history survives a reload or restart. On next spawn of the same
  // resumeKey, the snapshot is replayed into the fresh xterm instance before
  // the new PTY starts writing — giving instant scrollback access to prior work.
  // Per-pane cap, in characters. localStorage bills in UTF-16, so a cap of N
  // characters costs 2N bytes of the ~5 MB per-origin quota shared by every
  // pane: at the old 256 KB cap ten panes exhausted it, and from there each
  // save evicted a neighbour (measured: 2000 serialized lines ≈ 202 KB). That
  // was survivable while the only save was at teardown; with the periodic save
  // below it would turn occasional eviction into constant churn. 64 KB ≈ 128 KB
  // of quota, so ~40 panes fit — and at the measured ~100 characters per line
  // it still keeps ~640 lines of history per pane. Chosen over a cap that
  // scales with the live pane count because the quota is shared with snapshots
  // of panes that no longer exist (and with other renderer state), so a
  // computed budget would be confidently wrong; the halving loop in
  // saveScrollSnapshot already adapts to real pressure.
  const SCROLL_SNAP_MAX = 64 * 1024
  // Scrollback is measured in lines, not bytes: the payload is produced by
  // serializing xterm's buffer, and the only safe way to shrink it is to
  // serialize fewer lines. Slicing the string would cut through an escape
  // sequence and corrupt everything after the cut.
  const SCROLL_SNAP_LINES = 2000
  const SCROLL_SNAP_MIN_LINES = 100
  // Set when a session ends cleanly: its scrollback must not be persisted, and
  // unlike the old raw buffer there is nothing to clear — the content lives in
  // xterm itself, which is still on screen at that point.
  let snapshotDiscarded = false
  // Set once this pane's xterm has had the snapshot written into it. Both entry
  // points (tryReattach on a live PTY, _doCreate on a fresh one) read the same
  // stored payload, and replaying it a second time into the same terminal would
  // print the history twice.
  let snapshotReplayed = false
  // Marks a snapshot as a serialized buffer. Snapshots written before this
  // format existed are raw PTY bytes: replaying those is exactly the bug this
  // format was introduced to fix, so an unmarked snapshot is dropped rather
  // than rendered. Without this, the first resume after an upgrade would still
  // come back garbled.
  const SNAP_FORMAT = 'nv1\n'
  function scrollSnapKey(): string { return `terminal-scroll:${persistKey}` }
  function loadScrollSnapshot(): string {
    try {
      const stored = localStorage.getItem(scrollSnapKey()) ?? ''
      if (!stored.startsWith(SNAP_FORMAT)) {
        if (stored) localStorage.removeItem(scrollSnapKey())  // reclaim the quota
        return ''
      }
      return stored.slice(SNAP_FORMAT.length)
    } catch { return '' }
  }
  // localStorage quota is shared across every pane's snapshot, and snapshots
  // of closed panes linger. On overflow, evict another snapshot and retry —
  // dropping old history beats silently losing the newest.
  //
  // Orphans go first: a `terminal-scroll:` key no live pane owns is history
  // nobody can ever replay, while a live pane's snapshot is scrollback the user
  // may still come back to. Only when there is no orphan left do live panes
  // start taking from each other (which is what the periodic save would
  // otherwise make continuous).
  function evictOtherSnapshot(selfKey: string): boolean {
    const live = liveScrollSnapKeys()
    let orphan = ''
    let orphanLen = -1
    let owned = ''
    let ownedLen = -1
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k || k === selfKey || !k.startsWith('terminal-scroll:')) continue
        const len = (localStorage.getItem(k) ?? '').length
        if (live.has(k)) {
          if (len > ownedLen) { owned = k; ownedLen = len }
        } else if (len > orphanLen) {
          orphan = k; orphanLen = len
        }
      }
      const victim = orphan || owned
      if (!victim) return false
      localStorage.removeItem(victim)
      return true
    } catch { return false }
  }
  // Render the buffer to a width-independent payload. excludeAltBuffer keeps a
  // TUI's transient full-screen view (vim, a pager) out of the snapshot — only
  // the normal buffer, which holds the conversation, is worth restoring; the
  // CLI repaints its own alt-buffer view when it reattaches.
  //
  // A `fullScreenTui` vendor inverts that: its CONVERSATION is
  // the alt buffer, so excluding it saved an all but empty snapshot and both the
  // periodic save and the reattach replay were doing nothing for those panes.
  // Include the alt buffer there and strip the enter sequence, so the screen
  // replays as normal-buffer lines instead of parking the terminal in the
  // alternate buffer (see stripAltScreenEnter).
  //
  // Ceiling: xterm keeps NO scrollback for the alternate buffer, so this
  // recovers the LAST SCREENFUL of a running session, never the whole
  // conversation. History still accumulates across restarts — the replayed
  // snapshot lands in the normal buffer, which the next save serializes ahead
  // of the current screen.
  /** `lines` undefined = every line xterm still holds (the addon's default),
   *  which is what a handoff wants; the stored snapshot passes its cap. */
  function serializeSnapshot(lines?: number): string {
    const altIsHistory = agentProfile(activeAgentKey)?.fullScreenTui === true
    try {
      const payload = serializer.serialize({
        ...(lines === undefined ? {} : { scrollback: lines }),
        excludeAltBuffer: !altIsHistory,
      })
      return altIsHistory ? stripAltScreenEnter(payload) : payload
    } catch {
      return ''
    }
  }
  function saveScrollSnapshot(): void {
    const key = scrollSnapKey()
    let lines = SCROLL_SNAP_LINES
    let payload = snapshotDiscarded ? '' : serializeSnapshot(lines)
    // Halve the line count (never the string) until it fits the byte cap.
    while (payload.length > SCROLL_SNAP_MAX && lines > SCROLL_SNAP_MIN_LINES) {
      lines = Math.floor(lines / 2)
      payload = serializeSnapshot(lines)
    }
    if (!payload.trim()) {
      try { localStorage.removeItem(key) } catch { /* ignore */ }
      return
    }
    for (;;) {
      try {
        localStorage.setItem(key, SNAP_FORMAT + payload)
        return
      } catch {
        if (evictOtherSnapshot(key)) continue
        if (lines > SCROLL_SNAP_MIN_LINES) {
          lines = Math.floor(lines / 2)
          payload = serializeSnapshot(lines)
          continue
        }
        console.warn(`[terminal] scrollback snapshot dropped for ${persistKey}: localStorage quota exhausted`)
        return
      }
    }
  }

  // ── Periodic snapshot ────────────────────────────────────────────────────────
  // Teardown is not a reliable save point: a hard page reload (⌘R is Electron's
  // `role: 'reload'`) and an app restart both drop the renderer without running
  // onScopeDispose, so the pane came back with nothing to replay. Save while the
  // pane is idle instead, riding the per-pane status tick above (1s on screen,
  // 10s off) rather than adding an interval of its own.
  //
  // Saving at idle is also MORE faithful than saving at teardown: output is
  // coalesced for _BACKGROUND_COALESCE_MS before it reaches xterm, and the
  // teardown path serializes the buffer BEFORE cleanupSession flushes that
  // pending chunk — so the teardown snapshot is structurally missing its last
  // ~100ms. After SNAP_QUIET_MS of silence there is nothing left in flight.
  const SNAP_QUIET_MS = 3_000       // PTY silence (incl. TUI repaints) before saving
  const SNAP_MIN_GAP_MS = 60_000    // floor on how often a pane rewrites its snapshot
  let lastSnapSavedAt = 0
  // lastRawActivityAt as of the last save. Any byte since then — TUI repaint
  // included — means the buffer may have changed; equal means it cannot have,
  // so there is nothing to re-serialize. Cheaper and steadier than diffing the
  // payload, which would cost a 9ms serialize per tick just to find no change.
  let lastSnapActivityAt = 0
  function maybeSaveScrollSnapshot(): void {
    // The session ended: its snapshot was deliberately removed (see the exit
    // handler). Writing it back here would resurrect a closed session's
    // scrollback for the next pane that reuses the key.
    if (snapshotDiscarded) return
    if (displayStatus.value === 'running') return
    const raw = lastRawActivityAt.value
    if (raw === 0) return                      // nothing has ever been rendered
    if (raw === lastSnapActivityAt) return     // unchanged since the last save
    const now = Date.now()
    if (now - raw < SNAP_QUIET_MS) return      // still mid-output / mid-repaint
    if (now - lastSnapSavedAt < SNAP_MIN_GAP_MS) return
    saveScrollSnapshot()
    lastSnapSavedAt = now
    lastSnapActivityAt = raw
  }
  watch(nowTick, maybeSaveScrollSnapshot)

  /** This pane's scrollback as a serialized buffer, for handing to the pane
   *  that replaces it. Everything xterm still holds (bounded by xterm's own
   *  scrollback, not the stored snapshot's line cap — this is a memory
   *  handoff, not a localStorage write), in the stored snapshot's format.
   *
   *  Async on purpose: `term.write` queues, and the buffer only reflects a
   *  chunk once the parser has run it (a write callback fires after every
   *  earlier write has been processed). Serializing right after the flush
   *  would drop the tail the flush had just queued. */
  async function serializeScrollback(): Promise<string> {
    _flushPendingOutput()
    await new Promise<void>((resolve) => term.write('', resolve))
    return serializeSnapshot()
  }

  const _snapshotHooks: TerminalSnapshotHooks = {
    currentKey: () => persistKey,
    retargetKey: (key: string) => { persistKey = key },
    save: saveScrollSnapshot,
  }
  _liveTerminals.add(_snapshotHooks)

  // Rolling tail of what the user typed on the current line, used to spot the
  // `/clear` command. Lives out here (rather than inside bindSessionHandlers)
  // because the manual-paste path bypasses term.onData and has to feed it too —
  // otherwise pasting "/clear" and pressing Enter stops triggering onClear.
  let inputBuffer = ''

  /** When a real keystroke last reached this pane (mouse reports excluded).
   *  Zero until the user types. */
  const lastUserKeyAt = ref(0)

  /** Past this, an unsent line stops counting as a draft. The buffer itself is
   *  kept (it is also how `/clear` is recognised) — only the claim on delivery
   *  expires.
   *
   *  It exists because the buffer can only be emptied by a key that says so
   *  (Enter, Backspace, Ctrl+C/U/W, Escape), and there are inputs no such key
   *  ever follows: a permission prompt or an AskUserQuestion box answered with
   *  a bare `1`/`y`, which the CLI consumes on the keypress. The transition out
   *  of those two states clears the buffer below, and this is the backstop for
   *  every case that transition does not see. A minute is long enough that a
   *  real half-written line is still protected while someone is thinking about
   *  it, and the alternative to expiring at all is a pane whose messages never
   *  arrive again — and which `syncPaneBusy` keeps reporting as busy. */
  const DRAFT_STALE_MS = 60_000

  /** Longest buffer `onLeftUserPrompt` will throw away. The latch it exists to
   *  break is a prompt answered with a bare `1`/`2`/`y`/`n`, so anything longer
   *  than that is a line the user was writing, not an answer the CLI consumed —
   *  and leaving a prompt is not proof it was answered at all. `idle_prompt` and
   *  the other resolved Notification types end `awaiting` on their own (see
   *  cliAwaitingInput's RESOLVED_NOTIFICATION_TYPES), so an unconditional clear
   *  there would drop a real half-written line and let the next injection submit
   *  what was left of it. Those longer lines fall to DRAFT_STALE_MS instead. */
  const SINGLE_KEY_ANSWER_MAX = 2

  const draftPending = ref(false)

  /** True while that line holds something the user has not submitted yet.
   *
   *  Published because an unsent draft is not visible to anyone outside this
   *  composable, and injecting into a pane that has one appends the injected
   *  text to the draft and submits both together — see App.vue's messaging
   *  idle gate, which holds delivery on it. */
  const hasDraft = computed(() =>
    draftPending.value &&
    lastUserKeyAt.value > 0 &&
    // nowTick, not Date.now(): a computed reading the clock directly would be
    // cached at whatever the first read saw and never expire.
    nowTick.value - lastUserKeyAt.value < DRAFT_STALE_MS
  )

  function syncDraft(): void {
    draftPending.value = inputBuffer.trim() !== ''
  }

  /** Whether the program on the other end of this PTY has mode 2004 on right
   *  now, as xterm parsed it off that program's own output.
   *
   *  A plain getter, not a ref: xterm mutates `term.modes` outside Vue, so a
   *  computed would cache the first answer. Published because an injection is
   *  written straight to the PTY without going through xterm, so App.vue's
   *  injectText has no other way to know whether guards will be understood —
   *  and a CLI that dropped to a sub-shell, a bare bash, or a raw login prompt
   *  turns the mode off while the pane's vendor key still says it uses it. */
  function isBracketedPasteActive(): boolean {
    return term.modes.bracketedPasteMode === true
  }

  /** The other half of the same problem, and the precise one: a prompt answered
   *  with a single key never reaches Enter, so nothing above empties the buffer
   *  and the pane stays "being typed at" for good. Leaving `awaiting`/`question`
   *  is the moment the CLI took that answer, so whatever the line held is gone.
   *
   *  Deliberately narrow. Clearing on any turn signal instead would drop a line
   *  the user really is half-way through writing while the agent works, which is
   *  the exact case this gate exists for. And someone who answered a prompt and
   *  kept typing is still covered — lastUserKeyAt holds delivery on its own for
   *  a few seconds after every keystroke.
   *
   *  Wired further down, where displayStatus is safe to evaluate. */
  function onLeftUserPrompt(now: DisplayStatus, before: DisplayStatus): void {
    if (before !== 'awaiting' || now === 'awaiting') return
    if (inputBuffer.trim().length > SINGLE_KEY_ANSWER_MAX) return
    inputBuffer = ''
    syncDraft()
  }

  // Spawn-phase input gate. A pane is "preparing" for as long as its CLI is
  // booting (starting → checking-dialog → settling → injecting-role), and the
  // PTY cannot take keystrokes yet. This used to be xterm's own `disableStdin`,
  // which makes CoreService swallow keys outright — whatever the user typed in
  // that window was gone, which reads as "the pane ignored me and then caught
  // up". Hold the keystrokes here instead and replay them once the pane is
  // ready, so the input is late rather than lost.
  //
  // Only term.onData (real typing) is gated. pasteText stays open on purpose:
  // the injecting-role step sends the role prompt through it while isPreparing
  // is still true, so gating that path would deadlock the pane's own startup.
  let _stdinGated = false
  let _gatedInput = ''
  // True once something in _gatedInput was typed rather than reported by the
  // terminal, so the flush can carry the human flag the keystrokes would have.
  let _gatedInputHuman = false
  const GATED_INPUT_MAX = 4096
  /** When the held buffer was last written to, for the staleness bound below. */
  let _gatedInputAt = 0
  /** Past this, a held buffer is a stale reflex rather than a pending line. */
  const GATED_INPUT_MAX_AGE_MS = 60_000

  /**
   * True while the transport can actually carry a keystroke.
   *
   * Input must never ride wsClient's send queue. That queue exists so a request
   * survives a brief reconnect, which is right for a status poll and wrong for
   * a keystroke: on a fast reconnect it replays the whole burst into the TUI at
   * once — every Enter and Ctrl-C the user pressed at a pane that looked frozen
   * — and on a slow one (backoff reaches 30 s, the queue's timeout is 10 s) it
   * drops them with no error at all, because these sends are fire-and-forget.
   * Refusing is the honest option; the pane's disconnected overlay is what
   * tells the user why their typing is going nowhere.
   */
  function inputTransportReady(): boolean {
    return terminalPort.status.value === 'connected'
  }

  /** Replay what the user typed while the pane was still preparing. */
  function _flushGatedInput(): void {
    if (!_gatedInput) return
    // Hold the buffer while the transport is down rather than burning it on a
    // send that cannot leave; the reconnect watcher flushes it.
    if (!inputTransportReady()) return
    // …but only while it is still plausibly what the user meant to send. A PTY
    // survives an ownerless hour, so without an age bound a buffer typed before
    // a long outage would land minutes later as one burst — every Enter in it
    // included. That is the same failure the refuse-don't-queue rule exists to
    // prevent, arriving by the one path allowed to hold input.
    if (Date.now() - _gatedInputAt > GATED_INPUT_MAX_AGE_MS) {
      _gatedInput = ''
      _gatedInputHuman = false
      return
    }
    const pending = _gatedInput
    const human = _gatedInputHuman
    _gatedInput = ''
    _gatedInputHuman = false
    // A pane that died while preparing has nowhere to replay to; dropping the
    // buffer is the only option left, and sending would clear isStopped for a
    // session that no longer exists.
    if (!sessionId.value || status.value === 'exited' || status.value === 'error') return
    noteUserInput(pending)
    void terminalPort.input(sessionId.value, pending, undefined, human ? { human: true } : undefined)
  }

  // Renderer half of the input round-trip. The pane has no local echo, so the
  // gap between a keystroke leaving here and the PTY's answer arriving IS the
  // latency being reported. The backend measures its own half ("input echo
  // lag"); when the two numbers disagree, the difference is the WebSocket and
  // this renderer — which is exactly the split no log could show before.
  let _keystrokeSentAt = 0
  const ECHO_ROUNDTRIP_WARN_MS = 300
  // Beyond this the output is the CLI thinking, not an echo, so attributing it
  // to the keystroke would only manufacture alarming numbers.
  const ECHO_ROUNDTRIP_MAX_MS = 3000
  // Throttled for the reason above, and more sharply relevant here: sustained
  // lag would otherwise mean one diagnostic per keystroke.
  const _echoDiag = createThrottledDiag(terminalPort, 'echo', 5000)

  /** Input bookkeeping shared by term.onData and the manual-paste path. */
  function noteUserInput(text: string): void {
    if (isStopped.value) { isStopped.value = false; opts?.onUserResume?.() }
    // A clipboard paste is the user putting something in the composer they have
    // not sent yet, so it counts as input for the draft gate exactly like typing.
    lastUserKeyAt.value = Date.now()
    // Only what follows the last CR is still on the current line — without this
    // a pasted "/clear\n" leaves "/clear" behind and the user's NEXT Enter
    // fires onClear again.
    const lastBreak = text.lastIndexOf('\r')
    if (lastBreak >= 0) inputBuffer = ''
    inputBuffer += stripInputSequences(text.slice(lastBreak + 1))
    if (inputBuffer.length > 100) inputBuffer = inputBuffer.slice(-100)
    syncDraft()
  }

  // Wire input/output/exit handlers for the current sessionId. Shared by a fresh
  // spawn and a reattach so both bind identically.
  function bindSessionHandlers(): void {
    inputBuffer = ''
    syncDraft()
    inputDisposer = term.onData((data) => {
      // Before the gates below: a keystroke held back for a preparing pane is
      // still the user typing, and refusing to send one does not make the
      // person at the keyboard go away.
      if (!isTerminalReport(data)) lastUserKeyAt.value = Date.now()
      if (_stdinGated) {
        // Bounded so a pane stuck in preparation cannot grow this forever. Past
        // the cap the oldest keystrokes go, since those are the ones the user
        // has already given up on.
        _gatedInput = (_gatedInput + data).slice(-GATED_INPUT_MAX)
        _gatedInputAt = Date.now()
        if (!isTerminalReport(data)) _gatedInputHuman = true
        return
      }
      // Backstop for the disconnected overlay: refuse rather than queue. The
      // overlay already blocks the pointer, but focus can still be in the
      // terminal when the socket drops mid-keystroke.
      if (!inputTransportReady()) return
      if (data === '\r' || data === '\n' || data === '\r\n') {
        if (isStopped.value) { isStopped.value = false; opts?.onUserResume?.() }
        if (inputBuffer.trim() === '/clear' && opts?.onClear) {
          inputBuffer = ''
          syncDraft()
          opts.onClear()
          return
        }
        inputBuffer = ''
      } else if (data === '\x7f' || data === '\b') {
        inputBuffer = inputBuffer.slice(0, -1)
      } else if (data === '\x03' || data === '\x15' || data === '\x1b') {
        // The three ways a composer is emptied without sending it: Ctrl+C,
        // Ctrl+U, and Escape. Tracked because the draft signal latches
        // otherwise — the line is gone from the CLI's input box while this
        // buffer still holds it, and the pane stays "being typed at" until the
        // user's next Enter.
        inputBuffer = ''
      } else if (data === '\x17') {
        // Ctrl+W deletes back to the previous word boundary rather than
        // clearing, so mirror that instead of emptying the buffer: treating it
        // as a clear would call a still-half-written line finished, which is
        // the failure this whole gate exists to prevent.
        inputBuffer = inputBuffer.replace(/\s*\S+\s*$/, '')
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        if (isStopped.value) { isStopped.value = false; opts?.onUserResume?.() }
        inputBuffer += data
      } else if (data.length > 1) {
        if (isStopped.value) { isStopped.value = false; opts?.onUserResume?.() }
        // Terminal reports ride this same channel and are not typed text.
        // Dropping escape sequences is not enough for the mouse ones: X10
        // encodes the button and coordinates as three PRINTABLE bytes after
        // `ESC[M`, which would land in the buffer as a draft that never clears.
        if (!isTerminalReport(data)) inputBuffer += stripInputSequences(data)
      }
      if (inputBuffer.length > 100) inputBuffer = inputBuffer.slice(-100)
      syncDraft()

      // Only the first keystroke of a burst is timed, for the reason the
      // backend's probe does the same: a fast typist re-arming the clock on
      // every key would never let the lag they are feeling accumulate.
      if (!_keystrokeSentAt && data.length <= 16) _keystrokeSentAt = Date.now()

      // The one path that is the person typing; mouse/focus reports ride the
      // same event and must not read as a human at the keyboard.
      void terminalPort.input(sessionId.value, data, undefined, isTerminalReport(data) ? undefined : { human: true })

      // The public menu narrows from the same onData stream, including IME commits.
      mentionMenu.onData(data)

      // @-mention trigger. Capture the line BEFORE the '@' echoes (onData fires
      // before the PTY round-trips the echo, so readLineBeforeCursor still shows
      // the pre-'@' state). Defer the open one tick so the '@' echoes and the
      // cursor advances first, then position the menu at the new cursor cell.
      if (data === '@' || data === '＠') {
        const candidates = opts?.mentionCandidates?.() ?? []
        if (candidates.length && shouldOpenMentionMenu(data, readLineBeforeCursor())) {
          setTimeout(() => mentionMenu.open(candidates), 0)
        }
      }
    })

    outputUnsub = terminalPort.onOutput((payload) => {
      if (payload.terminal_session_id !== sessionId.value) return
      if (_keystrokeSentAt) {
        const roundTrip = Date.now() - _keystrokeSentAt
        _keystrokeSentAt = 0
        if (roundTrip >= ECHO_ROUNDTRIP_WARN_MS && roundTrip < ECHO_ROUNDTRIP_MAX_MS) {
          _echoDiag(`pane=${paneId} keystroke round-trip ${roundTrip}ms`, 'warning')
        }
      }
      _pendingOutput.push(payload.data)
      if (_ownsTerminalFocus) {
        // The user is typing in this pane — render the echo now.
        _flushPendingOutput()
      } else if (!_outputTimer) {
        _outputTimer = setTimeout(() => _flushPendingOutput(true), _coalesceMs())
      }
    })

    exitUnsub = terminalPort.onExit((payload) => {
      if (payload.terminal_session_id !== sessionId.value) return
      const crashState = activeCrashKey && activeAgentKey && activeAgentKey !== 'terminal'
        ? recordTerminalExit(activeCrashKey, payload)
        : { count: 0, open: false }
      status.value = crashState.open ? 'error' : 'exited'
      error.value = crashState.open
        ? `${formatTerminalExit(payload)}. Automatic rebuild stopped after ${crashState.count} fast crashes.`
        : ''
      rememberSessionId('')  // the PTY is gone — don't try to reattach to it
      // Session ended cleanly — discard its scrollback snapshot so a future
      // pane with the same key doesn't see stale output from a closed session.
      snapshotDiscarded = true
      try { localStorage.removeItem(scrollSnapKey()) } catch {}
      const color = crashState.open ? 31 : 33
      term.writeln(`\r\n\x1b[${color}m[session] ${error.value || formatTerminalExit(payload)}\x1b[0m`)
      cleanupSession()
    })
  }

  // Wait until the container width holds steady for two consecutive frames
  // (bounded ~500ms) so a fit measures the FINAL width, not a mid-grid-reflow
  // transient. Shared by spawn and reattach — sizing a PTY to a transient width
  // leaves the CLI painting narrow (empty space on the right).
  async function settleContainerWidth(): Promise<void> {
    const settleEl = containerRef.value
    if (!settleEl || settleEl.clientWidth === 0) return
    let lastW = -1
    const deadline = performance.now() + 500
    while (performance.now() < deadline) {
      // rAF with a timeout fallback — rAF is throttled (or fully paused) for
      // occluded/background windows and must never stall.
      await new Promise<void>((resolve) => {
        const raf = requestAnimationFrame(() => { clearTimeout(timer); resolve() })
        const timer = setTimeout(() => { cancelAnimationFrame(raf); resolve() }, 100)
      })
      const w = settleEl.clientWidth
      if (w === lastW) break
      lastW = w
    }
  }

  // Reattach-to-live-PTY on reload. The backend does NOT kill PTYs on WS
  // disconnect (output is dropped but the process keeps running). A page reload
  // or HMR cycle disconnects the WS briefly; when the renderer reconnects,
  // tryReattach() finds the alive PTY and rebinds — no --resume round-trip, no
  // conversation reprint. The width-narrow regression (original reason this was
  // disabled) is fixed: we send cols/rows 0 and defer the force_redraw to the
  // reconciler, which fires it only after the container width has settled.
  const REATTACH_ON_RELOAD = true as boolean

  // Try to rebind to a PTY that survived a reload. Returns true if the backend
  // confirms the persisted id is still alive (and we've rebound); false if it's
  // gone, in which case the caller spawns a fresh process.
  // `agentKey` matters when the caller reattaches WITHOUT ever calling spawn()
  // (AiCliDock claims a surviving PTY at mount): spawn() is the only other place
  // that records it, and without it every input-protocol decision — Shift+Enter
  // encoding, forced bracketed paste — degrades to the plain-shell branch.
  async function tryReattach(reattachOpts?: { agentKey?: string }): Promise<boolean> {
    if (!REATTACH_ON_RELOAD) return false
    const prev = persistedSessionId()
    if (!prev) return false
    try {
      // Alive-check + claim the output target only (cols/rows 0 → backend skips
      // force_redraw). The repaint is deferred to the reconciler, which fires it
      // once the width has settled — forcing it now would repaint the live agent
      // at the renderer's transient mid-reflow width (narrow).
      const resp = await terminalPort.reattach([prev], 0, 0)
      if (!resp.ok || !resp.payload || !resp.payload.alive.includes(prev)) {
        rememberSessionId('')  // stale id — fall through to a fresh spawn
        return false
      }
      // Adopt the survivor's real transcript path; '' when it was started
      // without one, and the caller then keeps whatever it derived.
      attachedOutputLogFile.value = resp.payload.logs?.[prev] ?? ''
    } catch {
      return false  // backend unreachable; let the caller decide (it will spawn)
    }
    // PTY is alive. Replay the stored scrollback into this fresh xterm before
    // rebinding, so the pane comes back with its history rather than blank.
    //
    // This used to be skipped, and the reason has expired. The snapshot was raw
    // PTY bytes back then — absolute cursor moves whose coordinates only hold at
    // the width they were recorded at, so replaying them at another width
    // garbled the layout. fab56a5 changed the payload to a SerializeAddon
    // rendering: glyphs and SGR, no cursor positioning, so it can only re-wrap
    // at a new width, never land in the wrong cell. That is the same property
    // the _doCreate replay already relies on, and the `nv1` format marker in
    // loadScrollSnapshot drops any pre-fab56a5 raw snapshot rather than render
    // it. What was left instead was a silent loss: a reattached pane showed only
    // what the CLI repaints on the deferred SIGWINCH — a whole screen for a
    // full-screen TUI, but just the prompt line for a line-mode CLI (aider) or a
    // shell, with the conversation above it simply gone.
    //
    // The live CLI's repaint (deferred to the reconciler, ~2 s) writes over the
    // viewport, so it replaces the snapshot's last screenful and leaves the
    // history above it intact. Ordering matters twice: the write must come
    // BEFORE the mouse-mode reset below (a serialized buffer ends with the modes
    // it captured, mouse tracking and bracketed paste among them) and before
    // bindSessionHandlers, so live output can never interleave into it.
    if (!snapshotReplayed) {
      const snap = loadScrollSnapshot()
      if (snap) {
        snapshotReplayed = true
        term.write(snap)
      }
    }
    // Reset mouse tracking modes so no stale xterm mouse state forwards events
    // to the process's stdin before it has a chance to re-enable what it needs.
    // Bracketed paste is deliberately NOT reset: the PTY is the same live
    // process, so the mode the snapshot restores is the mode it is still in.
    term.write(TERMINAL_MOUSE_MODE_RESET)
    sessionId.value = prev
    status.value = 'running'
    if (reattachOpts?.agentKey) activeAgentKey = reattachOpts.agentKey
    bindSessionHandlers()
    pendingReattachRedraw = true      // reconciler repaints once the width is settled
    resizeCtrl.applyFit()             // start syncing size (no-op while hidden)
    queueMicrotask(() => focus())
    return true
  }

  // Reattach to a PTY that survived a transient network disconnect. Called when
  // the WS reconnects while the pane is already in 'running' state. Uses the
  // same deferred-redraw pattern as tryReattach: cols/rows 0 skips the immediate
  // SIGWINCH; the reconciler fires it once the width has settled.
  async function reattachAfterReconnect(): Promise<void> {
    // 'running' is the only state that owns a PTY: `status` goes starting →
    // running on create and never back, and the idle a user sees is
    // displayStatus, derived from output silence, not a state of its own. A
    // pane still in 'starting' may hold a PREVIOUS session id that its
    // in-flight create is about to replace, so probing on it would reattach to
    // the wrong PTY.
    if (status.value !== 'running' || !sessionId.value) return
    const id = sessionId.value
    try {
      const resp = await terminalPort.reattach([id], 0, 0)
      if (!resp.ok || !resp.payload || !resp.payload.alive.includes(id)) {
        // PTY died while disconnected — mark exited so the user sees it
        status.value = 'exited'
        term.writeln('\r\n\x1b[33m[session ended while disconnected]\x1b[0m')
        rememberSessionId('')
        cleanupSession()
        // The PTY is gone for good (a backend restart kills all of them), but
        // the CLI's own session usually is not: hand the pane to the owner so
        // it can resume that conversation instead of leaving a dead pane.
        opts?.onPtyLostWhileDisconnected?.()
        return
      }
    } catch {
      return // WS not ready yet; the next status-change will retry
    }
    // Reset mouse tracking modes on reconnect for the same reason as tryReattach
    // — and leave bracketed paste alone for the same reason too. This path does
    // not even replay: xterm's view of the mode never stopped being correct.
    term.write(TERMINAL_MOUSE_MODE_RESET)
    cleanupSession()
    bindSessionHandlers()
    pendingReattachRedraw = true
    resizeCtrl.applyFit()
  }

  // When the backend WS reconnects while we have a live session, reattach so
  // output resumes and the TUI repaints at the correct width.
  watch(() => terminalPort.status.value, (newStatus, oldStatus) => {
    if (newStatus === 'connected' && oldStatus !== 'connected') {
      // Held keys go only AFTER the reattach settles. Flushing alongside it
      // raced: reattachAfterReconnect yields at its first await, so a synchronous
      // flush wrote to a PTY this connection had not reclaimed yet — the CLI
      // echoed into a dropped output stream — or, when the PTY had died, wrote
      // to a dead session id and emptied the buffer against a send that could
      // never land. Settling first means the flush sees the real outcome:
      // reclaimed, or exited and correctly discarded.
      void reattachAfterReconnect().then(() => {
        if (!_stdinGated) _flushGatedInput()
      })
    }
  })

  // A pane may be asked to spawn while its tab is hidden (clientWidth 0), where
  // its width can't be measured. We must NOT create the PTY at a guessed width:
  // the CLI's first paint (especially a `--resume` that reprints the whole
  // conversation) would hard-wrap at that wrong width and stay stuck in
  // scrollback. So the opts are parked here and the PTY is created only once the
  // container is genuinely measurable — i.e. when the tab is shown.
  // A ref so displayStatus can reflect a parked (deferred) spawn as idle.
  const pendingSpawn = shallowRef<SpawnOptions | null>(null)
  // Registered here rather than beside onLeftUserPrompt itself: watch() runs its
  // source once to capture the initial value, and displayStatus reads
  // pendingSpawn — which does not exist until this line.
  watch(displayStatus, onLeftUserPrompt)
  let activeCreateGeneration: string | null = null
  let pendingCreateCancel: Promise<boolean> | null = null
  const createCancelRequests = new Map<string, Promise<boolean>>()

  function newCreateGeneration(): string {
    return crypto.randomUUID()
  }

  function requestCreateCancel(generation: string): Promise<boolean> {
    const existing = createCancelRequests.get(generation)
    if (existing) return existing
    const request = terminalPort.cancelCreate(paneId, generation).then((response) => response.ok, () => false)
    createCancelRequests.set(generation, request)
    return request
  }

  async function requireCreateCancel(request: Promise<boolean>): Promise<void> {
    if (!await request) throw new Error('terminal create cancellation failed')
  }

  /** Invalidate the current create locally, then wait for backend rollback. */
  async function cancelPendingCreate(): Promise<void> {
    const generation = activeCreateGeneration
    if (!generation) {
      if (pendingCreateCancel) await requireCreateCancel(pendingCreateCancel)
      return
    }
    activeCreateGeneration = null
    pendingSpawn.value = null
    const request = requestCreateCancel(generation)
    pendingCreateCancel = request
    await requireCreateCancel(request)
    if (pendingCreateCancel === request) pendingCreateCancel = null
  }

  // Create the PTY for a parked spawn, but only when the container has a real,
  // measurable width. Returns silently (leaving it parked) until then; the
  // reconciler / ResizeObserver retry it once the pane is shown.
  function cellWidth(): number {
    return (term as any)._core?._renderService?.dimensions?.css?.cell?.width || 0
  }
  // Guarded entry point: only one create may be in flight. pendingSpawn isn't
  // cleared until after the awaits in _doCreate, so without this the reconciler /
  // ResizeObserver could start a second create for the same pane (two PTYs).
  let _creating = false
  // True only while the terminal.create RPC itself awaits its ack. That request
  // carries its own TERMINAL_CREATE_TIMEOUT_MS deadline and reports its own
  // failure, so the starting watchdog must stand down while it is in flight.
  let createInFlight = false
  async function createWhenMeasurable(): Promise<void> {
    if (_creating || !pendingSpawn.value) return
    _creating = true
    try { await _doCreate() } finally { _creating = false }
  }
  async function _doCreate(): Promise<void> {
    const opts = pendingSpawn.value
    if (!opts) return
    const createGeneration = activeCreateGeneration
    if (!createGeneration) { stallReason.value = 'no-active-generation'; return }
    let el = containerRef.value
    const visible = !!el && el.clientWidth > 0
    // A hidden pane has no measurable width, so the create below would fall back
    // to xterm's 80x24 default and the CLI would draw its first frame that narrow
    // — permanently, since already-printed output never re-wraps wider. Borrow the
    // cached layout size (from a visible terminal, or the previous run) so even a
    // hidden pane starts its PTY at a realistic size; the reconciler still corrects
    // it once the tab is shown.
    if (!visible && _lastKnownCols > 0 && _lastKnownRows > 0) {
      try { term.resize(_lastKnownCols, _lastKnownRows) } catch { /* ignore */ }
    } else if (!visible && opts.isResume) {
      // With no cached size to borrow, a resume must still wait until measurable:
      // it reprints the prior conversation and MUST paint at the real width. A
      // fresh spawn is empty, so it proceeds — deferring it would stall e.g. a
      // pipeline stage spawned into a tab the user isn't currently viewing.
      stallReason.value = 'hidden-resume-no-cached-size'
      return
    }
    if (visible && cellWidth() === 0) {
      // xterm hasn't measured its character cell yet (just opened): poke once to
      // force measurement, then AWAIT it (bounded) so a fresh spawn resolves
      // 'running' and the caller's role-injection flow proceeds. Poking per
      // attempt (not once ever) is what makes a re-parked pane measure again
      // after it was hidden and shown a second time.
      try { term.resize(Math.max(term.cols, 2), Math.max(term.rows, 1)) } catch { /* ignore */ }
      const deadline = performance.now() + 500
      while (cellWidth() === 0 && performance.now() < deadline) {
        await new Promise<void>((resolve) => {
          const raf = requestAnimationFrame(() => { clearTimeout(t); resolve() })
          const t = setTimeout(() => { cancelAnimationFrame(raf); resolve() }, 100)
        })
        el = containerRef.value
        if (opts.isResume && (!el || el.clientWidth === 0)) {  // hidden mid-wait
          stallReason.value = 'hidden-during-measure'
          return
        }
      }
    }
    pendingSpawn.value = null  // claim it so a concurrent retry can't double-create
    if (visible) {
      // Settle the width, then fit, so the create below uses the real size.
      await settleContainerWidth()
      // The tab may have been switched away during the settle. A resume must not
      // create at a hidden/stale width (it would paint narrow) — re-park it.
      el = containerRef.value
      if (opts.isResume && (!el || el.clientWidth === 0 || cellWidth() === 0)) {
        pendingSpawn.value = opts
        stallReason.value = 'reparked-tab-switched'
        return
      }
      try { fit.fit() } catch { /* keep current size */ }
    }
    // Replay stored scrollback into the fresh xterm so prior history is visible
    // before the new PTY starts writing. Only for resume spawns that have a saved
    // snapshot — fresh spawns (no resumeKey) have no snapshot to replay.
    if (opts.resumeKey && opts.restoreMode !== 'fresh' && !snapshotReplayed) {
      // The snapshot is a serialized buffer — glyphs and colours, no cursor
      // positioning — so it renders correctly whatever width this pane now has.
      // It re-wraps; it cannot land in the wrong cell.
      const snap = loadScrollSnapshot()
      if (snap) {
        snapshotReplayed = true
        term.write(snap)
        // Reset any mouse tracking modes the previous session may have enabled.
        // Bracketed paste goes too, and only here: the snapshot just replayed
        // the OLD session's `?2004h`, but the process about to start is a new
        // one that has not asked for it yet.
        term.write(TERMINAL_NEW_PROCESS_RESET)
        term.write(TERMINAL_RECONNECTED_DIVIDER)
      }
    } else if (opts.replayScrollback && !snapshotReplayed) {
      // A handoff from the pane this one replaces (quota-failover restart):
      // the same serialized-buffer format as the stored snapshot, taken from
      // the old xterm right before it was stopped, so the history the user
      // was looking at is the history they keep. Same mode reset, for the
      // same reason. Nothing here goes to the PTY.
      snapshotReplayed = true
      term.write(opts.replayScrollback)
      term.write(TERMINAL_NEW_PROCESS_RESET)
      term.write('\r\n\x1b[2m\x1b[38;5;240m─── account switched ───\x1b[0m\r\n')
    }
    // Only resume spawns are throttled (they are the heavy ones). Acquire before
    // send so the queue-wait is NOT charged against the per-request timeout;
    // released in finally once the ack (or failure) lands. Acquired INSIDE the
    // try so a queue timeout surfaces through the same catch as any other spawn
    // failure — a pane stuck behind a wedged backend must report an error rather
    // than sit in 'starting' having never sent anything. slotHeld (rather than
    // `throttled`) gates the release: a rejected acquire never held a slot, and
    // releasing one we don't own would hand a phantom slot to the next waiter.
    const throttled = !!opts.isResume
    let slotHeld = false
    try {
      if (throttled) {
        await acquireResumeSpawnSlot()
        slotHeld = true
      }
      // The pane may have been cancelled while waiting for the shared resume
      // semaphore. Never send a create for an invalidated generation.
      if (activeCreateGeneration !== createGeneration || isDisposed) return
      stallReason.value = null  // past every silent exit — the create is going out
      createInFlight = true
      const resp = await terminalPort.create({
        paneId,
        createGeneration,
        agentKey: opts.agentKey ?? null,
        command: opts.command,
        cwd: opts.cwd,
        env: opts.env ?? null,
        // Visible panes carry the real, measured width (so a resume's reprint
        // isn't hard-wrapped narrow). A fresh hidden pane has no measured size
        // yet → the 80x24 default; the reconciler corrects it once shown.
        cols: term.cols || 80,
        rows: term.rows || 24,
        metadata: opts.metadata ?? null,
        outputLogFile: opts.outputLogFile ?? null,
        loginProfileId: opts.loginProfileId ?? null,
        isLogin: opts.isLogin ?? false,
        ...(opts.accountDirLogin ? { accountDirLogin: true } : {}),
        replacesTerminalId: replacesPtyId || null,
        quotaTransactionId: opts.quotaTransactionId,
        quotaOriginalPaneId: opts.quotaOriginalPaneId,
      }, TERMINAL_CREATE_TIMEOUT_MS)
      // A cancellation or replacement can land while the RPC is in flight.
      // The backend cancellation owns rollback; a late result must never bind
      // its PTY or overwrite the newer pane state.
      if (isDisposed || activeCreateGeneration !== createGeneration) {
        void requestCreateCancel(createGeneration)
        return
      }
      if (!resp.ok || !resp.payload) {
        activeCreateGeneration = null
        void requestCreateCancel(createGeneration)
        status.value = 'error'
        error.value = resp.error?.message ?? 'spawn failed'
        term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
        const binaryPath = String(resp.error?.details?.binary_path ?? '')
        if (binaryPath && !error.value.includes(binaryPath)) {
          term.writeln(`\x1b[31m[binary] ${binaryPath}\x1b[0m`)
        }
        return
      }
      activeCreateGeneration = null
      startingStartedAt.value = null
      sessionId.value = resp.payload.terminal_session_id
      rememberSessionId(sessionId.value)  // enable reattach after a reload
      resumeSpawnedAt.value = opts.isResume ? Date.now() : 0
      status.value = 'running'
      const probe = resp.payload.startup_probe
      if (probe?.binary_path) {
        const version = probe.version ? ` v${probe.version}` : ''
        const duration = typeof probe.duration_ms === 'number' ? `, ${probe.duration_ms}ms` : ''
        term.writeln(`\x1b[2m[startup probe] ${probe.binary_path}${version}${duration}\x1b[0m`)
      }
      for (const warning of resp.payload.wiring_warnings ?? []) {
        term.writeln(`\x1b[33m[mcp] ${warning}\x1b[0m`)
      }
      resizeCtrl.applyFit()  // sync the real size to the backend on first paint
      // The width measured above can still be a mid-layout snapshot (e.g. this
      // spawn's own pane is still settling into a freshly reflowed grid) that
      // differs from the width the container settles at moments later. Any
      // banner/output the CLI already drew at the wrong width won't reflow on
      // its own — request the same gated (width-stable + CLI-quiet + once) SIGWINCH
      // repaint the ResizeObserver path uses, so a stale narrow first frame gets
      // corrected instead of stranded.
      resizeCtrl.requestResizeRedraw()
      // The fit above can still have captured a pre-settle width — re-check
      // after the layout truly settles (see scheduleFreshSpawnRefit).
      scheduleFreshSpawnRefit()
      queueMicrotask(() => focus())
      bindSessionHandlers()
    } catch (err) {
      if (activeCreateGeneration !== createGeneration) return
      // Throttled yet holding no slot can only mean acquireResumeSpawnSlot
      // rejected: this pane never reached terminal.create at all.
      if (throttled && !slotHeld) stallReason.value = 'resume-queue-timeout'
      activeCreateGeneration = null
      void requestCreateCancel(createGeneration)
      status.value = 'error'
      error.value = String((err as Error).message ?? err)
      term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
    } finally {
      createInFlight = false
      if (slotHeld) releaseResumeSpawnSlot()
    }
  }

  // A spawn measures its width once right before terminal.create
  // (settleContainerWidth only waits for 2-frame stability), so a pane spawned
  // into a still-reflowing layout (e.g. a new tab maximizing over the previous
  // multi-pane grid) can pin the PTY, xterm, AND the acked size to the same
  // pre-settle width — every recovery net then sees a consistent (but wrong)
  // size and no-ops. Re-check shortly after the create: if the container now
  // fits to a different size, re-run the normal gated fit + redraw path.
  // Idempotent — when the fitted size already matches xterm, it does nothing.
  let freshSpawnRefitTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleFreshSpawnRefit(): void {
    const attempt = (): void => {
      if (isDisposed || !sessionId.value) return
      const dims = fit.proposeDimensions()
      // Hidden/unmeasurable panes yield no finite dims — the reconciler owns those.
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
      if (resizeCtrl.capCols(dims.cols) === term.cols && dims.rows === term.rows) return
      resizeCtrl.applyFit()
      resizeCtrl.requestResizeRedraw()
    }
    // Two frames let the in-flight layout reflow commit; the timer retry covers
    // a slower settle and rAF throttling in occluded/background windows.
    requestAnimationFrame(() => requestAnimationFrame(attempt))
    freshSpawnRefitTimer = setTimeout(() => { freshSpawnRefitTimer = null; attempt() }, 350)
  }

  // Last resort for a pane that entered 'starting' and then went permanently
  // silent. The only way out of 'starting' is terminal.create's ack, so a create
  // that neither acks nor errors — or one that was never sent because _doCreate
  // took a silent exit nothing retried — strands the pane with no status change,
  // no error and no output. This turns that into a stated failure.
  //
  // It reports ONLY. _creating exists because a second create for the same pane
  // means two PTYs, and from out here we cannot know whether the first one is
  // truly dead; recovery stays a user action (Respawn).
  //
  // Every guard below is load-bearing:
  //  - pendingSpawn set means a resume is parked waiting for its hidden tab to
  //    be shown. Waiting indefinitely is the DESIGN there, not a stall.
  //  - createInFlight means the RPC owns the deadline and will report for itself.
  //  - _creating means _doCreate is mid-flight but has not reached the send yet
  //    — most of that window is the resume queue wait, which a pane unparked
  //    long after it entered 'starting' enters with its age already past the
  //    threshold. Without this guard an All-CLI restore prints a spurious error
  //    (naming the PREVIOUS park's stallReason) at a pane that then goes on to
  //    spawn fine. Not a blind spot: _doCreate is bounded by the 45s queue
  //    timeout and the 30s RPC timeout, both of which report for themselves.
  //  - the age is past both that deadline and the resume queue timeout, so
  //    whichever of those is the real cause gets to report first.
  const STARTING_WATCHDOG_MS = 60_000
  let startingWatchdogTimer: ReturnType<typeof setInterval> | null = null
  function stopStartingWatchdog(): void {
    if (startingWatchdogTimer === null) return
    clearInterval(startingWatchdogTimer)
    startingWatchdogTimer = null
  }
  function checkStartingStall(): void {
    if (status.value !== 'starting') { stopStartingWatchdog(); return }
    // Re-evaluated every tick rather than once at arm time: a pane can be
    // re-parked, or start its create, long after it entered 'starting'.
    if (pendingSpawn.value || createInFlight || _creating) return
    const startedAt = startingStartedAt.value
    if (startedAt === null || Date.now() - startedAt < STARTING_WATCHDOG_MS) return
    stopStartingWatchdog()
    status.value = 'error'
    error.value = `startup stalled before terminal.create (${stallReason.value ?? 'unknown'})`
    term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
  }
  watch(status, (next) => {
    if (next !== 'starting') { stopStartingWatchdog(); return }
    if (startingWatchdogTimer === null) {
      startingWatchdogTimer = setInterval(checkStartingStall, 5_000)
    }
  })

  // Assign here — after createWhenMeasurable is defined — so all callbacks
  // close over the fully-initialized functions. The declaration is hoisted
  // above the reconciler interval so async closures can reference it safely.
  resizeCtrl = createResizeController(
    term,
    fit,
    sessionId,
    containerRef,
    lastRawActivityAt,
    (sessionId, cols, rows) => terminalPort.resize(sessionId, cols, rows),
    (sessionId, cols, rows) => terminalPort.redraw(sessionId, cols, rows),
    () => !!pendingSpawn.value,
    () => { void createWhenMeasurable() },
  )

  // Shared zoom → this pane. A new font size means a new cell size, so refit to
  // recompute cols/rows and resync the PTY — that keeps the content filling the pane.
  //
  // Scrollback written before the zoom is NOT re-flowed: agent CLIs hard-wrap their own
  // output (standalone short lines, isWrapped=false), so xterm cannot re-wrap it into
  // the new grid. SIGWINCH redraws the current screen; font-only changes intentionally
  // do not auto-resume the CLI to reprint history.
  watch(terminalFontSize, (size) => {
    term.options.fontSize = size
    resizeCtrl.applyFit()
    // The container's CSS size does not change when only the xterm cell size
    // changes, so ResizeObserver may stay silent. Redraw after settlement.
    resizeCtrl.requestResizeRedraw()
  })

  async function spawn(opts: SpawnOptions): Promise<void> {
    if (status.value === 'starting' || status.value === 'running') {
      throw new Error('terminal already running')
    }
    isStopped.value = false
    runningLatched.value = false
    turnCompleteAt.value = 0
    // A rebuild/respawn out of AWAITING must not carry the old session's
    // prompt into the new one: the composable outlives the PTY, so a stale
    // timestamp here would show the fresh pane as parked on a question that
    // no longer exists.
    awaitingInputAt.value = 0
    questionAt.value = 0
    deliveredPendingCount.value = 0
    // A new process has none of the old one's background tasks.
    backgroundTaskIds.value = new Map()
    endedBackgroundTaskIds.clear()
    error.value = ''
    stallReason.value = null  // a retry must not inherit the last attempt's exit
    status.value = 'starting'
    startingStartedAt.value = Date.now()
    const createGeneration = newCreateGeneration()
    activeCreateGeneration = createGeneration
    activeAgentKey = opts.agentKey
    activeCrashKey = terminalCrashKey({
      agentKey: opts.agentKey,
      cwd: opts.cwd,
      resumeKey: opts.resumeKey,
      command: opts.command,
    })
    if (opts.isResume && isTerminalCrashLoopOpen(activeCrashKey)) {
      activeCreateGeneration = null
      startingStartedAt.value = null
      status.value = 'error'
      error.value = 'Automatic rebuild stopped after 3 fast crashes. Use Respawn after fixing the CLI.'
      term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
      return
    }
    lastCommand.value = Array.isArray(opts.command) ? opts.command.join(' ') : opts.command
    // Use the stable CLI session id as the reattach key when provided, so the
    // lookup below survives a reload (paneId does not).
    if (opts.resumeKey) persistKey = opts.resumeKey
    // Snapshot the pane's previous PTY id NOW — tryReattach clears it when the
    // PTY is gone. Passed to terminal.create as replaces_terminal_id so the
    // backend reaps a still-live predecessor this spawn is replacing (resume-id
    // dedup can't: the id rotates on every resume, so it never matches).
    replacesPtyId = persistedSessionId()
    // True persistence: a PTY from before a reload may still be running. Reattach
    // to it (recovering bash/build panes too, with no --resume round-trip) before
    // spawning anew. Falls through to a fresh spawn if the PTY is gone.
    if (!opts.skipReattach && await tryReattach()) {
      if (activeCreateGeneration === createGeneration) activeCreateGeneration = null
      startingStartedAt.value = null
      return
    }
    if (activeCreateGeneration !== createGeneration || isDisposed) return
    // Park the spawn and create the PTY only once the container is measurable, so
    // the CLI paints at the real width. Visible panes create immediately; a
    // hidden-tab pane creates when its tab is first shown (reconciler/observer).
    pendingSpawn.value = opts
    await createWhenMeasurable()
  }

  /** Returns false when nothing was sent, so a caller staging a paste in parts
   *  can stop rather than send the tail on its own — an Enter that arrives
   *  without the text it was meant to submit is its own kind of wrong. */
  function pasteText(text: string, opts?: TerminalInputOptions): boolean {
    if (!sessionId.value || status.value === 'exited' || status.value === 'error') return false
    if (!inputTransportReady()) return false
    void terminalPort.input(sessionId.value, text, undefined, opts)
    return true
  }

  /**
   * pasteText, but the caller can tell whether the write actually left.
   *
   * Rejects on the three ways a chunk goes missing: the session disappeared
   * mid-paste, the transport refused it (a full send queue or a timeout, both
   * of which reject), or the backend answered `ok: false` — which wsClient
   * resolves rather than rejects, so it has to be checked here.
   */
  function _sendPasteChunk(text: string, opts?: TerminalInputOptions): Promise<PasteChunkFailure | null> {
    if (!sessionId.value || status.value === 'exited' || status.value === 'error') {
      return Promise.resolve('transport')
    }
    if (!inputTransportReady()) {
      return Promise.resolve('transport')
    }
    return terminalPort.input(sessionId.value, text, PASTE_ACK_TIMEOUT_MS, opts)
      .then((reply) => {
        if (reply && typeof reply === 'object' && (reply as { ok?: unknown }).ok === false) {
          return 'refused' as const
        }
        return null
      })
      .catch(() => {
        // Everything wsClient rejects with lands here, and the two cases are
        // not the same news. A closed socket means the bytes never left; a
        // deadline that expired on a socket that is still up means only that
        // the ack is late — the backend writes to the PTY before it answers,
        // so the paste is in the CLI's input either way.
        return inputTransportReady() ? ('timeout' as const) : ('transport' as const)
      })
  }

  /**
   * Send clipboard text the way programmatic injection already does.
   *
   * xterm's built-in paste writes the whole clipboard in one call and decides
   * on bracketing from ITS view of DEC mode 2004. That view used to be wrong in
   * exactly the case that hurts most: reattaching reset the mode behind xterm's
   * back while the CLI on the other end was still in bracketed paste, so an
   * unbracketed multi-line paste reached it as one Enter per line — the first
   * line submits, the rest spill into the next prompt. That is the "paste gets
   * cut off" report, and the reset that caused it is gone from the live-PTY
   * paths (see TERMINAL_MOUSE_MODE_RESET), so xterm's view is now trustworthy there.
   *
   * The agent fallback below stays as a belt-and-braces for the one path that
   * still resets — a resume spawn — and for a CLI that enabled the mode before
   * this pane was watching. It is limited to multi-line text on purpose: only
   * multi-line text can be split by stray Enters, and wrapping a single line
   * for a shell that never asked would show it a literal "[200~".
   *
   * Chunking at 512 bytes is the same thing App.vue's injectText does, to keep
   * large pastes off the tty's write limits.
   *
   * Resolves true once every chunk is acked as written; false when anything
   * was dropped, refused or is still un-acked at the deadline.
   */
  function pasteFromClipboard(text: string): Promise<boolean> {
    // Both rejections below are silent by design, and that is what made "the
    // paste vanished" unanswerable: an empty clipboard (a copy that never
    // landed — see the Cmd+C path above and menu.ts) and a still-preparing
    // pane look identical from the outside. Split them so the log says which.
    if (!text) {
      // Reached from ⌘V on an empty clipboard and from a file drop that
      // resolved no paths, so the wording stays neutral about the source.
      _clipboardFailure(
        `pane=${paneId} paste ignored — no text to send`,
        'empty'
      )
      return Promise.resolve(false)
    }
    // The pane gates stdin while it is still preparing, and a paste respects
    // that too. Rejected rather than buffered: a clipboard paste is a discrete
    // action the user can simply repeat once the pane is ready, unlike typing.
    if (_stdinGated) {
      _clipboardFailure(
        `pane=${paneId} paste dropped — pane still preparing (${text.length} chars discarded)`,
        'preparing',
        text.length
      )
      return Promise.resolve(false)
    }
    // Same gate pasteText applies. Checked up front so a paste into a dead pane
    // cannot clear `isStopped` (and fire onUserResume) while sending nothing.
    if (!sessionId.value || status.value === 'exited' || status.value === 'error') {
      _clipboardFailure(
        `pane=${paneId} paste dropped — pane is ${status.value || 'unspawned'} (${text.length} chars discarded)`,
        'no-session',
        text.length
      )
      return Promise.resolve(false)
    }
    // Same normalization xterm applies: a PTY expects CR, never CRLF/LF.
    const normalized = text.replace(/\r?\n/g, '\r')
    // Bracket when xterm knows the CLI asked for it, and — only for text that
    // actually spans lines — when the agent is known to keep the mode on. That
    // second case is the reattach hole this exists for; restricting it to
    // multi-line text keeps a single-line paste on xterm's own judgement, so a
    // sub-shell that never enabled mode 2004 cannot receive a literal "[200~".
    const bracketed = isBracketedPasteActive() ||
      (normalized.includes('\r') && agentUsesBracketedPaste(agentProfile(activeAgentKey)))
    const payload = bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized
    // The rest of what term.onData would have done for us (CoreService's
    // _onUserInput plus this composable's own input bookkeeping).
    noteUserInput(normalized)
    // Sent as one burst rather than awaited chunk by chunk: wsClient writes in
    // call order, so the PTY still receives them in sequence, and a large paste
    // does not pay a round trip per 512 bytes. Awaiting the settled results is
    // what makes a lost chunk visible at all — the send queue rejects once it
    // is full and every request carries its own timeout, either of which used
    // to leave a paste truncated in the middle with nothing said. Nothing to
    // retry from here: the bytes that did land are already in the CLI's input,
    // so re-sending would duplicate them. Say so and let the user decide.
    const chunks = chunkForPty(payload, PASTE_CHUNK)
    // ⌘V and a file drop are the person at the keyboard; injection never
    // comes through here (App.vue's injectText has its own path).
    const written = Promise.all(chunks.map((chunk) => _sendPasteChunk(chunk, HUMAN_KEY))).then((outcomes) => {
      const lost = outcomes.filter((o) => o === 'transport' || o === 'refused').length
      const late = outcomes.filter((o) => o === 'timeout').length
      // A late ack is not a lost chunk: the backend writes the bytes into the
      // PTY in the handler's first line and only then queues its answer behind
      // whatever output is saturating the socket. Telling the user their paste
      // vanished when it did not is the worse error of the two, so this is
      // logged for the record and left off the screen.
      if (late && !lost) {
        _clipboardDiag(
          `pane=${paneId} paste ack late — ${late}/${chunks.length} chunk(s) ` +
          `un-acked after ${PASTE_ACK_TIMEOUT_MS}ms (bytes were written)`,
          'warning'
        )
        return false
      }
      if (!lost) return true
      _clipboardFailure(
        `pane=${paneId} paste truncated — ${lost}/${chunks.length} chunk(s) never left` +
        (late ? ` (${late} more un-acked)` : ''),
        lost === chunks.length ? 'send-failed-all' : 'send-failed',
        normalized.length
      )
      return false
    })
    term.scrollToBottom()
    term.clearSelection()
    return written
  }

  /**
   * pasteFromClipboard for text that exists nowhere else (voice dictation):
   * false, with nothing sent, when the paste would be dropped — the pane is
   * still preparing, has no live session, or the transport is down — so the
   * caller can keep the text instead of losing it.
   *
   * `submit` then presses Enter for the user, once every chunk of the paste is
   * acked and SUBMIT_AFTER_PASTE_MS has passed — so the CR arrives after the
   * bracketed-paste end, never inside it. A paste that lost a chunk, or is
   * not fully acked within SUBMIT_ACK_WAIT_MS, is left in the input box
   * unsent. `onSubmit` hears which of the two happened.
   */
  function insertText(
    text: string,
    { submit = false, onSubmit }: { submit?: boolean; onSubmit?: (sent: boolean) => void } = {}
  ): boolean {
    if (!text || _stdinGated || !inputTransportReady()) return false
    if (!sessionId.value || status.value === 'exited' || status.value === 'error') return false
    const written = pasteFromClipboard(text)
    if (submit) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), SUBMIT_ACK_WAIT_MS) })
      void Promise.race([written, late]).then((ok) => {
        clearTimeout(timer)
        if (!ok) {
          onSubmit?.(false)
          return
        }
        setTimeout(() => onSubmit?.(submitAsTyped()), SUBMIT_AFTER_PASTE_MS)
      })
    }
    return true
  }

  /** The Enter a person would type: the same bytes and bookkeeping as a CR
   *  through term.onData, sent as human input. False when it could not go. */
  function submitAsTyped(): boolean {
    if (_stdinGated || isDisposed) return false
    if (!pasteText('\r', HUMAN_KEY)) return false
    if (isStopped.value) { isStopped.value = false; opts?.onUserResume?.() }
    inputBuffer = ''
    syncDraft()
    return true
  }

  /** Returns whether the interrupt was actually issued. The two early exits
   *  below are silent no-ops, and STOP pressed by hand does not care — but
   *  ui.pane.interrupt reports this to an MCP caller that has no other way to
   *  learn its interrupt went nowhere, and "the window was reconnecting" reads
   *  exactly like "the agent ignored me" without it. True still means only
   *  that the backend accepted the request: it writes to the PTY and answers,
   *  and a write that fails there is logged, not reported back. */
  async function interrupt(): Promise<boolean> {
    if (!sessionId.value) return false
    // Guarded like every other user input, and for the sharpest case of it: a
    // frozen-looking pane is exactly when someone hits STOP, so a queued SIGINT
    // would land on whatever turn the CLI happens to be running once the socket
    // returns — possibly one started after the reconnect. The flag is set only
    // once the request is on its way, so the STOP badge cannot advertise an
    // interrupt that never left.
    if (!inputTransportReady()) return false
    isStopped.value = true
    const reply = await terminalPort.interrupt(sessionId.value)
    // wsClient resolves an `ok: false` rather than rejecting it, so a refusal
    // has to be read off the reply the way _sendPasteChunk reads it.
    return !(reply && typeof reply === 'object' && (reply as { ok?: unknown }).ok === false)
  }

  async function kill(opts?: { force?: boolean; retireRestore?: boolean }): Promise<void> {
    if (!sessionId.value) return
    const killedId = sessionId.value
    rememberSessionId('')  // explicit kill — never reattach to this PTY
    const force = opts?.force ?? false
    // Only an explicit Stop carries the flag; every other kill stays two-argument.
    const reply = opts?.retireRestore
      ? await terminalPort.kill(killedId, force, { retireRestore: true })
      : await terminalPort.kill(killedId, force)
    // wsClient resolves an `ok: false` rather than rejecting it (see interrupt).
    // A refused kill left the PTY running, so it must not read as done: keep the
    // id the pane still owns and let the caller sweep.
    if (reply && typeof reply === 'object' && (reply as { ok?: unknown }).ok === false) {
      rememberSessionId(killedId)
      const error = (reply as { error?: unknown }).error
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : error
      throw new Error(`terminal kill refused: ${String(code ?? 'unknown')}`)
    }
  }

  // Pin this pane's width at its current column count, so a layout mode that
  // hands it the whole stage leaves the extra space blank instead of widening
  // the terminal. Switching back then needs no resize, which is what keeps
  // xterm from reflowing (and permanently garbling) the scrollback. Passing
  // false lifts the cap and lets the next fit use the full container.
  function lockCols(locked: boolean): void {
    resizeCtrl.setColsCap(locked ? term.cols : null)
  }

  function fitTerminal(opts?: { redrawAfterSettle?: boolean }): void {
    if (!mounted) return
    resizeCtrl.applyFit()
    // Explicit refit paths (layout-mode switch, tab/minimize toggles, window
    // resize safety net) exist because the ResizeObserver is unreliable while
    // the pane is hidden/occluded — so when a caller opts in, arm the same
    // gated once-per-settle redraw the observer path uses. Default (no flag)
    // keeps spawn/reconciler call sites byte-for-byte unchanged.
    if (opts?.redrawAfterSettle) {
      resizeCtrl.requestResizeRedraw()
    }
  }

  /**
   * WARNING: `redraw()` should ONLY be used for manually triggered "redraw / clear screen"
   * actions by the user. Do NOT hook this into automatic resize/layout pathways (like window
   * resizes or layout mode changes). For automatic resizing, always use `fitTerminal`
   * instead, which correctly handles PTY dimensions and scrollback preservation.
   *
   * Ask the CLI to repaint its current frame by sending a SIGWINCH (via terminal.redraw).
   * We used to send Ctrl+L, but while Claude Code repaints properly, pure shells (bash/zsh)
   * interpret Ctrl+L as "clear screen", which visually wipes the scrollback.
   * We deliberately do NOT call term.clear() here. Letting the CLI repaint via SIGWINCH
   * keeps the scrollback intact and scrollable for both TUI apps and pure shells.
   */
  function redraw(): void {
    if (!sessionId.value) return
    void terminalPort.redraw(sessionId.value, term.cols, term.rows)
  }

  // Hard reset: drop the entire scrollback (including any corrupt frames frozen
  // there from a pre-fix resize, which the CLI can never repaint over), then
  // Ctrl+L so the CLI redraws its current frame into the cleared viewport.
  // Unlike redraw(), this DOES wipe history — it is an explicit, separately
  // labelled action, not the gentle refresh.
  function clearScrollback(): void {
    term.clear()
    pasteText('\x0c')
  }

  function updateXtermTheme(): void {
    term.options.theme = readXtermTheme()
  }

  function cleanupSession(): void {
    inputDisposer?.dispose()
    inputDisposer = null
    outputUnsub?.()
    outputUnsub = null
    exitUnsub?.()
    exitUnsub = null
    // Flush any coalesced output that hadn't been written yet. The snapshot is
    // read straight off xterm's buffer at teardown, so there is no separate
    // buffer to keep in step here; the exit handler sets snapshotDiscarded when
    // this session's scrollback must not be persisted at all.
    if (_outputTimer) { clearTimeout(_outputTimer); _outputTimer = null }
    if (_pendingOutput.length) {
      for (const chunk of _pendingOutput) term.write(chunk)
      _pendingOutput = []
    }
    // Chunks that DID reach xterm must reach cleanBuffer too before the
    // decoder below is reset, or the session's tail is lost to every reader.
    flushPendingClean()
    // Drop any partial-character state so it cannot bleed into a new session.
    _cleanDecoder = new TextDecoder('utf-8')
  }

  onScopeDispose(() => {
    isDisposed = true
    void cancelPendingCreate().catch(() => {})
    saveScrollSnapshot()  // persist scrollback before the pane is torn down
    _liveTerminals.delete(_snapshotHooks)  // stop answering app-exit saves / key rotations
    cleanupSession()
    clearInterval(tickInterval)
    clearInterval(reconcileInterval)
    detachWebgl()
    stopStartingWatchdog()
    if (freshSpawnRefitTimer) clearTimeout(freshSpawnRefitTimer)
    if (_hintTimer) clearTimeout(_hintTimer)
    resizeCtrl.dispose()
    if (mountedEl && _mousedownHandler) mountedEl.removeEventListener('mousedown', _mousedownHandler)
    if (_cmdKeyDown) window.removeEventListener('keydown', _cmdKeyDown)
    if (_cmdKeyUp) window.removeEventListener('keyup', _cmdKeyUp)
    if (mountedEl && _mousePosTracker) mountedEl.removeEventListener('mousemove', _mousePosTracker)
    if (mountedEl && _cmdClickHandler) mountedEl.removeEventListener('mousedown', _cmdClickHandler, { capture: true })
    _linkProviderDisposer?.()
    _linkProviderDisposer = null
    if (mountedEl && _pasteHandler) mountedEl.removeEventListener('paste', _pasteHandler, true)
    _selectionDisposer.dispose()
    _cancelSelectionPush()
    if (_focusOwner === term) {
      _focusOwner = null
      _emptyCopyReporter = undefined
      _reportSelection('') // a disposed pane must not keep answering Copy
    }
    _filePickerCloser?.()
    _filePickerCloser = null
    mentionMenu.close()  // tear down any open @-mention menu (detaches doc listeners)
    term.textarea?.removeEventListener('focus', _onTermFocus)
    term.textarea?.removeEventListener('blur', _onTermBlur)
    window.removeEventListener('focus', _onWindowFocus)
    term.textarea?.removeEventListener('compositionstart', _onCompositionStart)
    term.textarea?.removeEventListener('compositionend', _onCompositionEnd)
    // A pane disposed while focused never fires blur — clear the context so
    // `terminalFocus` cannot stay stuck on. Cleared directly rather than through
    // _onTermBlur(), which defers to the window-focus path when the whole window
    // is unfocused — and the listener that would have completed the handoff was
    // just removed above, so the context would stay stuck on for good.
    if (_ownsTerminalFocus) {
      _ownsTerminalFocus = false
      _blurredWithWindow = false
      setContext('terminalFocus', false)
    }
    term.dispose()
    // PTY is intentionally NOT killed here. The backend keeps PTYs running
    // after a WS disconnect so that tryReattach() can rebind after a page
    // reload or HMR cycle. Explicit kills are handled by kill() (user-initiated
    // pane removal). The backend terminates all PTYs when the app quits
    // (backend process exit). The persisted session id is kept so that
    // tryReattach() can locate the alive PTY on the next mount.
  })

  return {
    mount,
    spawn,
    serializeScrollback,
    tryReattach,
    attachedOutputLogFile,
    interrupt,
    kill,
    focus,
    fitTerminal,
    lockCols,
    redraw,
    pasteText,
    pasteFromClipboard,
    insertText,
    status,
    displayStatus,
    awaitingKind,
    startingStartedAt,
    startingAgeMs,
    stallReason,
    cancelPendingCreate,
    isStopped,
    sessionId,
    error,
    lastCommand,
    cleanBuffer,
    cleanBytesSeen,
    resumeSpawnedAt,
    lastActivityAt,
    lastRawActivityAt,
    hasDraft,
    lastUserKeyAt,
    isBracketedPasteActive,
    markTurnComplete,
    markNeedsInput,
    clearNeedsInput,
    markQuestion,
    clearQuestion,
    markDeliveredPending,
    clearDeliveredPending,
    noteBackgroundTasks,
    markBufferPosition,
    recleanBuffer,
    flushPendingClean,
    readRenderedText,
    readScreenTail,
    readLineBeforeCursor,
    updateXtermTheme,
    isAltBuffer,
    /** 'webgl' once the GPU renderer actually attached, 'dom' otherwise. The
     *  addon reports its own failures asynchronously, so this is the only
     *  reliable signal of which renderer a pane really ended up on. */
    rendererKind,
    optionSelectHint,
    getSelection: () => term.getSelection(),
    setDisableStdin: (disabled: boolean) => {
      if (_stdinGated === disabled) return
      _stdinGated = disabled
      if (!disabled) _flushGatedInput()
    },
  }
}
