import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import type { AsyncSecretCrypto } from './safeStorageCrypto'

/** Canonical key for a workspace path: resolve symlinks/worktrees when the path
 * exists and strip trailing separators, so trailing-slash or symlinked variants
 * of the same repo share one binding instead of silently missing it. */
function normalizeWorkspaceKey(workspacePath: string): string {
  const raw = String(workspacePath ?? '').trim()
  if (!raw) return ''
  let s = raw
  try {
    s = realpathSync.native(raw)
  } catch {
    // Path may not exist (e.g. a removed workspace) — fall back to the raw string.
  }
  return s.replace(/[/\\]+$/, '') || s
}

// Git account registry (main-owned): lets each workspace bind a distinct GitHub
// account's Personal Access Token, so pushes authenticate as the right account
// instead of fighting over the single host-keyed osxkeychain entry. Tokens are
// encrypted at rest via Electron safeStorage; the master key lives in the OS
// keychain, only the ciphertext is stored in this file.
//
// This module is deliberately electron-free: it takes the file path and a
// crypto provider as dependencies, so it can be unit-tested against a tmpdir
// with a fake crypto (the real safeStorage is injected from index.ts). Follows
// the same shape as health-timeout.ts / window-registry.ts.

/** Encrypt/decrypt provider — real impl wraps Electron safeStorage
 *  (safeStorageCrypto.ts). */
export type GitAccountCrypto = AsyncSecretCrypto

/** On-disk account record. `token` is never stored in plaintext. */
export interface StoredAccount {
  id: string
  label: string
  host: string
  username: string
  tokenEnc: string
  tokenLast4: string
}

/** Account shape returned to the renderer — carries no decryptable secret. */
export interface PublicAccount {
  id: string
  label: string
  host: string
  username: string
  tokenLast4: string
}

/** Decrypted credential handed to a git operation, in-memory only. */
export interface GitCredential {
  username: string
  token: string
  /** Canonical bare hostname the credential may answer for. */
  expectedHost: string
}

export interface GitAccountInput {
  label: string
  host: string
  username: string
  token: string
}

interface GitAccountsDoc {
  version: 1
  accounts: StoredAccount[]
  bindings: Record<string, string>
}

function emptyDoc(): GitAccountsDoc {
  return { version: 1, accounts: [], bindings: {} }
}

/**
 * Convert an account's host field to the one hostname representation used by
 * Git credential routing. Accounts deliberately identify a hostname, not a
 * URL authority: schemes, ports and paths would make credential destinations
 * ambiguous. WHATWG URL supplies lowercase + IDNA normalization; bracketed
 * IPv6 is retained in URL.hostname and is therefore compared consistently.
 */
export function normalizeGitAccountHost(value: string): string {
  const raw = String(value ?? '').trim()
  if (
    !raw ||
    raw !== value ||
    raw.normalize('NFKC') !== raw ||
    /[/?#@]/.test(raw)
  ) throw new Error('invalid Git host')
  const isBracketedIpv6 = /^\[[0-9a-fA-F:.]+\]$/.test(raw)
  if (!isBracketedIpv6 && raw.includes(':')) throw new Error('invalid Git host')
  try {
    const parsed = new URL(`https://${raw}`)
    if (
      !parsed.hostname ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) throw new Error('invalid Git host')
    return parsed.hostname
  } catch {
    throw new Error('invalid Git host')
  }
}

/** Raised when a mutation needs encryption but it is unavailable. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super('encryption-unavailable')
    this.name = 'EncryptionUnavailableError'
  }
}

export class GitAccountsStore {
  constructor(
    private readonly filePath: string,
    private readonly crypto: GitAccountCrypto
  ) {}

  available(): Promise<boolean> {
    return this.crypto.available()
  }

  list(): PublicAccount[] {
    return this.read().accounts.map(toPublic)
  }

  async add(input: GitAccountInput): Promise<PublicAccount> {
    await this.requireEncryption()
    const token = String(input.token ?? '')
    if (!token) throw new Error('empty token')
    const label = String(input.label ?? '').trim()
    const host = normalizeGitAccountHost(String(input.host ?? ''))
    const username = String(input.username ?? '').trim()
    const tokenEnc = await this.crypto.encrypt(token)
    // Read after the await, so a write made meanwhile is not lost.
    const doc = this.read()
    const account: StoredAccount = { id: randomUUID(), label, host, username, tokenEnc, tokenLast4: token.slice(-4) }
    doc.accounts.push(account)
    this.write(doc)
    return toPublic(account)
  }

  async update(id: string, patch: Partial<GitAccountInput>): Promise<void> {
    let tokenEnc: string | null = null
    if (patch.token !== undefined && patch.token !== '') {
      if (!this.read().accounts.some((a) => a.id === id)) throw new Error('account not found')
      await this.requireEncryption()
      tokenEnc = await this.crypto.encrypt(String(patch.token))
    }
    // Read after the await, so a write made meanwhile is not lost.
    const doc = this.read()
    const account = doc.accounts.find((a) => a.id === id)
    if (!account) throw new Error('account not found')
    if (patch.label !== undefined) account.label = String(patch.label).trim()
    if (patch.host !== undefined) account.host = normalizeGitAccountHost(String(patch.host))
    if (patch.username !== undefined) account.username = String(patch.username).trim()
    if (tokenEnc !== null) {
      account.tokenEnc = tokenEnc
      account.tokenLast4 = String(patch.token).slice(-4)
    }
    this.write(doc)
  }

  remove(id: string): void {
    const doc = this.read()
    doc.accounts = doc.accounts.filter((a) => a.id !== id)
    // Drop any workspace bindings that pointed at the deleted account.
    for (const [ws, accountId] of Object.entries(doc.bindings)) {
      if (accountId === id) delete doc.bindings[ws]
    }
    this.write(doc)
  }

  bind(workspacePath: string, accountId: string): void {
    const key = normalizeWorkspaceKey(workspacePath)
    if (!key) throw new Error('empty workspace path')
    const doc = this.read()
    if (!doc.accounts.some((a) => a.id === accountId)) throw new Error('account not found')
    // Drop any stale binding stored under the un-normalized raw path.
    const raw = String(workspacePath ?? '')
    if (raw !== key) delete doc.bindings[raw]
    doc.bindings[key] = accountId
    this.write(doc)
  }

  unbind(workspacePath: string): void {
    const doc = this.read()
    const key = normalizeWorkspaceKey(workspacePath)
    const raw = String(workspacePath ?? '')
    const removed = delete doc.bindings[key]
    const removedRaw = raw !== key ? delete doc.bindings[raw] : false
    if (removed || removedRaw) this.write(doc)
  }

  getBinding(workspacePath: string): string | null {
    const b = this.read().bindings
    return b[normalizeWorkspaceKey(workspacePath)] ?? b[String(workspacePath ?? '')] ?? null
  }

  /** Decrypt the token for the account bound to this workspace, if any. */
  async getCredentialForWorkspace(workspacePath: string): Promise<GitCredential | null> {
    const doc = this.read()
    // Prefer the normalized key; fall back to a legacy raw-path binding.
    const accountId =
      doc.bindings[normalizeWorkspaceKey(workspacePath)] ?? doc.bindings[String(workspacePath ?? '')]
    if (!accountId) return null
    const account = doc.accounts.find((a) => a.id === accountId)
    if (!account) return null
    try {
      return {
        username: account.username,
        token: await this.crypto.decrypt(account.tokenEnc),
        expectedHost: normalizeGitAccountHost(account.host),
      }
    } catch {
      // Decryption can fail if the keychain master key is gone (e.g. restored to
      // a new machine). Treat as unbound rather than crashing the git op.
      return null
    }
  }

  private async requireEncryption(): Promise<void> {
    if (!(await this.crypto.available())) throw new EncryptionUnavailableError()
  }

  /** Read the doc, tolerating a missing or corrupt file (→ empty). */
  private read(): GitAccountsDoc {
    let text: string | null = null
    try {
      text = readFileSync(this.filePath, 'utf-8')
    } catch {
      return emptyDoc()
    }
    try {
      const data = JSON.parse(text) as Partial<GitAccountsDoc>
      return {
        version: 1,
        accounts: Array.isArray(data?.accounts) ? (data.accounts as StoredAccount[]) : [],
        bindings:
          data?.bindings && typeof data.bindings === 'object'
            ? (data.bindings as Record<string, string>)
            : {}
      }
    } catch {
      return emptyDoc()
    }
  }

  /** Atomic write: sibling tmp + rename, so a crash can't truncate the store. */
  private write(doc: GitAccountsDoc): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = join(dirname(this.filePath), '.git-accounts.json.tmp')
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tmp, this.filePath)
    // mode only applies at creation; tighten files written by older builds
    // (and any stale tmp) on their first write after upgrade.
    chmodSync(this.filePath, 0o600)
  }
}

function toPublic(account: StoredAccount): PublicAccount {
  return {
    id: account.id,
    label: account.label,
    host: account.host,
    username: account.username,
    tokenLast4: account.tokenLast4
  }
}
