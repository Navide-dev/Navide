/** OpenClaw — per-vendor agent spec (see types.ts; assembled by index.ts).
 *  Measured against OpenClaw 2026.11.2 on 2026-11-10 (plan
 *  openclaw-hermes-0-2-40_a50148; backend cli_vendors/openclaw.py has the
 *  details). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

/** Every session key Navide hands OpenClaw starts with this. */
const KEY_PREFIX = 'agent:main:navide-'

export const SPEC = {
  agentKey: 'openclaw',
  // Label, command, resume arguments and the vendor kind (an agent): the
  // launch declaration.
  //
  // Command (`openclaw tui --local`): the TUI on the local embedded runtime.
  // A bare `openclaw` would attach to a running Gateway instead; Navide never
  // starts the Gateway, and `--local` leaves no background process behind.
  //
  // No permission-bypass flag. No modelArgs: the TUI has no model flag
  // (`agent --model` is non-interactive; `models set` changes the global
  // default).
  //
  // Resume: `tui --session <key>` reattaches the session with that key.
  ...declared('openclaw'),
  // Wider than the pattern derived from the declaration: other arguments may
  // sit between `tui` and the flag, in the `=` or the spaced form.
  resumeCommandPattern: /^openclaw\s+tui\b.*\s--session(?:=|\s+)\S+/,
  supportsRebuild: true,
  // A fresh pane names its own session key, so the pane owns it from the
  // first byte and the reader reports it under that key.
  pinsSessionIdAtLaunch: {
    flag: '--session',
    handwritten: /--session[=\s]+(agent:[^\s'"]+)/,
    generateId: () => `${KEY_PREFIX}${crypto.randomUUID()}`,
  },
  // No turnEndInferredFromSilence: the reader closes a turn on an assistant
  // message's stopReason in openclaw-agent.sqlite, a record rather than a
  // timer. bracketedPaste / fullScreenTui not measured.
  hint: 'generalist',
} as const satisfies AgentSpec
