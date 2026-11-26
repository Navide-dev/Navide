import { approvalMessage, codeHash, codeProof, pairingCode } from '../features/pairing/sas.ts'
import type { PairOffer } from '../features/pairing/offer.ts'
import { verify, type PhoneKeys } from '../identity/keys.ts'
import { newNonce, type Credential } from '../identity/store.ts'
import { pickPaneSummary, type DesktopRoster } from '../types/pane.ts'
import { reconnectDelay } from './backoff.ts'
import { Emitter } from './emitter.ts'
import { pairErrorCode } from './pairErrors.ts'
import { isAllowedServerUrl } from './serverUrl.ts'
import { PairError, type PairSession, type Transport, type TransportEvent } from './transport.ts'

/**
 * Heartbeat interval. It has to stay well under the idle timeout of the load
 * balancer in front of the server, or a quiet connection is cut silently.
 */
const HEARTBEAT_MS = 20_000
/** No frame at all for this long means the socket is dead even if open. */
const STALE_MS = 50_000
/** Close code the server uses after this phone was removed on a desktop. */
const CLOSE_REVOKED = 4401

type Frame = Record<string, unknown> & { type?: string }

function parseFrame(data: unknown): Frame | null {
  if (typeof data !== 'string') return null
  try {
    const f = JSON.parse(data)
    return f && typeof f === 'object' ? (f as Frame) : null
  } catch {
    return null
  }
}

function parseRoster(raw: unknown): DesktopRoster[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((d) => {
    if (!d || typeof d !== 'object') return []
    const r = d as Record<string, unknown>
    if (typeof r.deviceId !== 'string' || !Array.isArray(r.panes)) return []
    return [
      {
        deviceId: r.deviceId,
        deviceName: typeof r.deviceName === 'string' ? r.deviceName : r.deviceId,
        panes: r.panes.flatMap((p) => pickPaneSummary(p) ?? []),
      },
    ]
  })
}

export class ServerTransport implements Transport {
  private emitter = new Emitter()
  private socket: WebSocket | null = null
  private credential: Credential | null = null
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private lastFrameAt = 0

  constructor(private readonly url: string) {
    if (!isAllowedServerUrl(url, typeof __DEV__ !== 'undefined' && __DEV__)) {
      throw new Error('the Navide server address must use wss://')
    }
  }

  subscribe(listener: (event: TransportEvent) => void): () => void {
    return this.emitter.subscribe(listener)
  }

  async pair(offer: PairOffer, keys: PhoneKeys, deviceName: string): Promise<PairSession> {
    const phoneNonce = newNonce()
    const ws = new WebSocket(this.url)
    let settle: { resolve: (c: Credential) => void; reject: (e: PairError) => void } | null = null
    let accepted = false
    const approved = new Promise<Credential>((resolve, reject) => (settle = { resolve, reject }))
    approved.catch(() => {})

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'mobile.pair.redeem',
            codeHash: codeHash(offer.code),
            proof: codeProof(offer.code, keys.publicKey, phoneNonce),
            desktopId: offer.desktopId,
            phoneKey: keys.publicKey,
            phoneNonce,
            deviceName,
          }),
        )
      }
      ws.onerror = () => reject(new PairError('network'))
      ws.onclose = () => {
        reject(new PairError('network'))
        settle?.reject(new PairError('network'))
      }
      ws.onmessage = (msg) => {
        const f = parseFrame(msg.data)
        if (!f) return
        if (f.type === 'mobile.pair.pending') {
          accepted = true
          resolve()
        } else if (f.type === 'error') {
          const err = new PairError(pairErrorCode(f.code, accepted))
          reject(err)
          settle?.reject(err)
          ws.close()
        } else if (f.type === 'mobile.pair.rejected') {
          settle?.reject(new PairError('rejected'))
          ws.close()
        } else if (f.type === 'mobile.pair.approved') {
          const ok =
            typeof f.signature === 'string' &&
            verify(offer.desktopKey, approvalMessage(offer.desktopId, keys.publicKey, phoneNonce), f.signature)
          if (!ok || typeof f.token !== 'string' || typeof f.phoneId !== 'string') {
            settle?.reject(new PairError('bad-approval'))
          } else {
            settle?.resolve({
              phoneId: f.phoneId,
              token: f.token,
              desktops: [
                {
                  deviceId: offer.desktopId,
                  deviceName: typeof f.deviceName === 'string' ? f.deviceName : offer.desktopId,
                  signingKey: offer.desktopKey,
                },
              ],
            })
          }
          ws.close()
        }
      }
    })

    return {
      code: pairingCode(offer.desktopKey, keys.publicKey, offer.desktopNonce, phoneNonce),
      approved,
      cancel: () => ws.close(),
    }
  }

  connect(credential: Credential): void {
    this.credential = credential
    this.attempt = 0
    this.open()
  }

  disconnect(): void {
    this.credential = null
    this.teardown()
    this.emitter.emit({ type: 'state', state: 'offline' })
  }

  private open(): void {
    const credential = this.credential
    if (!credential) return
    this.teardown()
    this.emitter.emit({ type: 'state', state: this.attempt === 0 ? 'connecting' : 'reconnecting' })
    const ws = new WebSocket(this.url)
    this.socket = ws
    ws.onopen = () => {
      this.lastFrameAt = Date.now()
      ws.send(JSON.stringify({ type: 'mobile.hello', phoneId: credential.phoneId, token: credential.token }))
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastFrameAt > STALE_MS) ws.close()
        else ws.send(JSON.stringify({ type: 'ping' }))
      }, HEARTBEAT_MS)
    }
    ws.onmessage = (msg) => {
      this.lastFrameAt = Date.now()
      const f = parseFrame(msg.data)
      if (!f) return
      if (f.type === 'mobile.ready') {
        this.attempt = 0
        this.emitter.emit({ type: 'state', state: 'online' })
      } else if (f.type === 'mobile.roster') {
        this.emitter.emit({ type: 'roster', desktops: parseRoster(f.desktops) })
      } else if (f.type === 'mobile.revoked') {
        this.revoked()
      }
    }
    ws.onclose = (ev) => {
      if (this.socket !== ws) return
      if (ev.code === CLOSE_REVOKED) return this.revoked()
      this.scheduleReconnect()
    }
  }

  /** Called when the app returns to the foreground: skip the backoff wait. */
  resume(): void {
    if (this.credential && this.socket?.readyState !== WebSocket.OPEN) {
      this.attempt = 0
      this.open()
    }
  }

  private revoked(): void {
    this.credential = null
    this.teardown()
    this.emitter.emit({ type: 'revoked' })
  }

  private scheduleReconnect(): void {
    this.teardown()
    if (!this.credential) return
    this.emitter.emit({ type: 'state', state: 'reconnecting' })
    this.retryTimer = setTimeout(() => this.open(), reconnectDelay(this.attempt++))
  }

  private teardown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.retryTimer = null
    this.heartbeat = null
    const ws = this.socket
    this.socket = null
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close()
  }
}
