import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'

// Testplace (DX report §9.5) state the Registry does not keep for the App:
//
// - `joins`: how the user joined each test (a personal invite or a public
//   test code). The disclosure row says which review that means: an invite
//   build had the automated scan only; a public code had a light human review
//   of the code, never of the version.
// - `keptExpired` (D3): the user chose "Keep using (expired)" for this exact
//   artifact. Trust verification then skips the expiry check for that digest
//   only; a takedown, a revoked signer or any other failure still quarantines.
//
// A missing or unreadable file means no joins recorded and nothing kept.
const TESTPLACE_FILE = '.navide-testplace.json'

export type TestplaceJoinVia = 'invite' | 'code'

export interface TestplaceJoin {
  via: TestplaceJoinVia
  joinedAt: string
}

export interface TestplaceKeptExpired {
  artifactDigest: string
  expiresAt: string
  acceptedAt: string
}

interface PersistedTestplaceState {
  schemaVersion: 1
  joins: Record<string, TestplaceJoin>
  keptExpired: Record<string, TestplaceKeptExpired>
  /** S8 T-MED-1: versions the tester detail last listed as withdrawn. */
  withdrawn: Record<string, string[]>
}

const empty = (): PersistedTestplaceState => ({ schemaVersion: 1, joins: {}, keptExpired: {}, withdrawn: {} })

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readState(path: string): { state: PersistedTestplaceState; valid: boolean } {
  if (!existsSync(path)) return { state: empty(), valid: true }
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe testplace store')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.joins) || !isRecord(parsed.keptExpired)) {
      throw new Error('invalid state')
    }
    const state = empty()
    for (const [id, join] of Object.entries(parsed.joins)) {
      if (!isRecord(join) || (join.via !== 'invite' && join.via !== 'code') || typeof join.joinedAt !== 'string') {
        throw new Error('invalid state')
      }
      state.joins[id] = { via: join.via, joinedAt: join.joinedAt }
    }
    for (const [id, kept] of Object.entries(parsed.keptExpired)) {
      if (
        !isRecord(kept) ||
        typeof kept.artifactDigest !== 'string' ||
        typeof kept.expiresAt !== 'string' ||
        typeof kept.acceptedAt !== 'string'
      ) {
        throw new Error('invalid state')
      }
      state.keptExpired[id] = {
        artifactDigest: kept.artifactDigest,
        expiresAt: kept.expiresAt,
        acceptedAt: kept.acceptedAt,
      }
    }
    // Absent in a file written before S8: nothing withdrawn known yet.
    if (parsed.withdrawn !== undefined) {
      if (!isRecord(parsed.withdrawn)) throw new Error('invalid state')
      for (const [id, versions] of Object.entries(parsed.withdrawn)) {
        if (!Array.isArray(versions) || versions.some((v) => typeof v !== 'string')) throw new Error('invalid state')
        state.withdrawn[id] = [...versions] as string[]
      }
    }
    return { state, valid: true }
  } catch {
    return { state: empty(), valid: false }
  }
}

/** Which way a join token joins: `tpi_` is a personal invite, `tpc_` a public code. */
export function testplaceJoinVia(token: string): TestplaceJoinVia | null {
  if (token.startsWith('tpi_')) return 'invite'
  if (token.startsWith('tpc_')) return 'code'
  return null
}

export class PluginTestplaceStore {
  private readonly file: string

  constructor(private readonly root: string, private readonly now: () => Date = () => new Date()) {
    this.file = join(root, TESTPLACE_FILE)
  }

  private read(): PersistedTestplaceState {
    const parsed = readState(this.file)
    if (!parsed.valid) console.warn(`[plugins] invalid Testplace state at ${this.file}; ignoring it`)
    return parsed.state
  }

  joinVia(pluginId: string): TestplaceJoinVia | null {
    return this.read().joins[pluginId]?.via ?? null
  }

  recordJoin(pluginId: string, via: TestplaceJoinVia): void {
    if (!pluginId) throw new Error('invalid plugin id')
    const state = this.read()
    state.joins[pluginId] = { via, joinedAt: this.now().toISOString() }
    this.write(state)
  }

  /** True when the user chose to keep using exactly this expired artifact. */
  keepsExpired(pluginId: string, artifactDigest: string): boolean {
    return this.read().keptExpired[pluginId]?.artifactDigest === artifactDigest
  }

  keepExpired(pluginId: string, artifactDigest: string, expiresAt: string): void {
    if (!pluginId || !artifactDigest) throw new Error('invalid kept artifact')
    const state = this.read()
    state.keptExpired[pluginId] = { artifactDigest, expiresAt, acceptedAt: this.now().toISOString() }
    this.write(state)
  }

  /** True when the tester detail last listed this version as withdrawn. */
  isWithdrawn(pluginId: string, version: string): boolean {
    return this.read().withdrawn[pluginId]?.includes(version) === true
  }

  /** Record what the tester detail lists as withdrawn for this plugin (it replaces the last answer). */
  setWithdrawn(pluginId: string, versions: readonly string[]): void {
    const state = this.read()
    const next = [...new Set(versions)].sort()
    const current = state.withdrawn[pluginId] ?? []
    if (next.length === current.length && next.every((v, i) => v === current[i])) return
    if (next.length === 0) delete state.withdrawn[pluginId]
    else state.withdrawn[pluginId] = next
    this.write(state)
  }

  /** Forget the join only (leaving a test keeps an installed, kept build kept). */
  forgetJoin(pluginId: string): void {
    const state = this.read()
    if (!(pluginId in state.joins)) return
    delete state.joins[pluginId]
    this.write(state)
  }

  /** Forget everything about a plugin (it was removed). */
  forget(pluginId: string): void {
    const state = this.read()
    if (!(pluginId in state.joins) && !(pluginId in state.keptExpired) && !(pluginId in state.withdrawn)) return
    delete state.joins[pluginId]
    delete state.keptExpired[pluginId]
    delete state.withdrawn[pluginId]
    this.write(state)
  }

  private write(state: PersistedTestplaceState): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(temporary, 0o600)
      fsyncFileSync(temporary)
      renameSync(temporary, this.file)
      chmodSync(this.file, 0o600)
      syncDirectorySync(this.root)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
