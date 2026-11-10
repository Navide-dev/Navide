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
 *   notes      `agent.notes` (memory / todos read from the vendor's own files;
 *              a source that was not measured comes back "unsupported")
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

export interface AgentNoteEntry {
  /** Path relative to `root`. */
  name: string
  path: string
  /** Epoch ms of the file's last change. */
  modified_at: number
  preview: string
}

export interface AgentNotesSection {
  /** ok = entries found, empty = folder exists with nothing in it,
   *  missing = no folder, unsupported = no source Navide can read. */
  status: 'ok' | 'empty' | 'missing' | 'unsupported'
  root: string
  entries: AgentNoteEntry[]
}

export interface AgentNotes {
  memory: AgentNotesSection
  todos: AgentNotesSection
}

/** How many memory files the panel lists. */
export const AGENT_NOTES_LIMIT = 5

type Scheduler = Pick<ReturnType<typeof useSchedulerJobs>, 'jobs' | 'runNow' | 'refresh'>

interface Options {
  /** Opens Settings → Agents on one identity. */
  openSettings: (identityId: string) => void
  /** Sends `scheduler.set_enabled`; resolves true on success. */
  setJobEnabled?: (id: string, enabled: boolean) => Promise<boolean>
  /** Sends a partial `scheduler.upsert` (id + action); resolves true on success. */
  upsertJob?: (job: { id: string; action: SchedulerJob['action'] }) => Promise<boolean>
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
    if (ev.event_type === 'turn_complete') {
      turns[paneId] = { startedAt: null, endedAt: at }
      // A turn may have written memory; re-read only what someone has loaded.
      const key = byPane.value.get(paneId)?.agentKey
      if (key && key in notes) void refreshNotes(key)
    } else if (ev.event_type === 'agent_active' && ev.detail === 'user') turns[paneId] = { ...clock, startedAt: at }
  })

  function turnFor(paneId: string): AgentTurnClock {
    return turns[paneId] ?? { startedAt: null, endedAt: null }
  }

  // ── Memory and todos ───────────────────────────────────────────────────────
  /** Per vendor (one home per vendor, shared by its panes); absent until read. */
  const notes = reactive<Record<string, AgentNotes | null>>({})

  async function refreshNotes(agentKey: string): Promise<void> {
    if (!isAgentVendor(agentKey)) return
    if (!(agentKey in notes)) notes[agentKey] = null
    try {
      const resp = await backend.send<AgentNotes>('agent.notes', { agent_key: agentKey, limit: AGENT_NOTES_LIMIT })
      if (resp.ok && resp.payload?.memory && resp.payload.todos) {
        notes[agentKey] = { memory: resp.payload.memory, todos: resp.payload.todos }
      }
    } catch {
      // Keeps the last answer (or "reading…"); the next turn end retries.
    }
  }

  /** The last `agent.notes` answer for a vendor; null while it is being read. */
  function notesFor(agentKey: string): AgentNotes | null {
    return notes[agentKey] ?? null
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

  /** Message jobs that address a pane by this name (`action.pane_name`). */
  function jobsNamed(name: string): SchedulerJob[] {
    if (!name) return []
    return scheduler.jobs.value.filter((j) => j.action?.kind === 'message' && j.action.pane_name === name)
  }

  /** Points each job's `action.pane_name` at `name` (the rest of the action is
   *  sent unchanged); answers the names of the jobs that were not updated. */
  async function retargetJobs(jobs: readonly SchedulerJob[], name: string): Promise<string[]> {
    const failed: string[] = []
    if (!opts.upsertJob) return jobs.map((j) => j.name)
    for (const job of jobs) {
      if (!(await opts.upsertJob({ id: job.id, action: { ...job.action, pane_name: name } }))) failed.push(job.name)
    }
    await scheduler.refresh()
    return failed
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
    jobsNamed,
    retargetJobs,
    refreshNotes,
    notesFor,
    openSettings: opts.openSettings,
  }
}

export type AgentConsole = ReturnType<typeof createAgentConsole>

export const agentConsoleKey: InjectionKey<AgentConsole> = Symbol('agentConsole')
