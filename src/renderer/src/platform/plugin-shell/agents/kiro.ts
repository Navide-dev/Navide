/** Kiro CLI (AWS) — per-vendor agent spec (see types.ts; assembled by
 *  index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'kiro',
  label: 'Kiro CLI (AWS)',
  // `kiro-cli chat` opens the interactive chat (`kiro` alone opens the IDE).
  // `--v3` pins the V3 agent harness, the one Navide's turn-end hook is
  // written for (kiro.dev/docs/reference/cli-commands, read 2026-11-12).
  defaultCommand: 'kiro-cli chat --v3',
  // Trusts every tool; interactive V3 shows a confirmation warning first.
  // From the docs, not a live install.
  skipPermissionFlag: '--trust-all-tools',
  // `--model <MODEL>` and `--effort <LEVEL>` are flags of `chat`, spaced
  // form, levels low/medium/high/xhigh/max (kiro.dev/docs/reference/
  // cli-commands and /docs/models/effort, read 2026-11-25). From the docs,
  // not a live install: what Kiro does with an unknown model id, or a level
  // the chosen model lacks, is undocumented and unverified.
  modelArgs: (m) => `--model ${m}`,
  effortArgs: (e) => `--effort ${e}`,
  knownEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  // No resumeArgs: `--resume-id <ID>` exists but nothing can name the id of a
  // session Navide started (see the backend spec). bracketedPaste /
  // fullScreenTui not measured (the docs leave bracketed paste out; the
  // alternate screen is used only after `/fullscreen`).
  hint: 'generalist',
} as const satisfies AgentSpec
