import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackendPluginError,
  createAuthenticatedBackendRuntime,
  MCP_PROTOCOL_REVISION,
  parseBackendWireFrame,
  parseBackendWireHostFrame,
  PluginBackendSupervisor,
  type AuthenticatedBackendRuntime,
  type BackendPluginEvent,
  type BackendPluginLaunchSpec,
  type PluginBackendSupervisorOptions,
  type BackendRuntimeContext,
} from './pluginBackendSupervisor'
import {
  PLANS_BRIDGE_PORTS,
  createInMemoryPlansBridgeDispatcher,
  createProductionPlansBridgeDispatcher,
  createTestPlansFilesystemPort,
  type PlansBridgePort,
} from './plansBridge'
import { MAX_IGNORED_REQUEST_IDS } from './pluginBackendSupervisor'
import { MAX_BACKEND_BRIDGE_RESULT_BYTES } from './pluginBackendLimits'
import { verifyInstalledBackendSpawnTrust } from './pluginBackendSpawnTrust'
import { immutablePluginPackageDir, PluginActivationSelector } from './pluginActivationSelector'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  registryReceiptFromEvidence,
  type InstalledRegistryTrustContext,
} from './pluginInstalledTrust'
import { canonicalTrustJson, type RegistryPackageEnvelope, type RegistryTrustMetadata } from './pluginRegistryTrust'
import { sha256Hex } from './pluginVerify'
import { makeZip } from './zipFixture'

// Many real fsyncs per test that no assertion can observe; see tests/support/noFsync.ts.
vi.mock('node:fs', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutFsyncSync(await importOriginal()))
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutHandleSync(await importOriginal()))

const fixture = fileURLToPath(new URL('./test-fixtures/backend-wire-child.mjs', import.meta.url))
const packagedFixtureEnabled = process.env.NAVIDE_TEST_PACKAGED_PLANS === '1'
const packagedFixtures = [
  ['Python', join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans')],
  ['Go', join(process.cwd(), 'dist-test-fixtures/plans/backend/navide-plans-go')],
] as const
if (packagedFixtureEnabled && packagedFixtures.some(([, entryFile]) => !existsSync(entryFile))) {
  throw new Error('NAVIDE_TEST_PACKAGED_PLANS=1 requires both packaged Plans fixtures; run pnpm run build:plans:fixture first.')
}
const packagedBackendEnvironment: Record<string, string> = {}
for (const key of ['TMPDIR', 'TEMP', 'TMP'] as const) {
  const value = process.env[key]
  if (typeof value === 'string' && value.length > 0) packagedBackendEnvironment[key] = value
}

const activation: BackendPluginLaunchSpec = {
  pluginId: 'acme.backend',
  packageVersion: '1.2.3',
  packageDir: process.cwd(),
  entryFile: fixture,
  protocolVersion: 1,
  activation: 'startup',
  approvedMethods: [
    'fixture.cancelcount',
    'fixture.close',
    'fixture.delay',
    'fixture.duplicateevent',
    'fixture.duplicatekeys',
    'fixture.echo',
    'fixture.bridge',
    'fixture.emit',
    'fixture.exit',
    'fixture.forgedruntime',
    'fixture.forgedevent',
    'fixture.lateresponse',
    'fixture.multiline',
    'fixture.unknownmethod',
    'fixture.unknownnotification',
    'fixture.badversion',
    'fixture.progress',
    'fixture.protocolerror',
    'fixture.publicerror',
    'fixture.stderr',
    'plans.resolve_root',
  ],
  approvedEvents: ['fixture.changed', 'plans.changed'],
  approvedBridgePorts: ['filesystem'],
}

const runtime: BackendRuntimeContext = {
  pluginId: activation.pluginId,
  packageVersion: activation.packageVersion,
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  contributionKey: 'acme.backend.panel',
  hostWindowId: 'window-1',
  initiator: { kind: 'user', id: 'user-1' },
}

const authenticatedRuntime = createAuthenticatedBackendRuntime(runtime)

const packagedActivation = {
  pluginId: 'navide.plans',
  packageVersion: '0.1.92',
  packageDir: process.cwd(),
  protocolVersion: 1 as const,
  activation: 'startup' as const,
  approvedMethods: [
    'fixture.cancelcount',
    'fixture.close',
    'fixture.delay',
    'fixture.duplicateevent',
    'fixture.duplicatekeys',
    'fixture.echo',
    'fixture.forgedevent',
    'fixture.emit',
    'fixture.exit',
    'fixture.forgedruntime',
    'fixture.lateresponse',
    'fixture.multiline',
    'fixture.unknownmethod',
    'fixture.unknownnotification',
    'fixture.badversion',
    'fixture.progress',
    'fixture.protocolerror',
    'fixture.publicerror',
    'fixture.stderr',
    'plans.resolve_root',
  ],
  approvedEvents: ['fixture.changed', 'plans.changed'],
  approvedBridgePorts: ['filesystem'] as const,
}

const packagedRuntime = createAuthenticatedBackendRuntime({
  pluginId: packagedActivation.pluginId,
  packageVersion: packagedActivation.packageVersion,
  workspaceId: 'workspace-1',
  instanceId: 'instance-1',
  contributionKey: 'navide.plans.window',
  hostWindowId: 'window-1',
  initiator: { kind: 'user', id: 'user-1' },
})

function signedBackendFixture(root: string, version = '1.0.0', label = 'Backend'): {
  packageDir: string
  selection: { packageVersion: string; target: string; artifactDigest: string }
  trust: InstalledRegistryTrustContext
} {
  const pluginId = 'acme.backend'
  const target = 'universal'
  const packageDir = immutablePluginPackageDir(root, pluginId, version, target)
  mkdirSync(join(packageDir, 'frontend'), { recursive: true })
  const manifest = JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: pluginId,
    name: label,
    version,
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'Backend', license: 'MIT' },
    contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: label, entry: 'frontend/index.html' }] },
  })
  const archive = new Uint8Array(makeZip([
    { name: 'manifest.json', data: manifest },
    { name: 'frontend/index.html', data: `<!doctype html><!-- ${label} -->` },
  ]))
  const digest = sha256Hex(archive)
  const rootKey = generateKeyPairSync('ed25519')
  const signerKey = generateKeyPairSync('ed25519')
  const rootPem = rootKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const signerPem = signerKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const metadata: RegistryTrustMetadata = {
    schemaVersion: 1,
    registryProfile: 'official',
    rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [{ keyId: 'spawn-test', publicKey: signerPem, status: 'active', notBefore: '2026-08-01T00:00:00.000Z', notAfter: '2026-09-01T00:00:00.000Z' }],
    blockedPublishers: [],
    blockedPackages: [],
  }
  const signed = (value: unknown, key = signerKey.privateKey): string =>
    edSign(null, Buffer.from(canonicalTrustJson(value)), key).toString('base64')
  const envelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest: digest,
    packageId: pluginId,
    version,
    target,
    publisherId: 'acme',
    keyId: 'spawn-test',
    signedAt: '2026-08-16T11:00:00.000Z',
  }
  writeFileSync(join(packageDir, 'manifest.json'), manifest)
  writeFileSync(join(packageDir, 'frontend/index.html'), `<!doctype html><!-- ${label} -->`)
  writeFileSync(join(packageDir, REGISTRY_ARTIFACT_NAME), archive)
  writeFileSync(join(packageDir, REGISTRY_RECEIPT_NAME), JSON.stringify(registryReceiptFromEvidence({
    packageId: pluginId, version, publisherId: 'acme', target, artifactDigest: digest,
    envelope, envelopeSignature: signed(envelope), registryAuthority: 'official',
  })))
  return {
    packageDir,
    selection: { packageVersion: version, target, artifactDigest: digest },
    trust: {
      pinnedRootKey: rootPem,
      snapshot: { schemaVersion: 1, metadata, metadataSignature: signed(metadata, rootKey.privateKey) },
      registryAuthority: 'official',
      expectedTarget: target,
      now: new Date('2026-08-16T12:00:00.000Z'),
    },
  }
}

function makeSupervisor(
  overrides: Partial<PluginBackendSupervisorOptions> = {}
): PluginBackendSupervisor {
  return new PluginBackendSupervisor(activation, {
    ...overrides,
    environment: overrides.environment ?? { NAVIDE_FIXTURE: 'backend-wire' },
    spawnProcess: overrides.spawnProcess ?? ((entryFile, options) =>
      spawn(process.execPath, [entryFile], {
        ...options,
        env: options.env,
      }) as ChildProcessWithoutNullStreams),
  })
}

function makePackagedSupervisor(entryFile: string): PluginBackendSupervisor {
  return new PluginBackendSupervisor(
    { ...packagedActivation, entryFile },
    {
      environment: packagedBackendEnvironment,
      bridgeDispatcher: createProductionPlansBridgeDispatcher({ filesystem: createTestPlansFilesystemPort() }),
      authorizedPlanRoot: { value: process.cwd() },
      spawnProcess: (nextEntryFile, options) =>
        spawn(nextEntryFile, [], { ...options, env: options.env }) as ChildProcessWithoutNullStreams,
    },
  )
}

function makeControlledChild(
  generation: number,
  ignoredMethods: readonly string[] = [],
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let exited = false
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').trim().split('\n')) {
      if (!line) continue
      const frame = JSON.parse(line) as {
        id?: string | number
        method?: string
        params?: { name?: string }
      }
      if (frame.id === undefined || ignoredMethods.includes(frame.params?.name ?? '')) continue
      stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            resultType: 'complete',
            value: { generation },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'controlled', version: '1.0.0' } },
          },
        })}\n`
      )
    }
  })
  const killSignals: Array<NodeJS.Signals | number | undefined> = []
  const kill = (signal?: NodeJS.Signals | number): boolean => {
    killSignals.push(signal)
    if (exited) return true
    exited = true
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  return Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill,
    killSignals,
    pid: generation,
  }) as unknown as ChildProcessWithoutNullStreams
}

function makeBridgeChild(
  onFrame?: (frame: string) => void,
  port: PlansBridgePort = 'filesystem',
  operation = 'resolve_root',
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let input = ''
  let exited = false
  let parentCallId = ''
  const writeFrame = (frame: string): void => {
    onFrame?.(frame)
    stdout.write(frame)
  }
  stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    while (true) {
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const frame = JSON.parse(input.slice(0, newline)) as {
        id?: string
        method?: string
        params?: { name?: string; arguments?: unknown }
        result?: { value?: unknown }
        error?: unknown
      }
      input = input.slice(newline + 1)
      if (frame.method === 'navide/health' && frame.id) {
        writeFrame(`${JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            resultType: 'complete',
            value: { ok: true },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'bridge-child', version: '1.0.0' } },
          },
        })}\n`)
        continue
      }
      if (frame.method === 'navide/call' && frame.id && frame.params?.name === 'fixture.bridge') {
        parentCallId = frame.id
        writeFrame(`${JSON.stringify({
          jsonrpc: '2.0',
          id: 'bridge:child-request',
          method: 'navide/host/call',
          params: {
            origin: { kind: 'call', requestId: frame.id },
            port,
            operation,
            arguments: {},
          },
        })}\n`)
        continue
      }
      if (frame.method === 'navide/call' && frame.id && frame.params?.name === 'fixture.echo') {
        writeFrame(`${JSON.stringify({
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            resultType: 'complete',
            value: { arguments: frame.params.arguments },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'bridge-child', version: '1.0.0' } },
          },
        })}\n`)
        continue
      }
      if (frame.id === 'bridge:child-request' && frame.result && frame.id) {
        writeFrame(`${JSON.stringify({
          jsonrpc: '2.0',
          id: parentCallId,
          result: {
            resultType: 'complete',
            value: frame.result.value,
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'bridge-child', version: '1.0.0' } },
          },
        })}\n`)
      }
      if (frame.id === 'bridge:child-request' && frame.error && parentCallId) {
        writeFrame(`${JSON.stringify({
          jsonrpc: '2.0',
          id: parentCallId,
          error: frame.error,
        })}\n`)
      }
    }
  })
  const kill = (): boolean => {
    if (exited) return true
    exited = true
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  return Object.assign(child, { stdin, stdout, stderr, kill, pid: 99 }) as unknown as ChildProcessWithoutNullStreams
}

function bridgeOperationForPort(port: PlansBridgePort): string {
  switch (port) {
    case 'filesystem':
      return 'resolve_root'
    case 'workspace-storage':
      return 'get'
    case 'terminal':
      return 'create'
    case 'agent-messaging':
      return 'list'
    case 'routes':
      return 'invoke'
    case 'streams':
      return 'open'
    case 'spawn':
      return 'transform'
  }
  const exhaustive: never = port
  return exhaustive
}

function makeBridgePolicySupervisor(
  port: PlansBridgePort,
  overrides: Partial<PluginBackendSupervisorOptions> = {},
): PluginBackendSupervisor {
  return new PluginBackendSupervisor(
    { ...activation, approvedBridgePorts: [port] },
    {
      ...overrides,
      environment: overrides.environment ?? { NAVIDE_FIXTURE: 'backend-wire' },
      spawnProcess: overrides.spawnProcess ?? (() => makeBridgeChild(undefined, port, bridgeOperationForPort(port))),
    },
  )
}

describe('PluginBackendSupervisor', () => {
  const supervisors: PluginBackendSupervisor[] = []

  afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()))
  })

  it('starts a child process and completes health plus one unary call', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)

    const health = await supervisor.start()
    expect(health.value).toEqual({
      method: 'navide/health',
      protocolVersion: MCP_PROTOCOL_REVISION,
      requestIdIsNonNull: true,
      clientCapabilities: {},
    })
    expect(health.serverInfo).toEqual({ name: 'fixture.backend', version: '1.0.0' })

    const result = await supervisor.clientFor(authenticatedRuntime).call('fixture.echo', {
      value: 42,
      runtime: { hostWindowId: 'caller-supplied-value' },
    })
    expect(result).toEqual({
      arguments: {
        value: 42,
        runtime: { hostWindowId: 'caller-supplied-value' },
      },
      runtime,
    })
  })

  it('rejects a method that is not in the Host activation allowlist', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.notallowed', null)
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('retains the replacement watch reservation when a cancelled watch settles late', async () => {
    const releases: Array<() => void> = []
    let origin: unknown
    const child = makeBridgeChild((frame) => {
      const parsed = JSON.parse(frame)
      if (parsed.method === 'navide/host/call') origin = parsed.params.origin
    }, 'filesystem', 'watch')
    const dispatch = vi.fn(() => new Promise<null>((resolve) => { releases.push(() => resolve(null)) }))
    const supervisor = makeSupervisor({ bridgeDispatcher: { dispatch }, spawnProcess: () => child })
    supervisors.push(supervisor)
    await supervisor.start()
    const controller = new AbortController()
    const parent = supervisor.clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
      .call('fixture.bridge', null, { signal: controller.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const send = (frame: unknown): void => { child.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`)) }
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'bridge:child-request' } })
    send({ jsonrpc: '2.0', id: 'bridge:replacement', method: 'navide/host/call', params: {
      origin, port: 'filesystem', operation: 'watch', arguments: {},
    } })
    expect(dispatch).toHaveBeenCalledTimes(2)
    releases[0]()
    await Promise.resolve()
    await Promise.resolve()
    send({ jsonrpc: '2.0', id: 'bridge:third', method: 'navide/host/call', params: {
      origin, port: 'filesystem', operation: 'watch', arguments: {},
    } })
    expect(dispatch).toHaveBeenCalledTimes(2)
    controller.abort()
    for (const release of releases) release()
    await parent
  })

  it('dispatches a private Bridge request with the authenticated parent runtime', async () => {
    let bridgeRequest: unknown
    const supervisor = makeSupervisor({
      bridgeDispatcher: createInMemoryPlansBridgeDispatcher(),
      spawnProcess: () => makeBridgeChild((frame) => {
        if (frame.includes('navide/host/call')) {
          bridgeRequest = JSON.parse(frame.trim())
        }
      }),
    })
    supervisors.push(supervisor)

    await supervisor.start()
    // resolve(): on Windows '/workspace' comes back as 'D:\\workspace', so a
    // literal comparison only holds on POSIX.
    await expect(
      supervisor.clientFor(authenticatedRuntime, { workspacePath: resolve('/workspace') }).call('fixture.bridge', null)
    ).resolves.toEqual({ root: resolve('/workspace') })
    expect(bridgeRequest).toEqual({
      jsonrpc: '2.0',
      id: 'bridge:child-request',
      method: 'navide/host/call',
      params: {
        origin: { kind: 'call', requestId: expect.any(String) },
        port: 'filesystem',
        operation: 'resolve_root',
        arguments: {},
      },
    })
    expect(bridgeRequest).not.toHaveProperty('params.runtime')
  })

  it('keeps an agent Initiator on the child call and Host bridge context', async () => {
    let bridgeRuntime: BackendRuntimeContext | undefined
    const supervisor = makeSupervisor({
      resolveExecutionPolicy: () => ({
        policy: { schemaVersion: 1, mode: 'allowlist', system: ['fs'], shell: [] },
        revision: 1,
        state: 'user',
      }),
      bridgeDispatcher: {
        dispatch: async (_request, context) => {
          bridgeRuntime = context.runtime
          return { root: '/workspace' }
        },
      },
      spawnProcess: () => makeBridgeChild(),
    })
    supervisors.push(supervisor)
    const agentRuntime = createAuthenticatedBackendRuntime({
      ...runtime,
      initiator: { kind: 'agent', source: 'mcp', id: 'agent-request-1' },
    })

    await supervisor.start()
    await expect(
      supervisor.clientFor(agentRuntime, { workspacePath: '/workspace' }).call('fixture.bridge', null)
    ).resolves.toEqual({ root: '/workspace' })
    expect(bridgeRuntime?.initiator).toEqual({
      kind: 'agent',
      source: 'mcp',
      id: 'agent-request-1',
    })
  })

  it('rejects an agent filesystem Bridge request when fs is not allowed', async () => {
    const bridgeDispatcher = vi.fn(async () => ({ root: '/workspace' }))
    const supervisor = makeBridgePolicySupervisor('filesystem', {
      resolveExecutionPolicy: () => ({
        policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
        revision: 1,
        state: 'user',
      }),
      bridgeDispatcher: { dispatch: bridgeDispatcher },
    })
    supervisors.push(supervisor)
    const agentRuntime = createAuthenticatedBackendRuntime({
      ...runtime,
      initiator: { kind: 'agent', source: 'mcp', id: 'filesystem-denied-agent' },
    })

    await supervisor.start()
    await expect(
      supervisor
        .clientFor(agentRuntime, { workspacePath: '/workspace' })
        .call('fixture.bridge', null)
    ).rejects.toMatchObject({ code: 'PLUGIN_ERROR', pluginCode: 'CAPABILITY_DENIED' })
    expect(bridgeDispatcher).not.toHaveBeenCalled()
  })

  it.each(PLANS_BRIDGE_PORTS.filter((port) => port !== 'filesystem'))(
    'rejects agent Bridge use of unmapped %s even in full policy',
    async (port) => {
      const bridgeDispatcher = vi.fn(async () => ({ ok: true }))
      const supervisor = makeBridgePolicySupervisor(port, {
        resolveExecutionPolicy: () => ({
          policy: { schemaVersion: 1, mode: 'full', system: [], shell: [] },
          revision: 1,
          state: 'user',
        }),
        bridgeDispatcher: { dispatch: bridgeDispatcher },
      })
      supervisors.push(supervisor)
      const agentRuntime = createAuthenticatedBackendRuntime({
        ...runtime,
        initiator: { kind: 'agent', source: 'mcp', id: `${port}-agent` },
      })

      await supervisor.start()
      await expect(
        supervisor
          .clientFor(agentRuntime, { workspacePath: '/workspace' })
          .call('fixture.bridge', null)
      ).rejects.toMatchObject({ code: 'PLUGIN_ERROR', pluginCode: 'CAPABILITY_DENIED' })
      expect(bridgeDispatcher).not.toHaveBeenCalled()
    },
  )

  it.each(PLANS_BRIDGE_PORTS)(
    'does not apply the agent Bridge policy to user %s operations',
    async (port) => {
      const bridgeDispatcher = vi.fn(async () => ({ ok: true }))
      const supervisor = makeBridgePolicySupervisor(port, {
        resolveExecutionPolicy: () => ({
          policy: { schemaVersion: 1, mode: 'allowlist', system: [], shell: [] },
          revision: 1,
          state: 'corrupt',
        }),
        bridgeDispatcher: { dispatch: bridgeDispatcher },
      })
      supervisors.push(supervisor)

      await supervisor.start()
      await expect(
        supervisor
          .clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
          .call('fixture.bridge', null)
      ).resolves.toEqual({ ok: true })
      expect(bridgeDispatcher).toHaveBeenCalledOnce()
    },
  )

  it('fails closed without killing the child when the policy resolver throws', async () => {
    const bridgeDispatcher = vi.fn(async () => ({ root: '/workspace' }))
    const supervisor = makeSupervisor({
      resolveExecutionPolicy: () => {
        throw new Error('policy state unavailable')
      },
      bridgeDispatcher: { dispatch: bridgeDispatcher },
      spawnProcess: () => makeBridgeChild(),
    })
    supervisors.push(supervisor)

    await supervisor.start()
    await expect(
      supervisor.clientFor(
        createAuthenticatedBackendRuntime({
          ...runtime,
          initiator: { kind: 'agent', source: 'mcp', id: 'resolver-error-agent' },
        }),
        { workspacePath: '/workspace' },
      ).call('fixture.bridge', null)
    ).rejects.toMatchObject({ code: 'PLUGIN_ERROR' })
    expect(bridgeDispatcher).not.toHaveBeenCalled()
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', { value: 'still-ready' })
    ).resolves.toMatchObject({ arguments: { value: 'still-ready' } })
  })

  it('aborts a pending Bridge dispatcher when the child crashes', async () => {
    let child: ChildProcessWithoutNullStreams | undefined
    let bridgeStarted!: () => void
    const bridgeStart = new Promise<void>((resolve) => {
      bridgeStarted = resolve
    })
    let bridgeAborted!: () => void
    const bridgeAbort = new Promise<void>((resolve) => {
      bridgeAborted = resolve
    })
    const supervisor = makeSupervisor({
      bridgeDispatcher: {
        dispatch: async (_request, context) => {
          bridgeStarted()
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) {
              resolve()
              return
            }
            context.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          bridgeAborted()
          throw new Error('bridge aborted')
        },
      },
      spawnProcess: () => {
        child = makeBridgeChild()
        return child
      },
    })
    supervisors.push(supervisor)

    await supervisor.start()
    const pending = supervisor
      .clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
      .call('fixture.bridge', null)
    await bridgeStart
    ;(child as unknown as EventEmitter).emit('exit', 17, null)

    await expect(pending).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    await expect(bridgeAbort).resolves.toBeUndefined()
  })

  it('returns a stable error when a private Bridge result exceeds its encoded bound', async () => {
    const supervisor = makeSupervisor({
      bridgeDispatcher: {
        dispatch: async () => ({ content: 'x'.repeat(MAX_BACKEND_BRIDGE_RESULT_BYTES) }),
      },
      spawnProcess: () => makeBridgeChild(),
    })
    supervisors.push(supervisor)

    await supervisor.start()
    const error = await supervisor
      .clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
      .call('fixture.bridge', null)
      .catch((value) => value)

    expect(error).toMatchObject({
      code: 'RESULT_TOO_LARGE',
      pluginCode: 'RESULT_TOO_LARGE',
    })
  })

  it('acknowledges a subscription before delivering the requested event', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const received: unknown[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      (event) => received.push(event)
    )

    await subscription.acknowledged
    expect(received).toEqual([])

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.emit', {
        event: 'fixture.changed',
        payload: { value: 1 },
      })
    ).resolves.toEqual({ ok: true })

    await vi.waitFor(() => {
      expect(received).toEqual([
        {
          subscriptionId: subscription.subscriptionId,
          event: 'fixture.changed',
          payload: { value: 1 },
        },
      ])
    })

    subscription.dispose()
  })

  it('rejects events outside the Host-approved package catalog', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    expect(() =>
      supervisor.clientFor(authenticatedRuntime).subscribe(['fixture.other'], () => undefined)
    ).toThrowError(new BackendPluginError('INVALID_ARGUMENT'))
  })

  it('rejects malformed subscription options with a stable public error', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const client = supervisor.clientFor(authenticatedRuntime)
    expect(() =>
      client.subscribe(['fixture.changed'], () => undefined, {
        onProgress: 'not-a-listener' as unknown as () => void,
      })
    ).toThrowError(new BackendPluginError('INVALID_ARGUMENT'))
    expect(() =>
      client.subscribe(['fixture.changed'], () => undefined, {
        signal: {} as AbortSignal,
      })
    ).toThrowError(new BackendPluginError('INVALID_ARGUMENT'))
  })

  it('fails closed when the child emits before acknowledgment', async () => {
    const supervisor = makeSupervisor({
      environment: {
        NAVIDE_FIXTURE: 'backend-wire',
        NAVIDE_FIXTURE_EVENT_BEFORE_ACK: '1',
      },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )

    await expect(subscription.acknowledged).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Backend plugin returned an invalid protocol message.',
    })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'protocol-error' })
  })

  it('fails closed when an event addresses an unknown subscription', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await subscription.acknowledged

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.forgedevent', { subscriptionId: 'forged-subscription' })
      .catch((value) => value)

    expect(error).toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Backend plugin returned an invalid protocol message.',
    })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'protocol-error' })
  })

  it('fails closed when a child emits an event outside the requested filter', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await subscription.acknowledged

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.emit', { event: 'fixture.other', payload: null })
      .catch((value) => value)

    expect(error).toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'protocol-error' })
  })

  it('fails closed on an unknown notification or duplicate subscription event keys', async () => {
    for (const method of ['fixture.unknownnotification', 'fixture.duplicateevent']) {
      const supervisor = makeSupervisor()
      supervisors.push(supervisor)
      await supervisor.start()
      const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
        ['fixture.changed'],
        () => undefined
      )
      await subscription.acknowledged

      const error = await supervisor.clientFor(authenticatedRuntime).call(method, null).catch((value) => value)
      expect(error).toMatchObject({
        code: 'PROTOCOL_ERROR',
        message: 'Backend plugin returned an invalid protocol message.',
      })
      await expect(subscription.settled).resolves.toMatchObject({ reason: 'protocol-error' })
    }
  })

  it('settles cancellation and view destruction exactly once', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const cancelled = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await cancelled.acknowledged
    cancelled.dispose()
    cancelled.dispose('view-destroyed')
    await expect(cancelled.settled).resolves.toMatchObject({ reason: 'cancelled' })

    const destroyed = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await destroyed.acknowledged
    destroyed.dispose('view-destroyed')
    destroyed.dispose()

    await expect(destroyed.settled).resolves.toMatchObject({ reason: 'view-destroyed' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)
    ).resolves.toEqual(2)
  })

  it('ignores queued acknowledgment, event, and closure after cancel-before-ack', async () => {
    const supervisor = makeSupervisor({
      environment: {
        NAVIDE_FIXTURE: 'backend-wire',
        NAVIDE_FIXTURE_LATE_ACK_AFTER_CANCEL: '1',
      },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const received: BackendPluginEvent[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      (event) => received.push(event)
    )
    subscription.dispose()

    await expect(subscription.acknowledged).rejects.toMatchObject({ code: 'USER_CANCELLED' })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'cancelled' })
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)
    ).resolves.toEqual(1)
    expect(received).toEqual([])
  })

  it('settles a subscription timeout and sends one cancellation', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined,
      { timeoutMs: 20 }
    )
    await subscription.acknowledged

    await expect(subscription.settled).resolves.toMatchObject({ reason: 'timeout' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)
    ).resolves.toEqual(1)
  })

  it('bounds active subscription state', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const client = supervisor.clientFor(authenticatedRuntime)
    const subscriptions = Array.from({ length: 256 }, () =>
      client.subscribe(['fixture.changed'], () => undefined)
    )
    await Promise.all(subscriptions.map((subscription) => subscription.acknowledged))

    expect(() => client.subscribe(['fixture.changed'], () => undefined)).toThrowError(
      new BackendPluginError('RESOURCE_LIMIT')
    )

    subscriptions.forEach((subscription) => subscription.dispose())
    await Promise.all(subscriptions.map((subscription) => subscription.settled))
  })

  it('delivers progress only to the owning subscription', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const progress: unknown[] = []
    const otherProgress: unknown[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined,
      { onProgress: (value) => progress.push(value) }
    )
    const other = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined,
      { onProgress: (value) => otherProgress.push(value) }
    )
    await subscription.acknowledged
    await other.acknowledged
    const subscriptionId = subscription.subscriptionId
    expect(subscriptionId).toEqual(expect.any(String))
    if (subscriptionId === undefined) throw new Error('Expected a subscription id.')

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.progress', {
        subscriptionId,
      })
    ).resolves.toEqual({ ok: true })
    expect(progress).toEqual([
      {
        progressToken: subscription.subscriptionId,
        progress: 1,
        total: 2,
        message: 'fixture progress',
      },
    ])
    expect(otherProgress).toEqual([])
    subscription.dispose()
    other.dispose()
  })

  it('settles a backend-initiated graceful subscription closure once', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await subscription.acknowledged
    const subscriptionId = subscription.subscriptionId
    expect(subscriptionId).toEqual(expect.any(String))
    if (subscriptionId === undefined) throw new Error('Expected a subscription id.')

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.close', {
        subscriptionId,
      })
    ).resolves.toEqual({ ok: true })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'backend-closed' })
    await expect(subscription.settled).resolves.toMatchObject({ reason: 'backend-closed' })
  })

  it('re-establishes only the live subscription after child restart', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const received: BackendPluginEvent[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      (event) => received.push(event)
    )
    await subscription.acknowledged
    const firstSubscriptionId = subscription.subscriptionId
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.emit', {
        event: 'fixture.changed',
        payload: { generation: 1 },
      })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(received).toHaveLength(1))

    const cancelled = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      () => undefined
    )
    await cancelled.acknowledged
    cancelled.dispose()
    await expect(cancelled.settled).resolves.toMatchObject({ reason: 'cancelled' })

    await expect(supervisor.restart()).resolves.toMatchObject({
      serverInfo: { name: 'fixture.backend', version: '1.0.0' },
    })
    expect(subscription.subscriptionId).not.toBe(firstSubscriptionId)
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.emit', {
        event: 'fixture.changed',
        payload: { generation: 2 },
      })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received[1].payload).toEqual({ generation: 2 })
  })

  it('can restart after an unexpected child exit and restore the live subscription', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const received: BackendPluginEvent[] = []
    const subscription = supervisor.clientFor(authenticatedRuntime).subscribe(
      ['fixture.changed'],
      (event) => received.push(event)
    )
    await subscription.acknowledged

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.exit', null)
    ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    await expect(supervisor.restart()).resolves.toBeDefined()

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.emit', {
        event: 'fixture.changed',
        payload: { recovered: true },
      })
    ).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0].payload).toEqual({ recovered: true })
  })

  it('drains a completing request before switching the child generation', async () => {
    const supervisor = makeSupervisor({ drainTimeoutMs: 250 })
    supervisors.push(supervisor)
    await supervisor.start()

    const pending = supervisor.clientFor(authenticatedRuntime).call('fixture.delay', { milliseconds: 20 })
    const restarting = supervisor.restart()
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await expect(pending).resolves.toEqual({ delayed: true })
    await expect(restarting).resolves.toMatchObject({
      serverInfo: { name: 'fixture.backend', version: '1.0.0' },
    })
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).resolves.toMatchObject({ runtime })
  })

  it('continues an in-flight call Bridge request while the generation drains', async () => {
    let bridgeStarted!: () => void
    const bridgeStart = new Promise<void>((resolve) => {
      bridgeStarted = resolve
    })
    let releaseBridge!: () => void
    const bridgeRelease = new Promise<void>((resolve) => {
      releaseBridge = resolve
    })
    const supervisor = makeSupervisor({
      bridgeDispatcher: {
        dispatch: async () => {
          bridgeStarted()
          await bridgeRelease
          return { root: '/workspace' }
        },
      },
      spawnProcess: () => makeBridgeChild(),
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const pending = supervisor
      .clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
      .call('fixture.bridge', null)
    await bridgeStart
    const restarting = supervisor.restart()
    releaseBridge()

    await expect(pending).resolves.toEqual({ root: '/workspace' })
    await expect(restarting).resolves.toMatchObject({
      serverInfo: { name: 'bridge-child', version: '1.0.0' },
    })
  })

  it('ignores late events from a previous child generation', async () => {
    const children: ChildProcessWithoutNullStreams[] = []
    const stderr: string[] = []
    const supervisor = makeSupervisor({
      onStderr: (chunk) => stderr.push(chunk),
      spawnProcess: () => {
        const child = makeControlledChild(children.length + 1)
        children.push(child)
        return child
      },
    })
    supervisors.push(supervisor)

    await supervisor.start()
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).resolves.toEqual({ generation: 1 })
    await supervisor.restart()

    const previous = children[0]
    ;(previous.stdout as unknown as PassThrough).write(
      '{"jsonrpc":"2.0","id":"late-old-response","error":{"code":-32600,"message":"late"}}\n'
    )
    ;(previous.stderr as unknown as PassThrough).write('late old stderr')
    previous.emit('exit', 0, null)

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).resolves.toEqual({ generation: 2 })
    expect(stderr).toEqual([])
  })

  it('requires an explicit child environment and does not inherit the host environment', async () => {
    expect(() =>
      new PluginBackendSupervisor(activation, {} as PluginBackendSupervisorOptions)
    ).toThrowError(new BackendPluginError('INVALID_ACTIVATION'))

    let spawnOptions: Parameters<NonNullable<PluginBackendSupervisorOptions['spawnProcess']>>[1] | undefined
    const supervisor = new PluginBackendSupervisor(activation, {
      environment: { NAVIDE_FIXTURE: 'backend-wire' },
      spawnProcess: (entryFile, options) => {
        spawnOptions = options
        return spawn(process.execPath, [entryFile], {
          ...options,
          env: options.env,
        }) as ChildProcessWithoutNullStreams
      },
    })
    supervisors.push(supervisor)

    await supervisor.start()

    expect(spawnOptions?.env).toEqual({ NAVIDE_FIXTURE: 'backend-wire' })
    expect(spawnOptions?.env).not.toHaveProperty('PATH')
  })

  it.each([
    ['non-string value', { NAVIDE_FIXTURE: 123 }],
    ['NUL in a key', { 'NAVIDE_FIXTURE\u0000': 'backend-wire' }],
    ['NUL in a value', { NAVIDE_FIXTURE: 'backend\u0000wire' }],
    ['invalid key', { 'NAVIDE-FIXTURE': 'backend-wire' }],
  ])('rejects an environment with %s', (_label, environment) => {
    expect(() =>
      new PluginBackendSupervisor(activation, {
        environment: environment as unknown as Record<string, string>,
      })
    ).toThrowError(new BackendPluginError('INVALID_ACTIVATION'))
  })

  it('only accepts an authenticated binding for the activated package', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    expect(() => supervisor.clientFor(runtime as unknown as AuthenticatedBackendRuntime)).toThrowError(
      new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.')
    )
    expect(() =>
      supervisor.clientFor(createAuthenticatedBackendRuntime({ ...runtime, pluginId: 'acme.other' }))
    ).toThrowError(new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.'))
    expect(() =>
      supervisor.clientFor(
        createAuthenticatedBackendRuntime({ ...runtime, packageVersion: '9.9.9' })
      )
    ).toThrowError(new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.'))
    expect(() =>
      createAuthenticatedBackendRuntime({ ...runtime, forged: 'field' } as BackendRuntimeContext)
    ).toThrowError(new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.'))
  })

  it('freezes the Host-authenticated initiator at the runtime boundary', () => {
    const mutableRuntime = {
      ...runtime,
      initiator: { kind: 'user' as const, id: 'user-1' },
    }
    const authenticated = createAuthenticatedBackendRuntime(mutableRuntime)

    mutableRuntime.initiator.id = 'replaced'

    expect(authenticated.initiator).toEqual({ kind: 'user', id: 'user-1' })
    expect(Object.isFrozen(authenticated.initiator)).toBe(true)
  })

  it('does not accept a cloned authentication brand or audience', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const forged = { ...authenticatedRuntime } as AuthenticatedBackendRuntime
    for (const symbol of Object.getOwnPropertySymbols(authenticatedRuntime)) {
      const descriptor = Object.getOwnPropertyDescriptor(authenticatedRuntime, symbol)
      if (descriptor) Object.defineProperty(forged, symbol, descriptor)
    }

    expect(() => supervisor.clientFor(forged)).toThrowError(
      new BackendPluginError('INVALID_RUNTIME', 'Backend runtime is invalid.')
    )
  })

  it('preserves a public plugin error without exposing transport details', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.publicerror', null)
      .catch((value) => value)
    expect(error).toBeInstanceOf(BackendPluginError)
    expect(error).toMatchObject({
      code: 'PLUGIN_ERROR',
      pluginCode: 'INVALID_ARGUMENT',
      requestId: expect.any(String),
      message: 'Plugin request failed.',
    })
    expect(error.stack).toEqual(expect.any(String))
    expect(String(error)).not.toContain('fixture')
    expect(String(error)).not.toContain('transport')
    expect(String(error)).not.toContain('stack')
  })

  it('maps a protocol error with no optional data to a safe protocol error', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.protocolerror', null)
      .catch((value) => value)
    expect(error).toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Backend plugin returned an invalid protocol message.',
    })
  })

  it.each([
    ['wrong version', 'fixture.badversion'],
    ['duplicate keys', 'fixture.duplicatekeys'],
    ['multiline frame', 'fixture.multiline'],
    ['unknown method', 'fixture.unknownmethod'],
    ['forged runtime fields', 'fixture.forgedruntime'],
  ])('fails closed on %s from the child process', async (_label, method) => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor.clientFor(authenticatedRuntime).call(method, null).catch((value) => value)
    expect(error).toBeInstanceOf(BackendPluginError)
    expect(error).toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: 'Backend plugin returned an invalid protocol message.',
    })
    expect(String(error)).not.toContain(fixture)
  })

  it('times out once and sends a cancellation notification', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.delay', { milliseconds: 100 }, { timeoutMs: 20 })
      .catch((value) => value)
    expect(error).toMatchObject({
      code: 'TIMEOUT',
      message: 'Backend plugin call timed out.',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)).resolves.toEqual(1)
  })

  it('maps an aborted call to user cancellation and sends the same wire notification', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()
    const controller = new AbortController()
    const promise = supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.delay', { milliseconds: 100 }, { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toMatchObject({
      code: 'USER_CANCELLED',
      message: 'Backend plugin call was cancelled.',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(supervisor.clientFor(authenticatedRuntime).call('fixture.cancelcount', null)).resolves.toEqual(1)
  })

  it('retires a cancellation tombstone after a late response', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const timeoutError = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.delay', { milliseconds: 100 }, { timeoutMs: 5 })
      .catch((value) => value)
    const requestId = (timeoutError as BackendPluginError).requestId
    expect(requestId).toEqual(expect.any(String))
    if (requestId === undefined) throw new Error('Expected a timeout request id.')

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.lateresponse', { requestId })
    ).resolves.toEqual({ ok: true })

    const repeatedResponseError = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.lateresponse', { requestId })
      .catch((value) => value)
    expect(repeatedResponseError).toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  // A tombstone is retired the moment a response arrives for the request it
  // stands for, so the eviction this test is about only happens once MAX + 1
  // tombstones are live at the same time. Ask the child for a delay it cannot
  // possibly serve within the test: with 100ms the child's own timer raced our
  // cancellation, one genuine response slipped through under load, the tombstone
  // it retired kept the set one short of the bound, and the first id survived -
  // which made the last assertion read `{ ok: true }` instead of a refusal.
  const UNSERVABLE_DELAY_MS = 600_000

  it('bounds cancellation tombstones', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const firstError = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.delay', { milliseconds: UNSERVABLE_DELAY_MS }, { timeoutMs: 5 })
      .catch((value) => value)
    expect(firstError).toMatchObject({ code: 'TIMEOUT' })
    const firstRequestId = (firstError as BackendPluginError).requestId
    expect(firstRequestId).toEqual(expect.any(String))
    if (firstRequestId === undefined) throw new Error('Expected a timeout request id.')

    // Exactly MAX more tombstones: the one above is then the oldest of MAX + 1
    // live entries, so it - and only it - is evicted.
    let lastRequestId: string | number | undefined
    for (let index = 0; index < MAX_IGNORED_REQUEST_IDS; index += 1) {
      const error = await supervisor
        .clientFor(authenticatedRuntime)
        .call('fixture.delay', { milliseconds: UNSERVABLE_DELAY_MS }, { timeoutMs: 5 })
        .catch((value) => value)
      expect(error).toMatchObject({ code: 'TIMEOUT' })
      lastRequestId = (error as BackendPluginError).requestId
    }
    expect(lastRequestId).toEqual(expect.any(String))
    if (lastRequestId === undefined) throw new Error('Expected a timeout request id.')

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.lateresponse', {
        requestId: lastRequestId,
      })
    ).resolves.toEqual({ ok: true })

    const evictedResponseError = await supervisor
      .clientFor(authenticatedRuntime)
      .call('fixture.lateresponse', { requestId: firstRequestId })
      .catch((value) => value)
    expect(evictedResponseError).toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('maps an unexpected child exit to a safe unavailable error', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const error = await supervisor.clientFor(authenticatedRuntime).call('fixture.exit', null).catch((value) => value)
    expect(error).toBeInstanceOf(BackendPluginError)
    expect(error).toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
    })
    expect(String(error)).not.toContain('exit')
    expect(String(error)).not.toContain('SIG')
  })

  it('notifies the Host once when a child becomes unavailable', async () => {
    const onFailure = vi.fn()
    const supervisor = makeSupervisor({ onFailure })
    supervisors.push(supervisor)
    await supervisor.start()

    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.exit', null),
    ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })

    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'BACKEND_UNAVAILABLE',
    }))
  })

  it('hands the Host a cause when the health request times out, so the failure is not silent', async () => {
    // The Host's diagnostic emitter returns early without a cause, so a
    // health-request TIMEOUT used to reach the log as nothing at all. The
    // supervisor must pass the originating error on in its place.
    const onFailure = vi.fn()
    const supervisor = makeSupervisor({
      onFailure,
      healthTimeoutMs: 60,
      // A child that starts but never answers - the slow-boot shape, not a
      // crash. A crashing child would carry its own cause and log already.
      spawnProcess: () =>
        spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as ChildProcessWithoutNullStreams,
    })
    supervisors.push(supervisor)

    await expect(supervisor.start()).rejects.toMatchObject({ code: 'TIMEOUT' })

    expect(onFailure).toHaveBeenCalledOnce()
    const reported = onFailure.mock.calls[0][0] as { code: string; cause?: unknown }
    expect(reported.code).toBe('BACKEND_UNAVAILABLE')
    expect(reported.cause).toBeDefined()
    expect((reported.cause as { code?: string }).code).toBe('TIMEOUT')
  })

  it('routes stderr away from the protocol stream', async () => {
    const stderr = vi.fn()
    const supervisor = makeSupervisor({ onStderr: stderr })
    supervisors.push(supervisor)
    await supervisor.start()

    await expect(supervisor.clientFor(authenticatedRuntime).call('fixture.stderr', null)).resolves.toEqual({ ok: true })
    // The reply and the stderr line travel on different streams, so the call
    // can resolve first; wait for the line rather than assuming it landed.
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith('fixture diagnostic: /private/internal/path\n'))
  })

  it('emits host-only diagnostic and original cause on sync spawn error before generic failure', async () => {
    const stderr = vi.fn()
    const onFailure = vi.fn()
    const spawnError = new Error('spawn /custom/private/plans ENOENT')
    const supervisor = makeSupervisor({
      onStderr: stderr,
      onFailure,
      spawnProcess: () => {
        throw spawnError
      },
    })
    supervisors.push(supervisor)

    const startPromise = supervisor.start()
    await expect(startPromise).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
    })
    const error = await startPromise.catch((err) => err)
    expect(error.cause).toBe(spawnError)
    expect(String(error)).not.toContain('/custom/private/plans')

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('/custom/private/plans ENOENT'))
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
      cause: spawnError,
    }))
  })

  it('emits host-only diagnostic and original cause on async child error before generic failure', async () => {
    const stderr = vi.fn()
    const onFailure = vi.fn()
    const childError = new Error('spawn /custom/private/plans EACCES')
    const supervisor = makeSupervisor({
      onStderr: stderr,
      onFailure,
      spawnProcess: () => {
        const child = new EventEmitter()
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const childStderr = new PassThrough()
        const childProcess = Object.assign(child, {
          stdin,
          stdout,
          stderr: childStderr,
          kill: vi.fn(),
        }) as unknown as ChildProcessWithoutNullStreams
        queueMicrotask(() => {
          child.emit('error', childError)
        })
        return childProcess
      },
    })
    supervisors.push(supervisor)

    const startPromise = supervisor.start()
    await expect(startPromise).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
    })
    const error = await startPromise.catch((err) => err)
    expect(error.cause).toBe(childError)
    expect(String(error)).not.toContain('/custom/private/plans')

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('/custom/private/plans EACCES'))
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
      cause: childError,
    }))
  })

  it('emits host-only diagnostic on early child exit with stderr before generic failure', async () => {
    const stderr = vi.fn()
    const onFailure = vi.fn()
    const supervisor = makeSupervisor({
      onStderr: stderr,
      onFailure,
      spawnProcess: () => {
        const child = new EventEmitter()
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const childStderr = new PassThrough()
        const childProcess = Object.assign(child, {
          stdin,
          stdout,
          stderr: childStderr,
          kill: vi.fn(),
        }) as unknown as ChildProcessWithoutNullStreams
        queueMicrotask(() => {
          childStderr.write('fatal: cannot load /custom/private/lib.so: file not found\n')
          child.emit('exit', 1, null)
        })
        return childProcess
      },
    })
    supervisors.push(supervisor)

    const startPromise = supervisor.start()
    await expect(startPromise).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
    })
    const error = await startPromise.catch((err) => err)
    expect(error.cause).toBeDefined()
    expect(String(error.cause)).toContain('/custom/private/lib.so')
    expect(String(error)).not.toContain('/custom/private/lib.so')

    expect(stderr).toHaveBeenCalledWith('fatal: cannot load /custom/private/lib.so: file not found\n')
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
      cause: expect.objectContaining({
        message: expect.stringContaining('/custom/private/lib.so'),
      }),
    }))
  })

  it('emits host-only diagnostic and records private cause on unexpected early child exit with code 0 before health', async () => {
    const stderr = vi.fn()
    const onFailure = vi.fn()
    const supervisor = makeSupervisor({
      onStderr: stderr,
      onFailure,
      spawnProcess: () => {
        const child = new EventEmitter()
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const childStderr = new PassThrough()
        const childProcess = Object.assign(child, {
          stdin,
          stdout,
          stderr: childStderr,
          kill: vi.fn(),
        }) as unknown as ChildProcessWithoutNullStreams
        queueMicrotask(() => {
          child.emit('exit', 0, null)
        })
        return childProcess
      },
    })
    supervisors.push(supervisor)

    const startPromise = supervisor.start()
    await expect(startPromise).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
    })
    const error = await startPromise.catch((err) => err)
    expect(error.cause).toBeDefined()
    expect(String(error.cause)).toContain('prematurely')

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('prematurely'))
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
      cause: expect.objectContaining({
        message: expect.stringContaining('prematurely'),
      }),
    }))
  })

  it('bounds retained stderr and diagnostic emission with marked truncation for malicious child stderr', async () => {
    const stderr = vi.fn()
    const onFailure = vi.fn()
    const supervisor = makeSupervisor({
      onStderr: stderr,
      onFailure,
      spawnProcess: () => {
        const child = new EventEmitter()
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const childStderr = new PassThrough()
        const childProcess = Object.assign(child, {
          stdin,
          stdout,
          stderr: childStderr,
          kill: vi.fn(),
        }) as unknown as ChildProcessWithoutNullStreams
        queueMicrotask(() => {
          const chunk = 'x'.repeat(4096) + '\n'
          for (let i = 0; i < 50; i++) {
            childStderr.write(chunk)
          }
          child.emit('exit', 1, null)
        })
        return childProcess
      },
    })
    supervisors.push(supervisor)

    const startPromise = supervisor.start()
    await expect(startPromise).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    })
    const error = await startPromise.catch((err) => err)
    expect(error.cause).toBeDefined()
    expect(String(error.cause)).toContain('[stderr truncated]')

    const totalEmitted = stderr.mock.calls.map(([arg]) => String(arg)).join('')
    expect(totalEmitted).toContain('[stderr emission truncated]')
    expect(totalEmitted.length).toBeLessThan(128 * 1024)
  })

  it('sanitizes terminal control sequences and line injections in child stderr while keeping path-like cause bounded', async () => {
    const stderr = vi.fn()
    const onFailure = vi.fn()
    const supervisor = makeSupervisor({
      onStderr: stderr,
      onFailure,
      spawnProcess: () => {
        const child = new EventEmitter()
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const childStderr = new PassThrough()
        const childProcess = Object.assign(child, {
          stdin,
          stdout,
          stderr: childStderr,
          kill: vi.fn(),
        }) as unknown as ChildProcessWithoutNullStreams
        queueMicrotask(() => {
          childStderr.write('\x1b[31;1mfatal error\x1b[0m\x1b[2J\r\n/custom/private/plans/libbackend.so: dynamic loading failed\x07\r\n')
          child.emit('exit', 1, null)
        })
        return childProcess
      },
    })
    supervisors.push(supervisor)

    const startPromise = supervisor.start()
    await expect(startPromise).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
    })
    const error = await startPromise.catch((err) => err)
    expect(error.cause).toBeDefined()
    const causeStr = String(error.cause)
    expect(causeStr).toContain('/custom/private/plans/libbackend.so')
    expect(causeStr).not.toContain('\x1b')
    expect(causeStr).not.toContain('\r')
    expect(causeStr).not.toContain('\x07')
    expect(String(error)).not.toContain('/custom/private/plans')

    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'BACKEND_UNAVAILABLE',
      message: 'Backend plugin is unavailable.',
      cause: expect.objectContaining({
        message: expect.stringContaining('/custom/private/plans/libbackend.so'),
      }),
    }))
  })

  it('gracefully closes the child and can be closed again', async () => {
    let child: ChildProcessWithoutNullStreams | undefined
    const supervisor = new PluginBackendSupervisor(activation, {
      spawnProcess: (entryFile, options) => {
        child = spawn(process.execPath, [entryFile], {
          ...options,
          env: options.env,
        }) as ChildProcessWithoutNullStreams
        return child
      },
      environment: { NAVIDE_FIXTURE: 'backend-wire' },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    await supervisor.close()
    await supervisor.close()
    expect(child?.exitCode).not.toBeNull()
  })

  it('drains existing work, rejects new work, and force-terminates an unresponsive child', async () => {
    let child: ChildProcessWithoutNullStreams | undefined
    const supervisor = new PluginBackendSupervisor(activation, {
      environment: { NAVIDE_FIXTURE: 'backend-wire' },
      drainTimeoutMs: 5,
      shutdownTimeoutMs: 5,
      callTimeoutMs: 1_000,
      spawnProcess: () => {
        child = makeControlledChild(1, ['fixture.echo'])
        return child
      },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const pending = supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    const closing = supervisor.close()
    await expect(
      supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    ).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await closing

    const signals = (child as unknown as { killSignals: Array<string | number | undefined> }).killSignals
    expect(signals).toContain('SIGTERM')
  })

  it('does not respawn a child when close races a restart drain', async () => {
    const children: ChildProcessWithoutNullStreams[] = []
    const supervisor = makeSupervisor({
      drainTimeoutMs: 5,
      shutdownTimeoutMs: 5,
      callTimeoutMs: 1_000,
      spawnProcess: () => {
        const child = makeControlledChild(children.length + 1, ['fixture.echo'])
        children.push(child)
        return child
      },
    })
    supervisors.push(supervisor)
    await supervisor.start()

    const pending = supervisor.clientFor(authenticatedRuntime).call('fixture.echo', null)
    const restarting = supervisor.restart()
    const closing = supervisor.close()

    const pendingError = await pending.catch((error: unknown) => error)
    expect(pendingError).toBeInstanceOf(BackendPluginError)
    expect(['BACKEND_UNAVAILABLE', 'PLUGIN_STOPPING']).toContain(
      (pendingError as BackendPluginError).code,
    )
    await expect(restarting).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await closing
    expect(children).toHaveLength(1)
  })

  it('does not spawn after close wins a pending root refresh', async () => {
    let releaseRoot!: (root: string) => void
    const root = new Promise<string>((resolve) => {
      releaseRoot = resolve
    })
    let spawnCount = 0
    const supervisor = makeSupervisor({
      authorizedPlanRoot: { value: null },
      refreshAuthorizedPlanRoot: () => root,
      spawnProcess: () => {
        spawnCount += 1
        return makeControlledChild(1)
      },
    })
    supervisors.push(supervisor)

    const starting = supervisor.start()
    await Promise.resolve()
    const closing = supervisor.close()
    releaseRoot(process.cwd())

    await expect(starting).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await closing
    expect(spawnCount).toBe(0)
  })

  it('runs the Host-only before-spawn check after root refresh for each generation', async () => {
    const order: string[] = []
    let spawnCount = 0
    const supervisor = makeSupervisor({
      authorizedPlanRoot: { value: null },
      refreshAuthorizedPlanRoot: async () => {
        order.push('refresh')
        return process.cwd()
      },
      beforeSpawn: () => {
        order.push('before-spawn')
      },
      spawnProcess: () => {
        spawnCount += 1
        order.push('spawn')
        return makeControlledChild(spawnCount)
      },
    })
    supervisors.push(supervisor)

    await supervisor.start()
    await supervisor.restart()

    expect(order).toEqual([
      'refresh',
      'before-spawn',
      'spawn',
      'refresh',
      'before-spawn',
      'spawn',
    ])
  })

  it('fails closed without spawning when the Host-only before-spawn check rejects', async () => {
    let spawnCount = 0
    const supervisor = makeSupervisor({
      beforeSpawn: async () => {
        throw new Error('activation is no longer trusted')
      },
      spawnProcess: () => {
        spawnCount += 1
        return makeControlledChild(spawnCount)
      },
    })
    supervisors.push(supervisor)

    await expect(supervisor.start()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    expect(spawnCount).toBe(0)
  })

  describe('installed backend selector admission', () => {
    function selectorSupervisor(
      root: string,
      launch: BackendPluginLaunchSpec,
      spawnCount: { value: number },
      trust: InstalledRegistryTrustContext,
    ): PluginBackendSupervisor {
      return new PluginBackendSupervisor(launch, {
        environment: { NAVIDE_FIXTURE: 'backend-wire' },
        beforeSpawn: () => verifyInstalledBackendSpawnTrust(launch, {
          pluginsRoot: () => root,
          currentRegistryTrust: () => trust,
        }),
        spawnProcess: () => {
          spawnCount.value += 1
          return makeControlledChild(spawnCount.value)
        },
      })
    }

    it('rejects a signed same-ID B launch when selector A is active without spawning', async () => {
      const root = mkdtempSync(join(tmpdir(), 'navide-backend-selector-admission-'))
      try {
        const a = signedBackendFixture(root, '1.0.0')
        const b = signedBackendFixture(root, '2.0.0')
        const selector = new PluginActivationSelector(root)
        selector.stageCandidate('acme.backend', a.selection)
        selector.activateCandidate('acme.backend')
        selector.completeActivation('acme.backend')
        const spawnCount = { value: 0 }
        const supervisor = selectorSupervisor(root, {
          ...activation,
          packageVersion: b.selection.packageVersion,
          packageDir: b.packageDir,
        }, spawnCount, a.trust)
        try {
          await expect(supervisor.start()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
          expect(spawnCount.value).toBe(0)
        } finally {
          await supervisor.close()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('rejects a same-version same-target replacement when the active selector digest differs', async () => {
      const root = mkdtempSync(join(tmpdir(), 'navide-backend-selector-digest-'))
      const replacementRoot = mkdtempSync(join(tmpdir(), 'navide-backend-selector-digest-b-'))
      try {
        const a = signedBackendFixture(root, '1.0.0')
        const b = signedBackendFixture(replacementRoot, '1.0.0', 'Backend B')
        const selector = new PluginActivationSelector(root)
        selector.stageCandidate('acme.backend', a.selection)
        selector.activateCandidate('acme.backend')
        selector.completeActivation('acme.backend')
        expect(b.selection).toMatchObject({
          packageVersion: a.selection.packageVersion,
          target: a.selection.target,
        })
        expect(b.selection.artifactDigest).not.toBe(a.selection.artifactDigest)
        for (const relativePath of ['manifest.json', 'frontend/index.html', REGISTRY_ARTIFACT_NAME, REGISTRY_RECEIPT_NAME]) {
          cpSync(join(b.packageDir, relativePath), join(a.packageDir, relativePath))
        }

        const spawnCount = { value: 0 }
        const supervisor = selectorSupervisor(root, {
          ...activation,
          packageVersion: b.selection.packageVersion,
          packageDir: a.packageDir,
        }, spawnCount, b.trust)
        try {
          await expect(supervisor.start()).rejects.toMatchObject({
            code: 'BACKEND_UNAVAILABLE',
            message: expect.stringMatching(/artifact digest does not match/),
          })
          expect(spawnCount.value).toBe(0)
        } finally {
          await supervisor.close()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(replacementRoot, { recursive: true, force: true })
      }
    })

    it('allows a valid selector-absent legacy package but rejects its tampered archive', async () => {
      const root = mkdtempSync(join(tmpdir(), 'navide-backend-selector-legacy-'))
      try {
        const pkg = signedBackendFixture(root, '1.0.0')
        const spawnCount = { value: 0 }
        const supervisor = selectorSupervisor(root, { ...activation, packageDir: pkg.packageDir }, spawnCount, pkg.trust)
        try {
          await supervisor.start()
          expect(spawnCount.value).toBe(1)
        } finally {
          await supervisor.close()
        }
        writeFileSync(join(pkg.packageDir, REGISTRY_ARTIFACT_NAME), 'tampered archive')
        const rejectedCount = { value: 0 }
        const rejected = selectorSupervisor(root, { ...activation, packageDir: pkg.packageDir }, rejectedCount, pkg.trust)
        try {
          await expect(rejected.start()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
          expect(rejectedCount.value).toBe(0)
        } finally {
          await rejected.close()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('rejects a corrupt present selector without fallback or spawning', async () => {
      const root = mkdtempSync(join(tmpdir(), 'navide-backend-selector-corrupt-'))
      try {
        const pkg = signedBackendFixture(root, '1.0.0')
        mkdirSync(join(root, '.navide-lifecycle'), { recursive: true })
        writeFileSync(join(root, '.navide-lifecycle', 'acme.backend.json'), '{not-json')
        const spawnCount = { value: 0 }
        const supervisor = selectorSupervisor(root, { ...activation, packageDir: pkg.packageDir }, spawnCount, pkg.trust)
        try {
          await expect(supervisor.start()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
          expect(spawnCount.value).toBe(0)
        } finally {
          await supervisor.close()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  it('does not spawn after close wins a pending Host-only before-spawn check', async () => {
    let hookStarted!: () => void
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve
    })
    let releaseHook!: () => void
    const release = new Promise<void>((resolve) => {
      releaseHook = resolve
    })
    let spawnCount = 0
    const supervisor = makeSupervisor({
      beforeSpawn: async () => {
        hookStarted()
        await release
      },
      spawnProcess: () => {
        spawnCount += 1
        return makeControlledChild(spawnCount)
      },
    })
    supervisors.push(supervisor)

    const starting = supervisor.start()
    await started
    const closing = supervisor.close()
    releaseHook()

    await expect(starting).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
    await closing
    expect(spawnCount).toBe(0)
  })

  for (const [label, entryFile] of packagedFixtures) {
    const run = packagedFixtureEnabled ? it : it.skip

    run(`${label} passes the shared Backend Wire call and event corpus`, async () => {
      const supervisor = makePackagedSupervisor(entryFile)
      supervisors.push(supervisor)
      await expect(supervisor.start()).resolves.toMatchObject({
        serverInfo: { name: 'navide.plans', version: '0.1.92' },
      })
      const client = supervisor.clientFor(packagedRuntime, {
        workspacePath: process.cwd(),
        authorizedPlanRoot: process.cwd(),
      })
      await expect(client.call('fixture.echo', {
          value: 42,
        }),
      ).resolves.toEqual({ arguments: { value: 42 }, runtime: packagedRuntime })

      const received: BackendPluginEvent[] = []
      const progress: unknown[] = []
      const subscription = client.subscribe(
        ['fixture.changed', 'plans.changed'],
        (event) => received.push(event),
        { onProgress: (value) => progress.push(value) },
      )
      await subscription.acknowledged
      const subscriptionId = subscription.subscriptionId
      expect(subscriptionId).toEqual(expect.any(String))
      if (subscriptionId === undefined) throw new Error('Expected a subscription id.')
      await expect(client.call('plans.resolve_root', {
        workspace_path: process.cwd(),
      })).resolves.toEqual({ ok: true, root: process.cwd() })
      await vi.waitFor(() => {
        expect(received.some((event) => event.event === 'plans.changed')).toBe(true)
      })
      await expect(client.call('fixture.progress', { subscriptionId })).resolves.toEqual({ ok: true })
      expect(progress).toEqual([{
        progressToken: subscriptionId,
        progress: 1,
        total: 2,
        message: 'fixture progress',
      }])
      await expect(
        client.call('fixture.emit', {
          subscriptionId,
          event: 'fixture.changed',
          payload: { value: 1 },
        }),
      ).resolves.toEqual({ ok: true })
      await vi.waitFor(() => {
        expect(received.some((event) => event.event === 'fixture.changed' && event.payload &&
          typeof event.payload === 'object' && 'value' in event.payload && event.payload.value === 1)).toBe(true)
      })
      await expect(client.call('fixture.close', { subscriptionId })).resolves.toEqual({ ok: true })
      await expect(subscription.settled).resolves.toMatchObject({ reason: 'backend-closed' })
    })

    run(`${label} settles cancellation and timeout in the shared corpus`, async () => {
      const supervisor = makePackagedSupervisor(entryFile)
      supervisors.push(supervisor)
      await supervisor.start()

      const controller = new AbortController()
      const cancelled = supervisor.clientFor(packagedRuntime).call(
        'fixture.delay',
        { milliseconds: 100 },
        { signal: controller.signal },
      )
      controller.abort()
      await expect(cancelled).rejects.toMatchObject({ code: 'USER_CANCELLED' })
      await expect(
        supervisor.clientFor(packagedRuntime).call('fixture.delay', { milliseconds: 100 }, { timeoutMs: 10 }),
      ).rejects.toMatchObject({ code: 'TIMEOUT' })
      await expect(
        supervisor.clientFor(packagedRuntime).call('fixture.cancelcount', null),
      ).resolves.toBe(2)
    })

    run(`${label} restores the core after child crash and restart`, async () => {
      const supervisor = makePackagedSupervisor(entryFile)
      supervisors.push(supervisor)
      await supervisor.start()
      const received: BackendPluginEvent[] = []
      const subscription = supervisor.clientFor(packagedRuntime).subscribe(
        ['fixture.changed'],
        (event) => received.push(event),
      )
      await subscription.acknowledged

      await expect(
        supervisor.clientFor(packagedRuntime).call('fixture.exit', null),
      ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
      await expect(supervisor.restart()).resolves.toMatchObject({
        serverInfo: { name: 'navide.plans', version: '0.1.92' },
      })
      await expect(
        supervisor.clientFor(packagedRuntime).call('fixture.emit', {
          event: 'fixture.changed',
          payload: { recovered: true },
        }),
      ).resolves.toEqual({ ok: true })
      await vi.waitFor(() => expect(received.at(-1)?.payload).toEqual({ recovered: true }))
      subscription.dispose()
    })
  }

  it('rejects non-compact, duplicate-key, multiline, and invalid UTF-8 frames', () => {
    expect(() =>
      parseBackendWireFrame('{"jsonrpc": "2.0"}')
    ).toThrow('Backend plugin returned an invalid protocol message.')
    expect(() =>
      parseBackendWireFrame('{"id":1,"id":2}')
    ).toThrow('Backend plugin returned an invalid protocol message.')
    expect(() =>
      parseBackendWireFrame('{"jsonrpc":"2.0"}\n{"jsonrpc":"2.0"}')
    ).toThrow('Backend plugin returned an invalid protocol message.')
    expect(() => parseBackendWireFrame(Uint8Array.of(0xff))).toThrow(
      'Backend plugin returned an invalid protocol message.'
    )
  })

  it('parses only the private Bridge request shape and excludes runtime identity', () => {
    expect(parseBackendWireHostFrame(JSON.stringify({
      jsonrpc: '2.0',
      id: 'bridge:1',
      method: 'navide/host/call',
      params: {
        origin: { kind: 'call', requestId: 'parent-1' },
        port: 'filesystem',
        operation: 'resolve_root',
        arguments: { workspace_path: '/workspace' },
      },
    }))).toEqual({
      kind: 'bridge-request',
      id: 'bridge:1',
      origin: { kind: 'call', requestId: 'parent-1' },
      port: 'filesystem',
      operation: 'resolve_root',
      arguments: { workspace_path: '/workspace' },
    })
    expect(() => parseBackendWireHostFrame(JSON.stringify({
      jsonrpc: '2.0',
      id: 'bridge:2',
      method: 'navide/host/call',
      params: {
        origin: { kind: 'call', requestId: 'parent-1' },
        port: 'filesystem',
        operation: 'resolve_root',
        arguments: { workspace_path: '/workspace' },
        runtime,
      },
    }))).toThrow('Backend plugin returned an invalid protocol message.')
    expect(() => parseBackendWireHostFrame(JSON.stringify({
      jsonrpc: '2.0',
      id: 'bridge:',
      method: 'navide/host/call',
      params: {
        origin: { kind: 'call', requestId: 'parent-1' },
        port: 'filesystem',
        operation: 'resolve_root',
        arguments: { workspace_path: '/workspace' },
      },
    }))).toThrow('Backend plugin returned an invalid protocol message.')
  })

  describe('output queue overflow', () => {
    interface StallableChild {
      child: ChildProcessWithoutNullStreams
      kill: ReturnType<typeof vi.fn>
      hostFrames: string[]
      stall: () => void
      release: () => void
      emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void
    }

    function makeStallableChild(): StallableChild {
      const emitter = new EventEmitter()
      const stdout = new PassThrough()
      const childStderr = new PassThrough()
      const hostFrames: string[] = []
      let stalled = false
      let held: (() => void) | undefined
      let input = ''
      let exited = false
      let parentCallId = ''
      const serverInfo = { 'io.modelcontextprotocol/serverInfo': { name: 'stallable', version: '1.0.0' } }
      const consume = (text: string): void => {
        input += text
        while (true) {
          const newline = input.indexOf('\n')
          if (newline < 0) return
          const raw = input.slice(0, newline)
          input = input.slice(newline + 1)
          hostFrames.push(raw)
          const frame = JSON.parse(raw) as {
            id?: string
            method?: string
            params?: { name?: string; arguments?: unknown }
            result?: { value?: unknown }
            error?: unknown
          }
          if (frame.method === 'navide/health' && frame.id) {
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: frame.id,
              result: { resultType: 'complete', value: { ok: true }, _meta: serverInfo },
            })}\n`)
            continue
          }
          if (frame.method === 'navide/call' && frame.id && frame.params?.name === 'fixture.bridge') {
            parentCallId = frame.id
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: 'bridge:child-request',
              method: 'navide/host/call',
              params: {
                origin: { kind: 'call', requestId: frame.id },
                port: 'filesystem',
                operation: 'resolve_root',
                arguments: {},
              },
            })}\n`)
            continue
          }
          if (frame.method === 'navide/call' && frame.id) {
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: frame.id,
              result: { resultType: 'complete', value: { echoed: true }, _meta: serverInfo },
            })}\n`)
            continue
          }
          if (frame.id === 'bridge:child-request' && frame.result && parentCallId) {
            stdout.write(`${JSON.stringify({
              jsonrpc: '2.0',
              id: parentCallId,
              result: { resultType: 'complete', value: frame.result.value, _meta: serverInfo },
            })}\n`)
          }
        }
      }
      const stdin = new Writable({
        write(chunk: Buffer | string, _encoding, callback): void {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          if (stalled) {
            held = (): void => {
              held = undefined
              consume(text)
              callback()
            }
            return
          }
          consume(text)
          callback()
        },
      })
      const kill = vi.fn((): boolean => {
        if (exited) return true
        exited = true
        queueMicrotask(() => emitter.emit('exit', 0, null))
        return true
      })
      const child = Object.assign(emitter, {
        stdin,
        stdout,
        stderr: childStderr,
        kill,
        pid: 4242,
      }) as unknown as ChildProcessWithoutNullStreams
      return {
        child,
        kill,
        hostFrames,
        stall: (): void => { stalled = true },
        release: (): void => { stalled = false; held?.() },
        emitExit: (code, signal = null): void => {
          if (exited) return
          exited = true
          emitter.emit('exit', code, signal)
        },
      }
    }

    it('drops Host event notifications instead of failing the child when the output queue overflows', async () => {
      const onFailure = vi.fn()
      const stderrSink = vi.fn()
      const emitted = 12
      const payload = 'x'.repeat(48 * 1024)
      const harness = makeStallableChild()
      const supervisor = makeSupervisor({
        onFailure,
        onStderr: stderrSink,
        bridgeDispatcher: {
          dispatch: async (_request, context) => {
            harness.stall()
            for (let index = 0; index < emitted; index += 1) {
              context.emit('plans.changed', { index, payload })
            }
            harness.release()
            return { ok: true }
          },
        },
        spawnProcess: () => harness.child,
      })
      supervisors.push(supervisor)
      await supervisor.start()

      await expect(
        supervisor
          .clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
          .call('fixture.bridge', null)
      ).resolves.toEqual({ ok: true })

      const delivered = harness.hostFrames.filter((frame) => frame.includes('navide/host/event')).length
      expect(delivered).toBeGreaterThan(0)
      expect(delivered).toBeLessThan(emitted)
      expect(onFailure).not.toHaveBeenCalled()
      expect(harness.kill).not.toHaveBeenCalled()
      expect(stderrSink).toHaveBeenCalledWith(expect.stringContaining('output queue limit'))
    })

    it('still fails the child when a request frame overflows the output queue', async () => {
      const onFailure = vi.fn()
      const harness = makeStallableChild()
      const supervisor = makeSupervisor({ onFailure, spawnProcess: () => harness.child })
      supervisors.push(supervisor)
      await supervisor.start()
      harness.stall()

      const client = supervisor.clientFor(authenticatedRuntime)
      const payload = 'y'.repeat(48 * 1024)
      const settled = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          client.call('fixture.echo', { index, payload }).catch((error: unknown) => error)
        )
      )
      harness.release()

      expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'BACKEND_UNAVAILABLE' }))
      expect(
        settled.some((entry) => entry instanceof BackendPluginError && entry.code === 'BACKEND_UNAVAILABLE')
      ).toBe(true)
    })

    it('refuses a single request frame larger than the whole queue without failing the child', async () => {
      const onFailure = vi.fn()
      const harness = makeStallableChild()
      const supervisor = makeSupervisor({ onFailure, spawnProcess: () => harness.child })
      supervisors.push(supervisor)
      await supervisor.start()

      const client = supervisor.clientFor(authenticatedRuntime)
      // One frame that can never fit (256 KiB queue): refused up front, not
      // written, so the overflow that would kill the child never happens.
      await expect(client.call('fixture.echo', { payload: 'z'.repeat(300 * 1024) }))
        .rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
      expect(harness.hostFrames.some((frame) => frame.includes('fixture.echo'))).toBe(false)
      expect(onFailure).not.toHaveBeenCalled()
      expect(harness.kill).not.toHaveBeenCalled()
      // The child is still serving requests.
      await expect(client.call('fixture.echo', { payload: 'ok' })).resolves.toBeDefined()
    })

    it('records a private cause when a ready child exits cleanly with code 0 and no stderr', async () => {
      const onFailure = vi.fn()
      const stderrSink = vi.fn()
      const harness = makeStallableChild()
      const supervisor = makeSupervisor({ onFailure, onStderr: stderrSink, spawnProcess: () => harness.child })
      supervisors.push(supervisor)
      await supervisor.start()

      harness.emitExit(0, null)
      await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
      const error = onFailure.mock.calls[0]?.[0] as BackendPluginError
      expect(error.code).toBe('BACKEND_UNAVAILABLE')
      expect(error.cause).toBeDefined()
      expect(String(error.cause)).toContain('exit code 0')
      expect(stderrSink).toHaveBeenCalledWith(expect.stringContaining('exit code 0'))
    })
  })
})
