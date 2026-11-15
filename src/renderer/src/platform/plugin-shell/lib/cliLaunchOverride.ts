/**
 * cliLaunchOverride.ts
 *
 * The two per-vendor launch overrides a user can set by hand: the whole
 * command line, and extra environment variables.
 *
 * Scope is GLOBAL for both, matching `agentTeam.cliPermission.<key>` and
 * `agentTeam.cliModel.<key>`. How a CLI is
 * invoked follows the machine it is installed on, not whichever folder happens
 * to be open.
 *
 * Kept apart from cliModelDefault.ts because they answer to different owners:
 * a model pick is a request Navide assembles into argv, whereas a command
 * override means "I am writing the command line myself" — Navide stops adding
 * to it, model and effort included. That is existing behaviour in
 * `resolveCommand` (a non-empty override returns verbatim); this module only
 * gives it a stored value to read, so the UI has to say so out loud.
 *
 * Values are NOT validated here beyond shape. A command is whatever the user's
 * shell accepts, and an env value is opaque; the only rule enforced is that an
 * env NAME looks like one, because a name with an `=` or a space cannot be put
 * into a process environment at all.
 */

/** One row of the env table. An array rather than a map so the settings page
 *  can hold a half-typed row (empty name, value already pasted) without it
 *  colliding with another half-typed row. */
export interface CliEnvEntry {
  name: string
  value: string
}

/** Settings key holding one vendor's launch-command override. */
export function cliCommandKey(agentKey: string): string {
  return `agentTeam.cliCommand.${agentKey}`
}

/** Settings key holding one vendor's extra environment variables. */
export function cliEnvKey(agentKey: string): string {
  return `agentTeam.cliEnv.${agentKey}`
}

/** Where a launch's command line came from. `stored` is the one case where
 *  Navide appended nothing — no model, effort, permission flag or pane
 *  argument — so a caller must not claim any of those reached the CLI. */
export type LaunchCommandSource = 'caller' | 'stored' | 'none'

/**
 * Pick the command a launch starts from.
 *
 * A caller's command (a rebuilt resume line, an MCP resume) outranks the
 * stored override: it is this launch's command. A LOGIN pane never takes the
 * stored override — the backend keeps only the first token and appends the
 * vendor's sign-in subcommand, so a wrapper line (`npx …`, `ccr code`,
 * `FOO=1 claude`) would become `npx auth login`. The custom binary (the
 * backend's override, swapped in at terminal.create) is not this setting and
 * still applies to it.
 */
export function chooseLaunchCommand(input: {
  callerCommand: string
  storedCommand: string
  isLogin: boolean
}): { command: string; source: LaunchCommandSource } {
  const caller = input.callerCommand.trim()
  if (caller) return { command: caller, source: 'caller' }
  const stored = input.isLogin ? '' : input.storedCommand.trim()
  if (stored) return { command: stored, source: 'stored' }
  return { command: '', source: 'none' }
}

/** A name a process environment can actually hold: letters, digits and
 *  underscores, never starting with a digit. Checked in the UI so a row that
 *  can never work is refused while it is being typed rather than dropped
 *  without a word at spawn time. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidEnvName(name: string): boolean {
  return ENV_NAME.test(name)
}

/** Read a stored env map back as ordered rows. Anything that is not an object
 *  of string values — absent, null, a legacy scalar — reads as no rows, so an
 *  unset vendor spawns exactly as it did before this setting existed. */
export function parseCliEnvOverride(stored: unknown): CliEnvEntry[] {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return []
  return Object.entries(stored as Record<string, unknown>)
    .filter(([name, value]) => isValidEnvName(name) && typeof value === 'string')
    .map(([name, value]) => ({ name, value: value as string }))
}

/** What to persist for a table of rows, or null to clear the key.
 *
 *  Rows with a blank name are dropped rather than stored: they are a row the
 *  user started and abandoned, and writing them would make the parse above
 *  discard them anyway on the next read. A later row wins a duplicate name,
 *  which is what the object the spawn sends would do regardless. */
export function serializeCliEnvOverride(
  entries: readonly CliEnvEntry[],
): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const name = entry.name.trim()
    if (!isValidEnvName(name)) continue
    out[name] = entry.value
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The value for `TerminalSpawnOptions.env`, or undefined when this vendor has
 *  no overrides. Undefined rather than `{}` so a spawn for an untouched vendor
 *  reaches the backend byte-for-byte as it did before. */
export function spawnEnvOverride(stored: unknown): Record<string, string> | undefined {
  return serializeCliEnvOverride(parseCliEnvOverride(stored)) ?? undefined
}

/**
 * Env names a spawn request may not set — the backend's
 * `app.spawn_env_deny_list()`, mirrored here so the settings page can say so
 * while the value is being typed instead of leaving the user to find out from
 * a `cli.env_ignored` notice after the pane is already running.
 *
 * This is a MIRROR, not a second rule: the backend still filters, and a key
 * that slipped past this list is dropped there. `cliLaunchOverride.test.ts`
 * derives the same union out of the backend's sources (two Python tables and
 * every launch declaration's `env_strip`) and fails if the two disagree, so
 * the list cannot drift quietly when a vendor gains a home var.
 *
 * It is a single global list, not per vendor: the backend's union covers every
 * vendor's home relocators at once (a claude pane is refused CODEX_HOME too),
 * and splitting it here would invent a distinction the filter does not make.
 */
export const SPAWN_ENV_RESERVED_KEYS: readonly string[] = [
  'AIDER_CHAT_HISTORY_FILE',
  'AIDER_INPUT_HISTORY_FILE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  'DROID_PARENT_SESSION_ID',
  'FACTORY_HOME_OVERRIDE',
  'FACTORY_RUNTIME_SETTINGS_PATH',
  'GROK_BACKGROUND_CHILD',
  'GROK_DAEMON_CHILD',
  'GROK_HOME',
  'KILO_CONFIG',
  'KILO_CONFIG_DIR',
  'KIMI_CODE_HOME',
  'KIRO_HOME',
  'MAVIS_DATA_DIR',
  'MINIMAX_DATA_DIR',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
]

const RESERVED = new Set(SPAWN_ENV_RESERVED_KEYS)
const RESERVED_FOLDED = new Set(SPAWN_ENV_RESERVED_KEYS.map((key) => key.toLowerCase()))

/** True when the backend will drop this name on the way in. Soft, not hard:
 *  the UI marks the row and still lets it be saved, because the same name may
 *  become legal the day Navide stops managing that CLI's home.
 *
 *  Compared the way the host's process environment compares names, matching
 *  the backend's `osplat.paths.env_name_key`: Windows folds case, so
 *  `minimax_data_dir` sets MINIMAX_DATA_DIR and is marked; POSIX does not,
 *  and there the lower-case spelling is a different, legal variable. The
 *  caller says which (`foldCase`): plugin-shell owns no platform seam, and
 *  its ownership boundary keeps `shared/osplat` out of this module. */
export function isReservedSpawnEnvKey(name: string, options: { foldCase?: boolean } = {}): boolean {
  const trimmed = name.trim()
  return options.foldCase ? RESERVED_FOLDED.has(trimmed.toLowerCase()) : RESERVED.has(trimmed)
}
