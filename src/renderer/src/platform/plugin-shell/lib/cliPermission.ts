/**
 * cliPermission.ts
 *
 * One definition of whether a CLI pane starts with its permission-bypass flag.
 *
 * `skipPermissionFlagFor` resolves the global YOLO toggle against the
 * per-vendor override. Every spawn, resume and restore path must go through
 * it — they each used to inline `yolo ? spec.skipPermissionFlag : ''`, which
 * is why a per-vendor setting could otherwise take effect on some paths and
 * not others.
 */

/** Per-vendor override for the global YOLO toggle. */
export type CliPermissionMode = 'inherit' | 'force-on' | 'force-off'

const MODES: readonly string[] = ['inherit', 'force-on', 'force-off']

/** Settings key holding one vendor's override. */
export function cliPermissionKey(agentKey: string): string {
  return `agentTeam.cliPermission.${agentKey}`
}

/** Unknown or missing values read as 'inherit', so an unset vendor behaves
 *  exactly as it did before this setting existed. */
export function parseCliPermissionMode(stored: string | null | undefined): CliPermissionMode {
  return MODES.includes(stored as string) ? (stored as CliPermissionMode) : 'inherit'
}

/** The flag to append to a spawn command, or '' for none.
 *
 *  A vendor with no `skipPermissionFlag` (grok / opencode / pi) always yields
 *  '' — there is nothing to force on. */
export function skipPermissionFlagFor(input: {
  spec: { skipPermissionFlag?: string } | undefined
  globalYolo: boolean
  mode: CliPermissionMode
}): string {
  const flag = input.spec?.skipPermissionFlag
  if (!flag) return ''
  if (input.mode === 'force-off') return ''
  if (input.mode === 'force-on') return flag
  return input.globalYolo ? flag : ''
}

/** Whether a pane's recorded launch command carried its vendor's bypass flag:
 *  'on' / 'off', or null for a vendor with no flag (nothing to report).
 *
 *  Read from the command the pane actually started with, not from settings:
 *  the flag is fixed at launch, so a pane started before a settings change —
 *  or from a custom launch command, which Navide runs as typed — can differ
 *  from what the settings say now. */
export function launchBypassState(command: string, flag: string | undefined): 'on' | 'off' | null {
  if (!flag) return null
  return command.split(/\s+/).includes(flag) ? 'on' : 'off'
}
