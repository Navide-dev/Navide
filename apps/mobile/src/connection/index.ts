import { MockTransport } from './mockTransport.ts'
import { ServerTransport } from './serverTransport.ts'
import type { Transport } from './transport.ts'

/**
 * Development defaults to the mock. The real server is used only when
 * EXPO_PUBLIC_NAVIDE_TRANSPORT=server and a server URL are both set.
 */
function createTransport(): Transport {
  const url = process.env.EXPO_PUBLIC_NAVIDE_SERVER_URL
  if (process.env.EXPO_PUBLIC_NAVIDE_TRANSPORT === 'server' && url) return new ServerTransport(url)
  return new MockTransport()
}

export const transport = createTransport()
export const isMock = transport instanceof MockTransport
