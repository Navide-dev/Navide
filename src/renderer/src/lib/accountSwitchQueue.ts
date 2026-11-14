/**
 * Account switches that wait for busy panes (plan agent-0-2-42_3f728e).
 *
 * A switch asked for by an agent (MCP cli_account_switch) or a chat button
 * never interrupts a working pane and never asks the user: when the user's
 * own click would ask before restarting a running pane, the switch is parked
 * here instead and runs once the panes it would restart are idle.
 *
 * One job per key — `agent:<vendor>` for a CLI-wide switch, `pane:<id>` for
 * one pane — and the newest request wins: a later request for the same key
 * settles the parked one as "superseded".
 */

export type SwitchOutcome = Record<string, unknown> & { status: string }

export interface QueuedSwitch {
  key: string
  /** Panes the switch still waits for; 0 = run it now. */
  waiting: () => number | Promise<number>
  /** The switch itself. Answering status "queued" again (a pane got busy
   *  between the check and the run) keeps the job parked. */
  run: () => Promise<SwitchOutcome>
  /** Told once how the job ended. */
  settle: (outcome: SwitchOutcome) => void
  /** What the user sees of a parked switch (Settings ▸ Accounts, the quota
   *  popover). A job without it — a deferred pane restart — is not shown. */
  show?: { agentKey: string; to: string; paneName?: string; waiting: number }
}

/** A parked switch as the window shows it. */
export interface QueuedSwitchView {
  key: string
  agentKey: string
  to: string
  paneName?: string
  /** Panes it still waits for, as of the last check. */
  waiting: number
}

export interface AccountSwitchQueueOptions {
  intervalMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** Called with the shown jobs whenever one is added, ends or rechecks. */
  onChange?: (jobs: QueuedSwitchView[]) => void
}

export function createAccountSwitchQueue(options: AccountSwitchQueueOptions = {}) {
  const intervalMs = options.intervalMs ?? 2000
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const jobs = new Map<string, QueuedSwitch>()
  const running = new Set<QueuedSwitch>()
  let timer: unknown = null

  function view(): QueuedSwitchView[] {
    const out: QueuedSwitchView[] = []
    for (const job of jobs.values()) if (job.show) out.push({ key: job.key, ...job.show })
    return out
  }
  const changed = (): void => options.onChange?.(view())

  function arm(): void {
    if (timer !== null || jobs.size === 0) return
    timer = setTimer(() => {
      timer = null
      void tick().finally(arm)
    }, intervalMs)
  }

  /** Settle the job parked under `key` (if any) as replaced by a newer request. */
  function supersede(key: string): void {
    const job = jobs.get(key)
    if (!job) return
    jobs.delete(key)
    job.settle({ status: 'superseded' })
    changed()
  }

  /** The user called the parked switch off: it never runs. */
  function cancel(key: string): void {
    const job = jobs.get(key)
    if (!job) return
    jobs.delete(key)
    job.settle({ status: 'cancelled' })
    changed()
  }

  function enqueue(job: QueuedSwitch): void {
    supersede(job.key)
    jobs.set(job.key, job)
    changed()
    arm()
  }

  async function tick(): Promise<void> {
    for (const job of [...jobs.values()]) {
      if (running.has(job)) continue
      running.add(job)
      let waiting: number
      try {
        waiting = await job.waiting()
      } catch {
        waiting = 1 // cannot tell: keep waiting rather than interrupt anyone
      }
      if (job.show && job.show.waiting !== waiting && jobs.get(job.key) === job) {
        job.show.waiting = waiting
        changed()
      }
      if (waiting > 0 || jobs.get(job.key) !== job) {
        running.delete(job)
        continue
      }
      let outcome: SwitchOutcome
      try {
        outcome = await job.run()
      } catch {
        outcome = { status: 'refused', code: 'unknown' }
      } finally {
        running.delete(job)
      }
      // Replaced while it ran: the newer request owns the key now.
      if (jobs.get(job.key) !== job) continue
      if (outcome.status === 'queued') continue
      jobs.delete(job.key)
      job.settle(outcome)
      changed()
    }
  }

  function dispose(): void {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  return {
    enqueue,
    supersede,
    cancel,
    list: view,
    tick,
    dispose,
    has: (key: string) => jobs.has(key),
    get size() {
      return jobs.size
    },
  }
}

export type AccountSwitchQueue = ReturnType<typeof createAccountSwitchQueue>
