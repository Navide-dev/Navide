import { describe, expect, it } from 'vitest'
import type { Stage } from '../../data/stages'
import {
  applyGraphOps,
  deriveGraphFromStages,
  deriveStagesFromGraph,
  isLinearGraph,
  isPropertyVisible,
  layerGraph,
  validateGraph,
  type PipelineGraph,
  type RoleProperty,
} from '../pipelineGraph'

function stage(id: string, labels: string[], extra: Partial<Stage> = {}): Stage {
  return {
    id,
    title: `T${id}`,
    shortTitle: `S${id}`,
    question: '',
    description: '',
    recommendedRoles: [],
    sentinel: `---${id}---`,
    allowQuestions: false,
    docQuery: '',
    slots: labels.map((label) => ({ agentKey: 'claude', roleKey: 'pm', label, kickoffBody: `do ${label}` })),
    ...extra,
  } as Stage
}

const legacy = [stage('01', ['plan']), stage('02', ['fe', 'be']), stage('03', ['review'])]

describe('deriveGraphFromStages', () => {
  it('wires a trigger and every slot of stage i to every slot of stage i+1', () => {
    const g = deriveGraphFromStages(legacy)
    expect(g.nodes.map((n) => n.id)).toEqual(['trigger', 'n-01-0', 'n-02-0', 'n-02-1', 'n-03-0'])
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
      'trigger>n-01-0',
      'n-01-0>n-02-0',
      'n-01-0>n-02-1',
      'n-02-0>n-03-0',
      'n-02-1>n-03-0',
    ])
    expect(validateGraph(g)).toEqual([])
    expect(isLinearGraph(g)).toBe(true)
  })

  it('round-trips: stages derived back from the graph equal the legacy stages', () => {
    expect(deriveStagesFromGraph(deriveGraphFromStages(legacy), legacy)).toEqual(legacy)
  })
})

describe('layerGraph', () => {
  it('uses longest-path depth so a join waits for its deepest upstream', () => {
    // a → b → c → e ; a → d → e
    const g: PipelineGraph = {
      version: 1,
      nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
        id, kind: 'slot' as const, position: { x: 0, y: 0 },
        slot: { agentKey: 'claude', roleKey: '', label: id, kickoffBody: '' },
      })),
      edges: [['a', 'b'], ['b', 'c'], ['c', 'e'], ['a', 'd'], ['d', 'e']].map(([f, t]) => ({ id: `${f}${t}`, from: f, to: t })),
    }
    expect(layerGraph(g).layers).toEqual([['a'], ['b', 'd'], ['c'], ['e']])
  })

  it('ignores reject edges when layering', () => {
    const g = deriveGraphFromStages(legacy)
    g.edges.push({ id: 'loop', from: 'n-03-0', to: 'n-02-0', kind: 'reject', maxLoops: 2 })
    expect(layerGraph(g).layers).toEqual([['n-01-0'], ['n-02-0', 'n-02-1'], ['n-03-0']])
    expect(validateGraph(g)).toEqual([])
    expect(isLinearGraph(g)).toBe(false)
  })
})

describe('validateGraph', () => {
  it('rejects a main-edge cycle', () => {
    const g = deriveGraphFromStages(legacy)
    g.edges.push({ id: 'back', from: 'n-03-0', to: 'n-01-0' })
    expect(validateGraph(g).join()).toMatch(/cycle/)
  })

  it('rejects a reject edge that points downstream or has an unbounded count', () => {
    const g = deriveGraphFromStages(legacy)
    g.edges.push({ id: 'fwd', from: 'n-01-0', to: 'n-03-0', kind: 'reject' })
    g.edges.push({ id: 'big', from: 'n-03-0', to: 'n-01-0', kind: 'reject', maxLoops: 99 })
    const errs = validateGraph(g).join('\n')
    expect(errs).toMatch(/fwd must point to an upstream/)
    expect(errs).toMatch(/big: maxLoops/)
  })

  it('requires slot config on slot nodes and flags missing endpoints', () => {
    const g: PipelineGraph = {
      version: 1,
      nodes: [{ id: 'x', kind: 'slot', position: { x: 0, y: 0 } }],
      edges: [{ id: 'e', from: 'x', to: 'ghost' }],
    }
    const errs = validateGraph(g).join('\n')
    expect(errs).toMatch(/slot node x needs/)
    expect(errs).toMatch(/missing node/)
  })
})

describe('deriveStagesFromGraph', () => {
  it('drops gate-only layers and names unclaimed layers L<n>', () => {
    let g = deriveGraphFromStages(legacy)
    g = applyGraphOps(g, [
      { op: 'add_node', node: { id: 'gate', kind: 'gate', position: { x: 0, y: 0 } }, after: ['n-02-0', 'n-02-1'], before: ['n-03-0'] },
      { op: 'add_node', node: { id: 'extra', kind: 'slot', position: { x: 0, y: 0 }, slot: { agentKey: 'codex', roleKey: '', label: 'extra', kickoffBody: '' } }, after: ['n-03-0'] },
    ])
    expect(validateGraph(g)).toEqual([])
    const stages = deriveStagesFromGraph(g, legacy)
    expect(stages.map((s) => s.id)).toEqual(['01', '02', '03', 'L4'])
    expect(stages[2].sentinel).toBe('---03---')
    expect(stages[3].slots[0].label).toBe('extra')
  })
})

describe('applyGraphOps', () => {
  it('insert-on-edge replaces the edge and remove_node reconnects', () => {
    const g0 = deriveGraphFromStages([stage('01', ['a']), stage('02', ['b'])])
    const g1 = applyGraphOps(g0, [
      { op: 'add_node', node: { id: 'g', kind: 'gate', position: { x: 1, y: 1 } }, after: ['n-01-0'], before: ['n-02-0'] },
    ])
    expect(g1.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['trigger>n-01-0', 'n-01-0>g', 'g>n-02-0'])
    const g2 = applyGraphOps(g1, [{ op: 'remove_node', id: 'g' }])
    expect(g2.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['trigger>n-01-0', 'n-01-0>n-02-0'])
    expect(g0.nodes).toHaveLength(3) // input untouched
  })

  it('carries slot params and treats set_stage_meta as a graph no-op', () => {
    const st = stage('01', ['a'])
    st.slots[0].params = { doneWhen: 'message' }
    const g = deriveGraphFromStages([st])
    expect(g.nodes[1].slot?.params).toEqual({ doneWhen: 'message' })
    expect(applyGraphOps(g, [{ op: 'set_stage_meta', stageId: '01', title: 'x' }])).toEqual(g)
  })

  it('throws on a missing node', () => {
    expect(() => applyGraphOps(deriveGraphFromStages(legacy), [{ op: 'move_node', id: 'nope', position: { x: 0, y: 0 } }])).toThrow(/not found/)
  })
})

describe('isPropertyVisible', () => {
  const props: RoleProperty[] = [
    { name: 'doneWhen', type: 'options', default: 'turnEnd' },
    { name: 'reportKey', type: 'string', displayOptions: { show: { doneWhen: ['message'] } } },
  ]
  it('follows show conditions and falls back to defaults', () => {
    expect(isPropertyVisible(props[1], {}, props)).toBe(false)
    expect(isPropertyVisible(props[1], { doneWhen: 'message' }, props)).toBe(true)
  })
})
