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
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fsyncFileSync, syncDirectorySync } from './fsSync'
import { canonicalContractJson } from '../../shared/pluginDisclosure'

// The Developer Mode switch (DX report A2, card K4) and the developer folders
// the user consented to. The main process owns this file; inside Navide the
// renderer can only ask the main window's settings page to change it, so no
// plugin frame, sandboxed plugin backend or page script can turn it on. The
// file itself is unsigned and only shape-checked: any unsandboxed process of
// the same user, an agent CLI included, can write it to turn Developer Mode
// on and add a consented folder, without an activity log entry (disclosed in
// plugin-development-v2.md; Navide Guard grades an agent's write to it as
// critical where its hooks run; a signed consent is 0.2.27). Off by default:
// a missing or unreadable file means Developer Mode is off and no folder is
// loaded.
//
// A2-5 (DESIGN-A2 G5): with an integrity provider (Electron safeStorage in the
// app) Navide also keeps, in a file of its own, an HMAC of every entry it
// wrote. An entry it did not write (the switch turned on, a folder added or
// edited by another program) is disclosed and not used until the user turns
// the switch on or consents to the folder again in the main window. This does
// not block the program; it only means its edit is not taken as the user's
// consent. The store file keeps its 0.2.27 shape, so a downgrade reads it.
const DEVELOPER_MODE_FILE = '.navide-plugin-developer-mode.json'
const DEVELOPER_MODE_SIGNATURE_FILE = '.navide-plugin-developer-mode.sig.json'

/** Wraps the HMAC key at rest (Electron safeStorage in the app). Never the CLI
 * account credentials: this key is its own, in its own file. */
export interface DeveloperModeIntegrity {
  /** False where secure storage is unavailable: nothing is checked then. */
  readonly available: boolean
  encrypt(plain: string): string
  decrypt(enc: string): string
  /** Called once when a change made outside Navide is first seen. */
  onExternalChange?: (change: DeveloperModeExternalChange) => void
}

/** When Navide first saw entries it did not write. */
export interface DeveloperModeExternalChange {
  detectedAt: string
  /** The settings file's modification time then, when it could be read. */
  modifiedAt: string | null
}

interface PersistedSignature {
  schemaVersion: 1
  keyEnc: string
  /** HMACs of the entries Navide wrote: the switch when on, each folder. */
  macs: string[]
  externalChange: DeveloperModeExternalChange | null
}

interface Evaluated {
  state: PersistedDeveloperModeState
  enabledTrusted: boolean
  /** Indexes into `state.folders` of the entries Navide did not write. */
  untrusted: Set<number>
  externalChange: DeveloperModeExternalChange | null
}

/** One developer folder and the permission set the user consented to. The
 * consent is bound to the folder and the manifest's `permissions` and
 * `backend` declarations, not to file content, which changes all the time
 * during development. */
export interface DeveloperFolderConsent {
  path: string
  pluginId: string
  /** sha256 hex of the canonical `{permissions, backend}` of the manifest. */
  permissionsDigest: string
  consentedAt: string
}

interface PersistedDeveloperModeState {
  schemaVersion: 1
  enabled: boolean
  folders: DeveloperFolderConsent[]
}

const EMPTY: PersistedDeveloperModeState = { schemaVersion: 1, enabled: false, folders: [] }

function validFolder(value: unknown): value is DeveloperFolderConsent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const folder = value as Record<string, unknown>
  return (
    Object.keys(folder).length === 4 &&
    typeof folder.path === 'string' && folder.path.length > 0 &&
    typeof folder.pluginId === 'string' && folder.pluginId.length > 0 &&
    typeof folder.permissionsDigest === 'string' && /^[0-9a-f]{64}$/.test(folder.permissionsDigest) &&
    typeof folder.consentedAt === 'string'
  )
}

function readState(path: string): { state: PersistedDeveloperModeState; valid: boolean } {
  if (!existsSync(path)) return { state: EMPTY, valid: true }
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe developer mode store')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid state')
    const state = parsed as Record<string, unknown>
    if (
      state.schemaVersion !== 1 ||
      typeof state.enabled !== 'boolean' ||
      !Array.isArray(state.folders) ||
      !state.folders.every(validFolder)
    ) {
      throw new Error('invalid state')
    }
    return { state: { schemaVersion: 1, enabled: state.enabled, folders: state.folders as DeveloperFolderConsent[] }, valid: true }
  } catch {
    return { state: EMPTY, valid: false }
  }
}

/** What a developer folder's consent covers: its declared permissions and
 * backend, canonically encoded. Any change to either asks again. */
export function developerPermissionsDigest(manifest: { permissions?: unknown; backend?: unknown }): string {
  return createHash('sha256')
    .update(canonicalContractJson({ permissions: manifest.permissions ?? null, backend: manifest.backend ?? null }))
    .digest('hex')
}

const enabledEntry = (): string => JSON.stringify(['enabled', true])
const folderEntry = (folder: DeveloperFolderConsent): string =>
  JSON.stringify(['folder', folder.path, folder.pluginId, folder.permissionsDigest, folder.consentedAt])

function sameMac(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function readSignature(path: string): PersistedSignature | null {
  if (!existsSync(path)) return null
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('unsafe signature file')
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const change = parsed.externalChange as Record<string, unknown> | null
    return {
      schemaVersion: 1,
      keyEnc: typeof parsed.keyEnc === 'string' ? parsed.keyEnc : '',
      macs: Array.isArray(parsed.macs) ? parsed.macs.filter((mac): mac is string => typeof mac === 'string') : [],
      externalChange: change && typeof change === 'object' && typeof change.detectedAt === 'string'
        ? { detectedAt: change.detectedAt, modifiedAt: typeof change.modifiedAt === 'string' ? change.modifiedAt : null }
        : null,
    }
  } catch {
    // Unreadable is not "never signed": every entry is asked about again.
    return { schemaVersion: 1, keyEnc: '', macs: [], externalChange: null }
  }
}

export class PluginDeveloperModeStore {
  private readonly file: string
  private readonly signatureFile: string
  private unwrapped: { keyEnc: string; key: Buffer | null } | null = null

  constructor(private readonly root: string, private readonly integrity?: DeveloperModeIntegrity) {
    this.file = join(root, DEVELOPER_MODE_FILE)
    this.signatureFile = join(root, DEVELOPER_MODE_SIGNATURE_FILE)
  }

  /** The switch; off when the file is missing or unusable, or (G5) when
   * another program turned it on. */
  isEnabled(): boolean {
    const evaluated = this.evaluate()
    return evaluated.state.enabled && evaluated.enabledTrusted
  }

  setEnabled(enabled: boolean): void {
    const evaluated = this.evaluate()
    if ((evaluated.state.enabled && evaluated.enabledTrusted) === enabled) return
    this.write({ ...evaluated.state, enabled }, evaluated, { enabled: true })
  }

  /** The folders the user consented to in Navide. */
  folders(): DeveloperFolderConsent[] {
    const evaluated = this.evaluate()
    return evaluated.state.folders.filter((_, index) => !evaluated.untrusted.has(index)).map((folder) => ({ ...folder }))
  }

  folder(pluginId: string): DeveloperFolderConsent | undefined {
    return this.folders().find((folder) => folder.pluginId === pluginId)
  }

  /** G5: folder entries another program wrote. Never loaded; listed so the
   * user can consent to them again or remove them. */
  untrustedFolders(): DeveloperFolderConsent[] {
    const evaluated = this.evaluate()
    return evaluated.state.folders.filter((_, index) => evaluated.untrusted.has(index)).map((folder) => ({ ...folder }))
  }

  /** A folder entry for the id, consented in Navide or not. */
  anyFolder(pluginId: string): DeveloperFolderConsent | undefined {
    return this.folder(pluginId) ?? this.untrustedFolders().find((folder) => folder.pluginId === pluginId)
  }

  /** G5: when Navide first saw entries it did not write, while any is left. */
  externalChange(): DeveloperModeExternalChange | null {
    return this.evaluate().externalChange
  }

  /** Record (or replace) the consent for one plugin id's developer folder. */
  consent(folder: DeveloperFolderConsent): void {
    const evaluated = this.evaluate()
    const kept = evaluated.state.folders.filter((entry) => entry.pluginId !== folder.pluginId)
    this.write({ ...evaluated.state, folders: [...kept, { ...folder }] }, evaluated, { folder: { ...folder } })
  }

  forget(pluginId: string): void {
    const evaluated = this.evaluate()
    if (!evaluated.state.folders.some((entry) => entry.pluginId === pluginId)) return
    this.write(
      { ...evaluated.state, folders: evaluated.state.folders.filter((entry) => entry.pluginId !== pluginId) },
      evaluated,
      {},
    )
  }

  /** The HMAC key, unwrapped once per wrapped value; null when it cannot be. */
  private key(signature: PersistedSignature): Buffer | null {
    if (this.unwrapped?.keyEnc === signature.keyEnc) return this.unwrapped.key
    let key: Buffer | null = null
    try {
      const raw = Buffer.from(this.integrity!.decrypt(signature.keyEnc), 'base64')
      key = raw.length === 32 ? raw : null
    } catch {
      key = null
    }
    this.unwrapped = { keyEnc: signature.keyEnc, key }
    return key
  }

  private evaluate(): Evaluated {
    const state = this.read()
    const all: Evaluated = { state, enabledTrusted: true, untrusted: new Set(), externalChange: null }
    const integrity = this.integrity
    if (!integrity || !integrity.available) return all
    // Nothing to trust: no crypto is touched (Developer Mode never used).
    if (!state.enabled && state.folders.length === 0) {
      const signature = readSignature(this.signatureFile)
      if (signature?.externalChange) this.writeSignature({ ...signature, externalChange: null })
      return all
    }
    const signature = readSignature(this.signatureFile)
    if (!signature) {
      // A file from before 0.2.28: signed once as it is (disclosed).
      this.writeSignature(this.sign(state, new Set(), true, null))
      return all
    }
    const key = signature.keyEnc ? this.key(signature) : null
    const signed = (entry: string): boolean => {
      if (!key) return false
      const mac = createHmac('sha256', key).update(entry).digest('hex')
      return signature.macs.some((known) => sameMac(known, mac))
    }
    const enabledTrusted = !state.enabled || signed(enabledEntry())
    const untrusted = new Set<number>()
    state.folders.forEach((folder, index) => {
      if (!signed(folderEntry(folder))) untrusted.add(index)
    })
    if (enabledTrusted && untrusted.size === 0) {
      if (signature.externalChange) this.writeSignature({ ...signature, externalChange: null })
      return all
    }
    let change = signature.externalChange
    if (!change) {
      change = { detectedAt: new Date().toISOString(), modifiedAt: this.modifiedAt() }
      this.writeSignature({ ...signature, externalChange: change })
      try {
        integrity.onExternalChange?.(change)
      } catch (error) {
        console.warn('[plugins] Developer Mode external change was not recorded:', error)
      }
    }
    return { state, enabledTrusted, untrusted, externalChange: change }
  }

  private modifiedAt(): string | null {
    try {
      return lstatSync(this.file).mtime.toISOString()
    } catch {
      return null
    }
  }

  /** The signature of `state`: every entry trusted before, plus what this
   * write is the user's decision on. Entries another program wrote stay
   * unsigned. */
  private sign(
    state: PersistedDeveloperModeState,
    untrustedFolders: Set<DeveloperFolderConsent>,
    enabledTrusted: boolean,
    previous: PersistedSignature | null,
  ): PersistedSignature {
    const prior = previous?.keyEnc ? this.key(previous) : null
    const key = prior ?? randomBytes(32)
    const keyEnc = prior ? previous!.keyEnc : this.integrity!.encrypt(key.toString('base64'))
    if (!prior) this.unwrapped = { keyEnc, key }
    const mac = (entry: string): string => createHmac('sha256', key).update(entry).digest('hex')
    const macs = new Set<string>()
    if (state.enabled && enabledTrusted) macs.add(mac(enabledEntry()))
    for (const folder of state.folders) if (!untrustedFolders.has(folder)) macs.add(mac(folderEntry(folder)))
    const resolved = (!state.enabled || enabledTrusted) && state.folders.every((folder) => !untrustedFolders.has(folder))
    return { schemaVersion: 1, keyEnc, macs: [...macs], externalChange: resolved ? null : previous?.externalChange ?? null }
  }

  private read(): PersistedDeveloperModeState {
    const parsed = readState(this.file)
    if (!parsed.valid) console.warn(`[plugins] invalid Developer Mode settings at ${this.file}; Developer Mode is off`)
    return parsed.state
  }

  /** `decision` is what the user decided in this write (the switch, one
   * folder's consent); it is signed with every entry trusted before. */
  private write(
    state: PersistedDeveloperModeState,
    evaluated?: Evaluated,
    decision: { enabled?: true; folder?: DeveloperFolderConsent } = {},
  ): void {
    if (!this.integrity?.available || !evaluated) {
      this.writeAtomic(this.file, state)
      return
    }
    const untrusted = new Set(evaluated.state.folders.filter((_, index) => evaluated.untrusted.has(index)))
    const enabledTrusted = decision.enabled === true || evaluated.enabledTrusted
    const previous = readSignature(this.signatureFile)
    const next = this.sign(state, untrusted, enabledTrusted, previous)
    // Old and new entries are both signed while the two files change, so a
    // stop in between never reads as a change made outside Navide.
    const carried = previous && previous.keyEnc === next.keyEnc ? previous.macs : []
    this.writeSignature({ ...next, macs: [...new Set([...carried, ...next.macs])] })
    this.writeAtomic(this.file, state)
    this.writeSignature(next)
  }

  private writeSignature(signature: PersistedSignature): void {
    this.writeAtomic(this.signatureFile, signature)
  }

  private writeAtomic(file: string, value: unknown): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(temporary, 0o600)
      fsyncFileSync(temporary)
      renameSync(temporary, file)
      chmodSync(file, 0o600)
      syncDirectorySync(this.root)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

/** The digest a developer folder's native backend consent is bound to: the
 * folder and its consented permission set, never its content. Null for any
 * package that is not a consented developer folder. */
export function developerFolderBackendDigest(
  folders: readonly DeveloperFolderConsent[],
  spec: { pluginId: string; packageDir: string },
): string | null {
  const folder = folders.find((entry) => entry.pluginId === spec.pluginId && resolve(entry.path) === resolve(spec.packageDir))
  if (!folder) return null
  return createHash('sha256')
    .update(`developer-folder\u0000${resolve(folder.path)}\u0000${folder.permissionsDigest}`)
    .digest('hex')
}
