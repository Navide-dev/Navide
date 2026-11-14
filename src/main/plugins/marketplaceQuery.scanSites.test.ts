// Scanner 1.2.0 sites survive the Host's rebuild of a Registry scan report;
// a report without them, or with malformed ones, is read exactly as before.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { canonicalContractJson } from '../../shared/pluginDisclosure'
import { scanReport } from './marketplaceQuery'

const cases = JSON.parse(readFileSync(join(process.cwd(), 'docs/plugin-contracts/static-scan-fixtures/cases.json'), 'utf8')).cases as Array<{ name: string; expected: any }>
const report = (name: string): any => ({ ...structuredClone(cases.find((c) => c.name === name)!.expected), scannedAt: '2026-11-10T00:00:00Z' })
const withoutSites = (value: any): any => {
  const copy = structuredClone(value)
  for (const list of [copy.shell.calls, copy.network.hosts, copy.capabilities]) for (const entry of list) delete entry.sites
  return copy
}

describe('scanReport: scanner 1.2.0 sites', () => {
  it('keeps the sites of every finding', () => {
    const value = report('finding-sites')
    expect(scanReport(value)).toEqual(value)
  })

  it('reads a 1.1.0 report (no sites) unchanged', () => {
    const value = withoutSites(report('frontend-report-shape'))
    value.scanner.version = '1.1.0'
    expect(scanReport(value)).toEqual(value)
  })

  it('drops only malformed sites, never the report', () => {
    const value = report('finding-sites')
    value.network.hosts[0].sites = [{ file: 'a.js', line: -1, col: 1, excerpt: 'x' }]
    value.capabilities[0].sites = 'not a list'
    const rebuilt = scanReport(value)!
    expect(rebuilt).not.toBeNull()
    expect(rebuilt.network.hosts[0]).not.toHaveProperty('sites')
    expect(rebuilt.capabilities[0]).not.toHaveProperty('sites')
    expect(rebuilt.network.hosts[1].sites).toEqual(value.network.hosts[1].sites)
  })
})

// Pinned in marketplace/registry/tests/test_static_scan_sites.py too.
it('spells an astral excerpt as the Registry does (scanDigest)', () => {
  expect(createHash('sha256').update(canonicalContractJson(report('finding-sites')), 'utf8').digest('hex')).toBe('f6b13e7510110475081b42ae0b2eeb11c8562ca50f9c0745626d200d1da6a97a')
})
