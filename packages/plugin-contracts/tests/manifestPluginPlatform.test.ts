import { describe, expect, it } from 'vitest'
import { parseManifestV2 } from '../src/index'

// 0.2.39 batch 3/4: Host events, plugin calls, pipeline nodes, settings and
// command slots. The parser and the Registry (manifest_v2.py) apply the same
// rules; the JSON Schema states the shapes.

function manifest(over: { permissions?: Record<string, unknown>; contributes?: Record<string, unknown>; backend?: Record<string, unknown> } = {}): Record<string, any> {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.watch',
    name: 'Watch',
    version: '1.0.0',
    publisher: 'acme',
    permissions: { system: ['ui', 'agents'], ...over.permissions },
    marketplace: { description: 'A fixture.', license: 'MIT' },
    contributes: {
      views: [{ id: 'main', kind: 'custom', location: 'right', title: 'Watch', entry: 'frontend/main/index.html' }],
      commands: [{ id: 'acme.watch.refresh', title: 'Refresh', run: { view: 'main' } }],
      ...over.contributes,
    },
    backend: { entry: 'backend/watch', protocolVersion: 1, activation: 'startup', methods: ['watch.lookup', 'watch.fetch'], ...over.backend },
  }
}

function refusal(raw: unknown): string {
  try {
    parseManifestV2(raw)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the manifest to be refused')
}

describe('permissions.agents and permissions.plugins', () => {
  it('keeps declared events and plugins', () => {
    const parsed = parseManifestV2(manifest({ permissions: { agents: { events: ['agents.turnEnded'] }, plugins: ['acme.tools'] } }))
    expect(parsed.permissions.agents).toEqual({ events: ['agents.turnEnded'] })
    expect(parsed.permissions.plugins).toEqual(['acme.tools'])
  })

  it('needs agents in system, known events and valid ids', () => {
    expect(refusal(manifest({ permissions: { system: ['ui'], agents: { events: ['agents.turnEnded'] } } }))).toMatch(/without agents/)
    expect(refusal(manifest({ permissions: { agents: { events: ['agents.nope'] } } }))).toMatch(/unknown event/)
    expect(refusal(manifest({ permissions: { plugins: ['Not An Id'] } }))).toMatch(/invalid plugin id/)
  })
})

describe('contributes.api and pipelineNodes', () => {
  it('accepts methods the backend declares', () => {
    const parsed = parseManifestV2(manifest({ contributes: {
      api: [{ method: 'watch.lookup', description: 'Look a thing up' }],
      pipelineNodes: [{ id: 'fetch', title: 'Fetch', method: 'watch.fetch', timeoutMs: 5000, n8nTypes: ['n8n-nodes-base.httpRequest'] }],
    } }))
    expect(parsed.contributes?.api).toEqual([{ method: 'watch.lookup', description: 'Look a thing up' }])
    expect(parsed.contributes?.pipelineNodes?.[0]).toMatchObject({ id: 'fetch', method: 'watch.fetch', n8nTypes: ['n8n-nodes-base.httpRequest'] })
  })

  it('refuses a method the backend does not declare, duplicates and a bad timeout', () => {
    expect(refusal(manifest({ contributes: { api: [{ method: 'watch.other', description: 'x' }] } }))).toMatch(/not listed in backend.methods/)
    expect(refusal(manifest({ contributes: { pipelineNodes: [
      { id: 'a', title: 'A', method: 'watch.fetch' }, { id: 'a', title: 'B', method: 'watch.lookup' },
    ] } }))).toMatch(/listed twice/)
    expect(refusal(manifest({ contributes: { pipelineNodes: [{ id: 'a', title: 'A', method: 'watch.fetch', timeoutMs: 10 }] } }))).toMatch(/timeoutMs/)
  })
})

describe('contributes.settings', () => {
  it('accepts each type with a fitting default', () => {
    const parsed = parseManifestV2(manifest({ contributes: { settings: [
      { key: 'enabled', title: 'Enabled', type: 'boolean', default: true },
      { key: 'limits.max', title: 'Max', type: 'number', default: 5, minimum: 1, maximum: 10 },
      { key: 'label', title: 'Label', type: 'string', default: 'x', maxLength: 20 },
      { key: 'mode', title: 'Mode', type: 'enum', default: 'fast', options: ['fast', 'slow'] },
    ] } }))
    expect(parsed.contributes?.settings?.map((setting) => setting.key)).toEqual(['enabled', 'limits.max', 'label', 'mode'])
  })

  it('refuses a default its type or bounds do not allow, and misplaced fields', () => {
    expect(refusal(manifest({ contributes: { settings: [{ key: 'n', title: 'N', type: 'number', default: 20, maximum: 10 }] } }))).toMatch(/within its bounds/)
    expect(refusal(manifest({ contributes: { settings: [{ key: 'm', title: 'M', type: 'enum', default: 'x', options: ['a'] }] } }))).toMatch(/one of its options/)
    expect(refusal(manifest({ contributes: { settings: [{ key: 'b', title: 'B', type: 'boolean', default: true, options: ['a'] }] } }))).toMatch(/only for type enum/)
    expect(refusal(manifest({ contributes: { settings: [{ key: 'Bad Key', title: 'B', type: 'boolean', default: true }] } }))).toMatch(/key/)
  })
})

describe('command slots', () => {
  it('place this package\'s own commands', () => {
    const parsed = parseManifestV2(manifest({ contributes: {
      statusBar: [{ command: 'acme.watch.refresh', text: 'Watch', tooltip: 'Refresh the watch' }],
      paneActions: [{ command: 'acme.watch.refresh', title: 'Watch this pane' }],
      explorerMenu: [{ command: 'acme.watch.refresh', title: 'Watch this file', when: 'file' }],
    } }))
    expect(parsed.contributes?.statusBar).toEqual([{ command: 'acme.watch.refresh', text: 'Watch', tooltip: 'Refresh the watch' }])
    expect(parsed.contributes?.explorerMenu?.[0].when).toBe('file')
  })

  it('refuse another package\'s command and unsafe text', () => {
    expect(refusal(manifest({ contributes: { statusBar: [{ command: 'acme.other.run', text: 'X' }] } }))).toMatch(/contributes.commands/)
    expect(refusal(manifest({ contributes: { paneActions: [{ command: 'acme.watch.refresh', title: 'Safe‮evil' }] } }))).toMatch(/bidirectional/)
    expect(refusal(manifest({ contributes: { explorerMenu: [{ command: 'acme.watch.refresh', title: 'X', when: 'always' }] } }))).toMatch(/when/)
  })
})
