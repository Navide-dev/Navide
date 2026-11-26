import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseOffer } from './offer.ts'

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'

test('parses a desktop pairing link', () => {
  assert.deepEqual(parseOffer(`navide://pair?v=1&d=dev-1&k=${KEY}&n=nonce&c=code`), {
    desktopId: 'dev-1',
    desktopKey: KEY,
    desktopNonce: 'nonce',
    code: 'code',
  })
})

test('refuses anything else', () => {
  assert.equal(parseOffer('https://example.com'), null)
  assert.equal(parseOffer(`navide://pair?v=2&d=dev-1&k=${KEY}&n=nonce&c=code`), null)
  assert.equal(parseOffer('navide://pair?v=1&d=dev-1&k=short&n=nonce&c=code'), null)
  assert.equal(parseOffer(`navide://pair?v=1&k=${KEY}&n=nonce&c=code`), null)
})
