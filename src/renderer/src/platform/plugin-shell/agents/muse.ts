/**
 * Meta Muse Code — identity, spawn, permission bypass and resume.
 *
 * Meta's public documentation (https://dev.meta.ai/docs/muse-code/, checked
 * 2026-08-11) now covers permissions, interactive use and headless runs, so
 * the parts it pins down exactly are wired here: `muse resume <id>` is a
 * SUBCOMMAND (like codex's), and the approval layer has documented opt-out
 * flags.
 *
 * A log reader now exists (cli_vendors/muse.py, written against real session
 * files), so the two capabilities that depend on it are wired: the reader
 * binds a session to its pane through the `at-pane:` marker, which lands
 * verbatim in muse's command-intake record, and it discovers the session id
 * (the session DIRECTORY's name) that Rebuild needs.
 *
 * `turnEndInferredFromSilence` stays unset because it would be wrong: muse
 * writes an explicit `terminal` record and the reader emits turn_complete
 * only from it. `verifiedTurnText` also stays unset — the reader carries turn
 * text, which is enough for inter-CLI messaging, but per the types.ts note it
 * is deliberately withheld until the text has been validated against real
 * multi-turn sessions with a real provider (the samples this was built from
 * ran the `echo` provider). Paste protocol and login recovery stay unset:
 * neither is a reader question and neither has been observed.
 */

import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'muse',
  // Label, command, flags and resume arguments: the launch declaration.
  //
  // Effort values are from the binary's --help, which lists one more (`max`)
  // than the published configuration docs. Meta-hosted models reject `none`.
  //
  // Unattended: two documented ways to stop the prompting: `--yolo` drops
  // BOTH the approval layer and the OS sandbox (Meta scopes it to "CI
  // containers only"), while `--disable-approval` drops only the approval
  // prompts and keeps the sandbox confining writes to the workspace. YOLO
  // mode here means "don't stop to ask", not "remove OS containment", so the
  // narrower flag is the match; `--yolo` remains available to type as a
  // custom command.
  //
  // Resume is a subcommand, NOT a --flag. `muse resume --help` (0.1.0) states
  // `muse resume <session-uuid>`, and the reader verified that uuid against
  // real session files: it is the session DIRECTORY's name, which equals the
  // `stream.id` every record carries — NOT the internal command id that also
  // appears in the log under `owner.session_id` / `command_id`.
  ...declared('muse'),
  // Muse can't be told a session id at launch, and its session directory is
  // named by a uuid it coins itself — so a fresh pane embeds the `at-pane:`
  // marker in its kickoff and the reader matches the resulting session file
  // back by finding it in the recorded prompt.
  needsSessionMarker: true,
  supportsRebuild: true,
  hint: 'generalist',
  // Quota failover, from muse 1.3.0's binary strings (vendor-owner source
  // read, not reproduced live): "usage limit reached" is its own error class,
  // separate from "rate limited"; the goal state prints "usage limited" /
  // "limited by budget" and the provider class is provider_tier_limit. The
  // session-JSONL quota_hit record has no captured sample yet, so only the
  // printed forms are declared.
  quotaExhausted: {
    pattern: /(usage limit reached|limited by budget|provider_tier_limit|quota_hit)/i,
  },
} as const satisfies AgentSpec
