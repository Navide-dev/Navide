/** Antigravity CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'antigravity',
  // Label, command, flags and resume arguments: the launch declaration. agy
  // validates model and effort together and exits 1 on a bad value, naming
  // the three efforts it accepts.
  ...declared('antigravity'),
  needsSessionMarker: true,
  bracketedPaste: true,
  supportsRebuild: true,
  // Measured on a real PTY (agy 1.1.13): the CLI itself emits `ESC[?1049h`
  // during startup and keeps the conversation there. The probe only read 82
  // bytes before the CLI settled, but the sequence appearing at all is
  // positive evidence — unlike a normal-buffer verdict, which needs enough
  // output to trust the absence.
  fullScreenTui: true,
  // The ask_question option list. Its reader raises the same state from the
  // conversation db (step_type 138), but only once marker binding has matched
  // the pane to a session — until then, and whenever binding fails, nothing
  // reports the wait and the pane reads as plain idle. An idle antigravity
  // pane is reclaimable, so a question left on screen was being swept away.
  //
  // Three anchors, any one of which is enough, all read off real PTY captures
  // (420 logs, agy 1.1.8 through 1.1.13): the option-list footer, the question
  // header, and the write-in row every list ends with. The footer alone would
  // do most days; the other two cover a screen tail that scrolled it off.
  //
  // What is deliberately NOT here: the permission box. Its strings exist in
  // the binary but appear in none of the captures, because Navide launches
  // this CLI past them. A pattern no capture can confirm is a guess, and a
  // wrong guess here pins a pane as waiting forever.
  //
  // Each anchor is a full phrase for a reason. `esc Skip` (no "to") belongs to
  // this list only — the constantly repainted footer says `esc to cancel`, the
  // slash-command completer says `tab Complete`, and /model says `esc Go Back`.
  awaitingInput: {
    pattern: /↑\/↓ Navigate · enter Select · esc Skip|Question \d+\/\d+:|\d+\. Write-in\.\.\./,
  },
  hint: 'generalist'
} as const satisfies AgentSpec
