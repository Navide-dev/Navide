import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto'
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
  type BackendResultText,
  type PluginBackendSupervisorOptions,
  type BackendRuntimeContext,
} from './pluginBackendSupervisor'
import { AGENT_TOOL_CHUNK_BYTES, utf8ByteLength } from '../../shared/pluginAgentTools'
import { DEFAULT_BACKEND_RESOURCE_LIMITS, watchBackendResources } from './pluginBackendResourceWatchdog'
import { stdoutPendingOf } from './pluginThirdPartyBackends'
import {
  PLANS_BRIDGE_PORTS,
  PlansBridgeError,
  createInMemoryPlansBridgeDispatcher,
  createProductionPlansBridgeDispatcher,
  createTestPlansFilesystemPort,
  type PlansBridgePort,
} from './plansBridge'
import { MAX_IGNORED_REQUEST_IDS } from './pluginBackendSupervisor'
import type { ExecutionPolicySnapshot } from './executionPolicy'
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
    'fixture.hash',
    'fixture.pid',
    'fixture.bigresult',
    'fixture.bigexit',
    'fixture.nonewline',
    'fixture.bridge',
    'fixture.bridgeburst',
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
  bridgeArguments: unknown = {},
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
            arguments: bridgeArguments,
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
    case 'shell':
      return 'run'
    case 'web':
      return 'list'
    case 'agents':
      return 'list_panes'
    case 'agent-message-bodies':
      return 'read_message'
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

  it('gives every child spawn its own event-loop turn and still starts them all', async () => {
    let turn = 0
    let ticking = true
    const tick = (): void => {
      if (!ticking) return
      turn += 1
      setImmediate(tick)
    }
    setImmediate(tick)
    const spawnedAt: number[] = []
    const started = Array.from({ length: 5 }, (_, index) => {
      const supervisor = makeSupervisor({
        spawnProcess: () => {
          spawnedAt.push(turn)
          return makeControlledChild(index + 1)
        },
      })
      supervisors.push(supervisor)
      return supervisor.start()
    })
    await Promise.all(started)
    ticking = false
    expect(spawnedAt).toHaveLength(5)
    expect(new Set(spawnedAt).size).toBe(5)
  })

  describe('chunked transfer (agent-tools contract 4.4)', () => {
    const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
    const big = (bytes: number): { data: string } => {
      const unit = 'abc中文😀'
      return { data: unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit, 'utf8'))) }
    }

    it('joins a 10 MiB result sent in pieces over real stdio; the child is never restarted', async () => {
      const onFailure = vi.fn()
      const supervisor = makeSupervisor({ onFailure })
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      const pid = await client.call('fixture.pid', null)
      const phases: string[] = []

      const result = await client.call('fixture.bigresult', { bytes: 10 * 1_048_576 }, {
        timeoutMs: 60_000,
        onTransferProgress: (phase) => phases.push(phase),
      })
      expect(sha(JSON.stringify(result))).toBe(sha(JSON.stringify(big(10 * 1_048_576))))
      expect(phases.filter((phase) => phase === 'result').length).toBeGreaterThanOrEqual(80)
      expect(phases[0]).toBe('execution')
      await expect(client.call('fixture.pid', null)).resolves.toBe(pid)
      expect(onFailure).not.toHaveBeenCalled()
    }, 120_000)

    it('reads one result frame over 1 MiB without failing or restarting the child', async () => {
      const onFailure = vi.fn()
      const supervisor = makeSupervisor({ onFailure })
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      const pid = await client.call('fixture.pid', null)
      const result = await client.call('fixture.bigresult', { bytes: 3 * 1_048_576, mode: 'single' }, { timeoutMs: 60_000 })
      expect(sha(JSON.stringify(result))).toBe(sha(JSON.stringify(big(3 * 1_048_576))))
      await expect(client.call('fixture.pid', null)).resolves.toBe(pid)
      expect(onFailure).not.toHaveBeenCalled()
    }, 120_000)

    it('discloses a frame the child never ends as it grows, without cutting the child off', async () => {
      const onFailure = vi.fn()
      const supervisor = makeSupervisor({ onFailure })
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      expect(supervisor.resourceUsage().stdoutPending).toEqual({ bytes: 0, peakBytes: 0 })
      const call = client.call('fixture.nonewline', { bytes: 8 * 1_048_576 }, { timeoutMs: 60_000 }).catch((error) => error)
      // The number is visible while the bytes still arrive, long before memory runs out.
      await vi.waitFor(() => expect(supervisor.resourceUsage().stdoutPending.bytes).toBeGreaterThan(1_048_576), { timeout: 30_000 })
      await vi.waitFor(() => expect(supervisor.resourceUsage().stdoutPending.bytes).toBeGreaterThanOrEqual(8 * 1_048_576), { timeout: 30_000 })
      const usage = supervisor.resourceUsage().stdoutPending
      expect(usage.peakBytes).toBeGreaterThanOrEqual(usage.bytes)
      // Past the old 1 MiB frame bound the child is neither failed nor restarted.
      expect(onFailure).not.toHaveBeenCalled()
      await supervisor.close()
      await call
    }, 120_000)

    // #386 reads this disclosure through stdoutPendingOf from the Host's
    // backendResourceUsage().views[]: it notices, and never stops the child.
    it('feeds the resource watchdog a frame the child never ends, so the user is told and the child keeps running', async () => {
      const onFailure = vi.fn()
      const supervisor = makeSupervisor({ onFailure })
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      const pid = await client.call('fixture.pid', null) as number
      // The same entry shape PluginBackendHost.backendResourceUsage() lists.
      const usage = () => ({ views: [{ pluginId: 'acme.indexer', instanceId: 'view-1', subscriptions: { current: 0, peak: 0 }, child: supervisor.resourceUsage() }] })
      const killed: number[] = []
      const onExceeded = vi.fn()
      const watch = watchBackendResources(pid, '/data', vi.fn(), { ...DEFAULT_BACKEND_RESOURCE_LIMITS, dataSampleEvery: 1 }, {
        listProcesses: async () => [{ pid, ppid: 1, rssBytes: 1_048_576, cpuMs: 0 }],
        dataDirBytes: async () => 0,
        kill: (victim) => killed.push(victim),
        now: () => 0,
        setInterval: () => 'handle',
        clearInterval: () => undefined,
      }, undefined, {
        onExceeded,
        stdoutPending: { bytes: () => stdoutPendingOf(usage(), 'acme.indexer', 'view-1'), threshold: 2 * 1_048_576 },
      })
      try {
        await watch.sample()
        expect(onExceeded).not.toHaveBeenCalled()
        const call = client.call('fixture.nonewline', { bytes: 8 * 1_048_576 }, { timeoutMs: 60_000 }).catch((error) => error)
        await vi.waitFor(async () => {
          await watch.sample()
          expect(onExceeded).toHaveBeenCalledWith(expect.objectContaining({ item: 'stdoutPending', threshold: 2 * 1_048_576 }))
        }, { timeout: 30_000 })
        expect(onExceeded.mock.calls[0]?.[0].usage).toBeGreaterThan(2 * 1_048_576)
        // Another view's child reads nothing.
        expect(stdoutPendingOf(usage(), 'acme.indexer', 'view-2')).toBe(0)
        expect(killed).toEqual([])
        expect(onFailure).not.toHaveBeenCalled()
        expect(() => process.kill(pid, 0)).not.toThrow()
        await supervisor.close()
        await call
      } finally {
        watch.dispose()
      }
    }, 120_000)

    const loopLag =(): { stop: () => number } => {
      let worst = 0
      let last = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last - 1)
        last = now
      }, 1)
      return { stop: () => { clearInterval(timer); return worst } }
    }

    for (const mode of ['pieces', 'single'] as const) {
      it(`takes a 40 MiB result as text (${mode}); this thread never decodes or parses more than one piece at a time`, async () => {
        const onFailure = vi.fn()
        const supervisor = makeSupervisor({ onFailure })
        supervisors.push(supervisor)
        await supervisor.start()
        const client = supervisor.clientFor(authenticatedRuntime)
        const pid = await client.call('fixture.pid', null)
        // What this (the Host's main) thread decodes and parses during the call.
        let largestParse = 0
        let largestDecode = 0
        const parse = JSON.parse
        const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
          largestParse = Math.max(largestParse, Buffer.byteLength(text))
          return parse(text, reviver)
        })
        type Decoder = InstanceType<typeof TextDecoder>
        const decode = TextDecoder.prototype.decode
        const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (this: Decoder, input?: Parameters<Decoder['decode']>[0], options?: Parameters<Decoder['decode']>[1]) {
          largestDecode = Math.max(largestDecode, input?.byteLength ?? 0)
          return decode.call(this, input, options)
        })
        const lag = loopLag()
        let text: BackendResultText
        try {
          text = await client.call('fixture.bigresult', { bytes: 40 * 1_048_576, mode }, {
            timeoutMs: 120_000,
            resultText: true,
          }) as unknown as BackendResultText
        } finally {
          parseSpy.mockRestore()
          decodeSpy.mockRestore()
        }
        const worst = lag.stop()
        expect(largestParse).toBeLessThanOrEqual(AGENT_TOOL_CHUNK_BYTES)
        expect(largestDecode).toBeLessThanOrEqual(AGENT_TOOL_CHUNK_BYTES)
        const joined = Array.from({ length: text.chunks }, (_, index) => text.piece(index))
        expect(joined.every((piece) => utf8ByteLength(piece) <= AGENT_TOOL_CHUNK_BYTES)).toBe(true)
        expect(sha(joined.join(''))).toBe(sha(JSON.stringify(big(40 * 1_048_576))))
        expect(text.bytes).toBe(utf8ByteLength(joined.join('')))
        // A loose smoke check only; the bounds above are what this test guards.
        expect(worst).toBeLessThan(250)
        await expect(client.call('fixture.pid', null)).resolves.toBe(pid)
        expect(onFailure).not.toHaveBeenCalled()
      }, 240_000)
    }

    it('delivers a large answer from a child that exits right after writing it', async () => {
      let delivered = 0
      for (let round = 0; round < 10; round++) {
        const supervisor = makeSupervisor()
        supervisors.push(supervisor)
        await supervisor.start()
        const client = supervisor.clientFor(authenticatedRuntime)
        const value = await client.call('fixture.bigexit', { bytes: 2 * 1_048_576 }, { timeoutMs: 60_000 })
        if (sha(JSON.stringify(value)) === sha(JSON.stringify(big(2 * 1_048_576)))) delivered += 1
      }
      expect(delivered).toBe(10)
    }, 240_000)

    it('checks a frame parsed off the main thread as strictly as the main thread does', async () => {
      const supervisor = makeSupervisor()
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      // A repeated key is a protocol error at any size, on either thread.
      await expect(client.call('fixture.bigresult', { bytes: 2 * 1_048_576, mode: 'duplicate-key' }, { timeoutMs: 60_000 }))
        .rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    }, 120_000)

    it('handles the frames that follow a large one after it, in order', async () => {
      const supervisor = makeSupervisor()
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      const order: string[] = []
      const large = client.call('fixture.bigresult', { bytes: 8 * 1_048_576, mode: 'single' }, { timeoutMs: 60_000 })
        .then((value) => { order.push('large'); return value })
      const small = client.call('fixture.pid', null).then((value) => { order.push('small'); return value })
      await Promise.all([large, small])
      expect(order).toEqual(['large', 'small'])
      expect(sha(JSON.stringify(await large))).toBe(sha(JSON.stringify(big(8 * 1_048_576))))
    }, 120_000)

    it('fails a dripping child at its second piece as short, and the child keeps serving', async () => {
      const supervisor = makeSupervisor()
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      const pid = await client.call('fixture.pid', null)
      await expect(client.call('fixture.bigresult', { bytes: 1, mode: 'drip' }))
        .rejects.toMatchObject({ code: 'CHUNKS_INVALID', reason: 'short' })
      await expect(client.call('fixture.pid', null)).resolves.toBe(pid)
    })

    it('fails a repeated seq at once as seq', async () => {
      const supervisor = makeSupervisor()
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      await expect(client.call('fixture.bigresult', { bytes: 1_048_576, mode: 'repeat' }))
        .rejects.toMatchObject({ code: 'CHUNKS_INVALID', reason: 'seq' })
      await expect(client.call('fixture.echo', { ok: true })).resolves.toBeDefined()
    })

    it('drops pieces that arrive after the call was cancelled, without a protocol error', async () => {
      const onFailure = vi.fn()
      const supervisor = makeSupervisor({ onFailure })
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      const pid = await client.call('fixture.pid', null)
      const controller = new AbortController()
      const call = client.call('fixture.bigresult', { bytes: 4 * 1_048_576 }, {
        signal: controller.signal,
        timeoutMs: 60_000,
        onTransferProgress: (phase) => { if (phase === 'result') controller.abort() },
      })
      await expect(call).rejects.toMatchObject({ code: 'USER_CANCELLED' })
      await expect(client.call('fixture.pid', null)).resolves.toBe(pid)
      expect(onFailure).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(supervisor.resourceUsage().droppedResultPieces).toBeGreaterThan(0))
    }, 120_000)

    it('sends 10 MiB of arguments in pieces to a child that reads them', async () => {
      const supervisor = makeSupervisor({ environment: { NAVIDE_FIXTURE: 'backend-wire', NAVIDE_FIXTURE_ARGUMENT_CHUNKS: '1' } })
      supervisors.push(supervisor)
      await supervisor.start()
      const client = supervisor.clientFor(authenticatedRuntime)
      const args = big(10 * 1_048_576)
      const phases: string[] = []
      const result = await client.call('fixture.hash', args, { timeoutMs: 60_000, onTransferProgress: (phase) => phases.push(phase) }) as {
        sha256: string; bytes: number; pieces: number
      }
      expect(result.sha256).toBe(sha(JSON.stringify(args)))
      expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(args), 'utf8'))
      expect(result.pieces).toBeGreaterThanOrEqual(80)
      expect(phases.filter((phase) => phase === 'arguments')).toHaveLength(result.pieces)
      expect(phases.at(-1)).toBe('execution')
    }, 120_000)

    it('keeps other children answering promptly while a 10 MiB result streams in', async () => {
      const busy = makeSupervisor()
      const other = makeSupervisor()
      supervisors.push(busy, other)
      await Promise.all([busy.start(), other.start()])
      const otherClient = other.clientFor(authenticatedRuntime)
      await otherClient.call('fixture.echo', { warm: true })
      let done = false
      const transfer = busy.clientFor(authenticatedRuntime)
        .call('fixture.bigresult', { bytes: 10 * 1_048_576 }, { timeoutMs: 60_000 })
        .finally(() => { done = true })
      const latencies: number[] = []
      while (!done) {
        const started = performance.now()
        await otherClient.call('fixture.echo', { small: true })
        latencies.push(performance.now() - started)
      }
      await transfer
      expect(latencies.length).toBeGreaterThan(0)
      // Calls to another child are served throughout the transfer, not held behind it.
      expect(Math.max(...latencies)).toBeLessThan(1_000)
    }, 120_000)
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

  // `web`, `agents` and `agent-message-bodies` are mapped to their own policy
  // namespaces, like filesystem and shell.
  const POLICY_MAPPED_PORTS: readonly PlansBridgePort[] = ['filesystem', 'shell', 'web', 'agents', 'agent-message-bodies']
  it.each(PLANS_BRIDGE_PORTS.filter((port) => !POLICY_MAPPED_PORTS.includes(port)))(
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

  it.each([
    ['allowlist', ['git'], 'git rev-parse HEAD', true],
    ['allowlist', ['git'], 'gh pr list', false],
    ['allowlist', ['git'], '', false],
    ['allowlist', [], 'git status', false],
    ['full', [], 'gh pr list', true],
  ] as const)(
    'applies the agent shell Execution Policy (%s %j) to the shell Bridge command %j',
    async (mode, shell, command, allowed) => {
      const bridgeDispatcher = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
      const supervisor = new PluginBackendSupervisor(
        { ...activation, approvedBridgePorts: ['shell'] },
        {
          environment: { NAVIDE_FIXTURE: 'backend-wire' },
          spawnProcess: () => makeBridgeChild(undefined, 'shell', 'run', { command }),
          resolveExecutionPolicy: () => ({
            policy: { schemaVersion: 1, mode, system: [], shell: [...shell] },
            revision: 1,
            state: 'user',
          }),
          bridgeDispatcher: { dispatch: bridgeDispatcher },
        },
      )
      supervisors.push(supervisor)
      const agentRuntime = createAuthenticatedBackendRuntime({
        ...runtime,
        initiator: { kind: 'agent', source: 'mcp', id: `shell-${mode}-agent` },
      })

      await supervisor.start()
      const call = supervisor.clientFor(agentRuntime, { workspacePath: '/workspace' }).call('fixture.bridge', null)
      if (allowed) {
        await expect(call).resolves.toEqual({ exitCode: 0, stdout: '', stderr: '' })
        expect(bridgeDispatcher).toHaveBeenCalledOnce()
      } else {
        await expect(call).rejects.toMatchObject({ code: 'PLUGIN_ERROR', pluginCode: 'CAPABILITY_DENIED' })
        expect(bridgeDispatcher).not.toHaveBeenCalled()
      }
    },
  )

  it('refuses the web Bridge port to a backend without it and checks agents against the web namespace', async () => {
    const bridgeDispatcher = vi.fn(async () => ({ views: [] }))
    const run = async (ports: PlansBridgePort[], initiator: BackendRuntimeContext['initiator'], system: string[]) => {
      bridgeDispatcher.mockClear()
      const supervisor = new PluginBackendSupervisor(
        { ...activation, approvedBridgePorts: ports },
        {
          environment: { NAVIDE_FIXTURE: 'backend-wire' },
          spawnProcess: () => makeBridgeChild(undefined, 'web', 'list', {}),
          resolveExecutionPolicy: () => ({
            policy: { schemaVersion: 1, mode: 'allowlist', system, shell: [] },
            revision: 1,
            state: 'user',
          }) as ExecutionPolicySnapshot,
          bridgeDispatcher: { dispatch: bridgeDispatcher },
        },
      )
      supervisors.push(supervisor)
      await supervisor.start()
      return supervisor
        .clientFor(createAuthenticatedBackendRuntime({ ...runtime, initiator }), { workspacePath: '/workspace' })
        .call('fixture.bridge', null)
    }
    const agent = { kind: 'agent', source: 'mcp', id: 'web-agent' } as const
    await expect(run(['filesystem'], authenticatedRuntime.initiator, ['web']))
      .rejects.toMatchObject({ code: 'PLUGIN_ERROR', pluginCode: 'CAPABILITY_DENIED' })
    expect(bridgeDispatcher).not.toHaveBeenCalled()
    await expect(run(['web'], agent, ['fs', 'ui']))
      .rejects.toMatchObject({ code: 'PLUGIN_ERROR', pluginCode: 'CAPABILITY_DENIED' })
    expect(bridgeDispatcher).not.toHaveBeenCalled()
    await expect(run(['web'], agent, ['web'])).resolves.toEqual({ views: [] })
    expect(bridgeDispatcher).toHaveBeenCalledOnce()
  })

  it.each([
    ['agents', 'list_panes', 'allowlist', ['agents'], true],
    ['agents', 'list_panes', 'allowlist', ['fs'], false],
    ['agents', 'list_panes', 'denylist', [], true],
    ['agent-message-bodies', 'read_message', 'allowlist', ['agentMessages'], true],
    ['agent-message-bodies', 'read_message', 'allowlist', ['agents'], false],
    // A denylist written before agentMessages existed never names it.
    ['agent-message-bodies', 'read_message', 'denylist', [], false],
    ['agent-message-bodies', 'read_message', 'full', [], true],
  ] as const)(
    'checks agent use of the %s Bridge port (%s) against the agent Execution Policy (%s %j)',
    async (port, operation, mode, system, allowed) => {
      const bridgeDispatcher = vi.fn(async () => ({ ok: true }))
      const supervisor = new PluginBackendSupervisor(
        { ...activation, approvedBridgePorts: [port] },
        {
          environment: { NAVIDE_FIXTURE: 'backend-wire' },
          spawnProcess: () => makeBridgeChild(undefined, port, operation, {}),
          resolveExecutionPolicy: () => ({
            policy: { schemaVersion: 1, mode, system: [...system], shell: [] },
            revision: 1,
            state: 'user',
          }) as ExecutionPolicySnapshot,
          bridgeDispatcher: { dispatch: bridgeDispatcher },
        },
      )
      supervisors.push(supervisor)
      await supervisor.start()
      const call = supervisor
        .clientFor(createAuthenticatedBackendRuntime({
          ...runtime,
          initiator: { kind: 'agent', source: 'mcp', id: `${port}-${mode}-agent` },
        }), { workspacePath: '/workspace' })
        .call('fixture.bridge', null)
      if (allowed) {
        await expect(call).resolves.toEqual({ ok: true })
        expect(bridgeDispatcher).toHaveBeenCalledOnce()
      } else {
        await expect(call).rejects.toMatchObject({ code: 'PLUGIN_ERROR', pluginCode: 'CAPABILITY_DENIED' })
        expect(bridgeDispatcher).not.toHaveBeenCalled()
      }
    },
  )

  it('passes a Bridge refusal reason and message on to the child, keeping data.code', async () => {
    for (const [thrown, data] of [
      [new PlansBridgeError('USER_IN_CONTROL', undefined, { reason: 'manual_takeover' }), { code: 'USER_IN_CONTROL', reason: 'manual_takeover' }],
      [new PlansBridgeError('CDP_ERROR', undefined, { message: 'x'.repeat(600) }), { code: 'CDP_ERROR', message: 'x'.repeat(500) }],
      [new PlansBridgeError('CAPABILITY_DENIED', 'not for the child'), { code: 'CAPABILITY_DENIED' }],
    ] as const) {
      const hostFrames: string[] = []
      const supervisor = new PluginBackendSupervisor(
        { ...activation, approvedBridgePorts: ['web'] },
        {
          environment: { NAVIDE_FIXTURE: 'backend-wire' },
          spawnProcess: () => {
            const child = makeBridgeChild(undefined, 'web', 'cdp', { viewId: 'v1', method: 'Page.reload' })
            child.stdin.on('data', (chunk: Buffer) => { hostFrames.push(chunk.toString('utf8')) })
            return child
          },
          bridgeDispatcher: { dispatch: async () => { throw thrown } },
        },
      )
      supervisors.push(supervisor)
      await supervisor.start()
      await expect(
        supervisor.clientFor(authenticatedRuntime, { workspacePath: '/workspace' }).call('fixture.bridge', null)
      ).rejects.toMatchObject({ code: 'PLUGIN_ERROR', pluginCode: data.code })
      const error = hostFrames.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .find((frame) => frame.id === 'bridge:child-request')?.error
      expect(error).toEqual({ code: 1000, message: 'Host Bridge request failed.', data })
    }
  })

  it('refuses the shell Bridge port to an activation that was not projected it', async () => {
    const bridgeDispatcher = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }))
    const supervisor = new PluginBackendSupervisor(
      { ...activation, approvedBridgePorts: ['filesystem'] },
      {
        environment: { NAVIDE_FIXTURE: 'backend-wire' },
        spawnProcess: () => makeBridgeChild(undefined, 'shell', 'run', { command: 'git status' }),
        bridgeDispatcher: { dispatch: bridgeDispatcher },
      },
    )
    supervisors.push(supervisor)
    await supervisor.start()
    await expect(
      supervisor.clientFor(authenticatedRuntime, { workspacePath: '/workspace' }).call('fixture.bridge', null)
    ).rejects.toMatchObject({ code: 'PLUGIN_ERROR', pluginCode: 'CAPABILITY_DENIED' })
    expect(bridgeDispatcher).not.toHaveBeenCalled()
  })

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

  it('holds more subscriptions on one child than the old 256 and discloses current and peak', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const client = supervisor.clientFor(authenticatedRuntime)
    // User ruling: no cap; the 257th subscription used to get RESOURCE_LIMIT.
    const subscriptions = Array.from({ length: 300 }, () => client.subscribe(['fixture.changed'], () => undefined))
    await Promise.all(subscriptions.map((subscription) => subscription.acknowledged))
    expect(supervisor.resourceUsage().subscriptions).toEqual({ current: 300, peak: 300 })
    for (const subscription of subscriptions) subscription.dispose()
    await Promise.all(subscriptions.map((subscription) => subscription.settled))
    expect(supervisor.resourceUsage().subscriptions).toEqual({ current: 0, peak: 300 })
  }, 60_000)

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

  it('accepts a subscription past the old 256 bound and settles every one on dispose', async () => {
    const supervisor = makeSupervisor()
    supervisors.push(supervisor)
    await supervisor.start()

    const client = supervisor.clientFor(authenticatedRuntime)
    const subscriptions = Array.from({ length: 256 }, () =>
      client.subscribe(['fixture.changed'], () => undefined)
    )
    await Promise.all(subscriptions.map((subscription) => subscription.acknowledged))

    // User ruling: no cap; the 257th used to throw RESOURCE_LIMIT.
    const extra = client.subscribe(['fixture.changed'], () => undefined)
    await extra.acknowledged
    subscriptions.push(extra)

    subscriptions.forEach((subscription) => subscription.dispose())
    await Promise.all(subscriptions.map((subscription) => subscription.settled))
    expect(supervisor.resourceUsage().subscriptions).toEqual({ current: 0, peak: 257 })
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

  it('keeps the message in the host-only diagnostic when the cause stack lacks it', async () => {
    const stderr = vi.fn()
    const spawnError = new Error('spawn /custom/private/plans ENOENT')
    // Some runtimes build a stack that holds only a bare `Error` header.
    spawnError.stack = 'Error\n    at spawnPlans (/custom/spawn.ts:1:1)'
    const supervisor = makeSupervisor({
      onStderr: stderr,
      spawnProcess: () => {
        throw spawnError
      },
    })
    supervisors.push(supervisor)

    await expect(supervisor.start()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })

    expect(stderr).toHaveBeenCalledWith(
      'spawn /custom/private/plans ENOENT\nError\n    at spawnPlans (/custom/spawn.ts:1:1)\n',
    )
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
      let burst: { parent: string; expected: number; ok: number; errors: unknown[] } | undefined
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
          if (frame.method === 'navide/call' && frame.id && frame.params?.name === 'fixture.bridgeburst') {
            // Many Bridge requests in flight at once, all from one call.
            const count = (frame.params.arguments as { count: number }).count
            burst = { parent: frame.id, expected: count, ok: 0, errors: [] }
            for (let index = 0; index < count; index += 1) {
              stdout.write(`${JSON.stringify({
                jsonrpc: '2.0',
                id: `bridge:burst-${index}`,
                method: 'navide/host/call',
                params: {
                  origin: { kind: 'call', requestId: frame.id },
                  port: 'filesystem',
                  operation: 'resolve_root',
                  arguments: {},
                },
              })}\n`)
            }
            continue
          }
          if (burst && typeof frame.id === 'string' && frame.id.startsWith('bridge:burst-')) {
            if (frame.result) burst.ok += 1
            else burst.errors.push(frame.error)
            if (burst.ok + burst.errors.length === burst.expected) {
              stdout.write(`${JSON.stringify({
                jsonrpc: '2.0',
                id: burst.parent,
                result: { resultType: 'complete', value: { ok: burst.ok, errors: burst.errors }, _meta: serverInfo },
              })}\n`)
              burst = undefined
            }
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

    it('queues every Host event notification while the child is not reading, dropping none', async () => {
      const onFailure = vi.fn()
      const stderrSink = vi.fn()
      const onNotificationDropped = vi.fn()
      const emitted = 12
      const payload = 'x'.repeat(48 * 1024)
      const harness = makeStallableChild()
      const supervisor = makeSupervisor({
        onFailure,
        onStderr: stderrSink,
        onNotificationDropped,
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

      // User ruling: no drop. 12 x 48 KiB of events wait for the child instead.
      const delivered = harness.hostFrames.filter((frame) => frame.includes('navide/host/event')).length
      expect(delivered).toBe(emitted)
      expect(onFailure).not.toHaveBeenCalled()
      expect(harness.kill).not.toHaveBeenCalled()
      expect(stderrSink).not.toHaveBeenCalledWith(expect.stringContaining('output queue limit'))
      expect(onNotificationDropped).not.toHaveBeenCalled()
      const usage = supervisor.resourceUsage()
      expect(usage.droppedNotifications).toBe(0)
      expect(usage.outputQueue.notifications.peakFrames).toBeGreaterThanOrEqual(emitted - 1)
      expect(usage.outputQueue.notifications.peakBytes).toBeGreaterThan(256 * 1024)
      expect(usage.outputQueue.notifications).toMatchObject({ frames: 0, bytes: 0 })
    })

    it('keeps delivering Host event notifications while requests back up past the queue bound', async () => {
      const onNotificationDropped = vi.fn()
      const harness = makeStallableChild()
      let backlog: Promise<unknown[]> | undefined
      const payload = 'y'.repeat(48 * 1024)
      const supervisor: PluginBackendSupervisor = makeSupervisor({
        onNotificationDropped,
        bridgeDispatcher: {
          dispatch: async (_request, context) => {
            harness.stall()
            const client = supervisor.clientFor(authenticatedRuntime)
            // 12 x 48 KiB of requests: past the 256 KiB bound on their own.
            backlog = Promise.all(Array.from({ length: 12 }, (_, index) =>
              client.call('fixture.echo', { index, payload }).catch((error: unknown) => error)
            ))
            for (let index = 0; index < 3; index += 1) context.emit('plans.changed', { index })
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
      const settled = await backlog
      expect(settled?.filter((entry) => entry instanceof Error)).toEqual([])
      expect(harness.hostFrames.filter((frame) => frame.includes('navide/host/event'))).toHaveLength(3)
      expect(onNotificationDropped).not.toHaveBeenCalled()
    })

    it('queues request frames past the output queue bound instead of failing the child', async () => {
      const onFailure = vi.fn()
      const harness = makeStallableChild()
      const supervisor = makeSupervisor({ onFailure, spawnProcess: () => harness.child })
      supervisors.push(supervisor)
      await supervisor.start()
      harness.stall()

      const client = supervisor.clientFor(authenticatedRuntime)
      const payload = 'y'.repeat(48 * 1024)
      const calls = Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          client.call('fixture.echo', { index, payload }).catch((error: unknown) => error)
        )
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      harness.release()
      const settled = await calls

      // 12 x 48 KiB is past the 256 KiB bound: every call is still delivered.
      expect(settled.filter((entry) => entry instanceof Error)).toEqual([])
      expect(onFailure).not.toHaveBeenCalled()
      expect(harness.kill).not.toHaveBeenCalled()
      const queue = supervisor.resourceUsage().outputQueue.requests
      expect(queue.peakFrames).toBeGreaterThanOrEqual(11)
      expect(queue.peakBytes).toBeGreaterThan(256 * 1024)
      expect(queue).toMatchObject({ frames: 0, bytes: 0 })
    })

    it('serves more Bridge requests from one child at once than the old 256 and discloses them', async () => {
      const harness = makeStallableChild()
      const count = 300
      let arrived = 0
      let releaseAll!: () => void
      const allArrived = new Promise<void>((resolve) => { releaseAll = resolve })
      const supervisor: PluginBackendSupervisor = makeSupervisor({
        bridgeDispatcher: {
          dispatch: async () => {
            arrived += 1
            if (arrived === count) releaseAll()
            // Hold every request until all are in flight (or 2 s, so the old cap cannot hang the test).
            await Promise.race([allArrived, new Promise((resolve) => setTimeout(resolve, 2_000))])
            return { root: '/workspace' }
          },
        },
        spawnProcess: () => harness.child,
      })
      supervisors.push(supervisor)
      await supervisor.start()

      const result = await supervisor
        .clientFor(authenticatedRuntime, { workspacePath: '/workspace' })
        .call('fixture.bridgeburst', { count })
      // User ruling: no cap. Every request was dispatched; none got RESOURCE_LIMIT.
      expect(result).toEqual({ ok: count, errors: [] })
      expect(supervisor.resourceUsage().bridgeRequests).toEqual({ current: 0, peak: count })
    })

    it('writes a request frame larger than the old queue bound as one frame to a child without argument pieces', async () => {
      const onFailure = vi.fn()
      const harness = makeStallableChild()
      const supervisor = makeSupervisor({ onFailure, spawnProcess: () => harness.child })
      supervisors.push(supervisor)
      await supervisor.start()

      const client = supervisor.clientFor(authenticatedRuntime)
      // Contract 4.4, A3: no Host-side refusal (was RESOURCE_LIMIT); this child
      // did not advertise argument pieces, so the arguments go in one frame.
      await expect(client.call('fixture.echo', { payload: 'z'.repeat(300 * 1024) }))
        .resolves.toEqual({ echoed: true })
      const written = harness.hostFrames.filter((frame) => frame.includes('fixture.echo'))
      expect(written).toHaveLength(1)
      expect(written[0].length).toBeGreaterThan(300 * 1024)
      expect(harness.hostFrames.some((frame) => frame.includes('navide/argumentChunk'))).toBe(false)
      expect(onFailure).not.toHaveBeenCalled()
      expect(harness.kill).not.toHaveBeenCalled()
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
