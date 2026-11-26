import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pairErrorCode } from './pairErrors.ts'

test('server error codes map to pairing errors', () => {
  assert.equal(pairErrorCode('rate_limited', false), 'rate-limited')
  assert.equal(pairErrorCode('invalid_code', false), 'invalid-code')
  assert.equal(pairErrorCode('desktop_offline', false), 'desktop-offline')
  assert.equal(pairErrorCode('something_new', false), 'network')
})

test('expired means a stale code before acceptance and a timeout after', () => {
  assert.equal(pairErrorCode('expired', false), 'expired')
  assert.equal(pairErrorCode('expired', true), 'timed-out')
})
