/**
 * The agent specs, assembled. Nothing is registered here.
 *
 * Which CLIs exist, and where each sits in the menus, is the runtime's
 * declarations (`_cli_declarations.ts`, generated from
 * `native/navide-cli-runtime/src/vendors/<key>.rs`). What the app knows about
 * a CLI beyond launching and resuming it lives in `<key>.ts` beside this
 * file, which exports `SPEC`; every such file is found by `import.meta.glob`.
 * A declared CLI with no file gets its spec from the declaration alone. A
 * spec file that is not a declared CLI (the plain terminal) is listed after
 * the CLIs. The backend registry test cross-checks the key set.
 */

import declarations from './_cli_declarations'
import { declared } from './_declared'
import type { AgentSpec } from './types'

export type { AgentSpec, DirLister, PaneArgContext } from './types'

/** Literal union of real CLI agent keys: the declared ones. The single
 *  source stages.ts and friends re-export instead of hand-written unions. */
export type AgentKey = (typeof declarations)[number]['key']

/** Every spec file in this directory by its stem. `_`-prefixed files are
 *  infrastructure (the template, the declarations and their reader). */
const files = new Map<string, AgentSpec>()
for (const [path, module] of Object.entries(
  import.meta.glob<{ SPEC?: AgentSpec }>(['./*.ts', '!./_*.ts', '!./index.ts', '!./types.ts'], { eager: true }),
)) {
  if (module.SPEC) files.set(path.replace(/^\.\//, '').replace(/\.ts$/, ''), module.SPEC)
}

// Display order (spawn menus, settings): each declaration's `order.menu`,
// deliberate and not alphabetical.
const clis: AgentSpec[] = [...declarations]
  .sort((a, b) => a.order.menu - b.order.menu)
  .map(({ key }) => files.get(key) ?? { agentKey: key, ...declared(key) })

const declaredKeys = new Set<string>(declarations.map((entry) => entry.key))
const others: AgentSpec[] = [...files.keys()]
  .filter((stem) => !declaredKeys.has(stem))
  .sort()
  .map((stem) => files.get(stem)!)

export const AGENT_SPECS: AgentSpec[] = [...clis, ...others]

/** Specs that are real CLI agents (excludes the plain-shell terminal entry). */
export const CLI_AGENT_SPECS: AgentSpec[] = AGENT_SPECS.filter((s) => s.agentKey !== 'terminal')

/** The CLIs whose records the runtime declares (`observed` in the declaration,
 *  printed by `declarations launch`): they have a log reader, and it reports
 *  when a turn starts. The renderer reads this instead of keeping its own list
 *  of the CLIs that have none. */
export const OBSERVED_AGENT_KEYS: ReadonlySet<string> = new Set(
  declarations.filter((entry) => entry.observed).map((entry) => entry.key),
)

/** CLIs whose panes can be re-spawned via the vendor resume command (aider is
 *  excluded by its spec: no session ids, the gate flags never satisfy). */
export const REBUILD_CAPABLE_AGENTS: string[] = CLI_AGENT_SPECS.filter(
  (s) => s.supportsRebuild
).map((s) => s.agentKey)

/** CLIs whose restore may keep the saved session id pinned (self-healing). */
export const RESTORE_PIN_AGENTS: string[] = CLI_AGENT_SPECS.filter(
  (s) => s.supportsRestorePin
).map((s) => s.agentKey)
