/**
 * One file per vendor; this assembler is the canonical list. Adding a CLI:
 * copy `_template.ts` to `<key>.ts`, then register it here (one line, in
 * display order). The backend registry test cross-checks the key set.
 */

import type { AgentSpec } from './types'
import { SPEC as aider } from './aider'
import { SPEC as antigravity } from './antigravity'
import { SPEC as claude } from './claude'
import { SPEC as codex } from './codex'
import { SPEC as copilot } from './copilot'
import { SPEC as cursor } from './cursor'
import { SPEC as droid } from './droid'
import { SPEC as goose } from './goose'
import { SPEC as grok } from './grok'
import { SPEC as kilo } from './kilo'
import { SPEC as kimi } from './kimi'
import { SPEC as mcode } from './mcode'
import { SPEC as muse } from './muse'
import { SPEC as opencode } from './opencode'
import { SPEC as pi } from './pi'
import { SPEC as qwen } from './qwen'
import { SPEC as terminal } from './terminal'

export type { AgentSpec, DirLister, PaneArgContext } from './types'

// Display order (spawn menus, settings) — deliberate, not alphabetical.
const ORDERED = [
  claude,
  codex,
  antigravity,
  grok,
  kimi,
  opencode,
  qwen,
  kilo,
  pi,
  copilot,
  cursor,
  aider,
  muse,
  droid,
  mcode,
  goose,
  terminal
] as const

/** Literal union of real CLI agent keys, derived from the specs — the single
 *  source stages.ts and friends re-export instead of hand-written unions. */
export type AgentKey = Exclude<(typeof ORDERED)[number]['agentKey'], 'terminal'>

export const AGENT_SPECS: AgentSpec[] = [...ORDERED]

/** Specs that are real CLI agents (excludes the plain-shell terminal entry). */
export const CLI_AGENT_SPECS: AgentSpec[] = AGENT_SPECS.filter((s) => s.agentKey !== 'terminal')

/** CLIs whose panes can be re-spawned via the vendor resume command (aider is
 *  excluded by its spec: no session ids, the gate flags never satisfy). */
export const REBUILD_CAPABLE_AGENTS: string[] = CLI_AGENT_SPECS.filter(
  (s) => s.supportsRebuild
).map((s) => s.agentKey)

/** CLIs whose restore may keep the saved session id pinned (self-healing). */
export const RESTORE_PIN_AGENTS: string[] = CLI_AGENT_SPECS.filter(
  (s) => s.supportsRestorePin
).map((s) => s.agentKey)
