import {
  compareSemver as comparePublicSemver,
  isValidManifestV2PluginId as isPublicManifestV2PluginId,
  parseManifestV2 as parsePublicManifestV2,
  PluginContractError,
  V2_SHELL_MODES,
  V2_SYSTEM_NAMESPACES,
  V2_VIEW_LOCATIONS,
  type PluginManifestV2,
  type PluginManifestV2Permissions,
  type PluginManifestV2View,
  type PluginShellMode,
  type PluginSystemNamespace,
} from '../../../packages/plugin-contracts/src/index'
import { validateAgentTools } from '../../shared/pluginAgentTools'
import { isMethodName } from './pluginBackendSupervisor'
import { InstalledPluginError } from './pluginManifestErrors'

export {
  V2_SHELL_MODES,
  V2_SYSTEM_NAMESPACES,
  V2_VIEW_LOCATIONS,
}
export type {
  PluginManifestV2,
  PluginManifestV2Permissions,
  PluginManifestV2View,
  PluginShellMode,
  PluginSystemNamespace,
}

/** Return whether a value is a canonical Manifest v2 package id. */
export function isValidManifestV2PluginId(value: unknown): value is string {
  return isPublicManifestV2PluginId(value)
}

/** Compare SemVer precedence using the public contract implementation. */
export function compareSemver(left: string, right: string): number | null {
  return comparePublicSemver(left, right)
}

/**
 * Host adapter preserving the Host error type while delegating Manifest v2
 * validation to the public contracts package, plus the agent-tools contract
 * rules that the manifest schema (and so the public parser) cannot express.
 */
export function parseManifestV2(raw: Record<string, unknown>): PluginManifestV2 {
  // backend.agentTools: every rule of the agent-tools contract (section 2.5),
  // first, so a refusal names the contract's error code. A package with any
  // error is refused, exactly like a schema error.
  const [first] = validateAgentTools(raw)
  if (first) {
    const at = first.index === null ? '' : `[${first.index}]${first.field ? `.${first.field}` : ''}`
    throw new InstalledPluginError(`manifest backend.agentTools${at} is invalid: ${first.code}`)
  }
  // The backend supervisor accepts only lower-case method names
  // (isMethodName), so a tool forwarded to a camelCase method could never be
  // served: refuse it here, at install, instead of at activation.
  const backend = raw.backend as { agentTools?: unknown } | undefined
  if (backend && Array.isArray(backend.agentTools)) {
    backend.agentTools.forEach((tool, index) => {
      const method = (tool as { method?: unknown }).method
      if (!isMethodName(method)) {
        throw new InstalledPluginError(
          `manifest backend.agentTools[${index}].method '${String(method)}' is not a backend method name ` +
          'the Host accepts (lower-case dotted segments of a-z, 0-9 and _)'
        )
      }
    })
  }
  try {
    return parsePublicManifestV2(raw)
  } catch (error) {
    if (error instanceof PluginContractError) {
      throw new InstalledPluginError(error.message)
    }
    throw error
  }
}
