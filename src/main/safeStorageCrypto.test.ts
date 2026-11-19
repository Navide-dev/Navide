import { describe, expect, it } from 'vitest'
import { safeStorageCrypto } from './safeStorageCrypto'
import { fakeSafeStorage, legacyCiphertext } from './safeStorageCrypto.fake'

// Built at run time: never a literal secret in the repository.
const secret = (): string => ['fake', 'secret', String(Date.now())].join('-')

describe('safeStorageCrypto (async safeStorage adapter)', () => {
  it('decrypts a value an earlier build wrote with the synchronous encryptString', async () => {
    const fake = fakeSafeStorage()
    const value = secret()
    const stored = legacyCiphertext(fake, value)
    await expect(safeStorageCrypto(fake).decrypt(stored)).resolves.toBe(value)
  })

  it('writes the same format the synchronous API wrote (base64 of the ciphertext)', async () => {
    const fake = fakeSafeStorage()
    const value = secret()
    const written = await safeStorageCrypto(fake).encrypt(value)
    expect(written).toBe(legacyCiphertext(fake, value))
  })

  it('round-trips, and a damaged value rejects instead of returning text', async () => {
    const crypto = safeStorageCrypto(fakeSafeStorage())
    const value = secret()
    await expect(crypto.decrypt(await crypto.encrypt(value))).resolves.toBe(value)
    await expect(crypto.decrypt(Buffer.from('not ciphertext').toString('base64'))).rejects.toThrow()
  })

  it('is available only when the preconditions and safeStorage both say so', async () => {
    const fake = fakeSafeStorage()
    await expect(safeStorageCrypto(fake).available()).resolves.toBe(true)
    await expect(safeStorageCrypto(fake, () => false).available()).resolves.toBe(false)
    fake.asyncAvailable = false
    await expect(safeStorageCrypto(fake, () => true).available()).resolves.toBe(false)
  })
})
