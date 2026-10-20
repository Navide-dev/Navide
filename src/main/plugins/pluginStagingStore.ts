// Staged package copies on disk (review MED-5 on W1 / S8 Q3). A package an
// agent asked to install (plugins_install_file_fill) or a form staged for
// publishing is read once; its bytes are written here under a random id with
// their SHA-256, and every later use re-reads the file and refuses it unless
// the digest still matches. Nothing is held in the main process's memory and
// there is no count limit: a copy goes when the user decides (`discard`) or
// when it expires (`ttlMs`), and an expired id is remembered so its form or
// card can say "expired" instead of failing.
//
// The folder lives under Navide's own data folder, where an agent tool cannot
// name a path (pluginLocalPackageTools' protected roots). A process of the
// same user can still write there, which the digest check turns into a
// refusal, never into installing other bytes.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const STAGED_FILE = /^[0-9a-f]{32}\.vsix(?:\.tmp)?$/
/** How long an expired id is remembered after its copy is gone. */
const EXPIRED_MEMORY_MS = 24 * 60 * 60 * 1000

export interface StagedEntry<M> {
  /** Null for an entry without bytes (a developer folder, loaded in place). */
  bytes: Uint8Array | null
  digest: string | null
  meta: M
}

export class PackageStagingStore<M> {
  private readonly entries = new Map<string, { digest: string | null; at: number; meta: M }>()
  private readonly expired = new Map<string, number>()

  /**
   * @param root folder for the staged files, created owner-only; leftovers of
   *   an earlier run are removed (their requests did not survive it).
   * @param expiredCode prefix of the error a late use of an expired id gets.
   */
  constructor(
    private readonly root: string,
    private readonly ttlMs: number,
    private readonly expiredCode: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    for (const name of readdirSync(root)) {
      if (STAGED_FILE.test(name)) rmSync(join(root, name), { force: true })
    }
  }

  private file(id: string): string {
    return join(this.root, `${id}.vsix`)
  }

  private drop(id: string): void {
    this.entries.delete(id)
    rmSync(this.file(id), { force: true })
  }

  /** Remove every expired copy now. */
  sweep(): void {
    const now = this.now()
    for (const [id, entry] of this.entries) {
      if (now - entry.at <= this.ttlMs) continue
      this.drop(id)
      this.expired.set(id, now)
    }
    for (const [id, at] of this.expired) if (now - at > EXPIRED_MEMORY_MS) this.expired.delete(id)
  }

  /** Keep `bytes` (or, with null, only `meta`); returns the id and the digest. */
  stage(bytes: Uint8Array | null, meta: M): { id: string; digest: string | null } {
    this.sweep()
    const id = randomBytes(16).toString('hex')
    let digest: string | null = null
    if (bytes !== null) {
      digest = createHash('sha256').update(bytes).digest('hex')
      const temporary = `${this.file(id)}.tmp`
      writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file(id))
    }
    this.entries.set(id, { digest, at: this.now(), meta })
    return { id, digest }
  }

  /** The metadata of a live entry, without reading its bytes. */
  peek(id: string): M | undefined {
    this.sweep()
    return this.entries.get(id)?.meta
  }

  /**
   * Re-read a staged copy and check its digest. Throws `<expiredCode>: …`
   * for an id that expired, and refuses (and drops) a copy whose bytes no
   * longer match what was staged. Undefined for an id never staged here.
   */
  take(id: string): StagedEntry<M> | undefined {
    this.sweep()
    const entry = this.entries.get(id)
    if (!entry) {
      if (this.expired.has(id)) throw new Error(`${this.expiredCode}: the staged package expired; ask again`)
      return undefined
    }
    if (entry.digest === null) return { bytes: null, digest: null, meta: entry.meta }
    let bytes: Uint8Array
    try {
      const fd = openSync(this.file(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
        bytes = new Uint8Array(readFileSync(fd))
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      this.drop(id)
      throw new Error(`STAGING_DIGEST_MISMATCH: the staged copy cannot be read (${error instanceof Error ? error.message : String(error)}); ask again`)
    }
    if (createHash('sha256').update(bytes).digest('hex') !== entry.digest) {
      this.drop(id)
      throw new Error('STAGING_DIGEST_MISMATCH: the staged copy changed on disk; nothing was used. Ask again')
    }
    return { bytes, digest: entry.digest, meta: entry.meta }
  }

  /** The user decided (or the copy was used): remove it now. */
  discard(id: string): void {
    if (this.entries.has(id)) this.drop(id)
  }
}
