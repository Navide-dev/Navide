/**
 * `@navide/plugin-sdk/testing`: an in-memory Navide Host for a plugin's own
 * tests. It builds a {@link PluginContext} that answers capability calls from
 * handlers the test supplies, refuses what the test manifest does not declare
 * the way the Host does (`CAPABILITY_DENIED`), lets the test emit Host events,
 * and records every call. It runs no Host code and grants nothing real: it is
 * a stand-in for unit tests, not a sandbox.
 */
import type { Disposable, JsonValue, Params, Payload, PublicEvent, PublicMethod, Result } from '@navide/plugin-contracts'
import { capabilitiesV1, PluginError } from '@navide/plugin-contracts'
import type { PluginAppearanceSnapshot, PluginContext, WorkspaceTarget } from './index.js'

/** The parts of a Manifest v2 `permissions` block the test Host enforces. */
export interface TestHostPermissions {
  /** `permissions.system` namespaces (fs, ui, aiCli, web, agents, agentMessages, secrets, agentNotify). */
  system?: readonly string[]
  /** `permissions.shell`: any value lets `shell.*` through. */
  shell?: 'allowlist' | 'full'
  /** `permissions.agents.events`: the agents.* events the plugin receives. */
  agentEvents?: readonly string[]
  /** `permissions.plugins`: the plugins `plugins.call` may reach. */
  plugins?: readonly string[]
}

export type TestHostHandler = (params: unknown) => unknown | Promise<unknown>

export interface TestHostOptions {
  pluginId?: string
  packageVersion?: string
  contributionKey?: string
  workspaceId?: string
  permissions?: TestHostPermissions
  /** Answers by capability address, e.g. `{ 'fs.readFile': () => ({ content: 'x' }) }`.
   *  A declared address with no handler fails with METHOD_NOT_FOUND. */
  handlers?: Readonly<Record<string, TestHostHandler>>
  appearance?: PluginAppearanceSnapshot
}

export interface TestHostCall {
  address: string
  params: unknown
  /** 'ok', or the PluginError code the call failed with. */
  outcome: string
}

export interface TestHost {
  /** Pass this to your plugin's `activate`. */
  readonly context: PluginContext
  /** Every capability call so far, in order. */
  readonly calls: readonly TestHostCall[]
  /** Deliver a Host event to the plugin's subscribers. An agents.* event the
   *  permissions do not declare is not delivered (false), as on the Host. */
  emit<E extends PublicEvent>(event: E, payload: Payload<E>): boolean
  /** Point the view at another workspace target (or none). */
  setTarget(target: WorkspaceTarget | null): void
  /** Change the appearance snapshot and notify subscribers. */
  setAppearance(snapshot: PluginAppearanceSnapshot): void
  /** Progress lines, badges and other view effects the plugin asked for. */
  readonly effects: ReadonlyArray<{ kind: string; value: unknown }>
}

const DEFAULT_APPEARANCE: PluginAppearanceSnapshot = Object.freeze({
  locale: 'en-US',
  colorScheme: 'dark',
  themeId: 'navide-dark',
  uiScale: 1,
})

type CatalogPermission = { id: string; access?: string }

/** What each cataloged address needs declared, from capabilities-v1.json:
 *  the same catalog the Host enforces. */
const PERMISSIONS: ReadonlyMap<string, CatalogPermission> = new Map(
  (() => {
    const catalog = capabilitiesV1 as unknown as Record<'methods' | 'events', Array<{ address: string; permission: CatalogPermission }>>
    return [...catalog.methods, ...catalog.events].map((entry) => [entry.address, entry.permission] as const)
  })(),
)

function deny(message: string): PluginError {
  return new PluginError('CAPABILITY_DENIED', message)
}

export function createTestHost(options: TestHostOptions = {}): TestHost {
  const permissions = options.permissions ?? {}
  const system = new Set(permissions.system ?? [])
  const handlers = options.handlers ?? {}
  const calls: TestHostCall[] = []
  const effects: Array<{ kind: string; value: unknown }> = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const targetListeners = new Set<(target: WorkspaceTarget | null) => void>()
  const appearanceListeners = new Set<(snapshot: PluginAppearanceSnapshot) => void>()
  let appearance = options.appearance ?? DEFAULT_APPEARANCE

  const subscribe = <T>(set: Set<(value: T) => void>, listener: (value: T) => void): Disposable => {
    set.add(listener)
    return Object.freeze({ dispose: () => { set.delete(listener) } })
  }

  const authorize = (address: string, params: unknown): void => {
    const permission = PERMISSIONS.get(address)
    if (!permission) throw new PluginError('METHOD_NOT_FOUND', `unknown public capability '${address}'`)
    if (permission.id === 'storage') return
    if (permission.id === 'shell') {
      if (!permissions.shell) throw deny('shell access is not declared')
      return
    }
    if (permission.id === 'plugins') {
      const target = typeof params === 'object' && params !== null ? (params as { pluginId?: unknown }).pluginId : undefined
      if (typeof target !== 'string' || !(permissions.plugins ?? []).includes(target)) {
        throw deny(`plugin '${String(target)}' is not declared in permissions.plugins`)
      }
      return
    }
    if (!permission.access || !system.has(permission.access)) {
      throw deny(`system namespace '${permission.access ?? ''}' is not declared`)
    }
  }

  const invoke = async <M extends PublicMethod>(method: M, params: Params<M>): Promise<Result<M>> => {
    const address = String(method)
    try {
      authorize(address, params)
      const handler = handlers[address]
      if (!handler) throw new PluginError('METHOD_NOT_FOUND', `the test Host has no handler for '${address}'`)
      const result = await handler(params)
      calls.push({ address, params, outcome: 'ok' })
      return result as Result<M>
    } catch (error) {
      const code = error instanceof PluginError ? error.code : 'INTERNAL_ERROR'
      calls.push({ address, params, outcome: code })
      throw error instanceof PluginError ? error : new PluginError('INTERNAL_ERROR', String(error))
    }
  }

  const context: PluginContext = Object.freeze({
    pluginId: options.pluginId ?? 'test.plugin',
    packageVersion: options.packageVersion ?? '0.0.0',
    contributionKey: options.contributionKey ?? 'main',
    instanceId: 'test-instance',
    workspaceId: options.workspaceId ?? 'test-workspace',
    startupDeadlineMs: 5000,
    capabilities: Object.freeze({ invoke }),
    events: Object.freeze({
      subscribe<E extends PublicEvent>(event: E, listener: (payload: Payload<E>) => void): Disposable {
        let set = listeners.get(event)
        if (!set) listeners.set(event, set = new Set())
        return subscribe(set, listener as (payload: unknown) => void)
      },
    }),
    lifecycle: Object.freeze({ reportProgress: (message: string) => { effects.push({ kind: 'progress', value: message }) } }),
    view: Object.freeze({
      hide: async () => { effects.push({ kind: 'hide', value: null }) },
      openContribution: async (key: string) => { effects.push({ kind: 'openContribution', value: key }) },
      setBadge: async (value: string | number | null) => { effects.push({ kind: 'badge', value }) },
    }),
    appearance: Object.freeze({
      current: () => appearance,
      subscribe: (listener: (snapshot: PluginAppearanceSnapshot) => void) => subscribe(appearanceListeners, listener),
    }),
    credentials: Object.freeze({
      listAccounts: async () => [],
      workspaceBinding: async () => null,
      openAccountSettings: async () => { effects.push({ kind: 'openAccountSettings', value: null }) },
    }),
    ui: Object.freeze({
      pickWorkspace: async () => null,
      openWorkspace: async (grant: unknown) => { effects.push({ kind: 'openWorkspace', value: grant }) },
      revealInWorkspace: async (path: string) => { effects.push({ kind: 'revealInWorkspace', value: path }) },
      openTextPreview: async (title: string, content: string) => { effects.push({ kind: 'openTextPreview', value: { title, content } }) },
      openSettingsSection: async (section: string) => { effects.push({ kind: 'openSettingsSection', value: section }) },
    }),
    targets: Object.freeze({
      subscribe: (listener: (target: WorkspaceTarget | null) => void) => subscribe(targetListeners, listener),
    }),
  }) as PluginContext

  return Object.freeze({
    context,
    calls,
    effects,
    emit<E extends PublicEvent>(event: E, payload: Payload<E>): boolean {
      const name = String(event)
      if (name.startsWith('agents.') && (!system.has('agents') || !(permissions.agentEvents ?? []).includes(name))) {
        return false
      }
      for (const listener of [...(listeners.get(name) ?? [])]) listener(payload as unknown as JsonValue)
      return true
    },
    setTarget(target: WorkspaceTarget | null): void {
      for (const listener of [...targetListeners]) listener(target)
    },
    setAppearance(snapshot: PluginAppearanceSnapshot): void {
      appearance = snapshot
      for (const listener of [...appearanceListeners]) listener(snapshot)
    },
  })
}
