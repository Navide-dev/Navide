// Settings → General → Experimental features → "Remote container panes": a
// Claude/Codex pane that runs inside a Docker container on another machine,
// reached over ssh. Off unless the stored value is exactly true.
//
// The backend reads the same key and is where the switch takes effect: off,
// every remote_devcontainer.* request and every terminal.create carrying a
// `remote` object is refused (REMOTE_DISABLED). This ref only decides what the
// ＋ menu offers.
//
// The two lists kept beside it (recent targets, dismissed sign-in cards) hold
// host, container and CLI names only — never a key, a password, a network
// address or anything else read from the remote machine.
//
// Module-scoped ref, like useAcpPrefs: a second window flipping the switch
// repaints this one instead of leaving it on a stale copy.

import { ref } from 'vue'

import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

/** The key both sides agree on — see remote_devcontainer.SETTING_KEY. */
export const REMOTE_DEVCONTAINER_KEY = 'remoteDevcontainerExperimental'
export const REMOTE_RECENT_KEY = 'remoteDevcontainerRecent'
export const REMOTE_LOGIN_DONE_KEY = 'remoteDevcontainerLoginDone'
export const REMOTE_RECENT_MAX = 8
const REMOTE_LOGIN_DONE_MAX = 64

/** The CLIs a remote pane can run, with the product name the UI shows. */
export const REMOTE_AGENT_LABELS = { claude: 'Claude Code', codex: 'Codex CLI' } as const
export type RemoteAgentKey = keyof typeof REMOTE_AGENT_LABELS

export function isRemoteAgentKey(value: unknown): value is RemoteAgentKey {
  return value === 'claude' || value === 'codex'
}

/** How the container reaches this machine's tool server, as the list answered. */
export type RemoteNetwork = { mode: 'host' } | { mode: 'bridge'; gateway: string }

/** The `remote` object terminal.create takes. The pane's own agent key is
 *  'remote' (plugin-shell/remoteAgent.ts); `cli` is what runs in the container. */
export interface RemoteTarget {
  host: string
  container: string
  network: RemoteNetwork
  cli: RemoteAgentKey
}

/** One remembered target: names only. */
export interface RemoteRecent {
  host: string
  container: string
  agentKey: RemoteAgentKey
}

function loadEnabled(): boolean {
  return settingsGet<boolean>(REMOTE_DEVCONTAINER_KEY, false) === true
}

const remoteEnabled = ref<boolean>(loadEnabled())

onSettingsChanged((keys) => {
  if (keys.includes(REMOTE_DEVCONTAINER_KEY)) remoteEnabled.value = loadEnabled()
})

export function setRemoteDevcontainerEnabled(on: boolean): void {
  if (remoteEnabled.value === on) return
  remoteEnabled.value = on
  settingsSet(REMOTE_DEVCONTAINER_KEY, on)
}

export function useRemoteDevcontainerPrefs() {
  return { remoteEnabled }
}

/** Copies the three names and nothing else; null for a malformed row. */
function namesOnly(row: unknown): RemoteRecent | null {
  if (!row || typeof row !== 'object') return null
  const { host, container, agentKey } = row as Record<string, unknown>
  if (typeof host !== 'string' || !host || typeof container !== 'string' || !container) return null
  if (!isRemoteAgentKey(agentKey)) return null
  return { host, container, agentKey }
}

function loadList(key: string): RemoteRecent[] {
  const raw = settingsGet<unknown>(key, [])
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row) => {
    const clean = namesOnly(row)
    return clean ? [clean] : []
  })
}

function sameTarget(a: RemoteRecent, b: RemoteRecent): boolean {
  return a.host === b.host && a.container === b.container && a.agentKey === b.agentKey
}

/** Recently opened targets, newest first. */
export function loadRemoteRecent(): RemoteRecent[] {
  return loadList(REMOTE_RECENT_KEY)
}

export function rememberRemoteRecent(entry: RemoteRecent): void {
  const clean = namesOnly(entry)
  if (!clean) return
  const next = [clean, ...loadRemoteRecent().filter((r) => !sameTarget(r, clean))].slice(0, REMOTE_RECENT_MAX)
  settingsSet(REMOTE_RECENT_KEY, next)
}

/** Whether the sign-in card was dismissed for this host + container + CLI. */
export function isRemoteLoginDone(host: string, container: string, agentKey: string): boolean {
  return loadList(REMOTE_LOGIN_DONE_KEY).some((r) => r.host === host && r.container === container && r.agentKey === agentKey)
}

export function markRemoteLoginDone(host: string, container: string, agentKey: string): void {
  const clean = namesOnly({ host, container, agentKey })
  if (!clean || isRemoteLoginDone(host, container, agentKey)) return
  settingsSet(REMOTE_LOGIN_DONE_KEY, [...loadList(REMOTE_LOGIN_DONE_KEY), clean].slice(-REMOTE_LOGIN_DONE_MAX))
}
