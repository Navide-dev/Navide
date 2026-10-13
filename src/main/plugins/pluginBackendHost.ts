import {
  BackendPluginError,
  createAuthenticatedBackendRuntime,
  PluginBackendSupervisor,
  type AuthenticatedBackendRuntime,
  type BackendPluginCallOptions,
  type BackendPluginEvent,
  type BackendPluginLaunchSpec,
  type BackendPluginSubscription,
  type BackendPluginSubscriptionOptions,
  type BackendRuntimeContext,
  type JsonValue,
  type PluginBackendSupervisorOptions,
} from './pluginBackendSupervisor'
import {
  isAuthenticatedInitiator,
  type AuthenticatedInitiator,
} from './pluginCapabilityBroker'
import type { ExecutionPolicySnapshot } from './executionPolicy'
import {
  isAllowedBackendTimeout,
  MAX_BACKEND_CALLS_PER_INSTANCE,
  MAX_BACKEND_CHILDREN,
  MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE,
} from './pluginBackendLimits'
import {
  createProductionPlansBridgeDispatcher,
  type BackendBridgeDispatcher,
} from './plansBridge'
import { noteBackendFailure, type ThirdPartyAdmission } from './pluginThirdPartyBackends'
import {
  canonicalExistingDirectory,
  isWorkspaceContainedPath,
} from './workspacePathPolicy'
import { lstatSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'

export interface PlanRootResolverInput {
  readonly runtime: BackendRuntimeContext
  readonly workspacePath: string
  readonly signal: AbortSignal
}

export type PlanRootResolver = (input: PlanRootResolverInput) => Promise<string>

export interface PluginBackendHostOptions {
  environment?: Readonly<Record<string, string>>
  createSupervisor?: (
    activation: BackendPluginLaunchSpec,
    options: PluginBackendSupervisorOptions,
  ) => PluginBackendSupervisor
  /** Internal Host-owned Plans Bridge; never passed to renderer/SDK code. */
  bridgeDispatcher?: BackendBridgeDispatcher
  /** Resolve the Host-authorized Plans repository root for one bound view. */
  resolvePlanRoot?: PlanRootResolver
  /** Resolve the current agent policy for one Host-bound child bridge call. */
  resolveExecutionPolicy?: (
    runtime: BackendRuntimeContext,
    workspacePath?: string,
  ) => ExecutionPolicySnapshot | undefined
  /** Observe a bound child becoming unavailable before the next call. */
  onBackendFailure?: (runtime: BackendRuntimeContext, error: BackendPluginError) => void
  /** Observe a failed first-party child that an automatic restart brought
   * back, while its view is still bound. */
  onBackendRestarted?: (runtime: BackendRuntimeContext) => void
  /** Observe a bound view being unbound; its child is never reported again. */
  onBackendUnbound?: (runtime: BackendRuntimeContext) => void
  /** Observe child diagnostic output (stderr / startup failure diagnostics). */
  onStderr?: (chunk: string) => void
  /** Re-check Host-owned trust immediately before every backend child spawn. */
  reverifyBeforeSpawn?: (activation: Readonly<BackendPluginLaunchSpec>) => void | Promise<void>
  /** Admit a third-party backend (sandbox, consent, kill switches). Without
   * it every third-party activation is refused. */
  admitThirdParty?: ThirdPartyAdmitter
  /** Idle stop delay for third-party children (default THIRD_PARTY_BACKEND_IDLE_MS). */
  thirdPartyIdleMs?: number
}

export type ThirdPartyAdmitter = (
  activation: BackendPluginLaunchSpec,
  workspacePath: string | undefined,
) => Promise<ThirdPartyAdmission>

interface RegisteredBackend {
  activation: BackendPluginLaunchSpec
}

interface BoundView {
  runtime: AuthenticatedBackendRuntime
  workspacePath?: string
  activation: BackendPluginLaunchSpec
  supervisor?: PluginBackendSupervisor
  authorizedPlanRoot: { value: string | null }
  bindingController: AbortController
  bindingTask: Promise<void>
  closing: boolean
  closingReason?: 'view-destroyed' | 'plugin-stopping'
  slotReleased: boolean
  slotRetained: boolean
  calls: Set<AbortController>
  subscriptions: Set<BackendPluginSubscription>
  pendingSubscriptions: number
  /** Third-party only: idle auto-shutdown state. */
  idle?: ThirdPartyIdleState
}

interface ThirdPartyIdleState {
  timer?: ReturnType<typeof setTimeout>
  /** The child was closed for inactivity; the next call re-admits it. */
  stopped: boolean
  inFlight: number
  waking?: Promise<void>
}

/** A third-party child with no call, subscription or bridge traffic for this
 * long is closed; the next call starts it again through the admission gate. */
export const THIRD_PARTY_BACKEND_IDLE_MS = 10 * 60_000

function backendKey(pluginId: string, packageVersion: string): string {
  return `${pluginId}\u0000${packageVersion}`
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Resolve the package root that the Host owns for an activation or descriptor.
 * A package root must be an existing, real directory; accepting a symlink here
 * would let a later target change silently alter which descriptor is bound.
 *
 * Only the root itself has to be real. Its ancestors may be symlinks and on
 * Linux often are — `/home` → `var/home` on Fedora Silverblue, a stow- or
 * chezmoi-managed `~/.config`, a home on a second disk — and the plugins root
 * under `userData` is never realpath'd before it gets here, so requiring the
 * whole path to equal its realpath refused every plugin backend on such a
 * machine with no plugin-specific error. (macOS's `/var` → `/private/var`
 * is the same shape; `/Users` being real is why it never showed there.)
 */
export function canonicalBackendPackageDir(packageDir: unknown): string | null {
  if (!nonEmptyString(packageDir)) return null
  try {
    const resolved = resolve(packageDir)
    const entry = lstatSync(resolved)
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null
    const canonical = realpathSync(resolved)
    // The last component must survive canonicalisation unchanged: a link
    // swapped in between the lstat above and the realpath would not.
    if (canonical !== join(realpathSync(dirname(resolved)), basename(resolved))) return null
    const canonicalEntry = lstatSync(canonical)
    if (!canonicalEntry.isDirectory() || canonicalEntry.isSymbolicLink()) return null
    return canonical
  } catch {
    return null
  }
}

function isViewRuntime(runtime: BackendRuntimeContext): boolean {
  return (
    nonEmptyString(runtime.pluginId) &&
    nonEmptyString(runtime.packageVersion) &&
    nonEmptyString(runtime.workspaceId) &&
    nonEmptyString(runtime.instanceId) &&
    nonEmptyString(runtime.contributionKey) &&
    (runtime.hostWindowId === null || nonEmptyString(runtime.hostWindowId)) &&
    isAuthenticatedInitiator(runtime.initiator)
  )
}

function runtimeWithInitiator(
  runtime: AuthenticatedBackendRuntime,
  initiator: AuthenticatedInitiator | undefined,
): AuthenticatedBackendRuntime {
  if (initiator === undefined) return runtime
  if (!isAuthenticatedInitiator(initiator)) {
    throw new BackendPluginError('INVALID_RUNTIME')
  }
  const sameKindAndId =
    runtime.initiator.kind === initiator.kind &&
    runtime.initiator.id === initiator.id
  const sameAgentSource =
    runtime.initiator.kind === 'agent' &&
    initiator.kind === 'agent' &&
    runtime.initiator.source === initiator.source
  if (
    sameKindAndId &&
    (runtime.initiator.kind === 'user' || sameAgentSource)
  ) return runtime
  return createAuthenticatedBackendRuntime({ ...runtime, initiator })
}

function defaultSupervisor(
  activation: BackendPluginLaunchSpec,
  options: PluginBackendSupervisorOptions,
): PluginBackendSupervisor {
  return new PluginBackendSupervisor(activation, options)
}

/** The failure a first-party child reports once it has failed too often to be
 * restarted again; the original error stays its cause. */
export const BACKEND_RESTART_BUDGET_SPENT_MESSAGE =
  'Backend plugin failed repeatedly and will not be restarted.'

/**
 * Host-owned router for one package's Backend Wire child processes.
 *
 * A registered package is only metadata. Each bound view gets its own
 * supervisor, authenticated runtime, root binding, and process slot. Renderer
 * code never receives this object or any of those Host-owned handles.
 */
export class PluginBackendHost {
  private readonly environment: Readonly<Record<string, string>>
  private readonly createSupervisor: (
    activation: BackendPluginLaunchSpec,
    options: PluginBackendSupervisorOptions,
  ) => PluginBackendSupervisor
  private bridgeDispatcher: BackendBridgeDispatcher
  private readonly resolvePlanRoot?: PlanRootResolver
  private readonly resolveExecutionPolicy?: PluginBackendHostOptions['resolveExecutionPolicy']
  private readonly onBackendFailure?: PluginBackendHostOptions['onBackendFailure']
  private readonly onBackendRestarted?: PluginBackendHostOptions['onBackendRestarted']
  private readonly onBackendUnbound?: PluginBackendHostOptions['onBackendUnbound']
  private readonly onStderr?: PluginBackendHostOptions['onStderr']
  private reverifyBeforeSpawn?: PluginBackendHostOptions['reverifyBeforeSpawn']
  private admitThirdParty?: ThirdPartyAdmitter
  private readonly thirdPartyIdleMs: number
  private readonly backends = new Map<string, RegisteredBackend>()
  private readonly views = new Map<string, BoundView>()
  /** First-party child failure times per bound view, for restart backoff. */
  private readonly firstPartyFailures = new Map<string, number[]>()
  /** Package-version revocations are serialized and also act as an admission
   *  barrier while the old views and child are being drained. */
  private readonly packageRevocations = new Map<string, Promise<void>>()
  private readonly unbindTasks = new Map<
    string,
    { packageKey: string; task: Promise<void> }
  >()
  private reservedChildSlots = 0
  /** Slots consumed by children whose close failed; never reclaimed. */
  private retainedChildSlots = 0

  constructor(options: PluginBackendHostOptions = {}) {
    this.environment = Object.freeze({ ...(options.environment ?? {}) })
    this.bridgeDispatcher = options.bridgeDispatcher ?? createProductionPlansBridgeDispatcher()
    this.resolvePlanRoot = options.resolvePlanRoot
    this.resolveExecutionPolicy = options.resolveExecutionPolicy
    this.onBackendFailure = options.onBackendFailure
    this.onBackendRestarted = options.onBackendRestarted
    this.onBackendUnbound = options.onBackendUnbound
    this.onStderr = options.onStderr
    this.reverifyBeforeSpawn = options.reverifyBeforeSpawn
    this.admitThirdParty = options.admitThirdParty
    this.thirdPartyIdleMs = options.thirdPartyIdleMs ?? THIRD_PARTY_BACKEND_IDLE_MS
    this.createSupervisor = options.createSupervisor ?? defaultSupervisor
  }

  /** Install the third-party admission gate before views are bound. */
  setThirdPartyAdmitter(admitter: ThirdPartyAdmitter | undefined): void {
    if (this.views.size > 0) {
      throw new BackendPluginError(
        'INVALID_RUNTIME',
        'Third-party backend admission cannot change while a view is bound.',
      )
    }
    this.admitThirdParty = admitter
  }

  /** Kill switch: stop running third-party children (one plugin, or all). The
   * activations stay registered; a new bind is admitted again from scratch. */
  async stopThirdPartyBackends(pluginId: string | null): Promise<void> {
    const instances = [...this.views.entries()]
      .filter(([, view]) =>
        view.activation.thirdParty !== undefined &&
        (pluginId === null || view.activation.pluginId === pluginId),
      )
      .map(([instanceId]) => instanceId)
    await Promise.allSettled(instances.map((instanceId) => this.unbindView(instanceId, 'plugin-stopping')))
  }

  /** Replace the Host-owned bridge composition before any package runtime is
   * bound. Production wiring uses this to connect the existing core
   * filesystem service; tests may keep their isolated dispatcher. */
  setBridgeDispatcher(dispatcher: BackendBridgeDispatcher): void {
    if (this.views.size > 0) {
      throw new BackendPluginError(
        'INVALID_RUNTIME',
        'Backend bridge composition cannot change while a view is bound.',
      )
    }
    this.bridgeDispatcher = dispatcher
  }

  /** Install the Host's current-trust verifier before views are bound. The
   * callback is retained by each supervisor so restarts re-check fresh facts. */
  setBeforeSpawnVerifier(
    verifier: PluginBackendHostOptions['reverifyBeforeSpawn'] | undefined,
  ): void {
    if (this.views.size > 0) {
      throw new BackendPluginError(
        'INVALID_RUNTIME',
        'Backend spawn trust verifier cannot change while a view is bound.',
      )
    }
    this.reverifyBeforeSpawn = verifier
  }

  register(activation: BackendPluginLaunchSpec): void {
    const packageDir = canonicalBackendPackageDir(activation.packageDir)
    if (!packageDir) throw new BackendPluginError('INVALID_ACTIVATION')
    const key = backendKey(activation.pluginId, activation.packageVersion)
    if (this.packageRevocations.has(key)) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    if (this.backends.has(key)) {
      throw new BackendPluginError('INVALID_ACTIVATION', 'Backend package version is already registered.')
    }
    const normalizedActivation = activation.packageDir === packageDir
      ? activation
      : { ...activation, packageDir }
    this.backends.set(key, { activation: normalizedActivation })
  }

  hasActivation(pluginId: string, packageVersion: string): boolean {
    return this.backends.has(backendKey(pluginId, packageVersion))
  }

  /**
   * True while this Host owns a backend child that is running or is still
   * being torn down: a bound view (which owns a supervisor and a process slot)
   * or an unbind whose drain has not settled.
   *
   * This is the only liveness answer a caller outside the Host can trust.
   * A registered activation is metadata and never counts. `reservedChildSlots`
   * and `packageRevocations` are deliberately not consulted: both are retained
   * for the life of the process once a close or a drain fails, so reading them
   * would make this predicate permanently true, and a child that could not be
   * closed is not one that a longer wait recovers.
   */
  hasLiveBackendChildren(): boolean {
    return this.views.size > 0 || this.unbindTasks.size > 0
  }

  activationFor(
    pluginId: string,
    packageVersion: string,
    packageDir: string,
  ): BackendPluginLaunchSpec | undefined {
    const canonicalPackageDir = canonicalBackendPackageDir(packageDir)
    if (!canonicalPackageDir) return undefined
    const activation = this.backends.get(backendKey(pluginId, packageVersion))?.activation
    return activation?.packageDir === canonicalPackageDir ? activation : undefined
  }

  registeredActivations(): BackendPluginLaunchSpec[] {
    return [...this.backends.values()].map(({ activation }) => activation)
  }

  activationForPlugin(pluginId: string): BackendPluginLaunchSpec | undefined {
    return [...this.backends.values()].find(({ activation }) => activation.pluginId === pluginId)?.activation
  }

  /**
   * Bind a package backend to a workspace without requiring a visible view.
   * The generated instance id remains Host-private; MCP callers address this
   * binding through the Host's workspace routing seam instead.
   */
  async bindWorkspace(
    runtime: BackendRuntimeContext,
    packageDir: string,
    workspacePath: string,
  ): Promise<string> {
    if (!nonEmptyString(workspacePath)) throw new BackendPluginError('INVALID_RUNTIME')
    let instanceId = randomUUID()
    while (this.views.has(instanceId)) instanceId = randomUUID()
    const boundRuntime: BackendRuntimeContext = {
      ...runtime,
      instanceId,
      contributionKey: runtime.contributionKey ?? `${runtime.pluginId}.headless`,
      hostWindowId: runtime.hostWindowId ?? null,
    }
    await this.bindView(boundRuntime, packageDir, workspacePath)
    return instanceId
  }

  /**
   * Reserve a view synchronously, then resolve its root and create its child.
   * Synchronous input/identity errors still throw at the binding boundary;
   * asynchronous root failures are returned by the binding promise and by all
   * calls/subscriptions addressed to that view.
   */
  bindView(
    runtime: BackendRuntimeContext,
    packageDir: string,
    workspacePath?: string,
  ): Promise<void> {
    if (!isViewRuntime(runtime)) throw new BackendPluginError('INVALID_RUNTIME')
    const instanceId = runtime.instanceId
    if (!nonEmptyString(instanceId)) throw new BackendPluginError('INVALID_RUNTIME')
    const key = backendKey(runtime.pluginId, runtime.packageVersion)
    if (this.packageRevocations.has(key)) throw new BackendPluginError('PLUGIN_STOPPING')
    const backend = this.backends.get(key)
    if (!backend) throw new BackendPluginError('INVALID_RUNTIME')
    const canonicalPackageDir = canonicalBackendPackageDir(packageDir)
    if (!canonicalPackageDir || canonicalPackageDir !== backend.activation.packageDir) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    if (this.views.has(instanceId)) {
      throw new BackendPluginError('INVALID_RUNTIME', 'Backend view instance is already bound.')
    }
    if (workspacePath !== undefined && !nonEmptyString(workspacePath)) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    if (this.reservedChildSlots >= MAX_BACKEND_CHILDREN) {
      throw new BackendPluginError('RESOURCE_LIMIT', this.childLimitMessage())
    }

    const view: BoundView = {
      runtime: createAuthenticatedBackendRuntime(runtime),
      ...(workspacePath === undefined ? {} : { workspacePath: resolve(workspacePath) }),
      activation: backend.activation,
      authorizedPlanRoot: { value: null },
      bindingController: new AbortController(),
      bindingTask: Promise.resolve(),
      closing: false,
      slotReleased: false,
      slotRetained: false,
      calls: new Set(),
      subscriptions: new Set(),
      pendingSubscriptions: 0,
      ...(backend.activation.thirdParty !== undefined ? { idle: { stopped: false, inFlight: 0 } } : {}),
    }
    this.views.set(instanceId, view)
    this.reservedChildSlots++
    view.bindingTask = this.finishBinding(view).catch((error: unknown) => {
      if (this.views.get(instanceId) === view) this.views.delete(instanceId)
      view.closing = true
      view.bindingController.abort()
      this.releaseChildSlot(view)
      throw error
    })
    return view.bindingTask
  }

  private async finishBinding(view: BoundView): Promise<void> {
    if (view.activation.thirdParty !== undefined) return this.finishThirdPartyBinding(view)
    try {
      const needsFilesystem = view.activation.approvedBridgePorts?.includes('filesystem') ?? false
      if (needsFilesystem) {
        if (!view.workspacePath || !this.resolvePlanRoot) {
          throw new BackendPluginError('INVALID_RUNTIME')
        }
        const root = await this.resolvePlanRoot({
          runtime: view.runtime,
          workspacePath: view.workspacePath,
          signal: view.bindingController.signal,
        })
        if (view.bindingController.signal.aborted || view.closing) {
          throw new BackendPluginError('USER_CANCELLED')
        }
        const canonicalRoot = nonEmptyString(root) ? canonicalExistingDirectory(root) : null
        if (!canonicalRoot || !isWorkspaceContainedPath(canonicalRoot, view.workspacePath)) {
          throw new BackendPluginError('INVALID_RUNTIME', 'Plans root is outside the bound workspace.')
        }
        view.authorizedPlanRoot.value = canonicalRoot
      }

      if (view.bindingController.signal.aborted || view.closing) {
        throw new BackendPluginError('USER_CANCELLED')
      }
      const supervisorOptions: PluginBackendSupervisorOptions = {
        environment: this.environment,
        clientInfo: { name: 'navide-host', version: view.activation.packageVersion },
        bridgeDispatcher: this.bridgeDispatcher,
        authorizedPlanRoot: view.authorizedPlanRoot,
        ...(this.reverifyBeforeSpawn
          ? { beforeSpawn: () => this.reverifyBeforeSpawn?.(view.activation) }
          : {}),
        ...(this.onStderr ? { onStderr: this.onStderr } : {}),
        ...(this.resolveExecutionPolicy
          ? { resolveExecutionPolicy: this.resolveExecutionPolicy }
          : {}),
        onFailure: (error: BackendPluginError): void => {
          if (this.views.get(view.runtime.instanceId ?? '') !== view) return
          // Name the failure here, before any observer can drop it. Every
          // downstream diagnostic is gated on error.cause, and a startup
          // failure without one used to leave no trace at all - which is how
          // Plans kept falling into legacy recovery for days with nothing to
          // read. Code only; the sanitized detail still follows when present.
          console.warn(
            `[plugin-backend] ${view.runtime.pluginId} child failed: ${error.code}${
              error.cause ? '' : ' (no cause reported)'
            }`,
          )
          // Each view has its own budget: one window's crashing child must not
          // use up another window's restarts.
          const delay = noteBackendFailure(this.firstPartyFailures, view.runtime.instanceId ?? '', Date.now())
          try {
            this.onBackendFailure?.(
              view.runtime,
              delay === null
                ? new BackendPluginError(error.code, BACKEND_RESTART_BUDGET_SPENT_MESSAGE, { cause: error.cause })
                : error,
            )
          } catch {
            // A liveness observer must not change the child failure result.
          }
          if (delay === null) {
            console.warn(`[plugin-backend] ${view.runtime.pluginId} failed too often; leaving it stopped`)
            return
          }
          const stillBound = (): boolean =>
            this.views.get(view.runtime.instanceId ?? '') === view &&
            !view.closing &&
            view.supervisor === supervisor
          const timer = setTimeout(() => {
            if (!stillBound()) return
            supervisor.restart().then(() => {
              if (!stillBound()) return
              try {
                this.onBackendRestarted?.(view.runtime)
              } catch {
                // A liveness observer must not change the restart result.
              }
            }, () => {
              // The next failure is reported through onFailure again.
            })
          }, delay)
          timer.unref?.()
        },
        ...(needsFilesystem && this.resolvePlanRoot && view.workspacePath !== undefined
          ? {
              refreshAuthorizedPlanRoot: (signal: AbortSignal): Promise<string> =>
                this.refreshPlanRoot(view, signal),
            }
          : {}),
      }
      const supervisor: PluginBackendSupervisor = this.createSupervisor(view.activation, supervisorOptions)
      view.supervisor = supervisor
    } catch (error) {
      if (error instanceof BackendPluginError) throw error
      throw new BackendPluginError('BACKEND_UNAVAILABLE')
    }
  }

  /** Third-party children never reach the Plans root resolver or the Plans
   * bridge: their bridge is the admission's package dispatcher, their root is
   * the bound workspace itself, and their process is the sandboxed spawn. */
  private async finishThirdPartyBinding(view: BoundView): Promise<void> {
    try {
      if (!this.admitThirdParty) {
        throw new BackendPluginError('BACKEND_UNAVAILABLE', 'Third-party backends are not available.')
      }
      const admission = await this.admitThirdParty(view.activation, view.workspacePath)
      if (view.bindingController.signal.aborted || view.closing) {
        throw new BackendPluginError('USER_CANCELLED')
      }
      if (
        admission.workspaceRoot &&
        view.workspacePath &&
        isWorkspaceContainedPath(admission.workspaceRoot, view.workspacePath)
      ) {
        view.authorizedPlanRoot.value = admission.workspaceRoot
      }
      const instanceId = view.runtime.instanceId ?? ''
      const supervisor: PluginBackendSupervisor = this.createSupervisor(view.activation, {
        environment: this.environment,
        clientInfo: { name: 'navide-host', version: view.activation.packageVersion },
        spawnProcess: admission.spawnProcess,
        bridgeDispatcher: admission.bridgeDispatcher,
        authorizedPlanRoot: view.authorizedPlanRoot,
        beforeSpawn: async () => {
          await this.reverifyBeforeSpawn?.(view.activation)
          await admission.beforeSpawn()
        },
        ...(this.onStderr ? { onStderr: this.onStderr } : {}),
        onFailure: (error: BackendPluginError): void => {
          if (this.views.get(instanceId) !== view || view.supervisor !== supervisor) return
          console.warn(`[plugin-backend] ${view.runtime.pluginId} child failed: ${error.code}`)
          try {
            this.onBackendFailure?.(view.runtime, error)
          } catch {
            // A liveness observer must not change the child failure result.
          }
          const delay = admission.noteFailure()
          if (delay === null) return
          const timer = setTimeout(() => {
            if (this.views.get(instanceId) !== view || view.closing || view.supervisor !== supervisor) return
            supervisor.restart().catch(() => {
              // The next failure is reported through onFailure again.
            })
          }, delay)
          timer.unref?.()
        },
      })
      view.supervisor = supervisor
      this.scheduleIdleStop(view)
    } catch (error) {
      if (error instanceof BackendPluginError) throw error
      throw new BackendPluginError('BACKEND_UNAVAILABLE')
    }
  }

  private async refreshPlanRoot(view: BoundView, signal: AbortSignal): Promise<string> {
    if (!this.resolvePlanRoot || !view.workspacePath) {
      throw new BackendPluginError('INVALID_RUNTIME')
    }
    const root = await this.resolvePlanRoot({
      runtime: view.runtime,
      workspacePath: view.workspacePath,
      signal,
    })
    const canonicalRoot = nonEmptyString(root) ? canonicalExistingDirectory(root) : null
    if (!canonicalRoot || !isWorkspaceContainedPath(canonicalRoot, view.workspacePath)) {
      throw new BackendPluginError('INVALID_RUNTIME', 'Plans root is outside the bound workspace.')
    }
    view.authorizedPlanRoot.value = canonicalRoot
    return canonicalRoot
  }

  private releaseChildSlot(view: BoundView): void {
    if (view.slotReleased || view.slotRetained) return
    view.slotReleased = true
    this.reservedChildSlots--
  }

  /** A close that rejected cannot prove the child exited, and no one retries
   * it: the view is already unregistered and the Host has no exit signal to
   * reclaim on. Releasing the slot would let a new child start while that one
   * may still be running, which is the same reason a failed drain keeps its
   * package admission barrier. Keep the slot for the life of the process and
   * report it, so the limit it will eventually hit is explained. */
  private retainChildSlot(view: BoundView): void {
    if (view.slotReleased || view.slotRetained) return
    view.slotRetained = true
    this.retainedChildSlots++
    console.warn(
      `[plugin-backend] backend child slot retained after a failed close for ` +
      `${view.activation.pluginId}@${view.activation.packageVersion}: ` +
      `${this.retainedChildSlots} of ${MAX_BACKEND_CHILDREN} slots are held by children that may still be running.`,
    )
  }

  private childLimitMessage(): string {
    if (this.retainedChildSlots === 0) return 'Backend child process limit reached.'
    return 'Backend child process limit reached. ' +
      `${this.retainedChildSlots} of ${MAX_BACKEND_CHILDREN} slots are retained by backend children whose close failed.`
  }

  async unbindView(
    instanceId: string,
    reason: 'view-destroyed' | 'plugin-stopping' = 'view-destroyed',
  ): Promise<void> {
    const existing = this.unbindTasks.get(instanceId)
    if (existing) {
      await existing.task
      return
    }
    const view = this.views.get(instanceId)
    if (!view) return
    const packageKey = backendKey(view.activation.pluginId, view.activation.packageVersion)
    const task = (async (): Promise<void> => {
      this.views.delete(instanceId)
      this.firstPartyFailures.delete(instanceId)
      try {
        this.onBackendUnbound?.(view.runtime)
      } catch {
        // A liveness observer must not change the unbind result.
      }
      this.clearIdleTimer(view)
      view.closing = true
      view.closingReason = reason
      if (reason === 'plugin-stopping') view.bindingController.abort('plugin-stopping')
      else view.bindingController.abort()
      for (const controller of view.calls) {
        if (reason === 'plugin-stopping') controller.abort('plugin-stopping')
        else controller.abort()
      }
      view.calls.clear()
      for (const subscription of view.subscriptions) {
        subscription.dispose(reason)
      }
      view.subscriptions.clear()
      try {
        await view.bindingTask
      } catch {
        // A failed binding has no child to close; callers already receive it.
      }
      try {
        await view.supervisor?.close()
      } catch (error) {
        this.retainChildSlot(view)
        throw error
      }
      this.releaseChildSlot(view)
    })()
    this.unbindTasks.set(instanceId, { packageKey, task })
    try {
      await task
    } finally {
      if (this.unbindTasks.get(instanceId)?.task === task) this.unbindTasks.delete(instanceId)
    }
  }

  /** Revoke exactly one package-version activation. New binds are rejected as
   * soon as this method starts; existing views are drained before the selected
   * activation is removed from the Host registry. */
  async revokePackageVersion(pluginId: string, packageVersion: string): Promise<void> {
    const key = backendKey(pluginId, packageVersion)
    const existing = this.packageRevocations.get(key)
    if (existing) {
      await existing
      return
    }
    const task = Promise.resolve().then(async () => {
      const instances = [...this.views.entries()]
        .filter(([, view]) =>
          view.activation.pluginId === pluginId && view.activation.packageVersion === packageVersion,
        )
        .map(([instanceId]) => instanceId)
      const draining = [...this.unbindTasks.values()]
        .filter(({ packageKey }) => packageKey === key)
        .map(({ task }) => task)
      await Promise.all([
        ...instances.map((instanceId) => this.unbindView(instanceId, 'plugin-stopping')),
        ...draining,
      ])
      this.backends.delete(key)
    })
    this.packageRevocations.set(key, task)
    let completed = false
    try {
      await task
      completed = true
    } finally {
      // A failed drain cannot prove that the old child is gone. Retain its
      // admission barrier until process teardown rather than allowing respawn.
      if (completed && this.packageRevocations.get(key) === task) this.packageRevocations.delete(key)
    }
  }

  async call<Result extends JsonValue>(
    instanceId: string,
    name: string,
    args: JsonValue,
    options?: BackendPluginCallOptions,
  ): Promise<Result> {
    const thirdPartyView = this.views.get(instanceId)
    if (thirdPartyView?.idle === undefined) return this.callBound<Result>(instanceId, name, args, options)
    // Bridge requests only exist inside a call or subscription origin, so the
    // whole call - including the child's bridge traffic - counts as activity.
    const idle = thirdPartyView.idle
    idle.inFlight++
    this.clearIdleTimer(thirdPartyView)
    try {
      return await this.callBound<Result>(instanceId, name, args, options)
    } finally {
      idle.inFlight--
      this.scheduleIdleStop(thirdPartyView)
    }
  }

  private async callBound<Result extends JsonValue>(
    instanceId: string,
    name: string,
    args: JsonValue,
    options?: BackendPluginCallOptions,
  ): Promise<Result> {
    const unbinding = this.unbindTasks.get(instanceId)
    if (unbinding && this.packageRevocations.has(unbinding.packageKey)) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    const view = this.views.get(instanceId)
    if (!view) throw new BackendPluginError('INVALID_RUNTIME')
    if (this.packageRevocations.has(backendKey(view.activation.pluginId, view.activation.packageVersion))) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    if (!view.activation.approvedMethods.includes(name)) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    const initiator = options?.initiator ?? view.runtime.initiator
    if (initiator.kind === 'agent' && !view.activation.agentMethods?.includes(name)) {
      throw new BackendPluginError('CAPABILITY_DENIED')
    }
    if (options?.timeoutMs !== undefined && !isAllowedBackendTimeout(options.timeoutMs)) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (view.calls.size >= MAX_BACKEND_CALLS_PER_INSTANCE) {
      throw new BackendPluginError('RESOURCE_LIMIT')
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (options?.signal?.aborted) controller.abort()
    else options?.signal?.addEventListener('abort', abort, { once: true })
    view.calls.add(controller)
    try {
      const runtime = runtimeWithInitiator(view.runtime, options?.initiator)
      const supervisorOptions: BackendPluginCallOptions = { ...options }
      delete supervisorOptions.initiator
      try {
        await view.bindingTask
      } catch (error) {
        if (view.closingReason === 'plugin-stopping') {
          throw new BackendPluginError('PLUGIN_STOPPING')
        }
        throw error
      }
      await this.wakeIfIdleStopped(view)
      if (controller.signal.aborted) {
        throw new BackendPluginError(
          controller.signal.reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
        )
      }
      if (this.views.get(instanceId) !== view || view.closing || !view.supervisor) {
        throw new BackendPluginError(
          view.closingReason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'INVALID_RUNTIME',
        )
      }
      await view.supervisor.start()
      if (controller.signal.aborted) {
        throw new BackendPluginError(
          controller.signal.reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
        )
      }
      return view.supervisor.clientFor(runtime, {
        workspacePath: view.workspacePath,
        authorizedPlanRoot: view.authorizedPlanRoot.value ?? undefined,
      }).call<Result>(name, args, {
        ...supervisorOptions,
        signal: controller.signal,
      })
    } finally {
      options?.signal?.removeEventListener('abort', abort)
      view.calls.delete(controller)
    }
  }

  async subscribe(
    instanceId: string,
    event: string,
    listener: (payload: JsonValue) => void,
    options?: BackendPluginSubscriptionOptions,
  ): Promise<BackendPluginSubscription> {
    const unbinding = this.unbindTasks.get(instanceId)
    if (unbinding && this.packageRevocations.has(unbinding.packageKey)) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    const view = this.views.get(instanceId)
    if (!view) throw new BackendPluginError('INVALID_RUNTIME')
    if (this.packageRevocations.has(backendKey(view.activation.pluginId, view.activation.packageVersion))) {
      throw new BackendPluginError('PLUGIN_STOPPING')
    }
    if (!view.activation.approvedEvents.includes(event)) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (options?.timeoutMs !== undefined && !isAllowedBackendTimeout(options.timeoutMs)) {
      throw new BackendPluginError('INVALID_ARGUMENT')
    }
    if (view.subscriptions.size + view.pendingSubscriptions >= MAX_BACKEND_SUBSCRIPTIONS_PER_INSTANCE) {
      throw new BackendPluginError('RESOURCE_LIMIT')
    }
    view.pendingSubscriptions++
    try {
      const runtime = runtimeWithInitiator(view.runtime, options?.initiator)
      const supervisorOptions: BackendPluginSubscriptionOptions = { ...options }
      delete supervisorOptions.initiator
      try {
        await view.bindingTask
      } catch (error) {
        if (view.closingReason === 'plugin-stopping') {
          throw new BackendPluginError('PLUGIN_STOPPING')
        }
        throw error
      }
      await this.wakeIfIdleStopped(view)
      if (options?.signal?.aborted) {
        throw new BackendPluginError(
          options.signal.reason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'USER_CANCELLED',
        )
      }
      if (this.views.get(instanceId) !== view || view.closing || !view.supervisor) {
        throw new BackendPluginError(
          view.closingReason === 'plugin-stopping' ? 'PLUGIN_STOPPING' : 'INVALID_RUNTIME',
        )
      }
      await view.supervisor.start()
      const subscription = view.supervisor.clientFor(runtime, {
        workspacePath: view.workspacePath,
        authorizedPlanRoot: view.authorizedPlanRoot.value ?? undefined,
      }).subscribe(
        [event],
        (backendEvent: BackendPluginEvent) => {
          if (backendEvent.event === event) listener(backendEvent.payload)
        },
        supervisorOptions,
      )
      view.subscriptions.add(subscription)
      void subscription.settled.then(() => view.subscriptions.delete(subscription))
      if (view.idle) {
        const reschedule = (): void => this.scheduleIdleStop(view)
        void subscription.settled.then(reschedule, reschedule)
      }
      return subscription
    } finally {
      view.pendingSubscriptions--
      if (view.idle) this.scheduleIdleStop(view)
    }
  }

  private clearIdleTimer(view: BoundView): void {
    if (view.idle?.timer === undefined) return
    clearTimeout(view.idle.timer)
    view.idle.timer = undefined
  }

  /** Arm the idle stop when nothing is in flight; any activity re-arms it. */
  private scheduleIdleStop(view: BoundView): void {
    const idle = view.idle
    if (!idle) return
    this.clearIdleTimer(view)
    if (view.closing || idle.stopped || idle.inFlight > 0) return
    if (view.subscriptions.size + view.pendingSubscriptions > 0) return
    idle.timer = setTimeout(() => {
      idle.timer = undefined
      void this.stopIdleChild(view)
    }, this.thirdPartyIdleMs)
    idle.timer.unref?.()
  }

  private async stopIdleChild(view: BoundView): Promise<void> {
    const idle = view.idle
    if (
      !idle ||
      idle.stopped ||
      idle.inFlight > 0 ||
      view.closing ||
      view.subscriptions.size + view.pendingSubscriptions > 0 ||
      this.views.get(view.runtime.instanceId ?? '') !== view
    ) return
    idle.stopped = true
    const supervisor = view.supervisor
    view.supervisor = undefined
    try {
      await supervisor?.close()
    } catch (error) {
      console.warn(
        `[plugin-backend] ${view.activation.pluginId} idle close failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  /** Re-admit an idle-stopped third-party child (consent, switches, sandbox
   * are all checked again); concurrent callers share one admission. */
  private async wakeIfIdleStopped(view: BoundView): Promise<void> {
    const idle = view.idle
    if (!idle?.stopped) return
    idle.waking ??= this.finishThirdPartyBinding(view)
      .then(() => {
        idle.stopped = false
      })
      .finally(() => {
        idle.waking = undefined
      })
    await idle.waking
  }

  async close(): Promise<void> {
    await Promise.all([...this.views.keys()].map((instanceId) => this.unbindView(instanceId)))
    await Promise.all([...this.unbindTasks.values()].map(({ task }) => task))
    await Promise.all([...this.packageRevocations.values()])
    this.backends.clear()
  }
}
