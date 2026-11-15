/** Pi — per-vendor agent spec (see types.ts; assembled by index.ts). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'pi',
  // Label, command, flags and resume arguments: the launch declaration.
  //
  // Effort (`--thinking`): like claude, pi warns and continues on an unknown
  // level rather than failing, so the vocabulary is declared and checked
  // before launch. pi also accepts `provider/id:<thinking>` in --model; the
  // flag is used instead so the two arguments stay independent.
  //
  // no skipPermissionFlag: pi has no permission system at all
  // (bash/edit tools execute directly, nothing to bypass)
  //
  // Resume (`--session-id <id>`) creates a NEW session when the id doesn't
  // exist, resumes when it does.
  ...declared('pi'),
  needsSessionMarker: true,
  turnEndInferredFromSilence: true,
  supportsRebuild: true,
  // Restore-pin self-heals: `pi --session-id <id>` is documented as "Use exact
  // project session ID, creating it if missing", so a pin that never gets
  // replaced still resumes/claims a real session instead of dead-ending.
  supportsRestorePin: true,
  hint: 'generalist',
  // Quota failover: pi.py reports OpenRouter credits with usage/limit; a
  // null limit is an uncapped pool and says nothing about headroom.
  quotaSemantics: { hard: ['credits'], required: ['credits'] },
} as const satisfies AgentSpec
