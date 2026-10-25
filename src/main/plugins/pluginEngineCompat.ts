// Navide engine compatibility for Registry packages. `engines.navide` names the
// lowest Navide release a package supports, the way VS Code reads
// `engines.vscode`: `^0.2.9`, `~0.2.9`, `>=0.2.9` and a bare `0.2.9` all mean
// "0.2.9 or newer", and `*` means any release. Upper bounds are not enforced,
// so `^0.1.0` stays installable on 0.2.x and `>=0.2.30` on 0.3.0. The Registry
// applies the same rule (marketplace/registry/registry/discovery.py).
import { compareSemver } from './pluginManifestV2'

const ENGINE_RANGE_RE = /^\s*(?:\^|~|>=)?\s*(\S+)\s*$/

/** The lowest Navide version `requirement` accepts, or null when it is absent
 *  or not a form this rule reads. */
export function minNavideVersion(requirement: unknown): string | null {
  if (typeof requirement !== 'string') return null
  if (requirement.trim() === '*') return '0.0.0'
  const match = ENGINE_RANGE_RE.exec(requirement)
  if (!match) return null
  const floor = match[1]
  return compareSemver(floor, floor) === 0 ? floor : null
}

/** true/false against `appVersion`; null when the requirement is unknown. */
export function isEngineCompatible(requirement: unknown, appVersion: string): boolean | null {
  const floor = minNavideVersion(requirement)
  if (floor === null) return null
  const order = compareSemver(appVersion, floor)
  return order === null ? null : order >= 0
}

/** The `engines.navide` string of a manifest-shaped object, if any. */
export function engineRequirement(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null) return null
  const engines = (manifest as { engines?: unknown }).engines
  if (typeof engines !== 'object' || engines === null) return null
  const navide = (engines as { navide?: unknown }).navide
  return typeof navide === 'string' ? navide : null
}

/** Refuse a verified package this Navide release is too old to run. Unknown
 *  requirements pass: they were never enforced and stay installable. */
export function assertEngineCompatible(
  id: string,
  version: string,
  manifest: unknown,
  appVersion: string
): void {
  const requirement = engineRequirement(manifest)
  if (isEngineCompatible(requirement, appVersion) === false) {
    throw new Error(
      `${id} ${version} requires Navide ${minNavideVersion(requirement)} or newer; this is Navide ${appVersion}`
    )
  }
}
