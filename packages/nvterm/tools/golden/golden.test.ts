import { describe, expect, it } from 'vitest'
import type { ScreenSnapshot } from '../../src/snapshot.ts'
import { fixtures } from '../fixtures/fixtures.ts'
import { readFileSync } from 'node:fs'
import { compareFixture, type Triage } from './compare.ts'
import type { TerminalDriver } from './driver.ts'
import { nvtermDriver } from './nvtermDriver.ts'
import { xtermDriver } from './xtermOracle.ts'

const byId = (id: string) => fixtures.find((f) => f.id === id)!

describe('golden comparison tool', () => {
  it('xterm.js against itself matches on every fixture (M0 completion criterion)', async () => {
    for (const fixture of fixtures) {
      const result = await compareFixture(fixture, xtermDriver, xtermDriver)
      expect(result.diffs, fixture.id).toEqual([])
    }
  })

  it('nvterm matches the oracle on every fixture, apart from triaged differences (M1 gate)', async () => {
    const triage = JSON.parse(readFileSync(new URL('./triage.json', import.meta.url), 'utf8')) as Triage
    for (const fixture of fixtures) {
      const result = await compareFixture(fixture, xtermDriver, nvtermDriver, triage)
      expect(result.untriaged, fixture.id).toEqual([])
    }
  })

  it('the oracle snapshot sees wide characters, colours, modes and the alternate screen', async () => {
    const cjk = await xtermDriver.run(byId('cjk-wide'))
    expect(cjk.lines[0]!.cells[0]).toMatchObject({ chars: '中', width: 2 })
    expect(cjk.lines[0]!.cells[1]).toMatchObject({ chars: '', width: 0 })

    const rgb = await xtermDriver.run(byId('sgr-truecolor'))
    expect(rgb.lines[0]!.cells[0]!.fg).toMatch(/^r:[0-9a-f]{6}$/)

    const modes = await xtermDriver.run(byId('modes-input'))
    expect(modes.modes).toMatchObject({ bracketedPasteMode: true, applicationCursorKeysMode: true, sendFocusMode: true })
    expect(modes.modes.mouseTrackingMode).not.toBe('none')

    expect((await xtermDriver.run(byId('alt-screen-left-open'))).buffer).toBe('alternate')
    expect((await xtermDriver.run(byId('large-scroll'))).scrollbackLength).toBeGreaterThan(0)
  })

  it('reports a candidate that differs, and honours triage decisions', async () => {
    const fixture = byId('ascii-lines')
    const broken: TerminalDriver = {
      name: 'broken',
      async run(f) {
        const snap: ScreenSnapshot = await xtermDriver.run(f)
        snap.lines[0]!.cells[0] = { ...snap.lines[0]!.cells[0]!, chars: '?' }
        return snap
      },
    }
    const raw = await compareFixture(fixture, xtermDriver, broken)
    expect(raw.untriaged).toHaveLength(1)
    const triaged = await compareFixture(fixture, xtermDriver, broken, {
      'ascii-lines': { 'cell:0:0': { category: 'accepted', reason: 'test' } },
    })
    expect(triaged.diffs).toHaveLength(1)
    expect(triaged.untriaged).toEqual([])
  })
})
