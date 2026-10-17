import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isMethodName } from './pluginBackendSupervisor'
import { parseManifestV2 as parsePublicManifestV2 } from '../../../packages/plugin-contracts/src/index'

// Guard: backend.methods and backend.events keep main's rule at install, load
// and publish, so an installed package without agent tools loads exactly as
// before (a camelCase name is refused only at activation, as on main).
// backend.agentTools[].method must also be a name the backend supervisor
// accepts (isMethodName). The Registry twin is
// marketplace/registry/tests/test_backend_name_rule.py.

const NAMES = [
  'files.search', 'files.index', 'files.index_progress', 'devmap.block.status', 'search', 'a', 'a1', 'a_b',
  'devmap.setStatus', 'files.indexProgress', 'Files.search', 'files.', '.files', 'files..search', 'files.1x',
  '1files', '_files', 'files-search', 'files.search ', 'files.search\n', 'files/search', 'fïles.search', '',
]

/** main's backend.methods / backend.events rule (origin/main 99c9ea32d), pinned. */
const MAIN_BACKEND_NAME = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

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

describe('backend name rule: main for backend names, the supervisor for agent tool methods', () => {
  for (const path of SCHEMAS) {
    it(`${path}: backendNames keep main's rule; agentTool.method uses the supervisor rule`, () => {
      const schema = JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'))
      expect(schema.$defs.backendNames.items.pattern).toBe(MAIN_BACKEND_NAME.source)
      const regex = new RegExp(schema.$defs.agentTool.properties.method.pattern, 'u')
      for (const name of NAMES) expect(regex.test(name), JSON.stringify(name)).toBe(isMethodName(name))
    })
  }

  it('the public parser keeps main\'s rule for backend.methods', () => {
    for (const name of NAMES) {
      const accepted = (() => {
        try {
          parsePublicManifestV2(manifest([name]))
          return true
        } catch {
          return false
        }
      })()
      expect(accepted, JSON.stringify(name)).toBe(MAIN_BACKEND_NAME.test(name))
    }
  })
})
