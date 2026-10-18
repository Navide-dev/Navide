import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { knownBytes, parsePluginActivityReport, sumKnownBytes, UNKNOWN_BYTES } from './pluginActivity'

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/activity-report.json'), 'utf8')
) as {
  valid: Record<string, unknown>
  invalid: Array<{ name: string; patch?: Record<string, unknown>; path?: Array<string | number>; value?: unknown }>
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('parsePluginActivityReport (contract 5.1)', () => {
  it('rebuilds the valid fixture exactly', () => {
    expect(parsePluginActivityReport(clone(fixture.valid))).toEqual(fixture.valid)
  })

  it('drops unknown fields at every level', () => {
    const report = clone(fixture.valid) as Record<string, any>
    report.extra = 'x'
    report.toolCalls[0].arguments = { secret: 1 }
    report.undeclared[0].reasons[0].note = 'x'
    expect(parsePluginActivityReport(report)).toEqual(fixture.valid)
  })

  it.each(fixture.invalid.map((entry) => [entry.name, entry] as const))('refuses the whole report: %s', (_name, entry) => {
    const report = clone(fixture.valid) as Record<string, any>
    if (entry.patch) Object.assign(report, entry.patch)
    if (entry.path) {
      let target: any = report
      for (const key of entry.path.slice(0, -1)) target = target[key]
      target[entry.path[entry.path.length - 1]] = entry.value
    }
    expect(parsePluginActivityReport(report)).toBeNull()
  })

  it('keeps plain strings as they are: they are shown as text, never as links', () => {
    const parsed = parsePluginActivityReport(clone(fixture.valid))!
    expect(parsed.files.map((entry) => entry.path)).toContain('javascript:alert(1)')
    expect(parsed.files.map((entry) => entry.path)).toContain('mailto:someone@example.com')
  })

  it('accepts agentActions as null until B2-c lands, and as a list after', () => {
    const report = clone(fixture.valid) as Record<string, any>
    report.agentActions = [{
      at: 1, action: 'disable', callerKind: 'pane', paneId: 'p-1', paneName: 'dev', workspace: '/w', version: '0.2.0',
    }]
    expect(parsePluginActivityReport(report)?.agentActions).toHaveLength(1)
  })
})

describe('unknown sizes (-1)', () => {
  it('are never added to a total and are counted instead', () => {
    expect(sumKnownBytes([14, UNKNOWN_BYTES, 2, UNKNOWN_BYTES])).toEqual({ bytes: 16, unknown: 2 })
    expect(sumKnownBytes([UNKNOWN_BYTES])).toEqual({ bytes: 0, unknown: 1 })
  })

  it('read as null', () => {
    expect(knownBytes(UNKNOWN_BYTES)).toBeNull()
    expect(knownBytes(0)).toBe(0)
  })
})
