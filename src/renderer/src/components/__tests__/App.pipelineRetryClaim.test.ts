// p2-stage-retry and p2-crash-state reach App.vue at a few seams; the logic is
// in pipelineDagRun / usePipelineDag (lib/__tests__/pipelineRetry.test.ts) and
// backend/agent_team_backend/pipeline_liveness.py.
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

describe('the window claims its run on every reconnect (p2-crash-state)', () => {
  const claim = body("backend.send('pipeline.claim'", '\n)')
  const around = app.slice(app.indexOf("backend.send('pipeline.claim'") - 400, app.indexOf("backend.send('pipeline.claim'") + 200)

  it('sends pipeline.claim whenever the connection comes up, an empty list included', () => {
    expect(around).toContain("() => backend.status.value")
    expect(around).toContain("if (s !== 'connected') return")
    expect(around).toContain("pipeline.state === 'running' && pipelineRunWorkspace ? [pipelineRunWorkspace] : []")
    expect(around).toContain('{ immediate: true }')
    expect(claim).toContain('{ workspaces }')
  })
})

describe('a failed slot retries before it fails (p2-stage-retry)', () => {
  it('a reported failure retries, then takes its error edge or fails the run', () => {
    const done = body('function onStageSlotCompleted(', '\n/**')
    const read = done.indexOf('pipelineDag.reportedFailure(')
    expect(read).toBeGreaterThan(-1)
    expect(read).toBeLessThan(done.indexOf('completeSlot(stageCompletions, stageIndex, paneId)'))
    expect(done).toContain('scheduleSlotRetry(stageIndex, failedPane.slotLabel, retry)')
    expect(done).toContain('void failRunOnKickoff(stageIndex, failedPane.slotLabel, reported, false, true)')
  })

  it('a kickoff failure retries before the error edge and before failing the run', () => {
    const fail = body('async function failRunOnKickoff(', '\n/** Approve the gate the run is paused on')
    const retry = fail.indexOf('pipelineDag.retryAfterFailure(stageIndex, slotLabel, reason)')
    expect(retry).toBeGreaterThan(-1)
    expect(retry).toBeLessThan(fail.indexOf('pipelineDag.routeFailure('))
  })

  it('a retry re-runs only its slot, leaving the stage count, router and pre-spawn alone', () => {
    const act = body('async function activateStage(', '\nasync function spawnPipelineStage(')
    expect(act).toContain('if (!only) registerStage(stageCompletions, index, stage.slots.length)')
    expect(act).toContain('stage.slots.filter((slot) => !only || slot.label === only)')
    expect(act.indexOf('if (only) return')).toBeLessThan(act.indexOf('startRouterPoll(index)'))
    expect(act.indexOf('if (only) return')).toBeLessThan(act.indexOf('prewarmNextStage(index)'))
    const sched = body('function scheduleSlotRetry(', '\n/**')
    expect(sched).toContain("if (pipeline.state !== 'running' || pipeline.stageIndex !== stageIndex) return")
    expect(sched).toContain('await activateStage(stageIndex, { only: slotLabel, note: retry.note })')
  })
})
