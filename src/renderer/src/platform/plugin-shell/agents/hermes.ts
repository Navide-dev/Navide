/** Hermes Agent (Nous Research) — per-vendor agent spec (see types.ts;
 *  assembled by index.ts). Measured against Hermes Agent v0.23.0 on
 *  2026-11-10 (plan openclaw-hermes-0-2-40_a50148; backend
 *  cli_vendors/hermes.py has the details). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

/** Every session name Navide hands Hermes starts with this. */
const SESSION_PREFIX = 'navide-'

export const SPEC = {
  agentKey: 'hermes',
  // Label, command, flags, resume arguments and the vendor kind (an agent):
  // the launch declaration.
  //
  // Command: `hermes chat` is the same interactive chat a bare `hermes` opens
  // (it honours display.interface too), on Windows as well. The subcommand,
  // because `--create-if-missing` — what lets Navide name the session — only
  // exists there (`hermes chat --help`).
  //
  // Unattended: `chat --yolo` skips the dangerous-command approval prompt.
  //
  // No modelArgs / effortArgs: every pane launches through `--continue`, and
  // Hermes v0.23.1 refuses `-m` / `--reasoning` on any `--continue` launch,
  // creation included (exit 2, "creation overrides are unsupported on
  // resume"). Its `/model` and `/reasoning` slash commands work only when
  // typed raw into the PTY, which no launch path does yet.
  //
  // Resume: `--continue <name>` resumes the latest session in that name's
  // lineage (Hermes titles a continuation `<name> #2`).
  ...declared('hermes'),
  // Wider than the pattern derived from the declaration: other arguments may
  // sit between `chat` and the flag, and `-c` is its short form.
  resumeCommandPattern: /^hermes\s+chat\b.*\s(?:--continue|-c)\s+\S+/,
  supportsRebuild: true,
  // A fresh pane names its own session: `--create-if-missing` makes the named
  // session when none matches, so the pane owns it from the first byte and
  // the reader reports it under the same name.
  pinsSessionIdAtLaunch: {
    flag: '--create-if-missing --continue',
    handwritten: /(?:^|\s)(?:--continue|-c)[=\s]+(navide-[0-9A-Za-z-]+)(?=\s|$)/,
    generateId: () => `${SESSION_PREFIX}${crypto.randomUUID()}`,
  },
  // No turnEndInferredFromSilence: the reader closes a turn on an assistant
  // row's finish_reason in state.db, a record rather than a timer.
  // bracketedPaste / fullScreenTui not measured.
  hint: 'generalist',
} as const satisfies AgentSpec
