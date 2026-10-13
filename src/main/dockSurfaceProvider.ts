/** The built-in plugin behind each embedded AI panel surface. Other surfaces
 *  (pm, in the main window) have no plugin to lose. */
const SURFACE_PLUGIN: Record<string, string> = {
  plans: 'navide.plans',
  git: 'navide.git',
  editor: 'navide.mini-ide',
}

/** Whether a restored panel on `surface` still has a plugin behind it: the
 *  installed package or the built-in fallback, both of which register a
 *  descriptor. A panel without one retires its record instead of resuming. */
export function dockSurfaceProvided(surface: string, hasPlugin: (pluginId: string) => boolean): boolean {
  const pluginId = SURFACE_PLUGIN[surface]
  return pluginId === undefined || hasPlugin(pluginId)
}

/** The panel surface a built-in plugin provides, if any. */
export function dockSurfaceForPlugin(pluginId: string): string | undefined {
  return Object.keys(SURFACE_PLUGIN).find((surface) => SURFACE_PLUGIN[surface] === pluginId)
}
