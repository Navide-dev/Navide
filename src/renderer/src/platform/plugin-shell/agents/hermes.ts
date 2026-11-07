/** Hermes Agent (Nous Research) — per-vendor agent spec (see types.ts;
 *  assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'hermes',
  label: 'Hermes Agent',
  // A general agent with its own runtime and model keys, not a coding CLI:
  // offered in the ＋ menu's "Standalone agents" block only.
  category: 'standalone',
  // Bare `hermes` opens the interactive TUI, on Windows too (native PowerShell
  // install; hermes-agent.nousresearch.com docs, read 2026-11-07).
  defaultCommand: 'hermes',
  // Top-level flag that skips the dangerous-command approval prompt
  // (docs/reference/cli-commands). From the docs, not a live install.
  skipPermissionFlag: '--yolo',
  // No modelArgs: `-m` belongs to `hermes chat`, not the bare command. No
  // resumeArgs: `--resume <id>` exists but no reader can name the id of a
  // session Navide started. bracketedPaste / fullScreenTui not measured.
  hint: 'generalist',
} as const satisfies AgentSpec
