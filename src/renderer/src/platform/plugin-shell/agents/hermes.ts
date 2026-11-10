/** Hermes Agent (Nous Research) — per-vendor agent spec (see types.ts;
 *  assembled by index.ts). Measured against Hermes Agent v0.23.0 on
 *  2026-11-10 (plan openclaw-hermes-0-2-40_a50148; backend
 *  cli_vendors/hermes.py has the details). */

import type { AgentSpec } from './types'

/** Every session name Navide hands Hermes starts with this. */
const SESSION_PREFIX = 'navide-'

export const SPEC = {
  agentKey: 'hermes',
  label: 'Hermes Agent',
  // `hermes chat` is the same interactive chat a bare `hermes` opens (it
  // honours display.interface too), on Windows as well. The subcommand,
  // because `--create-if-missing` — what lets Navide name the session — only
  // exists there (`hermes chat --help`).
  defaultCommand: 'hermes chat',
  // `chat --yolo` skips the dangerous-command approval prompt.
  skipPermissionFlag: '--yolo',
  // `chat -m, --model MODEL`.
  modelArgs: (m) => `--model ${m}`,
  // `chat --reasoning LEVEL`: a closed list in `hermes chat --help`.
  effortArgs: (e) => `--reasoning ${e}`,
  knownEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  // `--continue <name>` resumes the latest session in that name's lineage
  // (Hermes titles a continuation `<name> #2`).
  resumeArgs: (id) => `--continue ${id}`,
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
  kind: 'agent',
} as const satisfies AgentSpec
