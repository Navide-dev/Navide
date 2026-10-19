// Navide Marketplace developer credentials, kept by the Host (plan
// mcp-navide-0-2-27, S4): the Registry tokens a developer sign-in returns
// (an account token, and a publisher token once the developer is approved) and
// the Ed25519 signing key Navide signs packages with.
//
// Secrets are encrypted at rest with Electron safeStorage (its master key lives
// in the OS keychain); only ciphertext is written to the file. Nothing here
// reads or writes the CLI account credentials, account switching or quota
// files: this is its own file and its own functions.
//
// Electron-free like gitAccountsStore.ts: the file path and the crypto provider
// are injected, so it is tested against a tmpdir with a fake crypto.
import { createHash, createPublicKey, generateKeyPairSync } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface DeveloperVaultCrypto {
  /** Whether real encryption is usable (false for Linux's basic_text backend too). */
  available: boolean
  encrypt(plain: string): string
  decrypt(enc: string): string
}

export type DeveloperTokenScope = 'account' | 'publisher'

interface StoredToken {
  tokenEnc: string
  expiresAt: string | null
}

interface StoredDeveloper {
  account?: StoredToken
  publisher?: StoredToken
  namespace?: string | null
  privateKeyEnc?: string
  publicKeyPem?: string
  /** The fingerprint the Registry reported once the public key was registered. */
  registeredFingerprint?: string | null
}

interface VaultDoc {
  version: 1
  registries: Record<string, StoredDeveloper>
}

/** What the renderer and the MCP status tools may see: no token, no key. */
export interface DeveloperPublicState {
  registry: string
  signedIn: { account: boolean; publisher: boolean }
  namespace: string | null
  tokenExpiresAt: { account: string | null; publisher: string | null }
  keyFingerprint: string | null
  keyRegistered: boolean
}

export class DeveloperVaultUnavailableError extends Error {
  constructor() {
    super('secure storage is unavailable on this system, so Navide cannot keep developer credentials')
    this.name = 'DeveloperVaultUnavailableError'
  }
}

/** sha256 of the SPKI DER, `SHA256:<base64>` like an SSH fingerprint. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return `SHA256:${createHash('sha256').update(der).digest('base64').replace(/=+$/, '')}`
}

function normalizeRegistry(registry: string): string {
  return registry.replace(/\/+$/, '')
}

function expired(token: StoredToken | undefined, now: number): boolean {
  if (!token?.expiresAt) return false
  const at = Date.parse(token.expiresAt)
  return Number.isFinite(at) && at <= now
}

export class DeveloperVault {
  constructor(
    private readonly filePath: string,
    private readonly crypto: DeveloperVaultCrypto,
    private readonly now: () => number = Date.now,
  ) {}

  get available(): boolean {
    return this.crypto.available
  }

  state(registry: string): DeveloperPublicState {
    const key = normalizeRegistry(registry)
    const entry = this.read().registries[key] ?? {}
    const now = this.now()
    const fingerprint = entry.publicKeyPem ? publicKeyFingerprint(entry.publicKeyPem) : null
    return {
      registry: key,
      signedIn: {
        account: !!entry.account && !expired(entry.account, now),
        publisher: !!entry.publisher && !expired(entry.publisher, now),
      },
      namespace: entry.namespace ?? null,
      tokenExpiresAt: { account: entry.account?.expiresAt ?? null, publisher: entry.publisher?.expiresAt ?? null },
      keyFingerprint: fingerprint,
      keyRegistered: fingerprint !== null && entry.registeredFingerprint === fingerprint,
    }
  }

  /** The token for `scope`, or null when there is none or it expired. Main-process use only. */
  token(registry: string, scope: DeveloperTokenScope): string | null {
    const entry = this.read().registries[normalizeRegistry(registry)]
    const stored = entry?.[scope]
    if (!stored || expired(stored, this.now())) return null
    return this.crypto.decrypt(stored.tokenEnc)
  }

  saveToken(
    registry: string,
    scope: DeveloperTokenScope,
    token: string,
    expiresAt: string | null,
    namespace: string | null,
  ): void {
    this.requireEncryption()
    if (!token) throw new Error('empty token')
    this.update(registry, (entry) => {
      entry[scope] = { tokenEnc: this.crypto.encrypt(token), expiresAt }
      if (scope === 'publisher') entry.namespace = namespace
    })
  }

  /** The signing key, created on first use (Ed25519, PKCS#8 / SPKI PEM). Main-process use only. */
  signingKey(registry: string): { privateKeyPem: string; publicKeyPem: string } {
    const entry = this.read().registries[normalizeRegistry(registry)]
    if (entry?.privateKeyEnc && entry.publicKeyPem) {
      return { privateKeyPem: this.crypto.decrypt(entry.privateKeyEnc), publicKeyPem: entry.publicKeyPem }
    }
    this.requireEncryption()
    const keys = generateKeyPairSync('ed25519')
    const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    this.update(registry, (stored) => {
      stored.privateKeyEnc = this.crypto.encrypt(privateKeyPem)
      stored.publicKeyPem = publicKeyPem
      stored.registeredFingerprint = null
    })
    return { privateKeyPem, publicKeyPem }
  }

  markKeyRegistered(registry: string, fingerprint: string): void {
    this.update(registry, (entry) => {
      entry.registeredFingerprint = fingerprint
    })
  }

  /** Forget the tokens; the signing key stays so a later sign-in keeps the same identity. */
  signOut(registry: string): void {
    this.update(registry, (entry) => {
      delete entry.account
      delete entry.publisher
      entry.namespace = null
    })
  }

  private requireEncryption(): void {
    if (!this.crypto.available) throw new DeveloperVaultUnavailableError()
  }

  private update(registry: string, change: (entry: StoredDeveloper) => void): void {
    const doc = this.read()
    const key = normalizeRegistry(registry)
    const entry = doc.registries[key] ?? {}
    change(entry)
    doc.registries[key] = entry
    this.write(doc)
  }

  private read(): VaultDoc {
    if (!existsSync(this.filePath)) return { version: 1, registries: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<VaultDoc>
      if (parsed?.version === 1 && parsed.registries && typeof parsed.registries === 'object') {
        return { version: 1, registries: parsed.registries }
      }
    } catch {
      // An unreadable file is treated as empty: the user signs in again.
    }
    return { version: 1, registries: {} }
  }

  private write(doc: VaultDoc): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(doc, null, 2), { mode: 0o600 })
    renameSync(temp, this.filePath)
  }
}
