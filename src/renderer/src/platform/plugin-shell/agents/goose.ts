/** Goose (AAIF) — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'goose',
  label: 'Goose (AAIF)',
  // Bare `goose` opens a new interactive session once a provider is
  // configured, and runs `goose configure` first when none is (1.55.0).
  defaultCommand: 'goose',
  // no skipPermissionFlag: goose has no such flag. Approval is the GOOSE_MODE
  // setting (auto — the default — approve, smart_approve, chat), so a pane
  // runs with whatever mode the user configured.
  // `--session-id` only resumes (`-r`); a new session cannot be given an id
  // at launch, so the pane binds through the kickoff marker. An unknown id
  // exits with "no such session exists", which the backend preflight checks.
  resumeArgs: (id) => `session -r --session-id ${id}`,
  resumeCommandPattern: /^goose\s+session\s+-r\s+--session-id\s+\S+/,
  needsSessionMarker: true,
  supportsRebuild: true,
  // Measured on a real PTY (1.55.0): `ESC[?2004h` at startup, never
  // `ESC[?1049h` — it draws in the normal buffer.
  bracketedPaste: true,
  // The tool-approval select shown under GOOSE_MODE=approve/smart_approve,
  // read off a real PTY capture. cliclack marks the live question with ◆ and
  // rewrites it to ◇ once answered, so only the waiting prompt matches.
  awaitingInput: {
    pattern: /◆\s+Goose would like to call the above tool, do you allow\?/,
  },
  hint: 'generalist'
} as const satisfies AgentSpec
