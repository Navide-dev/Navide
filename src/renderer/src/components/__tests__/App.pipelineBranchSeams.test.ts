// Branch and error edges reach App.vue's stage machine at three seams; the
// rest of the engine is pipelineDagRun / usePipelineDag (see
// lib/__tests__/pipelineBranching.test.ts). Each hook answers "nothing" for a
// pipeline without those edges, which pipelineLegacyCompat.test.ts pins.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function body(start: string, end: string): string {
  const i = app.indexOf(start)
  expect(i, start).toBeGreaterThan(-1)
  const j = app.indexOf(end, i + start.length)
  expect(j, end).toBeGreaterThan(-1)
  return app.slice(i, j)
}

describe('App.vue seams for branch and error edges', () => {
  it('the look-ahead pre-spawn leaves slots behind a branch or error edge alone', () => {
    const pre = body('async function preSpawnStage(', '\n/** Build cross-stage context')
    expect(pre).toContain('const conditional = pipelineDag.conditionalLabels(index)')
    expect(pre).toContain('if (pinned.has(slot.label) || conditional.has(slot.label)) return')
  })

  it('a stage skips its untaken slots and counts them finished after everything else', () => {
    const act = body('async function activateStage(index: number): Promise<void> {', '\nasync function spawnPipelineStage(')
    expect(act).toContain('const untaken = pipelineDag.untakenLabels(index)')
    expect(act.indexOf('if (untaken.has(slot.label))')).toBeLessThan(act.indexOf('const contextHeader = buildStageContext('))
    const tail = act.slice(act.lastIndexOf('prewarmNextStage(index)'))
    expect(tail).toContain("for (const label of untaken) onStageSlotCompleted(index, `skipped:${label}`, 'skipped')")
  })

  it('a kickoff failure takes an error edge before it fails the run', () => {
    const fail = body('async function failRunOnKickoff(', '\n/** Approve the gate the run is paused on')
    expect(fail.indexOf('pipelineDag.routeFailure(stageIndex, slotLabel, reason)')).toBeLessThan(fail.indexOf('tearDownPipelineOrchestration()'))
    expect(fail).toContain("'error-edge'")
  })
})
