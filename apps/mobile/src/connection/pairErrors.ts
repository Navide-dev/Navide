import type { PairErrorCode } from './transport.ts'

const PAIR_ERRORS: Record<string, PairErrorCode> = {
  rate_limited: 'rate-limited',
  invalid_code: 'invalid-code',
  expired: 'expired',
  desktop_offline: 'desktop-offline',
}

/** An error frame as a pairing failure. `expired` after the request was
 *  accepted means nobody answered it on the computer, not a stale code. */
export function pairErrorCode(code: unknown, accepted: boolean): PairErrorCode {
  const mapped = PAIR_ERRORS[String(code)] ?? 'network'
  return mapped === 'expired' && accepted ? 'timed-out' : mapped
}
