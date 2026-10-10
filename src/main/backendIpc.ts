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

/**
 * backend:info — the full payload (including wsUrl, which carries the ws
 * token) for a Navide window main created: a top-level frame of a window in
 * one of `navideWindows` (main, detached, Plans, Token Monitor). A plugin
 * frame or view, a webview, or any other window gets only the status.
 */
export function backendInfoFor<T extends { status: string }>(
  event: Sender,
  navideWindows: ReadonlyArray<ReadonlySet<BrowserWindow>>,
  payload: T,
): T | { status: T['status'] } {
  if (navideWindows.some((windows) => isTrustedPluginManagementSender(event, windows))) return payload
  return { status: payload.status }
}

/**
 * Who gets a backend:changed push (the same payload as backend:info, wsUrl
 * included): the Navide windows main created, nothing else. Any other window
 * is not sent anything at all — it has no preload to receive it — and so
 * never enters the focus-gated queue either.
 */
export function backendChangedTargets(
  windows: readonly BrowserWindow[],
  navideWindows: ReadonlyArray<ReadonlySet<BrowserWindow>>,
): BrowserWindow[] {
  return windows.filter((win) => navideWindows.some((set) => set.has(win)))
}
