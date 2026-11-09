/** A plugin's own secrets (API keys, tokens), declared with `secrets` in
 *  `permissions.system`. The Host encrypts each value with the operating
 *  system's secure storage and keeps it on this device only, keyed by the
 *  plugin id (not its version), so an update, a disable or a restart keeps it.
 *  Every plugin sees only its own names. Values never reach Navide Cloud, a
 *  settings export, a share bundle, Activity, a log, or an agent tool result.
 *
 *  When the system has no secure storage (for example a Linux desktop without
 *  a keyring), `set` and `get` answer `{ ok: false, code: 'SECRETS_UNAVAILABLE' }`
 *  and nothing is written in plain text. */

/** A secret name: letters, digits, `_`, `-` and `.`, 1–128 characters. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/
/** Longest value one secret may hold, in UTF-8 bytes. */
export const MAX_SECRET_VALUE_BYTES = 16 * 1024
/** Most secrets one plugin may keep. */
export const MAX_SECRETS_PER_PLUGIN = 64

export type SecretsUnavailable = { ok: false; code: 'SECRETS_UNAVAILABLE' }

export interface SecretsParams {
  'secrets.set': { name: string; value: string }
  'secrets.get': { name: string }
  'secrets.delete': { name: string }
  'secrets.list': Record<string, never>
}

export interface SecretsResults {
  'secrets.set': { ok: true } | SecretsUnavailable
  'secrets.get': { present: true; value: string } | { present: false } | SecretsUnavailable
  'secrets.delete': { ok: true }
  'secrets.list': { names: string[] }
}
