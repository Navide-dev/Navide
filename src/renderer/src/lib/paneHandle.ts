// What App.vue may read and call on any CLI pane, terminal or ACP.
//
// App.vue keeps one ref per pane (paneRefs) and drives every pane through it:
// status badges, the messaging gate, kill/interrupt, stuck and reclaim checks,
// the stage watcher. A terminal pane (TerminalPane) exposes this from its
// useTerminal composable; an ACP pane (AcpPane, no PTY) exposes the same shape
// from its ACP session, so most of App.vue works on either without branching.
//
// Members only a terminal can have — reading the rendered screen, fitting
// columns — are optional here: an ACP pane has no screen, and leaving them
// undefined makes every screen watcher skip it (callers use `?.`), where a
// stub returning '' would let one decide something from an empty screen.
// Design: navide-devmap-mockups/planb/0229/INVENTORY-acp-pty-assumptions.md.

import type { ComputedRef, ShallowUnwrapRef } from 'vue'
import type { DisplayStatus, useTerminal } from '@navide/terminal'

type TerminalApi = ReturnType<typeof useTerminal>

/** Every pane provides these. */
export type PaneHandleRequiredKey =
  | 'spawn' | 'interrupt' | 'kill' | 'focus'
  | 'status' | 'awaitingKind' | 'startingStartedAt' | 'startingAgeMs' | 'cancelPendingCreate'
  | 'sessionId' | 'attachedOutputLogFile' | 'error' | 'lastCommand'
  | 'cleanBuffer' | 'cleanBytesSeen' | 'resumeSpawnedAt' | 'lastActivityAt' | 'lastRawActivityAt'
  | 'hasDraft' | 'lastUserKeyAt' | 'isBracketedPasteActive' | 'insertText'
  | 'markTurnComplete' | 'markNeedsInput' | 'clearNeedsInput' | 'holdNeedsInput'
  | 'releaseNeedsInputHold' | 'awaitingHeld' | 'noteAnswerKeys' | 'permissionWaitLive'
  | 'markQuestion' | 'clearQuestion' | 'markDeliveredPending' | 'clearDeliveredPending'
  | 'noteBackgroundTasks' | 'hasLiveBackgroundTasks'
  | 'markBufferPosition' | 'recleanBuffer' | 'flushPendingClean' | 'readRenderedText'
  | 'serializeScrollback'

/** Only a terminal pane has these (a rendered screen, xterm columns). */
export type PaneHandleScreenKey =
  | 'readScreenTail' | 'readVisibleScreen' | 'readLineBeforeCursor'
  | 'fitTerminal' | 'lockCols' | 'isColsCapped' | 'unlockCols' | 'redraw'

export type PaneDisplay = 'tui' | 'acp'

/** What a pane component passes to defineExpose. */
export type PaneHandleSource =
  & Pick<TerminalApi, PaneHandleRequiredKey>
  & Partial<Pick<TerminalApi, PaneHandleScreenKey>>
  & {
    displayStatus: ComputedRef<DisplayStatus>
    /** STOP badge: App.vue owns persistence and reflects it into the pane. */
    setStopped: (stopped: boolean) => void
    /** Which kind of pane this is: a PTY running the CLI's own TUI, or an ACP session. */
    display: PaneDisplay
    /** ACP panes only: hand a message (an envelope the messaging layer
     *  rendered) to the agent as a prompt through the backend (acp.prompt).
     *  true: the backend took it (sent, or queued behind the running turn).
     *  false: refused. null: no session yet, try again later. */
    sendPrompt?: (text: string) => Promise<boolean | null>
  }

/** A pane ref as App.vue sees it (refs unwrapped, as on a component instance). */
export type PaneHandle = ShallowUnwrapRef<PaneHandleSource>
