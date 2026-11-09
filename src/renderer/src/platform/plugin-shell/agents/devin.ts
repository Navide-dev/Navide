/** Devin CLI (Cognition) — per-vendor agent spec (see types.ts; assembled by
 *  index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'devin',
  label: 'Devin CLI (Cognition)',
  // Bare `devin` in the project directory opens the interactive TUI, on
  // Windows too (docs.devin.ai/cli, read 2026-11-07). Sign-in (`/login`) and
  // the cloud handoff (`/handoff`) are Devin's own commands inside the TUI.
  defaultCommand: 'devin',
  // `dangerous` (aliases yolo / bypass) auto-approves every tool call; admin
  // deny and ask rules still apply (docs/cli/reference/commands). From the
  // docs, not a live install.
  skipPermissionFlag: '--permission-mode dangerous',
  // No modelArgs: `--model` is documented but could not be checked against an
  // invalid value without an install. No resumeArgs: `-r <id>` exists but no
  // reader can name the id of a session Navide started (see the backend
  // spec). bracketedPaste / fullScreenTui not measured.
  hint: 'generalist',
} as const satisfies AgentSpec
