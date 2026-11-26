import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DesktopRoster, PaneSummary } from '../../types/pane.ts'
import { diffRosters } from './events.ts'

const roster = (...panes: Partial<PaneSummary>[]): DesktopRoster[] => [
  {
    deviceId: 'd',
    deviceName: 'Desk',
    panes: panes.map((p) => ({ name: 'a', agentKey: 'claude', status: 'idle', awaitingKind: null, workspace: 'w', ...p })),
  },
]

test('first snapshot produces nothing', () => {
  assert.deepEqual(diffRosters(null, roster({ status: 'awaiting', awaitingKind: 'permission' })), [])
})

test('busy to idle is a finished turn', () => {
  const ev = diffRosters(roster({ status: 'running' }), roster({ status: 'idle' }), 1)
  assert.deepEqual(ev.map((e) => e.kind), ['done'])
})

test('starting to wait is an approval or a question', () => {
  assert.deepEqual(
    diffRosters(roster({ status: 'running' }), roster({ status: 'awaiting', awaitingKind: 'permission' })).map((e) => e.kind),
    ['approval'],
  )
  assert.deepEqual(
    diffRosters(roster({ status: 'idle' }), roster({ status: 'awaiting', awaitingKind: 'question' })).map((e) => e.kind),
    ['question'],
  )
})

test('no event while state holds, for new panes, or idle to offline', () => {
  const waiting = { status: 'awaiting', awaitingKind: 'permission' as const }
  assert.deepEqual(diffRosters(roster(waiting), roster(waiting)), [])
  assert.deepEqual(diffRosters(roster(), roster({ status: 'running' })), [])
  assert.deepEqual(diffRosters(roster({ status: 'idle' }), roster({ status: 'disconnected' })), [])
})
