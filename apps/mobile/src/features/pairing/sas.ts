import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, fromBase64Url, toBase64Url, utf8 } from '../../identity/encoding.ts'

const SAS_DOMAIN = 'navide/mobile-pair/v1'
const PROOF_DOMAIN = 'navide/mobile-proof/v1'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** What the phone sends instead of the pairing code itself. */
export function codeHash(code: string): string {
  return hex(sha256(utf8(code)))
}

/**
 * Proves this phone read the QR code, for this phone's key and nonce, without
 * sending the code: the desktop recomputes it from the code it made.
 */
export function codeProof(code: string, phoneKey: string, phoneNonce: string): string {
  return toBase64Url(hmac(sha256, utf8(code), concatBytes(utf8(PROOF_DOMAIN), fromBase64Url(phoneKey), utf8(phoneNonce))))
}

/**
 * The six digits both screens show. They are derived from both public keys
 * and both nonces, so a relay that swapped the phone's key on the way to the
 * desktop makes the two screens disagree.
 */
export function pairingCode(
  desktopKey: string,
  phoneKey: string,
  desktopNonce: string,
  phoneNonce: string,
): string {
  const digest = sha256(
    concatBytes(
      utf8(SAS_DOMAIN),
      fromBase64Url(desktopKey),
      fromBase64Url(phoneKey),
      utf8(desktopNonce),
      utf8(phoneNonce),
    ),
  )
  const n = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0
  return String(n % 1_000_000).padStart(6, '0')
}

/** The exact bytes the desktop signs when the user presses "Trust". */
export function approvalMessage(desktopId: string, phoneKey: string, phoneNonce: string): Uint8Array {
  return utf8(`navide/mobile-approval/v1\n${desktopId}\n${phoneKey}\n${phoneNonce}`)
}
