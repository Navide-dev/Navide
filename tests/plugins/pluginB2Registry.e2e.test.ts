// B2-d end to end, Host side: a real Marketplace Registry (marketplace/registry,
// started here on loopback with freshly generated keys) behind the App's real
// `plugins:*` IPC handlers, the Host's real answers to the backend's
// `marketplace.query` and `plugins.agent_action` (FrontendPluginManager, wired
// by registerPluginIpc), and the window's real carrying-out of an approved
// agent request (applyApprovedRequest with usePluginAgentRequests' finish).
//
// The backend side of the same messages is backend/tests/test_b2_wire_contract.py.
// The two meet in docs/plugin-contracts/b2-fixtures/host-messages.json: every
// message the Host sends here, and every backend message the Host accepts,
// must have exactly the fixture's shape. A full stack with a real backend
// process is a later nightly job.
//
// A rejected request never reaches the window's carrying-out (the approval
// card calls applyApprovedRequest only after `decide` answered `applying`):
// that path is the backend test's.
//
// Skipped where the Registry cannot run (Windows, no marketplace/registry/.venv),
// like pluginRegistry.e2e.test.ts; NAVIDE_REGISTRY_E2E_REQUIRED=1 makes that a failure.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.2.24' },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    },
  },
}))

import { registerPluginIpc } from '../../src/main/plugins/pluginIpc'
import { FrontendPluginManager } from '../../src/main/plugins/frontendPluginManager'
import { parsePluginAgentActionRequest, type PluginAgentActionNotice } from '../../src/main/plugins/pluginAgentAction'
import { registryRootFingerprint } from '../../src/main/plugins/pluginRegistryRootApproval'
import { PluginDisabledStore } from '../../src/main/plugins/pluginDisabledStore'
import {
  applyApprovedRequest,
  type PluginRequestRecord,
} from '../../src/renderer/src/lib/pluginAgentRequestApply'
import { usePluginAgentRequests } from '../../src/renderer/src/composables/usePluginAgentRequests'
import { pluginAgentUndoApplies } from '../../src/renderer/src/composables/useAnnouncements'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

const REGISTRY_DIR = resolve(__dirname, '../../marketplace/registry')
const REGISTRY_PYTHON = join(REGISTRY_DIR, '.venv', 'bin', 'python')
const IS_WINDOWS = process.platform === 'win32'
const REGISTRY_AVAILABLE = !IS_WINDOWS && existsSync(REGISTRY_PYTHON)
if (!IS_WINDOWS && !REGISTRY_AVAILABLE && process.env.NAVIDE_REGISTRY_E2E_REQUIRED === '1') {
  throw new Error(`Registry Python env missing at ${REGISTRY_PYTHON}; NAVIDE_REGISTRY_E2E_REQUIRED=1 needs it`)
}

const PUBLISHER = 'b2probe'
const NAME = 'tool'
const ID = `${PUBLISHER}.${NAME}`
const VERSION = '0.1.0'

// ── the shared wire fixture ─────────────────────────────────────────────────

interface FixtureEntry { name: string; message: unknown; optional?: string[]; nullable?: string[] }
interface Fixture { opaque: string[]; messages: Record<string, FixtureEntry[]> }
const FIXTURE: Fixture = JSON.parse(readFileSync(
  resolve(__dirname, '../../docs/plugin-contracts/b2-fixtures/host-messages.json'), 'utf8',
))

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Where `actual` differs in shape from `example`: exact keys at every level
 *  (optional paths may be absent, nullable paths may be null), arrays element
 *  by element against the example's first element, a null example accepting
 *  a string too. */
function shapeProblems(actual: unknown, example: unknown, path: string, optional: string[], nullable: string[] = []): string[] {
  if (actual === null && nullable.includes(path)) return []
  if (FIXTURE.opaque.includes(path)) {
    return kindOf(actual) === 'object' || actual === null ? [] : [`${path}: expected an object`]
  }
  if (example === null) return actual === null || typeof actual === 'string' ? [] : [`${path}: expected null or a string`]
  if (kindOf(actual) !== kindOf(example)) return [`${path || '(root)'}: expected ${kindOf(example)}, got ${kindOf(actual)}`]
  if (Array.isArray(example)) {
    return example.length === 0 ? [] : (actual as unknown[]).flatMap((item) => shapeProblems(item, example[0], `${path}[]`, optional, nullable))
  }
  if (kindOf(example) !== 'object') return []
  const ex = example as Record<string, unknown>
  const ac = actual as Record<string, unknown>
  const at = (key: string): string => (path ? `${path}.${key}` : key)
  const problems: string[] = []
  for (const key of Object.keys(ac)) if (!(key in ex)) problems.push(`${at(key)}: not in the fixture`)
  for (const key of Object.keys(ex)) {
    if (!(key in ac)) {
      if (!optional.includes(at(key))) problems.push(`${at(key)}: missing`)
      continue
    }
    problems.push(...shapeProblems(ac[key], ex[key], at(key), optional, nullable))
  }
  return problems
}

/** The problems of the closest fixture entry of `type` (none when one matches). */
function wireProblems(type: string, message: unknown): string[] {
  const entries = FIXTURE.messages[type]
  if (!entries) return [`${type}: no fixture entry`]
  const all = entries.map((entry) => shapeProblems(message, entry.message, '', entry.optional ?? [], entry.nullable ?? []))
  return all.find((problems) => problems.length === 0) ?? all.reduce((a, b) => (a.length <= b.length ? a : b))
}

function expectWire(type: string, message: unknown): void {
  expect(wireProblems(type, message), `${type}: ${JSON.stringify(message)}`).toEqual([])
}

describe('the shared B2 wire fixture', () => {
  it('catches a missing or an extra field, in the fixture or in a message', () => {
    const [changed] = FIXTURE.messages['plugins.agent_action.result']
    const message = structuredClone(changed.message) as Record<string, unknown>
    expect(wireProblems('plugins.agent_action.result', message)).toEqual([])
    const { changed: _dropped, ...missing } = message
    expect(wireProblems('plugins.agent_action.result', missing).length).toBeGreaterThan(0)
    expect(wireProblems('plugins.agent_action.result', { ...message, extra: 1 }).length).toBeGreaterThan(0)
  })

  it('accepts null only at the paths an entry lists as nullable', () => {
    const entry = FIXTURE.messages['plugins.agent_action.result'].find((e) => e.name === 'approval-required')!
    const message = structuredClone(entry.message) as { disabled: Record<string, unknown> }
    expect(wireProblems('plugins.agent_action.result', message)).toEqual([])
    expect(wireProblems('plugins.agent_action.result', { ...message, disabled: { ...message.disabled, at: null } })).toEqual([])
    expect(wireProblems('plugins.agent_action.result', { ...message, disabled: { ...message.disabled, by: null } }).length)
      .toBeGreaterThan(0)
    expect(wireProblems('plugins.agent_action.result', { ...message, pluginVersion: null }).length).toBeGreaterThan(0)
    expect(wireProblems('plugins.agent_action.result', { ...message, disabled: { ...message.disabled, at: 'x' } }).length)
      .toBeGreaterThan(0)
  })

  it('every backend → Host example is what the Host accepts', () => {
    for (const entry of FIXTURE.messages['plugins.agent_action.request']) {
      expect(parsePluginAgentActionRequest(entry.message), entry.name).not.toBeNull()
    }
  })
})

// ── the Registry ────────────────────────────────────────────────────────────

describe.skipIf(!REGISTRY_AVAILABLE)('B2 against a real Registry: search → request → approve → install → disable → enable → remove', () => {
  let work: string
  let dataDir: string
  let registry: ChildProcess | undefined
  let registryPid: number | undefined
  let registryUrl: string
  let publisherToken: string
  const registryLog: string[] = []
  let manager: FrontendPluginManager
  let root: string
  let call: (channel: string, args?: unknown) => Promise<any>
  const notices: PluginAgentActionNotice[] = []
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  const finishes: Array<Record<string, unknown>> = []

  function cli(commands: string[][]): void {
    const code = [
      'import json, sys',
      'from registry.cli import main',
      'for argv in json.loads(sys.argv[1]):',
      '    if main(argv) != 0: sys.exit(1)',
    ].join('\n')
    execFileSync(REGISTRY_PYTHON, ['-c', code, JSON.stringify(commands)], {
      cwd: REGISTRY_DIR,
      // The CLI opens a Registry data dir (database, trust keys) too. Its
      // default, .registry-data under cwd, is shared with pluginRegistry.e2e,
      // and two first runs at once race to create it (CI runs both together).
      env: {
        ...process.env, PYTHONDONTWRITEBYTECODE: '1', HOME: work,
        NAVIDE_PLUGIN_CONFIG_DIR: join(work, 'cli-config'), REGISTRY_DATA_DIR: join(work, 'cli-data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  const vsix = (): string => join(work, `${ID}-${VERSION}.vsix`)

  function buildPackage(): void {
    const src = join(work, 'src')
    mkdirSync(join(src, 'frontend', 'main'), { recursive: true })
    writeFileSync(join(src, 'manifest.json'), JSON.stringify({
      schemaVersion: 2, apiVersion: '^1.0.0', id: ID, name: 'B2 Probe Tool', version: VERSION, publisher: PUBLISHER,
      permissions: { system: ['fs'], scopes: { fs: { root: 'workspace', read: ['README.md'] } } },
      marketplace: { description: 'B2 end-to-end probe', license: 'MIT' },
      contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Probe', entry: 'frontend/main/index.html' }] },
    }, null, 2))
    writeFileSync(join(src, 'frontend', 'main', 'index.html'), '<!doctype html><title>b2 probe</title>')
    writeFileSync(join(src, 'artifact-files.json'), JSON.stringify({ files: ['manifest.json', 'frontend/main/index.html'] }))
    cli([
      ['keygen', '--out-dir', join(work, 'keys'), '--name', PUBLISHER],
      ['pack', src, '--out', vsix()],
      ['sign', vsix(), '--key', join(work, 'keys', `${PUBLISHER}.key`), '--out', `${vsix()}.sig`],
    ])
  }

  async function publish(): Promise<void> {
    const body = new FormData()
    body.append('package', new Blob([readFileSync(vsix())], { type: 'application/zip' }), `${ID}-${VERSION}.vsix`)
    const signature = readFileSync(`${vsix()}.sig`, 'utf8').trim()
    const res = await fetch(`${registryUrl}/api/publish?target=universal&signature=${encodeURIComponent(signature)}`, {
      method: 'POST', body, headers: { authorization: `Bearer ${publisherToken}` },
    })
    expect(res.status, await res.clone().text()).toBe(201)
  }

  async function startRegistry(): Promise<void> {
    const adminToken = createHash('sha256').update(`admin-${Math.random()}`).digest('hex')
    registry = spawn(REGISTRY_PYTHON, ['-m', 'uvicorn', 'registry.app:app', '--host', '127.0.0.1', '--port', '0'], {
      cwd: REGISTRY_DIR,
      env: {
        ...process.env, HOME: work, PYTHONDONTWRITEBYTECODE: '1',
        REGISTRY_DATA_DIR: dataDir, REGISTRY_ADMIN_TOKEN: adminToken, REGISTRY_TRUST_PROFILE: 'self-hosted-dev',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    registryPid = registry.pid
    registryUrl = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`Registry did not start:\n${registryLog.join('')}`)), 45_000)
      const onData = (chunk: Buffer): void => {
        registryLog.push(chunk.toString())
        const match = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/.exec(registryLog.join(''))
        if (match) {
          clearTimeout(timer)
          resolveUrl(match[1])
        }
      }
      registry!.stdout!.on('data', onData)
      registry!.stderr!.on('data', onData)
      registry!.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Registry exited (${code}):\n${registryLog.join('')}`))
      })
    })
    buildPackage()
    publisherToken = createHash('sha256').update(`publisher-${Math.random()}`).digest('hex')
    const res = await fetch(`${registryUrl}/api/publishers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ name: PUBLISHER, public_key: readFileSync(join(work, 'keys', `${PUBLISHER}.pub`), 'utf8'), token: publisherToken }),
    })
    expect(res.status).toBe(201)
    const rootPublicKeyPem = createPublicKey(readFileSync(join(dataDir, 'trust', 'root.pem'), 'utf8'))
      .export({ type: 'spki', format: 'pem' }).toString()
    const approvalFile = join(work, 'registry-root-approval.json')
    writeFileSync(approvalFile, JSON.stringify({
      schemaVersion: 1, registryUrl, rootPublicKeyPem, confirmedFingerprint: registryRootFingerprint(rootPublicKeyPem),
    }))
    vi.stubEnv('AGENT_TEAM_MARKETPLACE_URL', registryUrl)
    vi.stubEnv('AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE', approvalFile)
  }

  async function stopRegistry(): Promise<void> {
    if (!registry || registryPid === undefined) return
    if (registry.exitCode === null && registry.signalCode === null) {
      const exited = new Promise<void>((done) => registry!.once('exit', () => done()))
      // Only the PID this file started.
      process.kill(registryPid)
      await exited
    }
    registry = undefined
  }

  /** The Host's session to the backend, as the Host sees it: its sends are recorded. */
  const backendSession = {
    send: async (type: string, payload: Record<string, unknown>): Promise<unknown> => {
      sent.push({ type, payload: structuredClone(payload) })
      return { ok: true }
    },
  }
  let next = 0
  function lastSent(type: string): Record<string, unknown> {
    const found = [...sent].reverse().find((message) => message.type === type)
    if (!found) throw new Error(`the Host sent no ${type}`)
    return found.payload
  }

  /** Answer one backend → Host message the way the live session does, and return the Host's answer. */
  async function ask(type: 'marketplace.query.request' | 'plugins.agent_action.request', payload: Record<string, unknown>) {
    expectWire(type, payload)
    const host = manager as unknown as Record<string, (client: unknown, payload: unknown) => Promise<void>>
    const before = sent.length
    if (type === 'marketplace.query.request') await host.handleMarketplaceQueryRequest(backendSession, payload)
    else await host.handlePluginAgentActionRequest(backendSession, payload)
    expect(sent.length).toBe(before + 1)
    const answer = sent[sent.length - 1]
    const resultType = type === 'marketplace.query.request' ? 'marketplace.query.result' : 'plugins.agent_action.result'
    expect(answer.type).toBe(resultType)
    expectWire(resultType, answer.payload)
    return answer.payload as Record<string, any>
  }

  const query = (q: Record<string, unknown>) => ask('marketplace.query.request', { request_id: `mq:${++next}`, query: q })
  const action = (verb: 'disable' | 'enable', pluginId: string) => ask('plugins.agent_action.request', {
    request_id: `pa:${++next}`, action: verb, plugin_id: pluginId,
    requester: { paneId: 'p-41', paneName: 'dev', workspace: '/ws', callerKind: 'pane' },
  })

  /** The window's carrying-out of an approved request: the Extensions flows
   *  behind the IPC the renderer calls, and the real finish. */
  async function carryOut(record: PluginRequestRecord) {
    vi.stubGlobal('window', {
      agentTeam: {
        // A window confirmation, minted by the main process from a user click.
        trustConfirm: async (_action: string, _target: string, subject: string) => ({ subject, nonce: `n-${++next}` }),
      },
    })
    const { finish } = usePluginAgentRequests({
      send: async (type: string, payload: Record<string, unknown>) => {
        expectWire(type, payload)
        finishes.push(payload)
        return { ok: true, payload: {} }
      },
    } as never)
    return applyApprovedRequest(record, {
      install: async (namespace, name, version) => {
        // The trust dialog's consent: the user confirms publisher and risk.
        await call('plugins:prepareInstall', { namespace, name, version })
        await call('plugins:commitInstall', { id: `${namespace}.${name}`, publisherConfirmed: true, riskConfirmed: true })
        await call('plugins:restart', { id: `${namespace}.${name}` })
      },
      // W1: an agent's local file request is not part of this Registry run.
      installStaged: async () => {
        throw new Error('no staged file in the Registry run')
      },
      rollback: async (pluginId) => {
        await call('plugins:rollback', { id: pluginId })
      },
      remove: async (pluginId) => {
        await call('plugins:remove', { id: pluginId })
      },
      // As the approval card does: the user's own Disabled switch, off.
      enable: async (pluginId) => {
        await call('plugins:setDisabled', { id: pluginId, disabled: false })
      },
      listInstalled: async () => call('plugins:listInstalled'),
      // As the approval card passes it: the stored record is not needed here.
      finish: async (approvalId, result) => {
        await finish(approvalId, result)
      },
    })
  }

  function approved(kind: PluginRequestRecord['kind'], version: string | null): PluginRequestRecord {
    return {
      approval_id: `ap-${++next}`, kind, status: 'applying',
      target: { id: ID, namespace: PUBLISHER, name: NAME, version, fromVersion: null },
    }
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'navide-b2-e2e-'))
    dataDir = join(work, 'registry-data')
    mkdirSync(dataDir, { mode: 0o700 })
    try {
      await startRegistry()
      await publish()
    } catch (error) {
      await stopRegistry()
      throw error
    }
    root = join(work, 'plugins')
    mkdirSync(root)
    manager = new FrontendPluginManager()
    // As src/main/index.ts wires it: the Host reads the Extensions "Disabled" switch.
    const disabledSwitch = new PluginDisabledStore(root)
    manager.setDisabledPluginResolver((pluginId) => disabledSwitch.has(pluginId))
    handlers.clear()
    registerPluginIpc(manager, root, () => true, undefined, undefined, {
      cleanupPluginStorage: async () => undefined,
      preflightCandidateFrontend: async () => undefined,
      preflightCandidateBackend: async () => undefined,
      onPluginAgentAction: (notice) => notices.push(notice),
    })
    const bound = new Map(handlers)
    call = async (channel, args) => {
      const handler = bound.get(channel)
      if (!handler) throw new Error(`${channel} not registered`)
      return handler(null, args)
    }
    // The registered Host session the backend's requests arrive on.
    const host = manager as unknown as { wsClient: unknown; hostSessionRegistered: boolean }
    host.wsClient = backendSession
    host.hostSessionRegistered = true
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await manager?.closeBackendPlugins()
    await stopRegistry()
    if (work) rmSync(work, { recursive: true, force: true })
  })

  it('(1) marketplace_search: the Host answers from the Registry, in the fixture shape', async () => {
    const answer = await query({ kind: 'search', text: 'B2 Probe', limit: 20 })
    expect(answer.ok).toBe(true)
    expect(answer.result.items.map((item: { id: string }) => item.id)).toContain(ID)
    // Read-only: nothing was installed.
    expect((await call('plugins:listInstalled')).map((pkg: { id: string }) => pkg.id)).not.toContain(ID)
  })

  it('(2) marketplace_detail carries the disclosure card', async () => {
    const answer = await query({ kind: 'detail', id: ID, version: VERSION })
    expect(answer.ok).toBe(true)
    expect(answer.result.versions).toContain(VERSION)
    // The disclosure card (contract 3.4): the disclosure, the scan report and the Registry's facts.
    expect(answer.result.card).toMatchObject({
      manifest: { plugin: { id: ID, version: VERSION }, risk: { level: expect.any(String) } },
      scan: expect.any(Object),
      registry: { signature: { signed: true } },
    })
  })

  it('(3) an approved install request is carried out by the window and reported finished', async () => {
    const result = await carryOut(approved('plugin-install', VERSION))
    expect(result).toEqual({ status: 'completed', error: null })
    const installed = (await call('plugins:listInstalled')) as Array<{ id: string; packageVersion?: string }>
    expect(installed.find((pkg) => pkg.id === ID)?.packageVersion).toBe(VERSION)
    expect(finishes.at(-1)).toMatchObject({ status: 'completed', error: null, confirmation: { subject: expect.stringMatching(/:completed$/) } })
  })

  it('(4) installed: the Host lists the package in the fixture shape', async () => {
    const answer = await query({ kind: 'installed' })
    expect(answer.result.items.map((item: { id: string }) => item.id)).toContain(ID)
  })

  it('(5) plugins_disable acts at once, tells the user who did it, and the undo restores it', async () => {
    const disabled = await action('disable', ID)
    expect(disabled, JSON.stringify(disabled)).toMatchObject({ ok: true, pluginId: ID, pluginVersion: VERSION, disabled: true, changed: true })
    expect(notices.at(-1)).toMatchObject({ action: 'disable', pluginId: ID, requester: { paneName: 'dev' } })
    // The announcement's undo: only while the package is as the agent left it.
    // The agent disabled it, so the undo enables (disable: false).
    const undo = { kind: 'plugin-agent-undo' as const, pluginId: ID, disable: false }
    const before = await call('plugins:listInstalled')
    expect(pluginAgentUndoApplies(undo, before)).toBe(true)
    await call('plugins:setDisabled', { id: ID, disabled: false })
    expect((await call('plugins:listInstalled')).find((pkg: { id: string }) => pkg.id === ID)?.disabled).not.toBe(true)
  })

  it('(6) plugins_enable switches back at once; already enabled is a no-op that tells nobody', async () => {
    await action('disable', ID)
    const told = notices.length
    const enabled = await action('enable', ID)
    expect(enabled).toMatchObject({ ok: true, disabled: false, changed: true })
    expect(notices.length).toBe(told + 1)
    const again = await action('enable', ID)
    expect(again).toMatchObject({ ok: true, changed: false })
    expect(notices.length).toBe(told + 1)
  })

  it('(6a) plugins_enable of a package the user disabled needs the approval card; approved, the window enables it', async () => {
    const isDisabled = async () => (await call('plugins:listInstalled')).find((pkg: { id: string }) => pkg.id === ID)?.disabled === true
    // The user's own Disabled switch.
    await call('plugins:setDisabled', { id: ID, disabled: true })
    expect(await isDisabled()).toBe(true)
    const told = notices.length
    const refused = await action('enable', ID)
    expect(refused).toMatchObject({
      ok: false, error_code: 'APPROVAL_REQUIRED', pluginId: ID, pluginVersion: VERSION,
      disabled: { by: 'user', at: expect.any(Number), agent: null },
    })
    // Not enabled, and nobody is told: nothing changed.
    expect(await isDisabled()).toBe(true)
    expect(notices.length).toBe(told)
    // The backend files a plugin-enable request (backend/tests/test_b2_wire_contract.py);
    // the user approves it on the card, and the window carries it out.
    const result = await carryOut(approved('plugin-enable', VERSION))
    expect(result).toEqual({ status: 'completed', error: null })
    expect(await isDisabled()).toBe(false)
    expect(finishes.at(-1)).toMatchObject({ status: 'completed', error: null, confirmation: { subject: expect.stringMatching(/:completed$/) } })
    // Enabled by the user's approval: an agent may disable it again later, as before.
    expect(await action('disable', ID)).toMatchObject({ ok: true, changed: true })
    await call('plugins:setDisabled', { id: ID, disabled: false })
  })

  it('(7) the bundled Navide plugins cannot be disabled by an agent, and stay as they were', async () => {
    for (const builtin of ['navide.plans', 'navide.git', 'navide.mini-ide']) {
      const answer = await action('disable', builtin)
      expect(answer).toEqual({
        request_id: expect.any(String), ok: false, error_code: 'BUILTIN_PLUGIN',
        error: 'the bundled Navide plugins are disabled and enabled by the user in Extensions',
      })
    }
    expect(await call('plugins:disabledBuiltins')).toEqual([])
  })

  it('(8) an approved remove request removes it, and its activity is forgotten', async () => {
    const result = await carryOut(approved('plugin-remove', null))
    expect(result).toEqual({ status: 'completed', error: null })
    expect((await call('plugins:listInstalled')).map((pkg: { id: string }) => pkg.id)).not.toContain(ID)
    // Sent best effort after the removal, without waiting for it.
    await new Promise((done) => setTimeout(done, 50))
    const forget = lastSent('plugin.activity.forget')
    expectWire('plugin.activity.forget', forget)
    expect(forget).toEqual({ plugin_id: ID })
  })
})
