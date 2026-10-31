/** The version of each first-party plugin the App bundles. A first-party
 * plugin versions independently of the App: its version changes only when the
 * plugin itself changes, and each entry must equal `version` in that plugin's
 * source manifest (`plugins/<dir>/manifest.json`), which the build copies into
 * the staged artifact. Bundled artifacts are looked up at
 * `official-artifacts/<id>/<this version>/<target>`, never by scanning. */
export const OFFICIAL_PLUGIN_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'navide.browser': '1.0.0',
  'navide.git': '1.0.0',
  'navide.mini-ide': '1.0.0',
  'navide.plans': '1.1.1',
})

/** The bundled versions that may supersede an older installed copy this
 * session: only ids whose bundled copy will be attempted. An opted-out factory
 * copy, or a forced legacy recovery the user asked for, keeps the installed
 * package in charge of that id. */
export function supersedingBundledVersions(opts: {
  optedOut: (pluginId: string) => boolean
  gitRecoveryForced: boolean
  plansRecoveryForced: boolean
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(OFFICIAL_PLUGIN_VERSIONS).filter(([pluginId]) =>
      !opts.optedOut(pluginId) &&
      !(pluginId === 'navide.git' && opts.gitRecoveryForced) &&
      !(pluginId === 'navide.plans' && opts.plansRecoveryForced)
    ),
  )
}

export function officialPluginVersion(pluginId: string): string {
  const version = OFFICIAL_PLUGIN_VERSIONS[pluginId]
  if (version === undefined) throw new Error(`'${pluginId}' is not an App-bundled plugin`)
  return version
}
