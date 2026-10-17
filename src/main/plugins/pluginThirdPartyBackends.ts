import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { readdir, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'
import {
  BackendPluginError,
  type BackendPluginLaunchSpec,
} from './pluginBackendSupervisor'
import {
  PlansBridgeError,
  type BackendBridgeDispatcher,
  type PlansBridgeContext,
  type PlansBridgeRequest,
  type PlansFilesystemPort,
} from './plansBridge'
import {
  createHostSandboxProbe,
  resolveBackendSandbox,
  sandboxedSpawnProcess,
  type BackendSandboxProbe,
} from './pluginBackendSandbox'
import {
  killEscapedSandboxProcesses,
  killSandboxProcessesSync,
  sandboxIdentity,
  watchBackendResources,
  type BackendResourceWatch,
  type ResourceViolation,
  type SandboxIdentity,
} from './pluginBackendResourceWatchdog'
import type { NativeBackendStore } from './pluginNativeBackendStore'
import { OFFICIAL_RECEIPT_NAME, type PluginActivationCatalogEntry } from './installedPlugins'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
} from './pluginInstalledTrust'
import { PLUGIN_QUARANTINE_MARKER } from './pluginInstallPaths'
import { isManifestV2, parseInstalledManifest } from './pluginManifest'
import { parseManifestJson } from './pluginManifestJson'
import type { PluginManifestV2, PluginSystemNamespace } from './pluginManifestV2'
import { canonicalExistingDirectory } from './workspacePathPolicy'
import { canonicalContractJson, computeDisclosure, type DisclosureAgentTool } from '../../shared/pluginDisclosure'

/**
 * Admission control for third-party package backends (every package backend
 * other than the first-party Plans package).
 *
 * A third-party child starts only when ALL of these hold, checked again before
 * every (re)spawn: the global switch is on, the user has not disabled the
 * plugin, the user consented to this exact binary and permission set, the
 * platform sandbox is available, and the crash breaker is closed. The child
 * then runs under the OS sandbox and the resource watchdog, and reaches the
 * Host only through a filesystem bridge limited to its bound workspace.
 * MCP agents never reach third-party methods (no `agentMethods`). Declared
 * agent tools are part of what the user consents to (backendPermissionsKey)
 * and are listed in the consent dialog; serving them is not wired here.
 */

export type ThirdPartyBackendInfo = NonNullable<BackendPluginLaunchSpec['thirdParty']>

export type ThirdPartyLaunchSpec = BackendPluginLaunchSpec & { thirdParty: ThirdPartyBackendInfo }

export function isThirdPartyLaunchSpec(activation: BackendPluginLaunchSpec): activation is ThirdPartyLaunchSpec {
  return activation.thirdParty !== undefined
}

/** Read the Host-owned manifest of an installed v2 package. */
export function readInstalledManifestV2(packageDir: string): PluginManifestV2 {
  const manifest = parseInstalledManifest(parseManifestJson(readFileSync(join(packageDir, 'manifest.json'), 'utf8')))
  if (!isManifestV2(manifest)) throw new Error('third-party backend requires a Manifest v2 package')
  return manifest
}

/** Project one installed package's backend into a sandboxed launch spec. The
 * method/event allowlists come from the manifest; the only bridge port is the
 * workspace filesystem, and only when the package declares `fs`. A backend
 * that declares no methods can never be called, so it is never started. */
export function thirdPartyBackendLaunchSpec(
  activation: PluginActivationCatalogEntry,
  manifest: PluginManifestV2 = readInstalledManifestV2(activation.packageDir),
): ThirdPartyLaunchSpec | null {
  if (!activation.backend || !manifest.backend || manifest.id !== activation.pluginId) return null
  if (!manifest.backend.methods?.length) return null
  const system = [...(manifest.permissions.system ?? [])]
  const agentTools = computeDisclosure(manifest).agentTools
  return {
    pluginId: activation.pluginId,
    packageVersion: activation.packageVersion,
    packageDir: activation.packageDir,
    entryFile: activation.backend.entryFile,
    protocolVersion: activation.backend.protocolVersion,
    activation: activation.backend.activation,
    approvedMethods: [...(manifest.backend.methods ?? [])],
    agentMethods: [],
    approvedEvents: [...(manifest.backend.events ?? [])],
    approvedBridgePorts: system.includes('fs') ? ['filesystem'] : [],
    thirdParty: {
      name: manifest.name,
      system,
      ...(manifest.permissions.shell ? { shell: manifest.permissions.shell } : {}),
      ...(agentTools.length > 0 ? { agentTools } : {}),
    },
  }
}

/** SHA-256 of the canonical spelling of the disclosure's `agentTools` array.
 * Any change to any tool (name, method, risk, text, schema, timeout) changes it. */
export function agentToolsDigest(agentTools: readonly DisclosureAgentTool[]): string {
  return createHash('sha256').update(canonicalContractJson(agentTools)).digest('hex')
}

/** Canonical permission set a consent is bound to. The agent tools digest is
 * part of it only when the package declares tools, so a package without them
 * keeps the key (and the consent records) it had before agent tools existed. */
export function backendPermissionsKey(spec: ThirdPartyLaunchSpec): string {
  const agentTools = spec.thirdParty.agentTools ?? []
  return JSON.stringify({
    system: [...spec.thirdParty.system].sort(),
    shell: spec.thirdParty.shell ?? null,
    methods: [...spec.approvedMethods].sort(),
    events: [...spec.approvedEvents].sort(),
    ...(agentTools.length > 0 ? { agentTools: agentToolsDigest(agentTools) } : {}),
  })
}

/** A declared agent tool whose name an earlier package already holds. */
export interface AgentToolNameCollision {
  name: string
  /** Plugin id of the package that holds the name. */
  heldBy: string
}

export interface AgentToolNameClaimant {
  pluginId: string
  /** When the package began declaring agent tools (ISO 8601); unknown sorts last. */
  since?: string
  /** Per name, when a consented version first declared it; overrides `since`. */
  sinceByName?: Readonly<Record<string, string>>
  names: readonly string[]
}

/**
 * DB1: when two packages declare the same tool name, the one whose consent
 * first covered that name holds it and the later one's tool stays offline
 * (sync state `name-collision`). The order is per name, so a name an update
 * adds ranks from that update and cannot take over one another package
 * already holds. Ties fall back to plugin id order, so the answer never
 * depends on the order the packages are listed in.
 */
export function agentToolNameCollisions(
  claimants: readonly AgentToolNameClaimant[],
): Map<string, AgentToolNameCollision[]> {
  const byName = new Map<string, Array<{ pluginId: string; since?: string }>>()
  for (const claimant of claimants) {
    for (const name of claimant.names) {
      const since = claimant.sinceByName?.[name] ?? claimant.since
      byName.set(name, [...(byName.get(name) ?? []), { pluginId: claimant.pluginId, since }])
    }
  }
  const collisions = new Map<string, AgentToolNameCollision[]>()
  for (const claimant of claimants) {
    for (const name of claimant.names) {
      const [holder] = [...(byName.get(name) ?? [])].sort((left, right) => {
        if (left.since !== right.since) {
          if (left.since === undefined) return 1
          if (right.since === undefined) return -1
          return left.since < right.since ? -1 : 1
        }
        return left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0
      })
      if (holder && holder.pluginId !== claimant.pluginId) {
        collisions.set(claimant.pluginId, [...(collisions.get(claimant.pluginId) ?? []), { name, heldBy: holder.pluginId }])
      }
    }
  }
  return collisions
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** Files the Host itself writes into an installed package directory. They
 * are not author content (the installer refuses them in an archive). */
const HOST_OWNED_PACKAGE_FILES = new Set([
  OFFICIAL_RECEIPT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  PLUGIN_QUARANTINE_MARKER,
  '.navide-backend-activation.json',
])

/**
 * Digest of the whole package: every regular file's relative path and
 * content, sorted. Consent binds to this. A narrower "native files only"
 * digest is not enough: a backend can read any package file (an asset, a
 * script, bytecode), decode it into its data directory and load it as code,
 * so any changed file can change what runs. A version that only changes
 * frontend files therefore asks again too.
 */
export async function packageContentDigest(packageDir: string): Promise<string> {
  const entries: Array<[string, string]> = []
  const pending = ['']
  while (pending.length > 0) {
    const relative = pending.pop()!
    for (const entry of await readdir(join(packageDir, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (!relative && HOST_OWNED_PACKAGE_FILES.has(entry.name)) continue
      if (entry.isDirectory()) {
        // Directory names are author content too (the installer extracts
        // empty directories), so they count even when empty.
        entries.push([child, 'dir'])
        pending.push(child)
      } else if (entry.isSymbolicLink()) {
        // The installer refuses links; should one exist, its target counts.
        entries.push([child, `link:${await readlink(join(packageDir, child))}`])
      } else if (entry.isFile()) {
        entries.push([child, await sha256File(join(packageDir, child))])
      } else {
        entries.push([child, 'special'])
      }
    }
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

export type NativeBackendStatus =
  | 'ready'
  | 'disabled-globally'
  | 'disabled'
  | 'needs-consent'
  | 'sandbox-unavailable'
  | 'shell-not-allowed'
  | 'stopped-after-crashes'
  | 'unavailable'

/** One declared agent tool as the Extensions page shows it. */
export interface NativeBackendAgentToolRow {
  name: string
  title: string
  description: string
  risk: DisclosureAgentTool['risk']
  timeoutMs: number
  method: string
  /** The whole input schema the agent reads in tools/list. */
  inputSchema: Record<string, unknown>
  /** Set when an earlier package holds this name: the tool stays offline. */
  collidesWith?: string
  /** On the holder: the later packages that also declare this name. */
  sharedWith?: string[]
}

export interface NativeBackendStatusRow {
  pluginId: string
  packageVersion: string
  name: string
  status: NativeBackendStatus
  reason?: string
  /** Declared agent tools; absent when the package declares none. */
  agentTools?: NativeBackendAgentToolRow[]
  /** Consent exists but for another binary or permission set. */
  changedSinceConsent: boolean
  canWriteWorkspace: boolean
  workspaceWrite: string[]
  lastViolation?: ResourceViolation
}

export interface NativeBackendConsentPrompt {
  pluginId: string
  name: string
  packageVersion: string
  system: PluginSystemNamespace[]
  methods: string[]
  /** Declared agent tools, listed in the dialog; empty when there are none. */
  agentTools: DisclosureAgentTool[]
  /** A consent existed for a different binary or permission set. */
  update: boolean
}

export interface NativeBackendWritePrompt {
  pluginId: string
  name: string
  workspacePath: string
}

export interface ThirdPartyAdmission {
  spawnProcess: (entryFile: string, options: SpawnOptions) => ChildProcessWithoutNullStreams
  bridgeDispatcher: BackendBridgeDispatcher
  /** Re-check every gate immediately before each (re)spawn. */
  beforeSpawn: () => Promise<void>
  /** Record a child failure; returns the restart delay, or null to stay down. */
  noteFailure: () => number | null
  /** Canonical workspace root for the filesystem bridge, when granted. */
  workspaceRoot?: string
}

export interface ThirdPartyBackendControllerOptions {
  store: NativeBackendStore
  /** Root for per-plugin private data directories. */
  dataRoot: string
  probe?: BackendSandboxProbe
  /** Ask the user to run this backend. Absent = never prompt (deny). */
  promptConsent?: (prompt: NativeBackendConsentPrompt) => Promise<boolean>
  /** Ask the user to allow file changes in one workspace. Absent = deny. */
  promptWorkspaceWrite?: (prompt: NativeBackendWritePrompt) => Promise<boolean>
  /** Host filesystem service port (the same service Plans uses). */
  filesystemPort?: () => PlansFilesystemPort | undefined
  /** Stop running children: one plugin, or every third-party plugin (null). */
  stopBackends?: (pluginId: string | null) => Promise<void>
  watchResources?: (
    pid: number,
    dataDir: string,
    onViolation: (violation: ResourceViolation) => void,
  ) => BackendResourceWatch
  /** Digest the consent binds to (default: packageContentDigest). */
  digestBackend?: (spec: ThirdPartyLaunchSpec) => Promise<string>
  /** Kill what is left of one sandbox after its child exits (default: killSandboxProcessesSync). */
  killSandbox?: (rootPid: number | null, identity: SandboxIdentity) => void
  /** Remove escapees left by earlier launches, before a spawn (default: killEscapedSandboxProcesses). */
  sweepEscapees?: (identity: SandboxIdentity) => Promise<unknown>
  /** The user's real home, whose sensitive entries are hidden from stat. */
  homeDir?: string
  now?: () => number
  spawnImpl?: Parameters<typeof sandboxedSpawnProcess>[2]
}

/** Restart delays after consecutive failures; the next one stays down. */
export const BACKEND_RESTART_DELAYS_MS = [1_000, 5_000, 30_000] as const
export const BACKEND_CRASH_WINDOW_MS = 10 * 60_000

/** Record one child failure for `key` and return the restart delay, or null
 * once more failures than restart delays fell inside the crash window. */
export function noteBackendFailure(failures: Map<string, number[]>, key: string, now: number): number | null {
  const recent = (failures.get(key) ?? []).filter((at) => now - at < BACKEND_CRASH_WINDOW_MS)
  recent.push(now)
  failures.set(key, recent)
  if (recent.length > BACKEND_RESTART_DELAYS_MS.length) return null
  return BACKEND_RESTART_DELAYS_MS[recent.length - 1]
}

const PACKAGE_FS_READ_OPERATIONS = new Set(['read_file', 'read_range', 'list_dir', 'stat_path'])
const PACKAGE_FS_WRITE_OPERATIONS = new Set([
  'write_file', 'write_part', 'write_commit', 'write_abort', 'delete', 'rename',
])

/** The sandbox profile matches canonical paths, so the entry must resolve
 * inside the canonical package directory. */
function canonicalSandboxPaths(spec: ThirdPartyLaunchSpec, dataDir: string) {
  const packageDir = realpathSync(spec.packageDir)
  const entryFile = realpathSync(spec.entryFile)
  if (!entryFile.startsWith(`${packageDir}/`)) {
    throw unavailable('backend entry resolves outside its package')
  }
  return { packageDir, dataDir, entryFile }
}

function unavailable(message: string): BackendPluginError {
  return new BackendPluginError('BACKEND_UNAVAILABLE', message)
}

export class ThirdPartyBackendController {
  private readonly store: NativeBackendStore
  private readonly dataRoot: string
  private readonly probe: BackendSandboxProbe
  private readonly options: ThirdPartyBackendControllerOptions
  private readonly digestBackend: (spec: ThirdPartyLaunchSpec) => Promise<string>
  private readonly now: () => number
  /** Per-session "not now" answers: no prompt again for the same identity. */
  private readonly declinedConsent = new Set<string>()
  private readonly declinedWrite = new Set<string>()
  private readonly pendingPrompts = new Map<string, Promise<boolean>>()
  private readonly failures = new Map<string, number[]>()
  private readonly tripped = new Set<string>()
  private readonly lastViolation = new Map<string, ResourceViolation>()

  constructor(options: ThirdPartyBackendControllerOptions) {
    this.options = options
    this.store = options.store
    this.dataRoot = options.dataRoot
    this.probe = options.probe ?? createHostSandboxProbe()
    this.digestBackend = options.digestBackend ?? ((spec) => packageContentDigest(spec.packageDir))
    this.now = options.now ?? Date.now
  }

  dataDirFor(pluginId: string): string {
    return join(this.dataRoot, pluginId)
  }

  private sandboxFor(spec: ThirdPartyLaunchSpec) {
    return resolveBackendSandbox(
      { packageDir: spec.packageDir, dataDir: this.dataDirFor(spec.pluginId), entryFile: spec.entryFile },
      this.probe,
    )
  }

  /** Static gates (no prompt, no hashing). */
  private staticRefusal(spec: ThirdPartyLaunchSpec): { status: NativeBackendStatus; reason: string } | null {
    if (spec.thirdParty.shell) {
      return { status: 'shell-not-allowed', reason: 'third-party backends cannot also declare shell access' }
    }
    if (this.store.record(spec.pluginId).disabled) {
      return { status: 'disabled', reason: 'the native backend is disabled for this plugin' }
    }
    const sandbox = this.sandboxFor(spec)
    if (!sandbox.available) return { status: 'sandbox-unavailable', reason: sandbox.reason }
    if (this.tripped.has(spec.pluginId)) {
      return { status: 'stopped-after-crashes', reason: 'the native backend failed repeatedly and was stopped' }
    }
    return null
  }

  /** The gates that can change at any moment: switches, breaker, sandbox. */
  private assertAdmissible(spec: ThirdPartyLaunchSpec): void {
    // The global switch first: while it is off, that is the answer.
    if (!this.store.isEnabled()) throw unavailable('third-party native backends are turned off')
    const refusal = this.staticRefusal(spec)
    if (refusal) throw unavailable(refusal.reason)
  }

  private consentMatches(spec: ThirdPartyLaunchSpec, digest: string): boolean {
    const consent = this.store.record(spec.pluginId).consent
    return consent?.binarySha256 === digest && consent.permissionsKey === backendPermissionsKey(spec)
  }

  /** Decide whether the child may start; asks for consent when `prompt`
   * allows it. The global switch is never turned on from here: off means off. */
  async admit(
    spec: ThirdPartyLaunchSpec,
    workspacePath?: string,
    options: { prompt?: boolean } = {},
  ): Promise<ThirdPartyAdmission> {
    this.forgetDroppedAgentTools(spec)
    this.assertAdmissible(spec)
    const digest = await this.digestBackend(spec)
    if (!this.consentMatches(spec, digest)) {
      if (options.prompt === false) throw unavailable('the native backend has not been allowed')
      await this.requestConsent(spec, digest)
    }
    // Hashing and the consent dialog both wait; check the switches again.
    this.assertAdmissible(spec)
    const sandbox = this.sandboxFor(spec)
    if (!sandbox.available) throw unavailable(sandbox.reason)

    const dataDir = this.dataDirFor(spec.pluginId)
    mkdirSync(join(dataDir, 'tmp'), { recursive: true, mode: 0o700 })
    const canonicalDataDir = realpathSync(dataDir)
    const paths = { ...canonicalSandboxPaths(spec, canonicalDataDir), homeDir: this.options.homeDir ?? homedir() }
    const resolved = resolveBackendSandbox(paths, this.probe)
    if (!resolved.available) throw unavailable(resolved.reason)
    const spawnSandboxed = sandboxedSpawnProcess(resolved, paths, this.options.spawnImpl)
    const identity = sandboxIdentity(paths.packageDir, canonicalDataDir)
    const killSandbox = this.options.killSandbox ?? ((rootPid, id) => {
      killSandboxProcessesSync(rootPid, id)
    })

    const workspaceRoot = spec.thirdParty.system.includes('fs') && workspacePath
      ? canonicalExistingDirectory(workspacePath) ?? undefined
      : undefined

    return {
      spawnProcess: (entryFile, options) => {
        const child = spawnSandboxed(entryFile, options)
        if (typeof child.pid === 'number') {
          const rootPid = child.pid
          const report = (violation: ResourceViolation): void => {
            this.lastViolation.set(spec.pluginId, violation)
            console.warn(`[plugin-backend] ${spec.pluginId} exceeded its ${violation} limit and was stopped`)
          }
          const watch = this.options.watchResources
            ? this.options.watchResources(rootPid, canonicalDataDir, report)
            : watchBackendResources(rootPid, canonicalDataDir, report, undefined, undefined, identity)
          // Registered before the supervisor's own listener, so the whole
          // sandbox is gone before a stop, idle close or quit completes.
          child.once('exit', () => {
            watch.dispose()
            killSandbox(rootPid, identity)
          })
        }
        return child
      },
      bridgeDispatcher: this.packageBridgeDispatcher(spec),
      beforeSpawn: async () => {
        // Processes left over from an earlier launch (or an earlier Host run)
        // that escaped to launchd are removed before a new child starts,
        // without blocking the main thread.
        await (this.options.sweepEscapees ?? killEscapedSandboxProcesses)(identity)
        this.assertAdmissible(spec)
        const digest = await this.digestBackend(spec)
        // The switches may have changed while the package was being hashed.
        this.assertAdmissible(spec)
        if (!this.consentMatches(spec, digest)) {
          throw unavailable('the native backend changed since it was allowed')
        }
      },
      noteFailure: () => this.noteFailure(spec.pluginId),
      ...(workspaceRoot ? { workspaceRoot } : {}),
    }
  }

  private async requestConsent(spec: ThirdPartyLaunchSpec, digest: string): Promise<void> {
    const identity = `${spec.pluginId}\n${digest}\n${backendPermissionsKey(spec)}`
    if (this.declinedConsent.has(identity) || !this.options.promptConsent) {
      throw unavailable('the native backend has not been allowed')
    }
    // One prompt per identity at a time: concurrent binds share the answer.
    let pending = this.pendingPrompts.get(identity)
    if (!pending) {
      const consent = this.store.record(spec.pluginId).consent
      pending = this.options.promptConsent({
        pluginId: spec.pluginId,
        name: spec.thirdParty.name,
        packageVersion: spec.packageVersion,
        system: [...spec.thirdParty.system],
        methods: [...spec.approvedMethods],
        agentTools: [...(spec.thirdParty.agentTools ?? [])],
        update: consent !== undefined,
      }).catch(() => false)
      this.pendingPrompts.set(identity, pending)
      void pending.finally(() => this.pendingPrompts.delete(identity))
    }
    if (!(await pending)) {
      this.declinedConsent.add(identity)
      throw unavailable('the user did not allow the native backend')
    }
    if (!this.store.isEnabled()) throw unavailable('third-party native backends are turned off')
    if (!this.consentMatches(spec, digest)) {
      this.store.grantConsent(spec.pluginId, {
        binarySha256: digest,
        permissionsKey: backendPermissionsKey(spec),
        packageVersion: spec.packageVersion,
      })
      this.noteAgentTools(spec)
    }
  }

  /** Record when the user first allowed a version of this package that
   * declares agent tools (the DB1 order; unique across packages, so there is
   * never a tie). Bookkeeping only: a failed save never affects admission. */
  private noteAgentTools(spec: ThirdPartyLaunchSpec): void {
    if (!spec.thirdParty.agentTools?.length) return
    try {
      this.store.noteAgentToolsSince(
        spec.pluginId,
        new Date(this.now()),
        spec.thirdParty.agentTools.map((tool) => tool.name),
      )
    } catch {
      // The package then holds no names until its next consent.
    }
  }

  /** A version that declares no tools gives up its place in the DB1 order:
   * declaring tools again later counts from that later consent. */
  private forgetDroppedAgentTools(spec: ThirdPartyLaunchSpec): void {
    if (spec.thirdParty.agentTools?.length) return
    try {
      this.store.clearAgentToolsSince(spec.pluginId)
    } catch {
      // Retried on the next admission or listing.
    }
  }

  /** Whether the user's consent covers this exact tool set. */
  private agentToolsConsented(spec: ThirdPartyLaunchSpec): boolean {
    return this.store.record(spec.pluginId).consent?.permissionsKey === backendPermissionsKey(spec)
  }

  private noteFailure(pluginId: string): number | null {
    const delay = noteBackendFailure(this.failures, pluginId, this.now())
    if (delay === null) this.tripped.add(pluginId)
    return delay
  }

  /** Workspace filesystem bridge for one third-party backend: reads inside the
   * bound workspace; writes only after a per-workspace user grant. */
  private packageBridgeDispatcher(spec: ThirdPartyLaunchSpec): BackendBridgeDispatcher {
    return Object.freeze({
      dispatch: async (request: PlansBridgeRequest, context: PlansBridgeContext) => {
        if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
        if (request.port !== 'filesystem' || !spec.thirdParty.system.includes('fs')) {
          throw new PlansBridgeError('CAPABILITY_DENIED')
        }
        const port = this.options.filesystemPort?.()
        if (!port) throw new PlansBridgeError('BACKEND_UNAVAILABLE')
        const root = context.authorizedPlanRoot
        if (!root) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
        if (PACKAGE_FS_WRITE_OPERATIONS.has(request.operation)) {
          if (!(await this.ensureWorkspaceWrite(spec, root))) throw new PlansBridgeError('CAPABILITY_DENIED')
        } else if (!PACKAGE_FS_READ_OPERATIONS.has(request.operation)) {
          throw new PlansBridgeError('METHOD_NOT_FOUND')
        }
        switch (request.operation) {
          case 'read_file': return port.readFile(request.arguments, context)
          case 'read_range': return port.readRange(request.arguments, context)
          case 'list_dir': return port.listDir(request.arguments, context)
          case 'stat_path': return port.statPath(request.arguments, context)
          case 'write_file': return port.writeFile(request.arguments, context)
          case 'write_part': return port.writePart(request.arguments, context)
          case 'write_commit': return port.writeCommit(request.arguments, context)
          case 'write_abort': return port.writeAbort(request.arguments, context)
          case 'delete': return port.delete(request.arguments, context)
          case 'rename': return port.rename(request.arguments, context)
        }
        throw new PlansBridgeError('METHOD_NOT_FOUND')
      },
    })
  }

  private async ensureWorkspaceWrite(spec: ThirdPartyLaunchSpec, workspacePath: string): Promise<boolean> {
    if (this.store.allowsWorkspaceWrite(spec.pluginId, workspacePath)) return true
    const identity = `${spec.pluginId}\n${workspacePath}`
    if (this.declinedWrite.has(identity) || !this.options.promptWorkspaceWrite) return false
    let pending = this.pendingPrompts.get(`write\n${identity}`)
    if (!pending) {
      pending = this.options.promptWorkspaceWrite({
        pluginId: spec.pluginId,
        name: spec.thirdParty.name,
        workspacePath,
      }).catch(() => false)
      this.pendingPrompts.set(`write\n${identity}`, pending)
      void pending.finally(() => this.pendingPrompts.delete(`write\n${identity}`))
    }
    if (!(await pending)) {
      this.declinedWrite.add(identity)
      return false
    }
    this.store.setWorkspaceWrite(spec.pluginId, workspacePath, true)
    return true
  }

  async status(spec: ThirdPartyLaunchSpec): Promise<NativeBackendStatusRow> {
    const record = this.store.record(spec.pluginId)
    let digest: string | null = null
    try {
      digest = await this.digestBackend(spec)
    } catch {
      digest = null
    }
    const matches = digest !== null && this.consentMatches(spec, digest)
    const refusal = this.staticRefusal(spec)
    let status: NativeBackendStatus
    let reason: string | undefined
    if (digest === null) {
      status = 'unavailable'
      reason = 'the backend executable cannot be read'
    } else if (!this.store.isEnabled()) {
      status = 'disabled-globally'
    } else if (refusal) {
      status = refusal.status
      reason = refusal.reason
    } else {
      status = matches ? 'ready' : 'needs-consent'
    }
    const lastViolation = this.lastViolation.get(spec.pluginId)
    return {
      pluginId: spec.pluginId,
      packageVersion: spec.packageVersion,
      name: spec.thirdParty.name,
      status,
      ...(reason ? { reason } : {}),
      changedSinceConsent: record.consent !== undefined && !matches,
      canWriteWorkspace: spec.thirdParty.system.includes('fs'),
      workspaceWrite: record.workspaceWrite ?? [],
      ...(lastViolation ? { lastViolation } : {}),
      ...(spec.thirdParty.agentTools?.length
        ? {
            agentTools: spec.thirdParty.agentTools.map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              risk: tool.risk,
              timeoutMs: tool.timeoutMs,
              method: tool.method,
              inputSchema: tool.inputSchema,
            })),
          }
        : {}),
    }
  }

  /** Rows for every listed package, with DB1 name collisions marked in both
   * rows. Only a package whose consent covers its current tool set, that the
   * user has not disabled and that has its consent time recorded holds names;
   * a package that declares tools no longer gives its place up. */
  async statuses(specs: readonly ThirdPartyLaunchSpec[]): Promise<NativeBackendStatusRow[]> {
    for (const spec of specs) this.forgetDroppedAgentTools(spec)
    const rows = await Promise.all(specs.map((spec) => this.status(spec)))
    const claimants = specs.flatMap((spec, index) => {
      const row = rows[index]
      const record = this.store.record(spec.pluginId)
      return row.agentTools && !record.disabled && record.agentToolsSince !== undefined && this.agentToolsConsented(spec)
        ? [{
            pluginId: row.pluginId,
            since: record.agentToolsSince,
            sinceByName: record.agentToolNamesSince,
            names: row.agentTools.map((tool) => tool.name),
          }]
        : []
    })
    const collisions = agentToolNameCollisions(claimants)
    const sharedWith = new Map<string, Map<string, string[]>>()
    for (const [loser, lost] of collisions) {
      for (const { name, heldBy } of lost) {
        const byName = sharedWith.get(heldBy) ?? new Map<string, string[]>()
        byName.set(name, [...(byName.get(name) ?? []), loser].sort())
        sharedWith.set(heldBy, byName)
      }
    }
    return rows.map((row) => {
      const lost = collisions.get(row.pluginId)
      const shared = sharedWith.get(row.pluginId)
      if ((!lost && !shared) || !row.agentTools) return row
      return {
        ...row,
        agentTools: row.agentTools.map((tool) => {
          const collision = lost?.find((entry) => entry.name === tool.name)
          const others = shared?.get(tool.name)
          return {
            ...tool,
            ...(collision ? { collidesWith: collision.heldBy } : {}),
            ...(others ? { sharedWith: others } : {}),
          }
        }),
      }
    })
  }

  /** User consent from the Extensions page (no prompt). */
  async allow(spec: ThirdPartyLaunchSpec): Promise<void> {
    const digest = await this.digestBackend(spec)
    this.store.grantConsent(spec.pluginId, {
      binarySha256: digest,
      permissionsKey: backendPermissionsKey(spec),
      packageVersion: spec.packageVersion,
    })
    this.noteAgentTools(spec)
    this.resetFailures(spec.pluginId)
  }

  resetFailures(pluginId: string): void {
    this.failures.delete(pluginId)
    this.tripped.delete(pluginId)
    this.lastViolation.delete(pluginId)
    for (const identity of [...this.declinedConsent]) {
      if (identity.startsWith(`${pluginId}\n`)) this.declinedConsent.delete(identity)
    }
  }

  /** Global kill switch. Turning it off stops every third-party child. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      this.store.setEnabled(true)
      return
    }
    // Fail closed: the store applies "off" in memory before saving, and the
    // children stop even when the save throws (the error still reaches the UI).
    try {
      this.store.setEnabled(false)
    } finally {
      await this.options.stopBackends?.(null)
    }
  }

  /** Per-plugin kill switch; fails closed like the global one. */
  async setDisabled(pluginId: string, disabled: boolean): Promise<void> {
    if (!disabled) {
      this.store.setDisabled(pluginId, false)
      this.resetFailures(pluginId)
      return
    }
    try {
      this.store.setDisabled(pluginId, true)
    } finally {
      await this.options.stopBackends?.(pluginId)
    }
  }

  async setWorkspaceWrite(pluginId: string, workspacePath: string, allowed: boolean): Promise<void> {
    this.store.setWorkspaceWrite(pluginId, workspacePath, allowed)
    if (!allowed) this.declinedWrite.delete(`${pluginId}\n${workspacePath}`)
  }

  /** Install-time health check: exactly the admission a real spawn needs -
   * switch, not disabled, breaker, sandbox, and consent for THIS content and
   * permission set - without ever prompting, and under the same watchdog and
   * cleanup. Null means the candidate is only staged, never executed. */
  async preflightAdmission(spec: ThirdPartyLaunchSpec): Promise<ThirdPartyAdmission | null> {
    try {
      return await this.admit(spec, undefined, { prompt: false })
    } catch {
      return null
    }
  }
}
