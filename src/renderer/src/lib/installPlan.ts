import type { OnboardDep } from '../composables/useOnboarding'

/**
 * Ordering for a batch install, so a fresh machine can be walked through its
 * dependency chain instead of failing one step at a time.
 *
 * The wizard used to install in list order and stop at the first blocker. On a
 * bare Mac that means `brew install node` runs before Homebrew exists, exits
 * 127, and the user is left to work out for themselves what to install first.
 * The backend already reports each dep's prerequisites, so the order can be
 * derived rather than guessed.
 */

/** Bootstrap binaries that another dep in the registry provides. */
const PROVIDER_BY_BINARY: Record<string, string> = { brew: 'homebrew', npm: 'node' }

/** The dep that would provide `binary`, if the registry has one. */
export function providerFor(binary: string, all: OnboardDep[]): OnboardDep | undefined {
  const id = PROVIDER_BY_BINARY[binary]
  return id ? all.find((dep) => dep.id === id) : undefined
}

/** Unmet prerequisites of `dep` that this app can install itself. */
export function missingProviders(dep: OnboardDep, all: OnboardDep[]): OnboardDep[] {
  return (dep.requirements ?? [])
    .filter((requirement) => !requirement.ok)
    .map((requirement) => providerFor(requirement.name, all))
    .filter((provider): provider is OnboardDep => !!provider && provider.status !== 'ok')
}

/** Something the user has to install themselves; `url` is '' when none is known. */
export interface ManualPrerequisite {
  name: string
  url: string
}

/**
 * What stops `dep`'s install chain from running to the end. Each entry is what
 * the user can go and get: a provider with no install command, or a binary no
 * dep provides. When that binary is needed further down the chain, the link
 * needing it is the entry instead: on Windows without winget the way out is
 * Node's own installer, not winget.
 */
export function manualPrerequisites(dep: OnboardDep, all: OnboardDep[]): ManualPrerequisite[] {
  const found = new Map<string, ManualPrerequisite>()
  const seen = new Set<string>()
  const report = (name: string, url: string): void => void found.set(name, { name, url })

  const visit = (link: OnboardDep): void => {
    if (seen.has(link.id)) return // cycle guard
    seen.add(link.id)
    for (const requirement of link.requirements ?? []) {
      if (requirement.ok) continue
      const provider = providerFor(requirement.name, all)
      if (!provider) {
        if (link === dep) report(requirement.name, '')
        else report(link.label, link.docs_url)
      } else if (provider.status !== 'ok') {
        if (provider.can_install) visit(provider)
        else report(provider.label, provider.docs_url)
      }
    }
  }

  visit(dep)
  return [...found.values()]
}

/**
 * `targets` in install order, with any installable prerequisite pulled in ahead
 * of whatever needs it — including prerequisites that were not in `targets` at
 * all (installing Claude Code on a bare Mac has to bring in Node, which has to
 * bring in Homebrew).
 *
 * Deps already installed, or with no install command, are dropped: they are not
 * steps the user can be walked through. Prerequisites that no registry dep
 * provides (`curl`) are left to the backend's bootstrap gate to report.
 */
export function orderInstalls(targets: OnboardDep[], all: OnboardDep[]): OnboardDep[] {
  const ordered: OnboardDep[] = []
  const placed = new Set<string>()
  const visiting = new Set<string>()

  const visit = (dep: OnboardDep): void => {
    if (placed.has(dep.id) || visiting.has(dep.id)) return // cycle guard
    visiting.add(dep.id)
    for (const provider of missingProviders(dep, all)) visit(provider)
    visiting.delete(dep.id)
    if (placed.has(dep.id)) return
    placed.add(dep.id)
    if (dep.status !== 'ok' && dep.can_install) ordered.push(dep)
  }

  for (const dep of targets) visit(dep)
  return ordered
}
