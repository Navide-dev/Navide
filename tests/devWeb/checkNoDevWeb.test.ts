import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEV_WEB_MARKERS, findDevWebMarkers } from '../../scripts/check-no-dev-web.mjs'

const dirs: string[] = []
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'no-dev-web-'))
  dirs.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const script = join(__dirname, '../../scripts/check-no-dev-web.mjs')

describe('check-no-dev-web', () => {
  it('finds every web-mode marker in a build tree', () => {
    for (const marker of DEV_WEB_MARKERS) {
      const dir = fixture({ 'renderer/assets/a.js': `x("${marker}")`, 'main/index.js': 'ok' })
      expect(findDevWebMarkers(dir)).toEqual([{ file: join(dir, 'renderer/assets/a.js'), marker }])
    }
  })

  it('passes a clean tree', () => {
    const dir = fixture({ 'renderer/index.html': '<html></html>', 'preload/index.js': 'ok' })
    expect(findDevWebMarkers(dir)).toEqual([])
  })

  it('exits non-zero when a marker is found and zero when clean', () => {
    const dirty = fixture({ 'renderer/x.js': DEV_WEB_MARKERS[0] })
    const clean = fixture({ 'renderer/x.js': 'nothing' })
    expect(spawnSync(process.execPath, [script, dirty]).status).toBe(1)
    expect(spawnSync(process.execPath, [script, clean]).status).toBe(0)
  })

  it('fails rather than passes when the build tree is missing', () => {
    expect(spawnSync(process.execPath, [script, join(tmpdir(), 'no-such-build-dir-xyz')]).status).toBe(2)
  })
})
