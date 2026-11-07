import { PluginFactoryOptOutStore } from './pluginFactoryOptOutStore'

export const NETWORK_STRICT_PLUGINS_FILE = '.navide-plugin-network-strict.json'

/**
 * The user's per-package "Only allow declared network hosts" switch (C1,
 * 0.2.39, the user's decision of 11/7: a view's request to a host the
 * manifest does not declare is allowed and recorded by default). With the
 * switch on, both layers — the composed frame's Content-Security-Policy and
 * the session hook that judges a surface's requests — admit the declared
 * hosts only. The same owner-only id list as the Disabled switch; an
 * unreadable store reads as off (allow and record), never as a silent block.
 */
export class PluginNetworkStrictStore extends PluginFactoryOptOutStore {
  constructor(root: string) {
    super(root, NETWORK_STRICT_PLUGINS_FILE)
  }
}
