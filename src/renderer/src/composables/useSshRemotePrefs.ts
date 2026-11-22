// SSH Remote panes (experimental, behind the same switch as remote container
// panes): the recent-connections list the setup dialog offers.
//
// Each row holds host, user, port and the private key's PATH — never the key
// itself, a passphrase or anything read from the remote machine. The list
// lives in ui_settings (this machine's app data); no sync scope, settings
// bundle or workspace backup reads this key.

import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'

export const SSH_REMOTE_RECENT_KEY = 'sshRemoteRecent'
export const SSH_REMOTE_RECENT_MAX = 8
export const SSH_DEFAULT_PORT = 22

/** One connection target, as the dialog sends it to `remote_ssh.connect`. */
export interface SshRemoteTarget {
  host: string
  user: string
  port: number
  /** Path to a private key on this machine; empty for ssh's own default. */
  keyPath: string
}

/** Copies the four fields and nothing else; null for a malformed row. */
export function sshTargetFields(row: unknown): SshRemoteTarget | null {
  if (!row || typeof row !== 'object') return null
  const { host, user, port, keyPath } = row as Record<string, unknown>
  if (typeof host !== 'string' || !host.trim()) return null
  const p = typeof port === 'number' ? port : Number(port)
  return {
    host: host.trim(),
    user: typeof user === 'string' ? user.trim() : '',
    port: Number.isInteger(p) && p >= 1 && p <= 65535 ? p : SSH_DEFAULT_PORT,
    keyPath: typeof keyPath === 'string' ? keyPath.trim() : '',
  }
}

function sameTarget(a: SshRemoteTarget, b: SshRemoteTarget): boolean {
  return a.host === b.host && a.user === b.user && a.port === b.port
}

/** Recently used targets, newest first. */
export function loadSshRemoteRecent(): SshRemoteTarget[] {
  const raw = settingsGet<unknown>(SSH_REMOTE_RECENT_KEY, [])
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row) => {
    const clean = sshTargetFields(row)
    return clean ? [clean] : []
  })
}

export function rememberSshRemoteRecent(entry: SshRemoteTarget): void {
  const clean = sshTargetFields(entry)
  if (!clean) return
  const next = [clean, ...loadSshRemoteRecent().filter((r) => !sameTarget(r, clean))].slice(0, SSH_REMOTE_RECENT_MAX)
  settingsSet(SSH_REMOTE_RECENT_KEY, next)
}

/** "user@host:port" for a recent-list row. */
export function sshTargetLabel(t: SshRemoteTarget): string {
  return `${t.user ? `${t.user}@` : ''}${t.host}${t.port === SSH_DEFAULT_PORT ? '' : `:${t.port}`}`
}
