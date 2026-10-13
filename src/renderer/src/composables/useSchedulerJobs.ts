// Navide's own scheduled jobs for the Tasker tab: the list, the status light
// of each job, and the ▶ / toggle mutations. The backend owns timing and state
// (`scheduler.*` RPC, `scheduler.changed` broadcast); this only mirrors it.
//
// Status light, in priority order:
//   orange  running (state.running_at), or inside the ▶ grace window
//   grey    disabled
//   red     consecutive_errors > 0 — with the "failed ×N | repair" pill
//   grey    last run skipped — with the reason
//   green   last run ok
//   hollow  never run yet (none of the four is true of it)
//
// Ownership: this window acts as the user and may change every job; the
// labels only say which ones an agent created, which of those no agent can
// change any more (creator gone), and when an agent's periodic job expires.
// The exception is a system job (owner.kind 'system', e.g. workspace
// self-evolution): the backend refuses every mutation of it, so its row is
// read-only and points at the workspace that manages it.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from './useBackend'
import {
  formatClock,
  shortId,
  type JobOwner,
  type SchedulerJob,
  type SchedulerLimits,
} from '../lib/schedulerJobs'

/** After ▶ the row stays orange for at most this long, so a click never looks
 *  ignored while the backend is still waking the pane (NT-ClawLaunch's rule). */
const GRACE_MS = 60_000
const RPC_TIMEOUT_MS = 15_000
const DAY_MS = 86_400_000

export type Light = 'running' | 'off' | 'err' | 'skip' | 'ok' | 'new'

export function useSchedulerJobs(backend: ReturnType<typeof useBackend>) {
  const { t } = useI18n()

  const jobs = ref<SchedulerJob[]>([])
  /** From the last scheduler.list; runs today is not in the change broadcast. */
  const limits = ref<SchedulerLimits | null>(null)
  const listError = ref('')
  const opError = ref('')
  /** Job id → when ▶ was pressed; cleared by a timer at GRACE_MS. */
  const grace = ref<Record<string, number>>({})
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingId = ref<string | null>(null)
  const now = ref(Date.now())
  let tick: ReturnType<typeof setInterval> | null = null

  /** The ▶ grace window ends early once the backend reports a finished run
   *  that started after the press. */
  function inGrace(job: SchedulerJob): boolean {
    const since = grace.value[job.id]
    if (since === undefined) return false
    const st = job.state
    return !(st && !st.running_at && typeof st.last_run_at === 'number' && st.last_run_at >= since)
  }

  function light(job: SchedulerJob): Light {
    const st = job.state ?? {}
    if (st.running_at || inGrace(job)) return 'running'
    // A gone target is red even once the backend disabled the job for it:
    // it needs the user to rebind it, not just to switch it back on.
    if (targetGone(job)) return 'err'
    if (!job.enabled) return 'off'
    if ((st.consecutive_errors ?? 0) > 0) return 'err'
    if (st.last_status === 'skipped') return 'skip'
    if (st.last_status === 'ok') return 'ok'
    return 'new'
  }

  function targetGone(job: SchedulerJob): boolean {
    if (job.state?.disabled_reason === 'target_gone') return true
    return job.state?.last_status === 'skipped' && job.state.last_skip_reason === 'target_gone'
  }

  /** Rebound onto its rebuilt pane but still stopped: it waits for someone to switch it on. */
  function rebound(job: SchedulerJob): boolean {
    return !job.enabled && !!job.state?.rebound_needs_enable && !targetGone(job)
  }

  function skipLabel(job: SchedulerJob): string {
    const reason = job.state?.last_skip_reason
    return reason ? t(`scheduler.skip.${reason}`) : t('scheduler.skip.unknown')
  }

  function targetLabel(job: SchedulerJob): string {
    if (isSystem(job)) return t('scheduler.system.managed-by')
    const a = job.action
    const name = a.pane_name || shortId(a.pane_id)
    return a.pane_id
      ? t('scheduler.target-with-id', { name, id: shortId(a.pane_id) })
      : t('scheduler.target', { name })
  }

  function isAgent(owner: JobOwner | null | undefined): boolean {
    return !!owner && owner.kind !== 'user' && owner.kind !== 'system'
  }

  /** Owned by the app: no enable/disable, remove, edit, run-now, adopt, keep. */
  function isSystem(job: SchedulerJob): boolean {
    return job.owner?.kind === 'system'
  }

  /** The workspace whose panel manages a system job. */
  function systemWorkspace(job: SchedulerJob): string {
    return job.owner?.workspace || job.action.workspace || ''
  }

  function whoLabel(owner: JobOwner): string {
    return owner.kind === 'pane' ? owner.pane_name || shortId(owner.pane_id) : t('scheduler.owner.external')
  }

  /** '' for the user's own job. */
  function ownerLabel(job: SchedulerJob): string {
    if (!isAgent(job.owner)) return ''
    const owner = job.owner as JobOwner
    return owner.kind === 'pane' ? t('scheduler.owner.agent', { name: whoLabel(owner) }) : whoLabel(owner)
  }

  function ownerTitle(job: SchedulerJob): string {
    return isAgent(job.owner) ? t('scheduler.owner.agent-title', { name: whoLabel(job.owner as JobOwner) }) : ''
  }

  /** '' unless an agent last changed it. */
  function updatedByLabel(job: SchedulerJob): string {
    return isAgent(job.updated_by) ? t('scheduler.owner.updated-by', { name: whoLabel(job.updated_by as JobOwner) }) : ''
  }

  /** '' unless this is an enabled agent job that will expire. */
  function expiryLabel(job: SchedulerJob): string {
    const at = job.owner?.expires_at
    if (!job.enabled || !isAgent(job.owner) || typeof at !== 'number') return ''
    return t('scheduler.owner.expires-in', { n: Math.max(0, Math.ceil((at - now.value) / DAY_MS)) })
  }

  const agentEnabled = computed(() => jobs.value.filter((j) => j.enabled && isAgent(j.owner)).length)

  /** One-line notices for the panel: agents at their enabled-job or daily-run limit. */
  const limitNotices = computed(() => {
    const lim = limits.value
    if (!lim) return [] as { key: string; text: string }[]
    const out: { key: string; text: string }[] = []
    if (agentEnabled.value >= lim.agent_enabled_total)
      out.push({
        key: 'enabled',
        text: t('scheduler.limit.enabled-full', { n: agentEnabled.value, max: lim.agent_enabled_total }),
      })
    if (lim.agent_runs_today >= lim.agent_runs_per_day)
      out.push({
        key: 'runs',
        text: t('scheduler.limit.runs-full', { runs: lim.agent_runs_today, max: lim.agent_runs_per_day }),
      })
    return out
  })

  /** '' until any agent job exists. */
  const limitMeter = computed(() => {
    const lim = limits.value
    if (!lim || !jobs.value.some((j) => isAgent(j.owner))) return ''
    return t('scheduler.limit.meter', {
      n: agentEnabled.value,
      max: lim.agent_enabled_total,
      runs: lim.agent_runs_today,
      runsMax: lim.agent_runs_per_day,
    })
  })

  /** Only what the timeline's time column cannot say: a backoff hold. */
  function backoffLabel(job: SchedulerJob): string {
    const until = job.state?.backoff_until
    if (!job.enabled || typeof until !== 'number' || until <= now.value) return ''
    return t('scheduler.when-backoff', { time: formatClock(until) })
  }

  let listSeq = 0

  async function refresh(): Promise<void> {
    if (backend.status.value !== 'connected') return
    const seq = ++listSeq
    try {
      const resp = await backend.send<{
        ok: boolean
        jobs?: SchedulerJob[]
        limits?: SchedulerLimits
        error?: string
      }>(
        'scheduler.list',
        {},
        RPC_TIMEOUT_MS
      )
      if (seq !== listSeq) return
      if (resp.ok && resp.payload && resp.payload.ok !== false) {
        jobs.value = resp.payload.jobs ?? []
        limits.value = resp.payload.limits ?? null
        listError.value = ''
      } else listError.value = resp.error?.message ?? resp.payload?.error ?? 'scheduler.list failed'
    } catch (err) {
      if (seq !== listSeq) return
      listError.value = String((err as Error).message ?? err)
    }
  }

  /** Send a mutation; `ok: false` at either level lands in `opError`. */
  async function mutate(type: string, payload: Record<string, unknown>): Promise<boolean> {
    opError.value = ''
    try {
      const resp = await backend.send<{ ok: boolean; error?: string }>(type, payload, RPC_TIMEOUT_MS)
      if (!resp.ok) {
        opError.value = resp.error?.message ?? `${type} failed`
        return false
      }
      if (resp.payload && resp.payload.ok === false) {
        opError.value = resp.payload.error ?? `${type} failed`
        return false
      }
      return true
    } catch (err) {
      opError.value = String((err as Error).message ?? err)
      return false
    }
  }

  function endGrace(id: string): void {
    const timer = graceTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    graceTimers.delete(id)
    if (id in grace.value) {
      const next = { ...grace.value }
      delete next[id]
      grace.value = next
    }
  }

  /** ▶ and "repair" are the same call: run_now also clears the backend's
   *  backoff, and the error count resets on the next successful run. */
  async function runNow(job: SchedulerJob): Promise<void> {
    if (pendingId.value) return
    pendingId.value = job.id
    endGrace(job.id)
    grace.value = { ...grace.value, [job.id]: Date.now() }
    graceTimers.set(job.id, setTimeout(() => endGrace(job.id), GRACE_MS))
    try {
      if (!(await mutate('scheduler.run_now', { id: job.id }))) endGrace(job.id)
    } finally {
      pendingId.value = null
    }
  }

  async function toggleEnabled(job: SchedulerJob): Promise<void> {
    if (pendingId.value) return
    pendingId.value = job.id
    try {
      // The broadcast excludes the sender, so this window re-reads on its own.
      if (await mutate('scheduler.set_enabled', { id: job.id, enabled: !job.enabled })) await refresh()
    } finally {
      pendingId.value = null
    }
  }

  /** "Make it mine" (the job becomes the user's) or "keep" (it stops expiring). */
  async function claim(job: SchedulerJob, how: 'adopt' | 'keep'): Promise<void> {
    if (pendingId.value) return
    pendingId.value = job.id
    try {
      if (await mutate(`scheduler.${how}`, { id: job.id })) await refresh()
    } finally {
      pendingId.value = null
    }
  }

  let offChanged: (() => void) | null = null

  onMounted(() => {
    offChanged = backend.on('scheduler.changed', (p) => {
      const next = (p as { jobs?: SchedulerJob[] } | null)?.jobs
      if (Array.isArray(next)) jobs.value = next
      else void refresh()
    })
    tick = setInterval(() => (now.value = Date.now()), 30_000)
    void refresh()
  })

  watch(
    () => backend.status.value,
    (status, previous) => {
      if (status === 'connected' && previous !== 'connected') void refresh()
    }
  )

  onUnmounted(() => {
    offChanged?.()
    if (tick !== null) clearInterval(tick)
    for (const timer of graceTimers.values()) clearTimeout(timer)
    graceTimers.clear()
  })

  return {
    jobs,
    listError,
    opError,
    pendingId,
    now,
    light,
    targetGone,
    rebound,
    skipLabel,
    targetLabel,
    isSystem,
    systemWorkspace,
    backoffLabel,
    ownerLabel,
    ownerTitle,
    updatedByLabel,
    expiryLabel,
    limits,
    limitNotices,
    limitMeter,
    refresh,
    runNow,
    toggleEnabled,
    claim,
  }
}

export type SchedulerJobsApi = ReturnType<typeof useSchedulerJobs>
