import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { proveWindow } from './backend'
import { isTrustedPluginManagementSender } from './plugins/pluginIpc'

type Sender = Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>

/** The shape of the nonce the backend sends in `ws.welcome`. */
const WINDOW_CHALLENGE = /^[0-9a-f]{64}$/

/**
 * backend:proveWindow — sign a connection's window challenge, for a main
 * window only (the same top-level, live, registered check plugin management
 * uses). Anything else — a plugin frame or view, a webview, an aux window —
 * gets null and stays an ordinary ws client.
 */
export function answerWindowChallenge(
  event: Sender,
  nonce: unknown,
  mainWindows: ReadonlySet<BrowserWindow>,
  hostSessionToken: string | null,
): string | null {
  if (!isTrustedPluginManagementSender(event, mainWindows)) return null
  if (!hostSessionToken || typeof nonce !== 'string' || !WINDOW_CHALLENGE.test(nonce)) return null
  return proveWindow(hostSessionToken, nonce)
}
