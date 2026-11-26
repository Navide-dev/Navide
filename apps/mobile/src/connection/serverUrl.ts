/**
 * Only an encrypted connection is accepted. A development build may also use
 * ws:// so it can reach a server running on the developer's own machine.
 */
export function isAllowedServerUrl(url: string, dev: boolean): boolean {
  return url.startsWith('wss://') || (dev && url.startsWith('ws://'))
}
