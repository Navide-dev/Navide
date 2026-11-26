import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codeHash, codeProof, pairingCode } from './sas.ts'

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

test('code proof matches the desktop test vector', () => {
  assert.equal(
    codeProof('one-time-code', 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8', 'phone-nonce'),
    'jGKtwg-i10QOa8Gjvuz2b5wPYccyYdz44ECVwOsuRTM',
  )
})

test('code hash is the hex sha256 of the code', () => {
  assert.equal(codeHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
