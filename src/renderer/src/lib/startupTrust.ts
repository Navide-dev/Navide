/**
 * startupTrust.ts
 *
 * Accept a CLI's folder-trust prompt at launch, for the vendors that declare
 * one (`startupTrust` in agents/*.ts). Every pane Navide spawns gets this,
 * a resumed one included: Grok Build asks again whenever its trust store does
 * not know the folder, and a resumed pane with nobody answering held every
 * message on `pty-blocked` (issue #402).
 *
 * Reads the RENDERED screen, never the raw clean buffer: a resumed CLI replays
 * its transcript, and one that quotes the prompt must not be answered.
 * Kept free of App.vue state so it is unit-testable.
 */

import { AGENT_SPECS } from '@navide/plugin-shell'

const withoutTrailingSlash = (path: string): string => path.replace(/(.)\/+$/, '$1')

/** The keys that accept this vendor's trust prompt, while it is the live
 *  dialog on screen and asks about `folder` (the pane's workspace). Any other
 *  folder is left for the user to answer. */
export function startupTrustKeys(agentKey: string, screen: string, folder: string): string | null {
  const trust = AGENT_SPECS.find((s) => s.agentKey === agentKey)?.startupTrust
  if (!trust || !folder) return null
  const asked = trust.pattern.exec(screen.replace(/\s+/g, ' '))?.[1]
  return asked && withoutTrailingSlash(asked) === withoutTrailingSlash(folder) ? trust.keys : null
}

export interface StartupTrustDeps {
  readScreen: () => string
  /** The pane's monotonic output counter. */
  outputBytes: () => number
  alive: () => boolean
  send: (keys: string) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** How long to watch the first screen at all. */
  timeoutMs: number
  /** Output that has appeared and stayed quiet this long without the prompt
   *  means none is coming (dismissStartupDialog's NO_DIALOG_QUIET_MS). */
  quietMs: number
  /** The pane's workspace: the one folder whose prompt is accepted. */
  folder: string
}

/** Watch the pane's first screen and press the accept keys once if the trust
 *  prompt shows up. True when it pressed them. */
export async function acceptStartupTrust(agentKey: string, deps: StartupTrustDeps): Promise<boolean> {
  const deadline = deps.now() + deps.timeoutMs
  let lastBytes = -1
  let stableSince = deps.now()
  while (deps.now() < deadline) {
    if (!deps.alive()) return false
    const keys = startupTrustKeys(agentKey, deps.readScreen(), deps.folder)
    if (keys) {
      await deps.send(keys)
      return true
    }
    const bytes = deps.outputBytes()
    if (bytes !== lastBytes) {
      lastBytes = bytes
      stableSince = deps.now()
    } else if (bytes > 0 && deps.now() - stableSince >= deps.quietMs) {
      return false
    }
    await deps.sleep(250)
  }
  return false
}
