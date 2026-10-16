import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SANDBOX_EXEC_PATH, type BackendSandboxProbe } from './pluginBackendSandbox'
import { NativeBackendStore } from './pluginNativeBackendStore'
import { canonicalContractJson } from '../../shared/pluginDisclosure'
import { isWindows } from '../../shared/osplat'
import {
  agentToolNameCollisions,
  agentToolsDigest,
  backendPermissionsKey,
  ThirdPartyBackendController,
  thirdPartyBackendLaunchSpec,
  type NativeBackendConsentPrompt,
  type ThirdPartyLaunchSpec,
} from './pluginThirdPartyBackends'

// B1-a: backend.agentTools is validated with the contract's own functions,
// bound into the native backend consent only when declared, listed in the
// consent prompt and the Extensions rows, and DB1 name collisions are marked.

const DARWIN: BackendSandboxProbe = { platform: 'darwin', sandboxExec: () => SANDBOX_EXEC_PATH, bubblewrap: () => null }

type Tool = Record<string, unknown>

const READ_TOOL: Tool = {
  name: 'devmap_read',
  method: 'devmap.read',
  risk: 'read',
  title: 'Read dev map',
  description: "Read this workspace's dev map.",
  inputSchema: { type: 'object', properties: {} },
}
const WRITE_TOOL: Tool = {
  name: 'devmap_set_status',
  method: 'devmap.setStatus',
  risk: 'write',
  title: 'Set block status',
  description: "Set one block's status (done|wip|plan) in this workspace's dev map.",
  timeoutMs: 5000,
  inputSchema: { type: 'object', required: ['block_id'], properties: { block_id: { type: 'string' } } },
}

function manifest(id: string, agentTools?: Tool[]) {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id,
    name: 'Dev Map',
    version: '1.0.0',
    publisher: id.split('.')[0],
    permissions: { system: ['fs'] },
    marketplace: { description: 'Show the dev map.', license: 'MIT' },
    backend: {
      entry: 'backend/devmap',
      protocolVersion: 1,
      activation: 'startup',
      methods: ['devmap.read', 'devmap.setStatus'],
      events: ['devmap.changed'],
      ...(agentTools ? { agentTools } : {}),
    },
  }
}

let root = ''
let store: NativeBackendStore

function writePackage(id: string, agentTools?: Tool[]): ThirdPartyLaunchSpec {
  const packageDir = join(root, 'plugins', id, '1.0.0')
  mkdirSync(join(packageDir, 'backend'), { recursive: true })
  writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify(manifest(id, agentTools)))
  writeFileSync(join(packageDir, 'backend', 'devmap'), 'binary', { mode: 0o700 })
  const spec = thirdPartyBackendLaunchSpec({
    pluginId: id,
    packageVersion: '1.0.0',
    packageDir,
    views: [],
    backend: { entryFile: join(packageDir, 'backend', 'devmap'), protocolVersion: 1, activation: 'startup' },
  })
  if (!spec) throw new Error('no spec')
  return spec
}

function controller(options: Partial<ConstructorParameters<typeof ThirdPartyBackendController>[0]> = {}) {
  return new ThirdPartyBackendController({
    store,
    dataRoot: join(root, 'data'),
    probe: DARWIN,
    spawnImpl: vi.fn(() => ({ pid: undefined, once: vi.fn() })) as never,
    watchResources: () => ({ dispose: vi.fn(), sample: async () => null }),
    killSandbox: vi.fn(),
    sweepEscapees: vi.fn(async () => []),
    digestBackend: async () => 'a'.repeat(64),
    ...options,
  })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-tools-consent-')))
  store = new NativeBackendStore(join(root, 'store'))
  store.setEnabled(true)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('consent key (contract section 2.8)', () => {
  it('is unchanged for a package that declares no agent tools', () => {
    const spec = writePackage('acme.devmap')
    expect(spec.thirdParty).not.toHaveProperty('agentTools')
    // The exact key main produced, so existing consent records stay valid.
    expect(backendPermissionsKey(spec)).toBe(
      '{"system":["fs"],"shell":null,"methods":["devmap.read","devmap.setStatus"],"events":["devmap.changed"]}'
    )
  })

  it('adds the digest of the canonical agentTools disclosure when tools are declared', () => {
    const spec = writePackage('acme.devmap', [WRITE_TOOL, READ_TOOL])
    // The disclosure spelling: sorted by name, timeout defaulted.
    expect(spec.thirdParty.agentTools?.map((tool) => [tool.name, tool.timeoutMs])).toEqual([
      ['devmap_read', 30000],
      ['devmap_set_status', 5000],
    ])
    const digest = createHash('sha256').update(canonicalContractJson(spec.thirdParty.agentTools)).digest('hex')
    expect(agentToolsDigest(spec.thirdParty.agentTools!)).toBe(digest)
    expect(JSON.parse(backendPermissionsKey(spec))).toEqual({
      system: ['fs'],
      shell: null,
      methods: ['devmap.read', 'devmap.setStatus'],
      events: ['devmap.changed'],
      agentTools: digest,
    })
  })

  it('changes when any part of any tool changes, but not with declaration order', () => {
    const key = backendPermissionsKey(writePackage('acme.devmap', [READ_TOOL, WRITE_TOOL]))
    expect(backendPermissionsKey(writePackage('acme.devmap', [WRITE_TOOL, READ_TOOL]))).toBe(key)
    const variants: Tool[][] = [
      [{ ...READ_TOOL, description: 'Read the dev map, then do more.' }, WRITE_TOOL],
      [{ ...READ_TOOL, title: 'Read' }, WRITE_TOOL],
      [{ ...READ_TOOL, risk: 'write' }, WRITE_TOOL],
      [{ ...READ_TOOL, method: 'devmap.setStatus' }, WRITE_TOOL],
      [{ ...READ_TOOL, timeoutMs: 30001 }, WRITE_TOOL],
      [{ ...READ_TOOL, inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }, WRITE_TOOL],
      [READ_TOOL],
    ]
    for (const tools of variants) {
      expect(backendPermissionsKey(writePackage('acme.devmap', tools))).not.toBe(key)
    }
  })

  it.skipIf(isWindows())('asks again when a version changes its tools, and lists the tools in the prompt', async () => {
    const before = writePackage('acme.devmap', [READ_TOOL])
    store.grantConsent('acme.devmap', {
      binarySha256: 'a'.repeat(64),
      permissionsKey: backendPermissionsKey(before),
      packageVersion: '1.0.0',
    })
    const promptConsent = vi.fn(async (_prompt: NativeBackendConsentPrompt) => false)
    const instance = controller({ promptConsent })
    expect((await instance.status(before)).status).toBe('ready')

    const after = writePackage('acme.devmap', [READ_TOOL, WRITE_TOOL])
    const row = await instance.status(after)
    expect(row.status).toBe('needs-consent')
    expect(row.changedSinceConsent).toBe(true)
    await expect(instance.admit(after)).rejects.toThrow('the user did not allow the native backend')
    expect(promptConsent).toHaveBeenCalledTimes(1)
    const prompt = promptConsent.mock.calls[0][0]
    expect(prompt.update).toBe(true)
    expect(prompt.agentTools.map((tool) => [tool.name, tool.risk, tool.timeoutMs, tool.description])).toEqual([
      ['devmap_read', 'read', 30000, READ_TOOL.description],
      ['devmap_set_status', 'write', 5000, WRITE_TOOL.description],
    ])
  })

  it.skipIf(isWindows())('passes an empty tool list to the prompt of a package without tools', async () => {
    const promptConsent = vi.fn(async (_prompt: NativeBackendConsentPrompt) => false)
    await expect(controller({ promptConsent }).admit(writePackage('acme.devmap'))).rejects.toThrow()
    expect(promptConsent.mock.calls[0][0].agentTools).toEqual([])
    expect(store.record('acme.devmap')).not.toHaveProperty('agentToolsSince')
  })
})

describe('manifest validation uses the contract', () => {
  it('refuses a package whose tools break a contract rule, naming the rule', () => {
    expect(() => writePackage('acme.devmap', [{ ...READ_TOOL, name: 'other_read' }])).toThrow(
      'manifest backend.agentTools[0].name is invalid: AGENT_TOOL_PREFIX_MISMATCH'
    )
    expect(() => writePackage('acme.plan', [{ ...READ_TOOL, name: 'plan_read' }])).toThrow('AGENT_TOOL_PREFIX_RESERVED')
    expect(() => writePackage('acme.devmap', [{ ...READ_TOOL, method: 'devmap.delete' }])).toThrow(
      'AGENT_TOOL_METHOD_UNDECLARED'
    )
    expect(() => writePackage('acme.devmap', [{ ...READ_TOOL, description: 'one\ntwo' }])).toThrow(
      'AGENT_TOOL_TEXT_INVALID'
    )
    expect(() => writePackage('acme.devmap', [])).toThrow('manifest backend.agentTools must be a non-empty array')
  })

  it('refuses a description over the 1 MiB stability cap', () => {
    expect(() => writePackage('acme.devmap', [{ ...READ_TOOL, description: 'x'.repeat(1_048_577) }])).toThrow(
      'AGENT_TOOL_TOO_LARGE'
    )
  })
})

describe('DB1 name collisions', () => {
  it('lets the package that began declaring tools first keep the name', () => {
    const collisions = agentToolNameCollisions([
      { pluginId: 'zeta.devmap', since: '2026-10-02T00:00:00.000Z', names: ['devmap_read', 'devmap_only_z'] },
      { pluginId: 'acme.devmap', since: '2026-10-03T00:00:00.000Z', names: ['devmap_read'] },
      { pluginId: 'beta.devmap', names: ['devmap_read'] },
    ])
    expect(collisions.get('zeta.devmap')).toBeUndefined()
    expect(collisions.get('acme.devmap')).toEqual([{ name: 'devmap_read', heldBy: 'zeta.devmap' }])
    expect(collisions.get('beta.devmap')).toEqual([{ name: 'devmap_read', heldBy: 'zeta.devmap' }])
  })

  it('breaks a tie by plugin id, whatever order the packages are listed in', () => {
    const claimants = [
      { pluginId: 'zeta.devmap', since: '2026-10-02T00:00:00.000Z', names: ['devmap_read'] },
      { pluginId: 'acme.devmap', since: '2026-10-02T00:00:00.000Z', names: ['devmap_read'] },
    ]
    for (const order of [claimants, [...claimants].reverse()]) {
      expect([...agentToolNameCollisions(order)]).toEqual([['zeta.devmap', [{ name: 'devmap_read', heldBy: 'acme.devmap' }]]])
    }
  })

  it('marks the later package in the Extensions rows, and frees the name when the holder is disabled', async () => {
    let now = Date.parse('2026-10-01T00:00:00.000Z')
    const instance = controller({ now: () => now })
    const first = writePackage('zeta.devmap', [READ_TOOL])
    await instance.statuses([first])
    now += 60_000
    const second = writePackage('acme.devmap', [READ_TOOL, WRITE_TOOL])

    const rows = await instance.statuses([second, first])
    const byId = new Map(rows.map((row) => [row.pluginId, row]))
    expect(byId.get('zeta.devmap')?.agentTools).toEqual([
      { name: 'devmap_read', title: READ_TOOL.title, description: READ_TOOL.description, risk: 'read', timeoutMs: 30000 },
    ])
    expect(byId.get('acme.devmap')?.agentTools).toEqual([
      { name: 'devmap_read', title: READ_TOOL.title, description: READ_TOOL.description, risk: 'read', timeoutMs: 30000, collidesWith: 'zeta.devmap' },
      { name: 'devmap_set_status', title: WRITE_TOOL.title, description: WRITE_TOOL.description, risk: 'write', timeoutMs: 5000 },
    ])

    await instance.setDisabled('zeta.devmap', true)
    const freed = await instance.statuses([second, first])
    expect(freed.find((row) => row.pluginId === 'acme.devmap')?.agentTools?.every((tool) => !tool.collidesWith)).toBe(true)
  })

  it('leaves rows of packages without tools exactly as status() produced them', async () => {
    const instance = controller()
    const spec = writePackage('acme.devmap')
    const [row] = await instance.statuses([spec])
    expect(row).toEqual(await instance.status(spec))
    expect(row).not.toHaveProperty('agentTools')
  })
})

describe('NativeBackendStore agentToolsSince', () => {
  it('keeps the first time across reloads and forgets it on uninstall', () => {
    store.noteAgentToolsSince('acme.devmap', new Date('2026-10-01T00:00:00.000Z'))
    store.noteAgentToolsSince('acme.devmap', new Date('2026-10-05T00:00:00.000Z'))
    const reloaded = new NativeBackendStore(join(root, 'store'))
    expect(reloaded.record('acme.devmap').agentToolsSince).toBe('2026-10-01T00:00:00.000Z')
    reloaded.grantConsent('acme.devmap', { binarySha256: 'a'.repeat(64), permissionsKey: 'k', packageVersion: '1.0.0' })
    expect(reloaded.record('acme.devmap').agentToolsSince).toBe('2026-10-01T00:00:00.000Z')
    reloaded.forget('acme.devmap')
    expect(reloaded.record('acme.devmap')).toEqual({})
  })
})
