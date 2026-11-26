import { pairingCode } from '../features/pairing/sas.ts'
import type { PairOffer } from '../features/pairing/offer.ts'
import type { PhoneKeys } from '../identity/keys.ts'
import { newNonce, type Credential } from '../identity/store.ts'
import type { DesktopRoster, PaneSummary } from '../types/pane.ts'
import { Emitter } from './emitter.ts'
import { PairError, type PairSession, type Transport, type TransportEvent } from './transport.ts'

/**
 * A stand-in server for development: no network, fictional names. Pairing is
 * approved a few seconds after the code is shown, and pane states rotate so
 * the overview and the in-app notifications have something to show.
 *
 * Offer codes "rate-limited", "expired" and "rejected" exercise the error
 * screens.
 */
export const MOCK_OFFER: PairOffer = {
  desktopId: 'mock-desktop',
  desktopKey: 'A'.repeat(43),
  desktopNonce: 'mock-nonce',
  code: 'mock',
}

const SCRIPT: PaneSummary[][] = [
  [
    { name: 'Docs writer', agentKey: 'claude', status: 'running', awaitingKind: null, workspace: 'sample-app' },
    { name: 'API tests', agentKey: 'codex', status: 'idle', awaitingKind: null, workspace: 'sample-app' },
    { name: 'Refactor', agentKey: 'claude', status: 'running', awaitingKind: null, workspace: 'demo-site' },
  ],
  [
    { name: 'Docs writer', agentKey: 'claude', status: 'idle', awaitingKind: null, workspace: 'sample-app' },
    { name: 'API tests', agentKey: 'codex', status: 'running', awaitingKind: null, workspace: 'sample-app' },
    { name: 'Refactor', agentKey: 'claude', status: 'awaiting', awaitingKind: 'permission', workspace: 'demo-site' },
  ],
  [
    { name: 'Docs writer', agentKey: 'claude', status: 'running', awaitingKind: null, workspace: 'sample-app' },
    { name: 'API tests', agentKey: 'codex', status: 'awaiting', awaitingKind: 'question', workspace: 'sample-app' },
    { name: 'Refactor', agentKey: 'claude', status: 'running', awaitingKind: null, workspace: 'demo-site' },
  ],
]

export class MockTransport implements Transport {
  private emitter = new Emitter()
  private timer: ReturnType<typeof setInterval> | null = null
  private step = 0

  subscribe(listener: (event: TransportEvent) => void): () => void {
    return this.emitter.subscribe(listener)
  }

  async pair(offer: PairOffer, keys: PhoneKeys, _deviceName: string): Promise<PairSession> {
    await delay(400)
    if (offer.code === 'rate-limited') throw new PairError('rate-limited')
    if (offer.code === 'expired') throw new PairError('expired')
    let timer: ReturnType<typeof setTimeout> | undefined
    const approved = new Promise<Credential>((resolve, reject) => {
      timer = setTimeout(() => {
        if (offer.code === 'rejected') return reject(new PairError('rejected'))
        resolve({
          phoneId: 'mock-phone',
          token: 'mock',
          desktops: [{ deviceId: offer.desktopId, deviceName: 'Studio Mac', signingKey: offer.desktopKey }],
        })
      }, 4_000)
    })
    approved.catch(() => {})
    return {
      code: pairingCode(offer.desktopKey, keys.publicKey, offer.desktopNonce, newNonce()),
      approved,
      cancel: () => clearTimeout(timer),
    }
  }

  connect(credential: Credential): void {
    this.disconnect()
    this.emitter.emit({ type: 'state', state: 'connecting' })
    const deviceId = credential.desktops[0]?.deviceId ?? 'mock-desktop'
    const publish = () => {
      const roster: DesktopRoster[] = [{ deviceId, deviceName: 'Studio Mac', panes: SCRIPT[this.step % SCRIPT.length] }]
      this.step++
      this.emitter.emit({ type: 'roster', desktops: roster })
    }
    setTimeout(() => {
      this.emitter.emit({ type: 'state', state: 'online' })
      publish()
      this.timer = setInterval(publish, 6_000)
    }, 300)
  }

  disconnect(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  resume(): void {}

  /** Development only: behave as if the desktop removed this phone. */
  simulateRevoke(): void {
    this.disconnect()
    this.emitter.emit({ type: 'revoked' })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
