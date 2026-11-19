// Test-only stand-in for Electron's safeStorage. It models what the upgrade
// depends on: ciphertext the synchronous `encryptString` of an earlier build
// wrote must decrypt with `decryptStringAsync`. Both directions share one
// reversible codec behind a version prefix (like Chromium's `v10`), and a
// value without that prefix fails to decrypt, as a damaged entry does.
import type { AsyncSafeStorage } from './safeStorageCrypto'

const PREFIX = Buffer.from('v10')

function seal(plain: string): Buffer {
  const bytes = Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)
  return Buffer.concat([PREFIX, bytes])
}

function open(encrypted: Buffer): string {
  if (!encrypted.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
  return Buffer.from(encrypted.subarray(PREFIX.length).map((b) => b ^ 0x5a)).toString('utf8')
}

export interface FakeSafeStorage extends AsyncSafeStorage {
  /** The synchronous API an earlier build used to write its files. */
  encryptString(plain: string): Buffer
  asyncAvailable: boolean
  calls: { encrypt: number; decrypt: number }
}

export function fakeSafeStorage(asyncAvailable = true): FakeSafeStorage {
  const fake: FakeSafeStorage = {
    asyncAvailable,
    calls: { encrypt: 0, decrypt: 0 },
    encryptString: seal,
    isAsyncEncryptionAvailable: async () => fake.asyncAvailable,
    encryptStringAsync: async (plain) => {
      fake.calls.encrypt++
      return seal(plain)
    },
    decryptStringAsync: async (encrypted) => {
      fake.calls.decrypt++
      return { result: open(encrypted), shouldReEncrypt: false }
    },
  }
  return fake
}

/** A value as an earlier build persisted it: base64 of `encryptString`. */
export function legacyCiphertext(fake: FakeSafeStorage, plain: string): string {
  return fake.encryptString(plain).toString('base64')
}
