export {
  flushSettingsOnExit,
  initSettingsBackend,
  migrateLegacyLocalStorage,
  onSettingsChanged,
  seedSettings,
  settingsGet,
  settingsReadiness,
  settingsReady,
  retrySettings,
  settingsRemove,
  settingsSet,
  SETTINGS_FLUSH_DEBOUNCE_MS,
  MIGRATED_LOCALSTORAGE_KEYS,
  PURGED_LOCALSTORAGE_KEYS,
  PURGED_LOCALSTORAGE_PREFIXES,
} from './lib/settings'
export type { SettingsBackend, SettingsReadinessStatus } from './lib/settings'
export * from './lib/uiScale'
export * from './layout/gridLayout'
export * from './layout/paneCycle'

export type { KeybindingsPort } from './ports/keybindings'
export type { PortError, PortResponse } from './ports/response'
export type { ReactiveValue } from './ports/value'
export { parseConflicts, buildResolved, hasConflicts, countConflicts } from './lib/conflict-parser'
export type { ConflictChoice, ConflictSection, ContextSection, FileSection } from './lib/conflict-parser'

export { COMMAND_IDS, commandI18nKey, describeCommand } from './keybindings/commandCatalog'
export type { CommandInfo } from './keybindings/commandCatalog'

export {
  executeCommand,
  hasCommand,
  invokeCommand,
  listCommands,
  registerCommand,
  registerPluginCommand,
  unregisterCommand,
} from './keybindings/commandRegistry'
export type { InvokeCommandResult } from './keybindings/commandRegistry'

export { getContext, setContext } from './keybindings/contextService'

export {
  buildRows,
  classifyRow,
  conflictsByRow,
  findKeyConflicts,
  parseUserRules,
  resetRow,
  reviewImportedRules,
  rowId,
  sanitizeUserRules,
  serializeUserRules,
  setRowKeys,
} from './keybindings/customization'
export {
  PROTECTED_COMMANDS,
} from './keybindings/customization'
export type {
  BindingKeyChip,
  BindingRow,
  BindingSource,
  ImportReport,
  KeyConflict,
} from './keybindings/customization'

export { defaults, settingsKeySpec, sidebarTabKeySpec } from './keybindings/defaults'

export {
  acceleratorToSpec,
  MENU_LITERAL_ACCELERATORS,
  MENU_OMITTED_ROLES,
  MENU_OWNED_SPECS,
  MENU_ROLE_ACCELERATORS,
  menuOwnedSpecs,
  NATIVE_MENU_KEYS,
  nativeMenuKeys,
  splitKeyTokens,
  TERMINAL_KEYS,
} from './keybindings/externalKeys'
export type { ExternalKeyRow, KeyToken } from './keybindings/externalKeys'

export { formatKeySpec, keySpecToTokens, segmentToTokens } from './keybindings/keyDisplay'
export { KeyResolver } from './keybindings/keyResolver'

export {
  canonicalizeKeySpec,
  eventLoneModifier,
  eventToKeyString,
  eventToParsedKey,
  FN_KEY,
  formatParsedKey,
  isFnKey,
  isLoneModifierKey,
  isMacPlatform,
  LONE_MODIFIER_KEYS,
  matchesEvent,
  MODIFIER_KEYS,
  parseKey,
  parseKeySpec,
  parsedKeyEquals,
  validateKeySpec,
} from './keybindings/parseKey'
export type { KeySpecError } from './keybindings/parseKey'

export { isRemovalRule, removalTarget } from './keybindings/types'
export type { CommandHandler, KeybindingRule, ParsedKey } from './keybindings/types'

export {
  getUserRules,
  initKeybindingsPort,
  isKeyCaptureActive,
  onKeydownSeen,
  onUserRulesChanged,
  saveUserRules,
  setKeyCaptureActive,
  setUserRules,
  useKeybindings,
} from './keybindings/useKeybindings'

export { evaluateWhen } from './keybindings/whenEvaluator'
