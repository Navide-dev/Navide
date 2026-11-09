import { isValidManifestV2PluginId } from './pluginManifestV2'

/** `plugins.call`: one plugin calling a method another installed plugin offers
 *  in `contributes.api`. The broker checks the caller side (the target is in
 *  the caller's `permissions.plugins` and the package-version grant stands);
 *  {@link interPluginTargetError} checks the target side just before the Host
 *  forwards the call to the target's backend for the caller's workspace.
 *  Disclosure, not restriction: both declarations are shown to the user on the
 *  two plugins' cards, and every call lands in both plugins' Activity. */

export const PLUGINS_CALL_ADDRESS = 'plugins.call'
const MAX_METHOD_LENGTH = 128

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function validateInterPluginCallRequest(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) &&
    Object.keys(value).every(key => ['pluginId', 'method', 'args'].includes(key)) &&
    isValidManifestV2PluginId(value.pluginId) &&
    typeof value.method === 'string' && value.method.length > 0 && value.method.length <= MAX_METHOD_LENGTH &&
    Object.hasOwn(value, 'args')
}

/** What the Host knows about the target package when the call arrives. */
export interface InterPluginTarget {
  pluginId: string
  /** `contributes.api` method names of the installed, enabled version. */
  api: readonly string[]
  /** `backend.methods` of that version. */
  backendMethods: readonly string[]
  /** The target's native backend can run on this machine (no backend on Windows). */
  backendAvailable: boolean
}

/** Error codes from the public vocabulary (the SDK maps nothing else). */
export type InterPluginCallErrorCode =
  | 'METHOD_NOT_FOUND'
  | 'BACKEND_UNAVAILABLE'
  | 'TIMEOUT'
  | 'USER_CANCELLED'
  | 'PLUGIN_STOPPING'
  | 'RESOURCE_LIMIT'
  | 'INTERNAL_ERROR'

/** A `plugins.call` failure the caller may learn the reason of. */
export class InterPluginCallError extends Error {
  constructor(readonly code: InterPluginCallErrorCode, message: string) {
    super(message)
    this.name = 'InterPluginCallError'
  }
}

/** Why the target cannot serve this call, or null when it can. A missing or
 *  disabled target answers like a method it does not offer. */
export function interPluginTargetError(
  callerId: string,
  target: InterPluginTarget | null,
  method: string,
): InterPluginCallError | null {
  if (!target || target.pluginId === callerId) {
    return new InterPluginCallError('METHOD_NOT_FOUND', 'the target plugin is not installed and enabled')
  }
  if (!target.api.includes(method) || !target.backendMethods.includes(method)) {
    return new InterPluginCallError('METHOD_NOT_FOUND', `'${target.pluginId}' does not offer '${method}' in contributes.api`)
  }
  if (!target.backendAvailable) {
    return new InterPluginCallError('BACKEND_UNAVAILABLE', `'${target.pluginId}' has no backend on this machine`)
  }
  return null
}

/** The caller-visible form of a target backend failure: its code when the
 *  public vocabulary has it, otherwise a fixed message (no Host internals). */
export function interPluginBackendError(code: string | undefined): InterPluginCallError {
  switch (code) {
    case 'TIMEOUT':
    case 'USER_CANCELLED':
    case 'PLUGIN_STOPPING':
    case 'RESOURCE_LIMIT':
    case 'BACKEND_UNAVAILABLE':
      return new InterPluginCallError(code, `the target plugin backend answered ${code}`)
    default:
      return new InterPluginCallError('INTERNAL_ERROR', 'the target plugin backend failed')
  }
}
