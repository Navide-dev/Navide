/**
 * Model arena (experimental): one task sent to 2-4 models, each in its own git
 * worktree and CLI pane. The backend (arena.py) owns worktrees, records, diff
 * stats and merges; these are the shapes it answers with and the pure rules
 * the window applies on top.
 */

export const ARENA_MIN_CANDIDATES = 2
export const ARENA_MAX_CANDIDATES = 4
export const ARENA_DEFAULT_CANDIDATES = 3
export const ARENA_DEFAULT_TIME_LIMIT_MIN = 30
export const ARENA_DEFAULT_BUDGET_USD = 3

/** Model ids offered as suggestions per CLI. Free text stays allowed: ids
 *  change with every vendor release, the same reason the spawn dialog's Model
 *  field is a text box. */
export const ARENA_MODEL_SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5'],
}

export interface ArenaCandidateInput {
  agent: string
  model: string
}

export interface ArenaCandidate extends ArenaCandidateInput {
  id: string
  effort?: string
  slug: string
  branch: string
  worktree: string
  pane_id: string
  /** '' while running; 'time' / 'budget' once the window stopped it at a limit, 'user' by hand. */
  stopped: string
  rating: number
  adopted: boolean
}

export interface ArenaRun {
  id: string
  workspace: string
  task: string
  base_sha: string
  base_branch: string
  check_command: string
  time_limit_min: number
  budget_usd: number
  created_at: number
  state: 'running' | 'merged' | 'kept' | 'closed'
  candidates: ArenaCandidate[]
  dirty_base?: boolean
  merge?: { mode: string; branch: string; commit?: string; ok: boolean; candidate: string; at: number } | null
}

export interface ArenaSpend {
  usd: number
  tokens: number
  unpriced_calls: number
  available: boolean
}

export interface ArenaCandidateStatus {
  id: string
  files: number
  added: number
  deleted: number
  protected: string[]
  spend: ArenaSpend
  over_time: boolean
  over_budget: boolean
}

export interface ArenaStatus {
  run: ArenaRun
  elapsed_s: number
  candidates: ArenaCandidateStatus[]
}

/** The default lineup: up to ARENA_DEFAULT_CANDIDATES rows, claude's
 *  suggested models first when claude is enabled, else one row per enabled
 *  CLI that takes a model. */
export function defaultArenaLineup(agentKeys: readonly string[]): ArenaCandidateInput[] {
  if (agentKeys.includes('claude')) {
    return ARENA_MODEL_SUGGESTIONS.claude.slice(0, ARENA_DEFAULT_CANDIDATES).map((model) => ({ agent: 'claude', model }))
  }
  const rows = agentKeys.slice(0, ARENA_DEFAULT_CANDIDATES).map((agent) => ({ agent, model: '' }))
  while (rows.length && rows.length < ARENA_MIN_CANDIDATES) rows.push({ ...rows[0] })
  return rows
}

/** Which candidates the window should stop now: over a limit, still running,
 *  and with a live pane to interrupt. */
export function candidatesToStop(
  status: ArenaStatus,
  paneAlive: (paneId: string) => boolean,
): { id: string; paneId: string; reason: 'time' | 'budget' }[] {
  const out: { id: string; paneId: string; reason: 'time' | 'budget' }[] = []
  for (const row of status.candidates) {
    const cand = status.run.candidates.find((c) => c.id === row.id)
    if (!cand || cand.stopped || !cand.pane_id || !paneAlive(cand.pane_id)) continue
    if (row.over_budget) out.push({ id: row.id, paneId: cand.pane_id, reason: 'budget' })
    else if (row.over_time) out.push({ id: row.id, paneId: cand.pane_id, reason: 'time' })
  }
  return out
}

/** The pane title for a candidate: short enough for a narrow pane header. */
export function arenaPaneName(runId: string, cand: Pick<ArenaCandidate, 'id' | 'slug'>): string {
  return `arena-${runId}-${cand.id}-${cand.slug}`
}

/** "m:ss" under an hour, "h:mm:ss" above. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
