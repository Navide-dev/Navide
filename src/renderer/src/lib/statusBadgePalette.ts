/** The colour vocabulary a pane status can be painted with, and which colour
 *  each status starts out as.
 *
 *  Status colours used to live only as `[data-status='x']` CSS rules, once per
 *  surface — the pane pill, the sidebar dot, the meeting badge and the resource
 *  row each restated the same hue. That made a status impossible to recolour
 *  without editing five files, and it is why 'stopped' still carried a literal
 *  #000000 while every other status went through a token.
 *
 *  The CSS rules stay (they are the default look, and a surface with no rule
 *  silently falls back to neutral grey — see statusBadgeCss.test.ts). What is
 *  new is an override layer: a surface paints `var(--status-badge-bg, <its own
 *  default>)`, and a customized status supplies that variable inline. No
 *  customization, no variable, and the default rule wins untouched.
 *
 *  Every entry resolves through theme tokens rather than fixed hex, so a colour
 *  chosen once stays legible in light, dark, midnight, forest and high-contrast.
 */
import type { PaneStatusValue } from './paneStatusLabel'

/** A colour a status can be painted in. Names are hues, not meanings — the
 *  meaning is whatever the user assigns, which is the point of the setting. */
export type StatusColorKey =
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'cyan'
  | 'gray'
  | 'ink'

/** Badge background + foreground for one colour.
 *
 *  Families that ship a `-muted` background tier use it, which is what keeps
 *  the shipped defaults pixel-identical to the hand-written CSS they replace.
 *  Families that only have a foreground (warning, done, cyan, pink) mix their
 *  own hue down to a 20% wash — the recipe `awaiting` has always used — so the
 *  wash tracks the theme instead of needing a second token per theme file.
 */
export interface StatusColorSpec {
  /** Badge fill. */
  bg: string
  /** Badge text, and the dot fill on dot-only surfaces. */
  fg: string
}

export const STATUS_COLOR_PALETTE: Record<StatusColorKey, StatusColorSpec> = {
  green: { bg: 'var(--success-muted)', fg: 'var(--success-fg)' },
  // The subtle tier with its on-subtle text: attention-fg on attention-muted
  // fell below 4.5:1 in both light and dark.
  yellow: { bg: 'var(--attention-subtle)', fg: 'var(--attention-on-subtle)' },
  orange: {
    bg: 'color-mix(in srgb, var(--warning-fg) 20%, transparent)',
    fg: 'var(--warning-fg)',
  },
  red: { bg: 'var(--danger-deep)', fg: 'var(--danger-fg)' },
  blue: { bg: 'var(--status-idle-muted)', fg: 'var(--status-idle-fg)' },
  purple: {
    bg: 'color-mix(in srgb, var(--done-fg) 22%, transparent)',
    fg: 'var(--done-fg)',
  },
  pink: {
    bg: 'color-mix(in srgb, var(--purple-2) 22%, transparent)',
    fg: 'var(--purple-2)',
  },
  cyan: {
    bg: 'color-mix(in srgb, var(--ansi-cyan) 22%, transparent)',
    fg: 'var(--ansi-cyan)',
  },
  gray: { bg: 'var(--bg-muted)', fg: 'var(--text-primary)' },
  ink: { bg: 'var(--bg-inset)', fg: 'var(--text-bright)' },
}

/** Swatch order in the picker. Warm hues first, neutrals last, so the two
 *  greys do not sit between two colours a user is comparing. */
export const STATUS_COLOR_KEYS: readonly StatusColorKey[] = [
  'green',
  'yellow',
  'orange',
  'red',
  'blue',
  'purple',
  'pink',
  'cyan',
  'gray',
  'ink',
]

/** Statuses in the order the settings page lists them: the seven a pane can
 *  report, in rough lifecycle order, then the two only a pane row can show. */
export const PANE_STATUS_ORDER: readonly PaneStatusValue[] = [
  'starting',
  'running',
  'idle',
  'awaiting',
  'stopped',
  'exited',
  'error',
  'waiting',
  'disconnected',
]

/** ── The default colour of every status ──────────────────────────────────
 *
 *  This table is the whole default palette; changing a line here changes what
 *  a fresh install looks like, and what "Reset" restores. Nothing else needs
 *  to change with it.
 *
 *  The shipped values and the per-surface CSS say the same thing, and have to
 *  be changed together: this table is what the picker shows as "current" and
 *  what "Reset" clears back to, while the CSS is what actually paints.
 *
 *  'starting' and 'idle' paint through a role token (`--status-starting-*`,
 *  `--status-idle-*`) rather than a colour family directly, so a theme whose
 *  family colour would collide with another status can move that one status
 *  alone. That is also why the picker's `blue` swatch above resolves through
 *  `--status-idle-*`: it is the entry that has to stay blue in dark-forest,
 *  where `--accent-*` is green.
 *
 *  'stopped' and 'disconnected' are `ink` — near-black in dark themes, a pale
 *  inset in light ones. That replaced a literal `#000000` on white text, which
 *  read as a hole punched in the light theme.
 */
export const DEFAULT_STATUS_COLORS: Record<PaneStatusValue, StatusColorKey> = {
  starting: 'yellow',
  running: 'green',
  idle: 'blue',
  awaiting: 'orange',
  stopped: 'ink',
  exited: 'gray',
  error: 'red',
  waiting: 'gray',
  disconnected: 'ink',
}

/** True when `value` is a colour this build knows. Guards settings written by
 *  a newer version, which must fall back to the default rather than emit a
 *  `var(--undefined)` that paints nothing. */
export function isStatusColorKey(value: unknown): value is StatusColorKey {
  return typeof value === 'string' && value in STATUS_COLOR_PALETTE
}

/** True when `value` is a status this build paints. */
export function isPaneStatusValue(value: unknown): value is PaneStatusValue {
  return (
    typeof value === 'string' && (PANE_STATUS_ORDER as readonly string[]).includes(value)
  )
}
