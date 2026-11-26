import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { fromBase64Url, toBase64Url } from './encoding.ts'
import { keysFromSecret, type PhoneKeys } from './keys.ts'

/**
 * Everything this phone keeps lives in the platform keychain/keystore and
 * never leaves the device: its private key, and the credential it was
 * issued when a desktop trusted it.
 */
const SECRET_KEY = 'navide.phone.secret'
const CREDENTIAL = 'navide.phone.credential'

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
}

export interface PairedDesktop {
  deviceId: string
  deviceName: string
  signingKey: string
}

export interface Credential {
  phoneId: string
  token: string
  desktops: PairedDesktop[]
}

export async function loadOrCreateKeys(): Promise<PhoneKeys> {
  const stored = await SecureStore.getItemAsync(SECRET_KEY, OPTIONS)
  if (stored) return keysFromSecret(fromBase64Url(stored))
  const secret = Crypto.getRandomBytes(32)
  await SecureStore.setItemAsync(SECRET_KEY, toBase64Url(secret), OPTIONS)
  return keysFromSecret(secret)
}

export function newNonce(): string {
  return toBase64Url(Crypto.getRandomBytes(16))
}

export async function loadCredential(): Promise<Credential | null> {
  const raw = await SecureStore.getItemAsync(CREDENTIAL, OPTIONS)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Credential
  } catch {
    return null
  }
}

export async function saveCredential(credential: Credential): Promise<void> {
  await SecureStore.setItemAsync(CREDENTIAL, JSON.stringify(credential), OPTIONS)
}

/** Used on unpair and when a desktop removes this phone. */
export async function clearCredential(): Promise<void> {
  await SecureStore.deleteItemAsync(CREDENTIAL, OPTIONS)
}
