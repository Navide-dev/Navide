import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalContractJson, computeDisclosure } from './pluginDisclosure'
import {
  DISCLOSURE_ENVELOPE_FIELDS,
  INCOMPLETE_SKIP_REASONS,
  SCAN_LIMITS,
  SCAN_RISK_RULES,
  SCANNER_ID,
  SHELL_CATEGORY_ORDER,
  cardRiskLevel,
  classifyShellCommand,
  declaredVsScanned,
  diffScan,
  scanItems,
  scanRiskReasons,
  scanSentences,
  scopePatternMatches,
  type ScanReport,
} from './pluginDisclosureScan'

// The Python implementation (backend/agent_team_backend/plugins/disclosure_scan_contract.py)
// is held to the same fixture by backend/tests/test_plugin_disclosure_scan_contract.py.
const FIXTURES = join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures')
const load = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const fixture = load('scan-cases.json')
const manifests = new Map(
  (load('disclosure-cases.json').cases as Array<{ name: string; manifest: unknown }>).map((c) => [c.name, c.manifest])
)
const cases = fixture.cases as Array<{ name: string; disclosureCase: string; scan: ScanReport; expected: any }>
const byName = new Map(cases.map((c) => [c.name, c.scan]))

describe('scan contract constants', () => {
  it('match the shared fixture', () => {
    expect([...DISCLOSURE_ENVELOPE_FIELDS]).toEqual(fixture.disclosureEnvelopeFields)
    expect(SCAN_LIMITS).toEqual(fixture.scanLimits)
    expect(SCAN_RISK_RULES.map((rule) => [...rule])).toEqual(fixture.scanRiskRules)
    expect([...SHELL_CATEGORY_ORDER]).toEqual(fixture.shellCategoryOrder)
    expect(SCANNER_ID).toBe(fixture.scannerId)
    expect([...INCOMPLETE_SKIP_REASONS]).toEqual(fixture.incompleteSkipReasons)
  })
})

describe('classifyShellCommand', () => {
  it.each(fixture.classify as Array<{ executable: string; args: string[]; expected: [string | null, string] }>)(
    '$executable $args', ({ executable, args, expected }) => {
      expect(classifyShellCommand(executable, args)).toEqual(expected)
    })
})

describe('scopePatternMatches', () => {
  it.each(fixture.globs as Array<{ pattern: string; path: string; matches: boolean }>)(
    '$pattern ~ $path', ({ pattern, path, matches }) => {
      expect(scopePatternMatches(pattern, path)).toBe(matches)
    })
})

describe('derived values of a scan report', () => {
  it.each(cases)('$name', ({ disclosureCase, scan, expected }) => {
    const disclosure = computeDisclosure(manifests.get(disclosureCase) as never)
    expect(scanSentences(scan)).toEqual(expected.sentences)
    expect(scanRiskReasons(scan, disclosure)).toEqual(expected.riskReasons)
    expect(cardRiskLevel(disclosure, scan)).toBe(expected.cardRiskLevel)
    expect(declaredVsScanned(disclosure, scan)).toEqual(expected.declaredVsScanned)
    expect(scanItems(scan)).toEqual(expected.items)
  })

  it('never reports an absent kind as an empty list', () => {
    const keys = scanSentences(byName.get('nothing-found')!).map((sentence) => sentence.key)
    expect(keys).toEqual(['notFound.shell', 'notFound.network', 'notFound.files', 'notFound.dynamicCode', 'coverage'])
  })

  it('without a scan the card level is the manifest level', () => {
    const disclosure = computeDisclosure(manifests.get('ui-only') as never)
    expect(cardRiskLevel(disclosure, null)).toBe(disclosure.risk.level)
  })
})

describe('diffScan', () => {
  it.each(fixture.diffs as Array<{ from: string | null; to: string; expected: unknown }>)(
    '$from -> $to', ({ from, to, expected }) => {
      expect(diffScan(from ? byName.get(from)! : null, byName.get(to)!)).toEqual(expected)
    })
})

it('pins the scanDigest: lowercase hex SHA-256 of the canonical spelling of the report', () => {
  const spelling = canonicalContractJson(byName.get(fixture.scanDigestCase)!)
  expect(createHash('sha256').update(spelling, 'utf8').digest('hex')).toBe(fixture.scanDigestExpected)
})
