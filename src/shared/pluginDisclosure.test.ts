import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalContractJson,
  computeDisclosure,
  diffDisclosure,
  riskLevelForReasons,
} from './pluginDisclosure'

// The Python implementation (backend/agent_team_backend/plugins/disclosure_contract.py)
// is held to the same fixtures by backend/tests/test_plugin_agent_tools_contract.py.
const FIXTURES = join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures')
const load = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const disclosureCases = load('disclosure-cases.json').cases as Array<{ name: string; manifest: unknown; expected: unknown }>
const byName = new Map(disclosureCases.map((c) => [c.name, c]))

describe('computeDisclosure', () => {
  it.each(disclosureCases)('$name', ({ manifest, expected }) => {
    expect(computeDisclosure(manifest as never)).toEqual(expected)
  })

  it('does not depend on the order of arrays in the manifest', () => {
    const { manifest } = byName.get('devmap-0.2.0')!
    const shuffled = JSON.parse(JSON.stringify(manifest))
    shuffled.permissions.system.reverse()
    shuffled.backend.methods.reverse()
    shuffled.backend.agentTools.reverse()
    shuffled.permissions.scopes.fs.read.reverse()
    expect(canonicalContractJson(computeDisclosure(shuffled))).toBe(canonicalContractJson(computeDisclosure(manifest as never)))
  })
})

describe('risk level', () => {
  it('is the highest reason, and low with no reasons', () => {
    expect(riskLevelForReasons([])).toBe('low')
    expect(riskLevelForReasons([{ key: 'system.fs', level: 'medium' }, { key: 'shell.full', level: 'highest' }])).toBe('highest')
  })
})

describe('canonicalContractJson', () => {
  const canonical = load('canonical.json') as { values: Array<{ value: unknown; expected: string | null }>; disclosureCase: string; disclosureExpected: string; disclosureDigestExpected: string }

  it.each(canonical.values)('spells %j', ({ value, expected }) => {
    if (expected === null) expect(() => canonicalContractJson(value)).toThrow(TypeError)
    else expect(canonicalContractJson(value)).toBe(expected)
  })

  it('pins the canonical spelling of a computed disclosure', () => {
    const { manifest } = byName.get(canonical.disclosureCase)!
    expect(canonicalContractJson(computeDisclosure(manifest as never))).toBe(canonical.disclosureExpected)
  })

  it('pins the disclosureDigest: lowercase hex SHA-256 of the canonical spelling (section 3.5)', () => {
    const { manifest } = byName.get(canonical.disclosureCase)!
    const spelling = canonicalContractJson(computeDisclosure(manifest as never))
    expect(createHash('sha256').update(spelling, 'utf8').digest('hex')).toBe(canonical.disclosureDigestExpected)
  })
})

describe('diffDisclosure', () => {
  it.each(load('diff-cases.json').cases as Array<{ name: string; from: string; to: string; expected: unknown }>)('$name', ({ from, to, expected }) => {
    const a = computeDisclosure(byName.get(from)!.manifest as never)
    const b = computeDisclosure(byName.get(to)!.manifest as never)
    expect(diffDisclosure(a, b)).toEqual(expected)
  })
})

describe('aiCli in an update', () => {
  // A package that gains aiCli can start an AI CLI and read all it prints
  // (aiCli.output reaches every v2 package that declares it), so the update
  // says so and counts as widened. Disclosure only: nothing is limited.
  it('lists aiCli as added and the update as widened', () => {
    const before = byName.get('ui-only')!.manifest as { permissions: { system: string[] } }
    const after = JSON.parse(JSON.stringify(before)) as typeof before
    after.permissions.system = [...after.permissions.system, 'aiCli']
    const diff = diffDisclosure(computeDisclosure(before as never), computeDisclosure(after as never))
    expect(diff.added).toContainEqual({ kind: 'system', key: 'aiCli', detail: null })
    expect(diff.widened).toBe(true)
  })
})
