import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionPolicySnapshot } from './executionPolicy'
import { HOST_DEFAULT_EXECUTION_POLICY } from './executionPolicy'
import {
  FrontendPluginManager,
  parseDeveloperBackendRequest,
  type DeveloperBackendGate,
} from './frontendPluginManager'
import { manifestV2CapabilityPolicy } from './pluginPermissions'
import { readInstalledManifestV2, thirdPartyBackendLaunchSpec } from './pluginThirdPartyBackends'

// plugins_developer_backend_call (0.2.40), Host side: a plugin loaded from a
// folder is called through a real backend child on stdio (the backend-wire
// fixture), and every other case is refused before a child is started. Only
// tmp directories are used; every child is checked to have exited by the PID
// this file started it with.

vi.mock('electron', () => ({}))

const FIXTURE = fileURLToPath(new URL('./test-fixtures/backend-wire-child.mjs', import.meta.url))
const cleanups: Array<() => Promise<void>> = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((done) => setTimeout(done, 20))
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
}, 30_000)

interface Live {
  mgr: FrontendPluginManager
  workspace: string
  pids: number[]
  gate: { state: DeveloperBackendGate }
  call: (method: string, args?: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<Record<string, unknown>>
}

async function live(options: { installGate?: boolean } = {}): Promise<Live> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'developer-backend-call-')))
  const pids: number[] = []
  const mgr = new FrontendPluginManager()
  cleanups.push(async () => {
    try {
      await mgr.closeBackendPlugins()
      await waitUntil(() => pids.every((pid) => !alive(pid)))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  // A folder plugin with a backend and no agent tools at all.
  const packageDir = join(root, 'dev', 'acme.devtool')
  mkdirSync(join(packageDir, 'backend'), { recursive: true })
  writeFileSync(join(packageDir, 'backend', 'fixture'), 'binary', { mode: 0o700 })
  writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.devtool', name: 'acme.devtool', version: '0.1.0', publisher: 'acme',
    permissions: { system: ['fs'] },
    marketplace: { description: 'Fixture.', license: 'MIT' },
    backend: { entry: 'backend/fixture', protocolVersion: 1, activation: 'startup', methods: ['fixture.echo'] },
  }))
  const spec = thirdPartyBackendLaunchSpec(
    {
      pluginId: 'acme.devtool', packageVersion: '0.1.0', packageDir, views: [],
      backend: { entryFile: join(packageDir, 'backend', 'fixture'), protocolVersion: 1, activation: 'startup' },
    },
    readInstalledManifestV2(packageDir),
  )!
  const policy: ExecutionPolicySnapshot = { policy: HOST_DEFAULT_EXECUTION_POLICY, revision: 1, state: 'default' }
  mgr.setExecutionPolicyResolver(() => policy)
  mgr.setCapabilityGrantResolver((_pluginId, packageVersion) => ({ packageVersion, system: ['fs'], storage: true }))
  mgr.registerDescriptor({
    id: 'acme.devtool', packageVersion: '0.1.0', packageDir, requires: ['fs'],
    capabilityPolicy: manifestV2CapabilityPolicy({ system: ['fs'] }), devUrl: '',
    entryFile: join(packageDir, 'index.html'), views: [],
  }, { builtin: true })
  mgr.registerBackendActivation(spec)
  mgr.setThirdPartyBackendAdmitter(async () => ({
    spawnProcess: (_entryFile, spawnOptions) => {
      const child = spawn(process.execPath, [FIXTURE], {
        ...spawnOptions,
        env: { ...spawnOptions.env, NAVIDE_FIXTURE: 'backend-wire' },
      }) as ChildProcessWithoutNullStreams
      if (child.pid !== undefined) pids.push(child.pid)
      return child
    },
    bridgeDispatcher: { dispatch: vi.fn() },
    beforeSpawn: async () => undefined,
    noteFailure: () => null,
    workspaceRoot: workspace,
  }))
  mgr.setAgentToolWorkspaceResolver((candidate) => candidate === workspace)
  const gate = { state: 'ok' as DeveloperBackendGate }
  if (options.installGate !== false) mgr.setDeveloperBackendGate(() => gate.state)
  let next = 0
  const call = async (method: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const id = `mcp:${++next}`
    return await mgr.executeDeveloperBackendCall({
      request_id: id,
      operation: 'developerBackend',
      target: { plugin_id: 'acme.devtool', workspace_path: workspace },
      caller: { kind: 'pane', paneId: 'p-7', workspace, verifiedTo: 'pane' },
      payload: { reqId: id, name: method, args, timeoutMs: 10_000 },
      ...extra,
    }) as unknown as Record<string, unknown>
  }
  return { mgr, workspace, pids, gate, call }
}

describe('plugins_developer_backend_call on the Host', () => {
  it('calls a declared method of a folder plugin as an agent, without any agent tool', async () => {
    const f = await live()
    const response = await f.call('fixture.echo', { probe: 1 })
    expect(response).toMatchObject({ ok: true, packageVersion: '0.1.0' })
    const answer = response.result as { arguments: unknown; runtime: { initiator: unknown; pluginId: string } }
    expect(answer.arguments).toEqual({ probe: 1 })
    expect(answer.runtime.pluginId).toBe('acme.devtool')
    expect(answer.runtime.initiator).toMatchObject({
      kind: 'agent', source: 'mcp', caller: { kind: 'pane', paneId: 'p-7', workspace: f.workspace, verifiedTo: 'pane' },
    })
    expect(f.pids).toHaveLength(1)
  }, 30_000)

  it.each([
    ['not-developer-plugin', 'NOT_DEVELOPER_PLUGIN'],
    ['developer-mode-off', 'DEVELOPER_MODE_OFF'],
    ['plugin-stopped', 'PLUGIN_STOPPED'],
  ] as const)('refuses a plugin whose gate says %s, before any child starts', async (state, code) => {
    const f = await live()
    f.gate.state = state
    const response = await f.call('fixture.echo')
    expect(response).toMatchObject({ ok: false, error: { code } })
    expect(f.pids).toEqual([])
  })

  it('refuses everything while no gate is installed', async () => {
    const f = await live({ installGate: false })
    expect(await f.call('fixture.echo')).toMatchObject({ ok: false, error: { code: 'DEVELOPER_MODE_OFF' } })
    expect(f.pids).toEqual([])
  })

  it('refuses a method the manifest does not declare', async () => {
    const f = await live()
    const response = await f.call('fixture.undeclared')
    expect(response.ok).toBe(false)
    expect(response).toMatchObject({ packageVersion: '0.1.0' })
  }, 30_000)

  it('refuses a workspace that is not an open Navide workspace', async () => {
    const f = await live()
    f.mgr.setAgentToolWorkspaceResolver(() => false)
    expect(await f.call('fixture.echo')).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_AUTHORIZED' } })
    expect(f.pids).toEqual([])
  })

  it('a gate that closes during the call stops the bridge serving it', async () => {
    const f = await live()
    await f.call('fixture.echo')
    f.gate.state = 'plugin-stopped'
    const served = (f.mgr as unknown as {
      agentCallStillServed: (call: unknown) => boolean
    }).agentCallStillServed({ pluginId: 'acme.devtool', caller: { kind: 'host', paneId: null, workspace: null }, spec: { packageVersion: '0.1.0' }, developer: true })
    expect(served).toBe(false)
  }, 30_000)
})

describe('parseDeveloperBackendRequest', () => {
  const base = {
    request_id: 'mcp:1',
    operation: 'developerBackend',
    target: { plugin_id: 'acme.devtool', workspace_path: '/ws' },
    caller: { kind: 'pane', paneId: 'p-1', workspace: '/ws', verifiedTo: 'pane' },
    payload: { reqId: 'mcp:1', name: 'm', args: {}, timeoutMs: 1000 },
  }

  it('reads a well-formed request', () => {
    expect(parseDeveloperBackendRequest(base)).toMatchObject({ pluginId: 'acme.devtool', method: 'm', timeoutMs: 1000 })
  })

  it.each([
    ['another operation', { ...base, operation: 'agentTool' }],
    ['no caller', { ...base, caller: undefined }],
    ['a caller label that does not match its kind', { ...base, caller: { ...base.caller, verifiedTo: 'caller-kind' } }],
    ['an external caller with a pane', { ...base, caller: { kind: 'external', paneId: 'p', workspace: null, verifiedTo: 'caller-kind' } }],
    ['a relative workspace', { ...base, target: { ...base.target, workspace_path: 'ws' } }],
    ['arguments that are not an object', { ...base, payload: { ...base.payload, args: [] } }],
    ['a timeout out of range', { ...base, payload: { ...base.payload, timeoutMs: 0 } }],
    ['an extra key', { ...base, extra: true }],
  ])('refuses %s', (_label, request) => {
    expect(parseDeveloperBackendRequest(JSON.parse(JSON.stringify(request)))).toBeNull()
  })
})
