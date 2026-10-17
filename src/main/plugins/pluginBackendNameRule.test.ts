import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMethodName } from './pluginBackendSupervisor'
import { parseManifestV2 as parsePublicManifestV2 } from '../../../packages/plugin-contracts/src/index'

// Guard: a package-local backend name (backend.methods, backend.events and
// backend.agentTools[].method) is accepted at install and publish exactly
// when the backend supervisor accepts it at activation (isMethodName). The
// Registry twin is marketplace/registry/tests/test_backend_name_rule.py.

const NAMES = [
  'files.search', 'files.index', 'files.index_progress', 'devmap.block.status', 'search', 'a', 'a1', 'a_b',
  'devmap.setStatus', 'files.indexProgress', 'Files.search', 'files.', '.files', 'files..search', 'files.1x',
  '1files', '_files', 'files-search', 'files.search ', 'files.search\n', 'files/search', 'fïles.search', '',
]

const SCHEMAS = [
  'docs/plugin-contracts/plugin-manifest-v2.schema.json',
  'packages/plugin-contracts/src/schemas/plugin-manifest-v2.schema.json',
]

function manifest(methods: string[]) {
  return {
    schemaVersion: 2, apiVersion: '^1.0.0', id: 'acme.files', name: 'Files', version: '1.0.0', publisher: 'acme',
    permissions: {}, marketplace: { description: 'Files.', license: 'MIT' },
    backend: { entry: 'backend/files', protocolVersion: 1, activation: 'startup', methods },
  }
}

describe('backend name rule: install and publish accept exactly what activation accepts', () => {
  for (const path of SCHEMAS) {
    it(`${path}: backendNames and agentTool.method use the supervisor rule`, () => {
      const schema = JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'))
      const patterns = [schema.$defs.backendNames.items.pattern, schema.$defs.agentTool.properties.method.pattern]
      for (const pattern of patterns) {
        const regex = new RegExp(pattern, 'u')
        for (const name of NAMES) expect(regex.test(name), `${pattern} vs ${JSON.stringify(name)}`).toBe(isMethodName(name))
      }
    })
  }

  it('the public parser agrees for backend.methods', () => {
    for (const name of NAMES) {
      const accepted = (() => {
        try {
          parsePublicManifestV2(manifest([name]))
          return true
        } catch {
          return false
        }
      })()
      expect(accepted, JSON.stringify(name)).toBe(isMethodName(name))
    }
  })
})
