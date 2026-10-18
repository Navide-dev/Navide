import type { PluginSource } from '../../../shared/pluginSource'

/** Sources that keep a mark in the renderer chrome around a plugin view (DX
 *  report §10.4/§10.5): anything that is neither a reviewed Marketplace stable
 *  release nor shipped with Navide. The mark sits outside the guest, so the
 *  plugin's own content cannot cover or imitate it. */
export function chromeSourceMark(source: PluginSource | undefined): PluginSource | null {
  return source && source !== 'marketplace' && source !== 'factory-bundled' ? source : null
}

/** Source of a Registry-signed package known only by its version, by the
 *  Host's rule (`isPrereleaseVersion` in pluginIpc.ts): a SemVer pre-release
 *  suffix is a pre-release; build metadata is not. */
export function registrySourceOfVersion(version: string): PluginSource {
  return version.split('+', 1)[0].includes('-') ? 'prerelease' : 'marketplace'
}
