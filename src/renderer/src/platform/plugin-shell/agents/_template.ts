/**
 * CONTRIBUTOR TEMPLATE — copy to `<your_key>.ts` and fill in. Nothing else
 * registers it: `index.ts` finds every spec file here, and lists it where the
 * CLI's declaration says (`order.menu`). A CLI that needs nothing below
 * beyond its declaration needs no file at all. Files starting with `_` are
 * never registered. Full guide: docs/adding-a-cli-vendor.md.
 */

import type { AgentSpec } from './types'

// In a real spec file: `import { declared } from './_declared'`.

// `as const satisfies` — NOT `: AgentSpec`: the annotation would widen every
// literal in the spec. (The AgentKey union is the declared keys, from
// `_cli_declarations.ts`.)
export const SPEC = {
  agentKey: '_template', // must match the filename
  // ── Launch and resume: declared once, never retyped here ──
  // The label, the command, the unattended flag, the model and effort flags
  // (with the effort vocabulary), the resume arguments and the vendor kind
  // come from the CLI's declaration in
  // native/navide-cli-runtime/src/vendors/<key>.rs, through
  // _cli_declarations.ts:
  //   ...declared('mycli'),
  // Declare only what the INTERACTIVE command accepts — Navide never spawns
  // `exec`/`run`, and several CLIs expose a flag on the subcommand only. A
  // flag left undeclared makes a spawn asking for it REFUSED, which is the
  // point: some CLIs accept an unknown flag and ignore it, and a dropped
  // --model looks exactly like a working one. Verify by running the flag with
  // a deliberately invalid value; `--flag --version` proves nothing.
  // (This template alone spells the two required fields out, since it has no
  // declaration.)
  label: 'Human Name',
  defaultCommand: 'mycli',
  // paneArg: (ctx) => '...',           // per-pane argument, if state must be split
  // ── Session resume (see types.ts for full field docs) ──
  // resumeCommandPattern: /^mycli\s+(?:--resume|-r)\s+\S+/, // only to recognize more than the declared resume command
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
  hint: 'generalist'
} as const satisfies AgentSpec
