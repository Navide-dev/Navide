import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FIRST_PARTY_BACKEND_PLUGINS,
  firstPartyBridgePorts,
  isFirstPartyAgentToolPlugin,
  isFirstPartyBackendPlugin,
} from './pluginFirstPartyBackends'
import {
  firstPartyAgentToolSpec,
  firstPartyBackendLaunchSpec,
  isThirdPartyLaunchSpec,
  thirdPartyBackendLaunchSpec,
} from './pluginThirdPartyBackends'
import type { PluginActivationCatalogEntry } from './installedPlugins'

const BROWSER_TOOLS = [
  {
    name: 'browser_list', method: 'browser.list', risk: 'read', title: 'List spaces',
    description: 'List the browser spaces.', inputSchema: { type: 'object', properties: {} },
  },
]

function manifest(id: string, system: string[]) {
  const name = id.split('.')[1]!
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id,
    name: 'Browser',
    version: '1.0.0',
    publisher: id.split('.')[0],
    permissions: { system },
    marketplace: { description: 'Browse the web.', license: 'MIT' },
    contributes: {
      views: [{ id: 'window', kind: 'custom', location: 'window', title: 'Browser', entry: 'frontend/window/index.html' }],
    },
    backend: {
      entry: `backend/${id.replace('.', '-')}`,
      protocolVersion: 1,
      activation: 'startup',
      methods: ['browser.list'],
      agentTools: BROWSER_TOOLS.map((tool) => ({ ...tool, name: tool.name.replace('browser', name) })),
    },
  }
}

let root = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'first-party-backend-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writePackage(id: string, system: string[] = ['ui', 'web']): PluginActivationCatalogEntry {
  const packageDir = join(root, id, '1.0.0')
  const entry = `backend/${id.replace('.', '-')}`
  mkdirSync(join(packageDir, 'backend'), { recursive: true })
  writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify(manifest(id, system)))
  writeFileSync(join(packageDir, entry), 'binary', { mode: 0o700 })
  return {
    pluginId: id,
    packageVersion: '1.0.0',
    packageDir,
    views: [],
    backend: { entryFile: join(packageDir, entry), protocolVersion: 1, activation: 'startup' },
  }
}

describe('first-party backend list', () => {
  it('is exactly Plans with its current ports and the browser with the web port', () => {
    expect([...FIRST_PARTY_BACKEND_PLUGINS.keys()].sort()).toEqual(['navide.browser', 'navide.plans'])
    expect(firstPartyBridgePorts('navide.plans')).toEqual(['filesystem'])
    expect(firstPartyBridgePorts('navide.browser')).toEqual(['web'])
  })

  it('does not widen to look-alike or other bundled ids', () => {
    for (const id of ['acme.browser', 'navide.browser2', 'navide.git', 'navide.mini-ide', 'browser', '']) {
      expect(isFirstPartyBackendPlugin(id)).toBe(false)
      expect(firstPartyBridgePorts(id)).toBeNull()
      expect(isFirstPartyAgentToolPlugin(id)).toBe(false)
    }
    // Plans keeps its own agent route, never the agent-tool catalog.
    expect(isFirstPartyAgentToolPlugin('navide.plans')).toBe(false)
    expect(isFirstPartyAgentToolPlugin('navide.browser')).toBe(true)
  })
})

describe('firstPartyBackendLaunchSpec', () => {
  it('launches navide.browser outside third-party admission with only the web port and no agent methods', () => {
    const spec = firstPartyBackendLaunchSpec(writePackage('navide.browser'))
    expect(spec).not.toBeNull()
    expect(spec).toMatchObject({
      pluginId: 'navide.browser',
      approvedMethods: ['browser.list'],
      agentMethods: [],
      approvedBridgePorts: ['web'],
    })
    expect(spec).not.toHaveProperty('thirdParty')
    expect(isThirdPartyLaunchSpec(spec!)).toBe(false)
  })

  it('withholds a first-party port the manifest does not declare', () => {
    expect(firstPartyBackendLaunchSpec(writePackage('navide.browser', ['ui']))?.approvedBridgePorts).toEqual([])
  })

  it('refuses every id that is not first-party: acme.browser still goes through the third-party gate', () => {
    const activation = writePackage('acme.browser')
    expect(firstPartyBackendLaunchSpec(activation)).toBeNull()
    expect(firstPartyAgentToolSpec(activation)).toBeNull()
    const thirdParty = thirdPartyBackendLaunchSpec(activation)
    expect(thirdParty).not.toBeNull()
    expect(isThirdPartyLaunchSpec(thirdParty!)).toBe(true)
  })

  it('never projects Plans: it keeps plansBackendActivation', () => {
    expect(firstPartyBackendLaunchSpec(writePackage('navide.plans', ['fs']))).toBeNull()
  })
})

describe('firstPartyAgentToolSpec', () => {
  it('describes the declared agent tools for the catalog only', () => {
    const activation = writePackage('navide.browser')
    const catalog = firstPartyAgentToolSpec(activation)
    expect(catalog).not.toBeNull()
    expect(catalog!.thirdParty.agentTools?.map((tool) => tool.name)).toEqual(['browser_list'])
    expect(catalog!.thirdParty.system).toEqual(['ui', 'web'])
    expect(catalog!.thirdParty.permissions).toMatchObject({ system: ['ui', 'web'] })
    // The catalog entry never grants agent methods by itself.
    expect(catalog!.agentMethods).toEqual([])
    expect(catalog!.approvedBridgePorts).toEqual(['web'])
  })
})
