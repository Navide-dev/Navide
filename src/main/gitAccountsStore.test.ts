import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWindows } from '../shared/osplat'
import {
  GitAccountsStore,
  EncryptionUnavailableError,
  normalizeGitAccountHost,
  type GitAccountCrypto
} from './gitAccountsStore'
import { safeStorageCrypto } from './safeStorageCrypto'
import { fakeSafeStorage, legacyCiphertext } from './safeStorageCrypto.fake'

// Fake safeStorage: a reversible base64 codec, so tests exercise the store's
// encrypt/decrypt wiring without pulling in Electron (the real crypto is
// injected in index.ts). `available` is toggled to test the disabled path.
function fakeCrypto(available = true): GitAccountCrypto {
  return {
    available: async () => available,
    encrypt: async (plain: string) => Buffer.from(plain, 'utf-8').toString('base64'),
    decrypt: async (enc: string) => Buffer.from(enc, 'base64').toString('utf-8')
  }
}

describe('GitAccountsStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-accounts-'))
    file = join(dir, 'git-accounts.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips an account and never exposes the plaintext token in list()', async () => {
    const store = new GitAccountsStore(file, fakeCrypto())
    const added = await store.add({
      label: 'work',
      host: 'github.com',
      username: 'nt-nerdtechnic',
      token: 'ghp_secret1234' // gitleaks:allow — fixture token, not a real credential
    })
    expect(added.tokenLast4).toBe('1234')
    expect(added).not.toHaveProperty('token')
    expect(added).not.toHaveProperty('tokenEnc')

    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].username).toBe('nt-nerdtechnic')
    expect(JSON.stringify(listed)).not.toContain('ghp_secret1234')
  })

  it('decrypts the bound account credential for a workspace', async () => {
    const store = new GitAccountsStore(file, fakeCrypto())
    const account = await store.add({
      label: 'work',
      host: 'github.com',
      username: 'nt-nerdtechnic',
      token: 'ghp_secret1234' // gitleaks:allow — fixture token, not a real credential
    })
    store.bind('/Users/me/repo-a', account.id)

    expect(store.getBinding('/Users/me/repo-a')).toBe(account.id)
    expect(await store.getCredentialForWorkspace('/Users/me/repo-a')).toEqual({
      username: 'nt-nerdtechnic',
      token: 'ghp_secret1234', // gitleaks:allow — fixture token, not a real credential
      expectedHost: 'github.com',
    })
    // Unbound workspace → no credential, no throw.
    expect(await store.getCredentialForWorkspace('/Users/me/repo-b')).toBeNull()
  })

  it('canonicalizes a bound account host and rejects non-host destinations', async () => {
    const store = new GitAccountsStore(file, fakeCrypto())
    const account = await store.add({
      label: 'work',
      host: 'GITHUB.COM',
      username: 'u',
      token: 'tok-host',
    })
    expect(account.host).toBe('github.com')

    for (const host of [
      '',
      'https://github.com',
      'alice@github.com',
      'github.com/org/repo',
      'github.com:443',
      'github.com?query=value',
      'github.com#fragment',
    ]) {
      await expect(store.add({ label: 'bad', host, username: 'u', token: 'tok-host' })).rejects.toThrow()
    }
  })

  it('canonicalizes IDNA hostnames without accepting compatibility-character lookalikes', async () => {
    expect(normalizeGitAccountHost('bücher.example')).toBe('xn--bcher-kva.example')
    expect(normalizeGitAccountHost('xn--bcher-kva.example')).toBe('xn--bcher-kva.example')
    expect(() => normalizeGitAccountHost('ｇｉｔｈｕｂ．ｃｏｍ')).toThrow('invalid Git host')
  })

  it('normalizes trailing-slash workspace paths to the same binding', async () => {
    const store = new GitAccountsStore(file, fakeCrypto())
    const account = await store.add({ label: 'w', host: 'github.com', username: 'u', token: 'tok-1234' })
    // Bind with a trailing slash on a real dir; look up without one.
    store.bind(`${dir}/`, account.id)
    expect(store.getBinding(dir)).toBe(account.id)
    expect((await store.getCredentialForWorkspace(dir))?.token).toBe('tok-1234')
    // And unbind via the non-slash form clears it.
    store.unbind(dir)
    expect(store.getBinding(dir)).toBeNull()
  })

  it('still resolves a legacy raw-path binding via fallback', async () => {
    const account = await new GitAccountsStore(file, fakeCrypto()).add({
      label: 'w', host: 'github.com', username: 'u', token: 'tok-5678'
    })
    // Simulate a binding written by an older build under a non-normalized key.
    writeFileSync(
      file,
      JSON.stringify({ version: 1, accounts: JSON.parse(readFileSync(file, 'utf-8')).accounts, bindings: { '/legacy/ws/': account.id } }),
      'utf-8'
    )
    const store = new GitAccountsStore(file, fakeCrypto())
    expect((await store.getCredentialForWorkspace('/legacy/ws/'))?.token).toBe('tok-5678')
  })

  it('persists across store instances (same file)', async () => {
    const account = await new GitAccountsStore(file, fakeCrypto()).add({
      label: 'work',
      host: 'github.com',
      username: 'u',
      token: 'tok-abcd'
    })
    const reopened = new GitAccountsStore(file, fakeCrypto())
    expect(await reopened.getCredentialForWorkspace('/ws')).toBeNull()
    reopened.bind('/ws', account.id)
    expect((await reopened.getCredentialForWorkspace('/ws'))?.token).toBe('tok-abcd')
  })

  it('re-encrypts the token on update and leaves it out when omitted', async () => {
    const store = new GitAccountsStore(file, fakeCrypto())
    const account = await store.add({ label: 'a', host: 'github.com', username: 'u', token: 'old-1111' })
    store.bind('/ws', account.id)

    await store.update(account.id, { label: 'renamed' })
    expect(store.list()[0].label).toBe('renamed')
    expect((await store.getCredentialForWorkspace('/ws'))?.token).toBe('old-1111')

    await store.update(account.id, { token: 'new-2222' })
    expect((await store.getCredentialForWorkspace('/ws'))?.token).toBe('new-2222')
    expect(store.list()[0].tokenLast4).toBe('2222')
  })

  it('removing an account drops its workspace bindings', async () => {
    const store = new GitAccountsStore(file, fakeCrypto())
    const account = await store.add({ label: 'a', host: 'github.com', username: 'u', token: 'tok-9999' })
    store.bind('/ws', account.id)

    store.remove(account.id)
    expect(store.list()).toHaveLength(0)
    expect(store.getBinding('/ws')).toBeNull()
    expect(await store.getCredentialForWorkspace('/ws')).toBeNull()
  })

  it('rejects binding to a non-existent account', async () => {
    const store = new GitAccountsStore(file, fakeCrypto())
    expect(() => store.bind('/ws', 'nope')).toThrow(/account not found/)
  })

  it('refuses to add when encryption is unavailable', async () => {
    const store = new GitAccountsStore(file, fakeCrypto(false))
    await expect(store.available()).resolves.toBe(false)
    await expect(store.add({ label: 'a', host: 'github.com', username: 'u', token: 't' })).rejects.toThrow(
      EncryptionUnavailableError
    )
  })

  it('writes the store file with 0600 permissions, tightening an existing lax file', async () => {
    // Simulate a file left behind by an older build with default permissions.
    writeFileSync(file, JSON.stringify({ version: 1, accounts: [], bindings: {} }), 'utf-8')
    chmodSync(file, 0o644)
    const store = new GitAccountsStore(file, fakeCrypto())
    await store.add({ label: 'a', host: 'github.com', username: 'u', token: 'tok-0600' })
    // NTFS has no POSIX mode bits: chmod is a no-op there and stat reports 0666.
    if (!isWindows()) expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('survives a corrupt file on disk (→ empty store)', async () => {
    writeFileSync(file, '{truncated', 'utf-8')
    const store = new GitAccountsStore(file, fakeCrypto())
    expect(store.list()).toEqual([])
    expect(await store.getCredentialForWorkspace('/ws')).toBeNull()
  })

  it('keeps tokens it can no longer decrypt (Linux keyring downgrade) and accepts a re-entered one', async () => {
    const before = new GitAccountsStore(file, fakeCrypto())
    const account = await before.add({
      label: 'work',
      host: 'github.com',
      username: 'nt-nerdtechnic',
      token: 'ghp_secret1234' // gitleaks:allow — fixture token, not a real credential
    })
    before.bind('/ws', account.id)
    const onDisk = readFileSync(file, 'utf-8')

    // Same file, but the keyring-backed key is gone: every decrypt throws.
    const downgraded = new GitAccountsStore(file, {
      ...fakeCrypto(),
      decrypt: async () => {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      }
    })
    expect(downgraded.list()).toEqual([before.list()[0]])
    expect(downgraded.getBinding('/ws')).toBe(account.id)
    expect(await downgraded.getCredentialForWorkspace('/ws')).toBeNull()
    expect(readFileSync(file, 'utf-8')).toBe(onDisk)

    await downgraded.update(account.id, { token: 'ghp_fresh5678' }) // gitleaks:allow — fixture token
    const repaired = new GitAccountsStore(file, fakeCrypto())
    expect((await repaired.getCredentialForWorkspace('/ws'))?.token).toBe('ghp_fresh5678')
    expect(repaired.list()[0].tokenLast4).toBe('5678')
  })
})

describe('GitAccountsStore upgrade from the synchronous safeStorage API', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-accounts-upgrade-'))
    file = join(dir, 'git-accounts.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a token an earlier build wrote with encryptString, and leaves the file as it was', async () => {
    const fake = fakeSafeStorage()
    const token = ['tok', 'legacy', String(process.pid)].join('-')
    const onDisk = JSON.stringify({
      version: 1,
      accounts: [{ id: 'a1', label: 'work', host: 'github.com', username: 'u', tokenEnc: legacyCiphertext(fake, token), tokenLast4: token.slice(-4) }],
      bindings: { '/ws': 'a1' },
    })
    writeFileSync(file, onDisk, 'utf-8')

    const store = new GitAccountsStore(file, safeStorageCrypto(fake))
    expect(store.list()).toEqual([{ id: 'a1', label: 'work', host: 'github.com', username: 'u', tokenLast4: token.slice(-4) }])
    await expect(store.getCredentialForWorkspace('/ws')).resolves.toEqual({ username: 'u', token, expectedHost: 'github.com' })
    expect(readFileSync(file, 'utf-8')).toBe(onDisk)
  })

  it('writes what an earlier build can still read back the same way', async () => {
    const fake = fakeSafeStorage()
    const token = ['tok', 'new', String(process.pid)].join('-')
    const store = new GitAccountsStore(file, safeStorageCrypto(fake))
    await store.add({ label: 'w', host: 'github.com', username: 'u', token })
    const stored = JSON.parse(readFileSync(file, 'utf-8')).accounts[0].tokenEnc
    expect(stored).toBe(legacyCiphertext(fake, token))
  })
})
