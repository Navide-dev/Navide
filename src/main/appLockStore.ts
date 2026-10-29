// App Lock persistence: one owner-only JSON file in userData holding the
// settings and the PIN's scrypt hash. It stays on this machine — it is not a
// credential, is never synced and never touches the keychain.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'

import { APP_LOCK_IDLE_CHOICES, DEFAULT_APP_LOCK_SETTINGS, type AppLockSettings } from '../shared/appLock'

export const APP_LOCK_FILE = 'app-lock.json'

export interface PinRecord {
  kdf: 'scrypt'
  n: number
  r: number
  p: number
  salt: string
  hash: string
}

export interface AppLockDoc {
  v: 1
  settings: AppLockSettings
  pin: PinRecord | null
}

const SCRYPT = { n: 32768, r: 8, p: 1, keyLength: 32 }
// 128 * N * r is 32 MiB, exactly Node's default maxmem; leave headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024

function derive(pin: string, salt: Buffer, n: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pin, salt, keyLength, { N: n, r, p, maxmem: SCRYPT_MAXMEM }, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

export async function hashPin(pin: string): Promise<PinRecord> {
  const salt = randomBytes(16)
  const key = await derive(pin, salt, SCRYPT.n, SCRYPT.r, SCRYPT.p, SCRYPT.keyLength)
  return { kdf: 'scrypt', n: SCRYPT.n, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), hash: key.toString('base64') }
}

export async function verifyPin(pin: string, record: PinRecord): Promise<boolean> {
  const expected = Buffer.from(record.hash, 'base64')
  const key = await derive(pin, Buffer.from(record.salt, 'base64'), record.n, record.r, record.p, expected.length)
  return key.length === expected.length && timingSafeEqual(key, expected)
}

function isPinRecord(value: unknown): value is PinRecord {
  const v = value as Partial<PinRecord> | null
  return !!v && v.kdf === 'scrypt' && [v.n, v.r, v.p].every(x => Number.isInteger(x) && (x as number) > 0)
    && typeof v.salt === 'string' && typeof v.hash === 'string' && v.hash.length > 0
}

/** Keep only known, well-typed fields; anything else falls back to the default. */
export function sanitizeSettings(value: unknown): AppLockSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const d = DEFAULT_APP_LOCK_SETTINGS
  const bool = (key: keyof AppLockSettings): boolean => (typeof v[key] === 'boolean' ? (v[key] as boolean) : (d[key] as boolean))
  return {
    enabled: bool('enabled'),
    unlockMethod: v.unlockMethod === 'pin' || v.unlockMethod === 'system' ? v.unlockMethod : d.unlockMethod,
    idleMinutes: (APP_LOCK_IDLE_CHOICES as readonly number[]).includes(v.idleMinutes as number) ? (v.idleMinutes as number) : d.idleMinutes,
    lockOnScreenLock: bool('lockOnScreenLock'),
    lockOnSuspend: bool('lockOnSuspend'),
    lockOnStart: bool('lockOnStart'),
  }
}

export function readAppLockDoc(filePath: string): AppLockDoc {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<AppLockDoc>
    const pin = isPinRecord(raw.pin) ? raw.pin : null
    const settings = sanitizeSettings(raw.settings)
    // Without a PIN there is nothing to unlock with, so the lock cannot be on.
    return { v: 1, settings: pin ? settings : { ...settings, enabled: false }, pin }
  } catch {
    return { v: 1, settings: { ...DEFAULT_APP_LOCK_SETTINGS }, pin: null }
  }
}

/** Atomic write: sibling tmp + rename, so a crash can't truncate the file. */
export function writeAppLockDoc(filePath: string, doc: AppLockDoc): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = join(dirname(filePath), `.${APP_LOCK_FILE}.tmp`)
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, filePath)
  chmodSync(filePath, 0o600)
}
