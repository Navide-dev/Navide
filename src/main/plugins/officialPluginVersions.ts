/** The version of each first-party plugin the App bundles. A first-party
 * plugin versions independently of the App: its version changes only when the
 * plugin itself changes, and each entry must equal `version` in that plugin's
 * source manifest (`plugins/<dir>/manifest.json`), which the build copies into
 * the staged artifact. Bundled artifacts are looked up at
 * `official-artifacts/<id>/<this version>/<target>`, never by scanning. */
export const OFFICIAL_PLUGIN_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  'navide.git': '1.0.0',
  'navide.mini-ide': '1.0.0',
  'navide.plans': '1.0.0',
})

export function officialPluginVersion(pluginId: string): string {
  const version = OFFICIAL_PLUGIN_VERSIONS[pluginId]
  if (version === undefined) throw new Error(`'${pluginId}' is not an App-bundled plugin`)
  return version
}
