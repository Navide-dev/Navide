import { PluginFactoryOptOutStore } from './pluginFactoryOptOutStore'

export const DISABLED_PLUGINS_FILE = '.navide-disabled-plugins.json'

/**
 * The user's per-package "Disabled" switch for installed Navide plugins. A
 * disabled package keeps its files, grants and storage; the Host only stops
 * registering its views and backend. It is the same owner-only id list as the
 * factory opt-outs, kept in its own file because an opt-out means "removed".
 */
export class PluginDisabledStore extends PluginFactoryOptOutStore {
  constructor(root: string) {
    super(root, DISABLED_PLUGINS_FILE)
  }

  /** Neither the store nor its backup can be read: the built-in Plans, Git,
   *  Mini-IDE and Browser count as disabled (fail closed) until the user resets the
   *  store in Settings → Extensions. Marketplace packages keep reading as
   *  enabled, as before. */
  protected override unreadableAnswer(pluginId: string): boolean {
    return BUILTIN_SWITCH_IDS.has(pluginId)
  }
}

/** The built-ins whose switch fails closed (same ids as the Host's list). */
const BUILTIN_SWITCH_IDS: ReadonlySet<string> = new Set(['navide.plans', 'navide.git', 'navide.mini-ide', 'navide.browser'])

export const BUILTIN_REMOVED_EARLIER_FILE = '.navide-builtin-removed-earlier.json'

/**
 * Built-ins (Git, Mini-IDE) an earlier Navide version removed. That removal
 * deleted their stored data; the upgrade turned it into Disabled, and this
 * record lets the Extensions row say the data is gone until the user enables
 * the plugin again.
 */
export class BuiltinRemovedEarlierStore extends PluginFactoryOptOutStore {
  constructor(root: string) {
    super(root, BUILTIN_REMOVED_EARLIER_FILE)
  }
}

/**
 * Built-ins can no longer be removed, only disabled. Turn a removal an earlier
 * version recorded into Disabled, before anything loads: the bundled package
 * comes back, off, with Enable one click away. The switch is written before the
 * opt-out is cleared, so an interrupted run leaves the package away (as before
 * the upgrade) and is finished on the next launch. Returns the migrated ids.
 */
export function migrateBuiltinRemovalsToDisabled(
  stores: {
    optOuts: PluginFactoryOptOutStore
    disabled: PluginDisabledStore
    removedEarlier: BuiltinRemovedEarlierStore
  },
  pluginIds: readonly string[],
  warn: (message: string) => void,
): string[] {
  const migrated: string[] = []
  for (const pluginId of pluginIds) {
    if (!stores.optOuts.has(pluginId)) continue
    try {
      stores.disabled.add(pluginId)
      stores.removedEarlier.add(pluginId)
      stores.optOuts.remove(pluginId)
      migrated.push(pluginId)
    } catch (error) {
      warn(`${pluginId} removal could not become Disabled: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return migrated
}
