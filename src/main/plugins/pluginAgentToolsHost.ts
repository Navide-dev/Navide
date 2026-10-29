import type {
  AgentToolCaller,
  AgentToolState,
  AgentToolSyncEntry,
  AgentToolsSyncPayload,
  AgentToolUnavailableReason,
} from '../../shared/pluginAgentTools'
import type { DisclosureAgentTool } from '../../shared/pluginDisclosure'
import { isFirstPartyAgentToolPlugin } from './pluginFirstPartyBackends'
import type { AgentToolSwitches } from './pluginNativeBackendStore'
import { consentedAgentMethods, type ThirdPartyLaunchSpec } from './pluginThirdPartyBackends'

/**
 * Host side of plan B1-b: the third-party agent-tool catalog.
 *
 * The Host decides which consented agent tools of which installed third-party
 * Navide plugins an agent may call, pushes that catalog to the core backend
 * (`plugins.agentTools.sync`, contract section 4.1), keeps each backend's
 * `agentMethods` in step with it, and re-checks everything again on every
 * call (section 4.2), whatever the CLI or the backend has cached.
 *
 * Two switches decide which packages are served. The master switch (DB8, off
 * by default) covers third-party packages: while it is off every third-party
 * `agentMethods` stays `[]`, and with nothing else served nothing is sent,
 * exactly as on main. The first-party switch (on by default) covers Navide's
 * own packages the same way.
 *
 * First-party packages (pluginFirstPartyBackends.ts, listed through
 * `listFirstPartyPackages`) need no per-version consent for their tools and
 * keep their names against a third-party package.
 * Everything else still applies to them: the Disabled switch, quarantine and
 * revocation, the caller-kind switch, and, on the backend side, the
 * external-content wrapping and pane taint of every result. A package counts as first-party
 * only when it is listed there and its id is on the first-party list; a
 * third-party package never inherits the exemption, whatever its id.
 */

export type AgentToolPackageMark = 'quarantined' | 'revoked'

export interface PluginAgentToolsHostOptions {
  switches: () => AgentToolSwitches
  setSwitches: (change: Partial<AgentToolSwitches>) => void
  /** Installed, registered third-party backends (first-party ones excluded). */
  listPackages: () => ThirdPartyLaunchSpec[]
  /** The agent-tool catalog entries of registered first-party backends
   *  (firstPartyAgentToolSpec). An entry whose id is not on the first-party
   *  list is ignored. */
  listFirstPartyPackages?: () => ThirdPartyLaunchSpec[]
  /** The user's "Disabled" switch for the package or for its native backend. */
  isDisabled: (pluginId: string) => boolean
  /** Consent covers this exact package content, permission set and agent-tool
   * list (the consent recorded the tool-list digest). */
  hasConsent: (spec: ThirdPartyLaunchSpec) => Promise<boolean>
  /** When the user consented (ISO time); decides which of two same-named tools is served. */
  /** DB1 order for one tool name (B1-a's agentToolNamesSince, else agentToolsSince). */
  agentToolSince: (pluginId: string, name: string) => string | null
  setAgentMethods: (pluginId: string, packageVersion: string, methods: string[]) => void
  /** DB3 first-write confirmation for one (package, workspace). */
  confirmWrite: (spec: ThirdPartyLaunchSpec, tool: DisclosureAgentTool, workspaceRoot: string) => Promise<boolean>
  /** Deliver one snapshot to the core backend. `no-session`: nothing to send
   * to (a fresh snapshot follows registration); `failed`: retried, bounded. */
  send: (payload: AgentToolsSyncPayload) => Promise<AgentToolsSyncDelivery>
  /** Delays between retries of a failed push (default 1 s, 5 s, 15 s). */
  retryDelaysMs?: readonly number[]
}

export type AgentToolsSyncDelivery = 'delivered' | 'failed' | 'no-session'

interface PackageMark {
  kind: AgentToolPackageMark
  /** The package version and directory the mark applies to; another one clears it. */
  identity: { packageVersion: string; packageDir: string }
}

export type AgentToolAdmission =
  | { ok: true; spec: ThirdPartyLaunchSpec; tool: DisclosureAgentTool }
  | { ok: false; reason: AgentToolUnavailableReason }

const UNAVAILABLE_MESSAGES: Record<AgentToolUnavailableReason, string> = {
  'master-switch-off': 'Agent tools from this kind of Navide plugin (first-party or third-party) are turned off in Settings.',
  'external-callers-off': 'External MCP clients may not call third-party Navide plugin tools.',
  'plugin-not-installed': 'The Navide plugin is not installed.',
  'plugin-disabled': 'The Navide plugin is disabled.',
  'plugin-quarantined': 'The Navide plugin is quarantined.',
  'plugin-revoked': 'The Navide plugin was revoked.',
  'plugin-stopping': 'The Navide plugin is stopping.',
  'consent-required': 'The Navide plugin changed since the user allowed it.',
  'tool-not-consented': 'The user has not allowed this tool.',
  'name-collision': 'Another Navide plugin already provides a tool with this name.',
}

export function agentToolUnavailableMessage(reason: AgentToolUnavailableReason): string {
  return UNAVAILABLE_MESSAGES[reason]
}

function declaredTools(spec: ThirdPartyLaunchSpec): readonly DisclosureAgentTool[] {
  return spec.thirdParty.agentTools ?? []
}

export class PluginAgentToolsHost {
  private readonly options: PluginAgentToolsHostOptions
  private revision = 0
  /** What the backend was last told: null = nothing since start-up or reconnect. */
  private lastSentEnabled: boolean | null = null
  /** Last seen spec per package, kept while it is disabled, quarantined or revoked. */
  private readonly known = new Map<string, ThirdPartyLaunchSpec>()
  private readonly marks = new Map<string, PackageMark>()
  /** Packages that left the catalog without a mark (removed); kept so a
   * quarantine or revocation reported afterwards can still name its tools. */
  private readonly departed = new Map<string, ThirdPartyLaunchSpec>()
  /** `${pluginId}\0${tool}` entries that lost a name collision at the last refresh. */
  private collided = new Set<string>()
  private catalog: AgentToolSyncEntry[] = []
  private queue: Promise<void> = Promise.resolve()
  /** Ids that were listed as first-party, so a disabled, quarantined or
   *  revoked one keeps its first-party treatment. */
  private readonly firstPartyIds = new Set<string>()

  constructor(options: PluginAgentToolsHostOptions) {
    this.options = options
  }

  switches(): AgentToolSwitches {
    return this.options.switches()
  }

  async setSwitches(change: Partial<AgentToolSwitches>): Promise<AgentToolSwitches> {
    try {
      this.options.setSwitches(change)
    } finally {
      // Off takes effect even when the save failed (the store applies it in
      // memory first); the error still reaches the settings page.
      await this.refresh()
    }
    return this.switches()
  }

  /** A trust refresh quarantined, or a spawn-time trust check revoked, the package. */
  mark(pluginId: string, mark: AgentToolPackageMark): void {
    const departed = this.departed.get(pluginId)
    if (departed && !this.known.has(pluginId)) this.known.set(pluginId, departed)
    const spec = this.known.get(pluginId) ?? this.listAll().find((candidate) => candidate.pluginId === pluginId)
    // A mark names one package version and directory; with none known there
    // is nothing it could apply to, and it must not attach to a later install.
    if (!spec) return
    // Sticky: the mark holds for this package version and directory, also
    // while it is still listed during a drain or when its removal fails,
    // until another version or directory replaces it or the Host verifies
    // this one again.
    this.marks.set(pluginId, {
      kind: mark,
      identity: { packageVersion: spec.packageVersion, packageDir: spec.packageDir },
    })
  }

  /** The Host's trust check verified the package again (a trust refresh
   * restored it): its quarantine or revocation ends. A new consent does not. */
  clearMark(pluginId: string): void {
    this.marks.delete(pluginId)
  }

  /** The last catalog pushed or computed (empty while the switch is off). */
  snapshot(): AgentToolSyncEntry[] {
    return this.catalog.map((entry) => ({ ...entry }))
  }

  /** Recompute the catalog after any install, consent, disable, enable,
   * quarantine, revoke, remove, update or switch change, and push it. */
  refresh(): Promise<void> {
    const task = this.queue.then(() => this.refreshNow())
    this.queue = task.catch(() => undefined)
    return task
  }

  /** The backend (re)connected and registered: it starts from an empty catalog. */
  onBackendConnected(): Promise<void> {
    this.lastSentEnabled = null
    return this.refresh()
  }

  /** The first-party catalog entries listed now (ids off the list dropped). */
  private firstPartyPackages(): ThirdPartyLaunchSpec[] {
    const listed = (this.options.listFirstPartyPackages?.() ?? [])
      .filter((spec) => isFirstPartyAgentToolPlugin(spec.pluginId))
    for (const spec of listed) this.firstPartyIds.add(spec.pluginId)
    return listed
  }

  /** First-party entries, then the third-party packages with another id. */
  private listAll(firstParty = this.firstPartyPackages()): ThirdPartyLaunchSpec[] {
    const ids = new Set(firstParty.map((spec) => spec.pluginId))
    return [...firstParty, ...this.options.listPackages().filter((spec) => !ids.has(spec.pluginId))]
  }

  private updateKnown(present: ThirdPartyLaunchSpec[]): void {
    const presentIds = new Set(present.map((spec) => spec.pluginId))
    for (const pluginId of [...this.known.keys()]) {
      if (presentIds.has(pluginId)) continue
      if (!this.marks.has(pluginId) && !this.options.isDisabled(pluginId)) {
        this.departed.set(pluginId, this.known.get(pluginId)!)
        this.known.delete(pluginId)
      }
    }
    for (const spec of present) {
      this.known.set(spec.pluginId, spec)
      this.departed.delete(spec.pluginId)
      const mark = this.marks.get(spec.pluginId)
      if (
        mark &&
        (mark.identity.packageVersion !== spec.packageVersion || mark.identity.packageDir !== spec.packageDir)
      ) this.marks.delete(spec.pluginId)
    }
    for (const pluginId of [...this.marks.keys()]) {
      if (!this.known.has(pluginId)) this.marks.delete(pluginId)
    }
  }

  private async packageState(spec: ThirdPartyLaunchSpec, present: boolean): Promise<AgentToolState> {
    const mark = this.marks.get(spec.pluginId)?.kind
    if (mark === 'quarantined') return 'plugin-quarantined'
    if (mark === 'revoked') return 'plugin-revoked'
    if (!present || this.options.isDisabled(spec.pluginId)) return 'plugin-disabled'
    // First-party tools need no per-version consent.
    if (this.firstPartyIds.has(spec.pluginId)) return 'available'
    return (await this.options.hasConsent(spec)) ? 'available' : 'consent-required'
  }

  private async refreshNow(): Promise<void> {
    const registered = this.listAll()
    const present = registered.filter((spec) => declaredTools(spec).length > 0)
    this.updateKnown(present)
    const switches = this.options.switches()
    // Third-party packages follow the master switch, first-party ones theirs.
    const inScope = (pluginId: string): boolean =>
      this.firstPartyIds.has(pluginId) ? switches.firstParty !== false : switches.enabled
    if (!switches.enabled && ![...this.known.keys()].some(inScope)) {
      for (const spec of registered) this.options.setAgentMethods(spec.pluginId, spec.packageVersion, [])
      this.catalog = []
      this.collided = new Set()
      if (this.lastSentEnabled === true) {
        this.push({ enabled: false, externalCallers: switches.externalCallers, tools: [] })
      }
      return
    }
    const presentIds = new Set(present.map((spec) => spec.pluginId))
    const specs = [...this.known.values()].filter((spec) => inScope(spec.pluginId)).sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0))
    const entries: AgentToolSyncEntry[] = []
    for (const spec of specs) {
      const state = await this.packageState(spec, presentIds.has(spec.pluginId))
      for (const tool of declaredTools(spec)) {
        entries.push({
          pluginId: spec.pluginId,
          pluginVersion: spec.packageVersion,
          name: tool.name,
          title: tool.title,
          description: tool.description,
          risk: tool.risk,
          method: tool.method,
          timeoutMs: tool.timeoutMs,
          inputSchema: tool.inputSchema,
          state,
          permissions: spec.thirdParty.permissions ?? { system: [], shell: null, scopes: null },
        })
      }
    }
    // DB1: of two available tools with one name, the package the user allowed
    // first keeps it; the other is listed as a collision and not served. A
    // first-party package always keeps its names: a third-party package whose
    // id derives the same prefix (acme.browser) cannot take them over.
    const winners = new Map<string, AgentToolSyncEntry>()
    const order = (entry: AgentToolSyncEntry): string =>
      `${this.firstPartyIds.has(entry.pluginId) ? '0' : '1'}\u0000${
        this.options.agentToolSince(entry.pluginId, entry.name) ?? '￿'
      }\u0000${entry.pluginId}`
    for (const entry of entries) {
      if (entry.state !== 'available') continue
      const winner = winners.get(entry.name)
      if (!winner || order(entry) < order(winner)) winners.set(entry.name, entry)
    }
    const collided = new Set<string>()
    for (const entry of entries) {
      if (entry.state === 'available' && winners.get(entry.name) !== entry) {
        entry.state = 'name-collision'
        collided.add(`${entry.pluginId}\u0000${entry.name}`)
      }
    }
    // The switch may have been turned off while consent was being checked.
    const now = this.options.switches()
    if (now.enabled !== switches.enabled || (now.firstParty !== false) !== (switches.firstParty !== false)) {
      return this.refreshNow()
    }
    for (const spec of registered) {
      if (!inScope(spec.pluginId)) {
        this.options.setAgentMethods(spec.pluginId, spec.packageVersion, [])
        continue
      }
      // Only the tools actually served open their methods to agents.
      const served = new Set(entries
        .filter((entry) => entry.pluginId === spec.pluginId && entry.state === 'available')
        .map((entry) => entry.name))
      const servedSpec: ThirdPartyLaunchSpec = {
        ...spec,
        thirdParty: { ...spec.thirdParty, agentTools: declaredTools(spec).filter((tool) => served.has(tool.name)) },
      }
      this.options.setAgentMethods(
        spec.pluginId,
        spec.packageVersion,
        consentedAgentMethods(servedSpec, { masterSwitch: true, consentMatches: served.size > 0 }),
      )
    }
    this.catalog = entries
    this.collided = collided
    this.push({ enabled: true, externalCallers: this.options.switches().externalCallers, tools: entries })
  }

  private push(snapshot: Omit<AgentToolsSyncPayload, 'revision'>): void {
    this.revision += 1
    const payload: AgentToolsSyncPayload = { revision: this.revision, ...snapshot }
    // Synchronously known: the Host had a session to send to.
    this.lastSentEnabled = snapshot.enabled
    void this.deliver(payload, 0)
  }

  /** Send, and retry a failed push a bounded number of times while it is
   * still the newest snapshot. A reconnect sends a fresh one anyway. */
  private async deliver(payload: AgentToolsSyncPayload, attempt: number): Promise<void> {
    let delivery: AgentToolsSyncDelivery
    try {
      delivery = await this.options.send(payload)
    } catch {
      delivery = 'failed'
    }
    if (delivery === 'no-session') {
      if (payload.revision === this.revision) this.lastSentEnabled = null
      return
    }
    const delays = this.options.retryDelaysMs ?? [1_000, 5_000, 15_000]
    if (delivery !== 'failed' || attempt >= delays.length || payload.revision !== this.revision) return
    await new Promise<void>((done) => {
      const timer = setTimeout(done, delays[attempt])
      timer.unref?.()
    })
    if (payload.revision === this.revision) await this.deliver(payload, attempt + 1)
  }

  /** The synchronous part of the per-call check, in contract order up to the
   * consent check; run again after every wait. */
  recheck(
    pluginId: string,
    caller: AgentToolCaller,
    isStopping: (pluginId: string, packageVersion: string) => boolean,
    expected?: ThirdPartyLaunchSpec,
  ): { ok: true; spec: ThirdPartyLaunchSpec } | { ok: false; reason: AgentToolUnavailableReason } {
    const switches = this.options.switches()
    const firstParty = this.firstPartyPackages().find((candidate) => candidate.pluginId === pluginId)
    if (firstParty ? switches.firstParty === false : !switches.enabled) return { ok: false, reason: 'master-switch-off' }
    if (caller.kind !== 'pane' && !switches.externalCallers) {
      return { ok: false, reason: 'external-callers-off' }
    }
    const mark = this.marks.get(pluginId)?.kind
    if (mark) return { ok: false, reason: mark === 'quarantined' ? 'plugin-quarantined' : 'plugin-revoked' }
    const spec = firstParty ?? this.options.listPackages().find((candidate) => candidate.pluginId === pluginId)
    if (this.options.isDisabled(pluginId)) return { ok: false, reason: 'plugin-disabled' }
    if (!spec) return { ok: false, reason: 'plugin-not-installed' }
    if (isStopping(spec.pluginId, spec.packageVersion)) return { ok: false, reason: 'plugin-stopping' }
    if (expected && (spec.packageVersion !== expected.packageVersion || spec.packageDir !== expected.packageDir)) {
      // Updated or rolled back while the call waited: the new version needs its own checks.
      return { ok: false, reason: 'consent-required' }
    }
    return { ok: true, spec }
  }

  /** The Host checks of contract section 4.2 that belong to the catalog:
   * master switch, caller kind, package state, consent, consented tool,
   * name collision. The caller runs workspace, DB3, policy and binding. */
  async admit(
    request: { pluginId: string; toolName: string; pluginVersion: string; caller: AgentToolCaller },
    isStopping: (pluginId: string, packageVersion: string) => boolean,
  ): Promise<AgentToolAdmission> {
    const first = this.recheck(request.pluginId, request.caller, isStopping)
    if (!first.ok) return first
    // A listed first-party package needs no per-version consent.
    const consented = this.firstPartyPackages().some((candidate) => candidate.pluginId === first.spec.pluginId) ||
      await this.options.hasConsent(first.spec)
    // Hashing waits: a disable, quarantine, removal or switch change that
    // landed meanwhile wins.
    const again = this.recheck(request.pluginId, request.caller, isStopping, first.spec)
    if (!again.ok) return again
    if (!consented) return { ok: false, reason: 'consent-required' }
    const tool = declaredTools(again.spec).find((candidate) => candidate.name === request.toolName)
    if (!tool || request.pluginVersion !== again.spec.packageVersion) return { ok: false, reason: 'tool-not-consented' }
    if (this.collided.has(`${request.pluginId}\u0000${request.toolName}`)) return { ok: false, reason: 'name-collision' }
    return { ok: true, spec: again.spec, tool }
  }

  confirmWrite(spec: ThirdPartyLaunchSpec, tool: DisclosureAgentTool, workspaceRoot: string): Promise<boolean> {
    return this.options.confirmWrite(spec, tool, workspaceRoot)
  }
}
