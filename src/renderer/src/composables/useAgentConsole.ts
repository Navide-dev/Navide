/**
 * The agent console: what an agent pane (Hermes, OpenClaw) shows beyond its
 * terminal — its identity, its turn clock, its schedules — and the actions its
 * control panel and context menu offer. One instance per window, made in
 * App.vue and provided under `agentConsoleKey`.
 *
 * Every value comes from an existing source; nothing is invented:
 *   identity   ui settings (AGENT_IDENTITIES_KEY), owned here
 *   turn clock `agent.activity` (turn start = agent_active/detail "user",
 *              turn end = turn_complete; ISO timestamps)
 *   schedules  `scheduler.list`, jobs whose message action targets the pane
 *   channels   the channels store (read by the panel itself)
 * Memory and todos have no source in 0.2.40; the panel says so.
 */
import { computed, reactive, ref, type InjectionKey } from 'vue'
import { onSettingsChanged, settingsGet, settingsReady, settingsSet } from '@navide/plugin-ui/shared'
import type { useBackend } from './useBackend'
import type { useSchedulerJobs } from './useSchedulerJobs'
import type { SchedulerJob } from '../lib/schedulerJobs'
import {
  AGENT_COLOR_HEX,
  agentInitial,
  agentVendorLabel,
  isAgentVendor,
  nextAgentColor,
  parseAgentIdentities,
  type AgentIdentity,
  type AgentPaneInfo,
} from '../lib/agentIdentity'

export const AGENT_IDENTITIES_KEY = 'agent-team:agent-identities'

export interface AgentTurnClock {
  /** Epoch ms the running turn started; null when none is running. */
  startedAt: number | null
  /** Epoch ms the last turn ended; null when none was seen. */
  endedAt: number | null
}

export interface AgentPaneRef {
  paneId: string
  name: string
  agentKey: string
  workspacePath: string
  sessionId?: string | null
  /** Model the pane was launched on; undefined = the vendor's default. */
  model?: string
}

type Scheduler = Pick<ReturnType<typeof useSchedulerJobs>, 'jobs' | 'runNow' | 'refresh'>

interface Options {
  /** Opens Settings → Agents on one identity. */
  openSettings: (identityId: string) => void
  /** Sends `scheduler.set_enabled`; resolves true on success. */
  setJobEnabled?: (id: string, enabled: boolean) => Promise<boolean>
}

function isoMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v !== 'string' || !v) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

export function createAgentConsole(backend: ReturnType<typeof useBackend>, scheduler: Scheduler, opts: Options) {
  const identities = ref<AgentIdentity[]>(parseAgentIdentities(settingsGet<unknown>(AGENT_IDENTITIES_KEY, [])))
  onSettingsChanged((keys) => {
    if (keys.includes(AGENT_IDENTITIES_KEY)) {
      identities.value = parseAgentIdentities(settingsGet<unknown>(AGENT_IDENTITIES_KEY, []))
    }
  })

  let settingsLoaded = false
  let pendingPanes: readonly AgentPaneRef[] | null = null
  void settingsReady().then(() => {
    settingsLoaded = true
    identities.value = parseAgentIdentities(settingsGet<unknown>(AGENT_IDENTITIES_KEY, []))
    if (pendingPanes) reconcile(pendingPanes)
    pendingPanes = null
  })

  function save(next: AgentIdentity[]): void {
    identities.value = next
    settingsSet(AGENT_IDENTITIES_KEY, next)
  }

  function patch(id: string, change: Partial<AgentIdentity>): void {
    save(identities.value.map((a) => (a.id === id ? { ...a, ...change } : a)))
  }

  const byPane = computed(() => {
    const map = new Map<string, AgentIdentity>()
    for (const a of identities.value) if (a.paneId) map.set(a.paneId, a)
    return map
  })

  /**
   * Matches the open agent panes to identities, in one write:
   *   - an identity whose pane is not in `panes` is closed (paneId null);
   *   - a pane already linked keeps its identity, which follows its name and
   *     session id;
   *   - an unlinked pane takes the closed identity of the same vendor, name and
   *     workspace (that is how "reopen" and a restart's new pane ids attach);
   *   - any other pane gets a new identity.
   * `panes` must list every agent pane this window holds.
   */
  function reconcile(panes: readonly AgentPaneRef[]): void {
    // Until the settings store has its authoritative copy, the cached list may
    // be empty for no reason; writing then would overwrite the saved
    // identities. The last call is replayed once the store is ready.
    if (!settingsLoaded) {
      pendingPanes = panes
      return
    }
    for (const p of panes) paneModels[p.paneId] = p.model
    const live = new Set(panes.map((p) => p.paneId))
    const next = identities.value.map((a) => (a.paneId && !live.has(a.paneId) ? { ...a, paneId: null } : { ...a }))
    for (const p of panes) {
      let a = next.find((x) => x.paneId === p.paneId)
      if (!a) {
        a = next.find((x) => !x.paneId && x.agentKey === p.agentKey && x.name === p.name && x.workspacePath === p.workspacePath)
        if (a) a.paneId = p.paneId
      }
      if (!a) {
        next.push({
          id: crypto.randomUUID(),
          name: p.name,
          color: nextAgentColor(next),
          agentKey: p.agentKey,
          workspacePath: p.workspacePath,
          paneId: p.paneId,
          sessionId: p.sessionId || null,
          createdAt: Date.now(),
        })
        continue
      }
      if (p.name) a.name = p.name
      if (p.sessionId) a.sessionId = p.sessionId
    }
    if (JSON.stringify(next) !== JSON.stringify(identities.value)) save(next)
  }

  /** Launch model per agent pane, as the last reconcile reported it. */
  const paneModels = reactive<Record<string, string | undefined>>({})

  /** What an agent pane's header is drawn from; undefined for a CLI pane.
   *  Before its identity exists (the first reconcile), the pane's own name. */
  function paneInfo(paneId: string, agentKey: string | undefined, paneName: string): AgentPaneInfo | undefined {
    if (!agentKey || !isAgentVendor(agentKey)) return undefined
    const identity = byPane.value.get(paneId)
    const name = identity?.name ?? paneName
    return {
      name,
      color: AGENT_COLOR_HEX[identity?.color ?? 'violet'],
      initial: agentInitial(name, agentKey),
      vendor: agentVendorLabel(agentKey),
      model: paneModels[paneId],
      createdAt: identity?.createdAt ?? 0,
    }
  }

  function remove(identityId: string): void {
    save(identities.value.filter((a) => a.id !== identityId))
  }

  // ── Turn clock ─────────────────────────────────────────────────────────────
  const turns = reactive<Record<string, AgentTurnClock>>({})
  backend.on('agent.activity', (raw) => {
    const ev = raw as { pane_id?: string; event_type?: string; detail?: string; timestamp?: unknown } | null
    const paneId = ev?.pane_id
    if (!paneId || !byPane.value.has(paneId)) return
    const at = isoMs(ev.timestamp) ?? Date.now()
    const clock = turns[paneId] ?? { startedAt: null, endedAt: null }
    if (ev.event_type === 'turn_complete') turns[paneId] = { startedAt: null, endedAt: at }
    else if (ev.event_type === 'agent_active' && ev.detail === 'user') turns[paneId] = { ...clock, startedAt: at }
  })

  function turnFor(paneId: string): AgentTurnClock {
    return turns[paneId] ?? { startedAt: null, endedAt: null }
  }

  // ── Schedules ──────────────────────────────────────────────────────────────
  /** Jobs that wake this pane: an exact pane id, or the pane's name when the
   *  job names no id (the backend resolves those by name). */
  function jobsFor(paneId: string, paneName: string): SchedulerJob[] {
    return scheduler.jobs.value.filter((j) => {
      const a = j.action
      if (a?.kind !== 'message') return false
      if (a.pane_id) return a.pane_id === paneId
      return !!paneName && a.pane_name === paneName
    })
  }

  /** The enabled job that runs next, the one "wake now" fires. */
  function nextJob(paneId: string, paneName: string): SchedulerJob | null {
    const enabled = jobsFor(paneId, paneName).filter((j) => j.enabled)
    enabled.sort((x, y) => (x.state?.next_run_at ?? Infinity) - (y.state?.next_run_at ?? Infinity))
    return enabled[0] ?? null
  }

  async function wakeNow(paneId: string, paneName: string): Promise<boolean> {
    const job = nextJob(paneId, paneName)
    if (!job) return false
    await scheduler.runNow(job)
    return true
  }

  /** Pause every enabled job of the pane, or resume every paused one. */
  async function setSchedulesPaused(paneId: string, paneName: string, paused: boolean): Promise<void> {
    if (!opts.setJobEnabled) return
    for (const job of jobsFor(paneId, paneName)) {
      if (job.enabled === paused) await opts.setJobEnabled(job.id, !paused)
    }
    await scheduler.refresh()
  }

  return {
    identities,
    identityForPane: (paneId: string): AgentIdentity | null => byPane.value.get(paneId) ?? null,
    reconcile,
    paneInfo,
    patch,
    remove,
    turnFor,
    jobsFor,
    nextJob,
    wakeNow,
    setSchedulesPaused,
    openSettings: opts.openSettings,
  }
}

export type AgentConsole = ReturnType<typeof createAgentConsole>

export const agentConsoleKey: InjectionKey<AgentConsole> = Symbol('agentConsole')
