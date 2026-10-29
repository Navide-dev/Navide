// graphProblems gives each validateGraph problem a stable code and the label
// of the step it is about, so the editor can say it in the UI language instead
// of matching English sentences with regexes (pipeline UX PR-B, B3).
// validateGraph's sentences stay exactly as they were: the backend twin and
// MCP callers read them.
import { describe, expect, it } from 'vitest'
import type { Stage } from '../../data/stages'
import { applyGraphOps, deriveGraphFromStages, graphProblems, validateGraph, type PipelineGraph } from '../pipelineGraph'

const stage = (id: string, labels: string[]): Stage =>
  ({ id, title: id, shortTitle: id, question: '', description: '', recommendedRoles: [], sentinel: '', slots: labels.map((label) => ({ agentKey: 'claude', roleKey: '', label })) }) as unknown as Stage

const base = (): PipelineGraph => deriveGraphFromStages([stage('01', ['Writer']), stage('02', ['Reviewer'])])

describe('graphProblems', () => {
  it('codes a slot without an agent and names it by its label', () => {
    const g = base()
    const writer = g.nodes.find((n) => n.slot?.label === 'Writer')!
    writer.slot = { ...writer.slot!, agentKey: '' as never }
    const [p] = graphProblems(g)
    expect(p).toMatchObject({ code: 'slot-incomplete', nodeId: writer.id, label: writer.label || 'Writer' })
    expect(p.message).toBe(`slot node ${writer.id} needs slot.agentKey and slot.label`)
  })

  it('codes a forward cycle, and a reject link to a later step', () => {
    const g = base()
    const [w, r] = g.nodes.filter((n) => n.kind === 'slot').map((n) => n.id)
    const cyclic = applyGraphOps(g, [{ op: 'add_edge', edge: { id: 'back', from: r, to: w } }])
    expect(graphProblems(cyclic).map((p) => p.code)).toContain('cycle')
    const forward = applyGraphOps(g, [{ op: 'add_edge', edge: { id: 'rej', from: w, to: r, kind: 'reject' } }])
    expect(graphProblems(forward)).toEqual([expect.objectContaining({ code: 'reject-upstream', nodeId: w })])
  })

  it('carries the range for a reject loop count out of bounds', () => {
    const g = base()
    const [w, r] = g.nodes.filter((n) => n.kind === 'slot').map((n) => n.id)
    const bad = applyGraphOps(g, [{ op: 'add_edge', edge: { id: 'rej', from: r, to: w, kind: 'reject', maxLoops: 99 } }])
    expect(graphProblems(bad)).toEqual([expect.objectContaining({ code: 'max-loops-range', nodeId: r, params: { max: 10 } })])
  })

  it('validateGraph returns the same sentences, in the same order', () => {
    const g = base()
    const [w, r] = g.nodes.filter((n) => n.kind === 'slot').map((n) => n.id)
    g.nodes.push({ ...g.nodes[1] })
    g.edges.push({ id: 'self', from: w, to: w }, { id: 'rej', from: w, to: r, kind: 'reject', maxLoops: 0 })
    expect(validateGraph(g)).toEqual(graphProblems(g).map((p) => p.message))
    expect(validateGraph(g)[0]).toMatch(/^duplicate node id /)
  })
})
