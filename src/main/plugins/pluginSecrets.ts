// A plugin's own secrets (`secrets` in permissions.system): API keys and
// tokens a Navide plugin keeps for itself. Each value is encrypted with
// Electron safeStorage (its master key lives in the OS keychain) and only the
// ciphertext is written, to <userData>/plugin-secrets/<pluginId>.json (0600,
// directory 0700). The file is keyed by plugin id, never by version, so an
// update, a disable or a re-enable keeps it; only an explicit clear (the user
// removing the plugin with its data, or plugins_disable with clear_secrets)
// deletes it.
//
// The file is also bound to the package's trust identity (secretsIdentity):
// the first write records it, and every later operation with another
// identity — the same id installed from another source or signed by another
// publisher key, or a developer folder — answers SECRETS_IDENTITY_MISMATCH,
// without reading, writing or deleting anything. Only the user's explicit
// clear (the remove dialog) deletes a mismatched file.
//
// The values never leave this device: this directory is outside every Navide
// Cloud sync scope, settings export and share bundle, Activity records only
// the address, nothing here logs, and agent tool results are redacted against
// the plugin's own values (redactSecretValues).
//
// This is not the CLI account credential vault and shares no code with it.
// Electron-free: the root and the crypto provider are injected, so it is
// tested against a tmpdir with a fake crypto.
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_SECRETS_PER_PLUGIN,
  MAX_SECRET_VALUE_BYTES,
  SECRET_NAME_PATTERN,
} from '../../../packages/plugin-contracts/src/secrets'

export type { PluginSecretsNotice } from '../../shared/pluginSecretsNotice'

export const SECRETS_METHODS = ['secrets.set', 'secrets.get', 'secrets.delete', 'secrets.list'] as const
/** Operations of the backend Bridge port `secrets`; same arguments and results. */
export const SECRETS_BRIDGE_OPERATIONS = ['set', 'get', 'delete', 'list'] as const
export type SecretsOperation = (typeof SECRETS_BRIDGE_OPERATIONS)[number]

/** The plugin id rule of the Manifest (and of plugins.call), so an id can
 *  never name a path outside the secrets directory. */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/

export interface PluginSecretsCrypto {
  /** Whether real encryption is usable (false for Linux's basic_text backend too). */
  readonly available: boolean
  encrypt(plain: string): string
  decrypt(enc: string): string
}

/** Too many secrets or a value too long: the capability's RESOURCE_LIMIT. */
export class PluginSecretsLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginSecretsLimitError'
  }
}

const UNAVAILABLE = Object.freeze({ ok: false, code: 'SECRETS_UNAVAILABLE' }) as {
  ok: false
  code: 'SECRETS_UNAVAILABLE'
}

const IDENTITY_MISMATCH = Object.freeze({ ok: false, code: 'SECRETS_IDENTITY_MISMATCH' }) as {
  ok: false
  code: 'SECRETS_IDENTITY_MISMATCH'
}

/** The trust identity a secrets file is bound to, from the installed
 *  package's source: one value for every Registry-reviewed or bundled copy
 *  (the Registry binds the id's namespace to its publisher), the publisher
 *  and key for a locally installed signed file, and a class of its own for an
 *  unsigned local file and for a developer folder. Null when the Host cannot
 *  tell, which makes every operation refuse. */
export function secretsIdentity(
  source: string | undefined,
  signer?: { publisherId: string; keyId: string } | null,
): string | null {
  switch (source) {
    case 'marketplace':
    case 'prerelease':
    case 'testplace':
    case 'factory-bundled':
      return 'registry'
    case 'local-signed':
      return signer ? `local-signed:${signer.publisherId}:${signer.keyId}` : null
    case 'local-unsigned':
      return 'local-unsigned'
    case 'developer-unpacked':
      return 'developer-unpacked'
    default:
      return null
  }
}

interface SecretsFile {
  schemaVersion: 1
  /** The package trust identity the secrets belong to (secretsIdentity). */
  identity?: string
  secrets: Record<string, string>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isSecretName(value: unknown): value is string {
  return typeof value === 'string' && SECRET_NAME_PATTERN.test(value)
}

export function secretsOperation(address: string): SecretsOperation | null {
  const operation = address.startsWith('secrets.') ? address.slice('secrets.'.length) : ''
  return (SECRETS_BRIDGE_OPERATIONS as readonly string[]).includes(operation) ? operation as SecretsOperation : null
}

/** Validate by operation name; shared by the view capability and the Bridge
 *  port so both refuse exactly the same requests. The size limit is checked
 *  when the value is stored (RESOURCE_LIMIT), not here. */
export function validateSecretsOperation(operation: string, value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const keys = Object.keys(value)
  switch (operation) {
    case 'set':
      return keys.length === 2 && isSecretName(value.name) && typeof value.value === 'string'
    case 'get':
    case 'delete':
      return keys.length === 1 && isSecretName(value.name)
    case 'list':
      return keys.length === 0
  }
  return false
}

export function validateSecretsRequest(address: string, value: unknown): value is Record<string, unknown> {
  const operation = secretsOperation(address)
  return operation !== null && validateSecretsOperation(operation, value)
}

export class PluginSecretStore {
  constructor(
    private readonly root: string,
    private readonly crypto: PluginSecretsCrypto,
  ) {}

  /** Run one validated operation for `pluginId` (always the Host binding's)
   *  as the installed package's trust `identity` (secretsIdentity). A file
   *  bound to another identity answers SECRETS_IDENTITY_MISMATCH and is left
   *  as it is; `onMismatch` is told so the user can be. */
  run(
    pluginId: string,
    identity: string | null,
    operation: SecretsOperation,
    args: Record<string, unknown>,
    onMismatch?: () => void,
  ): unknown {
    if (identity === null) return UNAVAILABLE
    const stored = this.read(pluginId).identity
    if (stored !== undefined && stored !== identity) {
      onMismatch?.()
      return IDENTITY_MISMATCH
    }
    switch (operation) {
      case 'set': return this.set(pluginId, String(args.name), String(args.value), identity)
      case 'get': return this.get(pluginId, String(args.name))
      case 'delete': return this.delete(pluginId, String(args.name))
      case 'list': return this.list(pluginId)
    }
  }

  /** Whether the stored secrets belong to another identity than `identity`. */
  identityMismatch(pluginId: string, identity: string | null): boolean {
    const stored = this.read(pluginId).identity
    return stored !== undefined && stored !== identity
  }

  set(pluginId: string, name: string, value: string, identity?: string): { ok: true } | typeof UNAVAILABLE {
    if (!this.crypto.available) return UNAVAILABLE
    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
      throw new PluginSecretsLimitError(`a secret value is at most ${MAX_SECRET_VALUE_BYTES} bytes`)
    }
    const file = this.read(pluginId)
    // The first write binds the file to the package's trust identity.
    if (file.identity === undefined && identity !== undefined) file.identity = identity
    if (!Object.hasOwn(file.secrets, name) && Object.keys(file.secrets).length >= MAX_SECRETS_PER_PLUGIN) {
      throw new PluginSecretsLimitError(`a plugin keeps at most ${MAX_SECRETS_PER_PLUGIN} secrets`)
    }
    file.secrets[name] = this.crypto.encrypt(value)
    this.write(pluginId, file)
    return { ok: true }
  }

  get(pluginId: string, name: string): { present: true; value: string } | { present: false } | typeof UNAVAILABLE {
    if (!this.crypto.available) return UNAVAILABLE
    const encrypted = this.read(pluginId).secrets[name]
    if (typeof encrypted !== 'string') return { present: false }
    try {
      return { present: true, value: this.crypto.decrypt(encrypted) }
    } catch {
      // The keychain key changed or the entry is damaged: never plaintext.
      return UNAVAILABLE
    }
  }

  delete(pluginId: string, name: string): { ok: true } {
    const file = this.read(pluginId)
    if (Object.hasOwn(file.secrets, name)) {
      delete file.secrets[name]
      this.write(pluginId, file)
    }
    return { ok: true }
  }

  list(pluginId: string): { names: string[] } {
    return { names: Object.keys(this.read(pluginId).secrets).sort() }
  }

  /** How many secrets the plugin keeps (the remove dialog asks only then). */
  count(pluginId: string): number {
    return Object.keys(this.read(pluginId).secrets).length
  }

  /** Delete every secret of the plugin. */
  clear(pluginId: string): void {
    rmSync(this.path(pluginId), { force: true })
  }

  /** The plugin's decrypted values, for redacting agent tool results only.
   *  Never returned to any caller. */
  values(pluginId: string): string[] {
    if (!this.crypto.available) return []
    const values: string[] = []
    for (const encrypted of Object.values(this.read(pluginId).secrets)) {
      try {
        values.push(this.crypto.decrypt(encrypted))
      } catch {
        // A value that cannot be decrypted cannot have been handed out either.
      }
    }
    return values
  }

  private path(pluginId: string): string {
    if (!PLUGIN_ID_PATTERN.test(pluginId)) throw new Error('invalid plugin id')
    return join(this.root, `${pluginId}.json`)
  }

  private read(pluginId: string): SecretsFile {
    const path = this.path(pluginId)
    if (!existsSync(path)) return { schemaVersion: 1, secrets: {} }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      !isPlainObject(parsed) || parsed.schemaVersion !== 1 || !isPlainObject(parsed.secrets) ||
      (parsed.identity !== undefined && (typeof parsed.identity !== 'string' || parsed.identity.length === 0)) ||
      !Object.entries(parsed.secrets).every(([name, value]) => isSecretName(name) && typeof value === 'string')
    ) {
      throw new Error('plugin secrets file is damaged')
    }
    return {
      schemaVersion: 1,
      ...(typeof parsed.identity === 'string' ? { identity: parsed.identity } : {}),
      secrets: { ...(parsed.secrets as Record<string, string>) },
    }
  }

  private write(pluginId: string, file: SecretsFile): void {
    const path = this.path(pluginId)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(this.root, 0o700)
    if (Object.keys(file.secrets).length === 0) {
      rmSync(path, { force: true })
      return
    }
    const temporary = join(this.root, `.${pluginId}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, JSON.stringify(file), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }
}

const REDACTED = '[secret redacted]'

/** Replace every occurrence of any of `values` inside the strings (keys and
 *  values) of a JSON-shaped answer, so an agent tool result (or its error
 *  text) never carries one of the plugin's own secrets. Returns the answer
 *  unchanged (the same object) when it holds none. */
export function redactSecretValues<T>(answer: T, values: readonly string[]): T {
  const needles = values.filter((value) => value.length > 0).sort((left, right) => right.length - left.length)
  if (needles.length === 0) return answer
  let changed = false
  const redactString = (text: string): string => {
    let result = text
    for (const needle of needles) {
      if (result.includes(needle)) {
        result = result.split(needle).join(REDACTED)
        changed = true
      }
    }
    return result
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactString(value)
    if (Array.isArray(value)) return value.map(walk)
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactString(key), walk(item)]))
    }
    return value
  }
  const redacted = walk(answer)
  return changed ? redacted as T : answer
}
