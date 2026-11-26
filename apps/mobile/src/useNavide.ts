import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { transport } from './connection/index.ts'
import type { ConnectionState } from './connection/transport.ts'
import { diffRosters, type PaneEvent } from './features/notifications/events.ts'
import { clearCredential, loadCredential, saveCredential, type Credential } from './identity/store.ts'
import type { DesktopRoster } from './types/pane.ts'

const MAX_EVENTS = 100

export type Phase = 'loading' | 'unpaired' | 'paired'

/** App-wide state: the credential, the live roster and in-app notifications. */
export function useNavide() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [credential, setCredential] = useState<Credential | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('offline')
  const [roster, setRoster] = useState<DesktopRoster[]>([])
  const [events, setEvents] = useState<PaneEvent[]>([])
  const [latest, setLatest] = useState<PaneEvent | null>(null)
  const [revoked, setRevoked] = useState(false)
  const previous = useRef<DesktopRoster[] | null>(null)

  const forget = useCallback(async () => {
    transport.disconnect()
    await clearCredential()
    previous.current = null
    setCredential(null)
    setRoster([])
    setEvents([])
    setLatest(null)
    setPhase('unpaired')
  }, [])

  useEffect(() => {
    const off = transport.subscribe((event) => {
      if (event.type === 'state') {
        setConnection(event.state)
        // A fresh connection starts a fresh baseline, so a reconnect never
        // replays changes that happened while the phone was away.
        if (event.state !== 'online') previous.current = null
      } else if (event.type === 'roster') {
        const fresh = diffRosters(previous.current, event.desktops)
        previous.current = event.desktops
        setRoster(event.desktops)
        if (fresh.length) {
          setEvents((list) => [...fresh.reverse(), ...list].slice(0, MAX_EVENTS))
          setLatest(fresh[0])
        }
      } else if (event.type === 'revoked') {
        setRevoked(true)
        void forget()
      }
    })
    void loadCredential().then((c) => {
      if (c) {
        setCredential(c)
        setPhase('paired')
        transport.connect(c)
      } else setPhase('unpaired')
    })
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') transport.resume()
    })
    return () => {
      off()
      sub.remove()
    }
  }, [forget])

  const paired = useCallback(async (c: Credential) => {
    await saveCredential(c)
    setRevoked(false)
    setCredential(c)
    setPhase('paired')
    transport.connect(c)
  }, [])

  return {
    phase,
    credential,
    connection,
    roster,
    events,
    latest,
    revoked,
    paired,
    unpair: forget,
    dismissLatest: () => setLatest(null),
  }
}
