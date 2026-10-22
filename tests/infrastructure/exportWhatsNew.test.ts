import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WHATS_NEW } from '../../src/renderer/src/lib/whatsNew'
import { buildWhatsNewJson, changelogDates } from '../../scripts/export-whats-new.mjs'

// The mirror job runs the script with Node 22's type stripping and a
// node:module register() hook. CI runs vitest under Bun, whose execPath is bun
// and which ignores register(), so the run below names a real `node` from PATH
// and checks it can strip types; without one the test is skipped, not faked.
function nodeWithTypeStripping(): string | null {
  try {
    execFileSync('node', [
      '--experimental-strip-types', '-e',
      'if (process.versions.bun) process.exit(3); const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 6) ? 0 : 4)',
    ], { stdio: 'ignore' })
    return 'node'
  } catch {
    return null
  }
}
const NODE = nodeWithTypeStripping()

describe('whats-new.json export', () => {
  it('keeps entries at or below the release, newest first, with text only', () => {
    const json = buildWhatsNewJson(WHATS_NEW, { version: '0.2.10', dates: { '0.2.10': '2026-09-24' } })
    expect(json.schemaVersion).toBe(1)
    expect(json.version).toBe('0.2.10')
    expect(json.entries[0].version).toBe('0.2.10')
    expect(json.entries.every((entry: { version: string }) => !/^0\.2\.(1[1-9]|[2-9]\d)$/.test(entry.version))).toBe(true)
    const [first] = json.entries
    expect(first.date).toBe('2026-09-24')
    expect(first.major).toBe(true)
    expect(Object.keys(first).sort()).toEqual(['date', 'highlights', 'major', 'title', 'version'])
    expect(first.title['en-US']).toBe(WHATS_NEW.find((entry) => entry.version === '0.2.10')!.title['en-US'])
  })

  it('reads release dates from CHANGELOG headings', () => {
    expect(changelogDates('## [Unreleased]\n\n## [0.2.28] — 2026-10-21 — signed release\n## [0.2.27] — 2026-10-20\n'))
      .toEqual({ '0.2.28': '2026-10-21', '0.2.27': '2026-10-20' })
  })

  // Skipped when PATH has no Node >= 22.6 (type stripping): the script needs one, as the mirror job's setup-node gives it.
  it.skipIf(NODE === null)('runs under plain Node with no dependency install, as the mirror job does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whats-new-'))
    try {
      const out = join(dir, 'whats-new.json')
      execFileSync(NODE!, ['--experimental-strip-types', 'scripts/export-whats-new.mjs', '--version', 'v0.2.28', '--out', out], { stdio: 'pipe' })
      const json = JSON.parse(readFileSync(out, 'utf8'))
      expect(json.version).toBe('0.2.28')
      expect(json.entries[0].version).toBe('0.2.28')
      expect(json.entries[0].date).toBe('2026-10-21')
      expect(JSON.stringify(json)).not.toContain('"tour"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
