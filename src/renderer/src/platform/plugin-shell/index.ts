export {
  AGENT_SPECS,
  CLI_AGENT_SPECS,
  REBUILD_CAPABLE_AGENTS,
  RESTORE_PIN_AGENTS,
} from './agents'
export type { AgentKey, AgentSpec, DirLister, PaneArgContext } from './agents'

export { agentProfileFor, agentUsesBracketedPaste, encodeShiftEnter } from './agentProfile'
export { REMOTE_AGENT_KEY, REMOTE_AGENT_SPEC } from './remoteAgent'

export {
  cliPermissionKey,
  launchBypassState,
  parseCliPermissionMode,
  skipPermissionFlagFor,
} from './lib/cliPermission'
export type { CliPermissionMode } from './lib/cliPermission'

export {
  cliModelKey,
  parseCliModelDefault,
  serializeCliModelDefault,
} from './lib/cliModelDefault'
export type { CliModelDefault } from './lib/cliModelDefault'

export {
  SPAWN_ENV_RESERVED_KEYS,
  chooseLaunchCommand,
  cliCommandKey,
  cliEnvKey,
  isReservedSpawnEnvKey,
  isValidEnvName,
  parseCliEnvOverride,
  serializeCliEnvOverride,
  spawnEnvOverride,
} from './lib/cliLaunchOverride'
export type { CliEnvEntry, LaunchCommandSource } from './lib/cliLaunchOverride'

export { effortSuffixConflict, modelArgsFor, supportsEffort, supportsModel } from './lib/cliModel'
export type {
  CliModelCapability,
  CliModelRefusal,
  CliModelRequest,
  CliModelResult,
} from './lib/cliModel'

export { default as AiCliDock } from './components/AiCliDock.vue'
export { default as AiCliTerminal } from './components/AiCliTerminal.vue'

export {
  aiTerminalPaneId,
  bracketedPaste,
  buildPlanCliContext,
  dockOutputLogFile,
  dockWindowLabelKey,
  resolveCliCommand,
  truncateText,
  PLAN_DOC_TRUNCATE_AT,
} from './lib/aiCliContext'
export type { PlanCliContextInput, PlanCliMetaSummary } from './lib/aiCliContext'

export {
  acquirePaneRebuildLock,
  buildResumeCommand,
  cancelStalePendingCreate,
  dedupeRestorablePanes,
  isShellSafeSessionId,
  normalizeResumeSessionId,
  paneBusyForRebuild,
  paneCanRebuild,
  paneRebuildVisible,
  sessionHomeIdFor,
  shouldPreserveMissingSessionOnRestore,
  shouldWarnMissingResume,
  usesSessionHome,
} from './lib/resume-command'

export { shellEscape } from './lib/shellEscape'
