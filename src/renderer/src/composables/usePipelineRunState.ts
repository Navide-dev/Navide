import { computed, onScopeDispose, ref, watch } from 'vue'
import type { useBackend } from './useBackend'
import type { NodeRunState } from '../lib/pipelineGraph'
import { EMPTY_RUN, type RunSnapshot } from '../components/pipeline/pipelineEditorModel'

/** What the host window knows about its own run: the engine lives in the
 *  renderer, so the window that drives a run is the first to know it started,
 *  before any per-node state is broadcast. */
export interface HostRun {
  state: string
  pipelineId: string
  workspacePath: string
}

interface NodeStatesPayload {
  workspace_path?: string
  pipeline_id?: string
  state?: string
  nodes?: Record<string, NodeRunState>
  /** The engine reports the paused gate as {gateId, label, prompt, nextIndex},
   *  or {} when none (project.node_gate has the same shape). */
  gate?: unknown
}

/** Node id of the gate a run is paused on, from either wire shape. */
export function gateIdOf(raw: unknown): string | null {
  if (typeof raw === 'string') return raw || null
  const id = (raw as { gateId?: unknown } | null | undefined)?.gateId
  return typeof id === 'string' && id ? id : null
}

/**
 * Live run state of one workspace, for drawing status on the graph and for
 * the editor's read-only lock. Seeded from the project record (`project.peek`
 * carries pipeline_id / state / node_states / node_gate) and kept current by
 * the `pipeline.node_states_changed` broadcast, so a run started by MCP in
 * another window shows up as well.
 */
export function usePipelineRunState(
  backend: ReturnType<typeof useBackend>,
  workspacePath: () => string,
  hostRun?: () => HostRun | null
) {
  const snapshot = ref<RunSnapshot>({ ...EMPTY_RUN })

  async function seed(ws: string): Promise<void> {
    if (!ws) { snapshot.value = { ...EMPTY_RUN }; return }
    try {
      const resp = await backend.send<{ project: Record<string, unknown> | null }>('project.peek', { workspace_path: ws })
      if (ws !== workspacePath()) return
      const p = resp.ok ? resp.payload?.project : null
      if (!p) { snapshot.value = { ...EMPTY_RUN }; return }
      snapshot.value = {
        pipelineId: String(p.pipeline_id ?? ''),
        state: String(p.state ?? 'idle'),
        nodes: (p.node_states as Record<string, NodeRunState> | undefined) ?? {},
        gate: gateIdOf(p.node_gate),
      }
    } catch {
      // A transport blip leaves the last known state; the broadcast catches up.
    }
  }

  const off = backend.on('pipeline.node_states_changed', (raw) => {
    const p = raw as NodeStatesPayload
    if (!p || (p.workspace_path ?? '') !== workspacePath()) return
    snapshot.value = {
      pipelineId: p.pipeline_id ?? snapshot.value.pipelineId,
      state: p.state ?? snapshot.value.state,
      nodes: p.nodes ?? {},
      gate: gateIdOf(p.gate),
    }
  })
  onScopeDispose(() => off())

  watch(workspacePath, (ws) => { void seed(ws) }, { immediate: true })
  // The host's run starting or ending changes the project record too; re-read
  // it so a finished run does not leave a stale 'running' behind.
  watch(() => hostRun?.()?.state, (now, before) => {
    if (before !== undefined && now !== before) void seed(workspacePath())
  })

  /** The run as the editor should see it: the host's own run wins on state
   *  and pipeline id (it is never stale for the window driving the run). */
  const run = computed<RunSnapshot>(() => {
    const host = hostRun?.()
    const s = snapshot.value
    if (host && host.workspacePath === workspacePath() && host.state === 'running') {
      return { ...s, state: 'running', pipelineId: host.pipelineId || s.pipelineId }
    }
    return s
  })

  /** True while a run in this workspace is using `pipelineId`. */
  function isRunning(pipelineId: string): boolean {
    const r = run.value
    return !!pipelineId && r.state === 'running' && r.pipelineId === pipelineId
  }

  return { run, isRunning, refresh: () => seed(workspacePath()) }
}
