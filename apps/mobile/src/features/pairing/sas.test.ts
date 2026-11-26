import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pairingCode } from './sas.ts'

// Shared with the desktop backend's mobile pairing tests: both sides must
// derive the same six digits from the same inputs.
test('pairing code matches the desktop test vector', () => {
  assert.equal(
    pairingCode(
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
      'desktop-nonce',
      'phone-nonce',
    ),
    '888618',
  )
})
