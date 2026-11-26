import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reconnectDelay } from './backoff.ts'

test('backoff grows and caps at 30s', () => {
  assert.equal(reconnectDelay(0, () => 1), 1_000)
  assert.equal(reconnectDelay(3, () => 1), 8_000)
  assert.equal(reconnectDelay(20, () => 1), 30_000)
  assert.equal(reconnectDelay(20, () => 0), 500)
})
