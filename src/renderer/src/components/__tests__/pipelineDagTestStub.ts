import { usePipelineDag } from '../../composables/usePipelineDag'

/** A real DAG engine for the lifted-App.vue tests, wired to a backend that
 *  has no stored graph for any pipeline — the legacy linear case, in which
 *  every hook must be a no-op. `sent` records what the engine reported. */
export function linearPipelineDag(workspacePath: () => string = () => '/ws') {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  const dag = usePipelineDag({
    send: async (type, payload) => {
      sent.push({ type, payload })
      return type === 'pipelines.graph.get' ? { derived: true } : {}
    },
    log: () => {},
    workspacePath,
  })
  return { dag, sent }
}

/** Prepended to lifted App.vue source that names the run's slot record. These
 *  tests seed `panes` directly, so a slot's pane is the one they put there;
 *  App.pipelineSecondRun.test.ts runs the real record. */
export const RUN_SLOT_STUB = `
const runSlots = { current: () => new Map(), record() {}, startRun() {}, endChildRun() {}, adopt() {}, rekey() {} }
const runSlotPane = (stageId, slotLabel) => panes.value.find((p) => p.stageId === stageId && p.slotLabel === slotLabel && p.origin === 'pipeline')
const isPriorRunPane = () => false
`
