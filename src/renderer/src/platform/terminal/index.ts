/// <reference path="./env.d.ts" />

export {
  agentUsesBracketedPaste,
  encodeShiftEnter,
  migrateTerminalPtyKey,
  saveAllScrollSnapshots,
  stripAltScreenEnter,
  useTerminal,
} from './composables/useTerminal'
export type {
  ClipboardFailureReason,
  DisplayStatus,
  SpawnOptions,
  TerminalAgentProfile,
  TerminalAgentProfileResolver,
  TerminalStatus,
} from './composables/useTerminal'

export { collapseHomePath } from './lib/paths'

export {
  DEFAULT_FONT_SIZE,
  installTerminalZoomShortcuts,
  terminalFontSize,
  zoomIn,
  zoomOut,
  zoomReset,
} from './composables/useTerminalFontSize'

export { createResizeController } from './composables/useTerminalResize'
export type { ResizeController } from './composables/useTerminalResize'

export { findConsecutiveQuestionBlocks, findScreenSentinel, findSentinel } from './lib/buffer'

export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildCliPaneBufferReply,
  buildExternalPaneContextPaste,
  buildMentionInsert,
  buildPaneContextPaste,
  buildPaneStatusReply,
  CLI_CHIP_LINE_CAP,
  CLI_CONTEXT_MIME,
  CLI_PASTE_LINE_CAP,
  injectionChunks,
  MENTION_BROADCAST_ADDRESS,
  clusterMentionCandidates,
  rankMentionCandidates,
  recordMentionRecents,
  resolveCliDropSources,
  screenToClientPoint,
  shouldMentionOnDrop,
  writeCliPaneDragPayload,
  PANE_BATCH_MIME,
  PANE_ID_MIME,
} from './lib/cliContext'
export type { CliContextPayload, CliPaneBufferReply, CliSessionContext, MentionCandidate, PaneStatusReply } from './lib/cliContext'

export { diagLog } from './lib/diagLog'
export type { DiagnosticPort } from './lib/diagLog'

export {
  clampResumeConcurrency,
  DEFAULT_RESUME_CONCURRENCY,
  MAX_RESUME_CONCURRENCY,
  MIN_RESUME_CONCURRENCY,
  RESUME_CONCURRENCY_SETTING_KEY,
} from './lib/resumeConcurrency'

export {
  formatTerminalExit,
  isTerminalCrashLoopOpen,
  recordTerminalExit,
  resetTerminalCrashLoop,
  terminalCrashKey,
  STATUS_CONTROL_C_EXIT,
  TERMINAL_CREATE_TIMEOUT_MS,
} from './lib/terminalLifecycle'
export type { CrashLoopState, TerminalExitDetails, TerminalStartupProbe } from './lib/terminalLifecycle'

export {
  TERMINAL_DOCK_KEY,
} from './ports/terminalDock'
export type {
  DockAgentMessage,
  DockPaneRegistration,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDockPort,
  TerminalExitEvent,
  TerminalFileListResult,
  TerminalOutputEvent,
  TerminalSpawnOptions,
  TerminalStatusSource,
} from './ports/terminalDock'
