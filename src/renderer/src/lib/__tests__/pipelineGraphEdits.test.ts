import { describe, expect, it } from 'vitest'
import {
  applyGraphOps,
  deriveGraphFromStages,
  isLinearGraph,
  layerGraph,
  validateGraph,
  type GraphNode,
  type PipelineGraph,
} from '../pipelineGraph'
import {
  canReorderLayers,
  freshNodeId,
  laneBadges,
  opsAddToLayer,
  opsAutoLayout,
  opsInsertLayer,
  opsInsertOnEdge,
  opsMoveToLayer,
  opsReorderLayers,
  uniqueLabel,
} from '../pipelineGraphEdits'
import type { Stage } from '../../data/stages'

const stage = (id: string, labels: string[]): Stage => ({
  id, title: id, shortTitle: id, question: '', description: '', recommendedRoles: [],
  sentinel: '', allowQuestions: false, docQuery: '',
  slots: labels.map((label) => ({ agentKey: 'claude', roleKey: 'dev', label, kickoffBody: '', isCommander: false })),
})

/** trigger → A → (B1, B2) → C */
const base = (): PipelineGraph => deriveGraphFromStages([stage('01', ['A']), stage('02', ['B1', 'B2']), stage('03', ['C'])])

const slotNode = (id: string, label = id): GraphNode => ({
  id, kind: 'slot', label, position: { x: 0, y: 0 },
  slot: { agentKey: 'claude', roleKey: 'dev', label, kickoffBody: '', isCommander: false },
})

const labelsByLayer = (g: PipelineGraph): string[][] =>
  layerGraph(g).layers.map((l) => l.map((id) => g.nodes.find((n) => n.id === id)!.label ?? id))

describe('pipelineGraphEdits', () => {
  it('drops a card into a column as a parallel step wired like its neighbours', () => {
    const g = base()
    const next = applyGraphOps(g, opsAddToLayer(g, 1, slotNode('x', 'X')))
    expect(labelsByLayer(next)).toEqual([['A'], ['B1', 'B2', 'X'], ['C']])
    expect(isLinearGraph(next)).toBe(true)
    expect(validateGraph(next)).toEqual([])
  })

  it('a card dropped into the first column hangs off the trigger', () => {
    const g = base()
    const next = applyGraphOps(g, opsAddToLayer(g, 0, slotNode('x', 'X')))
    expect(labelsByLayer(next)[0]).toEqual(['A', 'X'])
    expect(isLinearGraph(next)).toBe(true)
  })

  it('keeps a skip edge when a parallel card is added between its ends', () => {
    let g = base()
    g = applyGraphOps(g, [{ op: 'add_edge', edge: { id: 'skip', from: 'n-01-0', to: 'n-03-0', kind: 'main' } }])
    const next = applyGraphOps(g, opsAddToLayer(g, 1, slotNode('x', 'X')))
    expect(next.edges.some((e) => e.id === 'skip')).toBe(true)
  })

  it('inserts a fully wired column in front of another', () => {
    const g = base()
    const next = applyGraphOps(g, opsInsertLayer(g, 1, slotNode('x', 'X')))
    expect(labelsByLayer(next)).toEqual([['A'], ['X'], ['B1', 'B2'], ['C']])
    expect(isLinearGraph(next)).toBe(true)
  })

  it('appends a column at the end', () => {
    const g = base()
    const next = applyGraphOps(g, opsInsertLayer(g, 3, slotNode('x', 'X')))
    expect(labelsByLayer(next)).toEqual([['A'], ['B1', 'B2'], ['C'], ['X']])
  })

  it('inserts on an edge by routing it through the new node', () => {
    const g = base()
    const edge = g.edges.find((e) => e.from === 'n-02-0' && e.to === 'n-03-0')!
    const next = applyGraphOps(g, opsInsertOnEdge(edge, slotNode('x', 'X')))
    expect(next.edges.some((e) => e.id === edge.id)).toBe(false)
    expect(next.edges.some((e) => e.from === 'n-02-0' && e.to === 'x')).toBe(true)
    expect(next.edges.some((e) => e.from === 'x' && e.to === 'n-03-0')).toBe(true)
    expect(validateGraph(next)).toEqual([])
  })

  it('moves a card into another column', () => {
    const g = base()
    const next = applyGraphOps(g, opsMoveToLayer(g, 'n-02-1', 2, 'into'))
    expect(labelsByLayer(next)).toEqual([['A'], ['B1'], ['C', 'B2']])
    expect(validateGraph(next)).toEqual([])
  })

  it('moves a lone card out of its column without shifting the target', () => {
    const g = base()
    // A is alone in layer 0; moving it into layer 2 (C) empties layer 0.
    const next = applyGraphOps(g, opsMoveToLayer(g, 'n-01-0', 2, 'into'))
    expect(labelsByLayer(next)).toEqual([['B1', 'B2'], ['C', 'A']])
    expect(validateGraph(next)).toEqual([])
  })

  it('moves a card into a new column of its own', () => {
    const g = base()
    const next = applyGraphOps(g, opsMoveToLayer(g, 'n-02-1', 2, 'newLayer'))
    expect(labelsByLayer(next)).toEqual([['A'], ['B1'], ['B2'], ['C']])
  })

  it('swaps two columns of a linear graph and keeps it linear', () => {
    const g = base()
    const ops = opsReorderLayers(g, 0, 1)!
    const next = applyGraphOps(g, ops)
    expect(labelsByLayer(next)).toEqual([['B1', 'B2'], ['A'], ['C']])
    expect(isLinearGraph(next)).toBe(true)
  })

  it('refuses to reorder columns once the graph has a gate or loop', () => {
    let g = base()
    g = applyGraphOps(g, opsInsertLayer(g, 2, { id: 'gate', kind: 'gate', label: 'OK?', position: { x: 0, y: 0 } }))
    expect(canReorderLayers(g)).toBe(false)
    expect(opsReorderLayers(g, 0, 1)).toBeNull()
  })

  it('lays out left to right with every main edge pointing forward', () => {
    const g = base()
    const next = applyGraphOps(g, opsAutoLayout(g))
    const x = new Map(next.nodes.map((n) => [n.id, n.position.x]))
    for (const e of next.edges) expect(x.get(e.to)!).toBeGreaterThan(x.get(e.from)!)
  })

  it('ignores reject loops when ranking, so the loop target stays upstream', () => {
    let g = base()
    g = applyGraphOps(g, [{ op: 'add_edge', edge: { id: 'r', from: 'n-03-0', to: 'n-01-0', kind: 'reject', maxLoops: 2 } }])
    const next = applyGraphOps(g, opsAutoLayout(g))
    const x = (id: string) => next.nodes.find((n) => n.id === id)!.position.x
    expect(x('n-01-0')).toBeLessThan(x('n-03-0'))
  })

  it('emits no move for a graph that is already laid out', () => {
    const g = base()
    const laid = applyGraphOps(g, opsAutoLayout(g))
    expect(opsAutoLayout(laid)).toEqual([])
  })

  it('badges what the columns cannot draw: reject loops and skips', () => {
    let g = base()
    g = applyGraphOps(g, opsInsertLayer(g, 3, { id: 'gate', kind: 'gate', label: 'OK?', position: { x: 0, y: 0 } }))
    g = applyGraphOps(g, [
      { op: 'add_edge', edge: { id: 'r', from: 'gate', to: 'n-02-0', kind: 'reject', maxLoops: 3 } },
      { op: 'add_edge', edge: { id: 'skip', from: 'n-01-0', to: 'n-03-0', kind: 'main' } },
    ])
    const badges = laneBadges(g)
    expect(badges.get('gate')).toEqual([{ kind: 'reject', edgeId: 'r', targetLayer: 2, maxLoops: 3 }])
    expect(badges.get('n-01-0')).toEqual([{ kind: 'skip', edgeId: 'skip', targetLayer: 3 }])
    expect(badges.has('n-02-1')).toBe(false)
  })

  it('never reuses a slot label or node id', () => {
    const g = base()
    expect(uniqueLabel(g, 'A')).toBe('A 2')
    expect(uniqueLabel(g, 'Fresh')).toBe('Fresh')
    const id = freshNodeId(g)
    expect(g.nodes.some((n) => n.id === id)).toBe(false)
  })
})

describe('opsPlaceNode', () => {
  it('places an inserted node right of its upstream and slides the downstream over', async () => {
    const { opsPlaceNode } = await import('../pipelineGraphEdits')
    const g0 = base()
    const laid = applyGraphOps(g0, opsAutoLayout(g0))
    const edge = laid.edges.find((e) => e.from === 'n-01-0')!
    const inserted = applyGraphOps(laid, opsInsertOnEdge(edge, slotNode('x', 'X')))
    const placed = applyGraphOps(inserted, opsPlaceNode(inserted, 'x'))
    const pos = (id: string) => placed.nodes.find((n) => n.id === id)!.position
    expect(pos('x').x).toBeGreaterThan(pos('n-01-0').x)
    // No two nodes overlap after placement.
    const boxes = placed.nodes.map((n) => ({ id: n.id, ...n.position }))
    for (const a of boxes) for (const b of boxes) {
      if (a.id >= b.id) continue
      const apart = Math.abs(a.x - b.x) >= 160 || Math.abs(a.y - b.y) >= 56
      expect(apart, `${a.id} vs ${b.id}`).toBe(true)
    }
    // Downstream of x was pushed right of x.
    expect(pos(edge.to).x).toBeGreaterThan(pos('x').x)
  })

  it('stacks a parallel node under its sibling', async () => {
    const { opsPlaceNode } = await import('../pipelineGraphEdits')
    const g0 = base()
    const laid = applyGraphOps(g0, opsAutoLayout(g0))
    const added = applyGraphOps(laid, opsAddToLayer(laid, 2, slotNode('x', 'X')))
    const placed = applyGraphOps(added, opsPlaceNode(added, 'x'))
    const pos = (id: string) => placed.nodes.find((n) => n.id === id)!.position
    expect(pos('x').y).toBeGreaterThan(pos('n-03-0').y)
    expect(Math.abs(pos('x').x - pos('n-03-0').x)).toBeLessThan(10)
  })
})
