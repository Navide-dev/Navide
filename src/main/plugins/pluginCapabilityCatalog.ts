import type { JsonValue, StoragePartitionScope } from '../../../packages/plugin-contracts/src/index'
import { validFilePickerRequest } from '../../../packages/plugin-contracts/src/filePicker'
import { normalizeJsonValue, utf8ByteLength } from './pluginStorageJson'
import { EDITOR_FILESYSTEM_METHODS, validateEditorFilesystemRequest } from './editorFilesystemCapability'
import { EDITOR_AI_METHODS, EDITOR_AI_EVENTS, validateEditorAiRequest } from './editorAiCapability'
import { EDITOR_NATIVE_METHODS, validateEditorNativeRequest } from './editorNativeCapability'
import { PUBLIC_GIT_METHODS, validatePublicGitRequest } from './gitPublicCapability'
import { PUBLIC_ISSUE_METHODS, validateIssueRequest } from './issueCapability'
import { EDITOR_PREFERENCE_METHODS, validateEditorPreferenceRequest } from './editorPreferenceCapability'
import { GIT_ACCOUNT_PUBLIC_METHODS, validateGitAccountRequest } from './gitAccountCapability'
import { WEB_EVENTS, WEB_GESTURE_METHODS, WEB_METHODS, validateWebRequest } from './webCapability'

/** Public Manifest v2 capability catalog used by the Host broker.
 *
 * The machine-readable JSON catalog remains the documentation/registry source
 * of truth. This small executable projection contains only the fields needed
 * to fail closed before a public request reaches a Host adapter.
 */

export type PublicCapabilityScope = 'workspace' | 'plugin'
/** Partition class a plugin may request from a Host-managed storage call. The
 *  Host derives the actual partition identity; the request only selects one of
 *  these two classes. */
export type StoragePartitionClass = StoragePartitionScope
export type PublicCapabilityEligibility = 'public' | 'firstParty'

export const STORAGE_LIMITS = {
  maxKeyBytes: 256,
  maxValueBytes: 1024 * 1024,
  maxSnapshotBytes: 10 * 1024 * 1024,
} as const

/** Executable names accepted by the public shell.run allowlist mode.
 * Package identity cannot add to or bypass this Host-owned policy. */
export const HOST_SHELL_EXECUTABLE_ALLOWLIST: readonly string[] = ['git', 'gh', 'glab']

interface PublicCapabilityCatalogBase {
  address: string
  kind: 'method' | 'event'
  eligibility: PublicCapabilityEligibility
  validateRequest?: (value: unknown) => value is Record<string, unknown>
  /** Mirrors the JSON catalog's `requiresUserGesture`: the Host refuses the
   *  address unless the request carries a gesture it observed itself. */
  requiresUserGesture?: boolean
}

/** Public storage entries are deliberately a separate union member: they do
 * not have a fixed namespace scope because the request chooses plugin versus
 * workspace while the Host derives the identity. */
export interface PublicStorageCapabilityCatalogEntry extends PublicCapabilityCatalogBase {
  namespace: 'storage'
  storage: true
  kind: 'method'
  validateRequest: (value: unknown) => value is Record<string, unknown>
}

export interface PublicSystemCapabilityCatalogEntry extends PublicCapabilityCatalogBase {
  namespace: 'fs' | 'ui' | 'aiCli' | 'web' | 'shell'
  /** Host-pinned scope for declared namespaces (`ui.openExternal` and every
   *  `web.*` address are `plugin`; storage has its own discriminated entry). */
  scope: PublicCapabilityScope
  storage?: false
  /** Fixed executable of a typed Host operation; never supplied by a Plugin. */
  shellCommand?: string
}

export type PublicCapabilityCatalogEntry =
  | PublicStorageCapabilityCatalogEntry
  | PublicSystemCapabilityCatalogEntry

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function requestWithString(
  key: string,
  value: unknown,
  optionalKeys: readonly string[] = []
): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, [key, ...optionalKeys]) && nonEmptyString(value[key])
}

/** Storage requests contain only a partition class and key; `set` additionally
 *  contains a JSON value. Partition identity is always Host-derived. */
export type StorageRequestValidationError = 'INVALID_ARGUMENT' | 'STORAGE_QUOTA_EXCEEDED'

export function storageRequestValidationError(
  value: unknown,
  address: 'storage.get' | 'storage.set' | 'storage.delete' = 'storage.get'
): StorageRequestValidationError | null {
  try {
    const allowedKeys = address === 'storage.set' ? ['scope', 'key', 'value'] : ['scope', 'key']
    if (!isRecord(value) || !hasOnlyKeys(value, allowedKeys)) return 'INVALID_ARGUMENT'
    const record = value as Record<string, unknown>
    const scope = record.scope
    if (scope !== 'plugin' && scope !== 'workspace') return 'INVALID_ARGUMENT'
    if (!nonEmptyString(record.key)) return 'INVALID_ARGUMENT'
    if (utf8ByteLength(record.key) > STORAGE_LIMITS.maxKeyBytes) {
      return 'STORAGE_QUOTA_EXCEEDED'
    }
    if (address === 'storage.set') {
      const normalized = normalizeJsonValue(record.value)
      if (!normalized) return 'INVALID_ARGUMENT'
      if (normalized.bytes > STORAGE_LIMITS.maxValueBytes) {
        return 'STORAGE_QUOTA_EXCEEDED'
      }
    }
    return null
  } catch {
    return 'INVALID_ARGUMENT'
  }
}

export function validateStorageRequest(
  value: unknown,
  address: 'storage.get' | 'storage.set' | 'storage.delete' = 'storage.get'
): value is Record<string, unknown> & {
  scope: StoragePartitionClass
  key: string
  value?: JsonValue
} {
  return storageRequestValidationError(value, address) === null
}

function validateEditorRequest(value: unknown): value is Record<string, unknown> {
  if (!requestWithString('path', value, ['line', 'column'])) return false
  const record = value as Record<string, unknown>
  return (
    (record.line === undefined || positiveInteger(record.line)) &&
    (record.column === undefined || positiveInteger(record.column))
  )
}

function validatePlansWindowRequest(value: unknown): value is Record<string, unknown> {
  return requestWithString('path', value)
}

function validateShareCreateRequest(value: unknown): value is Record<string, unknown> {
  if (!requestWithString('path', value, ['ttlSeconds', 'requireLogin', 'sendToChat', 'chatId'])) return false
  const { ttlSeconds, requireLogin, sendToChat, chatId } = value as Record<string, unknown>
  return (ttlSeconds === undefined || (Number.isInteger(ttlSeconds) && (ttlSeconds as number) > 0)) &&
    (requireLogin === undefined || typeof requireLogin === 'boolean') &&
    (sendToChat === undefined || typeof sendToChat === 'boolean') &&
    (chatId === undefined || nonEmptyString(chatId))
}

function validateExternalRequest(value: unknown): value is Record<string, unknown> {
  if (!requestWithString('url', value)) return false
  try {
    const url = new URL(String((value as Record<string, unknown>).url))
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch { return false }
}

function validateStartRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['profileId', 'requestId', 'cols', 'rows', 'paneId', 'yolo', 'persistView'])) return false
  return (
    nonEmptyString(value.profileId) &&
    (value.requestId === undefined || nonEmptyString(value.requestId)) &&
    positiveInteger(value.cols) &&
    positiveInteger(value.rows) &&
    (value.paneId === undefined || nonEmptyString(value.paneId)) &&
    (value.yolo === undefined || typeof value.yolo === 'boolean') &&
    (value.persistView === undefined || typeof value.persistView === 'boolean')
  )
}

function validateEmptyRequest(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, [])
}

function validateResumeRequest(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, ['cols', 'rows', 'persistView']) &&
    positiveInteger(value.cols) && positiveInteger(value.rows) &&
    (value.persistView === undefined || typeof value.persistView === 'boolean')
}

function validateWriteFileRequest(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, ['path', 'content', 'encoding', 'expectedMtime', 'selectionGrant']) &&
    nonEmptyString(value.path) && typeof value.content === 'string' &&
    (value.selectionGrant === undefined || nonEmptyString(value.selectionGrant)) &&
    (value.encoding === undefined || nonEmptyString(value.encoding)) &&
    (value.expectedMtime === undefined ||
      (typeof value.expectedMtime === 'number' && Number.isFinite(value.expectedMtime)))
}

function validateReadFileRequest(value: unknown): value is Record<string, unknown> {
  return requestWithString('path', value, ['encoding', 'selectionGrant']) &&
    (value.selectionGrant === undefined || nonEmptyString(value.selectionGrant)) &&
    (value.encoding === undefined || nonEmptyString(value.encoding))
}

function validateSelectedPathRequest(value: unknown): value is Record<string, unknown> {
  return requestWithString('path', value, ['selectionGrant']) &&
    (value.selectionGrant === undefined || nonEmptyString(value.selectionGrant))
}

function validateListFilesRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['query', 'maxResults'])) return false
  return (
    (value.query === undefined || typeof value.query === 'string') &&
    (value.maxResults === undefined || positiveInteger(value.maxResults))
  )
}

function validateSessionRequest(value: unknown): value is Record<string, unknown> {
  return requestWithString('sessionId', value)
}

function validateReattachRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'cols', 'rows'])) return false
  return nonEmptyString(value.sessionId) && positiveInteger(value.cols) && positiveInteger(value.rows)
}

function validateStopRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'force'])) return false
  return nonEmptyString(value.sessionId) && typeof value.force === 'boolean'
}

function validateInputRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'data'])) return false
  return nonEmptyString(value.sessionId) && typeof value.data === 'string'
}

function validateResizeRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sessionId', 'cols', 'rows'])) return false
  return nonEmptyString(value.sessionId) && positiveInteger(value.cols) && positiveInteger(value.rows)
}

function validateShellRequest(value: unknown): value is Record<string, unknown> {
  return requestWithString('command', value)
}

function systemMethod(
  address: string,
  namespace: 'fs' | 'ui' | 'aiCli',
  validateRequest: (value: unknown) => value is Record<string, unknown>,
  eligibility: PublicCapabilityEligibility = 'public'
): PublicCapabilityCatalogEntry {
  return {
    address,
    kind: 'method',
    namespace,
    scope: namespace === 'ui' && address === 'ui.openExternal' ? 'plugin' : 'workspace',
    eligibility,
    validateRequest,
  }
}

function aiCliMethod(
  address: string,
  validateRequest: (value: unknown) => value is Record<string, unknown>
): PublicCapabilityCatalogEntry {
  return systemMethod(address, 'aiCli', validateRequest)
}

function storageMethod(
  address: 'storage.get' | 'storage.set' | 'storage.delete'
): PublicCapabilityCatalogEntry {
  return {
    address,
    kind: 'method',
    namespace: 'storage',
    storage: true,
    eligibility: 'public',
    validateRequest: (value) => validateStorageRequest(value, address),
  }
}

/** Native `ui` methods a plain `ui` grant must not reach: opening a path or a
 *  plugin-written temp file hands it to the OS default app (a `.command` or
 *  `.bat` runs), and keybindings.json is the Host's own configuration. */
const FIRST_PARTY_NATIVE_METHODS: ReadonlySet<string> = new Set([
  'ui.openPath',
  'ui.openTempFile',
  'ui.writeKeybindings',
])

export const PUBLIC_CAPABILITY_CATALOG: Readonly<Record<string, PublicCapabilityCatalogEntry>> = {
  'ui.openFilePicker': systemMethod('ui.openFilePicker', 'ui', (value): value is Record<string, unknown> => validFilePickerRequest(value)),
  ...Object.fromEntries(EDITOR_NATIVE_METHODS.map(address => [address, {
    address, kind: 'method', namespace: 'ui', scope: 'workspace',
    eligibility: FIRST_PARTY_NATIVE_METHODS.has(address) ? 'firstParty' : 'public',
    validateRequest: (value: unknown) => validateEditorNativeRequest(address, value),
  } as PublicSystemCapabilityCatalogEntry])),
  // Git accounts hold hosting tokens: first-party only.
  ...Object.fromEntries(Object.keys(GIT_ACCOUNT_PUBLIC_METHODS).map(address => [address, {
    address, kind: 'method', namespace: 'ui', scope: 'workspace', eligibility: 'firstParty',
    validateRequest: (value: unknown) => validateGitAccountRequest(address, value),
  } as PublicSystemCapabilityCatalogEntry])),
  ...Object.fromEntries(PUBLIC_ISSUE_METHODS.map(address => [address, {
    address, namespace: 'shell', scope: 'workspace', kind: 'method', shellCommand: 'git',
    eligibility: 'public', validateRequest: (value: unknown) => validateIssueRequest(address, value),
  } as PublicSystemCapabilityCatalogEntry])),
  ...Object.fromEntries(EDITOR_PREFERENCE_METHODS.map(address => [address, {
    address, namespace: 'ui', scope: 'workspace', kind: 'method', eligibility: 'public',
    validateRequest: (value: unknown) => validateEditorPreferenceRequest(address, value),
  } as PublicSystemCapabilityCatalogEntry])),
  'ui.editorPreferencesChanged': {
    address: 'ui.editorPreferencesChanged', namespace: 'ui', scope: 'workspace', kind: 'event', eligibility: 'public',
  },
  'ui.pluginStorageChanged': {
    address: 'ui.pluginStorageChanged', namespace: 'ui', scope: 'workspace', kind: 'event', eligibility: 'public',
  },
  'shell.gitCredentialRequested': {
    address: 'shell.gitCredentialRequested', namespace: 'shell', scope: 'workspace', kind: 'event', eligibility: 'public',
  },
  'shell.gitCredentialCancelled': {
    address: 'shell.gitCredentialCancelled', namespace: 'shell', scope: 'workspace', kind: 'event', eligibility: 'public',
  },
  ...Object.fromEntries(PUBLIC_GIT_METHODS.map(address => [address, {
    address, kind: 'method', namespace: address.startsWith('aiCli.') ? 'aiCli' : 'shell',
    scope: 'workspace', eligibility: 'public',
    ...(address.startsWith('shell.') ? { shellCommand: 'git' } : {}),
    validateRequest: (value: unknown) => validatePublicGitRequest(address, value),
  } as PublicSystemCapabilityCatalogEntry])),
  'ui.keybindingsChanged': {
    address: 'ui.keybindingsChanged', kind: 'event', namespace: 'ui', scope: 'workspace', eligibility: 'public',
  },
  ...Object.fromEntries(EDITOR_AI_METHODS.map(address => [
    address, aiCliMethod(address, (value): value is Record<string, unknown> =>
      validateEditorAiRequest(address, value)),
  ])),
  ...Object.fromEntries(EDITOR_AI_EVENTS.map(address => [address, {
    address, kind: 'event', namespace: 'aiCli', scope: 'workspace', eligibility: 'public',
  } satisfies PublicCapabilityCatalogEntry])),
  ...Object.fromEntries(EDITOR_FILESYSTEM_METHODS.map(address => [
    address, systemMethod(address, 'fs', (value): value is Record<string, unknown> =>
      validateEditorFilesystemRequest(address, value)),
  ])),
  'fs.readFile': systemMethod('fs.readFile', 'fs', validateReadFileRequest),
  'fs.writeFile': systemMethod('fs.writeFile', 'fs', validateWriteFileRequest),
  'fs.readImage': systemMethod('fs.readImage', 'fs', validateSelectedPathRequest),
  'fs.listDirectory': systemMethod('fs.listDirectory', 'fs', (value): value is Record<string, unknown> =>
    requestWithString('path', value, ['showHidden']) &&
    (value.showHidden === undefined || typeof value.showHidden === 'boolean')),
  'fs.listFilesFlat': systemMethod('fs.listFilesFlat', 'fs', validateListFilesRequest),
  'fs.glob': systemMethod('fs.glob', 'fs', (value) => requestWithString('pattern', value)),
  'fs.stat': systemMethod('fs.stat', 'fs', validateSelectedPathRequest),
  'fs.statPath': systemMethod('fs.statPath', 'fs', validateSelectedPathRequest),
  'ui.openInEditor': systemMethod('ui.openInEditor', 'ui', validateEditorRequest),
  'ui.openPlansWindow': systemMethod(
    'ui.openPlansWindow',
    'ui',
    validatePlansWindowRequest,
    'firstParty',
  ),
  // Share links: the Plans view asks whether they work, then shares one plan.
  'ui.shareCaps': systemMethod('ui.shareCaps', 'ui', validateEmptyRequest, 'firstParty'),
  'ui.shareCreate': systemMethod('ui.shareCreate', 'ui', validateShareCreateRequest, 'firstParty'),
  'ui.shareChatTargets': systemMethod('ui.shareChatTargets', 'ui', validateEmptyRequest, 'firstParty'),
  'ui.openExternal': {
    ...systemMethod('ui.openExternal', 'ui', validateExternalRequest),
    requiresUserGesture: true,
  },
  'storage.get': storageMethod('storage.get'),
  'storage.set': storageMethod('storage.set'),
  'storage.delete': storageMethod('storage.delete'),
  'aiCli.listProfiles': aiCliMethod('aiCli.listProfiles', (value): value is Record<string, unknown> =>
    isRecord(value) && hasOnlyKeys(value, ['terminalView']) &&
    (value.terminalView === undefined || typeof value.terminalView === 'boolean')),
  'aiCli.readTerminalView': aiCliMethod('aiCli.readTerminalView', validateEmptyRequest),
  'aiCli.listMentionTargets': aiCliMethod('aiCli.listMentionTargets', validateSessionRequest),
  'aiCli.saveClipboardImage': aiCliMethod('aiCli.saveClipboardImage', (value): value is Record<string, unknown> =>
    requestWithString('sessionId', value, ['bytes', 'mediaType']) &&
    typeof value.mediaType === 'string' && Array.isArray(value.bytes) &&
    value.bytes.every(byte => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)),
  'aiCli.showTerminalContextMenu': aiCliMethod('aiCli.showTerminalContextMenu', (value): value is Record<string, unknown> =>
    isRecord(value) && hasOnlyKeys(value, ['sessionId', 'selection']) && typeof value.selection === 'string' &&
    (value.sessionId === undefined || nonEmptyString(value.sessionId))),
  'aiCli.reportTerminalSelection': aiCliMethod('aiCli.reportTerminalSelection', (value): value is Record<string, unknown> =>
    isRecord(value) && hasOnlyKeys(value, ['sessionId', 'selection']) && typeof value.selection === 'string' &&
    (value.sessionId === undefined || nonEmptyString(value.sessionId))),
  'aiCli.saveTerminalView': aiCliMethod('aiCli.saveTerminalView', (value): value is Record<string, unknown> =>
    requestWithString('sessionId', value, ['snapshots']) &&
    Array.isArray(value.snapshots) && value.snapshots.every(item => typeof item === 'string')),
  'aiCli.setTerminalFontSize': aiCliMethod('aiCli.setTerminalFontSize', (value): value is Record<string, unknown> =>
    isRecord(value) && hasOnlyKeys(value, ['fontSize']) &&
    typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) && value.fontSize > 0),
  'aiCli.startSession': aiCliMethod('aiCli.startSession', validateStartRequest),
  'aiCli.resumeSession': aiCliMethod('aiCli.resumeSession', validateResumeRequest),
  'aiCli.cancelStart': aiCliMethod('aiCli.cancelStart', (value) => requestWithString('requestId', value)),
  'aiCli.reattachSession': aiCliMethod('aiCli.reattachSession', validateReattachRequest),
  'aiCli.sendInput': aiCliMethod('aiCli.sendInput', validateInputRequest),
  'aiCli.resizeSession': aiCliMethod('aiCli.resizeSession', validateResizeRequest),
  'aiCli.redrawSession': aiCliMethod('aiCli.redrawSession', validateResizeRequest),
  'aiCli.interruptSession': aiCliMethod('aiCli.interruptSession', validateSessionRequest),
  'aiCli.stopSession': aiCliMethod('aiCli.stopSession', validateStopRequest),
  'shell.run': {
    address: 'shell.run',
    kind: 'method',
    namespace: 'shell',
    scope: 'workspace',
    eligibility: 'public',
    validateRequest: validateShellRequest,
  },
  'workspace.filesChanged': {
    address: 'workspace.filesChanged',
    kind: 'event',
    namespace: 'fs',
    scope: 'workspace',
    eligibility: 'public',
  },
  'aiCli.output': {
    address: 'aiCli.output',
    kind: 'event',
    namespace: 'aiCli',
    scope: 'workspace',
    eligibility: 'public',
  },
  'aiCli.exited': {
    address: 'aiCli.exited',
    kind: 'event',
    namespace: 'aiCli',
    scope: 'workspace',
    eligibility: 'public',
  },
  // Plugin-owned browser views: the partition belongs to the plugin, not to a
  // workspace, so every web address is plugin-scoped.
  ...Object.fromEntries(WEB_METHODS.map(address => [address, {
    address, kind: 'method', namespace: 'web', scope: 'plugin', eligibility: 'public',
    validateRequest: (value: unknown): value is Record<string, unknown> => validateWebRequest(address, value),
    ...(WEB_GESTURE_METHODS.has(address) ? { requiresUserGesture: true } : {}),
  } satisfies PublicSystemCapabilityCatalogEntry])),
  ...Object.fromEntries(WEB_EVENTS.map(address => [address, {
    address, kind: 'event', namespace: 'web', scope: 'plugin', eligibility: 'public',
  } satisfies PublicSystemCapabilityCatalogEntry])),
}

export const PUBLIC_CAPABILITY_EVENT_ADDRESSES: readonly string[] = [
  'workspace.filesChanged',
  'aiCli.output',
  'aiCli.exited',
]

export function publicCapabilityEntry(address: string): PublicCapabilityCatalogEntry | null {
  return PUBLIC_CAPABILITY_CATALOG[address] ?? null
}
