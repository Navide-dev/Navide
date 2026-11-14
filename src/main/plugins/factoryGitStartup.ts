interface FactoryLoadSuccess<T> {
  loaded: true
  activation: T
}

interface FactoryLoadFailure {
  loaded: false
  reason: string
}

export function shouldAttemptFactoryGit(state: {
  installedPackagePresent: boolean
  optedOut: boolean
}): boolean {
  return !state.installedPackagePresent && !state.optedOut
}

/** Load the App-bundled Git package at startup. Trust/grant decisions happen
 * before this seam; a package that cannot be loaded is reported with its
 * reason, which the main window shows next to a Reinstall action. There is no
 * second Git implementation to fall back to. */
export function activateFactoryGit<T>(
  loadFactory: () => FactoryLoadSuccess<T> | FactoryLoadFailure,
): { mode: 'v2'; activation: T } | { mode: 'failed'; reason: string } {
  let factory: FactoryLoadSuccess<T> | FactoryLoadFailure
  try {
    factory = loadFactory()
  } catch (error) {
    factory = {
      loaded: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  return factory.loaded
    ? { mode: 'v2', activation: factory.activation }
    : { mode: 'failed', reason: factory.reason }
}
