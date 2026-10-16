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
}
