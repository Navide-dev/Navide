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
// and checks it can strip types. Without one it is skipped on a developer
// machine, but fails in CI: there the mirror path must really be exercised.
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
const IN_CI = !!process.env.CI

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

  // Needs Node >= 22.6 on PATH (type stripping), as the mirror job's setup-node
  // gives it. Skipped without one locally; in CI that is a failure, not a skip.
  it.skipIf(NODE === null && !IN_CI)('runs under plain Node with no dependency install, as the mirror job does', () => {
    if (NODE === null) throw new Error('CI must provide Node.js >= 22.6 on PATH (actions/setup-node) for the mirror path; none was found')
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
