import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyShellCommand,
  declaredVsScanned,
  disclosurePermissions,
  scanPackageFiles,
  scopePatternMatches,
  STATIC_SCAN_LIMITS,
  type StaticScanReport,
} from '../src/staticScan'

// The Registry's scanner is held to the same file by
// marketplace/registry/tests/test_static_scan_fixtures.py.
const root = process.cwd()
const scanFixture = JSON.parse(readFileSync(join(root, 'docs/plugin-contracts/static-scan-fixtures/cases.json'), 'utf8'))
const contractFixtures = join(root, 'docs/plugin-contracts/agent-tools-fixtures')
const scanCases = JSON.parse(readFileSync(join(contractFixtures, 'scan-cases.json'), 'utf8'))
const disclosureManifests = new Map(
  (JSON.parse(readFileSync(join(contractFixtures, 'disclosure-cases.json'), 'utf8')).cases as Array<{ name: string; manifest: unknown }>)
    .map((item) => [item.name, item.manifest])
)

type FileEntry = { text: string } | { textParts: string[] } | { base64: string }

function bytesOf(entry: FileEntry): Uint8Array {
  if ('base64' in entry) return new Uint8Array(Buffer.from(entry.base64, 'base64'))
  return new TextEncoder().encode('text' in entry ? entry.text : entry.textParts.join(''))
}

function filesOf(manifest: unknown, files: Record<string, FileEntry>): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>([['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))]])
  for (const [path, entry] of Object.entries(files)) map.set(path, bytesOf(entry))
  return map
}

const NOW = new Date('2026-10-17T00:00:00.000Z')

describe('scanPackageFiles matches the Registry scanner', () => {
  it.each(scanFixture.cases as Array<{ name: string; target: string; manifest: unknown; files: Record<string, FileEntry>; expected: unknown }>)(
    '$name', ({ target, manifest, files, expected }) => {
      const report = scanPackageFiles({
        files: filesOf(manifest, files),
        artifactDigest: scanFixture.artifactDigest,
        target,
        manifest,
        now: NOW,
      })
      if (expected === null) {
        expect(report).toBeNull()
        return
      }
      expect(report?.scannedAt).toBe('2026-10-17T00:00:00Z')
      const { scannedAt: _scannedAt, ...rest } = report as StaticScanReport
      expect(rest).toEqual(expected)
    })

  it('marks the report timed out when the budget runs out between files', () => {
    const ticks = [0, 0, STATIC_SCAN_LIMITS.timeBudgetMs + 1]
    let index = 0
    const report = scanPackageFiles({
      files: filesOf({ schemaVersion: 2 }, { 'frontend/a.js': { text: '1' }, 'frontend/b.js': { text: '2' } }),
      artifactDigest: 'b'.repeat(64),
      target: 'universal',
      manifest: { schemaVersion: 2 },
      clock: () => ticks[Math.min(index++, ticks.length - 1)],
    })
    expect(report?.coverage.timedOut).toBe(true)
    expect(report?.coverage.skipped).toContainEqual({ reason: 'unsupported', count: 1 })
  })
})

describe('contract twins', () => {
  it.each(scanCases.classify as Array<{ executable: string; args: string[]; expected: [string | null, string] }>)(
    'classifyShellCommand $executable $args', ({ executable, args, expected }) => {
      expect(classifyShellCommand(executable, args)).toEqual(expected)
    })

  it.each(scanCases.globs as Array<{ pattern: string; path: string; matches: boolean }>)(
    'scopePatternMatches $pattern ~ $path', ({ pattern, path, matches }) => {
      expect(scopePatternMatches(pattern, path)).toBe(matches)
    })

  it.each(scanCases.cases as Array<{ name: string; disclosureCase: string; scan: StaticScanReport; expected: any }>)(
    'declaredVsScanned $name', ({ disclosureCase, scan, expected }) => {
      const permissions = disclosurePermissions(disclosureManifests.get(disclosureCase))
      expect(declaredVsScanned({ permissions }, scan)).toEqual(expected.declaredVsScanned)
    })
})
