// The one adapter from Electron's asynchronous safeStorage API to the
// encrypt/decrypt providers the main-process stores take (Git accounts,
// plugin secrets, the Marketplace developer vault, the Developer Mode HMAC
// key). Electron 45 deprecates the synchronous API and 46 removes it.
//
// The persisted format does not change: a value is the base64 of the
// safeStorage ciphertext, exactly as the synchronous API wrote it, and
// Electron documents that data encrypted with `encryptString` decrypts with
// `decryptStringAsync`, so files written by earlier builds read back as they
// are. `shouldReEncrypt` is not acted on: nothing is rewritten on read.
//
// Electron-free (the real `safeStorage` is injected from index.ts), so the
// stores and this adapter are tested with a fake.

/** The part of Electron's `safeStorage` this adapter uses. */
export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

/** What every store's crypto provider is. */
export interface AsyncSecretCrypto {
  /** Whether real encryption is usable now. */
  available(): Promise<boolean>
  /** Encrypt plaintext → base64 string safe to persist. */
  encrypt(plain: string): Promise<string>
  /** Decrypt a base64 string produced by encrypt() — or by the synchronous
   *  `encryptString` of an earlier build. */
  decrypt(enc: string): Promise<string>
}

/**
 * `usable` holds the synchronous preconditions a store adds on top of
 * safeStorage's own availability (app ready, no Linux basic_text backend…);
 * when it answers false, safeStorage is not asked.
 */
export function safeStorageCrypto(safeStorage: AsyncSafeStorage, usable: () => boolean = () => true): AsyncSecretCrypto {
  return {
    available: async () => usable() && (await safeStorage.isAsyncEncryptionAvailable()),
    encrypt: async (plain) => (await safeStorage.encryptStringAsync(plain)).toString('base64'),
    decrypt: async (enc) => (await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))).result,
  }
}
