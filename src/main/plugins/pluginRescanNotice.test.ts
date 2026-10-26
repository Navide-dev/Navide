import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rescanFinding } from './pluginRescanNotice'
import type { ScanReport } from '../../shared/pluginDisclosureScan'

const cases = (JSON.parse(
  readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/scan-cases.json'), 'utf8')
) as { cases: Array<{ name: string; scan: ScanReport }> }).cases
const scanOf = (name: string): ScanReport => cases.find((entry) => entry.name === name)!.scan
const row = (version: string, target: string, scan: unknown) => ({ version, target, yanked: false, scan })

describe('rescanFinding (D-f: notice only)', () => {
  const installed = scanOf('nothing-found')
  const rescanned = scanOf('ui-only-runs-git-push-undeclared')

  it('reports the items a rescan of the installed version added', () => {
    const finding = rescanFinding(installed, [row('1.0.0', 'universal', rescanned), row('1.1.0', 'universal', installed)], '1.0.0', 'darwin-arm64')
    expect(finding?.added.length).toBeGreaterThan(0)
    expect(finding?.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('says nothing when the scan is unchanged, only lost items, or there is no baseline', () => {
    expect(rescanFinding(installed, [row('1.0.0', 'universal', installed)], '1.0.0', 'darwin-arm64')).toBeNull()
    expect(rescanFinding(rescanned, [row('1.0.0', 'universal', installed)], '1.0.0', 'darwin-arm64')).toBeNull()
    expect(rescanFinding(null, [row('1.0.0', 'universal', rescanned)], '1.0.0', 'darwin-arm64')).toBeNull()
  })

  it("reads this Host's artifact of the installed version and ignores a malformed scan", () => {
    const rows = [row('1.0.0', 'linux-x64', rescanned), row('1.0.0', 'darwin-arm64', installed)]
    expect(rescanFinding(installed, rows, '1.0.0', 'darwin-arm64')).toBeNull()
    expect(rescanFinding(installed, [row('1.0.0', 'universal', { schemaVersion: 1, x: 'IGNORE' })], '1.0.0', 'darwin-arm64')).toBeNull()
    expect(rescanFinding(installed, [{ ...row('1.0.0', 'universal', rescanned), yanked: true }], '1.0.0', 'darwin-arm64')).toBeNull()
  })
})
