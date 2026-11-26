import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAllowedServerUrl } from './serverUrl.ts'

test('release builds accept only wss://', () => {
  assert.equal(isAllowedServerUrl('wss://example.com/ws', false), true)
  assert.equal(isAllowedServerUrl('ws://example.com/ws', false), false)
  assert.equal(isAllowedServerUrl('https://example.com', false), false)
  assert.equal(isAllowedServerUrl('', false), false)
})

test('development builds may also use ws://', () => {
  assert.equal(isAllowedServerUrl('ws://localhost:8080', true), true)
  assert.equal(isAllowedServerUrl('http://localhost:8080', true), false)
})
