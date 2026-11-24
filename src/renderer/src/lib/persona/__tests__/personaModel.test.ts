import { describe, expect, it } from 'vitest'

import {
  attentionList,
  deskAt,
  deskLayout,
  deskPos,
  DOZE_AFTER_MS,
  floorAlarm,
  lampOpacity,
  personaPose,
  roomCounts,
} from '../personaModel'
import { buildPersonaRooms, quotaStage, type StatusClock } from '../personaRooms'
import { lookFor, withAlpha } from '../sprites'
import { RAIL_PALETTE } from '../../workspaceRails'

describe('personaPose', () => {
  const now = 1_000_000_000
  it.each([
    ['running', 'type'],
    ['starting', 'type'],
    ['awaiting', 'raise'],
    ['error', 'smoke'],
    ['disconnected', 'unplugged'],
    ['exited', 'away'],
    ['stopped', 'away'],
    ['waiting', 'away'],
  ] as const)('%s → %s', (status, pose) => {
    expect(personaPose({ status }, now)).toBe(pose)
  })

  it('idle holds coffee, then dozes off after a long idle', () => {
    expect(personaPose({ status: 'idle', since: now - 1000 }, now)).toBe('coffee')
    expect(personaPose({ status: 'idle', since: now - DOZE_AFTER_MS }, now)).toBe('sleep')
  })

  it('an exhausted quota wins over the status', () => {
    expect(personaPose({ status: 'running', quota: 'empty' }, now)).toBe('quota')
    expect(personaPose({ status: 'running', quota: 'low' }, now)).toBe('type')
  })
})

describe('attention and counts', () => {
  const people = [
    { status: 'running' as const },
    { status: 'error' as const },
    { status: 'awaiting' as const },
    { status: 'idle' as const, quota: 'empty' as const },
    { status: 'awaiting' as const },
  ]
  it('lists awaiting first, then failures, stable within each', () => {
    expect(attentionList(people)).toEqual([people[2], people[4], people[1], people[3]])
  })
  it('counts running, awaiting and failing', () => {
    expect(roomCounts(people)).toEqual({ total: 5, running: 1, awaiting: 2, failing: 2 })
  })
  it('floor alarm: failing beats awaiting, nothing when calm', () => {
    expect(floorAlarm(people)).toBe('failing')
    expect(floorAlarm([{ status: 'awaiting' }])).toBe('awaiting')
    expect(floorAlarm([{ status: 'running' }])).toBeNull()
  })
})

describe('lampOpacity', () => {
  it('breathes at the sidebar dot rhythm and is steady otherwise', () => {
    expect(lampOpacity('running', 0, false)).toBeCloseTo(1)
    expect(lampOpacity('running', 800, false)).toBeCloseTo(0.35)
    expect(lampOpacity('awaiting', 600, false)).toBeCloseTo(0.35)
    expect(lampOpacity('error', 600, false)).toBe(1)
  })
  it('does not breathe under reduced motion', () => {
    expect(lampOpacity('running', 800, true)).toBe(1)
  })
})

describe('deskLayout', () => {
  it('shrinks desks as the room fills and never below S = 2', () => {
    expect(deskLayout(1, 1200).S).toBe(5)
    expect(deskLayout(6, 1200).S).toBe(4)
    expect(deskLayout(28, 1200).S).toBe(2)
  })
  it('shrinks further to fit the visible height', () => {
    const tall = deskLayout(6, 1200)
    const fitted = deskLayout(6, 1200, 600)
    expect(fitted.S).toBeLessThan(tall.S)
    expect(fitted.heightU * fitted.S).toBeLessThanOrEqual(600)
  })
  it('hit-tests the desk under a point', () => {
    const L = deskLayout(6, 1200)
    const { x, y } = deskPos(L, 4)
    expect(deskAt(L, 6, x + 10, y + 10)).toBe(4)
    expect(deskAt(L, 6, 0, 0)).toBe(-1)
  })
})

describe('buildPersonaRooms', () => {
  const facts = (id: string) => ({ name: id.toUpperCase(), vendor: 'Claude Code' })
  it('makes one room per tab with the group palette, in tab order', () => {
    const clock: StatusClock = new Map()
    const rooms = buildPersonaRooms({
      tabs: [{ key: 'a', label: 'A', paneIds: ['p1', 'p2'] }, { key: 'b', label: 'B', paneIds: ['p3'] }],
      stagePaneIds: [],
      fallbackLabel: 'Default',
      statusOf: () => 'running',
      factsOf: facts,
      clock,
      now: 10,
    })
    expect(rooms.map((r) => [r.key, r.color, r.people.map((p) => p.id)])).toEqual([
      ['a', RAIL_PALETTE[0], ['p1', 'p2']],
      ['b', RAIL_PALETTE[1], ['p3']],
    ])
  })

  it('falls back to one room of every stage pane when there are no tabs', () => {
    const rooms = buildPersonaRooms({
      tabs: [], stagePaneIds: ['p1'], fallbackLabel: 'Default',
      statusOf: () => 'idle', factsOf: facts, clock: new Map(), now: 0,
    })
    expect(rooms).toHaveLength(1)
    expect(rooms[0].label).toBe('Default')
  })

  it('stamps when a status began and keeps it until the status changes', () => {
    const clock: StatusClock = new Map()
    let status: 'running' | 'awaiting' = 'running'
    const build = (now: number) => buildPersonaRooms({
      tabs: [{ key: 'a', label: 'A', paneIds: ['p1'] }], stagePaneIds: [], fallbackLabel: '',
      statusOf: () => status, factsOf: facts, clock, now,
    })[0].people[0].since
    expect(build(100)).toBe(100)
    expect(build(200)).toBe(100)
    status = 'awaiting'
    expect(build(300)).toBe(300)
  })

  it('prefers a status start time the pane knows itself', () => {
    const rooms = buildPersonaRooms({
      tabs: [{ key: 'a', label: 'A', paneIds: ['p1'] }], stagePaneIds: [], fallbackLabel: '',
      statusOf: () => 'awaiting', factsOf: (id) => ({ ...facts(id), since: 42 }), clock: new Map(), now: 999,
    })
    expect(rooms[0].people[0].since).toBe(42)
  })
})

describe('helpers', () => {
  it('quotaStage maps the usage badge tiers', () => {
    expect(quotaStage('ok', false)).toBeNull()
    expect(quotaStage('warn', false)).toBe('low')
    expect(quotaStage('crit', false)).toBe('critical')
    expect(quotaStage('ok', true)).toBe('empty')
    expect(quotaStage(null, false)).toBeNull()
  })
  it('withAlpha handles hex and rgb()', () => {
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255,0,0,0.5)')
    expect(withAlpha('rgb(1, 2, 3)', 0.25)).toBe('rgba(1,2,3,0.25)')
  })
  it('a pane keeps the same look, wearing its agent colour when it has one', () => {
    expect(lookFor('pane-1')).toEqual(lookFor('pane-1'))
    expect(lookFor('pane-1', '#7650dc').shirt).toBe('#7650dc')
  })
})
