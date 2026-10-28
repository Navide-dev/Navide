import { describe, expect, it } from 'vitest'
import { usePipelineDag } from '../../composables/usePipelineDag'
import {
  applyGraphOps,
  deriveStagesFromGraph,
  edgeId,
  layerGraph,
  validateGraph,
  type GraphNode,
  type PipelineGraph,
} from '../pipelineGraph'
import { buildDagPlan, expandNodeOutputs, kickoffHints, parseNodeSignals } from '../pipelineDagRun'

function slot(id: string, kickoffBody = ''): GraphNode {
  return { id, kind: 'slot', label: id, position: { x: 0, y: 0 }, slot: { agentKey: 'claude', roleKey: '', label: id, kickoffBody } }
}

/** check → (ok: ship | default: fix) and an error edge to alert; fix and ship
 *  join into report. The backend twin is branching_graph() in
 *  backend/tests/test_pipeline_graph.py. */
function branching(): PipelineGraph {
  return {
    version: 1,
    nodes: [
      { id: 'trigger', kind: 'trigger', position: { x: 0, y: 0 } },
      slot('check'), slot('ship', 'ship {{node.check.output.version}}'), slot('fix', 'fix: {{node.check.output}}'), slot('alert'), slot('report'),
    ],
    edges: [
      { id: 'e-trigger-check', from: 'trigger', to: 'check', kind: 'main' },
      { id: 'b-check-ship', from: 'check', to: 'ship', kind: 'branch', when: 'ok' },
      { id: 'b-check-fix', from: 'check', to: 'fix', kind: 'branch', when: 'default' },
      { id: 'x-check-alert', from: 'check', to: 'alert', kind: 'error' },
      { id: 'e-ship-report', from: 'ship', to: 'report', kind: 'main' },
      { id: 'e-fix-report', from: 'fix', to: 'report', kind: 'main' },
    ],
  }
}

describe('branch and error edges: validation (mirrors the backend)', () => {
  it('a branching graph is valid and layers over every forward edge', () => {
    const g = branching()
    expect(validateGraph(g)).toEqual([])
    expect(layerGraph(g).layers).toEqual([['check'], ['ship', 'fix', 'alert'], ['report']])
  })

  it('edge ids per kind', () => {
    expect([edgeId('a', 'b'), edgeId('a', 'b', 'reject'), edgeId('a', 'b', 'branch'), edgeId('a', 'b', 'error')])
      .toEqual(['e-a-b', 'r-a-b', 'b-a-b', 'x-a-b'])
  })

  it.each([
    [undefined, 'when must be a non-empty string or {path, equals}'],
    ['  ', 'when must not be empty'],
    [{ path: 'status' }, 'when must be a non-empty string or {path, equals}'],
    [{ path: '', equals: 1 }, 'when must be a non-empty string or {path, equals}'],
    [{ path: 'a', equals: [1] }, 'when must be a non-empty string or {path, equals}'],
    [{ path: 'a', equals: 1, op: 'gt' }, 'when must be a non-empty string or {path, equals}'],
  ])('a branch edge needs a valid when (%j)', (when, msg) => {
    const g = branching()
    if (when === undefined) delete g.edges[1].when
    else g.edges[1].when = when as never
    expect(validateGraph(g)).toContain(`branch edge b-check-ship: ${msg}`)
  })

  it('an object when is valid', () => {
    const g = branching()
    g.edges[1].when = { path: 'status', equals: 'ok' }
    expect(validateGraph(g)).toEqual([])
  })

  it('when and maxLoops belong to their own kinds', () => {
    const g = branching()
    g.edges[0].when = 'ok'
    g.edges[3].maxLoops = 2
    const errs = validateGraph(g)
    expect(errs).toContain('edge e-trigger-check: when is only for branch edges')
    expect(errs).toContain('edge x-check-alert: maxLoops is only for reject edges')
  })

  it('branch and error edges start at a slot', () => {
    const g = branching()
    g.edges.push({ id: 'b-trigger-fix', from: 'trigger', to: 'fix', kind: 'branch', when: 'x' })
    g.edges.push({ id: 'x-trigger-alert', from: 'trigger', to: 'alert', kind: 'error' })
    const errs = validateGraph(g)
    expect(errs).toContain('branch edge b-trigger-fix must start at a slot node')
    expect(errs).toContain('error edge x-trigger-alert must start at a slot node')
  })

  it('a cycle through an error edge is rejected; a reject edge back over a branch is fine', () => {
    const cyc = branching()
    cyc.edges.push({ id: 'x-report-check', from: 'report', to: 'check', kind: 'error' })
    expect(validateGraph(cyc).some((e) => e.includes('cycle'))).toBe(true)
    const loop = branching()
    loop.edges.push({ id: 'r-report-check', from: 'report', to: 'check', kind: 'reject', maxLoops: 2 })
    expect(validateGraph(loop)).toEqual([])
  })

  it('remove_node reconnects main edges only', () => {
    const g = applyGraphOps(branching(), [{ op: 'remove_node', id: 'ship' }])
    expect(new Set(g.edges.map((e) => e.id))).toEqual(new Set(['e-trigger-check', 'b-check-fix', 'x-check-alert', 'e-fix-report']))
  })
})

describe('signals come from the agent reply, never from the kickoff (#733)', () => {
  it('reads the last real branch, failure and output', () => {
    const s = parseNodeSignals('work\n---BRANCH: no---\n⏺ ---BRANCH: ok---\n---OUTPUT-START---\n{"a": [1, {"b": 2}]}\n---OUTPUT-END---\n---NODE-FAILED: disk full---')
    expect(s).toEqual({ branch: 'ok', failed: 'disk full', output: { value: { a: [1, { b: 2 }] } } })
    expect(parseNodeSignals('---NODE-FAILED---').failed).toBe('the agent reported a failure')
  })

  it('a kickoff with example signals is not taken as a result', () => {
    const g = branching()
    g.edges[1].when = { path: 'status', equals: 'ok' }
    g.edges.push({ id: 'b-check-report', from: 'check', to: 'report', kind: 'branch', when: 'later' })
    const plan = buildDagPlan(g, deriveStagesFromGraph(g))
    const hints = kickoffHints(plan, 'check')
    expect(hints).toContain('---BRANCH: <值>---')
    expect(hints).toContain('---OUTPUT-START---')
    expect(hints).toContain('---NODE-FAILED: <原因>---')
    // The kickoff as typed, as a TUI echoes it (indented, every line), and
    // with its examples on lines of their own: none of it is a result.
    const kickoff = `do the check${hints}`
    const echo = kickoff.split('\n').map((l) => `  ${l}`).join('\n')
    const examples = '---BRANCH: <值>---\n---NODE-FAILED: <原因>---\n---OUTPUT-START---\n<JSON>\n---OUTPUT-END---'
    expect(parseNodeSignals(`${kickoff}\n${echo}\n${examples}\nI checked it.\n---STAGE-DONE---`)).toEqual({})
  })
})

describe('structured output between nodes', () => {
  const g = branching()
  const out = { version: '1.2', nested: { list: [3, 4] }, empty: null }

  it('expands the whole output, a field, and missing values to empty', () => {
    const read = (id: string): unknown => (id === 'check' ? out : undefined)
    expect(expandNodeOutputs('{{node.check.output}}', g, read)).toBe(JSON.stringify(out))
    expect(expandNodeOutputs('v={{node.check.output.version}}', g, read)).toBe('v=1.2')
    expect(expandNodeOutputs('{{node.check.output.nested.list.1}}', g, read)).toBe('4')
    expect(expandNodeOutputs('[{{node.check.output.nope.x}}][{{node.check.output.empty}}][{{node.ship.output}}]', g, read)).toBe('[][][]')
  })

  it('leaves text that names no node of the graph alone', () => {
    expect(expandNodeOutputs('{{node.other.output}} {{prev.summary}}', g, () => 1)).toBe('{{node.other.output}} {{prev.summary}}')
  })
})

/** Drive a run of the branching graph through the composable, the way App.vue
 *  does: per stage, skip the untaken slots and finish the others. */
async function run(graph: PipelineGraph, replies: Record<string, string>, failOnKickoff: string[] = []) {
  const stages = deriveStagesFromGraph(graph)
  const log: string[] = []
  const dag = usePipelineDag({
    send: async (type) => (type === 'pipelines.graph.get' ? { derived: false, graph } : {}),
    log: (l) => log.push(l),
    workspacePath: () => '/ws',
  })
  await dag.begin('p', stages)
  const kickoffs: Record<string, string> = {}
  const skipped: string[] = []
  for (let i = 0; i < stages.length; i++) {
    if (dag.holdBeforeStage(i)) throw new Error(`held before ${i}`)
    const untaken = dag.untakenLabels(i)
    for (const s of stages[i].slots) {
      if (untaken.has(s.label)) { skipped.push(s.label); continue }
      kickoffs[s.label] = dag.expandKickoff(s.kickoffBody, i, s.label)
      dag.slotStarted(i, s.label, `pane-${s.label}`)
      if (failOnKickoff.includes(s.label)) {
        if (!dag.routeFailure(i, s.label, 'kickoff never reached the agent')) dag.slotFailed(i, s.label, 'kickoff never reached the agent')
        continue
      }
      dag.slotFinished(i, s.label, replies[s.label] ?? `${s.label} done`)
    }
  }
  return { dag, stages, kickoffs, skipped, log, states: dag.nodeStates.value }
}

describe('readiness and skip propagation', () => {
  it('only the chosen branch runs; the join runs on one taken input', async () => {
    const r = await run(branching(), { check: 'looks fine\n---BRANCH: OK---\n---STAGE-DONE---' })
    expect(r.skipped).toEqual(['fix', 'alert'])
    expect(Object.keys(r.kickoffs)).toEqual(['check', 'ship', 'report'])
    expect(r.states.fix).toEqual({ status: 'skipped', skipReason: 'untaken' })
    expect(r.states.check).toMatchObject({ status: 'done', branch: 'OK' })
    expect(r.states.report.status).toBe('done')
  })

  it('an unmatched or missing branch value takes the default edge', async () => {
    for (const reply of ['---BRANCH: maybe---', 'no signal at all']) {
      const r = await run(branching(), { check: reply })
      expect(r.skipped).toEqual(['ship', 'alert'])
      expect(r.states.report.status).toBe('done')
    }
  })

  it('a reported failure takes the error edge and the skip propagates through the join', async () => {
    const r = await run(branching(), { check: 'cannot\n---NODE-FAILED: repo is locked---\n---STAGE-DONE---' })
    expect(r.states.check).toMatchObject({ status: 'failed', errorRouted: true, error: 'repo is locked' })
    expect(r.skipped).toEqual(['ship', 'fix', 'report'])
    expect(r.states.alert.status).toBe('done')
    expect(r.states.report).toEqual({ status: 'skipped', skipReason: 'untaken' })
  })

  it('a kickoff failure on a node with an error edge takes that edge too', async () => {
    const r = await run(branching(), {}, ['check'])
    expect(r.states.check).toMatchObject({ status: 'failed', errorRouted: true })
    expect(r.skipped).toEqual(['ship', 'fix', 'report'])
    expect(r.states.alert.status).toBe('done')
  })

  it('a node without an error edge ignores ---NODE-FAILED--- (no hint was given)', async () => {
    const r = await run(branching(), { check: '---BRANCH: ok---', ship: '---NODE-FAILED: x---' })
    expect(r.states.ship.status).toBe('done')
    expect(r.states.report.status).toBe('done')
  })

  it('an object when reads the structured output; bad JSON stores null and logs', async () => {
    const g = branching()
    g.edges[1].when = { path: 'status', equals: 'ok' }
    const ok = await run(g, { check: '---OUTPUT-START---\n{"status": "ok", "version": "2.0"}\n---OUTPUT-END---' })
    expect(ok.skipped).toEqual(['fix', 'alert'])
    expect(ok.kickoffs.ship).toBe('ship 2.0')
    const bad = await run(g, { check: '---OUTPUT-START---\n{status: ok}\n---OUTPUT-END---' })
    expect(bad.states.check).toMatchObject({ status: 'done', output: null })
    expect(bad.log.some((l) => l.includes('not valid JSON'))).toBe(true)
    expect(bad.skipped).toEqual(['ship', 'alert'])
    expect(bad.kickoffs.fix).toBe('fix: ')
  })

  it('kickoffs carry the hints their edges need, and only those', async () => {
    const r = await run(branching(), { check: '---BRANCH: ok---' })
    expect(r.kickoffs.check).toContain('[分支回報]')
    expect(r.kickoffs.check).toContain('ok')
    expect(r.kickoffs.check).toContain('[結構化輸出]')
    expect(r.kickoffs.check).toContain('[失敗回報]')
    expect(r.kickoffs.ship).toBe('ship ')
    expect(r.kickoffs.report).toBe('')
  })

  it('slots behind a branch are not pre-spawned; a legacy plan has none', async () => {
    const r = await run(branching(), { check: '---BRANCH: ok---' })
    expect([...r.dag.conditionalLabels(1)].sort()).toEqual(['alert', 'fix', 'ship'])
    expect([...r.dag.conditionalLabels(2)]).toEqual(['report'])
    expect([...r.dag.conditionalLabels(0)]).toEqual([])
  })

  it('a gate no input reaches is skipped instead of holding the run', async () => {
    const g = applyGraphOps(branching(), [
      { op: 'add_node', node: { id: 'gate', kind: 'gate', label: 'OK?', position: { x: 0, y: 0 } }, after: ['fix'], before: [] },
      { op: 'add_node', node: slot('after-gate'), after: ['gate'] },
    ])
    expect(validateGraph(g)).toEqual([])
    const r = await run(g, { check: '---BRANCH: ok---' })
    expect(r.states.gate).toEqual({ status: 'skipped', skipReason: 'untaken' })
    expect(r.skipped).toContain('after-gate')
  })

  it('a reject loop sends untaken nodes back to pending', async () => {
    const g = applyGraphOps(branching(), [
      { op: 'add_node', node: { id: 'gate', kind: 'gate', label: 'OK?', position: { x: 0, y: 0 } }, after: ['report'], before: [] },
      { op: 'add_edge', edge: { id: 'r-gate-check', from: 'gate', to: 'check', kind: 'reject', maxLoops: 2 } },
    ])
    const stages = deriveStagesFromGraph(g)
    const dag = usePipelineDag({
      send: async (type) => (type === 'pipelines.graph.get' ? { derived: false, graph: g } : {}),
      log: () => {},
      workspacePath: () => '/ws',
    })
    await dag.begin('p', stages)
    dag.slotFinished(0, 'check', '---BRANCH: ok---')
    expect([...dag.untakenLabels(1)].sort()).toEqual(['alert', 'fix'])
    dag.slotFinished(1, 'ship', 'shipped')
    dag.slotFinished(2, 'report', 'reported')
    expect(dag.holdBeforeStage(3)).toBe(true)
    expect(dag.reject('gate', 'again')).toMatchObject({ kind: 'loop', targetIndex: 0 })
    expect(dag.nodeStates.value.fix.status).toBe('pending')
    dag.slotFinished(0, 'check', 'no branch this time')
    expect([...dag.untakenLabels(1)].sort()).toEqual(['alert', 'ship'])
  })
})
