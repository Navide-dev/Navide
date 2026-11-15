/** Kiro CLI (AWS) — per-vendor agent spec (see types.ts; assembled by
 *  index.ts). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'kiro',
  // Label, command and flags: the launch declaration.
  //
  // Command: `kiro-cli chat` opens the interactive chat (`kiro` alone opens
  // the IDE). `--v3` pins the V3 agent harness, the one Navide's turn-end hook
  // is written for (kiro.dev/docs/reference/cli-commands, read 2026-11-12).
  //
  // Unattended: `--trust-all-tools` trusts every tool; interactive V3 shows a
  // confirmation warning first. From the docs, not a live install.
  ...declared('kiro'),
  // No modelArgs / effortArgs: `--model` and `--effort` are documented but
  // were not checked against an invalid value without an install. No
  // resumeArgs: `--resume-id <ID>` exists but nothing can name the id of a
  // session Navide started (see the backend spec). bracketedPaste /
  // fullScreenTui not measured (the docs leave bracketed paste out; the
  // alternate screen is used only after `/fullscreen`).
  hint: 'generalist',
} as const satisfies AgentSpec
