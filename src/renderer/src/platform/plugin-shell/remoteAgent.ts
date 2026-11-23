/**
 * The agent key of a remote container pane (Settings → Experimental → Remote
 * container panes): claude or codex run over ssh inside a Docker container on
 * another machine. The CLI actually run there is the pane's `remote.cli`.
 *
 * Its own key so that nothing keyed on 'claude' or 'codex' — accounts, quota
 * failover, resume, session pins, model flags — ever applies to a CLI whose
 * login, sessions and usage live in the container. The backend uses the same
 * key and keeps it out of its vendor registry for the same reason.
 *
 * Deliberately NOT a file under agents/: that directory is the vendor list.
 * Everything that enumerates spawnable vendors (the ＋ menu, Settings, the
 * spec assembly test, the backend's registry cross-check) reads it, and a
 * remote pane is opened only from its own setup dialog. Code that resolves a
 * live pane's spec by key looks this one up explicitly.
 */

import type { AgentSpec } from './agents/types'

export const REMOTE_AGENT_KEY = 'remote'

export const REMOTE_AGENT_SPEC = {
  agentKey: REMOTE_AGENT_KEY,
  label: 'Remote container',
  // The backend builds the ssh + docker exec line itself and ignores this.
  defaultCommand: '',
  hint: 'CLI in a remote container',
  // Both CLIs it can run (claude, codex) keep bracketed paste on.
  bracketedPaste: true,
  // Both queue text typed during a turn (see agents/claude.ts), so a message
  // is typed in mid-turn as it was when these panes ran under the CLI's own
  // key; the backend has no log reader in the container, so a turn end may
  // never be announced. turnEndInferredFromSilence stays unset on purpose:
  // inferring from silence types into a CLI mid tool call, or answers its
  // y/n prompt.
  acceptsMidTurnInput: true,
} as const satisfies AgentSpec
