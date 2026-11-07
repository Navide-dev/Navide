/** OpenClaw — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'openclaw',
  label: 'OpenClaw',
  // Bare `openclaw` opens the TUI and chooses the mode itself — it attaches to
  // a running Gateway, else runs the agent locally (docs.openclaw.ai/web/tui,
  // read 2026-11-07). Navide never starts the Gateway.
  defaultCommand: 'openclaw',
  // Everything optional is absent, from the docs rather than a live install:
  // no permission-bypass flag; no modelArgs (models are OpenClaw's own config);
  // no resumeArgs (sessions are Gateway keys with no reader to name them, see
  // the backend spec); bracketedPaste / fullScreenTui not measured.
  hint: 'generalist',
} as const satisfies AgentSpec
