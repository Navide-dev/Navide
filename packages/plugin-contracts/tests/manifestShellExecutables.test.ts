import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_SHELL_EXECUTABLES, SHELL_ANY_PROGRAM_EXECUTABLES, V2_SHELL_EXECUTABLE, parseManifestV2 } from '../src/index'
import { SHELL_ANY_PROGRAM_EXECUTABLES as DISCLOSED_ANY_PROGRAM } from '../../../src/shared/pluginDisclosure'

// PR C2: `permissions.shell` may be spelled as `{ mode: "allowlist", executables }`.
// The parser keeps the mode in `shell` and the names in `shellExecutables`.

const FIXTURES = join(process.cwd(), 'docs/plugin-contracts/fixtures')
const read = (group: string, name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, group, name), 'utf8'))

function manifest(shell: unknown): Record<string, any> {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.builder',
    name: 'Builder',
    version: '1.0.0',
    publisher: 'acme',
    permissions: { system: ['fs'], shell },
    marketplace: { description: 'A builder fixture.', license: 'MIT' },
    contributes: { views: [{ id: 'main', kind: 'custom', location: 'bottom', title: 'Builder', entry: 'frontend/main/index.html' }] },
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

describe('permissions.shell with declared executables', () => {
  it('keeps the string forms as before', () => {
    expect(parseManifestV2(manifest('allowlist')).permissions).toEqual({ system: ['fs'], shell: 'allowlist' })
    expect(parseManifestV2(manifest('full')).permissions).toEqual({ system: ['fs'], shell: 'full' })
  })

  it('normalizes the object form into the mode plus shellExecutables', () => {
    expect(parseManifestV2(manifest({ mode: 'allowlist', executables: ['npm', 'terraform'] })).permissions)
      .toEqual({ system: ['fs'], shell: 'allowlist', shellExecutables: ['npm', 'terraform'] })
    expect(parseManifestV2(read('valid', 'shell-executables.json')).permissions.shellExecutables).toEqual(['npm', 'terraform'])
  })

  it('refuses every invalid shell-executables fixture and names what would pass', () => {
    const invalid = readdirSync(join(FIXTURES, 'invalid')).filter((name) => name.startsWith('shell-executable'))
    expect(invalid.length).toBeGreaterThanOrEqual(5)
    for (const name of invalid) expect(() => parseManifestV2(read('invalid', name)), name).toThrow()
    expect(refusal(manifest({ mode: 'full', executables: ['npm'] }))).toContain('must be "allowlist"')
    expect(refusal(manifest({ mode: 'allowlist', executables: ['/usr/bin/npm'] }))).toContain('"/usr/bin/npm"')
    expect(refusal(manifest({ mode: 'allowlist', executables: ['npm.cmd'] }))).toContain('npm or terraform')
    expect(refusal(manifest({ mode: 'allowlist', executables: ['NPM'] }))).toContain('"NPM"')
    expect(refusal(manifest({ mode: 'allowlist', executables: [] }))).toContain('1-32 item(s)')
    expect(refusal(manifest({ mode: 'allowlist', executables: ['a', 'a'] }))).toContain('duplicate')
    expect(refusal(manifest({ mode: 'allowlist', executables: Array.from({ length: MAX_SHELL_EXECUTABLES + 1 }, (_, i) => `t${i}`) }))).toContain('1-32 item(s)')
    expect(refusal(manifest({ mode: 'allowlist' }))).toContain('executables')
    expect(refusal(manifest({ mode: 'allowlist', executables: ['npm'], extra: 1 }))).toContain('permissions.shell')
    expect(refusal(manifest('sudo'))).toContain('{ "mode": "allowlist", "executables": [...] }')
  })

  it('spells the executable rule as the schema copies do', () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), 'packages/plugin-contracts/src/schemas/plugin-manifest-v2.schema.json'), 'utf8'))
    const object = schema.properties.permissions.properties.shell.oneOf[1]
    expect(new RegExp(object.properties.executables.items.pattern).source).toBe(V2_SHELL_EXECUTABLE.source)
    expect(object.properties.executables.maxItems).toBe(MAX_SHELL_EXECUTABLES)
  })

  it('shares the any-program list with the disclosure contract', () => {
    expect([...DISCLOSED_ANY_PROGRAM].sort()).toEqual([...SHELL_ANY_PROGRAM_EXECUTABLES].sort())
    for (const name of SHELL_ANY_PROGRAM_EXECUTABLES) expect(V2_SHELL_EXECUTABLE.test(name), name).toBe(true)
  })
})
