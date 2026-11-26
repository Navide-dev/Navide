import { fromBase64Url } from '../../identity/encoding.ts'

/**
 * What the desktop's "Mobile App" page puts in its QR code. It carries no
 * account credential: a one-time code that expires within minutes, the
 * desktop's id, its public signing key and a nonce. The key arrives out of
 * band (the camera), so the relay cannot substitute it.
 */
export interface PairOffer {
  desktopId: string
  desktopKey: string
  desktopNonce: string
  code: string
}

const PREFIX = 'navide://pair?'

export function parseOffer(text: string): PairOffer | null {
  if (!text.startsWith(PREFIX)) return null
  const q = new URLSearchParams(text.slice(PREFIX.length))
  if (q.get('v') !== '1') return null
  const desktopId = q.get('d') ?? ''
  const desktopKey = q.get('k') ?? ''
  const desktopNonce = q.get('n') ?? ''
  const code = q.get('c') ?? ''
  if (!desktopId || !code || !desktopNonce) return null
  try {
    if (fromBase64Url(desktopKey).length !== 32) return null
  } catch {
    return null
  }
  return { desktopId, desktopKey, desktopNonce, code }
}
