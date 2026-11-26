import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paneState, pickPaneSummary } from './pane.ts'

const pane = (status: string, awaitingKind: 'permission' | 'question' | null = null) => ({
  name: 'p',
  agentKey: 'claude',
  status,
  awaitingKind,
  workspace: 'w',
})

test('groups desktop status words', () => {
  assert.equal(paneState(pane('running')), 'busy')
  assert.equal(paneState(pane('starting')), 'busy')
  assert.equal(paneState(pane('idle')), 'idle')
  assert.equal(paneState(pane('waiting')), 'idle')
  assert.equal(paneState(pane('disconnected')), 'offline')
  assert.equal(paneState(pane('awaiting')), 'attention')
  assert.equal(paneState(pane('running', 'permission')), 'attention')
})

test('keeps only the five contract fields', () => {
  const got = pickPaneSummary({ ...pane('idle'), paneId: 'x', path: '/secret', awaitingKind: 'other' })
  assert.deepEqual(got, pane('idle'))
  assert.equal(pickPaneSummary({ status: 'idle' }), null)
})
