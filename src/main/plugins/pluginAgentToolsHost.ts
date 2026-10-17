import type {
  AgentToolCaller,
  AgentToolState,
  AgentToolSyncEntry,
  AgentToolsSyncPayload,
  AgentToolUnavailableReason,
} from '../../shared/pluginAgentTools'
import type { DisclosureAgentTool } from '../../shared/pluginDisclosure'
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
 * With the master switch (DB8) off since start-up nothing is sent and every
 * third-party `agentMethods` stays `[]`, exactly as on main.
 */

export type AgentToolPackageMark = 'quarantined' | 'revoked'

export interface PluginAgentToolsHostOptions {
  switches: () => AgentToolSwitches
  setSwitches: (change: Partial<AgentToolSwitches>) => void
  /** Installed, registered third-party backends (Plans excluded). */
  listPackages: () => ThirdPartyLaunchSpec[]
  /** The user's "Disabled" switch for the package or for its native backend. */
  isDisabled: (pluginId: string) => boolean
  /** Consent covers this exact package content, permission set and agent-tool
   * list (the consent recorded the tool-list digest). */
  hasConsent: (spec: ThirdPartyLaunchSpec) => Promise<boolean>
  /** When the user consented (ISO time); decides which of two same-named tools is served. */
  consentGrantedAt: (pluginId: string) => string | null
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
  identity: { packageVersion: string; packageDir: string } | null
}

export type AgentToolAdmission =
  | { ok: true; spec: ThirdPartyLaunchSpec; tool: DisclosureAgentTool }
  | { ok: false; reason: AgentToolUnavailableReason }

const UNAVAILABLE_MESSAGES: Record<AgentToolUnavailableReason, string> = {
  'master-switch-off': 'Agent tools from third-party Navide plugins are turned off.',
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
    const spec = this.known.get(pluginId) ?? this.options.listPackages().find((candidate) => candidate.pluginId === pluginId)
    // Sticky: the mark holds for this package version and directory, also
    // while it is still listed during a drain or when its removal fails,
    // until another version or directory replaces it or the user consents again.
    this.marks.set(pluginId, {
      kind: mark,
      identity: spec ? { packageVersion: spec.packageVersion, packageDir: spec.packageDir } : null,
    })
  }

  /** The user consented again: a revocation or quarantine of the old decision ends. */
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
      if (mark?.identity === null) {
        mark.identity = { packageVersion: spec.packageVersion, packageDir: spec.packageDir }
      } else if (
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
    return (await this.options.hasConsent(spec)) ? 'available' : 'consent-required'
  }

  private async refreshNow(): Promise<void> {
    const present = this.options.listPackages().filter((spec) => declaredTools(spec).length > 0)
    const registered = this.options.listPackages()
    this.updateKnown(present)
    const switches = this.options.switches()
    if (!switches.enabled) {
      for (const spec of registered) this.options.setAgentMethods(spec.pluginId, spec.packageVersion, [])
      this.catalog = []
      this.collided = new Set()
      if (this.lastSentEnabled === true) {
        this.push({ enabled: false, externalCallers: switches.externalCallers, tools: [] })
      }
      return
    }
    const presentIds = new Set(present.map((spec) => spec.pluginId))
    const specs = [...this.known.values()].sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0))
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
    // first keeps it; the other is listed as a collision and not served.
    const winners = new Map<string, AgentToolSyncEntry>()
    const order = (entry: AgentToolSyncEntry): string =>
      `${this.options.consentGrantedAt(entry.pluginId) ?? '￿'}\u0000${entry.pluginId}`
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
    if (!this.options.switches().enabled) return this.refreshNow()
    for (const spec of registered) {
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
    if (!switches.enabled) return { ok: false, reason: 'master-switch-off' }
    if (caller.kind !== 'pane' && !switches.externalCallers) return { ok: false, reason: 'external-callers-off' }
    const mark = this.marks.get(pluginId)?.kind
    if (mark) return { ok: false, reason: mark === 'quarantined' ? 'plugin-quarantined' : 'plugin-revoked' }
    const spec = this.options.listPackages().find((candidate) => candidate.pluginId === pluginId)
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
    const consented = await this.options.hasConsent(first.spec)
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
