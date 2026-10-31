/** The public plugin API this Navide release provides. Bump the minor when the
 * capability catalog gains a method or event (its `since` names this value);
 * the major changes only with the deprecation window in the Compatibility
 * policy. Kept as a tiny module so the sandboxed plugin preload can share it
 * without bundling the full capability catalog. */
export const PLUGIN_API_VERSION = '1.1.0'

const API_RANGE = /^[~^]?(\d+)\.\d+\.\d+$/

/** The major a manifest `apiVersion` range asks for, or null for another form. */
export function pluginApiMajor(range: string): number | null {
  const match = API_RANGE.exec(range)
  return match ? Number(match[1]) : null
}

/** False only for a range on a newer major than this Host provides. An older
 * major is not refused here: that needs the deprecation window first. */
export function isPluginApiSupported(range: string): boolean {
  const major = pluginApiMajor(range)
  return major === null || major <= Number(pluginApiMajor(PLUGIN_API_VERSION))
}
