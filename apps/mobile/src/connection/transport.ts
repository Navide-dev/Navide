import type { Credential } from '../identity/store.ts'
import type { PhoneKeys } from '../identity/keys.ts'
import type { PairOffer } from '../features/pairing/offer.ts'
import type { DesktopRoster } from '../types/pane.ts'

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline'

export type TransportEvent =
  | { type: 'state'; state: ConnectionState }
  | { type: 'roster'; desktops: DesktopRoster[] }
  /** A desktop removed this phone. The app forgets its credential. */
  | { type: 'revoked' }

export type PairErrorCode =
  | 'rate-limited'
  | 'invalid-code'
  | 'expired'
  /** The request was not answered on the computer in time. */
  | 'timed-out'
  /** The computer the code came from is not online right now. */
  | 'desktop-offline'
  | 'rejected'
  | 'bad-approval'
  | 'network'

export class PairError extends Error {
  constructor(readonly code: PairErrorCode) {
    super(code)
  }
}

export interface PairSession {
  /** The six digits to compare with the desktop's screen. */
  code: string
  /** Resolves once the user presses "Trust" on the desktop. */
  approved: Promise<Credential>
  cancel(): void
}

export interface Transport {
  pair(offer: PairOffer, keys: PhoneKeys, deviceName: string): Promise<PairSession>
  connect(credential: Credential): void
  disconnect(): void
  subscribe(listener: (event: TransportEvent) => void): () => void
  /** The app came back to the foreground: reconnect now, without backoff. */
  resume(): void
  /**
   * Reserved for push notifications. Not implemented in this step: push
   * needs provider credentials on the server, which is pending a decision.
   */
  registerPushToken?(token: string, platform: 'ios' | 'android'): Promise<void>
}
