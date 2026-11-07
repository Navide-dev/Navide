import type { JsonValue } from './index.js'

/** Calling another installed plugin (contributes.api / permissions.plugins).
 *  The caller names the target in `permissions.plugins`; the target lists the
 *  package-local backend methods others may call in `contributes.api`. The
 *  Host forwards the call to the target's backend for the caller's workspace
 *  and records it in both plugins' Activity. */
export interface PluginsParams {
  'plugins.call': { pluginId: string; method: string; args: JsonValue }
}

export interface PluginsResults {
  'plugins.call': { result: JsonValue }
}
