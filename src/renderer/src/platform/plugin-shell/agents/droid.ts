/** Droid (Factory) — per-vendor agent spec (see types.ts; assembled by index.ts). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'droid',
  // Label, command, flags and resume arguments: the launch declaration.
  //
  // No model or effort flag: `droid --help` (the interactive command Navide
  // spawns) declares neither, and its `-r` means --resume there while
  // meaning --reasoning-effort under `droid exec`. Passing effort through
  // would resume a session named after the level, so both are refused.
  //
  // Droid has no boolean "skip every prompt" flag on its INTERACTIVE command:
  // `droid --help` (0.204.0) lists only `--auto <level>` with low|medium|high.
  // `--skip-permissions-unsafe` exists, but `droid exec --help` is the only
  // place that documents it, and the interactive binary silently ignores
  // unknown flags (verified: a deliberately bogus flag still starts the TUI),
  // so "it did not error" proves nothing here. `--auto high` is the documented
  // unattended level and is what YOLO mode appends.
  //
  // Resume: `-r, --resume [sessionId]` — the id is the session file's stem.
  ...declared('droid'),
  supportsRebuild: true,
  // Measured on a real PTY (0.204.0): droid emits `ESC[?2004h` during startup,
  // before it even finishes authenticating, and keeps it on.
  bracketedPaste: true,
  // Deliberately NOT fullScreenTui: the same PTY capture shows droid never
  // sends `ESC[?1049h`. It repaints the normal buffer (`ESC[2J ESC[3J ESC[H`)
  // instead of switching to the alternate screen, so the default
  // excludeAltBuffer snapshot already captures its conversation.
  //
  // Verbatim from the CLI on an expired/absent login:
  //   "Error during droid execution: Authentication failed. Please log in
  //    using /login or set a valid FACTORY_API_KEY environment variable."
  // Anchored on both halves so ordinary text mentioning /login can't match,
  // and tolerant of whitespace runs because a narrow pane hard-wraps it.
  loginExpired: {
    pattern: /authentication\s+failed.{0,60}?please\s+log\s+in\s+using\s+\/login(?:\s|$)/i,
    loginCommand: '/login',
  },
  // Droid names its session directory after the encoded cwd
  // (~/.factory/sessions/<encoded-cwd>/<uuid>.jsonl), so a session is scoped to
  // a workspace — but it cannot pin a session id at launch (`--session-id`
  // exists only on `droid exec`, not on the interactive command), so two panes
  // in one workspace would be indistinguishable. The kickoff marker is what
  // separates them, exactly as it does for the other markered vendors.
  needsSessionMarker: true,
  //
  // verifiedTurnText stays unset: the reader carries turn text, but it has not
  // been validated against a real authenticated session yet — the same bar the
  // other eleven unflagged vendors are held to.
  hint: 'generalist',
  // Quota failover, from droid 0.206.0's bundle (vendor-owner source read,
  // not reproduced on a live account): the session JSONL records
  // agent_turn_outcome.reason, and the reader hands it over as the
  // turn_complete `detail`. "model_usage_exhausted" is exhaustion; its
  // neighbours (model_authentication_failed, model_request_rejected,
  // model_provider_unreachable, prompt_rejected) and the retry classes
  // (overloaded, rate_limited, timeout, network) are not and are left out.
  // The TUI strings are the same event as text.
  quotaExhausted: {
    pattern: /(Standard Usage limit reached|standard credit limits are exhausted|usage quota is exhausted\. Limits reset at)/i,
    turnDetail: 'model_usage_exhausted',
  },
} as const satisfies AgentSpec
