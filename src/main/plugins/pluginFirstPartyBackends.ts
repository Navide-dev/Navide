import type { PlansBridgePort } from './plansBridge'

/**
 * The first-party Navide plugins whose package backend the Host launches
 * itself, outside the third-party admission gate (pluginThirdPartyBackends.ts):
 * no global "third-party native backends" switch, no per-version consent and
 * no OS sandbox requirement, so they also run on Windows. Each one carries the
 * exact bridge ports its backend may use.
 *
 * Membership is by plugin id. Every `navide.*` id is reserved
 * (isReservedPluginId), so only App-bundled or official-registry packages can
 * carry one. Any other id, including a look-alike such as `acme.browser`,
 * stays third-party. A first-party backend other than Plans also needs the
 * package itself to come from the Official Registry
 * ({@link isFirstPartyAgentToolActivation}).
 */
export const FIRST_PARTY_BACKEND_PLUGINS: ReadonlyMap<string, { readonly bridgePorts: readonly PlansBridgePort[] }> =
  new Map([
    // Plans keeps its own launch spec (plansBackendActivation); its ports here
    // are the same PLANS_BACKEND_BRIDGE_PORTS.
    ['navide.plans', { bridgePorts: Object.freeze(['filesystem'] as const) }],
    ['navide.browser', { bridgePorts: Object.freeze(['web'] as const) }],
  ])

/** Plans has its own launch spec and its own agent route; the other
 *  first-party backends are projected from their manifest. */
export const FIRST_PARTY_PLANS_PLUGIN_ID = 'navide.plans'

export function isFirstPartyBackendPlugin(pluginId: string): boolean {
  return FIRST_PARTY_BACKEND_PLUGINS.has(pluginId)
}

/** The bridge ports of one first-party backend, or null for any other id. */
export function firstPartyBridgePorts(pluginId: string): readonly PlansBridgePort[] | null {
  return FIRST_PARTY_BACKEND_PLUGINS.get(pluginId)?.bridgePorts ?? null
}

/** First-party backends that serve agent tools through PluginAgentToolsHost
 *  (every first-party backend except Plans). */
export function isFirstPartyAgentToolPlugin(pluginId: string): boolean {
  return pluginId !== FIRST_PARTY_PLANS_PLUGIN_ID && isFirstPartyBackendPlugin(pluginId)
}

/** One installed package of a first-party backend other than Plans: its id is
 *  on the list and the Official Registry installed it. The id alone is not
 *  enough: a package with any other provenance or a local source never gets
 *  the first-party exemption, whatever the install-time checks did. */
export function isFirstPartyAgentToolActivation(activation: {
  pluginId: string
  provenance?: string
  source?: string
}): boolean {
  return isFirstPartyAgentToolPlugin(activation.pluginId) &&
    activation.provenance === 'official-registry' &&
    activation.source !== 'local-unsigned' &&
    activation.source !== 'local-signed'
}
