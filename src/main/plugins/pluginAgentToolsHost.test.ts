import { describe, expect, it, vi } from 'vitest'
import type { AgentToolCaller, AgentToolsSyncPayload } from '../../shared/pluginAgentTools'
import type { DisclosureAgentTool } from '../../shared/pluginDisclosure'
import { agentToolUnavailableMessage, PluginAgentToolsHost, type PluginAgentToolsHostOptions } from './pluginAgentToolsHost'
import type { AgentToolSwitches } from './pluginNativeBackendStore'
import type { ThirdPartyLaunchSpec } from './pluginThirdPartyBackends'

const PANE: AgentToolCaller = { kind: 'pane', paneId: 'p-1', workspace: '/ws' }
const EXTERNAL: AgentToolCaller = { kind: 'external', paneId: null, workspace: null }
const HOST: AgentToolCaller = { kind: 'host', paneId: null, workspace: null }

function tool(name: string, method: string, risk: 'read' | 'write' = 'read'): DisclosureAgentTool {
  return {
    name, method, risk, title: name, description: `${name} tool`, timeoutMs: 30_000,
    inputSchema: { type: 'object', properties: {} },
  }
}

function spec(pluginId: string, version = '1.0.0', tools: DisclosureAgentTool[] = []): ThirdPartyLaunchSpec {
  return {
    pluginId,
    packageVersion: version,
    packageDir: `/pkgs/${pluginId}/${version}`,
    entryFile: `/pkgs/${pluginId}/${version}/backend/bin`,
    protocolVersion: 1,
    activation: 'startup',
    approvedMethods: [...new Set(tools.map((entry) => entry.method)), 'other.method'],
    agentMethods: [],
    approvedEvents: [],
    approvedBridgePorts: ['filesystem'],
    thirdParty: {
      name: pluginId,
      system: ['fs'],
      ...(tools.length > 0
        ? { agentTools: tools, permissions: { system: ['fs'], shell: null, scopes: null } }
        : {}),
    },
  }
}

const DEVMAP = spec('nerdtechnic.devmap', '0.2.0', [
  tool('devmap_read', 'devmap.read'),
  tool('devmap_set_status', 'devmap.setStatus', 'write'),
])

interface Harness {
  host: PluginAgentToolsHost
  switches: AgentToolSwitches
  packages: ThirdPartyLaunchSpec[]
  disabled: Set<string>
  consented: Set<string>
  /** B1-a's agentToolsSince per package. */
  since: Map<string, string>
  /** B1-a's agentToolNamesSince, keyed `<pluginId>\u0000<name>`. */
  nameSince: Map<string, string>
  sent: AgentToolsSyncPayload[]
  methods: Map<string, string[]>
  setAgentMethods: ReturnType<typeof vi.fn>
  sessionUp: { value: boolean }
}

function harness(overrides: Partial<PluginAgentToolsHostOptions> = {}, initial: Partial<AgentToolSwitches> = {}): Harness {
  const state: Omit<Harness, 'host' | 'setAgentMethods'> = {
    switches: { enabled: false, externalCallers: false, ...initial },
    packages: [DEVMAP],
    disabled: new Set(),
    consented: new Set(['nerdtechnic.devmap']),
    since: new Map([['nerdtechnic.devmap', '2026-10-01T00:00:00.000Z']]),
    nameSince: new Map(),
    sent: [],
    methods: new Map(),
    sessionUp: { value: true },
  }
  const setAgentMethods = vi.fn((pluginId: string, version: string, methods: string[]) => {
    state.methods.set(`${pluginId}@${version}`, methods)
  })
  const host = new PluginAgentToolsHost({
    switches: () => ({ ...state.switches }),
    setSwitches: (change) => {
      state.switches = { ...state.switches, ...change }
    },
    listPackages: () => state.packages,
    isDisabled: (pluginId) => state.disabled.has(pluginId),
    hasConsent: async (candidate) => state.consented.has(candidate.pluginId),
    agentToolSince: (pluginId, name) => state.nameSince.get(`${pluginId}\u0000${name}`) ?? state.since.get(pluginId) ?? null,
    setAgentMethods,
    confirmWrite: async () => true,
    send: async (payload) => {
      if (!state.sessionUp.value) return 'no-session'
      state.sent.push(structuredClone(payload))
      return 'delivered'
    },
    ...overrides,
  })
  return { ...state, host, setAgentMethods, get switches() { return state.switches }, get packages() { return state.packages }, set packages(value) { state.packages = value } } as Harness
}

const notStopping = (): boolean => false

describe('PluginAgentToolsHost with the master switch off (golden: same as main)', () => {
  it('sends nothing and keeps every third-party agentMethods empty on every lifecycle refresh', async () => {
    const h = harness()
    await h.host.onBackendConnected()
    await h.host.refresh()
    h.disabled.add('nerdtechnic.devmap')
    await h.host.refresh()
    h.host.mark('nerdtechnic.devmap', 'quarantined')
    await h.host.refresh()
    expect(h.sent).toEqual([])
    expect([...h.methods.values()].every((methods) => methods.length === 0)).toBe(true)
    expect(h.host.snapshot()).toEqual([])
  })

  it('refuses every call with master-switch-off before looking at anything else', async () => {
    const hasConsent = vi.fn(async () => true)
    const h = harness({ hasConsent })
    await expect(h.host.admit({
      pluginId: 'nerdtechnic.devmap', toolName: 'devmap_read', pluginVersion: '0.2.0', caller: PANE,
    }, notStopping)).resolves.toEqual({ ok: false, reason: 'master-switch-off' })
    expect(hasConsent).not.toHaveBeenCalled()
  })
})

describe('PluginAgentToolsHost catalog', () => {
  it('pushes the contract snapshot and opens only the consented tool methods when the switch turns on', async () => {
    const h = harness()
    await h.host.setSwitches({ enabled: true })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ revision: 1, enabled: true, externalCallers: false })
    expect(h.sent[0].tools.map((entry) => [entry.name, entry.state, entry.pluginVersion, entry.method])).toEqual([
      ['devmap_read', 'available', '0.2.0', 'devmap.read'],
      ['devmap_set_status', 'available', '0.2.0', 'devmap.setStatus'],
    ])
    expect(h.sent[0].tools[0].permissions).toEqual({ system: ['fs'], shell: null, scopes: null })
    expect(h.methods.get('nerdtechnic.devmap@0.2.0')).toEqual(['devmap.read', 'devmap.setStatus'])
  })

  it('sends exactly one empty snapshot when the switch is turned off, then nothing', async () => {
    const h = harness({}, { enabled: true })
    await h.host.refresh()
    await h.host.setSwitches({ enabled: false })
    await h.host.refresh()
    expect(h.sent.map((payload) => [payload.revision, payload.enabled, payload.tools.length])).toEqual([
      [1, true, 2],
      [2, false, 0],
    ])
    expect(h.methods.get('nerdtechnic.devmap@0.2.0')).toEqual([])
  })

  it('keeps revisions strictly increasing and starts over after a reconnect', async () => {
    const h = harness({}, { enabled: true })
    await h.host.refresh()
    await h.host.refresh()
    await h.host.onBackendConnected()
    expect(h.sent.map((payload) => payload.revision)).toEqual([1, 2, 3])
  })

  it('names each non-callable state and closes its methods', async () => {
    const h = harness({}, { enabled: true })
    h.consented.clear()
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['consent-required', 'consent-required'])
    expect(h.methods.get('nerdtechnic.devmap@0.2.0')).toEqual([])

    h.consented.add('nerdtechnic.devmap')
    h.disabled.add('nerdtechnic.devmap')
    h.packages = []
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['plugin-disabled', 'plugin-disabled'])

    h.disabled.clear()
    h.packages = [DEVMAP]
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['available', 'available'])

    // A trust refresh quarantines it: the package leaves the catalog first, then is marked.
    h.packages = []
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools).toEqual([])
    h.host.mark('nerdtechnic.devmap', 'quarantined')
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['plugin-quarantined', 'plugin-quarantined'])

    h.packages = [DEVMAP]
    await h.host.refresh()
    h.host.mark('nerdtechnic.devmap', 'revoked')
    h.packages = []
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['plugin-revoked', 'plugin-revoked'])
  })

  it('drops a removed package from the catalog entirely', async () => {
    const h = harness({}, { enabled: true })
    await h.host.refresh()
    h.packages = []
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools).toEqual([])
  })

  it('serves a contested name from the package the user allowed first (DB1)', async () => {
    const other = spec('acme.devmap', '1.0.0', [tool('devmap_read', 'map.read')])
    const h = harness({}, { enabled: true })
    h.packages = [DEVMAP, other]
    h.consented.add('acme.devmap')
    h.since.set('acme.devmap', '2026-10-05T00:00:00.000Z')
    await h.host.refresh()
    const states = Object.fromEntries(h.sent.at(-1)!.tools.map((entry) => [`${entry.pluginId}:${entry.name}`, entry.state]))
    expect(states).toEqual({
      'acme.devmap:devmap_read': 'name-collision',
      'nerdtechnic.devmap:devmap_read': 'available',
      'nerdtechnic.devmap:devmap_set_status': 'available',
    })
    expect(h.methods.get('acme.devmap@1.0.0')).toEqual([])
    await expect(h.host.admit({
      pluginId: 'acme.devmap', toolName: 'devmap_read', pluginVersion: '1.0.0', caller: PANE,
    }, notStopping)).resolves.toEqual({ ok: false, reason: 'name-collision' })
  })

  it('ranks a name an update added from that update, not from the package\'s first consent (DB1, per name)', async () => {
    const other = spec('acme.devmap', '1.1.0', [tool('acme_read', 'map.list'), tool('devmap_read', 'map.read')])
    const h = harness({}, { enabled: true })
    h.packages = [DEVMAP, other]
    h.consented.add('acme.devmap')
    // acme first declared tools before devmap did, but added devmap_read later.
    h.since.set('acme.devmap', '2026-09-01T00:00:00.000Z')
    h.nameSince.set('acme.devmap\u0000acme_read', '2026-09-01T00:00:00.000Z')
    h.nameSince.set('acme.devmap\u0000devmap_read', '2026-10-05T00:00:00.000Z')
    await h.host.refresh()
    const states = Object.fromEntries(h.sent.at(-1)!.tools.map((entry) => [`${entry.pluginId}:${entry.name}`, entry.state]))
    expect(states).toEqual({
      'acme.devmap:acme_read': 'available',
      'acme.devmap:devmap_read': 'name-collision',
      'nerdtechnic.devmap:devmap_read': 'available',
      'nerdtechnic.devmap:devmap_set_status': 'available',
    })
  })

  it('leaves packages without agent tools out of the catalog but keeps their agentMethods empty', async () => {
    const plain = spec('acme.indexer')
    const h = harness({}, { enabled: true })
    h.packages = [plain]
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools).toEqual([])
    expect(h.methods.get('acme.indexer@1.0.0')).toEqual([])
  })

  it('re-sends from scratch once a Host session exists', async () => {
    const h = harness({}, { enabled: true })
    h.sessionUp.value = false
    await h.host.refresh()
    expect(h.sent).toEqual([])
    h.sessionUp.value = true
    await h.host.onBackendConnected()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].enabled).toBe(true)
  })
})

describe('PluginAgentToolsHost per-call checks (contract 4.2 order)', () => {
  const call = (overrides: Partial<{ pluginId: string; toolName: string; pluginVersion: string; caller: AgentToolCaller }> = {}) => ({
    pluginId: 'nerdtechnic.devmap', toolName: 'devmap_set_status', pluginVersion: '0.2.0', caller: PANE, ...overrides,
  })

  it('admits a consented tool of an enabled package for a pane caller', async () => {
    const h = harness({}, { enabled: true })
    await h.host.refresh()
    const admission = await h.host.admit(call(), notStopping)
    expect(admission).toMatchObject({ ok: true, tool: { name: 'devmap_set_status', method: 'devmap.setStatus' } })
  })

  it('gates external and host callers behind the DB4 switch', async () => {
    const h = harness({}, { enabled: true })
    await expect(h.host.admit(call({ caller: EXTERNAL }), notStopping)).resolves.toEqual({ ok: false, reason: 'external-callers-off' })
    await expect(h.host.admit(call({ caller: HOST }), notStopping)).resolves.toEqual({ ok: false, reason: 'external-callers-off' })
    await h.host.setSwitches({ externalCallers: true })
    await expect(h.host.admit(call({ caller: EXTERNAL }), notStopping)).resolves.toMatchObject({ ok: true })
    await expect(h.host.admit(call({ caller: HOST }), notStopping)).resolves.toMatchObject({ ok: true })
  })

  it('names the package state that refuses a call', async () => {
    const h = harness({}, { enabled: true })
    await expect(h.host.admit(call({ pluginId: 'acme.missing' }), notStopping))
      .resolves.toEqual({ ok: false, reason: 'plugin-not-installed' })
    h.disabled.add('nerdtechnic.devmap')
    await expect(h.host.admit(call(), notStopping)).resolves.toEqual({ ok: false, reason: 'plugin-disabled' })
    h.disabled.clear()
    await expect(h.host.admit(call(), () => true)).resolves.toEqual({ ok: false, reason: 'plugin-stopping' })
    h.consented.clear()
    await expect(h.host.admit(call(), notStopping)).resolves.toEqual({ ok: false, reason: 'consent-required' })
    h.consented.add('nerdtechnic.devmap')
    await expect(h.host.admit(call({ toolName: 'devmap_delete_all' }), notStopping))
      .resolves.toEqual({ ok: false, reason: 'tool-not-consented' })
    // A cached catalog naming an older version does not reach the new one.
    await expect(h.host.admit(call({ pluginVersion: '0.1.0' }), notStopping))
      .resolves.toEqual({ ok: false, reason: 'tool-not-consented' })
    h.host.mark('nerdtechnic.devmap', 'quarantined')
    await expect(h.host.admit(call(), notStopping)).resolves.toEqual({ ok: false, reason: 'plugin-quarantined' })
  })

  // Races: the consent check waits on hashing the package. Whatever lands in
  // that window wins over the earlier "yes".
  const racing = (change: (h: Harness) => void) => {
    let h!: Harness
    h = harness({
      hasConsent: async () => {
        change(h)
        return true
      },
    }, { enabled: true })
    return h
  }

  it('refuses a call when the package is disabled while its consent is checked', async () => {
    const h = racing((self) => self.disabled.add('nerdtechnic.devmap'))
    await expect(h.host.admit(call(), notStopping)).resolves.toEqual({ ok: false, reason: 'plugin-disabled' })
  })

  it('refuses a call when the package is quarantined while its consent is checked', async () => {
    const h = racing((self) => self.host.mark('nerdtechnic.devmap', 'quarantined'))
    await expect(h.host.admit(call(), notStopping)).resolves.toEqual({ ok: false, reason: 'plugin-quarantined' })
  })

  it('refuses a call when the package is removed while its consent is checked', async () => {
    const h = racing((self) => {
      self.packages = []
    })
    await expect(h.host.admit(call(), notStopping)).resolves.toEqual({ ok: false, reason: 'plugin-not-installed' })
  })

  it('refuses a call when the package is updated while its consent is checked', async () => {
    const h = racing((self) => {
      self.packages = [spec('nerdtechnic.devmap', '0.3.0', [tool('devmap_set_status', 'devmap.setStatus', 'write')])]
    })
    await expect(h.host.admit(call(), notStopping)).resolves.toEqual({ ok: false, reason: 'consent-required' })
  })

  it('refuses a call when the master switch is turned off while its consent is checked', async () => {
    const h = racing((self) => {
      self.switches.enabled = false
    })
    await expect(h.host.admit(call(), notStopping)).resolves.toEqual({ ok: false, reason: 'master-switch-off' })
  })

  it('recheck catches a disable that lands after admission', async () => {
    const h = harness({}, { enabled: true })
    const admission = await h.host.admit(call(), notStopping)
    expect(admission.ok).toBe(true)
    h.disabled.add('nerdtechnic.devmap')
    expect(h.host.recheck('nerdtechnic.devmap', PANE, notStopping, DEVMAP)).toEqual({ ok: false, reason: 'plugin-disabled' })
  })
})

describe('PluginAgentToolsHost review fixes', () => {
  const call = { pluginId: 'nerdtechnic.devmap', toolName: 'devmap_set_status', pluginVersion: '0.2.0', caller: PANE }

  it('keeps a revocation while the package is still listed during the drain (production order)', async () => {
    const h = harness({}, { enabled: true })
    await h.host.refresh()
    // index.ts marks first and refreshes while the activation is still listed.
    h.host.mark('nerdtechnic.devmap', 'revoked')
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['plugin-revoked', 'plugin-revoked'])
    expect(h.methods.get('nerdtechnic.devmap@0.2.0')).toEqual([])
    await expect(h.host.admit(call, notStopping)).resolves.toEqual({ ok: false, reason: 'plugin-revoked' })
    // The drain or the removal failed: it stays listed, and stays revoked.
    await h.host.refresh()
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.every((entry) => entry.state === 'plugin-revoked')).toBe(true)
    await expect(h.host.admit(call, notStopping)).resolves.toEqual({ ok: false, reason: 'plugin-revoked' })
  })

  it('never attaches a mark made with no known package to a later install', async () => {
    const h = harness({}, { enabled: true })
    h.packages = []
    h.host.mark('nerdtechnic.devmap', 'revoked')
    h.packages = [DEVMAP]
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['available', 'available'])
  })

  it('ends a mark only for another version or directory, or a trust re-verification', async () => {
    const h = harness({}, { enabled: true })
    h.host.mark('nerdtechnic.devmap', 'quarantined')
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools[0].state).toBe('plugin-quarantined')
    h.packages = [spec('nerdtechnic.devmap', '0.2.1', [tool('devmap_read', 'devmap.read')])]
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => [entry.pluginVersion, entry.state])).toEqual([['0.2.1', 'available']])
    h.host.mark('nerdtechnic.devmap', 'revoked')
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools[0].state).toBe('plugin-revoked')
    h.host.clearMark('nerdtechnic.devmap')
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools[0].state).toBe('available')
  })

  it('retries a failed push a bounded number of times, and never an outdated one', async () => {
    let failures = 5
    const attempts: number[] = []
    const h = harness({
      retryDelaysMs: [0, 0],
      send: async (payload) => {
        attempts.push(payload.revision)
        return failures-- > 0 ? 'failed' : 'delivered'
      },
    }, { enabled: true })
    await h.host.refresh()
    // Wait on the retries themselves, not a fixed delay (flaky under load);
    // the settle after it only gives an extra retry the chance to show.
    const settle = () => new Promise((done) => setTimeout(done, 20))
    await vi.waitFor(() => expect(attempts).toEqual([1, 1, 1]))
    await settle()
    expect(attempts).toEqual([1, 1, 1])
    attempts.length = 0
    failures = 1
    await h.host.refresh()
    await h.host.refresh()
    await vi.waitFor(() => expect(attempts).toEqual([2, 3]))
    await settle()
    // Revision 2 failed once, but 3 superseded it: 2 is not retried.
    expect(attempts).toEqual([2, 3])
  })

  it('treats a consent that never covered the tool list as no consent', async () => {
    const h = harness({ hasConsent: async () => false }, { enabled: true })
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['consent-required', 'consent-required'])
    expect(h.methods.get('nerdtechnic.devmap@0.2.0')).toEqual([])
    await expect(h.host.admit(call, notStopping)).resolves.toEqual({ ok: false, reason: 'consent-required' })
  })
})

describe('PluginAgentToolsHost first-party agent tools (navide.browser)', () => {
  function firstParty(pluginId = 'navide.browser', tools = [tool('browser_list', 'browser.list'), tool('browser_act', 'browser.act', 'write')]): ThirdPartyLaunchSpec {
    const base = spec(pluginId, '1.0.0', tools)
    return {
      ...base,
      approvedBridgePorts: ['web'],
      thirdParty: { ...base.thirdParty, system: ['ui', 'web'], permissions: { system: ['ui', 'web'], shell: null, scopes: null } },
    }
  }
  const BROWSER = firstParty()
  const browserCall = { pluginId: 'navide.browser', toolName: 'browser_list', pluginVersion: '1.0.0', caller: PANE }
  const call = { pluginId: 'nerdtechnic.devmap', toolName: 'devmap_read', pluginVersion: '0.2.0', caller: PANE }

  function withBrowser(overrides: Partial<PluginAgentToolsHostOptions> = {}, initial: Partial<AgentToolSwitches> = {}) {
    const firstPartyPackages = { value: [BROWSER] }
    const h = harness({ listFirstPartyPackages: () => firstPartyPackages.value, ...overrides }, initial)
    return { ...h, firstPartyPackages, h }
  }

  it('serves first-party tools with the master switch off, and only them (DB8 covers third-party packages)', async () => {
    const { h } = withBrowser()
    await h.host.refresh()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ enabled: true, externalCallers: false })
    expect(h.sent[0].tools.map((entry) => [entry.pluginId, entry.name, entry.state])).toEqual([
      ['navide.browser', 'browser_list', 'available'],
      ['navide.browser', 'browser_act', 'available'],
    ])
    expect(h.methods.get('navide.browser@1.0.0')).toEqual(['browser.act', 'browser.list'])
    expect(h.methods.get('nerdtechnic.devmap@0.2.0')).toEqual([])
    await expect(h.host.admit(browserCall, notStopping)).resolves.toMatchObject({ ok: true, tool: { name: 'browser_list' } })
    await expect(h.host.admit(call, notStopping)).resolves.toEqual({ ok: false, reason: 'master-switch-off' })
    // The switch covers third-party tools only, and the agent is told so.
    expect(agentToolUnavailableMessage('master-switch-off')).toBe('Agent tools from this kind of Navide plugin (first-party or third-party) are turned off in Settings.')
  })

  it('serves no first-party tool with the first-party switch off, whatever the master switch says', async () => {
    const { h } = withBrowser({}, { firstParty: false })
    await h.host.refresh()
    expect(h.sent).toEqual([])
    expect(h.methods.get('navide.browser@1.0.0') ?? []).toEqual([])
    await expect(h.host.admit(browserCall, notStopping)).resolves.toEqual({ ok: false, reason: 'master-switch-off' })
    await h.host.setSwitches({ enabled: true })
    expect(h.sent.at(-1)!.tools.map((entry) => entry.pluginId)).toEqual(['nerdtechnic.devmap', 'nerdtechnic.devmap'])
    expect(h.methods.get('navide.browser@1.0.0')).toEqual([])
    await expect(h.host.admit(browserCall, notStopping)).resolves.toEqual({ ok: false, reason: 'master-switch-off' })
    await expect(h.host.admit(call, notStopping)).resolves.toMatchObject({ ok: true })
  })

  it('sends one disabled snapshot when the first-party switch goes off and nothing else is served', async () => {
    const { h } = withBrowser({ listPackages: () => [] })
    await h.host.refresh()
    await h.host.setSwitches({ firstParty: false })
    expect(h.sent.map((payload) => [payload.enabled, payload.tools.length])).toEqual([[true, 2], [false, 0]])
    expect(h.methods.get('navide.browser@1.0.0')).toEqual([])
    await h.host.setSwitches({ firstParty: true })
    expect(h.sent.at(-1)).toMatchObject({ enabled: true })
    expect(h.methods.get('navide.browser@1.0.0')).toEqual(['browser.act', 'browser.list'])
  })

  it('still refuses first-party calls without a pane while the master switch is off', async () => {
    const { h } = withBrowser()
    await h.host.refresh()
    await expect(h.host.admit({ ...browserCall, caller: EXTERNAL }, notStopping))
      .resolves.toEqual({ ok: false, reason: 'external-callers-off' })
    await expect(h.host.admit({ ...browserCall, caller: HOST }, notStopping))
      .resolves.toEqual({ ok: false, reason: 'external-callers-off' })
  })

  it('serves first-party tools with the master switch on and no consent', async () => {
    const hasConsent = vi.fn(async (candidate: ThirdPartyLaunchSpec) => candidate.pluginId === 'nerdtechnic.devmap')
    const { h } = withBrowser({ hasConsent }, { enabled: true })
    await h.host.refresh()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ enabled: true, externalCallers: false })
    expect(h.sent[0].tools.filter((entry) => entry.pluginId === 'navide.browser').map((entry) => [entry.pluginId, entry.name, entry.state])).toEqual([
      ['navide.browser', 'browser_list', 'available'],
      ['navide.browser', 'browser_act', 'available'],
    ])
    expect(h.sent[0].tools[0].permissions).toEqual({ system: ['ui', 'web'], shell: null, scopes: null })
    expect(h.methods.get('navide.browser@1.0.0')).toEqual(['browser.act', 'browser.list'])
    expect(hasConsent.mock.calls.some(([candidate]) => candidate.pluginId === 'navide.browser')).toBe(false)
    await expect(h.host.admit(browserCall, notStopping)).resolves.toMatchObject({ ok: true, tool: { name: 'browser_list' } })
    expect(hasConsent.mock.calls.some(([candidate]) => candidate.pluginId === 'navide.browser')).toBe(false)
  })

  it('still requires the master switch and consent for every third-party tool', async () => {
    const { h } = withBrowser()
    await expect(h.host.admit(call, notStopping)).resolves.toEqual({ ok: false, reason: 'master-switch-off' })
    await h.host.setSwitches({ enabled: true })
    h.consented.clear()
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.filter((entry) => entry.pluginId === 'nerdtechnic.devmap').map((entry) => entry.state))
      .toEqual(['consent-required', 'consent-required'])
    await expect(h.host.admit(call, notStopping)).resolves.toEqual({ ok: false, reason: 'consent-required' })
    await expect(h.host.admit(browserCall, notStopping)).resolves.toMatchObject({ ok: true })
  })

  it('never exempts a package by its id alone: navide.browser listed as third-party, or acme.browser listed as first-party', async () => {
    const impostor = { ...firstParty('acme.browser'), packageDir: '/pkgs/acme.browser/1.0.0' }
    const { h, firstPartyPackages } = withBrowser({ listPackages: () => [DEVMAP, BROWSER] })
    firstPartyPackages.value = [impostor]
    await h.host.refresh()
    expect(h.sent).toEqual([])
    await expect(h.host.admit(browserCall, notStopping)).resolves.toEqual({ ok: false, reason: 'master-switch-off' })
    await expect(h.host.admit({ ...browserCall, pluginId: 'acme.browser' }, notStopping))
      .resolves.toEqual({ ok: false, reason: 'master-switch-off' })
  })

  it('keeps the disabled switch, quarantine and revocation for first-party tools', async () => {
    const { h } = withBrowser({ listPackages: () => [] }, { enabled: true })
    h.disabled.add('navide.browser')
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['plugin-disabled', 'plugin-disabled'])
    expect(h.methods.get('navide.browser@1.0.0')).toEqual([])
    await expect(h.host.admit(browserCall, notStopping)).resolves.toEqual({ ok: false, reason: 'plugin-disabled' })
    h.disabled.clear()
    h.host.mark('navide.browser', 'quarantined')
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.state)).toEqual(['plugin-quarantined', 'plugin-quarantined'])
    await expect(h.host.admit(browserCall, notStopping)).resolves.toEqual({ ok: false, reason: 'plugin-quarantined' })
  })

  it('refuses callers without a pane unless both switches are on', async () => {
    const { h } = withBrowser({}, { enabled: true })
    await h.host.refresh()
    expect(h.sent.at(-1)).toMatchObject({ enabled: true, externalCallers: false })
    await expect(h.host.admit({ ...browserCall, caller: EXTERNAL }, notStopping))
      .resolves.toEqual({ ok: false, reason: 'external-callers-off' })
    await expect(h.host.admit({ ...browserCall, caller: HOST }, notStopping))
      .resolves.toEqual({ ok: false, reason: 'external-callers-off' })
    await h.host.setSwitches({ externalCallers: true })
    expect(h.sent.at(-1)).toMatchObject({ enabled: true, externalCallers: true })
    await expect(h.host.admit({ ...browserCall, caller: EXTERNAL }, notStopping)).resolves.toMatchObject({ ok: true })
  })

  it('keeps a first-party name against a third-party package that derives the same prefix', async () => {
    const lookalike = spec('acme.browser', '2.0.0', [tool('browser_list', 'browser.list')])
    const { h } = withBrowser({ listPackages: () => [lookalike] }, { enabled: true })
    h.consented.add('acme.browser')
    h.since.set('acme.browser', '2020-01-01T00:00:00.000Z')
    await h.host.refresh()
    const states = h.sent.at(-1)!.tools.map((entry) => [entry.pluginId, entry.name, entry.state])
    expect(states).toContainEqual(['acme.browser', 'browser_list', 'name-collision'])
    expect(states).toContainEqual(['navide.browser', 'browser_list', 'available'])
    expect(h.methods.get('acme.browser@2.0.0')).toEqual([])
    await expect(h.host.admit({ ...browserCall, pluginId: 'acme.browser', pluginVersion: '2.0.0' }, notStopping))
      .resolves.toEqual({ ok: false, reason: 'name-collision' })
  })

  it('drops only the third-party tools when the master switch goes off while both are served', async () => {
    const { h } = withBrowser({}, { enabled: true })
    await h.host.refresh()
    expect(h.sent.at(-1)!.tools.map((entry) => entry.pluginId)).toEqual([
      'navide.browser', 'navide.browser', 'nerdtechnic.devmap', 'nerdtechnic.devmap',
    ])
    await h.host.setSwitches({ enabled: false })
    expect(h.sent.at(-1)).toMatchObject({ enabled: true, externalCallers: false })
    expect(h.sent.at(-1)!.tools.map((entry) => entry.pluginId)).toEqual(['navide.browser', 'navide.browser'])
    expect(h.methods.get('navide.browser@1.0.0')).toEqual(['browser.act', 'browser.list'])
    expect(h.methods.get('nerdtechnic.devmap@0.2.0')).toEqual([])
  })

  it('sends one disabled snapshot when the first-party package leaves while the master switch is off', async () => {
    const { h, firstPartyPackages } = withBrowser({ listPackages: () => [] })
    await h.host.refresh()
    firstPartyPackages.value = []
    await h.host.refresh()
    await h.host.refresh()
    expect(h.sent.map((payload) => [payload.enabled, payload.tools.length])).toEqual([[true, 2], [false, 0]])
    expect(h.host.snapshot()).toEqual([])
  })
})
