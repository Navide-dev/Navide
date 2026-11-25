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
export const SSH_DEFAULT_DIR = '~'

/** What an SSH pane can run on the host: a login shell, or one of these CLIs
 *  (the backend's remote_ssh.CLI_COMMANDS). */
export const SSH_TERMINAL = 'terminal'
export const SSH_REMOTE_CLIS = [
  'claude', 'codex', 'aider', 'antigravity', 'copilot', 'cursor', 'devin', 'droid', 'goose', 'grok',
  'hermes', 'kilo', 'kimi', 'kiro', 'mcode', 'muse', 'openclaw', 'opencode', 'pi', 'qwen',
] as const
/** The CLIs that get Navide's tools on the host (remote_ssh.MCP_CLIS). */
export const SSH_MCP_CLIS: readonly string[] = ['claude', 'codex']
/** The CLIs whose remote session a reconnect or restore can resume. */
export const SSH_RESUMABLE_CLIS: readonly string[] = ['claude', 'codex']

/** One connection target, as the dialog sends it to `remote_ssh.connect`. */
export interface SshRemoteTarget {
  host: string
  user: string
  port: number
  /** Path to a private key on this machine; empty for ssh's own default. */
  keyPath: string
  /** The folder the pane starts in on the host; '~' (the default) is home. */
  dir?: string
  /** What runs there: SSH_TERMINAL (the default) or one of SSH_REMOTE_CLIS. */
  cli?: string
  /** The CLI's own session id on the host, once known ('' or absent before):
   *  a reconnect or restore resumes exactly this conversation. */
  sessionId?: string
  /** The tmux session the pane runs in on the host (`navide-` and hex, one
   *  per pane, chosen when the pane is first opened); a reconnect or restore
   *  attaches to it when the host has tmux. '' or absent: none. */
  tmuxSession?: string
  /** From the dialog only: the user ticked "run in tmux" (off by default).
   *  Never sent to the backend or recorded; tmuxSession is what is kept. */
  useTmux?: boolean
}

/** A new pane's tmux session name (remote_ssh._TMUX_SESSION_RE). */
export function newSshTmuxSession(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return 'navide-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A saved tmux session name, or '' for anything else. */
export function sshTmuxSessionField(value: unknown): string {
  return typeof value === 'string' && /^navide-[0-9a-f]{16,32}$/.test(value) ? value : ''
}

/** Copies the four fields and nothing else; null for a malformed row. */
export function sshTargetFields(row: unknown): SshRemoteTarget | null {
  if (!row || typeof row !== 'object') return null
  const { host, user, port, keyPath, dir, cli } = row as Record<string, unknown>
  if (typeof host !== 'string' || !host.trim()) return null
  const p = typeof port === 'number' ? port : Number(port)
  return {
    host: host.trim(),
    user: typeof user === 'string' ? user.trim() : '',
    port: Number.isInteger(p) && p >= 1 && p <= 65535 ? p : SSH_DEFAULT_PORT,
    keyPath: typeof keyPath === 'string' ? keyPath.trim() : '',
    dir: typeof dir === 'string' && dir.trim() ? dir.trim() : SSH_DEFAULT_DIR,
    cli: typeof cli === 'string' && (SSH_REMOTE_CLIS as readonly string[]).includes(cli) ? cli : SSH_TERMINAL,
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

/** Plain-language failure reasons `remote_ssh.connect` names (remote_ssh.REASONS). */
export const SSH_FAILURE_REASONS = ['unreachable', 'auth', 'host-key', 'other'] as const
export type SshFailureReason = (typeof SSH_FAILURE_REASONS)[number]

/** The reason of a failed `remote_ssh.connect` reply; 'other' for anything else. */
export function sshFailureReason(error: { code?: string; details?: unknown } | null | undefined): SshFailureReason {
  const reason = (error?.details as { reason?: unknown } | undefined)?.reason
  return error?.code === 'REMOTE_SSH_FAILED' && SSH_FAILURE_REASONS.includes(reason as SshFailureReason)
    ? (reason as SshFailureReason)
    : 'other'
}
