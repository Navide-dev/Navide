export interface GitV2ActivationFailure {
  pluginId: string
  packageVersion: string
  reason: string
}

interface SelectedGitDescriptor {
  id: string
  packageVersion?: string
  capabilityPolicy?: { kind: string }
}

interface GitV2FailureDependencies {
  selectedDescriptor(): SelectedGitDescriptor | null
  hasExactGrant(pluginId: string, packageVersion: string): boolean
}

/**
 * Whether an activation failure belongs to the exact, granted Manifest v2 Git
 * package the Host selected — the only failure the main window reports with a
 * Reinstall action. Absence, trust/grant denial, and stale-version failures are
 * not that package failing and stay fail closed.
 */
export function isSelectedGitV2ActivationFailure(
  failure: GitV2ActivationFailure,
  dependencies: GitV2FailureDependencies,
): boolean {
  if (failure.pluginId !== 'navide.git') return false
  const selected = dependencies.selectedDescriptor()
  return (
    selected?.id === failure.pluginId &&
    selected.packageVersion === failure.packageVersion &&
    selected.capabilityPolicy?.kind === 'manifest-v2' &&
    dependencies.hasExactGrant(failure.pluginId, failure.packageVersion)
  )
}
