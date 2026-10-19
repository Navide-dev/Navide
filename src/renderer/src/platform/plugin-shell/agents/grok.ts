/** Grok CLI — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

// Grok Build's folder-trust prompt (1.0.62), read off a pane (issue #402):
//   Do you trust the contents of this directory?
//   <path>
//   Grok Build may run or modify contents in this directory, posing security risks.
//     Yes, proceed   y
//     No, quit       n
// Anchored on the question AND the live option row, which only exist while it
// waits; the screen is whitespace-collapsed before matching.
const TRUST_PROMPT = /Do you trust the contents of this directory\? .*Yes, proceed y\b/

/** A UUIDv7 (RFC 9562): Grok Build names its own sessions with these, and
 *  `--session-id` must be a UUID that does not exist yet. */
function uuid7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  let ms = Date.now()
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256
    ms = Math.floor(ms / 256)
  }
  b[6] = (b[6] & 0x0f) | 0x70
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const SPEC = {
  agentKey: 'grok',
  label: 'Grok Build (SpaceXAI)',
  defaultCommand: 'grok',
  // `reasoning_effort` exists only in grok's API payload, not as a flag.
  modelArgs: (m) => `--model ${m}`,
  // no skipPermissionFlag: this CLI does have `--always-approve` and
  // `--permission-mode` (verified in `grok --help`, 1.0.30), but wiring either
  // one in is a change to how panes run, not part of reading its logs — so the
  // permission surface stays unwired until that is decided on its own.
  // `--sandbox` / `--no-sandbox` pre-answer the per-workspace host-vs-sandbox
  // question (stored in ~/.grok/workspace-trust.json); a sandbox choice, not a
  // permission bypass.
  // `-r` resumes; `-s`/`--session-id` NAMES A NEW session and errors on an
  // existing id, so the two are not interchangeable. Ids are UUIDv7.
  resumeArgs: (id) => `-r ${id}`,
  // No turnEndInferredFromSilence: the official CLI writes an explicit
  // `turn_completed` record into updates.jsonl and the reader emits its
  // turn_complete straight off it. The community grok-cli this replaced wrote
  // no such record, which is why the flag used to be set here.
  // A fresh pane is launched with `--session-id <uuid7>` (`grok --help`,
  // 1.0.62: "Use a specific session UUID for a new conversation"), so the
  // session is the pane's from the first byte. It used to be typed a session
  // marker instead, which Grok answered as a real prompt — a whole turn of the
  // user's quota before any task arrived (issue #402).
  pinsSessionIdAtLaunch: {
    flag: '--session-id',
    handwritten:
      /--session-id[=\s]+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9a-fA-F-])/,
    generateId: uuid7,
  },
  bracketedPaste: true,
  // The folder-trust prompt is the one wait this CLI shows as plain text. It
  // reads as awaiting, so a message is held instead of being pasted into a
  // y/n prompt, and cli_answer_prompt can answer it (lib/paneAnswerKeys.ts).
  awaitingInput: { pattern: TRUST_PROMPT },
  // Accepted for every pane Navide spawns, a resumed one included (#402).
  startupTrust: { pattern: TRUST_PROMPT, keys: 'y' },
  resumeCommandPattern: /^grok\s+-r\s+\S+/,
  supportsRebuild: true,
  hint: 'generalist',
  // Quota failover: grok.py reports one "Monthly credits" window.
  quotaSemantics: { hard: ['monthly'], required: ['monthly'] },
} as const satisfies AgentSpec
