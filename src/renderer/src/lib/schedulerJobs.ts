// Navide's own scheduled jobs (the NAVIDE JOBS section of the Tasker tab).
// The backend owns timing and state; this module only types the wire shape,
// words a schedule for a human, and previews the next slot in the editor.
// The list rows never compute a next run themselves — they show the backend's
// `state.next_run_at`, which is the only value that is actually honoured.
import { weekdayKey, type Translate } from './cronDescribe'

export type JobSchedule =
  | { kind: 'every'; every_ms: number; anchor_ms?: number }
  | { kind: 'daily'; at: string; tz: string }
  | { kind: 'weekly'; days: number[]; at: string; tz: string }
  /** One run at `at_ms`; the backend disables the job after it. */
  | { kind: 'once'; at_ms: number }

/** Wake a CLI pane and send it `text`. At least one of pane_id / pane_name is
 *  present; with pane_id the backend delivers to that exact pane and never
 *  falls back to a same-named one. A system job of the workspace
 *  self-evolution feature carries `kind: 'evolve'` and only `workspace`. */
export interface JobAction {
  kind: 'message' | 'evolve'
  workspace: string
  pane_id?: string
  pane_name?: string
  text: string
}

export interface JobPolicy {
  catch_up?: 'once' | 'skip'
  max_runs_per_day?: number
  timeout_s?: number
}

export type SkipReason =
  | 'no_window'
  | 'busy'
  | 'budget'
  | 'target_gone'
  | 'missed'
  | 'interrupted'
  | 'budget_global'
  | 'expired'

export interface JobState {
  next_run_at?: number | null
  running_at?: number | null
  last_run_at?: number | null
  last_status?: 'ok' | 'error' | 'skipped' | null
  last_error?: string | null
  last_duration_ms?: number | null
  consecutive_errors?: number
  backoff_until?: number | null
  last_skip_reason?: SkipReason | string | null
  /** target_gone runs in a row; the backend disables the job at 3. */
  consecutive_target_gone?: number
  /** Why the backend disabled the job itself ('target_gone'); cleared on re-enable. */
  disabled_reason?: string | null
  /** The pane id a rebuild moved this job off (session lineage). */
  rebound_from?: string
  /** Rebound while disabled; cleared once the job is switched back on. */
  rebound_needs_enable?: boolean
}

/** Who created a job (`owner`) or last changed it (`updated_by`). A job saved
 *  before owners were recorded is the user's (`legacy`). On an agent's periodic
 *  job `expires_at` is when it disables itself; null means the user kept it. */
export interface JobOwner {
  /** 'system' = owned by the app itself (workspace self-evolution): read-only
   *  everywhere, managed from that workspace's evolve panel. */
  kind: 'user' | 'pane' | 'external' | 'system'
  /** System jobs: the feature that owns it ('evolve'). */
  feature?: string
  pane_id?: string
  pane_name?: string
  workspace?: string
  legacy?: boolean
  expires_at?: number | null
}

/** The agent limits `scheduler.list` reports, and how much of them is in use. */
export interface SchedulerLimits {
  agent_enabled_total: number
  agent_enabled: number
  agent_runs_per_day: number
  agent_runs_today: number
}

export interface SchedulerJob {
  id: string
  name: string
  enabled: boolean
  created_at?: number
  updated_at?: number
  schedule: JobSchedule
  action: JobAction
  policy?: JobPolicy
  state?: JobState
  owner?: JobOwner
  updated_by?: JobOwner | null
  /** The pane that created it is gone; only the user may change it now. */
  owner_gone?: boolean
}

/** What `scheduler.upsert` takes: a new job has no id yet (the backend mints a
 *  uuid4) and the state is backend-owned, so it is never sent. */
export type JobDraft = Omit<
  SchedulerJob,
  'id' | 'state' | 'created_at' | 'updated_at' | 'owner' | 'updated_by' | 'owner_gone'
> & {
  id?: string
}

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
export function isValidHhmm(at: string): boolean {
  return HHMM.test(at)
}

/** First 8 characters of a pane id — enough to tell two same-named panes apart. */
export function shortId(id: string | undefined | null): string {
  return (id ?? '').slice(0, 8)
}

/** A once job whose single slot is spent: it has an outcome and no next run.
 *  A ▶ run leaves next_run_at in place, so it does not count. */
export function onceDone(s: JobSchedule, state: JobState | undefined): boolean {
  return s.kind === 'once' && !!state?.last_status && state.next_run_at == null
}

export function describeSchedule(s: JobSchedule, t: Translate, state?: JobState): string {
  if (s.kind === 'once') {
    return onceDone(s, state) ? t('scheduler.once-done') : t('scheduler.once-at', { time: formatDateTime(s.at_ms) })
  }
  if (s.kind === 'every') {
    if (s.every_ms % HOUR_MS === 0) return t('scheduler.every-hours', { n: s.every_ms / HOUR_MS })
    return t('scheduler.every-minutes', { n: Math.round(s.every_ms / MINUTE_MS) })
  }
  // The zone is only worth a word when it is not the one the user is sitting in.
  const zone = s.tz && s.tz !== localTimeZone() ? ` (${s.tz})` : ''
  if (s.kind === 'daily') return t('scheduler.daily-at', { time: s.at }) + zone
  const days = [...s.days]
    .sort((a, b) => a - b)
    .map((d) => t(weekdayKey(d)))
    .join(t('scheduler.day-separator'))
  return t('scheduler.weekly-at', { days, time: s.at }) + zone
}

// ── Next-slot preview (editor only) ─────────────────────────────────────────

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number
}

const WEEKDAY_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

function zonedParts(ms: number, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(ms))
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WEEKDAY_ISO[get('weekday')] ?? 1,
  }
}

/** UTC ms of a wall-clock time in `tz`. Two passes settle the offset, which is
 *  what makes a DST-change day land on the right instant. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  let guess = wall
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(guess, tz)
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
    guess += wall - seen
  }
  return guess
}

/** The next slot strictly after `now`, or null when the schedule is not
 *  complete enough to have one. A preview: the backend computes the real one. */
export function previewNextRun(s: JobSchedule, now: number): number | null {
  if (s.kind === 'once') return s.at_ms > now ? s.at_ms : null
  if (s.kind === 'every') {
    if (!(s.every_ms > 0)) return null
    const anchor = s.anchor_ms ?? now
    if (anchor > now) return anchor
    return anchor + (Math.floor((now - anchor) / s.every_ms) + 1) * s.every_ms
  }
  const m = HHMM.exec(s.at)
  if (!m || !isValidTimeZone(s.tz)) return null
  if (s.kind === 'weekly' && s.days.length === 0) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  const today = zonedParts(now, s.tz)
  for (let offset = 0; offset <= 7; offset++) {
    // Walk calendar days in the zone; Date.UTC normalises the day overflow.
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset))
    const y = day.getUTCFullYear()
    const mo = day.getUTCMonth() + 1
    const d = day.getUTCDate()
    const iso = day.getUTCDay() === 0 ? 7 : day.getUTCDay()
    if (s.kind === 'weekly' && !s.days.includes(iso)) continue
    const at = zonedToUtc(y, mo, d, hour, minute, s.tz)
    if (at > now) return at
  }
  return null
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}
