/** The version of each first-party plugin the App bundles. A first-party
 * plugin versions independently of the App: its version changes only when the
 * plugin itself changes. For a plugin built here the entry must equal
 * `version` in its source manifest (`plugins/<dir>/manifest.json`), which the
 * build copies into the staged artifact; for one that lives in its own
 * repository (REGISTRY_SOURCED_OFFICIAL_PLUGINS) it pins the version the
 * build takes, Registry-signed, from the official Registry. Bundled artifacts
 * are looked up at `official-artifacts/<id>/<this version>/<target>`, never by
 * scanning. */
export const OFFICIAL_PLUGIN_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'navide.browser': '1.1.7',
  'navide.git': '1.0.10',
  'navide.mini-ide': '1.0.9',
  'navide.plans': '1.1.9',
})

/** First-party plugins developed in their own repositories: the installer
 * carries the pinned version as the official Registry signed it
 * (scripts/stage-official-plugin-artifacts.mjs). */
export const REGISTRY_SOURCED_OFFICIAL_PLUGINS: readonly string[] = ['navide.git']

/** The navide.git bridge contract version the pinned navide.git was built
 *  against (its src/git-feature/gitBridgeContract.json). Raise it with the
 *  pin when the new version was built against a newer contract. */
export const PINNED_GIT_BRIDGE_VERSION = '1.0.0'

/** Whether a Host serving bridge contract `host` can run a plugin built
 *  against `plugin`: the same major, and the Host's minor.patch at least the
 *  plugin's (a minor version only adds). */
export function gitBridgeCompatible(host: string, plugin: string): boolean {
  const parse = (version: string): number[] | null => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
    return match ? match.slice(1).map(Number) : null
  }
  const h = parse(host)
  const p = parse(plugin)
  if (!h || !p || h[0] !== p[0]) return false
  return h[1] > p[1] || (h[1] === p[1] && h[2] >= p[2])
}

/** The bundled versions that may supersede an older installed copy this
 * session: only ids whose bundled copy will be attempted. An opted-out factory
 * copy, or a forced legacy Plans recovery the user asked for, keeps the
 * installed package in charge of that id. */
export function supersedingBundledVersions(opts: {
  optedOut: (pluginId: string) => boolean
  plansRecoveryForced: boolean
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(OFFICIAL_PLUGIN_VERSIONS).filter(([pluginId]) =>
      !opts.optedOut(pluginId) &&
      !(pluginId === 'navide.plans' && opts.plansRecoveryForced)
    ),
  )
}

export function officialPluginVersion(pluginId: string): string {
  const version = OFFICIAL_PLUGIN_VERSIONS[pluginId]
  if (version === undefined) throw new Error(`'${pluginId}' is not an App-bundled plugin`)
  return version
}
