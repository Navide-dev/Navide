import type { PluginSource } from '../../../shared/pluginSource'

/** The badge text of a source. A test build prints its expiry as YYYY-MM-DD,
 *  or says the expiry is unknown when the Host sent none. */
export function pluginSourceLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  source: PluginSource,
  expiresAt?: string | null
): string {
  const date = (expiresAt ?? '').slice(0, 10)
  if (source === 'testplace' && !date) return t('pluginDisclosure.source.testplaceNoExpiry')
  return t(`pluginDisclosure.source.${source}`, { date })
}

/** Sources that keep a mark in the renderer chrome around a plugin view (DX
 *  report §10.4/§10.5): anything that is neither a reviewed Marketplace stable
 *  release nor shipped with Navide. The mark sits outside the guest, so the
 *  plugin's own content cannot cover or imitate it. */
export function chromeSourceMark(source: PluginSource | undefined): PluginSource | null {
  return source && source !== 'marketplace' && source !== 'factory-bundled' ? source : null
}
