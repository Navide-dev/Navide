import { realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import {
  BackendPluginError,
  type BackendPluginLaunchSpec,
} from './pluginBackendSupervisor'
import {
  verifyInstalledRegistryPackage,
  type InstalledRegistryTrustContext,
} from './pluginInstalledTrust'
import { PluginActivationSelector } from './pluginActivationSelector'
import { verifyLocalInstalledPackage } from './pluginLocalInstall'

export interface BackendSpawnTrustContext {
  pluginsRoot: () => string
  currentRegistryTrust: () => InstalledRegistryTrustContext
}

/**
 * Re-verify a Registry-backed backend launch against the package selected by
 * the current Host lifecycle record. This is a Host-internal admission seam,
 * not a public plugin API.
 */
export function verifyInstalledBackendSpawnTrust(
  activation: Pick<BackendPluginLaunchSpec, 'pluginId' | 'packageVersion' | 'packageDir'>,
  context: BackendSpawnTrustContext,
): void {
  const pluginsRoot = context.pluginsRoot()
  const packageRelativePath = relative(pluginsRoot, activation.packageDir)
  if (
    !packageRelativePath ||
    isAbsolute(packageRelativePath) ||
    packageRelativePath === '..' ||
    packageRelativePath.startsWith(`..${sep}`)
  ) {
    // Factory-bundled and developer-local packages do not carry Registry
    // receipts. The Registry trust hook applies only to installed packages
    // under the Host-owned plugins root (Registry or installed from a file).
    return
  }

  let canonicalPackageDir: string
  let selectorRecord: ReturnType<PluginActivationSelector['read']>
  const selector = new PluginActivationSelector(pluginsRoot)
  try {
    canonicalPackageDir = realpathSync(activation.packageDir)
    selectorRecord = selector.read(activation.pluginId)
  } catch (error) {
    throw new BackendPluginError(
      'BACKEND_UNAVAILABLE',
      'installed plugin lifecycle selector is unreadable',
      { cause: error },
    )
  }

  // Pre-selector installs retain their legacy Registry verification path. Once
  // a selector exists, every launch must match its active immutable identity.
  if (selectorRecord === null) {
    const trust = context.currentRegistryTrust()
    const decision = verifyLocalInstalledPackage(pluginsRoot, canonicalPackageDir, activation.pluginId, trust) ??
      verifyInstalledRegistryPackage(canonicalPackageDir, activation.pluginId, trust)
    if (decision.action === 'quarantine') {
      throw new BackendPluginError(
        'BACKEND_UNAVAILABLE',
        'installed plugin trust verification failed',
        { cause: new Error(decision.reason) },
      )
    }
    return
  }
  if (!selectorRecord.active) {
    throw new BackendPluginError(
      'BACKEND_UNAVAILABLE',
      'installed plugin lifecycle selector has no active package selection',
    )
  }

  const active = selectorRecord.active
  let canonicalSelectedPackageDir: string
  try {
    canonicalSelectedPackageDir = realpathSync(selector.packageDir(activation.pluginId, active))
  } catch (error) {
    throw new BackendPluginError(
      'BACKEND_UNAVAILABLE',
      'installed plugin active package identity is unreadable',
      { cause: error },
    )
  }
  if (
    activation.packageVersion !== active.packageVersion ||
    canonicalPackageDir !== canonicalSelectedPackageDir
  ) {
    throw new BackendPluginError(
      'BACKEND_UNAVAILABLE',
      'installed backend launch identity does not match the active package selection',
    )
  }

  // Card K3: a package installed from a file is verified against the user's
  // consent record, under the same selector identity checks.
  const trust = context.currentRegistryTrust()
  const decision = verifyLocalInstalledPackage(pluginsRoot, canonicalPackageDir, activation.pluginId, trust) ??
    verifyInstalledRegistryPackage(canonicalPackageDir, activation.pluginId, trust)
  if (decision.action === 'quarantine') {
    throw new BackendPluginError(
      'BACKEND_UNAVAILABLE',
      'installed plugin trust verification failed',
      { cause: new Error(decision.reason) },
    )
  }
  if (decision.artifactDigest !== active.artifactDigest) {
    throw new BackendPluginError(
      'BACKEND_UNAVAILABLE',
      'installed plugin artifact digest does not match the active package selection',
    )
  }

  // This re-check narrows a selector change during verification; it does not
  // make the verification-and-spawn sequence atomic.
  let currentSelectorRecord: ReturnType<PluginActivationSelector['read']>
  try {
    currentSelectorRecord = selector.read(activation.pluginId)
  } catch (error) {
    throw new BackendPluginError(
      'BACKEND_UNAVAILABLE',
      'installed plugin lifecycle selector is unreadable after trust verification',
      { cause: error },
    )
  }
  const currentActive = currentSelectorRecord?.active
  if (
    !currentActive ||
    currentActive.packageVersion !== active.packageVersion ||
    currentActive.target !== active.target ||
    currentActive.artifactDigest !== active.artifactDigest
  ) {
    throw new BackendPluginError(
      'BACKEND_UNAVAILABLE',
      'installed plugin active package selection changed during trust verification',
    )
  }
  try {
    if (realpathSync(selector.packageDir(activation.pluginId, currentActive)) !== canonicalPackageDir) {
      throw new Error('active package directory no longer matches the launch identity')
    }
  } catch (error) {
    throw new BackendPluginError(
      'BACKEND_UNAVAILABLE',
      'installed plugin active package identity changed during trust verification',
      { cause: error },
    )
  }
}
