// Staged package copies on disk (review MED-5 on W1 / S8 Q3). A package an
// agent asked to install (plugins_install_file_fill) or a form staged for
// publishing is read once; its bytes are written here under a random id with
// their SHA-256, and every later use re-reads the file and refuses it unless
// the digest still matches. Nothing is held in the main process's memory and
// there is no count limit: a copy goes when the user decides (`discard`) or
// when it expires (`ttlMs`), and an expired id is remembered so its form or
// card can say "expired" instead of failing.
//
// Copies of the same bytes share one file (named by its digest, counted per
// entry), and no copy is written that would leave the disk with less than
// MIN_FREE_BYTES: such a request is refused with STAGING_DISK_LOW and nothing
// staged before it is touched. That protects the machine; it is not a quota.
//
// The folder lives under Navide's own data folder, where an agent tool cannot
// name a path (pluginLocalPackageTools' protected roots). A process of the
// same user can still write there, which the digest check turns into a
// refusal, never into installing other bytes.

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const STAGED_FILE = /^[0-9a-f]{64}\.vsix(?:\.[0-9a-f]{16}\.tmp)?$/
/** A staged write never leaves the disk with less free space than this. */
export const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024

const GIB = 1024 * 1024 * 1024
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(2)} GiB`

/** Free bytes for an unprivileged writer on the file system holding `path`. */
export function diskFreeBytes(path: string): number {
  const stat = statfsSync(path)
  return Number(stat.bavail) * Number(stat.bsize)
}
/** How long an expired or refused id is remembered after its copy is gone. */
const EXPIRED_MEMORY_MS = 24 * 60 * 60 * 1000
/** Expired copies are also removed on this timer, not only on the next use. */
export const SWEEP_INTERVAL_MS = 60 * 1000

const MISMATCH = 'STAGING_DIGEST_MISMATCH: the staged copy changed on disk; nothing was used. Ask again'

export interface StagedEntry<M> {
  /** Null for an entry without bytes (a developer folder, loaded in place). */
  bytes: Uint8Array | null
  digest: string | null
  meta: M
}

export class PackageStagingStore<M> {
  private readonly entries = new Map<string, { digest: string | null; at: number; meta: M }>()
  private readonly expired = new Map<string, number>()
  /** Entries per staged file, by digest. */
  private readonly references = new Map<string, number>()
  /** Ids whose shared file failed its digest check, so each says so on use. */
  private readonly refused = new Map<string, number>()
  private readonly timer: ReturnType<typeof setInterval>

  /**
   * @param root folder for the staged files, created owner-only on the first
   *   copy; when it already exists, an earlier run's leftovers are removed now
   *   (their requests did not survive it). A failing cleanup only warns.
   * @param expiredCode prefix of the error a late use of an expired id gets.
   * @param freeBytes the free space the disk check reads (tests inject it).
   */
  constructor(
    private readonly root: string,
    private readonly ttlMs: number,
    private readonly expiredCode: string,
    private readonly now: () => number = () => Date.now(),
    private readonly freeBytes: () => number = () => diskFreeBytes(root),
  ) {
    try {
      if (existsSync(root)) {
        for (const name of readdirSync(root)) {
          if (STAGED_FILE.test(name)) rmSync(join(root, name), { force: true })
        }
      }
    } catch (error) {
      console.warn(`[plugins] staged copies left by an earlier run were not removed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Unref'd: the sweep never keeps Navide from quitting.
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Stop the periodic sweep (tests, shutdown). */
  close(): void {
    clearInterval(this.timer)
  }

  private file(digest: string): string {
    return join(this.root, `${digest}.vsix`)
  }

  /** Forget an entry; its file goes with the last entry that used it. */
  private drop(id: string): void {
    const digest = this.entries.get(id)?.digest ?? null
    this.entries.delete(id)
    if (digest === null) return
    const left = (this.references.get(digest) ?? 1) - 1
    if (left > 0) {
      this.references.set(digest, left)
      return
    }
    this.references.delete(digest)
    rmSync(this.file(digest), { force: true })
  }

  /** Write a new staged file, refusing one that would leave too little disk. */
  private write(digest: string, bytes: Uint8Array): void {
    const lowDisk = (free: number): Error =>
      new Error(`STAGING_DISK_LOW: ${gib(free)} free on the disk holding Navide's data, and this package is ${gib(bytes.byteLength)}; ` +
        `Navide keeps at least ${gib(MIN_FREE_BYTES)} free, so nothing was staged. Free some space and ask again`)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const free = this.freeBytes()
    if (free - bytes.byteLength < MIN_FREE_BYTES) throw lowDisk(free)
    const temporary = `${this.file(digest)}.${randomBytes(8).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file(digest))
    } catch (error) {
      // Never leave half a copy behind.
      rmSync(temporary, { force: true })
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw lowDisk(this.freeBytes())
      throw error
    }
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
    for (const [id, at] of this.refused) if (now - at > EXPIRED_MEMORY_MS) this.refused.delete(id)
  }

  /** Keep `bytes` (or, with null, only `meta`); returns the id and the digest. */
  stage(bytes: Uint8Array | null, meta: M): { id: string; digest: string | null } {
    this.sweep()
    const id = randomBytes(16).toString('hex')
    let digest: string | null = null
    if (bytes !== null) {
      digest = createHash('sha256').update(bytes).digest('hex')
      // The same bytes already staged: share that file (rewritten if a
      // refused copy took it away meanwhile).
      if (!this.references.has(digest) || !existsSync(this.file(digest))) this.write(digest, bytes)
      this.references.set(digest, (this.references.get(digest) ?? 0) + 1)
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
      if (this.refused.has(id)) throw new Error(MISMATCH)
      return undefined
    }
    if (entry.digest === null) return { bytes: null, digest: null, meta: entry.meta }
    let bytes: Uint8Array
    try {
      const fd = openSync(this.file(entry.digest), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
        bytes = new Uint8Array(readFileSync(fd))
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      this.refuseDigest(entry.digest)
      throw new Error(`STAGING_DIGEST_MISMATCH: the staged copy cannot be read (${error instanceof Error ? error.message : String(error)}); ask again`)
    }
    if (createHash('sha256').update(bytes).digest('hex') !== entry.digest) {
      this.refuseDigest(entry.digest)
      throw new Error(MISMATCH)
    }
    return { bytes, digest: entry.digest, meta: entry.meta }
  }

  /** A shared file failed its check: it is bad for every entry using it.
   * All of them go (each says so on use) and so does the file, so the same
   * bytes staged again are written afresh. */
  private refuseDigest(digest: string): void {
    const now = this.now()
    for (const [id, entry] of this.entries) {
      if (entry.digest !== digest) continue
      this.entries.delete(id)
      this.refused.set(id, now)
    }
    this.references.delete(digest)
    rmSync(this.file(digest), { force: true })
  }

  /** The user decided (or the copy was used): remove it now. */
  discard(id: string): void {
    if (this.entries.has(id)) this.drop(id)
  }
}
