import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { changelogDates } from '../../scripts/export-whats-new.mjs'

const script = resolve('scripts/stamp-changelog-release.mjs')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stamp(changelog: string, version = '1.2.3', date = '2026-11-22') {
  const root = mkdtempSync(join(tmpdir(), 'navide-changelog-'))
  roots.push(root)
  const file = join(root, 'CHANGELOG.md')
  writeFileSync(file, changelog)
  const result = spawnSync(process.execPath, [script, version, date, file], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr, content: readFileSync(file, 'utf8') }
}

const head = '# Changelog\n\nIntro.\n\n'
const previous = '## [1.2.2] — 2026-11-01\n\n- Older.\n'

// release.sh renames `## [Unreleased]` to the release's heading (0.2.42 and
// 0.2.46 shipped without it, and the site's /news lost their dates).
describe('stamp-changelog-release', () => {
  it('renames the Unreleased heading to the dated release heading', () => {
    const result = stamp(`${head}## [Unreleased]\n\n- New.\n\n${previous}`)
    expect(result.status).toBe(0)
    expect(result.content).toBe(`${head}## [1.2.3] — 2026-11-22\n\n- New.\n\n${previous}`)
    expect(changelogDates(result.content)['1.2.3']).toBe('2026-11-22')
  })

  it('leaves a changelog that already has the dated heading alone', () => {
    const changelog = `${head}## [1.2.3] — 2026-11-20\n\n- New.\n\n${previous}`
    const result = stamp(changelog)
    expect(result.status).toBe(0)
    expect(result.content).toBe(changelog)
  })

  it('fails when the version heading exists without a date', () => {
    const changelog = `${head}## [1.2.3]\n\n- New.\n\n${previous}`
    const result = stamp(changelog)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('no date')
    expect(result.content).toBe(changelog)
  })

  it('fails when there is neither an Unreleased section nor the version heading', () => {
    const changelog = `${head}${previous}`
    const result = stamp(changelog)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('## [Unreleased]')
    expect(result.content).toBe(changelog)
  })
})

// The artifact tests of `pnpm test:run` read dist-plugins/official-artifacts,
// which is ignored by Git and survives from an older build: release.sh must
// stage the pinned copies fresh and make a missing one fail, not skip.
describe('release.sh test gate', () => {
  it('stages the official plugins before pnpm test:run and requires them', () => {
    const lines = readFileSync(resolve('release.sh'), 'utf8').split('\n')
    const stage = lines.findIndex((line) => /^node scripts\/stage-official-plugin-artifacts\.mjs\s*$/.test(line))
    const test = lines.findIndex((line) => /^NAVIDE_TEST_STAGED_PLUGINS=1 pnpm test:run\s*$/.test(line))
    expect(stage).toBeGreaterThan(-1)
    expect(test).toBeGreaterThan(stage)
    expect(lines.filter((line) => /pnpm test:run\s*$/.test(line) && !line.startsWith('#'))).toHaveLength(1)
  })

  it('stamps CHANGELOG.md and commits it with the version files', () => {
    const source = readFileSync(resolve('release.sh'), 'utf8')
    expect(source).toMatch(/^node scripts\/stamp-changelog-release\.mjs "\$VERSION" /m)
    expect(source).toMatch(/^VERSION_FILES=\([^)]*\n {2}CHANGELOG\.md\n/m)
    expect(source).toContain('|CHANGELOG\\.md)$')
  })
})
