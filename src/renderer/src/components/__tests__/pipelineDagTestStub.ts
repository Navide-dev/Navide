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
