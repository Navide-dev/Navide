import { capabilitiesV1 } from '../../../packages/plugin-contracts/src/index'

export interface CapabilityDeprecation {
  since: string
  removeAfter: string
  replacement?: string
}

type CatalogEntry = { address: string; deprecated?: CapabilityDeprecation }

const catalogEntries = [...capabilitiesV1.methods, ...capabilitiesV1.events] as CatalogEntry[]

const DEPRECATED_CAPABILITIES: ReadonlyMap<string, CapabilityDeprecation> = new Map(
  catalogEntries.flatMap((entry) => (entry.deprecated ? [[entry.address, entry.deprecated] as const] : [])),
)

const warned = new Set<string>()

/** The notice for a plugin's first call to a deprecated address, else null. */
export function deprecationNotice(
  pluginId: string,
  address: string,
  deprecations: ReadonlyMap<string, CapabilityDeprecation> = DEPRECATED_CAPABILITIES,
): string | null {
  const deprecation = deprecations.get(address)
  const key = `${pluginId}\0${address}`
  if (!deprecation || warned.has(key)) return null
  warned.add(key)
  const replacement = deprecation.replacement ? `; use ${deprecation.replacement}` : ''
  return `[plugin] ${pluginId} calls ${address}, deprecated since API ${deprecation.since} and removed after ${deprecation.removeAfter}${replacement}`
}

export function warnDeprecatedCapability(pluginId: string, address: string): void {
  const notice = deprecationNotice(pluginId, address)
  if (notice) console.warn(notice)
}
