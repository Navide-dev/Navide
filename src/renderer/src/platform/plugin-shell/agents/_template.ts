/**
 * CONTRIBUTOR TEMPLATE — copy to `<your_key>.ts` and fill in, then register
 * the SPEC in `index.ts` (one line, display order). Files starting with `_`
 * are never registered. Full guide: docs/adding-a-cli-vendor.md.
 */

import type { AgentSpec } from './types'

// `as const satisfies` — NOT `: AgentSpec`. The annotation would widen
// agentKey to `string`, and index.ts derives the AgentKey union from these
// literals: one annotated spec collapses the union for the whole app.
export const SPEC = {
  agentKey: '_template', // must match the filename
  label: 'Human Name',
  defaultCommand: 'mycli',
  // skipPermissionFlag: '--yolo',      // unattended-mode flag, if the CLI has one
  // paneArg: (ctx) => '...',           // per-pane argument, if state must be split
  // ── Model selection ──
  // Only what the INTERACTIVE command accepts — Navide never spawns
  // `exec`/`run`, and several CLIs expose these on the subcommand only.
  // Omit a field and a spawn asking for it is REFUSED, which is the point:
  // some CLIs accept an unknown flag and ignore it, and a dropped --model
  // looks exactly like a working one. Verify by running the flag with a
  // deliberately invalid value; `--flag --version` proves nothing.
  // modelArgs: (m) => `--model ${m}`,
  // effortArgs: (e) => `--effort ${e}`,   // omit if effort lives in the model id
  // knownEfforts: ['low', 'medium', 'high'],  // required if the CLI only warns
  // ── Session resume (see types.ts for full field docs) ──
  // resumeArgs: (id) => `--resume ${id}`,  // args only; binary = defaultCommand
  // resumeCommandPattern: /^mycli\s+--resume\s+\S+/, // only if non-generic shape
  // resumeWithoutId: (file) => '...',  // id-less vendors only (see aider)
  // supportsRebuild: true,
  // supportsRestorePin: true,
  // needsSessionMarker: true,          // true for every CLI that can't pin an id at launch
  // ── Turn signals ──
  // turnEndInferredFromSilence: true,  // ONLY if the log has no turn-end record
  // verifiedTurnText: true,            // ONLY after validating against real sessions
  // ── Terminal input protocol ──
  // bracketedPaste: true,
  // shiftEnterSequence: '\x1b[13;2u',  // only if bracketed-LF default won't do
  // ── Recovery ──
  // loginExpired: { pattern: /.../i, loginCommand: '/login' },
  // ── Kind ──
  // kind: 'agent',                     // long-lived agent, not a coding CLI (cli-extension-guide.md)
  hint: 'generalist'
} as const satisfies AgentSpec
