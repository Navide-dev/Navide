import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { fromBase64Url, toBase64Url } from './encoding.ts'

ed.hashes.sha512 = sha512

export interface PhoneKeys {
  secretKey: Uint8Array
  publicKey: string
}

/** `secretKey` must come from a CSPRNG (expo-crypto on device). */
export function keysFromSecret(secretKey: Uint8Array): PhoneKeys {
  return { secretKey, publicKey: toBase64Url(ed.getPublicKey(secretKey)) }
}

export function sign(keys: PhoneKeys, message: Uint8Array): string {
  return toBase64Url(ed.sign(message, keys.secretKey))
}

export function verify(publicKey: string, message: Uint8Array, signature: string): boolean {
  try {
    return ed.verify(fromBase64Url(signature), message, fromBase64Url(publicKey))
  } catch {
    return false
  }
}
