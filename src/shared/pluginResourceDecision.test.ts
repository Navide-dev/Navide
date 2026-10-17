import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePluginResourceDecisionRow } from './pluginResourceDecision'

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/resource-decisions.json'), 'utf8')
) as { valid: Array<Record<string, unknown>>; invalid: Array<{ name: string; patch: Record<string, unknown> }> }

describe('plugin.resource.decision rows (contract 5.2)', () => {
  it('accepts every valid fixture row unchanged and drops unknown fields', () => {
    for (const row of fixture.valid) expect(parsePluginResourceDecisionRow({ ...row, path: '/secret' })).toEqual(row)
  })

  it.each(fixture.invalid.map((entry) => [entry.name, entry.patch] as const))('refuses %s', (_name, patch) => {
    expect(parsePluginResourceDecisionRow({ ...fixture.valid[0], ...patch })).toBeNull()
  })
})
